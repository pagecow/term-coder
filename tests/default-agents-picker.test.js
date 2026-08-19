// Feature test: "default agents" picker offers claude / codex / opencode as
// DIRECT launch options (in addition to the ollama-launch entries), and opencode
// is wired end-to-end as a direct-CLI launch target.
//
// app.js is a browser module (top-level window/document/window.chatoss + an
// auto-running init()), so it can't be `require`d whole in Node. Following the
// audit-fixes test pattern (tests/audit-fixes.test.js), these tests:
//   1. Parse the REAL app.js source as text.
//   2. For the pure functions (buildCliOptions, availableLaunchTargets) the
//      function body is EXTRACTED from the real source with a brace-balancing
//      parser and EXECUTED in a sandbox against controlled `detection` objects,
//      so the test exercises the real code path, not a hand-copied replica.
//   3. Source-regex assertions prove the real source contains the opencode
//      wiring (detection, buildCliOptions, availableLaunchTargets).
//   4. The Settings "Default agent" picker HTML is read from the REAL
//      index.html and checked for the direct-binary options.
//   5. The spawnChosen `raw:<bin>` branch is extracted and run for "raw:opencode"
//      to prove picking the direct option launches the opencode binary.
//
// Run: node tests/default-agents-picker.test.js   (no test runner, no deps)

const fs = require("fs");
const path = require("path");
const { assert, test, run } = require("./harness.js");

const SRC = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const HTML = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

// ---------------------------------------------------------------------------
// Helpers: parse the OLLAMA_LAUNCH_TOOLS constant + brace-balance extract a
// top-level function body out of the real source so we can EXECUTE it.
// ---------------------------------------------------------------------------

function parseOllamaLaunchTools(src) {
  const m = src.match(/const OLLAMA_LAUNCH_TOOLS = (\[[\s\S]*?\]);/);
  assert(m, "OLLAMA_LAUNCH_TOOLS declaration not found in app.js");
  // eslint-disable-next-line no-new-func
  return Function('"use strict"; return (' + m[1] + ');')();
}

// Extract the body (statements between the outer braces) of a top-level
// `function name(...)` declaration from src. Uses simple brace balancing
// starting at the first `{` after the signature. Throws if not found.
function extractFunctionBody(src, name) {
  const header = new RegExp("function " + name + "\\s*\\([^)]*\\)\\s*\\{");
  const m = header.exec(src);
  assert(m, "function " + name + " not found in app.js");
  let i = m.index + m[0].length; // position just AFTER the opening brace
  let depth = 1;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  assert(depth === 0, "unbalanced braces in " + name);
  // body is everything between the opening brace and the matching close.
  return src.slice(m.index + m[0].length, i - 1);
}

// Build a callable from an extracted function body, injecting the free
// variables it references as parameters.
function makeFn(body, params) {
  // eslint-disable-next-line no-new-func
  return Function(...Object.keys(params), body)(...Object.values(params));
}

// ---------------------------------------------------------------------------
// 1. OLLAMA_LAUNCH_TOOLS still lists opencode (it was already there; this guards
//    against a regression that drops it while wiring the direct path).
// ---------------------------------------------------------------------------
test("OLLAMA_LAUNCH_TOOLS still includes opencode alongside claude/codex", () => {
  const tools = parseOllamaLaunchTools(SRC);
  const ids = tools.map((t) => t.id);
  assert(ids.includes("claude"), "claude missing from OLLAMA_LAUNCH_TOOLS");
  assert(ids.includes("codex"), "codex missing from OLLAMA_LAUNCH_TOOLS");
  assert(ids.includes("opencode"), "opencode missing from OLLAMA_LAUNCH_TOOLS");
});

// ---------------------------------------------------------------------------
// 2. buildCliOptions emits a "raw:opencode" direct-binary entry when opencode
//    is detected, and omits it when not. (Executes the REAL function body.)
// ---------------------------------------------------------------------------
test("buildCliOptions offers raw:claude / raw:codex / raw:opencode when detected", () => {
  const tools = parseOllamaLaunchTools(SRC);
  const body = extractFunctionBody(SRC, "buildCliOptions");
  const detectionAll = { ollama: true, claude: true, codex: true, opencode: true };
  const opts = makeFn(body, { OLLAMA_LAUNCH_TOOLS: tools, detection: detectionAll });
  const values = opts.map((o) => o.value);
  assert(values.includes("raw:claude"), "raw:claude missing from buildCliOptions: " + JSON.stringify(values));
  assert(values.includes("raw:codex"), "raw:codex missing from buildCliOptions: " + JSON.stringify(values));
  assert(values.includes("raw:opencode"), "raw:opencode missing from buildCliOptions: " + JSON.stringify(values));
  // The direct entries must be labeled as direct binaries.
  const oc = opts.find((o) => o.value === "raw:opencode");
  assert(oc && /direct binary/i.test(oc.label), "raw:opencode label should say 'direct binary': " + JSON.stringify(oc));
});

