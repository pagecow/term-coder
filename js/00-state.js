import { $ } from "./04-dom.js";
// Term Coder — AI agent orchestrator with live terminal squares.
// Spawns ollama/codex/claude sub-agents — ALWAYS asks the user first (spawn modal).
// Loaded by index.html as <script type="module" src="app.js"></script>.

export const STORE_KEY = "term-coder.state";
export const SETTINGS_KEY = "term-coder.settings";
export const WORKTREES_KEY = "term-coder.worktrees";
// Persisted terminal session list. On app close/reopen the live PTY processes
// are gone — this is what lets the Sessions column show the user what ran, what
// each agent was working on, what's finished, and the last output each one
// produced. Restored at load (loadPersistedSessions) as read-only "ended" cards
// alongside any live sessions created during the current run.
export const SESSIONS_KEY = "term-coder.sessions";
export const FALLBACK_MODELS = ["qwen3:30b", "qwen3:14b", "llama3.2:latest", "mistral:latest"];
export const DETECT_TTL_MS = 60 * 1000;
// The app's own version, used by the Settings "Check for updates" flow.
// Keep in sync with the "version" field in app.json (the app cannot read its
// own manifest at runtime — the sandboxed frame has no fetchable origin).
export const APP_VERSION = "1.22.0";
// CLIs that "ollama launch" can start (from the Ollama desktop Launch screen).
// This is the SINGLE source of truth for the ollama-launch entries offered in
// the spawn-modal dropdown (buildCliOptions). Keeping it here and deriving the
// dropdown from it means the constant and the UI can never drift apart (D2).
// Only the tools below are offered; "openclaw"/"droid" were previously listed
// but never actually wired into the dropdown, so they were removed.
export const OLLAMA_LAUNCH_TOOLS = [
  { id: "opencode", label: "ollama launch opencode  (OpenCode)" },
  { id: "claude", label: "ollama launch claude  (Claude Code)" },
  { id: "codex", label: "ollama launch codex  (Codex)" },
];

// Resolved absolute path to the ollama binary (found at detect time). The
// sandboxed terminal runs a NON-login shell, so PATH is minimal and "ollama"
// often isn't on it even though it works in the user's terminal.
export let ollamaPath = null;
export const OLLAMA_GUESSES = ["/usr/local/bin/ollama", "/opt/homebrew/bin/ollama", "/usr/bin/ollama", "/bin/ollama", "/snap/bin/ollama"];

// ── Direct-CLI launch targets (claude / codex / opencode) ──
// Resolved absolute paths to the real coding-CLI binaries, found at detect
// time. When the user picks "claude", "codex", or "opencode" as a launch
// target we spawn THESE directly via the terminal capability — NOT through
// `ollama launch`. This is for users who have a direct account and don't want
// to go through ollama. Like ollamaPath, the absolute path survives the
// sandbox's minimal PATH. Stays null when the binary isn't installed.
export let claudePath = null;
export let codexPath = null;
export let opencodePath = null;
// Well-known locations to fall back to when `which` fails under the minimal
// sandbox PATH (same rationale as OLLAMA_GUESSES).
export const CLAUDE_GUESSES = ["/usr/local/bin/claude", "/opt/homebrew/bin/claude", "/usr/bin/claude", "/bin/claude"];
export const CODEX_GUESSES = ["/usr/local/bin/codex", "/opt/homebrew/bin/codex", "/usr/bin/codex", "/bin/codex"];
export const OPENCODE_GUESSES = ["/usr/local/bin/opencode", "/opt/homebrew/bin/opencode", "/usr/bin/opencode", "/bin/opencode"];

// Wrap a command so it runs in a login shell (full user PATH) when possible.
// Falls back to the bare command if we can't build a wrapper.
export function loginShell(command) {
  return "zsh -lic " + JSON.stringify(command);
}

