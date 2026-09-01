// Regression test: Model Selection Mode is authoritative for the MODEL an
// agent launches with, and "Always" / "Select-by-complexity" must win over
// everything else — while the saved DEFAULT AGENT (settings.cliDefault) only
// picks WHICH chatoss tool launches, never the model.
//
// v1.28 contract (chatoss launch is the only launch path):
//   1. resolveSessionModel returns a CHATOSS MODEL id. It must NOT consult
//      the Default agent at all — the agent and the model are orthogonal now.
//   2. start_cli_session / spawn_batch: in "always"/"complexity" the
//      configured model launches with NO dialog; in "manual" the spawn modal
//      appears (agent dropdown + model pill picker).
//   3. spawnChosen passes the resolved model as --model and looks the saved
//      effort up under the MODEL id.
//
// Run: node tests/always-target-priority.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { test, run } = require("./harness.js");

const ROOT = path.join(__dirname, "..");
const CX = fs.readFileSync(path.join(ROOT, "js", "09-complexity.js"), "utf8");
const TOOLS = fs.readFileSync(path.join(ROOT, "js", "06-tools.js"), "utf8");
const SPAWN = fs.readFileSync(path.join(ROOT, "js", "07-spawn.js"), "utf8");

// ---------------------------------------------------------------------------
// 1. resolveSessionModel resolves MODELS only — the Default agent is not part
//    of model resolution anymore (the old cliDefault short-circuit is gone by
//    design: cliDefault names an agent, and agents don't imply models).
// ---------------------------------------------------------------------------
test("resolveSessionModel never consults the saved Default agent", () => {
  const start = CX.indexOf("resolveSessionModel = async function");
  assert(start !== -1, "resolveSessionModel found in 09-complexity.js");
  const body = CX.slice(start);
  assert(!/cliDefaultToTargetId/.test(body), "the cliDefault short-circuit must be gone");
  assert(!/TC\.settings\.cliDefault/.test(body), "model resolution must not read the Default agent");
  // The Default agent is exposed separately via getConfig for the spawn path.
  assert(/cliDefault: TC\.normalizeCliDefault\(TC\.settings\.cliDefault \|\| "ask"\)/.test(CX),
    "getModelSelectionConfig still exposes the normalized Default agent");
});

test("always mode returns the configured model unconditionally", () => {
  const start = CX.indexOf("resolveSessionModel = async function");
  const body = CX.slice(start, CX.indexOf("// ---- Complexity: assess + map", start));
  assert(/if \(cfg\.mode === "always"\) \{\s*\n\s*if \(cfg\.alwaysModel\) return cfg\.alwaysModel;/.test(body),
    "always mode must return the configured model unconditionally");
});

test("complexity mode maps low/medium/high to configured models", () => {
  const start = CX.indexOf("resolveSessionModel = async function");
  const body = CX.slice(start);
  assert(/const map = \{\s*\n\s*low: cfg\.complexityModelLow,/.test(body), "complexity map present");
  assert(/map\[level\] \|\| map\.medium \|\| map\.low \|\| map\.high/.test(body),
    "complexity cascades through the levels");
});

// ---------------------------------------------------------------------------
// 2. The orchestrator's fast paths honor Model Selection Mode (source-level):
//    non-manual modes spawn with the configured model and NO dialog; manual
//    mode opens the spawn modal.
// ---------------------------------------------------------------------------
test("start_cli_session gates the no-dialog fast path on non-manual modes", () => {
  const block = TOOLS.slice(TOOLS.indexOf('case "start_cli_session"'), TOOLS.indexOf('case "send_to_session"'));
  assert(/const msMode = \(TC\.modelSelection && TC\.modelSelection\.modelSelectionMode\) \|\| "manual";/.test(block),
    "start_cli_session must read the configured mode");
  assert(/if \(msMode !== "manual"\) \{[\s\S]*TC\.resolveSessionModel/.test(block),
    "non-manual modes must resolve the model through Model Selection Mode");
  assert(/no dialog shown/.test(block), "the fast path must report that no dialog was shown");
  // Manual mode: the spawn modal appears — the user picks the agent (with the
  // Default agent preselected) and the model.
  assert(/TC\.openSpawnModal\(\{[\s\S]*?source: "tool",/.test(block),
    "manual mode opens the spawn modal");
  assert(!/cliDefaultToTargetId/.test(block), "the pinned-default no-modal fast path is gone");
});

test("spawn_batch uses the configured model for all tasks in non-manual modes", () => {
  const end = TOOLS.indexOf('case "delete_worktree"');
  const block = TOOLS.slice(TOOLS.indexOf('case "spawn_batch"'), end > 0 ? end : TOOLS.length);
  assert(/const msMode = \(TC\.modelSelection && TC\.modelSelection\.modelSelectionMode\) \|\| "manual";/.test(block),
    "spawn_batch must gate its single launch choice on the mode");
  assert(/msMode !== "manual"[\s\S]*?TC\.resolveSessionModel/.test(block),
    "non-manual modes resolve the batch model via Model Selection Mode");
  assert(/spawnChosen\(\{ cli, cwd: wtPath, prompt, model \}\)/.test(block),
    "the batch passes the resolved model to spawnChosen");
});

// ---------------------------------------------------------------------------
// 3. spawnChosen applies the resolved model as --model and keys the effort
//    lookup under the MODEL id, so Settings' per-model effort selection works.
// ---------------------------------------------------------------------------
test("spawnChosen applies the resolved model as --model + per-model effort", () => {
  const fn = SPAWN.slice(SPAWN.indexOf("async function spawnChosen"), SPAWN.indexOf("// ---------- Settings panel"));
  assert(/const model = \(choice\.model \|\| choice\.target \|\| TC\.defaultModelId \|\| ""\)\.trim\(\);/.test(fn),
    "the resolved model (with back-compat target field) is read");
  assert(/inner \+= " --model " \+ JSON\.stringify\(model\);/.test(fn), "the model is passed as --model");
  assert(/const effortTargetId = model \|\| null;/.test(fn), "the effort is keyed under the model id");
  assert(/const effort = TC\.effortForTarget\(effortTargetId\);/.test(fn), "per-model effort is applied at launch");
});

run();