// 00-state.js — classic script (converted from an ES module; see REFACTOR_PLAN.md).
// Exports are registered on the shared window.termCoder namespace (TC).
(function () {
"use strict";
const TC = window.termCoder = window.termCoder || {};
// Term Coder — AI agent orchestrator with live terminal squares.
// Spawns OpenCode / Claude Code / Codex sub-agents via `chatoss launch` —
// ALWAYS asks the user first (spawn modal).
// Loaded by index.html as a classic <script src="js/00-state.js"> tag.

const STORE_KEY = "term-coder.state";
const SETTINGS_KEY = "term-coder.settings";
const WORKTREES_KEY = "term-coder.worktrees";
// Persisted terminal session list. On app close/reopen the live PTY processes
// are gone — this is what lets the Sessions column show the user what ran, what
// each agent was working on, what's finished, and the last output each one
// produced. Restored at load (loadPersistedSessions) as read-only "ended" cards
// alongside any live sessions created during the current run.
const SESSIONS_KEY = "term-coder.sessions";
// Fixed sub-agent reasoning-effort options used when a model does not enumerate
// its own thinkLevels (see effortOptionsForTarget in 08-settings.js).
const DETECT_TTL_MS = 60 * 1000;
// The app's own version, used by the Settings "Check for updates" flow.
// Keep in sync with the "version" field in app.json (the app cannot read its
// own manifest at runtime — the sandboxed frame has no fetchable origin).
const APP_VERSION = "1.28.1";
// CLIs that "chatoss launch" can start (from the ChatOSS Settings → Launch
// screen). This is the SINGLE source of truth for the chatoss-launch entries
// offered in the spawn-modal dropdown (buildCliOptions) and in the Settings
// "Default agent" picker. Keeping it here and deriving both UIs from it means
// the constant and the UI can never drift apart (D2).
//
// v1.28: chatoss launch is the ONLY launch path. The old "ollama launch <tool>"
// options and the direct-binary (raw:) options are gone — every sub-agent
// session starts through the `chatoss` command line wrapper, which wires the
// CLI's model provider at ChatOSS's local model server. The `tool` field is
// the argument chatoss launch takes (note: Claude Code's tool name is
// "claude-code", not "claude").
const CHATOSS_LAUNCH_TOOLS = [
  { id: "opencode", tool: "opencode", label: "chatoss launch opencode  (OpenCode)" },
  { id: "claude-code", tool: "claude-code", label: "chatoss launch claude-code  (Claude Code)" },
  { id: "codex", tool: "codex", label: "chatoss launch codex  (Codex)" },
];

// Resolved absolute path to the `chatoss` command (found at detect time). The
// sandboxed terminal runs a NON-login shell, so PATH is minimal and "chatoss"
// often isn't on it even though it works in the user's terminal.
let chatossPath = null;
const CHATOSS_GUESSES = ["/usr/local/bin/chatoss", "/opt/homebrew/bin/chatoss", "/usr/bin/chatoss", "/bin/chatoss", "/snap/bin/chatoss"];

// ── Underlying coding-CLI binaries (claude / codex / opencode) ──
// `chatoss launch <tool>` drives these real CLIs (Claude Code / Codex /
// OpenCode), pointing their model provider at ChatOSS's local model server.
// They are NOT launched directly anymore — the paths are resolved at detect
// time purely so the Settings "Detected tools" list can show what's installed.
// Stays null when the binary isn't installed.
let claudePath = null;
let codexPath = null;
let opencodePath = null;
// Well-known locations to fall back to when `which` fails under the minimal
// sandbox PATH (same rationale as CHATOSS_GUESSES).
const CLAUDE_GUESSES = ["/usr/local/bin/claude", "/opt/homebrew/bin/claude", "/usr/bin/claude", "/bin/claude"];
const CODEX_GUESSES = ["/usr/local/bin/codex", "/opt/homebrew/bin/codex", "/usr/bin/codex", "/bin/codex"];
const OPENCODE_GUESSES = ["/usr/local/bin/opencode", "/opt/homebrew/bin/opencode", "/usr/bin/opencode", "/bin/opencode"];

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
  termView: "squares", // "squares" | "columns" | "rows" — layout of the sessions panel
  convShown: {},       // project id -> how many conversations are visible (pagination)
  projectOpen: {},     // project id -> bool. Several project bodies can be open at
                       // once (parallel agents): the ACTIVE project's body shows
                       // unless the user explicitly collapsed it (false); a
                       // non-active project shows only when explicitly opened
                       // (true). Persisted, so open projects survive a restart.
  currentBranch: null, // active project's current git branch (last known), refreshed on demand
};
let settings = {
  cliDefault: "ask",       // 'ask' | 'opencode' | 'claude-code' | 'codex' — which
                           // agent `chatoss launch` starts. Legacy values
                           // ('claude', 'raw:*', ollama models) are normalized at
                           // load (normalizeCliDefault in 08-settings.js).
  modelDefault: "ask",     // 'ask' | <model id> (legacy field, kept for shape)
  cwdDefault: "",
  // Wake the orchestrator automatically when a delegated agent finishes its turn
  // or exits. Coding CLIs are REPLs that never exit, so without this the
  // orchestrator has nothing to react to and the user has to prod it by hand
  // after every subtask.
  autoFollow: true,
  detected: { chatoss: false, codex: false, claude: false, opencode: false, denied: false },
  editorWidth: 380,          // code editor column width (px) when open
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
  // Per-TARGET effort levels for sub-agent sessions: { [modelId]: "low" | "medium" | "high" | … }.
  // Empty/absent = model default. Applies in every selection mode (manual picks
  // included): whatever model launches carries its saved effort. Codex agent
  // sessions get the real --config model_reasoning_effort flag; other agents
  // get a guidance line appended to the task brief (see spawnChosen).
  subAgentEffort: {},
};
// The scopedData keys that back each model-selection field (top-level keys).
const MS_KEYS = ["modelSelectionMode", "alwaysModel", "complexityModelLow", "complexityModelMedium", "complexityModelHigh", "subAgentEffort"];

// Fixed option list for sub-agent effort selects when a model does not enumerate
// its own thinkLevels. Codex agent sessions have a real
// --config model_reasoning_effort flag that accepts these exact values.
const SUBAGENT_EFFORT_OPTIONS_BASE = [
  { value: "", label: "Model default" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

// Values that are safe to pass directly to Codex's --config model_reasoning_effort
// flag. Anything outside this set falls back to a guidance line in the prompt.
const CODEX_EFFORT_FLAG_VALUES = new Set(["low", "medium", "high"]);

// Generic effort levels shown when a model/target does not enumerate its own
// thinkLevels in listModels(). The user explicitly asked for more than
// low/medium/high — most reasoning models support at least a "max" level, and
// an "extra-high" slot covers the gap between high and max.
const GENERIC_EFFORT_LEVELS = ["low", "medium", "high", "extra-high", "max"];

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

// ---------- Token estimator ----------
// Context-window fallbacks keyed by model id, used when listModels() doesn't
// report a contextLength. Matched by substring (case-insensitive) so a family
// of model ids (e.g. "claude-3-5-sonnet", "claude-opus-4") all resolve.
const CONTEXT_WINDOW_MAP = [
  { match: /claude|anthropic/i, tokens: 200000 },
  { match: /gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-4-32k|o1|o3|o4|chatgpt/i, tokens: 128000 },
  { match: /gpt-3\.5/i, tokens: 16385 },
  { match: /gemini/i, tokens: 1000000 },
  { match: /deepseek/i, tokens: 128000 },
  { match: /llama3|llama-3/i, tokens: 128000 },
  { match: /qwen/i, tokens: 128000 },
  { match: /mistral/i, tokens: 128000 },
  { match: /codex/i, tokens: 128000 },
  { match: /grok/i, tokens: 128000 },
];
const DEFAULT_CONTEXT_WINDOW = 128000;
// Static fallback for the system prompt before the first turn has built one.
// buildSystemPrompt() caches its real output into _lastSystemPrompt each turn.
const SYSTEM_PROMPT_FALLBACK = "You are Term Coder, an autonomous software-building orchestrator.";
let _lastSystemPrompt = "";
let _lastBreakdown = null;
let _lastMax = 0;

// Auto-detection cache (refreshed every ~60s).
//   chatossPath: resolved absolute path to the `chatoss` command — REQUIRED:
//   every sub-agent launches through `chatoss launch <tool>`, and that command
//   only exists after the user clicks "Install chatoss command" in ChatOSS
//   Settings → Launch. When it is missing, spawn shows the install guidance.
//   claudePath / codexPath / opencodePath: the underlying CLI binaries
//   (informational only — they are never launched directly). The sandboxed
//   terminal runs a non-login shell with a minimal PATH, so absolute paths let
//   the Settings "Detected tools" list show real installs.
let detection = { codex: false, claude: false, chatoss: false, opencode: false, models: [], scannedAt: 0, denied: false, chatossPath: null, claudePath: null, codexPath: null, opencodePath: null };

// Sessions registry: sessionId -> { id, cmd, args, cwd, label, active, exitCode?, squareEl, mountEl, dispose?, expanded }
const sessions = new Map();

// Persisted (now-ended) sessions: sessionId -> snapshot record. These are
// terminals whose underlying PTY has died (process exit OR app close/reopen),
// shown as read-only "session ended — output preserved" cards so the user can
// still see what happened. They are NOT live and cannot be reattached to. A
// live session from THIS run (sessions Map) is also persisted to scopedData as
// a snapshot, so on the next reopen it reappears here as a dead card.
//
// Snapshot record shape (also what is written to SESSIONS_KEY):
//   { id, label, cwd, agent (cli label), worktreeBranch?, status, exitCode?,
//     createdAt, endedAt?, output (clean text tail), merged? }
const deadSessions = new Map();

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

// ---------- Session health check (stall detection + nudge) ----------
// Agents sometimes go quiet mid-task and never resume on their own (the user
// has had to type "are you working?" into the terminal by hand). A periodic
// check detects a session that has produced no output for STALL_QUIET_MS while
// still classified WORKING/STARTING, nudges it with a "are you still working?
// continue" prompt, and notifies the user. Nudges are rate-limited so a
// genuinely stuck agent isn't spammed.
const HEALTH_CHECK_MS = 5 * 60 * 1000;      // run the check every 5 minutes
const STALL_QUIET_MS = 10 * 60 * 1000;      // no output for 10 min = stalled
const NUDGE_COOLDOWN_MS = 10 * 60 * 1000;   // at most one nudge per 10 min per session
const NUDGE_TEXT = "are you still working? continue";

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

// ---------- Mutators for exported mutable bindings ----------
// ES module imports are READ-ONLY bindings — `import { state } ...; state = x;`
// throws a TypeError ("Attempted to assign to readonly property"). A module
// that needs to CHANGE one of these values must call the setter here, in the
// declaring module where the binding is actually mutable. Object bindings
// (state, settings, detection, models, sessions, deadSessions) are instead
// mutated IN PLACE at the call sites (Object.assign / splice), which is legal
// for importers and keeps every module's view of them live.
function setChatossPath(v) { chatossPath = v; }
function setClaudePath(v) { claudePath = v; }
function setCodexPath(v) { codexPath = v; }
function setOpencodePath(v) { opencodePath = v; }
function setTrustMode(v) { trustMode = v; }
function setDefaultModelId(v) { defaultModelId = v; }
function setAbortController(v) { abortController = v; }
function updateRunning(v) { running = v; }
function setLastSystemPrompt(v) { _lastSystemPrompt = v; }
function setLastBreakdown(b) { _lastBreakdown = b; _lastMax = b ? b.max : 0; }
// --- exports ---
Object.defineProperty(TC, "STORE_KEY", { get: () => STORE_KEY, configurable: true });
Object.defineProperty(TC, "SETTINGS_KEY", { get: () => SETTINGS_KEY, configurable: true });
Object.defineProperty(TC, "WORKTREES_KEY", { get: () => WORKTREES_KEY, configurable: true });
Object.defineProperty(TC, "SESSIONS_KEY", { get: () => SESSIONS_KEY, configurable: true });
Object.defineProperty(TC, "DETECT_TTL_MS", { get: () => DETECT_TTL_MS, configurable: true });
Object.defineProperty(TC, "APP_VERSION", { get: () => APP_VERSION, configurable: true });
Object.defineProperty(TC, "CHATOSS_LAUNCH_TOOLS", { get: () => CHATOSS_LAUNCH_TOOLS, configurable: true });
Object.defineProperty(TC, "CHATOSS_GUESSES", { get: () => CHATOSS_GUESSES, configurable: true });
Object.defineProperty(TC, "CLAUDE_GUESSES", { get: () => CLAUDE_GUESSES, configurable: true });
Object.defineProperty(TC, "CODEX_GUESSES", { get: () => CODEX_GUESSES, configurable: true });
Object.defineProperty(TC, "OPENCODE_GUESSES", { get: () => OPENCODE_GUESSES, configurable: true });
Object.defineProperty(TC, "MS_KEYS", { get: () => MS_KEYS, configurable: true });
Object.defineProperty(TC, "SUBAGENT_EFFORT_OPTIONS_BASE", { get: () => SUBAGENT_EFFORT_OPTIONS_BASE, configurable: true });
Object.defineProperty(TC, "CODEX_EFFORT_FLAG_VALUES", { get: () => CODEX_EFFORT_FLAG_VALUES, configurable: true });
Object.defineProperty(TC, "GENERIC_EFFORT_LEVELS", { get: () => GENERIC_EFFORT_LEVELS, configurable: true });
Object.defineProperty(TC, "CONTEXT_WINDOW_MAP", { get: () => CONTEXT_WINDOW_MAP, configurable: true });
Object.defineProperty(TC, "DEFAULT_CONTEXT_WINDOW", { get: () => DEFAULT_CONTEXT_WINDOW, configurable: true });
Object.defineProperty(TC, "SYSTEM_PROMPT_FALLBACK", { get: () => SYSTEM_PROMPT_FALLBACK, configurable: true });
Object.defineProperty(TC, "sessions", { get: () => sessions, configurable: true });
Object.defineProperty(TC, "deadSessions", { get: () => deadSessions, configurable: true });
Object.defineProperty(TC, "ORCH_SENTINEL_RE", { get: () => ORCH_SENTINEL_RE, configurable: true });
Object.defineProperty(TC, "APPROVE_BUSY_TIMEOUT_MS", { get: () => APPROVE_BUSY_TIMEOUT_MS, configurable: true });
Object.defineProperty(TC, "APPROVE_COOLDOWN_MS", { get: () => APPROVE_COOLDOWN_MS, configurable: true });
Object.defineProperty(TC, "TURN_IDLE_MS", { get: () => TURN_IDLE_MS, configurable: true });
Object.defineProperty(TC, "MIN_WORK_BYTES", { get: () => MIN_WORK_BYTES, configurable: true });
Object.defineProperty(TC, "HEALTH_CHECK_MS", { get: () => HEALTH_CHECK_MS, configurable: true });
Object.defineProperty(TC, "STALL_QUIET_MS", { get: () => STALL_QUIET_MS, configurable: true });
Object.defineProperty(TC, "NUDGE_COOLDOWN_MS", { get: () => NUDGE_COOLDOWN_MS, configurable: true });
Object.defineProperty(TC, "NUDGE_TEXT", { get: () => NUDGE_TEXT, configurable: true });
Object.defineProperty(TC, "AGENT_ERROR_PATTERNS", { get: () => AGENT_ERROR_PATTERNS, configurable: true });
Object.defineProperty(TC, "ERROR_LOOP_THRESHOLD", { get: () => ERROR_LOOP_THRESHOLD, configurable: true });
Object.defineProperty(TC, "chatossPath", { get: () => chatossPath, set: (v) => { chatossPath = v; }, configurable: true });
Object.defineProperty(TC, "claudePath", { get: () => claudePath, set: (v) => { claudePath = v; }, configurable: true });
Object.defineProperty(TC, "codexPath", { get: () => codexPath, set: (v) => { codexPath = v; }, configurable: true });
Object.defineProperty(TC, "opencodePath", { get: () => opencodePath, set: (v) => { opencodePath = v; }, configurable: true });
Object.defineProperty(TC, "state", { get: () => state, set: (v) => { state = v; }, configurable: true });
Object.defineProperty(TC, "settings", { get: () => settings, set: (v) => { settings = v; }, configurable: true });
Object.defineProperty(TC, "modelSelection", { get: () => modelSelection, set: (v) => { modelSelection = v; }, configurable: true });
Object.defineProperty(TC, "trustMode", { get: () => trustMode, set: (v) => { trustMode = v; }, configurable: true });
Object.defineProperty(TC, "models", { get: () => models, set: (v) => { models = v; }, configurable: true });
Object.defineProperty(TC, "defaultModelId", { get: () => defaultModelId, set: (v) => { defaultModelId = v; }, configurable: true });
Object.defineProperty(TC, "running", { get: () => running, set: (v) => { running = v; }, configurable: true });
Object.defineProperty(TC, "abortController", { get: () => abortController, set: (v) => { abortController = v; }, configurable: true });
Object.defineProperty(TC, "_lastSystemPrompt", { get: () => _lastSystemPrompt, set: (v) => { _lastSystemPrompt = v; }, configurable: true });
Object.defineProperty(TC, "_lastBreakdown", { get: () => _lastBreakdown, set: (v) => { _lastBreakdown = v; }, configurable: true });
Object.defineProperty(TC, "_lastMax", { get: () => _lastMax, set: (v) => { _lastMax = v; }, configurable: true });
Object.defineProperty(TC, "detection", { get: () => detection, set: (v) => { detection = v; }, configurable: true });
TC.loginShell = loginShell;
TC.setChatossPath = setChatossPath;
TC.setClaudePath = setClaudePath;
TC.setCodexPath = setCodexPath;
TC.setOpencodePath = setOpencodePath;
TC.setTrustMode = setTrustMode;
TC.setDefaultModelId = setDefaultModelId;
TC.setAbortController = setAbortController;
TC.updateRunning = updateRunning;
TC.setLastSystemPrompt = setLastSystemPrompt;
TC.setLastBreakdown = setLastBreakdown;
})();
