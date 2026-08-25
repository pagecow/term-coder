// 20-terminal.js — classic script (converted from an ES module; see REFACTOR_PLAN.md).
// Exports are registered on the shared window.termCoder namespace (TC).
(function () {
"use strict";
const TC = window.termCoder = window.termCoder || {};
function refreshSessionVisibility() {
  const cid = TC.state.activeConversationId;
  let visible = 0;
  for (const rec of TC.sessions.values()) {
    const show = (rec.conversationId || null) === cid;
    if (rec.squareEl) rec.squareEl.style.display = show ? "" : "none";
    if (show) visible++;
  }
  for (const card of TC.el.termGrid.querySelectorAll(".term-square-ended")) {
    const snap = TC.deadSessions.get(card.dataset.deadId);
    const show = !!snap && (snap.conversationId || null) === cid;
    card.style.display = show ? "" : "none";
    if (show) visible++;
  }
  if (TC.el.termEmpty) TC.el.termEmpty.style.display = visible ? "none" : "";
  if (TC.el.termCount) TC.el.termCount.textContent = String(visible);
}

function ensureEmptyHint() {
  // Both live sessions and persisted (ended) cards count toward "not empty",
  // but only those belonging to the active conversation.
  refreshSessionVisibility();
}

// Switch the terminal sessions panel between the three layout modes
// ("squares" | "columns" | "rows"). This only changes the CONTAINER layout
// (CSS class on the grid) — the live xterm mounts are NOT recreated, so their
// content/state is preserved. Each mount's ResizeObserver refits the PTY to
// its new box automatically after the relayout.
function setTermView(view) {
  if (view !== "squares" && view !== "columns" && view !== "rows") view = "squares";
  TC.state.termView = view;
  TC.saveState();
  // Swap the grid's layout class.
  TC.el.termGrid.classList.remove("view-squares", "view-columns", "view-rows");
  TC.el.termGrid.classList.add("view-" + view);
  // Update the active/aria-pressed state of the switcher buttons.
  if (TC.el.termViewSwitcher) {
    for (const btn of TC.el.termViewSwitcher.querySelectorAll(".term-view-btn")) {
      const isActive = btn.dataset.view === view;
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-pressed", isActive ? "true" : "false");
    }
  }
  // The container dimensions changed — give the layout a frame to settle, then
  // refit every live terminal to its new box. Dead (ended) cards have no PTY.
  requestAnimationFrame(() => {
    for (const rec of TC.sessions.values()) fitTerminal(rec);
  });
}

function renderTabs() {
  // Grid layout — no tab bar. Keep the active square visually marked and the
  // count badge in sync. (Name kept so existing call sites don't change.)
  for (const rec of TC.sessions.values()) {
    rec.squareEl.classList.toggle("active", rec.id === TC.state.activeSessionId);
  }
  // Mark an active ended card too (clicking one selects it).
  for (const card of TC.el.termGrid.querySelectorAll(".term-square-ended")) {
    card.classList.toggle("active", card.dataset.deadId === TC.state.activeSessionId);
  }
  refreshSessionVisibility();
}

function selectSession(id) {
  // Live session?
  const rec = TC.sessions.get(id);
  // Ended/persisted session?
  const dead = TC.deadSessions.get(id);
  if (!rec && !dead) return;
  TC.state.activeSessionId = id;
  TC.saveState();
  renderTabs();
  const target = rec ? rec.squareEl : (TC.el.termGrid.querySelector('[data-dead-id="' + CSS.escape(id) + '"]'));
  if (target) target.scrollIntoView({ block: "nearest", behavior: "smooth" });
  renderSessionInfo();
}

async function registerSession(session, cmd, args, cwd, label, conversationId) {
  const id = session.id;
  // Scope the session to the conversation that was active when it was spawned
  // (or the explicit id passed by the reattach path). This is what lets the
  // Sessions section show only the current conversation's terminals.
  const convId = (conversationId !== undefined) ? conversationId : TC.state.activeConversationId;
  // square
  const square = document.createElement("div");
  square.className = "term-square";

  const header = document.createElement("div");
  header.className = "term-square-header";
  const dot = document.createElement("span");
  dot.className = "term-status-dot";
  dot.title = "Running";
  const lab = document.createElement("span");
  lab.className = "term-label";
  lab.textContent = label;
  const cwdEl = document.createElement("span");
  cwdEl.className = "term-cwd";
  cwdEl.textContent = TC.basename(cwd);
  cwdEl.title = cwd;
  const expandBtn = document.createElement("button");
  expandBtn.className = "term-head-btn";
  expandBtn.type = "button";
  expandBtn.textContent = "⤢";
  expandBtn.title = "Expand / collapse";
  const closeBtn = document.createElement("button");
  closeBtn.className = "term-head-btn term-close-btn";
  closeBtn.type = "button";
  closeBtn.textContent = "✕";
  closeBtn.title = "Close session";

  header.appendChild(dot);
  header.appendChild(lab);
  header.appendChild(cwdEl);
  header.appendChild(expandBtn);
  header.appendChild(closeBtn);

  const mountEl = document.createElement("div");
  mountEl.className = "term-mount";

  square.appendChild(header);
  square.appendChild(mountEl);
  // Resize handles: a vertical one on the right edge (columns view → width) and
  // a horizontal one on the bottom edge (rows view → height). Only the handle
  // matching the active view is shown (CSS); the drag logic is delegated on the
  // grid in initTermResize().
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
  // Newest session first: prepend the square to the TOP of the grid so
  // currently-running terminals sit above ended (dead) cards and stay visible
  // without scrolling. The empty-state hint (termEmpty) remains the last child.
  TC.el.termGrid.insertBefore(square, TC.el.termGrid.firstChild);

  // clicking a square selects it
  square.addEventListener("click", () => selectSession(id));

  // trustState starts at "none", NOT "pending": only autoDriveStartup (i.e. a
  // session started with a task prompt) manages a trust dialog, and it sets
  // "pending" itself. A manually-spawned session with no prompt is driven by the
  // user in the terminal widget, and must not be treated as blocked on trust —
  // that would suppress its approval handling forever.
  const rec = { id: session.id, session, cmd, args, cwd, label, active: true, exitCode: null, squareEl: square, mountEl, dispose: null, expanded: false, trustState: "none", trustMode: null, autoApproveBusy: false, autoApproveUnsub: null, waitingForInput: false, pendingQuestion: "", _idleTimer: null, _busyTimer: null, _lastApprovalKey: "", _lastApprovalAt: 0, _approveCooldownUntil: 0, _sentinelKey: "",
    // Activity tracking — this is what lets the app tell "the agent is working"
    // from "the agent finished its turn and is sitting at its prompt". A coding
    // CLI is a REPL: it does NOT exit when the task is done, so process exit is
    // useless as a completion signal (waiting for it was why monitoring felt
    // dead for minutes at a time).
    lastOutputAt: Date.now(), taskSubmittedAt: 0, bytesSinceTask: 0, tailAtPrompt: false,
    // Platform PTY state (session.isWaitingForInput / onStateChange): true when
    // the foreground process is the shell/CLI blocked on a tty read — the
    // authoritative "sitting at its prompt" signal that the text heuristics kept
    // missing for opencode/codex. 'unsupported' (Windows) leaves this false.
    ptyIdle: false, ptyStateUnsub: null, ptyPollTimer: null,
    // Health-check bookkeeping (stall detection + nudge).
    lastNudgeAt: 0, nudgeCount: 0, degenerate: false, degenerateInfo: null,
    lastErrorText: "", errorCount: 0, lastErrorAt: 0, errorLoop: false,
    // Persistence metadata — used to snapshot the session to scopedData so the
    // Sessions column survives an app close/reopen. `agent` is the CLI label
    // (e.g. "claude", "codex"); `worktreeBranch` is the git branch this session's
    // cwd is a worktree of (derived from the path / worktreeMeta), so the merged-
    // worktree cleanup can match a session to a merged branch.
    agent: label ? String(label).split(" · ")[0] : label,
    conversationId: convId,
    createdAt: Date.now(), endedAt: null, worktreeBranch: TC.worktreeBranchForCwd(cwd), merged: false };
  TC.sessions.set(session.id, rec);
  // Persist immediately so a session that's spawned but produces no output
  // before the app is closed still survives a reopen (otherwise it would never
  // reach SESSIONS_KEY until the first output chunk triggers schedulePersist).
  TC.schedulePersistSessions();

  // ---------- Platform PTY-state observation (idle detection) ----------
  // The text heuristics (isIdlePrompt) never matched opencode/codex prompt
  // chrome, so those sessions stayed WORKING forever and wait_for_session hung.
  // The platform's own PTY state is CLI-agnostic: isWaitingForInput() is true
  // exactly when the foreground process is the shell/CLI blocked on a tty read
  // (sitting at its prompt). Wire BOTH the push (onStateChange) and a poll
  // fallback (covers sessions restored from persistence, where the subscription
  // is gone, and hosts where onStateChange is unavailable).
  const applyPtyState = (busy) => {
    if (!rec.active) return;
    rec.ptyIdle = busy === false;
  };
  if (session && typeof session.onStateChange === "function") {
    try {
      rec.ptyStateUnsub = session.onStateChange((st) => {
        if (st && typeof st.busy === "boolean") applyPtyState(st.busy);
      });
    } catch (e) { /* non-fatal */ }
  }
  if (session && typeof session.isWaitingForInput === "function") {
    const pollPty = async () => {
      if (!rec.active) return;
      try {
        const w = await session.isWaitingForInput();
        // THREE states: true (at prompt), false (busy), 'unsupported' (unknown —
        // Windows, or a dead session). Only a definite answer updates the flag.
        if (w === true) applyPtyState(false);
        else if (w === false) applyPtyState(true);
      } catch (e) { /* non-fatal */ }
    };
    pollPty();
    rec.ptyPollTimer = setInterval(pollPty, 10000);
  }

  // ---------- Degenerate-output recovery ----------
  // The platform detects repeated-token / incoherent-gibberish output loops
  // (the "codex goes silent then the terminal turns to garbage" failure). When
  // it fires, interrupt the agent (ctrl+c) so it stops burning quota, flag the
  // session so the orchestrator sees it, and notify the user. The orchestrator
  // can then close_session + respawn; we do NOT auto-kill because the worktree
  // may hold uncommitted work the user wants to inspect first.
  if (session && typeof session.onDegenerateOutput === "function") {
    try {
      session.onDegenerateOutput((info) => {
        if (!rec.active) return;
        rec.degenerate = true;
        rec.degenerateInfo = info || {};
        try { session.key("ctrl+c"); } catch (e) { /* non-fatal */ }
        try {
          window.chatoss.notifications.send({
            title: "Agent output degenerated",
            body: (rec.label || "Agent") + ": repeated-token/gibberish loop detected — interrupted. Consider closing and respawning it.",
          });
        } catch (e) { /* non-fatal */ }
        renderTabs();
        renderSessionInfo();
      });
    } catch (e) { /* non-fatal */ }
  }

  // autoDriveStartup calls this right after it sends the task, so idle detection
  // can distinguish "finished a turn" from "never started".
  rec._markTaskSubmitted = () => {
    rec.taskSubmittedAt = Date.now();
    rec.bytesSinceTask = 0;
  };

  // Set autoApproveBusy WITH a watchdog. This flag gates the entire monitor, so
  // any path that sets it and fails to clear it (an approval picker the user
  // never answers, a rejected promise) silently blinds the orchestrator to this
  // terminal for the rest of the session. The timer guarantees recovery.
  const setApproveBusy = (on) => {
    rec.autoApproveBusy = !!on;
    if (rec._busyTimer) { clearTimeout(rec._busyTimer); rec._busyTimer = null; }
    if (on) {
      rec._busyTimer = setTimeout(() => {
        rec._busyTimer = null;
        if (rec.autoApproveBusy) {
          console.warn("[Term Coder] autoApproveBusy watchdog fired for", rec.label);
          rec.autoApproveBusy = false;
        }
      }, TC.APPROVE_BUSY_TIMEOUT_MS);
    }
  };

  // ---------- Universal terminal monitor ----------
  // Watches every session's output and detects THREE kinds of events so the
  // orchestrator always knows what's going on inside ANY terminal, regardless
  // of which coding-agent CLI produced the output:
  //
  //   1. ORCHESTRATOR_INPUT_NEEDED sentinel — the agent followed the protocol
  //      we prepended to its task prompt and is asking us a question. We surface
  //      the question text to the orchestrator (via rec.pendingQuestion) and do
  //      NOT auto-respond — the orchestrator decides the answer and types it via
  //      send_to_session. Works with ANY CLI that can print text.
  //
  //   2. Permission/approval prompts — the agent is asking to run a command or
  //      make an edit (Codex's "Yes, proceed", Claude's "Do you want to make this
  //      edit?", or a generic y/n prompt). Safe ones auto-approve; destructive
  //      ones ask the user in chat.
  //
  //   3. Generic idle — the terminal has shown a prompt cursor (❯ › $ >) with no
  //      new output for a while. This catches agents that don't follow the
  //      protocol and just sit waiting. We mark the session NEEDS INPUT so the
  //      orchestrator knows to check on it.

  // Extract the question text that follows the orchestrator-input marker.
  function extractSentinelQuestion(text) {
    const m = text.match(TC.ORCH_SENTINEL_RE);
    if (!m) return "";
    // Grab the marker line + any following context lines (up to ~500 chars).
    let q = (m[1] || "").trim();
    const after = text.slice(m.index + m[0].length);
    const ctxLines = after.split("\n").filter((l) => l.trim() && !/^(─|❯|›|\$|>)/.test(l.trim())).slice(0, 4);
    if (ctxLines.length) q += "\n" + ctxLines.join("\n").trim();
    return q.slice(0, 500);
  }

  // Classify a permission prompt. Returns null when there's no prompt, else
  // { kind: "safe-edit" } | { kind: "safe-command", command } | { kind: "dangerous", command }.
  function classifyApprovalPrompt(cleanText, flat) {
    // NEVER treat a folder-trust dialog as a command approval. Claude Code's
    // trust dialog offers "1. Yes, proceed", which matches the Codex signature
    // below — so this monitor used to press Enter on it and silently confirm
    // trust, defeating the trustMode="ask" pill picker entirely. Trust is
    // handled exclusively by autoDriveStartup/handleTrust.
    if (/do\s*you\s*trust|trust\s*the\s*(files|contents|folder|directory)|trust\s*this\s*folder/.test(flat)) return null;
    // Codex command-approval signature.
    const codexSig = /yes,\s*proceed|press\s*enter\s*to\s*confirm|yes,\s*and\s*don'?t\s*ask\s*again/.test(flat);
    // Claude permission prompt signatures (edit / create / run / proceed / overwrite).
    const claudeSig = /do you want to make this edit|do you want to (proceed|create|run|delete|overwrite|make)|allow all edits during this session|esc to cancel/.test(flat);
    // Generic y/n confirmation (catches other CLIs: "Continue? (y/n)", "Proceed? [Y/n]").
    const genericYn = /\(y\/n\)|\[y\/n\]|\(yes\/no\)|\[yes\/no\]|proceed\?\s*$/m.test(flat) ||
      /continue\?\s*$/m.test(flat);
    if (!codexSig && !claudeSig && !genericYn) return null;

    // Extract the command/edit target text (the line(s) just above the options).
    let commandText = "";
    const ranMatch = cleanText.match(/Ran\s+(.+?)(?=\s*›|\s*1\.\s*Yes)/is);
    if (ranMatch) commandText = ranMatch[1].trim();
    if (!commandText) {
      const beforeYes = cleanText.split(/1\.\s*Yes/i)[0];
      commandText = (beforeYes.trim().split("\n").pop() || "").trim();
    }
    if (!commandText) {
      // Generic y/n fallback: grab the line before the (y/n).
      const beforeYn = cleanText.split(/\(y\/n\)|\[y\/n\]|\(yes\/no\)|\[yes\/no\]/i)[0];
      commandText = (beforeYn.trim().split("\n").pop() || "").trim();
    }

    // The terminal tail carries live CLI spinner glyphs ("✻") and status
    // frames ("Baking…", "still thinking") that stripAnsi() can't remove —
    // they're plain unicode redrawn every frame. Clean them out so the
    // approval overlay shows the real command, not garbled decoration.
    commandText = TC.cleanApprovalText(commandText);

    // Dangerous command patterns — always ask the user before approving.
    const dangerous = /\brm\s+-rf?\b|\bdelete\b|\bdrop\s+(table|database)\b|\bformat\b|\btruncate\b|\bsudo\s+rm\b|\bgit\s+push\s+.*--force\b|\bchmod\s+777\b|\bkill\s+-9\b/i.test(commandText);
    if (dangerous) return { kind: "dangerous", command: commandText };

    // File edit/create prompts are the agent doing its job — always safe.
    const isEdit = /make this edit|create this (file|directory)|overwrite|allow all edits/.test(flat);
    if (isEdit) return { kind: "safe-edit", command: commandText };

    return { kind: "safe-command", command: commandText };
  }

  // Detect a generic idle prompt: a prompt cursor at the end of recent output
  // with no new activity. Returns true if the terminal looks idle/waiting.
  function isIdlePrompt(flat) {
    // Is an input prompt visible near the bottom of the screen?
    //
    // This must NOT require the prompt glyph to be the last thing in the output.
    // Claude Code draws chrome BELOW its input box — a cursor line and a mode
    // line like "⏸ manual mode on" — so the glyph is typically 2-4 lines from the
    // end and an end-anchored test never matched. That made IDLE unreachable for
    // Claude Code, so wait_for_session always ran to its full timeout and the
    // orchestrator never learned that an agent had finished.
    //
    // Note this is only half the signal: sessionActivity() requires the terminal
    // to ALSO have been quiet for TURN_IDLE_MS. These CLIs animate a spinner the
    // whole time they work, so silence is what really distinguishes "finished"
    // from "thinking" — this function just confirms we're parked at a prompt
    // rather than mid-stream.
    const lines = flat.split("\n").map((l) => l.replace(/[│┃▌▎]/g, " ").trim()).filter(Boolean);
    for (const l of lines.slice(-6)) {
      if (/^[❯›»>]/.test(l)) return true;              // an input prompt line
      if (/[^<\/\w]\$\s*$/.test(l) || /^\$\s*$/.test(l)) return true; // plain shell prompt
      // Persistent idle-state chrome from the common CLIs.
      if (/esc to cancel|esc to interrupt|tab to amend|manual mode on|accept edits on|plan mode on|\? for shortcuts/.test(l)) return true;
    }
    return false;
  }

  try {
    if (typeof session.onData === "function") {
      let monitorBuffer = "";
      let lastOutputTime = Date.now();
      // Let autoDriveStartup drop the echo of the task prompt out of the buffer
      // the moment it is submitted, so a long prompt can't linger and be
      // re-matched as terminal content.
      rec._resetMonitorBuffer = () => { monitorBuffer = ""; };

      rec.autoApproveUnsub = session.onData((chunk) => {
        if (!rec.active) return;
        monitorBuffer += chunk;
        lastOutputTime = Date.now();
        rec.lastOutputAt = lastOutputTime;
        if (rec.taskSubmittedAt) rec.bytesSinceTask += chunk.length;
        // Debounced-save this session's output snapshot to scopedData so it
        // survives an app close/reopen (see SESSIONS_KEY). schedulePersistSessions
        // batches many chunks into one write — never per byte.
        TC.schedulePersistSessions();
        // Cap the buffer so a long session can't grow it unbounded — prompts
        // and markers are always near the tail, so keeping the last ~8KB is plenty.
        if (monitorBuffer.length > 8192) monitorBuffer = monitorBuffer.slice(-4096);
        const cleanText = TC.stripAnsi(monitorBuffer);
        // Match prompts against the TAIL only. Matching the whole accumulated
        // buffer meant a prompt that had already been answered stayed matchable
        // for thousands of characters — and since TUIs redraw their scrollback
        // continuously, the same prompt kept re-triggering an auto-approve,
        // spraying stray Enter keystrokes into a working agent.
        const tailText = cleanText.slice(-1200);
        const tailFlat = tailText.toLowerCase();
        const now = Date.now();

        // Is this session still waiting on the folder-trust dialog? While it is,
        // the monitor must not touch the PTY at all — autoDriveStartup owns the
        // keyboard until the user answers the trust picker.
        const trustPending = rec.trustMode !== "always" &&
          (rec.trustState === "pending" || rec.trustState === "asking");

        // 0) Record agent/provider errors. Passive — this never touches the PTY,
        //    it just makes the failure visible to the orchestrator as a state
        //    instead of leaving it to notice error text in a screen dump.
        const errLine = TC.detectAgentError(tailText);
        if (errLine) {
          if (errLine === rec.lastErrorText) {
            rec.errorCount = (rec.errorCount || 1) + 1;
          } else {
            rec.lastErrorText = errLine;
            rec.errorCount = 1;
          }
          rec.lastErrorAt = now;
          const looping = rec.errorCount >= TC.ERROR_LOOP_THRESHOLD;
          if (looping && !rec.errorLoop) {
            rec.errorLoop = true;
            renderTabs();
            renderSessionInfo();
            try {
              window.chatoss.notifications.send({
                title: "Agent stuck on an error",
                body: (rec.label || "Agent") + ": " + errLine.slice(0, 120),
              });
            } catch (e) { /* non-fatal */ }
          }
        } else if (rec.errorLoop && now - (rec.lastErrorAt || 0) > 20000) {
          // Twenty seconds of error-free output means it recovered (or was
          // corrected) — stop reporting it as stuck.
          rec.errorLoop = false;
          rec.lastErrorText = "";
          rec.errorCount = 0;
          renderTabs();
          renderSessionInfo();
        }

        // 1) Orchestrator-input marker — the agent is asking us a question.
        //    Deduped by question text rather than by latching autoApproveBusy, so
        //    a pending question never blinds the monitor to approval prompts.
        const sentinelMatch = cleanText.match(TC.ORCH_SENTINEL_RE);
        if (sentinelMatch) {
          const question = extractSentinelQuestion(cleanText);
          const key = question.slice(0, 160);
          if (key && key !== rec._sentinelKey) {
            rec._sentinelKey = key;
            rec.waitingForInput = true;
            rec.pendingQuestion = question;
            renderTabs();
            renderSessionInfo();
            // Notify the user about the pending question.
            try {
              window.chatoss.notifications.send({
                title: "Agent asking a question",
                body: (rec.label || "Agent") + ": " + question.split("\n")[0].slice(0, 120),
              });
            } catch (e) { /* non-fatal */ }
            // Do NOT auto-respond — the orchestrator decides the answer and types
            // it via send_to_session. Drop the marker from the buffer so the same
            // text doesn't keep re-matching, but keep rec.pendingQuestion +
            // waitingForInput set until the orchestrator acts.
            monitorBuffer = "";
            return;
          }
        }

        // 2) Permission / approval prompts.
        if (!rec.autoApproveBusy && !trustPending && now >= rec._approveCooldownUntil) {
          const verdict = classifyApprovalPrompt(tailText, tailFlat);
          // Ignore a prompt we just answered — the TUI keeps it on screen.
          const sameAsLast = verdict && verdict.command === rec._lastApprovalKey &&
            now - rec._lastApprovalAt < 4000;
          if (verdict && !sameAsLast) {
            setApproveBusy(true);
            rec.waitingForInput = true;
            rec._lastApprovalKey = verdict.command || "";
            rec._lastApprovalAt = now;
            renderTabs();
            renderSessionInfo();

            const settle = () => {
              monitorBuffer = "";
              rec._approveCooldownUntil = Date.now() + TC.APPROVE_COOLDOWN_MS;
              setApproveBusy(false);
              rec.waitingForInput = false;
              rec.pendingQuestion = "";
              renderTabs();
              renderSessionInfo();
            };

            if (verdict.kind === "dangerous") {
              // Ask the user in chat before approving a destructive command.
              // .catch is essential: an askChoice that rejects would otherwise
              // leave autoApproveBusy set (the watchdog would clear it, but only
              // after 45s of the orchestrator being blind to this terminal).
              TC.askCommandApproval(rec, verdict.command).then((approved) => {
                TC.sendKey(session, approved ? "enter" : "escape").finally(settle);
              }).catch((e) => {
                console.warn("askCommandApproval failed", e);
                TC.sendKey(session, "escape").finally(settle);
              });
            } else {
              // Safe edit / safe command — auto-approve. For Claude the default
              // highlighted option is "1. Yes", so Enter accepts it (we never
              // pick option 2 "allow all edits during this session" — that stays
              // the user's per-edit choice).
              TC.sendKey(session, "enter").finally(settle);
            }
            return;
          }
        }

        // 3) Generic idle fallback — if there's no marker and no approval prompt
        //    but the terminal is showing a prompt cursor, flag it so the
        //    orchestrator knows to check on it.
        const idle = isIdlePrompt(tailFlat);
        // Cached for sessionActivity(), which is polled from wait_for_session and
        // read by buildSystemPrompt without touching the PTY.
        rec.tailAtPrompt = idle;
        if (!idle) {
          // Any non-idle output means the agent is working again. Clear a pending
          // timer AND an already-raised idle flag — the old code only did the
          // former, so once the idle flag was set nothing ever cleared it and the
          // session reported NEEDS INPUT forever.
          if (rec._idleTimer) { clearTimeout(rec._idleTimer); rec._idleTimer = null; }
          if (rec.waitingForInput && /^\(agent appears idle/.test(rec.pendingQuestion || "")) {
            rec.waitingForInput = false;
            rec.pendingQuestion = "";
            renderTabs();
            renderSessionInfo();
          }
        } else if (!rec.autoApproveBusy && !rec.waitingForInput && !rec._idleTimer && rec.trustState !== "pending" && rec.trustState !== "asking") {
          // Only flag after a quiet period — an agent that is actually thinking
          // keeps emitting spinner frames, which refresh lastOutputTime.
          // The trustState guard (B1) prevents arming during the quiet trust /
          // pre-submission window: while a "trust this folder?" pill picker is
          // pending ("pending"/"asking"), the terminal shows a prompt cursor with
          // no spinner, so without this guard the 5s timer would falsely flag the
          // agent as idle before its task was ever submitted.
          rec._idleTimer = setTimeout(() => {
            rec._idleTimer = null;
            if (!rec.active || rec.autoApproveBusy || rec.waitingForInput) return;
            if (rec.trustState === "pending" || rec.trustState === "asking") return;
            if (Date.now() - lastOutputTime >= 5000) {
              rec.waitingForInput = true;
              rec.pendingQuestion = "(agent appears idle — terminal is showing a prompt cursor with no recent activity. Check on it with read_session to see what it needs.)";
              renderTabs();
              renderSessionInfo();
            }
          }, 5000);
        }
      });
    }
  } catch (e) { console.warn("universal terminal monitor setup failed:", e); }

  // mount the xterm widget. Per the docs, mount() wires session output → terminal
  // AND terminal input → stdin automatically — we do NOT need a separate onData
  // handler for display. Pass the session.id (string) per the documented signature.
  try {
    const handle = await window.chatoss.terminal.mount(mountEl, session.id, { fontSize: 12 });
    rec.dispose = handle && handle.dispose ? handle.dispose.bind(handle) : null;
  } catch (e) {
    console.warn("terminal.mount failed:", e);
    const errEl = document.createElement("div");
    errEl.className = "term-mount-error";
    errEl.textContent = "Terminal failed to load: " + (e && e.message ? e.message : String(e));
    mountEl.appendChild(errEl);
  }

  // exit callback — use the session handle's OO onExit method.
  try {
    if (session.onExit) {
      session.onExit((exitCode) => {
        rec.active = false;
        rec.exitCode = exitCode;
        rec.endedAt = Date.now();
        // Tear down monitor timers so an exited session can't keep firing
        // renderTabs()/renderSessionInfo() or flag a dead terminal as idle.
        if (rec._idleTimer) { clearTimeout(rec._idleTimer); rec._idleTimer = null; }
        if (rec._busyTimer) { clearTimeout(rec._busyTimer); rec._busyTimer = null; }
        rec.autoApproveBusy = false;
        rec.waitingForInput = false;
        rec.pendingQuestion = "";
        dot.classList.add("exited");
        dot.title = "Exited (" + (exitCode == null ? "killed" : exitCode) + ")";
        lab.textContent = label + " ✓ (" + (exitCode == null ? "exited" : exitCode) + ")";
        renderTabs();
        try { window.chatoss.notifications.send({ title: "Session ended", body: label + " finished" }); } catch (e) { /* non-fatal */ }
        renderSessionInfo();
        // Eagerly persist the final ended snapshot so the last output is saved
        // even if the app is closed immediately after the process exits.
        TC.persistSessions().catch((e) => console.warn("persistSessions onExit", e));
      });
    }
  } catch (e) { console.warn("onExit failed:", e); }

  expandBtn.onclick = () => toggleExpand(id);
  closeBtn.onclick = () => TC.confirmDelete(() => closeSession(id), closeBtn);

  ensureEmptyHint();
  TC.state.activeSessionId = id;
  TC.saveState();
  renderTabs();
  renderSessionInfo();

  // size the PTY to the square and keep it fitted when the column resizes
  requestAnimationFrame(() => fitTerminal(rec));
  try {
    const ro = new ResizeObserver(() => fitTerminal(rec));
    ro.observe(mountEl);
    rec.ro = ro;
  } catch (e) { /* ResizeObserver unavailable — window resize still refits */ }
}

function fitTerminal(rec) {
  if (!rec || !rec.active) return;
  // Skip squares that are not laid out (hidden or zero-size) — avoids
  // resizing the PTY to 20×5 while the app is starting up.
  const w = rec.mountEl.clientWidth;
  const h = rec.mountEl.clientHeight;
  if (!w || !h) return;
  const cols = Math.max(20, Math.floor(w / 7.6));
  const rows = Math.max(5, Math.floor(h / 15.5));
  try { if (rec.session && rec.session.resize) rec.session.resize(cols, rows); } catch (e) { /* non-fatal */ }
}

function toggleExpand(id) {
  const rec = TC.sessions.get(id);
  if (!rec) return;
  rec.expanded = !rec.expanded;
  rec.squareEl.classList.toggle("expanded", rec.expanded);
  requestAnimationFrame(() => fitTerminal(rec));
}

// ---------- Session health check ----------
// Detects stalled sessions (quiet but still classified WORKING/STARTING) and
// nudges them back to life, or reports them so the user can intervene. Runs on
// a timer (HEALTH_CHECK_MS) and is also exposed to the orchestrator as the
// health_check tool. Returns a per-session report string.
async function runHealthCheck() {
  const now = Date.now();
  const report = [];
  for (const rec of TC.sessions.values()) {
    if (rec.active === false) continue;
    const act = TC.sessionActivity(rec);
    const quietFor = now - (rec.lastOutputAt || now);
    const stalled = (act === "WORKING" || act === "STARTING") && quietFor >= TC.STALL_QUIET_MS;
    if (stalled) {
      const canNudge = now - (rec.lastNudgeAt || 0) >= TC.NUDGE_COOLDOWN_MS;
      if (canNudge && rec.session && typeof rec.session.paste === "function") {
        try {
          await rec.session.paste(TC.NUDGE_TEXT);
          await rec.session.key("enter");
          rec.lastNudgeAt = now;
          rec.nudgeCount = (rec.nudgeCount || 0) + 1;
          try {
            window.chatoss.notifications.send({
              title: "Agent appears stalled — nudged",
              body: (rec.label || "Agent") + " was quiet for " + Math.round(quietFor / 60000) + " min. Sent: \"" + TC.NUDGE_TEXT + "\"",
            });
          } catch (e) { /* non-fatal */ }
          report.push("NUDGED " + (rec.label || rec.id) + " (quiet " + Math.round(quietFor / 60000) + " min, nudge #" + rec.nudgeCount + ")");
        } catch (e) {
          report.push("STALLED " + (rec.label || rec.id) + " (quiet " + Math.round(quietFor / 60000) + " min) — nudge failed: " + (e && e.message ? e.message : String(e)));
        }
      } else if (canNudge) {
        report.push("STALLED " + (rec.label || rec.id) + " (quiet " + Math.round(quietFor / 60000) + " min) — no paste/key on this session handle, cannot nudge");
      } else {
        report.push("STALLED " + (rec.label || rec.id) + " (quiet " + Math.round(quietFor / 60000) + " min) — already nudged " + Math.round((now - rec.lastNudgeAt) / 60000) + " min ago, waiting");
      }
    } else if (rec.degenerate) {
      report.push("DEGENERATE " + (rec.label || rec.id) + " — output collapsed into a repeated-token/gibberish loop; interrupted. Consider close_session + respawn.");
    } else {
      report.push(act + " " + (rec.label || rec.id) + " (quiet " + Math.round(quietFor / 1000) + "s)");
    }
  }
  return report.length ? report.join("\n") : "No live sessions.";
}

async function closeSession(id) {
  const rec = TC.sessions.get(id);
  if (!rec) return;
  if (rec.autoApproveUnsub) { try { rec.autoApproveUnsub(); } catch (e) { /* non-fatal */ } }
  if (rec._idleTimer) { clearTimeout(rec._idleTimer); rec._idleTimer = null; }
  if (rec.ptyPollTimer) { clearInterval(rec.ptyPollTimer); rec.ptyPollTimer = null; }
  if (rec.ptyStateUnsub) { try { rec.ptyStateUnsub(); } catch (e) { /* non-fatal */ } }
  // Auto-commit the worktree BEFORE killing the process, so a killed agent's
  // uncommitted edits are never stranded. A session whose cwd is a worktree
  // (worktreeBranchForCwd returns its branch) gets a WIP commit; the merge flow
  // later folds it into main. Nothing-to-commit is fine (exit 1, ignored).
  const wtBranch = rec.worktreeBranch || TC.worktreeBranchForCwd(rec.cwd);
  if (wtBranch && rec.cwd) {
    try {
      const wipR = await window.chatoss.terminal.exec(
        TC.loginShell("git add -A && git commit -m " + JSON.stringify("WIP: commit uncommitted work before closing " + (rec.label || rec.id))),
        { cwd: rec.cwd }
      );
      if (wipR && wipR.exitCode === 0) {
        try {
          window.chatoss.notifications.send({
            title: "Worktree auto-committed",
            body: (rec.label || "Agent") + " closed — its uncommitted work was committed to branch " + wtBranch + " so it is resumable.",
          });
        } catch (e) { /* non-fatal */ }
      }
    } catch (e) { /* non-fatal — never block the close */ }
  }
  try { if (rec.session && rec.session.kill) await rec.session.kill(); } catch (e) { /* non-fatal */ }
  // Terminal sessions now survive window close in the OS store, so a closed
  // session must be removed from the OS-persisted record too (killSession
  // kills the process if any and deletes the persisted metadata/output).
  try { await window.chatoss.terminal.killSession(id); } catch (e) { /* non-fatal */ }
  if (rec.dispose) { try { rec.dispose(); } catch (e) { /* non-fatal */ } }
  if (rec.ro) { try { rec.ro.disconnect(); } catch (e) { /* non-fatal */ } }
  rec.squareEl.remove();
  TC.sessions.delete(id);
  // A closed session should NOT come back as a dead card on the next reopen,
  // so drop it from the persisted snapshot list too.
  TC.sqliteDeleteTerminalSession(id);
  TC.persistSessions().catch((e) => console.warn("persistSessions closeSession", e));
  if (TC.state.activeSessionId === id) {
    TC.state.activeSessionId = TC.sessions.size ? TC.sessions.keys().next().value : null;
  }
  TC.saveState();
  ensureEmptyHint();
  renderTabs();
  renderSessionInfo();
}

function renderSessionInfo() {
  // If the selected session belongs to a different conversation, drop the
  // selection so the footer doesn't name a terminal that isn't visible here.
  if (TC.state.activeSessionId) {
    const sel = TC.sessions.get(TC.state.activeSessionId) || TC.deadSessions.get(TC.state.activeSessionId);
    if (!sel || (sel.conversationId || null) !== TC.state.activeConversationId) {
      TC.state.activeSessionId = null;
    }
  }
  const rec = TC.state.activeSessionId ? TC.sessions.get(TC.state.activeSessionId) : null;
  const dead = (!rec && TC.state.activeSessionId) ? TC.deadSessions.get(TC.state.activeSessionId) : null;
  const c = TC.activeConversation();
  let bits = [];
  if (c) bits.push("Conversation: " + c.name);
  if (rec) bits.push("Session: " + rec.label + " @ " + rec.cwd + (rec.active ? "" : " (exited)"));
  else if (dead) bits.push("Session: " + dead.label + " @ " + dead.cwd + " (ended)");
  TC.el.sessionInfo.textContent = bits.join("  ·  ");
  // Keep the terminal grid + count badge scoped to the active conversation.
  refreshSessionVisibility();
}

// ---------- Reusable multiple-choice chat component ----------
// window.termCoder.askChoice(config) -> Promise
//   config = { prompt: string,
//             options: [{label: string, value: string}, ...],
//             style: "rect" | "pill" }
//   Resolves to the chosen option's `value` (string), or null if the user
//   dismisses/cancels (Escape). The Promise blocks ONLY this choice — the rest
//   of the UI stays fully interactive.
//
// Renders the prompt text + option buttons INSIDE the chat stream (as a chat
// message bubble) so the question appears naturally in the conversation.
// Shows a subtle "waiting for your selection…" state until clicked; after one
// option is clicked, all buttons are disabled and the chosen one is visually
// marked.
//
// style "rect" -> stacked text rectangles, one full-width row per option.
// style "pill" -> pill buttons in a wrapping row (flex-wrap), horizontal, wrap.
// --- exports ---
TC.refreshSessionVisibility = refreshSessionVisibility;
TC.ensureEmptyHint = ensureEmptyHint;
TC.setTermView = setTermView;
TC.renderTabs = renderTabs;
TC.selectSession = selectSession;
TC.registerSession = registerSession;
TC.fitTerminal = fitTerminal;
TC.toggleExpand = toggleExpand;
TC.runHealthCheck = runHealthCheck;
TC.closeSession = closeSession;
TC.renderSessionInfo = renderSessionInfo;
})();
