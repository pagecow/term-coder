// Collapsible thinking-widget tests for Term Coder.
//
// Feature: the model's reasoning/thinking tokens render in a Codex-desktop-app
// style collapsible container — a small, DIMMED box that is collapsed by
// default but shows a short preview (max-height ~120px) with a fade, plus a
// "Show more ↓" button to expand the full text and "Show less ↑" to collapse.
// The thinking text is visually distinct from the response (muted/monospace).
// While streaming, the widget STAYS collapsed and the latest snippet is visible
// inside the preview window; it never auto-expands.
//
// app.js is a browser module, so it can't be `require`d whole in Node. Same
// approach as the other test files: read the REAL app.js source, extract the
// real `createThinkingWidget` function, and EXECUTE it against a tiny DOM mock
// so we assert the actual runtime behavior (not just source strings).
//
// Run: node tests/thinking-collapsible.test.js   (no test runner, no deps)

const fs = require("fs");
const path = require("path");
const { assert, test, run } = require("./harness.js");

const SRC = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

// Extract a top-level `function NAME(...) { ... }` whose closing brace sits at
// column 0, and return a factory that evaluates it in a sandbox.
function extractFunction(src, name) {
  const re = new RegExp("(?:async )?function " + name + "\\([^)]*\\) \\{[\\s\\S]*?\\n\\}");
  const m = src.match(re);
  assert(m, name + " not found in app.js");
  // eslint-disable-next-line no-new-func
  return new Function("sandbox", "with (sandbox) { " + m[0] + " return " + name + "; }");
}

// ---------------------------------------------------------------------------
// Minimal DOM mock. createThinkingWidget only needs createElement() returning
// elements that support the handful of DOM methods/properties it touches. We
// record enough state to assert on structure, classes, attributes, and text.
// ---------------------------------------------------------------------------
function makeEl(tag) {
  const el = {
    tag,
    textContent: "",
    _children: [],
    _listeners: {},
    _attrs: {},
    // className is the source of truth; classList reads/writes through it so a
    // direct `el.className = "a b"` assignment (as app.js does) is reflected in
    // classList.contains() — a plain Set would miss direct assignments.
    className: "",
    classList: {
      add(c) { const s = new Set((el.className || "").split(/\s+/).filter(Boolean)); s.add(c); el.className = [...s].join(" "); },
      remove(c) { const s = new Set((el.className || "").split(/\s+/).filter(Boolean)); s.delete(c); el.className = [...s].join(" "); },
      toggle(c, on) {
        const s = new Set((el.className || "").split(/\s+/).filter(Boolean));
        if (on === undefined) on = !s.has(c);
        if (on) s.add(c); else s.delete(c);
        el.className = [...s].join(" ");
      },
      contains(c) { return new Set((el.className || "").split(/\s+/).filter(Boolean)).has(c); },
    },
    setAttribute(k, v) { this._attrs[k] = v; },
    getAttribute(k) { return this._attrs[k] != null ? this._attrs[k] : null; },
    appendChild(child) { this._children.push(child); return child; },
    addEventListener(ev, cb) { this._listeners[ev] = cb; },
    removeChild(child) {
      const i = this._children.indexOf(child);
      if (i !== -1) this._children.splice(i, 1);
    },
    // Style stub — some paths may touch it; keep it inert.
    style: {},
  };
  return el;
}

function makeDocument() {
  return { createElement: (tag) => makeEl(tag) };
}

// Build the real widget against the mock DOM.
function makeWidget(text, opts) {
  const sandbox = { document: makeDocument() };
  const factory = extractFunction(SRC, "createThinkingWidget");
  const fn = factory(sandbox);
  return fn(text, opts);
}

// Find a descendant element by a predicate over its className/attrs/text.
function find(el, pred) {
  if (pred(el)) return el;
  for (const c of (el._children || [])) {
    const r = find(c, pred);
    if (r) return r;
  }
  return null;
}
function findByClass(cls) { return (el) => (el.className || "").split(" ").includes(cls); }

