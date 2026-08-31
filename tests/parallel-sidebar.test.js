// Regression tests for the multi-open sidebar (parallel agents):
//
//   1. More than one project body can be open at once: a body is visible when
//      EITHER it is the active project not explicitly collapsed OR it was
//      explicitly opened (persisted in state.projectOpen).
//   2. Switching active project/conversation KEEPS the outgoing project open
//      (keepProjectOpen) so parallel monitoring survives hopping between
//      conversations.
//   3. Each open project gets its own Sessions list (data-proj-sessions),
//      scoped to that project's conversations; the 2s ticker repaints all of
//      them; the createdAt sort contract is preserved verbatim.
//   4. Session rows in ANY project jump to the owning conversation first,
//      THEN select the session (selectConversation → renderSessionInfo →
//      refreshSessionVisibility → selectSession order).
//   5. Conversation rows show a live progress dot (most-urgent activity).
//
// Same approach as the other suites: grep the real module sources for the
// wiring and replicate the core predicates verbatim for behavior checks.
const fs = require("fs");
const path = require("path");
const { assert, test, run } = require("./harness.js");
const { moduleSrc } = require("./module-src.js");

const PROJ = moduleSrc("11-projects.js");
const STATE = moduleSrc("00-state.js");
const INIT = moduleSrc("24-init.js");
const FOLLOW = moduleSrc("19-autofollow.js");
const HIST = moduleSrc("03-history.js");
const CSS = fs.readFileSync(path.join(__dirname, "..", "style.css"), "utf8");

// ---------------------------------------------------------------------------
// Verbatim predicates from 11-projects.js.
// ---------------------------------------------------------------------------
function isProjectOpen(TC, p) {
  const flag = (TC.state.projectOpen || {})[p.id];
  return (p.id === TC.state.activeProjectId) ? flag !== false : flag === true;
}

test("open-state model: active defaults open; non-active needs an explicit open", () => {
  const mkState = (flags) => ({ projectOpen: flags });
  // active project, no flag → OPEN (same as the old single-panel look)
  assert(isProjectOpen({ state: mkState({}) }, { id: "a" === "a" ? "a" : "a" }) === undefined || true, "noop");
  const TCa = { state: { activeProjectId: "a", projectOpen: {} } };
  assert(isProjectOpen(TCa, { id: "a" }), "active with no flag must be open");
  const TCb = { state: { activeProjectId: "a", projectOpen: { b: false } } };
  assert(!isProjectOpen(TCb, { id: "b" }), "active explicitly collapsed must be closed");
  const TCc = { state: { activeProjectId: "a", projectOpen: { c: true } } };
  assert(isProjectOpen(TCc, { id: "c" }), "non-active explicitly opened must be open");
  const TCd = { state: { activeProjectId: "a", projectOpen: { d: false } } };
  assert(!isProjectOpen(TCd, { id: "d" }), "non-active without explicit open must be closed");
  const TCe = { state: { activeProjectId: "a", projectOpen: {} } };
  assert(!isProjectOpen(TCe, { id: "e" }), "non-active with NO flag must be closed (default single-panel look)");
});

test("open-state model: flags persist across restarts (projectOpen in state defaults)", () => {
  assert(/projectOpen: \{\}/.test(STATE), "00-state.js must default state.projectOpen");
  assert(/if \(!TC\.state\.projectOpen\) TC\.state\.projectOpen = \{\};/.test(INIT),
    "24-init.js must guard a legacy saved state without projectOpen");
});

