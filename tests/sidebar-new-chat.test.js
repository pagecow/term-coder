// Regression tests for the Term Coder sidebar new-chat rework:
//   1. Topbar buttons read "New chat" / "New project" (lowercase c/p).
//   2. The sidebar "New conversation" row is GONE — new chats come from the
//      topbar button, the + on the project row, or Cmd/Ctrl+N.
//   3. A project row carries a + button (to the LEFT of the rename pencil)
//      that creates a chat in that project.
//   4. Empty conversations (no user post yet) stay OUT of the sidebar list,
//      and newConversation() reuses the one empty draft instead of piling up
//      more — repeated New chat / Cmd+N can't create a stack of empty chats.
//   5. Files and Sessions sections are collapsible and COLLAPSED BY DEFAULT
//      (persisted per project in state.sectionCollapsed).
//   6. Cmd/Ctrl+N starts a new chat in the current project.
//
// The app is split into classic scripts under js/ (shared window.termCoder
// namespace — see REFACTOR_PLAN.md), so these tests grep the real module
// sources/HTML/CSS for the wiring and replicate the decision predicates
// verbatim.
//
// Run: node tests/sidebar-new-chat.test.js   (no test runner, no deps)

const fs = require("fs");
const path = require("path");
const { assert, test, run } = require("./harness.js");
const { allModulesSrc } = require("./module-src.js");

const SRC = allModulesSrc();
const HTML = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const CSS = fs.readFileSync(path.join(__dirname, "..", "style.css"), "utf8");

// ---------------------------------------------------------------------------
// 1. Lowercase topbar labels
// ---------------------------------------------------------------------------

test("topbar: labels are 'New chat' and 'New project' (lowercase c/p)", () => {
  assert(/<span>New chat<\/span>/.test(HTML), "topbar must read 'New chat'");
  assert(/<span>New project<\/span>/.test(HTML), "topbar must read 'New project'");
  assert(!/<span>New Chat<\/span>/.test(HTML), "old 'New Chat' casing still present");
  assert(!/<span>New Project<\/span>/.test(HTML), "old 'New Project' casing still present");
});

// ---------------------------------------------------------------------------
// 2. Sidebar "New conversation" row removed
// ---------------------------------------------------------------------------

test("sidebar: the 'New conversation' row is removed", () => {
  assert(!/New conversation/.test(SRC), "app.js still renders a 'New conversation' row");
  assert(!/conv-new/.test(SRC), "conv-new class still referenced in app.js");
  assert(!/conv-new|conv-plus/.test(CSS), "dead .conv-new/.conv-plus rules still in style.css");
});

// ---------------------------------------------------------------------------
// 3. + button on the project row, left of the pencil
// ---------------------------------------------------------------------------

