// Regression tests for the v1.19.0 fixes in Term Coder:
//   1. First-install empty model dropdown — listModels() can come back empty
//      while the OS model service warms up on a fresh install; the app now
//      retries in the background, retries lazily on picker focus, and shows a
//      "Loading models…" placeholder instead of a silently blank dropdown.
//   2. Settings modal centering — the modal wrapper class was renamed off the
//      platform's base `.modal` (whose card properties leak onto a full-
//      viewport flex wrapper and pin the dialog top-left) to `.tc-*` with
//      defensive resets.
//   3. Sub-agent effort — per-target effort selects in Settings, persisted as
//      the "subAgentEffort" scopedData key, applied at spawn: a REAL Codex
//      `--config model_reasoning_effort` flag for direct codex, an EFFORT_BRIEF
//      guidance line for agents without a flag.
//   4. Top-left "New Chat" / "New Project" buttons.
//
// The app is split into classic scripts under js/ (shared window.termCoder
// namespace — see REFACTOR_PLAN.md), so these tests grep the real module
// sources/HTML/CSS for the wiring and replicate the decision predicates
// verbatim.
//
// Run: node tests/first-run-models-effort.test.js   (no test runner, no deps)

const fs = require("fs");
const path = require("path");
const { assert, test, run } = require("./harness.js");
const { allModulesSrc } = require("./module-src.js");

const SRC = allModulesSrc();
const HTML = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const CSS = fs.readFileSync(path.join(__dirname, "..", "style.css"), "utf8");
const APP_JSON = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "app.json"), "utf8"));

// ---------------------------------------------------------------------------
// 1. First-install model loading
// ---------------------------------------------------------------------------

test("models: a retrying loadModels() is the ONLY assignment of the model list", () => {
  assert(/async function loadModels\(\)/.test(SRC), "loadModels() helper missing");
  assert(/await window\.chatoss\.chat\.listModels\(\)/.test(SRC), "loadModels must call chat.listModels");
  // No stray one-shot assignment left in init():
  const initBlock = SRC.slice(SRC.indexOf("async function init()"), SRC.indexOf("TC.init().catch"));
  assert(!/models = await window\.chatoss/.test(initBlock), "init must go through loadModels(), not assign models ad-hoc");
  assert(/await TC\.loadModels\(\);/.test(SRC), "init must await loadModels()");
});

