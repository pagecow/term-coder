// 02-sqlite.js — classic script (converted from an ES module; see REFACTOR_PLAN.md).
// Exports are registered on the shared window.termCoder namespace (TC).
(function () {
"use strict";
const TC = window.termCoder = window.termCoder || {};
const SQLITE_DB = "termcoder";
let sqliteReady = false;
let sqliteInitPromise = null;

// --- ChatOSS sqlite API shape detection -------------------------------
// The documented contract is namespace-based: `db.open(name)` returns a
// sanitized NAME string, then `db.exec(name, sql, params)` / `db.query(name,
// sql, params)` / `db.close(name)` live on `window.chatoss.db`.
//
// The ACTUAL ChatOSS platform (as of the build this app runs against) is
// HANDLE-based: `db.open(name)` returns an OBJECT whose own methods are
// `handle.exec(sql)`, `handle.query(sql, params)` and `handle.close()`, with
// NO name argument (the handle is already bound to its DB). It also has a
// quirk: `handle.exec` does NOT bind parameters (it ignores any params arg,
// throwing "Wrong number of parameters passed to query"), while
// `handle.query(sql, paramsArray)` DOES bind them.
//
// To stay correct against EITHER shape (and survive a future platform change
// that brings the namespace API in line with the docs), we detect the shape
// once at open time and route every call through these helpers:
let sqliteApiShape = "unknown"; // "namespace" | "handle"
let sqliteHandle = null;        // the handle object when shape === "handle"
let sqliteName = null;          // the sanitized name string when shape === "namespace"

// Safely substitute `?` placeholders in a SQL string when the active exec path
// cannot bind params (i.e. the handle-exec path, which ignores params). Values
// are escaped for SQLite: strings get their quotes doubled, numbers/booleans
// are emitted literally, null/undefined -> NULL. This is only a fallback for
// the handle.exec() path; the namespace and handle.query() paths bind params
// natively. NOTE: every value Term Coder stores here is app-generated (ids,
// model output, tool results) — not user SQL — so interpolation is safe.
function sqliteInterpolate(sql, params) {
  if (!Array.isArray(params) || params.length === 0) return sql;
  let i = 0, out = "", literal = false;
  for (let k = 0; k < sql.length; k++) {
    const ch = sql[k];
    if (literal) { out += ch; if (ch === "'" && sql[k + 1] === "'") { out += "'"; k++; } else if (ch === "'") literal = false; continue; }
    if (ch === "'") { literal = true; out += ch; continue; }
    if (ch === "?") {
      const v = i < params.length ? params[i++] : null;
      out += sqliteLiteral(v);
      continue;
    }
    out += ch;
  }
  return out;
}
function sqliteLiteral(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return (isFinite(v) ? String(v) : "NULL");
  if (typeof v === "boolean") return v ? "1" : "0";
  // strings: escape embedded single quotes by doubling them
  return "'" + String(v).replace(/'/g, "''") + "'";
}

// Internal raw exec — does NOT gate on sqliteReady (used DURING sqliteInit to
// create the schema before the ready flag is set). Returns affected-row count.
async function _sqliteExecRaw(sql, params) {
  if (sqliteApiShape === "namespace") {
    return await window.chatoss.db.exec(sqliteName, sql, params) | 0;
  }
  // handle shape — exec does NOT bind params, so interpolate them in safely
  const real = params && params.length ? sqliteInterpolate(sql, params) : sql;
  return await sqliteHandle.exec(real) | 0;
}

// Internal raw query — does NOT gate on sqliteReady.
async function _sqliteQueryRaw(sql, params) {
  if (sqliteApiShape === "namespace") {
    return await window.chatoss.db.query(sqliteName, sql, params) || [];
  }
  // handle shape — query DOES bind params natively
  return await sqliteHandle.query(sql, params || []) || [];
}

// Run a statement (DDL/DML). Accepts (sql, params?). Returns the affected-row
// count from the platform (or 0 when the platform returns nothing meaningful).
async function sqliteExec(sql, params) {
  if (!sqliteReady) return 0;
  try {
    return await _sqliteExecRaw(sql, params);
  } catch (e) { console.warn("sqliteExec", e && e.message ? e.message : String(e), sql); throw e; }
}

// Run a SELECT. Accepts (sql, params?). Returns rows as objects keyed by column.
async function sqliteQuery(sql, params) {
  if (!sqliteReady) return [];
  try {
    return await _sqliteQueryRaw(sql, params);
  } catch (e) { console.warn("sqliteQuery", e && e.message ? e.message : String(e), sql); throw e; }
}

// Open the private DB and create the schema (idempotent). Returns true when
// the DB is usable; every helper below gates on this. Retries on a transient
// failure (the cached promise is cleared so a later open can succeed).
async function sqliteInit() {
  if (sqliteReady) return true;
  if (sqliteInitPromise) return sqliteInitPromise;
  sqliteInitPromise = (async () => {
    let step = "open";
    try {
      if (!window.chatoss || !window.chatoss.db) return false;
      const opened = await window.chatoss.db.open(SQLITE_DB);
      if (!opened) { return false; }
      // Detect API shape: a string sanitized name -> namespace API; an object
      // with exec/query -> handle API.
      if (typeof opened === "string") {
        sqliteApiShape = "namespace";
        sqliteName = opened;
        sqliteHandle = null;
      } else if (opened && typeof opened === "object" && typeof opened.exec === "function") {
        sqliteApiShape = "handle";
        sqliteHandle = opened;
        sqliteName = null;
      } else {
        // Unknown shape — can't proceed.
        console.warn("sqliteInit: unrecognized db.open() return type", typeof opened);
        return false;
      }
      step = "schema";
      // Use the RAW exec here (sqliteReady is not set yet, so sqliteExec would
      // no-op). Schema statements have no params, so interpolation is a no-op.
      await _sqliteExecRaw("CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT, folder_path TEXT, created_at INTEGER)");
      await _sqliteExecRaw("CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, created_at INTEGER)");
      await _sqliteExecRaw("CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT, content TEXT, thinking TEXT, tool_calls TEXT, seq INTEGER, created_at INTEGER)");
      await _sqliteExecRaw("CREATE TABLE IF NOT EXISTS tool_calls (id TEXT PRIMARY KEY, conversation_id TEXT, tool TEXT, args TEXT, result TEXT, created_at INTEGER)");
      await _sqliteExecRaw("CREATE TABLE IF NOT EXISTS terminal_sessions (id TEXT PRIMARY KEY, command TEXT, cwd TEXT, label TEXT, agent TEXT, worktree_branch TEXT, status TEXT, exit_code INTEGER, created_at INTEGER, last_active INTEGER, live INTEGER, merged INTEGER, output TEXT)");
      await _sqliteExecRaw("CREATE TABLE IF NOT EXISTS worktrees (branch TEXT PRIMARY KEY, wt_path TEXT, parent_branch TEXT, project_path TEXT, created_at INTEGER)");
      sqliteReady = true;
      return true;
    } catch (e) {
      console.warn("sqliteInit failed at step", step, ":", e && e.message ? e.message : String(e));
      // Clear the cached promise so a later attempt (e.g. after the capability
      // becomes ready) can retry instead of being stuck on a false result.
      sqliteInitPromise = null;
      return false;
    }
  })();
  return sqliteInitPromise;
}

// ---------- Conversations / messages / tool calls ----------

// Debounced full mirror of state.projects -> conversations -> messages into
// SQLite. saveState() calls scheduleSqliteSync(), so every message push (user,
// assistant, system) and every rename lands here within ~700ms. The sync is a
// full rewrite per conversation (delete + reinsert messages) — simple and
// correct; message ids are deterministic ("<convId>:<index>") so re-syncs are
// stable. Tool calls are upserted by id and never bulk-deleted here, so a
// mid-turn write (see sqlitePersistToolCall) survives a sync that runs before
// the assistant message is stored.
let _sqliteSyncTimer = null;
// Other modules (the init flush handler) cancel a pending sync through this —
// the timer binding itself is exported read-only.
function cancelPendingSqliteSync() {
  if (_sqliteSyncTimer) { clearTimeout(_sqliteSyncTimer); _sqliteSyncTimer = null; }
}
function scheduleSqliteSync() {
  if (_sqliteSyncTimer) return;
  _sqliteSyncTimer = setTimeout(() => {
    _sqliteSyncTimer = null;
    syncConversationsToSqlite().catch((e) => console.warn("scheduleSqliteSync", e));
  }, 700);
}

async function syncConversationsToSqlite() {
  if (!(await sqliteInit())) return;
  try {
    const projects = Array.isArray(TC.state.projects) ? TC.state.projects : [];
    for (const p of projects) {
      await sqliteExec(
        "INSERT OR REPLACE INTO projects (id, name, folder_path, created_at) VALUES (?, ?, ?, ?)",
        [p.id, p.name || "", p.folderPath || "", p.createdAt || Date.now()]);
      for (const c of (p.conversations || [])) {
        await sqliteExec(
          "INSERT OR REPLACE INTO conversations (id, project_id, title, created_at) VALUES (?, ?, ?, ?)",
          [c.id, p.id, c.name || c.id, c.createdAt || Date.now()]);
        await sqliteExec("DELETE FROM messages WHERE conversation_id = ?", [c.id]);
        const baseTs = c.createdAt || Date.now();
        let idx = 0;
        for (const m of (c.messages || [])) {
          const mid = c.id + ":" + idx;
          await sqliteExec(
            "INSERT INTO messages (id, conversation_id, role, content, thinking, tool_calls, seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [mid, c.id, m.role || "system", m.content || "",
             m.thinking || null,
             (m.toolCalls && m.toolCalls.length) ? JSON.stringify(m.toolCalls) : null,
             idx, baseTs + idx]);
          if (m.toolCalls && m.toolCalls.length) {
            for (const tc of m.toolCalls) {
              await sqliteExec(
                "INSERT OR REPLACE INTO tool_calls (id, conversation_id, tool, args, result, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                [tc.id || TC.uuid(), c.id, tc.name || "unknown",
                 JSON.stringify(tc.args || {}),
                 tc.error ? ("Error: " + tc.error) : (tc.result != null ? String(tc.result) : null),
                 tc.createdAt || Date.now()]);
            }
          }
          idx++;
        }
      }
    }
  } catch (e) { console.warn("syncConversationsToSqlite", e); }
}

// Write one tool call as it happens (mid-turn). Upsert by id so the result
// update later in the same turn replaces the pending row.
async function sqlitePersistToolCall(conversationId, tc) {
  if (!(await sqliteInit())) return;
  try {
    await sqliteExec(
      "INSERT OR REPLACE INTO tool_calls (id, conversation_id, tool, args, result, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [tc.id || TC.uuid(), conversationId, tc.name || "unknown",
       JSON.stringify(tc.args || {}),
       tc.error ? ("Error: " + tc.error) : (tc.result != null ? String(tc.result) : null),
       tc.createdAt || Date.now()]);
  } catch (e) { console.warn("sqlitePersistToolCall", e); }
}

