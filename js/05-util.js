// 05-util.js — classic script (converted from an ES module; see REFACTOR_PLAN.md).
// Exports are registered on the shared window.termCoder namespace (TC).
(function () {
"use strict";
const TC = window.termCoder = window.termCoder || {};
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function basename(p) {
  if (!p) return "project";
  const parts = String(p).replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}
function uuid() {
  return (crypto.randomUUID && crypto.randomUUID()) ||
    "id-" + Date.now() + "-" + Math.random().toString(36).slice(2);
}
// Persistence is async — fire-and-forget but never leave an unhandled rejection.
function saveState() {
  try { window.chatoss.scopedData.set(TC.STORE_KEY, TC.state).catch((e) => console.warn("saveState", e)); }
  catch (e) { console.warn("saveState", e); }
  // Mirror conversations/messages into the private SQLite DB (debounced) so
  // history survives even if the scopedData blob is lost after a session.
  TC.scheduleSqliteSync();
}
function saveSettings() {
  try { window.chatoss.scopedData.set(TC.SETTINGS_KEY, TC.settings).catch((e) => console.warn("saveSettings", e)); }
  catch (e) { console.warn("saveSettings", e); }
}
function getProject(id) { return TC.state.projects.find((p) => p.id === id) || null; }
function getConversation(pid, cid) {
  const p = getProject(pid);
  return p ? p.conversations.find((c) => c.id === cid) || null : null;
}
function activeConversation() { return getConversation(TC.state.activeProjectId, TC.state.activeConversationId); }
function defaultCwd() {
  // Best-effort cwd for terminal.exec probes: active project folder, then settings, then '/'.
  const p = getProject(TC.state.activeProjectId);
  if (p && p.folderPath) return p.folderPath;
  if (TC.settings.cwdDefault) return TC.settings.cwdDefault;
  return "/";
}
function setStatus(t) {
  const s = TC.el.chatStatus;
  if (!s) return;
  const text = t || "";
  // Show a subtle pulsing dot when the orchestrator is actively working.
  const active = !!text && /generating|thinking|running|working|polling|waiting/i.test(text);
  s.innerHTML = "";
  if (active) {
    const dot = document.createElement("span");
    dot.className = "pulse";
    s.appendChild(dot);
  }
  if (text) {
    const span = document.createElement("span");
    span.textContent = text;
    s.appendChild(span);
  }
  // The status line appearing/disappearing changes the composer stack height the
  // askChoice overlay sits above. (Hoisted declaration — safe to call here.)
  TC.syncOverlayOffset();
}

// Normalize a tool call delivered by runTurn's onToolCall. The documented shape is
// { function: { name, arguments } } where arguments is ALREADY an object — but some
// engines pass { name, args } or { name, arguments: "<json string>" }. Handle all.
function normalizeToolCall(call) {
  call = call || {};
  const fn = call.function || {};
  const name = call.name || fn.name || "unknown";
  let args = {};
  const candidates = [call.args, call.arguments, fn.arguments, fn.args];
  for (const cand of candidates) {
    if (cand == null) continue;
    if (typeof cand === "string") {
      try { const parsed = JSON.parse(cand); if (parsed && typeof parsed === "object") { args = parsed; break; } } catch (e) { /* try next */ }
    } else if (typeof cand === "object" && !Array.isArray(cand)) {
      args = cand; break;
    }
  }
  return { name, args };
}

// ---------- Auto-detection (cached ~60s) ----------
async function detectTools(force = false) {
  const now = Date.now();
  if (!force && TC.detection.scannedAt && now - TC.detection.scannedAt < TC.DETECT_TTL_MS) {
    return TC.detection;
  }
  const fresh = { codex: false, claude: false, chatoss: false, opencode: false, models: [], scannedAt: now, denied: false, chatossPath: null, claudePath: null, codexPath: null, opencodePath: null };
  const cwd = defaultCwd();

  const probe = async (cmd) => {
    try {
      const r = await window.chatoss.terminal.exec(cmd, { cwd });
      if (r === null) { fresh.denied = true; return null; }
      return r;
    } catch (e) {
      // Expected outcomes, NOT errors: the terminal capability may be off
      // (preview sandbox, permission not granted) or the command simply isn't
      // installed. v1.28.1 logged a console.warn per failed probe — 25
      // warnings per scan in the preview, which reads as "25 problems in this
      // app". The detection state + the Settings "Detected tools" list already
      // surface the outcome, so stay silent and mark the scan denied so the
      // remaining probes are skipped.
      fresh.denied = true;
      return null;
    }
  };

  // Helper: resolve a CLI binary's absolute path the same way chatossPath is
  // resolved — `which` first, then a login shell `which`, then well-known
  // locations. Returns the path string or null. Also sets the boolean flag
  // on `fresh` so callers know the binary is available. A denied/unavailable
  // terminal short-circuits the whole scan (every further probe would fail
  // the same way).
  const resolveCliPath = async (name, guesses) => {
    let path = null;
    const wr = await probe("which " + name);
    if (fresh.denied) return null;
    if (wr !== null && wr.exitCode === 0 && String(wr.output || "").trim()) {
      path = String(wr.output).trim().split("\n")[0].trim();
    }
    if (!path) {
      const lr = await probe(TC.loginShell("which " + name));
      if (fresh.denied) return null;
      if (lr !== null && lr.exitCode === 0 && String(lr.output || "").trim()) {
        path = String(lr.output).trim().split("\n")[0].trim();
      }
    }
    if (!path) {
      for (const g of guesses) {
        const tr = await probe("test -x " + JSON.stringify(g) + " && echo ok");
        if (fresh.denied) return null;
        if (tr !== null && tr.exitCode === 0 && /ok/.test(String(tr.output))) { path = g; break; }
      }
    }
    return path;
  };

  // ── chatoss: the ONLY launch path (v1.28) ── every sub-agent session starts
  // through `chatoss launch <tool>`. Resolve its absolute path so the spawn
  // command survives the sandbox's minimal PATH; sessions spawn through a
  // login shell anyway, so a null path still launches the bare command and
  // the not-installed case is handled at spawn time with the
  // "Install chatoss command" guidance (see spawnChosen).
  TC.setChatossPath(await resolveCliPath("chatoss", TC.CHATOSS_GUESSES));
  fresh.chatoss = !!TC.chatossPath;
  fresh.chatossPath = TC.chatossPath;

  // Resolve the underlying claude / codex / opencode binaries that
  // `chatoss launch` drives. These are informational only (the Settings
  // "Detected tools" list) — the app never spawns them directly. When the
  // terminal capability is denied/unavailable, every probe fails the same
  // way, so skip the rest of the scan (one probe instead of 25).
  if (!fresh.denied) {
    TC.setCodexPath(await resolveCliPath("codex", TC.CODEX_GUESSES));
    fresh.codex = !!TC.codexPath;
    fresh.codexPath = TC.codexPath;
    TC.setClaudePath(await resolveCliPath("claude", TC.CLAUDE_GUESSES));
    fresh.claude = !!TC.claudePath;
    fresh.claudePath = TC.claudePath;
    TC.setOpencodePath(await resolveCliPath("opencode", TC.OPENCODE_GUESSES));
    fresh.opencode = !!TC.opencodePath;
    fresh.opencodePath = TC.opencodePath;
  }

  // `detection` is exported from 00-state.js, so it must be mutated in place
  // (the imported binding itself is read-only).
  Object.assign(TC.detection, fresh);
  TC.settings.detected = {
    chatoss: TC.detection.chatoss,
    codex: TC.detection.codex,
    claude: TC.detection.claude,
    opencode: TC.detection.opencode,
    denied: TC.detection.denied,
    chatossPath: TC.detection.chatossPath || null,
    claudePath: TC.detection.claudePath || null,
    codexPath: TC.detection.codexPath || null,
    opencodePath: TC.detection.opencodePath || null,
  };
  saveSettings();
  TC.renderDetectedList();
  // If the settings panel is open, refresh the model pickers with the newly
  // detected models (preserving saved selections where still available).
  if (TC.el.settingsPanel && !TC.el.settingsPanel.classList.contains("hidden")) {
    TC.applyModelSelectionModeToUi();
  }

  return TC.detection;
}

// ---------- ORCHESTRATOR TOOLS (JSON schema for runTurn) ----------
// --- exports ---
TC.esc = esc;
TC.basename = basename;
TC.uuid = uuid;
TC.saveState = saveState;
TC.saveSettings = saveSettings;
TC.getProject = getProject;
TC.getConversation = getConversation;
TC.activeConversation = activeConversation;
TC.defaultCwd = defaultCwd;
TC.setStatus = setStatus;
TC.normalizeToolCall = normalizeToolCall;
TC.detectTools = detectTools;
})();
