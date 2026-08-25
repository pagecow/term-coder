// Token estimator verification tests for Term Coder.
//
// The app is split into classic scripts under js/ (shared window.termCoder
// namespace — see REFACTOR_PLAN.md), so these tests follow the same
// convention as tests/copy-conversation.test.js: read the REAL module sources
// as text and extract the pure estimation functions out of them, so the tests
// fail if the source drifts. The DOM wiring (HTML/CSS) is verified by grepping
// the real files.
//
// Run: node tests/token-estimator.test.js   (no test runner, no deps)

const fs = require("fs");
const path = require("path");
const { assert, test, run } = require("./harness.js");
const { allModulesSrc } = require("./module-src.js");

const SRC = allModulesSrc();
const HTML = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const CSS = fs.readFileSync(path.join(__dirname, "..", "style.css"), "utf8");

// Pull a pure function VERBATIM out of the modules and evaluate it in a sandbox.
function extractFn(src, name) {
  const re = new RegExp("function " + name + "\\(([\\s\\S]*?)\\)\\s*\\{");
  const m = src.match(re);
  assert(m, name + " declaration not found in the modules");
  const open = src.indexOf("{", m.index + m[0].length - 1);
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  assert(end > 0, name + ": could not find end of function body");
  const head = "function " + name + "(" + m[1] + ")";
  const body = src.slice(open, end + 1);
  // eslint-disable-next-line no-new-func
  const factory = new Function(head + body + "; return " + name + ";");
  return factory();
}

const estimateTokens = extractFn(SRC, "estimateTokens");

// ---------------------------------------------------------------------------
// 1. The heuristic
// ---------------------------------------------------------------------------

test("estimateTokens: ~4 chars per token, floor of 1 for non-empty", () => {
  assert.strictEqual(estimateTokens(""), 0, "empty string -> 0");
  assert.strictEqual(estimateTokens(null), 0, "null -> 0");
  assert.strictEqual(estimateTokens(undefined), 0, "undefined -> 0");
  assert.strictEqual(estimateTokens("a"), 1, "single char -> 1 (floor)");
  assert.strictEqual(estimateTokens("abcd"), 1, "4 chars -> 1 token");
  assert.strictEqual(estimateTokens("abcdefgh"), 2, "8 chars -> 2 tokens");
  assert.strictEqual(estimateTokens("x".repeat(40)), 10, "40 chars -> 10 tokens");
});

test("estimateTokens: coerces non-strings", () => {
  assert.strictEqual(estimateTokens(1234), 1, "number coerced to string");
  assert.strictEqual(estimateTokens("12345678"), 2, "numeric string counted");
});

// ---------------------------------------------------------------------------
// 2. Context-window fallback map
// ---------------------------------------------------------------------------

test("context window: CONTEXT_WINDOW_MAP covers claude/gpt/gemini families", () => {
  assert(/claude\|anthropic/i.test(SRC), "claude family must map to a context window");
  assert(/gpt-4o/.test(SRC), "gpt-4o family must map to a context window");
  assert(/gemini/i.test(SRC), "gemini family must map to a context window");
  assert(/200000/.test(SRC), "claude ~200k context window present");
  assert(/DEFAULT_CONTEXT_WINDOW/.test(SRC), "a default context window must exist");
});

test("context window: maxTokensForModel prefers model.contextLength", () => {
  const fn = SRC.slice(SRC.indexOf("function maxTokensForModel"), SRC.indexOf("function estimateToolTokens"));
  assert(/m\.contextLength/.test(fn), "must read the model's own contextLength first");
  assert(/CONTEXT_WINDOW_MAP/.test(fn), "must fall back to the id-keyed map");
  assert(/return 0/.test(fn), "no model selected -> 0");
});

// ---------------------------------------------------------------------------
// 3. Breakdown categories
// ---------------------------------------------------------------------------