test("buildCliOptions omits raw:opencode when opencode is NOT detected", () => {
  const tools = parseOllamaLaunchTools(SRC);
  const body = extractFunctionBody(SRC, "buildCliOptions");
  const detectionNone = { ollama: false, claude: false, codex: false, opencode: false };
  const opts = makeFn(body, { OLLAMA_LAUNCH_TOOLS: tools, detection: detectionNone });
  const values = opts.map((o) => o.value);
  assert(!values.includes("raw:opencode"), "raw:opencode should NOT appear when opencode undetected: " + JSON.stringify(values));
  assert(!values.includes("raw:claude"), "raw:claude should NOT appear when claude undetected");
  assert(!values.includes("raw:codex"), "raw:codex should NOT appear when codex undetected");
});

// ---------------------------------------------------------------------------
// 3. detectTools resolves opencode via `which opencode` + OPENCODE_GUESSES.
//    (Source-regex assertions — proves the real detection wiring exists.)
// ---------------------------------------------------------------------------
test("detectTools resolves the opencode binary (which opencode + OPENCODE_GUESSES)", () => {
  assert(/const OPENCODE_GUESSES = \[/.test(SRC), "OPENCODE_GUESSES constant not declared");
  assert(/let opencodePath = null;/.test(SRC), "opencodePath module-level var not declared");
  // detectTools must run `which opencode` through resolveCliPath.
  assert(/resolveCliPath\("opencode", OPENCODE_GUESSES\)/.test(SRC),
    "detectTools should call resolveCliPath(\"opencode\", OPENCODE_GUESSES)");
  // The opencode flag + path must be carried onto the `fresh` detection object
  // and persisted into settings.detected.
  assert(/fresh\.opencode = !!opencodePath;/.test(SRC), "fresh.opencode flag not set in detectTools");
  assert(/fresh\.opencodePath = opencodePath;/.test(SRC), "fresh.opencodePath not set in detectTools");
  assert(/opencode: detection\.opencode,/.test(SRC), "settings.detected.opencode not persisted");
  assert(/opencodePath: detection\.opencodePath \|\| null,/.test(SRC), "settings.detected.opencodePath not persisted");
  // The cold-start restore in init() must repopulate opencode from settings.detected.
  assert(/opencode: !!\(settings\.detected && settings\.detected\.opencode\),/.test(SRC),
    "init() detection restore missing opencode flag");
  assert(/opencodePath: \(settings\.detected && settings\.detected\.opencodePath\) \|\| null,/.test(SRC),
    "init() detection restore missing opencodePath");
});

// ---------------------------------------------------------------------------
// 4. availableLaunchTargets lists opencode as a "direct" target when detected.
//    (Executes the REAL function body — feeds the Model Selection pickers +
//    the getModelSelectionConfig export.)
// ---------------------------------------------------------------------------
test("availableLaunchTargets lists opencode as a direct target when installed", () => {
  const body = extractFunctionBody(SRC, "availableLaunchTargets");
  const detection = {
    ollama: true,
    claude: true, claudePath: "/usr/local/bin/claude",
    codex: true, codexPath: "/usr/local/bin/codex",
    opencode: true, opencodePath: "/usr/local/bin/opencode",
  };
  // Stub availableOllamaModels (the function calls it for the ollama list).
  const targets = makeFn(body, {
    detection,
    availableOllamaModels: () => ["qwen3:30b"],
  });
  const direct = targets.filter((t) => t.kind === "direct");
  const ids = direct.map((t) => t.id);
  assert(ids.includes("claude"), "claude direct target missing: " + JSON.stringify(ids));
  assert(ids.includes("codex"), "codex direct target missing: " + JSON.stringify(ids));
  assert(ids.includes("opencode"), "opencode direct target missing: " + JSON.stringify(ids));
  const oc = direct.find((t) => t.id === "opencode");
  assert(oc && oc.kind === "direct", "opencode target must be kind 'direct'");
  assert(oc && oc.bin === "/usr/local/bin/opencode", "opencode target must carry the resolved bin path");
});

test("availableLaunchTargets omits opencode when the binary is not installed", () => {
  const body = extractFunctionBody(SRC, "availableLaunchTargets");
  const detection = {
    ollama: true,
    claude: true, claudePath: "/usr/local/bin/claude",
    codex: true, codexPath: "/usr/local/bin/codex",
    opencode: false, opencodePath: null,
  };
  const targets = makeFn(body, {
    detection,
    availableOllamaModels: () => ["qwen3:30b"],
  });
  const ids = targets.map((t) => t.id);
  assert(!ids.includes("opencode"), "opencode should NOT be a target when undetected: " + JSON.stringify(ids));
});

// ---------------------------------------------------------------------------
// 5. The Settings "Default agent" picker (index.html #set-cli) offers the
//    direct-binary options alongside the ollama-launch ones.
// ---------------------------------------------------------------------------
test("Settings 'Default agent' picker offers raw:claude / raw:codex / raw:opencode direct options", () => {
  // The picker is a <select id="set-cli"> ... </select>.
  const sel = HTML.match(/<select id="set-cli"[^>]*>([\s\S]*?)<\/select>/);
  assert(sel, "set-cli select not found in index.html");
  const inner = sel[1];
  assert(/<option value="raw:claude">[^<]*direct binary[^<]*<\/option>/.test(inner),
    "set-cli missing a 'raw:claude' direct-binary option");
  assert(/<option value="raw:codex">[^<]*direct binary[^<]*<\/option>/.test(inner),
    "set-cli missing a 'raw:codex' direct-binary option");
  assert(/<option value="raw:opencode">[^<]*direct binary[^<]*<\/option>/.test(inner),
    "set-cli missing a 'raw:opencode' direct-binary option");
  // The ollama-launch options must still be present (the direct options are
  // offered ALONGSIDE ollama launch, not replacing it).
  assert(/<option value="claude">ollama launch claude/.test(inner),
    "set-cli should still offer 'ollama launch claude'");
  assert(/<option value="codex">ollama launch codex/.test(inner),
    "set-cli should still offer 'ollama launch codex'");
  assert(/<option value="opencode">ollama launch opencode/.test(inner),
    "set-cli should still offer 'ollama launch opencode'");
  // The 'ask' option must remain.
  assert(/<option value="ask">Ask me every time<\/option>/.test(inner),
    "set-cli should still offer the 'ask' option");
});

// ---------------------------------------------------------------------------
// 6. spawnChosen's raw:<bin> branch launches the named binary directly. Verify
//    it produces "exec opencode" for choice.cli === "raw:opencode", so picking
//    the direct option from either picker actually launches opencode directly
//    (NOT through `ollama launch opencode`).
// ---------------------------------------------------------------------------
test("spawnChosen raw: branch launches the opencode binary directly (exec opencode)", () => {
  // Extract the raw:<bin> branch from spawnChosen. The branch is:
  //   if (choice.cli && choice.cli.startsWith("raw:")) {
  //     const bin = choice.cli.slice(4);
  //     inner = "exec " + bin;
  //     label = bin + " · " + basename(choice.cwd);
  //   }
  // Replicate the EXACT predicate + body from app.js and run it for opencode.
  const m = SRC.match(/if \(choice\.cli && choice\.cli\.startsWith\("raw:"\)\) \{[\s\S]*?inner = "exec " \+ bin;[\s\S]*?\}/);
  assert(m, "spawnChosen raw:<bin> branch not found in app.js");
  // Pull the two assignment lines out of the captured branch and run them.
  const branch = m[0];
  assert(/const bin = choice\.cli\.slice\(4\);/.test(branch), "raw branch should slice(4) the cli value");
  assert(/inner = "exec " \+ bin;/.test(branch), "raw branch should set inner = 'exec ' + bin");

  // Execute the real predicate + body against choice.cli = "raw:opencode".
  const choice = { cli: "raw:opencode", cwd: "/proj/.chatoss/worktrees/feat" };
  // eslint-disable-next-line no-new-func
  Function("choice", "inner", "label", "basename",
    branch + "\nreturn { inner: inner, label: label };"
  );
  // The above Function just defines; call it via eval-free wrapper:
  // Re-run inline to capture locals (the branch declares `const bin`).
  const runner = new Function( // eslint-disable-line no-new-func
    "choice", "basename",
    "let inner, label;\n" + branch + "\nreturn { inner: inner, label: label };"
  );
  const out = runner(choice, (p) => p.split("/").pop());
  assert(out.inner === "exec opencode",
    "raw:opencode should produce inner 'exec opencode', got: " + JSON.stringify(out.inner));
  assert(/opencode/.test(out.label), "raw:opencode label should mention opencode: " + JSON.stringify(out.label));
  // Confirm it does NOT route through ollama.
  assert(!/ollama launch/.test(out.inner), "raw:opencode must NOT go through 'ollama launch'");
});

// ---------------------------------------------------------------------------
// 7. renderDetectedList shows the opencode binary (parity with claude/codex).
// ---------------------------------------------------------------------------
test("renderDetectedList surfaces the opencode detection row + direct path", () => {
  assert(/row\("opencode", !!d\.opencode\);/.test(SRC),
    "renderDetectedList should add an opencode detection row");
  assert(/d\.opencode && d\.opencodePath/.test(SRC),
    "renderDetectedList should print the opencode direct path when detected");
  assert(/"  opencode direct: " \+ d\.opencodePath/.test(SRC),
    "renderDetectedList should label the opencode direct path");
});

run();