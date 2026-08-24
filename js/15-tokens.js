import { CONTEXT_WINDOW_MAP, DEFAULT_CONTEXT_WINDOW, SYSTEM_PROMPT_FALLBACK, _lastBreakdown, _lastMax, _lastSystemPrompt, defaultModelId, models } from "./00-state.js";
import { el } from "./04-dom.js";
import { activeConversation, esc } from "./05-util.js";
import { ORCHESTRATOR_TOOLS } from "./06-tools.js";
import { selectedModel } from "./14-models.js";
export function estimateTokens(text) {
  if (text == null) return 0;
  const s = String(text);
  if (!s.length) return 0;
  return Math.max(1, Math.round(s.length / 4));
}

// Resolve the max context window for a model id. Prefers the model's own
// contextLength from listModels(); falls back to the CONTEXT_WINDOW_MAP, then
// a default. Returns 0 when no model is selected.
export function maxTokensForModel(modelId) {
  if (!modelId) return 0;
  const m = models.find((x) => x.id === modelId);
  if (m && m.contextLength && m.contextLength > 0) return m.contextLength;
  for (const entry of CONTEXT_WINDOW_MAP) {
    if (entry.match.test(modelId)) return entry.tokens;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

// Estimate the token cost of the tool definitions (JSON schema) passed to
// runTurn. Serializes each tool and counts it with the same heuristic.
export function estimateToolTokens(tools) {
  if (!tools || !tools.length) return 0;
  let total = 0;
  for (const t of tools) {
    try { total += estimateTokens(JSON.stringify(t)); } catch (e) { /* ignore */ }
  }
  return total;
}

// Build the full token breakdown for the current composer state. Categories:
//   - system prompt (cached from the last real turn, or a static fallback)
//   - tool definitions (ORCHESTRATOR_TOOLS JSON schema)
//   - messages (the conversation history that will be sent)
//   - draft (the text currently typed in the composer)
// Returns { system, tools, messages, draft, total, max }.
export function computeTokenBreakdown() {
  const c = activeConversation();
  const modelId = selectedModel() || defaultModelId;
  const max = maxTokensForModel(modelId);

  const systemText = _lastSystemPrompt || SYSTEM_PROMPT_FALLBACK;
  const system = estimateTokens(systemText);
  const tools = estimateToolTokens(ORCHESTRATOR_TOOLS);

  let messages = 0;
  if (c && c.messages) {
    for (const m of c.messages) {
      if (m.role === "user" || m.role === "assistant") {
        messages += estimateTokens(m.content);
      }
    }
  }

  const draft = estimateTokens(el.chatInput ? el.chatInput.value : "");

  return { system, tools, messages, draft, total: system + tools + messages + draft, max };
}

// Render the estimator: the "current / max" text, the progress ring, and the
// popover breakdown. Called on input, on model change, and after each turn.
export function renderTokenEstimator() {
  if (!el.tokenEstimator) return;
  const b = computeTokenBreakdown();
  _lastBreakdown = b;
  _lastMax = b.max;

  const pct = b.max > 0 ? Math.min(1, b.total / b.max) : 0;
  const pctInt = Math.round(pct * 100);

  if (el.tokenCount) {
    el.tokenCount.textContent = b.total.toLocaleString();
  }
  if (el.tokenMax) {
    el.tokenMax.textContent = b.max > 0 ? b.max.toLocaleString() : "—";
  }
  if (el.tokenRingFill) {
    // stroke-dasharray is 100 100, so offset 100 = empty, 0 = full.
    el.tokenRingFill.style.strokeDashoffset = String(100 - pct * 100);
    el.tokenRingFill.classList.toggle("is-warn", pct >= 0.75 && pct < 1);
    el.tokenRingFill.classList.toggle("is-over", pct >= 1);
  }
  if (el.tokenEstimatorBtn) {
    el.tokenEstimatorBtn.setAttribute(
      "aria-label",
      "Token usage: " + b.total.toLocaleString() + " of " + (b.max > 0 ? b.max.toLocaleString() : "unknown") + " tokens (" + pctInt + "%)"
    );
  }
  renderTokenPopover();
}

// Render the popover breakdown (only when open). Each category shows its count
// and a bar proportional to its share of the total.
export function renderTokenPopover() {
  if (!el.tokenPopover || el.tokenPopover.hidden) return;
  const b = _lastBreakdown || computeTokenBreakdown();
  const rows = [
    { key: "system", label: "System prompt", n: b.system },
    { key: "tools", label: "Tool definitions", n: b.tools },
    { key: "messages", label: "Messages", n: b.messages },
    { key: "draft", label: "Draft (typed)", n: b.draft },
  ];
  const maxN = Math.max(1, ...rows.map((r) => r.n));
  const pct = b.max > 0 ? Math.min(1, b.total / b.max) : 0;

  let html = '<div class="token-popover-head"><span>Token breakdown</span>' +
    '<span class="token-popover-total">' + b.total.toLocaleString() + " / " + (b.max > 0 ? b.max.toLocaleString() : "—") + "</span></div>";
  for (const r of rows) {
    const share = r.n > 0 ? Math.max(2, Math.round((r.n / maxN) * 100)) : 0;
    html += '<div class="token-popover-row">' +
      '<div class="token-popover-label"><span>' + esc(r.label) + '</span>' +
      '<span class="token-popover-num">' + r.n.toLocaleString() + "</span></div>" +
      '<div class="token-popover-bar"><div class="token-popover-bar-fill" style="width:' + share + '%"></div></div>' +
      "</div>";
  }
  html += '<div class="token-popover-note">Estimate: ~4 characters per token. ' +
    (b.max > 0 ? "Context used: " + Math.round(pct * 100) + "%." : "No model selected.") + "</div>";
  el.tokenPopover.innerHTML = html;
}

export function openTokenPopover() {
  if (!el.tokenPopover) return;
  el.tokenPopover.hidden = false;
  el.tokenEstimatorBtn.setAttribute("aria-expanded", "true");
  renderTokenPopover();
}
export function closeTokenPopover() {
  if (!el.tokenPopover) return;
  el.tokenPopover.hidden = true;
  el.tokenEstimatorBtn.setAttribute("aria-expanded", "false");
}
export function toggleTokenPopover() {
  if (el.tokenPopover && !el.tokenPopover.hidden) closeTokenPopover();
  else openTokenPopover();
}

// ---------- Attachments (files + images) ----------
// Per-conversation attachments: an array of { id, name, kind: 'image'|'file',
// dataUrl?, text?, path? }. Images are stored as data URLs (base64) so they can
// be previewed and passed to runTurn as multimodal content. Text files are read
// and embedded into the user's message as context.
