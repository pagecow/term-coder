// Regression test (v1.28.2): detection probes are SILENT and short-circuit.
//
// v1.28.1 logged `console.warn("probe failed:", cmd, e)` for every failed
// probe. In the preview sandbox the terminal capability is unavailable, so
// one scan produced 25 warnings — which reads as "25 problems in this app".
// A probe failure is an EXPECTED outcome (terminal not granted, or the CLI
// simply isn't installed): the detection state and the Settings "Detected
// tools" list already surface it, so the probes must stay silent, and a
// denied/unavailable terminal must short-circuit the whole scan (1 probe
// instead of 25).
//
// These tests execute the REAL probe/resolveCliPath helpers from
// js/05-util.js against fake terminal bridges, and pin the source contract.
//
// Run: node tests/detection-quiet.test.js   (no test runner, no deps)

const fs = require("fs");
const path = require("path");
const { assert, test, run } = require("./harness.js");

const SRC = fs.readFileSync(path.join(__dirname, "..", "js", "05-util.js"), "utf8");

// Extract the body of `const probe = async (cmd) => { ... };` from detectTools.
function extractProbeBody() {
  const m = SRC.match(/const probe = async \(cmd\) => \{([\s\S]*?)\n  \};/);
  assert(m, "probe helper not found in 05-util.js");
  return m[1];
}

// Extract the body of `const resolveCliPath = async (name, guesses) => { ... };`.
function extractResolveCliPathBody() {
  const m = SRC.match(/const resolveCliPath = async \(name, guesses\) => \{([\s\S]*?)\n  \};/);
  assert(m, "resolveCliPath not found in 05-util.js");
  return m[1];
}

test("probe: a rejected terminal.exec is silent and marks the scan denied", async () => {
  const body = extractProbeBody();
  const warns = [];
  const fresh = { denied: false };
  const window = {
    chatoss: {
      terminal: {
        exec: async () => { throw new Error("capability unavailable"); },
      },
    },
  };
  // eslint-disable-next-line no-new-func
  const probe = Function("window", "fresh", "cwd", "console", "return (async (cmd) => {" + body + "});")(window, fresh, "/x", { warn: (m) => warns.push(m) });
  const r = await probe("which chatoss");
  assert.strictEqual(r, null, "a failed probe returns null");
  assert.strictEqual(fresh.denied, true, "a failed probe marks the scan denied (short-circuit)");
  assert.deepStrictEqual(warns, [], "a failed probe must NOT console.warn — expected outcome, not an error");
});

test("probe: a null result (permission denied) is silent and marks the scan denied", async () => {
  const body = extractProbeBody();
  const warns = [];
  const fresh = { denied: false };
  const window = { chatoss: { terminal: { exec: async () => null } } };
  // eslint-disable-next-line no-new-func
  const probe = Function("window", "fresh", "cwd", "console", "return (async (cmd) => {" + body + "});")(window, fresh, "/x", { warn: (m) => warns.push(m) });
  const r = await probe("which chatoss");
  assert.strictEqual(r, null);
  assert.strictEqual(fresh.denied, true);
  assert.deepStrictEqual(warns, [], "no console.warn on a denied terminal");
});

test("resolveCliPath: a denied terminal short-circuits after ONE probe", async () => {
  const body = extractResolveCliPathBody();
  const calls = [];
  const fresh = { denied: false };
  const window = {
    chatoss: {
      terminal: {
        exec: async (cmd) => { calls.push(cmd); return null; }, // denied
      },
    },
  };
  const TC = { loginShell: (c) => "zsh -lic " + JSON.stringify(c) };
  // Rebuild the probe helper the same way the real code does.
  const probeBody = extractProbeBody();
  // eslint-disable-next-line no-new-func
  const probe = Function("window", "fresh", "cwd", "console", "return (async (cmd) => {" + probeBody + "});")(window, fresh, "/x", { warn: () => {} });
  // eslint-disable-next-line no-new-func
  const resolveCliPath = Function("window", "fresh", "cwd", "TC", "probe", "return (async (name, guesses) => {" + body + "});")(window, fresh, "/x", TC, probe);
  const path = await resolveCliPath("chatoss", ["/usr/local/bin/chatoss", "/opt/homebrew/bin/chatoss"]);
  assert.strictEqual(path, null, "no path when the terminal is denied");
  assert.strictEqual(calls.length, 1, "the scan must stop after the first denied probe, got " + calls.length + " calls");
  assert.strictEqual(calls[0], "which chatoss", "the first probe is `which <name>`");
});

test("source contract: no console.warn in detectTools, denied short-circuits the scan", () => {
  const start = SRC.indexOf("async function detectTools");
  assert(start !== -1, "detectTools found in 05-util.js");
  // Brace-balance to the end of the function so the assertion covers exactly
  // detectTools (saveState/saveSettings legitimately warn elsewhere).
  let i = SRC.indexOf("{", start), depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}") { depth--; if (depth === 0) break; }
  }
  const detect = SRC.slice(start, i + 1).replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert(!/console\.warn/.test(detect), "detectTools must not console.warn on probe failures");
  assert(/fresh\.denied = true;/.test(detect), "a failed probe must set fresh.denied");
  assert(/if \(!fresh\.denied\) \{/.test(detect),
    "the remaining tool probes must be skipped once the terminal is denied");
  assert(/if \(fresh\.denied\) return null;/.test(detect),
    "resolveCliPath must bail out between probes when denied");
});

run();