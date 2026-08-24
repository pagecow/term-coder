import { APP_VERSION, FALLBACK_MODELS, MS_KEYS, claudePath, codexPath, detection, modelSelection, models, opencodePath, trustMode } from "./00-state.js";
import { el } from "./04-dom.js";
import { cleanApprovalText } from "./06-tools.js";
export const UPDATES_APP_JSON_URL = "https://raw.githubusercontent.com/pagecow/term-coder/main/app.json";
export const UPDATES_CONTENTS_API_URL = "https://api.github.com/repos/pagecow/term-coder/contents/app.json";
export const UPDATES_RELEASES_API_URL = "https://api.github.com/repos/pagecow/term-coder/releases/latest";
export const UPDATES_RELEASES_PAGE_URL = "https://github.com/pagecow/term-coder/releases";

// Parse "1.16.1" / "v1.16.1" into [major, minor, patch] (missing parts = 0).
// Returns null when the string has no leading numeric version.
export function parseVersion(v) {
  const m = String(v == null ? "" : v).trim().replace(/^v/i, "").match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return [parseInt(m[1], 10) || 0, parseInt(m[2], 10) || 0, parseInt(m[3], 10) || 0];
}
// >0 when a is newer than b, <0 when b is newer, 0 when equal/unparseable.
export function compareVersions(a, b) {
  const pa = parseVersion(a), pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

// Fetch the latest published version from GitHub. Primary source is the repo's
// app.json on main; fallback is the latest release tag. Returns the version
// string or null when neither source could be read.
export async function fetchLatestVersion() {
  // web.fetch returns { title, content, links } — content is the page text.
  const readJson = async (url) => {
    const page = await window.chatoss.web.fetch(url);
    const text = (page && (page.content || page.text)) || "";
    if (!text) return null;
    try { return JSON.parse(text); } catch (e) { /* fall through to regex */ }
    // The fetcher may have wrapped/trimmed the raw JSON — pull the field out
    // with a regex as a last resort.
    const m = text.match(/"(?:version|tag_name)"\s*:\s*"([^"]+)"/);
    return m ? { version: m[1], tag_name: m[1] } : null;
  };
  // The GitHub contents API returns JSON whose "content" field is base64-
  // encoded (and may contain embedded newlines). Strip whitespace, atob it,
  // then JSON.parse — with the same regex fallback for wrapped/trimmed
  // payloads. Returns a { version } object, or null.
  const readContentsApi = async (url) => {
    const json = await readJson(url);
    if (!json || !json.content) return null;
    try {
      const decoded = atob(String(json.content).replace(/\s+/g, ""));
      try { return JSON.parse(decoded); } catch (e) { /* fall through to regex */ }
      const m = decoded.match(/"version"\s*:\s*"([^"]+)"/);
      return m ? { version: m[1] } : null;
    } catch (e) { console.warn("readContentsApi decode", e); return null; }
  };
  // 1) Primary: the repo's app.json on main. The "?t=" cache-buster forces a
  //    Fastly CDN cache miss so we always see origin's latest version instead
  //    of a stale cached copy (raw.githubusercontent.com ignores the param).
  try {
    const json = await readJson(UPDATES_APP_JSON_URL + "?t=" + Date.now());
    if (json && json.version) return String(json.version);
  } catch (e) { console.warn("fetchLatestVersion app.json", e); }
  // 2) Fallback: the GitHub contents API — base64-decode its "content" field.
  try {
    const json = await readContentsApi(UPDATES_CONTENTS_API_URL);
    if (json && json.version) return String(json.version);
  } catch (e) { console.warn("fetchLatestVersion contents", e); }
  // 3) Last resort: the latest release tag_name.
  try {
    const json = await readJson(UPDATES_RELEASES_API_URL);
    if (json && json.tag_name) return String(json.tag_name);
  } catch (e) { console.warn("fetchLatestVersion releases", e); }
  return null;
}

export async function checkForUpdates() {
  const status = el.updateStatus;
  if (!status) return;
  if (el.checkUpdatesBtn) el.checkUpdatesBtn.disabled = true;
  if (el.openReleasesBtn) el.openReleasesBtn.classList.add("hidden");
  status.textContent = "Checking…";
  status.className = "update-status";
  let remote = null;
  try {
    remote = await fetchLatestVersion();
  } catch (e) {
    console.warn("checkForUpdates", e);
  }
  if (el.checkUpdatesBtn) el.checkUpdatesBtn.disabled = false;
  if (!remote) {
    status.textContent = "Couldn't check for updates — check your connection";
    status.className = "update-status update-status-error";
    return;
  }
  if (compareVersions(remote, APP_VERSION) > 0) {
    status.textContent = "Update available: " + remote;
    status.className = "update-status update-status-available";
    if (el.openReleasesBtn) el.openReleasesBtn.classList.remove("hidden");
  } else {
    status.textContent = "Up to date (" + APP_VERSION + ")";
    status.className = "update-status update-status-ok";
  }
}

