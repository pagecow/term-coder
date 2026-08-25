// 14-models.js — classic script (converted from an ES module; see REFACTOR_PLAN.md).
// Exports are registered on the shared window.termCoder namespace (TC).
(function () {
"use strict";
const TC = window.termCoder = window.termCoder || {};
async function loadModels() {
  try {
    const list = await window.chatoss.chat.listModels();
    // `models` is an imported binding (read-only) — mutate the array in place.
    TC.models.splice(0, TC.models.length, ...(Array.isArray(list) ? list : []));
    TC.setDefaultModelId(await window.chatoss.chat.getDefaultModel());
  } catch (e) {
    console.warn("listModels", e);
    TC.models.splice(0, TC.models.length); TC.setDefaultModelId(null);
  }
  renderModelPicker();
  renderEffortPicker();
  return TC.models.length;
}

// Retry cadence for the fresh-install case (~26s total). Stops as soon as a
// non-empty list lands. Guarded so concurrent empty renders start ONE chain.
let _modelRetryScheduled = false;
function scheduleModelRetries() {
  if (_modelRetryScheduled) return;
  _modelRetryScheduled = true;
  const DELAYS = [700, 1500, 3000, 6000, 10000, 12000];
  let i = 0;
  const tick = async () => {
    if (TC.models.length) { _modelRetryScheduled = false; return; }
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
function renderModelPicker() {
  if (!TC.models.length) {
    // Never leave a silently-blank dropdown: show WHY it is empty. The picker is
    // disabled so its empty state can't be persisted onto a conversation.
    TC.el.modelPicker.innerHTML = "";
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Loading models…";
    TC.el.modelPicker.appendChild(opt);
    TC.el.modelPicker.value = "";
    TC.el.modelPicker.disabled = true;
    scheduleModelRetries(); // covers mid-session loss, harmless when already retried
    return;
  }
  TC.el.modelPicker.disabled = false;
  const c = TC.activeConversation();
  const cur = c && c.modelId ? c.modelId : null;
  let preselect = cur;
  if (!preselect && TC.defaultModelId && TC.models.some((m) => m.id === TC.defaultModelId && m.available)) preselect = TC.defaultModelId;
  if (!preselect) { const first = TC.models.find((m) => m.available) || TC.models[0]; preselect = first ? first.id : null; }

  TC.el.modelPicker.innerHTML = "";
  for (const m of TC.models) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.name + " (" + m.source + ")";
    if (!m.available) { opt.disabled = true; opt.textContent += " — unavailable"; }
    TC.el.modelPicker.appendChild(opt);
  }
  if (preselect) TC.el.modelPicker.value = preselect;
}

// Whether the currently-picked model can take an effort level at all.
// The real signal is the presence of thinkLevels OR a reasoning capability.
// If the model advertises neither, we still let the user pick from a generic
// set — many cloud models accept effort overrides even when listModels() doesn't
// enumerate the exact levels.
function selectedModelSupportsEffort() {
  const id = TC.el.modelPicker.value;
  const m = TC.models.find((x) => x.id === id);
  return !!(m && (m.thinkLevels && m.thinkLevels.length ||
                        (m.capabilities && m.capabilities.includes("reasoning"))));
}

// Effort levels shown for the orchestrator chat. Prefer the model's own
// thinkLevels; otherwise fall back to the generic expanded set.
function orchestratorEffortLevels() {
  const id = TC.el.modelPicker.value;
  const m = TC.models.find((x) => x.id === id);
  if (m && m.thinkLevels && m.thinkLevels.length) return m.thinkLevels;
  return TC.GENERIC_EFFORT_LEVELS;
}
function renderEffortPicker() {
  const c = TC.activeConversation();
  // No model at all (list empty / nothing selected) → disable the picker.
  if (!TC.models.length || !TC.el.modelPicker.value) {
    TC.el.effortPicker.innerHTML = "";
    const o = document.createElement("option");
    o.value = ""; o.textContent = "—";
    TC.el.effortPicker.appendChild(o);
    TC.el.effortPicker.disabled = true;
    TC.el.effortPicker.value = "";
    return;
  }
  const id = TC.el.modelPicker.value;
  const m = TC.models.find((x) => x.id === id);
  const levels = orchestratorEffortLevels();
  const hasEnumeratedLevels = !!(m && m.thinkLevels && m.thinkLevels.length);
  TC.el.effortPicker.innerHTML = "";
  TC.el.effortPicker.disabled = false;
  TC.el.effortPicker.title = hasEnumeratedLevels
    ? "Reasoning effort (levels reported by this model)"
    : "Reasoning effort override (generic levels — effect depends on the model provider)";
  const defOpt = document.createElement("option");
  defOpt.value = "";
  defOpt.textContent = "Default";
  TC.el.effortPicker.appendChild(defOpt);
  for (const lvl of levels) {
    const opt = document.createElement("option");
    opt.value = lvl;
    opt.textContent = lvl.charAt(0).toUpperCase() + lvl.slice(1);
    TC.el.effortPicker.appendChild(opt);
  }
  let eff = c && c.effort ? c.effort : null;
  if (!eff || (!levels.includes(eff) && eff !== "")) eff = m && m.thinkDefault ? m.thinkDefault : "";
  TC.el.effortPicker.value = eff;
}
function selectedModel() { return TC.el.modelPicker.value; }
function selectedEffort() {
  if (TC.el.effortPicker.disabled) return null;
  return TC.el.effortPicker.value || null;
}

// ---------- Token estimator ----------
// Heuristic token count: ~4 characters per token, with a floor of 1 token for
// any non-empty string. Good enough for a live estimate without a tokenizer.
// --- exports ---
Object.defineProperty(TC, "_modelRetryScheduled", { get: () => _modelRetryScheduled, set: (v) => { _modelRetryScheduled = v; }, configurable: true });
TC.loadModels = loadModels;
TC.scheduleModelRetries = scheduleModelRetries;
TC.renderModelPicker = renderModelPicker;
TC.selectedModelSupportsEffort = selectedModelSupportsEffort;
TC.orchestratorEffortLevels = orchestratorEffortLevels;
TC.renderEffortPicker = renderEffortPicker;
TC.selectedModel = selectedModel;
TC.selectedEffort = selectedEffort;
})();
