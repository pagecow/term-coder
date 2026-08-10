// Term Code — AI agent orchestrator with live terminal squares.
// Spawns ollama/codex/claude sub-agents — ALWAYS asks the user first (spawn modal).
// Loaded by index.html as <script type="module" src="app.js"></script>.

const STORE_KEY = "term-code.state";
const SETTINGS_KEY = "term-code.settings";
const FALLBACK_MODELS = ["qwen3:30b", "qwen3:14b", "llama3.2:latest", "mistral:latest"];
const DETECT_TTL_MS = 60 * 1000;

// ---------- State ----------
let state = {
  projects: [],
  activeProjectId: null,
  activeConversationId: null,
  activeSessionId: null,
};
let settings = {
  cliDefault: "ask",       // 'ask' | 'ollama' | 'codex' | 'claude'
  modelDefault: "ask",     // 'ask' | <ollama model name>
  cwdDefault: "",
  detected: { codex: false, claude: false, ollama: false, models: [], denied: false },
};
let models = [];
let defaultModelId = null;
let running = false;
let abortController = null;

// Auto-detection cache (refreshed every ~60s)
let detection = { codex: false, claude: false, ollama: false, models: [], scannedAt: 0, denied: false };

// Sessions registry: sessionId -> { id, cmd, args, cwd, label, active, exitCode?, squareEl, mountEl, dispose?, expanded }
const sessions = new Map();

// Promise + resolver for the spawn modal wait (set while the modal is open).
// The orchestrator's start_cli_session tool awaits this; manual start too.
let spawnPromise = null;
let spawnResolve = null;

// ---------- DOM refs ----------
const $ = (id) => document.getElementById(id);
const el = {
  loading: $("app-loading"),
  // top bar
  settingsBtn: $("settings-btn"),
  // left
  newProjectBtn: $("new-project-btn"),
  projectList: $("project-list"),
  // middle
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
  sessionInfo: $("session-info"),
  // right
  newSessionBtn: $("new-session-btn"),
  manualForm: $("manual-session-form"),
  manualCli: $("manual-cli"),
  manualCwd: $("manual-cwd"),
  termTabs: $("term-tabs"),
  termHost: $("term-host"),
  // spawn modal
  spawnModal: $("spawn-modal"),
  spawnCli: $("spawn-cli"),
  spawnModelRow: $("spawn-model-row"),
  spawnModel: $("spawn-model"),
  spawnPrompt: $("spawn-prompt"),
  spawnCwd: $("spawn-cwd"),
  spawnRemember: $("spawn-remember"),
  spawnStatus: $("spawn-status"),
  spawnStart: $("spawn-start"),
  spawnCancel: $("spawn-cancel"),
  spawnCancelX: $("spawn-cancel-x"),
  // settings
  settingsPanel: $("settings-panel"),
  setCli: $("set-cli"),
  setModelRow: $("set-model-row"),
  setModel: $("set-model"),
  setCwd: $("set-cwd"),
  settingsSave: $("settings-save"),
  settingsCancel: $("settings-cancel"),
  settingsCloseX: $("settings-close-x"),
  detectedList: $("detected-list"),
  rescanBtn: $("rescan-btn"),
  // board picker
  boardPicker: $("board-picker"),
  boardPickerList: $("board-picker-list"),
  boardPickerX: $("board-picker-x"),
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
// Persistence is async — fire-and-forget but never leave an unhandled rejection.
function saveState() {
  try { window.chatoss.scopedData.set(STORE_KEY, state).catch((e) => console.warn("saveState", e)); }
  catch (e) { console.warn("saveState", e); }
}
function saveSettings() {
  try { window.chatoss.scopedData.set(SETTINGS_KEY, settings).catch((e) => console.warn("saveSettings", e)); }
  catch (e) { console.warn("saveSettings", e); }
}
function getProject(id) { return state.projects.find((p) => p.id === id) || null; }
function getConversation(pid, cid) {
  const p = getProject(pid);
  return p ? p.conversations.find((c) => c.id === cid) || null : null;
}
function activeConversation() { return getConversation(state.activeProjectId, state.activeConversationId); }
function defaultCwd() {
  // Best-effort cwd for terminal.exec probes: active project folder, then settings, then '/'.
  const p = getProject(state.activeProjectId);
  if (p && p.folderPath) return p.folderPath;
  if (settings.cwdDefault) return settings.cwdDefault;
  return "/";
}
function setStatus(t) { el.chatStatus.textContent = t || ""; }

// Normalize a tool call delivered by runTurn's onToolCall. The engine may pass
// { name, arguments: "…json…" } (OpenAI-style) or { name, args: {…} } — handle both.
function normalizeToolCall(call) {
  call = call || {};
  const name = call.name || call.function?.name || "unknown";
  let args = {};
  if (call.args && typeof call.args === "object" && !Array.isArray(call.args)) {
    args = call.args;
  } else if (typeof call.arguments === "string") {
    try { args = JSON.parse(call.arguments); } catch (e) { args = {}; }
  } else if (call.arguments && typeof call.arguments === "object") {
    args = call.arguments;
  }
  return { name, args };
}

// ---------- Auto-detection (cached ~60s) ----------
function parseOllamaModels(out) {
  const found = [];
  const lines = String(out || "").split("\n");
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (/^NAME\b/i.test(t)) continue;
    const first = t.split(/\s+/)[0];
    if (first && first !== "NAME") found.push(first);
  }
  return [...new Set(found)];
}