// ---------- State ----------
export let state = {
  projects: [],
  activeProjectId: null,
  activeConversationId: null,
  activeSessionId: null,
  termView: "squares", // "squares" | "columns" | "rows" — layout of the sessions panel
  convShown: {},       // project id -> how many conversations are visible (pagination)
  currentBranch: null, // active project's current git branch (last known), refreshed on demand
};
export let settings = {
  cliDefault: "ask",       // 'ask' | 'ollama' | 'codex' | 'claude' | 'raw:claude' | 'raw:codex' | 'raw:opencode' | ...
  modelDefault: "ask",     // 'ask' | <ollama model name>
  cwdDefault: "",
  // Wake the orchestrator automatically when a delegated agent finishes its turn
  // or exits. Coding CLIs are REPLs that never exit, so without this the
  // orchestrator has nothing to react to and the user has to prod it by hand
  // after every subtask.
  autoFollow: true,
  detected: { codex: false, claude: false, ollama: false, models: [], denied: false },
  editorWidth: 380,          // code editor column width (px) when open
};
// Model Selection Mode — single source of truth for how sub-agent sessions
// choose a model. Persisted as individual scopedData keys (one per field, see
// MS_KEYS) and restored on load (loadModelSelection). Kept SEPARATE from the
// bundled `settings` blob so the session-startup integration can read it in
// isolation via window.termCoder.getModelSelectionConfig().
export let modelSelection = {
  modelSelectionMode: "manual", // "manual" | "always" | "complexity"
  alwaysModel: "",
  complexityModelLow: "",
  complexityModelMedium: "",
  complexityModelHigh: "",
  // Per-TARGET effort levels for sub-agent sessions: { [launchTargetId]: "low" | "medium" | "high" }.
  // Empty/absent = model default. Applies in every selection mode (manual picks
  // included): whatever target launches carries its saved effort. Codex targets
  // get the real --config model_reasoning_effort flag; agents without an effort
  // flag get a guidance line appended to the task brief (see spawnChosen).
  subAgentEffort: {},
};
// The scopedData keys that back each model-selection field (top-level keys).
export const MS_KEYS = ["modelSelectionMode", "alwaysModel", "complexityModelLow", "complexityModelMedium", "complexityModelHigh", "subAgentEffort"];

// Fixed option list for direct CLI targets (claude/codex/opencode) and for
// ollama models whose model list entry hasn't arrived yet. Direct Codex has a
// real --config model_reasoning_effort flag that accepts these exact values.
export const SUBAGENT_EFFORT_OPTIONS_BASE = [
  { value: "", label: "Model default" },
  { value: "low", label: "Low — fast & pragmatic" },
  { value: "medium", label: "Medium — balanced" },
  { value: "high", label: "High — deep reasoning" },
];

// Values that are safe to pass directly to Codex's --config model_reasoning_effort
// flag. Anything outside this set falls back to a guidance line in the prompt.
export const CODEX_EFFORT_FLAG_VALUES = new Set(["low", "medium", "high"]);

// Generic effort levels shown when a model/target does not enumerate its own
// thinkLevels in listModels(). The user explicitly asked for more than
// low/medium/high — most reasoning models support at least a "max" level, and
// an "extra-high" slot covers the gap between high and max.
export const GENERIC_EFFORT_LEVELS = ["low", "medium", "high", "extra-high", "max"];

// Trust-folder policy for spawned CLI agents (claude/codex/etc.):
//   "ask"    -> when a "trust this folder?" dialog appears, ask the user IN CHAT
//               via the askChoice pill picker before pressing Enter to confirm.
//   "always" -> automatically confirm the trust dialog without asking.
// Persisted as its own scopedData key ("trustMode"), separate from the bundled
// settings blob so autoDriveStartup can read it in isolation.
export let trustMode = "ask"; // "ask" | "always"
export let models = [];
export let defaultModelId = null;
export let running = false;
export let abortController = null;

