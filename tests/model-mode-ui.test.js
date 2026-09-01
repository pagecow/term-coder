// Regression test — Model Selection Mode: model-worded UI + a flat ChatOSS
// model list (v1.28).
//
// History: v1.26.1 fixed the section to be model-worded and model-first when
// targets were "direct CLIs + ollama models". v1.28 makes every launch target
// a CHATOSS MODEL (`chatoss launch <tool> --model <id>` serves the ChatOSS
// model list), so the select is a FLAT list of available ChatOSS models — no
// groups, no direct-CLI section — and the defaults land on the ChatOSS default
// model (or the first available model).
//
// Contract pinned here:
//   - the dropdown lists every AVAILABLE ChatOSS model (local / cloud /
//     custom all qualify; unavailable rows are skipped) with no grouping;
//   - a saved model id still wins over the default;
//   - a blank/unknown saved value lands on the ChatOSS default model, then
//     the first available model — never blank;
//   - the Settings MODEL SELECTION MODE section copy says "model", not "target".

const fs = require("fs");
const path = require("path");
const { assert, test, run } = require("./harness.js");
const { moduleSrc, makeTC } = require("./module-src.js");

// Execute the REAL populateModelSelect from js/08-settings.js against a fake
// <select>. TC stub mirrors the namespace pieces the function touches:
// TC.models (the ChatOSS chat model list) and TC.defaultModelId.
function runPopulate(models, selected, defaultModelId) {
  const src = moduleSrc("08-settings.js");
  const m = src.match(/function populateModelSelect\(selectEl, selected\) \{([\s\S]*?)\n\}/);
  if (!m) throw new Error("populateModelSelect not found in 08-settings.js");
  const body = m[1];
  const node = (tag) => ({ tagName: String(tag).toUpperCase(), children: [], textContent: "", label: undefined,
    appendChild(c) { this.children.push(c); return c; } });
  const select = { innerHTML: "", value: undefined, children: [],
    appendChild(c) { this.children.push(c); return c; } };
  const document = { createElement: (tag) => node(tag) };
  const TC = Object.assign(makeTC(), {
    models,
    defaultModelId: defaultModelId === undefined ? null : defaultModelId,
  });
  // The REAL availableSessionModels + sessionModelLabel from the same module,
  // extracted and executed so the list logic is not hand-copied.
  const extract = (name) => {
    const re = new RegExp("function " + name + "\\(([^)]*)\\)\\s*\\{");
    const mm = re.exec(src);
    if (!mm) throw new Error(name + " not found in 08-settings.js");
    let i = mm.index + mm[0].length, depth = 1;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      i++;
    }
    // eslint-disable-next-line no-new-func
    return new Function("TC", "return (function " + name + "(" + mm[1] + ") {" + src.slice(mm.index + mm[0].length, i - 1) + "});")(TC);
  };
  const availableSessionModels = extract("availableSessionModels");
  const sessionModelLabel = extract("sessionModelLabel");
  const fn = new Function("selectEl", "selected", "TC", "document", "availableSessionModels", "sessionModelLabel", body);
  fn(select, selected === undefined ? "" : selected, TC, document, availableSessionModels, sessionModelLabel);
  return { select };
}

// Fake <option> value lookup.
function flatOptions(select) {
  return select.children.map((o) => o.value);
}

const MODELS = [
  { id: "deepseek-v4-flash:cloud", name: "DeepSeek V4 Flash", source: "cloud", available: true },
  { id: "glm-5.2:cloud", name: "GLM 5.2", source: "cloud", available: true },
  { id: "qwen3-coder", name: "Qwen3 Coder", source: "local", available: true },
  { id: "custom-gpt", name: "My Custom GPT", source: "custom", available: true },
  { id: "broken-model", name: "Broken", source: "local", available: false },
];

test("model select: flat list of available ChatOSS models, no groups, no CLIs", () => {
  const { select } = runPopulate(MODELS, "", "qwen3-coder");
  const values = flatOptions(select);
  assert.deepStrictEqual(values,
    ["deepseek-v4-flash:cloud", "glm-5.2:cloud", "qwen3-coder", "custom-gpt"],
    "every AVAILABLE model is listed (local/cloud/custom all qualify): " + JSON.stringify(values));
  for (const opt of select.children) {
    assert(!/direct/i.test(opt.textContent || ""), "no direct-CLI options remain");
  }
  assert(!select.children.some((c) => c.children && c.children.length), "no optgroups — the list is flat");
});

test("model select: the ChatOSS default model wins when nothing valid is saved", () => {
  const { select } = runPopulate(MODELS, "", "qwen3-coder");
  assert.strictEqual(select.value, "qwen3-coder",
    "a blank saved value lands on the ChatOSS default model, got: " + select.value);
  const { select: noDefault } = runPopulate(MODELS, "", null);
  assert.strictEqual(noDefault.value, "deepseek-v4-flash:cloud",
    "with no default known, the FIRST available model wins, got: " + noDefault.value);
});

test("model select: a saved model id still wins over the default", () => {
  const { select } = runPopulate(MODELS, "glm-5.2:cloud", "qwen3-coder");
  assert.strictEqual(select.value, "glm-5.2:cloud", "saved model wins over the default");
  const { select: gone } = runPopulate(MODELS, "deleted-model", "qwen3-coder");
  assert.strictEqual(gone.value, "qwen3-coder",
    "a saved id that no longer exists falls back to the default, not to a stale option");
});

test("model select: unavailable models are never offered", () => {
  const { select } = runPopulate([{ id: "broken", available: false }, { id: "ok", available: true }], "broken", null);
  assert.strictEqual(select.value, "ok", "an unavailable saved id falls back to an available model");
  assert(!flatOptions(select).includes("broken"), "unavailable rows are skipped");
});

test("model select: empty list renders an explanatory placeholder, never blank", () => {
  const { select } = runPopulate([], "", null);
  assert.strictEqual(flatOptions(select)[0], "", "the placeholder option has an empty value");
  assert(select.children[0].textContent, "placeholder must explain itself: " + JSON.stringify(select.children[0].textContent));
  assert(/Re-scan|ChatOSS/i.test(select.children[0].textContent), "placeholder mentions Re-scan/ChatOSS");
});

test("settings copy: the MODEL SELECTION MODE section is model-worded, not target-worded", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const start = html.indexOf('Model Selection Mode</h3>');
  const end = html.indexOf('Folder trust</h3>');
  assert(start !== -1 && end > start, "section present");
  const section = html.slice(start, end);
  assert(!/pick their launch target/.test(section), "no 'launch target' wording anywhere in the section");
  assert(!/Always use a specific target/.test(section), "radio title must say 'model'");
  assert(/Always use a specific model/.test(section), "radio title says 'Always use a specific model'");
  assert(!/Pick the target each time/.test(section), "Manual sub must say 'model'");
  assert(!/Assign a target to each level/.test(section), "complexity sub must say 'model'");
  assert(!/>\s*Target\s*</.test(section), "the Always panel must not be labeled 'Target'");
  assert(/<span class="form-label">Model<\/span>/.test(section), "the Always panel is labeled 'Model'");
  // The section falls straight from the heading into the radio group.
  const between = html.slice(start, html.indexOf('model-mode-radios', start));
  assert(!/<p /.test(between), "no paragraph between the section title and the radios");
  // The manual-mode panel mentions chatoss launch (the model is passed that way).
  assert(/chatoss launch/.test(section), "the manual-mode hint explains the model is applied via chatoss launch");
});

run();