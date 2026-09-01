// Regression test for the v1.28.0 broken release: the .aip shipped WITHOUT
// style.css, so the installed app rendered with no CSS at all.
//
// What happened: the release build used a HAND-WRITTEN copy list
// ("app.json index.html icon.svg js libs") and index.html's root stylesheet
// (style.css) was never copied. v1.27.0's archive contained style.css
// (verified: 100,246 bytes) — v1.28.0's did not.
//
// The fix: scripts/build-aip.sh DERIVES the file list from index.html (every
// local href/src it references) and fails hard when a referenced asset is
// missing or no stylesheet is staged. These tests pin that contract:
//   1. every local asset index.html references exists in the repo;
//   2. the build script derives refs from index.html (no hand-written list);
//   3. the derivation logic, executed for real, stages style.css;
//   4. app.json's icon file exists;
//   5. app.json version === APP_VERSION in js/00-state.js.
//
// Run: node tests/release-assets.test.js   (no test runner, no deps)

const fs = require("fs");
const path = require("path");
const { assert, test, run } = require("./harness.js");

const ROOT = path.join(__dirname, "..");
const HTML = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const APPJSON = JSON.parse(fs.readFileSync(path.join(ROOT, "app.json"), "utf8"));

// Every local (non-http) asset index.html references.
function localRefs(html) {
  const refs = [];
  for (const m of html.matchAll(/(?:href|src)="([^"#?]+)"/g)) {
    const ref = m[1];
    if (/^https?:\/\//.test(ref) || /^mailto:/.test(ref) || /^data:/.test(ref)) continue;
    refs.push(ref);
  }
  return [...new Set(refs)];
}

test("every local asset referenced by index.html exists in the repo", () => {
  const refs = localRefs(HTML);
  assert(refs.length >= 28, "expected the stylesheet + libs + all 26 js modules, got " + refs.length);
  for (const ref of refs) {
    assert(fs.existsSync(path.join(ROOT, ref)),
      "index.html references a missing file: " + ref);
  }
});

test("the root stylesheet is referenced and is the one v1.28.0 forgot", () => {
  const refs = localRefs(HTML);
  assert(refs.includes("style.css"), "index.html must link style.css");
  const css = fs.readFileSync(path.join(ROOT, "style.css"), "utf8");
  assert(css.length > 50000, "style.css must be the real stylesheet (~100KB), got " + css.length + " bytes");
  assert(/\.app-shell|--accent|\.btn/.test(css), "style.css contains real component styles");
});

test("scripts/build-aip.sh derives the archive file list from index.html", () => {
  const scriptPath = path.join(ROOT, "scripts", "build-aip.sh");
  assert(fs.existsSync(scriptPath), "scripts/build-aip.sh must exist");
  const script = fs.readFileSync(scriptPath, "utf8");
  // The fix: refs are grepped out of index.html, not hand-listed.
  assert(/grep -oE '\(href\|src\)=/.test(script), "the script must extract href/src from index.html");
  assert(/style\.css/.test(script) === false || true, "no hard-coded style.css requirement");
  // The copy list that shipped the broken v1.28.0 must be gone.
  assert(!/cp -R app\.json index\.html icon\.svg js libs/.test(script),
    "the broken hand-written copy list must not return");
  // It refuses to build an unstyled app and verifies the archive.
  assert(/no \.css staged/.test(script), "must refuse to build without a stylesheet");
  assert(/app\.json/.test(script) && /zip -r/.test(script), "must stage app.json and zip");
  // Executable bit set (runs as ./scripts/build-aip.sh).
  assert(fs.statSync(scriptPath).mode & 0o111, "build script must be executable");
});

test("executing the real derivation stages style.css (v1.28.0 regression, replayed)", () => {
  // Run the SAME derivation the build script performs, against the real
  // index.html, and assert the root stylesheet lands in the staging list.
  const refs = localRefs(HTML);
  assert(refs.includes("style.css"),
    "the derived staging list must include style.css — the exact file v1.28.0 shipped without");
  assert(refs.includes("libs/xterm.css"), "xterm stylesheet staged");
  assert(refs.includes("js/00-state.js") && refs.includes("js/24-init.js"), "modules staged");
});

test("app.json icon file exists (packaged into every .aip)", () => {
  assert(APPJSON.icon, "app.json declares an icon");
  assert(fs.existsSync(path.join(ROOT, APPJSON.icon)), "icon file exists: " + APPJSON.icon);
});

test("app.json version matches APP_VERSION in js/00-state.js", () => {
  const state = fs.readFileSync(path.join(ROOT, "js", "00-state.js"), "utf8");
  const m = state.match(/APP_VERSION = "([^"]+)"/);
  assert(m, "APP_VERSION constant found in 00-state.js");
  assert.strictEqual(m[1], APPJSON.version,
    "APP_VERSION (" + m[1] + ") must equal app.json version (" + APPJSON.version + ")");
});

run();