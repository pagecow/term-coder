import { $, el } from "./04-dom.js";
import { activeConversation, saveState } from "./05-util.js";
export const boardNameCache = {};
export async function resolveBoardName(boardId) {
  if (!boardId) return "";
  if (boardNameCache[boardId]) return boardNameCache[boardId];
  try {
    const b = await window.chatoss.boards.get(boardId);
    const n = b && b.name ? b.name : "Board";
    boardNameCache[boardId] = n;
    return n;
  } catch (e) {
    return "Board";
  }
}
export async function renderBoardChip() {
  const c = activeConversation();
  const chip = el.boardChip;
  if (!chip) return;
  if (c && c.boardId) {
    chip.classList.remove("hidden");
    el.attachedBoardName.textContent = "…";
    el.attachBoardBtn.classList.add("hidden");
    const name = await resolveBoardName(c.boardId);
    // conversation may have changed while awaiting
    const cur = activeConversation();
    if (cur && cur.boardId === c.boardId) el.attachedBoardName.textContent = name;
  } else {
    chip.classList.add("hidden");
    el.attachBoardBtn.classList.remove("hidden");
  }
}
export function detachBoard() {
  const c = activeConversation();
  if (!c) return;
  c.boardId = null;
  saveState();
  renderBoardChip();
}

// ---------- Markdown renderer (self-contained, no dependencies) ----------
// Minimal, safe CommonMark-ish renderer: escapes HTML first, then applies
// block + inline transforms. Supports headings, fenced code blocks, tables,
// blockquotes, ordered/unordered lists, hr, bold/italic/strike/code, links,
// and inline code. Returns an HTML string.
export function mdEscape(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Apply inline markdown (bold, italic, strike, code, links) to an already-
// escaped string. Order matters: inline code first (protect its contents),
// then links, then emphasis. Uses unique placeholder tokens to avoid
// colliding with text content.
export function mdInline(escaped) {
  let out = escaped;
  const stash = [];
  const stashPush = (html) => { stash.push(html); return "\u0000" + (stash.length - 1) + "\u0000"; };

  // Inline code: `code`  (single or triple backticks allowed)
  out = out.replace(/```([^`]+)```|`([^`]+)`/g, (_m, a, b) =>
    stashPush('<code class="md-inline-code">' + mdEscape(a != null ? a : b) + "</code>"));

  // Links: [text](url)  — url must be http(s)/mailto only (no javascript:)
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text, url) => {
    const safe = /^(https?:\/\/|mailto:)/i.test(url) ? url : "#";
    return stashPush('<a href="' + mdEscape(safe) + '" target="_blank" rel="noopener noreferrer">' + text + "</a>");
  });

  // Bold: **text** or __text__
  out = out.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_m, a, b) =>
    stashPush("<strong>" + (a != null ? a : b) + "</strong>"));
  // Italic: *text* or _text_
  out = out.replace(/(^|[^*])\*([^*\n]+)\*|(^|[^_])_([^_\n]+)_/g, (m, p1, a, p2, b) =>
    (p1 || p2 || "") + stashPush("<em>" + (a != null ? a : b) + "</em>"));
  // Strikethrough: ~~text~~
  out = out.replace(/~~([^~]+)~~/g, (_m, a) => stashPush("<del>" + a + "</del>"));

  // Restore stashed HTML fragments.
  out = out.replace(/\u0000(\d+)\u0000/g, (_m, i) => stash[Number(i)] || "");
  return out;
}

// Render a single block of lines (already split) into HTML. Used for table rows,
// list items, paragraphs, etc.
export function mdRenderTable(lines) {
  if (lines.length < 2) return null;
  const splitRow = (l) => l.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const header = splitRow(lines[0]);
  const sep = splitRow(lines[1]);
  if (!header.length || !sep.every((c) => /^:?-+:?$/.test(c))) return null;
  const rows = lines.slice(2).map(splitRow);
  let html = '<div class="md-table-wrap"><table class="md-table"><thead><tr>';
  for (const h of header) html += "<th>" + mdInline(h) + "</th>";
  html += "</tr></thead><tbody>";
  for (const r of rows) {
    html += "<tr>";
    for (let i = 0; i < header.length; i++) html += "<td>" + mdInline(r[i] || "") + "</td>";
    html += "</tr>";
  }
  html += "</tbody></table></div>";
  return html;
}

