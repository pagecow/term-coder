import { CLAUDE_GUESSES, CODEX_GUESSES, DETECT_TTL_MS, FALLBACK_MODELS, OLLAMA_GUESSES, OPENCODE_GUESSES, SETTINGS_KEY, STORE_KEY, claudePath, codexPath, detection, loginShell, models, ollamaPath, opencodePath, running, settings, state } from "./00-state.js";
import { scheduleSqliteSync } from "./02-sqlite.js";
import { $, el } from "./04-dom.js";
import { renderDetectedList } from "./07-spawn.js";
import { applyModelSelectionModeToUi } from "./08-settings.js";
import { syncOverlayOffset } from "./21-askchoice.js";
export function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
export function basename(p) {
  if (!p) return "project";
  const parts = String(p).replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}
export function uuid() {
  return (crypto.randomUUID && crypto.randomUUID()) ||
    "id-" + Date.now() + "-" + Math.random().toString(36).slice(2);
}
// Persistence is async — fire-and-forget but never leave an unhandled rejection.
export function saveState() {
  try { window.chatoss.scopedData.set(STORE_KEY, state).catch((e) => console.warn("saveState", e)); }
  catch (e) { console.warn("saveState", e); }
  // Mirror conversations/messages into the private SQLite DB (debounced) so
  // history survives even if the scopedData blob is lost after a session.
  scheduleSqliteSync();
}
export function saveSettings() {
  try { window.chatoss.scopedData.set(SETTINGS_KEY, settings).catch((e) => console.warn("saveSettings", e)); }
  catch (e) { console.warn("saveSettings", e); }
}
export function getProject(id) { return state.projects.find((p) => p.id === id) || null; }
export function getConversation(pid, cid) {
  const p = getProject(pid);
  return p ? p.conversations.find((c) => c.id === cid) || null : null;
}
export function activeConversation() { return getConversation(state.activeProjectId, state.activeConversationId); }
export function defaultCwd() {
  // Best-effort cwd for terminal.exec probes: active project folder, then settings, then '/'.
  const p = getProject(state.activeProjectId);
  if (p && p.folderPath) return p.folderPath;
  if (settings.cwdDefault) return settings.cwdDefault;
  return "/";
}
export function setStatus(t) {
  const s = el.chatStatus;
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
  syncOverlayOffset();
}

// Normalize a tool call delivered by runTurn's onToolCall. The documented shape is
// { function: { name, arguments } } where arguments is ALREADY an object — but some
// engines pass { name, args } or { name, arguments: "<json string>" }. Handle all.
export function normalizeToolCall(call) {
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
export function parseOllamaModels(out) {
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

export async function detectTools(force = false) {
  const now = Date.now();
  if (!force && detection.scannedAt && now - detection.scannedAt < DETECT_TTL_MS) {
    return detection;
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
      const lr = await probe(loginShell("which " + name));
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
  codexPath = await resolveCliPath("codex", CODEX_GUESSES);
  fresh.codex = !!codexPath;
  fresh.codexPath = codexPath;
  claudePath = await resolveCliPath("claude", CLAUDE_GUESSES);
  fresh.claude = !!claudePath;
  fresh.claudePath = claudePath;
  opencodePath = await resolveCliPath("opencode", OPENCODE_GUESSES);
  fresh.opencode = !!opencodePath;
  fresh.opencodePath = opencodePath;

  // Resolve ollama's absolute path — the sandbox shell has a minimal PATH, so
  // "which ollama" may fail even though ollama is installed. Try `which`, then
  // a login shell, then well-known locations.
  ollamaPath = null;
  const ollamaR = await probe("which ollama");
  if (ollamaR !== null && ollamaR.exitCode === 0 && String(ollamaR.output || "").trim()) {
    ollamaPath = String(ollamaR.output).trim().split("\n")[0].trim();
  }
  if (!ollamaPath) {
    const lr = await probe(loginShell("which ollama"));
    if (lr !== null && lr.exitCode === 0 && String(lr.output || "").trim()) {
      ollamaPath = String(lr.output).trim().split("\n")[0].trim();
    }
  }
  if (!ollamaPath) {
    for (const g of OLLAMA_GUESSES) {
      const tr = await probe("test -x " + JSON.stringify(g) + " && echo ok");
      if (tr !== null && tr.exitCode === 0 && /ok/.test(String(tr.output))) { ollamaPath = g; break; }
    }
  }
  fresh.ollama = !!ollamaPath;

  if (fresh.ollama) {
    const listR = await probe(JSON.stringify(ollamaPath) + " list");
    if (listR !== null && listR.exitCode === 0) {
      fresh.models = parseOllamaModels(listR.output);
    }
    if (!fresh.models.length) fresh.models = FALLBACK_MODELS.slice();
  }

  detection = fresh;
  settings.detected = {
    codex: detection.codex,
    claude: detection.claude,
    ollama: detection.ollama,
    opencode: detection.opencode,
    models: detection.models.slice(),
    denied: detection.denied,
    claudePath: detection.claudePath || null,
    codexPath: detection.codexPath || null,
    opencodePath: detection.opencodePath || null,
  };
  saveSettings();
  renderDetectedList();
  // If the settings panel is open, refresh the model pickers with the newly
  // detected models (preserving saved selections where still available).
  if (el.settingsPanel && !el.settingsPanel.classList.contains("hidden")) {
    applyModelSelectionModeToUi();
  }

  return detection;
}

// ---------- ORCHESTRATOR TOOLS (JSON schema for runTurn) ----------
