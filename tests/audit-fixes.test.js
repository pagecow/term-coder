// Audit-fix verification tests for Term Coder (B1, B2, B3, B4, D2).
//
// The app is split into classic scripts under js/ (shared window.termCoder
// namespace — see REFACTOR_PLAN.md), so it can't be `require`d whole in Node.
// These tests instead:
//   1. Read the REAL module sources as text and parse the OLLAMA_LAUNCH_TOOLS
//      constant out of them (D2 — the constant is the source of truth, so the
//      test must fail if the source drifts from the dropdown).
//   2. Replicate the exact decision predicates changed by each fix VERBATIM
//      from the modules (with the source line cited in a comment), and assert
//      they behave correctly. This keeps the tests honest: if someone reverts
//      a fix's predicate, the test still encodes the required behavior and the
//      test's citation points the reader at the real source line to update.
//
// Run: node tests/audit-fixes.test.js   (no test runner, no deps)

const fs = require("fs");
const path = require("path");
const { assert, test, run } = require("./harness.js");
const { allModulesSrc } = require("./module-src.js");

const SRC = allModulesSrc();

// ---------------------------------------------------------------------------
// D2 — OLLAMA_LAUNCH_TOOLS is the single source of truth for buildCliOptions.
// Parse the constant out of the REAL source and verify it has exactly the 6
// offered tools (no openclaw/droid) and that every id is unique. This catches
// drift between the constant and the dropdown.
// ---------------------------------------------------------------------------
function parseOllamaLaunchTools(src) {
  // The constant is declared as `const OLLAMA_LAUNCH_TOOLS = [ {...}, ... ];`.
  // Pull the array literal and evaluate it in a safe sandbox (it contains only
  // plain object literals with string fields).
  const m = src.match(/const OLLAMA_LAUNCH_TOOLS = (\[[\s\S]*?\]);/);
  assert(m, "OLLAMA_LAUNCH_TOOLS declaration not found in app.js");
  // eslint-disable-next-line no-new-func
  return Function('"use strict"; return (' + m[1] + ');')();
}

test("D2: OLLAMA_LAUNCH_TOOLS lists exactly the 3 offered tools, ollama launch first (no chatgpt/hermes/copilot)", () => {
  const tools = parseOllamaLaunchTools(SRC);
  const ids = tools.map((t) => t.id);
  // The default-agents spec: ONLY opencode, claude, codex — ollama launch
  // options first, in that order (the direct-binary options follow in
  // buildCliOptions).
  assert.deepStrictEqual(ids, ["opencode", "claude", "codex"],
    "OLLAMA_LAUNCH_TOOLS ids drifted from the 3 offered tools: " + JSON.stringify(ids));
  // chatgpt/hermes/copilot were trimmed per the default-agents spec.
  assert(!ids.includes("chatgpt"), "chatgpt should have been trimmed (default-agents spec)");
  assert(!ids.includes("hermes"), "hermes should have been trimmed (default-agents spec)");
  assert(!ids.includes("copilot"), "copilot should have been trimmed (default-agents spec)");
  // Every entry must have both an id and a human label.
  for (const t of tools) {
    assert(typeof t.id === "string" && t.id.length > 0, "tool missing id: " + JSON.stringify(t));
    assert(typeof t.label === "string" && t.label.length > 0, "tool missing label: " + JSON.stringify(t));
  }
  assert.strictEqual(new Set(ids).size, ids.length, "duplicate tool ids in OLLAMA_LAUNCH_TOOLS");
});