export function mdRenderList(items, ordered) {
  // Detect GitHub-style task lists: every item starts with [ ] or [x].
  const allTasks = items.length > 0 && items.every((it) => /^\s*([-*+]|\d+\.)\s+\[[ xX]\]\s+/i.test(it));
  const tag = ordered ? "ol" : "ul";
  const cls = allTasks ? "md-list md-task-list" : "md-list";
  let html = '<' + tag + ' class="' + cls + '">';
  for (const it of items) {
    let body = it;
    if (allTasks) {
      const tm = it.match(/^\s*([-*+]|\d+\.)\s+\[([ xX])\]\s+(.*)$/i);
      const checked = tm && tm[2] && /[xX]/.test(tm[2]);
      body = tm ? tm[3] : it;
      const box = '<span class="md-task-box' + (checked ? " is-checked" : "") + '" aria-hidden="true">' +
        (checked ? "✓" : "") + "</span>";
      html += '<li class="md-task-item' + (checked ? " is-done" : "") + '">' + box + mdInline(mdEscape(body)) + "</li>";
    } else {
      const m = it.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/s);
      body = m ? m[3] : it;
      html += "<li>" + mdInline(mdEscape(body)) + "</li>";
    }
  }
  html += "</" + tag + ">";
  return html;
}

// Main markdown -> HTML. Code-fence contents are passed through RAW (then
// escaped + syntax-highlighted inside renderCodeBlockHtml); all other text is
// escaped first, then block + inline transforms are applied. Supports headings,
// fenced code blocks, tables, blockquotes, task lists, ordered/unordered lists,
// hr, bold/italic/strike/code, links, and inline code. Returns an HTML string.
export function renderMarkdown(src) {
  if (!src) return "";
  const text = String(src).replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    let line = lines[i];

    // Fenced code block: ```lang ... ```  (raw content — handled specially)
    const fence = line.match(/^```(.*)$/);
    if (fence) {
      const lang = fence[1].trim();
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { code.push(lines[i]); i++; }
      i++; // skip closing fence
      out.push(renderCodeBlockHtml(code.join("\n"), lang));
      continue;
    }

    // Horizontal rule
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { out.push('<hr class="md-hr" />'); i++; continue; }

    // Heading: # .. ######
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lvl = h[1].length;
      out.push('<h' + lvl + ' class="md-h md-h' + lvl + '">' + mdInline(mdEscape(h[2])) + "</h" + lvl + ">");
      i++;
      continue;
    }

    // Blockquote: collect consecutive ">" lines
    if (/^>\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      out.push('<blockquote class="md-blockquote">' + mdInline(mdEscape(quote.join(" "))) + "</blockquote>");
      continue;
    }

    // Table: a line with | followed by a separator line
    if (line.indexOf("|") !== -1 && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      const tbl = [line];
      let j = i + 1;
      while (j < lines.length && lines[j].indexOf("|") !== -1 && lines[j].trim()) { tbl.push(lines[j]); j++; }
      const rendered = mdRenderTable(tbl);
      if (rendered) { out.push(rendered); i = j; continue; }
    }

    // List: collect consecutive list-item lines (mixed markers allowed, incl. task lists)
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const items = [];
      let ordered = /^\s*\d+\.\s+/.test(line);
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i]);
        i++;
      }
      out.push(mdRenderList(items, ordered));
      continue;
    }

    // Blank line -> paragraph break
    if (line.trim() === "") { i++; continue; }

    // Paragraph: collect consecutive non-blank, non-block lines
    const para = [];
    while (i < lines.length && lines[i].trim() !== "" &&
      !/^```/.test(lines[i]) && !/^#{1,6}\s+/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) && !/^\s*([-*+*]|\d+\.)\s+/.test(lines[i]) &&
      !/^\s*([-*_])\1{2,}\s*$/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    if (para.length) out.push("<p>" + mdInline(mdEscape(para.join("\n"))).replace(/\n/g, "<br>") + "</p>");
  }
  return out.join("");
}