async function sqliteDeleteConversation(cid) {
  if (!(await sqliteInit())) return;
  try {
    await sqliteExec("DELETE FROM messages WHERE conversation_id = ?", [cid]);
    await sqliteExec("DELETE FROM tool_calls WHERE conversation_id = ?", [cid]);
    await sqliteExec("DELETE FROM conversations WHERE id = ?", [cid]);
  } catch (e) { console.warn("sqliteDeleteConversation", e); }
}

async function sqliteDeleteProject(pid) {
  if (!(await sqliteInit())) return;
  try {
    const rows = await sqliteQuery("SELECT id FROM conversations WHERE project_id = ?", [pid]);
    for (const r of rows) await sqliteDeleteConversation(r.id);
    await sqliteExec("DELETE FROM projects WHERE id = ?", [pid]);
  } catch (e) { console.warn("sqliteDeleteProject", e); }
}

// Restore projects/conversations/messages from SQLite at load. SQLite is the
// authoritative history store: scopedData may be stale or lost after an
// orchestration session. Merge rules:
//   • Projects missing from state are recreated (folderPath comes from the
//     projects table, so a lost scopedData blob still restores fully).
//   • A conversation missing from state is recreated with its SQLite messages.
//   • A conversation present in state keeps its (possibly newer) name, and its
//     messages become the SQLite ones — plus any in-memory tail that has not
//     been synced yet (state longer than SQLite).
async function hydrateFromSqlite() {
  if (!(await sqliteInit())) return;
  try {
    const prows = await sqliteQuery("SELECT * FROM projects ORDER BY created_at ASC");
    for (const pr of prows) {
      if (!TC.state.projects.some((p) => p.id === pr.id)) {
        TC.state.projects.push({
          id: pr.id,
          name: pr.name || TC.basename(pr.folder_path),
          folderPath: pr.folder_path || "",
          conversations: [],
        });
      }
    }
    const crows = await sqliteQuery("SELECT * FROM conversations ORDER BY created_at ASC");
    for (const cr of crows) {
      const p = TC.state.projects.find((x) => x.id === cr.project_id);
      if (!p) continue; // orphaned (project deleted) — leave the rows alone
      const mrows = await sqliteQuery(
        "SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq ASC", [cr.id]);
      const sqliteMsgs = mrows.map((mr) => {
        const m = { role: mr.role || "system", content: mr.content || "" };
        if (mr.thinking) m.thinking = mr.thinking;
        if (mr.tool_calls) { try { m.toolCalls = JSON.parse(mr.tool_calls); } catch (e) { /* ignore */ } }
        return m;
      });
      const c = p.conversations.find((x) => x.id === cr.id);
      if (c) {
        if (sqliteMsgs.length >= c.messages.length) c.messages = sqliteMsgs;
        else c.messages = sqliteMsgs.concat(c.messages.slice(sqliteMsgs.length));
      } else {
        p.conversations.push({
          id: cr.id,
          name: cr.title || ("Conversation " + (p.conversations.length + 1)),
          messages: sqliteMsgs,
          modelId: null, effort: null, boardId: null,
        });
      }
    }
  } catch (e) { console.warn("hydrateFromSqlite", e); }
}