test("models: empty first-boot list schedules background retries + focus recovery", () => {
  assert(/if \(!TC\.models\.length\) TC\.scheduleModelRetries\(\);/.test(SRC), "init must schedule retries when the list is empty");
  assert(/function scheduleModelRetries\(/.test(SRC), "scheduleModelRetries missing");
  assert(/TC\.el\.modelPicker\.addEventListener\("focus", \(\) => \{\s*if \(!TC\.models\.length\) TC\.loadModels\(\);/.test(SRC),
    "picker focus must lazily reload an empty model list");
  assert(/_modelRetryScheduled/.test(SRC), "retry chain must be guarded against stacking");
});

test("models: renderModelPicker shows a disabled 'Loading models…' placeholder when empty", () => {
  const fn = SRC.slice(SRC.indexOf("function renderModelPicker()"), SRC.indexOf("function selectedModelSupportsEffort"));
  assert(/Loading models…/.test(fn), "empty picker must show a placeholder instead of rendering blank");
  assert(/TC\.el\.modelPicker\.disabled = true/.test(fn), "empty picker must be disabled so '' can't persist onto a conversation");
  assert(/TC\.el\.modelPicker\.disabled = false/.test(fn), "picker must be re-enabled when models exist");
});

// ---------------------------------------------------------------------------
// 2. Effort picker UX (orchestrator)
// ---------------------------------------------------------------------------

test("effort: model and effort selects are inside the composer (no labels)", () => {
  assert(/<select id="model-picker" class="composer-select"/.test(HTML), "model picker must use composer-select class in the composer");
  assert(/<select id="effort-picker" class="composer-select"/.test(HTML), "effort picker must use composer-select class in the composer");
  assert(!/ctl-label/.test(HTML), "MODEL/EFFORT caption labels must be removed");
  assert(/composer-toolbar/.test(HTML), "composer must have a toolbar container for the selects");
});

test("empty state: welcome text present, example prompt buttons removed", () => {
  assert(/An autonomous software-building orchestrator\./.test(HTML), "welcome text must remain");
  assert(!/chat-empty-prompt/.test(HTML), "example prompt buttons must be removed from HTML");
  assert(!/chat-empty-prompt/.test(SRC), "prompt-button click handler must be removed from JS");
  assert(!/chat-empty-prompts/.test(CSS), "prompt button CSS must be removed");
});

test("effort: selectedModelSupportsEffort keys off thinkLevels or reasoning capability", () => {
  const fn = SRC.slice(SRC.indexOf("function selectedModelSupportsEffort()"), SRC.indexOf("function orchestratorEffortLevels()"));
  assert(/m\.thinkLevels/.test(fn), "must check thinkLevels");
  assert(/capabilities\.includes\("reasoning"\)/.test(fn), "must also accept a reasoning capability flag");
});

test("effort: orchestrator uses generic expanded levels when model has no thinkLevels", () => {
  const fn = SRC.slice(SRC.indexOf("function orchestratorEffortLevels()"), SRC.indexOf("function renderEffortPicker()"));
  assert(/TC\.GENERIC_EFFORT_LEVELS/.test(fn), "must fall back to the generic effort levels");
  assert(/return TC\.GENERIC_EFFORT_LEVELS/.test(fn), "fallback must return the generic set");
});

test("effort: sendMessage passes thinkLevel whenever effort is set", () => {
  const fn = SRC.slice(SRC.indexOf("async function sendMessage("), SRC.indexOf("async function sendMessage(") + 3000);
  // find the runTurn options block
  const block = SRC.slice(SRC.indexOf("const result = await window.chatoss.chat.runTurn"), SRC.indexOf("signal: TC.abortController.signal,", SRC.indexOf("const result = await window.chatoss.chat.runTurn")) + 40);
  assert(/thinkLevel: effort \|\| undefined/.test(block), "runTurn must pass thinkLevel whenever effort is chosen");
  assert(/think: canThink \|\| !!effort/.test(block), "runTurn must request reasoning when effort is chosen");
  assert(!/c\.effort = canThink/.test(SRC.slice(SRC.indexOf("const effort = TC.selectedEffort()"), SRC.indexOf("saveState();", SRC.indexOf("const effort = TC.selectedEffort()")) + 20)),
    "must not drop effort just because the model lacks a 'reasoning' capability string");
});

// ---------------------------------------------------------------------------
// 3. Modal centering fix
// ---------------------------------------------------------------------------

test("modals: wrapper class is .tc-modal (platform .modal collision gone)", () => {
  assert(!/class="modal hidden"/.test(HTML), "bare .modal wrapper must be gone from index.html");
  const wrappers = HTML.match(/class="tc-modal hidden"/g) || [];
  assert.ok(wrappers.length >= 4, "all modals must use .tc-modal (found " + wrappers.length + ")");
  assert(/class="tc-backdrop"/.test(HTML), "backdrop renamed to tc-backdrop");
  assert(/contains\("tc-backdrop"\)/.test(SRC), "app.js backdrop close check must use tc-backdrop");
});

test("modals: .tc-modal wrapper is fixed full-viewport flex-centered with defensive resets", () => {
  const rule = CSS.match(/\.tc-modal\s*\{[^}]*\}/);
  assert(rule, ".tc-modal rule missing from style.css");
  for (const decl of ["position: fixed", "inset: 0", "display: flex", "align-items: center", "justify-content: center",
    "width: auto", "height: auto", "margin: 0", "max-width: none", "max-height: none", "background: none"]) {
    assert(rule[0].includes(decl), ".tc-modal missing reset/positioning: " + decl);
  }
  // The platform stylesheet never styles .tc-*, so nothing can leak back in.
  assert(!/^\s*\.modal\s*\{/m.test(CSS), "bare .modal rule must be gone from style.css");
});

// ---------------------------------------------------------------------------
// 4. Sub-agent effort
// ---------------------------------------------------------------------------

test("subagent effort: app.json persists the subAgentEffort key", () => {
  assert(APP_JSON.scopedDataKeys.includes("subAgentEffort"), "subAgentEffort missing from scopedDataKeys");
  assert(/"subAgentEffort"/.test(SRC.match(/const MS_KEYS[^;]+;/)[0]), "MS_KEYS must include subAgentEffort");
});

test("subagent effort: effortForTarget validates against the target's current options", () => {
  const fn = SRC.slice(SRC.indexOf("function effortForTarget"), SRC.indexOf("function effortOptionsForTarget"));
  assert(/effortOptionsForTarget\(targetId\)/.test(fn), "effortForTarget must validate against per-target options");
  assert(!/v === "low" \|\| v === "medium" \|\| v === "high"/.test(fn), "must not hardcode low/medium/high whitelist");
});

test("subagent effort: effortOptionsForTarget uses model thinkLevels, otherwise generic expanded set", () => {
  const fn = SRC.slice(SRC.indexOf("function effortOptionsForTarget"), SRC.indexOf("function populateEffortSelect"));
  assert(/TC\.models\.find\(\(x\) => x\.id === targetId\)/.test(fn), "must look up the model by target id");
  assert(/m\.thinkLevels \u0026\u0026 m\.thinkLevels\.length/.test(fn), "must use model thinkLevels when present");
  assert(!/directIds\.includes\(targetId\)/.test(fn), "the direct-CLI branch is gone (targets are model ids now)");
  assert(/extra-high/.test(fn) && /max/.test(fn), "generic fallback must include extra-high and max");
});

test("subagent effort: spawnChosen applies a real codex flag for low/medium/high, guidance for extra levels", () => {
  const fn = SRC.slice(SRC.indexOf("async function spawnChosen"), SRC.indexOf("let session = null;", SRC.indexOf("async function spawnChosen")));
  assert(/--config 'model_reasoning_effort=\\""/.test(fn), "direct codex must get --config model_reasoning_effort");
  assert(/TC\.CODEX_EFFORT_FLAG_VALUES\.has\(effort\)/.test(fn), "codex flag must only be applied for known-safe values");
  assert(/"extra-high"/.test(SRC) && /"max"/.test(SRC), "EFFORT_BRIEF must cover the expanded generic levels");
});

test("subagent effort: settings rows pair every target select with an effort select", () => {
  for (const id of ["always-effort", "complexity-effort-low", "complexity-effort-medium", "complexity-effort-high"]) {
    assert(HTML.includes('id="' + id + '"'), "settings effort select missing: " + id);
    assert(SRC.includes('bindEffortSelect(TC.el.' + id.replace(/-([a-z])/g, (_, c) => c.toUpperCase()) + ","), "bindEffortSelect not wired for " + id);
  }
  assert(/TC\.syncEffortRows\(\);/.test(SRC), "syncEffortRows must refresh rows on target change");
});

// ---------------------------------------------------------------------------
// 5. Top-left New Chat / New Project
// ---------------------------------------------------------------------------

test("topbar: New Chat + New Project buttons exist and are wired; sidebar + button is gone", () => {
  assert(/id="new-chat-btn"/.test(HTML), "new-chat-btn missing from topbar");
  assert(/id="new-project-top-btn"/.test(HTML), "new-project-top-btn missing from topbar");
  assert(!/id="new-project-btn"/.test(HTML), "sidebar + New project button must be removed");
  assert(!/class="proj-titlebar"/.test(HTML) && !/Projects<\/span>\s*\+/.test(HTML.replace(/\n/g, " ")),
    "Projects titlebar + button must be gone");
  assert(/TC\.el\.newChatBtn\.addEventListener\("click", TC\.newChatFromTopbar\)/.test(SRC), "New Chat handler not wired");
  assert(/TC\.el\.newProjectTopBtn\.addEventListener\("click", TC\.newProject\)/.test(SRC), "New Project must reuse newProject()");
  assert(!/el\.newProjectBtn\.addEventListener\("click", newProject\)/.test(SRC), "old sidebar newProjectBtn listener must be removed");
  assert(/function syncTopNewButtons\(\)/.test(SRC) && /TC\.syncTopNewButtons\(\);/.test(SRC.replace(/function syncTopNewButtons\(\) \{[\s\S]*?\n\}/, "")),
    "syncTopNewButtons must be called outside its own definition");
  assert(/TC\.el\.newChatBtn\.disabled = !hasProject/.test(SRC), "New Chat must disable with no active project");
});

test("attachments: add-file button, attachment strip, and image preview modal exist", () => {
  assert(/id="add-file-btn"/.test(HTML), "add-file-btn missing");
  assert(/id="attachment-strip"/.test(HTML), "attachment-strip missing");
  assert(/id="image-preview-modal"/.test(HTML), "image preview modal missing");
  assert(/id="image-preview-img"/.test(HTML), "image preview img missing");
  assert(/id="image-preview-close"/.test(HTML), "image preview close button missing");
});

test("attachments: app.json declares fileDrop capability", () => {
  assert(APP_JSON.capabilities.includes("fileDrop"), "fileDrop capability must be declared");
});

test("attachments: addFileFromPicker + addDroppedFile + buildMessageContent are wired", () => {
  assert(/async function addFileFromPicker\(\)/.test(SRC), "addFileFromPicker must exist");
  assert(/async function addDroppedFile\(/.test(SRC), "addDroppedFile must exist");
  assert(/function buildMessageContent\(/.test(SRC), "buildMessageContent must exist");
  assert(/window\.chatoss\.files\.onDrop\(/.test(SRC), "files.onDrop must be registered");
  assert(/TC\.el\.addFileBtn\.addEventListener\("click", TC\.addFileFromPicker\)/.test(SRC), "add-file button must be wired");
  // Multimodal content: images produce an array of text + image_url parts.
  const fn = SRC.slice(SRC.indexOf("function buildMessageContent"), SRC.indexOf("function clearAttachments"));
  assert(/type: "image_url"/.test(fn), "buildMessageContent must produce image_url parts for images");
  assert(/type: "text"/.test(fn), "buildMessageContent must include a text part");
  // File contents are embedded into the text portion.
  assert(/\[Attached files\]/.test(fn), "file contents must be embedded into the message text");
});

run();