// ---------------------------------------------------------------------------
// Source-of-truth checks — the new design must be present in app.js itself.
// ---------------------------------------------------------------------------

test("source: createThinkingWidget builds a Show more/less button (.think-show)", () => {
  const m = SRC.match(/function createThinkingWidget[\s\S]*?\n\}/);
  assert(m, "createThinkingWidget not found in app.js");
  const body = m[0];
  assert(/think-show/.test(body), "widget must create a .think-show button");
  assert(/Show more ↓/.test(body), "collapsed Show button must read 'Show more ↓'");
  assert(/Show less ↑/.test(body), "expanded Show button must read 'Show less ↑'");
});

test("source: a bottom fade element (.think-fade) is rendered for the preview", () => {
  const m = SRC.match(/function createThinkingWidget[\s\S]*?\n\}/);
  assert(/think-fade/.test(m[0]), "widget must create a .think-fade element");
});

test("source: CSS gives the collapsed body a max-height preview, not max-height:0", () => {
  const cssRaw = fs.readFileSync(path.join(__dirname, "..", "style.css"), "utf8");
  // Strip CSS comments first — the rule's own doc-comment mentions "max-height:0"
  // to explain what it replaced, which must not be confused for a real declaration.
  const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, "");
  // The base .think-body rule (collapsed) must set a non-zero max-height so a
  // preview is visible — the old design used max-height:0 and hid everything.
  const bodyRule = css.match(/\.think-body\s*\{[^}]*\}/);
  assert(bodyRule, ".think-body rule not found in style.css");
  assert(/max-height:\s*120px/.test(bodyRule[0]),
    "collapsed .think-body should show a ~120px preview (found: " + bodyRule[0].trim() + ")");
  assert(!/max-height:\s*0\b/.test(bodyRule[0]),
    "collapsed .think-body must NOT be max-height:0 (that hid the thinking entirely)");
  // The open state lifts the cap and scrolls.
  const openRule = css.match(/\[data-state="open"\]\s*\.think-body\s*\{[^}]*\}/);
  assert(openRule && /overflow-y:\s*auto/.test(openRule[0]),
    "open .think-body should scroll the full text");
  // The fade + show button exist in CSS.
  assert(/\.think-fade\s*\{/.test(css), ".think-fade CSS missing");
  assert(/\.think-show\s*\{/.test(css), ".think-show CSS missing");
  // Thinking text is visually distinct: monospace (not the response's sans).
  const innerRule = css.match(/\.think-inner\s*\{[^}]*\}/);
  assert(innerRule && /var\(--mono\)/.test(innerRule[0]),
    ".think-inner should use the monospace stack so thinking reads distinct from the response");
});

// ---------------------------------------------------------------------------
// Behavior — execute the REAL extracted widget against the DOM mock.
// ---------------------------------------------------------------------------

test("behavior: widget is collapsed by default", () => {
  const w = makeWidget("some reasoning here", { streaming: false });
  assert.strictEqual(w.getAttribute("data-state"), "collapsed",
    "new widget must start collapsed");
});

test("behavior: streaming widget stays collapsed while tokens accumulate", () => {
  // onThinking only ever calls _update(); it never toggles state. So no matter
  // how much thinking streams in, the widget must remain collapsed — the latest
  // snippet is visible inside the max-height preview, it never auto-expands.
  const w = makeWidget("", { streaming: true });
  assert.strictEqual(w.getAttribute("data-state"), "collapsed", "starts collapsed");
  w._update("first chunk of reasoning");
  assert.strictEqual(w.getAttribute("data-state"), "collapsed",
    "must stay collapsed after first streaming chunk");
  w._update("first chunk of reasoning\n\nmore reasoning that grows longer and longer " +
    "until it overflows the 120px preview window so the fade clips the bottom");
  assert.strictEqual(w.getAttribute("data-state"), "collapsed",
    "must stay collapsed even when text overflows the preview (stays a dim summary)");
  // The accumulated text is present in the inner body.
  const inner = find(w, findByClass("think-inner"));
  assert(inner && /overflows the 120px preview/.test(inner.textContent),
    "streamed text must accumulate inside the inner body");
  // The streaming word-count meta updates.
  const meta = find(w, findByClass("think-meta"));
  assert(meta && /\d+ words/.test(meta.textContent), "streaming meta should show a word count");
});

