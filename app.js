// Term Code — AI agent orchestrator with live terminals.
// Loaded by index.html as <script type="module" src="app.js"></script>.

const STORE_KEY = "term-code.state";

// ---------- State ----------
let state = {
  projects: [],
  activeProjectId: null,
  activeConversationId: null,
  activeSessionId: null,
};
let models = [];
let defaultModelId = null;
let running = false;
let abortController = null;

// Sessions registry: sessionId -> { id, cli, cwd, exitCode?, active, tabEl, paneEl, dispose? }
const sessions = new Map();

// ---------- DOM refs ----------
const $ = (id) => document.getElementById(id);
const el = {
  loading: $("app-loading"),
  newProjectBtn: $("new-project-btn"),
  projectList: $("project-list"),
  modelPicker: $("model-picker"),
  effortPicker: $("effort-picker"),
  attachBoardBtn: $("attach-board-btn"),
  attachedBoardName: $("attached-board-name"),
  chatLog: $("chat-log"),
  chatStatus: $("chat-status"),
  chatForm: $("chat-form"),
  chatInput: $("chat-input"),
  sendBtn: $("send-btn"),
  chatTitle: $("chat-title"),
  termTabs: $("term-tabs"),
  termHost: $("term-host"),
  manualForm: $("manual-session-form"),
  manualCli: $("manual-cli"),
  manualCwd: $("manual-cwd"),
  manualStartBtn: $("manual-start-btn"),
  sessionInfo: $("session-info"),
};

// ---------- Utils ----------
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function basename(p) {
  if (!p) return "project";
  const parts = String(p).replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}
function uuid() {
  return (crypto.randomUUID && crypto.randomUUID()) ||
    "id-" + Date.now() + "-" + Math.random().toString(36).slice(2);
}
function saveState() {
  try { window.chatoss.scopedData.set(STORE_KEY, state); } catch (e) { console.warn("saveState", e); }
}
function getProject(id) { return state.projects.find((p) => p.id === id) || null; }
function getConversation(pid, cid) {
  const p = getProject(pid);
  return p ? p.conversations.find((c) => c.id === cid) || null : null;
}
function activeConversation() { return getConversation(state.activeProjectId, state.activeConversationId); }

