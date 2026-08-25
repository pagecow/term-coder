// 22-resizers.js — classic script (converted from an ES module; see REFACTOR_PLAN.md).
// Exports are registered on the shared window.termCoder namespace (TC).
(function () {
"use strict";
const TC = window.termCoder = window.termCoder || {};
const RZ_W = 5; // keep in sync with --rz-width in style.css
const COL_MIN = { projects: 180, chat: 360, terminals: 300 };

function shellEl() { return document.querySelector(".app-shell"); }

function currentColWidths() {
  const shell = shellEl();
  const proj = document.querySelector(".col-projects");
  const chat = document.querySelector(".col-chat");
  return {
    total: (shell && shell.clientWidth) || window.innerWidth,
    projects: proj ? proj.getBoundingClientRect().width : 264,
    chat: chat ? chat.getBoundingClientRect().width : 460,
  };
}

// Set both track widths at once, clamped so no column can be crushed below its
// minimum — including after the window itself has been made smaller than the
// widths that were saved.
function applyColWidths(projects, chat, opts) {
  const o = opts || {};
  const shell = shellEl();
  if (!shell) return;
  const cur = currentColWidths();
  const editorOpen = !TC.el.editor.classList.contains("hidden");
  const editorW = editorOpen
    ? (parseFloat(getComputedStyle(shell).getPropertyValue("--col-editor")) || TC.editorState.size)
    : 0;
  const resizerW = editorOpen ? 3 * RZ_W : 2 * RZ_W;
  const avail = cur.total - resizerW - editorW;
  let p = Math.round(projects != null ? projects : cur.projects);
  p = Math.max(COL_MIN.projects, p);
  p = Math.min(p, Math.max(COL_MIN.projects, avail - COL_MIN.chat - COL_MIN.terminals));
  let c = Math.round(chat != null ? chat : cur.chat);
  c = Math.max(COL_MIN.chat, c);
  c = Math.min(c, Math.max(COL_MIN.chat, avail - p - COL_MIN.terminals));
  shell.style.setProperty("--col-projects", p + "px");
  shell.style.setProperty("--col-chat", c + "px");
  if (o.persist) { TC.settings.layout = { projects: p, chat: c }; TC.saveSettings(); }
  // Refitting the PTY is relatively expensive, so only do it when the drag ends.
  if (o.fit) { for (const rec of TC.sessions.values()) TC.fitTerminal(rec); }
}

// Drop back to the responsive defaults in style.css.
function resetColWidths() {
  const shell = shellEl();
  if (!shell) return;
  shell.style.removeProperty("--col-projects");
  shell.style.removeProperty("--col-chat");
  delete TC.settings.layout;
  TC.saveSettings();
  for (const rec of TC.sessions.values()) TC.fitTerminal(rec);
}

function initColumnResizers() {
  // Restore a saved layout (clamped to the current window).
  const L = TC.settings.layout;
  if (L && L.projects && L.chat) applyColWidths(L.projects, L.chat, { fit: false });

  const bind = (handle, which) => {
    if (!handle) return;
    let startX = 0, startP = 0, startC = 0, dragging = false;
    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      if (which === "projects") applyColWidths(startP + dx, startC, {});
      else applyColWidths(startP, startC + dx, {});
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove("is-dragging");
      document.body.classList.remove("is-resizing");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const cur = currentColWidths();
      applyColWidths(cur.projects, cur.chat, { persist: true, fit: true });
    };
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const cur = currentColWidths();
      startX = e.clientX; startP = cur.projects; startC = cur.chat;
      dragging = true;
      handle.classList.add("is-dragging");
      document.body.classList.add("is-resizing");
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
    // Keyboard-resizable (the handle is a focusable role="separator").
    handle.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 32 : 8;
      let d = 0;
      if (e.key === "ArrowLeft") d = -step;
      else if (e.key === "ArrowRight") d = step;
      else return;
      e.preventDefault();
      const cur = currentColWidths();
      if (which === "projects") applyColWidths(cur.projects + d, cur.chat, { persist: true, fit: true });
      else applyColWidths(cur.projects, cur.chat + d, { persist: true, fit: true });
    });
    handle.addEventListener("dblclick", resetColWidths);
    handle.title = "Drag to resize · double-click to reset";
  };
  bind(TC.$("rz-projects"), "projects");
  bind(TC.$("rz-chat"), "chat");
}

