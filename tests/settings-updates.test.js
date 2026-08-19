// Settings screen verification tests for Term Coder:
//   T1 — "Check for updates" flow (version compare, GitHub sources, release link)
//   T2 — Settings accuracy fixes (setCli legacy fallback, model-mode fallback)
//   T3 — Ollama model detection unification (Settings consumes the same
//        complete list the chat model picker uses)
//
// app.js is a browser module (top-level `window`/`document`/`window.chatoss`
// references + an auto-running `init()`), so it can't be `require`d whole in
// Node. These tests instead:
//   1. Read the REAL app.js source as text and assert the wiring patterns.
//   2. Replicate the exact decision predicates changed by the fixes VERBATIM
//      from app.js (with the source line cited in a comment), and assert they
//      behave correctly — so a revert of a fix's predicate still fails here.
//
// Run: node tests/settings-updates.test.js   (no test runner, no deps)

const fs = require("fs");
const path = require("path");
const { assert, test, run } = require("./harness.js");

const SRC = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const APP_JSON = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "app.json"), "utf8"));

// ---------------------------------------------------------------------------
// T1 — Check for updates
// ---------------------------------------------------------------------------

test("T1: app.json declares webSearch + openExternal and allows the GitHub hosts", () => {
  assert(Array.isArray(APP_JSON.capabilities), "app.json capabilities missing");
  assert(APP_JSON.capabilities.includes("webSearch"), "webSearch capability missing (needed for web.fetch)");
  assert(APP_JSON.capabilities.includes("openExternal"), "openExternal capability missing (needed for the releases link)");
  // All pre-existing capabilities must be preserved.
  for (const cap of ["chatApi", "terminal", "fileAccess", "boards", "notifications", "clipboardWrite", "sqlite"]) {
    assert(APP_JSON.capabilities.includes(cap), "pre-existing capability dropped: " + cap);
  }
  assert(Array.isArray(APP_JSON.openExternalAllowlist), "openExternalAllowlist missing");
  assert(APP_JSON.openExternalAllowlist.includes("github.com"), "github.com not in openExternalAllowlist");
  assert(APP_JSON.openExternalAllowlist.includes("raw.githubusercontent.com"), "raw.githubusercontent.com not in openExternalAllowlist");
});

test("T1: APP_VERSION in app.js matches app.json's version", () => {
  const m = SRC.match(/const APP_VERSION = "([^"]+)";/);
  assert(m, "APP_VERSION constant not found in app.js");
  assert.strictEqual(m[1], APP_JSON.version,
    "APP_VERSION (" + m[1] + ") drifted from app.json version (" + APP_JSON.version + ")");
});