// ---------- Tool definitions (JSON schema for runTurn) ----------
const ORCHESTRATOR_TOOLS = [
  {
    type: "function",
    function: {
      name: "create_worktree",
      description: "Create a git worktree (an isolated working directory on a new branch) inside the project's .chatoss/worktrees folder. Returns the worktree path.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "The project id to create the worktree in." },
          branchName: { type: "string", description: "Optional branch name. Defaults to worktree-<timestamp>." },
        },
        required: ["projectId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "start_cli_session",
      description: "Spawn a Codex or Claude CLI session in a given working directory and (optionally) send it a task prompt. Returns the session id.",
      parameters: {
        type: "object",
        properties: {
          cli: { type: "string", enum: ["codex", "claude"], description: "Which CLI to spawn." },
          cwd: { type: "string", description: "Working directory for the session (a project path or a worktree path)." },
          taskPrompt: { type: "string", description: "Optional initial task to send to the CLI on startup." },
        },
        required: ["cli", "cwd"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_to_session",
      description: "Send a line of text to a running CLI session's stdin.",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          text: { type: "string" },
        },
        required: ["sessionId", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_project_files",
      description: "List the files in a project's working directory (ls -la). Returns the directory listing.",
      parameters: {
        type: "object",
        properties: { projectId: { type: "string" } },
        required: ["projectId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_boards",
      description: "List the user's available Kanban boards. Returns a JSON array of {id,name}.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_board",
      description: "Fetch a Kanban board's full contents (columns and cards). Returns JSON.",
      parameters: {
        type: "object",
        properties: { boardId: { type: "string" } },
        required: ["boardId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "move_card",
      description: "Move a Kanban card to a different column.",
      parameters: {
        type: "object",
        properties: {
          boardId: { type: "string" },
          cardId: { type: "string" },
          toColumnId: { type: "string" },
        },
        required: ["boardId", "cardId", "toColumnId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_card",
      description: "Update a Kanban card's title/description or mark it done. When done is true, the card is completed and moved to the Done column and a notification is sent.",
      parameters: {
        type: "object",
        properties: {
          boardId: { type: "string" },
          cardId: { type: "string" },
          done: { type: "boolean" },
          title: { type: "string" },
          description: { type: "string" },
        },
        required: ["boardId", "cardId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_current_git_branch",
      description: "Return the current git branch name of a project.",
      parameters: {
        type: "object",
        properties: { projectId: { type: "string" } },
        required: ["projectId"],
      },
    },
  },
];

// ---------- Tool handlers (async, return string) ----------
async function toolHandler(name, args) {
  args = args || {};
  try {
    switch (name) {
      case "create_worktree": {
        const p = getProject(args.projectId);
        if (!p) return "Error: project not found";
        const branch = args.branchName || "worktree-" + Date.now();
        const wtPath = (p.folderPath.replace(/\/+$/, "") + "/.chatoss/worktrees/" + branch);
        const r = await window.chatoss.terminal.exec(
          `git worktree add "${wtPath}" -b "${branch}"`,
          { cwd: p.folderPath }
        );
        if (r === null) return "Error: terminal permission denied";
        if (r.exitCode !== 0) return "git worktree failed (exit " + r.exitCode + "):\n" + r.output;
        return wtPath;
      }
      case "start_cli_session": {
        const cli = args.cli || "codex";
        const cwd = args.cwd || "";
        if (!cwd) return "Error: cwd is required";
        const session = await window.chatoss.terminal.spawn(cli, { args: [], cwd, cols: 80, rows: 24 });
        if (!session || !session.id) return "Error: terminal permission denied for spawn";
        registerSession(session.id, cli, cwd);
        if (args.taskPrompt) {
          await window.chatoss.terminal.write(session.id, args.taskPrompt + "\n");
        }
        return session.id;
      }
      case "send_to_session": {
        const s = sessions.get(args.sessionId);
        if (!s) return "Error: session not found";
        await window.chatoss.terminal.write(args.sessionId, args.text + "\n");
        return "ok";
      }
      case "list_project_files": {
        const p = getProject(args.projectId);
        if (!p) return "Error: project not found";
        const r = await window.chatoss.terminal.exec("ls -la", { cwd: p.folderPath });
        if (r === null) return "Error: terminal permission denied";
        return r.output || "(empty)";
      }
      case "list_boards": {
        const list = await window.chatoss.boards.list();
        return JSON.stringify(list);
      }
      case "get_board": {
        const b = await window.chatoss.boards.get(args.boardId);
        return JSON.stringify(b);
      }
      case "move_card": {
        await window.chatoss.boards.moveCard(args.boardId, args.cardId, args.toColumnId);
        return "ok";
      }
      case "update_card": {
        await window.chatoss.boards.updateCard(args.boardId, args.cardId, {
          done: args.done, title: args.title, description: args.description,
        });
        if (args.done === true) {
          let body = "Card " + args.cardId + " marked complete.";
          try {
            const b = await window.chatoss.boards.get(args.boardId);
            const card = b && b.cards ? b.cards.find((c) => c.id === args.cardId) : null;
            if (card && card.title) body = card.title;
          } catch (e) {}
          try { await window.chatoss.notifications.send({ title: "Task complete", body }); } catch (e) {}
        }
        return "ok";
      }
      case "get_current_git_branch": {
        const p = getProject(args.projectId);
        if (!p) return "Error: project not found";
        const r = await window.chatoss.terminal.exec("git branch --show-current", { cwd: p.folderPath });
        if (r === null) return "Error: terminal permission denied";
        return (r.output || "").trim() || "(no branch)";
      }
      default:
        return "Error: unknown tool " + name;
    }
  } catch (e) {
    return "Error: " + (e && e.message ? e.message : String(e));
  }
}

// ---------- Render: left column ----------
function renderProjects() {
  el.projectList.innerHTML = "";
  if (!state.projects.length) {
    const empty = document.createElement("div");
    empty.className = "conversation-item";
    empty.style.opacity = "0.6";
    empty.style.cursor = "default";
    empty.textContent = "No projects yet. Click “+ New Project”.";
    el.projectList.appendChild(empty);
    return;
  }
  for (const p of state.projects) {
    const item = document.createElement("div");
    item.className = "project-item" + (p.id === state.activeProjectId ? " selected" : "");

    const name = document.createElement("div");
    name.className = "project-name";
    const nameText = document.createElement("span");
    nameText.className = "project-name-text";
    nameText.textContent = p.name;
    name.appendChild(nameText);

    const renameBtn = document.createElement("button");
    renameBtn.className = "btn-icon";
    renameBtn.title = "Rename";
    renameBtn.textContent = "✎";
    renameBtn.onclick = (e) => { e.stopPropagation(); renameProject(p); };

    const delBtn = document.createElement("button");
    delBtn.className = "btn-icon btn-danger";
    delBtn.title = "Delete";
    delBtn.textContent = "✕";
    delBtn.onclick = (e) => { e.stopPropagation(); deleteProject(p); };

    name.appendChild(renameBtn);
    name.appendChild(delBtn);
    item.appendChild(name);

    const convList = document.createElement("div");
    convList.className = "conversation-list";

    for (const c of p.conversations) {
      const ci = document.createElement("div");
      ci.className = "conversation-item" + (p.id === state.activeProjectId && c.id === state.activeConversationId ? " selected" : "");
      const cn = document.createElement("span");
      cn.className = "conv-name";
      cn.textContent = c.name;
      ci.appendChild(cn);
      const cdel = document.createElement("button");
      cdel.className = "btn-icon btn-danger";
      cdel.title = "Delete conversation";
      cdel.textContent = "✕";
      cdel.onclick = (e) => { e.stopPropagation(); deleteConversation(p, c); };
      ci.appendChild(cdel);
      ci.onclick = () => selectConversation(p.id, c.id);
      convList.appendChild(ci);
    }

    // "+ New conversation" under the selected project
    if (p.id === state.activeProjectId) {
      const add = document.createElement("div");
      add.className = "conversation-item";
      add.style.fontWeight = "600";
      add.textContent = "+ New conversation";
      add.onclick = () => newConversation(p);
      convList.appendChild(add);
    }

    item.appendChild(convList);
    name.onclick = () => selectProject(p.id);
    el.projectList.appendChild(item);
  }
}

function selectProject(pid) {
  state.activeProjectId = pid;
  const p = getProject(pid);
  state.activeConversationId = p && p.conversations.length ? p.conversations[0].id : null;
  saveState();
  renderProjects();
  renderChat();
  renderSessionInfo();
}
function selectConversation(pid, cid) {
  state.activeProjectId = pid;
  state.activeConversationId = cid;
  saveState();
  renderProjects();
  renderChat();
}
async function newProject() {
  const path = await window.chatoss.files.pickFolder();
  if (!path) return;
  const p = { id: uuid(), name: basename(path), folderPath: path, conversations: [] };
  state.projects.push(p);
  state.activeProjectId = p.id;
  state.activeConversationId = null;
  saveState();
  renderProjects();
  newConversation(p);
  renderSessionInfo();
}
function renameProject(p) {
  const n = window.prompt("Rename project", p.name);
  if (n && n.trim()) { p.name = n.trim(); saveState(); renderProjects(); renderSessionInfo(); }
}
function deleteProject(p) {
  if (!window.confirm("Delete project “" + p.name + "” and all its conversations?")) return;
  state.projects = state.projects.filter((x) => x.id !== p.id);
  if (state.activeProjectId === p.id) {
    state.activeProjectId = state.projects.length ? state.projects[0].id : null;
    const np = getProject(state.activeProjectId);
    state.activeConversationId = np && np.conversations.length ? np.conversations[0].id : null;
  }
  saveState();
  renderProjects();
  renderChat();
  renderSessionInfo();
}
function newConversation(p) {
  const c = { id: uuid(), name: "Conversation", messages: [], modelId: null, effort: null, boardId: null };
  p.conversations.push(c);
  state.activeProjectId = p.id;
  state.activeConversationId = c.id;
  saveState();
  renderProjects();
  renderChat();
}
function deleteConversation(p, c) {
  if (!window.confirm("Delete conversation “" + c.name + "”?")) return;
  p.conversations = p.conversations.filter((x) => x.id !== c.id);
  if (state.activeConversationId === c.id) {
    state.activeConversationId = p.conversations.length ? p.conversations[0].id : null;
  }
  saveState();
  renderProjects();
  renderChat();
}

// ---------- Render: middle column (chat) ----------
function renderChat() {
  const c = activeConversation();
  el.chatLog.innerHTML = "";
  if (!c) {
    el.chatTitle.textContent = "Ask the agent";
    el.attachedBoardName.textContent = "No board";
    el.chatInput.placeholder = "Select or create a conversation…";
    renderModelPicker();
    renderEffortPicker();
    return;
  }
  el.chatTitle.textContent = c.name;
  el.chatInput.placeholder = "Ask the orchestrator to build something…";
  el.attachedBoardName.textContent = c.boardId ? "Board attached" : "No board";
  renderModelPicker();
  renderEffortPicker();

  for (const m of c.messages) {
    renderMessage(m);
  }
  scrollChatBottom();
}
function renderMessage(m) {
  const row = document.createElement("div");
  row.className = "msg " + (m.role || "system");
  if (m.thinking) {
    const th = document.createElement("div");
    th.className = "msg-thinking";
    th.textContent = m.thinking;
    el.chatLog.appendChild(th);
  }
  const body = document.createElement("div");
  body.innerHTML = m.content ? m.content.split(/\n\n+/).map((p) => "<p>" + esc(p).replace(/\n/g, "<br>") + "</p>").join("") : "";
  row.appendChild(body);
  if (m.toolCalls && m.toolCalls.length) {
    const pre = document.createElement("pre");
    pre.textContent = m.toolCalls.map((t) => "→ " + t.name + "(" + JSON.stringify(t.args || {}) + ")").join("\n");
    row.appendChild(pre);
  }
  el.chatLog.appendChild(row);
  return row;
}
function scrollChatBottom() { el.chatLog.scrollTop = el.chatLog.scrollHeight; }

function renderModelPicker() {
  if (!models.length) { el.modelPicker.innerHTML = ""; return; }
  const c = activeConversation();
  const cur = c && c.modelId ? c.modelId : null;
  let preselect = cur;
  if (!preselect) preselect = (defaultModelId && models.some((m) => m.id === defaultModelId && m.available)) ? defaultModelId : null;
  if (!preselect) preselect = (models.find((m) => m.available) || models[0]).id;

  el.modelPicker.innerHTML = "";
  for (const m of models) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.name + " (" + m.source + ")";
    if (!m.available) { opt.disabled = true; opt.textContent += " — unavailable"; }
    el.modelPicker.appendChild(opt);
  }
  el.modelPicker.value = preselect;
  if (c) { c.modelId = preselect; saveState(); }
}
function renderEffortPicker() {
  const c = activeConversation();
  const id = el.modelPicker.value;
  const m = models.find((x) => x.id === id);
  if (m && m.capabilities && m.capabilities.includes("reasoning") && m.thinkLevels && m.thinkLevels.length) {
    el.effortPicker.classList.remove("hidden");
    el.effortPicker.innerHTML = "";
    for (const lvl of m.thinkLevels) {
      const opt = document.createElement("option");
      opt.value = lvl; opt.textContent = lvl;
      el.effortPicker.appendChild(opt);
    }
    let eff = c && c.effort ? c.effort : null;
    if (!eff || !m.thinkLevels.includes(eff)) eff = m.thinkDefault || m.thinkLevels[0];
    el.effortPicker.value = eff;
    if (c) { c.effort = eff; saveState(); }
  } else {
    el.effortPicker.classList.add("hidden");
    if (c) { c.effort = null; saveState(); }
  }
}
function selectedModel() { return el.modelPicker.value; }
function selectedEffort() {
  if (el.effortPicker.classList.contains("hidden")) return null;
  return el.effortPicker.value || null;
}

// ---------- Board attach ----------
async function attachBoard() {
  const c = activeConversation();
  if (!c) { window.alert("Select a conversation first."); return; }
  try {
    const list = await window.chatoss.boards.list();
    if (!list || !list.length) { window.alert("No Kanban boards available."); return; }
    let menu = "Attach a Kanban board by number:\n\n";
    list.forEach((b, i) => { menu += (i + 1) + ". " + b.name + " (" + b.id + ")\n"; });
    const pick = window.prompt(menu, "1");
    if (!pick) return;
    const idx = parseInt(pick, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= list.length) { window.alert("Invalid choice."); return; }
    c.boardId = list[idx].id;
    saveState();
    renderChat();
  } catch (e) {
    window.alert("Boards error: " + (e && e.message ? e.message : String(e)));
  }
}

// ---------- Build system prompt ----------
async function buildSystemPrompt() {
  const c = activeConversation();
  const p = getProject(state.activeProjectId);
  let sys = [
    "You are Term Code, an autonomous software-building orchestrator (like a coding agent).",
    "You build software by spawning Codex or Claude CLI sessions inside git worktrees, reading Kanban board tasks, and marking cards done when work is complete.",
    "",
    "Workflow:",
    "1. Inspect the project with list_project_files / get_current_git_branch.",
    "2. Create an isolated git worktree with create_worktree for the work.",
    "3. Spawn a CLI session (codex or claude) in that worktree with start_cli_session, passing a task prompt.",
    "4. Drive the session with send_to_session as needed.",
    "5. Read the attached Kanban board with get_board, pick the next card, and when finished call update_card with done:true.",
    "",
  ];
  if (p) {
    sys.push("Current project: " + p.name);
    sys.push("Project folder: " + p.folderPath);
  }
  if (c && c.boardId) {
    try {
      const b = await window.chatoss.boards.get(c.boardId);
      if (b) {
        sys.push("", "Attached Kanban board: " + b.name, "Columns: " + (b.columns || []).map((col) => col.name).join(" | "), "", "Tasks:");
        const cards = b.cards || [];
        if (!cards.length) sys.push("(no cards)");
        for (const card of cards) {
          const col = (b.columns || []).find((x) => x.id === card.columnId);
          sys.push("- [" + (col ? col.name : "?") + "]" + (card.done ? " (done)" : "") + " " + card.title +
            (card.description ? " — " + card.description : ""));
        }
      }
    } catch (e) {
      sys.push("(Could not read attached board: " + (e && e.message ? e.message : String(e)) + ")");
    }
  }
  return sys.join("\n");
}

// ---------- Send message ----------
function setStatus(t) { el.chatStatus.textContent = t || ""; }
function setRunning(r) {
  running = r;
  el.sendBtn.textContent = r ? "Stop" : "Send";
  el.sendBtn.classList.toggle("is-running", r);
  el.chatInput.disabled = r;
}

async function sendMessage() {
  const c = activeConversation();
  if (!c) { window.alert("Select or create a conversation first."); return; }
  if (running) return;
  const text = el.chatInput.value.trim();
  if (!text) return;
  el.chatInput.value = "";

  c.messages.push({ role: "user", content: text });
  saveState();
  renderMessage({ role: "user", content: text });
  scrollChatBottom();

  setRunning(true);
  setStatus("Generating…");
  abortController = new AbortController();

  const modelId = selectedModel() || defaultModelId;
  const effort = selectedEffort();

  // live assistant row
  const liveRow = document.createElement("div");
  liveRow.className = "msg assistant";
  const liveBody = document.createElement("div");
  liveRow.appendChild(liveBody);
  let liveThink = null;
  let accContent = "";
  let accThink = "";
  const liveToolCalls = [];

  try {
    const systemPrompt = await buildSystemPrompt();
    const msgs = [{ role: "system", content: systemPrompt }];
    for (const m of c.messages) {
      if (m.role === "user" || m.role === "assistant") {
        msgs.push({ role: m.role, content: m.content || "" });
      }
    }

    const result = await window.chatoss.chat.runTurn({
      model: modelId,
      messages: msgs,
      tools: ORCHESTRATOR_TOOLS,
      onToken: (t) => {
        if (!t) return;
        accContent += t;
        liveBody.innerHTML = accContent.split(/\n\n+/).map((p) => "<p>" + esc(p).replace(/\n/g, "<br>") + "</p>").join("");
        scrollChatBottom();
      },
      onThinking: (t) => {
        if (!t) return;
        if (!liveThink) {
          liveThink = document.createElement("div");
          liveThink.className = "msg-thinking";
          el.chatLog.insertBefore(liveThink, liveRow);
        }
        accThink += t;
        liveThink.textContent = accThink;
        scrollChatBottom();
      },
      onToolCall: async (call) => {
        const tname = call && call.name;
        const targs = call && call.args ? call.args : {};
        liveToolCalls.push({ name: tname, args: targs });
        // render a tool row
        const tr = document.createElement("div");
        tr.className = "msg tool";
        tr.textContent = "→ " + tname + "(" + JSON.stringify(targs) + ")";
        el.chatLog.insertBefore(tr, liveRow);
        scrollChatBottom();
        try {
          const res = await toolHandler(tname, targs);
          return res;
        } catch (e) {
          return "Error: " + (e && e.message ? e.message : String(e));
        }
      },
      think: true,
      thinkLevel: effort || undefined,
      signal: abortController.signal,
    });

    const content = result && result.content ? result.content : accContent;
    const thinking = result && result.thinking ? result.thinking : accThink;

    if (result && result.aborted) {
      setStatus("Stopped");
    } else {
      setStatus("");
    }

    // finalize assistant message
    liveRow.remove();
    if (liveThink) liveThink.remove();
    c.messages.push({
      role: "assistant",
      content: content || "(no response)",
      thinking: thinking || undefined,
      toolCalls: (result && result.toolCalls) ? result.toolCalls : liveToolCalls.length ? liveToolCalls : undefined,
    });
    saveState();
    renderMessage(c.messages[c.messages.length - 1]);
    scrollChatBottom();
  } catch (e) {
    liveRow.remove();
    if (liveThink) liveThink.remove();
    setStatus("");
    const msg = "Error: " + (e && e.message ? e.message : String(e));
    c.messages.push({ role: "system", content: msg });
    saveState();
    renderMessage({ role: "system", content: msg });
    scrollChatBottom();
  } finally {
    setRunning(false);
    abortController = null;
  }
}

// ---------- Right column: terminals ----------
function ensureEmptyHint() {
  let hint = el.termHost.querySelector(".term-empty");
  if (!hint) {
    hint = document.createElement("div");
    hint.className = "term-empty";
    hint.textContent = "No active sessions. Ask the orchestrator to build something, or start one manually below.";
    el.termHost.appendChild(hint);
  }
  hint.style.display = sessions.size ? "none" : "";
}
function registerSession(id, cli, cwd) {
  const tab = document.createElement("button");
  tab.className = "term-tab";
  tab.type = "button";
  const label = document.createElement("span");
  label.className = "term-tab-label";
  label.textContent = cli + " · " + basename(cwd);
  const close = document.createElement("button");
  close.className = "term-close";
  close.type = "button";
  close.innerHTML = "&times;";
  close.title = "Close session";
  tab.appendChild(label);
  tab.appendChild(close);

  const pane = document.createElement("div");
  pane.className = "term-pane";
  pane.style.position = "absolute";
  pane.style.inset = "0";
  pane.style.display = "none";

  el.termTabs.appendChild(tab);
  el.termHost.appendChild(pane);

  const rec = { id, cli, cwd, active: true, tabEl: tab, paneEl: pane, dispose: null };
  sessions.set(id, rec);

  // mount xterm widget
  try {
    const handle = window.chatoss.terminal.mount(pane, { id }, { fontSize: 13 });
    rec.dispose = handle && handle.dispose ? handle.dispose : null;
  } catch (e) {
    console.warn("mount failed", e);
  }

  // wire onData (optional logging) + onExit
  try {
    window.chatoss.terminal.onData(id, () => {});
  } catch (e) {}
  window.chatoss.terminal.onExit(id, (exitCode) => {
    rec.active = false;
    rec.exitCode = exitCode;
    label.textContent = cli + " · " + basename(cwd) + " ✓";
    tab.style.opacity = "0.6";
    try { window.chatoss.notifications.send({ title: "Session ended", body: cli + " session finished (exit " + exitCode + ")" }); } catch (e) {}
  });

  tab.onclick = (e) => {
    if (e.target === close) return;
    switchTab(id);
  };
  close.onclick = (e) => { e.stopPropagation(); closeSession(id); };

  ensureEmptyHint();
  switchTab(id);
  state.activeSessionId = id;
  saveState();
  renderSessionInfo();
  fitVisible();
}
function switchTab(id) {
  state.activeSessionId = id;
  saveState();
  for (const [sid, rec] of sessions) {
    const on = sid === id;
    rec.tabEl.classList.toggle("active", on);
    rec.paneEl.style.display = on ? "" : "none";
  }
  renderSessionInfo();
  fitVisible();
}
async function closeSession(id) {
  const rec = sessions.get(id);
  if (!rec) return;
  try { window.chatoss.terminal.kill(id); } catch (e) {}
  if (rec.dispose) { try { rec.dispose(); } catch (e) {} }
  rec.paneEl.remove();
  rec.tabEl.remove();
  sessions.delete(id);
  if (state.activeSessionId === id) {
    const next = sessions.size ? sessions.keys().next().value : null;
    state.activeSessionId = next;
    if (next) switchTab(next);
  }
  saveState();
  ensureEmptyHint();
  renderSessionInfo();
}
function fitVisible() {
  const id = state.activeSessionId;
  if (!id) return;
  const rec = sessions.get(id);
  if (!rec || !rec.active) return;
  const w = rec.paneEl.clientWidth || el.termHost.clientWidth || 600;
  const h = rec.paneEl.clientHeight || el.termHost.clientHeight || 400;
  const cols = Math.max(20, Math.floor(w / 8));
  const rows = Math.max(6, Math.floor(h / 16));
  try { window.chatoss.terminal.resize(id, cols, rows); } catch (e) {}
}
function renderSessionInfo() {
  const rec = state.activeSessionId ? sessions.get(state.activeSessionId) : null;
  const c = activeConversation();
  let bits = [];
  if (c) bits.push("Conversation: " + c.name);
  if (rec) bits.push("Session: " + rec.cli + " @ " + rec.cwd + (rec.active ? "" : " (exited" + (rec.exitCode != null ? " " + rec.exitCode : "") + ")"));
  el.sessionInfo.textContent = bits.join("  ·  ");
}

// ---------- Manual session form ----------
async function startManualSession() {
  const cli = el.manualCli.value || "codex";
  let cwd = el.manualCwd.value.trim();
  if (!cwd) {
    const p = getProject(state.activeProjectId);
    cwd = p ? p.folderPath : "";
  }
  if (!cwd) { window.alert("Enter a working directory or select a project."); return; }
  const session = await window.chatoss.terminal.spawn(cli, { args: [], cwd, cols: 80, rows: 24 });
  if (!session || !session.id) { window.alert("Terminal permission denied for spawn."); return; }
  el.manualCwd.value = "";
  registerSession(session.id, cli, cwd);
}

// ---------- Init ----------
async function init() {
  // restore state
  try {
    const saved = await window.chatoss.scopedData.get(STORE_KEY);
    if (saved) state = Object.assign({ projects: [], activeProjectId: null, activeConversationId: null, activeSessionId: null }, saved);
  } catch (e) { console.warn("restore state", e); }

  // load models
  try {
    models = await window.chatoss.chat.listModels();
    defaultModelId = await window.chatoss.chat.getDefaultModel();
  } catch (e) { console.warn("listModels", e); models = []; defaultModelId = null; }

  // wire model picker change
  el.modelPicker.addEventListener("change", () => {
    const c = activeConversation();
    if (c) { c.modelId = el.modelPicker.value; saveState(); }
    renderEffortPicker();
  });
  el.effortPicker.addEventListener("change", () => {
    const c = activeConversation();
    if (c) { c.effort = selectedEffort(); saveState(); }
  });

  // wire buttons
  el.newProjectBtn.addEventListener("click", newProject);
  el.attachBoardBtn.addEventListener("click", attachBoard);
  el.chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (running) { if (abortController) abortController.abort(); return; }
    sendMessage();
  });
  el.manualForm.addEventListener("submit", (e) => { e.preventDefault(); startManualSession(); });

  // resize
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(fitVisible, 120);
  });

  // initial render
  renderProjects();
  renderChat();
  renderSessionInfo();
  ensureEmptyHint();

  // hide loading
  el.loading.classList.add("hidden");
}

init().catch((e) => {
  console.error(e);
  el.loading.textContent = "Failed to start: " + (e && e.message ? e.message : String(e));
});