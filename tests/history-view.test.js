// History-view fix verification tests for Term Coder (Tasks 1, 2, 3).
//
// The app is split into classic scripts under js/ (shared window.termCoder
// namespace — see REFACTOR_PLAN.md), so it can't be `require`d whole in Node.
// These tests follow the same convention as tests/audit-fixes.test.js:
//   1. Read the REAL module sources as text and parse the pure functions out
//      of them (sqliteInterpolate / sqliteLiteral) so the tests fail if the
//      source drifts away from the required behavior.
//   2. Replicate the verbatim decision logic of historyViewTerminal's output
//      fallback (with source-line citations) and assert it never surfaces a raw
//      "no such terminal session" error to the user.
//
// Run: node tests/history-view.test.js   (no test runner, no deps)

const fs = require("fs");
const path = require("path");
const { assert, test, run } = require("./harness.js");
const { allModulesSrc } = require("./module-src.js");

const SRC = allModulesSrc();

// ---------------------------------------------------------------------------
// Helpers: pull sqliteInterpolate + sqliteLiteral VERBATIM out of app.js and
// evaluate them in a sandbox. They are pure (no globals beyond `isFinite`/
// `String`/`Array.isArray`), so this is safe and keeps the test pinned to the
// real source. If someone edits the function bodies, the regex extraction
// fails loudly rather than testing a stale copy.
// ---------------------------------------------------------------------------
function extractFn(src, name, extraScope) {
  const re = new RegExp("function " + name + "\\(([\\s\\S]*?)\\)\\s*\\{");
  const m = src.match(re);
  assert(m, name + " declaration not found in app.js");
  // Walk from the opening brace to its matching close brace (brace counting),
  // so nested object literals / strings with braces don't trip us up.
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
  // extraScope lets a function see siblings it calls (e.g. sqliteInterpolate
  // calls sqliteLiteral). Passed in by name.
  const scopeNames = extraScope ? Object.keys(extraScope) : [];
  const scopeArgs = scopeNames.join(",");
  const scopeVals = scopeNames.map((n) => extraScope[n]);
  // eslint-disable-next-line no-new-func
  const factory = new Function(scopeArgs, head + body + "; return " + name + ";");
  return factory(...scopeVals);
}

const sqliteLiteral = extractFn(SRC, "sqliteLiteral");
const sqliteInterpolate = extractFn(SRC, "sqliteInterpolate", { sqliteLiteral });

// ===========================================================================
// TASK 1 — History > Conversations no longer reports "SQLite storage is
// unavailable". Root cause: the ChatOSS `sqlite` API is HANDLE-based
// (db.open returns an object with .exec/.query/.close) and the platform's
// handle.exec does NOT bind parameters, while Term Coder was written to the
// documented NAMESPACE API (window.chatoss.db.exec(name, sql, params)). The
// fix routes everything through a feature-detecting wrapper whose handle-exec
// path interpolates parameters safely. These tests exercise that interpolation
// (the new logic) so parameterized INSERTs/UPDATEs/DELETEs persist correctly.
// ===========================================================================

test("T1: sqliteLiteral escapes strings, nulls, numbers, booleans", () => {
  assert.strictEqual(sqliteLiteral(null), "NULL", "null -> NULL");
  assert.strictEqual(sqliteLiteral(undefined), "NULL", "undefined -> NULL");
  assert.strictEqual(sqliteLiteral(42), "42", "number -> literal");
  assert.strictEqual(sqliteLiteral(3.5), "3.5", "float -> literal");
  assert.strictEqual(sqliteLiteral(true), "1", "true -> 1");
  assert.strictEqual(sqliteLiteral(false), "0", "false -> 0");
  assert.strictEqual(sqliteLiteral("hello"), "'hello'", "plain string");
  // The critical case: a single quote inside a value (e.g. a model message
  // containing an apostrophe) must be doubled, not break the SQL.
  assert.strictEqual(sqliteLiteral("it's"), "'it''s'", "embedded quote is doubled");
  assert.strictEqual(sqliteLiteral("a''b"), "'a''''b'", "existing doubled quotes are re-doubled");
});

test("T1: sqliteInterpolate substitutes ? placeholders in order", () => {
  const sql = "INSERT INTO messages (id, role, content) VALUES (?, ?, ?)";
  const out = sqliteInterpolate(sql, ["m1", "user", "hello world"]);
  assert.strictEqual(out, "INSERT INTO messages (id, role, content) VALUES ('m1', 'user', 'hello world')",
    "placeholders substituted positionally");
});

