import { abortController, defaultModelId, models, running } from "./00-state.js";
import { sqlitePersistToolCall } from "./02-sqlite.js";
import { $, el } from "./04-dom.js";
import { activeConversation, normalizeToolCall, saveState, setStatus, uuid } from "./05-util.js";
import { ORCHESTRATOR_TOOLS, toolHandler } from "./06-tools.js";
import { nameFromFirstMessage, renderProjects } from "./11-projects.js";
import { renderMarkdown } from "./12-markdown.js";
import { chatAutoScroll, createActivityCard, createThinkingWidget, createToolChip, createTypingIndicator, maybeScrollChatBottom, renderMessage, scrollChatBottom, updateChatEmpty } from "./13-chat.js";
import { selectedEffort, selectedModel } from "./14-models.js";
import { renderTokenEstimator } from "./15-tokens.js";
import { buildMessageContent, clearAttachments } from "./16-attachments.js";
import { buildSystemPrompt } from "./17-system-prompt.js";
import { renderSessionInfo } from "./20-terminal.js";
import { pendingChoices } from "./21-askchoice.js";
export const TOOL_TIMEOUT_MS = 90 * 1000;
export const TOOL_TIMEOUT_OVERRIDES = { wait_for_session: 15 * 60 * 1000 };
export async function runToolWithTimeout(name, args, signal) {
  const limit = TOOL_TIMEOUT_OVERRIDES[name] || TOOL_TIMEOUT_MS;
  let timer = null;
  let onAbort = null;
  // Race the tool against the turn's abort signal too, so an interrupt (Stop or
  // interruptAndSend) ends the turn promptly instead of waiting out a long tool
  // call (wait_for_session can run 15 minutes). The abandoned toolHandler keeps
  // running in the background — its side effects (a spawned session, a merge)
  // still complete and the next turn sees them via list_sessions.
  const abortPromise = new Promise((resolve) => {
    if (!signal) return;
    onAbort = () => resolve("Error: interrupted by the user.");
    if (signal.aborted) { onAbort(); return; }
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([
      toolHandler(name, args),
      abortPromise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(
          "Error: the " + name + " tool did not return within " + Math.round(limit / 1000) +
          "s and was abandoned. This usually means it is blocked on something outside the app — most often an unanswered terminal-permission prompt. Tell the user what you were trying to do and ask them to check for a pending approval, then continue with something else."
        ), limit);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort && signal && typeof signal.removeEventListener === 'function') {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

export function setRunning(r) {
  running = r;
  syncSendButton();
  // The composer stays ENABLED while a turn runs so the user can interrupt the
  // orchestrator with a new message (see interruptAndSend). Only the placeholder
  // changes to advertise that.
  if (r) {
    el.chatInput.placeholder = "Type to interrupt the orchestrator…";
  } else {
    el.chatInput.placeholder = activeConversation() ? "Ask the orchestrator to build something…" : "Select or create a conversation…";
  }
}

// The send button doubles as Stop while a turn runs. When the user has typed a
// message, the button flips back to Send — submitting it interrupts the current
// turn and delivers the message (see interruptAndSend).
export function syncSendButton() {
  const hasText = !!(el.chatInput && el.chatInput.value && el.chatInput.value.trim());
  const isStop = running && !hasText;
  el.sendBtn.classList.toggle("is-running", isStop);
  el.sendBtn.title = isStop ? "Stop" : "Send";
  el.sendBtn.setAttribute("aria-label", isStop ? "Stop" : "Send");
  if (el.sendIcon) el.sendIcon.classList.toggle("hidden", isStop);
  if (el.stopIcon) el.stopIcon.classList.toggle("hidden", !isStop);
}

// textOverride lets the app itself start a turn (see autoFollowTick). opts.event
// marks the message as an app-generated event so it renders distinctly from
// something the user actually typed.
export async function sendMessage(textOverride, opts) {
  const o = opts || {};
  const c = activeConversation();
  if (!c) { setStatus("Select or create a conversation first."); return; }
  if (running) return;
  // An app-generated/event turn (e.g. an auto-follow wake) must NOT start
  // while a permission/choice prompt is awaiting the user — it would create a
  // fresh streaming UI on top of the active prompt. Drop it; the next
  // autoFollowTick retries once the prompt is answered. This guard only
  // applies to event (automatic) sends, so a user who deliberately types
  // while a prompt is up can still send.
  if (o.event && pendingChoices > 0) return;
  const text = textOverride != null ? String(textOverride).trim() : el.chatInput.value.trim();
  if (!text) return;
  if (textOverride == null) el.chatInput.value = "";

  // Build the user message content: if there are attachments, embed file
  // contents and pass images as multimodal parts; otherwise just the text.
  const content = buildMessageContent(text);
  const userMsg = { role: "user", content };
  if (o.event) userMsg.event = true;
  // Clear the attachment strip after the message is consumed.
  if (textOverride == null) clearAttachments();
  // Name the conversation from the user's first real (non-event) message,
  // replacing the "Conversation N" placeholder — but only if the user hasn't
  // already renamed it by hand. This covers every conversation regardless of
  // how it was created, since all user messages enter through sendMessage.
  const wasFirstUserMsg = !c.messages.some((m) => m.role === "user" && !m.event);
  let renamedConv = false;
  if (wasFirstUserMsg && !o.event && /^Conversation \d+$/.test(c.name)) {
    c.name = nameFromFirstMessage(text, c.name);
    renamedConv = true;
  }
  c.messages.push(userMsg);
  saveState();
  // The conversation is hidden from the sidebar until its first post — reveal
  // it now (also renames the "Conversation N" placeholder on that same post).
  if (renamedConv || (wasFirstUserMsg && !o.event)) { renderProjects(); renderSessionInfo(); }
  renderMessage(userMsg);
  scrollChatBottom(false);
  updateChatEmpty();

  await runOrchestratorTurn(c);
}

// Runs ONE orchestrator turn for the given conversation: streams the reply,
// executes tool calls, and persists the assistant message. Extracted from
// sendMessage so interruptAndSend can start a fresh turn after aborting an
// in-flight one. Callers must have already pushed the user message.
export async function runOrchestratorTurn(c) {
  setRunning(true);
  setStatus("Generating…");
  abortController = new AbortController();
  chatAutoScroll = true;

  // Snapshot the picker choices onto the conversation so history replays
  // with the same model/effort that was actually used.
  const modelId = selectedModel() || defaultModelId;
  const modelInfo = models.find((m) => m.id === modelId);
  const canThink = !!(modelInfo && modelInfo.capabilities && modelInfo.capabilities.includes("reasoning"));
  const effort = selectedEffort();
  if (modelId) { c.modelId = modelId; }
  // Persist the effort if one was chosen, even if the model doesn't explicitly
  // advertise "reasoning" in capabilities — many cloud models accept an effort
  // override even when listModels() doesn't enumerate the levels.
  c.effort = effort || null;
  saveState();

  // Typing indicator — shown until the first content token streams in.
  const typingRow = createTypingIndicator();
  el.chatLog.appendChild(typingRow);
  maybeScrollChatBottom();

  // Live assistant row — MUST be in the DOM before streaming so tokens are
  // visible and tool chips can be inserted before it. Hidden until first token.
  const liveRow = document.createElement("div");
  liveRow.className = "msg assistant is-streaming";
  liveRow.style.display = "none";
  const liveAvatar = document.createElement("div");
  liveAvatar.className = "msg-avatar avatar-assistant";
  liveAvatar.textContent = "◆";
  const liveCol = document.createElement("div");
  liveCol.className = "msg-col";
  const liveLabel = document.createElement("div");
  liveLabel.className = "msg-role";
  liveLabel.textContent = "Orchestrator";
  const liveBody = document.createElement("div");
  liveBody.className = "msg-body";
  liveCol.appendChild(liveLabel);
  liveCol.appendChild(liveBody);
  liveRow.appendChild(liveAvatar);
  liveRow.appendChild(liveCol);
  el.chatLog.appendChild(liveRow);

  let liveThink = null;
  let accContent = "";
  let accThink = "";
  const liveToolCalls = [];
  // Chip elements for this turn, so any still spinning when the turn ends can be
  // resolved instead of ticking forever.
  const liveChips = [];
  let firstTokenSeen = false;
  // Set when a tool call lands, so the next text token starts a new paragraph
  // instead of butting up against the previous segment's final word.
  let segmentBreakPending = false;

  // Stable activity card — holds thinking + all tool chips at a fixed height so
  // the layout never grows/jumps while tools fire. Created lazily on the first
  // thinking token or tool call, and collapsed to a compact pill on completion.
  let activityCard = null;
  const ensureActivityCard = () => {
    if (!activityCard) {
      activityCard = createActivityCard();
      el.chatLog.insertBefore(activityCard, liveRow);
    }
    return activityCard;
  };

  // rAF-throttled re-render so a burst of tokens only repaints once per frame —
  // keeps streaming smooth with no layout jank. The streaming cursor is shown
  // while tokens are incoming and removed on the final render.
  let rafId = 0;
  const flushContent = () => {
    rafId = 0;
    liveBody.innerHTML = renderMarkdown(accContent) + '<span class="md-stream-cursor" aria-hidden="true"></span>';
    maybeScrollChatBottom();
  };
  const scheduleFlush = () => {
    if (rafId) return;
    rafId = requestAnimationFrame(flushContent);
  };

  try {
    const systemPrompt = await buildSystemPrompt();
    const msgs = [{ role: "system", content: systemPrompt }];
    for (const m of c.messages) {
      if (m.role === "user" || m.role === "assistant") {
        msgs.push({ role: m.role, content: m.content || "" });
      }
    }

    const result = await window.chatoss.chat.runTurn({
      model: modelId,
      messages: msgs,
      tools: ORCHESTRATOR_TOOLS,
      onToken: (t) => {
        if (!t) return;
        if (!firstTokenSeen) {
          firstTokenSeen = true;
          typingRow.remove();
          liveRow.style.display = "";
        }
        // The engine streams a separate text segment per tool round. Concatenating
        // them raw ran sentences together across the boundary ("…improvements.Now
        // I'll spawn…"), so start a new paragraph when a tool call interrupted
        // the prose.
        if (segmentBreakPending) {
          segmentBreakPending = false;
          if (accContent && !/\n\n$/.test(accContent)) accContent += "\n\n";
        }
        accContent += t;
        scheduleFlush();
      },
      onThinking: (t) => {
        if (!t) return;
        if (!firstTokenSeen) {
          // Thinking before content: drop the typing dots, keep live row hidden.
          firstTokenSeen = true;
          typingRow.remove();
        }
        if (!liveThink) {
          liveThink = createThinkingWidget("", { streaming: true });
          ensureActivityCard()._addThinking(liveThink);
          maybeScrollChatBottom();
        }
        accThink += t;
        liveThink._update(accThink);
      },
      onToolCall: async (call) => {
        const { name, args } = normalizeToolCall(call);
        const entry = { id: uuid(), name, args, result: undefined, error: undefined };
        liveToolCalls.push(entry);
        // Persist the tool call to SQLite as it happens (result updated below),
        // so tool history survives even if the app dies mid-turn.
        sqlitePersistToolCall(c.id, entry);
        if (!firstTokenSeen) {
          firstTokenSeen = true;
          typingRow.remove();
          liveRow.style.display = "";
        }
        // Add a compact chip inside the stable activity card (fixed height,
        // internal scroll) so the layout never jumps as tools fire.
        const chip = createToolChip(name, args);
        liveChips.push(chip);
        ensureActivityCard()._addChip(chip);
        if (accContent) segmentBreakPending = true;
        maybeScrollChatBottom();
        try {
          const res = await runToolWithTimeout(name, args, abortController.signal);
          entry.result = res;
          sqlitePersistToolCall(c.id, entry);
          chip._setResult(res);
          return res; // string result feeds back into the engine's tool loop
        } catch (e) {
          const err = "Error: " + (e && e.message ? e.message : String(e));
          entry.error = err;
          sqlitePersistToolCall(c.id, entry);
          chip._setError(err);
          return err;
        }
      },
      think: canThink || !!effort,            // request reasoning if the model supports it OR the user asked for an effort level
      thinkLevel: effort || undefined,         // pass the chosen level when set; undefined lets the model use its default
      signal: abortController.signal,
    });

    // Flush any tail content that was queued behind a rAF, then drop the cursor.
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    liveBody.innerHTML = renderMarkdown(accContent);
    if (liveThink) liveThink._finalize();

    const content = result && result.content ? result.content : accContent;
    const thinking = result && result.thinking ? result.thinking : accThink;

    if (result && result.aborted) {
      setStatus(interruptDeliveryActive ? "Interrupted — continuing…" : "Stopped");
    } else {
      setStatus("");
    }

    typingRow.remove();
    liveRow.remove();
    // Remove the LIVE activity card — renderMessage below rebuilds an identical
    // collapsed card from the saved message. Keeping both produced two copies of
    // every thinking widget and tool chip on screen.
    if (activityCard) activityCard.remove();

    let storedToolCalls = liveToolCalls.length ? liveToolCalls : undefined;
    if (result && result.toolCalls && result.toolCalls.length) {
      // The engine's toolCalls list is authoritative for WHAT ran, but it carries
      // no results — those only exist in the liveToolCalls entries we filled in
      // from onToolCall. Overwriting wholesale (the old behaviour) discarded every
      // result, so replayed chips had nothing to show and rendered as unfinished.
      // Merge instead: consume live entries in order, matched by tool name.
      const pending = liveToolCalls.slice();
      storedToolCalls = result.toolCalls.map(normalizeToolCall).map((tc) => {
        const i = pending.findIndex((p) => p.name === tc.name);
        if (i === -1) return tc;
        const live = pending.splice(i, 1)[0];
        return { name: tc.name, args: tc.args, result: live.result, error: live.error };
      });
    }
    // When this abort was an interrupt-and-continue delivery (interruptAndSend),
    // the user's new message is ALREADY in history and a fresh turn starts the
    // moment this one unwinds. Don't save a partial assistant reply — it would
    // sit AFTER the user's new message in history and confuse the next turn.
    if (!(result && result.aborted && interruptDeliveryActive)) {
      c.messages.push({
        role: "assistant",
        content: content || "(no response)",
        thinking: thinking || undefined,
        toolCalls: storedToolCalls,
      });
      saveState();
      renderMessage(c.messages[c.messages.length - 1]);
      maybeScrollChatBottom();
    }
  } catch (e) {
    typingRow.remove();
    liveRow.remove();
    // On error there is no saved assistant message to rebuild the card from, so
    // KEEP the live card (collapsed) — it's the only record of what ran.
    if (activityCard) activityCard._finish();
    setStatus("");
    if (interruptDeliveryActive) {
      // The abort was an interrupt-and-continue delivery: the user's new message
      // is already in history and a fresh turn starts right after this unwinds.
      // Don't record a spurious error/system message for the interrupted turn.
    } else {
      const msg = "Error: " + (e && e.message ? e.message : String(e));
      c.messages.push({ role: "system", content: msg });
      saveState();
      renderMessage({ role: "system", content: msg });
      maybeScrollChatBottom();
    }
  } finally {
    // Nothing may be left spinning. If the turn ended (normally, by error, or by
    // abort) while a tool call was still outstanding, mark those chips
    // interrupted so they stop their tickers and read honestly.
    for (const ch of liveChips) {
      if (ch.classList.contains("is-running") && typeof ch._setInterrupted === "function") ch._setInterrupted();
    }
    setRunning(false);
    abortController = null;
    renderTokenEstimator();
  }
}

// ---------- Mid-run delivery: message the orchestrator while it works ----------
// While a turn is running the composer stays enabled. Sending a message then
// INTERRUPTS the in-flight turn and the orchestrator CONTINUES with the new
// message: the message is shown in the chat immediately, the current turn is
// aborted, and once it has fully unwound a fresh turn starts with the message
// in history (the same streaming path as a normal send).
//
// The orchestrator here is the chat model (chatApi.runTurn), not a CLI session,
// so "deliver to the orchestrator" = abort the in-flight runTurn and start the
// next one. (Sub-agent CLI sessions are driven by the orchestrator's own
// send_to_session tool, which already uses paste() + key('enter').)
export let midRunDeliveryInFlight = false;   // double-submission guard
export let interruptDeliveryActive = false;   // set while aborting for a delivery, so the
                                      // interrupted turn skips saving a partial reply

// Resolves when the in-flight orchestrator turn has fully unwound (its finally
// clears `running`). The abort signal makes the engine end the turn promptly;
// the timeout is a safety net so a stuck turn can never wedge the composer.
export function waitForTurnEnd(timeoutMs) {
  const limit = timeoutMs || 30000;
  return new Promise((resolve) => {
    if (!running) { resolve(); return; }
    const started = Date.now();
    const iv = setInterval(() => {
      if (!running || Date.now() - started >= limit) {
        clearInterval(iv);
        resolve();
      }
    }, 100);
  });
}

export async function interruptAndSend(text) {
  if (midRunDeliveryInFlight) {
    setStatus("Already delivering your previous message — one moment…");
    return;
  }
  const c = activeConversation();
  if (!c) { setStatus("Select or create a conversation first."); return; }
  midRunDeliveryInFlight = true;
  try {
    // 1. Show the user message immediately (same naming logic as sendMessage).
    const userMsg = { role: "user", content: text };
    const wasFirstUserMsg = !c.messages.some((m) => m.role === "user" && !m.event);
    let renamedConv = false;
    if (wasFirstUserMsg && /^Conversation \d+$/.test(c.name)) {
      c.name = nameFromFirstMessage(text, c.name);
      renamedConv = true;
    }
    c.messages.push(userMsg);
    saveState();
    // Reveal in the sidebar on first post (see sendMessage).
    if (renamedConv || wasFirstUserMsg) { renderProjects(); renderSessionInfo(); }
    const userRow = renderMessage(userMsg);
    scrollChatBottom(false);
    updateChatEmpty();
    el.chatInput.value = "";
    el.chatInput.style.height = "auto"; // reset the auto-resized composer
    syncSendButton();                   // empty composer + running → back to Stop

    // 2. Interrupt the in-flight turn.
    interruptDeliveryActive = true;
    if (abortController) abortController.abort();

    // 3. Wait for the old turn to fully unwind (its finally clears `running`).
    await waitForTurnEnd();
    if (running) {
      // Safety net: the turn ignored the abort (shouldn't happen — tool calls
      // race the abort signal). Leave the message in history; the user can
      // retry once the turn ends.
      interruptDeliveryActive = false;
      midRunDeliveryInFlight = false;
      setStatus("The current step is still finishing — try again in a moment.");
      return;
    }

    // 4. If the old turn finished on its own (not aborted) while we waited, it
    //    pushed its assistant reply AFTER our user message. Move our message to
    //    the end so history order stays user → assistant, and mirror the move in
    //    the DOM.
    const idx = c.messages.indexOf(userMsg);
    if (idx !== -1 && idx < c.messages.length - 1) {
      c.messages.splice(idx, 1);
      c.messages.push(userMsg);
      saveState();
      if (userRow && userRow.parentNode === el.chatLog) el.chatLog.appendChild(userRow);
    }

    // 5. Continue with the new message. Clear the delivery markers FIRST so this
    //    new turn can itself be interrupted the same way.
    interruptDeliveryActive = false;
    midRunDeliveryInFlight = false;
    await runOrchestratorTurn(c);
  } catch (e) {
    interruptDeliveryActive = false;
    midRunDeliveryInFlight = false;
    setStatus("Interrupt failed: " + (e && e.message ? e.message : String(e)));
  }
}

// ---------- Auto-follow: wake the orchestrator when an agent stops ----------
// Coding CLIs are REPLs — they finish a task and sit at their prompt forever.
// Nothing in the app used to react to that, so after spawning agents the
// orchestrator went silent until the user typed something, which is what made
// the whole loop feel like it had stalled. This watcher notices a delegated
// session finishing its turn (or exiting, or getting blocked) and starts one
// orchestrator turn so it can review, merge, and move the plan forward.
