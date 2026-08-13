// Term Coder — AI agent orchestrator with live terminal squares.
// Spawns ollama/codex/claude sub-agents — ALWAYS asks the user first (spawn modal).
// Loaded by index.html as <script type="module" src="app.js"></script>.

const STORE_KEY = "term-coder.state";
const SETTINGS_KEY = "term-coder.settings";
const WORKTREES_KEY = "term-coder.worktrees";
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
  // Wake the orchestrator automatically when a delegated agent finishes its turn
  // or exits. Coding CLIs are REPLs that never exit, so without this the
  // orchestrator has nothing to react to and the user has to prod it by hand
  // after every subtask.
  autoFollow: true,
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

// The marker a coding agent prints when it needs a decision from the
// orchestrator (see ORCH_PROTOCOL in autoDriveStartup). Anchored to the start of
// a line — tolerating a TUI gutter glyph or indentation — so an agent merely
// MENTIONING the marker mid-sentence doesn't trip it.
//
// CRITICAL: this assembled literal must NEVER appear in any string we write into
// a PTY. Agent TUIs echo the submitted prompt back through onData, so a marker
// quoted in the task prompt would match our own instructions on every spawn.
const ORCH_SENTINEL_RE = /^[\s>│┃▌▎|*•-]*\[ORCHESTRATOR_INPUT_NEEDED\]\s*(.*)$/im;

// How long a session may sit with autoApproveBusy set before we force-clear it.
// autoApproveBusy gates the whole universal monitor, so a path that sets it and
// never clears it (e.g. an approval picker the user never answers) would leave
// the session permanently unwatched. This watchdog guarantees recovery.
const APPROVE_BUSY_TIMEOUT_MS = 45000;
// After auto-answering an approval prompt, ignore further approval matches for
// this long. TUIs redraw their scrollback constantly, so the same prompt text
// reappears in the output stream and would otherwise be "approved" again and
// again, spraying stray Enter keystrokes into a working agent.
const APPROVE_COOLDOWN_MS = 1800;

// How long a terminal must be silent, while sitting at an input prompt, before
// we call the agent's turn finished. Coding CLIs stream output continuously while
// they work (spinner frames, tool output), so silence at a prompt is a reliable
// "done for now" signal — and unlike process exit, it actually happens.
const TURN_IDLE_MS = 4000;
// Bytes of output the agent must have produced since we submitted the task
// before idleness can mean "finished". Without this, the quiet prompt that
// exists BEFORE the task is submitted would read as an instantly-completed turn.
const MIN_WORK_BYTES = 200;

// Recognisable failure text from a coding agent's provider or the CLI itself.
// An agent hitting one of these is NOT going to finish on its own, and an agent
// RETRYING one is the worst case: it keeps emitting output, so it looks busy
// forever and every "wait for it to finish" call runs to its full timeout.
const AGENT_ERROR_PATTERNS = [
  /api error:?\s*\d{3}/i,
  /does not support image input/i,
  /rate limit|429 |too many requests/i,
  /context (?:length|window) exceeded|too many tokens|prompt is too long/i,
  /401 |unauthorized|authentication (?:failed|error)|invalid api key/i,
  /5\d\d (?:error|internal)|overloaded|service unavailable/i,
  /econnreset|etimedout|fetch failed|network error/i,
];
// How many times the same error must recur before we call it a loop.
const ERROR_LOOP_THRESHOLD = 3;

function detectAgentError(text) {
  for (const re of AGENT_ERROR_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    // Return the whole line for context — the orchestrator needs to know WHAT
    // failed to write a useful correction.
    const line = (text.slice(0, m.index).split("\n").pop() || "") +
      text.slice(m.index).split("\n")[0];
    return line.trim().slice(0, 240);
  }
  return "";
}

// Classify what a session is doing right now, without touching the PTY.
// Returns: "EXITED" | "ERROR LOOP" | "NEEDS INPUT" | "WORKING" | "IDLE" | "STARTING".
function sessionActivity(s) {
  if (!s) return "EXITED";
  if (s.active === false) return "EXITED";
  // Ranked above NEEDS INPUT: an agent stuck retrying a failing call needs
  // intervention more urgently than one politely waiting, and it will never
  // reach idle on its own.
  if (s.errorLoop) return "ERROR LOOP";
  if (s.waitingForInput) return "NEEDS INPUT";
  const quietFor = Date.now() - (s.lastOutputAt || 0);
  if (!s.taskSubmittedAt) return quietFor >= TURN_IDLE_MS ? "IDLE" : "STARTING";
  if (s.bytesSinceTask < MIN_WORK_BYTES) return "STARTING";
  if (quietFor < TURN_IDLE_MS) return "WORKING";
  return s.tailAtPrompt ? "IDLE" : "WORKING";
}

