// Tests for the orchestrator's OWN tools — the direct file tools and the
// git/release tools (git_status, git_commit, git_push, version_bump,
// create_release). These exist so the orchestrator never has to delegate a
// commit, push, release, or doc edit to a sub-agent (the exact failure mode
// from the 1.19.0 batch: the orchestrator claimed it "had no tools" for
// commits/pushes/releases and tried to spawn sub-agents for them).
const fs = require("fs");
const path = require("path");
const { assert, test, run } = require("./harness");
const { allModulesSrc } = require("./module-src.js");

const SRC = allModulesSrc();
const APP_JSON = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "app.json"), "utf8"));

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

test("all eight orchestrator-own tools are defined in ORCHESTRATOR_TOOLS", () => {
  for (const name of ["read_file", "write_file", "edit_file", "git_status", "git_commit", "git_push", "version_bump", "create_release"]) {
    assert(new RegExp('name: "' + name + '"').test(SRC), name + " definition missing");
  }
});

test("every tool definition has a matching handler case", () => {
  for (const name of ["read_file", "write_file", "edit_file", "git_status", "git_commit", "git_push", "version_bump", "create_release"]) {
    assert(new RegExp('case "' + name + '":').test(SRC), name + " handler missing");
  }
});

// ---------------------------------------------------------------------------
// File tools ride the files API (fileAccess), confined to the project folder
// ---------------------------------------------------------------------------

test("read_file/write_file/edit_file use window.chatoss.files and confine paths to the project", () => {
  assert(/window\.chatoss\.files\.readFile\(path\)/.test(SRC), "read_file must read via files.readFile");
  assert(/window\.chatoss\.files\.writeFile\(path, contents\)/.test(SRC), "write_file must write via files.writeFile");
  assert(/window\.chatoss\.files\.writeFile\(path, updated\)/.test(SRC), "edit_file must write the updated text");
  // Path confinement: every file tool must refuse paths outside the project.
  const matches = SRC.match(/path\.startsWith\(p\.folderPath\.replace\(\/\\\/\+\$\/, ""\) \+ "\/"\)/g) || [];
  assert(matches.length >= 3, "all three file tools must confine paths to the project folder");
});

test("edit_file requires old_string to appear exactly once", () => {
  assert(/old_string not found in/.test(SRC), "edit_file must report a missing old_string");
  assert(/appears more than once/.test(SRC), "edit_file must reject a non-unique old_string");
});

// ---------------------------------------------------------------------------
// Git tools run real git commands through the terminal
// ---------------------------------------------------------------------------

test("git_commit stages everything and commits with the given message", () => {
  assert(/git add -A && git commit -m/.test(SRC), "git_commit must run git add -A && git commit");
});

test("git_push retries with -u origin HEAD when there is no upstream", () => {
  assert(/git push -u origin HEAD/.test(SRC), "git_push must set upstream on first push");
  assert(/no upstream branch\|--set-upstream/i.test(SRC), "git_push must detect the no-upstream failure");
});

// ---------------------------------------------------------------------------
// version_bump keeps app.json and APP_VERSION in lockstep
// ---------------------------------------------------------------------------

test("version_bump bumps app.json's version and syncs matching APP_VERSION constants", () => {
  assert(/appJson\.version = newV/.test(SRC), "version_bump must write the new version into app.json");
  assert(/APP_VERSION\\s\*=\\s\*\["'\]/.test(SRC), "version_bump must find APP_VERSION constants");
  assert(/v === oldV/.test(SRC), "version_bump must only replace constants matching the OLD version");
  assert(/bump must be 'major', 'minor' or 'patch'/.test(SRC), "version_bump must validate the bump kind");
});

// ---------------------------------------------------------------------------
// create_release: gh release + .aip/.zip assets
// ---------------------------------------------------------------------------

test("create_release creates the release, builds the .aip, and uploads both assets", () => {
  assert(/gh release create/.test(SRC), "create_release must run gh release create");
  assert(/--target main/.test(SRC), "create_release must target main");
  assert(/zip -r -X/.test(SRC), "create_release must build the .aip with zip");
  assert(/gh release upload/.test(SRC), "create_release must upload the assets");
  assert(/\.aip\$/, "create_release must name the archive .aip");
  assert(/replace\(\/\.aip\$/, "create_release must make a .zip copy of the .aip");
});

test("create_release excludes non-runtime files from the .aip", () => {
  assert(/EXCLUDE = new Set\(\["tests", "docs", "node_modules", "\.git", "\.chatoss"\]\)/.test(SRC),
    "create_release must exclude tests/, docs/, node_modules, .git, .chatoss");
  assert(/\\\.\(md\|aip\|zip\)\$\/i\.test\(name\)/.test(SRC),
    "create_release must exclude *.md and old .aip/.zip artifacts");
});

// ---------------------------------------------------------------------------
// System prompt: the orchestrator is told these are ITS job
// ---------------------------------------------------------------------------

test("system prompt tells the orchestrator commits/pushes/releases are its own job", () => {
  assert(/STEP 7 — FINISH THE BATCH: COMMIT, PUSH, RELEASE/.test(SRC), "STEP 7 section missing");
  assert(/NEVER delegate them to a sub-agent/.test(SRC), "system prompt must forbid delegating release ops");
  assert(/version_bump → git_commit → git_push → create_release/.test(SRC), "release flow order must be documented");
  assert(/never hand that to a sub-agent/.test(SRC), "ACT line must say the orchestrator finishes the batch");
});

// ---------------------------------------------------------------------------
// Manifest: the command prefixes the release flow needs are pre-approved
// ---------------------------------------------------------------------------

test("app.json declares terminalCommandPrefixes for the release flow", () => {
  const prefixes = APP_JSON.terminalCommandPrefixes || [];
  for (const p of ["zsh", "git", "gh", "zip", "cp"]) {
    assert(prefixes.includes(p), "terminalCommandPrefixes must include " + p);
  }
});

test("APP_VERSION in js/00-state.js matches app.json's version", () => {
  const m = SRC.match(/const APP_VERSION = "([^"]+)";/);
  assert(m, "APP_VERSION constant not found in js/00-state.js");
  assert.strictEqual(m[1], APP_JSON.version,
    "APP_VERSION (" + m[1] + ") drifted from app.json version (" + APP_JSON.version + ")");
});

run();
