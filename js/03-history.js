// 03-history.js — classic script (converted from an ES module; see REFACTOR_PLAN.md).
// Exports are registered on the shared window.termCoder namespace (TC).
(function () {
"use strict";
const TC = window.termCoder = window.termCoder || {};
let historyTab = "conversations";

function fmtTime(ts) {
  if (!ts) return "unknown time";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "unknown time";
  const diff = Date.now() - ts;
  if (diff < 60 * 1000) return "just now";
  if (diff < 3600 * 1000) return Math.floor(diff / 60000) + "m ago";
  if (diff < 24 * 3600 * 1000) return Math.floor(diff / 3600000) + "h ago";
  return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function openHistoryBrowser() {
  if (!TC.el.historyModal) return;
  TC.el.historyModal.classList.remove("hidden");
  renderHistoryBrowser();
}
function closeHistoryBrowser() {
  if (TC.el.historyModal) TC.el.historyModal.classList.add("hidden");
}

async function renderHistoryBrowser() {
  const list = TC.el.historyList;
  if (!list || !TC.el.historyTabs) return;
  list.innerHTML = "";
  for (const btn of TC.el.historyTabs.querySelectorAll(".history-tab")) {
    const active = btn.dataset.tab === historyTab;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", String(active));
  }
  if (historyTab === "conversations") await renderHistoryConversations(list);
  else await renderHistoryTerminals(list);
}

async function renderHistoryConversations(list) {
  if (!(await TC.sqliteInit())) {
    list.innerHTML = '<div class="history-empty">SQLite storage is unavailable — history cannot be shown.</div>';
    return;
  }
  let rows = [];
  try {
    rows = await TC.sqliteQuery(
      "SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS msg_count FROM conversations c ORDER BY c.created_at DESC");
  } catch (e) { console.warn("renderHistoryConversations", e); }
  if (!rows.length) {
    list.innerHTML = '<div class="history-empty">No past conversations yet. Chat with the orchestrator and it will be saved here.</div>';
    return;
  }
  for (const r of rows) {
    const p = TC.state.projects.find((x) => x.id === r.project_id);
    const item = document.createElement("div");
    item.className = "history-item";
    const info = document.createElement("div");
    info.className = "history-item-info";
    const title = document.createElement("div");
    title.className = "history-item-title";
    title.textContent = r.title || r.id;
    title.title = r.title || r.id;
    const meta = document.createElement("div");
    meta.className = "history-item-meta";
    meta.textContent = (p ? p.name : "(project removed)") + " · " + (r.msg_count || 0) + " messages · " + fmtTime(r.created_at);
    info.appendChild(title);
    info.appendChild(meta);
    const acts = document.createElement("div");
    acts.className = "history-item-actions";
    const openBtn = document.createElement("button");
    openBtn.className = "btn btn-primary btn-small";
    openBtn.type = "button";
    openBtn.textContent = "Open";
    openBtn.disabled = !p;
    openBtn.title = p ? "Reopen this conversation in the chat" : "The project for this conversation no longer exists";
    openBtn.onclick = () => historyReopenConversation(r.id);
    const delBtn = document.createElement("button");
    delBtn.className = "btn btn-ghost btn-small";
    delBtn.type = "button";
    delBtn.textContent = "Delete";
    delBtn.title = "Delete this conversation and its messages";
    delBtn.onclick = () => historyDeleteConversation(r.id);
    acts.appendChild(openBtn);
    acts.appendChild(delBtn);
    item.appendChild(info);
    item.appendChild(acts);
    list.appendChild(item);
  }
}

function historyReopenConversation(cid) {
  for (const p of TC.state.projects) {
    const c = p.conversations.find((x) => x.id === cid);
    if (c) {
      TC.state.activeProjectId = p.id;
      TC.state.activeConversationId = c.id;
      TC.collapsedProjects.delete(p.id);
      TC.saveState();
      closeHistoryBrowser();
      TC.renderProjects();
      TC.renderChat();
      TC.renderSessionInfo();
      return;
    }
  }
  TC.setStatus("That conversation's project no longer exists.");
}

async function historyDeleteConversation(cid) {
  for (const p of TC.state.projects) {
    const c = p.conversations.find((x) => x.id === cid);
    if (c) { TC.deleteConversation(p, c); break; }
  }
  await TC.sqliteDeleteConversation(cid);
  renderHistoryBrowser();
}

async function renderHistoryTerminals(list) {
  let osSessions = [];
  try {
    if (window.chatoss && window.chatoss.terminal && typeof window.chatoss.terminal.listSessions === "function") {
      const l = await window.chatoss.terminal.listSessions();
      if (Array.isArray(l)) osSessions = l;
    }
  } catch (e) { console.warn("renderHistoryTerminals listSessions", e); }
  const meta = new Map();
  if (await TC.sqliteInit()) {
    try {
      const rows = await TC.sqliteQuery("SELECT * FROM terminal_sessions ORDER BY last_active DESC");
      for (const r of rows) meta.set(r.id, r);
    } catch (e) { /* ignore */ }
  }
  const entries = [];
  const seen = new Set();
  for (const s of osSessions) {
    if (!s || !s.id) continue;
    seen.add(s.id);
    const m = meta.get(s.id) || {};
    entries.push({
      id: s.id,
      command: s.command || m.command || "",
      cwd: s.cwd || m.cwd || "",
      label: m.label || s.command || s.id,
      agent: m.agent || s.command || "",
      worktreeBranch: m.worktree_branch || null,
      merged: !!m.merged,
      createdAt: s.createdAt || m.created_at || Date.now(),
      lastActiveAt: s.lastActiveAt || m.last_active || Date.now(),
      live: !!s.live,
    });
  }
  // In-memory live sessions not (yet) in the OS list.
  for (const rec of TC.sessions.values()) {
    if (seen.has(rec.id)) continue;
    seen.add(rec.id);
    entries.push({
      id: rec.id, command: rec.cmd || "", cwd: rec.cwd || "",
      label: rec.label || rec.id, agent: rec.agent || "",
      worktreeBranch: rec.worktreeBranch || null, merged: !!rec.merged,
      createdAt: rec.createdAt || Date.now(), lastActiveAt: Date.now(), live: true,
    });
  }
  // Dead cards from this run.
  for (const snap of TC.deadSessions.values()) {
    if (seen.has(snap.id)) continue;
    seen.add(snap.id);
    entries.push({
      id: snap.id, command: snap.agent || "", cwd: snap.cwd || "",
      label: snap.label || snap.id, agent: snap.agent || "",
      worktreeBranch: snap.worktreeBranch || null, merged: !!snap.merged,
      createdAt: snap.createdAt || Date.now(), lastActiveAt: snap.endedAt || Date.now(), live: false,
    });
  }
  entries.sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0));
  if (!entries.length) {
    list.innerHTML = '<div class="history-empty">No terminal sessions yet. Start a session and its history will be kept here.</div>';
    return;
  }
  for (const e of entries) {
    const item = document.createElement("div");
    item.className = "history-item";
    const info = document.createElement("div");
    info.className = "history-item-info";
    const title = document.createElement("div");
    title.className = "history-item-title";
    title.textContent = e.label;
    title.title = e.label;
    const meta = document.createElement("div");
    meta.className = "history-item-meta";
    meta.textContent = (e.command ? e.command + " · " : "") +
      (e.cwd ? TC.basename(e.cwd) : "(no cwd)") + " · " + fmtTime(e.createdAt) +
      (e.worktreeBranch ? " · branch " + e.worktreeBranch : "") +
      (e.merged ? " · merged" : "");
    info.appendChild(title);
    info.appendChild(meta);
    const acts = document.createElement("div");
    acts.className = "history-item-actions";
    if (e.live) {
      const liveBadge = document.createElement("span");
      liveBadge.className = "history-badge history-badge-live";
      liveBadge.textContent = "LIVE";
      acts.appendChild(liveBadge);
    } else {
      const endedBadge = document.createElement("span");
      endedBadge.className = "history-badge";
      endedBadge.textContent = "ended";
      acts.appendChild(endedBadge);
    }
    const viewBtn = document.createElement("button");
    viewBtn.className = "btn btn-ghost btn-small";
    viewBtn.type = "button";
    viewBtn.textContent = "Output";
    viewBtn.title = "Show the saved terminal output";
    viewBtn.onclick = () => historyViewTerminal(e.id, item);
    acts.appendChild(viewBtn);
    const killBtn = document.createElement("button");
    killBtn.className = "btn btn-ghost btn-small";
    killBtn.type = "button";
    killBtn.textContent = "Delete";
    killBtn.title = "Kill the process (if live) and delete the saved record";
    killBtn.onclick = () => historyKillTerminal(e.id);
    acts.appendChild(killBtn);
    item.appendChild(info);
    item.appendChild(acts);
    list.appendChild(item);
  }
}

async function historyViewTerminal(id, item) {
  const existing = item.querySelector(".history-output");
  if (existing) { existing.remove(); return; }
  const out = document.createElement("pre");
  out.className = "history-output";
  out.textContent = "Loading saved output…";
  item.appendChild(out);

  // 1) Try the OS-persisted session first (the live output history). The OS
  //    store is the authoritative record while the session still exists.
  let osOutput = null, osGone = false;
  try {
    const attached = await window.chatoss.terminal.attachSession(id);
    if (attached && attached.output) {
      osOutput = TC.stripAnsi(TC.decodeBase64(attached.output));
    }
  } catch (e) {
    // "no such terminal session: <id>" — the live session was killed/expired/
    // deleted and the OS no longer has it. Fall through to the saved history.
    osGone = true;
  }

  if (osOutput) {
    out.textContent = osOutput || "(no output)";
    return;
  }

  // 2) The OS session is gone (or had no output). Fall back to the output tail
  //    saved in the SQLite history table, plus the in-memory dead card if this
  //    session is from the current run. Show a clear message instead of a raw
  //    "no such terminal session" error.
  let saved = "";
  const dead = TC.deadSessions.get(id);
  if (dead && dead.output) saved = dead.output;
  if (!saved) {
    const meta = await TC.sqliteGetTerminalMeta(id);
    if (meta && meta.output) saved = meta.output;
  }

  const banner = osGone
    ? "This session is no longer live — showing saved output from history."
    : "No live output for this session — showing saved output from history.";
  if (saved) {
    out.textContent = banner + "\n\n" + saved;
  } else {
    out.textContent = "This session is no longer live, and no saved output was found in history.";
  }
}

async function historyKillTerminal(id) {
  try {
    if (window.chatoss && window.chatoss.terminal && typeof window.chatoss.terminal.killSession === "function") {
      await window.chatoss.terminal.killSession(id);
    }
  } catch (e) { console.warn("historyKillTerminal killSession", id, e); }
  if (TC.sessions.has(id)) { await TC.closeSession(id); }
  if (TC.deadSessions.has(id)) {
    TC.deadSessions.delete(id);
    const card = TC.el.termGrid.querySelector('[data-dead-id="' + CSS.escape(id) + '"]');
    if (card) card.remove();
    if (TC.state.activeSessionId === id) TC.state.activeSessionId = TC.sessions.size ? TC.sessions.keys().next().value : null;
    TC.saveState();
    TC.ensureEmptyHint();
    TC.renderTabs();
    TC.renderSessionInfo();
  }
  await TC.sqliteDeleteTerminalSession(id);
  TC.persistSessions().catch(() => { /* non-fatal */ });
  renderHistoryBrowser();
}

// Wire the top-bar button, tabs, refresh and close controls. Called once from
// init(); the modal itself is also added to the shared backdrop/Esc handling.
function initHistoryBrowser() {
  if (!TC.el.historyBtn || !TC.el.historyModal) return;
  TC.el.historyBtn.addEventListener("click", openHistoryBrowser);
  if (TC.el.historyCloseX) TC.el.historyCloseX.addEventListener("click", closeHistoryBrowser);
  if (TC.el.historyRefresh) TC.el.historyRefresh.addEventListener("click", () => renderHistoryBrowser());
  if (TC.el.historyTabs) {
    TC.el.historyTabs.addEventListener("click", (e) => {
      const btn = e.target.closest && e.target.closest(".history-tab");
      if (!btn) return;
      historyTab = btn.dataset.tab || "conversations";
      renderHistoryBrowser();
    });
  }
}

// Promise + resolver for the spawn modal wait (set while the modal is open).
// The orchestrator's start_cli_session tool awaits this; manual start too.
// --- exports ---
Object.defineProperty(TC, "historyTab", { get: () => historyTab, set: (v) => { historyTab = v; }, configurable: true });
TC.fmtTime = fmtTime;
TC.openHistoryBrowser = openHistoryBrowser;
TC.closeHistoryBrowser = closeHistoryBrowser;
TC.renderHistoryBrowser = renderHistoryBrowser;
TC.renderHistoryConversations = renderHistoryConversations;
TC.historyReopenConversation = historyReopenConversation;
TC.historyDeleteConversation = historyDeleteConversation;
TC.renderHistoryTerminals = renderHistoryTerminals;
TC.historyViewTerminal = historyViewTerminal;
TC.historyKillTerminal = historyKillTerminal;
TC.initHistoryBrowser = initHistoryBrowser;
})();
