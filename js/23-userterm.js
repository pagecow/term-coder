// 23-userterm.js — classic script (converted from an ES module; see REFACTOR_PLAN.md).
// Exports are registered on the shared window.termCoder namespace (TC).
(function () {
"use strict";
const TC = window.termCoder = window.termCoder || {};
const USER_TERM_KEY = "term-coder.userTerm";
let userTerm = {
  session: null,       // the live spawn() session handle (null when no shell)
  handle: null,        // the mount() dispose handle (null when not mounted)
  ro: null,            // ResizeObserver for the mount element
  open: false,         // whether the drawer is currently showing
  spawning: false,     // guard against concurrent spawn attempts
  cwd: null,           // cwd the current shell was started in
  persisted: { open: false, height: 0 }, // restored on boot
  cellW: 0,            // measured character cell width (px) — set after mount
  cellH: 0,            // measured character row height (px) — set after mount
  lastCols: 0,         // last cols we resized the PTY to (skip redundant resizes)
  lastRows: 0,         // last rows we resized the PTY to
};

// Resolve the working directory for the user terminal: the active project's
// folder, then the saved default cwd, then the root "/". Mirrors defaultCwd().
function userTermCwd() {
  const p = TC.getProject(TC.state.activeProjectId);
  if (p && p.folderPath) return p.folderPath;
  if (TC.settings.cwdDefault) return TC.settings.cwdDefault;
  return "/";
}

// Spawn a fresh interactive shell for the user terminal. Uses the SAME login-
// shell spawn pattern as the orchestrator sessions (zsh -l) so the user gets
// their full PATH. Accepts optional { cols, rows } so the PTY can be born at
// the drawer's REAL size — spawning at a placeholder size and resizing right
// after mount makes zsh re-render its prompt and leaves a stray "%" line.
async function userTermSpawn(dims) {
  if (userTerm.spawning) return null;
  userTerm.spawning = true;
  try {
    const cwd = userTermCwd();
    const d = dims || { cols: 90, rows: 24 };
    const session = await window.chatoss.terminal.spawn("zsh", {
      args: ["-l"],        // login shell, interactive — no command, so it drops to a prompt
      cwd,
      cols: d.cols,
      rows: d.rows,
    });
    userTerm.session = session;
    userTerm.cwd = cwd;
    if (TC.el.userTermCwd) {
      TC.el.userTermCwd.textContent = TC.basename(cwd);
      TC.el.userTermCwd.title = cwd;
    }
    // If the shell exits on its own (the user typed `exit`, or it crashed),
    // drop our references so the next open/restart spawns a fresh one.
    // Identity-guard: a Restart kills the OLD shell whose onExit fires AFTER
    // the new session is in place — without this check it would null out the
    // fresh session and the remounted terminal would vanish.
    try {
      if (session.onExit) {
        session.onExit(() => {
          if (userTerm.session !== session) return; // stale exit from a previous shell
          userTermUnmount();
          userTerm.session = null;
        });
      }
    } catch (e) { /* non-fatal */ }
    return session;
  } catch (e) {
    console.warn("user terminal spawn failed:", e);
    // Show an inline error so the user knows why the terminal is blank.
    if (TC.el.userTermMount) {
      const errEl = document.createElement("div");
      errEl.className = "term-mount-error";
      errEl.textContent = "Terminal failed to start: " + (e && e.message ? e.message : String(e));
      TC.el.userTermMount.appendChild(errEl);
    }
    return null;
  } finally {
    userTerm.spawning = false;
  }
}

// Mount the live xterm into the drawer's mount element. Reuses the exact
// terminal.mount bridge the orchestrator sessions use. Call AFTER the drawer
// is visible (mount needs a laid-out element to size the PTY).
async function userTermMount() {
  if (!userTerm.session || !TC.el.userTermMount) return;
  // Clear any prior error placeholder before mounting.
  for (const e of TC.el.userTermMount.querySelectorAll(".term-mount-error")) e.remove();
  try {
    const handle = await window.chatoss.terminal.mount(TC.el.userTermMount, userTerm.session.id, { fontSize: 13 });
    userTerm.handle = handle && handle.dispose ? handle : null;
  } catch (e) {
    console.warn("user terminal mount failed:", e);
    const errEl = document.createElement("div");
    errEl.className = "term-mount-error";
    errEl.textContent = "Terminal failed to load: " + (e && e.message ? e.message : String(e));
    TC.el.userTermMount.appendChild(errEl);
    return;
  }
  // Keep the PTY fitted to the drawer as it resizes.
  if (userTerm.ro) { try { userTerm.ro.disconnect(); } catch (e) { /* non-fatal */ } }
  try {
    const ro = new ResizeObserver(() => userTermFit());
    ro.observe(TC.el.userTermMount);
    userTerm.ro = ro;
  } catch (e) { /* non-fatal */ }
  // Re-measure the cell metrics from the xterm's ACTUAL computed font (now that
  // it's mounted) and fit immediately — synchronously, so the caller's post-
  // mount \x0c repaint (if any) lands AFTER the fit, not before it. The pre-spawn
  // probe used a best-guess font; if it was slightly off, this corrects the PTY
  // size now, and the "lastCols/lastRows" seed prevents a redundant double-resize.
  const m = measureUserTermCells();
  userTerm.cellW = m.cellW;
  userTerm.cellH = m.cellH;
  userTermFit();
}

// Measure the actual character cell dimensions for the xterm's font. We can't
// call the xterm instance's fit() directly (the mount handle only exposes
// dispose()), so we probe the font ourselves: render a block of characters in
// a hidden element with the SAME font-family and font-size the xterm uses, and
// divide the total width by the character count. This lets us compute the
// EXACT cols/rows the xterm will display — a hardcoded 7.8px approximation is
// wrong for most font/size combos and causes a PTY-width ≠ xterm-width
// mismatch, which makes zsh think every line is "partial" and print a stray
// "%" + spaces before each prompt.
function measureUserTermCells() {
  const mount = TC.el.userTermMount;
  if (!mount) return { cellW: 7.8, cellH: 16 };
  // After mount, read the font from the xterm's own root element so we match
  // exactly. Before mount (pre-spawn probe), fall back to the mount defaults.
  const xt = mount.querySelector(".xterm");
  let fontFamily = "monospace", fontSize = "13px";
  if (xt) {
    const cs = getComputedStyle(xt);
    if (cs.fontFamily) fontFamily = cs.fontFamily;
    if (cs.fontSize) fontSize = cs.fontSize;
  }
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:absolute;visibility:hidden;white-space:pre;" +
    "font-family:" + fontFamily + ";font-size:" + fontSize + ";" +
    "line-height:normal;display:inline-block;";
  probe.textContent = "M".repeat(200);
  mount.appendChild(probe);
  const rect = probe.getBoundingClientRect();
  mount.removeChild(probe);
  if (rect.width > 0 && rect.height > 0) {
    return { cellW: rect.width / 200, cellH: rect.height };
  }
  return { cellW: 7.8, cellH: 16 };
}

// Resize the PTY to match the mount element's box. Uses the MEASURED cell
// dimensions (not a hardcoded approximation) so the PTY cols exactly match the
// xterm's rendered cols — a mismatch makes zsh print a stray "%" partial-line
// marker before every prompt.
function userTermFit() {
  if (!userTerm.session || !TC.el.userTermMount) return;
  const w = TC.el.userTermMount.clientWidth;
  const h = TC.el.userTermMount.clientHeight;
  if (!w || !h) return;
  if (!userTerm.cellW || !userTerm.cellH) {
    const m = measureUserTermCells();
    userTerm.cellW = m.cellW;
    userTerm.cellH = m.cellH;
  }
  const cols = Math.max(20, Math.floor(w / userTerm.cellW));
  const rows = Math.max(5, Math.floor(h / userTerm.cellH));
  // Skip if unchanged — avoids SIGWINCH spam and the "%" artifact that every
  // unnecessary resize produces on a raw shell prompt.
  if (userTerm.lastCols === cols && userTerm.lastRows === rows) return;
  userTerm.lastCols = cols;
  userTerm.lastRows = rows;
  try { if (userTerm.session.resize) userTerm.session.resize(cols, rows); } catch (e) { /* non-fatal */ }
}

// Tear down the mount (NOT the session) so the shell keeps running in the
// background and can be remounted instantly on reopen.
function userTermUnmount() {
  if (userTerm.ro) { try { userTerm.ro.disconnect(); } catch (e) { /* non-fatal */ } userTerm.ro = null; }
  if (userTerm.handle) { try { userTerm.handle.dispose(); } catch (e) { /* non-fatal */ } userTerm.handle = null; }
}

// Kill the underlying shell entirely (used by Restart + the close-and-kill path).
async function userTermKill() {
  userTermUnmount();
  if (userTerm.session) {
    try { if (userTerm.session.kill) await userTerm.session.kill(); } catch (e) { /* non-fatal */ }
    userTerm.session = null;
  }
  userTerm.cwd = null;
}

// Persist the open/closed flag + current height so the drawer can restore on
// the next app launch. Fire-and-forget, never leaves an unhandled rejection.
function userTermPersist() {
  try {
    const rec = { open: userTerm.open };
    if (TC.el.userTermDrawer && TC.el.userTermDrawer.classList.contains("open")) {
      const h = TC.el.userTermDrawer.getBoundingClientRect().height;
      if (h > 80) rec.height = h;
      else if (userTerm.persisted.height) rec.height = userTerm.persisted.height;
    } else if (userTerm.persisted.height) {
      rec.height = userTerm.persisted.height;
    }
    userTerm.persisted = rec;
    window.chatoss.scopedData.set(USER_TERM_KEY, rec).catch((e) => console.warn("userTermPersist", e));
  } catch (e) { console.warn("userTermPersist", e); }
}

// Apply a height (px) to the drawer, clamped to a usable range.
function userTermApplyHeight(px) {
  if (!TC.el.userTermDrawer) return;
  const vh = window.innerHeight;
  const min = 140;
  const max = Math.floor(vh * 0.85);
  const h = Math.max(min, Math.min(max, px || Math.floor(vh * 0.35)));
  TC.el.userTermDrawer.style.height = h + "px";
  userTerm.persisted.height = h;
}

// OPEN the drawer: spawn a shell if none exists, mount it, slide it up.
async function userTermOpen() {
  if (userTerm.open) { userTermFocus(); return; }
  userTerm.open = true;
  // Restore the saved height (default ~35% of viewport).
  const vh = window.innerHeight;
  const h = (userTerm.persisted && userTerm.persisted.height) || Math.floor(vh * 0.35);
  userTermApplyHeight(h);
  if (TC.el.userTermDrawer) {
    TC.el.userTermDrawer.classList.add("open");
    TC.el.userTermDrawer.setAttribute("aria-hidden", "false");
  }
  if (TC.el.userTermBtn) {
    TC.el.userTermBtn.classList.add("active");
    TC.el.userTermBtn.setAttribute("aria-pressed", "true");
  }
  // Update the cwd label up front so it shows immediately.
  const cwd = userTermCwd();
  if (TC.el.userTermCwd) {
    TC.el.userTermCwd.textContent = TC.basename(cwd);
    TC.el.userTermCwd.title = cwd;
  }
  // Spawn (or reuse) the shell, then mount once the drawer is laid out.
  const fresh = !userTerm.session;
  if (fresh) {
    // Pre-measure the character cell size so we can spawn the PTY at the EXACT
    // cols/rows the xterm will render. A mismatch (spawn at 90 cols, xterm
    // renders at 105) makes zsh re-render on the first fit and leave a stray
    // "%" partial-line marker. The probe uses the same font the xterm will
    // use (monospace at 13px); after mount we re-measure from the xterm's own
    // computed style to correct any discrepancy.
    const pre = measureUserTermCells();
    const w = (TC.el.userTermMount && TC.el.userTermMount.clientWidth) || window.innerWidth;
    const mh = (TC.el.userTermMount && TC.el.userTermMount.clientHeight) || Math.max(200, h - 40);
    const cols = Math.max(20, Math.floor(w / pre.cellW));
    const rows = Math.max(5, Math.floor(mh / pre.cellH));
    userTerm.lastCols = cols;   // seed so the first fit won't double-resize
    userTerm.lastRows = rows;
    await userTermSpawn({ cols, rows });
  }
  // Mount needs the drawer to be visible/sized first.
  requestAnimationFrame(async () => {
    await userTermMount();
    // A remount (drawer reopened after X-close) attaches a FRESH xterm to a
    // shell that printed its prompt long ago — that output predates the mount
    // and never reaches the new xterm, leaving a bare cursor. The shell is
    // idle at its prompt now (ZLE is in raw mode), so Ctrl+L makes zsh
    // clear-and-repaint exactly one clean prompt. We DON'T do this for a
    // fresh spawn: the line editor isn't in raw mode yet and the raw \x0c
    // byte would echo as a visible "^L" before the prompt.
    if (!fresh && userTerm.session && typeof userTerm.session.write === "function") {
      try { await userTerm.session.write("\x0c"); } catch (e) { /* non-fatal */ }
    }
    userTermFocus();
  });
  userTermPersist();
}

// CLOSE the drawer: slide it down and unmount the xterm, but keep the shell
// alive so reopening is instant. The session is killed only on app exit.
function userTermClose() {
  if (!userTerm.open) return;
  userTerm.open = false;
  if (TC.el.userTermDrawer) {
    TC.el.userTermDrawer.classList.remove("open");
    TC.el.userTermDrawer.setAttribute("aria-hidden", "true");
  }
  if (TC.el.userTermBtn) {
    TC.el.userTermBtn.classList.remove("active");
    TC.el.userTermBtn.setAttribute("aria-pressed", "false");
  }
  userTermUnmount();
  userTermPersist();
}

// Toggle open/closed — the single entry point for the sidebar icon + shortcut.
function userTermToggle() {
  if (userTerm.open) userTermClose();
  else userTermOpen();
}

// Focus the terminal so keystrokes go to it.
function userTermFocus() {
  if (!TC.el.userTermMount) return;
  const xtermEl = TC.el.userTermMount.querySelector(".xterm");
  if (xtermEl && xtermEl.focus) { try { xtermEl.focus({ preventScroll: true }); } catch (e) { /* non-fatal */ } }
}

// Restart the shell (kill + respawn + remount). Used by the Restart button.
async function userTermRestart() {
  // Unmount first and null the session so the OLD shell's onExit (which fires
  // when we kill it below) can't null out the NEW session in a race.
  userTermUnmount();
  const old = userTerm.session;
  userTerm.session = null;
  if (old) {
    try { if (old.kill) await old.kill(); } catch (e) { /* non-fatal */ }
  }
  userTerm.cwd = null;
  // Spawn at the current drawer size, measured with the same cell metrics so
  // the PTY is born correctly sized (no post-spawn resize → no "%" artifact).
  const pre = measureUserTermCells();
  const w = (TC.el.userTermMount && TC.el.userTermMount.clientWidth) || window.innerWidth;
  const mh = (TC.el.userTermMount && TC.el.userTermMount.clientHeight) || 480;
  const cols = Math.max(20, Math.floor(w / pre.cellW));
  const rows = Math.max(5, Math.floor(mh / pre.cellH));
  userTerm.lastCols = cols;
  userTerm.lastRows = rows;
  await userTermSpawn({ cols, rows });
  if (userTerm.open) await userTermMount();
  userTermFocus();
}

// "Clear" — clear the shell screen with Ctrl+L (\x0c). The host's key() API
// doesn't support 'ctrl+l' (interactive key set only), so write the control
// byte directly. We don't kill the shell — the working directory + history
// persist.
async function userTermClear() {
  if (!userTerm.session) return;
  try {
    if (typeof userTerm.session.write === "function") {
      await userTerm.session.write("\x0c");
    } else {
      await TC.sendKey(userTerm.session, "ctrl+l");
    }
  } catch (e) { /* non-fatal */ }
}

// Horizontal drag-resize for the drawer height.
function initUserTermResizer() {
  const handle = TC.el.userTermResizer;
  if (!handle) return;
  let dragging = false;
  let startY = 0;
  let startH = 0;

  const onMove = (clientY) => {
    if (!dragging) return;
    const delta = startY - clientY; // drag up = taller
    userTermApplyHeight(startH + delta);
  };

  handle.addEventListener("mousedown", (e) => {
    dragging = true;
    startY = e.clientY;
    startH = TC.el.userTermDrawer.getBoundingClientRect().height;
    document.body.classList.add("is-resizing");
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => onMove(e.clientY));
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("is-resizing");
    userTermPersist();
    requestAnimationFrame(userTermFit);
  });
  // Keyboard-resizable (the handle is focusable role="separator").
  handle.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 48 : 16;
    let d = 0;
    if (e.key === "ArrowUp") d = step;
    else if (e.key === "ArrowDown") d = -step;
    else if (e.key === "Enter") { e.preventDefault(); userTermToggle(); return; }
    else return;
    e.preventDefault();
    const cur = TC.el.userTermDrawer.getBoundingClientRect().height;
    userTermApplyHeight(cur + d);
    requestAnimationFrame(userTermFit);
  });
}