// ---------- Dependency-free syntax highlighting ----------
// A tiny, safe tokenizer that wraps tokens in <span class="tok-…">. It operates
// on RAW code (not yet HTML-escaped) and escapes each token as it emits it, so
// it is XSS-safe. Languages share a generic pass; a few (js/ts/json/css) get a
// richer keyword/operator set. No external library, no build step.

export const HL_KEYWORDS = {
  js: "const let var function return if else for while do switch case break continue new class extends super this typeof instanceof void delete in of async await yield import export default from as try catch finally throw static get set null undefined true false NaN Infinity",
  ts: "const let var function return if else for while do switch case break continue new class extends super this typeof instanceof void delete in of async await yield import export default from as try catch finally throw static get set null undefined true false NaN Infinity public private protected readonly enum interface type namespace implements abstract declare",
  jsx: "const let var function return if else for while do switch case break continue new class extends super this typeof instanceof void delete in of async await yield import export default from as try catch finally throw static get set null undefined true false NaN Infinity",
  tsx: "const let var function return if else for while do switch case break continue new class extends super this typeof instanceof void delete in of async await yield import export default from as try catch finally throw static get set null undefined true false NaN Infinity public private protected readonly enum interface type namespace implements abstract declare",
  json: "true false null",
  py: "def class return if elif else for while break continue pass import from as with try except finally raise lambda global nonlocal yield async await is in not and or None True False self print",
  sh: "if then fi else elif case esac for while do done function return export local echo read source unset set in",
  go: "func var const type struct interface return if else for range switch case default break continue go defer chan map package import fallthrough nil true false",
  rust: "fn let mut const static struct enum impl trait return if else for while loop match break continue as use pub mod ref move self Self dyn unsafe extern crate type where async await",
  sql: "SELECT FROM WHERE INSERT INTO UPDATE DELETE CREATE TABLE ALTER DROP JOIN LEFT RIGHT INNER OUTER ON GROUP BY ORDER HAVING LIMIT OFFSET VALUES SET NULL NOT AND OR AS DISTINCT PRIMARY KEY FOREIGN REFERENCES DEFAULT UNIQUE INDEX",
};

export function hlLangFor(lang) {
  const l = String(lang || "").toLowerCase().replace(/^x-/, "").replace(/\.(.*)$/, "$1");
  if (HL_KEYWORDS[l]) return l;
  if (l === "javascript" || l === "js") return "js";
  if (l === "typescript" || l === "ts") return "ts";
  if (l === "jsx") return "jsx";
  if (l === "tsx") return "tsx";
  if (l === "python" || l === "py" || l === "py3") return "py";
  if (l === "bash" || l === "sh" || l === "shell" || l === "zsh") return "sh";
  if (l === "golang" || l === "go") return "go";
  if (l === "rs" || l === "rust") return "rust";
  if (l === "sql" || l === "psql") return "sql";
  return l || "code";
}