// Build the structured status + output block shared by read_session and
// wait_for_session. Returns a header line (status / exit code / working dir)
// followed by the clean terminal screen text. Preserves the trust-dialog
// masking so the orchestrator never sees raw "Do you trust..." text it would
// try to keystroke past.
async function formatSessionStatusOutput(s, statusOverride, opts) {
  const o = opts || {};
  // Default to the TAIL of the screen. Returning the whole ~64KB scrollback on
  // every read was slow and burned a large chunk of the turn's context for
  // output the orchestrator had already seen.
  const maxChars = o.full ? Infinity : (o.maxChars || 4000);
  try {
    let clean = "(terminal is empty — no output yet)";
    if (s.session && typeof s.session.getOutput === "function") {
      const text = await s.session.getOutput();
      clean = text ? stripAnsi(text) : "(terminal is empty — no output yet)";
      if (clean.length > maxChars) {
        clean = "…(earlier output trimmed — pass full:true to read_session for everything)…\n" + clean.slice(-maxChars);
      }
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
      // Caller-supplied status line (e.g. wait_for_session's "STILL WORKING
      // (timed out …)" message). Reuses the same output-fetch + trust-dialog
      // masking below so every session read masks the trust dialog uniformly.
      statusLine = statusOverride;
    } else if (s.active === false && s.exitCode !== undefined && s.exitCode !== null) {
      statusLine = "[SESSION: " + (s.label || s.id) + " | STATUS: EXITED | EXIT CODE: " + s.exitCode + "]";
    } else if (s.active === false) {
      // Exited but no exit code recorded (e.g. killed) — report "killed".
      statusLine = "[SESSION: " + (s.label || s.id) + " | STATUS: EXITED | EXIT CODE: killed]";
    } else {
      // Report the ACTIVITY, not just "RUNNING". A coding CLI is always
      // "running" — that told the orchestrator nothing about whether the agent
      // was still working or had finished its turn minutes ago.
      const act = sessionActivity(s);
      const quiet = Math.round((Date.now() - (s.lastOutputAt || Date.now())) / 1000);
      statusLine = "[SESSION: " + (s.label || s.id) + " | STATUS: " + act +
        (act === "IDLE" ? " — turn complete, idle " + quiet + "s at its prompt (the CLI stays running; that is normal)" : "") +
        (act === "WORKING" ? " — actively producing output" : "") +
        (act === "STARTING" ? " — launched, task not yet under way" : "") + "]";
      if (act === "ERROR LOOP") {
        statusLine += "\n[ERROR (seen " + (s.errorCount || 0) + "x): " + (s.lastErrorText || "(see output)") + "]" +
          "\n[Correct the RUNNING agent with send_to_session — do not replace it.]";
      }
    }
    const dirLine = "[WORKING DIR: " + (s.cwd || "(unknown)") + "]";
    // Surface a blocked-on-prompt signal so the orchestrator knows the coding
    // agent is waiting. If the agent asked a question via the ORCHESTRATOR_INPUT_NEEDED
    // sentinel, include the question text so the orchestrator can answer it.
    let needsInputLine = "";
    if (s.active !== false && s.waitingForInput) {
      if (s.pendingQuestion && !/^\(agent appears idle/.test(s.pendingQuestion)) {
        needsInputLine = "\n[NEEDS INPUT: the agent asked a question. The app auto-handles permission prompts; this is a genuine question for YOU.]\n[QUESTION: " + s.pendingQuestion + "]\n[To answer: call send_to_session({ sessionId: \"" + (s.id || "") + "\", text: \"<your answer>\", key: \"enter\" }). After you respond, the agent will continue.]";
      } else if (s.pendingQuestion && /^\(agent appears idle/.test(s.pendingQuestion)) {
        needsInputLine = "\n[NEEDS INPUT: " + s.pendingQuestion + "]";
      } else {
        needsInputLine = "\n[NEEDS INPUT: yes — the coding agent is asking the user a permission question. The app auto-approves safe edits/commands; a destructive one shows the user an approve/deny picker in chat. Do NOT send keystrokes to it — just keep monitoring.]";
      }
    }
    return statusLine + "\n" + dirLine + needsInputLine + "\n" + "------------------------------------------------------------\n" + clean;
  } catch (e) {
    return "Error: " + (e && e.message ? e.message : String(e));
  }
}

// Worktree metadata: branchName -> { wtPath, parentBranch, projectPath }.
// Tracks every worktree created by create_worktree so merge_worktree can find
// the parent branch to merge back into without the model having to remember it.
//
// PERSISTED to scopedData: the orchestrator's tool-call history is NOT replayed
// into the next turn's messages, and the runtime caps tool rounds per turn — so a
// create-worktrees turn and the merge turn are almost always DIFFERENT turns (and
// may straddle an app restart). Keeping this in memory only made every worktree
// unmergeable the moment the turn ended. buildSystemPrompt surfaces the live
// contents to the model, and list_worktrees lets it enumerate them explicitly.
const worktreeMeta = new Map();
function saveWorktrees() {
  try {
    const arr = [...worktreeMeta.entries()].map(([branch, m]) => Object.assign({ branch }, m));
    window.chatoss.scopedData.set(WORKTREES_KEY, arr).catch((e) => console.warn("saveWorktrees", e));
  } catch (e) { console.warn("saveWorktrees", e); }
}
async function loadWorktrees() {
  try {
    const arr = await window.chatoss.scopedData.get(WORKTREES_KEY);
    if (!Array.isArray(arr)) return;
    for (const m of arr) {
      if (m && m.branch) {
        worktreeMeta.set(m.branch, { wtPath: m.wtPath, parentBranch: m.parentBranch, projectPath: m.projectPath });
      }
    }
  } catch (e) { console.warn("loadWorktrees", e); }
}

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
  chatEmpty: $("chat-empty"),
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
  autoFollow: $("auto-follow"),
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
function setStatus(t) {
  const s = el.chatStatus;
  if (!s) return;
  const text = t || "";
  // Show a subtle pulsing dot when the orchestrator is actively working.
  const active = !!text && /generating|thinking|running|working|polling|waiting/i.test(text);
  s.innerHTML = "";
  if (active) {
    const dot = document.createElement("span");
    dot.className = "pulse";
    s.appendChild(dot);
  }
  if (text) {
    const span = document.createElement("span");
    span.textContent = text;
    s.appendChild(span);
  }
  // The status line appearing/disappearing changes the composer stack height the
  // askChoice overlay sits above. (Hoisted declaration — safe to call here.)
  syncOverlayOffset();
}

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
      description: "Ask the user to start a new sub-agent CLI session (ollama launch claude / codex, etc.) in a working directory. The USER decides the CLI and model in a confirmation dialog — call this when you need an agent shell to work in, then wait for the returned session id. cwd defaults to the active project folder. This REFUSES to start a second agent in a directory that already has a live session, because two agents in one working directory clobber each other's edits — correct or close the existing agent instead.",
      parameters: {
        type: "object",
        properties: {
          cwd: { type: "string", description: "Working directory for the session (a project path or a worktree path). Defaults to the active project folder." },
          taskPrompt: { type: "string", description: "Optional initial task to send to the CLI's stdin after it starts." },
          force: { type: "boolean", description: "Override the refusal to start a second agent in a directory that already has a live session. Almost never correct — prefer send_to_session to correct the running agent, or close_session first." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_to_session",
      description: "Type into a running CLI session. Pass `text` for content and `key` for a keypress — they are separate things. To send an instruction AND submit it, pass both: { text: \"do X instead\", key: \"enter\" }. That is the normal way to talk to a running agent. Do NOT put escape codes in `text` (no \\r, no \\x1b[A) — use `key` instead; text is typed as literal content. Multi-line text is fine. The session auto-handles the 'trust this folder' dialog and submits the initial taskPrompt itself, so this is for follow-ups: correcting a stuck agent, answering its question, or giving it more work.",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Optional. Defaults to the most recently started session." },
          text: { type: "string", description: "Content to type. Sent as literal text — newlines stay newlines. Omit if you only want a keypress." },
          key: { type: "string", description: "One keypress, sent after any text: enter, escape, tab, shift+tab, space, backspace, delete, up, down, left, right, home, end, pageup, pagedown, ctrl+c, ctrl+d, ctrl+u. Use key:\"enter\" to submit, key:\"ctrl+c\" to interrupt a runaway operation." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_session",
      description: "Read a session's terminal output. Returns a STATUS HEADER (WORKING / IDLE — turn complete / NEEDS INPUT / EXITED, plus the working directory) followed by the TAIL of the clean screen text. NOTE: a live snapshot of every terminal is already included in your system context each turn, so use this when you need MORE of one agent's output than the snapshot shows — not to find out whether an agent is busy. To wait for an agent to finish, use wait_for_session.",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Optional. Defaults to the most recently started session." },
          maxChars: { type: "number", description: "How many characters of the tail to return. Default 4000." },
          full: { type: "boolean", description: "Return the entire scrollback (up to ~64KB) instead of the tail. Use sparingly — it is large." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_sessions",
      description: "List all terminal sessions with their status. Returns a summary of every coding agent session: id, label, working directory, whether it's still RUNNING or EXITED (with exit code), and a NEEDS INPUT flag when an agent is blocked asking the user a permission question. Use this to coordinate parallel agents — see which are still working, which are done, and which are waiting on the user.",
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
      description: "Wait until a coding agent FINISHES ITS CURRENT TURN, then return its status and screen output. This is the main way to monitor an agent — call it once per agent instead of polling read_session. IMPORTANT: coding CLIs are REPLs. Claude Code and Codex do NOT exit when they finish a task, they sit at their input prompt — so 'still running' does NOT mean 'still working'. This call returns as soon as the agent goes quiet at its prompt (turn complete), gets blocked needing input, or the process actually exits. Use generous timeouts (5-10 min) for substantial subtasks; it returns early the moment the agent stops.",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "The session id to wait for. Defaults to the most recently started session." },
          timeoutMs: { type: "number", description: "Maximum time to wait in milliseconds. Default 300000 (5 min). Returns early as soon as the agent finishes its turn or needs input, so a large value costs nothing." },
          waitFor: { type: "string", description: "'idle' (default) returns when the agent finishes its turn — what you almost always want. 'exit' waits for the process to actually terminate, which for an interactive coding CLI usually only happens if it crashes or is closed." },
        },
      },
    },
  },
  {
    // NOTE: `type: "function"` is REQUIRED on every entry. It was missing here,
    // which risks the whole tools array being rejected by a strict engine (i.e.
    // no tool calling at all, not just this one tool going missing).
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
      name: "close_session",
      description: "Kill a terminal session and remove its square. This is a LAST RESORT for an agent that is genuinely unusable — it destroys the agent's context and any work it had not written to disk. Before using it, try correcting the agent with send_to_session ({ text: \"<instruction>\", key: \"enter\" }), and interrupting it with { key: \"ctrl+c\" } if it is mid-operation. Never close an agent merely because it hit one error.",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "The session to close." },
          reason: { type: "string", description: "Briefly, why this agent could not be recovered. Shown to the user." },
        },
        required: ["sessionId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_worktrees",
      description: "List every git worktree Term Coder has created and not yet merged, with its branch, path and parent branch. Worktrees SURVIVE across turns and app restarts, but your own tool-call history does NOT — so call this at the start of a turn to recover which worktrees are still open and mergeable instead of relying on remembering branch names from an earlier turn.",
      parameters: { type: "object", properties: {} },
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

// ---------- PTY input (ChatOSS >= 1.8.4 native input APIs) ----------
// session.key(name) delivers ONE keypress as its own read(), so a TUI handles it
// as a keystroke instead of folding it into a preceding paste. session.paste(text)
// sends content, bracketed by the host when the child actually enabled
// bracketed-paste mode (only the host can see the child's DECSET ?2004).
//
// This replaces the whole type → wait-for-quiet → send \r → scrape-the-screen →
// retry dance that existed because a text+\r written together arrived as one
// read() and had its \r absorbed into the paste.
//
// Feature-detected: on a host older than 1.8.4 these methods are absent, so fall
// back to raw write() with the bytes the host would have sent.
const LEGACY_KEY_BYTES = {
  enter: "\r", escape: "\x1b", tab: "\t", space: " ", backspace: "\x7f",
  up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D",
  "ctrl+c": "\x03", "ctrl+d": "\x04", "ctrl+u": "\x15",
  home: "\x1b[H", end: "\x1b[F", delete: "\x1b[3~",
  "shift+tab": "\x1b[Z", pageup: "\x1b[5~", pagedown: "\x1b[6~",
};
function hasNativeInput(session) {
  return !!(session && typeof session.key === "function" && typeof session.paste === "function");
}
async function sendKey(session, name) {
  const key = String(name || "").trim().toLowerCase();
  if (session && typeof session.key === "function") {
    try { await session.key(key); return true; } catch (e) { console.warn("session.key", key, e); return false; }
  }
  const bytes = LEGACY_KEY_BYTES[key];
  if (bytes && session && typeof session.write === "function") {
    try { await session.write(bytes); return true; } catch (e) { return false; }
  }
  return false;
}
// Send text as CONTENT. Returns true when the host bracketed it (newlines are
// then literal and safe); false when it went through as plain bytes.
async function sendText(session, text) {
  if (session && typeof session.paste === "function") {
    try { return (await session.paste(text)) === true; } catch (e) { console.warn("session.paste", e); }
  }
  if (session && typeof session.write === "function") {
    try { await session.write(text); } catch (e) { /* non-fatal */ }
  }
  return false;
}
// Does the child have bracketed-paste mode on? Decides whether a multi-line
// payload is safe to send in one piece: WITHOUT bracketing every \n acts as a
// submit and would split the prompt into many broken messages.
async function bracketedPasteOn(session) {
  if (!session || typeof session.modes !== "function") return false;
  try {
    const m = await session.modes();
    return !!(m && m.bracketedPaste);
  } catch (e) { return false; }
}

// ---------- PTY input: escape-sequence parser (LEGACY COMPAT ONLY) ----------
// Kept solely to translate the OLD escape-string form the model may still send
// in send_to_session ("answer\r", "\x03", "\x1b[A") — from habit, or replayed
// from earlier conversation history written against the previous tool contract.
// Pasting those literally would type visible junk into the agent, so they are
// translated to key() calls instead. New code should use key names.
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
  // Order matters: longest/most-specific sequence forms first, because the
  // catch-alls at the end would otherwise eat an escape's introducer and leave
  // its payload behind as literal text.
  //
  // 1) CSI: ESC [ params intermediates final. NOTE: do NOT let the intermediate
  //    class consume the space AFTER a finished sequence — an earlier version's
  //    [ -\/]* did exactly that and turned "Do you trust the contents" into
  //    "Doyoutrustthecontents", breaking every startup regex.
  s = s.replace(/\x1b\[[0-9;:?<>=]*[ -\/]*[@-~]/g, "");
  // 2) String sequences (OSC / DCS / APC / PM), terminated by BEL or ST. Must run
  //    before the single-char catch-all, or "ESC ]" gets eaten and the title
  //    payload is left as visible text.
  s = s.replace(/\x1b[\]P_^][\s\S]*?(?:\x07|\x1b\\)/g, "");
  // 3) nF escapes that carry an INTERMEDIATE byte: ESC ( B, ESC ) 0, ESC # 8,
  //    ESC % G. This class was missing, and it caused a nasty cascading failure:
  //    ESC ( B (select ASCII charset) is emitted constantly by TUIs, and only its
  //    ESC was being removed — leaving a literal "(B" in everything the
  //    orchestrator read. A run of them shows up as "(B(B(B", which the
  //    orchestrator reasonably read as junk keystrokes stuck in the agent's input
  //    box. It then fought text that did not exist: sent Ctrl+U / Ctrl+C / Esc
  //    into a perfectly healthy prompt, declared the session unrecoverable, and
  //    spawned a SECOND agent into the same worktree. Phantom input, real damage.
  s = s.replace(/\x1b[ -\/][0-~]/g, "");
  // 4) Any remaining single-char escape: ESC 7 / ESC 8 (save/restore cursor),
  //    ESC =, ESC >, ESC c (reset), ESC M. Previously only ESC @-_ was handled,
  //    so ESC 7 left a stray "7" and ESC c a stray "c" in the text.
  s = s.replace(/\x1b[0-~]/g, "");
  // 5) Remaining stray ESCs and other C0 control chars (except \n, \r, \t) -> drop
  s = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  // Collapse runs of spaces that were separated by (now-removed) ANSI codes
  // down to a single space, so "Do  you  trust" -> "Do you trust", which is what
  // the prompt/marker regexes need to match reliably.
  // TRADE-OFF: this also flattens indentation and TUI box alignment, so code the
  // agent prints loses its leading whitespace in read_session output. That is
  // acceptable — the orchestrator reads this for status, not to apply patches.
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

  // ---------- Universal orchestrator protocol ----------
  // Prepended to EVERY task prompt sent to ANY coding agent. It teaches the
  // agent a single, CLI-agnostic way to ask the orchestrator a question: print
  // a marker line, then the question. The app's universal terminal monitor
  // watches every session's output for that marker, so it works with any CLI.
  //
  // NOTE on newlines: with ChatOSS >= 1.8.4 the payload goes through
  // session.paste(), and when the child has bracketed-paste mode on the host
  // brackets it so newlines stay LITERAL — a multi-line prompt then arrives as
  // one message. When the child has NOT enabled that mode, paste falls through to
  // plain bytes and every \n still acts as a submit, which would split the prompt
  // into dozens of broken messages. So the payload is flattened only in that
  // case — see the bracketedPasteOn() check at submit time.
  //
  // IMPORTANT #2 — DO NOT put the assembled marker literal in this text. The
  // agent's TUI renders the submitted prompt into its own transcript, so every
  // byte we type here comes straight back out through session.onData. If the
  // literal marker appeared here, the universal monitor would match its OWN
  // instructions the moment the prompt was submitted — flagging a bogus
  // "agent asked a question" on every single spawn and (previously) latching
  // autoApproveBusy so no permission prompt was ever auto-approved again.
  // So we describe the marker as two fragments the agent must JOIN. The echoed
  // instruction contains "[ORCHESTRATOR" and "_INPUT_NEEDED]" separately but
  // never the concatenation, so ORCH_SENTINEL_RE cannot match the echo.
  const ORCH_PROTOCOL =
    "[ORCHESTRATOR PROTOCOL] You are directed by Term Coder, a supervisor app watching this terminal. " +
    "When you genuinely need a decision or clarification before you can proceed, print ONE line that begins with the " +
    "all-caps marker formed by joining these two fragments together with nothing between them — first `[ORCHESTRATOR` " +
    "and then `_INPUT_NEEDED]` — followed by a space and your one-line question, then STOP and WAIT for the " +
    "orchestrator to type a response. The joined marker must be the FIRST thing on that line. " +
    "Do NOT use the marker for routine edits or command execution — only when you genuinely need a decision. " +
    "TASK: ";
  const fullPrompt = ORCH_PROTOCOL + (prompt || "");

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
    // Startup is over: no trust dialog is blocking this session any more (either
    // we never saw one, or handleTrust resolved it). The universal terminal
    // monitor consults rec.trustState before touching the PTY, so leaving it at
    // "pending" here would suppress approval auto-answering for the whole
    // session on an already-trusted folder.
    if (rec && rec.trustState === "pending") rec.trustState = "confirmed";

    // ---------- Submit the task ----------
    // Two calls, no delays, no retries, no screen scraping. paste() sends the
    // payload as CONTENT and key('enter') is delivered as its own read(), so the
    // Enter can no longer be absorbed into the paste.
    //
    // This replaced a much worse thing. Writing the text and "\r" back-to-back
    // put both into the PTY fast enough to arrive as ONE read(); an Ink TUI like
    // Claude Code treats a large single chunk as a paste and inserts the \r as a
    // literal newline instead of submitting. The task then sat in the input box
    // indefinitely — the original 10-minute hang. The app worked around it with a
    // wait-for-quiet, an input-box scrape, and a \r/\r/\n escalation ladder; all
    // of that is now the host's job and is gone from here.
    //
    // Newlines: safe to send literally only when the child enabled bracketed
    // paste (the host brackets it and \n stays text). Otherwise each \n submits,
    // which would fragment the prompt — so flatten in that case only.
    const nativeInput = hasNativeInput(session);
    const bracketed = await bracketedPasteOn(session);
    const payload = bracketed ? fullPrompt : fullPrompt.replace(/\r?\n/g, "  ");
    await sendText(session, payload);
    // Drop the echoed prompt out of the monitor's buffer — it contains the whole
    // protocol text and would otherwise sit there being re-scanned as if it were
    // terminal output from the agent.
    try { if (rec && rec._resetMonitorBuffer) rec._resetMonitorBuffer(); } catch (_) {}
    if (!nativeInput) {
      // LEGACY HOST (ChatOSS < 1.8.4): there is no key() to guarantee the Enter
      // lands in its own read(), so two back-to-back write()s can still coalesce
      // and have the \r absorbed into the paste. A pause is the best an app can
      // do from out here — it is a mitigation, not a fix. Update ChatOSS.
      console.warn("[Term Coder] host lacks session.key/paste (ChatOSS < 1.8.4) — using the legacy submit path; update ChatOSS for reliable submission.");
      await new Promise((r) => setTimeout(r, 350));
    }
    await sendKey(session, "enter");

    // Mark the task as sent so idle detection can tell "finished a turn" from
    // "never started" (see markTaskSubmitted / wait_for_session). If a CLI still
    // fails to submit, wait_for_session's STALLED check catches it within 45s and
    // tells the orchestrator exactly what to do — that is the safety net now,
    // instead of blind keystroke retries down here.
    try { if (rec && rec._markTaskSubmitted) rec._markTaskSubmitted(); } catch (_) {}
  };

  // Confirm the trust dialog by pressing Enter on the highlighted "Yes" option.
  // Works for both Claude Code ("Yes, I trust this folder") and Codex
  // ("1. Yes, continue" + "Press enter to continue").
  const confirmTrust = async () => {
    trustHandled = true;
    await sendKey(session, "enter");
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
        // Persisted — the merge almost always happens in a LATER turn.
        worktreeMeta.set(branch, { wtPath, parentBranch: mainBranch, projectPath: base });
        saveWorktrees();
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
        // A branch name is REQUIRED for the merge itself — `git merge ""` fails
        // with an obscure error. If only worktreePath was given and we have no
        // metadata for it, say so plainly instead of running a broken command.
        if (!branch) {
          return "Error: I don't have a branch recorded for worktreePath " + wtPath +
            ". Call list_worktrees to see the open worktrees and pass the branchName.";
        }

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

        // The main project folder may have uncommitted edits (the user's own
        // work, or files an agent wrote before we moved to worktrees). Both
        // `git checkout` and `git merge` refuse to run against a dirty tree, so
        // commit it first — otherwise every merge fails with "local changes
        // would be overwritten" and the worktree is stranded.
        const dirtyR = await window.chatoss.terminal.exec(
          loginShell("git status --porcelain"),
          { cwd: base }
        );
        if (dirtyR === null) return "Error: terminal permission denied (approve git to continue)";
        if ((dirtyR.output || "").trim()) {
          const wipR = await window.chatoss.terminal.exec(
            loginShell("git add -A && git commit -m " + JSON.stringify("WIP: commit uncommitted work before merging " + branch)),
            { cwd: base }
          );
          if (wipR === null) return "Error: terminal permission denied (approve git to continue)";
        }

        // Switch to the parent branch in the MAIN project folder and merge.
        const mergeMsg = "Merge worktree branch " + branch + " into " + parentBranch;
        const mergeR = await window.chatoss.terminal.exec(
          loginShell("git checkout " + JSON.stringify(parentBranch) + " && git merge --no-ff " + JSON.stringify(branch) + " -m " + JSON.stringify(mergeMsg)),
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
        worktreeMeta.delete(branch);
        saveWorktrees();
        return "Merged branch " + branch + " into " + parentBranch + " successfully. Worktree cleaned up.\n" + mergeOut;
      }
      case "close_session": {
        const s = args.sessionId ? sessions.get(args.sessionId) : null;
        if (!s) return "Error: no such session " + (args.sessionId || "(none given)") + ". Call list_sessions to see what exists.";
        const label = s.label || s.id;
        const wasCwd = s.cwd || "(unknown)";
        await closeSession(s.id);
        return "Closed session " + args.sessionId + " (" + label + ") in " + wasCwd + "." +
          (args.reason ? " Reason recorded: " + args.reason : "") +
          " Its context and any unsaved work are gone. If that worktree still needs work, you may now start a fresh agent in it.";
      }
      case "list_worktrees": {
        if (!worktreeMeta.size) return "No open worktrees. Create one with create_worktree before spawning a coding agent.";
        const lines = [...worktreeMeta.entries()].map(([branch, m]) =>
          "  branch " + branch + " | parent " + (m.parentBranch || "main") + " | path " + (m.wtPath || "(unknown)"));
        return "OPEN WORKTREES (" + worktreeMeta.size + "):\n" + lines.join("\n") +
          "\n\nMerge each one with merge_worktree({ branchName: <branch> }) once its agent has finished.";
      }
      case "start_cli_session": {
        // The USER decides the CLI + model in the spawn modal. The tool WAITS
        // on a promise that resolves when the user hits Start or Cancel.
        let cwd = (args.cwd || "").trim();
        if (!cwd) {
          const p = resolveProject(args);
          cwd = p ? p.folderPath : "";
        }
        // REFUSE a second agent in a directory that already has a live one.
        // Worktree isolation exists so parallel agents can't edit the same files;
        // two agents inside the SAME worktree defeats it entirely. This happened
        // for real: an agent hit a provider error, the orchestrator judged it
        // unrecoverable, and spawned a second agent into the same worktree
        // alongside it — both then editing the same file.
        if (cwd && !args.force) {
          const norm = (p) => String(p || "").replace(/\/+$/, "");
          const existing = [...sessions.values()].find(
            (s) => s.active !== false && norm(s.cwd) === norm(cwd)
          );
          if (existing) {
            const act = sessionActivity(existing);
            return "Refused: session " + existing.id + " (" + (existing.label || existing.id) +
              ") is ALREADY running in " + cwd + " — status " + act + ".\n\n" +
              "Two agents in one working directory edit the same files and will clobber each other.\n" +
              "Do this instead:\n" +
              "  • To give that agent new or corrected instructions: send_to_session({ sessionId: \"" + existing.id + "\", text: \"<instruction>\", key: \"enter\" }). This keeps its context and its work in progress.\n" +
              "  • If it is stuck retrying an error, tell it plainly what to do differently" +
              (existing.lastErrorText ? " — its last error was: " + existing.lastErrorText : "") + ".\n" +
              "  • To interrupt a runaway operation first: send_to_session({ sessionId: \"" + existing.id + "\", key: \"ctrl+c\" }), then send your instruction.\n" +
              "  • Only if the agent is genuinely unusable: close_session({ sessionId: \"" + existing.id + "\" }) and THEN start a replacement.\n" +
              "  • For a genuinely separate subtask, create_worktree first and pass that new worktreePath as cwd.";
          }
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
          // Mark it as delegated so auto-follow wakes us when it finishes. A
          // terminal the USER opened by hand is theirs and never triggers a turn.
          const rec = sessions.get(choice.session.id);
          if (rec) rec.fromOrchestrator = true;
          return "session " + choice.session.id + " started: " + choice.session.label + " in " + choice.session.cwd +
            ". The app types and submits your taskPrompt automatically once the agent is ready. " +
            "Monitor it with wait_for_session (returns when its turn finishes) — do NOT wait for the process to exit; coding CLIs are REPLs and never do.";
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
          // Preferred contract: `text` is CONTENT and `key` is a KEYPRESS.
          // Sending both types the text then presses the key, which is the common
          // "answer a question and submit" case.
          let keyName = args.key ? String(args.key).trim().toLowerCase() : "";
          let text = args.text != null ? String(args.text) : "";

          // Backward compatibility: the model may still send the OLD escape-string
          // form ("answer\r", "\x03", "\x1b[A") — either from habit or replayed
          // from earlier turns written against the previous tool contract. Pasting
          // those literally would type visible junk into the agent, so translate
          // them into a key instead.
          if (text) {
            const parsed = parseTerminalEscapes(text);
            const WHOLE_PAYLOAD_KEYS = {
              "\r": "enter", "\n": "enter", "\x1b": "escape", "\x03": "ctrl+c",
              "\x04": "ctrl+d", "\x15": "ctrl+u", "\t": "tab",
              "\x1b[A": "up", "\x1b[B": "down", "\x1b[C": "right", "\x1b[D": "left",
              "\x1b[Z": "shift+tab", "\x7f": "backspace",
            };
            const whole = WHOLE_PAYLOAD_KEYS[parsed];
            if (whole) {
              if (!keyName) keyName = whole;
              text = "";
            } else if (/[\r\n]$/.test(parsed)) {
              // "answer\r" — the trailing newline meant "submit".
              text = parsed.replace(/[\r\n]+$/, "");
              if (!keyName) keyName = "enter";
            } else {
              text = parsed;
            }
          }

          if (text) {
            // Flatten interior newlines when the child has no bracketed paste,
            // or each one would submit and fragment the message.
            const bracketed = await bracketedPasteOn(s.session);
            await sendText(s.session, bracketed ? text : text.replace(/\r?\n/g, "  "));
          }
          if (keyName) {
            const ok = await sendKey(s.session, keyName);
            if (!ok) return "Error: unknown key name \"" + keyName + "\". Valid: enter, escape, tab, shift+tab, space, backspace, delete, up, down, left, right, home, end, pageup, pagedown, ctrl+c, ctrl+d, ctrl+u.";
          }
          if (!text && !keyName) return "Error: pass text (content to type) and/or key (a keypress name).";
          // The orchestrator just answered an agent's question (or sent a follow-
          // up). Clear the NEEDS INPUT / pending question state so the status
          // tools stop reporting it as blocked, and the idle timer can re-arm.
          // NOTE: we deliberately do NOT clear s._sentinelKey. The agent's TUI
          // keeps the asked question in its scrollback and re-emits it on every
          // redraw, so re-arming the same key would re-flag the question we just
          // answered — an answer/flag loop. A genuinely NEW question has
          // different text and will still be detected.
          // The orchestrator just intervened, so clear the error latch and give
          // the correction a chance to take effect before we call it stuck again.
          if (s.errorLoop) {
            s.errorLoop = false;
            s.errorCount = 0;
            s.lastErrorText = "";
          }
          if (s.waitingForInput || s.pendingQuestion) {
            s.waitingForInput = false;
            s.pendingQuestion = "";
            s.autoApproveBusy = false;
            if (s._busyTimer) { clearTimeout(s._busyTimer); s._busyTimer = null; }
            renderTabs();
            renderSessionInfo();
          }
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
        return await formatSessionStatusOutput(s, null, { full: !!args.full, maxChars: args.maxChars });
      }
      case "list_sessions": {
        // Summarize every coding-agent session at a glance so the orchestrator
        // can coordinate parallel work without guessing from raw screen text.
        if (!sessions.size) return "No active sessions. Start one with start_cli_session first.";
        const recs = [...sessions.values()];
        const tally = { WORKING: 0, IDLE: 0, "NEEDS INPUT": 0, STARTING: 0, EXITED: 0 };
        const lines = recs.map((s) => {
          const act = sessionActivity(s);
          tally[act] = (tally[act] || 0) + 1;
          let statusPart = act;
          if (act === "EXITED") {
            const code = (s.exitCode !== undefined && s.exitCode !== null) ? s.exitCode : "killed";
            statusPart = "EXITED (code " + code + ")";
          } else if (act === "IDLE") {
            statusPart = "IDLE — turn complete (still running; a REPL does not exit)";
          }
          let q = "";
          if (act === "NEEDS INPUT" && s.pendingQuestion && !/^\(agent appears idle/.test(s.pendingQuestion)) {
            q = " | Q: " + s.pendingQuestion.split("\n")[0].slice(0, 100);
          } else if (act === "ERROR LOOP") {
            statusPart = "ERROR LOOP (" + (s.errorCount || 0) + "x) — correct it with send_to_session, do not replace it";
            q = " | ERROR: " + String(s.lastErrorText || "").slice(0, 120);
          }
          return "  [" + s.id + "] " + (s.label || s.id) + " | " + statusPart + q + " | " + (s.cwd || "(unknown)");
        });
        const summary = Object.entries(tally).filter(([, n]) => n).map(([k, n]) => n + " " + k.toLowerCase()).join(", ");
        return "SESSIONS (" + recs.length + " total: " + summary + "):\n" + lines.join("\n") +
          "\n\nIDLE means the agent finished its turn and is waiting at its prompt — that is your signal to review its work and merge, NOT a reason to keep waiting.";
      }
      case "wait_for_session": {
        // Wait until the agent FINISHES ITS TURN — not until the process exits.
        //
        // This used to poll `s.active !== false`, i.e. it waited for the CLI to
        // exit. Coding CLIs are REPLs: Claude Code and Codex sit at their prompt
        // after finishing a task and never exit on their own. So this call always
        // burned its entire timeout (2 minutes by default) and came back knowing
        // nothing, which is what made monitoring feel dead for minutes at a time.
        //
        // It now returns as soon as ANY of these is true:
        //   • the agent went quiet at its input prompt (turn complete)
        //   • the agent is blocked needing input (a question, or a prompt the app
        //     couldn't classify)
        //   • the process really did exit
        let s = args.sessionId ? sessions.get(args.sessionId) : null;
        if (!s && sessions.size) { s = [...sessions.values()].pop(); }
        if (!s) return "Error: no such session.";
        const timeout = Math.max(1000, args.timeoutMs || 300000);
        const waitFor = args.waitFor === "exit" ? "exit" : "idle";
        const deadline = Date.now() + timeout;
        // A session that never gets going is a FAILURE, not something to wait out.
        // The classic cause is the task text landing in the agent's input box
        // without being submitted: the agent then sits at its prompt producing
        // nothing, and a naive wait burns its whole timeout in silence. Bail after
        // 45s of no work so the orchestrator can report something actionable.
        const stallDeadline = Date.now() + 45000;
        const settledNow = () => {
          if (s.active === false) return "EXITED";
          if (waitFor === "exit") return null;
          const act = sessionActivity(s);
          // An error loop must break the wait. A retrying agent keeps producing
          // output, so it reads as WORKING indefinitely and this call would
          // otherwise run to its full timeout while nothing progressed.
          if (act === "ERROR LOOP") return "ERROR LOOP";
          if (act === "IDLE" || act === "NEEDS INPUT") return act;
          if (act === "STARTING" && Date.now() > stallDeadline) return "STALLED";
          return null;
        };
        // Poll at 500ms so we react promptly once the agent stops.
        let reason = settledNow();
        while (!reason && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 500));
          reason = settledNow();
        }
        if (reason === "STALLED") {
          return await formatSessionStatusOutput(
            s,
            "[SESSION: " + (s.label || s.id) + " | STATUS: STALLED — the agent has produced almost no output since it was launched]\n" +
            "[LIKELY CAUSE: the task text is sitting in the agent's input box without having been submitted, or the CLI is still on a startup screen. Look at the output below: if you can see the task text next to the input prompt, call send_to_session({ sessionId: \"" + s.id + "\", key: \"enter\" }) to press Enter. If the CLI is showing a menu or dialog, tell the user what it says instead of keystroking it.]"
          );
        }
        if (s.active === false) return await formatSessionStatusOutput(s);
        if (reason === "IDLE") {
          return await formatSessionStatusOutput(
            s,
            "[SESSION: " + (s.label || s.id) + " | STATUS: RUNNING | AGENT TURN COMPLETE — it has been idle at its input prompt for " +
            Math.round((Date.now() - (s.lastOutputAt || Date.now())) / 1000) + "s]\n" +
            "[NOTE: the CLI is still running (that is normal — it is a REPL and will not exit). Read the output below to confirm the subtask is done, then merge its worktree. To give it more work, use send_to_session.]"
          );
        }
        if (reason === "ERROR LOOP") {
          return await formatSessionStatusOutput(
            s,
            "[SESSION: " + (s.label || s.id) + " | STATUS: STUCK ON A REPEATING ERROR (" + (s.errorCount || 0) + "x)]\n" +
            "[ERROR: " + (s.lastErrorText || "(see output)") + "]\n" +
            "[WHAT TO DO: this agent is retrying something that will keep failing. TALK TO IT — call send_to_session({ sessionId: \"" + s.id + "\", text: \"<a plain-language correction>\", key: \"enter\" }) telling it what to do differently. For example, if the error is about image input, tell it that its model cannot read images and it should work from the code instead. Do NOT close this session and do NOT start a second agent in the same worktree — correcting the running agent keeps its context and its work.]"
          );
        }
        if (reason === "NEEDS INPUT") return await formatSessionStatusOutput(s);
        // Timed out while the agent was still actively working.
        return await formatSessionStatusOutput(
          s,
          "[SESSION: " + (s.label || s.id) + " | STATUS: STILL WORKING (timed out after " + timeout + "ms without going idle)]"
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
  if (el.autoFollow) el.autoFollow.checked = settings.autoFollow !== false;
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
  if (el.autoFollow) settings.autoFollow = !!el.autoFollow.checked;
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
  if (!text.trim()) return "medium";

  // LENGTH IS NOT A PROXY FOR COMPLEXITY HERE. The previous version returned
  // "high" for anything over 200 characters — but the system prompt explicitly
  // instructs the orchestrator to write FOCUSED, DETAILED task prompts naming
  // exact files and constraints, so every delegated subtask cleared 200 chars.
  // The result: every session got the high-complexity model and the Low/Medium
  // settings were dead configuration. A verbose brief for a trivial job is still
  // a trivial job, so length is now only a last-resort nudge.
  const word = (w) => new RegExp("\\b" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b").test(text);
  const anyWord = (list) => list.some(word);

  // Verbs that change the repo vs verbs that only look at it.
  const MUTATE = ["write", "create", "add", "implement", "build", "refactor", "rewrite",
    "modify", "change", "update", "fix", "delete", "remove", "rename", "migrate",
    "port", "install", "configure", "redesign", "overhaul", "optimize", "optimise"];
  const INSPECT = ["read", "list", "report", "summarise", "summarize", "describe",
    "show", "display", "print", "count", "find", "locate", "check", "review",
    "explain", "audit", "inspect"];

  // A pure read-and-report task is LOW however long the brief is. This is the
  // case the old heuristic got most wrong.
  if (anyWord(INSPECT) && !anyWord(MUTATE)) return "low";

  const HIGH = ["architect", "architecture", "migration", "database", "schema",
    "security", "authentication", "authorization", "performance", "scalability",
    "concurren", "distributed", "microservice", "pipeline", "ci/cd",
    "infrastructure", "end-to-end", "refactor", "rewrite", "overhaul",
    "comprehensive", "from scratch", "redesign", "test suite", "state management",
    "design system"];
  const MED = ["add", "create", "build", "fix", "update", "change", "modify",
    "feature", "component", "screen", "page", "endpoint", "handler", "function",
    "method", "style", "css", "layout", "dark mode", "responsive", "accessib"];

  let high = 0, med = 0;
  for (const w of HIGH) if (text.includes(w)) high++;
  for (const w of MED) if (text.includes(w)) med++;

  // Breadth signals — these say "big" far more reliably than length does.
  const fileMentions = (text.match(/\b[\w./-]+\.(?:js|ts|tsx|jsx|css|scss|html|json|py|rb|go|rs|java|swift|md)\b/g) || []).length;
  const enumeratedSteps = (text.match(/^\s*(?:\d+[.)]|[-*•])\s+/gm) || []).length;
  if (fileMentions >= 4) high++;
  if (enumeratedSteps >= 6) high++;
  if (/\b(?:entire|whole|every|all)\b.{0,24}\b(?:app|project|codebase|file|component)/.test(text)) high++;

  if (high >= 2) return "high";
  if (high === 1) return med >= 3 ? "high" : "medium";
  if (med >= 1) return "medium";
  // Nothing recognisable: a very long brief is probably not trivial.
  return text.length > 600 ? "medium" : "low";
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
    // No project → drop the file watcher; it would be watching a folder that is
    // no longer shown anywhere.
    if (fileTree.watchStop) resetFileTree(null);
    const empty = document.createElement("div");
    empty.className = "projects-empty";
    const glyph = document.createElement("div");
    glyph.className = "projects-empty-glyph";
    glyph.textContent = "◫";
    const title = document.createElement("div");
    title.className = "projects-empty-title";
    title.textContent = "No projects yet";
    const bodyText = document.createElement("div");
    bodyText.className = "projects-empty-body";
    bodyText.textContent = "Add a folder to work in. Coding agents run in isolated git worktrees inside it.";
    const cta = document.createElement("button");
    cta.type = "button";
    cta.className = "btn btn-primary btn-small projects-empty-cta";
    cta.textContent = "+ Add a project folder";
    cta.onclick = newProject;
    empty.appendChild(glyph);
    empty.appendChild(title);
    empty.appendChild(bodyText);
    empty.appendChild(cta);
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

// ---------- File tree ----------
// A lazy, expandable tree over the active project folder that LIVE-UPDATES as
// coding agents edit files. Reads through window.chatoss.files.listDir (a path
// from files.pickFolder, which is how projects are added) and falls back to
// `ls -Ap` on runtimes where listDir is unavailable. files.watch gives us the
// change stream, which matters a lot here: agents are writing to this tree the
// whole time the app is running, and the old version was a flat, inert 60-line
// `ls` snapshot behind a 30s cache.
const HIDDEN_ENTRIES = new Set([".git", ".chatoss", ".DS_Store"]);
const MAX_CHILDREN = 300;

const fileTree = {
  projectPath: null,
  expanded: new Set(),  // absolute dir paths currently open
  cache: new Map(),     // absolute dir path -> [{ name, isDir }] | "denied"
  loading: new Set(),
  container: null,
  watchStop: null,
};

function resetFileTree(projectPath) {
  fileTree.projectPath = projectPath;
  fileTree.expanded = new Set();
  fileTree.cache = new Map();
  fileTree.loading = new Set();
  if (fileTree.watchStop) {
    try { fileTree.watchStop(); } catch (e) { /* non-fatal */ }
    fileTree.watchStop = null;
  }
}

async function listDirEntries(path) {
  // Preferred: the structured file API — no shell, no per-command approval, and
  // it reports isDir directly.
  try {
    const f = window.chatoss.files;
    if (f && typeof f.listDir === "function") {
      const entries = await f.listDir(path);
      if (Array.isArray(entries)) return entries.map((e) => ({ name: e.name, isDir: !!e.isDir }));
    }
  } catch (e) { /* fall through to the shell */ }
  // Fallback: `ls -Ap` suffixes directories with "/".
  try {
    const r = await window.chatoss.terminal.exec(loginShell("ls -Ap"), { cwd: path, timeoutMs: 8000 });
    if (!r) return "denied";
    return (r.output || "").split("\n").map((s) => s.trim()).filter(Boolean)
      .map((n) => (n.endsWith("/") ? { name: n.slice(0, -1), isDir: true } : { name: n, isDir: false }));
  } catch (e) { return "denied"; }
}

function sortEntries(entries) {
  return entries
    .filter((e) => !HIDDEN_ENTRIES.has(e.name))
    .sort((a, b) => (a.isDir === b.isDir
      ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
      : (a.isDir ? -1 : 1)));
}

async function loadDir(path, repaint) {
  if (fileTree.loading.has(path)) return;
  fileTree.loading.add(path);
  const entries = await listDirEntries(path);
  fileTree.loading.delete(path);
  fileTree.cache.set(path, entries === "denied" ? "denied" : sortEntries(entries));
  if (repaint) repaintFileTree();
}

// Start (or restart) the live watcher for the active project.
function ensureFileWatch(projectPath) {
  if (fileTree.watchStop) return;
  try {
    const f = window.chatoss.files;
    if (!f || typeof f.watch !== "function") return;
    fileTree.watchStop = f.watch(projectPath, (events) => {
      // The API debounces (~300ms) and batches. Invalidate the parent directory
      // of each changed path; only repaint if something visible actually changed.
      let touched = false;
      for (const ev of (events || [])) {
        const p = String(ev && ev.path || "");
        if (!p || p.includes("/.git/") || p.includes("/.chatoss/")) continue;
        const parent = p.replace(/\/+[^/]*$/, "") || projectPath;
        if (fileTree.cache.has(parent)) { fileTree.cache.delete(parent); touched = true; }
      }
      if (!touched) return;
      // Reload every open directory whose cache we just dropped.
      const dirs = [projectPath, ...fileTree.expanded].filter((d) => !fileTree.cache.has(d));
      Promise.all(dirs.map((d) => loadDir(d, false))).then(repaintFileTree);
    });
  } catch (e) { console.warn("files.watch unavailable", e); }
}

function renderFileTree(project, container) {
  // Switching projects resets expansion state and rebinds the watcher.
  if (fileTree.projectPath !== project.folderPath) resetFileTree(project.folderPath);
  fileTree.container = container;

  container.innerHTML = "";
  const head = document.createElement("div");
  head.className = "file-tree-head";
  const title = document.createElement("span");
  title.className = "file-tree-title";
  title.textContent = "Files";
  head.appendChild(title);
  const refresh = document.createElement("button");
  refresh.className = "btn-icon";
  refresh.title = "Refresh";
  refresh.textContent = "⟳";
  refresh.onclick = (e) => {
    e.stopPropagation();
    fileTree.cache.clear();
    const dirs = [project.folderPath, ...fileTree.expanded];
    Promise.all(dirs.map((d) => loadDir(d, false))).then(repaintFileTree);
    repaintFileTree();
  };
  head.appendChild(refresh);
  container.appendChild(head);

  const body = document.createElement("div");
  body.className = "file-tree-body";
  container.appendChild(body);

  paintFileTree(body, project.folderPath);
  // Load the root on first paint (no "Loading…" flash once it's cached).
  if (!fileTree.cache.has(project.folderPath)) loadDir(project.folderPath, true);
  ensureFileWatch(project.folderPath);
}

// Repaint in place — used by the watcher and by expand/collapse so we never have
// to rebuild the whole Projects column (which would also blow away the watcher).
function repaintFileTree() {
  const container = fileTree.container;
  if (!container || !container.isConnected || !fileTree.projectPath) return;
  const body = container.querySelector(".file-tree-body");
  if (body) paintFileTree(body, fileTree.projectPath);
}

function paintFileTree(body, rootPath) {
  body.innerHTML = "";
  const rows = document.createDocumentFragment();

  const paintLevel = (dirPath, depth) => {
    const entries = fileTree.cache.get(dirPath);
    if (entries === "denied") {
      rows.appendChild(fileTreeNote("Permission needed to list files.", depth));
      return;
    }
    if (!entries) {
      rows.appendChild(fileTreeNote("Loading…", depth));
      return;
    }
    if (!entries.length) {
      rows.appendChild(fileTreeNote("Empty folder", depth));
      return;
    }
    const shown = entries.slice(0, MAX_CHILDREN);
    for (const entry of shown) {
      const childPath = dirPath.replace(/\/+$/, "") + "/" + entry.name;
      const open = entry.isDir && fileTree.expanded.has(childPath);
      const row = document.createElement("div");
      row.className = "file-row" + (entry.isDir ? " is-dir" : "") + (open ? " is-open" : "");
      row.style.paddingLeft = (8 + depth * 12) + "px";
      const icon = document.createElement("span");
      icon.className = "file-icon";
      icon.textContent = entry.isDir ? "▸" : fileIcon(entry.name);
      const nm = document.createElement("span");
      nm.className = "file-name";
      nm.textContent = entry.name;
      row.appendChild(icon);
      row.appendChild(nm);
      if (entry.isDir) {
        row.title = "Click to " + (open ? "collapse" : "expand");
        row.onclick = (e) => {
          e.stopPropagation();
          if (fileTree.expanded.has(childPath)) fileTree.expanded.delete(childPath);
          else {
            fileTree.expanded.add(childPath);
            if (!fileTree.cache.has(childPath)) loadDir(childPath, true);
          }
          repaintFileTree();
        };
      } else {
        row.title = childPath;
      }
      rows.appendChild(row);
      if (open) paintLevel(childPath, depth + 1);
    }
    if (entries.length > shown.length) {
      rows.appendChild(fileTreeNote("+" + (entries.length - shown.length) + " more…", depth));
    }
  };

  paintLevel(rootPath, 0);
  body.appendChild(rows);
}

function fileTreeNote(text, depth) {
  const d = document.createElement("div");
  d.className = "file-tree-loading";
  d.textContent = text;
  d.style.paddingLeft = (8 + (depth || 0) * 12) + "px";
  return d;
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
// Switching conversation must also refresh the footer line, which names the
// active conversation — it used to keep showing the previous one.
function selectConversation(pid, cid) {
  state.activeProjectId = pid;
  state.activeConversationId = cid;
  saveState();
  renderProjects();
  renderChat();
  renderSessionInfo();
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
  renderSessionInfo();
}
function deleteConversation(p, c) {
  p.conversations = p.conversations.filter((x) => x.id !== c.id);
  if (state.activeConversationId === c.id) {
    state.activeConversationId = p.conversations.length ? p.conversations[0].id : null;
  }
  saveState();
  renderProjects();
  renderChat();
  renderSessionInfo();
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

// ---------- Live "Working" activity card ----------
// A single STABLE container that holds the thinking widget + every tool chip
// during a run. It has a FIXED max height with an internally-scrolling list, so
// the chat layout never grows or jumps as tools fire — the area stays one
// consistent card. On completion it collapses to a compact "N tools used" pill.
function createActivityCard() {
  const card = document.createElement("div");
  card.className = "activity-card is-live";

  const head = document.createElement("button");
  head.type = "button";
  head.className = "activity-card-head";
  head.setAttribute("aria-expanded", "true");
  const pulse = document.createElement("span");
  pulse.className = "activity-pulse";
  const headLabel = document.createElement("span");
  headLabel.className = "activity-card-title";
  headLabel.textContent = "Working…";
  const count = document.createElement("span");
  count.className = "activity-card-count";
  const caret = document.createElement("span");
  caret.className = "activity-card-caret";
  caret.textContent = "▸";
  head.appendChild(pulse);
  head.appendChild(headLabel);
  head.appendChild(count);
  head.appendChild(caret);

  const body = document.createElement("div");
  body.className = "activity-card-body";

  card.appendChild(head);
  card.appendChild(body);

  let toolCount = 0;
  let doneCount = 0;
  let open = true;

  const setOpen = (v) => {
    open = v;
    card.classList.toggle("is-open", open);
    head.setAttribute("aria-expanded", open ? "true" : "false");
  };
  setOpen(true);
  head.addEventListener("click", () => setOpen(!open));

  const refreshCount = () => {
    count.textContent = toolCount ? (doneCount + "/" + toolCount) : "";
  };

  // Public API used by the streaming block.
  card._body = body;
  card._addThinking = (widget) => { body.appendChild(widget); };
  card._addChip = (chip) => {
    toolCount++;
    body.appendChild(chip);
    refreshCount();
    // Keep the newest chip in view inside the scrolling list.
    body.scrollTop = body.scrollHeight;
    // Wrap the terminal-state setters so the done counter advances.
    const origRes = chip._setResult.bind(chip);
    const origErr = chip._setError.bind(chip);
    const origUnk = chip._setUnknown.bind(chip);
    chip._setResult = (r) => { doneCount++; origRes(r); refreshCount(); };
    chip._setError = (e) => { doneCount++; origErr(e); refreshCount(); };
    chip._setUnknown = () => { doneCount++; origUnk(); refreshCount(); };
  };
  // Collapse to a compact summary pill when the run finishes.
  card._finish = () => {
    card.classList.remove("is-live");
    card.classList.add("is-finished");
    pulse.classList.add("is-done");
    headLabel.textContent = toolCount
      ? ("Used " + toolCount + (toolCount === 1 ? " tool" : " tools"))
      : "Done";
    refreshCount();
    setOpen(false); // collapse — the area shrinks to a single pill line
  };
  return card;
}

// Rebuild the activity card for a SAVED message (history replay / reload).
//
// The activity card is the ONE canonical home for thinking + tool chips, live
// and historical alike. Previously the live card was left in the log on finish
// AND renderMessage appended a second thinking widget plus a second full set of
// chips into .msg-tools — so every completed turn showed its tools twice, and a
// reload showed them in a completely different shape than the run had. Same
// component both ways now.
function buildActivityRecord(m) {
  const card = createActivityCard();
  if (m.thinking) card._addThinking(createThinkingWidget(m.thinking, { streaming: false }));
  for (const t of (m.toolCalls || [])) {
    const chip = createToolChip(t.name, t.args || {}, { historical: true });
    card._addChip(chip);
    if (t.error) chip._setError(t.error);
    else if (t.result != null) chip._setResult(t.result);
    else chip._setUnknown();
  }
  card._finish();
  return card;
}

// ---------- Tool-call activity chip ----------
// Creates a compact inline chip with a status icon (spinner while running,
// green check when done, red x on error) plus a live elapsed-time readout so
// long-running tools never look "stuck". Clicking expands args/result detail.
function createToolChip(name, args, opts) {
  const o = opts || {};
  const chip = document.createElement("div");
  chip.className = "tool-chip is-running";
  chip.setAttribute("data-state", "collapsed");

  const head = document.createElement("button");
  head.type = "button";
  head.className = "tool-chip-head";
  const icon = document.createElement("span");
  icon.className = "tool-chip-icon";
  icon.innerHTML = '<span class="tool-chip-play"></span><span class="tool-chip-spinner"></span>';
  const label = document.createElement("span");
  label.className = "tool-chip-name";
  label.textContent = name || "tool";
  // Status badge — a compact pill that reads "running 3s" while the tool works,
  // then flips to "done" / "error" on completion. This is the key fix for chips
  // that looked "stuck" in an infinite spinner during long polling loops: the
  // elapsed counter makes it obvious the tool is actively working.
  const badge = document.createElement("span");
  badge.className = "tool-chip-badge";
  badge.textContent = "running…";
  const okLabel = document.createElement("span");
  okLabel.className = "tool-chip-ok";
  const caret = document.createElement("span");
  caret.className = "tool-chip-caret";
  caret.textContent = "▸";
  head.appendChild(icon);
  head.appendChild(label);
  head.appendChild(badge);
  head.appendChild(okLabel);
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

  // Live elapsed-time ticker — shows how long the tool has been running so a
  // long polling loop is obviously "working", not frozen.
  let startTime = Date.now();
  let timerId = null;
  const fmtTime = (ms) => {
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    const rs = s % 60;
    return m + "m " + (rs < 10 ? "0" : "") + rs + "s";
  };
  const startTimer = () => {
    startTime = Date.now();
    if (timerId) return;
    timerId = setInterval(() => {
      badge.textContent = "running " + fmtTime(Date.now() - startTime);
    }, 250);
  };
  const stopTimer = () => {
    if (timerId) { clearInterval(timerId); timerId = null; }
  };
  // A HISTORICAL chip (replayed from a saved message) is already finished, so it
  // must never start a ticker. Previously every replayed chip started a 250ms
  // setInterval that nothing ever stopped: a chip whose result wasn't recorded
  // sat spinning "running 14m 32s" forever, and a long conversation accumulated
  // one live interval per chip. This is the "chips stuck loading" bug.
  if (!o.historical) startTimer();

  const markDone = (markHtml) => {
    stopTimer();
    icon.innerHTML = markHtml;
    chip.classList.remove("is-running");
  };
  chip._setResult = (res) => {
    markDone('<span class="tool-chip-done">✓</span>');
    chip.classList.add("is-done");
    badge.textContent = "done";
    const txt = String(res == null ? "" : res);
    // Truncate very long results in the detail view but keep full text via title.
    resultLine.textContent = txt.length > 1200 ? txt.slice(0, 1200) + "\n…(truncated)" : txt;
  };
  // A replayed chip whose result was never recorded: show it as finished with an
  // unknown outcome rather than as perpetually running.
  chip._setUnknown = () => {
    markDone('<span class="tool-chip-done">✓</span>');
    chip.classList.add("is-done");
    badge.textContent = "done";
    resultLine.textContent = "(result not recorded)";
  };
  chip._setError = (err) => {
    markDone('<span class="tool-chip-error">✕</span>');
    chip.classList.add("is-error");
    badge.textContent = "error";
    resultLabel.textContent = "Error";
    resultLine.textContent = String(err || "error");
  };
  // The turn ended while this tool was still in flight (aborted, or the engine
  // never settled the call). Without this the chip kept its ticker running
  // forever, showing "running 6m 05s" with an empty result — the single most
  // "broken-looking" thing in the chat.
  chip._setInterrupted = () => {
    markDone('<span class="tool-chip-error">–</span>');
    chip.classList.add("is-error");
    badge.textContent = "interrupted";
    resultLabel.textContent = "Interrupted";
    resultLine.textContent = "The turn ended before this tool returned.";
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
function updateChatEmpty() {
  const c = activeConversation();
  const hasMessages = !!(c && c.messages && c.messages.length);
  if (el.chatEmpty) el.chatEmpty.classList.toggle("hidden", hasMessages || !c);
}
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
    updateChatEmpty();
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
  updateChatEmpty();
}
function renderMessage(m) {
  const role = m.role || "system";
  // Thinking + tool chips live together in ONE collapsed activity card above the
  // message body — the same component the live run uses.
  if (m.thinking || (m.toolCalls && m.toolCalls.length)) {
    el.chatLog.appendChild(buildActivityRecord(m));
  }
  const row = document.createElement("div");
  row.className = "msg " + role + (m.event ? " is-event" : "");

  // Role avatar — a small glyph label to the left of the bubble (Codex-style).
  const avatar = document.createElement("div");
  avatar.className = "msg-avatar";
  if (m.event) { avatar.textContent = "⤳"; avatar.classList.add("avatar-event"); }
  else if (role === "user") { avatar.textContent = "You"; avatar.classList.add("avatar-user"); }
  else if (role === "assistant") { avatar.textContent = "◆"; avatar.classList.add("avatar-assistant"); }
  else { avatar.textContent = "•"; avatar.classList.add("avatar-system"); }

  const col = document.createElement("div");
  col.className = "msg-col";

  // Role label row (hidden for system pills).
  if (role !== "system") {
    const lab = document.createElement("div");
    lab.className = "msg-role";
    lab.textContent = m.event ? "Agent event" : (role === "user" ? "You" : "Orchestrator");
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
    "STATE DOES NOT SURVIVE YOUR TURN — RECORD IT OR RECOVER IT",
    "═══════════════════════════════════════════════════════════════",
    "",
    "Use as many tool calls as the job needs. Do NOT pace yourself, do NOT ration calls, and do NOT announce that you are running low on them — just do the work. If a turn ever does get cut short, you will be prompted to continue and you pick up where you left off.",
    "",
    "The one real constraint: YOUR TOOL CALLS AND THEIR RESULTS ARE NOT REPLAYED INTO YOUR NEXT TURN. Next turn you see the conversation text only — not the JSON create_worktree returned, not the session ids. So:",
    "  • WRITE THE FACTS INTO YOUR REPLY as you go: one line per agent with its subtask, branch name, worktree path and session id. This is how you (and the user) keep track.",
    "  • RECOVER state instead of guessing: list_sessions({}) and list_worktrees({}) read live app state and always work, and a live snapshot of every terminal is already in your context each turn. Use them at the start of a turn rather than assuming a branch or session from earlier still exists.",
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
    "STEP 4 — MONITOR each agent.",
    "",
    "  ⚠ THE ONE THING TO UNDERSTAND ABOUT MONITORING: a coding CLI is a REPL. Claude Code and Codex do NOT exit when they finish a task — they print their result and sit at their input prompt indefinitely. So 'the session is still running' tells you NOTHING about whether the agent is still working. NEVER wait for a session to EXIT; you would wait forever. The signal you want is IDLE = the agent went quiet at its prompt = its turn is complete.",
    "",
    "  • YOU ALREADY SEE EVERY TERMINAL. Your system context contains a LIVE SNAPSHOT of all sessions each turn: each one's status (WORKING / IDLE / NEEDS INPUT / EXITED) and the last lines on its screen. Read that FIRST. You usually do not need a tool call to know what is happening.",
    "  • wait_for_session({ sessionId: <id>, timeoutMs: 600000 }) is the main monitoring call: it returns as soon as that agent finishes its turn, gets blocked, or exits. Use a generous timeout — it returns early, so a large value costs nothing. Call it once per agent rather than polling.",
    "  • list_sessions({}) gives every agent's status in one line each — use it to pick up state at the start of a turn.",
    "  • read_session({ sessionId: <id> }) returns the TAIL of a terminal (pass full:true for everything). Use it when you need more detail than the snapshot shows — not to check whether an agent is busy.",
    "  • When an agent reaches IDLE, its subtask is done as far as it is concerned: review its output, then MERGE its worktree. Do not call wait_for_session on it again unless you have given it new work with send_to_session.",
    "  • The app AUTO-SUBMITS the taskPrompt you passed to start_cli_session (it types the text and presses Enter once the agent is ready). Do not re-send the initial task.",
    "  • If auto-follow is enabled, you will be woken automatically with a '[Term Coder] The agent … has FINISHED ITS TURN' message when an agent stops. Treat that as your cue to review, merge, and continue — you do not need to sit in a waiting loop.",
    "  • Report progress on ALL agents to the user — which are still working, which are done, which hit errors.",
    "  • Use send_to_session({ sessionId: <id>, text }) ONLY for follow-up instructions AFTER an agent's input box is accepting text — not for startup dialogs.",
    "  • Do NOT loop read_session rapidly. Prefer wait_for_session to block for completion, or list_sessions to check status without dumping output. Only call read_session when you need to read the actual terminal text.",
    "  • send_to_session takes CONTENT in `text` and a KEYPRESS in `key` — e.g. { text: \"do X instead\", key: \"enter\" }. Never put escape codes in `text`; they would be typed as visible characters. Use key:\"ctrl+c\" to interrupt, key:\"enter\" to submit.",
    "  • NEVER try to confirm or send keystrokes to the agent's 'trust this folder?' dialog yourself. That dialog is handled by the app's settings and/or a chat pill picker. If the session keeps showing the trust dialog, you may say in chat that the agent is waiting for trust approval — but do NOT send Enter or arrow keys to it.",
    "  • NEVER try to select a model by sending arrow keys to an interactive model menu. The user already chooses the model when they approve the session spawn (or via Model Selection Mode in Settings). If read_session still shows a model picker, STOP and ask the user to pick the model in Settings or in the spawn dialog.",
    "  • The session auto-handles startup: trust confirmation (or asking you in chat) and typing/submitting the taskPrompt once the agent is ready. You just call start_cli_session, then wait and use read_session / wait_for_session to watch. Do not re-send the initial task.",
    "  • The session ALSO auto-handles command approvals: when ANY coding agent (Codex, Claude Code, or any CLI) asks for permission to run a command or make an edit, the app auto-approves safe edits/commands and only asks the user in chat for destructive ones (rm -rf, delete, drop, force push, etc.). You do NOT need to send Enter or Escape to these approval prompts yourself — the app does it for you. Just keep monitoring with read_session / list_sessions.",
    "  • A session showing NEEDS INPUT means the coding agent is blocked. There are two cases:",
    "    (a) PERMISSION PROMPT — the agent is asking to run a command/make an edit. The app auto-handles these (safe = auto-approve, destructive = asks user in chat). Do NOT send keystrokes — just keep monitoring the other agents.",
    "    (b) GENUINE QUESTION FOR YOU — the agent printed the [ORCHESTRATOR_INPUT_NEEDED] sentinel and is asking YOU a question (shown in the QUESTION field of the NEEDS INPUT header). You CAN and SHOULD answer it: call send_to_session({ sessionId: <id>, text: \"<your answer>\", key: \"enter\" }). After you respond, the agent will continue.",
    "  • The app injects an ORCHESTRATOR PROTOCOL into every agent's task prompt telling it to print [ORCHESTRATOR_INPUT_NEEDED] <question> when it needs a decision from you. So if an agent gets stuck or needs clarification, it will ask you this way — and you'll see the question in read_session / list_sessions. Answer it promptly with send_to_session so the agent isn't blocked.",
    "  • If a session shows NEEDS INPUT with '(agent appears idle)' it means the terminal is showing a prompt cursor with no recent activity. Use read_session to check what it actually shows — it may be done, or waiting on something the app didn't recognize. Use your judgment.",
    "  • If read_session returns 'Error: no such terminal session' shortly after start, the session was killed. Do NOT immediately re-call start_cli_session with the same args — that creates a loop. Instead explain what happened (likely trust declined) and ask the user how to proceed.",
    "",
    "STEP 5 — MERGE each worktree back to the parent branch when its agent is done.",
    "  • When an agent's status is IDLE (turn complete) and its output shows the subtask finished, call merge_worktree({ branchName: <branch from create_worktree> }) to merge that branch into the parent branch (usually main) and clean up the worktree.",
    "  • Merge agents ONE AT A TIME as they finish. Do not wait for ALL agents before merging — merge each as soon as it's done.",
    "  • Before the LAST merge, call list_sessions({}) and confirm no agent is still WORKING. Do NOT look for EXITED — these CLIs stay running by design. IDLE is the finished state.",
    "  • If merge_worktree reports CONFLICTS, the worktree is preserved. Tell the user which subtask conflicted and that manual resolution is needed, or spawn a follow-up agent in the worktree to resolve the conflicts.",
    "  • After all worktrees are merged, do a final read_session on the main project to verify the combined result, or inspect with list_project_files.",
    "",
    "STEP 6 — Complete the task.",
    "  • When all agents are done and all worktrees merged, summarize what was accomplished.",
    "  • Read the attached Kanban board with get_board({}) and call update_card({ cardId, done:true }) to mark the task complete (if a card exists for it).",
    "",
    "═══════════════════════════════════════════════════════════════",
    "WHEN AN AGENT GETS STUCK — TALK TO IT, DON'T REPLACE IT",
    "═══════════════════════════════════════════════════════════════",
    "",
    "A running agent holds context you cannot recover: everything it has read, the plan it made, and any edits it has not yet written to disk. Replacing it throws all of that away and starts from zero. So a stuck agent is a CONVERSATION problem first, not a lifecycle problem. Work down this ladder IN ORDER and do not skip steps:",
    "",
    "  1. UNDERSTAND the failure. Read its output. If the app reports STATUS: ERROR LOOP, the exact error text is in the header — that is what you must address.",
    "  2. CORRECT IT IN PLAIN LANGUAGE with send_to_session({ sessionId, text: \"<instruction>\", key: \"enter\" }). Tell it what to do differently, as you would tell a colleague. Examples:",
    "       • 'API Error: this model does not support image input' → \"Your model cannot read images. Do not open or read any image files. Work from the source code and the text descriptions instead.\"",
    "       • context/token limit → \"You are running out of context. Stop exploring, summarise what you have learned, and make the edits now.\"",
    "       • rate limit / 429 / overloaded → \"Wait a few seconds and retry that request once, then continue.\"",
    "       • it is looping on the same action → \"Stop repeating that step. It is failing and will keep failing. Skip it and continue with the rest of the task.\"",
    "  3. INTERRUPT then correct, if it is mid-operation and not reading you: send_to_session({ sessionId, key: \"ctrl+c\" }), wait a moment, THEN send the instruction from step 2.",
    "  4. ONLY IF IT IS GENUINELY UNUSABLE after steps 2 and 3: close_session({ sessionId, reason }) and start a fresh agent in the SAME worktree (its committed and on-disk work is still there).",
    "",
    "Hard rules:",
    "  • NEVER start a second agent in a worktree that already has a live session. Two agents in one directory edit the same files and clobber each other — that is exactly what worktree isolation exists to prevent. start_cli_session will refuse, and the refusal message tells you the session id to talk to instead.",
    "  • One error is not a reason to replace an agent. Even several errors are not, if you have not yet told it what to do differently.",
    "  • Do NOT try to 'clear junk' out of an agent's input box by sending arrow keys, Escape, or repeated control characters. If the screen looks garbled, send Ctrl+C once and then a clear instruction. Blind keystroking makes the real state worse.",
    "  • If you cannot get an agent working after the ladder above, STOP and tell the user what the error was and what you tried. Do not keep spawning agents.",
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

  // ---- LIVE APP STATE ----
  // Regenerated on every turn. This is what makes multi-turn orchestration
  // possible at all: the model's own tool-call history is not replayed, so
  // without this it starts each turn with no idea which agents it launched or
  // which worktrees are waiting to be merged.
  sys.push("", "═══════════════════════════════════════════════════════════════",
    "LIVE APP STATE (regenerated every turn — trust this over your memory)",
    "═══════════════════════════════════════════════════════════════", "");
  if (sessions.size) {
    // LIVE TERMINAL SNAPSHOT. This is the orchestrator's actual view into the
    // terminals: status plus the tail of what each one is showing right now,
    // refreshed every turn with no tool call needed. Before this, the only way to
    // see a terminal was to spend a tool call on read_session, so in practice the
    // orchestrator was flying blind between explicit reads.
    sys.push("CURRENT SESSIONS (" + sessions.size + ") — live snapshot, refreshed this turn:");
    for (const s of sessions.values()) {
      const act = sessionActivity(s);
      let status = act;
      if (act === "EXITED") {
        status = "EXITED (code " + ((s.exitCode !== undefined && s.exitCode !== null) ? s.exitCode : "killed") + ")";
      } else if (act === "IDLE") {
        const quiet = Math.round((Date.now() - (s.lastOutputAt || Date.now())) / 1000);
        status = "IDLE — finished its turn, quiet " + quiet + "s at its prompt";
      } else if (act === "ERROR LOOP") {
        status = "ERROR LOOP — retrying a failing call, needs a correction from you";
      }
      sys.push("", "── [" + s.id + "] " + (s.label || s.id) + " | " + status + " | cwd " + (s.cwd || "(unknown)"));
      if (act === "NEEDS INPUT" && s.pendingQuestion) {
        sys.push("   BLOCKED, asking: " + s.pendingQuestion.split("\n")[0].slice(0, 200));
      }
      if (act === "ERROR LOOP") {
        sys.push("   STUCK RETRYING AN ERROR (" + (s.errorCount || 0) + "x): " + String(s.lastErrorText || "").slice(0, 200));
        sys.push("   → Send this agent a plain-language correction with send_to_session. Do NOT close it and do NOT start another agent in its worktree.");
      }
      // Tail of the screen, kept short so several sessions stay affordable.
      let tail = "";
      try {
        if (s.session && typeof s.session.getOutput === "function") {
          const raw = await s.session.getOutput();
          tail = raw ? stripAnsi(raw) : "";
        }
      } catch (e) { /* a dead session just gets no snapshot */ }
      if ((s.trustState === "pending" || s.trustState === "asking") && s.trustMode !== "always" &&
          /do\s*you\s*trust|trust\s*the\s*(files|contents|folder|directory)/i.test(tail)) {
        sys.push("   (waiting for the user to approve 'trust this folder' in chat — do NOT send keystrokes)");
      } else if (tail.trim()) {
        const lines = tail.split("\n")
          .map((l) => l.replace(/\s+$/, ""))
          .filter((l) => l.trim())
          // Drop the echo of our own task prompt. The agent's TUI keeps the
          // submitted message in its transcript, so without this every snapshot
          // of every session repeated ~600 characters of ORCHESTRATOR PROTOCOL
          // boilerplate back at the model each turn.
          .filter((l) => !/\[ORCHESTRATOR PROTOCOL\]/.test(l));
        sys.push("   last screen lines:");
        for (const l of lines.slice(-12)) sys.push("   | " + l.slice(0, 160));
      } else {
        sys.push("   (no output yet)");
      }
    }
    sys.push("", "Read the snapshot above BEFORE calling read_session — it usually already tells you what you need. IDLE means that agent's turn is finished: review its work and merge its worktree rather than waiting on it again.");
  } else {
    sys.push("CURRENT SESSIONS: (none running — nothing has been spawned yet, or all were closed)");
  }
  sys.push("");
  if (worktreeMeta.size) {
    sys.push("OPEN WORKTREES (" + worktreeMeta.size + " — created and NOT yet merged):");
    for (const [branch, m] of worktreeMeta.entries()) {
      sys.push("- branch " + branch + " | parent " + (m.parentBranch || "main") + " | path " + (m.wtPath || "(unknown)"));
    }
    sys.push("Merge each of these with merge_worktree({ branchName: <branch> }) once its agent has finished.");
  } else {
    sys.push("OPEN WORKTREES: (none — every worktree has been merged and cleaned up)");
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
// No single tool call may hang the turn. `terminal.exec` never settles while an
// unanswered permission prompt is up, and a monitoring call can outlive the
// user's patience — either way the orchestrator used to sit there with chips
// reading "running 6m 05s" and an empty result, unable to make progress. A raced
// timeout guarantees the engine always gets a string back and the chip resolves.
const TOOL_TIMEOUT_MS = 90 * 1000;
const TOOL_TIMEOUT_OVERRIDES = { wait_for_session: 15 * 60 * 1000 };
async function runToolWithTimeout(name, args) {
  const limit = TOOL_TIMEOUT_OVERRIDES[name] || TOOL_TIMEOUT_MS;
  let timer = null;
  try {
    return await Promise.race([
      toolHandler(name, args),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(
          "Error: the " + name + " tool did not return within " + Math.round(limit / 1000) +
          "s and was abandoned. This usually means it is blocked on something outside the app — most often an unanswered terminal-permission prompt. Tell the user what you were trying to do and ask them to check for a pending approval, then continue with something else."
        ), limit);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function setRunning(r) {
  running = r;
  el.sendBtn.classList.toggle("is-running", r);
  el.sendBtn.title = r ? "Stop" : "Send";
  el.sendBtn.setAttribute("aria-label", r ? "Stop" : "Send");
  if (el.sendIcon) el.sendIcon.classList.toggle("hidden", r);
  if (el.stopIcon) el.stopIcon.classList.toggle("hidden", !r);
  el.chatInput.disabled = r;
}

// textOverride lets the app itself start a turn (see autoFollowTick). opts.event
// marks the message as an app-generated event so it renders distinctly from
// something the user actually typed.
async function sendMessage(textOverride, opts) {
  const o = opts || {};
  const c = activeConversation();
  if (!c) { setStatus("Select or create a conversation first."); return; }
  if (running) return;
  const text = textOverride != null ? String(textOverride).trim() : el.chatInput.value.trim();
  if (!text) return;
  if (textOverride == null) el.chatInput.value = "";

  const userMsg = { role: "user", content: text };
  if (o.event) userMsg.event = true;
  c.messages.push(userMsg);
  saveState();
  renderMessage(userMsg);
  scrollChatBottom(false);
  updateChatEmpty();

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
  // Chip elements for this turn, so any still spinning when the turn ends can be
  // resolved instead of ticking forever.
  const liveChips = [];
  let firstTokenSeen = false;
  // Set when a tool call lands, so the next text token starts a new paragraph
  // instead of butting up against the previous segment's final word.
  let segmentBreakPending = false;

  // Stable activity card — holds thinking + all tool chips at a fixed height so
  // the layout never grows/jumps while tools fire. Created lazily on the first
  // thinking token or tool call, and collapsed to a compact pill on completion.
  let activityCard = null;
  const ensureActivityCard = () => {
    if (!activityCard) {
      activityCard = createActivityCard();
      el.chatLog.insertBefore(activityCard, liveRow);
    }
    return activityCard;
  };

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
        // The engine streams a separate text segment per tool round. Concatenating
        // them raw ran sentences together across the boundary ("…improvements.Now
        // I'll spawn…"), so start a new paragraph when a tool call interrupted
        // the prose.
        if (segmentBreakPending) {
          segmentBreakPending = false;
          if (accContent && !/\n\n$/.test(accContent)) accContent += "\n\n";
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
          ensureActivityCard()._addThinking(liveThink);
          maybeScrollChatBottom();
        }
        accThink += t;
        liveThink._update(accThink);
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
        // Add a compact chip inside the stable activity card (fixed height,
        // internal scroll) so the layout never jumps as tools fire.
        const chip = createToolChip(name, args);
        liveChips.push(chip);
        ensureActivityCard()._addChip(chip);
        if (accContent) segmentBreakPending = true;
        maybeScrollChatBottom();
        try {
          const res = await runToolWithTimeout(name, args);
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
    // Remove the LIVE activity card — renderMessage below rebuilds an identical
    // collapsed card from the saved message. Keeping both produced two copies of
    // every thinking widget and tool chip on screen.
    if (activityCard) activityCard.remove();

    let storedToolCalls = liveToolCalls.length ? liveToolCalls : undefined;
    if (result && result.toolCalls && result.toolCalls.length) {
      // The engine's toolCalls list is authoritative for WHAT ran, but it carries
      // no results — those only exist in the liveToolCalls entries we filled in
      // from onToolCall. Overwriting wholesale (the old behaviour) discarded every
      // result, so replayed chips had nothing to show and rendered as unfinished.
      // Merge instead: consume live entries in order, matched by tool name.
      const pending = liveToolCalls.slice();
      storedToolCalls = result.toolCalls.map(normalizeToolCall).map((tc) => {
        const i = pending.findIndex((p) => p.name === tc.name);
        if (i === -1) return tc;
        const live = pending.splice(i, 1)[0];
        return { name: tc.name, args: tc.args, result: live.result, error: live.error };
      });
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
    // On error there is no saved assistant message to rebuild the card from, so
    // KEEP the live card (collapsed) — it's the only record of what ran.
    if (activityCard) activityCard._finish();
    setStatus("");
    const msg = "Error: " + (e && e.message ? e.message : String(e));
    c.messages.push({ role: "system", content: msg });
    saveState();
    renderMessage({ role: "system", content: msg });
    maybeScrollChatBottom();
  } finally {
    // Nothing may be left spinning. If the turn ended (normally, by error, or by
    // abort) while a tool call was still outstanding, mark those chips
    // interrupted so they stop their tickers and read honestly.
    for (const ch of liveChips) {
      if (ch.classList.contains("is-running") && typeof ch._setInterrupted === "function") ch._setInterrupted();
    }
    setRunning(false);
    abortController = null;
  }
}

// ---------- Auto-follow: wake the orchestrator when an agent stops ----------
// Coding CLIs are REPLs — they finish a task and sit at their prompt forever.
// Nothing in the app used to react to that, so after spawning agents the
// orchestrator went silent until the user typed something, which is what made
// the whole loop feel like it had stalled. This watcher notices a delegated
// session finishing its turn (or exiting, or getting blocked) and starts one
// orchestrator turn so it can review, merge, and move the plan forward.
let autoFollowTimer = null;
let lastAutoFollowAt = 0;
const AUTO_FOLLOW_COOLDOWN_MS = 8000;

function autoFollowTick() {
  if (settings.autoFollow === false) return;
  if (running) return;                                  // orchestrator is already busy
  if (Date.now() - lastAutoFollowAt < AUTO_FOLLOW_COOLDOWN_MS) return;
  if (!activeConversation()) return;

  for (const rec of sessions.values()) {
    const act = sessionActivity(rec);
    // Only report a CHANGE, and only the states that mean "your turn".
    if (act === rec._lastReportedActivity) continue;
    const wasReported = rec._lastReportedActivity;
    rec._lastReportedActivity = act;
    if (!rec.fromOrchestrator) continue;                // user-driven terminal: leave it alone
    if (act !== "IDLE" && act !== "EXITED" && act !== "NEEDS INPUT") continue;
    // Don't fire on the very first classification of a brand-new session.
    if (wasReported === undefined) continue;

    let note;
    if (act === "EXITED") {
      note = "[Term Coder] The agent \"" + (rec.label || rec.id) + "\" (session " + rec.id + ") has EXITED.";
    } else if (act === "NEEDS INPUT") {
      note = "[Term Coder] The agent \"" + (rec.label || rec.id) + "\" (session " + rec.id + ") is BLOCKED waiting for input" +
        (rec.pendingQuestion ? ": " + rec.pendingQuestion.split("\n")[0].slice(0, 200) : ".");
    } else {
      note = "[Term Coder] The agent \"" + (rec.label || rec.id) + "\" (session " + rec.id + ") has FINISHED ITS TURN and is idle at its prompt.";
    }
    note += " Check the live snapshot in your context, then continue the plan: merge its worktree if the subtask is done, answer it if it asked something, or spawn the next subtask. Do not wait on this agent again unless you have given it new work.";
    lastAutoFollowAt = Date.now();
    sendMessage(note, { event: true });
    return; // one wake-up per tick; the next tick picks up any others
  }
}

function startAutoFollow() {
  if (autoFollowTimer) return;
  autoFollowTimer = setInterval(autoFollowTick, 2500);
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

  // trustState starts at "none", NOT "pending": only autoDriveStartup (i.e. a
  // session started with a task prompt) manages a trust dialog, and it sets
  // "pending" itself. A manually-spawned session with no prompt is driven by the
  // user in the terminal widget, and must not be treated as blocked on trust —
  // that would suppress its approval handling forever.
  const rec = { id: session.id, session, cmd, args, cwd, label, active: true, exitCode: null, squareEl: square, mountEl, dispose: null, expanded: false, trustState: "none", trustMode: null, autoApproveBusy: false, autoApproveUnsub: null, waitingForInput: false, pendingQuestion: "", _idleTimer: null, _busyTimer: null, _lastApprovalKey: "", _lastApprovalAt: 0, _approveCooldownUntil: 0, _sentinelKey: "",
    // Activity tracking — this is what lets the app tell "the agent is working"
    // from "the agent finished its turn and is sitting at its prompt". A coding
    // CLI is a REPL: it does NOT exit when the task is done, so process exit is
    // useless as a completion signal (waiting for it was why monitoring felt
    // dead for minutes at a time).
    lastOutputAt: Date.now(), taskSubmittedAt: 0, bytesSinceTask: 0, tailAtPrompt: false,
    lastErrorText: "", errorCount: 0, lastErrorAt: 0, errorLoop: false };
  sessions.set(session.id, rec);

  // autoDriveStartup calls this right after it sends the task, so idle detection
  // can distinguish "finished a turn" from "never started".
  rec._markTaskSubmitted = () => {
    rec.taskSubmittedAt = Date.now();
    rec.bytesSinceTask = 0;
  };

  // Set autoApproveBusy WITH a watchdog. This flag gates the entire monitor, so
  // any path that sets it and fails to clear it (an approval picker the user
  // never answers, a rejected promise) silently blinds the orchestrator to this
  // terminal for the rest of the session. The timer guarantees recovery.
  const setApproveBusy = (on) => {
    rec.autoApproveBusy = !!on;
    if (rec._busyTimer) { clearTimeout(rec._busyTimer); rec._busyTimer = null; }
    if (on) {
      rec._busyTimer = setTimeout(() => {
        rec._busyTimer = null;
        if (rec.autoApproveBusy) {
          console.warn("[Term Coder] autoApproveBusy watchdog fired for", rec.label);
          rec.autoApproveBusy = false;
        }
      }, APPROVE_BUSY_TIMEOUT_MS);
    }
  };

  // ---------- Universal terminal monitor ----------
  // Watches every session's output and detects THREE kinds of events so the
  // orchestrator always knows what's going on inside ANY terminal, regardless
  // of which coding-agent CLI produced the output:
  //
  //   1. ORCHESTRATOR_INPUT_NEEDED sentinel — the agent followed the protocol
  //      we prepended to its task prompt and is asking us a question. We surface
  //      the question text to the orchestrator (via rec.pendingQuestion) and do
  //      NOT auto-respond — the orchestrator decides the answer and types it via
  //      send_to_session. Works with ANY CLI that can print text.
  //
  //   2. Permission/approval prompts — the agent is asking to run a command or
  //      make an edit (Codex's "Yes, proceed", Claude's "Do you want to make this
  //      edit?", or a generic y/n prompt). Safe ones auto-approve; destructive
  //      ones ask the user in chat.
  //
  //   3. Generic idle — the terminal has shown a prompt cursor (❯ › $ >) with no
  //      new output for a while. This catches agents that don't follow the
  //      protocol and just sit waiting. We mark the session NEEDS INPUT so the
  //      orchestrator knows to check on it.

  // Extract the question text that follows the orchestrator-input marker.
  function extractSentinelQuestion(text) {
    const m = text.match(ORCH_SENTINEL_RE);
    if (!m) return "";
    // Grab the marker line + any following context lines (up to ~500 chars).
    let q = (m[1] || "").trim();
    const after = text.slice(m.index + m[0].length);
    const ctxLines = after.split("\n").filter((l) => l.trim() && !/^(─|❯|›|\$|>)/.test(l.trim())).slice(0, 4);
    if (ctxLines.length) q += "\n" + ctxLines.join("\n").trim();
    return q.slice(0, 500);
  }

  // Classify a permission prompt. Returns null when there's no prompt, else
  // { kind: "safe-edit" } | { kind: "safe-command", command } | { kind: "dangerous", command }.
  function classifyApprovalPrompt(cleanText, flat) {
    // NEVER treat a folder-trust dialog as a command approval. Claude Code's
    // trust dialog offers "1. Yes, proceed", which matches the Codex signature
    // below — so this monitor used to press Enter on it and silently confirm
    // trust, defeating the trustMode="ask" pill picker entirely. Trust is
    // handled exclusively by autoDriveStartup/handleTrust.
    if (/do\s*you\s*trust|trust\s*the\s*(files|contents|folder|directory)|trust\s*this\s*folder/.test(flat)) return null;
    // Codex command-approval signature.
    const codexSig = /yes,\s*proceed|press\s*enter\s*to\s*confirm|yes,\s*and\s*don'?t\s*ask\s*again/.test(flat);
    // Claude permission prompt signatures (edit / create / run / proceed / overwrite).
    const claudeSig = /do you want to make this edit|do you want to (proceed|create|run|delete|overwrite|make)|allow all edits during this session|esc to cancel/.test(flat);
    // Generic y/n confirmation (catches other CLIs: "Continue? (y/n)", "Proceed? [Y/n]").
    const genericYn = /\(y\/n\)|\[y\/n\]|\(yes\/no\)|\[yes\/no\]|proceed\?\s*$/m.test(flat) ||
      /continue\?\s*$/m.test(flat);
    if (!codexSig && !claudeSig && !genericYn) return null;

    // Extract the command/edit target text (the line(s) just above the options).
    let commandText = "";
    const ranMatch = cleanText.match(/Ran\s+(.+?)(?=\s*›|\s*1\.\s*Yes)/is);
    if (ranMatch) commandText = ranMatch[1].trim();
    if (!commandText) {
      const beforeYes = cleanText.split(/1\.\s*Yes/i)[0];
      commandText = (beforeYes.trim().split("\n").pop() || "").trim();
    }
    if (!commandText) {
      // Generic y/n fallback: grab the line before the (y/n).
      const beforeYn = cleanText.split(/\(y\/n\)|\[y\/n\]|\(yes\/no\)|\[yes\/no\]/i)[0];
      commandText = (beforeYn.trim().split("\n").pop() || "").trim();
    }

    // Dangerous command patterns — always ask the user before approving.
    const dangerous = /\brm\s+-rf?\b|\bdelete\b|\bdrop\s+(table|database)\b|\bformat\b|\btruncate\b|\bsudo\s+rm\b|\bgit\s+push\s+.*--force\b|\bchmod\s+777\b|\bkill\s+-9\b/i.test(commandText);
    if (dangerous) return { kind: "dangerous", command: commandText };

    // File edit/create prompts are the agent doing its job — always safe.
    const isEdit = /make this edit|create this (file|directory)|overwrite|allow all edits/.test(flat);
    if (isEdit) return { kind: "safe-edit", command: commandText };

    return { kind: "safe-command", command: commandText };
  }

  // Detect a generic idle prompt: a prompt cursor at the end of recent output
  // with no new activity. Returns true if the terminal looks idle/waiting.
  function isIdlePrompt(flat) {
    // Is an input prompt visible near the bottom of the screen?
    //
    // This must NOT require the prompt glyph to be the last thing in the output.
    // Claude Code draws chrome BELOW its input box — a cursor line and a mode
    // line like "⏸ manual mode on" — so the glyph is typically 2-4 lines from the
    // end and an end-anchored test never matched. That made IDLE unreachable for
    // Claude Code, so wait_for_session always ran to its full timeout and the
    // orchestrator never learned that an agent had finished.
    //
    // Note this is only half the signal: sessionActivity() requires the terminal
    // to ALSO have been quiet for TURN_IDLE_MS. These CLIs animate a spinner the
    // whole time they work, so silence is what really distinguishes "finished"
    // from "thinking" — this function just confirms we're parked at a prompt
    // rather than mid-stream.
    const lines = flat.split("\n").map((l) => l.replace(/[│┃▌▎]/g, " ").trim()).filter(Boolean);
    for (const l of lines.slice(-6)) {
      if (/^[❯›»>]/.test(l)) return true;              // an input prompt line
      if (/[^<\/\w]\$\s*$/.test(l) || /^\$\s*$/.test(l)) return true; // plain shell prompt
      // Persistent idle-state chrome from the common CLIs.
      if (/esc to cancel|esc to interrupt|tab to amend|manual mode on|accept edits on|plan mode on|\? for shortcuts/.test(l)) return true;
    }
    return false;
  }

  try {
    if (typeof session.onData === "function") {
      let monitorBuffer = "";
      let lastOutputTime = Date.now();
      // Let autoDriveStartup drop the echo of the task prompt out of the buffer
      // the moment it is submitted, so a long prompt can't linger and be
      // re-matched as terminal content.
      rec._resetMonitorBuffer = () => { monitorBuffer = ""; };

      rec.autoApproveUnsub = session.onData((chunk) => {
        if (!rec.active) return;
        monitorBuffer += chunk;
        lastOutputTime = Date.now();
        rec.lastOutputAt = lastOutputTime;
        if (rec.taskSubmittedAt) rec.bytesSinceTask += chunk.length;
        // Cap the buffer so a long session can't grow it unbounded — prompts
        // and markers are always near the tail, so keeping the last ~8KB is plenty.
        if (monitorBuffer.length > 8192) monitorBuffer = monitorBuffer.slice(-4096);
        const cleanText = stripAnsi(monitorBuffer);
        // Match prompts against the TAIL only. Matching the whole accumulated
        // buffer meant a prompt that had already been answered stayed matchable
        // for thousands of characters — and since TUIs redraw their scrollback
        // continuously, the same prompt kept re-triggering an auto-approve,
        // spraying stray Enter keystrokes into a working agent.
        const tailText = cleanText.slice(-1200);
        const tailFlat = tailText.toLowerCase();
        const now = Date.now();

        // Is this session still waiting on the folder-trust dialog? While it is,
        // the monitor must not touch the PTY at all — autoDriveStartup owns the
        // keyboard until the user answers the trust picker.
        const trustPending = rec.trustMode !== "always" &&
          (rec.trustState === "pending" || rec.trustState === "asking");

        // 0) Record agent/provider errors. Passive — this never touches the PTY,
        //    it just makes the failure visible to the orchestrator as a state
        //    instead of leaving it to notice error text in a screen dump.
        const errLine = detectAgentError(tailText);
        if (errLine) {
          if (errLine === rec.lastErrorText) {
            rec.errorCount = (rec.errorCount || 1) + 1;
          } else {
            rec.lastErrorText = errLine;
            rec.errorCount = 1;
          }
          rec.lastErrorAt = now;
          const looping = rec.errorCount >= ERROR_LOOP_THRESHOLD;
          if (looping && !rec.errorLoop) {
            rec.errorLoop = true;
            renderTabs();
            renderSessionInfo();
            try {
              window.chatoss.notifications.send({
                title: "Agent stuck on an error",
                body: (rec.label || "Agent") + ": " + errLine.slice(0, 120),
              });
            } catch (e) { /* non-fatal */ }
          }
        } else if (rec.errorLoop && now - (rec.lastErrorAt || 0) > 20000) {
          // Twenty seconds of error-free output means it recovered (or was
          // corrected) — stop reporting it as stuck.
          rec.errorLoop = false;
          rec.lastErrorText = "";
          rec.errorCount = 0;
          renderTabs();
          renderSessionInfo();
        }

        // 1) Orchestrator-input marker — the agent is asking us a question.
        //    Deduped by question text rather than by latching autoApproveBusy, so
        //    a pending question never blinds the monitor to approval prompts.
        const sentinelMatch = cleanText.match(ORCH_SENTINEL_RE);
        if (sentinelMatch) {
          const question = extractSentinelQuestion(cleanText);
          const key = question.slice(0, 160);
          if (key && key !== rec._sentinelKey) {
            rec._sentinelKey = key;
            rec.waitingForInput = true;
            rec.pendingQuestion = question;
            renderTabs();
            renderSessionInfo();
            // Notify the user about the pending question.
            try {
              window.chatoss.notifications.send({
                title: "Agent asking a question",
                body: (rec.label || "Agent") + ": " + question.split("\n")[0].slice(0, 120),
              });
            } catch (e) { /* non-fatal */ }
            // Do NOT auto-respond — the orchestrator decides the answer and types
            // it via send_to_session. Drop the marker from the buffer so the same
            // text doesn't keep re-matching, but keep rec.pendingQuestion +
            // waitingForInput set until the orchestrator acts.
            monitorBuffer = "";
            return;
          }
        }

        // 2) Permission / approval prompts.
        if (!rec.autoApproveBusy && !trustPending && now >= rec._approveCooldownUntil) {
          const verdict = classifyApprovalPrompt(tailText, tailFlat);
          // Ignore a prompt we just answered — the TUI keeps it on screen.
          const sameAsLast = verdict && verdict.command === rec._lastApprovalKey &&
            now - rec._lastApprovalAt < 4000;
          if (verdict && !sameAsLast) {
            setApproveBusy(true);
            rec.waitingForInput = true;
            rec._lastApprovalKey = verdict.command || "";
            rec._lastApprovalAt = now;
            renderTabs();
            renderSessionInfo();

            const settle = () => {
              monitorBuffer = "";
              rec._approveCooldownUntil = Date.now() + APPROVE_COOLDOWN_MS;
              setApproveBusy(false);
              rec.waitingForInput = false;
              rec.pendingQuestion = "";
              renderTabs();
              renderSessionInfo();
            };

            if (verdict.kind === "dangerous") {
              // Ask the user in chat before approving a destructive command.
              // .catch is essential: an askChoice that rejects would otherwise
              // leave autoApproveBusy set (the watchdog would clear it, but only
              // after 45s of the orchestrator being blind to this terminal).
              askCommandApproval(rec, verdict.command).then((approved) => {
                sendKey(session, approved ? "enter" : "escape").finally(settle);
              }).catch((e) => {
                console.warn("askCommandApproval failed", e);
                sendKey(session, "escape").finally(settle);
              });
            } else {
              // Safe edit / safe command — auto-approve. For Claude the default
              // highlighted option is "1. Yes", so Enter accepts it (we never
              // pick option 2 "allow all edits during this session" — that stays
              // the user's per-edit choice).
              sendKey(session, "enter").finally(settle);
            }
            return;
          }
        }

        // 3) Generic idle fallback — if there's no marker and no approval prompt
        //    but the terminal is showing a prompt cursor, flag it so the
        //    orchestrator knows to check on it.
        const idle = isIdlePrompt(tailFlat);
        // Cached for sessionActivity(), which is polled from wait_for_session and
        // read by buildSystemPrompt without touching the PTY.
        rec.tailAtPrompt = idle;
        if (!idle) {
          // Any non-idle output means the agent is working again. Clear a pending
          // timer AND an already-raised idle flag — the old code only did the
          // former, so once the idle flag was set nothing ever cleared it and the
          // session reported NEEDS INPUT forever.
          if (rec._idleTimer) { clearTimeout(rec._idleTimer); rec._idleTimer = null; }
          if (rec.waitingForInput && /^\(agent appears idle/.test(rec.pendingQuestion || "")) {
            rec.waitingForInput = false;
            rec.pendingQuestion = "";
            renderTabs();
            renderSessionInfo();
          }
        } else if (!rec.autoApproveBusy && !rec.waitingForInput && !rec._idleTimer) {
          // Only flag after a quiet period — an agent that is actually thinking
          // keeps emitting spinner frames, which refresh lastOutputTime.
          rec._idleTimer = setTimeout(() => {
            rec._idleTimer = null;
            if (!rec.active || rec.autoApproveBusy || rec.waitingForInput) return;
            if (Date.now() - lastOutputTime >= 5000) {
              rec.waitingForInput = true;
              rec.pendingQuestion = "(agent appears idle — terminal is showing a prompt cursor with no recent activity. Check on it with read_session to see what it needs.)";
              renderTabs();
              renderSessionInfo();
            }
          }, 5000);
        }
      });
    }
  } catch (e) { console.warn("universal terminal monitor setup failed:", e); }

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
        // Tear down monitor timers so an exited session can't keep firing
        // renderTabs()/renderSessionInfo() or flag a dead terminal as idle.
        if (rec._idleTimer) { clearTimeout(rec._idleTimer); rec._idleTimer = null; }
        if (rec._busyTimer) { clearTimeout(rec._busyTimer); rec._busyTimer = null; }
        rec.autoApproveBusy = false;
        rec.waitingForInput = false;
        rec.pendingQuestion = "";
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
  if (rec._idleTimer) { clearTimeout(rec._idleTimer); rec._idleTimer = null; }
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
      // Always detach the capturing keydown listener. It used to be removed only
      // on the Escape path, so every picker answered by CLICK leaked a
      // document-level capturing listener for the lifetime of the app.
      // (onKey is a hoisted function declaration, so this reference is safe.)
      document.removeEventListener("keydown", onKey, true);
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

    // Escape dismisses -> resolve null (cancel). Listens only while pending;
    // finish() detaches this listener on every path.
    function onKey(e) {
      if (e.key !== "Escape" || settled) return;
      e.stopPropagation();
      finish(null, null);
      if (typeof scrollChatBottom === "function") scrollChatBottom();
    }
    document.addEventListener("keydown", onKey, true);

    host.appendChild(row);
    if (typeof scrollChatBottom === "function") scrollChatBottom();
  });
};

// Keep the askChoice overlay clear of the composer stack. The overlay is
// absolutely positioned in .col-chat, and the block below it (status line +
// composer + hint + session info) changes height as the textarea grows and as
// the status line appears — so its offset has to be measured, not hard-coded.
function syncOverlayOffset() {
  const chatCol = document.querySelector(".col-chat");
  if (!chatCol) return;
  let h = 0;
  for (const sel of [".chat-status", ".composer-wrap", ".session-info"]) {
    const node = chatCol.querySelector(sel);
    if (node) h += node.getBoundingClientRect().height;
  }
  chatCol.style.setProperty("--overlay-bottom", Math.round(h + 10) + "px");
}

// Held at module scope on purpose: a ResizeObserver with no strong reference can
// be collected, silently stopping the resync.
let overlayRO = null;
function initOverlayOffset() {
  syncOverlayOffset();
  window.addEventListener("resize", syncOverlayOffset);
  // A ResizeObserver catches height changes we don't have an explicit hook for,
  // but it only delivers on a rendered frame — so the two changes that actually
  // matter (the textarea growing, the status line appearing) ALSO call
  // syncOverlayOffset directly from autoResizeInput and setStatus.
  try {
    overlayRO = new ResizeObserver(syncOverlayOffset);
    for (const sel of [".chat-status", ".composer-wrap", ".session-info"]) {
      const node = document.querySelector(sel);
      if (node) overlayRO.observe(node);
    }
  } catch (e) { /* resize listener + explicit hooks still cover it */ }
}

// ---------- Column resizers ----------
// The three columns are grid tracks sized by two CSS variables on .app-shell.
// Dragging a handle writes px values; with no saved layout the variables keep
// their responsive defaults (minmax) so the grid still adapts to the window.
const RZ_W = 5; // keep in sync with --rz-width in style.css
const COL_MIN = { projects: 180, chat: 360, terminals: 300 };

function shellEl() { return document.querySelector(".app-shell"); }

function currentColWidths() {
  const shell = shellEl();
  const proj = document.querySelector(".col-projects");
  const chat = document.querySelector(".col-chat");
  return {
    total: (shell && shell.clientWidth) || window.innerWidth,
    projects: proj ? proj.getBoundingClientRect().width : 264,
    chat: chat ? chat.getBoundingClientRect().width : 460,
  };
}

// Set both track widths at once, clamped so no column can be crushed below its
// minimum — including after the window itself has been made smaller than the
// widths that were saved.
function applyColWidths(projects, chat, opts) {
  const o = opts || {};
  const shell = shellEl();
  if (!shell) return;
  const cur = currentColWidths();
  const avail = cur.total - 2 * RZ_W;
  let p = Math.round(projects != null ? projects : cur.projects);
  p = Math.max(COL_MIN.projects, p);
  p = Math.min(p, Math.max(COL_MIN.projects, avail - COL_MIN.chat - COL_MIN.terminals));
  let c = Math.round(chat != null ? chat : cur.chat);
  c = Math.max(COL_MIN.chat, c);
  c = Math.min(c, Math.max(COL_MIN.chat, avail - p - COL_MIN.terminals));
  shell.style.setProperty("--col-projects", p + "px");
  shell.style.setProperty("--col-chat", c + "px");
  if (o.persist) { settings.layout = { projects: p, chat: c }; saveSettings(); }
  // Refitting the PTY is relatively expensive, so only do it when the drag ends.
  if (o.fit) { for (const rec of sessions.values()) fitTerminal(rec); }
}

// Drop back to the responsive defaults in style.css.
function resetColWidths() {
  const shell = shellEl();
  if (!shell) return;
  shell.style.removeProperty("--col-projects");
  shell.style.removeProperty("--col-chat");
  delete settings.layout;
  saveSettings();
  for (const rec of sessions.values()) fitTerminal(rec);
}

function initColumnResizers() {
  // Restore a saved layout (clamped to the current window).
  const L = settings.layout;
  if (L && L.projects && L.chat) applyColWidths(L.projects, L.chat, { fit: false });

  const bind = (handle, which) => {
    if (!handle) return;
    let startX = 0, startP = 0, startC = 0, dragging = false;
    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      if (which === "projects") applyColWidths(startP + dx, startC, {});
      else applyColWidths(startP, startC + dx, {});
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove("is-dragging");
      document.body.classList.remove("is-resizing");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const cur = currentColWidths();
      applyColWidths(cur.projects, cur.chat, { persist: true, fit: true });
    };
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const cur = currentColWidths();
      startX = e.clientX; startP = cur.projects; startC = cur.chat;
      dragging = true;
      handle.classList.add("is-dragging");
      document.body.classList.add("is-resizing");
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
    // Keyboard-resizable (the handle is a focusable role="separator").
    handle.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 32 : 8;
      let d = 0;
      if (e.key === "ArrowLeft") d = -step;
      else if (e.key === "ArrowRight") d = step;
      else return;
      e.preventDefault();
      const cur = currentColWidths();
      if (which === "projects") applyColWidths(cur.projects + d, cur.chat, { persist: true, fit: true });
      else applyColWidths(cur.projects, cur.chat + d, { persist: true, fit: true });
    });
    handle.addEventListener("dblclick", resetColWidths);
    handle.title = "Drag to resize · double-click to reset";
  };
  bind($("rz-projects"), "projects");
  bind($("rz-chat"), "chat");
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
  // Restore worktrees created in earlier sessions so they stay mergeable after a
  // reload (buildSystemPrompt surfaces them; list_worktrees enumerates them).
  await loadWorktrees();
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
  // Smooth auto-resize: the textarea grows with content up to a max height.
  const autoResizeInput = () => {
    el.chatInput.style.height = "auto";
    el.chatInput.style.height = Math.min(el.chatInput.scrollHeight, 160) + "px";
    // Keep the askChoice overlay above the now-taller composer.
    syncOverlayOffset();
  };
  el.chatInput.addEventListener("input", autoResizeInput);

  // Empty-state example prompts — clicking fills the composer and sends.
  if (el.chatEmpty) {
    el.chatEmpty.addEventListener("click", (e) => {
      const btn = e.target.closest && e.target.closest(".chat-empty-prompt");
      if (!btn) return;
      const prompt = btn.getAttribute("data-prompt");
      if (!prompt) return;
      el.chatInput.value = prompt;
      autoResizeInput();
      if (!running) el.chatForm.requestSubmit();
    });
  }

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

  // column resizers (restores any saved layout)
  initColumnResizers();

  // window resize → re-clamp a saved layout, then refit visible terminals
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (settings.layout && settings.layout.projects && settings.layout.chat) {
        // Re-clamp: the window may now be narrower than the saved widths.
        applyColWidths(settings.layout.projects, settings.layout.chat, { fit: false });
      }
      for (const rec of sessions.values()) fitTerminal(rec);
    }, 120);
  });

  // Wake the orchestrator when a delegated agent finishes its turn.
  startAutoFollow();

  // initial render
  renderProjects();
  renderChat();
  renderSessionInfo();
  ensureEmptyHint();
  renderTabs();

  // hide loading
  el.loading.classList.add("hidden");

  // Overlay offset tracking — AFTER the first render and after the loading veil
  // is gone, so the composer stack it measures is actually laid out. Measuring
  // during event binding read a session-info of height 0 and left the askChoice
  // picker overlapping the composer until the next resync.
  initOverlayOffset();
  requestAnimationFrame(syncOverlayOffset);

  // auto-detection at startup (non-blocking; cached 60s). If terminal is
  // denied, everything degrades to "ask" mode — no crash.
  detectTools(true).catch((e) => console.warn("detect", e));
}

init().catch((e) => {
  console.error(e);
  el.loading.textContent = "Failed to start: " + (e && e.message ? e.message : String(e));
});
