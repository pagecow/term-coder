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

// Build the structured status + output block shared by read_session and
// wait_for_session. Returns a header line (status / exit code / working dir)
// followed by the clean terminal screen text. Preserves the trust-dialog
// masking so the orchestrator never sees raw "Do you trust..." text it would
// try to keystroke past.
async function formatSessionStatusOutput(s, statusOverride) {
  try {
    let clean = "(terminal is empty — no output yet)";
    if (s.session && typeof s.session.getOutput === "function") {
      const text = await s.session.getOutput();
      clean = text ? stripAnsi(text) : "(terminal is empty — no output yet)";
      // MASK the trust dialog from the orchestrator when user must approve it
      // in chat. If the orchestrator sees the raw "Do you trust..." text, it
      // will try to send keystrokes to bypass the pill picker. Hide it and
      // tell the orchestrator to wait for the user's answer.
      if ((s.trustState === "pending" || s.trustState === "asking") && s.trustMode !== "always" &&
          /trust\s*the\s*(files|contents|folder|directory)|trust\s*this\s*folder|do\s*you\s*trust|press\s*enter\s*to\s*continue/i.test(clean)) {
        return "Waiting for user approval: a 'trust this folder?' prompt is shown in chat. Do NOT send keystrokes to confirm it. The session will proceed once the user clicks Yes, or be killed if they click No.";
      }
    }
    let statusLine;
    if (statusOverride) {
      // Caller-supplied status line (e.g. wait_for_session's "STILL RUNNING
      // (timed out …)" message). Reuses the same output-fetch + trust-dialog
      // masking below so every session read masks the trust dialog uniformly.
      statusLine = statusOverride;
    } else if (s.active === false && s.exitCode !== undefined && s.exitCode !== null) {
      statusLine = "[SESSION: " + (s.label || s.id) + " | STATUS: EXITED | EXIT CODE: " + s.exitCode + "]";
    } else if (s.active === false) {
      // Exited but no exit code recorded (e.g. killed) — report "killed".
      statusLine = "[SESSION: " + (s.label || s.id) + " | STATUS: EXITED | EXIT CODE: killed]";
    } else {
      statusLine = "[SESSION: " + (s.label || s.id) + " | STATUS: RUNNING | EXIT CODE: n/a]";
    }
    const dirLine = "[WORKING DIR: " + (s.cwd || "(unknown)") + "]";
    return statusLine + "\n" + dirLine + "\n" + "------------------------------------------------------------\n" + clean;
  } catch (e) {
    return "Error: " + (e && e.message ? e.message : String(e));
  }
}