async function detectTools(force = false) {
  const now = Date.now();
  if (!force && detection.scannedAt && now - detection.scannedAt < DETECT_TTL_MS) {
    return detection;
  }
  const fresh = { codex: false, claude: false, ollama: false, models: [], scannedAt: now, denied: false };
  const cwd = defaultCwd();

  const probe = async (cmd) => {
    try {
      const r = await window.chatoss.terminal.exec(cmd, { cwd });
      if (r === null) { fresh.denied = true; return null; }
      return r;
    } catch (e) {
      console.warn("probe failed:", cmd, e);
      return null;
    }
  };

  const codexR = await probe("which codex");
  if (codexR !== null) fresh.codex = codexR.exitCode === 0 && String(codexR.output || "").trim().length > 0;
  const claudeR = await probe("which claude");
  if (claudeR !== null) fresh.claude = claudeR.exitCode === 0 && String(claudeR.output || "").trim().length > 0;
  const ollamaR = await probe("which ollama");
  if (ollamaR !== null) fresh.ollama = ollamaR.exitCode === 0 && String(ollamaR.output || "").trim().length > 0;

  if (fresh.ollama) {
    const listR = await probe("ollama list");
    if (listR !== null && listR.exitCode === 0) {
      fresh.models = parseOllamaModels(listR.output);
    }
    if (!fresh.models.length) fresh.models = FALLBACK_MODELS.slice();
  }

  detection = fresh;
  settings.detected = {
    codex: detection.codex,
    claude: detection.claude,
    ollama: detection.ollama,
    models: detection.models.slice(),
    denied: detection.denied,
  };
  saveSettings();
  renderDetectedList();
  return detection;
}

