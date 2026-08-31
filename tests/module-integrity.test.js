// Module-integrity guard for the v1.23.1 classic-script refactor.
//
// Each module under js/ is an IIFE sharing state only through the `termCoder`
// (TC) namespace. v1.23.1 shipped one bug of this class — the Settings gear
// crash: 08-settings.js read a bare `trustMode` that is IIFE-scoped inside
// 00-state.js. These tests turn the whole bug class into test failures:
//
//   T1  Exact static resolution (acorn): no free identifier referenced by
//       module A is only declared inside module B's IIFE (invisible here).
//   T2  Every TC.<name>/termCoder.<name> read is exported by some module.
//   T3  Every TC.el.<name>/el.<name> read is registered in 04-dom.js.
const { test, run } = require("./harness.js");
const fs = require("fs");
const path = require("path");

let acorn = null;
for (const p of [
  "/opt/homebrew/Cellar/heroku/9.5.0/libexec/node_modules/acorn/dist/acorn.js",
  "/opt/homebrew/lib/node_modules/acorn/dist/acorn.js",
]) { try { acorn = require(p); break; } catch {} }

const JS_DIR = path.join(__dirname, "..", "js");
const FILES = fs.readdirSync(JS_DIR).filter((f) => f.endsWith(".js")).sort();
const RAW = {};
for (const f of FILES) RAW[f] = fs.readFileSync(path.join(JS_DIR, f), "utf8");

const GLOBALS = new Set(("TC $ el chatoss termCoder FitAddon xterm fitAddon window document console " +
"undefined NaN Infinity globalThis arguments eval this require module exports process Buffer " +
"Object Function Boolean Symbol Error AggregateError Number BigInt Math Date String RegExp Array " +
"Map Set WeakMap WeakSet Promise Reflect Proxy Intl JSON ArrayBuffer DataView Atomics SharedArrayBuffer " +
"parseInt parseFloat isNaN isFinite encodeURI decodeURI encodeURIComponent decodeURIComponent escape unescape " +
"window document location navigator history screen self top parent frames opener localStorage sessionStorage " +
"indexedDB caches crypto performance fetch XMLHttpRequest WebSocket EventSource Blob File FileReader FormData " +
"Headers Request Response URL URLSearchParams AbortController DOMParser XMLSerializer MutationObserver " +
"ResizeObserver IntersectionObserver PerformanceObserver requestAnimationFrame cancelAnimationFrame " +
"requestIdleCallback cancelIdleCallback setTimeout clearTimeout setInterval clearInterval queueMicrotask " +
"structuredClone atob btoa getComputedStyle matchMedia getSelection CustomEvent Event KeyboardEvent MouseEvent " +
"PointerEvent ClipboardEvent DragEvent InputEvent ErrorEvent MessageEvent DataTransfer DataTransferItem " +
"DataTransferItemList FileList Range Selection NodeList HTMLCollection Node Element Document HTMLElement " +
"HTMLInputElement HTMLTextAreaElement HTMLSelectElement HTMLButtonElement HTMLAnchorElement Image Audio Option " +
"Worker SharedWorker Notification TextEncoder TextDecoder alert confirm prompt print open close focus blur stop " +
"Test suite assert console").split(/\s+/).filter(Boolean));

// ---------- scope extraction with acorn ----------
function patternNames(n, out) {
  if (!n) return;
  switch (n.type) {
    case "Identifier": out.push(n.name); return;
    case "ObjectPattern": for (const p of n.properties) patternNames(p.type === "Property" ? p.value : p, out); return;
    case "ArrayPattern": for (const e of n.elements) patternNames(e, out); return;
    case "AssignmentPattern": patternNames(n.left, out); return;
    case "RestElement": patternNames(n.argument, out); return;
  }
}

