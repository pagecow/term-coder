// Regression tests for the "Select by complexity" model-selection bug.
//
// BUG: with Model Selection Mode = "complexity" and Low/Medium/High mappings
// configured, every sub-agent session got the HIGH model. Two defects in
// assessComplexity() (the keyword + length heuristic behind the complexity
// branch of resolveSessionModel) caused almost every task to score "high":
//
//   1. Substring matching — HIGH/MED keyword counts used text.includes(), so a
//      keyword could match inside a longer word ("architecture" matched both
//      "architect" AND "architecture", double-counting to an instant "high";
//      "address" matched "add"; "prefix" matched "fix").
//   2. Detail counted as breadth — naming >=4 files bumped the high score, but
//      the orchestrator's system prompt explicitly tells it to write FOCUSED,
//      DETAILED prompts naming exact files, so a trivial "create a component +
//      wire it + test it" brief that named 4 files landed on "high".
//
// These tests extract the REAL assessComplexity() body from js/09-complexity.js
// and execute it against controlled prompts, following the audit-fixes /
// default-launch test pattern (the app is split into classic scripts under js/
// and can't be require()d whole).
//
// Run: node tests/complexity-assessment.test.js   (no test runner, no deps)

const fs = require("fs");
const path = require("path");
const { assert, test, run } = require("./harness.js");
const { moduleSrc, makeTC } = require("./module-src.js");

const SRC = moduleSrc("09-complexity.js");

// Brace-balance extract the body of a top-level `function name(...)` and make
// it callable (mirrors default-launch-apply.test.js).
function extractCallable(src, name, paramNames) {
  const header = new RegExp("function " + name + "\\s*\\([^)]*\\)\\s*\\{");
  const m = header.exec(src);
  assert(m, "function " + name + " not found in js/09-complexity.js");
  let i = m.index + m[0].length;
  let depth = 1;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  assert(depth === 0, "unbalanced braces in " + name);
  // eslint-disable-next-line no-new-func
  return Function(...paramNames, src.slice(m.index + m[0].length, i - 1));
}

const assessComplexity = extractCallable(SRC, "assessComplexity", ["taskPrompt", "TC"]);
const TC = makeTC();

test("keyword matching uses word boundaries, not raw substring includes", () => {
  // The fix must not use text.includes for the HIGH/MED loops (that is the
  // substring-collision bug). It should build a word-boundary RegExp.
  const fn = SRC.slice(SRC.indexOf("function assessComplexity"), SRC.indexOf("window.termCoder.resolveSessionModel = "));
  assert(!/for \(const w of HIGH\) if \(text\.includes\(w\)\)/.test(fn),
    "HIGH loop must not use text.includes(w)");
  assert(!/for \(const w of MED\) if \(text\.includes\(w\)\)/.test(fn),
    "MED loop must not use text.includes(w)");
  assert(/new RegExp\(/.test(fn) && /\\b/.test(fn),
    "keyword matching must build a boundary-aware RegExp");
});

test("'architecture' does not double-count 'architect' (no instant high)", () => {
  // A documentation-only task mentioning "architecture" must NOT be classified
  // high merely because the word contains "architect".
  const level = assessComplexity("Update the architecture documentation to describe the new module layout.");
  assert.notStrictEqual(level, "high", "a docs task mentioning 'architecture' must not be high");
});

test("substring false positives are gone: 'address' != 'add', 'prefix' != 'fix'", () => {
  // "address" must not match the MED keyword "add" and "prefix" must not match
  // "fix" — these used to push ordinary feature edits toward medium/high.
  const addr = assessComplexity("Add a mailing address field to the user profile form.");
  const prefix = assessComplexity("Fix the prefix handling in the URL parser.");
  assert.notStrictEqual(addr, "high", "'address' must not trigger high");
  assert.notStrictEqual(prefix, "high", "'prefix' must not trigger high");
});

test("a FOCUSED create-component brief naming 4 files stays medium (not high)", () => {
  // The orchestrator is told to name exact files, so naming 4 files for a
  // single component is routine — it must NOT bump to high via fileMentions.
  const level = assessComplexity(
    "Create a new Button component in src/components/Button.js with props for variant, " +
    "size, and disabled state. Add it to src/App.js and style it in src/style.css. " +
    "Write tests in tests/Button.test.js."
  );
  assert.strictEqual(level, "medium", "create-component naming 4 files must be medium, got: " + level);
});

test("a genuinely broad refactor (many files) is high", () => {
  const level = assessComplexity(
    "Refactor the authentication system: update src/auth/login.js, src/auth/register.js, " +
    "src/auth/session.js, src/api/middleware.js, and add tests in tests/auth.test.js."
  );
  assert.strictEqual(level, "high", "a broad multi-file refactor must be high, got: " + level);
});

test("pure read-and-report tasks are low", () => {
  assert.strictEqual(assessComplexity("Read src/app.js and report what it does."), "low",
    "read/report must be low");
  assert.strictEqual(assessComplexity("List every file under src/ and summarize its purpose."), "low",
    "list/summarize must be low");
});

test("a spread of representative prompts is NOT all high", () => {
  const prompts = [
    "Fix the login bug in src/auth/login.js where the session token is not refreshed.",
    "Add a dark mode toggle to the settings page in src/settings.js.",
    "Write a helper function that validates email addresses in src/utils/validate.js.",
    "Rename the variable foo to bar in src/parser.js.",
    "Update the README with installation instructions.",
  ];
  const levels = prompts.map(assessComplexity);
  const highs = levels.filter((l) => l === "high").length;
  assert(highs < levels.length,
    "representative everyday tasks must not ALL be high (got " + highs + "/" + levels.length + " high)");
  // At least one non-high level must appear for the mapping to be meaningful.
  assert(levels.some((l) => l !== "high"), "expected at least one non-high classification");
});

test("assessComplexity still maps through the low/medium/high vocabulary", () => {
  for (const p of ["Fix a typo in README", "Read the code and explain it", "Build an end-to-end migration"]) {
    const l = assessComplexity(p);
    assert(["low", "medium", "high"].includes(l), "unexpected level: " + l);
  }
});

run();