// Worktree metadata: branchName -> { wtPath, parentBranch, projectPath }.
// Tracks every worktree created by create_worktree so merge_worktree can find
// the parent branch to merge back into without the model having to remember it.
const worktreeMeta = new Map();

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
  chatScroll: $("chat-scroll"),
  chatOverlay: $("chat-overlay"),
  chatJumpBtn: $("chat-jump-btn"),
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
      description: "Create a git worktree (an isolated working directory on a new branch) inside the project's .chatoss/worktrees folder. If the project folder is NOT yet a git repo, it auto-initializes one (git init + initial commit) first. Returns JSON: { worktreePath, branch, parentBranch }. ALWAYS create a worktree before spawning each coding agent, and pass the worktreePath as cwd to start_cli_session. Use the active project unless projectId is given.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Optional. Defaults to the active project." },
          branchName: { type: "string", description: "Optional branch name. Defaults to worktree-<timestamp>. Use a descriptive name per subtask, e.g. visual-design, calendar-grid, dark-mode." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "merge_worktree",
      description: "Merge a worktree's branch back into its parent branch (e.g. main) in the project folder, then remove the worktree directory and delete the branch. Any uncommitted work in the worktree is committed first. Call this AFTER the coding agent in that worktree has finished its subtask. If there are merge conflicts, the worktree is preserved and you'll be told to resolve them. Pass branchName (from create_worktree's response) or worktreePath.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Optional. Defaults to the active project." },
          branchName: { type: "string", description: "The branch name returned by create_worktree. Preferred way to identify the worktree." },
          worktreePath: { type: "string", description: "Alternative: the worktree path returned by create_worktree." },
          parentBranch: { type: "string", description: "Optional. The branch to merge into. Defaults to the parent branch recorded at creation time (usually main)." },
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
      description: "Read the current output of a running CLI session — everything the terminal shows right now (up to ~64KB). The result now includes a STATUS HEADER showing whether the session is RUNNING or EXITED (with its exit code) and the working directory, followed by the clean terminal screen text. Use this to see what the agent has done, check for errors, or detect when a task is finished. For just waiting until an agent is done, prefer wait_for_session; to see all agents at once, use list_sessions.",
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
      name: "list_sessions",
      description: "List all terminal sessions with their status. Returns a summary of every coding agent session: id, label, working directory, whether it's still RUNNING or EXITED, and exit code. Use this to coordinate parallel agents — see which are still working and which are done.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wait_for_session",
      description: "Wait for a terminal session to exit (finish), then return its final status and last screen output. Use this instead of repeatedly calling read_session to poll — it blocks until the agent is done (up to the timeout), eliminating wasteful polling loops. Returns the session status (EXITED + exit code, or still RUNNING if timed out) and the terminal output.",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "The session id to wait for. Defaults to the most recently started session." },
          timeoutMs: { type: "number", description: "Maximum time to wait in milliseconds. Default 120000 (2 min). The call returns early if the session exits before the timeout." },
        },
      },
    },
  },
  {
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
  // CSI sequences: ESC [ ... <0x40-0x7E>. NOTE: do NOT consume spaces (0x20)
  // after the sequence — the previous regex had [ -\/]* which ate the space
  // between words in TUI output (e.g. "Do you trust the contents" became
  // "Doyoutrustthecontents"), breaking all regex-based startup detection.
  s = s.replace(/\x1b\[[0-9;?]*[@-~]/g, "");
  // OSC sequences: ESC ] ... BEL  or  ESC ] ... ESC \
  s = s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
  // Other 2-char ESC sequences (ESC + one char): ESC ( B, ESC = , etc.
  s = s.replace(/\x1b[@-_]/g, "");
  // Remaining stray ESCs and other C0 control chars (except \n, \r, \t) -> drop
  s = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  // Collapse runs of spaces that were separated by (now-removed) ANSI codes
  // down to a single space, so "Do  you  trust" -> "Do you trust". But preserve
  // leading spaces / indentation by only collapsing 2+ spaces to one.
  s = s.replace(/ {2,}/g, " ");
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
  // Codex (v0.147+) shows "model: loading" in its welcome box, then transitions
  // to "model: <name>" once the model is ready. We must NOT send the prompt
  // until the model has finished loading — otherwise the text lands in the
  // input box but Enter (\r) is ignored because the box isn't accepting
  // submissions yet. These flags track that transition.
  let modelLoading = false;
  let modelLoaded = false;
  let submitFallbackScheduled = false;

  const finish = async () => {
    if (settled) return;
    // NEVER auto-send the prompt while a trust dialog was seen but not yet
    // resolved. This is the core fix for Bug 1: previously the safety timeout
    // (or an early ready-state match) could call finish() which writes
    // prompt + "\r" — and the "\r" confirms the trust dialog's highlighted
    // "Yes" option WITHOUT ever showing the chat pill picker.
    if (sawTrust && !trustHandled) return;
    settled = true;
    try { unsub && unsub(); } catch (_) {}
    if (killed) return; // session was killed — don't send the prompt
    // Type the prompt, then press Enter. We send the text and the Enter key as
    // SEPARATE writes so a CLI that echoes input character-by-character has a
    // chance to render the full prompt before the submit keystroke arrives.
    //
    // BUG 2 FIX — robust submit: \r (carriage return) is the standard Enter in
    // a PTY, but some Codex versions submit on \n (line feed) instead. We send
    // \r first; if the task hasn't started ~400ms later we send \n as a
    // fallback. Both writes are guarded so that if \r already submitted the
    // task, the \n is just a harmless empty keystroke to the now-busy agent.
    await safe(() => session.write(prompt));
    await safe(() => session.write("\r"));
    if (!submitFallbackScheduled) {
      submitFallbackScheduled = true;
      setTimeout(() => {
        if (killed) return;
        try { session.write("\n"); } catch (_) {}
      }, 400);
    }
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
  //
  // BUG 1 FIX: We re-read the persisted trust policy FRESH from scopedData via
  // loadTrustMode() before checking trustMode. This eliminates any race where
  // the module-level variable is stale (e.g. the user changed it in Settings
  // after this session started, or loadTrustMode hadn't completed yet).
  // trustBusy MUST be set BEFORE the first await so the onData watcher pauses
  // while we load — no \r can leak to the PTY during the load.
  //
  // CRITICAL: trustBusy stays TRUE through confirmTrust()/denyTrust() and is
  // only cleared AFTER the trust \r (or the kill) has finished writing. If we
  // cleared it before the await in confirmTrust(), the onData watcher would
  // resume the instant the user answered, see trustHandled=true, and could call
  // finish() — writing prompt+"\r" CONCURRENTLY with the trust "\r" in a second
  // session.write() call. Two concurrent writes can interleave bytes in the PTY
  // (the prompt's \r landing before the trust \r, or the prompt text spliced
  // into the trust confirmation). Keeping trustBusy=true until the trust write
  // fully completes guarantees the watcher stays paused, so finish() can only
  // run on a LATER chunk (the post-trust welcome/input-prompt output) — exactly
  // the ordering we want.
  // Update the session registry so read_session can mask the trust dialog from
  // the orchestrator and avoid tempting it to send bypass keystrokes.
  const rec = sessions.get(session.id);
  if (rec) {
    rec.trustState = "pending";
    rec.trustMode = trustMode;
  }

  const handleTrust = async () => {
    trustBusy = true;
    if (rec) rec.trustState = "asking";
    try { await loadTrustMode(); } catch (_) {}
    if (trustMode === "always") {
      if (rec) rec.trustMode = "always";
      await confirmTrust();
      if (rec) rec.trustState = "confirmed";
      trustBusy = false;
      return;
    }
    if (rec) rec.trustMode = "ask";
    // trustMode === "ask" — ask in chat, wait for the answer.
    const ok = await askTrustInChat(folderLabel);
    if (settled) { trustBusy = false; return; } // safety timeout fired while waiting
    if (ok) {
      if (rec) rec.trustState = "confirmed";
      await confirmTrust();
    } else {
      if (rec) rec.trustState = "denied";
      await denyTrust();
    }
    trustBusy = false; // only now — after the trust \r / kill is fully written
  };

  let unsub = null;
  try {
    if (typeof session.onData === "function") {
      unsub = session.onData((chunk) => {
        if (settled || trustBusy) return; // don't act while waiting on the user
        buffer += chunk;
        const flat = stripAnsi(buffer).toLowerCase();
        // Per-chunk text for state tracking that depends on the LATEST output
        // (the accumulated buffer would keep stale "model: loading" text and
        // mask the transition to "model: <name>").
        const chunkFlat = stripAnsi(chunk).toLowerCase();

        // 1) Trust dialog. Match BOTH CLIs robustly:
        //    Claude Code: "Do you trust the files in this folder?"
        //    Codex:       "Do you trust the contents of this directory?"
        //                 + "Press enter to continue"
        //    Also catch "Yes, I trust this folder" / "Yes, continue".
        //    Use a flexible regex that tolerates missing spaces (stripAnsi may
        //    collapse some spaces in TUI output) and matches either CLI.
        if (!sawTrust && /trust\s*the\s*(files|contents|folder|directory)|trust\s*this\s*folder|do\s*you\s*trust/i.test(flat)) {
          sawTrust = true;
          handleTrust(); // fire-and-forget; it sets trustBusy while awaiting
          return;
        }

        // 2) Codex model-loading state (MUST run before the model-picker check
        //    below). Codex v0.147+ shows "model: loading" in its welcome box,
        //    then transitions to "model: <name>" once the model is ready. We
        //    detect this PER-CHUNK (using chunkFlat, not the accumulated `flat`)
        //    so the stale "loading" text in the buffer doesn't mask the
        //    transition to "model: <name>".
        //
        //    We must NOT send the prompt until the model has finished loading —
        //    otherwise the text lands in the input box but Enter (\r) is
        //    ignored because the box isn't accepting submissions yet (Bug 2).
        if (/model\s*:\s*loading/.test(chunkFlat)) {
          modelLoading = true;
          return; // wait — the input box isn't accepting submissions yet
        }
        if (modelLoading) {
          // Transition to a loaded model: a "model: <name>" line that is NOT
          // "model: loading", OR Codex's "/model to change" hint which only
          // appears once the model is ready.
          if ((/model\s*:\s*[a-z0-9_-]/.test(chunkFlat) && !/model\s*:\s*loading/.test(chunkFlat)) ||
              /\/\s*model\s*to\s*change/.test(chunkFlat)) {
            modelLoaded = true;
            modelLoading = false;
            // Fall through to the ready-state check below so the prompt is
            // sent as soon as the input box is visible.
          } else {
            return; // still loading — keep waiting
          }
        }

        // 3) Model picker MENU (a real interactive list the user must navigate).
        //    We do NOT pick here — the model was already passed via --model, OR
        //    the user picked it via Model Selection Mode pills. If a picker still
        //    shows, leave it to the orchestrator/user.
        //
        //    BUG 2 FIX: The old regex had a bare `\/model` alternative that
        //    matched Codex's harmless "/model to change" HINT (shown in the
        //    welcome box once the model loads — NOT a picker menu). That set
        //    modelPickerSeen=true, which then blocked the ready-state check
        //    (`!modelPickerSeen`) for the rest of startup, so the prompt was
        //    never sent until the 12s safety timeout — by which point the model
        //    might have only just loaded and the submit keystroke landed too
        //    early or was ignored. Removed the bare `\/model`; kept only the
        //    specific menu signatures that mean an actual interactive list.
        if (/select\s*model|navigate.*enter\s*select|choose\s*a\s*model|use\s*.*arrow.*enter.*select/.test(flat)) {
          modelPickerSeen = true;
          return;
        }

        // 4) Ready state: the CLI's input prompt is showing. Send the task now
        //    — but only if we're past the trust dialog (or never saw one), not
        //    blocked on a menu, and (for Codex) the model has finished loading.
        //    Match the input-prompt glyph for BOTH CLIs: Claude Code uses ❯
        //    (U+276F), Codex uses › (U+203A) — these are DIFFERENT characters.
        //    The old regex only had ❯ and anchored it with ^ (which, without
        //    the /m flag, only matches the start of the accumulated buffer, so
        //    it never fired once the buffer grew past the welcome box).
        if (!modelPickerSeen && (sawTrust ? trustHandled : true)) {
          if (modelLoading && !modelLoaded) return; // Codex still loading — wait
          if (/welcome\s*back|try\s*"how\s*do\s*i|what\s*would\s*you\s*like|how\s*can\s*i\s*help|enter\s*a\s*task|❯|›/.test(flat)) {
            finish();
          }
        }
      });
    }
  } catch (_) {}

  // Safety net: never hang. After 12s, send the prompt regardless of state —
  // the orchestrator can recover via read/send later. BUT never fire while
  // trustBusy is true (the user is answering the trust pill picker) OR while a
  // trust dialog was seen but not yet resolved (sawTrust && !trustHandled) —
  // firing in either case would write \r to the PTY and silently confirm trust
  // without asking, which is exactly Bug 1.
  setTimeout(() => {
    if (!settled && !trustBusy && !(sawTrust && !trustHandled)) finish();
  }, 12000);
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
        const base = p.folderPath.replace(/\/+$/, "");
        const branch = args.branchName || "worktree-" + Date.now();
        const wtPath = base + "/.chatoss/worktrees/" + branch;

        // Ensure the project is a git repo. `git worktree add` fails with
        // "fatal: not a git repository" on folders that were never `git init`'d.
        // Auto-initialize + make an initial commit so worktrees can branch off it.
        // This is idempotent: if a repo already exists, the init/commit are no-ops.
        const checkRepo = await window.chatoss.terminal.exec(
          loginShell("git rev-parse --is-inside-work-tree 2>/dev/null"),
          { cwd: base }
        );
        if (checkRepo === null) return "Error: terminal permission denied (approve git to continue)";
        const isRepo = (checkRepo.output || "").trim() === "true";
        if (!isRepo) {
          // Initialize the repo, add everything, and make an initial commit so
          // there's a HEAD for worktree branches to branch from.
          const initCmd = "git init && git add -A && git commit -m \"initial commit (auto-created by Term Coder for worktree isolation)\"";
          const initR = await window.chatoss.terminal.exec(loginShell(initCmd), { cwd: base });
          if (initR === null) return "Error: terminal permission denied (approve git to continue)";
          if (initR.exitCode !== 0) {
            return "Failed to auto-initialize git repo (exit " + initR.exitCode + "):\n" + initR.output +
              "\n\nThe project folder is not a git repository, so a worktree cannot be created. " +
              "Ask the user to initialize git in the project folder first.";
          }
        }

        // Make sure the parent directory for the worktree exists.
        await window.chatoss.terminal.exec(loginShell("mkdir -p \"" + base + "/.chatoss/worktrees\""), { cwd: base });

        // Determine the current (main) branch so we can branch the worktree off it
        // and later merge it back. We stash this in the session record's project
        // metadata so merge_worktree knows where to merge to.
        const branchR = await window.chatoss.terminal.exec(
          loginShell("git branch --show-current"),
          { cwd: base }
        );
        const mainBranch = (branchR && branchR.output || "").trim() || "main";

        const r = await window.chatoss.terminal.exec(
          loginShell(`git worktree add "${wtPath}" -b "${branch}" "${mainBranch}"`),
          { cwd: base }
        );
        if (r === null) return "Error: terminal permission denied (approve git to continue)";
        if (r.exitCode !== 0) return "git worktree failed (exit " + r.exitCode + "):\n" + r.output;

        // Track worktree metadata so merge_worktree can find the parent branch.
        worktreeMeta.set(branch, { wtPath, parentBranch: mainBranch, projectPath: base });
        return JSON.stringify({ worktreePath: wtPath, branch: branch, parentBranch: mainBranch });
      }
      case "merge_worktree": {
        // Merge a worktree's branch back into its parent branch and remove the
        // worktree directory. Pass branchName (from create_worktree's response)
        // or the worktree path directly.
        const p = resolveProject(args);
        if (!p) return "Error: no project selected. Ask the user to add a project folder first.";
        const base = p.folderPath.replace(/\/+$/, "");
        const branch = args.branchName || "";
        const meta = branch ? worktreeMeta.get(branch) : null;
        const wtPath = (meta && meta.wtPath) || (args.worktreePath || "").trim();
        const parentBranch = (meta && meta.parentBranch) || args.parentBranch || "main";
        if (!wtPath && !branch) return "Error: pass branchName or worktreePath so I know which worktree to merge.";

        // First commit any uncommitted work inside the worktree.
        if (wtPath) {
          const commitMsg = "worktree work: " + (branch || "merge");
          const commitR = await window.chatoss.terminal.exec(
            loginShell("git add -A && git commit -m " + JSON.stringify(commitMsg) + " --allow-empty"),
            { cwd: wtPath }
          );
          if (commitR === null) return "Error: terminal permission denied (approve git to continue)";
          // exitCode 0 = committed; non-zero with "nothing to commit" is fine.
        }

        // Switch to the parent branch in the MAIN project folder and merge.
        const mergeMsg = "Merge worktree branch " + (branch || "?") + " into " + parentBranch;
        const mergeR = await window.chatoss.terminal.exec(
          loginShell("git checkout " + JSON.stringify(parentBranch) + " && git merge --no-ff " + JSON.stringify(branch || "") + " -m " + JSON.stringify(mergeMsg)),
          { cwd: base }
        );
        if (mergeR === null) return "Error: terminal permission denied (approve git to continue)";
        let mergeOut = mergeR.output || "";
        if (mergeR.exitCode !== 0) {
          // Check for merge conflicts.
          if (/CONFLICT|conflict/i.test(mergeOut)) {
            return "Merge CONFLICT detected while merging branch " + branch + " into " + parentBranch + ":\n" + mergeOut +
              "\n\nThere are merge conflicts. The worktree is preserved at " + (wtPath || "(unknown)") +
              ". You should resolve the conflicts manually in the project folder, or ask the user to help.";
          }
          return "git merge failed (exit " + mergeR.exitCode + "):\n" + mergeOut;
        }

        // Clean up: remove the worktree directory and delete the branch.
        if (wtPath) {
          await window.chatoss.terminal.exec(loginShell("git worktree remove \"" + wtPath + "\" --force"), { cwd: base });
        }
        await window.chatoss.terminal.exec(loginShell("git branch -D \"" + branch + "\""), { cwd: base });
        if (meta) worktreeMeta.delete(branch);
        return "Merged branch " + branch + " into " + parentBranch + " successfully. Worktree cleaned up.\n" + mergeOut;
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
        // HARD GUARD: if the session is waiting on a "trust this folder?" prompt
        // and the user chose "Ask each time", ignore any keystrokes from the
        // orchestrator that could bypass the chat pill picker (Enter, arrows, Esc).
        // The only legitimate way through is for the user to click yes/no.
        let outputCheck = "";
        if (s.session && typeof s.session.getOutput === "function" && s.trustMode !== "always") {
          try { outputCheck = stripAnsi(await s.session.getOutput() || ""); } catch (_) {}
        }
        if ((s.trustState === "asking" || /trust\s*the\s*(files|contents|folder|directory)|trust\s*this\s*folder|do\s*you\s*trust|press\s*enter\s*to\s*continue/i.test(outputCheck)) && s.trustMode !== "always") {
          return "Blocked: this session is waiting for the user to approve 'trust this folder' in chat. Keystrokes cannot bypass the approval. Wait for the user to respond.";
        }
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
        // Now returns a structured header (status + exit code + working dir)
        // above the clean terminal text, so the orchestrator can tell at a
        // glance whether the session is still RUNNING or has EXITED.
        let s = args.sessionId ? sessions.get(args.sessionId) : null;
        if (!s && sessions.size) { s = [...sessions.values()].pop(); }
        if (!s) return "Error: no active sessions. Start one with start_cli_session first.";
        return await formatSessionStatusOutput(s);
      }
      case "list_sessions": {
        // Summarize every coding-agent session at a glance so the orchestrator
        // can coordinate parallel work without guessing from raw screen text.
        if (!sessions.size) return "No active sessions. Start one with start_cli_session first.";
        const recs = [...sessions.values()];
        let running = 0, exited = 0;
        const lines = recs.map((s) => {
          let statusPart;
          if (s.active === false) {
            exited++;
            const code = (s.exitCode !== undefined && s.exitCode !== null) ? s.exitCode : "killed";
            statusPart = "EXITED (code " + code + ")";
          } else {
            running++;
            statusPart = "RUNNING";
          }
          return "  [" + s.id + "] " + (s.label || s.id) + " | " + statusPart + " | " + (s.cwd || "(unknown)");
        });
        return "SESSIONS (" + recs.length + " total, " + running + " running, " + exited + " exited):\n" + lines.join("\n");
      }
      case "wait_for_session": {
        // Block until the given session exits (or the timeout expires), then
        // return its final status + last screen output. Replaces the wasteful
        // read_session polling loop that left tool chips stuck "loading".
        let s = args.sessionId ? sessions.get(args.sessionId) : null;
        if (!s && sessions.size) { s = [...sessions.values()].pop(); }
        if (!s) return "Error: no such session.";
        const timeout = args.timeoutMs || 120000;
        // Already exited — return immediately.
        if (s.active === false) return await formatSessionStatusOutput(s);
        // Still running — poll every 2s up to the timeout.
        const deadline = Date.now() + timeout;
        while (s.active !== false && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 2000));
        }
        if (s.active === false) return await formatSessionStatusOutput(s);
        // Timed out while still running — reuse the shared formatter so the
        // output fetch + ANSI stripping + trust-dialog masking stay uniform
        // across read_session / wait_for_session (a session that times out
        // while showing a "Do you trust this folder?" dialog would otherwise
        // leak the raw trust text to the orchestrator).
        return await formatSessionStatusOutput(
          s,
          "[SESSION: " + (s.label || s.id) + " | STATUS: STILL RUNNING (timed out after " + timeout + "ms)]"
        );
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

// Ask the user (IN CHAT, via the askChoice pill picker) whether to approve a
// potentially dangerous command the coding agent wants to run. Resolves true
// for "approve", false for "deny". Used by the persistent auto-approve watcher.
async function askCommandApproval(rec, commandText) {
  try {
    const short = commandText.length > 200 ? commandText.slice(0, 200) + "…" : commandText;
    const v = await window.termCoder.askChoice({
      prompt: "A coding agent wants to run a command that looks potentially destructive:\n\n" + short,
      options: [
        { label: "Yes, approve it", value: "yes" },
        { label: "No, deny it", value: "no" },
      ],
      style: "rect",
    });
    return v === "yes";
  } catch (e) {
    console.warn("askCommandApproval", e);
    return false;
  }
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

// ---------- Markdown renderer (self-contained, no dependencies) ----------
// Minimal, safe CommonMark-ish renderer: escapes HTML first, then applies
// block + inline transforms. Supports headings, fenced code blocks, tables,
// blockquotes, ordered/unordered lists, hr, bold/italic/strike/code, links,
// and inline code. Returns an HTML string.
function mdEscape(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Apply inline markdown (bold, italic, strike, code, links) to an already-
// escaped string. Order matters: inline code first (protect its contents),
// then links, then emphasis. Uses unique placeholder tokens to avoid
// colliding with text content.
function mdInline(escaped) {
  let out = escaped;
  const stash = [];
  const stashPush = (html) => { stash.push(html); return "\u0000" + (stash.length - 1) + "\u0000"; };

  // Inline code: `code`  (single or triple backticks allowed)
  out = out.replace(/```([^`]+)```|`([^`]+)`/g, (_m, a, b) =>
    stashPush('<code class="md-inline-code">' + mdEscape(a != null ? a : b) + "</code>"));

  // Links: [text](url)  — url must be http(s)/mailto only (no javascript:)
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text, url) => {
    const safe = /^(https?:\/\/|mailto:)/i.test(url) ? url : "#";
    return stashPush('<a href="' + mdEscape(safe) + '" target="_blank" rel="noopener noreferrer">' + text + "</a>");
  });

  // Bold: **text** or __text__
  out = out.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_m, a, b) =>
    stashPush("<strong>" + (a != null ? a : b) + "</strong>"));
  // Italic: *text* or _text_
  out = out.replace(/(^|[^*])\*([^*\n]+)\*|(^|[^_])_([^_\n]+)_/g, (m, p1, a, p2, b) =>
    (p1 || p2 || "") + stashPush("<em>" + (a != null ? a : b) + "</em>"));
  // Strikethrough: ~~text~~
  out = out.replace(/~~([^~]+)~~/g, (_m, a) => stashPush("<del>" + a + "</del>"));

  // Restore stashed HTML fragments.
  out = out.replace(/\u0000(\d+)\u0000/g, (_m, i) => stash[Number(i)] || "");
  return out;
}

