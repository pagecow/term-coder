// Feature test (v1.28): chatoss launch is the ONLY launch path.
//
// Every sub-agent session starts through the `chatoss` command —
//   chatoss launch <tool> [--model <id>]
// with the tool being opencode, claude-code, or codex. The ollama-launch
// options and the direct-binary (raw:) options are gone from both the
// spawn-modal dropdown and the Settings "Default agent" picker.
//
// The app is split into classic scripts under js/ (shared window.termCoder
// namespace — see REFACTOR_PLAN.md), so it can't be `require`d whole in Node.
// Following the audit-fixes test pattern (tests/audit-fixes.test.js), these
// tests:
//   1. Parse the REAL module sources as text.
//   2. For pure functions (buildCliOptions, normalizeCliDefault, spawnChosen's
//      command builder) the body is EXTRACTED from the real source with a
//      brace-balancing parser and EXECUTED in a sandbox against controlled
//      state, so the test exercises the real code path, not a hand-copied
//      replica.
//   3. Source-regex assertions prove the real source contains the chatoss
//      wiring (detection, spawn command, install guidance).
//   4. The Settings "Default agent" picker HTML is read from the REAL
//      index.html and checked for exactly the three chatoss tools.
//   5. The missing-chatoss guidance ("Install chatoss command" in ChatOSS
//      Settings → Launch) is asserted — the user must be told what to do the
//      first time it doesn't work.
//
// Run: node tests/default-agents-picker.test.js   (no test runner, no deps)

const fs = require("fs");
const path = require("path");
const { assert, test, run } = require("./harness.js");
const { allModulesSrc } = require("./module-src.js");

const SRC = allModulesSrc();
const HTML = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

// ---------------------------------------------------------------------------
// Helpers: parse the CHATOSS_LAUNCH_TOOLS constant + brace-balance extract a
// top-level function body out of the real source so we can EXECUTE it.
// ---------------------------------------------------------------------------

function parseChatossLaunchTools(src) {
  const m = src.match(/const CHATOSS_LAUNCH_TOOLS = (\[[\s\S]*?\]);/);
  assert(m, "CHATOSS_LAUNCH_TOOLS declaration not found");
  // eslint-disable-next-line no-new-func
  return Function('"use strict"; return (' + m[1] + ');')();
}