test("project row: a + button creates a chat in that project, left of rename", () => {
  assert(/newConvBtn\.title = "New chat in this project"/.test(SRC), "project-row + button missing");
  assert(/newConvBtn\.onclick = \(e\) => \{\s*e\.stopPropagation\(\);\s*newConversation\(p\);/.test(SRC),
    "+ button must stop propagation and call newConversation(p)");
  const iNew = SRC.indexOf("acts.appendChild(newConvBtn);");
  const iRen = SRC.indexOf("acts.appendChild(renameBtn);");
  assert(iNew >= 0 && iRen >= 0 && iNew < iRen, "+ must be appended BEFORE the rename pencil");
});

// ---------------------------------------------------------------------------
// 4. Empty chats hidden from the sidebar + single-draft reuse
// ---------------------------------------------------------------------------

// Verbatim copies of the app predicates.
function conversationHasPosts(c) {
  return !!(c && c.messages && c.messages.some((m) => m.role === "user" && !m.event));
}

test("conversationHasPosts: only a real (non-event) user message counts as a post", () => {
  assert(!conversationHasPosts({ messages: [] }), "empty conversation must NOT count");
  assert(!conversationHasPosts({ messages: [{ role: "assistant", content: "hi" }] }),
    "assistant-only must NOT count");
  assert(!conversationHasPosts({ messages: [{ role: "user", content: "wake", event: true }] }),
    "event-only user message must NOT count");
  assert(conversationHasPosts({ messages: [{ role: "user", content: "build a thing" }] }),
    "a real user message counts");
  assert(!conversationHasPosts(null) && !conversationHasPosts({}), "null/empty must be safe");
});

test("sidebar: the conversation list filters out post-less conversations", () => {
  assert(/p\.conversations\.filter\(conversationHasPosts\)/.test(SRC),
    "renderProjects must list only conversations with posts");
});

test("newConversation: reuses the existing empty draft instead of piling up chats", () => {
  // Replicated reuse guard from newConversation().
  const findDraft = (p) => p.conversations.find((c) => !conversationHasPosts(c));
  const p = { conversations: [
    { id: "c1", messages: [{ role: "user", content: "old chat" }] },
    { id: "c2", messages: [] }, // the empty draft
  ] };
  assert(findDraft(p).id === "c2", "must find the empty draft");
  p.conversations[1].messages.push({ role: "user", content: "now it has a post" });
  assert(!findDraft(p), "a posted conversation is no longer a draft");
  // Source check: the guard exists and RETURNS the draft (no new push).
  const fn = SRC.slice(SRC.indexOf("function newConversation(p)"), SRC.indexOf("function newChatFromTopbar"));
  assert(/const draft = p\.conversations\.find\(\(c\) => !conversationHasPosts\(c\)\);/.test(fn),
    "newConversation must look for an existing empty draft first");
  assert(/if \(draft\) \{[\s\S]*?return draft;/.test(fn), "newConversation must return the reused draft");
});

test("first post: the sidebar re-renders on a conversation's first real message", () => {
  // sendMessage must reveal the formerly-hidden chat even when the name was
  // not a 'Conversation N' placeholder (renamedConv false).
  const fn = SRC.slice(SRC.indexOf("async function sendMessage("), SRC.indexOf("async function runOrchestratorTurn"));
  assert(/if \(renamedConv \|\| \(wasFirstUserMsg && !o\.event\)\) \{ TC\.renderProjects\(\); TC\.renderSessionInfo\(\); \}/.test(fn),
    "sendMessage must renderProjects on the first post, not only on rename");
});

// ---------------------------------------------------------------------------
// 5. Files / Sessions collapsible, collapsed by default
// ---------------------------------------------------------------------------

test("sections: Files and Sessions default to collapsed (false means expanded)", () => {
  assert(/sec\.files !== false/.test(SRC), "Files collapse must default to collapsed");
  assert(/sec\.sessions !== false/.test(SRC), "Sessions collapse must default to collapsed");
  assert(/function toggleProjSection\(pid, key\)/.test(SRC), "toggleProjSection missing");
  assert(/state\.sectionCollapsed\[pid\] = Object\.assign/.test(SRC), "toggle must persist per project");
  assert(/if \(!TC\.state\.sectionCollapsed\) TC\.state\.sectionCollapsed = \{\};/.test(SRC), "sectionCollapsed must be in the init defaults");
});

test("sections: heads are toggles with a chevron; bodies hide when collapsed", () => {
  assert(/head\.onclick = \(\) => toggleProjSection\(project\.id, "files"\)/.test(SRC),
    "Files head must toggle the section");
  assert(/sesHead\.onclick = \(\) => toggleProjSection\(p\.id, "sessions"\)/.test(SRC),
    "Sessions head must toggle the section");
  assert(/\.section-chev/.test(CSS), "section chevron styles missing");
  assert(/\.file-tree\.is-collapsed \.file-tree-body \{ display: none; \}/.test(CSS),
    "collapsed Files body must hide");
  assert(/\.proj-sessions-group\.is-collapsed \.proj-sessions-list \{ display: none; \}/.test(CSS),
    "collapsed Sessions body must hide");
});

test("sections: collapsed file tree does no eager directory read", () => {
  const fn = SRC.slice(SRC.indexOf("function renderFileTree("), SRC.indexOf("function repaintFileTree"));
  assert(/if \(collapsed\) \{[\s\S]*?return;/.test(fn),
    "renderFileTree must bail out before loadDir when the section is collapsed");
});

// ---------------------------------------------------------------------------
// 6. Cmd/Ctrl+N shortcut
// ---------------------------------------------------------------------------

test("shortcut: Cmd/Ctrl+N starts a new chat in the current project", () => {
  const i = SRC.indexOf('e.code === "KeyN"');
  assert(i >= 0, "Cmd/Ctrl+N handler missing");
  const block = SRC.slice(i, i + 400);
  assert(/e\.preventDefault\(\);\s*TC\.newChatFromTopbar\(\);/.test(block),
    "Cmd/Ctrl+N must preventDefault and call newChatFromTopbar()");
  assert(/metaKey \|\| e\.ctrlKey/.test(SRC.slice(Math.max(0, i - 300), i)),
    "combo must require meta/ctrl so a plain 'n' never triggers it");
  // and the tooltip mentions it
  assert(/⌘N \/ Ctrl\+N/.test(HTML) && /⌘N \/ Ctrl\+N/.test(SRC),
    "New chat tooltip should advertise the shortcut");
});

run();