// ---------- ORCHESTRATOR TOOLS (JSON schema for runTurn) ----------
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
      },
    },
  },
  {
    type: "function",
    function: {
      name: "start_cli_session",
      description: "Ask the user to start a new sub-agent CLI session (ollama run / codex / claude) in a working directory. The USER decides the CLI and model in a confirmation dialog — call this when you need an agent shell to work in, then wait for the returned session id.",
      parameters: {
        type: "object",
        properties: {
          cwd: { type: "string", description: "Working directory for the session (a project path or a worktree path)." },
          taskPrompt: { type: "string", description: "Optional initial task to send to the CLI's stdin after it starts." },
        },
        required: ["cwd"],
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
      description: "Update a Kanban card's title/description or mark it done. When done is true, the card is completed, moved to the Done column, and the user gets a notification.",
      parameters: {
        type: "object",
        properties: {
          boardId: { type: "string" },
          cardId: { type: "string" },
          done: { type: "boolean", description: "Mark the card complete (moves it to Done + notification)." },
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

// ---------- Tool handlers (async, always return a string) ----------
async function toolHandler(name, args) {
  args = args || {};
  try {
    switch (name) {
      case "create_worktree": {
        const p = getProject(args.projectId);
        if (!p) return "Error: project not found";
        const branch = args.branchName || "worktree-" + Date.now();
        const wtPath = p.folderPath.replace(/\/+$/, "") + "/.chatoss/worktrees/" + branch;
        const r = await window.chatoss.terminal.exec(
          `git worktree add "${wtPath}" -b "${branch}"`,
          { cwd: p.folderPath }
        );
        if (r === null) return "Error: terminal permission denied (approve git to continue)";
        if (r.exitCode !== 0) return "git worktree failed (exit " + r.exitCode + "):\n" + r.output;
        return wtPath;
      }
      case "start_cli_session": {
        // The USER decides the CLI + model in the spawn modal. The tool WAITS
        // on a promise that resolves when the user hits Start or Cancel.
        const choice = await openSpawnModal({
          source: "tool",
          cwd: args.cwd || "",
          prompt: args.taskPrompt || "",
        });
        if (!choice) {
          return "Cancelled by user — do not start the session; ask the user how to proceed or stop.";
        }
        if (choice.session && choice.session.id) {
          return "session " + choice.session.id + " started: " + choice.session.label + " in " + choice.session.cwd;
        }
        return "Error: session did not start";
      }
      case "send_to_session": {
        const s = sessions.get(args.sessionId);
        if (!s) return "Error: session not found";
        try {
          await window.chatoss.terminal.write(args.sessionId, args.text + "\n");
        } catch (e) {
          return "Error: " + (e && e.message ? e.message : String(e));
        }
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
        try {
          const list = await window.chatoss.boards.list();
          return JSON.stringify(list || []);
        } catch (e) {
          return "Error: " + (e && e.message ? e.message : String(e)) + " (mount the Kanban section first)";
        }
      }
      case "get_board": {
        try {
          const b = await window.chatoss.boards.get(args.boardId);
          return JSON.stringify(b);
        } catch (e) {
          return "Error: " + (e && e.message ? e.message : String(e));
        }
      }
      case "move_card": {
        try {
          await window.chatoss.boards.moveCard(args.boardId, args.cardId, args.toColumnId);
          return "ok";
        } catch (e) {
          return "Error: " + (e && e.message ? e.message : String(e));
        }
      }
      case "update_card": {
        const patch = {};
        if (args.done !== undefined && args.done !== null) patch.done = args.done;
        if (args.title !== undefined && args.title !== null) patch.title = args.title;
        if (args.description !== undefined && args.description !== null) patch.description = args.description;
        try {
          await window.chatoss.boards.updateCard(args.boardId, args.cardId, patch);
        } catch (e) {
          return "Error: " + (e && e.message ? e.message : String(e));
        }
        if (patch.done === true) {
          let body = "Card marked complete.";
          try {
            const b = await window.chatoss.boards.get(args.boardId);
            const card = b && b.cards ? b.cards.find((c) => c.id === args.cardId) : null;
            if (card && card.title) body = card.title;
          } catch (e) { /* non-fatal */ }
          try { await window.chatoss.notifications.send({ title: "Task complete", body }); } catch (e) { /* non-fatal */ }
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

// ---------- Spawn modal (the heart: ask the user every time) ----------
function buildCliOptions() {
  const opts = [];
  const push = (value, label, detected) => {
    opts.push({ value, label: detected ? label : label + " (not detected)" });
  };
  push("ollama", "ollama run <model>", detection.ollama);
  push("codex", "codex", detection.codex);
  push("claude", "claude", detection.claude);
  return opts;
}

function populateSpawnModelSelect(selected) {
  el.spawnModel.innerHTML = "";
  const all = (detection.models && detection.models.length ? detection.models : FALLBACK_MODELS);
  for (const m of all) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    el.spawnModel.appendChild(opt);
  }
  if (selected && all.includes(selected)) el.spawnModel.value = selected;
  else if (all.length) el.spawnModel.value = all[0];
}

function syncSpawnModelRow() {
  const isOllama = el.spawnCli.value === "ollama";
  el.spawnModelRow.classList.toggle("hidden", !isOllama);
  el.spawnModel.disabled = !isOllama;
}

/**
 * Open the spawn modal and return a Promise that resolves with
 *   { cli, model?, cwd, prompt, session }  on Start, or
 *   null                                   on Cancel.
 * If the modal is already open (e.g. the orchestrator called the tool twice),
 * the same promise is returned — one dialog, one choice, all waiters resolve.
 */
function openSpawnModal(opts) {
  // One dialog at a time: if the modal is already open (e.g. the orchestrator
  // called the tool twice), every waiter shares the same promise.
  if (spawnPromise) return spawnPromise;
  opts = opts || {};
  el.spawnStatus.textContent = "";
  el.spawnStart.disabled = false;

  // Create the wait promise FIRST so callers (the orchestrator tool) start
  // awaiting it immediately, then populate the UI asynchronously.
  let resolveFn;
  const promise = new Promise((resolve) => { resolveFn = resolve; });
  spawnPromise = promise;
  spawnResolve = resolveFn;

  (async () => {
    try {
      // Fresh-ish detection (cached 60s), so options only show what's installed.
      await detectTools(false);

      // CLI options
      el.spawnCli.innerHTML = "";
      const cliOpts = buildCliOptions();
      for (const o of cliOpts) {
        const opt = document.createElement("option");
        opt.value = o.value;
        opt.textContent = o.label;
        el.spawnCli.appendChild(opt);
      }
      let preselectCli = (opts.cliHint || "").trim() || null;
      if (!preselectCli && settings.cliDefault && settings.cliDefault !== "ask" && cliOpts.some((o) => o.value === settings.cliDefault)) {
        preselectCli = settings.cliDefault;
      }
      if (!preselectCli) {
        if (detection.ollama) preselectCli = "ollama";        // ollama is the default when installed
        else if (detection.codex) preselectCli = "codex";
        else if (detection.claude) preselectCli = "claude";
        else preselectCli = "ollama";                          // nothing detected — still let the user try
      }
      el.spawnCli.value = preselectCli;
      populateSpawnModelSelect(settings.modelDefault !== "ask" ? settings.modelDefault : null);
      syncSpawnModelRow();

      // cwd: tool call > settings default > active project folder > manual form
      let cwd = (opts.cwd || "").trim();
      if (!cwd) cwd = (settings.cwdDefault || "").trim();
      if (!cwd && el.manualCwd.value.trim()) cwd = el.manualCwd.value.trim();
      if (!cwd) {
        const p = getProject(state.activeProjectId);
        cwd = p ? p.folderPath : "";
      }
      el.spawnCwd.value = cwd;

      // prompt: tool call, else empty
      el.spawnPrompt.value = (opts.prompt || "").trim();
      el.spawnRemember.checked = false;

      el.spawnModal.classList.remove("hidden");
    } catch (e) {
      // Never hang the waiters — degrade to a cancelled dialog.
      console.warn("openSpawnModal", e);
      closeSpawnModal(null);
    }
  })();

  return promise;
}

function closeSpawnModal(choice) {
  el.spawnModal.classList.add("hidden");
  const r = spawnResolve;
  spawnResolve = null;
  spawnPromise = null;
  if (r) r(choice);
}
async function onSpawnStart() {
  if (!spawnResolve) return;
  const cli = el.spawnCli.value;
  const model = cli === "ollama" ? el.spawnModel.value : null;
  const cwd = el.spawnCwd.value.trim();
  const prompt = el.spawnPrompt.value.trim();
  const remember = el.spawnRemember.checked;

  if (!cli) { el.spawnStatus.textContent = "Pick a CLI."; return; }
  if (cli === "ollama" && !model) { el.spawnStatus.textContent = "Pick an ollama model."; return; }
  if (!cwd) { el.spawnStatus.textContent = "Enter a working directory."; return; }

  if (remember) {
    settings.cliDefault = cli;
    settings.modelDefault = cli === "ollama" ? model : "ask";
    settings.cwdDefault = cwd;
    saveSettings();
  }

  el.spawnStart.disabled = true;
  el.spawnStatus.textContent = "Starting…";
  try {
    const session = await spawnChosen({ cli, model, cwd, prompt });
    if (!session) {
      el.spawnStatus.textContent = "Terminal permission denied for “" + cli + "”. Approve it in the system prompt and try again, or cancel.";
      el.spawnStart.disabled = false;
      return; // keep the modal open so the user can retry/cancel
    }
    closeSpawnModal({ cli, model, cwd, prompt, session });
  } catch (e) {
    el.spawnStatus.textContent = "Error: " + (e && e.message ? e.message : String(e));
    el.spawnStart.disabled = false;
  }
}

function onSpawnCancel() {
  closeSpawnModal(null);
}

async function spawnChosen(choice) {
  let cmd, args;
  if (choice.cli === "ollama") {
    cmd = "ollama";
    args = ["run", choice.model];
  } else {
    cmd = choice.cli;   // codex | claude
    args = [];
  }
  const session = await window.chatoss.terminal.spawn(cmd, { args, cwd: choice.cwd, cols: 90, rows: 22 });
  if (!session || !session.id) return null;
  const label = choice.cli === "ollama"
    ? "ollama · " + choice.model
    : choice.cli + " · " + basename(choice.cwd);
  registerSession(session.id, cmd, args, choice.cwd, label);
  if (choice.prompt) {
    try { await window.chatoss.terminal.write(session.id, choice.prompt + "\n"); } catch (e) { /* non-fatal */ }
  }
  return { id: session.id, label, cwd: choice.cwd };
}

// ---------- Settings panel ----------
function renderDetectedList() {
  if (!el.detectedList) return;
  const d = settings.detected || { codex: false, claude: false, ollama: false, models: [], denied: false };
  el.detectedList.innerHTML = "";
  const row = (name, ok) => {
    const div = document.createElement("div");
    div.className = "detected-item";
    const mark = document.createElement("span");
    mark.className = ok ? "ok" : "no";
    mark.textContent = ok ? "✓" : "✗";
    div.appendChild(mark);
    div.appendChild(document.createTextNode(" " + name + (ok ? " installed" : " not found")));
    el.detectedList.appendChild(div);
  };
  row("codex", !!d.codex);
  row("claude", !!d.claude);
  row("ollama", !!d.ollama);
  if (d.ollama) {
    const div = document.createElement("div");
    div.className = "detected-item";
    div.textContent = "ollama models (" + (d.models || []).length + "): " + ((d.models || []).join(", ") || "(none)");
    el.detectedList.appendChild(div);
  }
  if (d.denied) {
    const div = document.createElement("div");
    div.className = "detected-item";
    div.style.color = "var(--danger)";
    div.textContent = "Terminal permission needed for auto-detection.";
    el.detectedList.appendChild(div);
  }
}

function openSettings() {
  el.setCli.value = settings.cliDefault || "ask";
  populateSettingsModelSelect(settings.modelDefault !== "ask" ? settings.modelDefault : null);
  syncSettingsModelRow();
  el.setCwd.value = settings.cwdDefault || "";
  renderDetectedList();
  el.settingsPanel.classList.remove("hidden");
}

function populateSettingsModelSelect(selected) {
  el.setModel.innerHTML = "";
  const ask = document.createElement("option");
  ask.value = "ask";
  ask.textContent = "Ask me every time";
  el.setModel.appendChild(ask);
  const all = (settings.detected && settings.detected.models && settings.detected.models.length
    ? settings.detected.models : detection.models && detection.models.length
      ? detection.models : FALLBACK_MODELS);
  for (const m of all) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    el.setModel.appendChild(opt);
  }
  if (selected && all.includes(selected)) el.setModel.value = selected;
  else el.setModel.value = "ask";
}

function syncSettingsModelRow() {
  const isOllama = el.setCli.value === "ollama";
  el.setModelRow.classList.toggle("hidden", !isOllama);
  el.setModel.disabled = !isOllama;
}

function saveSettingsFromPanel() {
  settings.cliDefault = el.setCli.value;
  settings.modelDefault = el.setModel.value || "ask";
  settings.cwdDefault = el.setCwd.value.trim();
  saveSettings();
  el.settingsPanel.classList.add("hidden");
}

// ---------- Board picker ----------
async function openBoardPicker() {
  const c = activeConversation();
  if (!c) { setStatus("Select a conversation first."); return; }
  el.boardPickerList.innerHTML = "<div class='detected-scanning'>Loading boards…</div>";
  el.boardPicker.classList.remove("hidden");
  try {
    const list = await window.chatoss.boards.list();
    el.boardPickerList.innerHTML = "";
    if (!list || !list.length) {
      el.boardPickerList.innerHTML = "<div class='settings-hint'>No Kanban boards available. Mount the Kanban section first.</div>";
      return;
    }
    for (const b of list) {
      const btn = document.createElement("button");
      btn.className = "btn board-pick-btn";
      btn.type = "button";
      btn.textContent = b.name;
      btn.style.width = "100%";
      btn.style.textAlign = "left";
      btn.onclick = () => {
        c.boardId = b.id;
        saveState();
        el.boardPicker.classList.add("hidden");
        renderChat();
      };
      el.boardPickerList.appendChild(btn);
    }
  } catch (e) {
    el.boardPickerList.innerHTML = "<div class='settings-hint'>Boards error: " + esc(e && e.message ? e.message : String(e)) + "</div>";
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
    empty.textContent = "No projects yet. Click “+ Project”.";
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
    renameBtn.onclick = (e) => { e.stopPropagation(); renameProject(p, nameText); };

    const delBtn = document.createElement("button");
    delBtn.className = "btn-icon btn-danger";
    delBtn.title = "Delete";
    delBtn.textContent = "✕";
    delBtn.onclick = (e) => { e.stopPropagation(); confirmDelete(() => deleteProject(p), delBtn); };

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
      cdel.onclick = (e) => { e.stopPropagation(); confirmDelete(() => deleteConversation(p, c), cdel); };
      ci.appendChild(cdel);
      ci.onclick = () => selectConversation(p.id, c.id);
      convList.appendChild(ci);
    }

    if (p.id === state.activeProjectId) {
      const add = document.createElement("div");
      add.className = "conversation-item conv-new";
      add.textContent = "+ New conversation";
      add.onclick = () => newConversation(p);
      convList.appendChild(add);
    }

    item.appendChild(convList);
    name.onclick = () => selectProject(p.id);
    el.projectList.appendChild(item);
  }
}

// Inline rename (no window.prompt — blocked in the sandbox)
function renameProject(p, nameText) {
  const input = document.createElement("input");
  input.className = "form-input";
  input.value = p.name;
  input.style.padding = "2px 6px";
  input.style.fontSize = "12px";
  nameText.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (v) { p.name = v; saveState(); }
    renderProjects();
    renderSessionInfo();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    if (e.key === "Escape") { done = true; renderProjects(); }
  });
  input.addEventListener("blur", commit);
}

// Two-step confirm (no window.confirm — blocked in the sandbox)
function confirmDelete(fn, btn) {
  if (btn.dataset.armed === "1") { fn(); return; }
  btn.dataset.armed = "1";
  const orig = btn.textContent;
  btn.textContent = "✓?";
  btn.style.opacity = "1";
  setTimeout(() => {
    btn.dataset.armed = "0";
    btn.textContent = orig;
  }, 2500);
}

function selectProject(pid) {
  state.activeProjectId = pid;
  const p = getProject(pid);
  const cur = getConversation(pid, state.activeConversationId);
  if (!cur) state.activeConversationId = p && p.conversations.length ? p.conversations[0].id : null;
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
  try {
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
  } catch (e) {
    setStatus("Project error: " + (e && e.message ? e.message : String(e)));
  }
}
function deleteProject(p) {
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
  const c = { id: uuid(), name: "Conversation " + (p.conversations.length + 1), messages: [], modelId: null, effort: null, boardId: null };
  p.conversations.push(c);
  state.activeProjectId = p.id;
  state.activeConversationId = c.id;
  saveState();
  renderProjects();
  renderChat();
}
function deleteConversation(p, c) {
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
  el.chatInput.placeholder = "Ask the orchestrator to build something… (Enter to send, ⇧Enter for newline)";
  el.attachedBoardName.textContent = c.boardId ? "Board attached" : "No board";
  renderModelPicker();
  renderEffortPicker();

  for (const m of c.messages) {
    renderMessage(m);
  }
  scrollChatBottom();
}
function renderMessage(m) {
  if (m.thinking) {
    const th = document.createElement("div");
    th.className = "msg-thinking";
    th.textContent = m.thinking;
    el.chatLog.appendChild(th);
  }
  const row = document.createElement("div");
  row.className = "msg " + (m.role || "system");
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

// Display-only renders — no state mutation, no saveState here.
function renderModelPicker() {
  if (!models.length) { el.modelPicker.innerHTML = ""; return; }
  const c = activeConversation();
  const cur = c && c.modelId ? c.modelId : null;
  let preselect = cur;
  if (!preselect && defaultModelId && models.some((m) => m.id === defaultModelId && m.available)) preselect = defaultModelId;
  if (!preselect) { const first = models.find((m) => m.available) || models[0]; preselect = first ? first.id : null; }

  el.modelPicker.innerHTML = "";
  for (const m of models) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.name + " (" + m.source + ")";
    if (!m.available) { opt.disabled = true; opt.textContent += " — unavailable"; }
    el.modelPicker.appendChild(opt);
  }
  if (preselect) el.modelPicker.value = preselect;
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
      opt.value = lvl;
      opt.textContent = lvl;
      el.effortPicker.appendChild(opt);
    }
    let eff = c && c.effort ? c.effort : null;
    if (!eff || !m.thinkLevels.includes(eff)) eff = m.thinkDefault || m.thinkLevels[0];
    el.effortPicker.value = eff;
  } else {
    el.effortPicker.classList.add("hidden");
  }
}
function selectedModel() { return el.modelPicker.value; }
function selectedEffort() {
  if (el.effortPicker.classList.contains("hidden")) return null;
  return el.effortPicker.value || null;
}

// ---------- Build system prompt ----------
async function buildSystemPrompt() {
  const c = activeConversation();
  const p = getProject(state.activeProjectId);
  let sys = [
    "You are Term Code, an autonomous software-building orchestrator (like a coding agent).",
    "You build software by spawning sub-agent CLI sessions (ollama run <model>, codex, or claude) inside git worktrees, reading Kanban board tasks, and marking cards done when work is complete.",
    "",
    "IMPORTANT: every sub-agent session requires the USER's approval. When you call start_cli_session, a confirmation dialog appears and the user chooses the CLI and model — you just supply the working directory and a task prompt, then wait for the returned session id.",
    "",
    "Workflow:",
    "1. Inspect the project with list_project_files / get_current_git_branch.",
    "2. Create an isolated git worktree with create_worktree for the work.",
    "3. Call start_cli_session with the worktree path and a task prompt. The user approves the session in the dialog.",
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
function setRunning(r) {
  running = r;
  el.sendBtn.textContent = r ? "Stop" : "Send";
  el.sendBtn.classList.toggle("is-running", r);
  el.chatInput.disabled = r;
}

async function sendMessage() {
  const c = activeConversation();
  if (!c) { setStatus("Select or create a conversation first."); return; }
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

  // Snapshot the picker choices onto the conversation so history replays
  // with the same model/effort that was actually used.
  const modelId = selectedModel() || defaultModelId;
  const modelInfo = models.find((m) => m.id === modelId);
  const canThink = !!(modelInfo && modelInfo.capabilities && modelInfo.capabilities.includes("reasoning"));
  const effort = selectedEffort();
  if (modelId) { c.modelId = modelId; }
  if (canThink && effort) { c.effort = effort; } else { c.effort = null; }
  saveState();

  // Live assistant row — MUST be in the DOM before streaming so tokens are
  // visible and tool rows can be inserted before it.
  const liveRow = document.createElement("div");
  liveRow.className = "msg assistant";
  const liveBody = document.createElement("div");
  liveRow.appendChild(liveBody);
  el.chatLog.appendChild(liveRow);
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
        const { name, args } = normalizeToolCall(call);
        liveToolCalls.push({ name, args });
        // Render the tool row before the live assistant row, then append the result.
        const tr = document.createElement("div");
        tr.className = "msg tool";
        tr.textContent = "→ " + name + "(" + JSON.stringify(args) + ")";
        el.chatLog.insertBefore(tr, liveRow);
        scrollChatBottom();
        try {
          const res = await toolHandler(name, args);
          tr.textContent += "\n" + String(res);
          return res; // string result feeds back into the engine's tool loop
        } catch (e) {
          const err = "Error: " + (e && e.message ? e.message : String(e));
          tr.textContent += "\n" + err;
          return err;
        }
      },
      think: canThink,                       // only thinking-capable models get think:true
      thinkLevel: canThink && effort ? effort : undefined,
      signal: abortController.signal,
    });

    const content = result && result.content ? result.content : accContent;
    const thinking = result && result.thinking ? result.thinking : accThink;

    if (result && result.aborted) {
      setStatus("Stopped");
    } else {
      setStatus("");
    }

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

// ---------- Right column: terminal squares ----------
function ensureEmptyHint() {
  let hint = el.termHost.querySelector(".term-empty");
  if (!hint) {
    hint = document.createElement("div");
    hint.className = "term-empty";
    hint.textContent = "No active sessions. Click “+ New session” or ask the orchestrator to spawn one.";
    el.termHost.appendChild(hint);
  }
  hint.style.display = sessions.size ? "none" : "";
}

function renderTabs() {
  el.termTabs.innerHTML = "";
  if (!sessions.size) return;
  for (const rec of sessions.values()) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "term-tab" + (rec.id === state.activeSessionId ? " active" : "") + (rec.active ? "" : " exited");
    tab.textContent = rec.label;
    tab.title = rec.label + " @ " + rec.cwd;
    tab.onclick = () => selectSession(rec.id);
    el.termTabs.appendChild(tab);
  }
}

function selectSession(id) {
  const rec = sessions.get(id);
  if (!rec) return;
  state.activeSessionId = id;
  saveState();
  renderTabs();
  rec.squareEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
  renderSessionInfo();
}

function registerSession(id, cmd, args, cwd, label) {
  // square
  const square = document.createElement("div");
  square.className = "term-square";

  const header = document.createElement("div");
  header.className = "term-square-header";
  const dot = document.createElement("span");
  dot.className = "term-status-dot";
  dot.title = "Running";
  const lab = document.createElement("span");
  lab.className = "term-label";
  lab.textContent = label;
  const expandBtn = document.createElement("button");
  expandBtn.className = "term-head-btn";
  expandBtn.type = "button";
  expandBtn.textContent = "⤢";
  expandBtn.title = "Expand / collapse";
  const closeBtn = document.createElement("button");
  closeBtn.className = "term-head-btn term-close-btn";
  closeBtn.type = "button";
  closeBtn.textContent = "✕";
  closeBtn.title = "Close session";

  header.appendChild(dot);
  header.appendChild(lab);
  header.appendChild(expandBtn);
  header.appendChild(closeBtn);

  const mountEl = document.createElement("div");
  mountEl.className = "term-mount";

  square.appendChild(header);
  square.appendChild(mountEl);
  el.termHost.appendChild(square);

  const rec = { id, cmd, args, cwd, label, active: true, exitCode: null, squareEl: square, mountEl, dispose: null, expanded: false };
  sessions.set(id, rec);

  // mount the xterm widget into the square (session is the spawn() result { id })
  try {
    const handle = window.chatoss.terminal.mount(mountEl, { id }, { fontSize: 12 });
    rec.dispose = handle && handle.dispose ? handle.dispose : null;
  } catch (e) {
    console.warn("terminal.mount failed:", e);
  }

  // stream + exit
  try { window.chatoss.terminal.onData(id, () => {}); } catch (e) { /* optional */ }
  window.chatoss.terminal.onExit(id, (exitCode) => {
    rec.active = false;
    rec.exitCode = exitCode;
    dot.classList.add("exited");
    dot.title = "Exited (" + (exitCode == null ? "killed" : exitCode) + ")";
    lab.textContent = label + " ✓ (" + (exitCode == null ? "exited" : exitCode) + ")";
    renderTabs();
    try {
      window.chatoss.notifications.send({ title: "Session ended", body: label + " finished" });
    } catch (e) { /* non-fatal */ }
    renderSessionInfo();
  });

  expandBtn.onclick = () => toggleExpand(id);
  closeBtn.onclick = () => confirmDelete(() => closeSession(id), closeBtn);

  ensureEmptyHint();
  state.activeSessionId = id;
  saveState();
  renderTabs();
  renderSessionInfo();

  // size the PTY to the square and keep it fitted when the column resizes
  requestAnimationFrame(() => fitTerminal(rec));
  try {
    const ro = new ResizeObserver(() => fitTerminal(rec));
    ro.observe(mountEl);
    rec.ro = ro;
  } catch (e) { /* ResizeObserver unavailable — window resize still refits */ }
}

function fitTerminal(rec) {
  if (!rec || !rec.active) return;
  // Skip squares that are not laid out (hidden or zero-size) — avoids
  // resizing the PTY to 20×5 while the app is starting up.
  const w = rec.mountEl.clientWidth;
  const h = rec.mountEl.clientHeight;
  if (!w || !h) return;
  const cols = Math.max(20, Math.floor(w / 7.6));
  const rows = Math.max(5, Math.floor(h / 15.5));
  try { window.chatoss.terminal.resize(rec.id, cols, rows); } catch (e) { /* non-fatal */ }
}

function toggleExpand(id) {
  const rec = sessions.get(id);
  if (!rec) return;
  rec.expanded = !rec.expanded;
  rec.squareEl.classList.toggle("expanded", rec.expanded);
  requestAnimationFrame(() => fitTerminal(rec));
}

async function closeSession(id) {
  const rec = sessions.get(id);
  if (!rec) return;
  try { await window.chatoss.terminal.kill(id); } catch (e) { /* non-fatal */ }
  if (rec.dispose) { try { rec.dispose(); } catch (e) { /* non-fatal */ } }
  if (rec.ro) { try { rec.ro.disconnect(); } catch (e) { /* non-fatal */ } }
  rec.squareEl.remove();
  sessions.delete(id);
  if (state.activeSessionId === id) {
    state.activeSessionId = sessions.size ? sessions.keys().next().value : null;
  }
  saveState();
  ensureEmptyHint();
  renderTabs();
  renderSessionInfo();
}

function renderSessionInfo() {
  const rec = state.activeSessionId ? sessions.get(state.activeSessionId) : null;
  const c = activeConversation();
  let bits = [];
  if (c) bits.push("Conversation: " + c.name);
  if (rec) bits.push("Session: " + rec.label + " @ " + rec.cwd + (rec.active ? "" : " (exited)"));
  el.sessionInfo.textContent = bits.join("  ·  ");
}

// ---------- Init ----------
async function init() {
  // restore state + settings
  try {
    const saved = await window.chatoss.scopedData.get(STORE_KEY);
    if (saved) state = Object.assign({ projects: [], activeProjectId: null, activeConversationId: null, activeSessionId: null }, saved);
  } catch (e) { console.warn("restore state", e); }
  try {
    const savedSettings = await window.chatoss.scopedData.get(SETTINGS_KEY);
    if (savedSettings) settings = Object.assign(settings, savedSettings);
  } catch (e) { console.warn("restore settings", e); }
  detection = {
    codex: !!(settings.detected && settings.detected.codex),
    claude: !!(settings.detected && settings.detected.claude),
    ollama: !!(settings.detected && settings.detected.ollama),
    models: (settings.detected && settings.detected.models) || [],
    scannedAt: 0, // force a fresh scan at startup
    denied: !!(settings.detected && settings.detected.denied),
  };

  // load models
  try {
    models = await window.chatoss.chat.listModels();
    defaultModelId = await window.chatoss.chat.getDefaultModel();
  } catch (e) { console.warn("listModels", e); models = []; defaultModelId = null; }

  // model picker change → persist on the conversation (render never mutates state)
  el.modelPicker.addEventListener("change", () => {
    const c = activeConversation();
    if (c) { c.modelId = el.modelPicker.value; saveState(); }
    renderEffortPicker();
  });
  el.effortPicker.addEventListener("change", () => {
    const c = activeConversation();
    if (c) { c.effort = selectedEffort(); saveState(); }
  });

  // top bar + left column
  el.settingsBtn.addEventListener("click", openSettings);
  el.newProjectBtn.addEventListener("click", newProject);

  // middle column
  el.attachBoardBtn.addEventListener("click", openBoardPicker);
  el.chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (running) { if (abortController) abortController.abort(); return; }
    sendMessage();
  });
  // Enter sends, Shift+Enter newline
  el.chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      el.chatForm.requestSubmit();
    }
  });

  // right column — manual start goes through the SAME spawn modal
  el.newSessionBtn.addEventListener("click", () => {
    openSpawnModal({ source: "manual" }).then((choice) => {
      if (!choice) return; // cancelled
      // session already started + mounted inside onSpawnStart; nothing else to do
    });
  });
  el.manualForm.addEventListener("submit", (e) => {
    e.preventDefault();
    openSpawnModal({ source: "manual", cliHint: el.manualCli.value, cwd: el.manualCwd.value.trim() });
  });

  // spawn modal
  el.spawnCli.addEventListener("change", syncSpawnModelRow);
  el.spawnStart.addEventListener("click", onSpawnStart);
  el.spawnCancel.addEventListener("click", onSpawnCancel);
  el.spawnCancelX.addEventListener("click", onSpawnCancel);
  el.spawnPrompt.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSpawnStart(); }
  });

  // settings panel
  el.setCli.addEventListener("change", syncSettingsModelRow);
  el.settingsSave.addEventListener("click", saveSettingsFromPanel);
  el.settingsCancel.addEventListener("click", () => el.settingsPanel.classList.add("hidden"));
  el.settingsCloseX.addEventListener("click", () => el.settingsPanel.classList.add("hidden"));
  el.rescanBtn.addEventListener("click", async () => {
    el.detectedList.innerHTML = "<div class='detected-scanning'>Scanning…</div>";
    await detectTools(true);
    renderDetectedList();
  });

  // board picker
  el.boardPickerX.addEventListener("click", () => el.boardPicker.classList.add("hidden"));

  // backdrop click closes modals
  for (const [modal, closer] of [
    [el.spawnModal, onSpawnCancel],
    [el.settingsPanel, () => el.settingsPanel.classList.add("hidden")],
    [el.boardPicker, () => el.boardPicker.classList.add("hidden")],
  ]) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal || (e.target.classList && e.target.classList.contains("modal-backdrop"))) closer();
    });
  }

  // Esc closes any open modal (spawn first — its wait must resolve)
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!el.spawnModal.classList.contains("hidden")) onSpawnCancel();
    else if (!el.settingsPanel.classList.contains("hidden")) el.settingsPanel.classList.add("hidden");
    else if (!el.boardPicker.classList.contains("hidden")) el.boardPicker.classList.add("hidden");
  });

  // window resize → refit visible terminals
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      for (const rec of sessions.values()) fitTerminal(rec);
    }, 120);
  });

  // manual CLI select mirrors detection
  el.manualCli.innerHTML = "";
  const cliOpts = buildCliOptions();
  for (const o of cliOpts) {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    el.manualCli.appendChild(opt);
  }
  el.manualCli.value = detection.ollama ? "ollama" : (detection.codex ? "codex" : (detection.claude ? "claude" : "ollama"));

  // initial render
  renderProjects();
  renderChat();
  renderSessionInfo();
  ensureEmptyHint();
  renderTabs();

  // hide loading
  el.loading.classList.add("hidden");

  // auto-detection at startup (non-blocking; cached 60s). If terminal is
  // denied, everything degrades to "ask" mode — no crash.
  detectTools(true).then(() => {
    // refresh the manual CLI select + settings list once real results land
    el.manualCli.innerHTML = "";
    for (const o of buildCliOptions()) {
      const opt = document.createElement("option");
      opt.value = o.value;
      opt.textContent = o.label;
      el.manualCli.appendChild(opt);
    }
  }).catch((e) => console.warn("detect", e));
}

init().catch((e) => {
  console.error(e);
  el.loading.textContent = "Failed to start: " + (e && e.message ? e.message : String(e));
});
