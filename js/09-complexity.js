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
    availableModels: TC.availableOllamaModels(),
    // Unified launch targets: direct CLIs (claude/codex/opencode) + ollama
    // models. The session-startup integration can read these to know everything
    // launchable.
    availableTargets: TC.availableLaunchTargets(),
    // The persisted "default launch" (Settings "Default agent" / spawn-modal
    // "Remember as default"). resolveSessionModel applies it automatically on
    // session start so the orchestrator does not re-ask every time.
    cliDefault: TC.settings.cliDefault || "ask",
  };
};

// ---------- Session model resolution (Model Selection Mode) ----------
// Encapsulates all three Model Selection Modes so the session-startup code
// calls a single helper and gets back the launch target to use (or null to
// cancel).
//
//   window.termCoder.resolveSessionModel(taskPrompt) -> Promise<string|null>
//
// The returned string is a LAUNCH TARGET id — either a direct CLI ("claude" /
// "codex", launched directly via the terminal capability) or an ollama model
// name (launched through `ollama launch`). spawnChosen reads the id back with
// findLaunchTarget()/targetKind() to build the right spawn command, so this
// function stays pure and knows nothing about how the binary is launched.
//
//   - "manual"     -> prompt via askChoice (pill style) offering every launch
//                     target (claude, codex, ollama models), wait, return the
//                     chosen target id (or null if dismissed — caller cancels).
//   - "always"     -> return cfg.alwaysModel automatically (now also accepts a
//                     direct-CLI id); if it's unset/empty, fall back to the
//                     pill picker so the user can still pick a target.
//   - "complexity" -> assess the task prompt's complexity (low/medium/high),
//                     return the corresponding configured target automatically
//                     (no prompt). Falls back through the other levels, then to
//                     the first available target if the assessed level is unset.
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
// Returns a launch-target id to apply (direct CLI name or ollama model), or
// null to cancel the session.
window.termCoder.resolveSessionModel = async function resolveSessionModel(taskPrompt) {
  const cfg = window.termCoder.getModelSelectionConfig();
  // Unified launch targets (direct CLIs + ollama models) — supersedes the
  // ollama-only `availableModels` list so the picker can offer
  // claude/codex/opencode directly alongside ollama models.
  const targets = Array.isArray(cfg.availableTargets) && cfg.availableTargets.length
    ? cfg.availableTargets
    : (Array.isArray(cfg.availableModels) ? cfg.availableModels.map((m) => ({ kind: "ollama", id: m, label: m, model: m })) : []);
  // Bare id list for membership checks and "always"/"complexity" validation.
  const ids = targets.map((t) => t.id);
  const opts = targets.map((t) => ({ label: t.label, value: t.id }));

  // ---- Saved default launch takes priority over the mode branches. ----
  // The "Default agent" Settings picker and the spawn-modal "Remember as
  // default" checkbox both persist into settings.cliDefault (exposed here as
  // cfg.cliDefault). When the user pinned a default that maps to a CURRENTLY
  // AVAILABLE launch target, apply it automatically and skip the pill picker —
  // this is the fix for the orchestrator re-asking which launch to use on every
  // session even after a default was set. "Ask me every time" (and values that
  // don't map to a concrete target, e.g. the bare ollama-tool names that still
  // need a model) resolve to null here and fall through to the Model Selection
  // Mode logic below, so the picker still appears exactly when it should.
  const defId = TC.cliDefaultToTargetId(cfg.cliDefault);
  if (defId && ids.includes(defId)) return defId;

  // ---- Always: use the configured fixed target, no prompt. ----
  if (cfg.mode === "always") {
    if (cfg.alwaysModel) return cfg.alwaysModel;
    // No always-target configured yet — fall back to a pill picker so the
    // session can still start, and hint that Settings has the real config.
    if (opts.length) {
      return await window.termCoder.askChoice({
        prompt: "No \"always\" target is configured yet — pick one for this session (or set it in Settings):",
        options: opts,
        style: "pill",
      });
    }
    // B3: no models/targets detected at all — distinguish from a user cancel
    // (null) so the caller can show an actionable message instead of silently
    // dismissing the spawn modal. Throw a recognizable error.
    const e = new Error("No launch targets detected. Run Re-scan in Settings, install ollama/a CLI, or switch Model Selection Mode.");
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
    const e = new Error("No launch targets detected. Run Re-scan in Settings, install ollama/a CLI, or switch Model Selection Mode.");
    e.code = "NO_MODELS";
    throw e;
  }

  // ---- Manual (default): prompt via pills and wait for the pick. ----
  if (!opts.length) {
    const e = new Error("No launch targets detected. Run Re-scan in Settings, install ollama/a CLI, or switch Model Selection Mode.");
    e.code = "NO_MODELS";
    throw e;
  }
  return await window.termCoder.askChoice({
    prompt: "Select a launch target for this session:",
    options: opts,
    style: "pill",
  });
};

// ---------- Board picker ----------
// --- exports ---
TC.assessComplexity = assessComplexity;
})();