export function openReleasesPage() {
  try {
    window.chatoss.openExternal.open(UPDATES_RELEASES_PAGE_URL).catch((e) => console.warn("openReleasesPage", e));
  } catch (e) { console.warn("openReleasesPage", e); }
}

// ---------- Model Selection Mode ----------
// The COMPLETE ollama model list: the terminal-detected models (`ollama list`
// via detectTools) PLUS every local model the ChatOSS chat model list reports
// (the same source the model picker at the top of the AI chat section uses).
// The terminal probe can miss models (truncated output, PATH quirks, a stale
// persisted snapshot), so the chat list is the authoritative superset.
// detection.models first (terminal-verified), then chat-local models, deduped
// by id. Falls back to FALLBACK_MODELS when both sources are empty.
export function allOllamaModels() {
  const seen = new Set();
  const out = [];
  const push = (m) => {
    if (m && !seen.has(m)) { seen.add(m); out.push(m); }
  };
  for (const m of (detection && detection.models) || []) push(m);
  for (const m of models) {
    if (m && m.source === "local" && m.id) push(m.id);
  }
  return out;
}

// Returns the auto-detected ollama model ids (a copy of allOllamaModels()),
// falling back to FALLBACK_MODELS when detection is empty.
export function availableOllamaModels() {
  const m = allOllamaModels();
  return m.length ? m : FALLBACK_MODELS.slice();
}

// ── Direct-CLI + ollama launch targets ──
// A single unified list of everything the user can launch as a sub-agent
// session. Each entry is a "target" the model picker (resolveSessionModel) and
// the spawn logic (spawnChosen) both understand:
//
//   { kind: "direct", id, label, bin }   — run the real claude/codex binary
//                                          directly via the terminal capability
//                                          (NOT through ollama).
//   { kind: "ollama", id, label, model } — launch through `ollama launch
//                                          <tool> --model <model>` (existing path).
//
// `id` is the stable value stored in settings (alwaysModel / complexityModel*).
// Direct CLIs use ids "claude", "codex", and "opencode"; ollama models use their
// model name. kind is derived from the id with targetKind() so a bare id
// round-trips.
export function availableLaunchTargets() {
  const out = [];
  // Direct CLIs first — these are the "I have a direct account" options and
  // are the most distinct from the ollama path, so they read as the headline
  // choices. Only listed when the binary is actually installed.
  if (detection.claude && detection.claudePath) {
    out.push({ kind: "direct", id: "claude", label: "claude  (Claude Code, direct)", bin: detection.claudePath });
  }
  if (detection.codex && detection.codexPath) {
    out.push({ kind: "direct", id: "codex", label: "codex  (Codex, direct)", bin: detection.codexPath });
  }
  if (detection.opencode && detection.opencodePath) {
    out.push({ kind: "direct", id: "opencode", label: "opencode  (OpenCode, direct)", bin: detection.opencodePath });
  }
  // Ollama models — the existing launch path. Each becomes its own target so
  // picking one launches through ollama with that model.
  for (const model of availableOllamaModels()) {
    out.push({ kind: "ollama", id: model, label: model + "  (ollama)", model });
  }
  return out;
}

// Look up a launch target by its stable id. Returns the target object or null.
export function findLaunchTarget(id) {
  if (!id) return null;
  return availableLaunchTargets().find((t) => t.id === id) || null;
}

// Given a target id, return its kind ("direct" | "ollama") or null when not
// found / not a known target. Used to route the spawn command without needing
// the full target object.
export function targetKind(id) {
  const t = findLaunchTarget(id);
  return t ? t.kind : null;
}