function analyze(src) {
  const ast = acorn.parse(src, { ecmaVersion: "latest" });
  const declared = new Set();   // every name bound anywhere in this file
  const free = [];              // { name, line } unresolved identifier refs
  let scope = new Set();        // current lexical scope (approx: function-level merge)
  const scopes = [scope];
  const scopeStack = [scope];
  function push() { scope = new Set(); scopes.push(scope); scopeStack.push(scope); }
  function pop() { scopeStack.pop(); scope = scopeStack[scopeStack.length - 1]; }
  function visit(node, parent, prop) {
    if (!node || typeof node.type !== "string") return;
    switch (node.type) {
      case "Program": push(); node.body.forEach((c) => visit(c, node)); break;
      case "FunctionDeclaration":
        if (node.id) scope.add(node.id.name);
        visitFunction(node); return;
      case "FunctionExpression":
      case "ArrowFunctionExpression": visitFunction(node); return;
      case "ClassDeclaration":
        if (node.id) scope.add(node.id.name);
        node.body.body.forEach((m) => visit(m, node)); return;
      case "ClassExpression":
        node.body.body.forEach((m) => visit(m, node)); return;
      case "VariableDeclaration":
        for (const d of node.declarations) {
          const names = [];
          patternNames(d.id, names);
          names.forEach((n) => scope.add(n));
          if (d.init) visit(d.init, node);
        }
        return;
      case "Identifier":
        if (!(parent && (
              (parent.type === "MemberExpression" && parent.property === node && !parent.computed) ||
              (parent.type === "Property" && parent.key === node && !parent.computed && parent.value !== node) ||
              (parent.type === "MethodDefinition" && parent.key === node && !parent.computed) ||
              (parent.type === "PropertyDefinition" && parent.key === node && !parent.computed) ||
              (parent.type === "VariableDeclarator" && parent.id === node) ||
              (parent.type === "FunctionDeclaration" && parent.id === node) ||
              (parent.type === "ClassDeclaration" && parent.id === node) ||
              (parent.type === "LabeledStatement" && parent.label === node) ||
              ((parent.type === "BreakStatement" || parent.type === "ContinueStatement") && parent.label === node) ||
              (parent.type === "ExportSpecifier" || parent.type === "ImportSpecifier" || parent.type === "ImportDefaultSpecifier" || parent.type === "ImportNamespaceSpecifier")
            ))) {
          free.push({ name: node.name, line: node.loc ? node.loc.start.line : 0 });
        }
        return;
      case "CatchClause": {
        push();
        if (node.param) { const names = []; patternNames(node.param, names); names.forEach((n) => scope.add(n)); }
        visit(node.body, node);
        pop(); return;
      }
      case "TryStatement":
        visit(node.block, node);
        if (node.handler) visit(node.handler, node);
        if (node.finalizer) visit(node.finalizer, node);
        return;
      default: {
        for (const k of Object.keys(node)) {
          if (k === "loc" || k === "start" || k === "end") continue;
          const v = node[k];
          if (Array.isArray(v)) v.forEach((c) => visit(c, node, k));
          else if (v && typeof v.type === "string") visit(v, node, k);
        }
        return;
      }
    }
    function visitFunction(fn) {
      push();
      if (fn.id && fn.type === "FunctionExpression") scope.add(fn.id.name);
      const names = [];
      for (const p of fn.params) patternNames(p, names);
      names.forEach((n) => scope.add(n));
      if (fn.body.type === "BlockStatement") fn.body.body.forEach((c) => visit(c, fn));
      else visit(fn.body, fn);
      pop();
    }
  }
  visit(ast, null);
  for (const s of scopes) for (const n of s) declared.add(n);
  return { declared, free };
}

const analyzed = {};
for (const f of FILES) {
  if (!acorn) { analyzed[f] = { declared: new Set(), free: [] }; continue; }
  try { analyzed[f] = analyze(RAW[f]); }
  catch (e) { throw new Error("acorn failed to parse " + f + ": " + e.message); }
}

