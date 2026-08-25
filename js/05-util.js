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
function parseOllamaModels(out) {
  const found = [];
  const lines = String(out || "").split("\n");
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (/^NAME\b/i.test(t)) continue;
    const first = t.split(/\s+/)[0];
    if (first && first !== "NAME") found.push(first);
  }
  return [...new Set(found)];
}

async function detectTools(force = false) {
  const now = Date.now();
  if (!force && TC.detection.scannedAt && now - TC.detection.scannedAt < TC.DETECT_TTL_MS) {
    return TC.detection;
  }
  const fresh = { codex: false, claude: false, ollama: false, opencode: false, models: [], scannedAt: now, denied: false, claudePath: null, codexPath: null, opencodePath: null };
  const cwd = defaultCwd();

  const probe = async (cmd) => {
    try {
      const r = await window.chatoss.terminal.exec(cmd, { cwd });
      if (r === null) { fresh.denied = true; return null; }
      return r;
    } catch (e) {
      console.warn("probe failed:", cmd, e);
      return null;
    }
  };

  // Helper: resolve a CLI binary's absolute path the same way ollamaPath is
  // resolved — `which` first, then a login shell `which`, then well-known
  // locations. Returns the path string or null. Also sets the boolean flag
  // on `fresh` so callers know the binary is available.
  const resolveCliPath = async (name, guesses) => {
    let path = null;
    const wr = await probe("which " + name);
    if (wr !== null && wr.exitCode === 0 && String(wr.output || "").trim()) {
      path = String(wr.output).trim().split("\n")[0].trim();
    }
    if (!path) {
      const lr = await probe(TC.loginShell("which " + name));
      if (lr !== null && lr.exitCode === 0 && String(lr.output || "").trim()) {
        path = String(lr.output).trim().split("\n")[0].trim();
      }
    }
    if (!path) {
      for (const g of guesses) {
        const tr = await probe("test -x " + JSON.stringify(g) + " && echo ok");
        if (tr !== null && tr.exitCode === 0 && /ok/.test(String(tr.output))) { path = g; break; }
      }
    }
    return path;
  };

  // Resolve the direct claude / codex / opencode binaries (for launching them
  // WITHOUT going through ollama). The boolean flags stay in lockstep with the
  // path.
  TC.setCodexPath(await resolveCliPath("codex", TC.CODEX_GUESSES));
  fresh.codex = !!TC.codexPath;
  fresh.codexPath = TC.codexPath;
  TC.setClaudePath(await resolveCliPath("claude", TC.CLAUDE_GUESSES));
  fresh.claude = !!TC.claudePath;
  fresh.claudePath = TC.claudePath;
  TC.setOpencodePath(await resolveCliPath("opencode", TC.OPENCODE_GUESSES));
  fresh.opencode = !!TC.opencodePath;
  fresh.opencodePath = TC.opencodePath;

  // Resolve ollama's absolute path — the sandbox shell has a minimal PATH, so
  // "which ollama" may fail even though ollama is installed. Try `which`, then
  // a login shell, then well-known locations.
  TC.setOllamaPath(null);
  const ollamaR = await probe("which ollama");
  if (ollamaR !== null && ollamaR.exitCode === 0 && String(ollamaR.output || "").trim()) {
    TC.setOllamaPath(String(ollamaR.output).trim().split("\n")[0].trim());
  }
  if (!TC.ollamaPath) {
    const lr = await probe(TC.loginShell("which ollama"));
    if (lr !== null && lr.exitCode === 0 && String(lr.output || "").trim()) {
      TC.setOllamaPath(String(lr.output).trim().split("\n")[0].trim());
    }
  }
  if (!TC.ollamaPath) {
    for (const g of TC.OLLAMA_GUESSES) {
      const tr = await probe("test -x " + JSON.stringify(g) + " && echo ok");
      if (tr !== null && tr.exitCode === 0 && /ok/.test(String(tr.output))) { TC.setOllamaPath(g); break; }
    }
  }
  fresh.ollama = !!TC.ollamaPath;

  if (fresh.ollama) {
    const listR = await probe(JSON.stringify(TC.ollamaPath) + " list");
    if (listR !== null && listR.exitCode === 0) {
      fresh.models = parseOllamaModels(listR.output);
    }
    if (!fresh.models.length) fresh.models = TC.FALLBACK_MODELS.slice();
  }

  // `detection` is exported from 00-state.js, so it must be mutated in place
  // (the imported binding itself is read-only).
  Object.assign(TC.detection, fresh);
  TC.settings.detected = {
    codex: TC.detection.codex,
    claude: TC.detection.claude,
    ollama: TC.detection.ollama,
    opencode: TC.detection.opencode,
    models: TC.detection.models.slice(),
    denied: TC.detection.denied,
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
TC.parseOllamaModels = parseOllamaModels;
TC.detectTools = detectTools;
})();
