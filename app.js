// Term Coder — AI agent orchestrator with live terminal squares.
// Spawns ollama/codex/claude sub-agents — ALWAYS asks the user first (spawn modal).
// Loaded by index.html as <script type="module" src="app.js"></script>.

const STORE_KEY = "term-coder.state";
const SETTINGS_KEY = "term-coder.settings";
const FALLBACK_MODELS = ["qwen3:30b", "qwen3:14b", "llama3.2:latest", "mistral:latest"];
const DETECT_TTL_MS = 60 * 1000;
// CLIs that "ollama launch" can start (from the Ollama desktop Launch screen).
const OLLAMA_LAUNCH_TOOLS = ["claude", "codex", "chatgpt", "hermes", "openclaw", "opencode", "copilot", "droid"];

// Resolved absolute path to the ollama binary (found at detect time). The
// sandboxed terminal runs a NON-login shell, so PATH is minimal and "ollama"
// often isn't on it even though it works in the user's terminal.
let ollamaPath = null;
const OLLAMA_GUESSES = ["/usr/local/bin/ollama", "/opt/homebrew/bin/ollama", "/usr/bin/ollama", "/bin/ollama", "/snap/bin/ollama"];

// Wrap a command so it runs in a login shell (full user PATH) when possible.
// Falls back to the bare command if we can't build a wrapper.
function loginShell(command) {
  return "zsh -lic " + JSON.stringify(command);
}

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
// Model Selection Mode — single source of truth for how sub-agent sessions
// choose a model. Persisted as individual scopedData keys (one per field, see
// MS_KEYS) and restored on load (loadModelSelection). Kept SEPARATE from the
// bundled `settings` blob so the session-startup integration can read it in
// isolation via window.termCoder.getModelSelectionConfig().
let modelSelection = {
  modelSelectionMode: "manual", // "manual" | "always" | "complexity"
  alwaysModel: "",
  complexityModelLow: "",
  complexityModelMedium: "",
  complexityModelHigh: "",
};
// The scopedData keys that back each model-selection field (top-level keys).
const MS_KEYS = ["modelSelectionMode", "alwaysModel", "complexityModelLow", "complexityModelMedium", "complexityModelHigh"];

// Trust-folder policy for spawned CLI agents (claude/codex/etc.):
//   "ask"    -> when a "trust this folder?" dialog appears, ask the user IN CHAT
//               via the askChoice pill picker before pressing Enter to confirm.
//   "always" -> automatically confirm the trust dialog without asking.
// Persisted as its own scopedData key ("trustMode"), separate from the bundled
// settings blob so autoDriveStartup can read it in isolation.
let trustMode = "ask"; // "ask" | "always"
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
  boardChip: $("board-chip"),
  detachBoardBtn: $("detach-board-btn"),
  chatLog: $("chat-log"),
  chatStatus: $("chat-status"),
  chatForm: $("chat-form"),
  chatInput: $("chat-input"),
  sendBtn: $("send-btn"),
  sendIcon: document.querySelector("#send-btn .send-icon"),
  stopIcon: document.querySelector("#send-btn .stop-icon"),
  chatTitle: $("chat-title"),
  sessionInfo: $("session-info"),
  // right
  newSessionBtn: $("new-session-btn"),
  newSessionBtn2: $("new-session-btn-2"),
  termCount: $("term-count"),
  termGrid: $("term-grid"),
  termEmpty: $("term-empty"),
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
  // model selection mode
  modelModeRadios: $("model-mode-radios"),
  modelModeManual: $("model-mode-manual"),
  modelModeAlways: $("model-mode-always"),
  modelModeComplexity: $("model-mode-complexity"),
  alwaysModel: $("always-model"),
  complexityModelLow: $("complexity-model-low"),
  complexityModelMedium: $("complexity-model-medium"),
  complexityModelHigh: $("complexity-model-high"),
  // trust-folder mode
  trustModeRadios: $("trust-mode-radios"),
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

