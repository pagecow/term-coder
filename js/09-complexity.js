// 09-complexity.js — classic script (converted from an ES module; see REFACTOR_PLAN.md).
// Exports are registered on the shared window.termCoder namespace (TC).
(function () {
"use strict";
const TC = window.termCoder = window.termCoder || {};
window.termCoder = window.termCoder || {};
window.termCoder.getModelSelectionConfig = function () {
  return {
    mode: TC.modelSelection.modelSelectionMode || "manual",
    alwaysModel: TC.modelSelection.alwaysModel || "",
    complexityModelLow: TC.modelSelection.complexityModelLow || "",
    complexityModelMedium: TC.modelSelection.complexityModelMedium || "",
    complexityModelHigh: TC.modelSelection.complexityModelHigh || "",
    availableModels: TC.availableSessionModels(),
    // Launch targets are ChatOSS MODELS now — each one is passed to
    // `chatoss launch <tool> --model <id>`. The session-startup integration can
    // read these to know every model launchable as a sub-agent.
    availableTargets: TC.availableLaunchTargets(),
    // The persisted "Default agent" (Settings "Default agent" / spawn-modal
    // "Remember as defaults") — which chatoss tool to launch. Normalized so
    // legacy values from older builds resolve to a real tool (or "ask").
    cliDefault: TC.normalizeCliDefault(TC.settings.cliDefault || "ask"),
  };
};

// ---------- Session model resolution (Model Selection Mode) ----------
// Encapsulates all three Model Selection Modes so the session-startup code
// calls a single helper and gets back the model to use (or null to cancel).
//
//   window.termCoder.resolveSessionModel(taskPrompt) -> Promise<string|null>
//
// The returned string is a CHATOSS MODEL id. spawnChosen passes it to
// `chatoss launch <tool> --model <id>` (the tool itself comes from the
// spawn-modal dropdown / the saved Default agent), so this function stays pure
// and knows nothing about how the agent is launched.
//
//   - "manual"     -> prompt via askChoice (pill style) offering every
//                     available ChatOSS model, wait, return the chosen model
//                     id (or null if dismissed — caller cancels).
//   - "always"     -> return cfg.alwaysModel automatically; if it's unset/empty,
//                     fall back to the pill picker so the user can still pick.
//   - "complexity" -> assess the task prompt's complexity (low/medium/high),
//                     return the corresponding configured model automatically
//                     (no prompt). Falls back through the other levels, then to
//                     the first available model if the assessed level is unset.
//
// Keep this pure — it knows nothing about the spawn modal. The caller decides
// whether/how to hide the modal while the pill picker is on screen.

// Lightweight keyword + length heuristic. No chatApi call needed, so it works
// even before the first orchestrator turn and never adds latency.
// Returns "low" | "medium" | "high".
function assessComplexity(taskPrompt) {
  const text = (taskPrompt || "").toLowerCase();
  if (!text.trim()) return "medium";

  // LENGTH IS NOT A PROXY FOR COMPLEXITY HERE. The previous version returned
  // "high" for anything over 200 characters — but the system prompt explicitly
  // instructs the orchestrator to write FOCUSED, DETAILED task prompts naming
  // exact files and constraints, so every delegated subtask cleared 200 chars.
  // The result: every session got the high-complexity model and the Low/Medium
  // settings were dead configuration. A verbose brief for a trivial job is still
  // a trivial job, so length is now only a last-resort nudge.
  const word = (w) => new RegExp("\\b" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b").test(text);
  const anyWord = (list) => list.some(word);

  // Verbs that change the repo vs verbs that only look at it.
  const MUTATE = ["write", "create", "add", "implement", "build", "refactor", "rewrite",
    "modify", "change", "update", "fix", "delete", "remove", "rename", "migrate",
    "port", "install", "configure", "redesign", "overhaul", "optimize", "optimise"];
  const INSPECT = ["read", "list", "report", "summarise", "summarize", "describe",
    "show", "display", "print", "count", "find", "locate", "check", "review",
    "explain", "audit", "inspect"];

  // A pure read-and-report task is LOW however long the brief is. This is the
  // case the old heuristic got most wrong.
  if (anyWord(INSPECT) && !anyWord(MUTATE)) return "low";

  const HIGH = ["architect", "architecture", "migration", "database", "schema",
    "security", "authentication", "authorization", "performance", "scalability",
    "concurren", "distributed", "microservice", "pipeline", "ci/cd",
    "infrastructure", "end-to-end", "refactor", "rewrite", "overhaul",
    "comprehensive", "from scratch", "redesign", "test suite", "state management",
    "design system"];
  const MED = ["add", "create", "build", "fix", "update", "change", "modify",
    "feature", "component", "screen", "page", "endpoint", "handler", "function",
    "method", "style", "css", "layout", "dark mode", "responsive", "accessib"];

  let high = 0, med = 0;
  // Keyword counts use word-boundary matching (NOT text.includes) so substring
  // collisions can't double-count or false-positive: "architecture" must not
  // also match "architect", "address" must not match "add", "prefix" must not
  // match "fix". Two entries are intentional prefixes — "concurren" (→
  // concurrency/concurrent) and "accessib" (→ accessibility/accessible) — and
  // match with only a LEADING boundary so they still catch their word family.
  const kw = (w) => {
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const isPrefix = /(?:concurren|accessib)$/.test(w);
    return new RegExp("\\b" + esc + (isPrefix ? "" : "\\b")).test(text);
  };
  for (const w of HIGH) if (kw(w)) high++;
  for (const w of MED) if (kw(w)) med++;

  // Breadth signals — these say "big" far more reliably than length does, BUT
  // the orchestrator is explicitly instructed to write FOCUSED, DETAILED prompts
  // naming exact files, so a handful of file mentions is ROUTINE, not a
  // complexity signal. Only a genuinely broad span (many files / many enumerated
  // steps) adds a high signal; naming 3–4 files to "create a component + wire it
  // + test it" stays medium.
  const fileMentions = (text.match(/\b[\w./-]+\.(?:js|ts|tsx|jsx|css|scss|html|json|py|rb|go|rs|java|swift|md)\b/g) || []).length;
  const enumeratedSteps = (text.match(/^\s*(?:\d+[.)]|[-*•])\s+/gm) || []).length;
  if (fileMentions >= 6) high++;
  if (enumeratedSteps >= 6) high++;
  if (/\b(?:entire|whole|every|all)\b.{0,24}\b(?:app|project|codebase|file|component)/.test(text)) high++;

  if (high >= 2) return "high";
  if (high === 1) return med >= 3 ? "high" : "medium";
  if (med >= 1) return "medium";
  // Nothing recognisable: a very long brief is probably not trivial.
  return text.length > 600 ? "medium" : "low";
}

// Single helper that routes through the configured Model Selection Mode.
// Returns the ChatOSS MODEL id to pass to `chatoss launch <tool> --model`, or
// null to cancel the session.
window.termCoder.resolveSessionModel = async function resolveSessionModel(taskPrompt) {
  const cfg = window.termCoder.getModelSelectionConfig();
  // Available launch targets are ChatOSS models. `availableModels` carries the
  // bare ids (legacy field kept for the session-startup integration).
  const targets = Array.isArray(cfg.availableTargets) && cfg.availableTargets.length
    ? cfg.availableTargets
    : (Array.isArray(cfg.availableModels) ? cfg.availableModels.map((m) => ({ kind: "chatoss", id: m, label: m, model: m })) : []);
  // Bare id list for membership checks and "always"/"complexity" validation.
  const ids = targets.map((t) => t.id);
  const opts = targets.map((t) => ({ label: t.label, value: t.id }));

  // ---- Always: use the configured fixed model, no prompt. ----
  if (cfg.mode === "always") {
    if (cfg.alwaysModel) return cfg.alwaysModel;
    // No always-model configured yet — fall back to a pill picker so the
    // session can still start, and hint that Settings has the real config.
    if (opts.length) {
      return await window.termCoder.askChoice({
        prompt: "No \"always\" model is configured yet — pick one for this session (or set it in Settings):",
        options: opts,
        style: "pill",
      });
    }
    // B3: no ChatOSS models available at all — distinguish from a user cancel
    // (null) so the caller can show an actionable message instead of silently
    // dismissing the spawn modal. Throw a recognizable error.
    const e = new Error("No ChatOSS models available. Run Re-scan in Settings, or open ChatOSS and pick a model.");
    e.code = "NO_MODELS";
    throw e;
  }

  // ---- Complexity: assess + map, no prompt. ----
  if (cfg.mode === "complexity") {
    const level = assessComplexity(taskPrompt);
    const map = {
      low: cfg.complexityModelLow,
      medium: cfg.complexityModelMedium,
      high: cfg.complexityModelHigh,
    };
    // Use the assessed level; cascade to a sensible fallback if it's unset.
    const target = map[level] || map.medium || map.low || map.high;
    if (target) return target;
    if (ids.length) return ids[0]; // last-resort default
    const e = new Error("No ChatOSS models available. Run Re-scan in Settings, or open ChatOSS and pick a model.");
    e.code = "NO_MODELS";
    throw e;
  }

  // ---- Manual (default): prompt via pills and wait for the pick. ----
  if (!opts.length) {
    const e = new Error("No ChatOSS models available. Run Re-scan in Settings, or open ChatOSS and pick a model.");
    e.code = "NO_MODELS";
    throw e;
  }
  return await window.termCoder.askChoice({
    prompt: "Select a ChatOSS model for this session:",
    options: opts,
    style: "pill",
  });
};

// ---------- Board picker ----------
// --- exports ---
TC.assessComplexity = assessComplexity;
})();
