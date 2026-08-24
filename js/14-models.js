import { GENERIC_EFFORT_LEVELS, defaultModelId, models } from "./00-state.js";
import { el } from "./04-dom.js";
import { activeConversation } from "./05-util.js";
export async function loadModels() {
  try {
    const list = await window.chatoss.chat.listModels();
    models = Array.isArray(list) ? list : [];
    defaultModelId = await window.chatoss.chat.getDefaultModel();
  } catch (e) {
    console.warn("listModels", e);
    models = []; defaultModelId = null;
  }
  renderModelPicker();
  renderEffortPicker();
  return models.length;
}

// Retry cadence for the fresh-install case (~26s total). Stops as soon as a
// non-empty list lands. Guarded so concurrent empty renders start ONE chain.
export let _modelRetryScheduled = false;
export function scheduleModelRetries() {
  if (_modelRetryScheduled) return;
  _modelRetryScheduled = true;
  const DELAYS = [700, 1500, 3000, 6000, 10000, 12000];
  let i = 0;
  const tick = async () => {
    if (models.length) { _modelRetryScheduled = false; return; }
    const n = await loadModels();
    if (n === 0 && i < DELAYS.length) {
      setTimeout(tick, DELAYS[i++]);
    } else {
      _modelRetryScheduled = false; // list arrived, or budget exhausted
    }
  };
  setTimeout(tick, DELAYS[i++]);
}

// Display-only renders — no state mutation, no saveState here.
export function renderModelPicker() {
  if (!models.length) {
    // Never leave a silently-blank dropdown: show WHY it is empty. The picker is
    // disabled so its empty state can't be persisted onto a conversation.
    el.modelPicker.innerHTML = "";
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Loading models…";
    el.modelPicker.appendChild(opt);
    el.modelPicker.value = "";
    el.modelPicker.disabled = true;
    scheduleModelRetries(); // covers mid-session loss, harmless when already retried
    return;
  }
  el.modelPicker.disabled = false;
  const c = activeConversation();
  const cur = c && c.modelId ? c.modelId : null;
  let preselect = cur;
  if (!preselect && defaultModelId && models.some((m) => m.id === defaultModelId && m.available)) preselect = defaultModelId;
  if (!preselect) { const first = models.find((m) => m.available) || models[0]; preselect = first ? first.id : null; }

  el.modelPicker.innerHTML = "";
  for (const m of models) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.name + " (" + m.source + ")";
    if (!m.available) { opt.disabled = true; opt.textContent += " — unavailable"; }
    el.modelPicker.appendChild(opt);
  }
  if (preselect) el.modelPicker.value = preselect;
}

// Whether the currently-picked model can take an effort level at all.
// The real signal is the presence of thinkLevels OR a reasoning capability.
// If the model advertises neither, we still let the user pick from a generic
// set — many cloud models accept effort overrides even when listModels() doesn't
// enumerate the exact levels.
export function selectedModelSupportsEffort() {
  const id = el.modelPicker.value;
  const m = models.find((x) => x.id === id);
  return !!(m && (m.thinkLevels && m.thinkLevels.length ||
                        (m.capabilities && m.capabilities.includes("reasoning"))));
}

// Effort levels shown for the orchestrator chat. Prefer the model's own
// thinkLevels; otherwise fall back to the generic expanded set.
export function orchestratorEffortLevels() {
  const id = el.modelPicker.value;
  const m = models.find((x) => x.id === id);
  if (m && m.thinkLevels && m.thinkLevels.length) return m.thinkLevels;
  return GENERIC_EFFORT_LEVELS;
}
export function renderEffortPicker() {
  const c = activeConversation();
  // No model at all (list empty / nothing selected) → disable the picker.
  if (!models.length || !el.modelPicker.value) {
    el.effortPicker.innerHTML = "";
    const o = document.createElement("option");
    o.value = ""; o.textContent = "—";
    el.effortPicker.appendChild(o);
    el.effortPicker.disabled = true;
    el.effortPicker.value = "";
    return;
  }
  const id = el.modelPicker.value;
  const m = models.find((x) => x.id === id);
  const levels = orchestratorEffortLevels();
  const hasEnumeratedLevels = !!(m && m.thinkLevels && m.thinkLevels.length);
  el.effortPicker.innerHTML = "";
  el.effortPicker.disabled = false;
  el.effortPicker.title = hasEnumeratedLevels
    ? "Reasoning effort (levels reported by this model)"
    : "Reasoning effort override (generic levels — effect depends on the model provider)";
  const defOpt = document.createElement("option");
  defOpt.value = "";
  defOpt.textContent = "Default";
  el.effortPicker.appendChild(defOpt);
  for (const lvl of levels) {
    const opt = document.createElement("option");
    opt.value = lvl;
    opt.textContent = lvl.charAt(0).toUpperCase() + lvl.slice(1);
    el.effortPicker.appendChild(opt);
  }
  let eff = c && c.effort ? c.effort : null;
  if (!eff || (!levels.includes(eff) && eff !== "")) eff = m && m.thinkDefault ? m.thinkDefault : "";
  el.effortPicker.value = eff;
}
export function selectedModel() { return el.modelPicker.value; }
export function selectedEffort() {
  if (el.effortPicker.disabled) return null;
  return el.effortPicker.value || null;
}

// ---------- Token estimator ----------
// Heuristic token count: ~4 characters per token, with a floor of 1 token for
// any non-empty string. Good enough for a live estimate without a tokenizer.
