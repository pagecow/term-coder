// 01-sessions.js — classic script (converted from an ES module; see REFACTOR_PLAN.md).
// Exports are registered on the shared window.termCoder namespace (TC).
(function () {
"use strict";
const TC = window.termCoder = window.termCoder || {};
function detectAgentError(text) {
  for (const re of TC.AGENT_ERROR_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    // Return the whole line for context — the orchestrator needs to know WHAT
    // failed to write a useful correction.
    const line = (text.slice(0, m.index).split("\n").pop() || "") +
      text.slice(m.index).split("\n")[0];
    return line.trim().slice(0, 240);
  }
  return "";
}

// Classify what a session is doing right now, without touching the PTY.
// Returns: "EXITED" | "ERROR LOOP" | "NEEDS INPUT" | "WORKING" | "IDLE" | "STARTING".
function sessionActivity(s) {
  if (!s) return "EXITED";
  if (s.active === false) return "EXITED";
  // Ranked above NEEDS INPUT: an agent stuck retrying a failing call needs
  // intervention more urgently than one politely waiting, and it will never
  // reach idle on its own.
  if (s.errorLoop) return "ERROR LOOP";
  if (s.waitingForInput) return "NEEDS INPUT";
  const quietFor = Date.now() - (s.lastOutputAt || 0);
  if (!s.taskSubmittedAt) return quietFor >= TC.TURN_IDLE_MS ? "IDLE" : "STARTING";
  if (s.bytesSinceTask < TC.MIN_WORK_BYTES) return "STARTING";
  if (quietFor < TC.TURN_IDLE_MS) return "WORKING";
  // IDLE = quiet at a prompt. Two independent signals, either one suffices:
  //   1. tailAtPrompt — the text heuristic (prompt glyph / idle chrome in the
  //      output tail). This is what opencode/codex sessions kept failing: their
  //      prompt chrome never matched the glyph patterns, so IDLE was unreachable
  //      and the status stayed WORKING forever.
  //   2. ptyIdle — the PLATFORM's own PTY state (session.isWaitingForInput() /
  //      onStateChange, tcgetpgrp-based on macOS): the foreground process is the
  //      shell/CLI blocked on a tty read, i.e. sitting at its input prompt. This
  //      is authoritative and CLI-agnostic — it does not depend on matching any
  //      TUI's prompt glyphs. 'unsupported' (Windows) leaves ptyIdle false and
  //      the text heuristic carries the load.
  // While the folder-trust dialog is up the CLI is also blocked on input, so
  // ptyIdle alone must not read as "turn complete" — the trust flow owns the
  // keyboard until the user answers.
  const trustBlocked = s.trustState === "pending" || s.trustState === "asking";
  return (s.tailAtPrompt || (s.ptyIdle && !trustBlocked)) ? "IDLE" : "WORKING";
}

// Build the structured status + output block shared by read_session and
// wait_for_session. Returns a header line (status / exit code / working dir)
// followed by the clean terminal screen text. Preserves the trust-dialog
// masking so the orchestrator never sees raw "Do you trust..." text it would
// try to keystroke past.
async function formatSessionStatusOutput(s, statusOverride, opts) {
  const o = opts || {};
  // Default to the TAIL of the screen. Returning the whole ~64KB scrollback on
  // every read was slow and burned a large chunk of the turn's context for
  // output the orchestrator had already seen.
  const maxChars = o.full ? Infinity : (o.maxChars || 4000);
  try {
    let clean = "(terminal is empty — no output yet)";
    if (s.session && typeof s.session.getOutput === "function") {
      const text = await s.session.getOutput();
      clean = text ? TC.stripAnsi(text) : "(terminal is empty — no output yet)";
      if (clean.length > maxChars) {
        clean = "…(earlier output trimmed — pass full:true to read_session for everything)…\n" + clean.slice(-maxChars);
      }
      // MASK the trust dialog from the orchestrator when user must approve it
      // in chat. If the orchestrator sees the raw "Do you trust..." text, it
      // will try to send keystrokes to bypass the pill picker. Hide it and
      // tell the orchestrator to wait for the user's answer.
      if ((s.trustState === "pending" || s.trustState === "asking") && s.trustMode !== "always" &&
          /trust\s*the\s*(files|contents|folder|directory)|trust\s*this\s*folder|do\s*you\s*trust|press\s*enter\s*to\s*continue/i.test(clean)) {
        return "Waiting for user approval: a 'trust this folder?' prompt is shown in chat. Do NOT send keystrokes to confirm it. The session will proceed once the user clicks Yes, or be killed if they click No.";
      }
    }
    let statusLine;
    if (statusOverride) {
      // Caller-supplied status line (e.g. wait_for_session's "STILL WORKING
      // (timed out …)" message). Reuses the same output-fetch + trust-dialog
      // masking below so every session read masks the trust dialog uniformly.
      statusLine = statusOverride;
    } else if (s.active === false && s.exitCode !== undefined && s.exitCode !== null) {
      statusLine = "[SESSION: " + (s.label || s.id) + " | STATUS: EXITED | EXIT CODE: " + s.exitCode + "]";
    } else if (s.active === false) {
      // Exited but no exit code recorded (e.g. killed) — report "killed".
      statusLine = "[SESSION: " + (s.label || s.id) + " | STATUS: EXITED | EXIT CODE: killed]";
    } else {
      // Report the ACTIVITY, not just "RUNNING". A coding CLI is always
      // "running" — that told the orchestrator nothing about whether the agent
      // was still working or had finished its turn minutes ago.
      const act = sessionActivity(s);
      const quiet = Math.round((Date.now() - (s.lastOutputAt || Date.now())) / 1000);
      statusLine = "[SESSION: " + (s.label || s.id) + " | STATUS: " + act +
        (act === "IDLE" ? " — turn complete, idle " + quiet + "s at its prompt (the CLI stays running; that is normal)" : "") +
        (act === "WORKING" ? " — actively producing output" : "") +
        (act === "STARTING" ? " — launched, task not yet under way" : "") + "]";
      if (act === "ERROR LOOP") {
        statusLine += "\n[ERROR (seen " + (s.errorCount || 0) + "x): " + (s.lastErrorText || "(see output)") + "]" +
          "\n[Correct the RUNNING agent with send_to_session — do not replace it.]";
      }
      if (s.degenerate) {
        const di = s.degenerateInfo || {};
        statusLine += "\n[DEGENERATE OUTPUT: the terminal collapsed into a repeated-token/gibberish loop (" +
          (di.pattern || "unknown pattern") + ", " + (di.count || "?") + "x). The app interrupted it with ctrl+c. " +
          "It is NOT making progress — close_session and respawn a fresh agent in the same worktree (its uncommitted work is auto-committed on close).]";
      }
    }
    const dirLine = "[WORKING DIR: " + (s.cwd || "(unknown)") + "]";
    // Surface a blocked-on-prompt signal so the orchestrator knows the coding
    // agent is waiting. If the agent asked a question via the ORCHESTRATOR_INPUT_NEEDED
    // sentinel, include the question text so the orchestrator can answer it.
    let needsInputLine = "";
    if (s.active !== false && s.waitingForInput) {
      if (s.pendingQuestion && !/^\(agent appears idle/.test(s.pendingQuestion)) {
        needsInputLine = "\n[NEEDS INPUT: the agent asked a question. The app auto-handles permission prompts; this is a genuine question for YOU.]\n[QUESTION: " + s.pendingQuestion + "]\n[To answer: call send_to_session({ sessionId: \"" + (s.id || "") + "\", text: \"<your answer>\", key: \"enter\" }). After you respond, the agent will continue.]";
      } else if (s.pendingQuestion && /^\(agent appears idle/.test(s.pendingQuestion)) {
        needsInputLine = "\n[NEEDS INPUT: " + s.pendingQuestion + "]";
      } else {
        needsInputLine = "\n[NEEDS INPUT: yes — the coding agent is asking the user a permission question. The app auto-approves safe edits/commands; a destructive one shows the user an approve/deny picker in chat. Do NOT send keystrokes to it — just keep monitoring.]";
      }
    }
    return statusLine + "\n" + dirLine + needsInputLine + "\n" + "------------------------------------------------------------\n" + clean;
  } catch (e) {
    return "Error: " + (e && e.message ? e.message : String(e));
  }
}

// Worktree metadata: branchName -> { wtPath, parentBranch, projectPath }.
// Tracks every worktree created by create_worktree so merge_worktree can find
// the parent branch to merge back into without the model having to remember it.
//
// PERSISTED to scopedData: the orchestrator's tool-call history is NOT replayed
// into the next turn's messages, and the runtime caps tool rounds per turn — so a
// create-worktrees turn and the merge turn are almost always DIFFERENT turns (and
// may straddle an app restart). Keeping this in memory only made every worktree
// unmergeable the moment the turn ended. buildSystemPrompt surfaces the live
// contents to the model, and list_worktrees lets it enumerate them explicitly.
const worktreeMeta = new Map();
function saveWorktrees() {
  try {
    const arr = [...worktreeMeta.entries()].map(([branch, m]) => Object.assign({ branch }, m));
    window.chatoss.scopedData.set(TC.WORKTREES_KEY, arr).catch((e) => console.warn("saveWorktrees", e));
    // Mirror into SQLite so worktrees survive even if scopedData is lost.
    TC.sqliteSyncWorktrees(arr);
  } catch (e) { console.warn("saveWorktrees", e); }
}
async function loadWorktrees() {
  try {
    const arr = await window.chatoss.scopedData.get(TC.WORKTREES_KEY);
    if (Array.isArray(arr)) {
      for (const m of arr) {
        if (m && m.branch) {
          worktreeMeta.set(m.branch, { wtPath: m.wtPath, parentBranch: m.parentBranch, projectPath: m.projectPath });
        }
      }
    }
  } catch (e) { console.warn("loadWorktrees", e); }
  // Merge in any worktrees recorded in SQLite but missing from scopedData.
  await TC.sqliteHydrateWorktrees();
}

// Derive the worktree branch a session's cwd belongs to. Worktrees created by
// create_worktree live at "<project>/.chatoss/worktrees/<branch>", so the last
// path segment is the branch. We also cross-check against worktreeMeta (which
// records the wtPath per branch) so a branch recorded at creation wins over a
// guess. Returns null for a cwd that isn't one of our worktrees.
function worktreeBranchForCwd(cwd) {
  const c = String(cwd || "").replace(/\/+$/, "");
  if (!c) return null;
  // Exact match against a known worktree path — authoritative.
  for (const [branch, m] of worktreeMeta.entries()) {
    if (m.wtPath && m.wtPath.replace(/\/+$/, "") === c) return branch;
  }
  // Fall back to the path-shape heuristic: <base>/.chatoss/worktrees/<branch>.
  const idx = c.indexOf("/.chatoss/worktrees/");
  if (idx >= 0) {
    const seg = c.slice(idx + "/.chatoss/worktrees/".length);
    if (seg && !seg.includes("/")) return seg;
  }
  return null;
}

// ---------- Persisted terminal sessions ----------
// A "snapshot" is the minimal per-session record we persist to scopedData so the
// Sessions column can show prior terminals (their state + last output) after the
// app is closed and reopened, even though the live PTY is gone. These are read-
// only; we never pretend to reattach to a dead process.
//
// The persisted array is the union of:
//   • live sessions (sessions Map) — written as snapshots so they survive a reopen
//   • dead sessions (deadSessions Map) — already-ended ones carried over
// This way closing/reopening never loses a session, and deleting one (closeSession
// or the merged-worktree cleanup) removes it from BOTH the in-memory maps and the
// persisted array via persistSessions().

// Build a plain snapshot of one live session record for persistence. Captures the
// clean tail of its current output so reopening shows what happened.
async function snapshotLiveSession(rec) {
  let output = "";
  try {
    if (rec.session && typeof rec.session.getOutput === "function") {
      const raw = await rec.session.getOutput();
      output = raw ? TC.stripAnsi(raw) : "";
    }
  } catch (e) { /* a dead session just gets no output */ }
  // Keep the tail manageable — a full ~64KB scrollback per session would bloat
  // the persisted blob fast. The last ~6000 chars is plenty to recall what happened.
  if (output.length > 6000) output = "…(earlier output trimmed)…\n" + output.slice(-6000);
  const act = sessionActivity(rec);
  let status;
  if (rec.active === false) status = "exited";
  else if (act === "ERROR LOOP") status = "error";
  else if (act === "NEEDS INPUT") status = "needs-input";
  else if (act === "IDLE") status = "idle";
  else if (act === "WORKING") status = "working";
  else status = "starting";
  return {
    id: rec.id,
    label: rec.label || rec.id,
    cwd: rec.cwd || "",
    agent: rec.agent || rec.label || rec.id,
    conversationId: rec.conversationId || null,
    worktreeBranch: rec.worktreeBranch || null,
    status,
    exitCode: (rec.active === false) ? rec.exitCode : null,
    createdAt: rec.createdAt || Date.now(),
    endedAt: rec.endedAt || null,
    output,
    merged: !!rec.merged,
  };
}

// Persist the union of live + dead sessions to scopedData. Fire-and-forget but
// never leaves an unhandled rejection. Called debounced during a live run and
// eagerly on exit/close/delete.
let _persistSessionsTimer = null;
// Other modules (the init flush handler) must cancel a pending debounce
// without touching the timer binding itself — it is exported read-only.
function cancelPendingPersistSessions() {
  if (_persistSessionsTimer) { clearTimeout(_persistSessionsTimer); _persistSessionsTimer = null; }
}
function schedulePersistSessions() {
  if (_persistSessionsTimer) return;
  _persistSessionsTimer = setTimeout(() => {
    _persistSessionsTimer = null;
    persistSessions().catch((e) => console.warn("schedulePersistSessions", e));
  }, 1500);
}
async function persistSessions() {
  try {
    // Live sessions need an async output read; dead sessions are already plain.
    const liveSnaps = [];
    for (const rec of TC.sessions.values()) {
      try { liveSnaps.push(await snapshotLiveSession(rec)); } catch (e) { /* skip */ }
    }
    const deadSnaps = [...TC.deadSessions.values()];
    // Live ones first (most recent activity on top), then dead ones, newest first.
    const all = liveSnaps.concat(deadSnaps);
    // Mirror into the SQLite metadata table (History browser) alongside the
    // scopedData blob. The OS terminal store is the real durable record.
    TC.sqliteSyncTerminalSessions(all);
    await window.chatoss.scopedData.set(TC.SESSIONS_KEY, all);
  } catch (e) { console.warn("persistSessions", e); }
}

// Load persisted snapshots from scopedData into the deadSessions map as read-only
// ended cards. Called once at init, BEFORE the UI renders, so the Sessions column
// shows prior terminals immediately. A snapshot whose status was "working" at the
// last save is shown as "ended" (the PTY is necessarily gone across a reopen).
async function loadPersistedSessions() {
  try {
    const arr = await window.chatoss.scopedData.get(TC.SESSIONS_KEY);
    if (!Array.isArray(arr)) return;
    for (const s of arr) {
      if (!s || !s.id) continue;
      // If a live session with the same id somehow already exists this run, don't
      // shadow it with a dead card.
      if (TC.sessions.has(s.id)) continue;
      // Anything persisted across a reopen is, by definition, no longer live.
      const snap = {
        id: s.id,
        label: s.label || s.id,
        cwd: s.cwd || "",
        agent: s.agent || s.label || s.id,
        conversationId: s.conversationId || null,
        worktreeBranch: s.worktreeBranch || null,
        // "working"/"starting"/"needs-input" all become "ended" after a reopen.
        status: (s.status === "exited") ? "exited" : "ended",
        exitCode: (s.status === "exited") ? s.exitCode : null,
        createdAt: s.createdAt || Date.now(),
        endedAt: s.endedAt || Date.now(),
        output: s.output || "",
        merged: !!s.merged,
      };
      TC.deadSessions.set(snap.id, snap);
    }
  } catch (e) { console.warn("loadPersistedSessions", e); }
}

// Render the read-only "ended" card for a dead/persisted session into the grid.
// Shows the agent, working dir, an ended indicator, and the captured output tail.
// NOT live — there is no xterm mount, no input. Has only a Dismiss (✕) button.
function renderDeadSessionCard(snap) {
  const square = document.createElement("div");
  square.className = "term-square term-square-ended";
  square.dataset.deadId = snap.id;

  const header = document.createElement("div");
  header.className = "term-square-header";
  const dot = document.createElement("span");
  dot.className = "term-status-dot exited";
  dot.title = "Session ended — output preserved";
  const lab = document.createElement("span");
  lab.className = "term-label";
  // Label reflects the ended state clearly.
  lab.textContent = snap.label + (snap.status === "exited" ? " (exited)" : " (ended)");
  const cwdEl = document.createElement("span");
  cwdEl.className = "term-cwd";
  cwdEl.textContent = TC.basename(snap.cwd);
  cwdEl.title = snap.cwd;
  const dismissBtn = document.createElement("button");
  dismissBtn.className = "term-head-btn term-close-btn";
  dismissBtn.type = "button";
  dismissBtn.textContent = "✕";
  dismissBtn.title = "Dismiss this ended session";
  header.appendChild(dot);
  header.appendChild(lab);
  header.appendChild(cwdEl);
  header.appendChild(dismissBtn);

  const body = document.createElement("div");
  body.className = "term-ended-body";

  // A short status line describing how it ended.
  const statusLine = document.createElement("div");
  statusLine.className = "term-ended-status";
  let statusText = "Session ended — output preserved (the live terminal is gone).";
  if (snap.merged) statusText = "Session ended — worktree merged. Output preserved.";
  else if (snap.status === "exited") statusText = "Agent exited (code " + (snap.exitCode == null ? "killed" : snap.exitCode) + "). Output preserved.";
  else if (snap.worktreeBranch) statusText = "Session ended (app was closed). Output preserved. Worktree branch: " + snap.worktreeBranch;
  statusLine.textContent = statusText;
  body.appendChild(statusLine);

  // The captured output tail, shown in a scrollable monospace block.
  const out = document.createElement("pre");
  out.className = "term-ended-output";
  out.textContent = (snap.output && snap.output.trim()) ? snap.output : "(no output was captured)";
  body.appendChild(out);

  square.appendChild(header);
  square.appendChild(body);

  // Resize handles (same as live squares) so ended cards resize in columns/rows
  // views too. The drag logic is delegated on the grid in initTermResize().
  const resizeX = document.createElement("div");
  resizeX.className = "term-resize-handle term-resize-handle-x";
  resizeX.setAttribute("role", "separator");
  resizeX.setAttribute("aria-orientation", "vertical");
  resizeX.setAttribute("aria-label", "Resize terminal width");
  const resizeY = document.createElement("div");
  resizeY.className = "term-resize-handle term-resize-handle-y";
  resizeY.setAttribute("role", "separator");
  resizeY.setAttribute("aria-orientation", "horizontal");
  resizeY.setAttribute("aria-label", "Resize terminal height");
  square.appendChild(resizeX);
  square.appendChild(resizeY);

  // insert before the empty-state card so the grid stays clean
  if (TC.el.termEmpty && TC.el.termEmpty.parentNode === TC.el.termGrid) TC.el.termGrid.insertBefore(square, TC.el.termEmpty);
  else TC.el.termGrid.appendChild(square);

  // clicking selects it (highlights); dismiss removes it
  square.addEventListener("click", (e) => {
    if (e.target === dismissBtn) return;
    TC.selectSession(snap.id);
  });
  dismissBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    dismissDeadSession(snap.id);
  });

  return square;
}

// Remove a dead/persisted session from the UI + memory + scopedData.
async function dismissDeadSession(id) {
  const snap = TC.deadSessions.get(id);
  if (!snap) return;
  TC.deadSessions.delete(id);
  // Remove the card from the DOM.
  const card = TC.el.termGrid.querySelector('[data-dead-id="' + CSS.escape(id) + '"]');
  if (card) card.remove();
  if (TC.state.activeSessionId === id) {
    TC.state.activeSessionId = TC.sessions.size ? TC.sessions.keys().next().value : null;
  }
  TC.saveState();
  TC.ensureEmptyHint();
  TC.renderTabs();
  TC.renderSessionInfo();
  // Also delete the OS-persisted record + SQLite metadata row.
  try { await window.chatoss.terminal.killSession(id); } catch (e) { /* non-fatal */ }
  await TC.sqliteDeleteTerminalSession(id);
  await persistSessions();
}

// ============================================================
// === SQLite persistence layer ===
// ============================================================
// Conversation + terminal history used to live ONLY in scopedData, which was
// lost when an orchestration session finished — the user had no way to check
// on past work. This layer makes history durable the new way:
//
//   • Conversations, messages and tool calls are mirrored into the app's
//     PRIVATE SQLite database (capability "sqlite" — no prompt, persists
//     across restarts). saveState() schedules a debounced full sync, and
//     hydrateFromSqlite() restores them at load, so history survives even if
//     the scopedData blob is lost or reset.
//   • Terminal sessions are persisted BY THE OS now (they survive window close
//     and a full app restart). loadPlatformSessions() merges
//     terminal.listSessions() into the Sessions column — reattaching still-live
//     processes with reattachSession() and showing ended ones as read-only
//     cards whose output comes from attachSession(). killSession() is the
//     cleanup path.
//   • The History browser (top-bar "History" button) lets the user reopen a
//     past conversation or review/reconnect/delete a past terminal session.
//
// NOTE: this section is deliberately self-contained. Other code only calls
// into it through the small hooks listed at the bottom of this comment block:
//   saveState()            -> scheduleSqliteSync()
//   persistSessions()      -> sqliteSyncTerminalSessions(all)
//   saveWorktrees()        -> sqliteSyncWorktrees(arr)
//   loadWorktrees()        -> sqliteHydrateWorktrees()
//   dismissDeadSession()   -> sqliteDeleteTerminalSession(id) + killSession
//   closeSession()         -> sqliteDeleteTerminalSession(id) + killSession
//   deleteConversation()   -> sqliteDeleteConversation(c.id)
//   deleteProject()        -> sqliteDeleteProject(p.id)
//   sendMessage.onToolCall -> sqlitePersistToolCall(c.id, entry)
//   init()                 -> hydrateFromSqlite(), loadPlatformSessions(),
//                             initHistoryBrowser()
// --- exports ---
Object.defineProperty(TC, "worktreeMeta", { get: () => worktreeMeta, configurable: true });
Object.defineProperty(TC, "_persistSessionsTimer", { get: () => _persistSessionsTimer, set: (v) => { _persistSessionsTimer = v; }, configurable: true });
TC.detectAgentError = detectAgentError;
TC.sessionActivity = sessionActivity;
TC.formatSessionStatusOutput = formatSessionStatusOutput;
TC.saveWorktrees = saveWorktrees;
TC.loadWorktrees = loadWorktrees;
TC.worktreeBranchForCwd = worktreeBranchForCwd;
TC.snapshotLiveSession = snapshotLiveSession;
TC.cancelPendingPersistSessions = cancelPendingPersistSessions;
TC.schedulePersistSessions = schedulePersistSessions;
TC.persistSessions = persistSessions;
TC.loadPersistedSessions = loadPersistedSessions;
TC.renderDeadSessionCard = renderDeadSessionCard;
TC.dismissDeadSession = dismissDeadSession;
})();
