// Mid-run interrupt tests for Term Coder.
//
// Feature: the user can type and send a message WHILE the orchestrator is
// running. The message interrupts the in-flight turn and the orchestrator
// continues with it (a fresh turn with the message in history), instead of the
// old behavior where the composer was disabled and submitting only stopped.
//
// app.js is a browser module, so it can't be `require`d whole in Node. These
// tests follow the audit-fixes pattern:
//   1. Read the REAL app.js source and assert the wiring (submit handler,
//      setRunning, runOrchestratorTurn, runToolWithTimeout) contains the new
//      paths.
//   2. Extract the real functions from the source and EXECUTE them in a
//      sandbox with mocked globals, asserting the actual behavior.
//
// Run: node tests/midrun-interrupt.test.js   (no test runner, no deps)

const fs = require("fs");
const path = require("path");
const { assert } = require("./harness.js");

// The shared harness's run() does not await async test functions, so this file
// uses its own async-aware runner (same output format, same exit code).
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
async function run() {
  let passed = 0, failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
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

const SRC = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

// Extract a top-level `function NAME(...) { ... }` (or `async function`) whose
// closing brace sits at column 0, and return a factory that evaluates it with
// the given sandbox globals.
function extractFunction(src, name) {
  const re = new RegExp("(?:async )?function " + name + "\\([^)]*\\) \\{[\\s\\S]*?\\n\\}");
  const m = src.match(re);
  assert(m, name + " not found in app.js");
  return new Function("sandbox", "with (sandbox) { " + m[0] + " return " + name + "; }");
}

// ---------------------------------------------------------------------------
// Source wiring — the new paths must exist in the real app.js.
// ---------------------------------------------------------------------------

test("wiring: setRunning no longer disables the chat input while running", () => {
  const setRunningSrc = extractFunction(SRC, "setRunning");
  const fn = setRunningSrc({});
  const src = fn.toString();
  assert(!/chatInput\.disabled\s*=/.test(src),
    "setRunning must not disable the composer (the old `el.chatInput.disabled = r` blocks mid-run sends)");
  assert(/Type to interrupt the orchestrator/.test(src),
    "setRunning should advertise the interrupt affordance in the placeholder");
});

test("wiring: the submit handler delivers mid-run text via interruptAndSend", () => {
  // The submit handler must route a non-empty message to interruptAndSend while
  // running, and only plain-abort when the composer is empty.
  const m = SRC.match(/el\.chatForm\.addEventListener\("submit", \(e\) => \{[\s\S]*?\n  \}\);/);
  assert(m, "chatForm submit handler not found");
  const handler = m[0];
  assert(/interruptAndSend\(text\)/.test(handler),
    "mid-run submit must call interruptAndSend(text)");
  assert(/abortController\.abort\(\); \/\/ plain stop/.test(handler),
    "empty submit while running must remain a plain stop");
  assert(/sendMessage\(\);/.test(handler),
    "idle submit must still call sendMessage()");
});

test("wiring: sendMessage delegates the turn to runOrchestratorTurn", () => {
  assert(/async function runOrchestratorTurn\(c\)/.test(SRC),
    "runOrchestratorTurn must be extracted from sendMessage");
  const m = SRC.match(/async function sendMessage\(textOverride, opts\) \{[\s\S]*?\n\}/);
  assert(m, "sendMessage not found");
  assert(/await runOrchestratorTurn\(c\);/.test(m[0]),
    "sendMessage must hand off to runOrchestratorTurn(c)");
});

test("wiring: an aborted delivery turn does not save a partial assistant reply", () => {
  const m = SRC.match(/async function runOrchestratorTurn\(c\) \{[\s\S]*?\n\}/);
  assert(m, "runOrchestratorTurn not found");
  const body = m[0];
  assert(/result && result\.aborted && interruptDeliveryActive/.test(body),
    "the completion path must skip saving the partial reply when aborted for a delivery");
  assert(/if \(interruptDeliveryActive\)/.test(body),
    "the catch path must skip the spurious error message when aborted for a delivery");
});

test("wiring: tool calls race the turn's abort signal", () => {
  const m = SRC.match(/async function runToolWithTimeout\(name, args, signal\) \{[\s\S]*?\n\}/);
  assert(m, "runToolWithTimeout(name, args, signal) not found");
  assert(/signal\.addEventListener\("abort"/.test(m[0]),
    "runToolWithTimeout must race the abort signal so an interrupt is responsive");
  assert(/runToolWithTimeout\(name, args, abortController\)/.test(SRC),
    "onToolCall must pass the turn's abortController");
});

// ---------------------------------------------------------------------------
// Behavior — setRunning / syncSendButton keep the composer usable mid-run.
// ---------------------------------------------------------------------------

test("behavior: setRunning(true) keeps the input enabled and flips the placeholder", () => {
  const make = extractFunction(SRC, "setRunning");
  const el = {
    chatInput: { value: "", placeholder: "Ask the orchestrator to build something…" },
    sendBtn: { classList: { toggle: () => {} }, title: "", setAttribute: () => {} },
    sendIcon: { classList: { toggle: () => {} } },
    stopIcon: { classList: { toggle: () => {} } },
  };
  const sandbox = {
    running: false,
    el,
    activeConversation: () => ({ id: "c1" }),
    syncSendButton: extractFunction(SRC, "syncSendButton")({ running: false, el }),
  };
  const setRunning = make(sandbox);
  setRunning(true);
  assert.strictEqual(el.chatInput.disabled, undefined,
    "the input must stay enabled while a turn runs");
  assert.strictEqual(el.chatInput.placeholder, "Type to interrupt the orchestrator…",
    "placeholder should advertise the interrupt affordance");
  setRunning(false);
  assert.strictEqual(el.chatInput.placeholder, "Ask the orchestrator to build something…",
    "placeholder should restore when the turn ends");
});

test("behavior: syncSendButton shows Stop only when running with an empty composer", () => {
  const make = extractFunction(SRC, "syncSendButton");
  const state = { running: false };
  const el = {
    chatInput: { value: "" },
    sendBtn: { classList: { toggle: (cls, on) => { state[cls] = on; } }, title: "", setAttribute: (k, v) => { state[k] = v; } },
    sendIcon: { classList: { toggle: (cls, on) => { state[cls + "-icon"] = on; } } },
    stopIcon: { classList: { toggle: (cls, on) => { state[cls + "-icon"] = on; } } },
  };
  const sync = make({ get running() { return state.running; }, el });
  // Idle → Send.
  sync();
  assert.strictEqual(state["is-running"], false, "idle button must show Send");
  assert.strictEqual(state["aria-label"], "Send");
  // Running, empty composer → Stop.
  state.running = true;
  sync();
  assert.strictEqual(state["is-running"], true, "running + empty composer must show Stop");
  assert.strictEqual(state["aria-label"], "Stop");
  // Running, user typed a message → Send again (submitting delivers it).
  el.chatInput.value = "do this instead";
  sync();
  assert.strictEqual(state["is-running"], false, "running + typed message must show Send");
  assert.strictEqual(state["aria-label"], "Send");
});

// ---------------------------------------------------------------------------
// Behavior — interruptAndSend: the mid-run delivery flow.
// ---------------------------------------------------------------------------

function makeInterruptSandbox(overrides) {
  const conv = {
    id: "c1",
    name: "Conversation 1",
    messages: [{ role: "user", content: "build a thing" }],
  };
  const calls = [];
  const state = {
    running: true,
    midRunDeliveryInFlight: false,
    interruptDeliveryActive: false,
    abortController: { abort: () => calls.push("abort") },
  };
  const chatLog = { appendChild: (node) => calls.push("dom:" + (node && node.content)) };
  const sandbox = {
    // Getter/setter proxies so the extracted function's reads/writes of these
    // module-level variables hit the shared state object.
    get running() { return state.running; },
    set running(v) { state.running = v; },
    get midRunDeliveryInFlight() { return state.midRunDeliveryInFlight; },
    set midRunDeliveryInFlight(v) { state.midRunDeliveryInFlight = v; },
    get interruptDeliveryActive() { return state.interruptDeliveryActive; },
    set interruptDeliveryActive(v) { state.interruptDeliveryActive = v; },
    get abortController() { return state.abortController; },
    setStatus: (t) => calls.push("status:" + t),
    activeConversation: () => conv,
    nameFromFirstMessage: (t, f) => t,
    saveState: () => calls.push("saveState"),
    renderProjects: () => {},
    renderSessionInfo: () => {},
    renderMessage: (m) => { calls.push("render:" + m.content); return { content: m.content, parentNode: chatLog }; },
    scrollChatBottom: () => {},
    updateChatEmpty: () => {},
    el: { chatInput: { value: "typed", style: {} }, chatLog },
    syncSendButton: () => {},
    waitForTurnEnd: async () => { state.running = false; },
    runOrchestratorTurn: async (c) => { calls.push("turn:" + c.messages.map((m) => m.role).join(",")); },
    ...overrides,
  };
  return { conv, calls, state, sandbox };
}

test("behavior: interruptAndSend aborts, waits, and continues with the new message", async () => {
  const { conv, calls, state, sandbox } = makeInterruptSandbox();
  const interruptAndSend = extractFunction(SRC, "interruptAndSend")(sandbox);
  await interruptAndSend("stop and do X instead");

  // The message is in history and was rendered immediately.
  assert.strictEqual(conv.messages.length, 2);
  assert.strictEqual(conv.messages[1].content, "stop and do X instead");
  assert(calls.includes("render:stop and do X instead"), "message must render immediately");
  // The in-flight turn was aborted, then a fresh turn ran with the full history.
  assert(calls.includes("abort"), "the current turn must be aborted");
  assert(calls.includes("turn:user,user"), "a fresh turn must run with the new message in history");
  // The composer was cleared and the delivery markers reset.
  assert.strictEqual(sandbox.el.chatInput.value, "");
  assert.strictEqual(state.midRunDeliveryInFlight, false);
  assert.strictEqual(state.interruptDeliveryActive, false);
});

test("behavior: interruptAndSend guards against double-submission", async () => {
  const { conv, calls, sandbox } = makeInterruptSandbox({
    midRunDeliveryInFlight: true, // a delivery is already in flight
  });
  const interruptAndSend = extractFunction(SRC, "interruptAndSend")(sandbox);
  await interruptAndSend("second message");

  assert.strictEqual(conv.messages.length, 1, "no second message may be pushed");
  assert(!calls.includes("abort"), "must not abort again while a delivery is in flight");
  assert(!calls.some((c) => c.startsWith("turn:")), "must not start a second turn");
  assert(calls.some((c) => c.startsWith("status:Already delivering")),
    "should tell the user a delivery is already in flight");
});

test("behavior: interruptAndSend reorders history when the old turn finished on its own", async () => {
  // The old turn completes normally WHILE we wait: it pushes its assistant
  // reply after our user message. The delivery must move the user message to
  // the end so history order stays user → assistant.
  const { conv, calls, sandbox } = makeInterruptSandbox({
    waitForTurnEnd: async () => {
      sandbox.running = false;
      conv.messages.push({ role: "assistant", content: "partial reply" });
    },
  });
  const interruptAndSend = extractFunction(SRC, "interruptAndSend")(sandbox);
  await interruptAndSend("new instruction");

  assert.deepStrictEqual(conv.messages.map((m) => m.role), ["user", "assistant", "user"],
    "history must end with the new user message");
  assert.strictEqual(conv.messages[2].content, "new instruction");
  assert(calls.includes("turn:user,assistant,user"),
    "the fresh turn must see the corrected order");
});

test("behavior: interruptAndSend safety net when the turn ignores the abort", async () => {
  const { conv, calls, state, sandbox } = makeInterruptSandbox({
    waitForTurnEnd: async () => { /* turn stays running */ },
  });
  const interruptAndSend = extractFunction(SRC, "interruptAndSend")(sandbox);
  await interruptAndSend("please stop");

  assert(!calls.some((c) => c.startsWith("turn:")), "must not start a turn while the old one is stuck");
  assert(calls.some((c) => c.startsWith("status:The current step is still finishing")),
    "should tell the user the step is still finishing");
  // The message stays in history for the retry, and the guards are released.
  assert.strictEqual(conv.messages[1].content, "please stop");
  assert.strictEqual(state.midRunDeliveryInFlight, false, "guard must release so the user can retry");
  assert.strictEqual(state.interruptDeliveryActive, false);
});

// ---------------------------------------------------------------------------
// Behavior — waitForTurnEnd.
// ---------------------------------------------------------------------------

test("behavior: waitForTurnEnd resolves when the turn unwinds and times out otherwise", async () => {
  const make = extractFunction(SRC, "waitForTurnEnd");
  const state = { running: true };
  const waitForTurnEnd = make({ get running() { return state.running; } });
  // Unwinds quickly.
  setTimeout(() => { state.running = false; }, 50);
  await waitForTurnEnd(5000);
  assert.strictEqual(state.running, false);
  // Stuck turn → resolves at the timeout instead of hanging forever.
  const stuck = { running: true };
  const waitStuck = make({ get running() { return stuck.running; } });
  const t0 = Date.now();
  await waitStuck(150);
  assert.strictEqual(stuck.running, true, "stuck turn stays running");
  assert(Date.now() - t0 >= 140, "must wait out the timeout, not resolve instantly");
});

// ---------------------------------------------------------------------------
// Behavior — runToolWithTimeout races the abort signal.
// ---------------------------------------------------------------------------

test("behavior: runToolWithTimeout resolves promptly when the turn is aborted", async () => {
  const make = extractFunction(SRC, "runToolWithTimeout");
  const listeners = new Map();
  const signal = {
    aborted: false,
    addEventListener: (ev, fn) => listeners.set(ev, fn),
    removeEventListener: (ev) => listeners.delete(ev),
  };
  const sandbox = {
    TOOL_TIMEOUT_MS: 90 * 1000,
    TOOL_TIMEOUT_OVERRIDES: {},
    toolHandler: () => new Promise(() => {}), // never settles (e.g. a hung wait_for_session)
  };
  const runToolWithTimeout = make(sandbox);
  const p = runToolWithTimeout("wait_for_session", {}, signal);
  // Abort fires while the tool is still pending.
  signal.aborted = true;
  listeners.get("abort")();
  const result = await p;
  assert.strictEqual(result, "Error: interrupted by the user.",
    "an aborted tool call must resolve with an interrupt result, not hang");
  assert.strictEqual(listeners.size, 0, "the abort listener must be cleaned up");
});

test("behavior: runToolWithTimeout still returns the tool result when not aborted", async () => {
  const make = extractFunction(SRC, "runToolWithTimeout");
  const signal = {
    aborted: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const sandbox = {
    TOOL_TIMEOUT_MS: 90 * 1000,
    TOOL_TIMEOUT_OVERRIDES: {},
    toolHandler: async () => "tool done",
  };
  const runToolWithTimeout = make(sandbox);
  const result = await runToolWithTimeout("read_session", {}, signal);
  assert.strictEqual(result, "tool done", "normal tool calls must be unaffected");
});

run();