test("breakdown: computeTokenBreakdown reports system/tools/messages/draft", () => {
  const fn = SRC.slice(SRC.indexOf("function computeTokenBreakdown"), SRC.indexOf("function renderTokenEstimator"));
  assert(/system/.test(fn) && /tools/.test(fn) && /messages/.test(fn) && /draft/.test(fn),
    "breakdown must include system, tools, messages, and draft categories");
  assert(/ORCHESTRATOR_TOOLS/.test(fn), "tool definitions must be estimated from ORCHESTRATOR_TOOLS");
  assert(/estimateTokens\(TC\.el\.chatInput/.test(fn), "draft must read the live chat input");
});

test("breakdown: system prompt is cached from buildSystemPrompt", () => {
  assert(/TC\.setLastSystemPrompt\(joined\)/.test(SRC), "buildSystemPrompt must cache its output");
  assert(/TC\._lastSystemPrompt \|\| TC\.SYSTEM_PROMPT_FALLBACK/.test(SRC), "breakdown must use the cached prompt with a fallback");
});

// ---------------------------------------------------------------------------
// 4. DOM wiring
// ---------------------------------------------------------------------------

test("dom: estimator lives inside .composer-wrap, below the form", () => {
  assert(/id="token-estimator"/.test(HTML), "token-estimator container missing");
  assert(/id="token-count"/.test(HTML), "token-count text missing");
  assert(/id="token-max"/.test(HTML), "token-max text missing");
  assert(/id="token-ring-fill"/.test(HTML), "progress ring fill missing");
  assert(/id="token-popover"/.test(HTML), "breakdown popover missing");
  // The estimator must come AFTER the composer form (the old hint text was
  // removed and replaced by the project/branch bar).
  const wrap = HTML.slice(HTML.indexOf('class="composer-wrap"'), HTML.indexOf('id="session-info"'));
  assert(wrap.indexOf("token-estimator") > wrap.indexOf("chat-form"), "estimator must be below the form");
  assert(!/composer-hint/.test(wrap), "composer-hint must be removed (replaced by the project/branch bar)");
});

test("dom: estimator is a button with aria attributes, popover is a dialog", () => {
  assert(/id="token-estimator-btn"[^>]*aria-haspopup="true"/.test(HTML), "button must declare aria-haspopup");
  assert(/aria-expanded="false"/.test(HTML), "button must start aria-expanded=false");
  assert(/role="dialog"/.test(HTML), "popover must be a dialog");
});

test("css: ring + popover styles exist and use theme variables", () => {
  assert(/\.token-ring-fill/.test(CSS), "ring fill style missing");
  assert(/\.token-popover/.test(CSS), "popover style missing");
  assert(/\.token-popover-bar/.test(CSS), "breakdown bar style missing");
  assert(/var\(--accent\)/.test(CSS), "must use the accent variable");
});

test("wiring: estimator updates on input and model change", () => {
  assert(/renderTokenEstimator\(\);/.test(SRC), "renderTokenEstimator must be called");
  // Called from the chat input handler and the model picker change handler.
  const inputHandler = SRC.slice(SRC.indexOf('el.chatInput.addEventListener("input"'), SRC.indexOf('el.chatInput.addEventListener("input"') + 400);
  assert(/renderTokenEstimator\(\);/.test(inputHandler), "input handler must refresh the estimator");
  const modelHandler = SRC.slice(SRC.indexOf('el.modelPicker.addEventListener("change"'), SRC.indexOf('el.modelPicker.addEventListener("change"') + 400);
  assert(/renderTokenEstimator\(\);/.test(modelHandler), "model change handler must refresh the estimator");
});

test("wiring: popover closes on outside click and Escape", () => {
  assert(/closeTokenPopover\(\)/.test(SRC), "closeTokenPopover must exist");
  assert(/toggleTokenPopover\(\)/.test(SRC), "toggleTokenPopover must exist");
  assert(/TC\.el\.tokenPopover && !TC\.el\.tokenPopover\.hidden\) TC\.closeTokenPopover\(\)/.test(SRC),
    "Escape must close the popover");
});

run();
