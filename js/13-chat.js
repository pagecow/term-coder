// 13-chat.js — classic script (converted from an ES module; see REFACTOR_PLAN.md).
// Exports are registered on the shared window.termCoder namespace (TC).
(function () {
"use strict";
const TC = window.termCoder = window.termCoder || {};
function createThinkingWidget(text, opts) {
  const o = opts || {};
  const wrap = document.createElement("div");
  wrap.className = "msg-thinking-collapsible" + (o.streaming ? " is-streaming" : "");
  wrap.setAttribute("data-state", "collapsed");

  // --- Header: the "still thinking" indicator + the single toggle ---
  const header = document.createElement("button");
  header.type = "button";
  header.className = "think-toggle";
  header.setAttribute("aria-expanded", "false");
  const icon = document.createElement("span");
  icon.className = "think-icon";
  icon.textContent = "💭";
  const caret = document.createElement("span");
  caret.className = "think-caret";
  caret.textContent = "▸";
  const label = document.createElement("span");
  label.className = "think-label";
  label.textContent = o.streaming ? "Thinking…" : "Thought process";
  const meta = document.createElement("span");
  meta.className = "think-meta";
  meta.textContent = "";
  header.appendChild(icon);
  header.appendChild(caret);
  header.appendChild(label);
  header.appendChild(meta);

  // --- Body: the full reasoning text, hidden until expanded ---
  const body = document.createElement("div");
  body.className = "think-body";
  const inner = document.createElement("div");
  inner.className = "think-inner";
  inner.textContent = String(text || "");
  body.appendChild(inner);

  wrap.appendChild(header);
  wrap.appendChild(body);

  const setOpen = (open) => {
    wrap.setAttribute("data-state", open ? "open" : "collapsed");
    header.setAttribute("aria-expanded", open ? "true" : "false");
  };
  header.addEventListener("click", () => {
    setOpen(wrap.getAttribute("data-state") !== "open");
  });

  // Expose updaters for streaming.
  wrap._update = (newText) => {
    inner.textContent = String(newText || "");
    if (!o.streaming) return;
    const words = String(newText || "").trim().split(/\s+/).filter(Boolean).length;
    meta.textContent = words ? words + " words" : "";
  };
  // When streaming ends, switch label from "Thinking…" to "Thought process".
  wrap._finalize = () => {
    wrap.classList.remove("is-streaming");
    label.textContent = "Thought process";
  };
  return wrap;
}

// ---------- Live "Working" activity card ----------
// A single STABLE container that holds the thinking widget + every tool chip
// during a run. It has a FIXED max height with an internally-scrolling list, so
// the chat layout never grows or jumps as tools fire — the area stays one
// consistent card. On completion it collapses to a compact "N tools used" pill.
function createActivityCard() {
  const card = document.createElement("div");
  card.className = "activity-card is-live";

  const head = document.createElement("button");
  head.type = "button";
  head.className = "activity-card-head";
  head.setAttribute("aria-expanded", "true");
  const pulse = document.createElement("span");
  pulse.className = "activity-pulse";
  const headLabel = document.createElement("span");
  headLabel.className = "activity-card-title";
  headLabel.textContent = "Working…";
  const count = document.createElement("span");
  count.className = "activity-card-count";
  const caret = document.createElement("span");
  caret.className = "activity-card-caret";
  caret.textContent = "▸";
  head.appendChild(pulse);
  head.appendChild(headLabel);
  head.appendChild(count);
  head.appendChild(caret);

  const body = document.createElement("div");
  body.className = "activity-card-body";

  card.appendChild(head);
  card.appendChild(body);

  let toolCount = 0;
  let doneCount = 0;
  let open = true;

  const setOpen = (v) => {
    open = v;
    card.classList.toggle("is-open", open);
    head.setAttribute("aria-expanded", open ? "true" : "false");
  };
  setOpen(true);
  head.addEventListener("click", () => setOpen(!open));

  const refreshCount = () => {
    count.textContent = toolCount ? (doneCount + "/" + toolCount) : "";
  };

  // Public API used by the streaming block.
  card._body = body;
  card._addThinking = (widget) => { body.appendChild(widget); };
  card._addChip = (chip) => {
    toolCount++;
    body.appendChild(chip);
    refreshCount();
    // Keep the newest chip in view inside the scrolling list.
    body.scrollTop = body.scrollHeight;
    // Wrap the terminal-state setters so the done counter advances.
    const origRes = chip._setResult.bind(chip);
    const origErr = chip._setError.bind(chip);
    const origUnk = chip._setUnknown.bind(chip);
    chip._setResult = (r) => { doneCount++; origRes(r); refreshCount(); };
    chip._setError = (e) => { doneCount++; origErr(e); refreshCount(); };
    chip._setUnknown = () => { doneCount++; origUnk(); refreshCount(); };
  };
  // Collapse to a compact summary pill when the run finishes.
  card._finish = () => {
    card.classList.remove("is-live");
    card.classList.add("is-finished");
    pulse.classList.add("is-done");
    headLabel.textContent = toolCount
      ? ("Used " + toolCount + (toolCount === 1 ? " tool" : " tools"))
      : "Done";
    refreshCount();
    setOpen(false); // collapse — the area shrinks to a single pill line
  };
  return card;
}

// Rebuild the activity card for a SAVED message (history replay / reload).
//
// The activity card is the ONE canonical home for thinking + tool chips, live
// and historical alike. Previously the live card was left in the log on finish
// AND renderMessage appended a second thinking widget plus a second full set of
// chips into .msg-tools — so every completed turn showed its tools twice, and a
// reload showed them in a completely different shape than the run had. Same
// component both ways now.
function buildActivityRecord(m) {
  const card = createActivityCard();
  if (m.thinking) card._addThinking(createThinkingWidget(m.thinking, { streaming: false }));
  for (const t of (m.toolCalls || [])) {
    const chip = createToolChip(t.name, t.args || {}, { historical: true });
    card._addChip(chip);
    if (t.error) chip._setError(t.error);
    else if (t.result != null) chip._setResult(t.result);
    else chip._setUnknown();
  }
  card._finish();
  return card;
}

// ---------- Tool-call activity chip ----------
// Creates a compact inline chip with a status icon (spinner while running,
// green check when done, red x on error) plus a live elapsed-time readout so
// long-running tools never look "stuck". Clicking expands args/result detail.
function createToolChip(name, args, opts) {
  const o = opts || {};
  const chip = document.createElement("div");
  chip.className = "tool-chip is-running";
  chip.setAttribute("data-state", "collapsed");

  const head = document.createElement("button");
  head.type = "button";
  head.className = "tool-chip-head";
  const icon = document.createElement("span");
  icon.className = "tool-chip-icon";
  icon.innerHTML = '<span class="tool-chip-play"></span><span class="tool-chip-spinner"></span>';
  const label = document.createElement("span");
  label.className = "tool-chip-name";
  label.textContent = name || "tool";
  // Status badge — a compact pill that reads "running 3s" while the tool works,
  // then flips to "done" / "error" on completion. This is the key fix for chips
  // that looked "stuck" in an infinite spinner during long polling loops: the
  // elapsed counter makes it obvious the tool is actively working.
  const badge = document.createElement("span");
  badge.className = "tool-chip-badge";
  badge.textContent = "running…";
  const okLabel = document.createElement("span");
  okLabel.className = "tool-chip-ok";
  const caret = document.createElement("span");
  caret.className = "tool-chip-caret";
  caret.textContent = "▸";
  head.appendChild(icon);
  head.appendChild(label);
  head.appendChild(badge);
  head.appendChild(okLabel);
  head.appendChild(caret);

  const detail = document.createElement("div");
  detail.className = "tool-chip-detail";
  const argLine = document.createElement("div");
  argLine.className = "tool-chip-args";
  argLine.textContent = JSON.stringify(args || {}, null, 2);
  detail.appendChild(argLine);
  const resultLabel = document.createElement("div");
  resultLabel.className = "tool-chip-result-label";
  resultLabel.textContent = "Result";
  detail.appendChild(resultLabel);
  const resultLine = document.createElement("div");
  resultLine.className = "tool-chip-result";
  detail.appendChild(resultLine);

  chip.appendChild(head);
  chip.appendChild(detail);

  head.addEventListener("click", () => {
    const open = chip.getAttribute("data-state") === "open";
    chip.setAttribute("data-state", open ? "collapsed" : "open");
  });

  // Live elapsed-time ticker — shows how long the tool has been running so a
  // long polling loop is obviously "working", not frozen.
  let startTime = Date.now();
  let timerId = null;
  const fmtTime = (ms) => {
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    const rs = s % 60;
    return m + "m " + (rs < 10 ? "0" : "") + rs + "s";
  };
  const startTimer = () => {
    startTime = Date.now();
    if (timerId) return;
    timerId = setInterval(() => {
      badge.textContent = "running " + fmtTime(Date.now() - startTime);
    }, 250);
  };
  const stopTimer = () => {
    if (timerId) { clearInterval(timerId); timerId = null; }
  };
  // A HISTORICAL chip (replayed from a saved message) is already finished, so it
  // must never start a ticker. Previously every replayed chip started a 250ms
  // setInterval that nothing ever stopped: a chip whose result wasn't recorded
  // sat spinning "running 14m 32s" forever, and a long conversation accumulated
  // one live interval per chip. This is the "chips stuck loading" bug.
  if (!o.historical) startTimer();

  const markDone = (markHtml) => {
    stopTimer();
    icon.innerHTML = markHtml;
    chip.classList.remove("is-running");
  };
  chip._setResult = (res) => {
    markDone('<span class="tool-chip-done">✓</span>');
    chip.classList.add("is-done");
    badge.textContent = "done";
    const txt = String(res == null ? "" : res);
    // Truncate very long results in the detail view but keep full text via title.
    resultLine.textContent = txt.length > 1200 ? txt.slice(0, 1200) + "\n…(truncated)" : txt;
  };
  // A replayed chip whose result was never recorded: show it as finished with an
  // unknown outcome rather than as perpetually running.
  chip._setUnknown = () => {
    markDone('<span class="tool-chip-done">✓</span>');
    chip.classList.add("is-done");
    badge.textContent = "done";
    resultLine.textContent = "(result not recorded)";
  };
  chip._setError = (err) => {
    markDone('<span class="tool-chip-error">✕</span>');
    chip.classList.add("is-error");
    badge.textContent = "error";
    resultLabel.textContent = "Error";
    resultLine.textContent = String(err || "error");
  };
  // The turn ended while this tool was still in flight (aborted, or the engine
  // never settled the call). Without this the chip kept its ticker running
  // forever, showing "running 6m 05s" with an empty result — the single most
  // "broken-looking" thing in the chat.
  chip._setInterrupted = () => {
    markDone('<span class="tool-chip-error">–</span>');
    chip.classList.add("is-error");
    badge.textContent = "interrupted";
    resultLabel.textContent = "Interrupted";
    resultLine.textContent = "The turn ended before this tool returned.";
  };
  return chip;
}

// ---------- Chat scroll management ----------
// autoScroll tracks whether we should keep the log pinned to the bottom while
// streaming. It is set false when the user scrolls up and re-enabled on
// jump-to-latest / new conversation render.
let chatAutoScroll = true;
// chatAutoScroll is exported (read by other modules); only this module may
// REBIND it, so other modules set it through this mutator.
function setChatAutoScroll(v) { chatAutoScroll = v; }
// The REAL scrolling container is #chat-log (overflow-y: auto). Its parent
// #chat-scroll is overflow: hidden and NEVER scrolls — wiring the scroll logic
// to chatScroll made every pin a silent no-op (long conversations opened at
// the top and "Jump to latest" never appeared). Prefer chatLog; keep
// chatScroll as a fallback for any future layout where the roles swap.
function chatScroller() {
  if (TC.el.chatLog) return TC.el.chatLog;
  return TC.el.chatScroll;
}
function chatScrollListener() {
  const sc = chatScroller();
  if (!sc) return;
  const atBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 60;
  chatAutoScroll = atBottom;
  if (TC.el.chatJumpBtn) TC.el.chatJumpBtn.classList.toggle("hidden", atBottom);
}
function scrollChatBottom(smooth) {
  const sc = chatScroller();
  if (!sc) return;
  // Explicit behavior: CSS gives .chat-log `scroll-behavior: smooth`, which
  // would turn every "instant" pin during streaming into a laggy animation.
  // "instant" pins immediately; the jump button animates.
  if (smooth) { sc.scrollTo({ top: sc.scrollHeight, behavior: "smooth" }); }
  else { sc.scrollTo({ top: sc.scrollHeight, behavior: "instant" }); }
  chatAutoScroll = true;
  if (TC.el.chatJumpBtn) TC.el.chatJumpBtn.classList.add("hidden");
}
function maybeScrollChatBottom() { if (chatAutoScroll) scrollChatBottom(false); }

// ---------- Typing indicator ----------
function createTypingIndicator() {
  const row = document.createElement("div");
  row.className = "msg assistant typing-row";
  const dots = document.createElement("div");
  dots.className = "typing-dots";
  for (let i = 0; i < 3; i++) {
    const d = document.createElement("span");
    d.className = "typing-dot";
    dots.appendChild(d);
  }
  row.appendChild(dots);
  return row;
}

// ---------- Render: middle column (chat) ----------
function updateChatEmpty() {
  const c = TC.activeConversation();
  const hasMessages = !!(c && c.messages && c.messages.length);
  if (TC.el.chatEmpty) TC.el.chatEmpty.classList.toggle("hidden", hasMessages || !c);
}
function renderChat() {
  const c = TC.activeConversation();
  TC.el.chatLog.innerHTML = "";
  TC.syncCopyConvBtn();
  TC.syncTopNewButtons();
  if (!c) {
    TC.el.chatInput.placeholder = "Select or create a conversation…";
    TC.renderModelPicker();
    TC.renderEffortPicker();
    TC.renderBoardChip();
    TC.renderAttachmentStrip();
    chatAutoScroll = true;
    if (TC.el.chatJumpBtn) TC.el.chatJumpBtn.classList.add("hidden");
    updateChatEmpty();
    return;
  }
  TC.el.chatInput.placeholder = "Ask the orchestrator to build something…";
  TC.renderModelPicker();
  TC.renderEffortPicker();
  TC.renderBoardChip();
  TC.renderAttachmentStrip();

  for (const m of c.messages) {
    renderMessage(m);
  }
  // After a full history render, pin to the bottom and reset auto-scroll.
  chatAutoScroll = true;
  scrollChatBottom(false);
  updateChatEmpty();
  // The conversation being rendered is the one the user is looking at —
  // anything that arrived while it was in the background is now seen.
  if (TC.markConversationRead && c === TC.activeConversation()) {
    const before = c.readUpTo;
    TC.markConversationRead(c);
    if (before !== c.readUpTo) TC.paintConvIndicators();
  }
  TC.renderTokenEstimator();
}
function renderMessage(m) {
  const role = m.role || "system";
  // Thinking + tool chips live together in ONE collapsed activity card above the
  // message body — the same component the live run uses.
  if (m.thinking || (m.toolCalls && m.toolCalls.length)) {
    TC.el.chatLog.appendChild(buildActivityRecord(m));
  }
  const row = document.createElement("div");
  row.className = "msg " + role + (m.event ? " is-event" : "");

  // Role avatar — a small glyph label to the left of the bubble (Codex-style).
  const avatar = document.createElement("div");
  avatar.className = "msg-avatar";
  if (m.event) { avatar.textContent = "⤳"; avatar.classList.add("avatar-event"); }
  else if (role === "user") { avatar.textContent = "You"; avatar.classList.add("avatar-user"); }
  else if (role === "assistant") { avatar.textContent = "◆"; avatar.classList.add("avatar-assistant"); }
  else { avatar.textContent = "•"; avatar.classList.add("avatar-system"); }

  const col = document.createElement("div");
  col.className = "msg-col";

  // Role label row (hidden for system pills).
  if (role !== "system") {
    const lab = document.createElement("div");
    lab.className = "msg-role";
    lab.textContent = m.event ? "Agent event" : (role === "user" ? "You" : "Orchestrator");
    col.appendChild(lab);
  }

  const body = document.createElement("div");
  body.className = "msg-body";
  if (role === "assistant") {
    body.innerHTML = TC.renderMarkdown(m.content || "");
  } else if (role === "user") {
    body.innerHTML = TC.renderMarkdown(m.content || "");
  } else {
    // System messages: keep plain (escaped) text, no markdown.
    body.innerHTML = m.content ? m.content.split(/\n\n+/).map((p) => "<p>" + TC.esc(p).replace(/\n/g, "<br>") + "</p>").join("") : "";
  }
  col.appendChild(body);
  if (role !== "system") { row.appendChild(avatar); }
  row.appendChild(col);
  TC.el.chatLog.appendChild(row);
  return row;
}

// ---------- Model list loading (with first-install retry) ----------
// models is populated ONLY here. Callers re-render the pickers when it arrives
// so a list that lands late (fresh install warm-up) fills the dropdown without
// an app restart.
// --- exports ---
Object.defineProperty(TC, "chatAutoScroll", { get: () => chatAutoScroll, set: (v) => { chatAutoScroll = v; }, configurable: true });
TC.createThinkingWidget = createThinkingWidget;
TC.createActivityCard = createActivityCard;
TC.buildActivityRecord = buildActivityRecord;
TC.createToolChip = createToolChip;
TC.setChatAutoScroll = setChatAutoScroll;
TC.chatScrollListener = chatScrollListener;
TC.scrollChatBottom = scrollChatBottom;
TC.maybeScrollChatBottom = maybeScrollChatBottom;
TC.createTypingIndicator = createTypingIndicator;
TC.updateChatEmpty = updateChatEmpty;
TC.renderChat = renderChat;
TC.renderMessage = renderMessage;
})();