// Map a persisted "default launch" value — the shared value space of the
// Settings "Default agent" picker (#set-cli) and the spawn-modal "Remember as
// default" checkbox — to a launch-target id, or null when it must NOT be
// auto-applied on session start.
//
//   "raw:claude" | "raw:codex" | "raw:opencode" -> the matching direct-CLI
//       target id ("claude" / "codex" / "opencode"). These are the only values
//       that name a SELF-CONTAINED launch target (a direct binary needs no extra
//       model choice), so they are the values that can short-circuit the
//       launch-target picker.
//   "ask" | "" | null | undefined -> null. The user asked to be prompted every
//       time, so the caller falls through to the Model Selection Mode logic.
//   anything else (the bare ollama-tool names "claude" / "codex" / "chatgpt" /
//       "hermes" / "opencode" / "copilot", or a stray legacy value) -> null.
//       These are launch TOOLS, not self-contained launch targets — they still
//       need an ollama model (chosen in the pill picker / Model Selection Mode),
//       so they cannot be applied as a single target. Returning null makes the
//       caller fall through to the normal Model Selection Mode logic, which
//       preserves the pre-existing behavior for those values.
//
// resolveSessionModel consults this BEFORE its mode branches so a saved default
// is applied on session start instead of re-asking every time (the launch-pick
// bug): the orchestrator kept showing the pill picker even after the user pinned
// a default agent.
export function cliDefaultToTargetId(value) {
  if (!value || value === "ask") return null;
  if (typeof value !== "string") return null;
  if (value.indexOf("raw:") === 0) {
    const id = value.slice(4);
    return id || null;
  }
  return null;
}

// Build the list of { label, value } options for the pill/rect askChoice picker
// and for any <select> that should offer the same choices. value is the stable
// target id so the picker result maps straight back to a launch target.
export function launchTargetChoiceOptions() {
  return availableLaunchTargets().map((t) => ({ label: t.label, value: t.id }));
}

// Populate a <select> with the available launch targets (direct CLIs +
// ollama models) and select `selected` (if present in the list). Renders an
// empty placeholder option when nothing is available so the picker is never
// silently blank. Direct CLIs are grouped under an optgroup so they read as a
// distinct choice from the ollama models.
export function populateModelSelect(selectEl, selected) {
  if (!selectEl) return;
  const targets = availableLaunchTargets();
  selectEl.innerHTML = "";
  if (!targets.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(nothing detected — run Re-scan)";
    selectEl.appendChild(opt);
    selectEl.value = "";
    return;
  }
  const ids = targets.map((t) => t.id);
  // Direct CLIs first (if any), under a labeled group.
  const direct = targets.filter((t) => t.kind === "direct");
  const ollama = targets.filter((t) => t.kind === "ollama");
  if (direct.length) {
    const grp = document.createElement("optgroup");
    grp.label = "Direct CLI (no ollama)";
    for (const t of direct) {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = t.id + "  (direct)";
      grp.appendChild(opt);
    }
    selectEl.appendChild(grp);
  }
  if (ollama.length) {
    const grp = document.createElement("optgroup");
    grp.label = "Ollama models";
    for (const t of ollama) {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = t.id;
      grp.appendChild(opt);
    }
    selectEl.appendChild(grp);
  }
  // Restore the saved selection if it's still available, else first target.
  if (selected && ids.includes(selected)) selectEl.value = selected;
  else selectEl.value = ids[0];
}

// ---------- Sub-agent effort (per launch target) ----------
// Settings → Model Selection Mode rows pair each target select with an Effort
// select. The effort belongs to the TARGET (not the row), so it applies in
// every selection mode — a manual pill pick of that target carries the same
// effort saved for it in Always/Complexity.

// Read the saved effort for a launch-target id. For ollama-model targets the
// value must be one of the model's current thinkLevels (or "" for default).
// Direct CLI targets are restricted to the fixed low/medium/high set.
export function effortForTarget(targetId) {
  if (!targetId) return null;
  const map = modelSelection.subAgentEffort;
  const v = map && typeof map === "object" ? map[targetId] : null;
  if (v == null || v === "") return null;
  const opts = effortOptionsForTarget(targetId);
  return opts.some((o) => o.value === v) ? v : null;
}

// Return the effort options for a given launch target:
//   - Direct CLI (claude/codex/opencode) → low/medium/high (the values Codex's
//     real flag accepts; other direct agents get guidance lines).
//   - An ollama model id with thinkLevels → those exact levels.
//   - Otherwise → the generic low/medium/high/extra-high/max set.
export function effortOptionsForTarget(targetId) {
  const directIds = ["claude", "codex", "opencode"];
  if (targetId && directIds.includes(targetId)) {
    return [{ value: "", label: "Model default" },
      { value: "low", label: "Low — fast & pragmatic" },
      { value: "medium", label: "Medium — balanced" },
      { value: "high", label: "High — deep reasoning" }];
  }
  const m = models.find((x) => x.id === targetId);
  if (m && m.thinkLevels && m.thinkLevels.length) {
    const opts = [{ value: "", label: "Model default" }];
    for (const lvl of m.thinkLevels) {
      opts.push({ value: lvl, label: lvl.charAt(0).toUpperCase() + lvl.slice(1) });
    }
    return opts;
  }
  return [{ value: "", label: "Model default" },
    { value: "low", label: "Low — fast & pragmatic" },
    { value: "medium", label: "Medium — balanced" },
    { value: "high", label: "High — deep reasoning" },
    { value: "extra-high", label: "Extra high" },
    { value: "max", label: "Max" }];
}