// Render a single block of lines (already split) into HTML. Used for table rows,
// list items, paragraphs, etc.
function mdRenderTable(lines) {
  if (lines.length < 2) return null;
  const splitRow = (l) => l.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const header = splitRow(lines[0]);
  const sep = splitRow(lines[1]);
  if (!header.length || !sep.every((c) => /^:?-+:?$/.test(c))) return null;
  const rows = lines.slice(2).map(splitRow);
  let html = '<div class="md-table-wrap"><table class="md-table"><thead><tr>';
  for (const h of header) html += "<th>" + mdInline(h) + "</th>";
  html += "</tr></thead><tbody>";
  for (const r of rows) {
    html += "<tr>";
    for (let i = 0; i < header.length; i++) html += "<td>" + mdInline(r[i] || "") + "</td>";
    html += "</tr>";
  }
  html += "</tbody></table></div>";
  return html;
}

function mdRenderList(items, ordered) {
  // Detect GitHub-style task lists: every item starts with [ ] or [x].
  const allTasks = items.length > 0 && items.every((it) => /^\s*([-*+]|\d+\.)\s+\[[ xX]\]\s+/i.test(it));
  const tag = ordered ? "ol" : "ul";
  const cls = allTasks ? "md-list md-task-list" : "md-list";
  let html = '<' + tag + ' class="' + cls + '">';
  for (const it of items) {
    let body = it;
    if (allTasks) {
      const tm = it.match(/^\s*([-*+]|\d+\.)\s+\[([ xX])\]\s+(.*)$/i);
      const checked = tm && tm[2] && /[xX]/.test(tm[2]);
      body = tm ? tm[3] : it;
      const box = '<span class="md-task-box' + (checked ? " is-checked" : "") + '" aria-hidden="true">' +
        (checked ? "✓" : "") + "</span>";
      html += '<li class="md-task-item' + (checked ? " is-done" : "") + '">' + box + mdInline(mdEscape(body)) + "</li>";
    } else {
      const m = it.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/s);
      body = m ? m[3] : it;
      html += "<li>" + mdInline(mdEscape(body)) + "</li>";
    }
  }
  html += "</" + tag + ">";
  return html;
}

