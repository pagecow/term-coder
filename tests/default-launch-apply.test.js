// Feature test: the saved DEFAULT LAUNCH is applied on session start instead of
// re-asking every time (the launch-pick bug).
//
// BUG FIXED: the user pinned a default launch (Settings "Default agent" picker
// #set-cli and/or the spawn-modal "Remember as default" checkbox), but the
// orchestrator kept showing the launch-target pill picker on every session
// because resolveSessionModel (the picker) never read settings.cliDefault.
// A second half of the bug: "Remember as default" saved the spawn-dropdown
// tool value, not the launch target the user actually picked.
//
// app.js is a browser module (top-level window/document/window.chatoss + an
// auto-running init()), so it can't be `require`d whole in Node. Following the
// audit-fixes / default-agents-picker test pattern, these tests:
//   1. Parse the REAL app.js source as text.
//   2. Extract the pure helper `cliDefaultToTargetId` with a brace-balancing
//      parser and EXECUTE it against controlled inputs — exercises the real
//      mapping, not a hand copy.
//   3. Extract the `onSpawnStart` "Remember as default" block and EXECUTE it
//      with a stubbed findLaunchTarget to prove it writes the CHOSEN launch
//      target (raw:<id> for a direct CLI; the spawn-dropdown tool for an
//      ollama model) — i.e. it round-trips through the set-cli value space so
//      the Settings picker and the remembered default agree.
//   4. Replicate the resolveSessionModel guard predicate VERBATIM from app.js
//      and assert the saved default short-circuits the picker (returns the
//      target with no prompt) while "Ask me every time" falls through to the
//      Model Selection Mode logic.
//   5. Source-regex assertions prove the guard sits BEFORE the mode branches
//      and that getModelSelectionConfig exposes cliDefault.
//
// Run: node tests/default-launch-apply.test.js   (no test runner, no deps)

const fs = require("fs");
const path = require("path");
const { assert, test, run } = require("./harness.js");

const SRC = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

// ---------------------------------------------------------------------------
// Helpers: brace-balance extract a top-level `function name(...)` body, and
// extract a specific `if (remember) { ... }` block, out of the REAL source so
// the tests execute the real code.
// ---------------------------------------------------------------------------

// Extract the body (statements between the outer braces) of a top-level
// `function name(...)` declaration from src. Throws if not found.
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
  return src.slice(m.index + m[0].length, i - 1);
}

// Build a CALLABLE (not yet invoked) from an extracted function body, declaring
// the named free variables as parameters. The body of cliDefaultToTargetId
// references only `value`, so ["value"] makes a reusable fn(value).
function makeCallable(body, paramNames) {
  // eslint-disable-next-line no-new-func
  return Function(...paramNames, body);
}

// Extract the `if (remember) { ... }` block from onSpawnStart (the block that
// persists the chosen launch as the default). Returns the full statement
// including the `if (remember) {` ... `}` braces so it can be run as-is.
function extractRememberBlock(src) {
  const marker = "if (remember) {";
  const start = src.indexOf(marker);
  assert(start !== -1, "'if (remember) {' block not found in app.js");
  let i = start + marker.length;
  let depth = 1;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  assert(depth === 0, "unbalanced braces in the remember block");
  return src.slice(start, i);
}

// Build a callable from the remember block. The block references: remember,
// target, cli, cwd, findLaunchTarget, settings, saveSettings. We append a
// `return settings;` so the runner exposes what got written.
function makeRememberRunner(block) {
  // eslint-disable-next-line no-new-func
  return new Function(
    "remember", "target", "cli", "cwd", "findLaunchTarget", "settings", "saveSettings",
    block + "\nreturn settings;"
  );
}

// A saveSettings stub that records whether it was called, on the function
// object itself (visible to the outer test because the same object is passed in).
function recordingSave() {
  const fn = function saveSettings() { fn._called = true; };
  fn._called = false;
  return fn;
}

// ---------------------------------------------------------------------------
// 1. cliDefaultToTargetId maps direct-binary defaults to launch-target ids and
//    returns null for "ask" / bare ollama-tool names / anything that should not
//    auto-apply. (Executes the REAL function body.)
// ---------------------------------------------------------------------------
const cliDefaultToTargetId = makeCallable(extractFunctionBody(SRC, "cliDefaultToTargetId"), ["value"]);

test("cliDefaultToTargetId maps raw: direct defaults to launch-target ids", () => {
  assert.strictEqual(cliDefaultToTargetId("raw:claude"), "claude", "raw:claude -> claude");
  assert.strictEqual(cliDefaultToTargetId("raw:codex"), "codex", "raw:codex -> codex");
  assert.strictEqual(cliDefaultToTargetId("raw:opencode"), "opencode", "raw:opencode -> opencode");
});

test("cliDefaultToTargetId returns null for 'ask' / empty / missing (must show picker)", () => {
  for (const v of ["ask", "", null, undefined]) {
    assert.strictEqual(cliDefaultToTargetId(v), null, "ask/empty/missing must NOT auto-apply: " + JSON.stringify(v));
  }
});

