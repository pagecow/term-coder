// Minimal test harness for the audit-fix tests — no dependencies, no runner.
// Exposes assert.* (the small subset we use) plus test()/run() that print
// results and exit non-zero on any failure.
const assert = require("assert");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function run() {
  let passed = 0, failed = 0;
  for (const t of tests) {
    try {
      t.fn();
      passed++;
      console.log("  \u2713 " + t.name);
    } catch (e) {
      failed++;
      console.error("  \u2717 " + t.name);
      console.error("      " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n      ") : e));
    }
  }
  console.log("\n" + passed + " passed, " + failed + " failed (" + tests.length + " total)");
  if (failed > 0) process.exitCode = 1;
}

module.exports = { assert, test, run };