// T1: free refs whose name is declared in a DIFFERENT module only
const nameToModules = new Map();
for (const f of FILES) for (const n of analyzed[f].declared) (nameToModules.get(n) || nameToModules.set(n, []).get(n)).push(f);
const t1leaks = [];
for (const f of FILES) {
  for (const r of analyzed[f].free) {
    if (GLOBALS.has(r.name)) continue;
    if (analyzed[f].declared.has(r.name)) continue;
    const ds = nameToModules.get(r.name) || [];
    if (ds.length > 0 && !ds.includes(f)) t1leaks.push({ ...r, file: f, declaredIn: ds.join(",") });
  }
}

// ---------- T2: TC exports ----------
const tcUsed = new Map();
const tcExported = new Set();
for (const f of FILES) {
  for (const m of RAW[f].matchAll(/\b(?:TC|termCoder)\.([A-Za-z_$][\w$]*)/g)) {
    if (!tcUsed.has(m[1])) tcUsed.set(m[1], []);
    tcUsed.get(m[1]).push(`${f}:${RAW[f].slice(0, m.index).split("\n").length}`);
  }
  for (const m of RAW[f].matchAll(/\b(?:TC|termCoder)\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) tcExported.add(m[1]);
  for (const m of RAW[f].matchAll(/defineProperty\(\s*(?:TC|termCoder|window\.termCoder)\s*,\s*["']([A-Za-z_$][\w$]*)["']/g)) tcExported.add(m[1]);
  for (const m of RAW[f].matchAll(/Object\.assign\(\s*(?:TC|termCoder|window\.termCoder)\s*,\s*\{([\s\S]*?)\}\s*\)/g)) {
    for (const t of m[1].matchAll(/(?:^|[{,]\s*)[A-Za-z_$][\w$]*\s*:/gm)) {}
    for (const t of m[1].matchAll(/([A-Za-z_$][\w$]*)\s*:/g)) tcExported.add(t[1]);
  }
}
const tcMissing = [...tcUsed.entries()].filter(([n]) => !tcExported.has(n));

// ---------- T3: TC.el registry ----------
const elDomSrc = RAW["04-dom.js"];
const elKeys = new Set();
for (const m of elDomSrc.matchAll(/^  ([A-Za-z_$][\w$]*)\s*:/gm)) elKeys.add(m[1]);
for (const m of elDomSrc.matchAll(/el\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) elKeys.add(m[1]);
const elReads = new Map();
for (const f of FILES) {
  for (const m of RAW[f].matchAll(/\b(?:TC\.)?el\.([A-Za-z_$][\w$]*)/g)) {
    if (!elReads.has(m[1])) elReads.set(m[1], []);
    elReads.get(m[1]).push(`${f}:${RAW[f].slice(0, m.index).split("\n").length}`);
  }
}
const elMissing = [...elReads.entries()].filter(([n]) => !elKeys.has(n));

test("T2: every TC.<name> read is exported by some module", () => {
  if (tcMissing.length) throw new Error("TC members read but never exported: " +
    tcMissing.map(([n, locs]) => n + " ← " + locs.slice(0, 2).join(", ")).join("; "));
});

test("T3: every TC.el.<name> read is registered in 04-dom.js", () => {
  if (elMissing.length) throw new Error("el refs with no DOM registration: " +
    elMissing.map(([n, locs]) => n + " ← " + locs.slice(0, 2).join(", ")).join("; "));
});

test("T1: no free identifier resolves only across module boundaries (v1.23.1 class)", () => {
  if (!acorn) throw new Error("acorn unavailable — T1 cannot run");
  if (t1leaks.length) throw new Error("Cross-module leaks: " +
    t1leaks.map((r) => r.name + " @ " + r.file + ":" + r.line + " (declared in " + r.declaredIn + ")").join("; "));
});

module.exports = { t1leaks, tcMissing, elMissing, analyzed };

run();