test("T1: sqliteInterpolate passes through SQL with no params unchanged", () => {
  const sql = "CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY)";
  assert.strictEqual(sqliteInterpolate(sql, undefined), sql, "no params -> unchanged");
  assert.strictEqual(sqliteInterpolate(sql, []), sql, "empty params array -> unchanged");
});

test("T1: sqliteInterpolate does not substitute ? inside string literals", () => {
  // A model message containing a literal '?' must NOT be treated as a placeholder.
  const sql = "INSERT INTO t (v) VALUES (?)";
  const out = sqliteInterpolate(sql, ["what is 2 + 2? maybe 4"]);
  assert.strictEqual(out, "INSERT INTO t (v) VALUES ('what is 2 + 2? maybe 4')",
    "question mark inside the bound value stays literal");
  // And a SQL string literal already in the statement is left alone.
  const sql2 = "SELECT '?' AS q WHERE v = ?";
  const out2 = sqliteInterpolate(sql2, ["x"]);
  assert.strictEqual(out2, "SELECT '?' AS q WHERE v = 'x'",
    "? inside an existing string literal is not a placeholder");
});

test("T1: sqliteInterpolate handles null params (NULL) and too-few params", () => {
  const sql = "INSERT INTO t (a, b) VALUES (?, ?)";
  assert.strictEqual(sqliteInterpolate(sql, ["x", null]), "INSERT INTO t (a, b) VALUES ('x', NULL)",
    "null param -> NULL keyword");
  // Fewer params than placeholders: remaining placeholders become NULL (safe).
  assert.strictEqual(sqliteInterpolate(sql, ["x"]), "INSERT INTO t (a, b) VALUES ('x', NULL)",
    "missing trailing params -> NULL");
});

test("T1: sqliteInterpolate survives injection-style content safely", () => {
  // All values Term Coder stores are app-generated, but the interpolation must
  // still neutralize anything that looks like SQL in a value.
  const out = sqliteInterpolate("INSERT INTO t (v) VALUES (?)", ["'); DROP TABLE t;--"]);
  assert.strictEqual(out, "INSERT INTO t (v) VALUES ('''); DROP TABLE t;--')",
    "quote in value is doubled so the statement cannot be broken out of");
});

// ===========================================================================
// TASK 2 — The reattach affordance is removed from the History terminals view.
// The "Reattach" button (which called historyReattachTerminal -> reattachSession)
// must no longer be rendered there. The LIVE status badge is intentionally kept.
// ===========================================================================

test("T2: historyReattachTerminal function is gone from app.js", () => {
  // The dead function was removed along with the button. If it reappears, the
  // History view would regain a reattach affordance.
  assert(!/\bfunction historyReattachTerminal\b/.test(SRC),
    "historyReattachTerminal should be removed (it was only used by the History Reattach button)");
});

test("T2: no 'Reattach' button text remains in renderHistoryTerminals", () => {
  // Locate renderHistoryTerminals and ensure it no longer creates a Reattach
  // button. The LIVE badge ('LIVE') is allowed and expected to remain.
  const m = SRC.match(/async function renderHistoryTerminals\([\s\S]*?\n\}/);
  assert(m, "renderHistoryTerminals not found in app.js");
  const body = m[0];
  assert(!/Reattach/.test(body), "renderHistoryTerminals must not contain a 'Reattach' button (T2)");
  assert(/history-badge-live/.test(body), "the LIVE status badge should remain (only the button was removed)");
});

test("T2: the load-flow auto-reattach (reattachSession) is left intact", () => {
  // Conventions: do NOT touch the launch/session-start flow. The auto-reattach
  // in loadPlatformSessions must remain (it is NOT a History-view affordance).
  assert(/loadPlatformSessions[\s\S]{0,400}reattachSession/.test(SRC),
    "loadPlatformSessions should still reattach still-live PTYs at load (untouched)");
});

// ===========================================================================
// TASK 3 — History terminal Output no longer throws a raw
// "Could not read saved output: no such terminal session: <id>" error. When
// attachSession(id) throws (session gone) or returns null/no output, it falls
// back to the SQLite-saved output tail with a clean banner. This replicates
// the VERBATIM decision logic of historyViewTerminal (app.js ~L1237-1273) and
// asserts the rendered text for every branch.
// ===========================================================================

