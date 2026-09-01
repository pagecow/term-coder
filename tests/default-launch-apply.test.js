// Feature test (v1.28): the saved DEFAULT AGENT round-trips through the new
// chatoss-launch value space.
//
// CONTRACT: settings.cliDefault holds a chatoss launch tool id —
// "ask" | "opencode" | "claude-code" | "codex" — shared by the Settings
// "Default agent" picker (#set-cli) and the spawn-modal "Remember as defaults"
// checkbox. The model the session uses is governed SEPARATELY by Model
// Selection Mode (see 09-complexity.js / always-target-priority.test.js), so
// the default agent alone never picks a model.
//
//   1. "Remember as defaults" stores the dropdown's tool id verbatim (the old
//      code mangled it into a "raw:<id>" value).
//   2. Legacy values saved by older builds ("claude", "raw:*", ollama model
//      ids) are normalized by normalizeCliDefault — never left dangling.
//   3. init() migrates a legacy saved value once at load.
//   4. openSettings normalizes before reflecting the value into #set-cli.
//   5. The Settings picker and the spawn dropdown share ONE value space.
//
// Run: node tests/default-launch-apply.test.js   (no test runner, no deps)

const fs = require("fs");
const path = require("path");
const { assert, test, run } = require("./harness.js");

const ROOT = path.join(__dirname, "..");
const SPAWN = fs.readFileSync(path.join(ROOT, "js", "07-spawn.js"), "utf8");
const SETTINGS = fs.readFileSync(path.join(ROOT, "js", "08-settings.js"), "utf8");
const INIT = fs.readFileSync(path.join(ROOT, "js", "24-init.js"), "utf8");
const HTML = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function extractFunctionBody(src, name) {
  const header = new RegExp("function " + name + "\\s*\\(([^)]*)\\)\\s*\\{");
  const m = header.exec(src);
  assert(m, "function " + name + " not found");
  let i = m.index + m[0].length;
  let depth = 1;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  return src.slice(m.index + m[0].length, i - 1);
}

function makeFn(body, params) {
  // eslint-disable-next-line no-new-func
  return Function(...Object.keys(params), body)(...Object.values(params));
}

// The REAL normalizeCliDefault, executed against controlled inputs.
function realNormalize(value) {
  const body = extractFunctionBody(SETTINGS, "normalizeCliDefault");
  // normalizeCliDefault self-recurses for the raw: prefix — build it as a
  // named function expression with a self reference bound as a free variable.
  // eslint-disable-next-line no-new-func
  const factory = Function("normalizeCliDefault", "return (function normalizeCliDefault(value) {" + body + "});");
  const fn = factory(null);
  return factory(fn)(value);
}

// ---------------------------------------------------------------------------
// 1. normalizeCliDefault: the full migration table (real function body).
// ---------------------------------------------------------------------------
test("normalizeCliDefault: new value space passes through unchanged", () => {
  for (const v of ["ask", "opencode", "claude-code", "codex"]) {
    assert.strictEqual(realNormalize(v), v, v + " must round-trip");
  }
});

test("normalizeCliDefault: legacy values migrate to chatoss tool ids", () => {
  assert.strictEqual(realNormalize("claude"), "claude-code", "bare 'claude' is the legacy spelling of claude-code");
  assert.strictEqual(realNormalize("raw:claude"), "claude-code");
  assert.strictEqual(realNormalize("raw:claude-code"), "claude-code");
  assert.strictEqual(realNormalize("raw:codex"), "codex");
  assert.strictEqual(realNormalize("raw:opencode"), "opencode");
  assert.strictEqual(realNormalize("codex"), "codex");
  assert.strictEqual(realNormalize("opencode"), "opencode");
  assert.strictEqual(realNormalize(" claude-code "), "claude-code", "whitespace is trimmed");
});

test("normalizeCliDefault: non-agents (models, tool typos, null) fall back to ask", () => {
  for (const v of ["qwen3:30b", "glm-5.3:cloud", "chatgpt", "hermes", "copilot", "ollama", "", null, undefined, 42]) {
    assert.strictEqual(realNormalize(v), "ask",
      "an ollama model id no longer names a launchable agent — must ask: " + JSON.stringify(v));
  }
});

// ---------------------------------------------------------------------------
// 2. "Remember as defaults" stores the dropdown tool id verbatim — the old
//    raw:<id> mangling is gone.
// ---------------------------------------------------------------------------
test("spawn modal 'Remember as defaults' stores the chosen chatoss tool id", () => {
  const ix = SPAWN.indexOf("if (remember) {");
  assert(ix !== -1, "remember block found in onSpawnStart");
  const block = SPAWN.slice(ix, SPAWN.indexOf("}", SPAWN.indexOf("TC.saveSettings();", ix)) + 1);
  assert(/TC\.settings\.cliDefault = cli;/.test(block),
    "the dropdown value (a chatoss tool id) must be stored verbatim");
  assert(!/raw:/.test(block), "the raw: mangling must be gone");
  assert(!/findLaunchTarget/.test(block), "the model is NOT remembered as the agent");
});

// ---------------------------------------------------------------------------
// 3. init() migrates a legacy saved cliDefault once at load.
// ---------------------------------------------------------------------------
test("init() normalizes the persisted cliDefault at load", () => {
  assert(/normalizeCliDefault\(TC\.settings\.cliDefault\)/.test(INIT),
    "init() must normalize settings.cliDefault");
  assert(/TC\.settings\.cliDefault = norm;/.test(INIT),
    "the normalized value must be written back");
  assert(/TC\.saveSettings\(\);/.test(INIT.slice(INIT.indexOf("v1.28 migration"))),
    "the migration persists immediately");
});

// ---------------------------------------------------------------------------
// 4. openSettings reflects the normalized value into #set-cli (never blank).
// ---------------------------------------------------------------------------
test("openSettings reflects the normalized default into the picker", () => {
  assert(/TC\.el\.setCli\.value = TC\.normalizeCliDefault\(TC\.settings\.cliDefault\) \|\| "ask";/.test(SPAWN),
    "openSettings must normalize before selecting");
});

// ---------------------------------------------------------------------------
// 5. ONE shared value space: #set-cli option values === dropdown values ===
//    CHATOSS_LAUNCH_TOOLS ids.
// ---------------------------------------------------------------------------
test("Settings picker and spawn dropdown share the chatoss tool value space", () => {
  const sel = HTML.match(/<select id="set-cli"[^>]*>([\s\S]*?)<\/select>/);
  assert(sel, "set-cli select not found");
  const htmlValues = [...sel[1].matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(htmlValues, ["ask", "opencode", "claude-code", "codex"],
    "set-cli values drifted: " + JSON.stringify(htmlValues));
  const stateSrc = fs.readFileSync(path.join(ROOT, "js", "00-state.js"), "utf8");
  const m = stateSrc.match(/const CHATOSS_LAUNCH_TOOLS = (\[[\s\S]*?\]);/);
  assert(m, "CHATOSS_LAUNCH_TOOLS not found");
  const tools = Function('"use strict"; return (' + m[1] + ');')();
  assert.deepStrictEqual(tools.map((t) => t.id), htmlValues.slice(1),
    "CHATOSS_LAUNCH_TOOLS ids must equal the picker's tool options");
});

run();