// ---------- Terminal sessions (SQLite metadata mirror) ----------
// The OS is the real store (terminal.listSessions / attachSession /
// reattachSession / killSession). This table only mirrors the app's own
// metadata (label, agent, worktree branch, merged flag, output tail) so the
// History browser can show richer rows than the OS list alone.

async function sqliteSyncTerminalSessions(snaps) {
  if (!(await sqliteInit())) return;
  try {
    for (const s of (snaps || [])) {
      if (!s || !s.id) continue;
      const live = !(s.status === "exited" || s.status === "ended");
      await sqliteExec(
        "INSERT OR REPLACE INTO terminal_sessions (id, command, cwd, label, agent, worktree_branch, status, exit_code, created_at, last_active, live, merged, output) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [s.id, s.agent || s.label || "", s.cwd || "", s.label || s.id, s.agent || "",
         s.worktreeBranch || null, s.status || "ended",
         s.exitCode == null ? null : s.exitCode,
         s.createdAt || Date.now(), s.endedAt || s.createdAt || Date.now(),
         live ? 1 : 0, s.merged ? 1 : 0, s.output || ""]);
    }
  } catch (e) { console.warn("sqliteSyncTerminalSessions", e); }
}

async function sqliteDeleteTerminalSession(id) {
  if (!(await sqliteInit())) return;
  try {
    await sqliteExec("DELETE FROM terminal_sessions WHERE id = ?", [id]);
  } catch (e) { console.warn("sqliteDeleteTerminalSession", e); }
}