// ---------- Token estimator ----------
// Context-window fallbacks keyed by model id, used when listModels() doesn't
// report a contextLength. Matched by substring (case-insensitive) so a family
// of model ids (e.g. "claude-3-5-sonnet", "claude-opus-4") all resolve.
export const CONTEXT_WINDOW_MAP = [
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
export const DEFAULT_CONTEXT_WINDOW = 128000;
// Static fallback for the system prompt before the first turn has built one.
// buildSystemPrompt() caches its real output into _lastSystemPrompt each turn.
export const SYSTEM_PROMPT_FALLBACK = "You are Term Coder, an autonomous software-building orchestrator.";
export let _lastSystemPrompt = "";
export let _lastBreakdown = null;
export let _lastMax = 0;

// Auto-detection cache (refreshed every ~60s).
//   claudePath / codexPath: resolved absolute path to the direct CLI binary
//   (mirrors ollamaPath). The sandboxed terminal runs a non-login shell with a
//   minimal PATH, so storing the absolute path lets us launch the real CLI
//   directly even when bare "claude"/"codex" wouldn't resolve.
export let detection = { codex: false, claude: false, ollama: false, opencode: false, models: [], scannedAt: 0, denied: false, claudePath: null, codexPath: null, opencodePath: null };

// Sessions registry: sessionId -> { id, cmd, args, cwd, label, active, exitCode?, squareEl, mountEl, dispose?, expanded }
export const sessions = new Map();

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
export const deadSessions = new Map();

// The marker a coding agent prints when it needs a decision from the
// orchestrator (see ORCH_PROTOCOL in autoDriveStartup). Anchored to the start of
// a line — tolerating a TUI gutter glyph or indentation — so an agent merely
// MENTIONING the marker mid-sentence doesn't trip it.
//
// CRITICAL: this assembled literal must NEVER appear in any string we write into
// a PTY. Agent TUIs echo the submitted prompt back through onData, so a marker
// quoted in the task prompt would match our own instructions on every spawn.
export const ORCH_SENTINEL_RE = /^[\s>│┃▌▎|*•-]*\[ORCHESTRATOR_INPUT_NEEDED\]\s*(.*)$/im;

// How long a session may sit with autoApproveBusy set before we force-clear it.
// autoApproveBusy gates the whole universal monitor, so a path that sets it and
// never clears it (e.g. an approval picker the user never answers) would leave
// the session permanently unwatched. This watchdog guarantees recovery.
export const APPROVE_BUSY_TIMEOUT_MS = 45000;
// After auto-answering an approval prompt, ignore further approval matches for
// this long. TUIs redraw their scrollback constantly, so the same prompt text
// reappears in the output stream and would otherwise be "approved" again and
// again, spraying stray Enter keystrokes into a working agent.
export const APPROVE_COOLDOWN_MS = 1800;

// How long a terminal must be silent, while sitting at an input prompt, before
// we call the agent's turn finished. Coding CLIs stream output continuously while
// they work (spinner frames, tool output), so silence at a prompt is a reliable
// "done for now" signal — and unlike process exit, it actually happens.
export const TURN_IDLE_MS = 4000;
// Bytes of output the agent must have produced since we submitted the task
// before idleness can mean "finished". Without this, the quiet prompt that
// exists BEFORE the task is submitted would read as an instantly-completed turn.
export const MIN_WORK_BYTES = 200;

// ---------- Session health check (stall detection + nudge) ----------
// Agents sometimes go quiet mid-task and never resume on their own (the user
// has had to type "are you working?" into the terminal by hand). A periodic
// check detects a session that has produced no output for STALL_QUIET_MS while
// still classified WORKING/STARTING, nudges it with a "are you still working?
// continue" prompt, and notifies the user. Nudges are rate-limited so a
// genuinely stuck agent isn't spammed.
export const HEALTH_CHECK_MS = 5 * 60 * 1000;      // run the check every 5 minutes
export const STALL_QUIET_MS = 10 * 60 * 1000;      // no output for 10 min = stalled
export const NUDGE_COOLDOWN_MS = 10 * 60 * 1000;   // at most one nudge per 10 min per session
export const NUDGE_TEXT = "are you still working? continue";

// Recognisable failure text from a coding agent's provider or the CLI itself.
// An agent hitting one of these is NOT going to finish on its own, and an agent
// RETRYING one is the worst case: it keeps emitting output, so it looks busy
// forever and every "wait for it to finish" call runs to its full timeout.
export const AGENT_ERROR_PATTERNS = [
  /api error:?\s*\d{3}/i,
  /does not support image input/i,
  /rate limit|429 |too many requests/i,
  /context (?:length|window) exceeded|too many tokens|prompt is too long/i,
  /401 |unauthorized|authentication (?:failed|error)|invalid api key/i,
  /5\d\d (?:error|internal)|overloaded|service unavailable/i,
  /econnreset|etimedout|fetch failed|network error/i,
];
// How many times the same error must recur before we call it a loop.
export const ERROR_LOOP_THRESHOLD = 3;