// Restore the drawer's persisted state on boot. A live PTY does not survive an
// app restart, so if it was open we respawn a fresh shell and reopen the drawer.
async function userTermRestore() {
  try {
    const saved = await window.chatoss.scopedData.get(USER_TERM_KEY);
    if (saved && typeof saved === "object") {
      userTerm.persisted = { open: !!saved.open, height: saved.height || 0 };
    }
  } catch (e) { console.warn("userTermRestore", e); }
  if (userTerm.persisted.open) {
    // Defer until after the first render so the drawer element is laid out.
    requestAnimationFrame(() => userTermOpen().catch((e) => console.warn("userTermRestore open", e)));
  }
}

// Kill the shell on app exit/close so it doesn't linger. Called from pagehide.
async function userTermShutdown() {
  await userTermKill();
}

// ---------- Init ----------
// --- exports ---
Object.defineProperty(TC, "USER_TERM_KEY", { get: () => USER_TERM_KEY, configurable: true });
Object.defineProperty(TC, "userTerm", { get: () => userTerm, set: (v) => { userTerm = v; }, configurable: true });
TC.userTermCwd = userTermCwd;
TC.userTermSpawn = userTermSpawn;
TC.userTermMount = userTermMount;
TC.measureUserTermCells = measureUserTermCells;
TC.userTermFit = userTermFit;
TC.userTermUnmount = userTermUnmount;
TC.userTermKill = userTermKill;
TC.userTermPersist = userTermPersist;
TC.userTermApplyHeight = userTermApplyHeight;
TC.userTermOpen = userTermOpen;
TC.userTermClose = userTermClose;
TC.userTermToggle = userTermToggle;
TC.userTermFocus = userTermFocus;
TC.userTermRestart = userTermRestart;
TC.userTermClear = userTermClear;
TC.initUserTermResizer = initUserTermResizer;
TC.userTermRestore = userTermRestore;
TC.userTermShutdown = userTermShutdown;
})();