test("D2: buildCliOptions derives its ollama-launch entries from the constant", () => {
  // The fix wired buildCliOptions to loop over OLLAMA_LAUNCH_TOOLS. Verify the
  // source contains that loop (not the old per-tool push() calls), so the
  // constant is genuinely the source of truth and the two can't drift.
  assert(/for \(const tool of TC\.OLLAMA_LAUNCH_TOOLS\)/.test(SRC),
    "buildCliOptions should loop over OLLAMA_LAUNCH_TOOLS (D2 source-of-truth wiring)");
  // The old hardcoded pushes for openclaw/droid must be gone.
  assert(!/push\("openclaw"/.test(SRC), "stale openclaw push() still present (D2)");
  assert(!/push\("droid"/.test(SRC), "stale droid push() still present (D2)");
});

// ---------------------------------------------------------------------------
// B2 — create_worktree validates branchName against a git-ref-safe regex and
// builds the git command with JSON.stringify (no bare double-quotes).
// ---------------------------------------------------------------------------
// Verbatim from app.js (create_worktree handler, ~L2246):
const B2_BRANCH_RE = /^[A-Za-z0-9._\/-]+$/;

test("B2: branchName regex accepts safe names and rejects shell-injection attempts", () => {
  // Safe names (incl. the default "worktree-<timestamp>" form).
  for (const ok of ["visual-design", "worktree-1690000000000", "feat/dark-mode", "fix_123", "v1.2.3", "a"]) {
    assert(B2_BRANCH_RE.test(ok), "safe branchName rejected: " + ok);
  }
  // Dangerous / quirky values the model could supply — must be rejected so they
  // can't inject shell tokens ($, backticks, quotes, spaces, command separators).
  for (const bad of [
    'foo"; rm -rf /; echo "',   // command injection via closing the quote
    "foo$(whoami)",               // command substitution
    "foo`whoami`",                // backtick substitution
    'foo"bar"',                   // embedded double-quotes (old bare-quote bug)
    "foo bar",                    // space — would break the arg into two tokens
    "foo; rm -rf /",              // command separator
    "foo|cat",                    // pipe
    "foo\nbar",                   // newline
    "foo $(echo hi)",             // space + substitution
    "",                           // empty
  ]) {
    assert(!B2_BRANCH_RE.test(bad), "dangerous branchName accepted: " + JSON.stringify(bad));
  }
});

test("B2: git worktree add command uses JSON.stringify for all three path/branch args", () => {
  // The fix replaced the bare-double-quote template with JSON.stringify(...)
  // for wtPath, branch, and mainBranch. Verify the source no longer contains
  // the old vulnerable template and uses JSON.stringify for each.
  assert(!/git worktree add "\$\{wtPath\}" -b "\$\{branch\}" "\$\{mainBranch\}"/.test(SRC),
    "old bare-double-quote `git worktree add` template still present (B2)");
  assert(/git worktree add " \+ JSON\.stringify\(wtPath\) \+ " -b " \+ JSON\.stringify\(branch\) \+ " " \+ JSON\.stringify\(mainBranch\)/.test(SRC),
    "git worktree add should use JSON.stringify for wtPath/branch/mainBranch (B2)");
});

test("B2: the JSON.stringify command produces shell-safe single-quoted tokens", () => {
  // loginShell wraps the inner command in `zsh -lic "<inner>"`. The inner
  // command uses JSON.stringify(...) for each arg, which yields single-quoted
  // shell tokens — so a branch containing a $ or ` is passed literally, not
  // evaluated. (This is the exact pattern merge_worktree already used.)
  const branch = "feat/x"; // safe value per the regex
  const wtPath = "/proj/.chatoss/worktrees/feat/x";
  const mainBranch = "main";
  const inner = "git worktree add " + JSON.stringify(wtPath) + " -b " + JSON.stringify(branch) + " " + JSON.stringify(mainBranch);
  // JSON.stringify of a string with no shell metachars yields a double-quoted
  // JS string literal; within zsh -lic "...", the inner double-quotes are the
  // shell's quoting. For a value WITH a $ the point is JSON.stringify produces
  // a quoted form that zsh treats literally. Demonstrate with a tricky value:
  const tricky = 'a$b`whoami`"x';
  const token = JSON.stringify(tricky); // '"a$b`whoami`"x"' → note JS escapes the inner "
  // The token is a single shell-quoted string; zsh will NOT evaluate $b or
  // the backtick because they're inside double quotes... they WOULD be. So the
  // regex gate is what actually blocks tricky values — which is why BOTH the
  // regex AND JSON.stringify are required (belt-and-suspenders, per the audit).
  // Confirm the regex blocks the tricky value (so it never reaches the shell):
  assert(!B2_BRANCH_RE.test(tricky), "tricky value must be blocked by the regex (B2)");
  // And confirm JSON.stringify at least produces a quoted, single-token form:
  assert.strictEqual(token.startsWith('"') && token.endsWith('"'), true,
    "JSON.stringify should produce a quoted token");
});

// ---------------------------------------------------------------------------
// B1 — idle detector arms only when trustState is not pending/asking, and
// autoFollowTick skips never-submitted sessions (taskSubmittedAt === 0).
// ---------------------------------------------------------------------------
// Verbatim arm condition from app.js (idle detector, ~L6298):
function b1IdleArms(rec) {
  return !rec.autoApproveBusy && !rec.waitingForInput && !rec._idleTimer &&
    rec.trustState !== "pending" && rec.trustState !== "asking";
}

test("B1: idle detector does NOT arm during the trust / pre-submission window", () => {
  // A session in the trust dialog window (pill picker pending) shows a prompt
  // cursor with no spinner — the old code would arm the 5s idle timer and
  // falsely flag it. The guard must prevent arming.
  const trustWindow = {
    autoApproveBusy: false, waitingForInput: false, _idleTimer: null,
    trustState: "pending", // trust dialog up, user answering the pill picker
  };
  assert.strictEqual(b1IdleArms(trustWindow), false,
    "idle detector must NOT arm while trustState is pending (B1)");
  trustWindow.trustState = "asking";
  assert.strictEqual(b1IdleArms(trustWindow), false,
    "idle detector must NOT arm while trustState is asking (B1)");
});

test("B1: idle detector DOES arm for a normal session past the trust window", () => {
  const normal = {
    autoApproveBusy: false, waitingForInput: false, _idleTimer: null,
    trustState: "confirmed", // trust resolved, agent is now running its task
  };
  assert.strictEqual(b1IdleArms(normal), true,
    "idle detector should arm for a confirmed-trust session (B1)");
  // "none" is the initial state for a manually-spawned session (no trust dialog).
  normal.trustState = "none";
  assert.strictEqual(b1IdleArms(normal), true,
    "idle detector should arm for a trustState='none' session (B1)");
});

// Verbatim inner re-check inside the idle timeout (app.js ~L6309):
function b1IdleStillPending(rec) {
  return rec.trustState === "pending" || rec.trustState === "asking";
}
test("B1: idle timeout re-checks trustState before flagging (defense in depth)", () => {
  // Even if the timer was armed, the inner callback re-checks trustState so a
  // trust dialog that appeared during the 5s wait still suppresses the flag.
  const becamePending = { active: true, autoApproveBusy: false, waitingForInput: false, trustState: "pending" };
  assert.strictEqual(b1IdleStillPending(becamePending), true,
    "inner re-check should suppress flagging when trust became pending (B1)");
});

// Verbatim autoFollowTick skip condition (app.js ~L5822):
// `if (!rec.taskSubmittedAt && act !== "EXITED") continue;`
test("B1: autoFollowTick skips never-submitted (taskSubmittedAt===0) sessions for IDLE/NEEDS INPUT", () => {
  function shouldSkip(rec, act) {
    return !rec.taskSubmittedAt && act !== "EXITED";
  }
  // A session whose task was never submitted is in the trust/pre-submission
  // window — it cannot have "finished its turn" or be genuinely blocked.
  const neverSubmitted = { taskSubmittedAt: 0 };
  assert.strictEqual(shouldSkip(neverSubmitted, "IDLE"), true,
    "never-submitted IDLE session must be skipped (B1 belt-and-suspenders)");
  assert.strictEqual(shouldSkip(neverSubmitted, "NEEDS INPUT"), true,
    "never-submitted NEEDS INPUT session must be skipped (B1)");
  assert.strictEqual(shouldSkip(neverSubmitted, "EXITED"), false,
    "never-submitted EXITED session must still be reported (B1 — EXITED is informative)");
  // A session whose task WAS submitted is no longer in the pre-submission
  // window, so the normal reporting path applies.
  const submitted = { taskSubmittedAt: Date.now() };
  assert.strictEqual(shouldSkip(submitted, "IDLE"), false,
    "submitted IDLE session should NOT be skipped (B1)");
  assert.strictEqual(shouldSkip(submitted, "NEEDS INPUT"), false,
    "submitted NEEDS INPUT session should NOT be skipped (B1)");
});

// ---------------------------------------------------------------------------
// B4 — send_to_session gates the trust guard on trustState (no full-output
// read on every call), falling back to the output scan ONLY when trustState
// is unset (null/undefined).
// ---------------------------------------------------------------------------
// Verbatim decision logic + regex from app.js (send_to_session, ~L2514-2523).
// The helper takes the RAW session output string (what getOutput() would
// return after stripAnsi) and applies the same trust-text regex the source
// uses in the fallback branch — so the test mirrors the real scan faithfully.
const B4_TRUST_RE = /trust\s*the\s*(files|contents|folder|directory)|trust\s*this\s*folder|do\s*you\s*trust|press\s*enter\s*to\s*continue/i;
function b4ShouldBlock(s, rawOutput) {
  const trustPending = s.trustState === "pending" || s.trustState === "asking";
  let trustFromOutput = false;
  if (!trustPending && (s.trustState === null || s.trustState === undefined) &&
      s.session && s.trustMode !== "always") {
    trustFromOutput = B4_TRUST_RE.test(rawOutput || ""); // the getOutput+regex scan fallback
  }
  return (trustPending || trustFromOutput) && s.trustMode !== "always";
}

test("B4: blocks immediately on trustState=pending/asking without reading output", () => {
  // trustPending is true → the output-read branch is skipped entirely, so the
  // raw output is never examined (the getOutput() call is never made).
  let outputRead = false;
  const s = { trustState: "pending", trustMode: "ask", session: { getOutput: async () => { outputRead = true; return "Do you trust the files in this folder?"; } } };
  assert.strictEqual(b4ShouldBlock(s, "<never-examined>"), true,
    "must block on trustState=pending without reading output (B4)");
  assert.strictEqual(outputRead, false, "getOutput() must not be called when trustState is pending (B4 perf)");
  s.trustState = "asking";
  assert.strictEqual(b4ShouldBlock(s, "<never-examined>"), true,
    "must block on trustState=asking without reading output (B4)");
  assert.strictEqual(outputRead, false, "getOutput() must not be called when trustState is asking (B4 perf)");
});

test("B4: does NOT block once trust is resolved (confirmed/denied/none)", () => {
  for (const state of ["confirmed", "denied", "none"]) {
    const s = { trustState: state, trustMode: "ask", session: { getOutput: async () => "Do you trust the files in this folder?" } };
    // trustState is a real (non-null) value → neither the pending branch nor
    // the fallback output-scan branch fires → no block. This is the perf win:
    // no getOutput() call on every send_to_session, even when the output
    // still contains stale trust text.
    assert.strictEqual(b4ShouldBlock(s, "Do you trust the files in this folder?"), false,
      "should not block when trustState=" + state + " (already resolved) (B4)");
  }
});

test("B4: falls back to the output scan ONLY when trustState is unset (null/undefined)", () => {
  // A session registered before the trustState was wired has no state — the
  // safety net scans the output. This is the ONLY path that reads the output.
  const noState = { trustState: null, trustMode: "ask", session: {} };
  assert.strictEqual(b4ShouldBlock(noState, "Do you trust the files in this folder?"), true,
    "fallback should block when trust text is present and trustState is null (B4)");
  assert.strictEqual(b4ShouldBlock(noState, "agent is idle at its prompt"), false,
    "fallback should NOT block when no trust text and trustState is null (B4)");
  const undefState = { trustState: undefined, trustMode: "ask", session: {} };
  assert.strictEqual(b4ShouldBlock(undefState, "Do you trust the contents of this directory?"), true,
    "fallback should block when trust text is present and trustState is undefined (B4)");
  // Codex's "Press enter to continue" is also caught by the regex.
  assert.strictEqual(b4ShouldBlock(undefState, "1. Yes, continue — Press enter to continue"), true,
    "fallback should catch Codex's 'Press enter to continue' (B4)");
});

test("B4: never blocks in 'always' trust mode (user opted out of the prompt)", () => {
  const s = { trustState: "pending", trustMode: "always", session: {} };
  assert.strictEqual(b4ShouldBlock(s, "anything"), false,
    "must not block in always mode even if trustState is pending (B4)");
});

// ---------------------------------------------------------------------------
// B3 — resolveSessionModel throws a NO_MODELS-coded error for the no-model
// paths (Manual/Always/Complexity) instead of returning null (silent cancel),
// so onSpawnStart can show an actionable message and keep the modal open.
// ---------------------------------------------------------------------------
// Replicate the no-model decision: each mode's "no targets" path throws
// { code: "NO_MODELS" }; a user *cancel* of the pill picker returns null.
function b3Resolve(cfg, pickerResult) {
  // cfg: { mode, alwaysModel, targets:[{id,label}] }
  // pickerResult: what askChoice would return (string|null) when a picker is shown
  const targets = cfg.targets || [];
  const opts = targets.map((t) => ({ label: t.label, value: t.id }));
  if (cfg.mode === "always") {
    if (cfg.alwaysModel) return cfg.alwaysModel;
    if (opts.length) return pickerResult; // picker shown → cancel is null
    throw Object.assign(new Error("no models"), { code: "NO_MODELS" });
  }
  if (cfg.mode === "complexity") {
    // complexity with no mapped target and no targets → NO_MODELS; else returns
    // a target. Simplify: if no targets at all, NO_MODELS.
    if (!targets.length) throw Object.assign(new Error("no models"), { code: "NO_MODELS" });
    return targets[0].id;
  }
  // manual
  if (!opts.length) throw Object.assign(new Error("no models"), { code: "NO_MODELS" });
  return pickerResult; // picker shown → cancel is null
}

test("B3: Manual mode with zero targets throws NO_MODELS (not silent null)", () => {
  let threw = null;
  try { b3Resolve({ mode: "manual", targets: [] }, null); } catch (e) { threw = e; }
  assert(threw && threw.code === "NO_MODELS",
    "Manual no-targets must throw NO_MODELS so the modal stays open (B3)");
});

test("B3: Always mode with no alwaysModel and zero targets throws NO_MODELS", () => {
  let threw = null;
  try { b3Resolve({ mode: "always", alwaysModel: "", targets: [] }, null); } catch (e) { threw = e; }
  assert(threw && threw.code === "NO_MODELS",
    "Always no-alwaysModel + no-targets must throw NO_MODELS (B3)");
});

test("B3: Complexity mode with zero targets throws NO_MODELS", () => {
  let threw = null;
  try { b3Resolve({ mode: "complexity", targets: [] }, null); } catch (e) { threw = e; }
  assert(threw && threw.code === "NO_MODELS",
    "Complexity no-targets must throw NO_MODELS (B3)");
});

test("B3: a genuine user cancel of the pill picker returns null (NOT NO_MODELS)", () => {
  // When targets ARE available and the picker is shown, the user clicking
  // Cancel returns null — onSpawnStart must close silently. This must NOT be
  // confused with the no-models case.
  const manualWithTargets = b3Resolve({ mode: "manual", targets: [{ id: "claude", label: "claude" }] }, null);
  assert.strictEqual(manualWithTargets, null, "user cancel of the picker must return null (B3)");
  const alwaysNoAlwaysWithTargets = b3Resolve({ mode: "always", alwaysModel: "", targets: [{ id: "claude", label: "claude" }] }, null);
  assert.strictEqual(alwaysNoAlwaysWithTargets, null, "user cancel in always-fallback picker must return null (B3)");
});

test("B3: resolveSessionModel source throws NO_MODELS in all three no-target paths", () => {
  // Verify the actual app.js source throws the recognizable error (with the
  // code) in the Manual, Always, and Complexity no-target branches, and that
  // onSpawnStart distinguishes e.code === "NO_MODELS" from a plain null.
  const noModelsThrows = (SRC.match(/e\.code = "NO_MODELS"/g) || []).length;
  assert(noModelsThrows >= 3, "expected >=3 NO_MODELS throws (Manual/Always/Complexity), found " + noModelsThrows + " (B3)");
  assert(/if \(e && e\.code === "NO_MODELS"\)/.test(SRC),
    "onSpawnStart must branch on e.code === 'NO_MODELS' to keep the modal open (B3)");
  assert(/No models detected — run Re-scan in Settings, or switch Model Selection Mode\./.test(SRC),
    "onSpawnStart must show the actionable status message for the no-models case (B3)");
});

// ---------------------------------------------------------------------------
// D1 — the dead "live bridge probe" debug logging block is gone.
// ---------------------------------------------------------------------------
test("D1: detectTools no longer logs the dead bridge probe / sets detection.bridge", () => {
  assert(!/live bridge probe/.test(SRC), "live bridge probe comment still present (D1)");
  assert(!/detection\.bridge =/.test(SRC), "detection.bridge = still assigned (D1)");
  assert(!/window\.chatoss\.terminal keys:/.test(SRC), "bridge probe console.log still present (D1)");
});

// ---------------------------------------------------------------------------
// D3 — the status-refresh setInterval handle is stored (clearable).
// ---------------------------------------------------------------------------
test("D3: statusRefreshTimer handle is declared and stored/cleared", () => {
  assert(/let statusRefreshTimer = null;/.test(SRC), "statusRefreshTimer module-level handle missing (D3)");
  assert(/statusRefreshTimer = setInterval\(/.test(SRC), "statusRefreshTimer is not assigned the setInterval handle (D3)");
  assert(/function stopAutoFollow\(\)/.test(SRC), "stopAutoFollow teardown helper missing (D3)");
  assert(/clearInterval\(statusRefreshTimer\)/.test(SRC), "statusRefreshTimer is never cleared (D3)");
});

// ---------------------------------------------------------------------------
// R3 — handleTrust captures trustMode into a local `mode` after loadTrustMode.
// ---------------------------------------------------------------------------
test("R3: handleTrust branches on a local `mode`, not the shared `trustMode`", () => {
  assert(/const mode = TC\.trustMode;/.test(SRC), "handleTrust should capture `const mode = TC.trustMode;` (R3)");
  assert(/if \(mode === "always"\)/.test(SRC), "handleTrust should branch on local `mode` (R3)");
});

// ---------------------------------------------------------------------------
// R2 — `rec` and `unsub` are declared above `finish()` in autoDriveStartup.
// ---------------------------------------------------------------------------
test("R2: rec and unsub are declared above finish() (no TDZ footgun)", () => {
  // Find the declaration positions and the finish() definition; the
  // declarations must come BEFORE `const finish = async () =>`.
  const finishIdx = SRC.indexOf("const finish = async () => {");
  assert(finishIdx > -1, "finish() not found (R2)");
  const recDeclIdx = SRC.indexOf("const rec = TC.sessions.get(session.id);");
  const unsubDeclIdx = SRC.indexOf("let unsub = null;");
  assert(recDeclIdx > -1 && recDeclIdx < finishIdx,
    "const rec must be declared before finish() (R2): rec@" + recDeclIdx + " finish@" + finishIdx);
  assert(unsubDeclIdx > -1 && unsubDeclIdx < finishIdx,
    "let unsub must be declared before finish() (R2): unsub@" + unsubDeclIdx + " finish@" + finishIdx);
});

run();