async function sqliteGetTerminalMeta(id) {
  if (!(await sqliteInit())) return null;
  try {
    const rows = await sqliteQuery("SELECT * FROM terminal_sessions WHERE id = ?", [id]);
    return rows.length ? rows[0] : null;
  } catch (e) { return null; }
}

// Decode the base64 output history attachSession() returns.
function decodeBase64(b64) {
  try { return atob(String(b64 || "")); } catch (e) { return ""; }
}

// Merge the OS-persisted terminal sessions into the app at load. Called from
// init() AFTER loadPersistedSessions() so scopedData snapshots (which carry
// the richer label/agent metadata) win for ids they already know.
//   • live:true  -> reattachSession() and register it as a live square again.
//   • live:false -> read-only "ended" card with the saved output tail.
async function loadPlatformSessions() {
  try {
    if (!window.chatoss || !window.chatoss.terminal || typeof window.chatoss.terminal.listSessions !== "function") return;
    const list = await window.chatoss.terminal.listSessions();
    if (!Array.isArray(list)) return;
    for (const s of list) {
      if (!s || !s.id) continue;
      if (TC.sessions.has(s.id)) continue; // already live this run
      const prior = TC.deadSessions.get(s.id);
      if (s.live) {
        // The process survived the window close — reconnect to it.
        try {
          const handle = await window.chatoss.terminal.reattachSession(s.id);
          if (handle) {
            const label = (prior && prior.label) || s.command || "session";
            const cwd = (prior && prior.cwd) || s.cwd || "";
            await TC.registerSession(handle, s.command || "", [], cwd, label, (prior && prior.conversationId) || null);
            // The reattached session is live again — drop the stale dead card.
            if (prior) {
              TC.deadSessions.delete(s.id);
              const card = TC.el.termGrid.querySelector('[data-dead-id="' + CSS.escape(s.id) + '"]');
              if (card) card.remove();
            }
            continue;
          }
        } catch (e) { console.warn("loadPlatformSessions reattach", s.id, e); }
        // Reattach failed (denied or already gone) — leave it to the History
        // browser, which shows it as LIVE (status badge only; the reattach
        // affordance was removed from History to avoid confusion).
        continue;
      }
      if (TC.deadSessions.has(s.id)) continue;
      // Ended session — fetch its persisted output for the read-only card.
      let output = "";
      try {
        const attached = await window.chatoss.terminal.attachSession(s.id);
        if (attached && attached.output) {
          output = TC.stripAnsi(decodeBase64(attached.output));
          if (output.length > 6000) output = "…(earlier output trimmed)…\n" + output.slice(-6000);
        }
      } catch (e) { /* no output available */ }
      TC.deadSessions.set(s.id, {
        id: s.id,
        label: (prior && prior.label) || s.command || s.id,
        cwd: (prior && prior.cwd) || s.cwd || "",
        agent: (prior && prior.agent) || s.command || s.id,
        conversationId: (prior && prior.conversationId) || null,
        worktreeBranch: (prior && prior.worktreeBranch) || TC.worktreeBranchForCwd(s.cwd),
        status: "ended",
        exitCode: null,
        createdAt: s.createdAt || Date.now(),
        endedAt: s.lastActiveAt || Date.now(),
        output,
        merged: !!(prior && prior.merged),
      });
    }
  } catch (e) { console.warn("loadPlatformSessions", e); }
}

