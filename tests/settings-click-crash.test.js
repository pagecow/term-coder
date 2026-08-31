// Regression test for the "Settings gear does nothing + Script error" bug.
//
// Root cause (v1.23.1 refactor): applyTrustModeToUi in js/08-settings.js
// referenced the bare identifier `trustMode`, which used to be a file-scope
// global in the old monolithic app.js but is IIFE-scoped inside
// js/00-state.js after the module conversion — so opening Settings threw
// `ReferenceError: trustMode is not defined` and the modal never opened.
//
// These tests fail on the old code and pass on the fix:
//   T1  execute the REAL applyTrustModeToUi from js/08-settings.js with a
//       TC stub whose trustMode is NOT a visible binding (mirrors the live
//       IIFE closure) — it must render the radio selector without throwing.
//   T2  source check: the trust-mode select must read through TC.trustMode.
const { test, run } = require("./harness.js");
const { moduleSrc } = require("./module-src.js");

// Re-usable TC stub: the settings DOM bits applyTrustModeToUi touches, plus a
// trustMode getter (the Object.defineProperty accessor 00-state.js registers).
function makeTC() {
  const tc = {
    el: {
      trustModeRadios: {
        querySelector(sel) {
          tc.lastSelector = sel;
          return { checked: false };
        },
      },
    },
  };
  let trustMode = "always";
  Object.defineProperty(tc, "trustMode", { get: () => trustMode, configurable: true });
  return tc;
}

test("T1: applyTrustModeToUi does not throw on a bare trustMode reference", () => {
  const SRC = moduleSrc("08-settings.js");
  const m = SRC.match(/function applyTrustModeToUi\(\) \{[\s\S]*?\n\}/);
  if (!m) throw new Error("applyTrustModeToUi not found in 08-settings.js");
  const tc = makeTC();
  // The real module body runs inside its own IIFE with no global `trustMode`
  // visible (00-state.js keeps it IIFE-scoped) — execute it in strict mode so
  // a bare free identifier throws the same ReferenceError it did in the app.
  const fn = new Function("TC", `"use strict";\n${m[0]}\nreturn applyTrustModeToUi;`)(tc);
  fn(tc);
  if (tc.lastSelector !== 'input[name="trust-mode"][value="always"]') {
    throw new Error("unexpected selector built: " + tc.lastSelector);
  }
});

test("T2: trust-mode select reads trustMode via TC.trustMode (TC-qualified)", () => {
  const SRC = moduleSrc("08-settings.js");
  const fnSrc = SRC.match(/function applyTrustModeToUi\(\) \{[\s\S]*?\n\}/)[0];
  if (/[^.\w$]trustMode\s*\|\|/.test(fnSrc)) {
    throw new Error("applyTrustModeToUi still uses a bare `trustMode` — must read TC.trustMode");
  }
  if (!/TC\.trustMode\s*\|\|/.test(fnSrc)) {
    throw new Error("applyTrustModeToUi should read `TC.trustMode || 'ask'`");
  }
});

run();