// Populate an effort select with the option list for `targetId`, selecting the
// value saved for that target ("" = model default).
export function populateEffortSelect(selectEl, targetId) {
  if (!selectEl) return;
  selectEl.innerHTML = "";
  for (const o of effortOptionsForTarget(targetId)) {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    selectEl.appendChild(opt);
  }
  selectEl.value = effortForTarget(targetId) || "";
}

// Reflect the per-target effort map into every Settings row. Runs whenever a
// row's target select changes and whenever the panels are (re)populated.
export function syncEffortRows() {
  populateEffortSelect(el.alwaysEffort, el.alwaysModel.value);
  populateEffortSelect(el.complexityEffortLow, el.complexityModelLow.value);
  populateEffortSelect(el.complexityEffortMedium, el.complexityModelMedium.value);
  populateEffortSelect(el.complexityEffortHigh, el.complexityModelHigh.value);
}

// Wire one effort select: changing it stores the level against the CURRENT
// target of its sibling model select, and persists immediately ("" deletes the
// entry so a target returns to its model default).
export function bindEffortSelect(effortSel, modelSel) {
  if (!effortSel || !modelSel) return;
  effortSel.addEventListener("change", () => {
    const targetId = modelSel.value;
    if (!targetId) return; // empty picker ("nothing detected") — nothing to attach the effort to
    if (!modelSelection.subAgentEffort || typeof modelSelection.subAgentEffort !== "object") modelSelection.subAgentEffort = {};
    const v = effortSel.value;
    if (v) modelSelection.subAgentEffort[targetId] = v;
    else delete modelSelection.subAgentEffort[targetId];
    persistModelSelection();
  });
}

// The task-brief guidance line appended when an effort level is set but the
// target has no real effort flag (claude / opencode / ollama launches). Direct
// Codex instead gets the verified --config model_reasoning_effort flag.
export const EFFORT_BRIEF = {
  low: "Effort level: LOW. Work fast and pragmatically — minimal analysis, no over-engineering; prefer the simplest correct solution.",
  medium: "Effort level: MEDIUM. Balance speed and care — think through the important decisions, but don't over-engineer routine parts.",
  high: "Effort level: HIGH. Work with maximum care — reason deeply, consider edge cases and trade-offs, and verify your work before calling it done.",
  "extra-high": "Effort level: EXTRA HIGH. Push deeper than the standard high setting — explore more alternatives, check subtle edge cases, and prioritize correctness over speed.",
  max: "Effort level: MAX. Use the deepest reasoning available — exhaustively analyze the problem, validate assumptions, and produce the most robust solution regardless of time.",
};

// Show only the picker panel matching the active radio mode.
export function showModelModePanel(mode) {
  el.modelModeManual.classList.toggle("hidden", mode !== "manual");
  el.modelModeAlways.classList.toggle("hidden", mode !== "always");
  el.modelModeComplexity.classList.toggle("hidden", mode !== "complexity");
}

// Reflect the persisted model-selection config into the settings UI.
// Called on openSettings() (UI open) and after a Re-scan refreshes models.
export function applyModelSelectionModeToUi() {
  let mode = modelSelection.modelSelectionMode || "manual";
  const radio = el.modelModeRadios.querySelector(`input[name="model-mode"][value="${mode}"]`);
  if (radio) {
    radio.checked = true;
  } else {
    // Corrupted/legacy persisted mode — fall back to Manual so the UI is never
    // left with no radio checked and every mode panel hidden.
    mode = "manual";
    const fallback = el.modelModeRadios.querySelector('input[name="model-mode"][value="manual"]');
    if (fallback) fallback.checked = true;
  }
  populateModelSelect(el.alwaysModel, modelSelection.alwaysModel);
  populateModelSelect(el.complexityModelLow, modelSelection.complexityModelLow);
  populateModelSelect(el.complexityModelMedium, modelSelection.complexityModelMedium);
  populateModelSelect(el.complexityModelHigh, modelSelection.complexityModelHigh);
  syncEffortRows();
  showModelModePanel(mode);
}