// ---------- Terminal resize (columns width / rows height) ----------
// Each terminal square carries two drag handles: a vertical one on its right
// edge (columns view → width) and a horizontal one on its bottom edge (rows
// view → height). Only the handle matching the active view is shown (CSS), and
// only that one is draggable. Sizes are applied as inline CSS variables
// (--term-w / --term-h) so they survive view switches; the live PTY refits
// automatically via each mount's ResizeObserver as the box changes.
const TERM_MIN_W = 200; // min column width (px)
const TERM_MIN_H = 120; // min row height (px)

function initTermResize() {
  if (!TC.el.termGrid) return;
  let drag = null;

  const onMove = (e) => {
    if (!drag) return;
    const delta = (drag.axis === "x" ? e.clientX : e.clientY) - drag.startPos;
    const min = drag.axis === "x" ? TERM_MIN_W : TERM_MIN_H;
    const size = Math.max(min, drag.startSize + delta);
    drag.square.style.setProperty(drag.axis === "x" ? "--term-w" : "--term-h", size + "px");
  };
  const onUp = () => {
    if (!drag) return;
    const handle = drag.handle;
    drag = null;
    if (handle) handle.classList.remove("is-dragging");
    document.body.classList.remove("is-resizing", "is-resizing-row");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
  };

  TC.el.termGrid.addEventListener("pointerdown", (e) => {
    const handle = e.target.closest && e.target.closest(".term-resize-handle");
    if (!handle) return;
    const square = handle.closest(".term-square");
    if (!square) return;
    const axis = handle.classList.contains("term-resize-handle-x") ? "x" : "y";
    // Only the handle matching the current view is active (the other is hidden
    // by CSS, but guard against a stale handle during a view transition).
    if (axis === "x" && !TC.el.termGrid.classList.contains("view-columns")) return;
    if (axis === "y" && !TC.el.termGrid.classList.contains("view-rows")) return;
    if (square.classList.contains("expanded")) return;

    e.preventDefault();
    e.stopPropagation();
    const rect = square.getBoundingClientRect();
    drag = {
      square,
      handle,
      axis,
      startPos: axis === "x" ? e.clientX : e.clientY,
      startSize: axis === "x" ? rect.width : rect.height,
    };
    handle.classList.add("is-dragging");
    document.body.classList.add(axis === "x" ? "is-resizing" : "is-resizing-row");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  });

  // A click on a handle (no drag) must not select the session — swallow it in
  // the capture phase so it never reaches the square's click listener.
  TC.el.termGrid.addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest(".term-resize-handle")) {
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);
}

// ============================================================
// USER TERMINAL — bottom drawer
// ============================================================
// A terminal the USER controls directly. It is NOT one of the orchestrator's
// AI sessions on the right — the orchestrator never spawns it, drives it, or
// reads it. It slides up from the bottom of the screen as a drawer and hosts a
// live interactive xterm running in the current project's working directory.
//
// The live session is kept alive across open/close toggles so reopening is
// instant. We persist a tiny "open" flag + last height to scopedData so the
// drawer can restore its open state and size across app restarts, but the live
// PTY itself is gone after a restart (terminals are not portable across boots),
// so on reopen we respawn a fresh shell if the drawer was open.
// --- exports ---
Object.defineProperty(TC, "RZ_W", { get: () => RZ_W, configurable: true });
Object.defineProperty(TC, "COL_MIN", { get: () => COL_MIN, configurable: true });
Object.defineProperty(TC, "TERM_MIN_W", { get: () => TERM_MIN_W, configurable: true });
Object.defineProperty(TC, "TERM_MIN_H", { get: () => TERM_MIN_H, configurable: true });
TC.shellEl = shellEl;
TC.currentColWidths = currentColWidths;
TC.applyColWidths = applyColWidths;
TC.resetColWidths = resetColWidths;
TC.initColumnResizers = initColumnResizers;
TC.initTermResize = initTermResize;
})();