test("behavior: the Show more button expands to open and back to collapsed", () => {
  const w = makeWidget("reasoning line one\nreasoning line two", { streaming: false });
  const show = find(w, findByClass("think-show"));
  assert(show, ".think-show button must exist");
  assert.strictEqual(show.textContent, "Show more ↓", "collapsed button reads 'Show more ↓'");
  assert.strictEqual(show.getAttribute("aria-expanded"), "false");

  // Click Show more → opens.
  show._listeners.click();
  assert.strictEqual(w.getAttribute("data-state"), "open", "Show click must expand the widget");
  assert.strictEqual(show.textContent, "Show less ↑", "open button reads 'Show less ↑'");
  assert.strictEqual(show.getAttribute("aria-expanded"), "true");

  // Click Show less → collapses back.
  show._listeners.click();
  assert.strictEqual(w.getAttribute("data-state"), "collapsed", "second Show click must collapse");
  assert.strictEqual(show.textContent, "Show more ↓", "collapsed again reads 'Show more ↓'");
});

test("behavior: the header toggle and the Show button stay in sync", () => {
  // Both affordances drive the same state, so toggling one is reflected in the
  // other's label — a user clicking the header must not leave the Show button
  // showing the wrong verb.
  const w = makeWidget("reasoning", { streaming: false });
  const header = find(w, findByClass("think-toggle"));
  const show = find(w, findByClass("think-show"));
  assert(header && show, "header and show button must both exist");

  header._listeners.click(); // expand via header
  assert.strictEqual(w.getAttribute("data-state"), "open", "header click expands");
  assert.strictEqual(show.textContent, "Show less ↑",
    "Show button must reflect the open state set by the header");

  show._listeners.click(); // collapse via Show button
  assert.strictEqual(w.getAttribute("data-state"), "collapsed", "Show click collapses");
  assert.strictEqual(header.getAttribute("aria-expanded"), "false",
    "header aria-expanded must reflect the collapse set by the Show button");
});

test("behavior: _finalize switches the label from 'Thinking…' to 'Thought process'", () => {
  // The "still thinking" indicator (header label) must flip when streaming ends,
  // but the widget stays collapsed.
  const w = makeWidget("", { streaming: true });
  const label = find(w, findByClass("think-label"));
  assert.strictEqual(label.textContent, "Thinking…", "streaming label is 'Thinking…'");
  assert(w.classList.contains("is-streaming"), "streaming widget has the is-streaming class");

  w._finalize();
  assert.strictEqual(label.textContent, "Thought process", "finalized label is 'Thought process'");
  assert(!w.classList.contains("is-streaming"), "is-streaming class removed on finalize");
  assert.strictEqual(w.getAttribute("data-state"), "collapsed",
    "widget stays collapsed after finalize (a dim summary, not expanded)");
});

test("behavior: thinking text lives in a distinct, dimmed container", () => {
  // The container carries the dimmed thinking classes; the response bubble does
  // not. The inner text uses the monospace thinking styling, separate from the
  // markdown response body.
  const w = makeWidget("a reasoning thought", { streaming: false });
  assert((w.className || "").split(" ").includes("msg-thinking-collapsible"),
    "container has the .msg-thinking-collapsible class");
  const inner = find(w, findByClass("think-inner"));
  assert(inner, ".think-inner holds the thinking text");
  assert.strictEqual(inner.textContent, "a reasoning thought",
    "the thinking text is rendered inside the distinct inner element");
});

run();