// Read the current settings-UI values back into `modelSelection` and persist
// each field to its own scopedData key immediately (live persistence).
export function saveModelSelectionMode() {
  const checked = el.modelModeRadios.querySelector('input[name="model-mode"]:checked');
  modelSelection.modelSelectionMode = checked ? checked.value : "manual";
  modelSelection.alwaysModel = el.alwaysModel.value || "";
  modelSelection.complexityModelLow = el.complexityModelLow.value || "";
  modelSelection.complexityModelMedium = el.complexityModelMedium.value || "";
  modelSelection.complexityModelHigh = el.complexityModelHigh.value || "";
  persistModelSelection();
}

// Persist every model-selection field to its own scopedData key.
export function persistModelSelection() {
  for (const key of MS_KEYS) {
    try {
      window.chatoss.scopedData.set(key, modelSelection[key]).catch((e) => console.warn("persistModelSelection", key, e));
    } catch (e) { console.warn("persistModelSelection", key, e); }
  }
}

// On app load: read each model-selection field from its own scopedData key and
// restore the in-memory config + UI. Missing keys keep their defaults.
export async function loadModelSelection() {
  for (const key of MS_KEYS) {
    try {
      const v = await window.chatoss.scopedData.get(key);
      if (v !== undefined && v !== null) modelSelection[key] = v;
    } catch (e) { console.warn("loadModelSelection", key, e); }
  }
  // Sanitize: the effort map must be a plain object of targetId → level.
  if (!modelSelection.subAgentEffort || typeof modelSelection.subAgentEffort !== "object" || Array.isArray(modelSelection.subAgentEffort)) {
    modelSelection.subAgentEffort = {};
  }
  applyModelSelectionModeToUi();
}

// ---------- Folder-trust policy ----------
// Persist + restore trustMode ("ask" | "always") to its own scopedData key.
export async function loadTrustMode() {
  try {
    const v = await window.chatoss.scopedData.get("trustMode");
    if (v === "ask" || v === "always") trustMode = v;
  } catch (e) { console.warn("loadTrustMode", e); }
}
export function persistTrustMode() {
  try { window.chatoss.scopedData.set("trustMode", trustMode).catch((e) => console.warn("persistTrustMode", e)); }
  catch (e) { console.warn("persistTrustMode", e); }
}
// Reflect the persisted trustMode into the settings UI radio group.
export function applyTrustModeToUi() {
  if (!el.trustModeRadios) return;
  const radio = el.trustModeRadios.querySelector(`input[name="trust-mode"][value="${trustMode || "ask"}"]`);
  if (radio) radio.checked = true;
}
// Read the settings-UI trust radio back into trustMode and persist it.
export function saveTrustMode() {
  if (!el.trustModeRadios) return;
  const checked = el.trustModeRadios.querySelector('input[name="trust-mode"]:checked');
  trustMode = checked ? checked.value : "ask";
  persistTrustMode();
}

// Ask the user (IN CHAT, via the askChoice pill picker) whether to approve a
// potentially dangerous command the coding agent wants to run. Resolves true
// for "approve", false for "deny". Used by the persistent auto-approve watcher.
export async function askCommandApproval(rec, commandText) {
  try {
    // Clean again here as a belt-and-suspenders measure: classifyApprovalPrompt
    // already cleaned verdict.command, but this is the final gate before the
    // text reaches the overlay, so any stray spinner glyph / status frame that
    // slipped through another path is stripped here too. Fall back to a short
    // generic label if cleaning left nothing usable.
    const cleaned = cleanApprovalText(commandText) || "(command text unavailable)";
    const short = cleaned.length > 200 ? cleaned.slice(0, 200) + "…" : cleaned;
    const v = await window.termCoder.askChoice({
      prompt: "A coding agent wants to run a command that looks potentially destructive:\n\n" + short,
      options: [
        { label: "Yes, approve it", value: "yes" },
        { label: "No, deny it", value: "no" },
      ],
      style: "rect",
    });
    return v === "yes";
  } catch (e) {
    console.warn("askCommandApproval", e);
    return false;
  }
}

// Ask the user (IN CHAT, via the askChoice pill picker) whether to trust the
// folder a CLI agent is prompting about. Resolves true for "trust", false for
// "don't trust" or if dismissed. Used by autoDriveStartup when trustMode=ask.
export async function askTrustInChat(folderLabel) {
  try {
    const v = await window.termCoder.askChoice({
      prompt: "A coding agent wants to trust this folder before it can run:\n\n" + (folderLabel || "(this folder)"),
      options: [
        { label: "Yes, trust this folder", value: "yes" },
        { label: "No, don't trust", value: "no" },
      ],
      style: "pill",
    });
    return v === "yes";
  } catch (e) {
    console.warn("askTrustInChat", e);
    return false;
  }
}

// Shared read helper for other code (e.g. the session-startup integration).
// Always returns a plain object with the current config + detected models.
