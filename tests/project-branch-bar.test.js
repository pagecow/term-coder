// Tests for the project + git branch management bar (under the composer).
//
// app.js is a browser module, so these tests follow the same convention as
// tests/token-estimator.test.js: read the REAL app.js source as text and
// extract the pure branch-ordering/filtering helpers out of it, so the tests
// fail if the source drifts. The DOM wiring (HTML/CSS) is verified by grepping
// the real files.
//
// Run: node tests/project-branch-bar.test.js   (no test runner, no deps)

const fs = require("fs");
const path = require("path");
const { assert, test, run } = require("./harness.js");

const SRC = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const HTML = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const CSS = fs.readFileSync(path.join(__dirname, "..", "style.css"), "utf8");

// Pull a pure function VERBATIM out of app.js and evaluate it in a sandbox.
function extractFn(src, name) {
  const re = new RegExp("function " + name + "\\(([\\s\\S]*?)\\)\\s*\\{");
  const m = src.match(re);
  assert(m, name + " declaration not found in app.js");
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

const detectMainBranch = extractFn(SRC, "detectMainBranch");
const orderBranches = extractFn(SRC, "orderBranches");
const filterBranches = extractFn(SRC, "filterBranches");

// ---------------------------------------------------------------------------
// 1. Main-branch detection
// ---------------------------------------------------------------------------

test("detectMainBranch: prefers main, then master, else null", () => {
  assert.strictEqual(detectMainBranch(["main", "dev", "feature/x"]), "main");
  assert.strictEqual(detectMainBranch(["master", "dev"]), "master");
  assert.strictEqual(detectMainBranch(["main", "master"]), "main", "main wins over master");
  assert.strictEqual(detectMainBranch(["dev", "feature/x"]), null);
  assert.strictEqual(detectMainBranch([]), null);
  assert.strictEqual(detectMainBranch(null), null);
});

// ---------------------------------------------------------------------------
// 2. Main-at-top ordering
// ---------------------------------------------------------------------------

test("orderBranches: main branch is ALWAYS first", () => {
  const out = orderBranches(["feature/z", "main", "feature/a", "dev"]);
  assert.strictEqual(out[0], "main", "main must be pinned to the top");
  assert.deepStrictEqual(out.slice(1), ["dev", "feature/a", "feature/z"],
    "the rest must be sorted alphabetically");
});

test("orderBranches: master is pinned when no main exists", () => {
  const out = orderBranches(["dev", "master", "feature/a"]);
  assert.strictEqual(out[0], "master");
});

test("orderBranches: no main/master -> plain alphabetical", () => {
  const out = orderBranches(["feature/b", "feature/a", "dev"]);
  assert.deepStrictEqual(out, ["dev", "feature/a", "feature/b"]);
});

test("orderBranches: explicit mainBranch argument wins over detection", () => {
  const out = orderBranches(["main", "dev"], "dev");
  assert.strictEqual(out[0], "dev", "explicit mainBranch must be honored");
});

test("orderBranches: does not mutate the input array", () => {
  const input = ["feature/b", "main", "feature/a"];
  orderBranches(input);
  assert.deepStrictEqual(input, ["feature/b", "main", "feature/a"]);
});

// ---------------------------------------------------------------------------
// 3. Search filter
// ---------------------------------------------------------------------------

test("filterBranches: empty query returns everything", () => {
  const input = ["main", "dev", "feature/a"];
  assert.deepStrictEqual(filterBranches(input, ""), input);
  assert.deepStrictEqual(filterBranches(input, "   "), input);
  assert.deepStrictEqual(filterBranches(input, null), input);
});

test("filterBranches: case-insensitive substring match", () => {
  const input = ["main", "dev", "feature/Login", "feature/login-2"];
  assert.deepStrictEqual(filterBranches(input, "login"),
    ["feature/Login", "feature/login-2"]);
  assert.deepStrictEqual(filterBranches(input, "FEATURE"),
    ["feature/Login", "feature/login-2"]);
});

test("filterBranches: no match -> empty array", () => {
  assert.deepStrictEqual(filterBranches(["main", "dev"], "zzz"), []);
});

// ---------------------------------------------------------------------------
// 4. DOM wiring (HTML)
// ---------------------------------------------------------------------------

test("dom: hint text is removed", () => {
  assert(!/Enter to send/.test(HTML), "the old composer hint text must be gone");
  assert(!/composer-hint/.test(HTML), "the composer-hint element must be gone");
});

test("dom: project + branch bar exists under the composer", () => {
  assert(/id="project-branch-bar"/.test(HTML), "project-branch-bar container missing");
  assert(/id="pb-project-btn"/.test(HTML), "project chip button missing");
  assert(/id="pb-project-name"/.test(HTML), "project name span missing");
  assert(/id="pb-branch-btn"/.test(HTML), "branch chip button missing");
  assert(/id="pb-branch-name"/.test(HTML), "branch name span missing");
  assert(/id="pb-popover"/.test(HTML), "selector popover missing");
  // The bar must come AFTER the composer form (it replaced the hint below it).
  const wrap = HTML.slice(HTML.indexOf('class="composer-wrap"'), HTML.indexOf('id="session-info"'));
  assert(wrap.indexOf("project-branch-bar") > wrap.indexOf("chat-form"),
    "project/branch bar must be below the composer form");
});

test("dom: chips are buttons with aria-haspopup", () => {
  assert(/id="pb-project-btn"[^>]*aria-haspopup="true"/.test(HTML), "project chip must declare aria-haspopup");
  assert(/id="pb-branch-btn"[^>]*aria-haspopup="true"/.test(HTML), "branch chip must declare aria-haspopup");
});

// ---------------------------------------------------------------------------
// 5. CSS
// ---------------------------------------------------------------------------

test("css: bar + popover styles exist and use theme variables", () => {
  assert(/\.project-branch-bar/.test(CSS), "bar style missing");
  assert(/\.pb-chip/.test(CSS), "chip style missing");
  assert(/\.pb-popover/.test(CSS), "popover style missing");
  assert(/\.pb-search/.test(CSS), "search box style missing");
  assert(/\.pb-list/.test(CSS), "branch list style missing");
  assert(/\.pb-create/.test(CSS), "create-branch action style missing");
  assert(/var\(--accent\)/.test(CSS), "must use the accent variable");
});

// ---------------------------------------------------------------------------
// 6. Wiring (app.js)
// ---------------------------------------------------------------------------

test("wiring: branch selector loads branches from git and pins main", () => {
  assert(/git for-each-ref --format=%\(refname:short\) refs\/heads/.test(SRC),
    "must list branches via git for-each-ref");
  assert(/git branch --show-current/.test(SRC), "must read the current branch");
  assert(/orderBranches\(/.test(SRC), "must order branches (main first)");
  assert(/filterBranches\(/.test(SRC), "must filter branches by search query");
});

test("wiring: create branch uses git checkout -b and validates the name", () => {
  assert(/git checkout -b/.test(SRC), "must create a branch with git checkout -b");
  assert(/A-Za-z0-9\._/.test(SRC), "must validate the branch name charset");
});

test("wiring: switching branch uses git checkout", () => {
  assert(/git checkout /.test(SRC), "must switch branches with git checkout");
});

test("wiring: bar renders on project select and initial load", () => {
  assert(/renderProjectBranchBar\(\);/.test(SRC), "renderProjectBranchBar must be called");
  // Called from selectProject and the initial render.
  const sel = SRC.slice(SRC.indexOf("function selectProject"), SRC.indexOf("function selectConversation"));
  assert(/renderProjectBranchBar\(\);/.test(sel), "selectProject must refresh the bar");
});

run();