// Main markdown -> HTML. Code-fence contents are passed through RAW (then
// escaped + syntax-highlighted inside renderCodeBlockHtml); all other text is
// escaped first, then block + inline transforms are applied. Supports headings,
// fenced code blocks, tables, blockquotes, task lists, ordered/unordered lists,
// hr, bold/italic/strike/code, links, and inline code. Returns an HTML string.
function renderMarkdown(src) {
  if (!src) return "";
  const text = String(src).replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    let line = lines[i];

    // Fenced code block: ```lang ... ```  (raw content — handled specially)
    const fence = line.match(/^```(.*)$/);
    if (fence) {
      const lang = fence[1].trim();
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { code.push(lines[i]); i++; }
      i++; // skip closing fence
      out.push(renderCodeBlockHtml(code.join("\n"), lang));
      continue;
    }

    // Horizontal rule
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { out.push('<hr class="md-hr" />'); i++; continue; }

    // Heading: # .. ######
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lvl = h[1].length;
      out.push('<h' + lvl + ' class="md-h md-h' + lvl + '">' + mdInline(mdEscape(h[2])) + "</h" + lvl + ">");
      i++;
      continue;
    }

    // Blockquote: collect consecutive ">" lines
    if (/^>\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      out.push('<blockquote class="md-blockquote">' + mdInline(mdEscape(quote.join(" "))) + "</blockquote>");
      continue;
    }

    // Table: a line with | followed by a separator line
    if (line.indexOf("|") !== -1 && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      const tbl = [line];
      let j = i + 1;
      while (j < lines.length && lines[j].indexOf("|") !== -1 && lines[j].trim()) { tbl.push(lines[j]); j++; }
      const rendered = mdRenderTable(tbl);
      if (rendered) { out.push(rendered); i = j; continue; }
    }

    // List: collect consecutive list-item lines (mixed markers allowed, incl. task lists)
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const items = [];
      let ordered = /^\s*\d+\.\s+/.test(line);
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i]);
        i++;
      }
      out.push(mdRenderList(items, ordered));
      continue;
    }

    // Blank line -> paragraph break
    if (line.trim() === "") { i++; continue; }

    // Paragraph: collect consecutive non-blank, non-block lines
    const para = [];
    while (i < lines.length && lines[i].trim() !== "" &&
      !/^```/.test(lines[i]) && !/^#{1,6}\s+/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) && !/^\s*([-*+*]|\d+\.)\s+/.test(lines[i]) &&
      !/^\s*([-*_])\1{2,}\s*$/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    if (para.length) out.push("<p>" + mdInline(mdEscape(para.join("\n"))).replace(/\n/g, "<br>") + "</p>");
  }
  return out.join("");
}

// ---------- Dependency-free syntax highlighting ----------
// A tiny, safe tokenizer that wraps tokens in <span class="tok-…">. It operates
// on RAW code (not yet HTML-escaped) and escapes each token as it emits it, so
// it is XSS-safe. Languages share a generic pass; a few (js/ts/json/css) get a
// richer keyword/operator set. No external library, no build step.

const HL_KEYWORDS = {
  js: "const let var function return if else for while do switch case break continue new class extends super this typeof instanceof void delete in of async await yield import export default from as try catch finally throw static get set null undefined true false NaN Infinity",
  ts: "const let var function return if else for while do switch case break continue new class extends super this typeof instanceof void delete in of async await yield import export default from as try catch finally throw static get set null undefined true false NaN Infinity public private protected readonly enum interface type namespace implements abstract declare",
  jsx: "const let var function return if else for while do switch case break continue new class extends super this typeof instanceof void delete in of async await yield import export default from as try catch finally throw static get set null undefined true false NaN Infinity",
  tsx: "const let var function return if else for while do switch case break continue new class extends super this typeof instanceof void delete in of async await yield import export default from as try catch finally throw static get set null undefined true false NaN Infinity public private protected readonly enum interface type namespace implements abstract declare",
  json: "true false null",
  py: "def class return if elif else for while break continue pass import from as with try except finally raise lambda global nonlocal yield async await is in not and or None True False self print",
  sh: "if then fi else elif case esac for while do done function return export local echo read source unset set in",
  go: "func var const type struct interface return if else for range switch case default break continue go defer chan map package import fallthrough nil true false",
  rust: "fn let mut const static struct enum impl trait return if else for while loop match break continue as use pub mod ref move self Self dyn unsafe extern crate type where async await",
  sql: "SELECT FROM WHERE INSERT INTO UPDATE DELETE CREATE TABLE ALTER DROP JOIN LEFT RIGHT INNER OUTER ON GROUP BY ORDER HAVING LIMIT OFFSET VALUES SET NULL NOT AND OR AS DISTINCT PRIMARY KEY FOREIGN REFERENCES DEFAULT UNIQUE INDEX",
};

