// Tests for the create_card / create_column orchestrator tools (wired to the
// ChatOSS boards capability: window.chatoss.boards.createCard / createColumn).
const fs = require("fs");
const path = require("path");
const { assert, test, run } = require("./harness");

const SRC = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

test("create_card tool definition exists and requires title", () => {
  assert(/name: "create_card"/.test(SRC), "create_card definition missing");
  assert(/required: \["title"\]/.test(SRC), "create_card must require title");
});

test("create_card handler calls window.chatoss.boards.createCard", () => {
  assert(/case "create_card":/.test(SRC), "create_card handler missing");
  assert(/window\.chatoss\.boards\.createCard\(/.test(SRC), "createCard call missing");
});

test("create_column tool definition exists and requires name", () => {
  assert(/name: "create_column"/.test(SRC), "create_column definition missing");
  assert(/required: \["name"\]/.test(SRC), "create_column must require name");
});

test("create_column handler calls window.chatoss.boards.createColumn", () => {
  assert(/case "create_column":/.test(SRC), "create_column handler missing");
  assert(/window\.chatoss\.boards\.createColumn\(/.test(SRC), "createColumn call missing");
});

test("system prompt tells the model about create_card / create_column", () => {
  assert(/create_card\(\{ title, description\?, columnId \}\)/.test(SRC), "system prompt should mention create_card");
  assert(/create_column\(\{ name \}\)/.test(SRC), "system prompt should mention create_column");
});

run();