test("cliDefaultToTargetId returns null for bare ollama-tool names + non-strings (need a model, fall through)", () => {
  // Bare ollama-tool names from the set-cli picker — these are launch TOOLS,
  // not self-contained targets; they must fall through to the picker.
  for (const v of ["claude", "codex", "chatgpt", "hermes", "opencode", "copilot", "ollama"]) {
    assert.strictEqual(cliDefaultToTargetId(v), null, "bare ollama-tool name must NOT auto-apply: " + JSON.stringify(v));
  }
  // Non-strings and a malformed "raw:" with no id.
  assert.strictEqual(cliDefaultToTargetId(123), null, "non-string must return null");
  assert.strictEqual(cliDefaultToTargetId({}), null, "object must return null");
  assert.strictEqual(cliDefaultToTargetId("raw:"), null, "raw: with no id must return null");
  // A legacy value not in the set-cli picker.
  assert.strictEqual(cliDefaultToTargetId("something:legacy"), null, "unknown value must return null");
});

// ---------------------------------------------------------------------------
// 2. resolveSessionModel applies the saved default BEFORE the mode branches and
//    only falls through to the picker when the default is "ask"/unset/unmapped.
// ---------------------------------------------------------------------------
test("resolveSessionModel source consults cliDefault before the mode branches", () => {
  // The guard: const defId = cliDefaultToTargetId(cfg.cliDefault);
  //            if (defId && ids.includes(defId)) return defId;
  assert(/cliDefaultToTargetId\(cfg\.cliDefault\)/.test(SRC),
    "resolveSessionModel must map cfg.cliDefault via cliDefaultToTargetId");
  assert(/if \(defId && ids\.includes\(defId\)\) return defId;/.test(SRC),
    "resolveSessionModel must short-circuit return the default target when available");
  // getModelSelectionConfig must expose cliDefault so the guard has it.
  assert(/cliDefault: settings\.cliDefault \|\| "ask"/.test(SRC),
    "getModelSelectionConfig must expose settings.cliDefault as cfg.cliDefault");
  // The guard must appear BEFORE the first mode branch (cfg.mode === "always").
  const guardIdx = SRC.indexOf("cliDefaultToTargetId(cfg.cliDefault)");
  const firstModeIdx = SRC.indexOf('if (cfg.mode === "always")');
  assert(guardIdx !== -1 && firstModeIdx !== -1 && guardIdx < firstModeIdx,
    "the default-launch guard must run BEFORE the Model Selection Mode branches (guard=" +
      guardIdx + ", firstMode=" + firstModeIdx + ")");
});

test("saved direct default short-circuits the picker; 'ask' falls through (verbatim guard)", () => {
  // Verbatim guard predicate from app.js:
  //   const defId = cliDefaultToTargetId(cfg.cliDefault);
  //   if (defId && ids.includes(defId)) return defId;
  // null = guard did not short-circuit -> falls through to mode logic (picker).
  const guard = (cfg, ids) => {
    const defId = cliDefaultToTargetId(cfg.cliDefault);
    if (defId && ids.includes(defId)) return defId;
    return null;
  };
  const idsDirect = ["claude", "codex", "qwen3:30b"];

  // A direct-CLI default that IS among the available targets -> applied, no picker.
  assert.strictEqual(guard({ cliDefault: "raw:claude" }, idsDirect), "claude",
    "raw:claude default with claude available must auto-apply (no picker)");
  assert.strictEqual(guard({ cliDefault: "raw:codex" }, idsDirect), "codex",
    "raw:codex default with codex available must auto-apply (no picker)");

  // "Ask me every time" -> null -> falls through to the Model Selection Mode
  // logic (picker shown in manual mode).
  assert.strictEqual(guard({ cliDefault: "ask" }, idsDirect), null,
    "'ask' must NOT short-circuit — picker still shown per Model Selection Mode");
  assert.strictEqual(guard({ cliDefault: "" }, idsDirect), null,
    "empty default must fall through to the picker");

  // A default whose target is NOT currently available (e.g. user uninstalled
  // claude) -> null -> falls through. Graceful, never a silent wrong launch.
  assert.strictEqual(guard({ cliDefault: "raw:claude" }, ["codex", "qwen3:30b"]), null,
    "default for an unavailable target must fall through (no wrong launch)");

  // A bare ollama-tool default (e.g. "ollama launch claude") -> null -> falls
  // through. These need a model the default doesn't carry, so the picker is
  // still the right behavior.
  assert.strictEqual(guard({ cliDefault: "claude" }, idsDirect), null,
    "bare ollama-tool default must fall through (needs a model)");
});

test("saved default takes priority over an 'always' mode target (default is the most explicit choice)", () => {
  // The guard runs before the mode branches, so a pinned direct default wins
  // over an "always" mode configuration. This documents the intended priority.
  const ids = ["claude", "codex"];
  const defId = cliDefaultToTargetId("raw:claude");
  // Guard short-circuits; the alwaysModel ("codex") would only be reached if
  // the guard did not fire.
  assert(defId === "claude" && ids.includes(defId),
    "raw:claude must resolve to a usable defId before the always-branch is reached");
});

