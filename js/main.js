// main.js — classic script (converted from an ES module; see REFACTOR_PLAN.md).
// Entry point: starts the app once every module has loaded.
(function () {
"use strict";
const TC = window.termCoder = window.termCoder || {};

TC.init().catch((e) => {
  console.error(e);
  TC.el.loading.textContent = "Failed to start: " + (e && e.message ? e.message : String(e));
});

})();
