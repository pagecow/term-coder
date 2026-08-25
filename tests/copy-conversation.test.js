// Copy-conversation verification tests for Term Coder.
//
// The app is split into classic scripts under js/ (shared window.termCoder
// namespace — see REFACTOR_PLAN.md), so it can't be `require`d whole in Node.
// These tests follow the same convention as tests/history-view.test.js:
// read the REAL module source as text and parse the pure function out of it
// (conversationToText), so the tests fail if the source drifts away from the
// required behavior.
//
// Run: node tests/copy-conversation.test.js   (no test runner, no deps)

const fs = require("fs");
const path = require("path");
const { assert, test, run } = require("./harness.js");
const { moduleSrc } = require("./module-src.js");

const SRC = moduleSrc("16-attachments.js");

// Pull conversationToText VERBATIM out of js/16-attachments.js and evaluate it
// in a sandbox. It is pure (no DOM / window / chatoss references), so this is
// safe and keeps the test pinned to the real source. If someone edits the
// function body, the regex extraction fails loudly rather than testing a stale
// copy.
function extractFn(src, name) {
  const re = new RegExp("function " + name + "\\(([\\s\\S]*?)\\)\\s*\\{");
  const m = src.match(re);
  assert(m, name + " declaration not found in js/16-attachments.js");
  // Walk from the opening brace to its matching close brace (brace counting),
  // so nested object literals / strings with braces don't trip us up.
  const open = src.indexOf("{", m.index + m[0].length - 1);
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  assert(end > 0, name + ": could not find end of function body");
  const head = "function " + name + "(" + m[1] + ")";
  const body = src.slice(open, end + 1);
  // eslint-disable-next-line no-new-func
  const factory = new Function(head + body + "; return " + name + ";");
  return factory();
}

const conversationToText = extractFn(SRC, "conversationToText");

// ===========================================================================
// TASK — "Copy conversation" button copies the ENTIRE conversation as plain
// text. conversationToText is the pure serializer behind copyConversation().
// ===========================================================================

test("C1: user + assistant messages are labeled and ordered", () => {
  const c = {
    id: "c1",
    name: "Conversation 1",
    messages: [
      { role: "user", content: "build a todo app" },
      { role: "assistant", content: "On it." },
    ],
  };
  const out = conversationToText(c);
  assert.strictEqual(out, "You:\nbuild a todo app\n\nAssistant:\nOn it.",
    "user first, assistant second, 'You:'/'Assistant:' labels, blank line between");
});

test("C2: system messages are included with a System label", () => {
  const c = {
    id: "c1",
    messages: [
      { role: "system", content: "You are Term Coder." },
      { role: "user", content: "hi" },
    ],
  };
  const out = conversationToText(c);
  assert.strictEqual(out, "System:\nYou are Term Coder.\n\nYou:\nhi",
    "system message serialized before the user message");
});

test("C3: tool-call activity is included with name, args and result", () => {
  const c = {
    id: "c1",
    messages: [
      { role: "user", content: "list files" },
      {
        role: "assistant",
        content: "Here they are.",
        toolCalls: [
          { name: "list_dir", args: { path: "." }, result: "a.txt\nb.txt" },
          { name: "read_file", args: { path: "a.txt" }, result: "hello" },
        ],
      },
    ],
  };
  const out = conversationToText(c);
  assert(out.includes("Tools:"), "tool section header present");
  assert(out.includes('• list_dir({"path":"."})'), "tool name + JSON args present");
  assert(out.includes("  a.txt\nb.txt"), "tool result present");
  assert(out.includes('• read_file({"path":"a.txt"})'), "second tool present");
  // Order: content, then Tools section, then the next message.
  assert(out.indexOf("Here they are.") < out.indexOf("Tools:"), "content before tools");
});

test("C4: tool errors are included", () => {
  const c = {
    id: "c1",
    messages: [
      {
        role: "assistant",
        content: "Failed.",
        toolCalls: [{ name: "run", args: { cmd: "x" }, error: "Error: boom" }],
      },
    ],
  };
  const out = conversationToText(c);
  assert(out.includes("Error: boom"), "tool error text present");
});

test("C5: thinking is included under a Thinking section", () => {
  const c = {
    id: "c1",
    messages: [
      { role: "assistant", content: "Answer.", thinking: "Let me think…" },
    ],
  };
  const out = conversationToText(c);
  assert(out.includes("Thinking:\nLet me think…"), "thinking block present");
  assert(out.indexOf("Answer.") < out.indexOf("Thinking:"), "content before thinking");
});

test("C6: event messages are labeled Event, not You", () => {
  const c = {
    id: "c1",
    messages: [
      { role: "user", content: "agent finished", event: true },
      { role: "user", content: "real question" },
    ],
  };
  const out = conversationToText(c);
  assert.strictEqual(out, "Event:\nagent finished\n\nYou:\nreal question",
    "event message gets its own label and does not masquerade as a user message");
});

test("C7: empty / missing conversation yields empty text (no-op path)", () => {
  assert.strictEqual(conversationToText(null), "", "null conversation -> empty");
  assert.strictEqual(conversationToText({ id: "c1" }), "", "no messages -> empty");
  assert.strictEqual(conversationToText({ id: "c1", messages: [] }), "", "empty messages -> empty");
});

test("C8: multi-turn conversation keeps full order and separators", () => {
  const c = {
    id: "c1",
    messages: [
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
      { role: "user", content: "three" },
      { role: "assistant", content: "four" },
    ],
  };
  const out = conversationToText(c);
  const lines = out.split("\n\n");
  assert.strictEqual(lines.length, 4, "one block per message");
  assert.strictEqual(lines[0], "You:\none");
  assert.strictEqual(lines[1], "Assistant:\ntwo");
  assert.strictEqual(lines[2], "You:\nthree");
  assert.strictEqual(lines[3], "Assistant:\nfour");
});

run();