// ---------- Worktrees (SQLite mirror) ----------

async function sqliteSyncWorktrees(arr) {
  if (!(await sqliteInit())) return;
  try {
    const seen = new Set();
    for (const m of (arr || [])) {
      if (!m || !m.branch) continue;
      seen.add(m.branch);
      await sqliteExec(
        "INSERT OR REPLACE INTO worktrees (branch, wt_path, parent_branch, project_path, created_at) VALUES (?, ?, ?, ?, ?)",
        [m.branch, m.wtPath || null, m.parentBranch || null, m.projectPath || null, m.createdAt || Date.now()]);
    }
    // Mirror worktreeMeta exactly: merged worktrees are deleted from the map
    // before saveWorktrees() runs, so drop any row that is no longer present.
    const rows = await sqliteQuery("SELECT branch FROM worktrees");
    for (const r of rows) {
      if (!seen.has(r.branch)) await sqliteExec("DELETE FROM worktrees WHERE branch = ?", [r.branch]);
    }
  } catch (e) { console.warn("sqliteSyncWorktrees", e); }
}

async function sqliteHydrateWorktrees() {
  if (!(await sqliteInit())) return;
  try {
    const rows = await sqliteQuery("SELECT * FROM worktrees");
    for (const r of rows) {
      if (!r.branch || TC.worktreeMeta.has(r.branch)) continue;
      TC.worktreeMeta.set(r.branch, { wtPath: r.wt_path, parentBranch: r.parent_branch, projectPath: r.project_path });
    }
  } catch (e) { console.warn("sqliteHydrateWorktrees", e); }
}