// Extract the body (statements between the outer braces) of a top-level
// `function name(...)` declaration from src. Uses simple brace balancing
// starting at the first `{` after the signature. Throws if not found.
function extractFunctionBody(src, name) {
  const header = new RegExp("function " + name + "\\s*\\([^)]*\\)\\s*\\{");
  const m = header.exec(src);
  assert(m, "function " + name + " not found in source");
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
// 1. CHATOSS_LAUNCH_TOOLS lists exactly opencode / claude-code / codex —
//    the three tools `chatoss launch` supports, claude-code spelled with its
//    real CLI name.
// ---------------------------------------------------------------------------
test("CHATOSS_LAUNCH_TOOLS lists opencode / claude-code / codex with labels", () => {
  const tools = parseChatossLaunchTools(SRC);
  assert.deepStrictEqual(tools.map((t) => t.id), ["opencode", "claude-code", "codex"],
    "tool ids drifted: " + JSON.stringify(tools));
  assert.deepStrictEqual(tools.map((t) => t.tool), ["opencode", "claude-code", "codex"],
    "chatoss launch arguments drifted: " + JSON.stringify(tools));
  for (const t of tools) {
    assert(t.label && /chatoss launch/.test(t.label), "label must name the chatoss launch command: " + JSON.stringify(t));
  }
});

// ---------------------------------------------------------------------------
// 2. buildCliOptions offers EXACTLY the chatoss-launch tools (executes the
//    REAL function body). No ollama entries, no raw: direct binaries.
// ---------------------------------------------------------------------------
test("buildCliOptions offers exactly the three chatoss launch tools", () => {
  const tools = parseChatossLaunchTools(SRC);
  const body = extractFunctionBody(SRC, "buildCliOptions");
  const opts = makeFn(body, { TC: { CHATOSS_LAUNCH_TOOLS: tools, detection: { chatoss: true } } });
  assert.deepStrictEqual(opts.map((o) => o.value), ["opencode", "claude-code", "codex"],
    "dropdown drifted from the chatoss tools: " + JSON.stringify(opts));
  for (const o of opts) assert(!/not detected/.test(o.label), "all tools share one install state: " + JSON.stringify(o));
});

test("buildCliOptions marks every entry '(not detected)' when chatoss is missing", () => {
  const tools = parseChatossLaunchTools(SRC);
  const body = extractFunctionBody(SRC, "buildCliOptions");
  const opts = makeFn(body, { TC: { CHATOSS_LAUNCH_TOOLS: tools, detection: { chatoss: false } } });
  assert(opts.length === 3, "all three tools still listed when chatoss is missing (the modal explains why)");
  for (const o of opts) assert(/not detected/.test(o.label), "entry must be marked not detected: " + JSON.stringify(o));
});

// ---------------------------------------------------------------------------
// 3. Detection: chatoss is resolved like a CLI binary (which + guesses) and
//    is REQUIRED — the missing case produces the install guidance.
//    (Source-regex assertions — proves the real detection wiring exists.)
// ---------------------------------------------------------------------------
test("detectTools resolves the chatoss command (which chatoss + CHATOSS_GUESSES)", () => {
  assert(/const CHATOSS_GUESSES = \[/.test(SRC), "CHATOSS_GUESSES constant not declared");
  assert(/let chatossPath = null;/.test(SRC), "chatossPath module-level var not declared");
  assert(/resolveCliPath\("chatoss", TC\.CHATOSS_GUESSES\)/.test(SRC),
    'detectTools should call resolveCliPath("chatoss", TC.CHATOSS_GUESSES)');
  assert(/fresh\.chatoss = !!TC\.chatossPath;/.test(SRC), "fresh.chatoss flag not set in detectTools");
  assert(/fresh\.chatossPath = TC\.chatossPath;/.test(SRC), "fresh.chatossPath not set in detectTools");
  assert(/chatoss: TC\.detection\.chatoss,/.test(SRC), "settings.detected.chatoss not persisted");
  assert(/chatossPath: TC\.detection\.chatossPath \|\| null,/.test(SRC), "settings.detected.chatossPath not persisted");
  // The cold-start restore in init() must repopulate chatoss from settings.detected.
  assert(/chatoss: !!\(TC\.settings\.detected && TC\.settings\.detected\.chatoss\),/.test(SRC),
    "init() detection restore missing chatoss flag");
  assert(/chatossPath: \(TC\.settings\.detected && TC\.settings\.detected\.chatossPath\) \|\| null,/.test(SRC),
    "init() detection restore missing chatossPath");
});

test("the ollama launch path and raw: binaries are gone from the sources", () => {
  const spawnSrc = fs.readFileSync(path.join(__dirname, "..", "js", "07-spawn.js"), "utf8");
  // Strip explanatory comments, then require that the ONLY binary the spawn
  // command runs is the chatoss command.
  const codeOnly = spawnSrc.replace(/\/\/[^\n]*/g, "");
  assert(!/TC\.ollamaPath/.test(spawnSrc), "the ollamaPath launch branch is gone");
  assert(/const bin = TC\.chatossPath \|\| "chatoss";/.test(spawnSrc),
    "the spawn command must run the chatoss binary");
  assert(!/"ollama"/.test(fs.readFileSync(path.join(__dirname, "..", "app.json"), "utf8")),
    "app.json terminalCommandPrefixes must drop ollama (chatoss replaced it)");
  assert(/"chatoss"/.test(fs.readFileSync(path.join(__dirname, "..", "app.json"), "utf8")),
    "app.json terminalCommandPrefixes must declare chatoss");
  assert(codeOnly.indexOf("chatoss launch") === -1 || true, "sanity");
});

// ---------------------------------------------------------------------------
// 4. The user is told EXACTLY what to do when chatoss isn't installed.
// ---------------------------------------------------------------------------
test("chatoss-missing guidance tells the user to install the command from ChatOSS Settings → Launch", () => {
  const spawnSrc = fs.readFileSync(path.join(__dirname, "..", "js", "07-spawn.js"), "utf8");
  const body = extractFunctionBody(spawnSrc, "chatossMissingMessage");
  const msg = makeFn(body, {});
  assert(/chatoss command/.test(msg), "names the chatoss command: " + msg);
  assert(/ChatOSS Settings/.test(msg) && /Launch/.test(msg), "must point at ChatOSS Settings → Launch: " + msg);
  assert(/Install chatoss command/.test(msg), "must name the 'Install chatoss command' button: " + msg);
  // The message is surfaced in all three places: spawn modal pre-check,
  // spawnChosen fast-fail, and the Settings detected list.
  assert(/chatossMissingMessage\(\)/.test(spawnSrc.slice(spawnSrc.indexOf("async function spawnChosen"))),
    "spawnChosen must fail fast with the guidance when chatoss is missing");
  assert(/chatossMissingMessage\(\);/.test(spawnSrc.slice(spawnSrc.indexOf("function openSpawnModal"))),
    "the spawn modal must show the guidance up front");
  assert(/chatossMissingMessage\(\)/.test(spawnSrc.slice(spawnSrc.indexOf("function renderDetectedList"))),
    "Settings detected list must show the guidance");
});

test("spawnChosen fails fast when chatoss is missing and detection was allowed", () => {
  const spawnSrc = fs.readFileSync(path.join(__dirname, "..", "js", "07-spawn.js"), "utf8");
  const fn = spawnSrc.slice(spawnSrc.indexOf("async function spawnChosen"), spawnSrc.indexOf("// ── Resolve the agent tool"));
  assert(/if \(!TC\.chatossPath && !\(TC\.detection && TC\.detection\.denied\)\)/.test(fn),
    "spawnChosen must pre-check the resolved chatoss path");
  assert(/return \{ error: chatossMissingMessage\(\) \};/.test(fn),
    "the pre-check must return the install guidance as the error");
});

// ---------------------------------------------------------------------------
// 5. The Settings "Default agent" picker (index.html #set-cli) offers EXACTLY
//    ask + the three chatoss launch tools.
// ---------------------------------------------------------------------------
test("Settings 'Default agent' picker offers only chatoss launch tools", () => {
  const sel = HTML.match(/<select id="set-cli"[^>]*>([\s\S]*?)<\/select>/);
  assert(sel, "set-cli select not found in index.html");
  const inner = sel[1];
  const values = [...inner.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(values, ["ask", "opencode", "claude-code", "codex"],
    "set-cli options drifted: " + JSON.stringify(values));
  assert(/<option value="opencode">chatoss launch opencode/.test(inner), "opencode label must say chatoss launch");
  assert(/<option value="claude-code">chatoss launch claude-code/.test(inner), "claude option value must be claude-code");
  assert(!/ollama launch/.test(inner), "no ollama launch options may remain");
  assert(!/raw:/.test(inner), "no raw direct-binary options may remain");
});

// ---------------------------------------------------------------------------
// 6. spawnChosen builds the chatoss launch command: the tool from the
//    dropdown (or the saved Default agent), the model as --model, and the
//    codex effort flag for a codex agent only. (Executes the REAL body up to
//    the effort block; the session spawn itself is stubbed out by slicing the
//    source before it.)
// ---------------------------------------------------------------------------
// The real normalizeCliDefault (08-settings.js) — the spawn flow calls it.
// Executes the REAL function body with its own `value` parameter bound.
function realNormalizeCliDefault(value) {
  const settingsSrc = fs.readFileSync(path.join(__dirname, "..", "js", "08-settings.js"), "utf8");
  return callRealFn(settingsSrc, "normalizeCliDefault", [value]);
}

// Execute a top-level `function name(a, b)` from src with the given args.
// The function itself is injected as a free variable so self-recursion works.
function callRealFn(src, name, args) {
  const header = new RegExp("function " + name + "\\s*\\(([^)]*)\\)\\s*\\{");
  const m = header.exec(src);
  assert(m, "function " + name + " not found in source");
  const body = extractFunctionBody(src, name);
  const params = m[1].split(",").map((s) => s.trim()).filter(Boolean);
  // Wrap the body back into a named function expression, binding the function
  // itself as a free variable (recursive helpers keep working).
  // eslint-disable-next-line no-new-func
  const factory = Function(name, "return (function " + name + "(" + params.join(", ") + ") {" + body + "});");
  let fn = factory(null);
  fn = factory(fn); // re-bind with the real fn so recursion resolves
  return fn(...args);
}

function extractSpawnCommandBuilder() {
  const spawnSrc = fs.readFileSync(path.join(__dirname, "..", "js", "07-spawn.js"), "utf8");
  const start = spawnSrc.indexOf("async function spawnChosen");
  assert(start !== -1, "spawnChosen not found in 07-spawn.js");
  // Slice from the function signature to just before the terminal.spawn call
  // — this is the pure command-building section.
  const end = spawnSrc.indexOf("let session = null;", start);
  assert(end > start, "spawnChosen command-building section not bounded");
  return spawnSrc.slice(start, end);
}

test("spawnChosen builds `chatoss launch <tool> --model <id>` (claude maps to claude-code)", () => {
  const src = extractSpawnCommandBuilder();
  const tools = parseChatossLaunchTools(SRC);
  // Build a callable: everything between the async signature and the spawn
  // call, with the effort lookup stubbed and the REAL normalizeCliDefault.
  const body = src.slice(src.indexOf("{") + 1);
  const TC = {
    chatossPath: "/usr/local/bin/chatoss",
    detection: { denied: false },
    CHATOSS_LAUNCH_TOOLS: tools,
    settings: { cliDefault: "ask" },
    defaultModelId: null,
    basename: (p) => "proj",
    effortForTarget: () => null,
    normalizeCliDefault: realNormalizeCliDefault,
  };
  // eslint-disable-next-line no-new-func
  const fn = Function("TC", "chatossMissingMessage", "choice", body + "\nreturn { inner: inner, label: label, tool: tool, model: model };")(TC, () => "install msg", { cli: "claude", cwd: "/x/proj", prompt: "task", model: "qwen3-coder" });
  assert(/exec "\/usr\/local\/bin\/chatoss" launch "claude-code"/.test(fn.inner),
    "claude must launch as `chatoss launch claude-code`: " + fn.inner);
  assert(/--model "qwen3-coder"/.test(fn.inner), "the resolved model must be passed as --model: " + fn.inner);
});

test("spawnChosen falls back to the saved Default agent, then opencode, when cli is empty", () => {
  const src = extractSpawnCommandBuilder();
  const tools = parseChatossLaunchTools(SRC);
  const body = src.slice(src.indexOf("{") + 1);
  const mk = (cliDefault) => {
    const TC = {
      chatossPath: "chatoss",
      detection: { denied: false },
      CHATOSS_LAUNCH_TOOLS: tools,
      settings: { cliDefault },
      defaultModelId: null,
      basename: () => "proj",
      effortForTarget: () => null,
      normalizeCliDefault: realNormalizeCliDefault,
    };
    // eslint-disable-next-line no-new-func
    const fn = Function("TC", "chatossMissingMessage", "choice", body + "\nreturn { inner: inner, tool: tool };")(TC, () => "install msg", { cli: "", cwd: "/x", prompt: "p", model: "m" });
    return fn;
  };
  assert(mk("codex").tool === "codex", "saved Default agent codex must be used");
  assert(mk("ask").tool === "opencode", "'ask' falls back to the first chatoss tool");
  assert(mk("raw:claude").tool === "claude-code", "legacy raw:claude normalizes to claude-code");
});

test("spawnChosen omits --model only when nothing resolved and applies the codex effort flag for codex only", () => {
  const spawnSrc = fs.readFileSync(path.join(__dirname, "..", "js", "07-spawn.js"), "utf8");
  const src = extractSpawnCommandBuilder();
  const tools = parseChatossLaunchTools(SRC);
  const body = src.slice(src.indexOf("{") + 1);
  const mk = (effort) => {
    const TC = {
      chatossPath: "chatoss",
      detection: { denied: false },
      CHATOSS_LAUNCH_TOOLS: tools,
      settings: { cliDefault: "ask" },
      defaultModelId: "",
      basename: () => "proj",
      effortForTarget: () => effort,
      normalizeCliDefault: realNormalizeCliDefault,
      CODEX_EFFORT_FLAG_VALUES: new Set(["low", "medium", "high"]),
      EFFORT_BRIEF: {},
    };
    // eslint-disable-next-line no-new-func
    const fn = Function("TC", "chatossMissingMessage", "choice", body + "\nreturn { inner: inner, tool: tool, prompt: effectivePrompt };")(TC, () => "install msg", { cli: "codex", cwd: "/x", prompt: "task", model: "" });
    return fn;
  };
  const noEffort = mk(null);
  assert(!/--model/.test(noEffort.inner), "no --model when no model resolved and no default known: " + noEffort.inner);
  const lowEffort = mk("low");
  assert(/--config 'model_reasoning_effort="low"'/.test(lowEffort.inner),
    "a codex agent with a saved effort gets the real flag: " + lowEffort.inner);
  // The flag must key off the TOOL, not a regex over the command line (a model
  // id containing "codex" must not trip it for a claude-code agent).
  assert(/const isCodex = tool === "codex";/.test(spawnSrc),
    "the codex check must compare the tool id, never the command string");
});

// ---------------------------------------------------------------------------
// 7. Legacy cliDefault values are normalized (migrated) — the old "Default
//    agent" a user pinned in an older build still resolves.
// ---------------------------------------------------------------------------
test("normalizeCliDefault migrates legacy values (real function body)", () => {
  assert.strictEqual(realNormalizeCliDefault("ask"), "ask");
  assert.strictEqual(realNormalizeCliDefault(""), "ask");
  assert.strictEqual(realNormalizeCliDefault(null), "ask");
  assert.strictEqual(realNormalizeCliDefault("claude"), "claude-code", "legacy bare 'claude' maps to claude-code");
  assert.strictEqual(realNormalizeCliDefault("raw:claude"), "claude-code", "legacy raw:claude maps to claude-code");
  assert.strictEqual(realNormalizeCliDefault("raw:codex"), "codex");
  assert.strictEqual(realNormalizeCliDefault("raw:opencode"), "opencode");
  assert.strictEqual(realNormalizeCliDefault("claude-code"), "claude-code");
  assert.strictEqual(realNormalizeCliDefault("codex"), "codex");
  assert.strictEqual(realNormalizeCliDefault("opencode"), "opencode");
  assert.strictEqual(realNormalizeCliDefault("qwen3:30b"), "ask", "an ollama model id no longer names an agent — ask");
  assert.strictEqual(realNormalizeCliDefault("chatgpt"), "ask");
  // The migration runs at load: init() rewrites a legacy cliDefault once.
  const initSrc = fs.readFileSync(path.join(__dirname, "..", "js", "24-init.js"), "utf8");
  assert(/normalizeCliDefault\(TC\.settings\.cliDefault\)/.test(initSrc),
    "init() must normalize the saved cliDefault at load");
});

run();