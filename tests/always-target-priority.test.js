// Regression test: "Always use a specific target" must actually launch the
// target the user picked — model AND effort.
//
// Root cause: resolveSessionModel applied the legacy "Default agent" pin
// (settings.cliDefault, e.g. "raw:claude") BEFORE the mode branches, and the
// orchestrator's start_cli_session / spawn_batch spawned from cliDefault
// without consulting Model Selection Mode at all. A user who once ticked
// "Remember as default" on Claude therefore got Claude every time, no matter
// what Always / Select-by-complexity said.
//
// New contract:
//   1. Guard predicate (VERBATIM replication from 09-complexity.js, the same
//      technique default-launch-apply.test.js uses): the cliDefault
//      short-circuit fires ONLY in manual mode — so always/complexity win
//      over a pinned default.
//   2. Source-level: start_cli_session / spawn_batch resolve through
//      TC.resolveSessionModel in non-manual modes; manual keeps the fast path.
//   3. The real resolveSessionModel source contains the manual-only gate.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { test, run } = require("./harness.js");

const ROOT = path.join(__dirname, "..");
const CX = fs.readFileSync(path.join(ROOT, "js", "09-complexity.js"), "utf8");
const TOOLS = fs.readFileSync(path.join(ROOT, "js", "06-tools.js"), "utf8");

// ---------------------------------------------------------------------------
// 1. Guard predicate — VERBATIM from resolveSessionModel (keep in sync!).
//    Sync on purpose: the promise wiring around it is trivial; the CONTRACT is
//    what value wins in each mode.
// ---------------------------------------------------------------------------
function manualOnlyDefaultPin(mode, defId, ids) {
  // ---- Saved default launch applies ONLY in Manual mode. ---- (verbatim)
  if (mode === "manual") {
    if (defId && ids.includes(defId)) return defId;
  }
  return null;
}

test("guard: pinned claude default does NOT veto always mode", () => {
  const ids = ["claude", "glm-5.2:cloud"];
  assert.strictEqual(manualOnlyDefaultPin("manual", "claude", ids), "claude", "manual keeps the remember-my-pick convenience");
  assert.strictEqual(manualOnlyDefaultPin("always", "claude", ids), null, "always mode ignores the pinned default");
  assert.strictEqual(manualOnlyDefaultPin("complexity", "claude", ids), null, "complexity mode ignores the pinned default");
});

test("resolveSessionModel source gates the cliDefault short-circuit on manual mode", () => {
  const start = CX.indexOf("resolveSessionModel = async function");
  assert(start !== -1, "resolveSessionModel found in 09-complexity.js");
  const body = CX.slice(start, CX.indexOf("// ---- Complexity: assess + map", start));
  // The default-pin short-circuit must sit INSIDE an `if (cfg.mode === "manual")` block…
  assert(/if \(cfg\.mode === "manual"\) \{[\s\S]*?cliDefaultToTargetId\(cfg\.cliDefault\)[\s\S]*?return defId;[\s\S]*?\}/.test(body),
    "the cliDefault short-circuit must be inside the manual-mode gate");
  // …and the ALWAYS branch must come after it and win in non-manual modes.
  const alwaysIx = body.indexOf('cfg.mode === "always"');
  const manualIx = body.indexOf('cfg.mode === "manual"');
  assert(alwaysIx > manualIx - 1 && alwaysIx !== -1, "always branch present");
  assert(/if \(cfg\.mode === "always"\) \{\s*\n\s*if \(cfg\.alwaysModel\) return cfg\.alwaysModel;/.test(body),
    "always mode must return the configured target unconditionally");
});

// ---------------------------------------------------------------------------
// 2. The orchestrator's fast paths honor Model Selection Mode (source-level).
// ---------------------------------------------------------------------------
test("start_cli_session fast path is gated on manual mode", () => {
  const block = TOOLS.slice(TOOLS.indexOf('case "start_cli_session"'), TOOLS.indexOf('case "send_to_session"'));
  assert(/const msMode = \(TC\.modelSelection && TC\.modelSelection\.modelSelectionMode\) \|\| "manual";/.test(block),
    "start_cli_session must read the configured mode");
  assert(/if \(msMode !== "manual"\) \{[\s\S]*TC\.resolveSessionModel/.test(block),
    "non-manual modes must resolve through Model Selection Mode");
  const fast = block.slice(block.indexOf("const defId = TC.cliDefaultToTargetId"));
  assert(fast.includes("spawnChosen"), "manual mode keeps the remembered-default fast path");
});

test("spawn_batch uses the configured target for all tasks in non-manual modes", () => {
  const end = TOOLS.indexOf('case "delete_worktree"');
  const block = TOOLS.slice(TOOLS.indexOf('case "spawn_batch"'), end > 0 ? end : TOOLS.length);
  assert(/const msMode = \(TC\.modelSelection && TC\.modelSelection\.modelSelectionMode\) \|\| "manual";/.test(block),
    "spawn_batch must gate its single launch choice on the mode");
  assert(/msMode !== "manual"[\s\S]*?TC\.resolveSessionModel/.test(block),
    "non-manual modes resolve the batch target via Model Selection Mode");
});

// ---------------------------------------------------------------------------
// 3. Launch-path behavior for an ollama target (spawnChosen, source-level):
//    the resolved target id flows into --model, and the per-target effort is
//    looked up under the target id so Settings' effort selection applies.
// ---------------------------------------------------------------------------
test("spawnChosen routes an always-mode ollama target to --model + effort lookup", () => {
  const src = fs.readFileSync(path.join(ROOT, "js", "07-spawn.js"), "utf8");
  const fn = src.slice(src.indexOf("async function spawnChosen"), src.indexOf("// ---------- Settings panel"));
  assert(/const target = TC\.findLaunchTarget\(choice\.target\);/.test(fn), "spawnChosen resolves the chosen target");
  assert(/inner \+= " --model " \+ JSON\.stringify\(model\);/.test(fn), "ollama launches apply the model");
  assert(/const effort = TC\.effortForTarget\(effortTargetId\);/.test(fn), "per-target effort is applied at launch");
});

run();