// Regression test — Model Selection Mode: model-worded UI + model-first select.
//
// User report (v1.26.0): selecting "Always use a specific target" showed a
// TARGET dropdown reading "claude (direct)" — the section is supposed to be
// about picking an AI MODEL and its Effort level.
//
// Root causes fixed in v1.26.1:
//   1. populateModelSelect ordered direct CLIs FIRST and defaulted a blank
//      saved value to ids[0] (= "claude", the direct CLI), so every freshly
//      configured panel (Always / complexity) opened on a CLI, not a model.
//   2. The whole Settings section used "target" wording even though it is the
//      AI-model picker (label "Target", radio "Always use a specific target",
//      subs "Pick the target…", intro "pick their launch target").
//
// Contract pinned here:
//   - the dropdown's first group is "Ollama models" and defaults to the first
//     ollama model when nothing valid is saved (direct CLIs remain available
//     as a clearly-labeled secondary group — each runs its own model);
//   - a saved id still wins over the default;
//   - the Settings MODEL SELECTION MODE section copy says "model", not "target".

const fs = require("fs");
const path = require("path");
const { assert, test, run } = require("./harness.js");
const { moduleSrc, makeTC } = require("./module-src.js");

// Execute the REAL populateModelSelect from js/08-settings.js against a fake
// <select>. TC stub mirrors the namespace pieces the function touches:
// TC.detection.{claude,claudePath,codex,codexPath,opencode,opencodePath} and
// TC.models.
function runPopulate(detection, ollamaModels, selected) {
  const src = moduleSrc("08-settings.js");
  const m = src.match(/function populateModelSelect\(selectEl, selected\) \{([\s\S]*?)\n\}/);
  if (!m) throw new Error("populateModelSelect not found in 08-settings.js");
  const body = m[1];
  const node = (tag) => ({ tagName: String(tag).toUpperCase(), children: [], _text: "", label: undefined,
    appendChild(c) { this.children.push(c); return c; } });
  const select = { innerHTML: "", value: undefined, children: [],
    appendChild(c) { this.children.push(c); return c; } };
  const document = { createElement: (tag) => node(tag) };
  const TC = Object.assign(makeTC(), {
    detection,
    models: ollamaModels.map((id) => ({ id, thinkLevels: ["low", "medium", "high", "max"] })),
  });
  // Faithful replica of availableLaunchTargets() in the same file — the real
  // detection order/direct-first assembly, scoped to the stubbed environment.
  const availableLaunchTargets = () => {
    const out = [];
    if (detection.claude && detection.claudePath) out.push({ kind: "direct", id: "claude", bin: detection.claudePath });
    if (detection.codex && detection.codexPath) out.push({ kind: "direct", id: "codex", bin: detection.codexPath });
    if (detection.opencode && detection.opencodePath) out.push({ kind: "direct", id: "opencode", bin: detection.opencodePath });
    for (const model of ollamaModels) out.push({ kind: "ollama", id: model, model });
    return out;
  };
  const fn = new Function("selectEl", "selected", "TC", "document", "availableLaunchTargets", body);
  fn(select, selected === undefined ? "" : selected, TC, document, availableLaunchTargets);
  return { select };
}

// Fake <option>/<optgroup> value lookup: direct children (optgroup) carry
// .children; options carry .value.
function flatOptions(select) {
  const out = [];
  for (const node of select.children) {
    if (node.children && node.children.length) {
      out.push({ group: node.label, values: node.children.map((o) => o.value) });
    } else {
      out.push({ group: null, values: [node.value] });
    }
  }
  return out;
}

test("model select: ollama models are the FIRST group; default lands on the first model", () => {
  const det = { claude: true, claudePath: "/usr/bin/claude", codex: false, opencode: false };
  const { select } = runPopulate(det, ["deepseek-v4-flash:cloud", "glm-5.2:cloud", "deepseek-v4-pro:cloud"], "");
  const groups = flatOptions(select);
  const directGroups = groups.filter((g) => /Direct CLI/i.test(g.group || "")).length;
  assert.strictEqual(directGroups, 1, "direct CLIs remain available as one labeled group");
  const modelGroup = groups.find((g) => g.group === "Ollama models");
  assert(modelGroup, "model group present");
  assert.strictEqual(groups.indexOf(modelGroup), 0, "OLLAMA MODELS MUST BE THE FIRST GROUP (was: direct CLIs first)");
  if (select.value === "claude") throw new Error("blank saved value must NOT default to a direct CLI; got: " + select.value);
  assert.strictEqual(select.value, modelGroup.values[0],
    "blank saved value must default to the FIRST OLLAMA MODEL, got: " + select.value);
  // Direct option text: id + clear "(direct CLI)" marker.
  const directGroup = groups.find((g) => /Direct CLI/i.test(g.group || ""));
  assert.deepStrictEqual(directGroup.values, ["claude"]);
});

test("model select: a saved target id still wins over the model-first default", () => {
  const det = { claude: true, claudePath: "/usr/bin/claude", codex: false, opencode: false };
  const { select } = runPopulate(det, ["deepseek-v4-flash:cloud", "glm-5.2:cloud"], "claude");
  assert.strictEqual(select.value, "claude", "saved id must be restored even when it is a direct CLI");
  const { select: sel2 } = runPopulate(det, ["deepseek-v4-flash:cloud", "glm-5.2:cloud"], "glm-5.2:cloud");
  assert.strictEqual(sel2.value, "glm-5.2:cloud", "saved ollama model wins");
});

test("model select: with only direct CLIs detected it still picks a usable target", () => {
  const det = { claude: true, claudePath: "/usr/bin/claude", codex: false, opencode: false };
  const { select } = runPopulate(det, [], "");
  const groups = flatOptions(select);
  const directGroup = groups.find((g) => /Direct CLI/i.test(g.group || ""));
  assert.strictEqual(groups.indexOf(directGroup), 0, "only group when no ollama models");
  assert.strictEqual(select.value, "claude", "falls back to the first direct CLI when ollama has nothing");
});

test("settings copy: the MODEL SELECTION MODE section is model-worded, not target-worded", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const start = html.indexOf('Model Selection Mode</h3>');
  const end = html.indexOf('Folder trust</h3>');
  assert(start !== -1 && end > start, "section present");
  const section = html.slice(start, end);
  assert(!/>\s*Target\s*</.test(section), "the Always panel must not be labeled 'Target'");
  assert(/<span class="form-label">Model<\/span>/.test(section), "the Always panel is labeled 'Model'");
  assert(!/Always use a specific target/.test(section), "radio title must say 'model'");
  assert(/Always use a specific model/.test(section), "radio title says 'Always use a specific model'");
  assert(!/Pick the target each time/.test(section), "Manual sub must say 'model'");
  assert(!/Assign a target to each level/.test(section), "complexity sub must say 'model'");
  assert(!/pick their launch target/.test(section), "intro must not name a 'launch target'");
  assert(/selects an AI model/.test(section) || /AI <strong>model<\/strong>/.test(section), "intro is AI-model framed");
});

run();