// ---------- History browser ----------
// Top-bar "History" button -> modal with two tabs. Conversations come from the
// SQLite mirror; terminals come from the OS-persisted session list merged with
// the app's metadata table and in-memory maps.
// --- exports ---
Object.defineProperty(TC, "SQLITE_DB", { get: () => SQLITE_DB, configurable: true });
Object.defineProperty(TC, "sqliteReady", { get: () => sqliteReady, set: (v) => { sqliteReady = v; }, configurable: true });
Object.defineProperty(TC, "sqliteInitPromise", { get: () => sqliteInitPromise, set: (v) => { sqliteInitPromise = v; }, configurable: true });
Object.defineProperty(TC, "sqliteApiShape", { get: () => sqliteApiShape, set: (v) => { sqliteApiShape = v; }, configurable: true });
Object.defineProperty(TC, "sqliteHandle", { get: () => sqliteHandle, set: (v) => { sqliteHandle = v; }, configurable: true });
Object.defineProperty(TC, "sqliteName", { get: () => sqliteName, set: (v) => { sqliteName = v; }, configurable: true });
Object.defineProperty(TC, "_sqliteSyncTimer", { get: () => _sqliteSyncTimer, set: (v) => { _sqliteSyncTimer = v; }, configurable: true });
TC.sqliteInterpolate = sqliteInterpolate;
TC.sqliteLiteral = sqliteLiteral;
TC._sqliteExecRaw = _sqliteExecRaw;
TC._sqliteQueryRaw = _sqliteQueryRaw;
TC.sqliteExec = sqliteExec;
TC.sqliteQuery = sqliteQuery;
TC.sqliteInit = sqliteInit;
TC.cancelPendingSqliteSync = cancelPendingSqliteSync;
TC.scheduleSqliteSync = scheduleSqliteSync;
TC.syncConversationsToSqlite = syncConversationsToSqlite;
TC.sqlitePersistToolCall = sqlitePersistToolCall;
TC.sqliteDeleteConversation = sqliteDeleteConversation;
TC.sqliteDeleteProject = sqliteDeleteProject;
TC.hydrateFromSqlite = hydrateFromSqlite;
TC.sqliteSyncTerminalSessions = sqliteSyncTerminalSessions;
TC.sqliteDeleteTerminalSession = sqliteDeleteTerminalSession;
TC.sqliteGetTerminalMeta = sqliteGetTerminalMeta;
TC.decodeBase64 = decodeBase64;
TC.loadPlatformSessions = loadPlatformSessions;
TC.sqliteSyncWorktrees = sqliteSyncWorktrees;
TC.sqliteHydrateWorktrees = sqliteHydrateWorktrees;
})();
