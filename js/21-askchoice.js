// 21-askchoice.js — classic script (converted from an ES module; see REFACTOR_PLAN.md).
// Exports are registered on the shared window.termCoder namespace (TC).
(function () {
"use strict";
const TC = window.termCoder = window.termCoder || {};
window.termCoder = window.termCoder || {};

// Count of askChoice prompts currently awaiting the user. A permission/approval
// question can land WHILE an orchestrator turn is still streaming (e.g. a
// merge_worktree tool call fires askChoice inside onToolCall), so the live
// "thinking" indicators — typing dots, the streaming caret, spinning tool
// chips, the status pulse — would keep animating on top of / around the
// permission content. While a prompt is up we pause those animations (via the
// .chat-prompt-pending class below) and block new auto-follow turns from
// starting a fresh streaming UI on top of it. The underlying turn keeps
// running; only the visual spinners pause, and they resume the instant the
// last pending prompt is answered.
let pendingChoices = 0;

// Toggle the "a choice is pending" state on the chat column. The CSS rules
// scoped to .chat-prompt-pending freeze the thinking-indicator animations and
// make the overlay opaque so no streaming content shows through around the
// prompt. Idempotent: adding when already on / removing when already off is a
// no-op. Robust to the document.body fallback host (no .col-chat ancestor).
function setPromptPending(on) {
  let target = null;
  if (typeof TC.el !== "undefined" && TC.el && TC.el.chatOverlay) {
    target = TC.el.chatOverlay.closest ? TC.el.chatOverlay.closest(".col-chat") : null;
  }
  if (!target) target = document.querySelector(".col-chat") || document.body;
  if (on) target.classList.add("chat-prompt-pending");
  else target.classList.remove("chat-prompt-pending");
}

window.termCoder.askChoice = function askChoice(config) {
  return new Promise((resolve) => {
    const cfg = config || {};
    const promptText = typeof cfg.prompt === "string" ? cfg.prompt : "";
    const opts = Array.isArray(cfg.options) ? cfg.options : [];
    const styleMode = cfg.style === "pill" ? "pill" : "rect"; // default rect

    // Render into a persistent overlay container, NOT inside chatLog, so the
    // pill picker survives renderChat() full-history re-renders (which clear
    // chatLog.innerHTML). The overlay sits above the chat log.
    let host = (typeof TC.el !== "undefined" && TC.el && TC.el.chatOverlay) ? TC.el.chatOverlay : null;
    if (!host) host = document.body;

    // --- message bubble -------------------------------------------------
    const row = document.createElement("div");
    row.className = "msg assistant choice-msg";

    const body = document.createElement("div");
    body.className = "choice-body";
    row.appendChild(body);

    if (promptText) {
      const promptEl = document.createElement("div");
      promptEl.className = "choice-prompt";
      // Render the prompt as markdown for a polished look (safe: escaped inside).
      promptEl.innerHTML = TC.renderMarkdown(promptText);
      body.appendChild(promptEl);
    }

    // options container
    const optsWrap = document.createElement("div");
    optsWrap.className = "choice-options choice-" + styleMode;
    body.appendChild(optsWrap);

    // waiting hint
    const waitHint = document.createElement("div");
    waitHint.className = "choice-waiting";
    waitHint.textContent = "waiting for your selection…";
    body.appendChild(waitHint);

    let settled = false;
    const btns = [];

    function finish(clickedBtn, value) {
      if (settled) return;
      settled = true;
      // Always detach the capturing keydown listener. It used to be removed only
      // on the Escape path, so every picker answered by CLICK leaked a
      // document-level capturing listener for the lifetime of the app.
      // (onKey is a hoisted function declaration, so this reference is safe.)
      document.removeEventListener("keydown", onKey, true);
      waitHint.classList.add("hidden");
      // disable every button; dim the un-chosen ones, highlight the chosen
      for (const b of btns) {
        b.disabled = true;
        if (b !== clickedBtn) b.classList.add("choice-dimmed");
      }
      // One fewer prompt awaiting the user. When the last one is answered,
      // release the "prompt pending" state so the paused thinking-indicator
      // animations resume (the orchestrator turn may still be streaming) and
      // auto-follow turns may fire again.
      pendingChoices = Math.max(0, pendingChoices - 1);
      if (pendingChoices === 0) setPromptPending(false);
      resolve(value);
      // Auto-dismiss the popup after a brief moment so the user sees their
      // selection confirmed, then it fades away instead of blocking the input.
      setTimeout(() => {
        if (row && row.parentNode) {
          row.style.transition = "opacity .3s ease";
          row.style.opacity = "0";
          setTimeout(() => { if (row.parentNode) row.parentNode.removeChild(row); }, 300);
        }
      }, 1200);
    }

    for (const opt of opts) {
      if (!opt || typeof opt !== "object") continue;
      const label = opt.label != null ? String(opt.label) : String(opt.value);
      const value = opt.value != null ? String(opt.value) : label;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "choice-btn";
      btn.textContent = label;
      btn.addEventListener("click", () => {
        if (settled) return;
        btn.classList.add("choice-selected");
        finish(btn, value);
        if (typeof TC.scrollChatBottom === "function") TC.scrollChatBottom();
      });
      optsWrap.appendChild(btn);
      btns.push(btn);
    }

    // No options -> nothing to pick; resolve null.
    if (!btns.length) {
      waitHint.textContent = "no options provided";
      finish(null, null);
    }

    // Escape dismisses -> resolve null (cancel). Listens only while pending;
    // finish() detaches this listener on every path.
    function onKey(e) {
      if (e.key !== "Escape" || settled) return;
      e.stopPropagation();
      finish(null, null);
      if (typeof TC.scrollChatBottom === "function") TC.scrollChatBottom();
    }
    document.addEventListener("keydown", onKey, true);

    // Mark a prompt as pending: pause the live thinking-indicator animations
    // (typing dots / streaming caret / spinning tool chips / status pulse) so
    // they don't keep animating on top of / around the permission content, and
    // make the overlay opaque so streaming UI behind it is occluded. Only do
    // this for a real prompt (>=1 option) — the no-options path resolves
    // immediately and never actually awaits the user.
    if (btns.length) {
      pendingChoices++;
      setPromptPending(true);
    }
    host.appendChild(row);
    if (typeof TC.scrollChatBottom === "function") TC.scrollChatBottom();
  });
};

// Keep the askChoice overlay clear of the composer stack. The overlay is
// absolutely positioned in .col-chat, and the block below it (status line +
// composer + hint + session info) changes height as the textarea grows and as
// the status line appears — so its offset has to be measured, not hard-coded.
function syncOverlayOffset() {
  const chatCol = document.querySelector(".col-chat");
  if (!chatCol) return;
  let h = 0;
  for (const sel of [".chat-status", ".composer-wrap", ".session-info"]) {
    const node = chatCol.querySelector(sel);
    if (node) h += node.getBoundingClientRect().height;
  }
  chatCol.style.setProperty("--overlay-bottom", Math.round(h + 10) + "px");
}

// Held at module scope on purpose: a ResizeObserver with no strong reference can
// be collected, silently stopping the resync.
let overlayRO = null;
function initOverlayOffset() {
  syncOverlayOffset();
  window.addEventListener("resize", syncOverlayOffset);
  // A ResizeObserver catches height changes we don't have an explicit hook for,
  // but it only delivers on a rendered frame — so the two changes that actually
  // matter (the textarea growing, the status line appearing) ALSO call
  // syncOverlayOffset directly from autoResizeInput and setStatus.
  try {
    overlayRO = new ResizeObserver(syncOverlayOffset);
    for (const sel of [".chat-status", ".composer-wrap", ".session-info"]) {
      const node = document.querySelector(sel);
      if (node) overlayRO.observe(node);
    }
  } catch (e) { /* resize listener + explicit hooks still cover it */ }
}

// ---------- Column resizers ----------
// The three columns are grid tracks sized by two CSS variables on .app-shell.
// Dragging a handle writes px values; with no saved layout the variables keep
// their responsive defaults (minmax) so the grid still adapts to the window.
// --- exports ---
Object.defineProperty(TC, "pendingChoices", { get: () => pendingChoices, set: (v) => { pendingChoices = v; }, configurable: true });
Object.defineProperty(TC, "overlayRO", { get: () => overlayRO, set: (v) => { overlayRO = v; }, configurable: true });
TC.setPromptPending = setPromptPending;
TC.syncOverlayOffset = syncOverlayOffset;
TC.initOverlayOffset = initOverlayOffset;
})();
