// No-effort-selector-description contract (v1.27.0 user request):
//
// Every effort picker in the app must show ONLY the level name — no
// " — description" suffix. The suffixes used to live in two places:
//   - js/00-state.js SUBAGENT_EFFORT_OPTIONS_BASE ("Low — fast & pragmatic", …)
//   - js/08-settings.js effortOptionsForTarget direct-CLI branch (same labels)
// This suite pins bare level names in both sources AND executes the real
// effortOptionsForTarget (which also builds the ollama thinkLevels labels).

const fs = require("fs");
const path = require("path");
const { assert, test, run } = require("./harness.js");
const { moduleSrc } = require("./module-src.js");

const STATE_SRC = moduleSrc("00-state.js");
const SETTINGS_SRC = moduleSrc("08-settings.js");

function grabLabels(src) {
  return (src.match(/label:\s*"([^"]+)"/g) || [])
    .map((s) => s.replace(/label:\s*"/, "").replace(/"$/, ""));
}

test("effort option labels are bare level names (no ' — description') in state + settings", () => {
  const labels = [...grabLabels(STATE_SRC), ...grabLabels(SETTINGS_SRC)]
    .filter((l) => /^(Low|Medium|High|Model default)/.test(l));
  assert(labels.includes("Low") && labels.includes("Medium") && labels.includes("High"),
    "the three effort levels must exist with bare labels; got: " + JSON.stringify(labels));
  for (const l of labels) {
    assert(!/\s—\s/.test(l), "effort label must not carry a description suffix: \"" + l + "\"");
  }
});

function realEffortOptionsForTarget() {
  const m = SETTINGS_SRC.match(/function effortOptionsForTarget\(targetId\) \{([\s\S]*?)\n\}/);
  assert(m, "effortOptionsForTarget not found in 08-settings.js");
  const fn = new Function("targetId", "TC", m[1] + "\nreturn effortOptionsForTarget.apply(null, arguments);");
  return fn;
}

test("settings effortOptionsForTarget (real fn): direct-CLI options are bare names", () => {
  const TC = {
    models: [{ id: "glm-5.3:cloud", thinkLevels: ["low", "medium", "high", "max"] }],
    detection: {},
  };
  const opts = realEffortOptionsForTarget()("claude", TC);
  assert.deepStrictEqual(opts.map((o) => o.label), ["Model default", "Low", "Medium", "High"],
    "direct-CLI effort options must be bare names: " + JSON.stringify(opts));
});

test("settings effortOptionsForTarget (real fn): ollama thinkLevels are bare too", () => {
  const TC = {
    models: [{ id: "glm-5.3:cloud", thinkLevels: ["low", "medium", "high", "max"] }],
    detection: {},
  };
  const opts = realEffortOptionsForTarget()("glm-5.3:cloud", TC);
  assert.deepStrictEqual(opts.map((o) => o.label), ["Model default", "Low", "Medium", "High", "Max"],
    "ollama thinkLevels labels must be bare: " + JSON.stringify(opts));
});

run();