// Normalize a tool call delivered by runTurn's onToolCall. The documented shape is
// { function: { name, arguments } } where arguments is ALREADY an object — but some
// engines pass { name, args } or { name, arguments: "<json string>" }. Handle all.
function normalizeToolCall(call) {
  call = call || {};
  const fn = call.function || {};
  const name = call.name || fn.name || "unknown";
  let args = {};
  const candidates = [call.args, call.arguments, fn.arguments, fn.args];
  for (const cand of candidates) {
    if (cand == null) continue;
    if (typeof cand === "string") {
      try { const parsed = JSON.parse(cand); if (parsed && typeof parsed === "object") { args = parsed; break; } } catch (e) { /* try next */ }
    } else if (typeof cand === "object" && !Array.isArray(cand)) {
      args = cand; break;
    }
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

  // Resolve ollama's absolute path — the sandbox shell has a minimal PATH, so
  // "which ollama" may fail even though ollama is installed. Try `which`, then
  // a login shell, then well-known locations.
  ollamaPath = null;
  const ollamaR = await probe("which ollama");
  if (ollamaR !== null && ollamaR.exitCode === 0 && String(ollamaR.output || "").trim()) {
    ollamaPath = String(ollamaR.output).trim().split("\n")[0].trim();
  }
  if (!ollamaPath) {
    const lr = await probe(loginShell("which ollama"));
    if (lr !== null && lr.exitCode === 0 && String(lr.output || "").trim()) {
      ollamaPath = String(lr.output).trim().split("\n")[0].trim();
    }
  }
  if (!ollamaPath) {
    for (const g of OLLAMA_GUESSES) {
      const tr = await probe("test -x " + JSON.stringify(g) + " && echo ok");
      if (tr !== null && tr.exitCode === 0 && /ok/.test(String(tr.output))) { ollamaPath = g; break; }
    }
  }
  fresh.ollama = !!ollamaPath;

  if (fresh.ollama) {
    const listR = await probe(JSON.stringify(ollamaPath) + " list");
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
  // If the settings panel is open, refresh the model pickers with the newly
  // detected models (preserving saved selections where still available).
  if (el.settingsPanel && !el.settingsPanel.classList.contains("hidden")) {
    applyModelSelectionModeToUi();
  }

  // ── live bridge probe: log exactly which terminal methods exist at runtime ──
  const t = window.chatoss.terminal;
  const bridgeMethods = t ? Object.keys(t) : [];
  console.log("[Term Coder] window.chatoss.terminal keys:", bridgeMethods);
  const checks = ["exec", "spawn", "mount", "onData", "onExit", "write", "resize", "kill"];
  for (const m of checks) {
    console.log(`[Term Coder] terminal.${m}:`, typeof t && t[m]);
  }
  detection.bridge = bridgeMethods; // stash for the Settings panel too
  return detection;
}

// ---------- ORCHESTRATOR TOOLS (JSON schema for runTurn) ----------
const ORCHESTRATOR_TOOLS = [
  {
    type: "function",
    function: {
      name: "create_worktree",
      description: "Create a git worktree (an isolated working directory on a new branch) inside the project's .chatoss/worktrees folder. Returns the worktree path. Uses the active project unless projectId is given.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Optional. Defaults to the active project." },
          branchName: { type: "string", description: "Optional branch name. Defaults to worktree-<timestamp>." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "start_cli_session",
      description: "Ask the user to start a new sub-agent CLI session (ollama launch claude / codex, etc.) in a working directory. The USER decides the CLI and model in a confirmation dialog — call this when you need an agent shell to work in, then wait for the returned session id. cwd defaults to the active project folder.",
      parameters: {
        type: "object",
        properties: {
          cwd: { type: "string", description: "Working directory for the session (a project path or a worktree path). Defaults to the active project folder." },
          taskPrompt: { type: "string", description: "Optional initial task to send to the CLI's stdin after it starts." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_to_session",
      description: "Send keystrokes to a running CLI session's stdin. The text is parsed for escape codes before being written, so \\r=Enter, \\n=newline, \\x1b[A=Up, \\x1b[B=Down, \\x1b[C=Right, \\x1b[D=Left, \\x1b=Esc, \\x03=Ctrl+C are all interpreted as REAL keypresses, not typed literally. To submit a typed line in a TUI like Claude Code, end your text with \\r (Enter). Do NOT add a trailing \\n — Enter already submits it. The session auto-handles the 'trust this folder' dialog and the initial model menu, so you usually only need this for follow-up instructions once the agent is running.",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Optional. Defaults to the most recently started session." },
          text: { type: "string", description: "The text or control sequence to send." },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_session",
      description: "Read the current output of a running CLI session — everything the terminal shows right now (up to ~64KB). Use this to see what the agent has done, check for errors, or detect when a task is finished. Returns the terminal screen text.",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Optional. Defaults to the most recently started session." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_project_files",
      description: "List the files in the project's working directory (ls -la). Uses the active project unless projectId is given. Returns the directory listing.",
      parameters: {
        type: "object",
        properties: { projectId: { type: "string", description: "Optional. Defaults to the active project." } },
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
      description: "Fetch the attached Kanban board's full contents (columns and cards). Defaults to the conversation's attached board; pass boardId only to read a different one. Returns JSON.",
      parameters: {
        type: "object",
        properties: { boardId: { type: "string", description: "Optional. Defaults to the attached board." } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "move_card",
      description: "Move a Kanban card to a different column on the attached board (boardId defaults to the attached board).",
      parameters: {
        type: "object",
        properties: {
          boardId: { type: "string", description: "Optional. Defaults to the attached board." },
          cardId: { type: "string" },
          toColumnId: { type: "string" },
        },
        required: ["cardId", "toColumnId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_card",
      description: "Update a Kanban card's title/description or mark it done on the attached board (boardId defaults to the attached board). When done is true, the card is completed, moved to the Done column, and the user gets a notification.",
      parameters: {
        type: "object",
        properties: {
          boardId: { type: "string", description: "Optional. Defaults to the attached board." },
          cardId: { type: "string" },
          done: { type: "boolean", description: "Mark the card complete (moves it to Done + notification)." },
          title: { type: "string" },
          description: { type: "string" },
        },
        required: ["cardId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_current_git_branch",
      description: "Return the current git branch name of the project (active project unless projectId is given).",
      parameters: {
        type: "object",
        properties: { projectId: { type: "string", description: "Optional. Defaults to the active project." } },
      },
    },
  },
];

// ---------- PTY input: escape-sequence parser ----------
// The orchestrator sends text containing literal escape codes as written in
// tool descriptions (\\r, \\x1b[A, \\n, \\x03, etc.). These arrive as the raw
// STRING "\\r" (backslash + 'r'), not a carriage-return byte — so we MUST parse
// them into real control bytes before writing to the PTY, or the CLI sees the
// literal characters typed into its input box instead of keypresses. This was
// the core bug: Claude Code's TUI showed the prompt text but Enter never fired.
function parseTerminalEscapes(s) {
  if (typeof s !== "string") return s;
  // Normalize the common backslash-escape sequences used in the tool docs.
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== "\\") { out += ch; continue; }
    const next = s[i + 1];
    if (next === undefined) { out += "\\"; break; }
    switch (next) {
      case "r": out += "\r"; i++; break;        // Enter (carriage return)
      case "n": out += "\n"; i++; break;        // newline / line feed
      case "t": out += "\t"; i++; break;        // tab
      case "b": out += "\b"; i++; break;        // backspace
      case "e": out += "\x1b"; i++; break;      // escape (alt: \e)
      case "x": {                               // \x1b -> hex byte
        const hex = s.slice(i + 2, i + 4);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 3; }
        else { out += "\\x"; i++; }
        break;
      }
      case "\\": out += "\\"; i++; break;        // literal backslash
      default: out += "\\" + next; i++; break;   // unknown — leave as-is
    }
  }
  return out;
}

// Strip ANSI escape sequences (colors, cursor moves, etc.) from raw terminal
// output so the orchestrator reads readable text instead of escape noise.
function stripAnsi(s) {
  if (typeof s !== "string") return s;
  // CSI sequences: ESC [ ... <0x40-0x7E>
  s = s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "");
  // OSC sequences: ESC ] ... BEL  or  ESC ] ... ESC \
  s = s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
  // Other 2-char ESC sequences (ESC + one char): ESC ( B, ESC = , etc.
  s = s.replace(/\x1b[@-_]/g, "");
  // Remaining stray ESCs and other C0 control chars (except \n, \r, \t) -> drop
  s = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  return s;
}

// Auto-drive a freshly spawned CLI through its startup dialogs and into the
// point where it will accept the task prompt, then send the prompt.
// Claude Code / Codex / OpenCode show a "trust this folder?" prompt and then a
// model-picker menu at launch. We handle those so the orchestrator's prompt
// actually lands in the agent's input box instead of the wrong screen.
//
// Trust policy (trustMode):
//   "ask"    -> pause the session, show a yes/no pill picker IN CHAT, and only
//               press Enter to confirm trust after the user says yes. If they
//               say no / dismiss it, kill the session (don't trust = don't run).
//   "always" -> automatically press Enter to confirm trust without asking.
//
// Strategy: watch onData chunks for known dialog signatures. When the trust
// dialog appears, handle it per trustMode. When the CLI's real input box is
// ready (welcome line / `❯` prompt), send the task. Safety timeout = 12s.
async function autoDriveStartup(session, prompt, label, cwd) {
  if (!prompt) return;
  const safe = (fn) => { try { return fn(); } catch (_) { return null; } };
  const folderLabel = cwd || label || "(this folder)";

  let settled = false;
  let killed = false;
  let buffer = "";
  let sawTrust = false;
  let trustHandled = false;
  let trustBusy = false; // true while we're waiting for the user's chat answer
  let modelPickerSeen = false;

  const finish = async () => {
    if (settled) return;
    settled = true;
    try { unsub && unsub(); } catch (_) {}
    if (killed) return; // session was killed — don't send the prompt
    // Type the prompt and press Enter so the CLI's input box submits it.
    await safe(() => session.write(prompt + "\r"));
  };

  // Confirm the trust dialog by pressing Enter on the highlighted "Yes" option.
  // Works for both Claude Code ("Yes, I trust this folder") and Codex
  // ("1. Yes, continue" + "Press enter to continue").
  const confirmTrust = async () => {
    trustHandled = true;
    await safe(() => session.write("\r"));
  };

  // Deny trust: kill the session so the untrusted agent doesn't run half-baked.
  const denyTrust = async () => {
    killed = true;
    settled = true;
    try { unsub && unsub(); } catch (_) {}
    try { if (typeof session.kill === "function") await session.kill(); } catch (_) {}
  };

  // Handle the trust dialog according to trustMode. "ask" pauses here until the
  // user answers the chat pill picker; "always" confirms immediately.
  const handleTrust = async () => {
    if (trustMode === "always") {
      await confirmTrust();
      return;
    }
    // trustMode === "ask" — ask in chat, wait for the answer.
    trustBusy = true;
    const ok = await askTrustInChat(folderLabel);
    trustBusy = false;
    if (settled) return; // safety timeout fired while we were waiting
    if (ok) {
      await confirmTrust();
    } else {
      await denyTrust();
    }
  };

  let unsub = null;
  try {
    if (typeof session.onData === "function") {
      unsub = session.onData((chunk) => {
        if (settled || trustBusy) return; // don't act while waiting on the user
        buffer += chunk;
        const flat = stripAnsi(buffer).toLowerCase();

        // 1) Trust dialog. Match BOTH CLIs robustly:
        //    Claude Code: "Do you trust the files in this folder?"
        //    Codex:       "Do you trust the contents of this directory?"
        //                 + "Press enter to continue"
        //    Also catch "Yes, I trust this folder" / "Yes, continue".
        if (!sawTrust && /trust the (files|contents|folder|directory)|trust this folder|do you trust/.test(flat)) {
          sawTrust = true;
          handleTrust(); // fire-and-forget; it sets trustBusy while awaiting
          return;
        }

        // 2) Model picker menu. We do NOT pick here — the model was already
        //    passed via --model, OR the user picked it via Model Selection Mode
        //    pills. If a picker still shows, leave it to the orchestrator/user.
        if (/select model|\/model|navigate.*enter select|choose a model/.test(flat)) {
          modelPickerSeen = true;
          return;
        }

        // 3) Ready state: the CLI's input prompt is showing (welcome box done,
        //    `❯` input line visible). Send the task now — but only if we're
        //    past the trust dialog (or never saw one) and not blocked on a menu.
        if (!modelPickerSeen && (sawTrust ? trustHandled : true)) {
          if (/welcome back|try "how do i|what would you like|how can i help|enter a task|^\s*❯/.test(flat)) {
            finish();
          }
        }
      });
    }
  } catch (_) {}

  // Safety net: never hang. After 12s, send the prompt regardless of state —
  // the orchestrator can recover via read/send later. (Longer than before so
  // the "ask" chat prompt has time to be answered.)
  setTimeout(() => { if (!settled && !trustBusy) finish(); }, 12000);
}

// ---------- Tool handlers (async, always return a string) ----------
// Resolve the project the model means: the id it passed, else the ACTIVE project.
// This makes tools work even when the model calls them with {} (the common case).
function resolveProject(args) {
  return getProject(args && args.projectId) || getProject(state.activeProjectId) || state.projects[0] || null;
}
// Resolve the board the model means: the id it passed, else the conversation's attached board.
function resolveBoardId(args) {
  const c = activeConversation();
  return (args && args.boardId) || (c && c.boardId) || null;
}

async function toolHandler(name, args) {
  args = args || {};
  try {
    switch (name) {
      case "create_worktree": {
        const p = resolveProject(args);
        if (!p) return "Error: no project selected. Ask the user to add a project folder first.";
        const branch = args.branchName || "worktree-" + Date.now();
        const wtPath = p.folderPath.replace(/\/+$/, "") + "/.chatoss/worktrees/" + branch;
        const r = await window.chatoss.terminal.exec(
          loginShell(`git worktree add "${wtPath}" -b "${branch}"`),
          { cwd: p.folderPath }
        );
        if (r === null) return "Error: terminal permission denied (approve git to continue)";
        if (r.exitCode !== 0) return "git worktree failed (exit " + r.exitCode + "):\n" + r.output;
        return wtPath;
      }
      case "start_cli_session": {
        // The USER decides the CLI + model in the spawn modal. The tool WAITS
        // on a promise that resolves when the user hits Start or Cancel.
        let cwd = (args.cwd || "").trim();
        if (!cwd) {
          const p = resolveProject(args);
          cwd = p ? p.folderPath : "";
        }
        const choice = await openSpawnModal({
          source: "tool",
          cwd,
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
        // Default to the most recently started session if no sessionId given.
        let s = args.sessionId ? sessions.get(args.sessionId) : null;
        if (!s && sessions.size) { s = [...sessions.values()].pop(); }
        if (!s) return "Error: no active sessions. Start one with start_cli_session first.";
        try {
          // Parse escape sequences (\\r, \\x1b[A, \\n, …) into real control
          // bytes BEFORE writing to the PTY. The model sends these as literal
          // two-character strings; writing them un-parsed was the bug that left
          // text sitting in the CLI's input box with Enter never firing.
          const raw = parseTerminalEscapes(args.text);
          await s.session.write(raw);
        } catch (e) {
          return "Error: " + (e && e.message ? e.message : String(e));
        }
        return "ok";
      }
      case "read_session": {
        // Read what the terminal currently shows — the orchestrator's eyes.
        let s = args.sessionId ? sessions.get(args.sessionId) : null;
        if (!s && sessions.size) { s = [...sessions.values()].pop(); }
        if (!s) return "Error: no active sessions. Start one with start_cli_session first.";
        try {
          if (s.session && typeof s.session.getOutput === "function") {
            const text = await s.session.getOutput();
            // Strip ANSI color/cursor escapes so the orchestrator reads clean
            // text and can pattern-match on it instead of wading through noise.
            return text ? stripAnsi(text) : "(terminal is empty — no output yet)";
          }
          return "Error: getOutput() not available on this session";
        } catch (e) {
          return "Error: " + (e && e.message ? e.message : String(e));
        }
      }
      case "list_project_files": {
        const p = resolveProject(args);
        if (!p) return "Error: no project selected. Ask the user to add a project folder first.";
        const r = await window.chatoss.terminal.exec(loginShell("ls -la"), { cwd: p.folderPath });
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
        const bid = resolveBoardId(args);
        if (!bid) return "Error: no board attached to this conversation. Use list_boards, or ask the user to attach one.";
        try {
          const b = await window.chatoss.boards.get(bid);
          return JSON.stringify(b);
        } catch (e) {
          return "Error: " + (e && e.message ? e.message : String(e));
        }
      }
      case "move_card": {
        const bid = resolveBoardId(args);
        if (!bid) return "Error: no board attached to this conversation.";
        try {
          await window.chatoss.boards.moveCard(bid, args.cardId, args.toColumnId);
          return "ok";
        } catch (e) {
          return "Error: " + (e && e.message ? e.message : String(e));
        }
      }
      case "update_card": {
        const bid = resolveBoardId(args);
        if (!bid) return "Error: no board attached to this conversation.";
        const patch = {};
        if (args.done !== undefined && args.done !== null) patch.done = args.done;
        if (args.title !== undefined && args.title !== null) patch.title = args.title;
        if (args.description !== undefined && args.description !== null) patch.description = args.description;
        try {
          await window.chatoss.boards.updateCard(bid, args.cardId, patch);
        } catch (e) {
          return "Error: " + (e && e.message ? e.message : String(e));
        }
        if (patch.done === true) {
          let body = "Card marked complete.";
          try {
            const b = await window.chatoss.boards.get(bid);
            const card = b && b.cards ? b.cards.find((c) => c.id === args.cardId) : null;
            if (card && card.title) body = card.title;
          } catch (e) { /* non-fatal */ }
          try { await window.chatoss.notifications.send({ title: "Task complete", body }); } catch (e) { /* non-fatal */ }
        }
        return "ok";
      }
      case "get_current_git_branch": {
        const p = resolveProject(args);
        if (!p) return "Error: no project selected. Ask the user to add a project folder first.";
        const r = await window.chatoss.terminal.exec(loginShell("git branch --show-current"), { cwd: p.folderPath });
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
// "ollama launch <tool>" starts an agent CLI (claude, codex, …) and opens its
// OWN interactive model picker inside the terminal — so we don't pass a model.
function buildCliOptions() {
  const opts = [];
  const push = (value, label, detected) => {
    opts.push({ value, label: detected ? label : label + " (not detected)" });
  };
  push("claude", "ollama launch claude  (Claude Code)", detection.ollama);
  push("codex", "ollama launch codex  (Codex)", detection.ollama);
  push("chatgpt", "ollama launch chatgpt  (ChatGPT)", detection.ollama);
  push("hermes", "ollama launch hermes  (Hermes Agent)", detection.ollama);
  push("opencode", "ollama launch opencode  (OpenCode)", detection.ollama);
  push("copilot", "ollama launch copilot  (Copilot CLI)", detection.ollama);
  // Raw binaries, only if actually installed on PATH.
  if (detection.claude) push("raw:claude", "claude  (direct binary)", true);
  if (detection.codex) push("raw:codex", "codex  (direct binary)", true);
  return opts;
}

function syncSpawnModelRow() {
  // "ollama launch <tool>" opens its own model picker inside the terminal, so
  // there's no separate model dropdown — always hide that row.
  el.spawnModelRow.classList.add("hidden");
  el.spawnModel.disabled = true;
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
      if (!preselectCli || !cliOpts.some((o) => o.value === preselectCli)) {
        preselectCli = detection.claude ? "claude" : (detection.codex ? "codex" : (cliOpts[0] ? cliOpts[0].value : "claude"));
      }
      el.spawnCli.value = preselectCli;
      syncSpawnModelRow();

      // cwd: tool call > settings default > active project folder
      let cwd = (opts.cwd || "").trim();
      if (!cwd) cwd = (settings.cwdDefault || "").trim();
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
  const cwd = el.spawnCwd.value.trim();
  const prompt = el.spawnPrompt.value.trim();
  const remember = el.spawnRemember.checked;

  if (!cli) { el.spawnStatus.textContent = "Pick what to launch."; return; }
  if (!cwd) { el.spawnStatus.textContent = "Enter a working directory."; return; }

  // ---- Route the session model through the configured Model Selection Mode ----
  // window.termCoder.resolveSessionModel(taskPrompt) encapsulates all three
  // modes (manual / always / complexity) and returns the model to use, or null
  // to cancel. The manual mode renders a pill picker inside the chat stream via
  // askChoice, so hide the spawn modal while the choice is pending so the pills
  // are visible and clickable.
  el.spawnModal.classList.add("hidden");
  let model = null;
  try {
    model = await window.termCoder.resolveSessionModel(prompt);
  } catch (e) {
    console.warn("resolveSessionModel", e);
  }
  if (!model) {
    // Dismissed / cancelled / unavailable — do NOT start the session.
    closeSpawnModal(null);
    return;
  }

  if (remember) {
    settings.cliDefault = cli;
    settings.cwdDefault = cwd;
    saveSettings();
  }

  el.spawnStart.disabled = true;
  el.spawnStatus.textContent = "Starting…";
  el.spawnModal.classList.remove("hidden");
  try {
    const session = await spawnChosen({ cli, cwd, prompt, model });
    if (!session) {
      el.spawnStatus.textContent = "Terminal permission denied. Approve it in the system prompt and try again, or cancel.";
      el.spawnStart.disabled = false;
      return; // keep the modal open so the user can retry/cancel
    }
    if (session.error) {
      el.spawnStatus.textContent = session.error;
      el.spawnStart.disabled = false;
      return;
    }
    closeSpawnModal({ cli, cwd, prompt, session });
  } catch (e) {
    el.spawnStatus.textContent = "Error: " + (e && e.message ? e.message : String(e));
    el.spawnStart.disabled = false;
  }
}

function onSpawnCancel() {
  closeSpawnModal(null);
}

async function spawnChosen(choice) {
  // choice.cli is either a launch tool ("claude"|"codex"|…) or "raw:<bin>".
  // ALWAYS spawn through a login shell so `ollama` (and any user-installed CLI)
  // resolves on the full PATH — the sandboxed default shell has a minimal PATH,
  // which is exactly what caused "Unable to spawn ollama … not found in PATH".
  let inner, label;
  if (choice.cli.startsWith("raw:")) {
    const bin = choice.cli.slice(4);
    inner = "exec " + bin;
    label = bin + " · " + basename(choice.cwd);
  } else {
    const bin = ollamaPath || "ollama";
    inner = "exec " + JSON.stringify(bin) + " launch " + choice.cli;
    // Apply the resolved model (from Model Selection Mode) as a CLI flag so
    // the launched agent uses it instead of opening its own model picker.
    if (choice.model) {
      inner += " --model " + JSON.stringify(choice.model);
    }
    label = choice.cli + " · " + basename(choice.cwd);
  }

  let session = null;
  try {
    session = await window.chatoss.terminal.spawn("zsh", { args: ["-lic", inner], cwd: choice.cwd, cols: 90, rows: 22 });
  } catch (e) {
    return { error: "Failed to start session: " + (e && e.message ? e.message : String(e)) };
  }
  if (!session) {
    // spawn returns null when denied by the user.
    return null; // denied
  }
  // The session handle is object-oriented: session.id, session.write, session.onData,
  // session.onExit, session.resize, session.kill. Pass the WHOLE handle to
  // registerSession so mount() can wire output→terminal and input→stdin.
  await registerSession(session, "zsh", ["-lic", inner], choice.cwd, label);
  if (choice.prompt) {
    // Don't write the prompt immediately — the CLI (Claude Code / Codex) shows a
    // "trust this folder?" dialog and sometimes a model picker at launch, and
    // typing the prompt too early dumps it into the wrong screen. autoDriveStartup
    // watches the live output, handles the trust dialog (per the Settings trust
    // policy: ask in chat, or always trust), and sends the prompt once the agent's
    // real input box is ready (with a 12s safety timeout).
    try { autoDriveStartup(session, choice.prompt, label, choice.cwd); } catch (e) { /* non-fatal */ }
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
  el.setCwd.value = settings.cwdDefault || "";
  renderDetectedList();
  applyModelSelectionModeToUi();
  applyTrustModeToUi();
  el.settingsPanel.classList.remove("hidden");
}

function syncSettingsModelRow() {
  // Model is chosen inside the launched terminal — no settings model row.
  if (el.setModelRow) el.setModelRow.classList.add("hidden");
}

function saveSettingsFromPanel() {
  settings.cliDefault = el.setCli.value;
  settings.cwdDefault = el.setCwd.value.trim();
  // Model Selection Mode persists to its own scopedData keys (handled by
  // saveModelSelectionMode), not the bundled settings blob. Sync it now so
  // any uncommitted picker value is captured on Save.
  saveModelSelectionMode();
  saveTrustMode();
  saveSettings();
  el.settingsPanel.classList.add("hidden");
}

// ---------- Model Selection Mode ----------
// Returns the auto-detected ollama model ids (a copy of detection.models),
// falling back to FALLBACK_MODELS when detection is empty.
function availableOllamaModels() {
  const m = (detection && detection.models && detection.models.length) ? detection.models : FALLBACK_MODELS.slice();
  return m.slice();
}

// Populate a <select> with the detected ollama models and select `selected`
// (if present in the list). Renders an empty placeholder option when no
// models are available so the picker is never silently blank.
function populateModelSelect(selectEl, selected) {
  if (!selectEl) return;
  const models = availableOllamaModels();
  selectEl.innerHTML = "";
  if (!models.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(no models detected — run Re-scan)";
    selectEl.appendChild(opt);
    selectEl.value = "";
    return;
  }
  for (const id of models) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = id;
    selectEl.appendChild(opt);
  }
  // restore the saved selection if it's still available, else first model.
  if (selected && models.includes(selected)) selectEl.value = selected;
  else selectEl.value = models[0];
}

// Show only the picker panel matching the active radio mode.
function showModelModePanel(mode) {
  el.modelModeManual.classList.toggle("hidden", mode !== "manual");
  el.modelModeAlways.classList.toggle("hidden", mode !== "always");
  el.modelModeComplexity.classList.toggle("hidden", mode !== "complexity");
}

// Reflect the persisted model-selection config into the settings UI.
// Called on openSettings() (UI open) and after a Re-scan refreshes models.
function applyModelSelectionModeToUi() {
  const mode = modelSelection.modelSelectionMode || "manual";
  const radio = el.modelModeRadios.querySelector(`input[name="model-mode"][value="${mode}"]`);
  if (radio) radio.checked = true;
  populateModelSelect(el.alwaysModel, modelSelection.alwaysModel);
  populateModelSelect(el.complexityModelLow, modelSelection.complexityModelLow);
  populateModelSelect(el.complexityModelMedium, modelSelection.complexityModelMedium);
  populateModelSelect(el.complexityModelHigh, modelSelection.complexityModelHigh);
  showModelModePanel(mode);
}

// Read the current settings-UI values back into `modelSelection` and persist
// each field to its own scopedData key immediately (live persistence).
function saveModelSelectionMode() {
  const checked = el.modelModeRadios.querySelector('input[name="model-mode"]:checked');
  modelSelection.modelSelectionMode = checked ? checked.value : "manual";
  modelSelection.alwaysModel = el.alwaysModel.value || "";
  modelSelection.complexityModelLow = el.complexityModelLow.value || "";
  modelSelection.complexityModelMedium = el.complexityModelMedium.value || "";
  modelSelection.complexityModelHigh = el.complexityModelHigh.value || "";
  persistModelSelection();
}

// Persist every model-selection field to its own scopedData key.
function persistModelSelection() {
  for (const key of MS_KEYS) {
    try {
      window.chatoss.scopedData.set(key, modelSelection[key]).catch((e) => console.warn("persistModelSelection", key, e));
    } catch (e) { console.warn("persistModelSelection", key, e); }
  }
}

// On app load: read each model-selection field from its own scopedData key and
// restore the in-memory config + UI. Missing keys keep their defaults.
async function loadModelSelection() {
  for (const key of MS_KEYS) {
    try {
      const v = await window.chatoss.scopedData.get(key);
      if (v !== undefined && v !== null) modelSelection[key] = v;
    } catch (e) { console.warn("loadModelSelection", key, e); }
  }
  applyModelSelectionModeToUi();
}

// ---------- Folder-trust policy ----------
// Persist + restore trustMode ("ask" | "always") to its own scopedData key.
async function loadTrustMode() {
  try {
    const v = await window.chatoss.scopedData.get("trustMode");
    if (v === "ask" || v === "always") trustMode = v;
  } catch (e) { console.warn("loadTrustMode", e); }
}
function persistTrustMode() {
  try { window.chatoss.scopedData.set("trustMode", trustMode).catch((e) => console.warn("persistTrustMode", e)); }
  catch (e) { console.warn("persistTrustMode", e); }
}
// Reflect the persisted trustMode into the settings UI radio group.
function applyTrustModeToUi() {
  if (!el.trustModeRadios) return;
  const radio = el.trustModeRadios.querySelector(`input[name="trust-mode"][value="${trustMode || "ask"}"]`);
  if (radio) radio.checked = true;
}
// Read the settings-UI trust radio back into trustMode and persist it.
function saveTrustMode() {
  if (!el.trustModeRadios) return;
  const checked = el.trustModeRadios.querySelector('input[name="trust-mode"]:checked');
  trustMode = checked ? checked.value : "ask";
  persistTrustMode();
}

// Ask the user (IN CHAT, via the askChoice pill picker) whether to trust the
// folder a CLI agent is prompting about. Resolves true for "trust", false for
// "don't trust" or if dismissed. Used by autoDriveStartup when trustMode=ask.
async function askTrustInChat(folderLabel) {
  try {
    const v = await window.termCoder.askChoice({
      prompt: "A coding agent wants to trust this folder before it can run:\n\n" + (folderLabel || "(this folder)"),
      options: [
        { label: "Yes, trust this folder", value: "yes" },
        { label: "No, don't trust", value: "no" },
      ],
      style: "pill",
    });
    return v === "yes";
  } catch (e) {
    console.warn("askTrustInChat", e);
    return false;
  }
}

// Shared read helper for other code (e.g. the session-startup integration).
// Always returns a plain object with the current config + detected models.
window.termCoder = window.termCoder || {};
window.termCoder.getModelSelectionConfig = function () {
  return {
    mode: modelSelection.modelSelectionMode || "manual",
    alwaysModel: modelSelection.alwaysModel || "",
    complexityModelLow: modelSelection.complexityModelLow || "",
    complexityModelMedium: modelSelection.complexityModelMedium || "",
    complexityModelHigh: modelSelection.complexityModelHigh || "",
    availableModels: availableOllamaModels(),
  };
};

// ---------- Session model resolution (Model Selection Mode) ----------
// Encapsulates all three Model Selection Modes so the session-startup code
// calls a single helper and gets back the model to use (or null to cancel).
//
//   window.termCoder.resolveSessionModel(taskPrompt) -> Promise<string|null>
//
//   - "manual"     -> prompt via askChoice (pill style), wait, return chosen
//                     model (or null if dismissed — caller cancels the session).
//   - "always"     -> return cfg.alwaysModel automatically; if it's unset/empty,
//                     fall back to askChoice so the user can still pick one.
//   - "complexity" -> assess the task prompt's complexity (low/medium/high),
//                     return the corresponding configured model automatically
//                     (no prompt). Falls back through the other levels, then to
//                     the first available model if the assessed level is unset.
//
// Keep this pure — it knows nothing about the spawn modal. The caller decides
// whether/how to hide the modal while the pill picker is on screen.

// Lightweight keyword + length heuristic. No chatApi call needed, so it works
// even before the first orchestrator turn and never adds latency.
// Returns "low" | "medium" | "high".
function assessComplexity(taskPrompt) {
  const text = (taskPrompt || "").toLowerCase();
  const len = text.length;

  // Words that signal a non-trivial, multi-step, or architecturally
  // involved task.
  const HIGH_KEYWORDS = [
    "refactor", "architect", "architecture", "design", "implement",
    "migrate", "migration", "database", "security", "performance",
    "optimize", "optimise", "scale", "auth", "authentication", "authorize",
    "full", "complete", "system", "multiple", "integrate", "integration",
    "complex", "deploy", "ci/cd", "pipeline", "infrastructure",
    "microservice", "concurrent", "async", "distributed", "end-to-end",
    "comprehensive", "overhaul", "rewrite",
  ];
  // Words that signal an ordinary, focused change.
  const MEDIUM_KEYWORDS = [
    "add", "create", "build", "fix", "update", "change", "modify",
    "feature", "component", "screen", "page", "endpoint", "handler",
    "function", "method", "style", "css", "layout",
  ];

  let highHits = 0;
  let medHits = 0;
  for (const kw of HIGH_KEYWORDS) if (text.includes(kw)) highHits++;
  for (const kw of MEDIUM_KEYWORDS) if (text.includes(kw)) medHits++;

  // Long, keyword-rich prompts are high complexity.
  if (len > 200 || highHits >= 3) return "high";
  // Moderate length or at least one complexity keyword -> medium.
  if (len > 80 || highHits >= 1 || medHits >= 2) return "medium";
  // Short, simple, everyday prompts.
  return "low";
}

// Single helper that routes through the configured Model Selection Mode.
// Returns a model string to apply, or null to cancel the session.
window.termCoder.resolveSessionModel = async function resolveSessionModel(taskPrompt) {
  const cfg = window.termCoder.getModelSelectionConfig();
  const models = Array.isArray(cfg.availableModels) ? cfg.availableModels : [];

  // ---- Always: use the configured fixed model, no prompt. ----
  if (cfg.mode === "always") {
    if (cfg.alwaysModel) return cfg.alwaysModel;
    // No always-model configured yet — fall back to a pill picker so the
    // session can still start, and hint that Settings has the real config.
    if (models.length) {
      return await window.termCoder.askChoice({
        prompt: "No \"always\" model is configured yet — pick one for this session (or set it in Settings):",
        options: models.map((m) => ({ label: m, value: m })),
        style: "pill",
      });
    }
    return null;
  }

  // ---- Complexity: assess + map, no prompt. ----
  if (cfg.mode === "complexity") {
    const level = assessComplexity(taskPrompt);
    const map = {
      low: cfg.complexityModelLow,
      medium: cfg.complexityModelMedium,
      high: cfg.complexityModelHigh,
    };
    // Use the assessed level; cascade to a sensible fallback if it's unset.
    const model = map[level] || map.medium || map.low || map.high;
    if (model) return model;
    if (models.length) return models[0]; // last-resort default
    return null;
  }

  // ---- Manual (default): prompt via pills and wait for the pick. ----
  if (!models.length) return null;
  return await window.termCoder.askChoice({
    prompt: "Select a model for this session:",
    options: models.map((m) => ({ label: m, value: m })),
    style: "pill",
  });
};

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
        boardNameCache[b.id] = b.name;
        saveState();
        el.boardPicker.classList.add("hidden");
        renderBoardChip();
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

    // File tree (only for the selected project) — toggle with the ▸ triangle
    if (p.id === state.activeProjectId) {
      const filesWrap = document.createElement("div");
      filesWrap.className = "file-tree";
      renderFileTree(p, filesWrap);
      item.appendChild(filesWrap);
    }

    name.onclick = () => selectProject(p.id);
    el.projectList.appendChild(item);
  }
}

// ---------- File tree (terminal 'ls' — files.listDir does not exist) ----------
const fileTreeCache = new Map(); // projectPath -> { ts, lines }
async function renderFileTree(project, container) {
  container.innerHTML = "";
  const head = document.createElement("div");
  head.className = "file-tree-head";
  head.innerHTML = '<span class="file-tree-title">Files</span>';
  const refresh = document.createElement("button");
  refresh.className = "btn-icon";
  refresh.title = "Refresh";
  refresh.textContent = "⟳";
  refresh.onclick = (e) => { e.stopPropagation(); fileTreeCache.delete(project.folderPath); renderFileTree(project, container); };
  head.appendChild(refresh);
  container.appendChild(head);

  const body = document.createElement("div");
  body.className = "file-tree-body";
  body.innerHTML = '<div class="file-tree-loading">Loading…</div>';
  container.appendChild(body);

  const cached = fileTreeCache.get(project.folderPath);
  if (cached && Date.now() - cached.ts < 30000) { paintFileTree(body, cached.lines); return; }

  let res = null;
  try {
    res = await window.chatoss.terminal.exec(
      loginShell('ls -Ap | grep -v "^\\.git/" | head -60'),
      { cwd: project.folderPath, timeoutMs: 8000 }
    );
  } catch (e) { res = null; }
  if (!res) {
    body.innerHTML = '<div class="file-tree-loading">Terminal permission needed to list files.</div>';
    return;
  }
  const lines = (res.output || "").split("\n").map(s => s.trim()).filter(Boolean);
  fileTreeCache.set(project.folderPath, { ts: Date.now(), lines });
  paintFileTree(body, lines);
}

function paintFileTree(body, lines) {
  body.innerHTML = "";
  if (!lines.length) { body.innerHTML = '<div class="file-tree-loading">Empty folder</div>'; return; }
  for (const line of lines) {
    const isDir = line.endsWith("/");
    const row = document.createElement("div");
    row.className = "file-row" + (isDir ? " is-dir" : "");
    const icon = document.createElement("span");
    icon.className = "file-icon";
    icon.textContent = isDir ? "▸" : fileIcon(line);
    const nm = document.createElement("span");
    nm.className = "file-name";
    nm.textContent = isDir ? line.slice(0, -1) : line;
    row.appendChild(icon);
    row.appendChild(nm);
    body.appendChild(row);
  }
}

function fileIcon(name) {
  const ext = name.split(".").pop().toLowerCase();
  const map = { js:"JS", ts:"TS", json:"{}", html:"<>", css:"#", md:"M↓", svg:"◈", png:"▦", jpg:"▦", txt:"≡" };
  return map[ext] || "·";
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

// Resolve a board's display name (cached) so the attached chip shows the real name.
const boardNameCache = {};
async function resolveBoardName(boardId) {
  if (!boardId) return "";
  if (boardNameCache[boardId]) return boardNameCache[boardId];
  try {
    const b = await window.chatoss.boards.get(boardId);
    const n = b && b.name ? b.name : "Board";
    boardNameCache[boardId] = n;
    return n;
  } catch (e) {
    return "Board";
  }
}
async function renderBoardChip() {
  const c = activeConversation();
  const chip = el.boardChip;
  if (!chip) return;
  if (c && c.boardId) {
    chip.classList.remove("hidden");
    el.attachedBoardName.textContent = "…";
    el.attachBoardBtn.classList.add("hidden");
    const name = await resolveBoardName(c.boardId);
    // conversation may have changed while awaiting
    const cur = activeConversation();
    if (cur && cur.boardId === c.boardId) el.attachedBoardName.textContent = name;
  } else {
    chip.classList.add("hidden");
    el.attachBoardBtn.classList.remove("hidden");
  }
}
function detachBoard() {
  const c = activeConversation();
  if (!c) return;
  c.boardId = null;
  saveState();
  renderBoardChip();
}

// ---------- Render: middle column (chat) ----------
function renderChat() {
  const c = activeConversation();
  el.chatLog.innerHTML = "";
  if (!c) {
    el.chatTitle.textContent = "Ask the agent";
    el.chatInput.placeholder = "Select or create a conversation…";
    renderModelPicker();
    renderEffortPicker();
    renderBoardChip();
    return;
  }
  el.chatTitle.textContent = c.name;
  el.chatInput.placeholder = "Ask the orchestrator to build something…";
  renderModelPicker();
  renderEffortPicker();
  renderBoardChip();

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
    "You are Term Coder, an autonomous software-building orchestrator (like a coding agent).",
    "You build software by spawning sub-agent CLI coding sessions (claude, codex, etc.) in the terminals panel, reading Kanban board tasks, and marking cards done when work is complete.",
    "",
    "IMPORTANT — tool arguments: most tools work with NO arguments because they default to the active project and the attached board. Do NOT invent ids. If you are unsure, call the tool with {} and it will use the current context.",
    "",
    "IMPORTANT: every sub-agent session requires the USER's approval. When you call start_cli_session, a confirmation dialog appears and the user chooses the CLI and model — you just supply the working directory and a task prompt, then wait for the returned session id.",
    "",
    "Workflow:",
    "1. Quickly inspect with list_project_files({}) and get_current_git_branch({}) — do this ONCE, don't loop.",
    "2. Create an isolated git worktree with create_worktree({}) for the work (returns a path).",
    "3. Call start_cli_session({ cwd: <worktree path>, taskPrompt: <the task> }) to SPIN UP A CODING AGENT in a terminal. The user approves and picks the CLI/model. This is the main way work gets done — the sub-agent writes the code, not you.",
    "4. MONITOR the running session: call read_session({}) to see what the agent is doing — its output, errors, or progress. The read returns CLEAN text (ANSI escapes stripped) so you can read it directly. Use send_to_session({ text }) to send follow-up instructions or navigate menus.",
    "   - send_to_session parses escape codes: use \\r for Enter (to submit a typed line), \\x1b[A / \\x1b[B for Up/Down arrows, \\x1b for Esc, \\x03 for Ctrl+C. Do NOT add a trailing \\n after \\r — Enter already submits.",
    "   - The session AUTO-HANDLES its own startup: the 'trust this folder?' dialog is handled per your Settings (Term Coder asks you IN CHAT with a yes/no pill picker before confirming, or trusts automatically if set to 'Always'), and the taskPrompt you passed to start_cli_session is typed + submitted once the agent's input box is ready. So you do NOT need to re-send the task or press Enter on the trust dialog yourself — just call read_session({}) a few seconds later to watch it work. If you see a yes/no 'trust this folder' question appear in the chat, answer it to let the session proceed.",
    "   - If read_session shows a model-picker menu ('Select model…' / '↑/↓ navigate • enter select'), the model selection did NOT happen automatically — use send_to_session with arrow keys + \\r to pick one, or tell the user to pick a model in the app's Model Selection Mode pills (Settings). Do not type your task text into the model menu.",
    "   - If read_session returns 'Error: no such terminal session' shortly after start, the session was killed — most likely the user declined to trust the folder. Do NOT immediately re-call start_cli_session with the same args. Instead tell the user the folder wasn't trusted and ask how they'd like to proceed.",
    "5. When read_session shows the work is done (or the user confirms), read the attached Kanban board with get_board({}) and call update_card({ cardId, done:true }) to mark the task complete.",
    "",
    "ACT, don't just explore. When the user asks you to build or change something, your job is to SPIN UP one or more coding agents (start_cli_session) to do the work in their own terminals — then coordinate them by reading their output (read_session) and sending follow-up instructions (send_to_session). Don't try to write all the code yourself in chat; delegate it to sub-agents.",
    "",
  ];
  if (p) {
    sys.push("Active project name: " + p.name);
    sys.push("Active project id: " + p.id);
    sys.push("Active project folder: " + p.folderPath);
  } else {
    sys.push("(No project selected yet — ask the user to add a project folder with the + button.)");
  }
  if (c && c.boardId) {
    sys.push("", "Attached Kanban board id: " + c.boardId);
    try {
      const b = await window.chatoss.boards.get(c.boardId);
      if (b) {
        sys.push("Attached Kanban board: " + b.name, "Columns: " + (b.columns || []).map((col) => col.name + " (" + col.id + ")").join(" | "), "", "Tasks:");
        const cards = b.cards || [];
        if (!cards.length) sys.push("(no cards)");
        for (const card of cards) {
          const col = (b.columns || []).find((x) => x.id === card.columnId);
          sys.push("- cardId " + card.id + " [" + (col ? col.name : "?") + "]" + (card.done ? " (done)" : "") + " " + card.title +
            (card.description ? " — " + card.description : ""));
        }
      }
    } catch (e) {
      sys.push("(Could not read attached board: " + (e && e.message ? e.message : String(e)) + ")");
    }
  } else {
    sys.push("", "(No Kanban board attached to this conversation. You can still list_boards to see what exists.)");
  }
  return sys.join("\n");
}

// ---------- Send message ----------
function setRunning(r) {
  running = r;
  el.sendBtn.classList.toggle("is-running", r);
  el.sendBtn.title = r ? "Stop" : "Send";
  el.sendBtn.setAttribute("aria-label", r ? "Stop" : "Send");
  if (el.sendIcon) el.sendIcon.classList.toggle("hidden", r);
  if (el.stopIcon) el.stopIcon.classList.toggle("hidden", !r);
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
    let storedToolCalls = liveToolCalls.length ? liveToolCalls : undefined;
    if (result && result.toolCalls && result.toolCalls.length) {
      storedToolCalls = result.toolCalls.map(normalizeToolCall);
    }
    c.messages.push({
      role: "assistant",
      content: content || "(no response)",
      thinking: thinking || undefined,
      toolCalls: storedToolCalls,
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

// ---------- Right column: terminal grid ----------
function ensureEmptyHint() {
  if (el.termEmpty) el.termEmpty.style.display = sessions.size ? "none" : "";
  if (el.termCount) el.termCount.textContent = String(sessions.size);
}

function renderTabs() {
  // Grid layout — no tab bar. Keep the active square visually marked and the
  // count badge in sync. (Name kept so existing call sites don't change.)
  for (const rec of sessions.values()) {
    rec.squareEl.classList.toggle("active", rec.id === state.activeSessionId);
  }
  if (el.termCount) el.termCount.textContent = String(sessions.size);
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

async function registerSession(session, cmd, args, cwd, label) {
  const id = session.id;
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
  const cwdEl = document.createElement("span");
  cwdEl.className = "term-cwd";
  cwdEl.textContent = basename(cwd);
  cwdEl.title = cwd;
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
  header.appendChild(cwdEl);
  header.appendChild(expandBtn);
  header.appendChild(closeBtn);

  const mountEl = document.createElement("div");
  mountEl.className = "term-mount";

  square.appendChild(header);
  square.appendChild(mountEl);
  // insert before the empty-state card so the grid stays clean
  if (el.termEmpty && el.termEmpty.parentNode === el.termGrid) el.termGrid.insertBefore(square, el.termEmpty);
  else el.termGrid.appendChild(square);

  // clicking a square selects it
  square.addEventListener("click", () => selectSession(id));

  const rec = { id: session.id, session, cmd, args, cwd, label, active: true, exitCode: null, squareEl: square, mountEl, dispose: null, expanded: false };
  sessions.set(session.id, rec);

  // mount the xterm widget. Per the docs, mount() wires session output → terminal
  // AND terminal input → stdin automatically — we do NOT need a separate onData
  // handler for display. Pass the session.id (string) per the documented signature.
  try {
    const handle = await window.chatoss.terminal.mount(mountEl, session.id, { fontSize: 12 });
    rec.dispose = handle && handle.dispose ? handle.dispose.bind(handle) : null;
  } catch (e) {
    console.warn("terminal.mount failed:", e);
    const errEl = document.createElement("div");
    errEl.className = "term-mount-error";
    errEl.textContent = "Terminal failed to load: " + (e && e.message ? e.message : String(e));
    mountEl.appendChild(errEl);
  }

  // exit callback — use the session handle's OO onExit method.
  try {
    if (session.onExit) {
      session.onExit((exitCode) => {
        rec.active = false;
        rec.exitCode = exitCode;
        dot.classList.add("exited");
        dot.title = "Exited (" + (exitCode == null ? "killed" : exitCode) + ")";
        lab.textContent = label + " ✓ (" + (exitCode == null ? "exited" : exitCode) + ")";
        renderTabs();
        try { window.chatoss.notifications.send({ title: "Session ended", body: label + " finished" }); } catch (e) { /* non-fatal */ }
        renderSessionInfo();
      });
    }
  } catch (e) { console.warn("onExit failed:", e); }

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
  try { if (rec.session && rec.session.resize) rec.session.resize(cols, rows); } catch (e) { /* non-fatal */ }
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
  try { if (rec.session && rec.session.kill) await rec.session.kill(); } catch (e) { /* non-fatal */ }
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

// ---------- Reusable multiple-choice chat component ----------
// window.termCoder.askChoice(config) -> Promise
//   config = { prompt: string,
//             options: [{label: string, value: string}, ...],
//             style: "rect" | "pill" }
//   Resolves to the chosen option's `value` (string), or null if the user
//   dismisses/cancels (Escape). The Promise blocks ONLY this choice — the rest
//   of the UI stays fully interactive.
//
// Renders the prompt text + option buttons INSIDE the chat stream (as a chat
// message bubble) so the question appears naturally in the conversation.
// Shows a subtle "waiting for your selection…" state until clicked; after one
// option is clicked, all buttons are disabled and the chosen one is visually
// marked.
//
// style "rect" -> stacked text rectangles, one full-width row per option.
// style "pill" -> pill buttons in a wrapping row (flex-wrap), horizontal, wrap.
window.termCoder = window.termCoder || {};

window.termCoder.askChoice = function askChoice(config) {
  return new Promise((resolve) => {
    const cfg = config || {};
    const promptText = typeof cfg.prompt === "string" ? cfg.prompt : "";
    const opts = Array.isArray(cfg.options) ? cfg.options : [];
    const styleMode = cfg.style === "pill" ? "pill" : "rect"; // default rect

    // Defensive: if the chat log isn't available, fall back to body so the
    // promise still settles rather than hanging forever.
    let host = (typeof el !== "undefined" && el && el.chatLog) ? el.chatLog : document.body;
    if (!host) host = document.body;

    // --- message bubble -------------------------------------------------
    const row = document.createElement("div");
    row.className = "msg assistant choice-msg";

    const body = document.createElement("div");
    body.className = "choice-body";
    row.appendChild(body);

    if (promptText) {
      const promptEl = document.createElement("div");
      promptEl.className = "choice-prompt";
      // reuse the same paragraph-splitting convention as renderMessage()
      promptEl.innerHTML = promptText.split(/\n\n+/)
        .map((p) => "<p>" + esc(p).replace(/\n/g, "<br>") + "</p>").join("");
      body.appendChild(promptEl);
    }

    // options container
    const optsWrap = document.createElement("div");
    optsWrap.className = "choice-options choice-" + styleMode;
    body.appendChild(optsWrap);

    // waiting hint
    const waitHint = document.createElement("div");
    waitHint.className = "choice-waiting";
    waitHint.textContent = "waiting for your selection…";
    body.appendChild(waitHint);

    let settled = false;
    const btns = [];

    function finish(clickedBtn, value) {
      if (settled) return;
      settled = true;
      waitHint.classList.add("hidden");
      // disable every button; dim the un-chosen ones, highlight the chosen
      for (const b of btns) {
        b.disabled = true;
        if (b !== clickedBtn) b.classList.add("choice-dimmed");
      }
      resolve(value);
    }

    for (const opt of opts) {
      if (!opt || typeof opt !== "object") continue;
      const label = opt.label != null ? String(opt.label) : String(opt.value);
      const value = opt.value != null ? String(opt.value) : label;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "choice-btn";
      btn.textContent = label;
      btn.addEventListener("click", () => {
        if (settled) return;
        btn.classList.add("choice-selected");
        finish(btn, value);
        if (typeof scrollChatBottom === "function") scrollChatBottom();
      });
      optsWrap.appendChild(btn);
      btns.push(btn);
    }

    // No options -> nothing to pick; resolve null.
    if (!btns.length) {
      waitHint.textContent = "no options provided";
      finish(null, null);
    }

    // Escape dismisses -> resolve null (cancel). Listens only while pending.
    function onKey(e) {
      if (e.key !== "Escape" || settled) return;
      e.stopPropagation();
      finish(null, null);
      document.removeEventListener("keydown", onKey, true);
      if (typeof scrollChatBottom === "function") scrollChatBottom();
    }
    document.addEventListener("keydown", onKey, true);

    host.appendChild(row);
    if (typeof scrollChatBottom === "function") scrollChatBottom();
  });
};

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
  // Migration: older builds stored the Model Selection Mode fields inside the
  // bundled `settings` blob. They now live in their own scopedData keys. If any
  // legacy field is present on settings AND the new key is unset, seed the new
  // key from it, then delete the legacy field from `settings` so it is not
  // re-saved into the blob.
  {
    const legacyMap = {
      modelSelectionMode: "modelSelectionMode",
      alwaysModel: "alwaysModel",
      complexityModelLow: "complexityModelLow",
      complexityModelMedium: "complexityModelMedium",
      complexityModelHigh: "complexityModelHigh",
    };
    let migratedAny = false;
    for (const [legacyField, msKey] of Object.entries(legacyMap)) {
      if (settings[legacyField] != null) {
        try {
          const existing = await window.chatoss.scopedData.get(msKey);
          if (existing === undefined || existing === null) {
            await window.chatoss.scopedData.set(msKey, settings[legacyField]);
          }
        } catch (e) { /* non-fatal */ }
        delete settings[legacyField];
        migratedAny = true;
      }
    }
    if (migratedAny) saveSettings();
  }
  // Restore Model Selection Mode from its own scopedData keys, then render the UI.
  await loadModelSelection();
  // Restore the folder-trust policy ("ask" | "always").
  await loadTrustMode();
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
  if (el.detachBoardBtn) el.detachBoardBtn.addEventListener("click", detachBoard);
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

  // right column — both "new session" buttons open the SAME spawn modal
  const openManualSpawn = () => {
    openSpawnModal({ source: "manual" }).then((choice) => {
      if (!choice) return; // cancelled — session already started inside onSpawnStart
    });
  };
  el.newSessionBtn.addEventListener("click", openManualSpawn);
  if (el.newSessionBtn2) el.newSessionBtn2.addEventListener("click", openManualSpawn);

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

  // Model Selection Mode — radios toggle pickers live + persist immediately.
  el.modelModeRadios.addEventListener("change", (e) => {
    if (e.target && e.target.name === "model-mode") {
      showModelModePanel(e.target.value);
      saveModelSelectionMode();
    }
  });
  el.alwaysModel.addEventListener("change", saveModelSelectionMode);
  el.complexityModelLow.addEventListener("change", saveModelSelectionMode);
  el.complexityModelMedium.addEventListener("change", saveModelSelectionMode);
  el.complexityModelHigh.addEventListener("change", saveModelSelectionMode);

  el.rescanBtn.addEventListener("click", async () => {
    el.detectedList.innerHTML = "<div class='detected-scanning'>Scanning…</div>";
    await detectTools(true);
    renderDetectedList();
    // refresh the model pickers with the newly detected models, preserving
    // the saved selections where the model is still available.
    applyModelSelectionModeToUi();
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
  detectTools(true).catch((e) => console.warn("detect", e));
}

init().catch((e) => {
  console.error(e);
  el.loading.textContent = "Failed to start: " + (e && e.message ? e.message : String(e));
});