// Tokenize a single line into [{t: type, v: raw}] pieces. The tokenizer is a
// single ordered regex pass per line, which is plenty for read-only previews.
export function hlLine(raw, langKey) {
  const kw = HL_KEYWORDS[langKey] ? HL_KEYWORDS[langKey].split(" ") : null;
  const kwSet = kw ? new Set(kw) : null;
  // Order: comments, strings, numbers, then identifiers/words, then operators/punct.
  const tokenRe = /(#.*$|\/\/.*$|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b0x[0-9a-fA-F]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([A-Za-z_$][A-Za-z0-9_$]*)|(\s+)|([^\sA-Za-z0-9_$]+)/g;
  const out = [];
  let m;
  while ((m = tokenRe.exec(raw)) !== null) {
    if (m[1] !== undefined) out.push({ t: "comment", v: m[1] });
    else if (m[2] !== undefined) out.push({ t: "string", v: m[2] });
    else if (m[3] !== undefined) out.push({ t: "num", v: m[3] });
    else if (m[4] !== undefined) {
      const w = m[4];
      if (kwSet && kwSet.has(w)) out.push({ t: "kw", v: w });
      else if (/^[A-Z][A-Za-z0-9_]*$/.test(w)) out.push({ t: "type", v: w });
      else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(w) && raw[tokenRe.lastIndex] === "(") out.push({ t: "fn", v: w });
      else out.push({ t: "word", v: w });
    } else if (m[5] !== undefined) out.push({ t: "ws", v: m[5] });
    else if (m[6] !== undefined) out.push({ t: "op", v: m[6] });
  }
  return out;
}

export function hlEscape(s) {
  return String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

// Highlight raw code into an HTML string of <span> tokens, one line per row so
// long lines scroll horizontally without reflowing tokens.
export function highlightCode(raw, lang) {
  const langKey = hlLangFor(lang);
  const lines = String(raw == null ? "" : raw).split("\n");
  let html = "";
  for (let li = 0; li < lines.length; li++) {
    const toks = hlLine(lines[li], langKey);
    let lineHtml = "";
    for (const tk of toks) {
      if (tk.t === "ws" || tk.t === "word") { lineHtml += hlEscape(tk.v); continue; }
      lineHtml += '<span class="tok-' + tk.t + '">' + hlEscape(tk.v) + "</span>";
    }
    if (lineHtml === "" && li < lines.length - 1) lineHtml = " ";
    html += lineHtml;
    if (li < lines.length - 1) html += "\n";
  }
  return html;
}

// Build the HTML for a fenced code block: syntax-highlighted code + language
// label + copy button. The copy button uses data-code-copy which a delegated
// click listener copies to the clipboard.
export function renderCodeBlockHtml(rawCode, lang) {
  const langLabel = lang ? mdEscape(lang) : "";
  const langKey = hlLangFor(lang);
  const id = "code-" + (crypto.randomUUID ? crypto.randomUUID() : "c" + Date.now() + Math.random().toString(36).slice(2));
  const highlighted = highlightCode(rawCode, langKey);
  return (
    '<div class="md-code-block" data-lang="' + langKey + '">' +
      '<div class="md-code-head">' +
        '<span class="md-code-lang">' + (langLabel || "code") + "</span>" +
        '<button class="md-code-copy" type="button" data-code-copy="' + id + '" title="Copy code" aria-label="Copy code"><span class="md-code-copy-ic">⧉</span>Copy</button>' +
      "</div>" +
      '<pre class="md-code-pre"><code id="' + id + '">' + highlighted + "</code></pre>" +
    "</div>"
  );
}

// Copy text to the clipboard, preferring the platform clipboardWrite API and
// falling back to a hidden textarea + execCommand('copy'). Resolves a bool.
export async function copyToClipboard(text) {
  try {
    if (window.chatoss && window.chatoss.clipboard && window.chatoss.clipboard.writeText) {
      return await window.chatoss.clipboard.writeText(String(text));
    }
  } catch (e) { /* fall through */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = String(text);
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch (e) { return false; }
}

// ---------- Collapsible thinking widget ----------
// Codex-desktop-style reasoning container: a subtle, DIMMED disclosure row that
// is FULLY collapsed by default — just a "Thinking…" header, no preview — so the
// reasoning never competes with the actual response text. Clicking the header
// expands the full reasoning inline; clicking again collapses it. The header
// doubles as the "still thinking" indicator (💭 Thinking… while streaming,
// Thought process when done) and carries a live word count while streaming.
//
// Streaming contract: onThinking only calls _update() — the widget STAYS
// collapsed while tokens accumulate (the word count ticks up in the header), so