function hlLangFor(lang) {
  const l = String(lang || "").toLowerCase().replace(/^x-/, "").replace(/\.(.*)$/, "$1");
  if (HL_KEYWORDS[l]) return l;
  if (l === "javascript" || l === "js") return "js";
  if (l === "typescript" || l === "ts") return "ts";
  if (l === "jsx") return "jsx";
  if (l === "tsx") return "tsx";
  if (l === "python" || l === "py" || l === "py3") return "py";
  if (l === "bash" || l === "sh" || l === "shell" || l === "zsh") return "sh";
  if (l === "golang" || l === "go") return "go";
  if (l === "rs" || l === "rust") return "rust";
  if (l === "sql" || l === "psql") return "sql";
  return l || "code";
}

// Tokenize a single line into [{t: type, v: raw}] pieces. The tokenizer is a
// single ordered regex pass per line, which is plenty for read-only previews.
function hlLine(raw, langKey) {
  const kw = HL_KEYWORDS[langKey] ? HL_KEYWORDS[langKey].split(" ") : null;
  const kwSet = kw ? new Set(kw) : null;
  // Order: comments, strings, numbers, then identifiers/words, then operators/punct.
  const tokenRe = /(#.*$|\/\/.*$|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b0x[0-9a-fA-F]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([A-Za-z_$][A-Za-z0-9_$]*)|(\s+)|([^\sA-Za-z0-9_$]+)/g;
  const out = [];
  let m;
  while ((m = tokenRe.exec(raw)) !== null) {
    if (m[1] !== undefined) out.push({ t: "comment", v: m[1] });
    else if (m[2] !== undefined) out.push({ t: "string", v: m[2] });
    else if (m[3] !== undefined) out.push({ t: "num", v: m[3] });
    else if (m[4] !== undefined) {
      const w = m[4];
      if (kwSet && kwSet.has(w)) out.push({ t: "kw", v: w });
      else if (/^[A-Z][A-Za-z0-9_]*$/.test(w)) out.push({ t: "type", v: w });
      else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(w) && raw[tokenRe.lastIndex] === "(") out.push({ t: "fn", v: w });
      else out.push({ t: "word", v: w });
    } else if (m[5] !== undefined) out.push({ t: "ws", v: m[5] });
    else if (m[6] !== undefined) out.push({ t: "op", v: m[6] });
  }
  return out;
}