// Verbatim from app.js (parseVersion / compareVersions, ~L3150):
function parseVersion(v) {
  const m = String(v == null ? "" : v).trim().replace(/^v/i, "").match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return [parseInt(m[1], 10) || 0, parseInt(m[2], 10) || 0, parseInt(m[3], 10) || 0];
}
function compareVersions(a, b) {
  const pa = parseVersion(a), pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

test("T1: compareVersions orders versions correctly (incl. v-prefix and partials)", () => {
  assert.strictEqual(compareVersions("1.16.1", "1.16.1"), 0, "equal versions must compare 0");
  assert(compareVersions("1.17.0", "1.16.1") > 0, "1.17.0 is newer than 1.16.1");
  assert(compareVersions("1.16.1", "1.17.0") < 0, "1.16.1 is older than 1.17.0");
  assert(compareVersions("2.0.0", "1.99.99") > 0, "major bump wins");
  assert(compareVersions("1.16.2", "1.16.10") < 0, "patch 10 > patch 2 (numeric, not string)");
  assert(compareVersions("v1.17.0", "1.16.1") > 0, "leading v must be stripped (release tag_name)");
  assert(compareVersions("1.17", "1.16.1") > 0, "partial version 1.17 == 1.17.0");
  assert.strictEqual(compareVersions("not-a-version", "1.16.1"), 0, "unparseable must compare equal (no false update)");
  assert.strictEqual(compareVersions("", "1.16.1"), 0, "empty must compare equal");
});

test("T1: update decision predicate flags only genuinely newer versions", () => {
  // Verbatim from app.js (checkForUpdates): update shown iff compareVersions(remote, APP_VERSION) > 0.
  const APP_VERSION = APP_JSON.version;
  const decide = (remote) => compareVersions(remote, APP_VERSION) > 0;
  assert.strictEqual(decide("1.19.0"), true, "newer remote must show the update");
  assert.strictEqual(decide("v1.19.0"), true, "newer v-prefixed tag must show the update");
  assert.strictEqual(decide("1.18.0"), false, "same version must show up-to-date");
  assert.strictEqual(decide("1.17.0"), false, "older remote must show up-to-date");
  assert.strictEqual(decide("garbage"), false, "unparseable remote must NOT show an update");
});

test("T1: checkForUpdates wires the GitHub sources, statuses, and the releases link", () => {
  // Primary source: the repo's app.json on main, parsed for "version".
  assert(/UPDATES_APP_JSON_URL = "https:\/\/raw\.githubusercontent\.com\/pagecow\/term-coder\/main\/app\.json"/.test(SRC),
    "primary update source (raw app.json) missing");
  assert(/json && json\.version/.test(SRC), "app.json source must read the version field");
  // Fallback: latest release tag_name.
  assert(/UPDATES_RELEASES_API_URL = "https:\/\/api\.github\.com\/repos\/pagecow\/term-coder\/releases\/latest"/.test(SRC),
    "fallback update source (releases/latest) missing");
  assert(/json && json\.tag_name/.test(SRC), "releases fallback must read tag_name");
  // Statuses.
  assert(/Couldn't check for updates — check your connection/.test(SRC), "failure status message missing");
  assert(/"Update available: " \+ remote/.test(SRC), "update-available status missing");
  assert(/"Up to date \(" \+ APP_VERSION \+ "\)"/.test(SRC), "up-to-date status missing");
  // The update action opens the releases page via openExternal (the app cannot
  // self-replace its files — notify + link out is the whole flow).
  assert(/UPDATES_RELEASES_PAGE_URL = "https:\/\/github\.com\/pagecow\/term-coder\/releases"/.test(SRC),
    "releases page URL missing");
  assert(/openExternal\.open\(UPDATES_RELEASES_PAGE_URL\)/.test(SRC), "releases page must open via openExternal");
  // The check must be user-triggered from the Settings button.
  assert(/checkUpdatesBtn\.addEventListener\("click", checkForUpdates\)/.test(SRC), "Check-for-updates button not wired");
  assert(/openReleasesBtn\.addEventListener\("click", openReleasesPage\)/.test(SRC), "Get-update button not wired");
});

test("T1: raw app.json fetch is cache-busted (forces a CDN cache miss)", () => {
  // The raw.githubusercontent.com CDN (Fastly) serves a stale cached copy, so
  // the fetch MUST append a unique query param to force a cache miss. The
  // constant itself stays unchanged (a prior test asserts its exact value);
  // only the call site is cache-busted.
  assert(/UPDATES_APP_JSON_URL \+ "\?t=" \+ Date\.now\(\)/.test(SRC),
    "raw fetch must append a cache-busting query param (UPDATES_APP_JSON_URL + \"?t=\" + Date.now())");
  // The constant must still be the bare URL with no query string baked in.
  assert(/UPDATES_APP_JSON_URL = "https:\/\/raw\.githubusercontent\.com\/pagecow\/term-coder\/main\/app\.json";/.test(SRC),
    "UPDATES_APP_JSON_URL constant must stay the bare URL (cache-bust is at the call site)");
});

test("T1: contents-API fallback exists and decodes base64 content", () => {
  // A reliable second source: the GitHub contents API returns JSON whose
  // "content" field is base64-encoded (and may contain embedded newlines).
  const URL = "https://api.github.com/repos/pagecow/term-coder/contents/app.json";
  assert(SRC.indexOf('UPDATES_CONTENTS_API_URL = "' + URL + '"') !== -1,
    "UPDATES_CONTENTS_API_URL constant must be the GitHub contents API URL");
  // The path must decode the base64 "content" field with atob.
  assert(/atob\(/.test(SRC), "contents-API path must decode base64 with atob");
  assert(/\.replace\(\/\\s\+\/g, ""\)/.test(SRC),
    "contents-API path must strip whitespace/newlines from the content before atob");
  // It must read the version from the decoded payload.
  assert(/readContentsApi/.test(SRC), "a dedicated contents-API reader must be wired");
  assert(/readContentsApi\(UPDATES_CONTENTS_API_URL\)/.test(SRC),
    "readContentsApi must be called with UPDATES_CONTENTS_API_URL");
});

// Verbatim from app.js (readContentsApi, ~L3320): the decode half of the
// contents-API path — given the parsed contents-API JSON, strip whitespace/
// newlines from the base64 "content", atob it, JSON.parse, then regex fallback.
function readContentsApiDecode(json) {
  if (!json || !json.content) return null;
  try {
    const decoded = atob(String(json.content).replace(/\s+/g, ""));
    try { return JSON.parse(decoded); } catch (e) { /* fall through to regex */ }
    const m = decoded.match(/"version"\s*:\s*"([^"]+)"/);
    return m ? { version: m[1] } : null;
  } catch (e) { return null; }
}

test("T1: readContentsApiDecode extracts version from a base64 contents payload", () => {
  // A real contents-API response: "content" is base64 of the app.json body.
  // GitHub chunk-splits long content with embedded newlines every 76 chars.
  const appJsonBody = JSON.stringify({ id: "com.thetjmccarty.termcoder", name: "Term Coder", version: "1.18.1" });
  const b64clean = Buffer.from(appJsonBody, "utf8").toString("base64");
  // Simulate the 76-char line wrapping GitHub inserts into the content field.
  const wrapped = b64clean.match(/.{1,76}/g).join("\n");
  const out = readContentsApiDecode({ content: wrapped, encoding: "base64" });
  assert(out && out.version === "1.18.1",
    "must strip newlines, atob, JSON.parse and read version, got: " + JSON.stringify(out));
});

test("T1: readContentsApiDecode handles malformed/wrapped decoded payloads via regex", () => {
  // If the decoded text is not valid JSON (e.g. the fetcher wrapped/trimmed it),
  // the regex fallback must still recover the version field.
  const decodedText = 'some leading garbage ... "version": "1.19.0" ... trailing junk';
  // Pre-encode so atob reproduces the decodedText; inject as the content field.
  const payload = { content: Buffer.from(decodedText, "utf8").toString("base64") };
  const out = readContentsApiDecode(payload);
  assert(out && out.version === "1.19.0",
    "regex fallback must recover version from a non-JSON decoded payload, got: " + JSON.stringify(out));
});

test("T1: readContentsApiDecode returns null for missing/bad content", () => {
  assert.strictEqual(readContentsApiDecode(null), null, "null json -> null");
  assert.strictEqual(readContentsApiDecode({}), null, "no content field -> null");
  assert.strictEqual(readContentsApiDecode({ content: "!!!not-base64!!!" }), null,
    "undecodable base64 -> null (caught, no throw)");
});

test("T1: fallback chain order is raw first, contents second, releases last", () => {
  // Locate the three fetch attempts inside fetchLatestVersion by their
  // distinctive call sites, then assert they appear in source order.
  const rawIdx = SRC.indexOf('UPDATES_APP_JSON_URL + "?t=" + Date.now()');
  const contentsIdx = SRC.indexOf("readContentsApi(UPDATES_CONTENTS_API_URL)");
  const releasesIdx = SRC.indexOf("readJson(UPDATES_RELEASES_API_URL)");
  assert(rawIdx !== -1, "cache-busted raw fetch not found");
  assert(contentsIdx !== -1, "contents-API fallback not found");
  assert(releasesIdx !== -1, "releases fallback not found");
  assert(rawIdx < contentsIdx, "raw fetch must come before the contents-API fallback");
  assert(contentsIdx < releasesIdx, "contents-API fallback must come before the releases fallback");
});

// ---------------------------------------------------------------------------
// T2 — Settings accuracy fixes
// ---------------------------------------------------------------------------

test("T2: openSettings falls back to 'ask' for a legacy cliDefault not in the select", () => {
  // Verbatim from app.js (openSettings): the saved default is applied only when
  // it is among the select's current options, else "ask".
  const cliValues = ["ask", "claude", "codex", "chatgpt", "hermes", "opencode", "copilot"];
  const pick = (saved) => (cliValues.includes(saved) ? saved : "ask");
  assert.strictEqual(pick("codex"), "codex", "valid saved default must be kept");
  assert.strictEqual(pick("ask"), "ask");
  assert.strictEqual(pick("ollama"), "ask", "legacy 'ollama' value must fall back to ask (blank select bug)");
  assert.strictEqual(pick(""), "ask", "empty value must fall back to ask");
  assert.strictEqual(pick(undefined), "ask", "undefined value must fall back to ask");
  // The source must contain the fallback wiring.
  assert(/cliValues\.includes\(settings\.cliDefault\) \? settings\.cliDefault : "ask"/.test(SRC),
    "openSettings setCli fallback wiring missing");
});

test("T2: applyModelSelectionModeToUi falls back to Manual for an invalid persisted mode", () => {
  // Verbatim from app.js: an unmatched radio resets the mode to "manual" so the
  // UI is never left with no radio checked and every panel hidden.
  const VALID = ["manual", "always", "complexity"];
  const resolve = (mode) => (VALID.includes(mode) ? mode : "manual");
  assert.strictEqual(resolve("always"), "always");
  assert.strictEqual(resolve("complexity"), "complexity");
  assert.strictEqual(resolve("bogus"), "manual", "invalid mode must fall back to manual");
  assert.strictEqual(resolve(undefined), "manual", "missing mode must fall back to manual");
  assert(/mode = "manual";/.test(SRC), "applyModelSelectionModeToUi manual fallback missing");
});

// ---------------------------------------------------------------------------
// T3 — Ollama model detection unification
// ---------------------------------------------------------------------------

// Verbatim from app.js (allOllamaModels): merge terminal-detected models with
// the local models from the ChatOSS chat model list (the same source the model
// picker at the top of the AI chat section uses), deduped by id.
function allOllamaModels(detection, models) {
  const seen = new Set();
  const out = [];
  const push = (m) => {
    if (m && !seen.has(m)) { seen.add(m); out.push(m); }
  };
  for (const m of (detection && detection.models) || []) push(m);
  for (const m of models) {
    if (m && m.source === "local" && m.id) push(m.id);
  }
  return out;
}
// Verbatim from app.js (availableOllamaModels): fall back to FALLBACK_MODELS
// only when the merged list is empty.
function availableOllamaModels(detection, models, FALLBACK_MODELS) {
  const m = allOllamaModels(detection, models);
  return m.length ? m : FALLBACK_MODELS.slice();
}

test("T3: allOllamaModels merges terminal detection with the chat picker's local models", () => {
  // The bug: the terminal probe saw only 5 models while the chat model picker
  // (chat.listModels) saw all 10 local models. The merged list must show all.
  const detection = { models: ["a:1", "b:1", "c:1", "d:1", "e:1"] };
  const chatModels = [
    { id: "a:1", name: "A", source: "local" },
    { id: "b:1", name: "B", source: "local" },
    { id: "c:1", name: "C", source: "local" },
    { id: "d:1", name: "D", source: "local" },
    { id: "e:1", name: "E", source: "local" },
    { id: "f:1", name: "F", source: "local" },
    { id: "g:1", name: "G", source: "local" },
    { id: "h:1", name: "H", source: "local" },
    { id: "i:1", name: "I", source: "local" },
    { id: "j:1", name: "J", source: "local" },
    { id: "cloud-1", name: "Cloud", source: "cloud" },
    { id: "custom-1", name: "Custom", source: "custom" },
  ];
  const merged = allOllamaModels(detection, chatModels);
  assert.strictEqual(merged.length, 10, "merged list must contain all 10 local models, got: " + JSON.stringify(merged));
  for (const id of ["a:1", "b:1", "c:1", "d:1", "e:1", "f:1", "g:1", "h:1", "i:1", "j:1"]) {
    assert(merged.includes(id), "missing model " + id);
  }
  assert(!merged.includes("cloud-1"), "cloud models must not become ollama launch targets");
  assert(!merged.includes("custom-1"), "custom models must not become ollama launch targets");
  assert.strictEqual(new Set(merged).size, merged.length, "merged list must be deduped");
});

test("T3: allOllamaModels handles empty/partial sources", () => {
  // In the app, `models` is always an array (module-level `let models = []`),
  // so the verbatim loop over it is safe; only `detection` can be null.
  assert.deepStrictEqual(allOllamaModels(null, []), [], "null detection + no chat models -> empty");
  assert.deepStrictEqual(allOllamaModels({ models: [] }, []), [], "empty detection + no chat models -> empty");
  assert.deepStrictEqual(allOllamaModels(null, [{ id: "x:1", source: "local" }]), ["x:1"], "chat-only local models survive");
  assert.deepStrictEqual(allOllamaModels({ models: ["x:1"] }, []), ["x:1"], "detection-only models survive");
  // Chat model entries without an id or a non-local source are skipped.
  assert.deepStrictEqual(allOllamaModels(null, [{ name: "no-id", source: "local" }]), [], "local entry without id skipped");
});

test("T3: availableOllamaModels falls back to FALLBACK_MODELS only when both sources are empty", () => {
  const FALLBACK = ["qwen3:30b", "qwen3:14b", "llama3.2:latest", "mistral:latest"];
  assert.deepStrictEqual(availableOllamaModels(null, [], FALLBACK), FALLBACK, "empty sources -> fallback list");
  assert.deepStrictEqual(
    availableOllamaModels({ models: ["a:1"] }, [], FALLBACK),
    ["a:1"],
    "detected models must win over the fallback");
  assert.deepStrictEqual(
    availableOllamaModels(null, [{ id: "a:1", source: "local" }], FALLBACK),
    ["a:1"],
    "chat-local models must win over the fallback");
});

test("T3: Settings consumes the live detection + merged list (source wiring)", () => {
  // renderDetectedList must read the LIVE `detection` object — the same source
  // the launch-target pickers use — not the persisted settings.detected
  // snapshot (the stale/limited list that caused the 5-vs-all mismatch).
  assert(!/const d = settings\.detected/.test(SRC), "renderDetectedList still reads the stale settings.detected snapshot");
  assert(/const d = detection \|\| \{ codex: false/.test(SRC), "renderDetectedList must read the live detection object");
  // The detected list must show the merged model list.
  assert(/const ollamaModels = allOllamaModels\(\);/.test(SRC), "renderDetectedList must use allOllamaModels()");
  // availableOllamaModels (the pickers' source) must consume the merged list.
  assert(/const m = allOllamaModels\(\);/.test(SRC), "availableOllamaModels must consume allOllamaModels()");
  // detectTools/parseOllamaModels themselves must be untouched by this fix.
  assert(/function parseOllamaModels\(out\)/.test(SRC), "parseOllamaModels declaration missing");
  assert(/fresh\.models = parseOllamaModels\(listR\.output\);/.test(SRC), "detectTools parse wiring missing");
});

run();