// ---------------------------------------------------------------------------
// 3. "Remember as default" writes the CHOSEN LAUNCH TARGET (not the spawn
//    dropdown tool) and round-trips through the set-cli value space.
//    (Executes the REAL remember block from onSpawnStart.)
// ---------------------------------------------------------------------------
const REMEMBER_BLOCK = extractRememberBlock(SRC);
const REMEMBER_RUNNER = makeRememberRunner(REMEMBER_BLOCK);

// findLaunchTarget stub: direct CLIs + one ollama model, mirroring
// availableLaunchTargets() in app.js.
function stubFindLaunchTarget(id) {
  if (id === "claude") return { kind: "direct", id: "claude", bin: "/usr/local/bin/claude" };
  if (id === "codex") return { kind: "direct", id: "codex", bin: "/usr/local/bin/codex" };
  if (id === "qwen3:30b") return { kind: "ollama", id: "qwen3:30b", model: "qwen3:30b" };
  return null;
}

test("Remember as default source writes the chosen target, not the dropdown tool", () => {
  // Prove the block computes the default from the chosen target, not merely cli.
  assert(/findLaunchTarget\(target\)/.test(REMEMBER_BLOCK),
    "remember block must look up the chosen target via findLaunchTarget(target)");
  assert(/tgt\.kind === "direct"/.test(REMEMBER_BLOCK),
    "remember block must branch on the target kind (direct vs ollama)");
  assert(/"raw:" \+ tgt\.id/.test(REMEMBER_BLOCK),
    "remember block must persist a direct target as 'raw:' + tgt.id");
});

test("Remember as default writes raw:<id> for a DIRECT launch target", () => {
  const settings = {};
  const saveSettings = recordingSave();
  const out = REMEMBER_RUNNER(true, "claude", "claude", "/proj", stubFindLaunchTarget, settings, saveSettings);
  assert.strictEqual(out.cliDefault, "raw:claude",
    "direct claude launch + Remember must save 'raw:claude' (not the dropdown 'claude'), got: " + JSON.stringify(out.cliDefault));
  assert.strictEqual(out.cwdDefault, "/proj", "Remember must also persist the cwd");
  assert(saveSettings._called, "Remember must call saveSettings()");
});

test("Remember as default writes the spawn-dropdown tool for an OLLAMA model target", () => {
  const settings = {};
  const saveSettings = recordingSave();
  // Ollama model target: there is no self-contained set-cli value for a model,
  // so the block falls back to the spawn-dropdown tool id ("codex") — which IS
  // a valid set-cli option, keeping the Settings picker and the remembered
  // default consistent.
  const out = REMEMBER_RUNNER(true, "qwen3:30b", "codex", "/proj", stubFindLaunchTarget, settings, saveSettings);
  assert.strictEqual(out.cliDefault, "codex",
    "ollama model target + Remember must fall back to the spawn-dropdown tool 'codex', got: " + JSON.stringify(out.cliDefault));
  assert(saveSettings._called, "ollama Remember must still call saveSettings()");
});

test("Remember as default does not write anything when the checkbox is unchecked", () => {
  const settings = { cliDefault: "ask", cwdDefault: "" };
  const saveSettings = recordingSave();
  const out = REMEMBER_RUNNER(false, "claude", "claude", "/proj", stubFindLaunchTarget, settings, saveSettings);
  assert.strictEqual(out.cliDefault, "ask", "unchecked Remember must not overwrite the existing default");
  assert.strictEqual(out.cwdDefault, "", "unchecked Remember must not overwrite the cwd");
  assert(!saveSettings._called, "unchecked Remember must not call saveSettings()");
});

// ---------------------------------------------------------------------------
// 4. Round-trip: a remembered direct default is applied on the NEXT session.
//    (Wires the remember block + the guard together end-to-end.)
// ---------------------------------------------------------------------------
test("round-trip: a direct launch remembered this session is auto-applied next session", () => {
  // Session 1: user picks DIRECT claude in the pill picker and checks Remember.
  const settings = { cliDefault: "ask" };
  const saveSettings = recordingSave();
  const persisted = REMEMBER_RUNNER(true, "claude", "claude", "/proj", stubFindLaunchTarget, settings, saveSettings);
  assert.strictEqual(persisted.cliDefault, "raw:claude",
    "session 1 should persist 'raw:claude', got: " + JSON.stringify(persisted.cliDefault));

  // Session 2: resolveSessionModel reads settings.cliDefault and, because it
  // maps to an available target, returns it WITHOUT showing the picker.
  const availableIds = ["claude", "codex", "qwen3:30b"];
  const defId = cliDefaultToTargetId(persisted.cliDefault);
  const applied = (defId && availableIds.includes(defId)) ? defId : null;
  assert.strictEqual(applied, "claude",
    "session 2 should auto-apply 'claude' from the persisted default (no picker), got: " + JSON.stringify(applied));

  // Session 2 with "ask": no auto-apply -> picker is shown (manual mode).
  const askDefId = cliDefaultToTargetId("ask");
  const askApplied = (askDefId && availableIds.includes(askDefId)) ? askDefId : null;
  assert.strictEqual(askApplied, null, "'ask' default must NOT auto-apply — the picker is shown instead");
});

run();