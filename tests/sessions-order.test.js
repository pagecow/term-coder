// Sessions-list ordering tests for Term Coder.
//
// Newest terminal sessions must appear FIRST (top of the list):
//   1. paintProjSessions (sidebar "Sessions" list) sorts live sessions by
//      createdAt DESCENDING — newest first, stable, and independent of the
//      lastOutputAt activity field (which reshuffles the list as agents emit
//      output). Live sessions render above ended ones.
//   2. registerSession prepends each new session square to the TOP of the
//      terminal grid, so currently-running terminals sit above ended cards
//      and stay visible without scrolling.
//
// The app is split into classic scripts under js/ (shared window.termCoder
// namespace — see REFACTOR_PLAN.md), so it can't be `require`d whole in Node.
// Same approach as audit-fixes.test.js: read the REAL module sources as text
// and assert the fix is present there (so a revert fails the test), then
// replicate the exact predicates/insertion logic VERBATIM and assert their
// behavior.
//
// Run: node tests/sessions-order.test.js   (no test runner, no deps)

const fs = require("fs");
const path = require("path");
const { assert, test, run } = require("./harness.js");
const { allModulesSrc } = require("./module-src.js");

const SRC = allModulesSrc();

// ---------------------------------------------------------------------------
// Source-of-truth checks — the ordering fix must be present in app.js itself.
// ---------------------------------------------------------------------------
test("paintProjSessions sorts live sessions newest-first by createdAt", () => {
  assert(/const recs = liveAll\.sort\(\(a, b\) => \(b\.createdAt \|\| 0\) - \(a\.createdAt \|\| 0\)\);/.test(SRC),
    "paintProjSessions should sort live sessions by createdAt descending (newest first)");
  // The old activity-based sort must be gone: ordering by lastOutputAt made
  // the list reshuffle as agents emitted output (unstable, not creation order).
  assert(!/const recs = \[\.\.\.sessions\.values\(\)\]\.sort\(\(a, b\) => \(b\.lastOutputAt/.test(SRC),
    "paintProjSessions must not sort by lastOutputAt anymore (unstable/activity-based)");
});

test("registerSession prepends new squares to the TOP of the terminal grid", () => {
  // Slice the registerSession function body (from its declaration to the
  // sessions.set that closes registration) and check the insertion logic.
  const start = SRC.indexOf("async function registerSession");
  const end = SRC.indexOf("sessions.set(session.id, rec);");
  assert(start !== -1 && end !== -1 && end > start, "registerSession body not found in app.js");
  const body = SRC.slice(start, end);
  assert(body.includes("TC.el.termGrid.insertBefore(square, TC.el.termGrid.firstChild);"),
    "registerSession should insert the new square as the grid's first child (newest on top)");
  assert(!body.includes("el.termGrid.appendChild(square)"),
    "registerSession must not append new squares at the end of the grid anymore");
});

// ---------------------------------------------------------------------------
// Behavior checks — replicate the exact predicates from app.js verbatim.
// ---------------------------------------------------------------------------
// Verbatim from app.js (paintProjSessions, ~L3947):
function newestFirst(list) {
  return [...list].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

test("sidebar order: newest session first, older sessions below even when more active", () => {
  // "a" started long ago but just emitted output (lastOutputAt is huge) — the
  // old sort would put it on top. The fix keys on createdAt, so "c" (the
  // newest) must be first.
  const a = { id: "a", createdAt: 1000, lastOutputAt: Date.now() };
  const b = { id: "b", createdAt: 2000, lastOutputAt: 0 };
  const c = { id: "c", createdAt: 3000, lastOutputAt: 0 };
  const ids = newestFirst([a, b, c]).map((s) => s.id);
  assert.deepStrictEqual(ids, ["c", "b", "a"],
    "live sessions must render newest-by-createdAt first, regardless of recent output");
});

test("sidebar order: stable for equal createdAt (insertion order preserved)", () => {
  const x1 = { id: "x1", createdAt: 5 };
  const x2 = { id: "x2", createdAt: 5 };
  const x3 = { id: "x3", createdAt: 5 };
  assert.deepStrictEqual(newestFirst([x1, x2, x3]).map((s) => s.id), ["x1", "x2", "x3"],
    "equal createdAt must keep insertion order (stable sort)");
});

test("sidebar order: sessions missing createdAt sort last (defensive)", () => {
  const withTs = { id: "ts", createdAt: 100 };
  const noTs = { id: "no-ts", createdAt: 0 };
  assert.deepStrictEqual(newestFirst([noTs, withTs]).map((s) => s.id), ["ts", "no-ts"],
    "a session with no createdAt must fall below one with a timestamp");
});

// Verbatim insert from app.js (registerSession, ~L6277):
function insertSquare(grid, square) {
  grid.insertBefore(square, grid.firstChild);
}

// Minimal linked-list stand-in for el.termGrid's firstChild/insertBefore.
function makeGrid() {
  const grid = { children: [], get firstChild() { return this.children[0] || null; } };
  grid.insertBefore = function (node, before) {
    if (before === null) { this.children.push(node); return; }
    const i = this.children.indexOf(before);
    this.children.splice(i === -1 ? this.children.length : i, 0, node);
  };
  return grid;
}

test("grid order: new live sessions land on top, above ended cards and the empty hint", () => {
  const grid = makeGrid();
  // Boot-time state: ended cards render first (newest ended first), and the
  // empty-state hint is the last child (renderDeadSessionCard inserts before
  // it, per the init path at app.js ~L7837).
  grid.children.push({ id: "dead-old" });
  grid.children.push({ id: "dead-new" });
  grid.children.push({ id: "__empty__" });

  insertSquare(grid, { id: "live-1" }); // started first
  insertSquare(grid, { id: "live-2" }); // started later → must be on top

  const ids = grid.children.map((n) => n.id);
  assert.deepStrictEqual(ids, ["live-2", "live-1", "dead-old", "dead-new", "__empty__"],
    "newest live session must be first, running sessions above ended cards, empty hint last");
});

test("grid order: a brand-new session on an otherwise empty grid goes above the hint", () => {
  const grid = makeGrid();
  grid.children.push({ id: "__empty__" }); // first ever session: only the hint exists

  insertSquare(grid, { id: "live-1" });

  assert.deepStrictEqual(grid.children.map((n) => n.id), ["live-1", "__empty__"],
    "the empty-state hint must stay the last child (grid stays clean)");
});

run();
