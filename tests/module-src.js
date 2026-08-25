// Shared helpers for tests that read the REAL app source.
//
// The app is split into classic scripts under js/ (each registers its exports
// on the shared window.termCoder namespace — see REFACTOR_PLAN.md). Tests read
// the module sources as text and either parse constants out of them or extract
// function bodies and execute them in a sandbox. Extracted bodies reference
// the namespace as the free variable `TC`, so runners must pass a TC stub.
const fs = require("fs");
const path = require("path");

// Read a module's source text (e.g. moduleSrc("00-state.js")).
function moduleSrc(name) {
  return fs.readFileSync(path.join(__dirname, "..", "js", name), "utf8");
}

// Concatenate every module's source (for tests that pattern-match across the
// whole app, the way they used to pattern-match the old monolithic app.js).
function allModulesSrc() {
  return fs
    .readdirSync(path.join(__dirname, "..", "js"))
    .filter((f) => f.endsWith(".js"))
    .sort()
    .map((f) => moduleSrc(f))
    .join("\n");
}

// A stub TC namespace for executing extracted code. Tests can pass overrides
// for the specific state their extracted function touches.
function makeTC(overrides) {
  return Object.assign(
    {
      state: { projects: [], activeProjectId: null, activeConversationId: null },
      settings: {},
      modelSelection: {},
      detection: {},
      el: {},
      models: [],
      sessions: new Map(),
      deadSessions: new Map(),
      worktreeMeta: new Map(),
    },
    overrides || {}
  );
}

module.exports = { moduleSrc, allModulesSrc, makeTC };