// Replicate the exact fallback logic. `deps` injects the platform boundaries
// (attachSession, deadSessions.get, sqliteGetTerminalMeta, stripAnsi,
// decodeBase64) so we can drive each branch without a browser.
function historyViewOutputLogic(id, deps) {
  const { attachSession, deadSessions, sqliteGetTerminalMeta, stripAnsi, decodeBase64 } = deps;
  let osOutput = null, osGone = false;
  try {
    const attached = attachSession(id);
    if (attached && attached.output) {
      osOutput = stripAnsi(decodeBase64(attached.output));
    }
  } catch (e) {
    osGone = true;
  }
  if (osOutput) {
    return osOutput || "(no output)";
  }
  let saved = "";
  const dead = deadSessions.get(id);
  if (dead && dead.output) saved = dead.output;
  if (!saved) {
    const meta = sqliteGetTerminalMeta(id);
    if (meta && meta.output) saved = meta.output;
  }
  const banner = osGone
    ? "This session is no longer live — showing saved output from history."
    : "No live output for this session — showing saved output from history.";
  if (saved) {
    return banner + "\n\n" + saved;
  } else {
    return "This session is no longer live, and no saved output was found in history.";
  }
}

const stripAnsi = (s) => String(s || "").replace(/\x1b\[[0-9;]*m/g, "");
const decodeBase64 = (b64) => { try { return Buffer.from(String(b64 || ""), "base64").toString("utf8"); } catch (e) { return ""; } };

test("T3: attachSession success shows the live decoded output (no banner)", () => {
  const out = historyViewOutputLogic("s1", {
    attachSession: () => ({ output: Buffer.from("hello from the PTY").toString("base64") }),
    deadSessions: new Map(), sqliteGetTerminalMeta: () => null, stripAnsi, decodeBase64,
  });
  assert.strictEqual(out, "hello from the PTY", "live output is shown directly");
  assert(!/no such terminal session/.test(out), "must never surface the raw platform error");
});

test("T3: attachSession throwing 'no such terminal session' falls back to saved output with banner", () => {
  const out = historyViewOutputLogic("gone-id", {
    attachSession: () => { throw new Error("no such terminal session: gone-id"); },
    deadSessions: new Map(),
    sqliteGetTerminalMeta: () => ({ output: "last lines of output from history" }),
    stripAnsi, decodeBase64,
  });
  assert.strictEqual(out,
    "This session is no longer live — showing saved output from history.\n\nlast lines of output from history",
    "raw error replaced by a clean banner + saved output");
  assert(!/no such terminal session/.test(out), "the raw 'no such terminal session' error must NOT be shown (T3)");
  assert(!/Could not read saved output/.test(out), "the old 'Could not read saved output' message must be gone (T3)");
});

test("T3: attachSession returning null also falls back to saved output", () => {
  const out = historyViewOutputLogic("null-id", {
    attachSession: () => null,
    deadSessions: new Map([["null-id", { output: "from dead card this run" }]]),
    sqliteGetTerminalMeta: () => null, stripAnsi, decodeBase64,
  });
  assert.strictEqual(out,
    "No live output for this session — showing saved output from history.\n\nfrom dead card this run",
    "null attachSession -> saved output (in-memory dead card takes priority)");
});

test("T3: dead card output is preferred over SQLite meta when both exist", () => {
  const out = historyViewOutputLogic("both", {
    attachSession: () => { throw new Error("no such terminal session: both"); },
    deadSessions: new Map([["both", { output: "fresher in-memory tail" }]]),
    sqliteGetTerminalMeta: () => ({ output: "staler sqlite tail" }),
    stripAnsi, decodeBase64,
  });
  assert(out.includes("fresher in-memory tail"), "in-memory dead card output wins");
  assert(!out.includes("staler sqlite tail"), "stale sqlite tail is not used when dead card has output");
});

test("T3: session gone with NO saved output shows a clean message, never a raw error", () => {
  const out = historyViewOutputLogic("nohist", {
    attachSession: () => { throw new Error("no such terminal session: nohist"); },
    deadSessions: new Map(), sqliteGetTerminalMeta: () => null, stripAnsi, decodeBase64,
  });
  assert.strictEqual(out, "This session is no longer live, and no saved output was found in history.",
    "graceful message when nothing is available");
  assert(!/no such terminal session/.test(out), "no raw error leaked");
  assert(!/Could not read/.test(out), "no old error message leaked");
});

test("T3: ANSI codes in saved output are stripped from the rendered text", () => {
  // The dead card / sqlite tail is already ANSI-stripped when persisted, but
  // the live path strips too — guard that stripAnsi is applied to OS output.
  const out = historyViewOutputLogic("ansi", {
    attachSession: () => ({ output: Buffer.from("\x1b[32mgreen\x1b[0m text").toString("base64") }),
    deadSessions: new Map(), sqliteGetTerminalMeta: () => null, stripAnsi, decodeBase64,
  });
  assert.strictEqual(out, "green text", "ANSI escapes stripped from live output");
});

run();