test("chevron toggles per-project open state via setProjectOpen (no singleton collapse)", () => {
  const chev = PROJ.slice(PROJ.indexOf("chev.onclick"), PROJ.indexOf("row.appendChild(chev)"));
  assert(/setProjectOpen\(p, !open\)/.test(chev), "chevron must call setProjectOpen(p, !open)");
  assert(!/collapsedProjects\.(has|delete|add)/.test(PROJ) && !/defineProperty\(TC, "collapsedProjects"/.test(PROJ),
    "the old collapsedProjects singleton must be gone (comment mentions aside)");
});

test("renderProjects: every open project renders a body (not only the active one)", () => {
  assert(/if \(open\) \{\s*\n\s*const body = document\.createElement\("div"\);\s*\n\s*body\.className = "proj-body";/.test(PROJ),
    "project body must render under if (open)");
  assert(!/isActive && !isCollapsed/.test(PROJ), "the old active-only body gate must be gone");
});

test("keepProjectOpen: switching active keeps a monitored project open", () => {
  const TC = { state: { activeProjectId: "a", projectOpen: { b: true } }, getProject: (id) => (id === "b" ? { id: "b" } : null) };
  // verbatim body of keepProjectOpen
  function keepProjectOpen(pid) {
    if (!pid) return;
    const p = TC.getProject(pid);
    if (!p) return;
    if (!TC.state.projectOpen) TC.state.projectOpen = {};
    if (isProjectOpen(TC, p)) TC.state.projectOpen[pid] = true;
  }
  keepProjectOpen("b");
  assert(TC.state.projectOpen.b === true, "outgoing open project must be stuck open");
  // A closed project is NOT force-opened by a switch away from it.
  const TC2 = { state: { activeProjectId: "x", projectOpen: { y: false } }, getProject: (id) => (id === "y" ? { id: "y" } : null) };
  function kp2(pid) {
    const p = TC2.getProject(pid);
    if (!p) return;
    if (isProjectOpen(TC2, p)) TC2.state.projectOpen[pid] = true;
  }
  kp2("y");
  assert(TC2.state.projectOpen.y === false, "selecting away must not reveal a project the user collapsed");
});

test("selectProject/selectConversation switch away without collapsing the monitor", () => {
  const sp = PROJ.slice(PROJ.indexOf("function selectProject(pid)"), PROJ.indexOf("// Switching conversation must also"));
  const sc = PROJ.slice(PROJ.indexOf("function selectConversation(pid, cid)"), PROJ.indexOf("async function newProject"));
  assert(/keepProjectOpen\(TC\.state\.activeProjectId\);/.test(sp), "selectProject must keepProjectOpen the outgoing project");
  assert(/keepProjectOpen\(TC\.state\.activeProjectId\);/.test(sc), "selectConversation must keepProjectOpen the outgoing project");
  assert(/delete TC\.state\.projectOpen\[pid\];/.test(sp), "selectProject must clear the incoming flag (always reveal)");
  // history reopen path reveals too
  assert(/delete TC\.state\.projectOpen\[p\.id\];/.test(HIST), "historyReopenConversation must clear the reveal flag");
});

test("Sessions lists exist per open project (data-proj-sessions) and the ticker repaints all", () => {
  assert(/sesBody\.dataset\.projSessions = p\.	id?;/m.test(PROJ.replace(/\.id;/, ".id;")) || /sesBody\.dataset\.projSessions = p\.id;/.test(PROJ),
    "each Sessions list body must carry data-proj-sessions");
  assert(/querySelectorAll\("\[data-proj-sessions\]"\)/.test(PROJ), "paintProjSessions must iterate every open project's list");
  assert(/paintOneProjSessions\(pid, body, countEl\)/.test(PROJ), "paintProjSessions must delegate per project");
  assert(/TC\.el\.projectList\.querySelector\("\[data-proj-sessions\]"\)/.test(FOLLOW) || /projectList.*\[data-proj-sessions\]/.test(FOLLOW),
    "the 2s ticker must fire when ANY open project has a Sessions list");
});

test("paintProjSessions keeps the newest-first createdAt sort (sessions-order contract)", () => {
  assert(/const recs = liveAll\.sort\(\(a, b\) => \(b\.createdAt \|\| 0\) - \(a\.createdAt \|\| 0\)\);/.test(PROJ),
    "live list must sort by createdAt descending (newest first)");
  assert(/const deads = deadAll\.sort\(\(a, b\) => \(b\.endedAt \|\| b\.createdAt \|\| 0\) - \(a\.endedAt \|\| a\.createdAt \|\| 0\)\);/.test(PROJ),
    "ended list must sort by endedAt descending");
});

test("per-project scope: a project's Sessions list covers ALL of its conversations", () => {
  const fn = PROJ.slice(PROJ.indexOf("function paintOneProjSessions"), PROJ.indexOf("function jumpToSession"));
  assert(/const convIds = new Set\(p\.conversations\.map\(\(c\) => c\.id\)\);/.test(fn),
    "must key the project's conversation ids");
  assert(/convIds\.has\(s\.conversationId \|\| null\)/.test(fn), "must scope sessions by conversationId ∈ project");
});

test("session rows in any project jump to the owning conversation BEFORE selecting", () => {
  const fn = PROJ.slice(PROJ.indexOf("function jumpToSession(pid, rec)"), PROJ.indexOf("// The \x22most urgent\x22 activity"));
  const iSel = fn.indexOf("selectConversation(pid, cid)");
  const iGrid = fn.indexOf("TC.selectSession(rec.id)");
  assert(iSel !== -1 && iGrid !== -1 && iSel < iGrid,
    "jumpToSession must selectConversation first, then selectSession (grid visibility refresh)");
  assert(/row\.onclick = \(\) => jumpToSession\(p\.id, rec\);/.test(PROJ), "live rows must jump");
  assert(/row\.onclick = \(\) => jumpToSession\(p\.id, snap\);/.test(PROJ), "ended rows must jump");
});

// Verbatim replication of conversationActivity.
function conversationActivity(TC, c) {
  if (!c) return null;
  const recs = [
    ...[...TC.sessions.values()].filter((s) => (s.conversationId || null) === c.id),
    ...[...TC.deadSessions.values()].filter((s) => (s.conversationId || null) === c.id),
  ];
  const rank = { "ERROR LOOP": 6, "NEEDS INPUT": 5, "WORKING": 4, "STARTING": 3, "IDLE": 2, "EXITED": 1 };
  let best = null, bestR = 0;
  for (const s of recs) {
    const a = TC.sessionActivity(s);
    const r = rank[a] || 0;
    if (r > bestR) { bestR = r; best = a; }
  }
  return best;
}

test("conversation dot: most-urgent activity wins across a conversation's sessions", () => {
  const TC = {
    sessions: new Map([
      ["s1", { id: "s1", conversationId: "c1", active: true, taskSubmittedAt: Date.now(), lastOutputAt: Date.now(), bytesSinceTask: 9999 }],
      ["s2", { id: "s2", conversationId: "c1", active: true, waitingForInput: true, taskSubmittedAt: Date.now() }],
    ]),
    deadSessions: new Map(),
    sessionActivity(s) {
      if (!s) return "EXITED";
      if (s.active === false) return "EXITED";
      if (s.errorLoop) return "ERROR LOOP";
      if (s.waitingForInput) return "NEEDS INPUT";
      const quietFor = Date.now() - (s.lastOutputAt || 0);
      if (!s.taskSubmittedAt) return quietFor >= 20000 ? "IDLE" : "STARTING";
      if (s.bytesSinceTask < 800) return "STARTING";
      return quietFor < 20000 ? "WORKING" : "IDLE";
    },
  };
  assert(conversationActivity(TC, { id: "c1" }) === "NEEDS INPUT",
    "NEEDS INPUT outranks WORKING (a blocked agent needs attention first)");
  assert(conversationActivity(TC, { id: "none" }) === null, "a conversation with no sessions shows no dot");
});

test("sidebar conversation rows carry the live progress indicator", () => {
  assert(/ind\.dataset\.convIndicator = c\.id;/.test(PROJ), "each conversation row must carry an indicator container");
  assert(/paintConvIndicators\(\);/.test(PROJ), "renderProjects must paint the indicators");
  assert(/paintConvIndicator\(container, prog\.kind === "running"[\s\S]*conv-jump-dot/.test(PROJ.replace(/\n/g, " ")) ||
         (/function paintConvIndicator\(container, prog\) {[\s\S]*?conv-jump-dot/.test(PROJ)),
    "the running state must render the 3 jumping dots");
  assert(/\.conversation-item \.conv-dot\[data-status="unread"\] { background: var\(--green\)/.test(CSS), "green dot for finished & unread");
  assert(/\.conversation-item \.conv-dot\[data-status="read"\] { background: transparent/.test(CSS), "hollow dot for finished & read");
  assert(/\.conversation-item \.conv-dot\[data-status="input"\] { background: var\(--amber\)/.test(CSS), "orange dot for needs-input");
  assert(/@keyframes conv-jump/.test(CSS), "jumping-dot animation missing");
});

test("files tree stays active-project-only (singleton tree) while bodies are multi-open", () => {
  const body = PROJ.slice(PROJ.indexOf("if (open) {"), PROJ.indexOf("item.appendChild(body);"));
  assert(/ACTIVE project only: the tree is a singleton/.test(body) && body.indexOf("if (isActive) {") !== -1,
    "the Files section must render only for the active project (if (isActive) gate)");
  const gate = body.slice(body.indexOf("if (isActive) {"), body.indexOf("renderFileTree(p, filesWrap"));
  assert(gate.length > 0 && gate.length < 400, "the isActive gate must directly contain the file tree");
  assert(body.indexOf("renderFileTree(p, filesWrap") !== -1, "active project keeps its file tree");
});

test("el singletons keep meaning the ACTIVE project's sessions section", () => {
  assert(/\n\s{6}if \(isActive\) \{\s*\n\s*\/\/ The el refs keep meaning[\s\S]*?TC\.el\.projSessionsBody = sesBody;/.test(PROJ),
    "TC.el.projSessionsBody must be assigned only for the active project");
});

test("deleteProject clears the persisted open flag", () => {
  const dp = PROJ.slice(PROJ.indexOf("function deleteProject(p)"), PROJ.indexOf("// Derive a short conversation name"));
  assert(/delete TC\.state\.projectOpen\[p\.id\];/.test(dp), "deleted project must not leave a stale open flag");
});

// ---------------------------------------------------------------------------
// Per-project activity badge — a busy-agent count ON the project row so even a
// COLLAPSED project signals activity.
// ---------------------------------------------------------------------------
function projectActivitySummary(TC, p) {
  const empty = { running: 0, starting: 0, input: 0, error: 0, active: 0 };
  if (!p) return empty;
  const convIds = new Set(p.conversations.map((c) => c.id));
  let running = 0, starting = 0, input = 0, error = 0;
  for (const s of TC.sessions.values()) {
    if (!convIds.has(s.conversationId || null)) continue;
    const act = TC.sessionActivity(s);
    if (act === "WORKING") running++;
    else if (act === "STARTING") starting++;
    else if (act === "NEEDS INPUT") input++;
    else if (act === "ERROR LOOP") error++;
  }
  return { running, starting, input, error, active: running + starting + input + error };
}

test("activity badge: counts busy agents per project, scoped to its conversations", () => {
  const TC = {
    sessions: new Map([
      ["s1", { id: "s1", conversationId: "p1c1", working: true }],
      ["s2", { id: "s2", conversationId: "p1c2", waiting: true }],
      ["s3", { id: "s3", conversationId: "p2c1", working: true }],
      ["s4", { id: "s4", conversationId: "p2c1", idle: true }],       // settled → not busy
      ["s5", { id: "s5", conversationId: null, working: true }],      // no conversation → nowhere
    ]),
    sessionActivity(s) {
      if (s.working) return "WORKING";
      if (s.waiting) return "NEEDS INPUT";
      if (s.errloop) return "ERROR LOOP";
      if (s.beginning) return "STARTING";
      return "IDLE";
    },
  };
  const p1 = { conversations: [{ id: "p1c1" }, { id: "p1c2" }] };
  const sum1 = projectActivitySummary(TC, p1);
  assert(sum1.running === 1 && sum1.input === 1 && sum1.active === 2,
    "p1 badge must count its working + needs-input agents (2)");
  const p2 = { conversations: [{ id: "p2c1" }] };
  const sum2 = projectActivitySummary(TC, p2);
  assert(sum2.active === 1, "p2 badge must count only its busy agent (1) — settled sessions don't count");
  assert(projectActivitySummary(TC, null).active === 0, "no project → zero");
  const emptyP = { conversations: [] };
  assert(projectActivitySummary(TC, emptyP).active === 0, "project with no conversations → zero");
});

test("activity badge: renders on every project row (collapsed included) and repaints via the ticker", () => {
  assert(/actBadge\.dataset\.projActivity = p\.id;/.test(PROJ),
    "renderProjects must stamp data-proj-activity on every project row");
  // The badge element is created OUTSIDE any `if (open)` gate — find its
  // creation and confirm it sits before the body gate in the loop.
  const rowBadgeIdx = PROJ.indexOf("actBadge.className = \"proj-activity-badge hidden\"");
  const bodyGateIdx = PROJ.indexOf("if (open) {");
  const rowLoopIdx = PROJ.indexOf("for (const p of TC.state.projects) {");
  assert(rowLoopIdx !== -1 && rowBadgeIdx !== -1 && rowBadgeIdx > rowLoopIdx && rowBadgeIdx < bodyGateIdx,
    "the badge must be created for every project, not only open ones");
  assert(/badge\.dataset\.urgent = "error";/.test(PROJ) && /badge\.dataset\.urgent = "input";/.test(PROJ),
    "paintProjActivity must color the badge by most-urgent state");
  assert(/badge\.classList\.add\("hidden"\);[\s\S]*?badge\.textContent = "";/.test(PROJ),
    "badge must hide entirely when nothing is busy");
  assert(/TC\.paintProjActivity\(\);/.test(FOLLOW),
    "the 2s status ticker must repaint the badges (collapsed projects stay live)");
  assert(/TC\.paintProjActivity = paintProjActivity;/.test(PROJ), "paintProjActivity must be exported on TC");
  assert(/TC\.projectActivitySummary = projectActivitySummary;/.test(PROJ), "projectActivitySummary must be exported on TC");
  assert(/TC\.getProject\(badge\.dataset\.projActivity\)/.test(PROJ),
    "paintProjActivity must resolve the project by the badge's data attr");
  assert(/\.proj-activity-badge/.test(CSS), "badge CSS must exist");
  assert(/\.proj-activity-badge\[data-urgent="input"\]/.test(CSS) && /\.proj-activity-badge\[data-urgent="error"\]/.test(CSS),
    "badge CSS must have the amber (needs input) and red (error loop) urgency variants");
});

test("renderProjects paints the badges immediately (not just on the next tick)", () => {
  const tail = PROJ.slice(PROJ.indexOf("// Plus the per-project activity badges"));
  assert(/paintProjActivity\(\);/.test(tail),
    "renderProjects must end with a paintProjActivity() pass after the DOM is built");
});

run();