function hlEscape(s) {
  return String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

// Highlight raw code into an HTML string of <span> tokens, one line per row so
// long lines scroll horizontally without reflowing tokens.
function highlightCode(raw, lang) {
  const langKey = hlLangFor(lang);
  const lines = String(raw == null ? "" : raw).split("\n");
  let html = "";
  for (let li = 0; li < lines.length; li++) {
    const toks = hlLine(lines[li], langKey);
    let lineHtml = "";
    for (const tk of toks) {
      if (tk.t === "ws" || tk.t === "word") { lineHtml += hlEscape(tk.v); continue; }
      lineHtml += '<span class="tok-' + tk.t + '">' + hlEscape(tk.v) + "</span>";
    }
    if (lineHtml === "" && li < lines.length - 1) lineHtml = " ";
    html += lineHtml;
    if (li < lines.length - 1) html += "\n";
  }
  return html;
}

// Build the HTML for a fenced code block: syntax-highlighted code + language
// label + copy button. The copy button uses data-code-copy which a delegated
// click listener copies to the clipboard.
function renderCodeBlockHtml(rawCode, lang) {
  const langLabel = lang ? mdEscape(lang) : "";
  const langKey = hlLangFor(lang);
  const id = "code-" + (crypto.randomUUID ? crypto.randomUUID() : "c" + Date.now() + Math.random().toString(36).slice(2));
  const highlighted = highlightCode(rawCode, langKey);
  return (
    '<div class="md-code-block" data-lang="' + langKey + '">' +
      '<div class="md-code-head">' +
        '<span class="md-code-lang">' + (langLabel || "code") + "</span>" +
        '<button class="md-code-copy" type="button" data-code-copy="' + id + '" title="Copy code" aria-label="Copy code"><span class="md-code-copy-ic">⧉</span>Copy</button>' +
      "</div>" +
      '<pre class="md-code-pre"><code id="' + id + '">' + highlighted + "</code></pre>" +
    "</div>"
  );
}

// Copy text to the clipboard, preferring the platform clipboardWrite API and
// falling back to a hidden textarea + execCommand('copy'). Resolves a bool.
async function copyToClipboard(text) {
  try {
    if (window.chatoss && window.chatoss.clipboard && window.chatoss.clipboard.writeText) {
      return await window.chatoss.clipboard.writeText(String(text));
    }
  } catch (e) { /* fall through */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = String(text);
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch (e) { return false; }
}

// ---------- Collapsible thinking widget ----------
function createThinkingWidget(text, opts) {
  const o = opts || {};
  const wrap = document.createElement("div");
  wrap.className = "msg-thinking-collapsible" + (o.streaming ? " is-streaming" : "");
  wrap.setAttribute("data-state", "collapsed");

  const header = document.createElement("button");
  header.type = "button";
  header.className = "think-toggle";
  header.setAttribute("aria-expanded", "false");
  const icon = document.createElement("span");
  icon.className = "think-icon";
  icon.textContent = "💭";
  const caret = document.createElement("span");
  caret.className = "think-caret";
  caret.textContent = "▸";
  const label = document.createElement("span");
  label.className = "think-label";
  label.textContent = o.streaming ? "Thinking…" : "Thought process";
  const meta = document.createElement("span");
  meta.className = "think-meta";
  meta.textContent = "";
  header.appendChild(icon);
  header.appendChild(caret);
  header.appendChild(label);
  header.appendChild(meta);

  const body = document.createElement("div");
  body.className = "think-body";
  const inner = document.createElement("div");
  inner.className = "think-inner";
  inner.textContent = String(text || "");
  body.appendChild(inner);

  wrap.appendChild(header);
  wrap.appendChild(body);

  header.addEventListener("click", () => {
    const open = wrap.getAttribute("data-state") === "open";
    wrap.setAttribute("data-state", open ? "collapsed" : "open");
    header.setAttribute("aria-expanded", open ? "false" : "true");
  });
  // Expose updaters for streaming.
  wrap._update = (newText) => {
    inner.textContent = String(newText || "");
    if (!o.streaming) return;
    const words = String(newText || "").trim().split(/\s+/).filter(Boolean).length;
    meta.textContent = words ? words + " words" : "";
  };
  // When streaming ends, switch label from "Thinking…" to "Thought process".
  wrap._finalize = () => {
    wrap.classList.remove("is-streaming");
    label.textContent = "Thought process";
  };
  return wrap;
}

// ---------- Tool-call activity chip ----------
// Creates a compact inline chip: "▶ tool_name" with a spinner while running,
// then a green check when done. Clicking expands the args/result detail.
function createToolChip(name, args) {
  const chip = document.createElement("div");
  chip.className = "tool-chip";
  chip.setAttribute("data-state", "collapsed");

  const head = document.createElement("button");
  head.type = "button";
  head.className = "tool-chip-head";
  const icon = document.createElement("span");
  icon.className = "tool-chip-icon";
  icon.innerHTML = '<span class="tool-chip-play">▶</span><span class="tool-chip-spinner"></span>';
  const label = document.createElement("span");
  label.className = "tool-chip-name";
  label.textContent = name || "tool";
  const caret = document.createElement("span");
  caret.className = "tool-chip-caret";
  caret.textContent = "▸";
  head.appendChild(icon);
  head.appendChild(label);
  head.appendChild(caret);

  const detail = document.createElement("div");
  detail.className = "tool-chip-detail";
  const argLine = document.createElement("div");
  argLine.className = "tool-chip-args";
  argLine.textContent = JSON.stringify(args || {}, null, 2);
  detail.appendChild(argLine);
  const resultLabel = document.createElement("div");
  resultLabel.className = "tool-chip-result-label";
  resultLabel.textContent = "Result";
  detail.appendChild(resultLabel);
  const resultLine = document.createElement("div");
  resultLine.className = "tool-chip-result";
  detail.appendChild(resultLine);

  chip.appendChild(head);
  chip.appendChild(detail);

  head.addEventListener("click", () => {
    const open = chip.getAttribute("data-state") === "open";
    chip.setAttribute("data-state", open ? "collapsed" : "open");
  });

  const markDone = (mark) => {
    icon.innerHTML = mark;
    chip.classList.add("is-done");
  };
  chip._setResult = (res) => {
    markDone('<span class="tool-chip-done">✓</span>');
    const txt = String(res == null ? "" : res);
    // Truncate very long results in the detail view but keep full text via title.
    resultLine.textContent = txt.length > 1200 ? txt.slice(0, 1200) + "\n…(truncated)" : txt;
  };
  chip._setError = (err) => {
    icon.innerHTML = '<span class="tool-chip-error">✕</span>';
    chip.classList.add("is-error");
    resultLabel.textContent = "Error";
    resultLine.textContent = String(err || "error");
  };
  return chip;
}

// ---------- Chat scroll management ----------
// autoScroll tracks whether we should keep the log pinned to the bottom while
// streaming. It is set false when the user scrolls up and re-enabled on
// jump-to-latest / new conversation render.
let chatAutoScroll = true;
function chatScrollListener() {
  if (!el.chatScroll) return;
  const sc = el.chatScroll;
  const atBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 60;
  chatAutoScroll = atBottom;
  if (el.chatJumpBtn) el.chatJumpBtn.classList.toggle("hidden", atBottom);
}
function scrollChatBottom(smooth) {
  if (!el.chatScroll) { if (el.chatLog) el.chatLog.scrollTop = el.chatLog.scrollHeight; return; }
  const sc = el.chatScroll;
  if (smooth) { sc.scrollTo({ top: sc.scrollHeight, behavior: "smooth" }); }
  else { sc.scrollTop = sc.scrollHeight; }
  chatAutoScroll = true;
  if (el.chatJumpBtn) el.chatJumpBtn.classList.add("hidden");
}
function maybeScrollChatBottom() { if (chatAutoScroll) scrollChatBottom(false); }

// ---------- Typing indicator ----------
function createTypingIndicator() {
  const row = document.createElement("div");
  row.className = "msg assistant typing-row";
  const dots = document.createElement("div");
  dots.className = "typing-dots";
  for (let i = 0; i < 3; i++) {
    const d = document.createElement("span");
    d.className = "typing-dot";
    dots.appendChild(d);
  }
  row.appendChild(dots);
  return row;
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
    chatAutoScroll = true;
    if (el.chatJumpBtn) el.chatJumpBtn.classList.add("hidden");
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
  // After a full history render, pin to the bottom and reset auto-scroll.
  chatAutoScroll = true;
  scrollChatBottom(false);
}
function renderMessage(m) {
  const role = m.role || "system";
  // Collapsible thinking widget (rendered ABOVE the message body).
  if (m.thinking) {
    const th = createThinkingWidget(m.thinking, { streaming: false });
    el.chatLog.appendChild(th);
  }
  const row = document.createElement("div");
  row.className = "msg " + role;

  // Role avatar — a small glyph label to the left of the bubble (Codex-style).
  const avatar = document.createElement("div");
  avatar.className = "msg-avatar";
  if (role === "user") { avatar.textContent = "You"; avatar.classList.add("avatar-user"); }
  else if (role === "assistant") { avatar.textContent = "◆"; avatar.classList.add("avatar-assistant"); }
  else { avatar.textContent = "•"; avatar.classList.add("avatar-system"); }

  const col = document.createElement("div");
  col.className = "msg-col";

  // Role label row (hidden for system pills).
  if (role !== "system") {
    const lab = document.createElement("div");
    lab.className = "msg-role";
    lab.textContent = role === "user" ? "You" : "Orchestrator";
    col.appendChild(lab);
  }

  const body = document.createElement("div");
  body.className = "msg-body";
  if (role === "assistant") {
    body.innerHTML = renderMarkdown(m.content || "");
  } else if (role === "user") {
    body.innerHTML = renderMarkdown(m.content || "");
  } else {
    // System messages: keep plain (escaped) text, no markdown.
    body.innerHTML = m.content ? m.content.split(/\n\n+/).map((p) => "<p>" + esc(p).replace(/\n/g, "<br>") + "</p>").join("") : "";
  }
  col.appendChild(body);
  // Tool-call activity chips (collapsed by default).
  if (m.toolCalls && m.toolCalls.length) {
    const wrap = document.createElement("div");
    wrap.className = "msg-tools";
    for (const t of m.toolCalls) {
      const chip = createToolChip(t.name, t.args || {});
      if (t.result != null) chip._setResult(t.result);
      if (t.error) chip._setError(t.error);
      wrap.appendChild(chip);
    }
    col.appendChild(wrap);
  }
  if (role !== "system") { row.appendChild(avatar); }
  row.appendChild(col);
  el.chatLog.appendChild(row);
  return row;
}

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
    "You build software by DECOMPOSING the user's request into independent parallel subtasks, spawning a sub-agent CLI coding session (claude, codex, etc.) for EACH subtask in its own isolated git worktree, monitoring all of them, and merging the results back together.",
    "",
    "IMPORTANT — tool arguments: most tools work with NO arguments because they default to the active project and the attached board. Do NOT invent ids. If you are unsure, call the tool with {} and it will use the current context.",
    "",
    "IMPORTANT: every sub-agent session requires the USER's approval. When you call start_cli_session, a confirmation dialog appears and the user chooses the CLI and model — you just supply the working directory and a task prompt, then wait for the returned session id.",
    "",
    "═══════════════════════════════════════════════════════════════",
    "CORE STRATEGY: PARALLEL MULTI-AGENT DELEGATION",
    "═══════════════════════════════════════════════════════════════",
    "",
    "Your primary job is to decompose a task into INDEPENDENT, PARALLELIZABLE subtasks and spawn a separate coding agent for each — NOT one monolithic agent. This is the #1 thing that makes you effective.",
    "",
    "STEP 1 — DECOMPOSE the task into independent subtasks.",
    "  • Break the user's request into 2–5 subtasks that can be developed in parallel.",
    "  • Each subtask should touch DIFFERENT files, or different sections of the same file, to minimize merge conflicts.",
    "  • Scope each subtask narrowly and clearly. A subtask like \"improve the visual design system\" is good; \"improve everything\" is bad.",
    "  • If two subtasks MUST touch the same file(s), run those subtasks SEQUENTIALLY (one after the other), not in parallel. Parallel subtasks must be file-disjoint.",
    "  • Example: 'improve the UX/UI of a calendar app' should decompose into:",
    "      Agent 1: Visual design system (colors, typography, spacing, CSS variables) — touches style.css only",
    "      Agent 2: Calendar grid + view switching (month/week/day) — touches calendar.js + grid template",
    "      Agent 3: Event management UI (forms, modals, color pickers) — touches events.js + form template",
    "      Agent 4: Dark mode + accessibility + responsive breakpoints — touches responsive.css + a11y attrs",
    "  • Tell the user your decomposition plan in chat BEFORE you start spawning, so they can adjust it.",
    "",
    "STEP 2 — CREATE A WORKTREE for each subtask (one per agent, ALWAYS).",
    "  • For EACH subtask, call create_worktree({ branchName: <descriptive name> }) to get an isolated working directory.",
    "  • create_worktree returns JSON: { worktreePath, branch, parentBranch }. Save these — you need worktreePath and branch later.",
    "  • If the project folder isn't a git repo yet, create_worktree auto-initializes one (git init + initial commit) — you don't need to do anything extra.",
    "  • NEVER spawn a coding agent directly in the project folder. ALWAYS create a worktree first and pass its worktreePath as cwd to start_cli_session. This prevents parallel agents from stomping on each other's changes.",
    "  • Create ALL the worktrees you need up front (or in batches) before spawning agents.",
    "",
    "STEP 3 — SPAWN a coding agent for each subtask (in parallel where possible).",
    "  • For each subtask, call start_cli_session({ cwd: <worktreePath>, taskPrompt: <the subtask instructions> }) to spin up a coding agent in that worktree.",
    "  • Give each agent a FOCUSED, DETAILED task prompt — exactly what files to create/modify, what behavior to implement, and any constraints. The sub-agent writes the code, not you.",
    "  • Spawn subtasks that are file-disjoint ALL AT ONCE (or in rapid succession). The app supports multiple simultaneous terminal sessions.",
    "  • Spawn subtasks that share files SEQUENTIALLY — wait for the first agent to finish and merge before spawning the next one that touches the same files.",
    "  • Each start_cli_session returns a session id. SAVE every session id so you can monitor each agent independently.",
    "",
    "STEP 4 — MONITOR each agent independently with read_session, list_sessions, and wait_for_session.",
    "  • Use list_sessions({}) to see ALL agents at once — a summary of every session with its id, label, working directory, and whether it is RUNNING or EXITED (with exit code). This is the quickest way to check on parallel agents.",
    "  • Use read_session({ sessionId: <id> }) to check on a specific agent. The result now starts with a STATUS HEADER like '[SESSION: <label> | STATUS: RUNNING | EXIT CODE: n/a]' or '[SESSION: <label> | STATUS: EXITED | EXIT CODE: 0]', followed by the working dir and the CLEAN terminal screen text (ANSI escapes stripped). Read the header first to know instantly whether the agent is still working or finished.",
    "  • PREFER wait_for_session({ sessionId: <id>, timeoutMs: 120000 }) when you just want an agent to finish — it blocks until the session exits (or the timeout) and returns the same status header + output. This eliminates wasteful read_session polling loops that leave tool chips stuck 'loading' and hang the orchestrator. Call it once per agent instead of polling read_session in a loop.",
    "  • Report progress on ALL agents to the user — which are still working, which are done, which hit errors.",
    "  • Use send_to_session({ sessionId: <id>, text }) ONLY for follow-up instructions AFTER an agent's input box is accepting text — not for startup dialogs.",
    "  • Do NOT loop read_session rapidly. Prefer wait_for_session to block for completion, or list_sessions to check status without dumping output. Only call read_session when you need to read the actual terminal text.",
    "  • send_to_session parses escape codes: use \\r for Enter, \\x1b[A / \\x1b[B for arrows, etc. But you almost never need it for startup.",
    "  • NEVER try to confirm or send keystrokes to the agent's 'trust this folder?' dialog yourself. That dialog is handled by the app's settings and/or a chat pill picker. If the session keeps showing the trust dialog, you may say in chat that the agent is waiting for trust approval — but do NOT send \\r or arrow keys to it.",
    "  • NEVER try to select a model by sending arrow keys to an interactive model menu. The user already chooses the model when they approve the session spawn (or via Model Selection Mode in Settings). If read_session still shows a model picker, STOP and ask the user to pick the model in Settings or in the spawn dialog.",
    "  • The session auto-handles startup: trust confirmation (or asking you in chat) and typing/submitting the taskPrompt once the agent is ready. You just call start_cli_session, then wait and use read_session / wait_for_session to watch. Do not re-send the initial task.",
    "  • The session ALSO auto-handles command approvals: when the coding agent (Codex) asks 'Yes, proceed?' before running a command, the app auto-approves safe commands (cd, ls, grep, cat, git add, etc.) and only asks the user in chat for destructive ones (rm -rf, delete, drop, force push, etc.). You do NOT need to send \\r or Esc to these approval prompts yourself — the app does it for you. Just keep monitoring with read_session / list_sessions.",
    "  • If read_session returns 'Error: no such terminal session' shortly after start, the session was killed. Do NOT immediately re-call start_cli_session with the same args — that creates a loop. Instead explain what happened (likely trust declined) and ask the user how to proceed.",
    "",
    "STEP 5 — MERGE each worktree back to the parent branch when its agent is done.",
    "  • When an agent is done (read_session status header shows EXITED, or wait_for_session returns), call merge_worktree({ branchName: <branch from create_worktree> }) to merge that worktree's branch back into the parent branch (usually main) and clean up the worktree directory.",
    "  • Merge agents ONE AT A TIME as they finish. Do not wait for ALL agents before merging — merge each as soon as it's done.",
    "  • Before merging the LAST worktree, call list_sessions({}) to confirm that ALL agents have EXITED (none still RUNNING). If any agent is still running, wait for it with wait_for_session before doing the final merge.",
    "  • If merge_worktree reports CONFLICTS, the worktree is preserved. Tell the user which subtask conflicted and that manual resolution is needed, or spawn a follow-up agent in the worktree to resolve the conflicts.",
    "  • After all worktrees are merged, do a final read_session on the main project to verify the combined result, or inspect with list_project_files.",
    "",
    "STEP 6 — Complete the task.",
    "  • When all agents are done and all worktrees merged, summarize what was accomplished.",
    "  • Read the attached Kanban board with get_board({}) and call update_card({ cardId, done:true }) to mark the task complete (if a card exists for it).",
    "",
    "═══════════════════════════════════════════════════════════════",
    "CONFLICT AWARENESS",
    "═══════════════════════════════════════════════════════════════",
    "",
    "The reason for worktrees + file-disjoint decomposition is to avoid merge conflicts. Follow these rules:",
    "  • PARALLEL subtasks must touch disjoint sets of files. If subtask A and subtask B both modify style.css, they WILL conflict on merge.",
    "  • If two subtasks must touch the same file, run them SEQUENTIALLY: complete and merge subtask A first, THEN create a fresh worktree (which will include A's merged changes) for subtask B.",
    "  • When in doubt about file overlap, run sequentially. Correctness > speed.",
    "  • A subtask that touches MANY files across the project (e.g. 'add dark mode everywhere') is fine in parallel as long as no OTHER parallel subtask touches those same files.",
    "",
    "═══════════════════════════════════════════════════════════════",
    "WHEN TO USE A SINGLE AGENT",
    "═══════════════════════════════════════════════════════════════",
    "",
    "Not every task needs parallelism. Use a SINGLE agent (one worktree, one session) when:",
    "  • The task is small and focused (one bug fix, one small feature, one file).",
    "  • The task is inherently sequential and can't be split into file-disjoint pieces.",
    "  • The user explicitly asks for a single approach.",
    "Still ALWAYS create a worktree first, even for a single agent.",
    "",
    "═══════════════════════════════════════════════════════════════",
    "",
    "ACT, don't just explore. When the user asks you to build or change something, your job is to DECOMPOSE the task, create worktrees, SPIN UP coding agents (start_cli_session) to do the work in their own terminals, coordinate them by reading their output (read_session) and sending follow-up instructions (send_to_session), and MERGE the results back (merge_worktree). Don't try to write all the code yourself in chat; delegate it to sub-agents.",
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
  scrollChatBottom(false);

  setRunning(true);
  setStatus("Generating…");
  abortController = new AbortController();
  chatAutoScroll = true;

  // Snapshot the picker choices onto the conversation so history replays
  // with the same model/effort that was actually used.
  const modelId = selectedModel() || defaultModelId;
  const modelInfo = models.find((m) => m.id === modelId);
  const canThink = !!(modelInfo && modelInfo.capabilities && modelInfo.capabilities.includes("reasoning"));
  const effort = selectedEffort();
  if (modelId) { c.modelId = modelId; }
  if (canThink && effort) { c.effort = effort; } else { c.effort = null; }
  saveState();

  // Typing indicator — shown until the first content token streams in.
  const typingRow = createTypingIndicator();
  el.chatLog.appendChild(typingRow);
  maybeScrollChatBottom();

  // Live assistant row — MUST be in the DOM before streaming so tokens are
  // visible and tool chips can be inserted before it. Hidden until first token.
  const liveRow = document.createElement("div");
  liveRow.className = "msg assistant is-streaming";
  liveRow.style.display = "none";
  const liveAvatar = document.createElement("div");
  liveAvatar.className = "msg-avatar avatar-assistant";
  liveAvatar.textContent = "◆";
  const liveCol = document.createElement("div");
  liveCol.className = "msg-col";
  const liveLabel = document.createElement("div");
  liveLabel.className = "msg-role";
  liveLabel.textContent = "Orchestrator";
  const liveBody = document.createElement("div");
  liveBody.className = "msg-body";
  liveCol.appendChild(liveLabel);
  liveCol.appendChild(liveBody);
  liveRow.appendChild(liveAvatar);
  liveRow.appendChild(liveCol);
  el.chatLog.appendChild(liveRow);

  let liveThink = null;
  let accContent = "";
  let accThink = "";
  const liveToolCalls = [];
  let firstTokenSeen = false;

  // rAF-throttled re-render so a burst of tokens only repaints once per frame —
  // keeps streaming smooth with no layout jank. The streaming cursor is shown
  // while tokens are incoming and removed on the final render.
  let rafId = 0;
  const flushContent = () => {
    rafId = 0;
    liveBody.innerHTML = renderMarkdown(accContent) + '<span class="md-stream-cursor" aria-hidden="true"></span>';
    maybeScrollChatBottom();
  };
  const scheduleFlush = () => {
    if (rafId) return;
    rafId = requestAnimationFrame(flushContent);
  };

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
        if (!firstTokenSeen) {
          firstTokenSeen = true;
          typingRow.remove();
          liveRow.style.display = "";
        }
        accContent += t;
        scheduleFlush();
      },
      onThinking: (t) => {
        if (!t) return;
        if (!firstTokenSeen) {
          // Thinking before content: drop the typing dots, keep live row hidden.
          firstTokenSeen = true;
          typingRow.remove();
        }
        if (!liveThink) {
          liveThink = createThinkingWidget("", { streaming: true });
          el.chatLog.insertBefore(liveThink, liveRow);
        }
        accThink += t;
        liveThink._update(accThink);
        maybeScrollChatBottom();
      },
      onToolCall: async (call) => {
        const { name, args } = normalizeToolCall(call);
        const entry = { name, args, result: undefined, error: undefined };
        liveToolCalls.push(entry);
        if (!firstTokenSeen) {
          firstTokenSeen = true;
          typingRow.remove();
          liveRow.style.display = "";
        }
        // Render a compact activity chip before the live assistant row.
        const chip = createToolChip(name, args);
        el.chatLog.insertBefore(chip, liveRow);
        maybeScrollChatBottom();
        try {
          const res = await toolHandler(name, args);
          entry.result = res;
          chip._setResult(res);
          return res; // string result feeds back into the engine's tool loop
        } catch (e) {
          const err = "Error: " + (e && e.message ? e.message : String(e));
          entry.error = err;
          chip._setError(err);
          return err;
        }
      },
      think: canThink,                       // only thinking-capable models get think:true
      thinkLevel: canThink && effort ? effort : undefined,
      signal: abortController.signal,
    });

    // Flush any tail content that was queued behind a rAF, then drop the cursor.
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    liveBody.innerHTML = renderMarkdown(accContent);
    if (liveThink) liveThink._finalize();

    const content = result && result.content ? result.content : accContent;
    const thinking = result && result.thinking ? result.thinking : accThink;

    if (result && result.aborted) {
      setStatus("Stopped");
    } else {
      setStatus("");
    }

    typingRow.remove();
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
    maybeScrollChatBottom();
  } catch (e) {
    typingRow.remove();
    liveRow.remove();
    if (liveThink) liveThink.remove();
    setStatus("");
    const msg = "Error: " + (e && e.message ? e.message : String(e));
    c.messages.push({ role: "system", content: msg });
    saveState();
    renderMessage({ role: "system", content: msg });
    maybeScrollChatBottom();
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

  const rec = { id: session.id, session, cmd, args, cwd, label, active: true, exitCode: null, squareEl: square, mountEl, dispose: null, expanded: false, trustState: "pending", trustMode: null, autoApproveBusy: false, autoApproveUnsub: null };
  sessions.set(session.id, rec);

  // ---------- Persistent command-approval watcher ----------
  // After startup, Codex shows a command-approval prompt before running each
  // command: "1. Yes, proceed (y)  2. Yes, and don't ask again...  3. No..."
  // We auto-approve SAFE commands (press Enter) and ask the user in chat before
  // approving DANGEROUS ones (rm, delete, drop, format, etc.).
  try {
    if (typeof session.onData === "function") {
      let approvalBuffer = "";
      rec.autoApproveUnsub = session.onData((chunk) => {
        if (!rec.active || rec.autoApproveBusy) return;
        approvalBuffer += chunk;
        const flat = stripAnsi(approvalBuffer).toLowerCase();
        // Codex's command-approval prompt signatures
        if (!/yes,\s*proceed|press\s*enter\s*to\s*confirm|yes,\s*and\s*don'?t\s*ask\s*again/.test(flat)) return;

        // Already handled? Check if the approval prompt is still on screen.
        // (The buffer accumulates, so we check if we've already seen AND acted
        // on this prompt by tracking autoApproveBusy.)
        rec.autoApproveBusy = true;

        // Extract the command text from the approval prompt to check for danger.
        // The command appears before the "1. Yes, proceed" options. Look for
        // "ran" prefix (Codex shows "Ran <command>") or the command after "›".
        const cleanText = stripAnsi(approvalBuffer);
        let commandText = "";
        const ranMatch = cleanText.match(/Ran\s+(.+?)(?=\s*›|\s*1\.\s*Yes)/is);
        if (ranMatch) commandText = ranMatch[1].trim();
        if (!commandText) {
          // Fallback: grab everything before the "Yes, proceed" line
          const beforeYes = cleanText.split(/1\.\s*Yes/i)[0];
          commandText = beforeYes.trim().split("\n").pop() || "";
        }

        // Dangerous command patterns — ask the user before approving.
        const dangerous = /\brm\s+-rf?\b|\bdelete\b|\bdrop\s+(table|database)\b|\bformat\b|\btruncate\b|\bsudo\s+rm\b|\bgit\s+push\s+.*--force\b|\bchmod\s+777\b|\bkill\s+-9\b/i.test(commandText);

        if (dangerous) {
          // Ask the user in chat before approving.
          askCommandApproval(rec, commandText).then((approved) => {
            if (approved) {
              session.write("\r"); // press Enter = "1. Yes, proceed"
            } else {
              session.write("\x1b"); // Esc = "3. No, and tell Codex what to do differently"
            }
            // Clear the buffer so we don't re-trigger on the same prompt.
            approvalBuffer = "";
            rec.autoApproveBusy = false;
          });
        } else {
          // Safe command — auto-approve immediately.
          session.write("\r");
          approvalBuffer = "";
          rec.autoApproveBusy = false;
        }
      });
    }
  } catch (e) { console.warn("auto-approve watcher setup failed:", e); }

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
  if (rec.autoApproveUnsub) { try { rec.autoApproveUnsub(); } catch (e) { /* non-fatal */ } }
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

    // Render into a persistent overlay container, NOT inside chatLog, so the
    // pill picker survives renderChat() full-history re-renders (which clear
    // chatLog.innerHTML). The overlay sits above the chat log.
    let host = (typeof el !== "undefined" && el && el.chatOverlay) ? el.chatOverlay : null;
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
      // Render the prompt as markdown for a polished look (safe: escaped inside).
      promptEl.innerHTML = renderMarkdown(promptText);
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
      // Auto-dismiss the popup after a brief moment so the user sees their
      // selection confirmed, then it fades away instead of blocking the input.
      setTimeout(() => {
        if (row && row.parentNode) {
          row.style.transition = "opacity .3s ease";
          row.style.opacity = "0";
          setTimeout(() => { if (row.parentNode) row.parentNode.removeChild(row); }, 300);
        }
      }, 1200);
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

  // Chat scroll tracking — show the "Jump to latest" button when scrolled up,
  // and pause auto-scroll while streaming so the user can read history.
  if (el.chatScroll) {
    el.chatScroll.addEventListener("scroll", chatScrollListener, { passive: true });
  }
  if (el.chatJumpBtn) {
    el.chatJumpBtn.addEventListener("click", () => scrollChatBottom(true));
  }
  // Delegated copy handler for code-block copy buttons.
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest && e.target.closest("[data-code-copy]");
    if (!btn) return;
    const codeEl = document.getElementById(btn.getAttribute("data-code-copy"));
    if (!codeEl) return;
    const text = codeEl.textContent || "";
    const ok = await copyToClipboard(text);
    const orig = btn.textContent;
    btn.textContent = ok ? "Copied!" : "Failed";
    btn.classList.toggle("is-copied", !!ok);
    setTimeout(() => { btn.textContent = orig; btn.classList.remove("is-copied"); }, 1400);
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
