// Term Coder — AI agent orchestrator with live terminal squares.
// Spawns ollama/codex/claude sub-agents — ALWAYS asks the user first (spawn modal).
// Loaded by index.html as <script type="module" src="app.js"></script>.

const STORE_KEY = "term-coder.state";
const SETTINGS_KEY = "term-coder.settings";
const WORKTREES_KEY = "term-coder.worktrees";
// Persisted terminal session list. On app close/reopen the live PTY processes
// are gone — this is what lets the Sessions column show the user what ran, what
// each agent was working on, what's finished, and the last output each one
// produced. Restored at load (loadPersistedSessions) as read-only "ended" cards
// alongside any live sessions created during the current run.
const SESSIONS_KEY = "term-coder.sessions";
const FALLBACK_MODELS = ["qwen3:30b", "qwen3:14b", "llama3.2:latest", "mistral:latest"];
const DETECT_TTL_MS = 60 * 1000;
// The app's own version, used by the Settings "Check for updates" flow.
// Keep in sync with the "version" field in app.json (the app cannot read its
// own manifest at runtime — the sandboxed frame has no fetchable origin).
const APP_VERSION = "1.22.0";
// CLIs that "ollama launch" can start (from the Ollama desktop Launch screen).
// This is the SINGLE source of truth for the ollama-launch entries offered in
// the spawn-modal dropdown (buildCliOptions). Keeping it here and deriving the
// dropdown from it means the constant and the UI can never drift apart (D2).
// Only the tools below are offered; "openclaw"/"droid" were previously listed
// but never actually wired into the dropdown, so they were removed.
const OLLAMA_LAUNCH_TOOLS = [
  { id: "opencode", label: "ollama launch opencode  (OpenCode)" },
  { id: "claude", label: "ollama launch claude  (Claude Code)" },
  { id: "codex", label: "ollama launch codex  (Codex)" },
];

// Resolved absolute path to the ollama binary (found at detect time). The
// sandboxed terminal runs a NON-login shell, so PATH is minimal and "ollama"
// often isn't on it even though it works in the user's terminal.
let ollamaPath = null;
const OLLAMA_GUESSES = ["/usr/local/bin/ollama", "/opt/homebrew/bin/ollama", "/usr/bin/ollama", "/bin/ollama", "/snap/bin/ollama"];

// ── Direct-CLI launch targets (claude / codex / opencode) ──
// Resolved absolute paths to the real coding-CLI binaries, found at detect
// time. When the user picks "claude", "codex", or "opencode" as a launch
// target we spawn THESE directly via the terminal capability — NOT through
// `ollama launch`. This is for users who have a direct account and don't want
// to go through ollama. Like ollamaPath, the absolute path survives the
// sandbox's minimal PATH. Stays null when the binary isn't installed.
let claudePath = null;
let codexPath = null;
let opencodePath = null;
// Well-known locations to fall back to when `which` fails under the minimal
// sandbox PATH (same rationale as OLLAMA_GUESSES).
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
};
let settings = {
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
let modelSelection = {
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
const MS_KEYS = ["modelSelectionMode", "alwaysModel", "complexityModelLow", "complexityModelMedium", "complexityModelHigh", "subAgentEffort"];

// Fixed option list for direct CLI targets (claude/codex/opencode) and for
// ollama models whose model list entry hasn't arrived yet. Direct Codex has a
// real --config model_reasoning_effort flag that accepts these exact values.
const SUBAGENT_EFFORT_OPTIONS_BASE = [
  { value: "", label: "Model default" },
  { value: "low", label: "Low — fast & pragmatic" },
  { value: "medium", label: "Medium — balanced" },
  { value: "high", label: "High — deep reasoning" },
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
//   claudePath / codexPath: resolved absolute path to the direct CLI binary
//   (mirrors ollamaPath). The sandboxed terminal runs a non-login shell with a
//   minimal PATH, so storing the absolute path lets us launch the real CLI
//   directly even when bare "claude"/"codex" wouldn't resolve.
let detection = { codex: false, claude: false, ollama: false, opencode: false, models: [], scannedAt: 0, denied: false, claudePath: null, codexPath: null, opencodePath: null };

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
  // IDLE = quiet at a prompt. Two independent signals, either one suffices:
  //   1. tailAtPrompt — the text heuristic (prompt glyph / idle chrome in the
  //      output tail). This is what opencode/codex sessions kept failing: their
  //      prompt chrome never matched the glyph patterns, so IDLE was unreachable
  //      and the status stayed WORKING forever.
  //   2. ptyIdle — the PLATFORM's own PTY state (session.isWaitingForInput() /
  //      onStateChange, tcgetpgrp-based on macOS): the foreground process is the
  //      shell/CLI blocked on a tty read, i.e. sitting at its input prompt. This
  //      is authoritative and CLI-agnostic — it does not depend on matching any
  //      TUI's prompt glyphs. 'unsupported' (Windows) leaves ptyIdle false and
  //      the text heuristic carries the load.
  // While the folder-trust dialog is up the CLI is also blocked on input, so
  // ptyIdle alone must not read as "turn complete" — the trust flow owns the
  // keyboard until the user answers.
  const trustBlocked = s.trustState === "pending" || s.trustState === "asking";
  return (s.tailAtPrompt || (s.ptyIdle && !trustBlocked)) ? "IDLE" : "WORKING";
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
      if (s.degenerate) {
        const di = s.degenerateInfo || {};
        statusLine += "\n[DEGENERATE OUTPUT: the terminal collapsed into a repeated-token/gibberish loop (" +
          (di.pattern || "unknown pattern") + ", " + (di.count || "?") + "x). The app interrupted it with ctrl+c. " +
          "It is NOT making progress — close_session and respawn a fresh agent in the same worktree (its uncommitted work is auto-committed on close).]";
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
    // Mirror into SQLite so worktrees survive even if scopedData is lost.
    sqliteSyncWorktrees(arr);
  } catch (e) { console.warn("saveWorktrees", e); }
}
async function loadWorktrees() {
  try {
    const arr = await window.chatoss.scopedData.get(WORKTREES_KEY);
    if (Array.isArray(arr)) {
      for (const m of arr) {
        if (m && m.branch) {
          worktreeMeta.set(m.branch, { wtPath: m.wtPath, parentBranch: m.parentBranch, projectPath: m.projectPath });
        }
      }
    }
  } catch (e) { console.warn("loadWorktrees", e); }
  // Merge in any worktrees recorded in SQLite but missing from scopedData.
  await sqliteHydrateWorktrees();
}

// Derive the worktree branch a session's cwd belongs to. Worktrees created by
// create_worktree live at "<project>/.chatoss/worktrees/<branch>", so the last
// path segment is the branch. We also cross-check against worktreeMeta (which
// records the wtPath per branch) so a branch recorded at creation wins over a
// guess. Returns null for a cwd that isn't one of our worktrees.
function worktreeBranchForCwd(cwd) {
  const c = String(cwd || "").replace(/\/+$/, "");
  if (!c) return null;
  // Exact match against a known worktree path — authoritative.
  for (const [branch, m] of worktreeMeta.entries()) {
    if (m.wtPath && m.wtPath.replace(/\/+$/, "") === c) return branch;
  }
  // Fall back to the path-shape heuristic: <base>/.chatoss/worktrees/<branch>.
  const idx = c.indexOf("/.chatoss/worktrees/");
  if (idx >= 0) {
    const seg = c.slice(idx + "/.chatoss/worktrees/".length);
    if (seg && !seg.includes("/")) return seg;
  }
  return null;
}

// ---------- Persisted terminal sessions ----------
// A "snapshot" is the minimal per-session record we persist to scopedData so the
// Sessions column can show prior terminals (their state + last output) after the
// app is closed and reopened, even though the live PTY is gone. These are read-
// only; we never pretend to reattach to a dead process.
//
// The persisted array is the union of:
//   • live sessions (sessions Map) — written as snapshots so they survive a reopen
//   • dead sessions (deadSessions Map) — already-ended ones carried over
// This way closing/reopening never loses a session, and deleting one (closeSession
// or the merged-worktree cleanup) removes it from BOTH the in-memory maps and the
// persisted array via persistSessions().

// Build a plain snapshot of one live session record for persistence. Captures the
// clean tail of its current output so reopening shows what happened.
async function snapshotLiveSession(rec) {
  let output = "";
  try {
    if (rec.session && typeof rec.session.getOutput === "function") {
      const raw = await rec.session.getOutput();
      output = raw ? stripAnsi(raw) : "";
    }
  } catch (e) { /* a dead session just gets no output */ }
  // Keep the tail manageable — a full ~64KB scrollback per session would bloat
  // the persisted blob fast. The last ~6000 chars is plenty to recall what happened.
  if (output.length > 6000) output = "…(earlier output trimmed)…\n" + output.slice(-6000);
  const act = sessionActivity(rec);
  let status;
  if (rec.active === false) status = "exited";
  else if (act === "ERROR LOOP") status = "error";
  else if (act === "NEEDS INPUT") status = "needs-input";
  else if (act === "IDLE") status = "idle";
  else if (act === "WORKING") status = "working";
  else status = "starting";
  return {
    id: rec.id,
    label: rec.label || rec.id,
    cwd: rec.cwd || "",
    agent: rec.agent || rec.label || rec.id,
    conversationId: rec.conversationId || null,
    worktreeBranch: rec.worktreeBranch || null,
    status,
    exitCode: (rec.active === false) ? rec.exitCode : null,
    createdAt: rec.createdAt || Date.now(),
    endedAt: rec.endedAt || null,
    output,
    merged: !!rec.merged,
  };
}

// Persist the union of live + dead sessions to scopedData. Fire-and-forget but
// never leaves an unhandled rejection. Called debounced during a live run and
// eagerly on exit/close/delete.
let _persistSessionsTimer = null;
function schedulePersistSessions() {
  if (_persistSessionsTimer) return;
  _persistSessionsTimer = setTimeout(() => {
    _persistSessionsTimer = null;
    persistSessions().catch((e) => console.warn("schedulePersistSessions", e));
  }, 1500);
}
async function persistSessions() {
  try {
    // Live sessions need an async output read; dead sessions are already plain.
    const liveSnaps = [];
    for (const rec of sessions.values()) {
      try { liveSnaps.push(await snapshotLiveSession(rec)); } catch (e) { /* skip */ }
    }
    const deadSnaps = [...deadSessions.values()];
    // Live ones first (most recent activity on top), then dead ones, newest first.
    const all = liveSnaps.concat(deadSnaps);
    // Mirror into the SQLite metadata table (History browser) alongside the
    // scopedData blob. The OS terminal store is the real durable record.
    sqliteSyncTerminalSessions(all);
    await window.chatoss.scopedData.set(SESSIONS_KEY, all);
  } catch (e) { console.warn("persistSessions", e); }
}

// Load persisted snapshots from scopedData into the deadSessions map as read-only
// ended cards. Called once at init, BEFORE the UI renders, so the Sessions column
// shows prior terminals immediately. A snapshot whose status was "working" at the
// last save is shown as "ended" (the PTY is necessarily gone across a reopen).
async function loadPersistedSessions() {
  try {
    const arr = await window.chatoss.scopedData.get(SESSIONS_KEY);
    if (!Array.isArray(arr)) return;
    for (const s of arr) {
      if (!s || !s.id) continue;
      // If a live session with the same id somehow already exists this run, don't
      // shadow it with a dead card.
      if (sessions.has(s.id)) continue;
      // Anything persisted across a reopen is, by definition, no longer live.
      const snap = {
        id: s.id,
        label: s.label || s.id,
        cwd: s.cwd || "",
        agent: s.agent || s.label || s.id,
        conversationId: s.conversationId || null,
        worktreeBranch: s.worktreeBranch || null,
        // "working"/"starting"/"needs-input" all become "ended" after a reopen.
        status: (s.status === "exited") ? "exited" : "ended",
        exitCode: (s.status === "exited") ? s.exitCode : null,
        createdAt: s.createdAt || Date.now(),
        endedAt: s.endedAt || Date.now(),
        output: s.output || "",
        merged: !!s.merged,
      };
      deadSessions.set(snap.id, snap);
    }
  } catch (e) { console.warn("loadPersistedSessions", e); }
}

// Render the read-only "ended" card for a dead/persisted session into the grid.
// Shows the agent, working dir, an ended indicator, and the captured output tail.
// NOT live — there is no xterm mount, no input. Has only a Dismiss (✕) button.
function renderDeadSessionCard(snap) {
  const square = document.createElement("div");
  square.className = "term-square term-square-ended";
  square.dataset.deadId = snap.id;

  const header = document.createElement("div");
  header.className = "term-square-header";
  const dot = document.createElement("span");
  dot.className = "term-status-dot exited";
  dot.title = "Session ended — output preserved";
  const lab = document.createElement("span");
  lab.className = "term-label";
  // Label reflects the ended state clearly.
  lab.textContent = snap.label + (snap.status === "exited" ? " (exited)" : " (ended)");
  const cwdEl = document.createElement("span");
  cwdEl.className = "term-cwd";
  cwdEl.textContent = basename(snap.cwd);
  cwdEl.title = snap.cwd;
  const dismissBtn = document.createElement("button");
  dismissBtn.className = "term-head-btn term-close-btn";
  dismissBtn.type = "button";
  dismissBtn.textContent = "✕";
  dismissBtn.title = "Dismiss this ended session";
  header.appendChild(dot);
  header.appendChild(lab);
  header.appendChild(cwdEl);
  header.appendChild(dismissBtn);

  const body = document.createElement("div");
  body.className = "term-ended-body";

  // A short status line describing how it ended.
  const statusLine = document.createElement("div");
  statusLine.className = "term-ended-status";
  let statusText = "Session ended — output preserved (the live terminal is gone).";
  if (snap.merged) statusText = "Session ended — worktree merged. Output preserved.";
  else if (snap.status === "exited") statusText = "Agent exited (code " + (snap.exitCode == null ? "killed" : snap.exitCode) + "). Output preserved.";
  else if (snap.worktreeBranch) statusText = "Session ended (app was closed). Output preserved. Worktree branch: " + snap.worktreeBranch;
  statusLine.textContent = statusText;
  body.appendChild(statusLine);

  // The captured output tail, shown in a scrollable monospace block.
  const out = document.createElement("pre");
  out.className = "term-ended-output";
  out.textContent = (snap.output && snap.output.trim()) ? snap.output : "(no output was captured)";
  body.appendChild(out);

  square.appendChild(header);
  square.appendChild(body);

  // Resize handles (same as live squares) so ended cards resize in columns/rows
  // views too. The drag logic is delegated on the grid in initTermResize().
  const resizeX = document.createElement("div");
  resizeX.className = "term-resize-handle term-resize-handle-x";
  resizeX.setAttribute("role", "separator");
  resizeX.setAttribute("aria-orientation", "vertical");
  resizeX.setAttribute("aria-label", "Resize terminal width");
  const resizeY = document.createElement("div");
  resizeY.className = "term-resize-handle term-resize-handle-y";
  resizeY.setAttribute("role", "separator");
  resizeY.setAttribute("aria-orientation", "horizontal");
  resizeY.setAttribute("aria-label", "Resize terminal height");
  square.appendChild(resizeX);
  square.appendChild(resizeY);

  // insert before the empty-state card so the grid stays clean
  if (el.termEmpty && el.termEmpty.parentNode === el.termGrid) el.termGrid.insertBefore(square, el.termEmpty);
  else el.termGrid.appendChild(square);

  // clicking selects it (highlights); dismiss removes it
  square.addEventListener("click", (e) => {
    if (e.target === dismissBtn) return;
    selectSession(snap.id);
  });
  dismissBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    dismissDeadSession(snap.id);
  });

  return square;
}

// Remove a dead/persisted session from the UI + memory + scopedData.
async function dismissDeadSession(id) {
  const snap = deadSessions.get(id);
  if (!snap) return;
  deadSessions.delete(id);
  // Remove the card from the DOM.
  const card = el.termGrid.querySelector('[data-dead-id="' + CSS.escape(id) + '"]');
  if (card) card.remove();
  if (state.activeSessionId === id) {
    state.activeSessionId = sessions.size ? sessions.keys().next().value : null;
  }
  saveState();
  ensureEmptyHint();
  renderTabs();
  renderSessionInfo();
  // Also delete the OS-persisted record + SQLite metadata row.
  try { await window.chatoss.terminal.killSession(id); } catch (e) { /* non-fatal */ }
  await sqliteDeleteTerminalSession(id);
  await persistSessions();
}

// ============================================================
// === SQLite persistence layer ===
// ============================================================
// Conversation + terminal history used to live ONLY in scopedData, which was
// lost when an orchestration session finished — the user had no way to check
// on past work. This layer makes history durable the new way:
//
//   • Conversations, messages and tool calls are mirrored into the app's
//     PRIVATE SQLite database (capability "sqlite" — no prompt, persists
//     across restarts). saveState() schedules a debounced full sync, and
//     hydrateFromSqlite() restores them at load, so history survives even if
//     the scopedData blob is lost or reset.
//   • Terminal sessions are persisted BY THE OS now (they survive window close
//     and a full app restart). loadPlatformSessions() merges
//     terminal.listSessions() into the Sessions column — reattaching still-live
//     processes with reattachSession() and showing ended ones as read-only
//     cards whose output comes from attachSession(). killSession() is the
//     cleanup path.
//   • The History browser (top-bar "History" button) lets the user reopen a
//     past conversation or review/reconnect/delete a past terminal session.
//
// NOTE: this section is deliberately self-contained. Other code only calls
// into it through the small hooks listed at the bottom of this comment block:
//   saveState()            -> scheduleSqliteSync()
//   persistSessions()      -> sqliteSyncTerminalSessions(all)
//   saveWorktrees()        -> sqliteSyncWorktrees(arr)
//   loadWorktrees()        -> sqliteHydrateWorktrees()
//   dismissDeadSession()   -> sqliteDeleteTerminalSession(id) + killSession
//   closeSession()         -> sqliteDeleteTerminalSession(id) + killSession
//   deleteConversation()   -> sqliteDeleteConversation(c.id)
//   deleteProject()        -> sqliteDeleteProject(p.id)
//   sendMessage.onToolCall -> sqlitePersistToolCall(c.id, entry)
//   init()                 -> hydrateFromSqlite(), loadPlatformSessions(),
//                             initHistoryBrowser()

const SQLITE_DB = "termcoder";
let sqliteReady = false;
let sqliteInitPromise = null;

// --- ChatOSS sqlite API shape detection -------------------------------
// The documented contract is namespace-based: `db.open(name)` returns a
// sanitized NAME string, then `db.exec(name, sql, params)` / `db.query(name,
// sql, params)` / `db.close(name)` live on `window.chatoss.db`.
//
// The ACTUAL ChatOSS platform (as of the build this app runs against) is
// HANDLE-based: `db.open(name)` returns an OBJECT whose own methods are
// `handle.exec(sql)`, `handle.query(sql, params)` and `handle.close()`, with
// NO name argument (the handle is already bound to its DB). It also has a
// quirk: `handle.exec` does NOT bind parameters (it ignores any params arg,
// throwing "Wrong number of parameters passed to query"), while
// `handle.query(sql, paramsArray)` DOES bind them.
//
// To stay correct against EITHER shape (and survive a future platform change
// that brings the namespace API in line with the docs), we detect the shape
// once at open time and route every call through these helpers:
let sqliteApiShape = "unknown"; // "namespace" | "handle"
let sqliteHandle = null;        // the handle object when shape === "handle"
let sqliteName = null;          // the sanitized name string when shape === "namespace"

// Safely substitute `?` placeholders in a SQL string when the active exec path
// cannot bind params (i.e. the handle-exec path, which ignores params). Values
// are escaped for SQLite: strings get their quotes doubled, numbers/booleans
// are emitted literally, null/undefined -> NULL. This is only a fallback for
// the handle.exec() path; the namespace and handle.query() paths bind params
// natively. NOTE: every value Term Coder stores here is app-generated (ids,
// model output, tool results) — not user SQL — so interpolation is safe.
function sqliteInterpolate(sql, params) {
  if (!Array.isArray(params) || params.length === 0) return sql;
  let i = 0, out = "", literal = false;
  for (let k = 0; k < sql.length; k++) {
    const ch = sql[k];
    if (literal) { out += ch; if (ch === "'" && sql[k + 1] === "'") { out += "'"; k++; } else if (ch === "'") literal = false; continue; }
    if (ch === "'") { literal = true; out += ch; continue; }
    if (ch === "?") {
      const v = i < params.length ? params[i++] : null;
      out += sqliteLiteral(v);
      continue;
    }
    out += ch;
  }
  return out;
}
function sqliteLiteral(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return (isFinite(v) ? String(v) : "NULL");
  if (typeof v === "boolean") return v ? "1" : "0";
  // strings: escape embedded single quotes by doubling them
  return "'" + String(v).replace(/'/g, "''") + "'";
}

// Internal raw exec — does NOT gate on sqliteReady (used DURING sqliteInit to
// create the schema before the ready flag is set). Returns affected-row count.
async function _sqliteExecRaw(sql, params) {
  if (sqliteApiShape === "namespace") {
    return await window.chatoss.db.exec(sqliteName, sql, params) | 0;
  }
  // handle shape — exec does NOT bind params, so interpolate them in safely
  const real = params && params.length ? sqliteInterpolate(sql, params) : sql;
  return await sqliteHandle.exec(real) | 0;
}

// Internal raw query — does NOT gate on sqliteReady.
async function _sqliteQueryRaw(sql, params) {
  if (sqliteApiShape === "namespace") {
    return await window.chatoss.db.query(sqliteName, sql, params) || [];
  }
  // handle shape — query DOES bind params natively
  return await sqliteHandle.query(sql, params || []) || [];
}

// Run a statement (DDL/DML). Accepts (sql, params?). Returns the affected-row
// count from the platform (or 0 when the platform returns nothing meaningful).
async function sqliteExec(sql, params) {
  if (!sqliteReady) return 0;
  try {
    return await _sqliteExecRaw(sql, params);
  } catch (e) { console.warn("sqliteExec", e && e.message ? e.message : String(e), sql); throw e; }
}

// Run a SELECT. Accepts (sql, params?). Returns rows as objects keyed by column.
async function sqliteQuery(sql, params) {
  if (!sqliteReady) return [];
  try {
    return await _sqliteQueryRaw(sql, params);
  } catch (e) { console.warn("sqliteQuery", e && e.message ? e.message : String(e), sql); throw e; }
}

// Open the private DB and create the schema (idempotent). Returns true when
// the DB is usable; every helper below gates on this. Retries on a transient
// failure (the cached promise is cleared so a later open can succeed).
async function sqliteInit() {
  if (sqliteReady) return true;
  if (sqliteInitPromise) return sqliteInitPromise;
  sqliteInitPromise = (async () => {
    let step = "open";
    try {
      if (!window.chatoss || !window.chatoss.db) return false;
      const opened = await window.chatoss.db.open(SQLITE_DB);
      if (!opened) { return false; }
      // Detect API shape: a string sanitized name -> namespace API; an object
      // with exec/query -> handle API.
      if (typeof opened === "string") {
        sqliteApiShape = "namespace";
        sqliteName = opened;
        sqliteHandle = null;
      } else if (opened && typeof opened === "object" && typeof opened.exec === "function") {
        sqliteApiShape = "handle";
        sqliteHandle = opened;
        sqliteName = null;
      } else {
        // Unknown shape — can't proceed.
        console.warn("sqliteInit: unrecognized db.open() return type", typeof opened);
        return false;
      }
      step = "schema";
      // Use the RAW exec here (sqliteReady is not set yet, so sqliteExec would
      // no-op). Schema statements have no params, so interpolation is a no-op.
      await _sqliteExecRaw("CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT, folder_path TEXT, created_at INTEGER)");
      await _sqliteExecRaw("CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, created_at INTEGER)");
      await _sqliteExecRaw("CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT, content TEXT, thinking TEXT, tool_calls TEXT, seq INTEGER, created_at INTEGER)");
      await _sqliteExecRaw("CREATE TABLE IF NOT EXISTS tool_calls (id TEXT PRIMARY KEY, conversation_id TEXT, tool TEXT, args TEXT, result TEXT, created_at INTEGER)");
      await _sqliteExecRaw("CREATE TABLE IF NOT EXISTS terminal_sessions (id TEXT PRIMARY KEY, command TEXT, cwd TEXT, label TEXT, agent TEXT, worktree_branch TEXT, status TEXT, exit_code INTEGER, created_at INTEGER, last_active INTEGER, live INTEGER, merged INTEGER, output TEXT)");
      await _sqliteExecRaw("CREATE TABLE IF NOT EXISTS worktrees (branch TEXT PRIMARY KEY, wt_path TEXT, parent_branch TEXT, project_path TEXT, created_at INTEGER)");
      sqliteReady = true;
      return true;
    } catch (e) {
      console.warn("sqliteInit failed at step", step, ":", e && e.message ? e.message : String(e));
      // Clear the cached promise so a later attempt (e.g. after the capability
      // becomes ready) can retry instead of being stuck on a false result.
      sqliteInitPromise = null;
      return false;
    }
  })();
  return sqliteInitPromise;
}

// ---------- Conversations / messages / tool calls ----------

// Debounced full mirror of state.projects -> conversations -> messages into
// SQLite. saveState() calls scheduleSqliteSync(), so every message push (user,
// assistant, system) and every rename lands here within ~700ms. The sync is a
// full rewrite per conversation (delete + reinsert messages) — simple and
// correct; message ids are deterministic ("<convId>:<index>") so re-syncs are
// stable. Tool calls are upserted by id and never bulk-deleted here, so a
// mid-turn write (see sqlitePersistToolCall) survives a sync that runs before
// the assistant message is stored.
let _sqliteSyncTimer = null;
function scheduleSqliteSync() {
  if (_sqliteSyncTimer) return;
  _sqliteSyncTimer = setTimeout(() => {
    _sqliteSyncTimer = null;
    syncConversationsToSqlite().catch((e) => console.warn("scheduleSqliteSync", e));
  }, 700);
}

async function syncConversationsToSqlite() {
  if (!(await sqliteInit())) return;
  try {
    const projects = Array.isArray(state.projects) ? state.projects : [];
    for (const p of projects) {
      await sqliteExec(
        "INSERT OR REPLACE INTO projects (id, name, folder_path, created_at) VALUES (?, ?, ?, ?)",
        [p.id, p.name || "", p.folderPath || "", p.createdAt || Date.now()]);
      for (const c of (p.conversations || [])) {
        await sqliteExec(
          "INSERT OR REPLACE INTO conversations (id, project_id, title, created_at) VALUES (?, ?, ?, ?)",
          [c.id, p.id, c.name || c.id, c.createdAt || Date.now()]);
        await sqliteExec("DELETE FROM messages WHERE conversation_id = ?", [c.id]);
        const baseTs = c.createdAt || Date.now();
        let idx = 0;
        for (const m of (c.messages || [])) {
          const mid = c.id + ":" + idx;
          await sqliteExec(
            "INSERT INTO messages (id, conversation_id, role, content, thinking, tool_calls, seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [mid, c.id, m.role || "system", m.content || "",
             m.thinking || null,
             (m.toolCalls && m.toolCalls.length) ? JSON.stringify(m.toolCalls) : null,
             idx, baseTs + idx]);
          if (m.toolCalls && m.toolCalls.length) {
            for (const tc of m.toolCalls) {
              await sqliteExec(
                "INSERT OR REPLACE INTO tool_calls (id, conversation_id, tool, args, result, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                [tc.id || uuid(), c.id, tc.name || "unknown",
                 JSON.stringify(tc.args || {}),
                 tc.error ? ("Error: " + tc.error) : (tc.result != null ? String(tc.result) : null),
                 tc.createdAt || Date.now()]);
            }
          }
          idx++;
        }
      }
    }
  } catch (e) { console.warn("syncConversationsToSqlite", e); }
}

// Write one tool call as it happens (mid-turn). Upsert by id so the result
// update later in the same turn replaces the pending row.
async function sqlitePersistToolCall(conversationId, tc) {
  if (!(await sqliteInit())) return;
  try {
    await sqliteExec(
      "INSERT OR REPLACE INTO tool_calls (id, conversation_id, tool, args, result, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [tc.id || uuid(), conversationId, tc.name || "unknown",
       JSON.stringify(tc.args || {}),
       tc.error ? ("Error: " + tc.error) : (tc.result != null ? String(tc.result) : null),
       tc.createdAt || Date.now()]);
  } catch (e) { console.warn("sqlitePersistToolCall", e); }
}

async function sqliteDeleteConversation(cid) {
  if (!(await sqliteInit())) return;
  try {
    await sqliteExec("DELETE FROM messages WHERE conversation_id = ?", [cid]);
    await sqliteExec("DELETE FROM tool_calls WHERE conversation_id = ?", [cid]);
    await sqliteExec("DELETE FROM conversations WHERE id = ?", [cid]);
  } catch (e) { console.warn("sqliteDeleteConversation", e); }
}

async function sqliteDeleteProject(pid) {
  if (!(await sqliteInit())) return;
  try {
    const rows = await sqliteQuery("SELECT id FROM conversations WHERE project_id = ?", [pid]);
    for (const r of rows) await sqliteDeleteConversation(r.id);
    await sqliteExec("DELETE FROM projects WHERE id = ?", [pid]);
  } catch (e) { console.warn("sqliteDeleteProject", e); }
}

// Restore projects/conversations/messages from SQLite at load. SQLite is the
// authoritative history store: scopedData may be stale or lost after an
// orchestration session. Merge rules:
//   • Projects missing from state are recreated (folderPath comes from the
//     projects table, so a lost scopedData blob still restores fully).
//   • A conversation missing from state is recreated with its SQLite messages.
//   • A conversation present in state keeps its (possibly newer) name, and its
//     messages become the SQLite ones — plus any in-memory tail that has not
//     been synced yet (state longer than SQLite).
async function hydrateFromSqlite() {
  if (!(await sqliteInit())) return;
  try {
    const prows = await sqliteQuery("SELECT * FROM projects ORDER BY created_at ASC");
    for (const pr of prows) {
      if (!state.projects.some((p) => p.id === pr.id)) {
        state.projects.push({
          id: pr.id,
          name: pr.name || basename(pr.folder_path),
          folderPath: pr.folder_path || "",
          conversations: [],
        });
      }
    }
    const crows = await sqliteQuery("SELECT * FROM conversations ORDER BY created_at ASC");
    for (const cr of crows) {
      const p = state.projects.find((x) => x.id === cr.project_id);
      if (!p) continue; // orphaned (project deleted) — leave the rows alone
      const mrows = await sqliteQuery(
        "SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq ASC", [cr.id]);
      const sqliteMsgs = mrows.map((mr) => {
        const m = { role: mr.role || "system", content: mr.content || "" };
        if (mr.thinking) m.thinking = mr.thinking;
        if (mr.tool_calls) { try { m.toolCalls = JSON.parse(mr.tool_calls); } catch (e) { /* ignore */ } }
        return m;
      });
      const c = p.conversations.find((x) => x.id === cr.id);
      if (c) {
        if (sqliteMsgs.length >= c.messages.length) c.messages = sqliteMsgs;
        else c.messages = sqliteMsgs.concat(c.messages.slice(sqliteMsgs.length));
      } else {
        p.conversations.push({
          id: cr.id,
          name: cr.title || ("Conversation " + (p.conversations.length + 1)),
          messages: sqliteMsgs,
          modelId: null, effort: null, boardId: null,
        });
      }
    }
  } catch (e) { console.warn("hydrateFromSqlite", e); }
}

// ---------- Terminal sessions (SQLite metadata mirror) ----------
// The OS is the real store (terminal.listSessions / attachSession /
// reattachSession / killSession). This table only mirrors the app's own
// metadata (label, agent, worktree branch, merged flag, output tail) so the
// History browser can show richer rows than the OS list alone.

async function sqliteSyncTerminalSessions(snaps) {
  if (!(await sqliteInit())) return;
  try {
    for (const s of (snaps || [])) {
      if (!s || !s.id) continue;
      const live = !(s.status === "exited" || s.status === "ended");
      await sqliteExec(
        "INSERT OR REPLACE INTO terminal_sessions (id, command, cwd, label, agent, worktree_branch, status, exit_code, created_at, last_active, live, merged, output) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [s.id, s.agent || s.label || "", s.cwd || "", s.label || s.id, s.agent || "",
         s.worktreeBranch || null, s.status || "ended",
         s.exitCode == null ? null : s.exitCode,
         s.createdAt || Date.now(), s.endedAt || s.createdAt || Date.now(),
         live ? 1 : 0, s.merged ? 1 : 0, s.output || ""]);
    }
  } catch (e) { console.warn("sqliteSyncTerminalSessions", e); }
}

async function sqliteDeleteTerminalSession(id) {
  if (!(await sqliteInit())) return;
  try {
    await sqliteExec("DELETE FROM terminal_sessions WHERE id = ?", [id]);
  } catch (e) { console.warn("sqliteDeleteTerminalSession", e); }
}

async function sqliteGetTerminalMeta(id) {
  if (!(await sqliteInit())) return null;
  try {
    const rows = await sqliteQuery("SELECT * FROM terminal_sessions WHERE id = ?", [id]);
    return rows.length ? rows[0] : null;
  } catch (e) { return null; }
}

// Decode the base64 output history attachSession() returns.
function decodeBase64(b64) {
  try { return atob(String(b64 || "")); } catch (e) { return ""; }
}

// Merge the OS-persisted terminal sessions into the app at load. Called from
// init() AFTER loadPersistedSessions() so scopedData snapshots (which carry
// the richer label/agent metadata) win for ids they already know.
//   • live:true  -> reattachSession() and register it as a live square again.
//   • live:false -> read-only "ended" card with the saved output tail.
async function loadPlatformSessions() {
  try {
    if (!window.chatoss || !window.chatoss.terminal || typeof window.chatoss.terminal.listSessions !== "function") return;
    const list = await window.chatoss.terminal.listSessions();
    if (!Array.isArray(list)) return;
    for (const s of list) {
      if (!s || !s.id) continue;
      if (sessions.has(s.id)) continue; // already live this run
      const prior = deadSessions.get(s.id);
      if (s.live) {
        // The process survived the window close — reconnect to it.
        try {
          const handle = await window.chatoss.terminal.reattachSession(s.id);
          if (handle) {
            const label = (prior && prior.label) || s.command || "session";
            const cwd = (prior && prior.cwd) || s.cwd || "";
            await registerSession(handle, s.command || "", [], cwd, label, (prior && prior.conversationId) || null);
            // The reattached session is live again — drop the stale dead card.
            if (prior) {
              deadSessions.delete(s.id);
              const card = el.termGrid.querySelector('[data-dead-id="' + CSS.escape(s.id) + '"]');
              if (card) card.remove();
            }
            continue;
          }
        } catch (e) { console.warn("loadPlatformSessions reattach", s.id, e); }
        // Reattach failed (denied or already gone) — leave it to the History
        // browser, which shows it as LIVE (status badge only; the reattach
        // affordance was removed from History to avoid confusion).
        continue;
      }
      if (deadSessions.has(s.id)) continue;
      // Ended session — fetch its persisted output for the read-only card.
      let output = "";
      try {
        const attached = await window.chatoss.terminal.attachSession(s.id);
        if (attached && attached.output) {
          output = stripAnsi(decodeBase64(attached.output));
          if (output.length > 6000) output = "…(earlier output trimmed)…\n" + output.slice(-6000);
        }
      } catch (e) { /* no output available */ }
      deadSessions.set(s.id, {
        id: s.id,
        label: (prior && prior.label) || s.command || s.id,
        cwd: (prior && prior.cwd) || s.cwd || "",
        agent: (prior && prior.agent) || s.command || s.id,
        conversationId: (prior && prior.conversationId) || null,
        worktreeBranch: (prior && prior.worktreeBranch) || worktreeBranchForCwd(s.cwd),
        status: "ended",
        exitCode: null,
        createdAt: s.createdAt || Date.now(),
        endedAt: s.lastActiveAt || Date.now(),
        output,
        merged: !!(prior && prior.merged),
      });
    }
  } catch (e) { console.warn("loadPlatformSessions", e); }
}

// ---------- Worktrees (SQLite mirror) ----------

async function sqliteSyncWorktrees(arr) {
  if (!(await sqliteInit())) return;
  try {
    const seen = new Set();
    for (const m of (arr || [])) {
      if (!m || !m.branch) continue;
      seen.add(m.branch);
      await sqliteExec(
        "INSERT OR REPLACE INTO worktrees (branch, wt_path, parent_branch, project_path, created_at) VALUES (?, ?, ?, ?, ?)",
        [m.branch, m.wtPath || null, m.parentBranch || null, m.projectPath || null, m.createdAt || Date.now()]);
    }
    // Mirror worktreeMeta exactly: merged worktrees are deleted from the map
    // before saveWorktrees() runs, so drop any row that is no longer present.
    const rows = await sqliteQuery("SELECT branch FROM worktrees");
    for (const r of rows) {
      if (!seen.has(r.branch)) await sqliteExec("DELETE FROM worktrees WHERE branch = ?", [r.branch]);
    }
  } catch (e) { console.warn("sqliteSyncWorktrees", e); }
}

async function sqliteHydrateWorktrees() {
  if (!(await sqliteInit())) return;
  try {
    const rows = await sqliteQuery("SELECT * FROM worktrees");
    for (const r of rows) {
      if (!r.branch || worktreeMeta.has(r.branch)) continue;
      worktreeMeta.set(r.branch, { wtPath: r.wt_path, parentBranch: r.parent_branch, projectPath: r.project_path });
    }
  } catch (e) { console.warn("sqliteHydrateWorktrees", e); }
}

// ---------- History browser ----------
// Top-bar "History" button -> modal with two tabs. Conversations come from the
// SQLite mirror; terminals come from the OS-persisted session list merged with
// the app's metadata table and in-memory maps.

let historyTab = "conversations";

function fmtTime(ts) {
  if (!ts) return "unknown time";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "unknown time";
  const diff = Date.now() - ts;
  if (diff < 60 * 1000) return "just now";
  if (diff < 3600 * 1000) return Math.floor(diff / 60000) + "m ago";
  if (diff < 24 * 3600 * 1000) return Math.floor(diff / 3600000) + "h ago";
  return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function openHistoryBrowser() {
  if (!el.historyModal) return;
  el.historyModal.classList.remove("hidden");
  renderHistoryBrowser();
}
function closeHistoryBrowser() {
  if (el.historyModal) el.historyModal.classList.add("hidden");
}

async function renderHistoryBrowser() {
  const list = el.historyList;
  if (!list || !el.historyTabs) return;
  list.innerHTML = "";
  for (const btn of el.historyTabs.querySelectorAll(".history-tab")) {
    const active = btn.dataset.tab === historyTab;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", String(active));
  }
  if (historyTab === "conversations") await renderHistoryConversations(list);
  else await renderHistoryTerminals(list);
}

async function renderHistoryConversations(list) {
  if (!(await sqliteInit())) {
    list.innerHTML = '<div class="history-empty">SQLite storage is unavailable — history cannot be shown.</div>';
    return;
  }
  let rows = [];
  try {
    rows = await sqliteQuery(
      "SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS msg_count FROM conversations c ORDER BY c.created_at DESC");
  } catch (e) { console.warn("renderHistoryConversations", e); }
  if (!rows.length) {
    list.innerHTML = '<div class="history-empty">No past conversations yet. Chat with the orchestrator and it will be saved here.</div>';
    return;
  }
  for (const r of rows) {
    const p = state.projects.find((x) => x.id === r.project_id);
    const item = document.createElement("div");
    item.className = "history-item";
    const info = document.createElement("div");
    info.className = "history-item-info";
    const title = document.createElement("div");
    title.className = "history-item-title";
    title.textContent = r.title || r.id;
    title.title = r.title || r.id;
    const meta = document.createElement("div");
    meta.className = "history-item-meta";
    meta.textContent = (p ? p.name : "(project removed)") + " · " + (r.msg_count || 0) + " messages · " + fmtTime(r.created_at);
    info.appendChild(title);
    info.appendChild(meta);
    const acts = document.createElement("div");
    acts.className = "history-item-actions";
    const openBtn = document.createElement("button");
    openBtn.className = "btn btn-primary btn-small";
    openBtn.type = "button";
    openBtn.textContent = "Open";
    openBtn.disabled = !p;
    openBtn.title = p ? "Reopen this conversation in the chat" : "The project for this conversation no longer exists";
    openBtn.onclick = () => historyReopenConversation(r.id);
    const delBtn = document.createElement("button");
    delBtn.className = "btn btn-ghost btn-small";
    delBtn.type = "button";
    delBtn.textContent = "Delete";
    delBtn.title = "Delete this conversation and its messages";
    delBtn.onclick = () => historyDeleteConversation(r.id);
    acts.appendChild(openBtn);
    acts.appendChild(delBtn);
    item.appendChild(info);
    item.appendChild(acts);
    list.appendChild(item);
  }
}

function historyReopenConversation(cid) {
  for (const p of state.projects) {
    const c = p.conversations.find((x) => x.id === cid);
    if (c) {
      state.activeProjectId = p.id;
      state.activeConversationId = c.id;
      collapsedProjects.delete(p.id);
      saveState();
      closeHistoryBrowser();
      renderProjects();
      renderChat();
      renderSessionInfo();
      return;
    }
  }
  setStatus("That conversation's project no longer exists.");
}

async function historyDeleteConversation(cid) {
  for (const p of state.projects) {
    const c = p.conversations.find((x) => x.id === cid);
    if (c) { deleteConversation(p, c); break; }
  }
  await sqliteDeleteConversation(cid);
  renderHistoryBrowser();
}

async function renderHistoryTerminals(list) {
  let osSessions = [];
  try {
    if (window.chatoss && window.chatoss.terminal && typeof window.chatoss.terminal.listSessions === "function") {
      const l = await window.chatoss.terminal.listSessions();
      if (Array.isArray(l)) osSessions = l;
    }
  } catch (e) { console.warn("renderHistoryTerminals listSessions", e); }
  const meta = new Map();
  if (await sqliteInit()) {
    try {
      const rows = await sqliteQuery("SELECT * FROM terminal_sessions ORDER BY last_active DESC");
      for (const r of rows) meta.set(r.id, r);
    } catch (e) { /* ignore */ }
  }
  const entries = [];
  const seen = new Set();
  for (const s of osSessions) {
    if (!s || !s.id) continue;
    seen.add(s.id);
    const m = meta.get(s.id) || {};
    entries.push({
      id: s.id,
      command: s.command || m.command || "",
      cwd: s.cwd || m.cwd || "",
      label: m.label || s.command || s.id,
      agent: m.agent || s.command || "",
      worktreeBranch: m.worktree_branch || null,
      merged: !!m.merged,
      createdAt: s.createdAt || m.created_at || Date.now(),
      lastActiveAt: s.lastActiveAt || m.last_active || Date.now(),
      live: !!s.live,
    });
  }
  // In-memory live sessions not (yet) in the OS list.
  for (const rec of sessions.values()) {
    if (seen.has(rec.id)) continue;
    seen.add(rec.id);
    entries.push({
      id: rec.id, command: rec.cmd || "", cwd: rec.cwd || "",
      label: rec.label || rec.id, agent: rec.agent || "",
      worktreeBranch: rec.worktreeBranch || null, merged: !!rec.merged,
      createdAt: rec.createdAt || Date.now(), lastActiveAt: Date.now(), live: true,
    });
  }
  // Dead cards from this run.
  for (const snap of deadSessions.values()) {
    if (seen.has(snap.id)) continue;
    seen.add(snap.id);
    entries.push({
      id: snap.id, command: snap.agent || "", cwd: snap.cwd || "",
      label: snap.label || snap.id, agent: snap.agent || "",
      worktreeBranch: snap.worktreeBranch || null, merged: !!snap.merged,
      createdAt: snap.createdAt || Date.now(), lastActiveAt: snap.endedAt || Date.now(), live: false,
    });
  }
  entries.sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0));
  if (!entries.length) {
    list.innerHTML = '<div class="history-empty">No terminal sessions yet. Start a session and its history will be kept here.</div>';
    return;
  }
  for (const e of entries) {
    const item = document.createElement("div");
    item.className = "history-item";
    const info = document.createElement("div");
    info.className = "history-item-info";
    const title = document.createElement("div");
    title.className = "history-item-title";
    title.textContent = e.label;
    title.title = e.label;
    const meta = document.createElement("div");
    meta.className = "history-item-meta";
    meta.textContent = (e.command ? e.command + " · " : "") +
      (e.cwd ? basename(e.cwd) : "(no cwd)") + " · " + fmtTime(e.createdAt) +
      (e.worktreeBranch ? " · branch " + e.worktreeBranch : "") +
      (e.merged ? " · merged" : "");
    info.appendChild(title);
    info.appendChild(meta);
    const acts = document.createElement("div");
    acts.className = "history-item-actions";
    if (e.live) {
      const liveBadge = document.createElement("span");
      liveBadge.className = "history-badge history-badge-live";
      liveBadge.textContent = "LIVE";
      acts.appendChild(liveBadge);
    } else {
      const endedBadge = document.createElement("span");
      endedBadge.className = "history-badge";
      endedBadge.textContent = "ended";
      acts.appendChild(endedBadge);
    }
    const viewBtn = document.createElement("button");
    viewBtn.className = "btn btn-ghost btn-small";
    viewBtn.type = "button";
    viewBtn.textContent = "Output";
    viewBtn.title = "Show the saved terminal output";
    viewBtn.onclick = () => historyViewTerminal(e.id, item);
    acts.appendChild(viewBtn);
    const killBtn = document.createElement("button");
    killBtn.className = "btn btn-ghost btn-small";
    killBtn.type = "button";
    killBtn.textContent = "Delete";
    killBtn.title = "Kill the process (if live) and delete the saved record";
    killBtn.onclick = () => historyKillTerminal(e.id);
    acts.appendChild(killBtn);
    item.appendChild(info);
    item.appendChild(acts);
    list.appendChild(item);
  }
}

async function historyViewTerminal(id, item) {
  const existing = item.querySelector(".history-output");
  if (existing) { existing.remove(); return; }
  const out = document.createElement("pre");
  out.className = "history-output";
  out.textContent = "Loading saved output…";
  item.appendChild(out);

  // 1) Try the OS-persisted session first (the live output history). The OS
  //    store is the authoritative record while the session still exists.
  let osOutput = null, osGone = false;
  try {
    const attached = await window.chatoss.terminal.attachSession(id);
    if (attached && attached.output) {
      osOutput = stripAnsi(decodeBase64(attached.output));
    }
  } catch (e) {
    // "no such terminal session: <id>" — the live session was killed/expired/
    // deleted and the OS no longer has it. Fall through to the saved history.
    osGone = true;
  }

  if (osOutput) {
    out.textContent = osOutput || "(no output)";
    return;
  }

  // 2) The OS session is gone (or had no output). Fall back to the output tail
  //    saved in the SQLite history table, plus the in-memory dead card if this
  //    session is from the current run. Show a clear message instead of a raw
  //    "no such terminal session" error.
  let saved = "";
  const dead = deadSessions.get(id);
  if (dead && dead.output) saved = dead.output;
  if (!saved) {
    const meta = await sqliteGetTerminalMeta(id);
    if (meta && meta.output) saved = meta.output;
  }

  const banner = osGone
    ? "This session is no longer live — showing saved output from history."
    : "No live output for this session — showing saved output from history.";
  if (saved) {
    out.textContent = banner + "\n\n" + saved;
  } else {
    out.textContent = "This session is no longer live, and no saved output was found in history.";
  }
}

async function historyKillTerminal(id) {
  try {
    if (window.chatoss && window.chatoss.terminal && typeof window.chatoss.terminal.killSession === "function") {
      await window.chatoss.terminal.killSession(id);
    }
  } catch (e) { console.warn("historyKillTerminal killSession", id, e); }
  if (sessions.has(id)) { await closeSession(id); }
  if (deadSessions.has(id)) {
    deadSessions.delete(id);
    const card = el.termGrid.querySelector('[data-dead-id="' + CSS.escape(id) + '"]');
    if (card) card.remove();
    if (state.activeSessionId === id) state.activeSessionId = sessions.size ? sessions.keys().next().value : null;
    saveState();
    ensureEmptyHint();
    renderTabs();
    renderSessionInfo();
  }
  await sqliteDeleteTerminalSession(id);
  persistSessions().catch(() => { /* non-fatal */ });
  renderHistoryBrowser();
}

// Wire the top-bar button, tabs, refresh and close controls. Called once from
// init(); the modal itself is also added to the shared backdrop/Esc handling.
function initHistoryBrowser() {
  if (!el.historyBtn || !el.historyModal) return;
  el.historyBtn.addEventListener("click", openHistoryBrowser);
  if (el.historyCloseX) el.historyCloseX.addEventListener("click", closeHistoryBrowser);
  if (el.historyRefresh) el.historyRefresh.addEventListener("click", () => renderHistoryBrowser());
  if (el.historyTabs) {
    el.historyTabs.addEventListener("click", (e) => {
      const btn = e.target.closest && e.target.closest(".history-tab");
      if (!btn) return;
      historyTab = btn.dataset.tab || "conversations";
      renderHistoryBrowser();
    });
  }
}

// Promise + resolver for the spawn modal wait (set while the modal is open).
// The orchestrator's start_cli_session tool awaits this; manual start too.
let spawnPromise = null;
let spawnResolve = null;
// The opts the currently-open modal was opened with (batchMode support).
let spawnModalOpts = null;

// ---------- DOM refs ----------
const $ = (id) => document.getElementById(id);
const el = {
  loading: $("app-loading"),
  // top bar
  settingsBtn: $("settings-btn"),
  newChatBtn: $("new-chat-btn"),
  newProjectTopBtn: $("new-project-top-btn"),
  // left
  projectList: $("project-list"),
  projSessionsBody: null,   // filled in by renderProjects (selected project only)
  projSessionsCount: null,
  // code editor column
  editor: $("code-editor"),
  rzEditor: $("rz-editor"),
  editorInput: $("editor-input"),
  editorFilename: $("editor-filename"),
  editorModifiedDot: $("editor-modified-dot"),
  editorSaveBtn: $("editor-save-btn"),
  editorCloseBtn: $("editor-close-btn"),
  editorStatus: $("editor-status"),
  // middle
  modelPicker: $("model-picker"),
  effortPicker: $("effort-picker"),
  copyConvBtn: $("copy-conv-btn"),
  addFileBtn: $("add-file-btn"),
  attachBoardBtn: $("attach-board-btn"),
  attachedBoardName: $("attached-board-name"),
  boardChip: $("board-chip"),
  detachBoardBtn: $("detach-board-btn"),
  attachmentStrip: $("attachment-strip"),
  imagePreviewModal: $("image-preview-modal"),
  imagePreviewImg: $("image-preview-img"),
  imagePreviewClose: $("image-preview-close"),
  chatLog: $("chat-log"),
  chatEmpty: $("chat-empty"),
  chatScroll: $("chat-scroll"),
  chatOverlay: $("chat-overlay"),
  chatJumpBtn: $("chat-jump-btn"),
  chatStatus: $("chat-status"),
  chatForm: $("chat-form"),
  chatInput: $("chat-input"),
  tokenEstimator: $("token-estimator"),
  tokenEstimatorBtn: $("token-estimator-btn"),
  tokenCount: $("token-count"),
  tokenMax: $("token-max"),
  tokenRingFill: $("token-ring-fill"),
  tokenPopover: $("token-popover"),
  sendBtn: $("send-btn"),
  sendIcon: document.querySelector("#send-btn .send-icon"),
  stopIcon: document.querySelector("#send-btn .stop-icon"),
  sessionInfo: $("session-info"),
  // right
  newSessionBtn: $("new-session-btn"),
  newSessionBtn2: $("new-session-btn-2"),
  termCount: $("term-count"),
  termGrid: $("term-grid"),
  termEmpty: $("term-empty"),
  termViewSwitcher: $("term-view-switcher"),
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
  // updates
  checkUpdatesBtn: $("check-updates-btn"),
  updateStatus: $("update-status"),
  openReleasesBtn: $("open-releases-btn"),
  // model selection mode
  modelModeRadios: $("model-mode-radios"),
  modelModeManual: $("model-mode-manual"),
  modelModeAlways: $("model-mode-always"),
  modelModeComplexity: $("model-mode-complexity"),
  alwaysModel: $("always-model"),
  complexityModelLow: $("complexity-model-low"),
  complexityModelMedium: $("complexity-model-medium"),
  complexityModelHigh: $("complexity-model-high"),
  // Per-target sub-agent effort selects (Model Selection Mode panels)
  alwaysEffort: $("always-effort"),
  complexityEffortLow: $("complexity-effort-low"),
  complexityEffortMedium: $("complexity-effort-medium"),
  complexityEffortHigh: $("complexity-effort-high"),
  // trust-folder mode
  trustModeRadios: $("trust-mode-radios"),
  autoFollow: $("auto-follow"),
  // board picker
  boardPicker: $("board-picker"),
  boardPickerList: $("board-picker-list"),
  boardPickerX: $("board-picker-x"),
  // history browser (modal)
  historyBtn: $("history-btn"),
  historyModal: $("history-modal"),
  historyCloseX: $("history-close-x"),
  historyRefresh: $("history-refresh"),
  historyTabs: $("history-tabs"),
  historyList: $("history-list"),
  // user terminal (bottom drawer) — entirely user-driven, separate from the
  // orchestrator's right-side AI sessions. Toggled by sidebar icon / Cmd+J.
  userTermBtn: $("user-term-btn"),
  userTermDrawer: $("user-term-drawer"),
  userTermResizer: $("user-term-resizer"),
  userTermCwd: $("user-term-cwd"),
  userTermMount: $("user-term-mount"),
  userTermClear: $("user-term-clear"),
  userTermRestart: $("user-term-restart"),
  userTermClose: $("user-term-close"),
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
  // Mirror conversations/messages into the private SQLite DB (debounced) so
  // history survives even if the scopedData blob is lost after a session.
  scheduleSqliteSync();
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
  const fresh = { codex: false, claude: false, ollama: false, opencode: false, models: [], scannedAt: now, denied: false, claudePath: null, codexPath: null, opencodePath: null };
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

  // Helper: resolve a CLI binary's absolute path the same way ollamaPath is
  // resolved — `which` first, then a login shell `which`, then well-known
  // locations. Returns the path string or null. Also sets the boolean flag
  // on `fresh` so callers know the binary is available.
  const resolveCliPath = async (name, guesses) => {
    let path = null;
    const wr = await probe("which " + name);
    if (wr !== null && wr.exitCode === 0 && String(wr.output || "").trim()) {
      path = String(wr.output).trim().split("\n")[0].trim();
    }
    if (!path) {
      const lr = await probe(loginShell("which " + name));
      if (lr !== null && lr.exitCode === 0 && String(lr.output || "").trim()) {
        path = String(lr.output).trim().split("\n")[0].trim();
      }
    }
    if (!path) {
      for (const g of guesses) {
        const tr = await probe("test -x " + JSON.stringify(g) + " && echo ok");
        if (tr !== null && tr.exitCode === 0 && /ok/.test(String(tr.output))) { path = g; break; }
      }
    }
    return path;
  };

  // Resolve the direct claude / codex / opencode binaries (for launching them
  // WITHOUT going through ollama). The boolean flags stay in lockstep with the
  // path.
  codexPath = await resolveCliPath("codex", CODEX_GUESSES);
  fresh.codex = !!codexPath;
  fresh.codexPath = codexPath;
  claudePath = await resolveCliPath("claude", CLAUDE_GUESSES);
  fresh.claude = !!claudePath;
  fresh.claudePath = claudePath;
  opencodePath = await resolveCliPath("opencode", OPENCODE_GUESSES);
  fresh.opencode = !!opencodePath;
  fresh.opencodePath = opencodePath;

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
    opencode: detection.opencode,
    models: detection.models.slice(),
    denied: detection.denied,
    claudePath: detection.claudePath || null,
    codexPath: detection.codexPath || null,
    opencodePath: detection.opencodePath || null,
  };
  saveSettings();
  renderDetectedList();
  // If the settings panel is open, refresh the model pickers with the newly
  // detected models (preserving saved selections where still available).
  if (el.settingsPanel && !el.settingsPanel.classList.contains("hidden")) {
    applyModelSelectionModeToUi();
  }

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
      description: "Ask the user to start a new sub-agent CLI session in a working directory. The USER decides the launch target in a confirmation dialog — they can run the real claude or codex CLI directly (if they have a direct account), or launch through ollama with a chosen model. Call this when you need an agent shell to work in, then wait for the returned session id. cwd defaults to the active project folder. This REFUSES to start a second agent in a directory that already has a live session, because two agents in one working directory clobber each other's edits — correct or close the existing agent instead.",
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
      name: "create_card",
      description: "Create a new Kanban card on the attached board (boardId defaults to the attached board). Returns the new card id.",
      parameters: {
        type: "object",
        properties: {
          boardId: { type: "string", description: "Optional. Defaults to the attached board." },
          title: { type: "string", description: "The card title (required)." },
          description: { type: "string", description: "Optional longer description." },
          columnId: { type: "string", description: "The column to add the card to — must be one of the column ids from get_board. Defaults to the first column." },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_column",
      description: "Create a new column on the attached Kanban board (boardId defaults to the attached board). Returns the new column id.",
      parameters: {
        type: "object",
        properties: {
          boardId: { type: "string", description: "Optional. Defaults to the attached board." },
          name: { type: "string", description: "The column name (required)." },
        },
        required: ["name"],
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
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file's contents from the project (or a worktree path inside it). Returns the content, truncated to maxChars (default 20000). Use this to inspect files yourself — app.json, AGENTS.md, a file an agent just changed — instead of spawning a sub-agent to look.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path of the file to read. Must be inside the active project folder (worktree paths are inside it)." },
          maxChars: { type: "number", description: "How many characters to return. Default 20000." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write (create or overwrite) a file in the project. Use for small direct edits that are YOUR job — release metadata, docs, config — not for implementation work (that belongs to sub-agents in worktrees).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path of the file to write. Must be inside the active project folder." },
          contents: { type: "string", description: "The complete new file contents." },
        },
        required: ["path", "contents"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Make a targeted edit to a file: replace an exact snippet (old_string) with new_string. old_string must appear EXACTLY ONCE in the file — the edit fails otherwise. Use for small precise changes (e.g. bumping a version string). For whole-file rewrites use write_file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path of the file to edit. Must be inside the active project folder." },
          old_string: { type: "string", description: "The exact existing text to replace (copy it verbatim)." },
          new_string: { type: "string", description: "The replacement text." },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_status",
      description: "Show the project's git state: current branch, ahead/behind vs origin, uncommitted changes, and the last 5 commits. Use this to check whether a commit or push is needed.",
      parameters: {
        type: "object",
        properties: { projectId: { type: "string", description: "Optional. Defaults to the active project." } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_commit",
      description: "Stage ALL changes in the project and commit them with the given message. This is YOUR job (the orchestrator's) — never delegate a commit to a sub-agent. Returns the commit output.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Optional. Defaults to the active project." },
          message: { type: "string", description: "The commit message (required)." },
        },
        required: ["message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_push",
      description: "Push the project's current branch to origin (sets upstream on first push). This is YOUR job — never delegate a push to a sub-agent. Returns the push output.",
      parameters: {
        type: "object",
        properties: { projectId: { type: "string", description: "Optional. Defaults to the active project." } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "version_bump",
      description: "Bump the project's version: the \"version\" field in app.json AND any matching APP_VERSION constant in the project's root-level JS files (the two must always match). bump is 'major', 'minor' or 'patch'. This is release metadata — YOUR job, never a sub-agent's. Call this BEFORE git_commit/git_push/create_release.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Optional. Defaults to the active project." },
          bump: { type: "string", description: "'major', 'minor' or 'patch' (required). MINOR for a batch with features/fixes, PATCH for a single tiny fix." },
        },
        required: ["bump"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_release",
      description: "Create a GitHub release for the project's CURRENT version (from app.json) and attach installable assets: gh release create v<version> --target main, then build the .aip (zip of the app's runtime files — app.json, entry HTML, JS/CSS, icon, libs/ — excluding tests/, docs, .git, *.md, and old .aip/.zip files) plus a .zip copy, and upload both with gh release upload. The version bump must already be committed and pushed (version_bump → git_commit → git_push → create_release). This is YOUR job — never delegate a release to a sub-agent.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Optional. Defaults to the active project." },
          notes: { type: "string", description: "Release notes (markdown). Defaults to a one-line summary." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "health_check",
      description: "Check every live session for stalls: a session that is still WORKING/STARTING but has produced no output for 10+ minutes is nudged with \"are you still working? continue\" (rate-limited to one nudge per 10 min per session) and reported. Sessions with degenerate output are reported too. The app also runs this check automatically every 5 minutes. Use this to see at a glance which agents are healthy, stalled, or degenerate.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "worktree_git_status",
      description: "Show the git state of ONE worktree: uncommitted changes (git status --porcelain), a diff stat, and the last 3 commits on its branch. Use this to see what a killed or finished agent actually changed before merging — the app also auto-commits a worktree's uncommitted work when its session is closed, so a killed agent's edits are never stranded.",
      parameters: {
        type: "object",
        properties: {
          branchName: { type: "string", description: "The worktree's branch name (from list_worktrees)." },
          worktreePath: { type: "string", description: "Alternative: the worktree's absolute path." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "spawn_batch",
      description: "Spawn ALL parallel subtasks in ONE call: for each task, create a git worktree and start a coding-agent session in it with the task's prompt. One launch choice applies to the whole batch (the saved default if one is pinned, otherwise ONE spawn dialog for the batch). This eliminates the 'stopped after 1-of-N' failure mode where the orchestrator spawned agents one at a time and stopped early. Returns every session id + worktree branch so you can monitor them with wait_for_session and merge with merge_worktree.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Optional. Defaults to the active project." },
          tasks: {
            type: "array",
            description: "The parallel subtasks to spawn (1-8). Each: { name: short kebab-case name (becomes the worktree branch), prompt: the full task brief for the agent }.",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Short kebab-case name, e.g. 'fix-idle-detection'. Becomes the worktree branch name." },
                prompt: { type: "string", description: "The full task brief the agent receives." },
              },
              required: ["name", "prompt"],
            },
          },
        },
        required: ["tasks"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_worktree",
      description: "Delete a worktree WITHOUT merging: commits any uncommitted work in it (WIP commit), removes the worktree directory (git worktree remove --force), deletes its branch (git branch -D), and purges the bookkeeping entry. The response lists the discarded unmerged commits so nothing is lost silently. Use this for abandoned/stale worktrees you do NOT want merged into main. You have FULL authority over worktree management — create, merge, delete, and prune are all yours.",
      parameters: {
        type: "object",
        properties: {
          branchName: { type: "string", description: "The worktree's branch name (from list_worktrees)." },
          worktreePath: { type: "string", description: "Alternative: the worktree's absolute path." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "prune_worktrees",
      description: "Reconcile worktree bookkeeping with reality: purge every bookkeeping entry whose directory AND branch no longer exist (stale orphaned entries — e.g. worktrees whose folders were already removed), and report real git worktrees on disk that are NOT in bookkeeping. Call this whenever list_worktrees shows entries whose directories are gone, or after a batch, to keep the worktree list clean. You have FULL authority over worktree management.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Optional. Defaults to the active project (stale entries from ANY project are still purged)." },
        },
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
  "ctrl+c": "\x03", "ctrl+d": "\x04", "ctrl+u": "\x15", "ctrl+l": "\x0c",
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

// Strip the live CLI spinner glyphs and one-line status frames ("✻ Baking…",
// "still thinking", "Cooking…", "Wrangling…") that bleed into approval-prompt
// text. stripAnsi() above only removes ANSI escape codes — but TUIs redraw
// their spinner as PLAIN unicode every animation frame, so those glyphs
// survive stripAnsi and show up garbled in the askChoice overlay's question
// text (spinner dingbats, "Baking…", repeated "still thinking" lines mixed
// into the command). We drop the decoration glyphs and discard any line that
// is *only* a status frame, keeping the real command line intact.
function cleanApprovalText(text) {
  if (typeof text !== "string") return text;
  // Unicode ranges TUIs paint as plain (non-ANSI) spinner / box / braille
  // glyphs every frame: Box Drawing, Block Elements, Braille Patterns,
  // Dingbats (✢ ✳ ✶ ✻ ✽ ✲ ✱ ✹ ✸ ✺ ✼ ✾ ✿ …), Arrows (↻ ↺), and Misc Symbols
  // & Arrows. These never belong in a real command, so removing the whole
  // range is safe — a real command line is ASCII + a few punctuation marks.
  const GLYPH_RE = /[\u2500-\u257F\u2580-\u259F\u2800-\u28FF\u2700-\u27BF\u2190-\u21FF\u2B00-\u2BFF]/g;
  // A line that — after the glyphs are gone — is just a CLI status phrase,
  // optionally ending in an ellipsis or trailing dots. Covers Claude Code's
  // cooking verbs ("Baking…", "Tending…", "Wrangling…"), "still thinking",
  // and the common "<verb>…" shape other agents use.
  const STATUS_LINE_RE = /^(still thinking|baking|cooking|wrangling|tending|simmering|pondering|musing|reflecting|remembering|dreaming|waking|brewing|stewing|marinating|fermenting|kneading|resting|sifting|grinding|churning|toiling|hammering|carving|sculpting|painting|drawing|sketching|drafting|editing|rewriting|reading|writing|analyzing|researching|investigating|exploring|searching|scanning|parsing|compiling|building|running|executing|loading|downloading|uploading|installing|configuring|starting|stopping|initializing|thinking|working|waiting)\s*[.….\u2026]{0,6}\s*$/i;
  // A bare status frame the explicit list missed: a short, letters-and-spaces-
  // only phrase ending in an ellipsis. Real shell commands don't end in "…",
  // so this catches unknown verbs ("Whipping…", "Juicing…") without touching a
  // real command (which always carries flags/paths/quotes/symbols).
  const BARE_ELLIPSIS_RE = /^[a-z][a-z\s]{0,24}\s*[.….\u2026]{1,6}\s*$/i;
  const lines = text.split("\n");
  const kept = [];
  for (const raw of lines) {
    // Remove the decoration glyphs first, then assess what remains.
    let stripped = raw.replace(GLYPH_RE, "").replace(/\s{2,}/g, " ").trim();
    if (!stripped) continue;                       // line was glyphs / whitespace only
    if (STATUS_LINE_RE.test(stripped)) continue;   // "Baking…", "still thinking"
    if (BARE_ELLIPSIS_RE.test(stripped)) continue; // "Pondering…", "Whipping…"
    kept.push(stripped);
  }
  return kept.join("\n").trim();
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

  // R2: hoist `rec` and `unsub` ABOVE `finish()` so the closure never reads
  // them before their declaration line. Previously `finish` (an arrow closure)
  // referenced `rec` and `unsub` even though both were declared with const/let
  // AFTER `finish` in the source. That is safe only because `finish` is never
  // called synchronously before those lines run (it fires from the onData
  // callback or the 12s timeout, both async) — but it's a TDZ footgun for any
  // future refactor that calls finish() earlier. Hoisting removes it.
  //
  // `rec` is a read from the already-populated sessions map (registerSession ran
  // before autoDriveStartup), and setting trustState="pending" up front actually
  // reinforces B1's idle-detector guard from the very first chunk. `unsub` is
  // assigned later inside the onData try-block; only its DECLARATION moves here.
  // Update the session registry so read_session can mask the trust dialog from
  // the orchestrator and avoid tempting it to send bypass keystrokes.
  const rec = sessions.get(session.id);
  if (rec) {
    rec.trustState = "pending";
    rec.trustMode = trustMode;
  }
  let unsub = null;

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

  const handleTrust = async () => {
    trustBusy = true;
    if (rec) rec.trustState = "asking";
    try { await loadTrustMode(); } catch (_) {}
    // R3: capture the just-loaded mode into a LOCAL so the ask/always branch
    // below can't observe a concurrent change of the shared `trustMode`
    // variable between this await and the check (e.g. the user toggling it in
    // Settings while a second trust dialog is in flight). Behavior unchanged.
    const mode = trustMode;
    if (mode === "always") {
      if (rec) rec.trustMode = "always";
      await confirmTrust();
      if (rec) rec.trustState = "confirmed";
      trustBusy = false;
      return;
    }
    if (rec) rec.trustMode = "ask";
    // mode === "ask" — ask in chat, wait for the answer.
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

  // R2: `unsub` is declared above `finish()` now (hoisted). Assign it here when
  // the onData subscription is actually set up. Kept as an explicit reset for
  // readability — it is already null at this point.
  unsub = null;
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
        // B2: branchName comes from the orchestrator model (untrusted input). Bare
        // double-quotes in the git command below don't protect against $, backticks,
        // or " — validate it against a git-ref-safe charset before use so a quirky
        // value can't inject shell tokens. The default ("worktree-<timestamp>") is
        // always safe.
        if (!/^[A-Za-z0-9._\/-]+$/.test(branch)) {
          return "Error: invalid branchName \"" + branch + "\". Use only letters, digits, dot, underscore, slash, or hyphen.";
        }
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
          loginShell("git worktree add " + JSON.stringify(wtPath) + " -b " + JSON.stringify(branch) + " " + JSON.stringify(mainBranch)),
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

        // ---- Part 2: ask whether to delete the finished terminal session ----
        // The merge is done, so the worktree is gone. If a terminal session was
        // running in that worktree AND its agent is FINISHED (IDLE = turn complete
        // at its prompt, or EXITED), the session is now just a closed loop sitting
        // in the Sessions column. Ask the user in chat (via the askChoice pill
        // picker — the same pattern askTrustInChat uses) whether to delete that
        // terminal. This blocks until the user answers.
        //
        // "Already merged" detection: we are here precisely because the merge
        // succeeded, so the branch/worktree is merged. We match the session by its
        // worktreeBranch (derived from the cwd at registration) equaling the just-
        // merged branch. If the app doesn't track a merge state per session, this
        // branch-match is the proxy (noted here intentionally).
        const matchedSession = [...sessions.values()].find(
          (s) => s.worktreeBranch === branch || (wtPath && String(s.cwd || "") === wtPath)
        );
        let deletedNote = "";
        if (matchedSession) {
          const act = sessionActivity(matchedSession);
          const finished = (act === "IDLE" || act === "EXITED");
          // Mark the session's worktree as merged regardless, so its persisted
          // snapshot (if it survives a reopen) shows the merged state.
          matchedSession.merged = true;
          persistSessions().catch((e) => console.warn("persistSessions merge", e));
          if (finished) {
            try {
              const v = await window.termCoder.askChoice({
                prompt: "The agent **" + (matchedSession.label || matchedSession.id) +
                  "** finished its work and its worktree branch **" + branch +
                  "** has been merged into **" + parentBranch + "**.\n\n" +
                  "Delete this terminal session now?",
                options: [
                  { label: "Yes, delete the terminal", value: "yes" },
                  { label: "No, keep it", value: "no" },
                ],
                style: "pill",
              });
              if (v === "yes") {
                await closeSession(matchedSession.id);
                deletedNote = "\nThe finished terminal session was deleted at your request.";
              } else {
                deletedNote = "\nThe terminal session was kept (left as finished in the Sessions column).";
              }
            } catch (e) {
              console.warn("merge delete prompt failed", e);
              deletedNote = "\n(Delete prompt failed: the terminal session was kept.)";
            }
          } else {
            deletedNote = "\nThe terminal session is still " + act + " — it was left running. Merge its worktree again only if you gave it new work.";
          }
        }

        return "Merged branch " + branch + " into " + parentBranch + " successfully. Worktree cleaned up." + deletedNote + "\n" + mergeOut;
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
        // Flag stale entries (directory gone) so the orchestrator can prune them.
        const lines = [];
        for (const [branch, m] of [...worktreeMeta.entries()]) {
          let stale = false;
          if (m.wtPath) {
            const t = await window.chatoss.terminal.exec(
              loginShell("test -d " + JSON.stringify(m.wtPath) + " && echo yes || echo no"),
              { cwd: (m.projectPath || undefined) }
            );
            stale = !(t && (t.output || "").trim() === "yes");
          }
          lines.push("  branch " + branch + " | parent " + (m.parentBranch || "main") + " | path " + (m.wtPath || "(unknown)") +
            (stale ? "  [STALE: directory gone — purge with prune_worktrees or delete_worktree]" : ""));
        }
        return "OPEN WORKTREES (" + worktreeMeta.size + "):\n" + lines.join("\n") +
          "\n\nMerge each one with merge_worktree({ branchName: <branch> }) once its agent has finished. " +
          "Delete abandoned ones with delete_worktree({ branchName }) and purge stale bookkeeping with prune_worktrees({}).";
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
        // FIX: "Remember as defaults" — when the user pinned a default launch
        // (Settings "Default agent" picker or the spawn-modal "Remember as
        // defaults" checkbox), the spawn modal must NOT appear again. Skip it
        // and spawn with the saved default directly. Only direct-CLI defaults
        // ("raw:claude" etc.) map to a concrete target without further input;
        // anything else falls through to the modal as before.
        const defId = cliDefaultToTargetId(settings.cliDefault);
        const defTarget = defId ? findLaunchTarget(defId) : null;
        if (defTarget) {
          const session = await spawnChosen({ cli: "", cwd, prompt: args.taskPrompt || "", target: defId });
          if (!session) return "Terminal permission denied. Approve it in the system prompt and try again.";
          if (session.error) return session.error;
          const rec = sessions.get(session.id);
          if (rec) rec.fromOrchestrator = true;
          return "session " + session.id + " started: " + session.label + " in " + session.cwd +
            " (using your saved default launch — no dialog shown). The app types and submits your taskPrompt automatically once the agent is ready. " +
            "Monitor it with wait_for_session (returns when its turn finishes) — do NOT wait for the process to exit; coding CLIs are REPLs and never do.";
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
        //
        // B4: the universal monitor + autoDriveStartup already maintain
        // rec.trustState ("pending"/"asking" while a trust dialog is up), so gate
        // on that directly and AVOID re-reading the ENTIRE scrollback via
        // getOutput() on every call (O(scrollback) per tool call, duplicating the
        // monitor's work). Only when trustState is unexpectedly unset (null/
        // undefined — e.g. a session registered before the state was wired) do we
        // fall back to scanning the output as a safety net.
        const trustPending = s.trustState === "pending" || s.trustState === "asking";
        let trustFromOutput = false;
        if (!trustPending && (s.trustState === null || s.trustState === undefined) &&
            s.session && typeof s.session.getOutput === "function" && s.trustMode !== "always") {
          try {
            const outputCheck = stripAnsi(await s.session.getOutput() || "");
            trustFromOutput = /trust\s*the\s*(files|contents|folder|directory)|trust\s*this\s*folder|do\s*you\s*trust|press\s*enter\s*to\s*continue/i.test(outputCheck);
          } catch (_) {}
        }
        if ((trustPending || trustFromOutput) && s.trustMode !== "always") {
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
          } else if (s.degenerate) {
            statusPart = "DEGENERATE OUTPUT — interrupted; close_session and respawn";
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
      case "create_card": {
        const bid = resolveBoardId(args);
        if (!bid) return "Error: no board attached to this conversation.";
        if (!args.title) return "Error: title is required.";
        try {
          const payload = { title: args.title };
          if (args.description !== undefined && args.description !== null) payload.description = args.description;
          if (args.columnId !== undefined && args.columnId !== null) payload.columnId = args.columnId;
          const id = await window.chatoss.boards.createCard(bid, payload);
          return "created card " + id;
        } catch (e) {
          return "Error: " + (e && e.message ? e.message : String(e));
        }
      }
      case "create_column": {
        const bid = resolveBoardId(args);
        if (!bid) return "Error: no board attached to this conversation.";
        if (!args.name) return "Error: name is required.";
        try {
          const id = await window.chatoss.boards.createColumn(bid, { name: args.name });
          return "created column " + id;
        } catch (e) {
          return "Error: " + (e && e.message ? e.message : String(e));
        }
      }
      case "get_current_git_branch": {
        const p = resolveProject(args);
        if (!p) return "Error: no project selected. Ask the user to add a project folder first.";
        const r = await window.chatoss.terminal.exec(loginShell("git branch --show-current"), { cwd: p.folderPath });
        if (r === null) return "Error: terminal permission denied";
        return (r.output || "").trim() || "(no branch)";
      }
      // ---------- Direct file tools (the orchestrator's own job) ----------
      // These ride the files API (fileAccess), so they work on the project
      // folder and every worktree inside it — the same roots the user picked.
      case "read_file": {
        const p = resolveProject(args);
        if (!p) return "Error: no project selected. Ask the user to add a project folder first.";
        const path = String(args.path || "").trim();
        if (!path) return "Error: pass the file path to read.";
        if (!path.startsWith(p.folderPath.replace(/\/+$/, "") + "/")) {
          return "Error: path must be inside the active project folder (" + p.folderPath + ").";
        }
        try {
          const text = await window.chatoss.files.readFile(path);
          if (typeof text !== "string") return "Error: not a text file (binary).";
          const max = args.maxChars || 20000;
          if (text.length > max) {
            return text.slice(0, max) + "\n…[truncated at " + max + " chars — pass a larger maxChars to read more]";
          }
          return text;
        } catch (e) {
          return "Error reading " + path + ": " + (e && e.message ? e.message : String(e));
        }
      }
      case "write_file": {
        const p = resolveProject(args);
        if (!p) return "Error: no project selected. Ask the user to add a project folder first.";
        const path = String(args.path || "").trim();
        if (!path) return "Error: pass the file path to write.";
        if (!path.startsWith(p.folderPath.replace(/\/+$/, "") + "/")) {
          return "Error: path must be inside the active project folder (" + p.folderPath + ").";
        }
        const contents = String(args.contents == null ? "" : args.contents);
        try {
          await window.chatoss.files.writeFile(path, contents);
          return "Wrote " + path + " (" + contents.length + " chars).";
        } catch (e) {
          return "Error writing " + path + ": " + (e && e.message ? e.message : String(e));
        }
      }
      case "edit_file": {
        const p = resolveProject(args);
        if (!p) return "Error: no project selected. Ask the user to add a project folder first.";
        const path = String(args.path || "").trim();
        if (!path) return "Error: pass the file path to edit.";
        if (!path.startsWith(p.folderPath.replace(/\/+$/, "") + "/")) {
          return "Error: path must be inside the active project folder (" + p.folderPath + ").";
        }
        const oldStr = String(args.old_string == null ? "" : args.old_string);
        const newStr = String(args.new_string == null ? "" : args.new_string);
        if (!oldStr) return "Error: old_string is required.";
        try {
          const text = await window.chatoss.files.readFile(path);
          if (typeof text !== "string") return "Error: not a text file (binary).";
          const idx = text.indexOf(oldStr);
          if (idx === -1) return "Error: old_string not found in " + path + ". Read the file first and copy the exact text.";
          if (text.indexOf(oldStr, idx + 1) !== -1) {
            return "Error: old_string appears more than once in " + path + " — make it more specific so it matches exactly once.";
          }
          const updated = text.slice(0, idx) + newStr + text.slice(idx + oldStr.length);
          await window.chatoss.files.writeFile(path, updated);
          return "Edited " + path + " (replaced " + oldStr.length + " chars with " + newStr.length + ").";
        } catch (e) {
          return "Error editing " + path + ": " + (e && e.message ? e.message : String(e));
        }
      }
      // ---------- Git + release tools (the orchestrator's own job) ----------
      case "git_status": {
        const p = resolveProject(args);
        if (!p) return "Error: no project selected. Ask the user to add a project folder first.";
        const base = p.folderPath.replace(/\/+$/, "");
        const run = async (cmd) => {
          const r = await window.chatoss.terminal.exec(loginShell(cmd), { cwd: base });
          if (r === null) return "Error: terminal permission denied (approve git to continue)";
          return (r.output || "").trim();
        };
        const branch = await run("git branch --show-current");
        const status = await run("git status --porcelain");
        const ahead = await run("git rev-list --count @{upstream}..HEAD 2>/dev/null || echo 'no upstream'");
        const behind = await run("git rev-list --count HEAD..@{upstream} 2>/dev/null || echo 'no upstream'");
        const log = await run("git log --oneline -5");
        return "Branch: " + (branch || "(none)") +
          "\nAhead of upstream: " + ahead +
          "\nBehind upstream: " + behind +
          "\nUncommitted changes:\n" + (status || "(none — working tree clean)") +
          "\nLast commits:\n" + (log || "(none)");
      }
      case "git_commit": {
        const p = resolveProject(args);
        if (!p) return "Error: no project selected. Ask the user to add a project folder first.";
        const msg = String(args.message || "").trim();
        if (!msg) return "Error: pass a commit message.";
        const r = await window.chatoss.terminal.exec(
          loginShell("git add -A && git commit -m " + JSON.stringify(msg)),
          { cwd: p.folderPath }
        );
        if (r === null) return "Error: terminal permission denied (approve git to continue)";
        if (r.exitCode !== 0) return "git commit failed (exit " + r.exitCode + "):\n" + r.output;
        return "Committed:\n" + r.output;
      }
      case "git_push": {
        const p = resolveProject(args);
        if (!p) return "Error: no project selected. Ask the user to add a project folder first.";
        let r = await window.chatoss.terminal.exec(loginShell("git push"), { cwd: p.folderPath });
        if (r === null) return "Error: terminal permission denied (approve git to continue)";
        if (r.exitCode !== 0 && /no upstream branch|--set-upstream/i.test(r.output || "")) {
          r = await window.chatoss.terminal.exec(loginShell("git push -u origin HEAD"), { cwd: p.folderPath });
          if (r === null) return "Error: terminal permission denied (approve git to continue)";
        }
        if (r.exitCode !== 0) return "git push failed (exit " + r.exitCode + "):\n" + r.output;
        return "Pushed:\n" + r.output;
      }
      case "version_bump": {
        const p = resolveProject(args);
        if (!p) return "Error: no project selected. Ask the user to add a project folder first.";
        const bump = String(args.bump || "").toLowerCase();
        if (!/^(major|minor|patch)$/.test(bump)) return "Error: bump must be 'major', 'minor' or 'patch'.";
        const base = p.folderPath.replace(/\/+$/, "");
        const appJsonPath = base + "/app.json";
        let appJson;
        try {
          appJson = JSON.parse(await window.chatoss.files.readFile(appJsonPath));
        } catch (e) {
          return "Error: could not read/parse " + appJsonPath + " — is this a ChatOSS app project? " + (e && e.message ? e.message : String(e));
        }
        const oldV = String(appJson.version || "");
        const m = oldV.match(/^(\d+)\.(\d+)\.(\d+)$/);
        if (!m) return "Error: app.json version \"" + oldV + "\" is not semver x.y.z — bump it manually with edit_file.";
        let [ma, mi, pa] = [Number(m[1]), Number(m[2]), Number(m[3])];
        if (bump === "major") { ma += 1; mi = 0; pa = 0; }
        else if (bump === "minor") { mi += 1; pa = 0; }
        else { pa += 1; }
        const newV = ma + "." + mi + "." + pa;
        appJson.version = newV;
        await window.chatoss.files.writeFile(appJsonPath, JSON.stringify(appJson, null, 2) + "\n");
        // Keep any matching APP_VERSION constant in root-level JS files in sync.
        const updatedFiles = [];
        try {
          const entries = await window.chatoss.files.listDir(base);
          for (const ent of (entries || [])) {
            if (!ent || ent.kind === "dir") continue;
            const name = ent.name || "";
            if (!/\.(js|mjs|cjs)$/.test(name)) continue;
            const fpath = base + "/" + name;
            try {
              const text = await window.chatoss.files.readFile(fpath);
              if (typeof text !== "string") continue;
              let changed = false;
              const updated = text.replace(/(APP_VERSION\s*=\s*["'])([^"']+)(["'])/g, (all, pre, v, post) => {
                if (v === oldV) { changed = true; return pre + newV + post; }
                return all;
              });
              if (changed) {
                await window.chatoss.files.writeFile(fpath, updated);
                updatedFiles.push(name);
              }
            } catch (e) { /* skip unreadable files */ }
          }
        } catch (e) { /* listDir unavailable — app.json alone is still bumped */ }
        return "Version bumped " + oldV + " → " + newV + " in app.json" +
          (updatedFiles.length ? " and APP_VERSION in: " + updatedFiles.join(", ") : "") +
          ".\nNext: git_commit, then git_push, then create_release.";
      }
      case "create_release": {
        const p = resolveProject(args);
        if (!p) return "Error: no project selected. Ask the user to add a project folder first.";
        const base = p.folderPath.replace(/\/+$/, "");
        const appJsonPath = base + "/app.json";
        let appJson;
        try {
          appJson = JSON.parse(await window.chatoss.files.readFile(appJsonPath));
        } catch (e) {
          return "Error: could not read/parse " + appJsonPath + " — is this a ChatOSS app project? " + (e && e.message ? e.message : String(e));
        }
        const version = String(appJson.version || "");
        if (!/^\d+\.\d+\.\d+/.test(version)) {
          return "Error: app.json version \"" + version + "\" is not semver — bump it with version_bump first.";
        }
        const tag = "v" + version;
        const appName = appJson.name || p.name || "app";
        const notes = String(args.notes || "").trim() || appName + " " + tag;
        const run = async (cmd) => {
          const r = await window.chatoss.terminal.exec(loginShell(cmd), { cwd: base });
          if (r === null) return { denied: true };
          return { denied: false, exitCode: r.exitCode, output: r.output || "" };
        };
        // 1) Create the release on GitHub, targeting main.
        const rel = await run("gh release create " + JSON.stringify(tag) + " --target main --title " +
          JSON.stringify(appName + " " + tag) + " --notes " + JSON.stringify(notes));
        if (rel.denied) return "Error: terminal permission denied (approve gh to continue)";
        if (rel.exitCode !== 0) return "gh release create failed (exit " + rel.exitCode + "):\n" + rel.output;
        // 2) Build the .aip: zip ONLY the app's runtime files. Exclude tests/,
        //    docs, dot-folders (.git, .chatoss), *.md, and old .aip/.zip artifacts.
        const EXCLUDE = new Set(["tests", "docs", "node_modules", ".git", ".chatoss"]);
        let files = [];
        try {
          const entries = await window.chatoss.files.listDir(base);
          for (const ent of (entries || [])) {
            const name = ent.name || "";
            if (!name || name.startsWith(".")) continue;
            if (EXCLUDE.has(name)) continue;
            if (/\.(md|aip|zip)$/i.test(name)) continue;
            files.push(name);
          }
        } catch (e) {
          files = ["app.json", "index.html", "app.js", "style.css", "icon.svg", "libs"];
        }
        if (!files.length) return "Error: no app files found to package.";
        const aipName = String(p.name || "app").toLowerCase().replace(/[^a-z0-9._-]+/g, "-") + "-" + tag + ".aip";
        const zipName = aipName.replace(/\.aip$/, ".zip");
        const zipR = await run("zip -r -X " + JSON.stringify(aipName) + " " + files.map(JSON.stringify).join(" "));
        if (zipR.denied) return "Error: terminal permission denied (approve zip to continue)";
        if (zipR.exitCode !== 0) return "zip build failed (exit " + zipR.exitCode + "):\n" + zipR.output;
        const cpR = await run("cp " + JSON.stringify(aipName) + " " + JSON.stringify(zipName));
        if (cpR.denied) return "Error: terminal permission denied (approve cp to continue)";
        if (cpR.exitCode !== 0) return "cp failed (exit " + cpR.exitCode + "):\n" + cpR.output;
        // 3) Upload both installable assets.
        const upR = await run("gh release upload " + JSON.stringify(tag) + " " + JSON.stringify(aipName) + " " + JSON.stringify(zipName));
        if (upR.denied) return "Error: terminal permission denied (approve gh to continue)";
        if (upR.exitCode !== 0) return "gh release upload failed (exit " + upR.exitCode + "):\n" + upR.output;
        return "Release " + tag + " created with installable assets:\n" + aipName + "\n" + zipName + "\n\n" + rel.output + "\n" + upR.output;
      }
      case "health_check": {
        return await runHealthCheck();
      }
      case "worktree_git_status": {
        const branch = String(args.branchName || "").trim();
        const meta = branch ? worktreeMeta.get(branch) : null;
        const wtPath = (meta && meta.wtPath) || String(args.worktreePath || "").trim();
        if (!wtPath) return "Error: pass branchName (from list_worktrees) or worktreePath.";
        const run = async (cmd) => {
          const r = await window.chatoss.terminal.exec(loginShell(cmd), { cwd: wtPath });
          if (r === null) return "Error: terminal permission denied (approve git to continue)";
          return (r.output || "").trim();
        };
        const status = await run("git status --porcelain");
        const diffStat = await run("git diff --stat");
        const log = await run("git log --oneline -3");
        return "WORKTREE " + (branch || wtPath) + " (" + wtPath + ")\n" +
          "Uncommitted changes:\n" + (status || "(none — clean)") +
          "\nDiff stat (uncommitted):\n" + (diffStat || "(none)") +
          "\nLast commits on branch:\n" + (log || "(none)");
      }
      case "spawn_batch": {
        const p = resolveProject(args);
        if (!p) return "Error: no project selected. Ask the user to add a project folder first.";
        const tasks = Array.isArray(args.tasks) ? args.tasks : [];
        if (!tasks.length) return "Error: pass tasks: [{ name, prompt }, ...].";
        if (tasks.length > 8) return "Error: at most 8 tasks per batch.";
        const base = p.folderPath.replace(/\/+$/, "");
        // ONE launch choice for the whole batch: the saved default if pinned,
        // otherwise a single spawn dialog (batchMode — no session spawned yet).
        const defId = cliDefaultToTargetId(settings.cliDefault);
        const defTarget = defId ? findLaunchTarget(defId) : null;
        let cli = "";
        let target = defId || null;
        if (!defTarget) {
          const choice = await openSpawnModal({
            source: "tool",
            cwd: base,
            prompt: "BATCH: " + tasks.length + " parallel subtasks — pick the launch to use for ALL of them.",
            batchMode: true,
          });
          if (!choice) return "Cancelled by user — do not start the batch; ask the user how to proceed or stop.";
          cli = choice.cli || "";
          target = choice.target || null;
        }
        const results = [];
        for (const t of tasks) {
          const name = String(t.name || "").trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
          const prompt = String(t.prompt || "").trim();
          if (!name || !prompt) { results.push("SKIPPED (missing name/prompt): " + JSON.stringify(t)); continue; }
          const branch = name;
          const wtPath = base + "/.chatoss/worktrees/" + branch;
          const branchR = await window.chatoss.terminal.exec(loginShell("git branch --show-current"), { cwd: base });
          const mainBranch = (branchR && branchR.output || "").trim() || "main";
          const r = await window.chatoss.terminal.exec(
            loginShell("git worktree add " + JSON.stringify(wtPath) + " -b " + JSON.stringify(branch) + " " + JSON.stringify(mainBranch)),
            { cwd: base }
          );
          if (r === null) { results.push("FAILED " + name + ": terminal permission denied"); continue; }
          if (r.exitCode !== 0) { results.push("FAILED " + name + ": " + (r.output || "").trim().slice(0, 200)); continue; }
          worktreeMeta.set(branch, { wtPath, parentBranch: mainBranch, projectPath: base });
          saveWorktrees();
          const session = await spawnChosen({ cli, cwd: wtPath, prompt, target });
          if (!session) { results.push("FAILED " + name + ": terminal permission denied"); continue; }
          if (session.error) { results.push("FAILED " + name + ": " + session.error); continue; }
          const rec = sessions.get(session.id);
          if (rec) rec.fromOrchestrator = true;
          results.push("STARTED " + name + " → session " + session.id + " (branch " + branch + ")");
        }
        return "BATCH SPAWN (" + results.length + " tasks):\n" + results.join("\n") +
          "\n\nMonitor each with wait_for_session({ sessionId }), then merge each worktree with merge_worktree({ branchName }).";
      }
      case "delete_worktree": {
        const p = resolveProject(args);
        if (!p) return "Error: no project selected. Ask the user to add a project folder first.";
        const base = p.folderPath.replace(/\/+$/, "");
        const branch = String(args.branchName || "").trim();
        const meta = branch ? worktreeMeta.get(branch) : null;
        const wtPath = (meta && meta.wtPath) || String(args.worktreePath || "").trim();
        if (!wtPath && !branch) return "Error: pass branchName or worktreePath of the worktree to delete.";
        const parentBranch = (meta && meta.parentBranch) || "main";
        // Commit any uncommitted work in the worktree first so it is at least
        // captured in the branch's history (and reported below) before the
        // branch is deleted — nothing is lost silently.
        if (wtPath) {
          const commitR = await window.chatoss.terminal.exec(
            loginShell("git add -A && git commit -m " + JSON.stringify("WIP: commit uncommitted work before deleting " + (branch || wtPath)) + " --allow-empty"),
            { cwd: wtPath }
          );
          if (commitR === null) return "Error: terminal permission denied (approve git to continue)";
        }
        // Report the unmerged commits that will be discarded.
        let discardNote = "";
        if (branch) {
          const logR = await window.chatoss.terminal.exec(
            loginShell("git log --oneline " + JSON.stringify(parentBranch) + ".." + JSON.stringify(branch)),
            { cwd: base }
          );
          if (logR && (logR.output || "").trim()) {
            discardNote = "\nDISCARDED unmerged commits on " + branch + ":\n" + logR.output.trim();
          }
        }
        if (wtPath) {
          const rmR = await window.chatoss.terminal.exec(loginShell("git worktree remove " + JSON.stringify(wtPath) + " --force"), { cwd: base });
          if (rmR === null) return "Error: terminal permission denied (approve git to continue)";
          if (rmR.exitCode !== 0) return "git worktree remove failed (exit " + rmR.exitCode + "):\n" + rmR.output;
        }
        if (branch) {
          const brR = await window.chatoss.terminal.exec(loginShell("git branch -D " + JSON.stringify(branch)), { cwd: base });
          if (brR === null) return "Error: terminal permission denied (approve git to continue)";
          if (brR.exitCode !== 0) return "git branch -D failed (exit " + brR.exitCode + "):\n" + brR.output;
        }
        if (branch) { worktreeMeta.delete(branch); saveWorktrees(); }
        return "Deleted worktree " + (branch || wtPath) + " (directory removed, branch deleted, bookkeeping purged)." + discardNote;
      }
      case "prune_worktrees": {
        const entries = [...worktreeMeta.entries()];
        if (!entries.length) return "No worktree bookkeeping entries to prune.";
        const purged = [];
        const kept = [];
        for (const [branch, m] of entries) {
          const proj = (m && m.projectPath) || "";
          const wtPath = (m && m.wtPath) || "";
          let dirExists = false, branchExists = false;
          if (wtPath) {
            const t = await window.chatoss.terminal.exec(
              loginShell("test -d " + JSON.stringify(wtPath) + " && echo yes || echo no"),
              { cwd: proj || undefined }
            );
            dirExists = !!(t && (t.output || "").trim() === "yes");
          }
          if (proj && branch) {
            const b = await window.chatoss.terminal.exec(
              loginShell("git branch --list " + JSON.stringify(branch)),
              { cwd: proj }
            );
            branchExists = !!(b && (b.output || "").trim());
          }
          if (!dirExists && !branchExists) {
            worktreeMeta.delete(branch);
            purged.push(branch + " (dir gone, branch gone)");
          } else {
            kept.push(branch + (dirExists ? "" : " [dir gone]") + (branchExists ? "" : " [branch gone]"));
          }
        }
        if (purged.length) saveWorktrees();
        // Report real git worktrees on disk that are NOT in bookkeeping.
        let orphans = "";
        const p = resolveProject(args);
        if (p) {
          const base = p.folderPath.replace(/\/+$/, "");
          const wl = await window.chatoss.terminal.exec(loginShell("git worktree list --porcelain"), { cwd: base });
          if (wl && wl.output) {
            const real = new Set();
            for (const line of wl.output.split("\n")) {
              if (line.startsWith("worktree ")) real.add(line.slice(9).trim());
            }
            const known = new Set([...worktreeMeta.values()].map((x) => x && x.wtPath).filter(Boolean));
            const orphanPaths = [...real].filter((wp) => wp !== base && !known.has(wp));
            if (orphanPaths.length) {
              orphans = "\nReal git worktrees NOT in bookkeeping (delete with delete_worktree({ worktreePath }) if stale):\n  " + orphanPaths.join("\n  ");
            }
          }
        }
        return "PRUNED " + purged.length + " stale bookkeeping entries:\n" + (purged.map((x) => "  - " + x).join("\n") || "  (none)") +
          "\nRemaining entries:\n" + (kept.map((x) => "  - " + x).join("\n") || "  (none)") + orphans;
      }
      default:
        return "Error: unknown tool " + name;
    }
  } catch (e) {
    return "Error: " + (e && e.message ? e.message : String(e));
  }
}

// ---------- Spawn modal (the heart: ask the user every time) ----------
// The dropdown here selects the OLLAMA LAUNCH TOOL (the agent ollama starts).
// The actual launch TARGET — including the option to run claude/codex DIRECTLY
// without ollama — is chosen in the model picker (resolveSessionModel) that
// appears after Start. So this dropdown matters only when the user picks an
// ollama model from that picker; picking "claude"/"codex" there launches the
// real binary directly regardless of this dropdown. The raw:<bin> entries
// below are a manual fallback for direct launching from the dropdown itself.
function buildCliOptions() {
  const opts = [];
  const push = (value, label, detected) => {
    opts.push({ value, label: detected ? label : label + " (not detected)" });
  };
  // D2: the ollama-launch entries come from OLLAMA_LAUNCH_TOOLS (the single
  // source of truth) so the constant and the dropdown can never drift apart.
  // `detected` here reflects whether ollama itself is available (these all
  // launch THROUGH ollama), matching the previous per-line behavior.
  for (const tool of OLLAMA_LAUNCH_TOOLS) {
    push(tool.id, tool.label, detection.ollama);
  }
  // Direct binaries (launch the real CLI without ollama), only if installed.
  // These are a manual fallback; the model picker also offers claude/codex
  // directly as launch targets. Order matches the default-agents spec:
  // opencode, claude, codex.
  if (detection.opencode) push("raw:opencode", "opencode  (direct binary)", true);
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
  spawnModalOpts = opts;
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
  spawnModalOpts = null;
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
  let target = null;
  let noModels = false;
  try {
    // resolveSessionModel returns a LAUNCH TARGET id — a direct CLI name
    // ("claude"/"codex") or an ollama model name. spawnChosen routes on it.
    target = await window.termCoder.resolveSessionModel(prompt);
  } catch (e) {
    console.warn("resolveSessionModel", e);
    // B3: when there are NO detected models/targets at all (Manual/Always/
    // Complexity), resolveSessionModel throws an error with code "NO_MODELS"
    // instead of returning null (which would silently cancel). Show an
    // actionable message and keep the spawn modal open so the user can
    // cancel/retry, rather than auto-dismissing it with no explanation.
    if (e && e.code === "NO_MODELS") {
      noModels = true;
      target = null;
    }
  }
  if (!target) {
    if (noModels) {
      // Re-show the modal (it was hidden to make room for the pill picker) with
      // an actionable status message. Do NOT dismiss — let the user cancel or
      // go run Re-scan in Settings.
      el.spawnModal.classList.remove("hidden");
      el.spawnStatus.textContent = "No models detected — run Re-scan in Settings, or switch Model Selection Mode.";
      el.spawnStart.disabled = false;
    } else {
      // Dismissed / cancelled by the user — close silently.
      closeSpawnModal(null);
    }
    return;
  }

  if (remember) {
    // Remember the CHOSEN LAUNCH TARGET, not merely the spawn-modal dropdown
    // tool. The launch target id (from resolveSessionModel) is what the next
    // session applies automatically — for a direct-CLI launch that's "claude" /
    // "codex" / "opencode", persisted as the set-cli-style "raw:<id>" value so
    // it round-trips through the Settings "Default agent" picker (the two
    // controls share the cliDefault value space and must agree). Ollama launches
    // (target is an ollama model) have no self-contained set-cli value, so fall
    // back to the dropdown's ollama-tool id — consistent with the picker, and
    // auto-applied only when it maps to a concrete target.
    const tgt = findLaunchTarget(target);
    settings.cliDefault = (tgt && tgt.kind === "direct") ? ("raw:" + tgt.id) : cli;
    settings.cwdDefault = cwd;
    saveSettings();
  }

  // Batch mode (spawn_batch): the modal collected ONE launch choice for a whole
  // batch of parallel subtasks — resolve with the choice (including the target)
  // WITHOUT spawning a session here; the batch tool spawns each task itself.
  if (spawnModalOpts && spawnModalOpts.batchMode) {
    closeSpawnModal({ cli, cwd, prompt, target });
    return;
  }

  el.spawnStart.disabled = true;
  el.spawnStatus.textContent = "Starting…";
  el.spawnModal.classList.remove("hidden");
  try {
    const session = await spawnChosen({ cli, cwd, prompt, target });
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
  // choice.target is the launch-target id from resolveSessionModel — either a
  // direct CLI name ("claude"/"codex") or an ollama model name. choice.cli is
  // the ollama launch tool from the spawn-modal dropdown (used only for the
  // ollama path) or a "raw:<bin>" manual override.
  //
  // ALWAYS spawn through a login shell so `ollama` (and any user-installed CLI)
  // resolves on the full PATH — the sandboxed default shell has a minimal PATH,
  // which is exactly what caused "Unable to spawn ollama … not found in PATH".
  let inner, label;
  // effortTargetId: which launch-target id to look the effort up under. The raw:
  // dropdown path names a binary directly, so its id IS the bin name.
  let effortTargetId = null;
  let codexFlagApplied = false; // true once --config model_reasoning_effort is on the command line
  // Manual raw-binary override from the dropdown (kept for backward compat and
  // for CLIs not yet covered by the launch-target picker).
  if (choice.cli && choice.cli.startsWith("raw:")) {
    const bin = choice.cli.slice(4);
    effortTargetId = bin;
    inner = "exec " + bin;
    label = bin + " · " + basename(choice.cwd);
  } else {
    // Route by the chosen launch target.
    const target = findLaunchTarget(choice.target);
    if (target) effortTargetId = target.id;
    if (target && target.kind === "direct") {
      // ── Direct CLI launch ── run the REAL binary via the terminal capability,
      // NOT through ollama. Uses the resolved absolute path (claudePath /
      // codexPath / opencodePath) so it survives the sandbox's minimal PATH.
      inner = "exec " + JSON.stringify(target.bin);
      label = target.id + " · " + basename(choice.cwd);
    } else {
      // ── Ollama launch path (existing) ── the dropdown's tool selects the
      // agent; the target id (an ollama model name) is passed as --model.
      const bin = ollamaPath || "ollama";
      const tool = choice.cli || "claude";
      inner = "exec " + JSON.stringify(bin) + " launch " + tool;
      // Apply the resolved model as a CLI flag so the launched agent uses it
      // instead of opening its own model picker. choice.model is kept as a
      // back-compat fallback for any caller still passing the old field.
      const model = target ? target.model : choice.model;
      if (model) {
        inner += " --model " + JSON.stringify(model);
      }
      label = tool + " · " + basename(choice.cwd);
    }
  }

  // ── Per-target effort level (Settings → Model Selection Mode) ──
  // Direct Codex has a REAL reasoning-effort flag that accepts low/medium/high
  // (verified OpenAI codex CLI values). Apply it on the command line ONLY when
  // the chosen effort is one of those safe values — if a future model exposes a
  // non-codex level like "max" for a codex target, we fall back to a guidance
  // line instead of passing an invalid flag. Every other agent (claude /
  // opencode / anything under `ollama launch`) has no effort flag, so the level
  // is expressed as a guidance line appended to the task brief — universal and
  // harmless on CLIs that don't parse it. Effort values are validated against
  // the target's option list before storage, so interpolating them is safe.
  const effort = effortForTarget(effortTargetId);
  let effectivePrompt = choice.prompt;
  if (effort) {
    const isCodex = /^exec "?[^"]*codex/.test(inner);
    if (isCodex && CODEX_EFFORT_FLAG_VALUES.has(effort)) {
      inner += " --config 'model_reasoning_effort=\"" + effort + "\"'";
      codexFlagApplied = true;
    } else if (EFFORT_BRIEF[effort] && effectivePrompt) {
      effectivePrompt = effectivePrompt + "\n\n[" + EFFORT_BRIEF[effort] + "]";
    } else if (effectivePrompt) {
      // Unknown/custom level (e.g. "max" on a non-codex target with no EFFORT_BRIEF entry):
      // append a generic instruction so the level is not silently dropped.
      effectivePrompt = effectivePrompt + "\n\n[Reasoning effort level: " + effort + "]";
    }
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
  if (effectivePrompt) {
    // Don't write the prompt immediately — the CLI (Claude Code / Codex) shows a
    // "trust this folder?" dialog and sometimes a model picker at launch, and
    // typing the prompt too early dumps it into the wrong screen. autoDriveStartup
    // watches the live output, handles the trust dialog (per the Settings trust
    // policy: ask in chat, or always trust), and sends the prompt once the agent's
    // real input box is ready (with a 12s safety timeout).
    try { autoDriveStartup(session, effectivePrompt, label, choice.cwd); } catch (e) { /* non-fatal */ }
  }
  return { id: session.id, label, cwd: choice.cwd };
}

// ---------- Settings panel ----------
function renderDetectedList() {
  if (!el.detectedList) return;
  // Read the LIVE detection object — the same source the launch-target pickers
  // (and the chat pill picker) consume via availableOllamaModels() — NOT the
  // persisted settings.detected snapshot. The snapshot can be stale (restored
  // from an older app version) and then disagrees with the pickers, which is
  // exactly the "Settings shows fewer models than the chat picker" bug.
  const d = detection || { codex: false, claude: false, ollama: false, opencode: false, models: [], denied: false };
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
  row("opencode", !!d.opencode);
  // Show the resolved direct-CLI paths so the user can confirm the real
  // binaries were found (these are what "claude"/"codex"/"opencode" launch
  // targets use).
  if (d.claude && d.claudePath) {
    const div = document.createElement("div");
    div.className = "detected-item";
    div.textContent = "  claude direct: " + d.claudePath;
    el.detectedList.appendChild(div);
  }
  if (d.codex && d.codexPath) {
    const div = document.createElement("div");
    div.className = "detected-item";
    div.textContent = "  codex direct: " + d.codexPath;
    el.detectedList.appendChild(div);
  }
  if (d.opencode && d.opencodePath) {
    const div = document.createElement("div");
    div.className = "detected-item";
    div.textContent = "  opencode direct: " + d.opencodePath;
    el.detectedList.appendChild(div);
  }
  // The COMPLETE ollama model list (terminal detection + local models from the
  // ChatOSS chat model list — the same source the model picker at the top of
  // the AI chat section uses), so Settings shows every detected model.
  const ollamaModels = allOllamaModels();
  if (d.ollama || ollamaModels.length) {
    const div = document.createElement("div");
    div.className = "detected-item";
    div.textContent = "ollama models (" + ollamaModels.length + "): " + (ollamaModels.join(", ") || "(none)");
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
  // Fall back to "ask" when the saved default isn't among the current options
  // (e.g. a legacy "ollama" value from an older build) — otherwise the select
  // renders blank and Save would silently clear the default.
  const cliValues = Array.from(el.setCli.options).map((o) => o.value);
  el.setCli.value = cliValues.includes(settings.cliDefault) ? settings.cliDefault : "ask";
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

// ---------- Check for updates ----------
// The app cannot replace its own files, so "update" = notify + open the GitHub
// releases page for the user to install. APP_VERSION (top of file) must stay
// in sync with app.json's "version".
const UPDATES_APP_JSON_URL = "https://raw.githubusercontent.com/pagecow/term-coder/main/app.json";
const UPDATES_CONTENTS_API_URL = "https://api.github.com/repos/pagecow/term-coder/contents/app.json";
const UPDATES_RELEASES_API_URL = "https://api.github.com/repos/pagecow/term-coder/releases/latest";
const UPDATES_RELEASES_PAGE_URL = "https://github.com/pagecow/term-coder/releases";

// Parse "1.16.1" / "v1.16.1" into [major, minor, patch] (missing parts = 0).
// Returns null when the string has no leading numeric version.
function parseVersion(v) {
  const m = String(v == null ? "" : v).trim().replace(/^v/i, "").match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return [parseInt(m[1], 10) || 0, parseInt(m[2], 10) || 0, parseInt(m[3], 10) || 0];
}
// >0 when a is newer than b, <0 when b is newer, 0 when equal/unparseable.
function compareVersions(a, b) {
  const pa = parseVersion(a), pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

// Fetch the latest published version from GitHub. Primary source is the repo's
// app.json on main; fallback is the latest release tag. Returns the version
// string or null when neither source could be read.
async function fetchLatestVersion() {
  // web.fetch returns { title, content, links } — content is the page text.
  const readJson = async (url) => {
    const page = await window.chatoss.web.fetch(url);
    const text = (page && (page.content || page.text)) || "";
    if (!text) return null;
    try { return JSON.parse(text); } catch (e) { /* fall through to regex */ }
    // The fetcher may have wrapped/trimmed the raw JSON — pull the field out
    // with a regex as a last resort.
    const m = text.match(/"(?:version|tag_name)"\s*:\s*"([^"]+)"/);
    return m ? { version: m[1], tag_name: m[1] } : null;
  };
  // The GitHub contents API returns JSON whose "content" field is base64-
  // encoded (and may contain embedded newlines). Strip whitespace, atob it,
  // then JSON.parse — with the same regex fallback for wrapped/trimmed
  // payloads. Returns a { version } object, or null.
  const readContentsApi = async (url) => {
    const json = await readJson(url);
    if (!json || !json.content) return null;
    try {
      const decoded = atob(String(json.content).replace(/\s+/g, ""));
      try { return JSON.parse(decoded); } catch (e) { /* fall through to regex */ }
      const m = decoded.match(/"version"\s*:\s*"([^"]+)"/);
      return m ? { version: m[1] } : null;
    } catch (e) { console.warn("readContentsApi decode", e); return null; }
  };
  // 1) Primary: the repo's app.json on main. The "?t=" cache-buster forces a
  //    Fastly CDN cache miss so we always see origin's latest version instead
  //    of a stale cached copy (raw.githubusercontent.com ignores the param).
  try {
    const json = await readJson(UPDATES_APP_JSON_URL + "?t=" + Date.now());
    if (json && json.version) return String(json.version);
  } catch (e) { console.warn("fetchLatestVersion app.json", e); }
  // 2) Fallback: the GitHub contents API — base64-decode its "content" field.
  try {
    const json = await readContentsApi(UPDATES_CONTENTS_API_URL);
    if (json && json.version) return String(json.version);
  } catch (e) { console.warn("fetchLatestVersion contents", e); }
  // 3) Last resort: the latest release tag_name.
  try {
    const json = await readJson(UPDATES_RELEASES_API_URL);
    if (json && json.tag_name) return String(json.tag_name);
  } catch (e) { console.warn("fetchLatestVersion releases", e); }
  return null;
}

async function checkForUpdates() {
  const status = el.updateStatus;
  if (!status) return;
  if (el.checkUpdatesBtn) el.checkUpdatesBtn.disabled = true;
  if (el.openReleasesBtn) el.openReleasesBtn.classList.add("hidden");
  status.textContent = "Checking…";
  status.className = "update-status";
  let remote = null;
  try {
    remote = await fetchLatestVersion();
  } catch (e) {
    console.warn("checkForUpdates", e);
  }
  if (el.checkUpdatesBtn) el.checkUpdatesBtn.disabled = false;
  if (!remote) {
    status.textContent = "Couldn't check for updates — check your connection";
    status.className = "update-status update-status-error";
    return;
  }
  if (compareVersions(remote, APP_VERSION) > 0) {
    status.textContent = "Update available: " + remote;
    status.className = "update-status update-status-available";
    if (el.openReleasesBtn) el.openReleasesBtn.classList.remove("hidden");
  } else {
    status.textContent = "Up to date (" + APP_VERSION + ")";
    status.className = "update-status update-status-ok";
  }
}

function openReleasesPage() {
  try {
    window.chatoss.openExternal.open(UPDATES_RELEASES_PAGE_URL).catch((e) => console.warn("openReleasesPage", e));
  } catch (e) { console.warn("openReleasesPage", e); }
}

// ---------- Model Selection Mode ----------
// The COMPLETE ollama model list: the terminal-detected models (`ollama list`
// via detectTools) PLUS every local model the ChatOSS chat model list reports
// (the same source the model picker at the top of the AI chat section uses).
// The terminal probe can miss models (truncated output, PATH quirks, a stale
// persisted snapshot), so the chat list is the authoritative superset.
// detection.models first (terminal-verified), then chat-local models, deduped
// by id. Falls back to FALLBACK_MODELS when both sources are empty.
function allOllamaModels() {
  const seen = new Set();
  const out = [];
  const push = (m) => {
    if (m && !seen.has(m)) { seen.add(m); out.push(m); }
  };
  for (const m of (detection && detection.models) || []) push(m);
  for (const m of models) {
    if (m && m.source === "local" && m.id) push(m.id);
  }
  return out;
}

// Returns the auto-detected ollama model ids (a copy of allOllamaModels()),
// falling back to FALLBACK_MODELS when detection is empty.
function availableOllamaModels() {
  const m = allOllamaModels();
  return m.length ? m : FALLBACK_MODELS.slice();
}

// ── Direct-CLI + ollama launch targets ──
// A single unified list of everything the user can launch as a sub-agent
// session. Each entry is a "target" the model picker (resolveSessionModel) and
// the spawn logic (spawnChosen) both understand:
//
//   { kind: "direct", id, label, bin }   — run the real claude/codex binary
//                                          directly via the terminal capability
//                                          (NOT through ollama).
//   { kind: "ollama", id, label, model } — launch through `ollama launch
//                                          <tool> --model <model>` (existing path).
//
// `id` is the stable value stored in settings (alwaysModel / complexityModel*).
// Direct CLIs use ids "claude", "codex", and "opencode"; ollama models use their
// model name. kind is derived from the id with targetKind() so a bare id
// round-trips.
function availableLaunchTargets() {
  const out = [];
  // Direct CLIs first — these are the "I have a direct account" options and
  // are the most distinct from the ollama path, so they read as the headline
  // choices. Only listed when the binary is actually installed.
  if (detection.claude && detection.claudePath) {
    out.push({ kind: "direct", id: "claude", label: "claude  (Claude Code, direct)", bin: detection.claudePath });
  }
  if (detection.codex && detection.codexPath) {
    out.push({ kind: "direct", id: "codex", label: "codex  (Codex, direct)", bin: detection.codexPath });
  }
  if (detection.opencode && detection.opencodePath) {
    out.push({ kind: "direct", id: "opencode", label: "opencode  (OpenCode, direct)", bin: detection.opencodePath });
  }
  // Ollama models — the existing launch path. Each becomes its own target so
  // picking one launches through ollama with that model.
  for (const model of availableOllamaModels()) {
    out.push({ kind: "ollama", id: model, label: model + "  (ollama)", model });
  }
  return out;
}

// Look up a launch target by its stable id. Returns the target object or null.
function findLaunchTarget(id) {
  if (!id) return null;
  return availableLaunchTargets().find((t) => t.id === id) || null;
}

// Given a target id, return its kind ("direct" | "ollama") or null when not
// found / not a known target. Used to route the spawn command without needing
// the full target object.
function targetKind(id) {
  const t = findLaunchTarget(id);
  return t ? t.kind : null;
}

// Map a persisted "default launch" value — the shared value space of the
// Settings "Default agent" picker (#set-cli) and the spawn-modal "Remember as
// default" checkbox — to a launch-target id, or null when it must NOT be
// auto-applied on session start.
//
//   "raw:claude" | "raw:codex" | "raw:opencode" -> the matching direct-CLI
//       target id ("claude" / "codex" / "opencode"). These are the only values
//       that name a SELF-CONTAINED launch target (a direct binary needs no extra
//       model choice), so they are the values that can short-circuit the
//       launch-target picker.
//   "ask" | "" | null | undefined -> null. The user asked to be prompted every
//       time, so the caller falls through to the Model Selection Mode logic.
//   anything else (the bare ollama-tool names "claude" / "codex" / "chatgpt" /
//       "hermes" / "opencode" / "copilot", or a stray legacy value) -> null.
//       These are launch TOOLS, not self-contained launch targets — they still
//       need an ollama model (chosen in the pill picker / Model Selection Mode),
//       so they cannot be applied as a single target. Returning null makes the
//       caller fall through to the normal Model Selection Mode logic, which
//       preserves the pre-existing behavior for those values.
//
// resolveSessionModel consults this BEFORE its mode branches so a saved default
// is applied on session start instead of re-asking every time (the launch-pick
// bug): the orchestrator kept showing the pill picker even after the user pinned
// a default agent.
function cliDefaultToTargetId(value) {
  if (!value || value === "ask") return null;
  if (typeof value !== "string") return null;
  if (value.indexOf("raw:") === 0) {
    const id = value.slice(4);
    return id || null;
  }
  return null;
}

// Build the list of { label, value } options for the pill/rect askChoice picker
// and for any <select> that should offer the same choices. value is the stable
// target id so the picker result maps straight back to a launch target.
function launchTargetChoiceOptions() {
  return availableLaunchTargets().map((t) => ({ label: t.label, value: t.id }));
}

// Populate a <select> with the available launch targets (direct CLIs +
// ollama models) and select `selected` (if present in the list). Renders an
// empty placeholder option when nothing is available so the picker is never
// silently blank. Direct CLIs are grouped under an optgroup so they read as a
// distinct choice from the ollama models.
function populateModelSelect(selectEl, selected) {
  if (!selectEl) return;
  const targets = availableLaunchTargets();
  selectEl.innerHTML = "";
  if (!targets.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(nothing detected — run Re-scan)";
    selectEl.appendChild(opt);
    selectEl.value = "";
    return;
  }
  const ids = targets.map((t) => t.id);
  // Direct CLIs first (if any), under a labeled group.
  const direct = targets.filter((t) => t.kind === "direct");
  const ollama = targets.filter((t) => t.kind === "ollama");
  if (direct.length) {
    const grp = document.createElement("optgroup");
    grp.label = "Direct CLI (no ollama)";
    for (const t of direct) {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = t.id + "  (direct)";
      grp.appendChild(opt);
    }
    selectEl.appendChild(grp);
  }
  if (ollama.length) {
    const grp = document.createElement("optgroup");
    grp.label = "Ollama models";
    for (const t of ollama) {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = t.id;
      grp.appendChild(opt);
    }
    selectEl.appendChild(grp);
  }
  // Restore the saved selection if it's still available, else first target.
  if (selected && ids.includes(selected)) selectEl.value = selected;
  else selectEl.value = ids[0];
}

// ---------- Sub-agent effort (per launch target) ----------
// Settings → Model Selection Mode rows pair each target select with an Effort
// select. The effort belongs to the TARGET (not the row), so it applies in
// every selection mode — a manual pill pick of that target carries the same
// effort saved for it in Always/Complexity.

// Read the saved effort for a launch-target id. For ollama-model targets the
// value must be one of the model's current thinkLevels (or "" for default).
// Direct CLI targets are restricted to the fixed low/medium/high set.
function effortForTarget(targetId) {
  if (!targetId) return null;
  const map = modelSelection.subAgentEffort;
  const v = map && typeof map === "object" ? map[targetId] : null;
  if (v == null || v === "") return null;
  const opts = effortOptionsForTarget(targetId);
  return opts.some((o) => o.value === v) ? v : null;
}

// Return the effort options for a given launch target:
//   - Direct CLI (claude/codex/opencode) → low/medium/high (the values Codex's
//     real flag accepts; other direct agents get guidance lines).
//   - An ollama model id with thinkLevels → those exact levels.
//   - Otherwise → the generic low/medium/high/extra-high/max set.
function effortOptionsForTarget(targetId) {
  const directIds = ["claude", "codex", "opencode"];
  if (targetId && directIds.includes(targetId)) {
    return [{ value: "", label: "Model default" },
      { value: "low", label: "Low — fast & pragmatic" },
      { value: "medium", label: "Medium — balanced" },
      { value: "high", label: "High — deep reasoning" }];
  }
  const m = models.find((x) => x.id === targetId);
  if (m && m.thinkLevels && m.thinkLevels.length) {
    const opts = [{ value: "", label: "Model default" }];
    for (const lvl of m.thinkLevels) {
      opts.push({ value: lvl, label: lvl.charAt(0).toUpperCase() + lvl.slice(1) });
    }
    return opts;
  }
  return [{ value: "", label: "Model default" },
    { value: "low", label: "Low — fast & pragmatic" },
    { value: "medium", label: "Medium — balanced" },
    { value: "high", label: "High — deep reasoning" },
    { value: "extra-high", label: "Extra high" },
    { value: "max", label: "Max" }];
}

// Populate an effort select with the option list for `targetId`, selecting the
// value saved for that target ("" = model default).
function populateEffortSelect(selectEl, targetId) {
  if (!selectEl) return;
  selectEl.innerHTML = "";
  for (const o of effortOptionsForTarget(targetId)) {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    selectEl.appendChild(opt);
  }
  selectEl.value = effortForTarget(targetId) || "";
}

// Reflect the per-target effort map into every Settings row. Runs whenever a
// row's target select changes and whenever the panels are (re)populated.
function syncEffortRows() {
  populateEffortSelect(el.alwaysEffort, el.alwaysModel.value);
  populateEffortSelect(el.complexityEffortLow, el.complexityModelLow.value);
  populateEffortSelect(el.complexityEffortMedium, el.complexityModelMedium.value);
  populateEffortSelect(el.complexityEffortHigh, el.complexityModelHigh.value);
}

// Wire one effort select: changing it stores the level against the CURRENT
// target of its sibling model select, and persists immediately ("" deletes the
// entry so a target returns to its model default).
function bindEffortSelect(effortSel, modelSel) {
  if (!effortSel || !modelSel) return;
  effortSel.addEventListener("change", () => {
    const targetId = modelSel.value;
    if (!targetId) return; // empty picker ("nothing detected") — nothing to attach the effort to
    if (!modelSelection.subAgentEffort || typeof modelSelection.subAgentEffort !== "object") modelSelection.subAgentEffort = {};
    const v = effortSel.value;
    if (v) modelSelection.subAgentEffort[targetId] = v;
    else delete modelSelection.subAgentEffort[targetId];
    persistModelSelection();
  });
}

// The task-brief guidance line appended when an effort level is set but the
// target has no real effort flag (claude / opencode / ollama launches). Direct
// Codex instead gets the verified --config model_reasoning_effort flag.
const EFFORT_BRIEF = {
  low: "Effort level: LOW. Work fast and pragmatically — minimal analysis, no over-engineering; prefer the simplest correct solution.",
  medium: "Effort level: MEDIUM. Balance speed and care — think through the important decisions, but don't over-engineer routine parts.",
  high: "Effort level: HIGH. Work with maximum care — reason deeply, consider edge cases and trade-offs, and verify your work before calling it done.",
  "extra-high": "Effort level: EXTRA HIGH. Push deeper than the standard high setting — explore more alternatives, check subtle edge cases, and prioritize correctness over speed.",
  max: "Effort level: MAX. Use the deepest reasoning available — exhaustively analyze the problem, validate assumptions, and produce the most robust solution regardless of time.",
};

// Show only the picker panel matching the active radio mode.
function showModelModePanel(mode) {
  el.modelModeManual.classList.toggle("hidden", mode !== "manual");
  el.modelModeAlways.classList.toggle("hidden", mode !== "always");
  el.modelModeComplexity.classList.toggle("hidden", mode !== "complexity");
}

// Reflect the persisted model-selection config into the settings UI.
// Called on openSettings() (UI open) and after a Re-scan refreshes models.
function applyModelSelectionModeToUi() {
  let mode = modelSelection.modelSelectionMode || "manual";
  const radio = el.modelModeRadios.querySelector(`input[name="model-mode"][value="${mode}"]`);
  if (radio) {
    radio.checked = true;
  } else {
    // Corrupted/legacy persisted mode — fall back to Manual so the UI is never
    // left with no radio checked and every mode panel hidden.
    mode = "manual";
    const fallback = el.modelModeRadios.querySelector('input[name="model-mode"][value="manual"]');
    if (fallback) fallback.checked = true;
  }
  populateModelSelect(el.alwaysModel, modelSelection.alwaysModel);
  populateModelSelect(el.complexityModelLow, modelSelection.complexityModelLow);
  populateModelSelect(el.complexityModelMedium, modelSelection.complexityModelMedium);
  populateModelSelect(el.complexityModelHigh, modelSelection.complexityModelHigh);
  syncEffortRows();
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
  // Sanitize: the effort map must be a plain object of targetId → level.
  if (!modelSelection.subAgentEffort || typeof modelSelection.subAgentEffort !== "object" || Array.isArray(modelSelection.subAgentEffort)) {
    modelSelection.subAgentEffort = {};
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
    // Clean again here as a belt-and-suspenders measure: classifyApprovalPrompt
    // already cleaned verdict.command, but this is the final gate before the
    // text reaches the overlay, so any stray spinner glyph / status frame that
    // slipped through another path is stripped here too. Fall back to a short
    // generic label if cleaning left nothing usable.
    const cleaned = cleanApprovalText(commandText) || "(command text unavailable)";
    const short = cleaned.length > 200 ? cleaned.slice(0, 200) + "…" : cleaned;
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
    // Unified launch targets: direct CLIs (claude/codex/opencode) + ollama
    // models. The session-startup integration can read these to know everything
    // launchable.
    availableTargets: availableLaunchTargets(),
    // The persisted "default launch" (Settings "Default agent" / spawn-modal
    // "Remember as default"). resolveSessionModel applies it automatically on
    // session start so the orchestrator does not re-ask every time.
    cliDefault: settings.cliDefault || "ask",
  };
};

// ---------- Session model resolution (Model Selection Mode) ----------
// Encapsulates all three Model Selection Modes so the session-startup code
// calls a single helper and gets back the launch target to use (or null to
// cancel).
//
//   window.termCoder.resolveSessionModel(taskPrompt) -> Promise<string|null>
//
// The returned string is a LAUNCH TARGET id — either a direct CLI ("claude" /
// "codex", launched directly via the terminal capability) or an ollama model
// name (launched through `ollama launch`). spawnChosen reads the id back with
// findLaunchTarget()/targetKind() to build the right spawn command, so this
// function stays pure and knows nothing about how the binary is launched.
//
//   - "manual"     -> prompt via askChoice (pill style) offering every launch
//                     target (claude, codex, ollama models), wait, return the
//                     chosen target id (or null if dismissed — caller cancels).
//   - "always"     -> return cfg.alwaysModel automatically (now also accepts a
//                     direct-CLI id); if it's unset/empty, fall back to the
//                     pill picker so the user can still pick a target.
//   - "complexity" -> assess the task prompt's complexity (low/medium/high),
//                     return the corresponding configured target automatically
//                     (no prompt). Falls back through the other levels, then to
//                     the first available target if the assessed level is unset.
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
  // Keyword counts use word-boundary matching (NOT text.includes) so substring
  // collisions can't double-count or false-positive: "architecture" must not
  // also match "architect", "address" must not match "add", "prefix" must not
  // match "fix". Two entries are intentional prefixes — "concurren" (→
  // concurrency/concurrent) and "accessib" (→ accessibility/accessible) — and
  // match with only a LEADING boundary so they still catch their word family.
  const kw = (w) => {
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const isPrefix = /(?:concurren|accessib)$/.test(w);
    return new RegExp("\\b" + esc + (isPrefix ? "" : "\\b")).test(text);
  };
  for (const w of HIGH) if (kw(w)) high++;
  for (const w of MED) if (kw(w)) med++;

  // Breadth signals — these say "big" far more reliably than length does, BUT
  // the orchestrator is explicitly instructed to write FOCUSED, DETAILED prompts
  // naming exact files, so a handful of file mentions is ROUTINE, not a
  // complexity signal. Only a genuinely broad span (many files / many enumerated
  // steps) adds a high signal; naming 3–4 files to "create a component + wire it
  // + test it" stays medium.
  const fileMentions = (text.match(/\b[\w./-]+\.(?:js|ts|tsx|jsx|css|scss|html|json|py|rb|go|rs|java|swift|md)\b/g) || []).length;
  const enumeratedSteps = (text.match(/^\s*(?:\d+[.)]|[-*•])\s+/gm) || []).length;
  if (fileMentions >= 6) high++;
  if (enumeratedSteps >= 6) high++;
  if (/\b(?:entire|whole|every|all)\b.{0,24}\b(?:app|project|codebase|file|component)/.test(text)) high++;

  if (high >= 2) return "high";
  if (high === 1) return med >= 3 ? "high" : "medium";
  if (med >= 1) return "medium";
  // Nothing recognisable: a very long brief is probably not trivial.
  return text.length > 600 ? "medium" : "low";
}

// Single helper that routes through the configured Model Selection Mode.
// Returns a launch-target id to apply (direct CLI name or ollama model), or
// null to cancel the session.
window.termCoder.resolveSessionModel = async function resolveSessionModel(taskPrompt) {
  const cfg = window.termCoder.getModelSelectionConfig();
  // Unified launch targets (direct CLIs + ollama models) — supersedes the
  // ollama-only `availableModels` list so the picker can offer
  // claude/codex/opencode directly alongside ollama models.
  const targets = Array.isArray(cfg.availableTargets) && cfg.availableTargets.length
    ? cfg.availableTargets
    : (Array.isArray(cfg.availableModels) ? cfg.availableModels.map((m) => ({ kind: "ollama", id: m, label: m, model: m })) : []);
  // Bare id list for membership checks and "always"/"complexity" validation.
  const ids = targets.map((t) => t.id);
  const opts = targets.map((t) => ({ label: t.label, value: t.id }));

  // ---- Saved default launch takes priority over the mode branches. ----
  // The "Default agent" Settings picker and the spawn-modal "Remember as
  // default" checkbox both persist into settings.cliDefault (exposed here as
  // cfg.cliDefault). When the user pinned a default that maps to a CURRENTLY
  // AVAILABLE launch target, apply it automatically and skip the pill picker —
  // this is the fix for the orchestrator re-asking which launch to use on every
  // session even after a default was set. "Ask me every time" (and values that
  // don't map to a concrete target, e.g. the bare ollama-tool names that still
  // need a model) resolve to null here and fall through to the Model Selection
  // Mode logic below, so the picker still appears exactly when it should.
  const defId = cliDefaultToTargetId(cfg.cliDefault);
  if (defId && ids.includes(defId)) return defId;

  // ---- Always: use the configured fixed target, no prompt. ----
  if (cfg.mode === "always") {
    if (cfg.alwaysModel) return cfg.alwaysModel;
    // No always-target configured yet — fall back to a pill picker so the
    // session can still start, and hint that Settings has the real config.
    if (opts.length) {
      return await window.termCoder.askChoice({
        prompt: "No \"always\" target is configured yet — pick one for this session (or set it in Settings):",
        options: opts,
        style: "pill",
      });
    }
    // B3: no models/targets detected at all — distinguish from a user cancel
    // (null) so the caller can show an actionable message instead of silently
    // dismissing the spawn modal. Throw a recognizable error.
    const e = new Error("No launch targets detected. Run Re-scan in Settings, install ollama/a CLI, or switch Model Selection Mode.");
    e.code = "NO_MODELS";
    throw e;
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
    const target = map[level] || map.medium || map.low || map.high;
    if (target) return target;
    if (ids.length) return ids[0]; // last-resort default
    const e = new Error("No launch targets detected. Run Re-scan in Settings, install ollama/a CLI, or switch Model Selection Mode.");
    e.code = "NO_MODELS";
    throw e;
  }

  // ---- Manual (default): prompt via pills and wait for the pick. ----
  if (!opts.length) {
    const e = new Error("No launch targets detected. Run Re-scan in Settings, install ollama/a CLI, or switch Model Selection Mode.");
    e.code = "NO_MODELS";
    throw e;
  }
  return await window.termCoder.askChoice({
    prompt: "Select a launch target for this session:",
    options: opts,
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

// Collapse state — which projects have their body (conversations + files +
// sessions) hidden. Every project CAN be collapsed, unlike before where one
// project was always forced open.
let collapsedProjects = new Set();
// Codex-style sidebar: bold project rows with folder glyph + chevron, hover
// actions on the right, and the selected project's content (Conversations +
// Files tree) nested underneath with an indentation guide.
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
    glyph.innerHTML = '<svg viewBox="0 0 16 16" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.75 4.5a1.25 1.25 0 0 1 1.25-1.25h3l1.5 1.5h6.75a1.25 1.25 0 0 1 1.25 1.25v6a1.25 1.25 0 0 1-1.25 1.25H3a1.25 1.25 0 0 1-1.25-1.25v-7.5z"/></svg>';
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
    const isActive = p.id === state.activeProjectId;
    const isCollapsed = collapsedProjects.has(p.id);
    const item = document.createElement("div");
    item.className = "project-item" + (isActive ? " selected" : "") + (isCollapsed ? " is-collapsed" : "");

    const row = document.createElement("div");
    row.className = "project-row";

    // Chevron — ALWAYS a collapse toggle now. Clicking it expands/collapses this
    // project's body without changing the active conversation.
    const chev = document.createElement("span");
    chev.className = "proj-chev" + (isCollapsed ? " is-collapsed" : "");
    chev.title = isCollapsed ? "Expand project" : "Collapse project";
    chev.setAttribute("role", "button");
    chev.setAttribute("aria-expanded", String(!isCollapsed));
    chev.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 3.5 10 8l-4.5 4.5"/></svg>';
    chev.onclick = (e) => {
      e.stopPropagation();
      if (collapsedProjects.has(p.id)) collapsedProjects.delete(p.id);
      else collapsedProjects.add(p.id);
      saveState();
      renderProjects();
    };
    row.appendChild(chev);

    // Folder glyph (lighter in the resting state so it doesn't compete with the
    // accent chevron of the selected row).
    const folder = document.createElement("span");
    folder.className = "proj-folder";
    folder.innerHTML = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.75 4.5a1.25 1.25 0 0 1 1.25-1.25h3l1.5 1.5h6.75a1.25 1.25 0 0 1 1.25 1.25v6a1.25 1.25 0 0 1-1.25 1.25H3a1.25 1.25 0 0 1-1.25-1.25v-7.5z"/></svg>';
    row.appendChild(folder);

    const name = document.createElement("div");
    name.className = "project-name";
    const nameText = document.createElement("span");
    nameText.className = "project-name-text";
    nameText.textContent = p.name;
    nameText.title = p.folderPath || p.name;
    name.appendChild(nameText);
    row.appendChild(name);

    // Hover actions — new chat (+) first, then pencil; delete shows after a beat.
    const acts = document.createElement("div");
    acts.className = "proj-actions";
    const newConvBtn = document.createElement("button");
    newConvBtn.className = "btn-icon";
    newConvBtn.title = "New chat in this project";
    newConvBtn.setAttribute("aria-label", "New chat in this project");
    newConvBtn.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg>';
    newConvBtn.onclick = (e) => {
      e.stopPropagation();
      newConversation(p);
      try { el.chatInput.focus(); } catch (_) {}
    };
    const renameBtn = document.createElement("button");
    renameBtn.className = "btn-icon";
    renameBtn.title = "Rename project";
    renameBtn.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.3 2.2a1.4 1.4 0 0 1 2 0l.5.5a1.4 1.4 0 0 1 0 2L7 11.5l-3.2.7.7-3.2 6.8-6.8z"/></svg>';
    renameBtn.onclick = (e) => { e.stopPropagation(); renameProject(p, nameText); };
    const delBtn = document.createElement("button");
    delBtn.className = "btn-icon btn-danger proj-delete";
    delBtn.title = "Delete project";
    delBtn.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M3 5.5h10M6.2 5.5V3.8c0-.5.4-.9.9-.9h1.8c.5 0 .9.4.9.9v1.7M4.8 5.5l.6 6.6c.05.55.5 1 1.05 1h3.1c.55 0 1-.45 1.05-1l.6-6.6"/></svg>';
    delBtn.onclick = (e) => { e.stopPropagation(); confirmDelete(() => deleteProject(p), delBtn); };
    acts.appendChild(newConvBtn);
    acts.appendChild(renameBtn);
    acts.appendChild(delBtn);
    row.appendChild(acts);

    row.onclick = () => selectProject(p.id);
    item.appendChild(row);

    if (isActive && !isCollapsed) {
      const body = document.createElement("div");
      body.className = "proj-body";

      // Conversations group — one row per chat. Newest first; paginated: 7
      // shown by default, +10 per "Show more", "Show less" back. New chats are
      // created via the + on the project row, the top-bar "New chat" button, or
      // Cmd/Ctrl+N — NOT a row here — and an empty chat stays OUT of this list
      // until its first post, so repeated "new chat" clicks can't pile up a
      // stack of empty rows.
      const convWrap = document.createElement("div");
      convWrap.className = "proj-group";
      const convList = document.createElement("div");
      convList.className = "conversation-list";
      const allConvs = p.conversations.filter(conversationHasPosts);
      const base = 7, step = 10;
      // Most recent first (newest is appended at the end of the array).
      const recent = [...allConvs].reverse();
      const maxShown = Math.min(allConvs.length, state.convShown[p.id] || base);
      const shown = recent.slice(0, maxShown);

      for (const c of shown) {
        const ci = document.createElement("div");
        ci.className = "conversation-item" + (c.id === state.activeConversationId ? " selected" : "");
        const cn = document.createElement("span");
        cn.className = "conv-name";
        cn.textContent = c.name;
        ci.appendChild(cn);
        const cacts = document.createElement("div");
        cacts.className = "conv-actions";
        const cren = document.createElement("button");
        cren.className = "btn-icon";
        cren.title = "Rename conversation";
        cren.innerHTML = '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.3 2.2a1.4 1.4 0 0 1 2 0l.5.5a1.4 1.4 0 0 1 0 2L7 11.5l-3.2.7.7-3.2 6.8-6.8z"/></svg>';
        cren.onclick = (e) => { e.stopPropagation(); renameConversation(p, c, cn); };
        const cdel = document.createElement("button");
        cdel.className = "btn-icon btn-danger";
        cdel.title = "Delete conversation";
        cdel.innerHTML = '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M3 5.5h10M6.2 5.5V3.8c0-.5.4-.9.9-.9h1.8c.5 0 .9.4.9.9v1.7M4.8 5.5l.6 6.6c.05.55.5 1 1.05 1h3.1c.55 0 1-.45 1.05-1l.6-6.6"/></svg>';
        cdel.onclick = (e) => { e.stopPropagation(); confirmDelete(() => deleteConversation(p, c), cdel); };
        cacts.appendChild(cren);
        cacts.appendChild(cdel);
        ci.appendChild(cacts);
        ci.onclick = () => selectConversation(p.id, c.id);
        convList.appendChild(ci);
      }

      // Show more / Show less — more reveals up to 10 more at a time; less
      // collapses straight back to the initial 7.
      if (allConvs.length > base) {
        const moreRow = document.createElement("div");
        moreRow.className = "conv-more-row";
        if (maxShown < allConvs.length) {
          const more = document.createElement("button");
          more.className = "conv-more";
          more.type = "button";
          more.innerHTML = '<span class="conv-more-icon"><svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 6 8 9.5 11.5 6"/></svg></span><span>Show more</span>';
          more.title = "Show up to 10 more conversations";
          more.onclick = (e) => {
            e.stopPropagation();
            state.convShown[p.id] = Math.min(allConvs.length, maxShown + step);
            saveState();
            renderProjects();
          };
          moreRow.appendChild(more);
        } else {
          const less = document.createElement("button");
          less.className = "conv-more";
          less.type = "button";
          less.innerHTML = '<span class="conv-more-icon"><svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 10 8 6.5 11.5 10"/></svg></span><span>Show less</span>';
          less.onclick = (e) => {
            e.stopPropagation();
            delete state.convShown[p.id];
            saveState();
            renderProjects();
          };
          moreRow.appendChild(less);
        }
        convList.appendChild(moreRow);
      }

      convWrap.appendChild(convList);
      body.appendChild(convWrap);

      // Section collapse state — Files and Sessions start COLLAPSED and stay
      // that way until the user expands one (persisted per project).
      const sec = (state.sectionCollapsed && state.sectionCollapsed[p.id]) || {};
      const filesCollapsed = sec.files !== false;
      const sessionsCollapsed = sec.sessions !== false;

      // File tree (live, expandable, collapsible) — same group styling.
      const filesWrap = document.createElement("div");
      filesWrap.className = "file-tree" + (filesCollapsed ? " is-collapsed" : "");
      renderFileTree(p, filesWrap, { collapsed: filesCollapsed });
      body.appendChild(filesWrap);

      // Sessions group — live agent status (click selects in the grid).
      // Collapsible like Files; the count badge stays visible when collapsed.
      const sesWrap = document.createElement("div");
      sesWrap.className = "proj-group proj-sessions-group" + (sessionsCollapsed ? " is-collapsed" : "");
      const sesHead = document.createElement("div");
      sesHead.className = "proj-sessions-head section-toggle";
      sesHead.title = sessionsCollapsed ? "Expand Sessions" : "Collapse Sessions";
      sesHead.setAttribute("role", "button");
      sesHead.setAttribute("aria-expanded", String(!sessionsCollapsed));
      const sesChev = document.createElement("span");
      sesChev.className = "section-chev" + (sessionsCollapsed ? " is-collapsed" : "");
      sesChev.innerHTML = '<svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 3.5 10 8l-4.5 4.5"/></svg>';
      const sesTitle = document.createElement("span");
      sesTitle.className = "file-tree-title";
      sesTitle.textContent = "Sessions";
      const sesCount = document.createElement("span");
      sesCount.className = "proj-sessions-count";
      sesHead.appendChild(sesChev);
      sesHead.appendChild(sesTitle);
      sesHead.appendChild(sesCount);
      sesHead.onclick = () => toggleProjSection(p.id, "sessions");
      const sesBody = document.createElement("div");
      sesBody.className = "proj-sessions-list";
      sesWrap.appendChild(sesHead);
      sesWrap.appendChild(sesBody);
      body.appendChild(sesWrap);
      el.projSessionsBody = sesBody;
      el.projSessionsCount = sesCount;
      paintProjSessions();

      item.appendChild(body);
    }

    el.projectList.appendChild(item);
  }
}

// ---------- Sidebar Sessions section ----------
// Live agent status mirror in the Projects column, refreshed every 2s by the
// auto-follow ticker. Clicking a row selects that session in the terminal grid.
//
// Sessions are scoped to the conversation that was active when they were
// spawned (rec.conversationId). Only the ACTIVE conversation's sessions are
// shown here, so a new chat / a different conversation starts with an empty
// Sessions section instead of inheriting the previous conversation's terminals.
function sessionsForActiveConversation() {
  const cid = state.activeConversationId;
  const live = [...sessions.values()].filter((s) => (s.conversationId || null) === cid);
  const dead = [...deadSessions.values()].filter((s) => (s.conversationId || null) === cid);
  return { live, dead };
}

function paintProjSessions() {
  const body = el.projSessionsBody;
  if (!body || !body.isConnected) return;
  const { live: liveAll, dead: deadAll } = sessionsForActiveConversation();
  const total = liveAll.length + deadAll.length;
  if (el.projSessionsCount) el.projSessionsCount.textContent = String(total);

  body.innerHTML = "";
  // Newest session first (by createdAt, which is immutable — unlike lastOutputAt,
  // so the list order stays stable as agents emit output). Live sessions render
  // above the ended ones.
  const recs = liveAll.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const deads = deadAll.sort((a, b) => (b.endedAt || b.createdAt || 0) - (a.endedAt || a.createdAt || 0));
  if (!recs.length && !deads.length) {
    const note = document.createElement("div");
    note.className = "proj-sessions-empty";
    note.textContent = "No sessions in this conversation";
    body.appendChild(note);
    return;
  }
  const labelFor = (s) => {
    const lab = s.label || s.id || "session";
    const idx = lab.indexOf(" · ");
    return idx >= 0 ? lab.slice(0, idx) : lab;
  };
  for (const rec of recs) {
    const act = sessionActivity(rec);
    const row = document.createElement("div");
    row.className = "proj-session-row";
    row.dataset.status = act === "ERROR LOOP" ? "error" : act === "NEEDS INPUT" ? "input" : act === "WORKING" ? "working" : act === "IDLE" ? "idle" : "starting";
    const dot = document.createElement("span");
    dot.className = "proj-session-dot";
    const nm = document.createElement("span");
    nm.className = "proj-session-name";
    nm.textContent = labelFor(rec);
    row.appendChild(dot);
    row.appendChild(nm);
    row.title = act + (rec.worktreeBranch ? " · branch " + rec.worktreeBranch : "");
    row.onclick = () => { selectSession(rec.id); };
    body.appendChild(row);
  }
  for (const snap of deads) {
    const row = document.createElement("div");
    row.className = "proj-session-row";
    row.dataset.status = "exited";
    const dot = document.createElement("span");
    dot.className = "proj-session-dot";
    const nm = document.createElement("span");
    nm.className = "proj-session-name";
    nm.textContent = labelFor(snap);
    row.appendChild(dot);
    row.appendChild(nm);
    row.title = (snap.merged ? "Merged · " : "Ended · ") + (snap.worktreeBranch ? "branch " + snap.worktreeBranch : "output preserved");
    row.onclick = () => { selectSession(snap.id); };
    body.appendChild(row);
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

function renderFileTree(project, container, opts) {
  const collapsed = !!(opts && opts.collapsed);
  // Switching projects resets expansion state and rebinds the watcher.
  if (fileTree.projectPath !== project.folderPath) resetFileTree(project.folderPath);
  fileTree.container = container;

  container.innerHTML = "";
  const head = document.createElement("div");
  head.className = "file-tree-head section-toggle";
  head.title = collapsed ? "Expand Files" : "Collapse Files";
  head.setAttribute("role", "button");
  head.setAttribute("aria-expanded", String(!collapsed));
  const chev = document.createElement("span");
  chev.className = "section-chev" + (collapsed ? " is-collapsed" : "");
  chev.innerHTML = '<svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 3.5 10 8l-4.5 4.5"/></svg>';
  const title = document.createElement("span");
  title.className = "file-tree-title";
  title.textContent = "Files";
  head.appendChild(chev);
  head.appendChild(title);
  const refresh = document.createElement("button");
  refresh.className = "btn-icon";
  refresh.title = "Refresh file tree";
  refresh.innerHTML = '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v2.4h-2.4"/></svg>';
  refresh.onclick = (e) => {
    e.stopPropagation();
    fileTree.cache.clear();
    const dirs = [project.folderPath, ...fileTree.expanded];
    Promise.all(dirs.map((d) => loadDir(d, false))).then(repaintFileTree);
    repaintFileTree();
  };
  head.appendChild(refresh);
  // Clicking anywhere on the head (except the refresh button, which stops
  // propagation) toggles the section.
  head.onclick = () => toggleProjSection(project.id, "files");
  container.appendChild(head);

  const body = document.createElement("div");
  body.className = "file-tree-body";
  container.appendChild(body);

  if (collapsed) {
    // Collapsed by default: skip the initial directory read entirely — the tree
    // loads the first time the user expands the section (which re-renders the
    // project with collapsed=false and lands here).
    return;
  }

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
      // Row indent; the ::before connector sits at the same depth so children
      // are tied back to their parent's chevron.
      row.style.setProperty("--depth", depth);
      const icon = document.createElement("span");
      icon.className = "file-icon";
      icon.innerHTML = entry.isDir
        ? '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg>'
        : fileIcon(entry.name);
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
        row.title = "Open in editor";
        row.onclick = (e) => { e.stopPropagation(); openFileInEditor(childPath); };
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
  d.style.setProperty("--depth", depth || 0);
  return d;
}

function fileIcon(name) {
  const ext = name.split(".").pop().toLowerCase();
  switch (ext) {
    case "js": case "mjs": case "cjs": case "jsx":
      return '<span class="file-ext" data-ext="js">JS</span>';
    case "ts": case "tsx": case "mts": case "cts":
      return '<span class="file-ext" data-ext="ts">TS</span>';
    case "json":
      return '<span class="file-ext" data-ext="json">{}</span>';
    case "html": case "htm":
      return '<span class="file-ext" data-ext="html">&lt;&gt;</span>';
    case "css": case "scss": case "less":
      return '<span class="file-ext" data-ext="css">#</span>';
    case "md":
      return '<span class="file-ext" data-ext="md">M↓</span>';
    case "svg":
      return '<span class="file-ext" data-ext="svg">◈</span>';
    case "png": case "jpg": case "jpeg": case "gif": case "webp": case "ico":
      return '<span class="file-ext" data-ext="img">▦</span>';
    case "sh": case "zsh": case "bash":
      return '<span class="file-ext" data-ext="sh">$</span>';
    default:
      return '<span class="file-ext" data-ext="plain">·</span>';
  }
}

// ---------- Code editor column ----------
// Thin in-sidebar editor between Projects and Chat. Files open by clicking the
// Files tree; unsaved changes gate closing/saving, and ⌘S / Ctrl+S saves.
const editorState = {
  path: null,          // absolute path of the open file (null = closed)
  original: "",        // contents as last saved (or as loaded)
  size: 360,           // persisted column width
};

const isBinaryExt = (name) => {
  const ext = name.split(".").pop().toLowerCase();
  return ["png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "tiff", "pdf", "zip",
          "gz", "tar", "7z", "woff", "woff2", "ttf", "otf", "eot", "mp3", "mp4",
          "mov", "avi", "exe", "dll", "so", "dylib", "class", "jar", "bin", "o",
          "a", "wasm", "db", "sqlite", "sqlite3", "icns", "lock"].includes(ext);
};

async function openFileInEditor(path) {
  // Unsaved changes? Ask before switching files.
  if (editorState.path && editorState.path !== path && editorIsDirty()) {
    const ok = await editorConfirm("Discard unsaved changes to open another file?");
    if (!ok) return;
  }
  if (isBinaryExt(path)) {
    editorSetStatus("Can't edit binary files.", true);
    return;
  }
  try {
    const text = await window.chatoss.files.readFile(path);
    if (typeof text !== "string") {
      editorSetStatus("Read failed: not a text file.", true);
      return;
    }
    editorState.path = path;
    editorState.original = text;
    el.editorInput.value = text;
    el.editorFilename.textContent = path.split("/").pop();
    el.editorFilename.title = path;
    editorSetStatus("Loaded " + (text.split("\n").length) + " lines");
    openEditorPane();
  } catch (e) {
    editorSetStatus("Error opening file: " + (e && e.message ? e.message : String(e)), true);
  }
}

function openEditorPane() {
  if (el.editor.classList.contains("hidden")) {
    el.editor.classList.remove("hidden");
    el.rzEditor.classList.remove("hidden");
    const shell = shellEl();
    const editorWidth = editorState.size || 380;
    shell.style.setProperty("--col-editor", editorWidth + "px");
    shell.style.setProperty("--rz-editor", RZ_W + "px");
    // Re-clamp the chat column so the editor doesn't crush it or overflow.
    applyColWidths(null, null, {});
  }
  el.editorInput.focus();
}

function closeEditorPane() {
  if (el.editor.classList.contains("hidden")) return;
  el.editor.classList.add("hidden");
  el.rzEditor.classList.add("hidden");
  editorState.path = null;
  editorState.original = "";
  el.editorInput.value = "";
  el.editorFilename.textContent = "";
  el.editorFilename.title = "";
  editorSetStatus("");
  el.editorSaveBtn.disabled = true;
  el.editorModifiedDot.classList.add("hidden");
  const shell = shellEl();
  shell.style.setProperty("--col-editor", "0px");
  shell.style.setProperty("--rz-editor", "0px");
  applyColWidths(null, null, {});
  // Chat is the primary column — give it focus back.
  el.chatInput && el.chatInput.focus();
}

function editorIsDirty() {
  return !!editorState.path && el.editorInput.value !== editorState.original;
}

function editorRefreshDirty() {
  const dirty = editorIsDirty();
  el.editorSaveBtn.disabled = !dirty;
  el.editorModifiedDot.classList.toggle("hidden", !dirty);
  if (dirty) editorSetStatus("Unsaved changes — press Save");
}

function editorSetStatus(msg, isError) {
  el.editorStatus.textContent = msg || "";
  el.editorStatus.classList.toggle("is-error", !!isError);
  el.editorStatus.classList.remove("is-saving");
}

async function editorSave() {
  if (!editorState.path) return;
  const contents = el.editorInput.value;
  if (contents === editorState.original) { editorSetStatus("No changes"); return; }
  el.editorStatus.classList.add("is-saving");
  el.editorStatus.classList.remove("is-error");
  editorSetStatus("Saving…");
  try {
    await window.chatoss.files.writeFile(editorState.path, contents);
    editorState.original = contents;
    editorRefreshDirty();
    editorSetStatus("Saved");
  } catch (e) {
    editorSetStatus("Save failed: " + (e && e.message ? e.message : String(e)), true);
  }
}

// Inline confirm (no window.confirm — blocked in the sandbox).
function editorConfirm(question) {
  return new Promise((resolve) => {
    const status = el.editorStatus;
    status.classList.add("is-error");
    status.textContent = question + " Click ✓ to confirm.";
    const yes = document.createElement("button");
    yes.className = "btn btn-small btn-primary";
    yes.textContent = "✓ Discard";
    const no = document.createElement("button");
    no.className = "btn btn-small btn-ghost";
    no.textContent = "Cancel";
    no.style.marginLeft = "4px";
    status.appendChild(yes);
    status.appendChild(no);
    const cleanup = (val) => {
      yes.remove(); no.remove();
      editorRefreshDirty();
      resolve(val);
    };
    yes.onclick = () => cleanup(true);
    no.onclick = () => cleanup(false);
  });
}

function initEditor() {
  if (!el.editor) return;
  el.editorInput.addEventListener("input", editorRefreshDirty);
  el.editorInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { el.editorCloseBtn.click(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      editorSave();
    }
  });
  el.editorSaveBtn.onclick = editorSave;
  el.editorCloseBtn.onclick = async () => {
    if (editorIsDirty()) {
      const ok = await editorConfirm("Discard unsaved changes and close the editor?");
      if (!ok) return;
    }
    closeEditorPane();
  };

  // Editor resizer — same pattern as the other column handles.
  const handle = el.rzEditor;
  if (!handle) return;
  let startX = 0, startW = 0, dragging = false;
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    startX = e.clientX;
    startW = parseFloat(getComputedStyle(shellEl()).getPropertyValue("--col-editor")) || editorState.size;
    dragging = true;
    handle.classList.add("is-dragging");
    document.body.classList.add("is-resizing");
    const onMove = (ev) => {
      if (!dragging) return;
      const w = Math.max(200, Math.min(720, startW + (ev.clientX - startX)));
      shellEl().style.setProperty("--col-editor", w + "px");
      applyColWidths(null, null, {});
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove("is-dragging");
      document.body.classList.remove("is-resizing");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const w = parseFloat(getComputedStyle(shellEl()).getPropertyValue("--col-editor")) || editorState.size;
      editorState.size = w;
      settings.editorWidth = w;
      saveSettings();
      applyColWidths(null, null, { fit: true });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
  handle.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 32 : 8;
    let d = 0;
    if (e.key === "ArrowLeft") d = -step;
    else if (e.key === "ArrowRight") d = step;
    else return;
    e.preventDefault();
    const w = Math.max(200, Math.min(720, (editorState.size || 380) + d));
    editorState.size = w;
    shellEl().style.setProperty("--col-editor", w + "px");
    settings.editorWidth = w;
    saveSettings();
    applyColWidths(null, null, {});
  });
  handle.addEventListener("dblclick", () => {
    editorState.size = 360;
    shellEl().style.setProperty("--col-editor", "360px");
    settings.editorWidth = 360;
    saveSettings();
    applyColWidths(null, null, {});
  });
  handle.title = "Drag to resize the code editor · double-click to reset";
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

// Same inline-rename pattern for a conversation row.
function renameConversation(p, c, nameEl) {
  const input = document.createElement("input");
  input.className = "conv-rename-input";
  input.value = c.name;
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (v) { c.name = v; saveState(); }
    renderProjects();
    renderChat();
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
  const orig = btn.innerHTML;
  btn.textContent = "✓?";
  btn.style.opacity = "1";
  setTimeout(() => {
    btn.dataset.armed = "0";
    btn.innerHTML = orig;
  }, 2500);
}

function selectProject(pid) {
  state.activeProjectId = pid;
  // Selecting a project always reveals its body — a hidden one would make the
  // click look broken.
  collapsedProjects.delete(pid);
  const p = getProject(pid);
  const cur = getConversation(pid, state.activeConversationId);
  if (!cur) {
    const pref = preferredConversation(p);
    state.activeConversationId = pref ? pref.id : null;
  }
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
  // Remove the project + its conversations from the SQLite history store so
  // they don't resurrect on the next hydrateFromSqlite().
  sqliteDeleteProject(p.id);
  if (state.activeProjectId === p.id) {
    state.activeProjectId = state.projects.length ? state.projects[0].id : null;
    const np = getProject(state.activeProjectId);
    const pref = preferredConversation(np);
    state.activeConversationId = pref ? pref.id : null;
  }
  saveState();
  renderProjects();
  renderChat();
  renderSessionInfo();
}
// Derive a short conversation name from the first user message: the first
// ~40–60 characters, cut cleanly at a word boundary with a trailing "…" when
// the message is longer than that. Returns fallback when text is empty, so a
// brand-new conversation keeps its "Conversation N" placeholder until the user
// actually sends something.
function nameFromFirstMessage(text, fallback) {
  const s = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  if (!s) return fallback;
  const MAX = 60, MIN = 40;
  if (s.length <= MAX) return s;
  let cut = s.slice(0, MAX);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace >= MIN) cut = cut.slice(0, lastSpace);
  else if (lastSpace > 0) cut = cut.slice(0, lastSpace);
  cut = cut.replace(/[\s.,;:!?"')\]]+$/, "");
  return cut ? cut + "…" : fallback;
}

// A conversation only "exists" for the sidebar once the user has posted in it.
// Brand-new empty chats stay hidden so New chat / Cmd+N can never pile up a
// stack of empty rows — see newConversation(), which reuses the empty draft.
function conversationHasPosts(c) {
  return !!(c && c.messages && c.messages.some((m) => m.role === "user" && !m.event));
}

// Pick which conversation to open when none is selected: the newest one that
// has posts (empty drafts stay out of the way), falling back to the newest
// overall when every conversation is still empty.
function preferredConversation(p) {
  if (!p || !p.conversations.length) return null;
  for (let i = p.conversations.length - 1; i >= 0; i--) {
    if (conversationHasPosts(p.conversations[i])) return p.conversations[i];
  }
  return p.conversations[p.conversations.length - 1];
}

// Files / Sessions section collapse — persisted per project in
// state.sectionCollapsed. Both are COLLAPSED by default: a section counts as
// expanded only when it was explicitly set to false.
function toggleProjSection(pid, key) {
  if (!state.sectionCollapsed) state.sectionCollapsed = {};
  const cur = state.sectionCollapsed[pid] || {};
  const nowCollapsed = cur[key] !== false;
  state.sectionCollapsed[pid] = Object.assign({}, cur, { [key]: !nowCollapsed });
  saveState();
  renderProjects();
}

function newConversation(p) {
  // One empty draft at a time per project: if one already exists (no posts
  // yet), just switch back to it instead of creating another. The user can
  // hit New chat / Cmd+N repeatedly and always lands on the same fresh chat
  // until they actually post something in it.
  const draft = p.conversations.find((c) => !conversationHasPosts(c));
  if (draft) {
    state.activeProjectId = p.id;
    state.activeConversationId = draft.id;
    collapsedProjects.delete(p.id);
    saveState();
    renderProjects();
    renderChat();
    renderSessionInfo();
    return draft;
  }
  // Start with the "Conversation N" placeholder; the real name is filled in
  // from the user's first message in sendMessage (see nameFromFirstMessage).
  const c = { id: uuid(), name: "Conversation " + (p.conversations.length + 1), messages: [], modelId: null, effort: null, boardId: null, attachments: [] };
  p.conversations.push(c);
  state.activeProjectId = p.id;
  state.activeConversationId = c.id;
  collapsedProjects.delete(p.id);
  saveState();
  renderProjects();
  renderChat();
  renderSessionInfo();
  return c;
}

// Top-bar "New Chat" — starts a fresh conversation inside the CURRENTLY
// selected project (same flow as the + button on a project row). Disabled via
// syncTopNewButtons() when there is no project to put it in.
function newChatFromTopbar() {
  const p = getProject(state.activeProjectId);
  if (!p) {
    setStatus("Add a project folder first — new chats live inside a project.");
    return;
  }
  newConversation(p);
  // Drop the caret into the composer so the user can type immediately.
  try { el.chatInput.focus(); } catch (_) {}
}
// Keep the top-bar New Chat enabled state in step with the active project.
// renderChat runs on every project/conversation change, so it owns the sync.
function syncTopNewButtons() {
  if (!el.newChatBtn) return;
  const hasProject = !!getProject(state.activeProjectId);
  el.newChatBtn.disabled = !hasProject;
  el.newChatBtn.title = hasProject
    ? "Start a new chat in the current project (⌘N / Ctrl+N)"
    : "Add a project folder first";
}
function deleteConversation(p, c) {
  p.conversations = p.conversations.filter((x) => x.id !== c.id);
  // Remove it from the SQLite history store too (messages + tool calls).
  sqliteDeleteConversation(c.id);
  if (state.activeConversationId === c.id) {
    const pref = preferredConversation(p);
    state.activeConversationId = pref ? pref.id : null;
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
// Codex-desktop-style reasoning container: a subtle, DIMMED disclosure row that
// is FULLY collapsed by default — just a "Thinking…" header, no preview — so the
// reasoning never competes with the actual response text. Clicking the header
// expands the full reasoning inline; clicking again collapses it. The header
// doubles as the "still thinking" indicator (💭 Thinking… while streaming,
// Thought process when done) and carries a live word count while streaming.
//
// Streaming contract: onThinking only calls _update() — the widget STAYS
// collapsed while tokens accumulate (the word count ticks up in the header), so
// the response remains the single clear focus. It never auto-expands.
function createThinkingWidget(text, opts) {
  const o = opts || {};
  const wrap = document.createElement("div");
  wrap.className = "msg-thinking-collapsible" + (o.streaming ? " is-streaming" : "");
  wrap.setAttribute("data-state", "collapsed");

  // --- Header: the "still thinking" indicator + the single toggle ---
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

  // --- Body: the full reasoning text, hidden until expanded ---
  const body = document.createElement("div");
  body.className = "think-body";
  const inner = document.createElement("div");
  inner.className = "think-inner";
  inner.textContent = String(text || "");
  body.appendChild(inner);

  wrap.appendChild(header);
  wrap.appendChild(body);

  const setOpen = (open) => {
    wrap.setAttribute("data-state", open ? "open" : "collapsed");
    header.setAttribute("aria-expanded", open ? "true" : "false");
  };
  header.addEventListener("click", () => {
    setOpen(wrap.getAttribute("data-state") !== "open");
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
  syncCopyConvBtn();
  syncTopNewButtons();
  if (!c) {
    el.chatInput.placeholder = "Select or create a conversation…";
    renderModelPicker();
    renderEffortPicker();
    renderBoardChip();
    renderAttachmentStrip();
    chatAutoScroll = true;
    if (el.chatJumpBtn) el.chatJumpBtn.classList.add("hidden");
    updateChatEmpty();
    return;
  }
  el.chatInput.placeholder = "Ask the orchestrator to build something…";
  renderModelPicker();
  renderEffortPicker();
  renderBoardChip();
  renderAttachmentStrip();

  for (const m of c.messages) {
    renderMessage(m);
  }
  // After a full history render, pin to the bottom and reset auto-scroll.
  chatAutoScroll = true;
  scrollChatBottom(false);
  updateChatEmpty();
  renderTokenEstimator();
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

// ---------- Model list loading (with first-install retry) ----------
// models is populated ONLY here. Callers re-render the pickers when it arrives
// so a list that lands late (fresh install warm-up) fills the dropdown without
// an app restart.
async function loadModels() {
  try {
    const list = await window.chatoss.chat.listModels();
    models = Array.isArray(list) ? list : [];
    defaultModelId = await window.chatoss.chat.getDefaultModel();
  } catch (e) {
    console.warn("listModels", e);
    models = []; defaultModelId = null;
  }
  renderModelPicker();
  renderEffortPicker();
  return models.length;
}

// Retry cadence for the fresh-install case (~26s total). Stops as soon as a
// non-empty list lands. Guarded so concurrent empty renders start ONE chain.
let _modelRetryScheduled = false;
function scheduleModelRetries() {
  if (_modelRetryScheduled) return;
  _modelRetryScheduled = true;
  const DELAYS = [700, 1500, 3000, 6000, 10000, 12000];
  let i = 0;
  const tick = async () => {
    if (models.length) { _modelRetryScheduled = false; return; }
    const n = await loadModels();
    if (n === 0 && i < DELAYS.length) {
      setTimeout(tick, DELAYS[i++]);
    } else {
      _modelRetryScheduled = false; // list arrived, or budget exhausted
    }
  };
  setTimeout(tick, DELAYS[i++]);
}

// Display-only renders — no state mutation, no saveState here.
function renderModelPicker() {
  if (!models.length) {
    // Never leave a silently-blank dropdown: show WHY it is empty. The picker is
    // disabled so its empty state can't be persisted onto a conversation.
    el.modelPicker.innerHTML = "";
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Loading models…";
    el.modelPicker.appendChild(opt);
    el.modelPicker.value = "";
    el.modelPicker.disabled = true;
    scheduleModelRetries(); // covers mid-session loss, harmless when already retried
    return;
  }
  el.modelPicker.disabled = false;
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

// Whether the currently-picked model can take an effort level at all.
// The real signal is the presence of thinkLevels OR a reasoning capability.
// If the model advertises neither, we still let the user pick from a generic
// set — many cloud models accept effort overrides even when listModels() doesn't
// enumerate the exact levels.
function selectedModelSupportsEffort() {
  const id = el.modelPicker.value;
  const m = models.find((x) => x.id === id);
  return !!(m && (m.thinkLevels && m.thinkLevels.length ||
                        (m.capabilities && m.capabilities.includes("reasoning"))));
}

// Effort levels shown for the orchestrator chat. Prefer the model's own
// thinkLevels; otherwise fall back to the generic expanded set.
function orchestratorEffortLevels() {
  const id = el.modelPicker.value;
  const m = models.find((x) => x.id === id);
  if (m && m.thinkLevels && m.thinkLevels.length) return m.thinkLevels;
  return GENERIC_EFFORT_LEVELS;
}
function renderEffortPicker() {
  const c = activeConversation();
  // No model at all (list empty / nothing selected) → disable the picker.
  if (!models.length || !el.modelPicker.value) {
    el.effortPicker.innerHTML = "";
    const o = document.createElement("option");
    o.value = ""; o.textContent = "—";
    el.effortPicker.appendChild(o);
    el.effortPicker.disabled = true;
    el.effortPicker.value = "";
    return;
  }
  const id = el.modelPicker.value;
  const m = models.find((x) => x.id === id);
  const levels = orchestratorEffortLevels();
  const hasEnumeratedLevels = !!(m && m.thinkLevels && m.thinkLevels.length);
  el.effortPicker.innerHTML = "";
  el.effortPicker.disabled = false;
  el.effortPicker.title = hasEnumeratedLevels
    ? "Reasoning effort (levels reported by this model)"
    : "Reasoning effort override (generic levels — effect depends on the model provider)";
  const defOpt = document.createElement("option");
  defOpt.value = "";
  defOpt.textContent = "Default";
  el.effortPicker.appendChild(defOpt);
  for (const lvl of levels) {
    const opt = document.createElement("option");
    opt.value = lvl;
    opt.textContent = lvl.charAt(0).toUpperCase() + lvl.slice(1);
    el.effortPicker.appendChild(opt);
  }
  let eff = c && c.effort ? c.effort : null;
  if (!eff || (!levels.includes(eff) && eff !== "")) eff = m && m.thinkDefault ? m.thinkDefault : "";
  el.effortPicker.value = eff;
}
function selectedModel() { return el.modelPicker.value; }
function selectedEffort() {
  if (el.effortPicker.disabled) return null;
  return el.effortPicker.value || null;
}

// ---------- Token estimator ----------
// Heuristic token count: ~4 characters per token, with a floor of 1 token for
// any non-empty string. Good enough for a live estimate without a tokenizer.
function estimateTokens(text) {
  if (text == null) return 0;
  const s = String(text);
  if (!s.length) return 0;
  return Math.max(1, Math.round(s.length / 4));
}

// Resolve the max context window for a model id. Prefers the model's own
// contextLength from listModels(); falls back to the CONTEXT_WINDOW_MAP, then
// a default. Returns 0 when no model is selected.
function maxTokensForModel(modelId) {
  if (!modelId) return 0;
  const m = models.find((x) => x.id === modelId);
  if (m && m.contextLength && m.contextLength > 0) return m.contextLength;
  for (const entry of CONTEXT_WINDOW_MAP) {
    if (entry.match.test(modelId)) return entry.tokens;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

// Estimate the token cost of the tool definitions (JSON schema) passed to
// runTurn. Serializes each tool and counts it with the same heuristic.
function estimateToolTokens(tools) {
  if (!tools || !tools.length) return 0;
  let total = 0;
  for (const t of tools) {
    try { total += estimateTokens(JSON.stringify(t)); } catch (e) { /* ignore */ }
  }
  return total;
}

// Build the full token breakdown for the current composer state. Categories:
//   - system prompt (cached from the last real turn, or a static fallback)
//   - tool definitions (ORCHESTRATOR_TOOLS JSON schema)
//   - messages (the conversation history that will be sent)
//   - draft (the text currently typed in the composer)
// Returns { system, tools, messages, draft, total, max }.
function computeTokenBreakdown() {
  const c = activeConversation();
  const modelId = selectedModel() || defaultModelId;
  const max = maxTokensForModel(modelId);

  const systemText = _lastSystemPrompt || SYSTEM_PROMPT_FALLBACK;
  const system = estimateTokens(systemText);
  const tools = estimateToolTokens(ORCHESTRATOR_TOOLS);

  let messages = 0;
  if (c && c.messages) {
    for (const m of c.messages) {
      if (m.role === "user" || m.role === "assistant") {
        messages += estimateTokens(m.content);
      }
    }
  }

  const draft = estimateTokens(el.chatInput ? el.chatInput.value : "");

  return { system, tools, messages, draft, total: system + tools + messages + draft, max };
}

// Render the estimator: the "current / max" text, the progress ring, and the
// popover breakdown. Called on input, on model change, and after each turn.
function renderTokenEstimator() {
  if (!el.tokenEstimator) return;
  const b = computeTokenBreakdown();
  _lastBreakdown = b;
  _lastMax = b.max;

  const pct = b.max > 0 ? Math.min(1, b.total / b.max) : 0;
  const pctInt = Math.round(pct * 100);

  if (el.tokenCount) {
    el.tokenCount.textContent = b.total.toLocaleString();
  }
  if (el.tokenMax) {
    el.tokenMax.textContent = b.max > 0 ? b.max.toLocaleString() : "—";
  }
  if (el.tokenRingFill) {
    // stroke-dasharray is 100 100, so offset 100 = empty, 0 = full.
    el.tokenRingFill.style.strokeDashoffset = String(100 - pct * 100);
    el.tokenRingFill.classList.toggle("is-warn", pct >= 0.75 && pct < 1);
    el.tokenRingFill.classList.toggle("is-over", pct >= 1);
  }
  if (el.tokenEstimatorBtn) {
    el.tokenEstimatorBtn.setAttribute(
      "aria-label",
      "Token usage: " + b.total.toLocaleString() + " of " + (b.max > 0 ? b.max.toLocaleString() : "unknown") + " tokens (" + pctInt + "%)"
    );
  }
  renderTokenPopover();
}

// Render the popover breakdown (only when open). Each category shows its count
// and a bar proportional to its share of the total.
function renderTokenPopover() {
  if (!el.tokenPopover || el.tokenPopover.hidden) return;
  const b = _lastBreakdown || computeTokenBreakdown();
  const rows = [
    { key: "system", label: "System prompt", n: b.system },
    { key: "tools", label: "Tool definitions", n: b.tools },
    { key: "messages", label: "Messages", n: b.messages },
    { key: "draft", label: "Draft (typed)", n: b.draft },
  ];
  const maxN = Math.max(1, ...rows.map((r) => r.n));
  const pct = b.max > 0 ? Math.min(1, b.total / b.max) : 0;

  let html = '<div class="token-popover-head"><span>Token breakdown</span>' +
    '<span class="token-popover-total">' + b.total.toLocaleString() + " / " + (b.max > 0 ? b.max.toLocaleString() : "—") + "</span></div>";
  for (const r of rows) {
    const share = r.n > 0 ? Math.max(2, Math.round((r.n / maxN) * 100)) : 0;
    html += '<div class="token-popover-row">' +
      '<div class="token-popover-label"><span>' + esc(r.label) + '</span>' +
      '<span class="token-popover-num">' + r.n.toLocaleString() + "</span></div>" +
      '<div class="token-popover-bar"><div class="token-popover-bar-fill" style="width:' + share + '%"></div></div>' +
      "</div>";
  }
  html += '<div class="token-popover-note">Estimate: ~4 characters per token. ' +
    (b.max > 0 ? "Context used: " + Math.round(pct * 100) + "%." : "No model selected.") + "</div>";
  el.tokenPopover.innerHTML = html;
}

function openTokenPopover() {
  if (!el.tokenPopover) return;
  el.tokenPopover.hidden = false;
  el.tokenEstimatorBtn.setAttribute("aria-expanded", "true");
  renderTokenPopover();
}
function closeTokenPopover() {
  if (!el.tokenPopover) return;
  el.tokenPopover.hidden = true;
  el.tokenEstimatorBtn.setAttribute("aria-expanded", "false");
}
function toggleTokenPopover() {
  if (el.tokenPopover && !el.tokenPopover.hidden) closeTokenPopover();
  else openTokenPopover();
}

// ---------- Attachments (files + images) ----------
// Per-conversation attachments: an array of { id, name, kind: 'image'|'file',
// dataUrl?, text?, path? }. Images are stored as data URLs (base64) so they can
// be previewed and passed to runTurn as multimodal content. Text files are read
// and embedded into the user's message as context.
function getAttachments() {
  const c = activeConversation();
  if (!c) return [];
  if (!c.attachments) c.attachments = [];
  return c.attachments;
}
function setAttachments(arr) {
  const c = activeConversation();
  if (!c) return;
  c.attachments = arr || [];
  saveState();
  renderAttachmentStrip();
}

// Render the attachment thumbnails above the composer.
function renderAttachmentStrip() {
  const strip = el.attachmentStrip;
  if (!strip) return;
  const atts = getAttachments();
  if (!atts.length) { strip.classList.add("hidden"); strip.innerHTML = ""; return; }
  strip.classList.remove("hidden");
  strip.innerHTML = "";
  for (const att of atts) {
    const thumb = document.createElement("div");
    thumb.className = "attachment-thumb";
    thumb.title = att.name || "attachment";
    if (att.kind === "image" && att.dataUrl) {
      const img = document.createElement("img");
      img.src = att.dataUrl;
      img.alt = att.name || "image";
      thumb.appendChild(img);
      thumb.addEventListener("click", () => openImagePreview(att.dataUrl));
    } else {
      const icon = document.createElement("span");
      icon.className = "att-file-icon";
      icon.textContent = "📄";
      thumb.appendChild(icon);
      const nm = document.createElement("span");
      nm.className = "att-name";
      nm.textContent = att.name || "file";
      thumb.appendChild(nm);
    }
    const rm = document.createElement("button");
    rm.className = "att-remove";
    rm.type = "button";
    rm.innerHTML = "&times;";
    rm.title = "Remove attachment";
    rm.addEventListener("click", (e) => {
      e.stopPropagation();
      removeAttachment(att.id);
    });
    thumb.appendChild(rm);
    strip.appendChild(thumb);
  }
}

function removeAttachment(id) {
  const atts = getAttachments().filter((a) => a.id !== id);
  setAttachments(atts);
}

// Open the full-size image preview modal.
function openImagePreview(dataUrl) {
  if (!el.imagePreviewModal || !el.imagePreviewImg) return;
  el.imagePreviewImg.src = dataUrl;
  el.imagePreviewModal.classList.remove("hidden");
}
function closeImagePreview() {
  if (!el.imagePreviewModal) return;
  el.imagePreviewModal.classList.add("hidden");
  el.imagePreviewImg.src = "";
}

// Add a file via the file picker (fileAccess openDialog).
async function addFileFromPicker() {
  try {
    const path = await window.chatoss.files.openDialog({ multiple: false });
    if (!path) return; // cancelled/denied
    await addFileByPath(path);
  } catch (e) {
    console.warn("addFileFromPicker", e);
    setStatus("Could not open that file: " + (e && e.message ? e.message : String(e)));
  }
}

// Add a file from a known path: read its bytes, detect if it's an image.
async function addFileByPath(path) {
  const name = basename(path);
  const ext = name.split(".").pop().toLowerCase();
  const imageExts = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"];
  if (imageExts.includes(ext)) {
    // Image: read as base64 and build a data URL.
    try {
      const b64 = await window.chatoss.files.readFile(path, { binary: true });
      const mime = ext === "svg" ? "image/svg+xml" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/" + ext;
      const dataUrl = "data:" + mime + ";base64," + b64;
      addAttachment({ id: uuid(), name, kind: "image", dataUrl });
    } catch (e) {
      console.warn("readFile image", e);
      setStatus("Could not read that image: " + (e && e.message ? e.message : String(e)));
    }
  } else {
    // Text/code file: read as text and store for embedding in the message.
    try {
      const text = await window.chatoss.files.readFile(path);
      addAttachment({ id: uuid(), name, kind: "file", text, path });
    } catch (e) {
      // Binary non-image file: store just the path/name as context.
      console.warn("readFile", e);
      addAttachment({ id: uuid(), name, kind: "file", text: null, path });
    }
  }
}

// Add a dropped file (from fileDrop onDrop). The drop callback gives file
// objects with .text() and .arrayBuffer() methods, NOT paths.
async function addDroppedFile(file) {
  const name = file.name || "dropped-file";
  const type = file.type || "";
  if (type.startsWith("image/")) {
    try {
      const buf = await file.arrayBuffer();
      const b64 = arrayBufferToBase64(buf);
      const dataUrl = "data:" + type + ";base64," + b64;
      addAttachment({ id: uuid(), name, kind: "image", dataUrl });
    } catch (e) { console.warn("dropped image", e); }
  } else {
    try {
      const text = await file.text();
      addAttachment({ id: uuid(), name, kind: "file", text });
    } catch (e) {
      addAttachment({ id: uuid(), name, kind: "file", text: null });
    }
  }
}

function addAttachment(att) {
  const atts = getAttachments();
  atts.push(att);
  saveState();
  renderAttachmentStrip();
}

// Convert an ArrayBuffer to a base64 string (for dropped image data URLs).
function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// Build the content for runTurn: if there are image attachments, return an
// array of text + image parts (multimodal); otherwise return the plain string.
function buildMessageContent(userText) {
  const atts = getAttachments();
  const images = atts.filter((a) => a.kind === "image" && a.dataUrl);
  const files = atts.filter((a) => a.kind === "file");

  // Embed file contents into the text portion.
  let text = userText;
  if (files.length) {
    const fileBlocks = [];
    for (const f of files) {
      if (f.text) {
        fileBlocks.push("--- File: " + f.name + " ---\n" + f.text);
      } else {
        fileBlocks.push("--- File: " + f.name + " (binary — path: " + (f.path || "?") + ") ---");
      }
    }
    text = text + "\n\n[Attached files]\n" + fileBlocks.join("\n\n");
  }

  // If there are images, send multimodal content (text + image_url parts).
  if (images.length) {
    const parts = [{ type: "text", text }];
    for (const img of images) {
      parts.push({ type: "image_url", image_url: { url: img.dataUrl } });
    }
    return parts;
  }
  return text;
}

// Clear attachments after a message is sent.
function clearAttachments() {
  setAttachments([]);
}

// ---------- Copy conversation ----------
// Serialize a conversation's full message history (user + assistant + system,
// including thinking and tool-call activity) into readable plain text.
function conversationToText(c) {
  if (!c || !c.messages || !c.messages.length) return "";
  const parts = [];
  for (const m of c.messages) {
    const role = m.role || "system";
    const label = m.event ? "Event" : (role === "user" ? "You" : role === "assistant" ? "Assistant" : "System");
    let block = label + ":\n" + (m.content || "");
    if (m.thinking) block += "\n\nThinking:\n" + m.thinking;
    if (m.toolCalls && m.toolCalls.length) {
      const lines = m.toolCalls.map((t) => {
        let s = "• " + t.name + "(" + (t.args ? JSON.stringify(t.args) : "") + ")";
        if (t.result !== undefined) s += "\n  " + (typeof t.result === "string" ? t.result : JSON.stringify(t.result));
        if (t.error) s += "\n  " + t.error;
        return s;
      });
      block += "\n\nTools:\n" + lines.join("\n");
    }
    parts.push(block);
  }
  return parts.join("\n\n");
}

let copyConvTimer = null;
// Enable/disable the toolbar button to match whether a conversation is loaded.
function syncCopyConvBtn() {
  const btn = el.copyConvBtn;
  if (!btn) return;
  const c = activeConversation();
  const hasContent = !!(c && c.messages && c.messages.length);
  btn.disabled = !hasContent;
  if (!hasContent) {
    btn.classList.remove("copied");
    const lab = btn.querySelector(".copy-conv-label");
    if (lab) lab.textContent = "Copy";
  }
}
// Copy the ENTIRE active conversation to the clipboard, with a brief
// "Copied!" confirmation on the button. No-op when no conversation is loaded.
async function copyConversation() {
  const c = activeConversation();
  if (!c || !c.messages || !c.messages.length) return; // no conversation → no-op
  const text = conversationToText(c);
  if (!text) return;
  try {
    await window.chatoss.clipboard.writeText(text);
  } catch (e) {
    console.warn("clipboard write", e);
    setStatus("Clipboard unavailable — enable it in Permissions.");
    return;
  }
  const btn = el.copyConvBtn;
  if (!btn) return;
  const lab = btn.querySelector(".copy-conv-label");
  if (lab) lab.textContent = "Copied!";
  btn.classList.add("copied");
  btn.disabled = true;
  clearTimeout(copyConvTimer);
  copyConvTimer = setTimeout(() => {
    btn.classList.remove("copied");
    if (lab) lab.textContent = "Copy";
    syncCopyConvBtn();
  }, 1600);
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
    "IMPORTANT: every sub-agent session requires the USER's approval. When you call start_cli_session, a confirmation dialog appears and the user chooses the launch target — the real claude or codex CLI directly (if they have a direct account), or an ollama model. You just supply the working directory and a task prompt, then wait for the returned session id.",
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
    "  • YOU HAVE FULL AUTHORITY OVER WORKTREE MANAGEMENT (CRUD): create_worktree, list_worktrees, worktree_git_status, merge_worktree, delete_worktree (remove WITHOUT merging — for abandoned work), and prune_worktrees (purge stale bookkeeping entries whose directories/branches are gone). Clean up stale entries yourself — never leave orphaned bookkeeping behind, and never tell the user a cleanup is 'a ChatOSS-side task'.",
    "  • NEVER spawn a coding agent directly in the project folder. ALWAYS create a worktree first and pass its worktreePath as cwd to start_cli_session. This prevents parallel agents from stomping on each other's changes.",
    "  • Create ALL the worktrees you need up front (or in batches) before spawning agents.",
    "",
    "STEP 3 — SPAWN a coding agent for each subtask (in parallel where possible).",
    "  • For each subtask, call start_cli_session({ cwd: <worktreePath>, taskPrompt: <the subtask instructions> }) to spin up a coding agent in that worktree.",
    "  • PREFER spawn_batch({ tasks: [{ name, prompt }, ...] }) for parallel subtasks: ONE call creates every worktree AND spawns every agent, so you can never 'stop after 1-of-N'. One launch choice applies to the whole batch (the user's saved default, or one dialog).",
    "  • Give each agent a FOCUSED, DETAILED task prompt — exactly what files to create/modify, what behavior to implement, and any constraints. The sub-agent writes the code, not you.",
    "  • Spawn subtasks that are file-disjoint ALL AT ONCE (or in rapid succession). The app supports multiple simultaneous terminal sessions.",
    "  • Spawn subtasks that share files SEQUENTIALLY — wait for the first agent to finish and merge before spawning the next one that touches the same files.",
    "  • Each start_cli_session / spawn_batch returns session ids. SAVE every session id so you can monitor each agent independently.",
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
    "  • IDLE is now detected by the PLATFORM's own PTY state (the foreground process sitting at its input prompt), not just by matching prompt glyphs — so opencode/codex sessions flip to IDLE reliably when they finish.",
    "  • The app runs a HEALTH CHECK every 5 minutes: a session that is still WORKING/STARTING but has produced no output for 10+ minutes is nudged with \"are you still working? continue\" (rate-limited) and the user is notified. You can also call health_check({}) yourself to see every session's health at once.",
    "  • A session reported as DEGENERATE OUTPUT has collapsed into a repeated-token/gibberish loop and was interrupted. Do not keep waiting on it — close_session and respawn a fresh agent in the same worktree (the app auto-commits the worktree's uncommitted work when a session closes, so nothing is lost).",
    "  • To see what a worktree's agent actually changed (committed vs uncommitted) before merging — e.g. after a kill — call worktree_git_status({ branchName: <branch> }).",
    "  • The app AUTO-SUBMITS the taskPrompt you passed to start_cli_session (it types the text and presses Enter once the agent is ready). Do not re-send the initial task.",
    "  • If auto-follow is enabled, you will be woken automatically with a '[Term Coder] The agent … has FINISHED ITS TURN' message when an agent stops. Treat that as your cue to review, merge, and continue — you do not need to sit in a waiting loop.",
    "  • Report progress on ALL agents to the user — which are still working, which are done, which hit errors.",
    "  • Use send_to_session({ sessionId: <id>, text }) ONLY for follow-up instructions AFTER an agent's input box is accepting text — not for startup dialogs.",
    "  • Do NOT loop read_session rapidly. Prefer wait_for_session to block for completion, or list_sessions to check status without dumping output. Only call read_session when you need to read the actual terminal text.",
    "  • send_to_session takes CONTENT in `text` and a KEYPRESS in `key` — e.g. { text: \"do X instead\", key: \"enter\" }. Never put escape codes in `text`; they would be typed as visible characters. Use key:\"ctrl+c\" to interrupt, key:\"enter\" to submit.",
    "  • NEVER try to confirm or send keystrokes to the agent's 'trust this folder?' dialog yourself. That dialog is handled by the app's settings and/or a chat pill picker. If the session keeps showing the trust dialog, you may say in chat that the agent is waiting for trust approval — but do NOT send Enter or arrow keys to it.",
    "  • NEVER try to select a model by sending arrow keys to an interactive model menu. The user already chooses the launch target (claude / codex direct, or an ollama model) when they approve the session spawn (or via Model Selection Mode in Settings). If read_session still shows a model picker, STOP and ask the user to pick the target in Settings or in the spawn dialog.",
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
    "STEP 7 — FINISH THE BATCH: COMMIT, PUSH, RELEASE. THESE ARE YOUR JOB.",
    "  • Merges, git commits, git pushes, version bumps, and GitHub releases are the ORCHESTRATOR's job — NEVER delegate them to a sub-agent. You have the tools: git_status, git_commit, git_push, version_bump, create_release, read_file, write_file, edit_file.",
    "  • When the user asks to finish a batch (or says 'stop when everything is done'), the done condition is: every worktree merged, main pushed to origin, and a release created with installable assets.",
    "  • Release flow, in order:",
    "      1. version_bump({ bump: 'minor' }) — MINOR for a batch with features/fixes, PATCH for a single tiny fix. It updates app.json AND the APP_VERSION constant together.",
    "      2. git_commit({ message: 'vX.Y.Z: <summary>' })",
    "      3. git_push({})",
    "      4. create_release({ notes: '<summary>' }) — creates the GitHub release and builds/uploads the .aip + .zip assets.",
    "  • Small direct file edits (release metadata, docs like AGENTS.md, config) are also YOUR job — use read_file/write_file/edit_file. Implementation work still belongs to sub-agents in worktrees.",
    "  • If a tool reports 'terminal permission denied', tell the user to approve the command in the pending permission prompt — do NOT delegate the operation to a sub-agent.",
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
    "ACT, don't just explore. When the user asks you to build or change something, your job is to DECOMPOSE the task, create worktrees, SPIN UP coding agents (start_cli_session) to do the work in their own terminals, coordinate them by reading their output (read_session) and sending follow-up instructions (send_to_session), and MERGE the results back (merge_worktree). Don't try to write all the code yourself in chat; delegate it to sub-agents. But when the batch is done, YOU finish it: commit, push, and release (STEP 7) — never hand that to a sub-agent.",
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
        sys.push("You can create new cards with create_card({ title, description?, columnId }) and new columns with create_column({ name }) — columnId must be one of the column ids listed above.");
      }
    } catch (e) {
      sys.push("(Could not read attached board: " + (e && e.message ? e.message : String(e)) + ")");
    }
  } else {
    sys.push("", "(No Kanban board attached to this conversation. You can still list_boards to see what exists.)");
  }
  const joined = sys.join("\n");
  _lastSystemPrompt = joined;
  return joined;
}

// ---------- Send message ----------
// No single tool call may hang the turn. `terminal.exec` never settles while an
// unanswered permission prompt is up, and a monitoring call can outlive the
// user's patience — either way the orchestrator used to sit there with chips
// reading "running 6m 05s" and an empty result, unable to make progress. A raced
// timeout guarantees the engine always gets a string back and the chip resolves.
const TOOL_TIMEOUT_MS = 90 * 1000;
const TOOL_TIMEOUT_OVERRIDES = { wait_for_session: 15 * 60 * 1000 };
async function runToolWithTimeout(name, args, signal) {
  const limit = TOOL_TIMEOUT_OVERRIDES[name] || TOOL_TIMEOUT_MS;
  let timer = null;
  let onAbort = null;
  // Race the tool against the turn's abort signal too, so an interrupt (Stop or
  // interruptAndSend) ends the turn promptly instead of waiting out a long tool
  // call (wait_for_session can run 15 minutes). The abandoned toolHandler keeps
  // running in the background — its side effects (a spawned session, a merge)
  // still complete and the next turn sees them via list_sessions.
  const abortPromise = new Promise((resolve) => {
    if (!signal) return;
    onAbort = () => resolve("Error: interrupted by the user.");
    if (signal.aborted) { onAbort(); return; }
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([
      toolHandler(name, args),
      abortPromise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(
          "Error: the " + name + " tool did not return within " + Math.round(limit / 1000) +
          "s and was abandoned. This usually means it is blocked on something outside the app — most often an unanswered terminal-permission prompt. Tell the user what you were trying to do and ask them to check for a pending approval, then continue with something else."
        ), limit);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort && signal && typeof signal.removeEventListener === 'function') {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

function setRunning(r) {
  running = r;
  syncSendButton();
  // The composer stays ENABLED while a turn runs so the user can interrupt the
  // orchestrator with a new message (see interruptAndSend). Only the placeholder
  // changes to advertise that.
  if (r) {
    el.chatInput.placeholder = "Type to interrupt the orchestrator…";
  } else {
    el.chatInput.placeholder = activeConversation() ? "Ask the orchestrator to build something…" : "Select or create a conversation…";
  }
}

// The send button doubles as Stop while a turn runs. When the user has typed a
// message, the button flips back to Send — submitting it interrupts the current
// turn and delivers the message (see interruptAndSend).
function syncSendButton() {
  const hasText = !!(el.chatInput && el.chatInput.value && el.chatInput.value.trim());
  const isStop = running && !hasText;
  el.sendBtn.classList.toggle("is-running", isStop);
  el.sendBtn.title = isStop ? "Stop" : "Send";
  el.sendBtn.setAttribute("aria-label", isStop ? "Stop" : "Send");
  if (el.sendIcon) el.sendIcon.classList.toggle("hidden", isStop);
  if (el.stopIcon) el.stopIcon.classList.toggle("hidden", !isStop);
}

// textOverride lets the app itself start a turn (see autoFollowTick). opts.event
// marks the message as an app-generated event so it renders distinctly from
// something the user actually typed.
async function sendMessage(textOverride, opts) {
  const o = opts || {};
  const c = activeConversation();
  if (!c) { setStatus("Select or create a conversation first."); return; }
  if (running) return;
  // An app-generated/event turn (e.g. an auto-follow wake) must NOT start
  // while a permission/choice prompt is awaiting the user — it would create a
  // fresh streaming UI on top of the active prompt. Drop it; the next
  // autoFollowTick retries once the prompt is answered. This guard only
  // applies to event (automatic) sends, so a user who deliberately types
  // while a prompt is up can still send.
  if (o.event && pendingChoices > 0) return;
  const text = textOverride != null ? String(textOverride).trim() : el.chatInput.value.trim();
  if (!text) return;
  if (textOverride == null) el.chatInput.value = "";

  // Build the user message content: if there are attachments, embed file
  // contents and pass images as multimodal parts; otherwise just the text.
  const content = buildMessageContent(text);
  const userMsg = { role: "user", content };
  if (o.event) userMsg.event = true;
  // Clear the attachment strip after the message is consumed.
  if (textOverride == null) clearAttachments();
  // Name the conversation from the user's first real (non-event) message,
  // replacing the "Conversation N" placeholder — but only if the user hasn't
  // already renamed it by hand. This covers every conversation regardless of
  // how it was created, since all user messages enter through sendMessage.
  const wasFirstUserMsg = !c.messages.some((m) => m.role === "user" && !m.event);
  let renamedConv = false;
  if (wasFirstUserMsg && !o.event && /^Conversation \d+$/.test(c.name)) {
    c.name = nameFromFirstMessage(text, c.name);
    renamedConv = true;
  }
  c.messages.push(userMsg);
  saveState();
  // The conversation is hidden from the sidebar until its first post — reveal
  // it now (also renames the "Conversation N" placeholder on that same post).
  if (renamedConv || (wasFirstUserMsg && !o.event)) { renderProjects(); renderSessionInfo(); }
  renderMessage(userMsg);
  scrollChatBottom(false);
  updateChatEmpty();

  await runOrchestratorTurn(c);
}

// Runs ONE orchestrator turn for the given conversation: streams the reply,
// executes tool calls, and persists the assistant message. Extracted from
// sendMessage so interruptAndSend can start a fresh turn after aborting an
// in-flight one. Callers must have already pushed the user message.
async function runOrchestratorTurn(c) {
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
  // Persist the effort if one was chosen, even if the model doesn't explicitly
  // advertise "reasoning" in capabilities — many cloud models accept an effort
  // override even when listModels() doesn't enumerate the levels.
  c.effort = effort || null;
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
        const entry = { id: uuid(), name, args, result: undefined, error: undefined };
        liveToolCalls.push(entry);
        // Persist the tool call to SQLite as it happens (result updated below),
        // so tool history survives even if the app dies mid-turn.
        sqlitePersistToolCall(c.id, entry);
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
          const res = await runToolWithTimeout(name, args, abortController.signal);
          entry.result = res;
          sqlitePersistToolCall(c.id, entry);
          chip._setResult(res);
          return res; // string result feeds back into the engine's tool loop
        } catch (e) {
          const err = "Error: " + (e && e.message ? e.message : String(e));
          entry.error = err;
          sqlitePersistToolCall(c.id, entry);
          chip._setError(err);
          return err;
        }
      },
      think: canThink || !!effort,            // request reasoning if the model supports it OR the user asked for an effort level
      thinkLevel: effort || undefined,         // pass the chosen level when set; undefined lets the model use its default
      signal: abortController.signal,
    });

    // Flush any tail content that was queued behind a rAF, then drop the cursor.
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    liveBody.innerHTML = renderMarkdown(accContent);
    if (liveThink) liveThink._finalize();

    const content = result && result.content ? result.content : accContent;
    const thinking = result && result.thinking ? result.thinking : accThink;

    if (result && result.aborted) {
      setStatus(interruptDeliveryActive ? "Interrupted — continuing…" : "Stopped");
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
    // When this abort was an interrupt-and-continue delivery (interruptAndSend),
    // the user's new message is ALREADY in history and a fresh turn starts the
    // moment this one unwinds. Don't save a partial assistant reply — it would
    // sit AFTER the user's new message in history and confuse the next turn.
    if (!(result && result.aborted && interruptDeliveryActive)) {
      c.messages.push({
        role: "assistant",
        content: content || "(no response)",
        thinking: thinking || undefined,
        toolCalls: storedToolCalls,
      });
      saveState();
      renderMessage(c.messages[c.messages.length - 1]);
      maybeScrollChatBottom();
    }
  } catch (e) {
    typingRow.remove();
    liveRow.remove();
    // On error there is no saved assistant message to rebuild the card from, so
    // KEEP the live card (collapsed) — it's the only record of what ran.
    if (activityCard) activityCard._finish();
    setStatus("");
    if (interruptDeliveryActive) {
      // The abort was an interrupt-and-continue delivery: the user's new message
      // is already in history and a fresh turn starts right after this unwinds.
      // Don't record a spurious error/system message for the interrupted turn.
    } else {
      const msg = "Error: " + (e && e.message ? e.message : String(e));
      c.messages.push({ role: "system", content: msg });
      saveState();
      renderMessage({ role: "system", content: msg });
      maybeScrollChatBottom();
    }
  } finally {
    // Nothing may be left spinning. If the turn ended (normally, by error, or by
    // abort) while a tool call was still outstanding, mark those chips
    // interrupted so they stop their tickers and read honestly.
    for (const ch of liveChips) {
      if (ch.classList.contains("is-running") && typeof ch._setInterrupted === "function") ch._setInterrupted();
    }
    setRunning(false);
    abortController = null;
    renderTokenEstimator();
  }
}

// ---------- Mid-run delivery: message the orchestrator while it works ----------
// While a turn is running the composer stays enabled. Sending a message then
// INTERRUPTS the in-flight turn and the orchestrator CONTINUES with the new
// message: the message is shown in the chat immediately, the current turn is
// aborted, and once it has fully unwound a fresh turn starts with the message
// in history (the same streaming path as a normal send).
//
// The orchestrator here is the chat model (chatApi.runTurn), not a CLI session,
// so "deliver to the orchestrator" = abort the in-flight runTurn and start the
// next one. (Sub-agent CLI sessions are driven by the orchestrator's own
// send_to_session tool, which already uses paste() + key('enter').)
let midRunDeliveryInFlight = false;   // double-submission guard
let interruptDeliveryActive = false;   // set while aborting for a delivery, so the
                                      // interrupted turn skips saving a partial reply

// Resolves when the in-flight orchestrator turn has fully unwound (its finally
// clears `running`). The abort signal makes the engine end the turn promptly;
// the timeout is a safety net so a stuck turn can never wedge the composer.
function waitForTurnEnd(timeoutMs) {
  const limit = timeoutMs || 30000;
  return new Promise((resolve) => {
    if (!running) { resolve(); return; }
    const started = Date.now();
    const iv = setInterval(() => {
      if (!running || Date.now() - started >= limit) {
        clearInterval(iv);
        resolve();
      }
    }, 100);
  });
}

async function interruptAndSend(text) {
  if (midRunDeliveryInFlight) {
    setStatus("Already delivering your previous message — one moment…");
    return;
  }
  const c = activeConversation();
  if (!c) { setStatus("Select or create a conversation first."); return; }
  midRunDeliveryInFlight = true;
  try {
    // 1. Show the user message immediately (same naming logic as sendMessage).
    const userMsg = { role: "user", content: text };
    const wasFirstUserMsg = !c.messages.some((m) => m.role === "user" && !m.event);
    let renamedConv = false;
    if (wasFirstUserMsg && /^Conversation \d+$/.test(c.name)) {
      c.name = nameFromFirstMessage(text, c.name);
      renamedConv = true;
    }
    c.messages.push(userMsg);
    saveState();
    // Reveal in the sidebar on first post (see sendMessage).
    if (renamedConv || wasFirstUserMsg) { renderProjects(); renderSessionInfo(); }
    const userRow = renderMessage(userMsg);
    scrollChatBottom(false);
    updateChatEmpty();
    el.chatInput.value = "";
    el.chatInput.style.height = "auto"; // reset the auto-resized composer
    syncSendButton();                   // empty composer + running → back to Stop

    // 2. Interrupt the in-flight turn.
    interruptDeliveryActive = true;
    if (abortController) abortController.abort();

    // 3. Wait for the old turn to fully unwind (its finally clears `running`).
    await waitForTurnEnd();
    if (running) {
      // Safety net: the turn ignored the abort (shouldn't happen — tool calls
      // race the abort signal). Leave the message in history; the user can
      // retry once the turn ends.
      interruptDeliveryActive = false;
      midRunDeliveryInFlight = false;
      setStatus("The current step is still finishing — try again in a moment.");
      return;
    }

    // 4. If the old turn finished on its own (not aborted) while we waited, it
    //    pushed its assistant reply AFTER our user message. Move our message to
    //    the end so history order stays user → assistant, and mirror the move in
    //    the DOM.
    const idx = c.messages.indexOf(userMsg);
    if (idx !== -1 && idx < c.messages.length - 1) {
      c.messages.splice(idx, 1);
      c.messages.push(userMsg);
      saveState();
      if (userRow && userRow.parentNode === el.chatLog) el.chatLog.appendChild(userRow);
    }

    // 5. Continue with the new message. Clear the delivery markers FIRST so this
    //    new turn can itself be interrupted the same way.
    interruptDeliveryActive = false;
    midRunDeliveryInFlight = false;
    await runOrchestratorTurn(c);
  } catch (e) {
    interruptDeliveryActive = false;
    midRunDeliveryInFlight = false;
    setStatus("Interrupt failed: " + (e && e.message ? e.message : String(e)));
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
let statusRefreshTimer = null; // D3: handle for the sidebar status-refresh interval, cleared together with autoFollowTimer
let lastAutoFollowAt = 0;
const AUTO_FOLLOW_COOLDOWN_MS = 8000;

function autoFollowTick() {
  if (settings.autoFollow === false) return;
  if (running) return;                                  // orchestrator is already busy
  // Don't start a new orchestrator turn while a permission/choice prompt is
  // awaiting the user — a fresh streaming turn would spin up a whole new set
  // of "still thinking" indicators on top of the active prompt. Wait for the
  // user to answer first; the next tick (2.5s) picks up once it's cleared.
  if (pendingChoices > 0) return;
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
    // B1 (belt-and-suspenders): a session whose task was NEVER submitted
    // (taskSubmittedAt === 0) cannot have "finished its turn" or be genuinely
    // blocked on input — it's still in the trust / pre-submission window. Skip
    // the IDLE / NEEDS INPUT wake for it so the orchestrator isn't spuriously
    // fired while the user is approving trust. EXITED is still reported.
    if (!rec.taskSubmittedAt && act !== "EXITED") continue;

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
  // Lightweight status refresh: bump activity markers + count in the sidebar
  // Sessions section and update the Projects column without rebuilding the
  // file tree. No PTY reads — purely the in-memory activity classification.
  // D3: store the handle at module scope (statusRefreshTimer) so a future
  // teardown path can clear it alongside autoFollowTimer. Previously the
  // handle was discarded, so this interval could never be stopped.
  if (statusRefreshTimer) clearInterval(statusRefreshTimer);
  statusRefreshTimer = setInterval(() => {
    if (el.projSessionsBody && el.projSessionsBody.isConnected) paintProjSessions();
  }, 2000);
}

// D3: tear down both auto-follow intervals. Called if/when auto-follow is ever
// disabled (e.g. a future "disable auto-follow" setting). Safe to call even
// when nothing is running.
function stopAutoFollow() {
  if (autoFollowTimer) { clearInterval(autoFollowTimer); autoFollowTimer = null; }
  if (statusRefreshTimer) { clearInterval(statusRefreshTimer); statusRefreshTimer = null; }
}

// ---------- Right column: terminal grid ----------
// Show/hide each terminal square (live) and ended card (dead) based on whether
// it belongs to the ACTIVE conversation, and keep the empty-state hint + count
// badge in sync with the visible total. Sessions are scoped per conversation
// (rec.conversationId), so switching conversations shows only that
// conversation's terminals and a fresh chat starts with an empty grid.
function refreshSessionVisibility() {
  const cid = state.activeConversationId;
  let visible = 0;
  for (const rec of sessions.values()) {
    const show = (rec.conversationId || null) === cid;
    if (rec.squareEl) rec.squareEl.style.display = show ? "" : "none";
    if (show) visible++;
  }
  for (const card of el.termGrid.querySelectorAll(".term-square-ended")) {
    const snap = deadSessions.get(card.dataset.deadId);
    const show = !!snap && (snap.conversationId || null) === cid;
    card.style.display = show ? "" : "none";
    if (show) visible++;
  }
  if (el.termEmpty) el.termEmpty.style.display = visible ? "none" : "";
  if (el.termCount) el.termCount.textContent = String(visible);
}

function ensureEmptyHint() {
  // Both live sessions and persisted (ended) cards count toward "not empty",
  // but only those belonging to the active conversation.
  refreshSessionVisibility();
}

// Switch the terminal sessions panel between the three layout modes
// ("squares" | "columns" | "rows"). This only changes the CONTAINER layout
// (CSS class on the grid) — the live xterm mounts are NOT recreated, so their
// content/state is preserved. Each mount's ResizeObserver refits the PTY to
// its new box automatically after the relayout.
function setTermView(view) {
  if (view !== "squares" && view !== "columns" && view !== "rows") view = "squares";
  state.termView = view;
  saveState();
  // Swap the grid's layout class.
  el.termGrid.classList.remove("view-squares", "view-columns", "view-rows");
  el.termGrid.classList.add("view-" + view);
  // Update the active/aria-pressed state of the switcher buttons.
  if (el.termViewSwitcher) {
    for (const btn of el.termViewSwitcher.querySelectorAll(".term-view-btn")) {
      const isActive = btn.dataset.view === view;
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-pressed", isActive ? "true" : "false");
    }
  }
  // The container dimensions changed — give the layout a frame to settle, then
  // refit every live terminal to its new box. Dead (ended) cards have no PTY.
  requestAnimationFrame(() => {
    for (const rec of sessions.values()) fitTerminal(rec);
  });
}

function renderTabs() {
  // Grid layout — no tab bar. Keep the active square visually marked and the
  // count badge in sync. (Name kept so existing call sites don't change.)
  for (const rec of sessions.values()) {
    rec.squareEl.classList.toggle("active", rec.id === state.activeSessionId);
  }
  // Mark an active ended card too (clicking one selects it).
  for (const card of el.termGrid.querySelectorAll(".term-square-ended")) {
    card.classList.toggle("active", card.dataset.deadId === state.activeSessionId);
  }
  refreshSessionVisibility();
}

function selectSession(id) {
  // Live session?
  const rec = sessions.get(id);
  // Ended/persisted session?
  const dead = deadSessions.get(id);
  if (!rec && !dead) return;
  state.activeSessionId = id;
  saveState();
  renderTabs();
  const target = rec ? rec.squareEl : (el.termGrid.querySelector('[data-dead-id="' + CSS.escape(id) + '"]'));
  if (target) target.scrollIntoView({ block: "nearest", behavior: "smooth" });
  renderSessionInfo();
}

async function registerSession(session, cmd, args, cwd, label, conversationId) {
  const id = session.id;
  // Scope the session to the conversation that was active when it was spawned
  // (or the explicit id passed by the reattach path). This is what lets the
  // Sessions section show only the current conversation's terminals.
  const convId = (conversationId !== undefined) ? conversationId : state.activeConversationId;
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
  // Resize handles: a vertical one on the right edge (columns view → width) and
  // a horizontal one on the bottom edge (rows view → height). Only the handle
  // matching the active view is shown (CSS); the drag logic is delegated on the
  // grid in initTermResize().
  const resizeX = document.createElement("div");
  resizeX.className = "term-resize-handle term-resize-handle-x";
  resizeX.setAttribute("role", "separator");
  resizeX.setAttribute("aria-orientation", "vertical");
  resizeX.setAttribute("aria-label", "Resize terminal width");
  const resizeY = document.createElement("div");
  resizeY.className = "term-resize-handle term-resize-handle-y";
  resizeY.setAttribute("role", "separator");
  resizeY.setAttribute("aria-orientation", "horizontal");
  resizeY.setAttribute("aria-label", "Resize terminal height");
  square.appendChild(resizeX);
  square.appendChild(resizeY);
  // Newest session first: prepend the square to the TOP of the grid so
  // currently-running terminals sit above ended (dead) cards and stay visible
  // without scrolling. The empty-state hint (termEmpty) remains the last child.
  el.termGrid.insertBefore(square, el.termGrid.firstChild);

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
    // Platform PTY state (session.isWaitingForInput / onStateChange): true when
    // the foreground process is the shell/CLI blocked on a tty read — the
    // authoritative "sitting at its prompt" signal that the text heuristics kept
    // missing for opencode/codex. 'unsupported' (Windows) leaves this false.
    ptyIdle: false, ptyStateUnsub: null, ptyPollTimer: null,
    // Health-check bookkeeping (stall detection + nudge).
    lastNudgeAt: 0, nudgeCount: 0, degenerate: false, degenerateInfo: null,
    lastErrorText: "", errorCount: 0, lastErrorAt: 0, errorLoop: false,
    // Persistence metadata — used to snapshot the session to scopedData so the
    // Sessions column survives an app close/reopen. `agent` is the CLI label
    // (e.g. "claude", "codex"); `worktreeBranch` is the git branch this session's
    // cwd is a worktree of (derived from the path / worktreeMeta), so the merged-
    // worktree cleanup can match a session to a merged branch.
    agent: label ? String(label).split(" · ")[0] : label,
    conversationId: convId,
    createdAt: Date.now(), endedAt: null, worktreeBranch: worktreeBranchForCwd(cwd), merged: false };
  sessions.set(session.id, rec);
  // Persist immediately so a session that's spawned but produces no output
  // before the app is closed still survives a reopen (otherwise it would never
  // reach SESSIONS_KEY until the first output chunk triggers schedulePersist).
  schedulePersistSessions();

  // ---------- Platform PTY-state observation (idle detection) ----------
  // The text heuristics (isIdlePrompt) never matched opencode/codex prompt
  // chrome, so those sessions stayed WORKING forever and wait_for_session hung.
  // The platform's own PTY state is CLI-agnostic: isWaitingForInput() is true
  // exactly when the foreground process is the shell/CLI blocked on a tty read
  // (sitting at its prompt). Wire BOTH the push (onStateChange) and a poll
  // fallback (covers sessions restored from persistence, where the subscription
  // is gone, and hosts where onStateChange is unavailable).
  const applyPtyState = (busy) => {
    if (!rec.active) return;
    rec.ptyIdle = busy === false;
  };
  if (session && typeof session.onStateChange === "function") {
    try {
      rec.ptyStateUnsub = session.onStateChange((st) => {
        if (st && typeof st.busy === "boolean") applyPtyState(st.busy);
      });
    } catch (e) { /* non-fatal */ }
  }
  if (session && typeof session.isWaitingForInput === "function") {
    const pollPty = async () => {
      if (!rec.active) return;
      try {
        const w = await session.isWaitingForInput();
        // THREE states: true (at prompt), false (busy), 'unsupported' (unknown —
        // Windows, or a dead session). Only a definite answer updates the flag.
        if (w === true) applyPtyState(false);
        else if (w === false) applyPtyState(true);
      } catch (e) { /* non-fatal */ }
    };
    pollPty();
    rec.ptyPollTimer = setInterval(pollPty, 10000);
  }

  // ---------- Degenerate-output recovery ----------
  // The platform detects repeated-token / incoherent-gibberish output loops
  // (the "codex goes silent then the terminal turns to garbage" failure). When
  // it fires, interrupt the agent (ctrl+c) so it stops burning quota, flag the
  // session so the orchestrator sees it, and notify the user. The orchestrator
  // can then close_session + respawn; we do NOT auto-kill because the worktree
  // may hold uncommitted work the user wants to inspect first.
  if (session && typeof session.onDegenerateOutput === "function") {
    try {
      session.onDegenerateOutput((info) => {
        if (!rec.active) return;
        rec.degenerate = true;
        rec.degenerateInfo = info || {};
        try { session.key("ctrl+c"); } catch (e) { /* non-fatal */ }
        try {
          window.chatoss.notifications.send({
            title: "Agent output degenerated",
            body: (rec.label || "Agent") + ": repeated-token/gibberish loop detected — interrupted. Consider closing and respawning it.",
          });
        } catch (e) { /* non-fatal */ }
        renderTabs();
        renderSessionInfo();
      });
    } catch (e) { /* non-fatal */ }
  }

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

    // The terminal tail carries live CLI spinner glyphs ("✻") and status
    // frames ("Baking…", "still thinking") that stripAnsi() can't remove —
    // they're plain unicode redrawn every frame. Clean them out so the
    // approval overlay shows the real command, not garbled decoration.
    commandText = cleanApprovalText(commandText);

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
        // Debounced-save this session's output snapshot to scopedData so it
        // survives an app close/reopen (see SESSIONS_KEY). schedulePersistSessions
        // batches many chunks into one write — never per byte.
        schedulePersistSessions();
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
        } else if (!rec.autoApproveBusy && !rec.waitingForInput && !rec._idleTimer && rec.trustState !== "pending" && rec.trustState !== "asking") {
          // Only flag after a quiet period — an agent that is actually thinking
          // keeps emitting spinner frames, which refresh lastOutputTime.
          // The trustState guard (B1) prevents arming during the quiet trust /
          // pre-submission window: while a "trust this folder?" pill picker is
          // pending ("pending"/"asking"), the terminal shows a prompt cursor with
          // no spinner, so without this guard the 5s timer would falsely flag the
          // agent as idle before its task was ever submitted.
          rec._idleTimer = setTimeout(() => {
            rec._idleTimer = null;
            if (!rec.active || rec.autoApproveBusy || rec.waitingForInput) return;
            if (rec.trustState === "pending" || rec.trustState === "asking") return;
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
        rec.endedAt = Date.now();
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
        // Eagerly persist the final ended snapshot so the last output is saved
        // even if the app is closed immediately after the process exits.
        persistSessions().catch((e) => console.warn("persistSessions onExit", e));
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

// ---------- Session health check ----------
// Detects stalled sessions (quiet but still classified WORKING/STARTING) and
// nudges them back to life, or reports them so the user can intervene. Runs on
// a timer (HEALTH_CHECK_MS) and is also exposed to the orchestrator as the
// health_check tool. Returns a per-session report string.
async function runHealthCheck() {
  const now = Date.now();
  const report = [];
  for (const rec of sessions.values()) {
    if (rec.active === false) continue;
    const act = sessionActivity(rec);
    const quietFor = now - (rec.lastOutputAt || now);
    const stalled = (act === "WORKING" || act === "STARTING") && quietFor >= STALL_QUIET_MS;
    if (stalled) {
      const canNudge = now - (rec.lastNudgeAt || 0) >= NUDGE_COOLDOWN_MS;
      if (canNudge && rec.session && typeof rec.session.paste === "function") {
        try {
          await rec.session.paste(NUDGE_TEXT);
          await rec.session.key("enter");
          rec.lastNudgeAt = now;
          rec.nudgeCount = (rec.nudgeCount || 0) + 1;
          try {
            window.chatoss.notifications.send({
              title: "Agent appears stalled — nudged",
              body: (rec.label || "Agent") + " was quiet for " + Math.round(quietFor / 60000) + " min. Sent: \"" + NUDGE_TEXT + "\"",
            });
          } catch (e) { /* non-fatal */ }
          report.push("NUDGED " + (rec.label || rec.id) + " (quiet " + Math.round(quietFor / 60000) + " min, nudge #" + rec.nudgeCount + ")");
        } catch (e) {
          report.push("STALLED " + (rec.label || rec.id) + " (quiet " + Math.round(quietFor / 60000) + " min) — nudge failed: " + (e && e.message ? e.message : String(e)));
        }
      } else if (canNudge) {
        report.push("STALLED " + (rec.label || rec.id) + " (quiet " + Math.round(quietFor / 60000) + " min) — no paste/key on this session handle, cannot nudge");
      } else {
        report.push("STALLED " + (rec.label || rec.id) + " (quiet " + Math.round(quietFor / 60000) + " min) — already nudged " + Math.round((now - rec.lastNudgeAt) / 60000) + " min ago, waiting");
      }
    } else if (rec.degenerate) {
      report.push("DEGENERATE " + (rec.label || rec.id) + " — output collapsed into a repeated-token/gibberish loop; interrupted. Consider close_session + respawn.");
    } else {
      report.push(act + " " + (rec.label || rec.id) + " (quiet " + Math.round(quietFor / 1000) + "s)");
    }
  }
  return report.length ? report.join("\n") : "No live sessions.";
}

async function closeSession(id) {
  const rec = sessions.get(id);
  if (!rec) return;
  if (rec.autoApproveUnsub) { try { rec.autoApproveUnsub(); } catch (e) { /* non-fatal */ } }
  if (rec._idleTimer) { clearTimeout(rec._idleTimer); rec._idleTimer = null; }
  if (rec.ptyPollTimer) { clearInterval(rec.ptyPollTimer); rec.ptyPollTimer = null; }
  if (rec.ptyStateUnsub) { try { rec.ptyStateUnsub(); } catch (e) { /* non-fatal */ } }
  // Auto-commit the worktree BEFORE killing the process, so a killed agent's
  // uncommitted edits are never stranded. A session whose cwd is a worktree
  // (worktreeBranchForCwd returns its branch) gets a WIP commit; the merge flow
  // later folds it into main. Nothing-to-commit is fine (exit 1, ignored).
  const wtBranch = rec.worktreeBranch || worktreeBranchForCwd(rec.cwd);
  if (wtBranch && rec.cwd) {
    try {
      const wipR = await window.chatoss.terminal.exec(
        loginShell("git add -A && git commit -m " + JSON.stringify("WIP: commit uncommitted work before closing " + (rec.label || rec.id))),
        { cwd: rec.cwd }
      );
      if (wipR && wipR.exitCode === 0) {
        try {
          window.chatoss.notifications.send({
            title: "Worktree auto-committed",
            body: (rec.label || "Agent") + " closed — its uncommitted work was committed to branch " + wtBranch + " so it is resumable.",
          });
        } catch (e) { /* non-fatal */ }
      }
    } catch (e) { /* non-fatal — never block the close */ }
  }
  try { if (rec.session && rec.session.kill) await rec.session.kill(); } catch (e) { /* non-fatal */ }
  // Terminal sessions now survive window close in the OS store, so a closed
  // session must be removed from the OS-persisted record too (killSession
  // kills the process if any and deletes the persisted metadata/output).
  try { await window.chatoss.terminal.killSession(id); } catch (e) { /* non-fatal */ }
  if (rec.dispose) { try { rec.dispose(); } catch (e) { /* non-fatal */ } }
  if (rec.ro) { try { rec.ro.disconnect(); } catch (e) { /* non-fatal */ } }
  rec.squareEl.remove();
  sessions.delete(id);
  // A closed session should NOT come back as a dead card on the next reopen,
  // so drop it from the persisted snapshot list too.
  sqliteDeleteTerminalSession(id);
  persistSessions().catch((e) => console.warn("persistSessions closeSession", e));
  if (state.activeSessionId === id) {
    state.activeSessionId = sessions.size ? sessions.keys().next().value : null;
  }
  saveState();
  ensureEmptyHint();
  renderTabs();
  renderSessionInfo();
}

function renderSessionInfo() {
  // If the selected session belongs to a different conversation, drop the
  // selection so the footer doesn't name a terminal that isn't visible here.
  if (state.activeSessionId) {
    const sel = sessions.get(state.activeSessionId) || deadSessions.get(state.activeSessionId);
    if (!sel || (sel.conversationId || null) !== state.activeConversationId) {
      state.activeSessionId = null;
    }
  }
  const rec = state.activeSessionId ? sessions.get(state.activeSessionId) : null;
  const dead = (!rec && state.activeSessionId) ? deadSessions.get(state.activeSessionId) : null;
  const c = activeConversation();
  let bits = [];
  if (c) bits.push("Conversation: " + c.name);
  if (rec) bits.push("Session: " + rec.label + " @ " + rec.cwd + (rec.active ? "" : " (exited)"));
  else if (dead) bits.push("Session: " + dead.label + " @ " + dead.cwd + " (ended)");
  el.sessionInfo.textContent = bits.join("  ·  ");
  // Keep the terminal grid + count badge scoped to the active conversation.
  refreshSessionVisibility();
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

// Count of askChoice prompts currently awaiting the user. A permission/approval
// question can land WHILE an orchestrator turn is still streaming (e.g. a
// merge_worktree tool call fires askChoice inside onToolCall), so the live
// "thinking" indicators — typing dots, the streaming caret, spinning tool
// chips, the status pulse — would keep animating on top of / around the
// permission content. While a prompt is up we pause those animations (via the
// .chat-prompt-pending class below) and block new auto-follow turns from
// starting a fresh streaming UI on top of it. The underlying turn keeps
// running; only the visual spinners pause, and they resume the instant the
// last pending prompt is answered.
let pendingChoices = 0;

// Toggle the "a choice is pending" state on the chat column. The CSS rules
// scoped to .chat-prompt-pending freeze the thinking-indicator animations and
// make the overlay opaque so no streaming content shows through around the
// prompt. Idempotent: adding when already on / removing when already off is a
// no-op. Robust to the document.body fallback host (no .col-chat ancestor).
function setPromptPending(on) {
  let target = null;
  if (typeof el !== "undefined" && el && el.chatOverlay) {
    target = el.chatOverlay.closest ? el.chatOverlay.closest(".col-chat") : null;
  }
  if (!target) target = document.querySelector(".col-chat") || document.body;
  if (on) target.classList.add("chat-prompt-pending");
  else target.classList.remove("chat-prompt-pending");
}

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
      // One fewer prompt awaiting the user. When the last one is answered,
      // release the "prompt pending" state so the paused thinking-indicator
      // animations resume (the orchestrator turn may still be streaming) and
      // auto-follow turns may fire again.
      pendingChoices = Math.max(0, pendingChoices - 1);
      if (pendingChoices === 0) setPromptPending(false);
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

    // Mark a prompt as pending: pause the live thinking-indicator animations
    // (typing dots / streaming caret / spinning tool chips / status pulse) so
    // they don't keep animating on top of / around the permission content, and
    // make the overlay opaque so streaming UI behind it is occluded. Only do
    // this for a real prompt (>=1 option) — the no-options path resolves
    // immediately and never actually awaits the user.
    if (btns.length) {
      pendingChoices++;
      setPromptPending(true);
    }
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
  const editorOpen = !el.editor.classList.contains("hidden");
  const editorW = editorOpen
    ? (parseFloat(getComputedStyle(shell).getPropertyValue("--col-editor")) || editorState.size)
    : 0;
  const resizerW = editorOpen ? 3 * RZ_W : 2 * RZ_W;
  const avail = cur.total - resizerW - editorW;
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

// ---------- Terminal resize (columns width / rows height) ----------
// Each terminal square carries two drag handles: a vertical one on its right
// edge (columns view → width) and a horizontal one on its bottom edge (rows
// view → height). Only the handle matching the active view is shown (CSS), and
// only that one is draggable. Sizes are applied as inline CSS variables
// (--term-w / --term-h) so they survive view switches; the live PTY refits
// automatically via each mount's ResizeObserver as the box changes.
const TERM_MIN_W = 200; // min column width (px)
const TERM_MIN_H = 120; // min row height (px)

function initTermResize() {
  if (!el.termGrid) return;
  let drag = null;

  const onMove = (e) => {
    if (!drag) return;
    const delta = (drag.axis === "x" ? e.clientX : e.clientY) - drag.startPos;
    const min = drag.axis === "x" ? TERM_MIN_W : TERM_MIN_H;
    const size = Math.max(min, drag.startSize + delta);
    drag.square.style.setProperty(drag.axis === "x" ? "--term-w" : "--term-h", size + "px");
  };
  const onUp = () => {
    if (!drag) return;
    const handle = drag.handle;
    drag = null;
    if (handle) handle.classList.remove("is-dragging");
    document.body.classList.remove("is-resizing", "is-resizing-row");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
  };

  el.termGrid.addEventListener("pointerdown", (e) => {
    const handle = e.target.closest && e.target.closest(".term-resize-handle");
    if (!handle) return;
    const square = handle.closest(".term-square");
    if (!square) return;
    const axis = handle.classList.contains("term-resize-handle-x") ? "x" : "y";
    // Only the handle matching the current view is active (the other is hidden
    // by CSS, but guard against a stale handle during a view transition).
    if (axis === "x" && !el.termGrid.classList.contains("view-columns")) return;
    if (axis === "y" && !el.termGrid.classList.contains("view-rows")) return;
    if (square.classList.contains("expanded")) return;

    e.preventDefault();
    e.stopPropagation();
    const rect = square.getBoundingClientRect();
    drag = {
      square,
      handle,
      axis,
      startPos: axis === "x" ? e.clientX : e.clientY,
      startSize: axis === "x" ? rect.width : rect.height,
    };
    handle.classList.add("is-dragging");
    document.body.classList.add(axis === "x" ? "is-resizing" : "is-resizing-row");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  });

  // A click on a handle (no drag) must not select the session — swallow it in
  // the capture phase so it never reaches the square's click listener.
  el.termGrid.addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest(".term-resize-handle")) {
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);
}

// ============================================================
// USER TERMINAL — bottom drawer
// ============================================================
// A terminal the USER controls directly. It is NOT one of the orchestrator's
// AI sessions on the right — the orchestrator never spawns it, drives it, or
// reads it. It slides up from the bottom of the screen as a drawer and hosts a
// live interactive xterm running in the current project's working directory.
//
// The live session is kept alive across open/close toggles so reopening is
// instant. We persist a tiny "open" flag + last height to scopedData so the
// drawer can restore its open state and size across app restarts, but the live
// PTY itself is gone after a restart (terminals are not portable across boots),
// so on reopen we respawn a fresh shell if the drawer was open.
const USER_TERM_KEY = "term-coder.userTerm";
let userTerm = {
  session: null,       // the live spawn() session handle (null when no shell)
  handle: null,        // the mount() dispose handle (null when not mounted)
  ro: null,            // ResizeObserver for the mount element
  open: false,         // whether the drawer is currently showing
  spawning: false,     // guard against concurrent spawn attempts
  cwd: null,           // cwd the current shell was started in
  persisted: { open: false, height: 0 }, // restored on boot
  cellW: 0,            // measured character cell width (px) — set after mount
  cellH: 0,            // measured character row height (px) — set after mount
  lastCols: 0,         // last cols we resized the PTY to (skip redundant resizes)
  lastRows: 0,         // last rows we resized the PTY to
};

// Resolve the working directory for the user terminal: the active project's
// folder, then the saved default cwd, then the root "/". Mirrors defaultCwd().
function userTermCwd() {
  const p = getProject(state.activeProjectId);
  if (p && p.folderPath) return p.folderPath;
  if (settings.cwdDefault) return settings.cwdDefault;
  return "/";
}

// Spawn a fresh interactive shell for the user terminal. Uses the SAME login-
// shell spawn pattern as the orchestrator sessions (zsh -l) so the user gets
// their full PATH. Accepts optional { cols, rows } so the PTY can be born at
// the drawer's REAL size — spawning at a placeholder size and resizing right
// after mount makes zsh re-render its prompt and leaves a stray "%" line.
async function userTermSpawn(dims) {
  if (userTerm.spawning) return null;
  userTerm.spawning = true;
  try {
    const cwd = userTermCwd();
    const d = dims || { cols: 90, rows: 24 };
    const session = await window.chatoss.terminal.spawn("zsh", {
      args: ["-l"],        // login shell, interactive — no command, so it drops to a prompt
      cwd,
      cols: d.cols,
      rows: d.rows,
    });
    userTerm.session = session;
    userTerm.cwd = cwd;
    if (el.userTermCwd) {
      el.userTermCwd.textContent = basename(cwd);
      el.userTermCwd.title = cwd;
    }
    // If the shell exits on its own (the user typed `exit`, or it crashed),
    // drop our references so the next open/restart spawns a fresh one.
    // Identity-guard: a Restart kills the OLD shell whose onExit fires AFTER
    // the new session is in place — without this check it would null out the
    // fresh session and the remounted terminal would vanish.
    try {
      if (session.onExit) {
        session.onExit(() => {
          if (userTerm.session !== session) return; // stale exit from a previous shell
          userTermUnmount();
          userTerm.session = null;
        });
      }
    } catch (e) { /* non-fatal */ }
    return session;
  } catch (e) {
    console.warn("user terminal spawn failed:", e);
    // Show an inline error so the user knows why the terminal is blank.
    if (el.userTermMount) {
      const errEl = document.createElement("div");
      errEl.className = "term-mount-error";
      errEl.textContent = "Terminal failed to start: " + (e && e.message ? e.message : String(e));
      el.userTermMount.appendChild(errEl);
    }
    return null;
  } finally {
    userTerm.spawning = false;
  }
}

// Mount the live xterm into the drawer's mount element. Reuses the exact
// terminal.mount bridge the orchestrator sessions use. Call AFTER the drawer
// is visible (mount needs a laid-out element to size the PTY).
async function userTermMount() {
  if (!userTerm.session || !el.userTermMount) return;
  // Clear any prior error placeholder before mounting.
  for (const e of el.userTermMount.querySelectorAll(".term-mount-error")) e.remove();
  try {
    const handle = await window.chatoss.terminal.mount(el.userTermMount, userTerm.session.id, { fontSize: 13 });
    userTerm.handle = handle && handle.dispose ? handle : null;
  } catch (e) {
    console.warn("user terminal mount failed:", e);
    const errEl = document.createElement("div");
    errEl.className = "term-mount-error";
    errEl.textContent = "Terminal failed to load: " + (e && e.message ? e.message : String(e));
    el.userTermMount.appendChild(errEl);
    return;
  }
  // Keep the PTY fitted to the drawer as it resizes.
  if (userTerm.ro) { try { userTerm.ro.disconnect(); } catch (e) { /* non-fatal */ } }
  try {
    const ro = new ResizeObserver(() => userTermFit());
    ro.observe(el.userTermMount);
    userTerm.ro = ro;
  } catch (e) { /* non-fatal */ }
  // Re-measure the cell metrics from the xterm's ACTUAL computed font (now that
  // it's mounted) and fit immediately — synchronously, so the caller's post-
  // mount \x0c repaint (if any) lands AFTER the fit, not before it. The pre-spawn
  // probe used a best-guess font; if it was slightly off, this corrects the PTY
  // size now, and the "lastCols/lastRows" seed prevents a redundant double-resize.
  const m = measureUserTermCells();
  userTerm.cellW = m.cellW;
  userTerm.cellH = m.cellH;
  userTermFit();
}

// Measure the actual character cell dimensions for the xterm's font. We can't
// call the xterm instance's fit() directly (the mount handle only exposes
// dispose()), so we probe the font ourselves: render a block of characters in
// a hidden element with the SAME font-family and font-size the xterm uses, and
// divide the total width by the character count. This lets us compute the
// EXACT cols/rows the xterm will display — a hardcoded 7.8px approximation is
// wrong for most font/size combos and causes a PTY-width ≠ xterm-width
// mismatch, which makes zsh think every line is "partial" and print a stray
// "%" + spaces before each prompt.
function measureUserTermCells() {
  const mount = el.userTermMount;
  if (!mount) return { cellW: 7.8, cellH: 16 };
  // After mount, read the font from the xterm's own root element so we match
  // exactly. Before mount (pre-spawn probe), fall back to the mount defaults.
  const xt = mount.querySelector(".xterm");
  let fontFamily = "monospace", fontSize = "13px";
  if (xt) {
    const cs = getComputedStyle(xt);
    if (cs.fontFamily) fontFamily = cs.fontFamily;
    if (cs.fontSize) fontSize = cs.fontSize;
  }
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:absolute;visibility:hidden;white-space:pre;" +
    "font-family:" + fontFamily + ";font-size:" + fontSize + ";" +
    "line-height:normal;display:inline-block;";
  probe.textContent = "M".repeat(200);
  mount.appendChild(probe);
  const rect = probe.getBoundingClientRect();
  mount.removeChild(probe);
  if (rect.width > 0 && rect.height > 0) {
    return { cellW: rect.width / 200, cellH: rect.height };
  }
  return { cellW: 7.8, cellH: 16 };
}

// Resize the PTY to match the mount element's box. Uses the MEASURED cell
// dimensions (not a hardcoded approximation) so the PTY cols exactly match the
// xterm's rendered cols — a mismatch makes zsh print a stray "%" partial-line
// marker before every prompt.
function userTermFit() {
  if (!userTerm.session || !el.userTermMount) return;
  const w = el.userTermMount.clientWidth;
  const h = el.userTermMount.clientHeight;
  if (!w || !h) return;
  if (!userTerm.cellW || !userTerm.cellH) {
    const m = measureUserTermCells();
    userTerm.cellW = m.cellW;
    userTerm.cellH = m.cellH;
  }
  const cols = Math.max(20, Math.floor(w / userTerm.cellW));
  const rows = Math.max(5, Math.floor(h / userTerm.cellH));
  // Skip if unchanged — avoids SIGWINCH spam and the "%" artifact that every
  // unnecessary resize produces on a raw shell prompt.
  if (userTerm.lastCols === cols && userTerm.lastRows === rows) return;
  userTerm.lastCols = cols;
  userTerm.lastRows = rows;
  try { if (userTerm.session.resize) userTerm.session.resize(cols, rows); } catch (e) { /* non-fatal */ }
}

// Tear down the mount (NOT the session) so the shell keeps running in the
// background and can be remounted instantly on reopen.
function userTermUnmount() {
  if (userTerm.ro) { try { userTerm.ro.disconnect(); } catch (e) { /* non-fatal */ } userTerm.ro = null; }
  if (userTerm.handle) { try { userTerm.handle.dispose(); } catch (e) { /* non-fatal */ } userTerm.handle = null; }
}

// Kill the underlying shell entirely (used by Restart + the close-and-kill path).
async function userTermKill() {
  userTermUnmount();
  if (userTerm.session) {
    try { if (userTerm.session.kill) await userTerm.session.kill(); } catch (e) { /* non-fatal */ }
    userTerm.session = null;
  }
  userTerm.cwd = null;
}

// Persist the open/closed flag + current height so the drawer can restore on
// the next app launch. Fire-and-forget, never leaves an unhandled rejection.
function userTermPersist() {
  try {
    const rec = { open: userTerm.open };
    if (el.userTermDrawer && el.userTermDrawer.classList.contains("open")) {
      const h = el.userTermDrawer.getBoundingClientRect().height;
      if (h > 80) rec.height = h;
      else if (userTerm.persisted.height) rec.height = userTerm.persisted.height;
    } else if (userTerm.persisted.height) {
      rec.height = userTerm.persisted.height;
    }
    userTerm.persisted = rec;
    window.chatoss.scopedData.set(USER_TERM_KEY, rec).catch((e) => console.warn("userTermPersist", e));
  } catch (e) { console.warn("userTermPersist", e); }
}

// Apply a height (px) to the drawer, clamped to a usable range.
function userTermApplyHeight(px) {
  if (!el.userTermDrawer) return;
  const vh = window.innerHeight;
  const min = 140;
  const max = Math.floor(vh * 0.85);
  const h = Math.max(min, Math.min(max, px || Math.floor(vh * 0.35)));
  el.userTermDrawer.style.height = h + "px";
  userTerm.persisted.height = h;
}

// OPEN the drawer: spawn a shell if none exists, mount it, slide it up.
async function userTermOpen() {
  if (userTerm.open) { userTermFocus(); return; }
  userTerm.open = true;
  // Restore the saved height (default ~35% of viewport).
  const vh = window.innerHeight;
  const h = (userTerm.persisted && userTerm.persisted.height) || Math.floor(vh * 0.35);
  userTermApplyHeight(h);
  if (el.userTermDrawer) {
    el.userTermDrawer.classList.add("open");
    el.userTermDrawer.setAttribute("aria-hidden", "false");
  }
  if (el.userTermBtn) {
    el.userTermBtn.classList.add("active");
    el.userTermBtn.setAttribute("aria-pressed", "true");
  }
  // Update the cwd label up front so it shows immediately.
  const cwd = userTermCwd();
  if (el.userTermCwd) {
    el.userTermCwd.textContent = basename(cwd);
    el.userTermCwd.title = cwd;
  }
  // Spawn (or reuse) the shell, then mount once the drawer is laid out.
  const fresh = !userTerm.session;
  if (fresh) {
    // Pre-measure the character cell size so we can spawn the PTY at the EXACT
    // cols/rows the xterm will render. A mismatch (spawn at 90 cols, xterm
    // renders at 105) makes zsh re-render on the first fit and leave a stray
    // "%" partial-line marker. The probe uses the same font the xterm will
    // use (monospace at 13px); after mount we re-measure from the xterm's own
    // computed style to correct any discrepancy.
    const pre = measureUserTermCells();
    const w = (el.userTermMount && el.userTermMount.clientWidth) || window.innerWidth;
    const mh = (el.userTermMount && el.userTermMount.clientHeight) || Math.max(200, h - 40);
    const cols = Math.max(20, Math.floor(w / pre.cellW));
    const rows = Math.max(5, Math.floor(mh / pre.cellH));
    userTerm.lastCols = cols;   // seed so the first fit won't double-resize
    userTerm.lastRows = rows;
    await userTermSpawn({ cols, rows });
  }
  // Mount needs the drawer to be visible/sized first.
  requestAnimationFrame(async () => {
    await userTermMount();
    // A remount (drawer reopened after X-close) attaches a FRESH xterm to a
    // shell that printed its prompt long ago — that output predates the mount
    // and never reaches the new xterm, leaving a bare cursor. The shell is
    // idle at its prompt now (ZLE is in raw mode), so Ctrl+L makes zsh
    // clear-and-repaint exactly one clean prompt. We DON'T do this for a
    // fresh spawn: the line editor isn't in raw mode yet and the raw \x0c
    // byte would echo as a visible "^L" before the prompt.
    if (!fresh && userTerm.session && typeof userTerm.session.write === "function") {
      try { await userTerm.session.write("\x0c"); } catch (e) { /* non-fatal */ }
    }
    userTermFocus();
  });
  userTermPersist();
}

// CLOSE the drawer: slide it down and unmount the xterm, but keep the shell
// alive so reopening is instant. The session is killed only on app exit.
function userTermClose() {
  if (!userTerm.open) return;
  userTerm.open = false;
  if (el.userTermDrawer) {
    el.userTermDrawer.classList.remove("open");
    el.userTermDrawer.setAttribute("aria-hidden", "true");
  }
  if (el.userTermBtn) {
    el.userTermBtn.classList.remove("active");
    el.userTermBtn.setAttribute("aria-pressed", "false");
  }
  userTermUnmount();
  userTermPersist();
}

// Toggle open/closed — the single entry point for the sidebar icon + shortcut.
function userTermToggle() {
  if (userTerm.open) userTermClose();
  else userTermOpen();
}

// Focus the terminal so keystrokes go to it.
function userTermFocus() {
  if (!el.userTermMount) return;
  const xtermEl = el.userTermMount.querySelector(".xterm");
  if (xtermEl && xtermEl.focus) { try { xtermEl.focus({ preventScroll: true }); } catch (e) { /* non-fatal */ } }
}

// Restart the shell (kill + respawn + remount). Used by the Restart button.
async function userTermRestart() {
  // Unmount first and null the session so the OLD shell's onExit (which fires
  // when we kill it below) can't null out the NEW session in a race.
  userTermUnmount();
  const old = userTerm.session;
  userTerm.session = null;
  if (old) {
    try { if (old.kill) await old.kill(); } catch (e) { /* non-fatal */ }
  }
  userTerm.cwd = null;
  // Spawn at the current drawer size, measured with the same cell metrics so
  // the PTY is born correctly sized (no post-spawn resize → no "%" artifact).
  const pre = measureUserTermCells();
  const w = (el.userTermMount && el.userTermMount.clientWidth) || window.innerWidth;
  const mh = (el.userTermMount && el.userTermMount.clientHeight) || 480;
  const cols = Math.max(20, Math.floor(w / pre.cellW));
  const rows = Math.max(5, Math.floor(mh / pre.cellH));
  userTerm.lastCols = cols;
  userTerm.lastRows = rows;
  await userTermSpawn({ cols, rows });
  if (userTerm.open) await userTermMount();
  userTermFocus();
}

// "Clear" — clear the shell screen with Ctrl+L (\x0c). The host's key() API
// doesn't support 'ctrl+l' (interactive key set only), so write the control
// byte directly. We don't kill the shell — the working directory + history
// persist.
async function userTermClear() {
  if (!userTerm.session) return;
  try {
    if (typeof userTerm.session.write === "function") {
      await userTerm.session.write("\x0c");
    } else {
      await sendKey(userTerm.session, "ctrl+l");
    }
  } catch (e) { /* non-fatal */ }
}

// Horizontal drag-resize for the drawer height.
function initUserTermResizer() {
  const handle = el.userTermResizer;
  if (!handle) return;
  let dragging = false;
  let startY = 0;
  let startH = 0;

  const onMove = (clientY) => {
    if (!dragging) return;
    const delta = startY - clientY; // drag up = taller
    userTermApplyHeight(startH + delta);
  };

  handle.addEventListener("mousedown", (e) => {
    dragging = true;
    startY = e.clientY;
    startH = el.userTermDrawer.getBoundingClientRect().height;
    document.body.classList.add("is-resizing");
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => onMove(e.clientY));
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("is-resizing");
    userTermPersist();
    requestAnimationFrame(userTermFit);
  });
  // Keyboard-resizable (the handle is focusable role="separator").
  handle.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 48 : 16;
    let d = 0;
    if (e.key === "ArrowUp") d = step;
    else if (e.key === "ArrowDown") d = -step;
    else if (e.key === "Enter") { e.preventDefault(); userTermToggle(); return; }
    else return;
    e.preventDefault();
    const cur = el.userTermDrawer.getBoundingClientRect().height;
    userTermApplyHeight(cur + d);
    requestAnimationFrame(userTermFit);
  });
}

// Restore the drawer's persisted state on boot. A live PTY does not survive an
// app restart, so if it was open we respawn a fresh shell and reopen the drawer.
async function userTermRestore() {
  try {
    const saved = await window.chatoss.scopedData.get(USER_TERM_KEY);
    if (saved && typeof saved === "object") {
      userTerm.persisted = { open: !!saved.open, height: saved.height || 0 };
    }
  } catch (e) { console.warn("userTermRestore", e); }
  if (userTerm.persisted.open) {
    // Defer until after the first render so the drawer element is laid out.
    requestAnimationFrame(() => userTermOpen().catch((e) => console.warn("userTermRestore open", e)));
  }
}

// Kill the shell on app exit/close so it doesn't linger. Called from pagehide.
async function userTermShutdown() {
  await userTermKill();
}

// ---------- Init ----------
async function init() {
  // restore state + settings
  try {
    const saved = await window.chatoss.scopedData.get(STORE_KEY);
    if (saved) state = Object.assign({ projects: [], activeProjectId: null, activeConversationId: null, activeSessionId: null, termView: "squares", convShown: {}, sectionCollapsed: {} }, saved);
    if (!state.sectionCollapsed) state.sectionCollapsed = {};
  } catch (e) { console.warn("restore state", e); }
  // Hydrate conversations + messages from the private SQLite DB (the durable
  // history store). scopedData may be stale or lost after an orchestration
  // session; SQLite is authoritative for conversation history.
  await hydrateFromSqlite();
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
  // Restore persisted terminal sessions as read-only "ended" cards so the user
  // immediately sees what ran, what's finished, and the last output — even
  // though the live PTY processes are gone. (Must run AFTER loadWorktrees so
  // worktreeBranchForCwd can match against the restored worktreeMeta.)
  await loadPersistedSessions();
  // Merge in the OS-persisted terminal sessions (terminal.listSessions): the
  // OS now keeps sessions across window close AND app restart, so reattach
  // still-live ones and show ended ones as read-only cards with their saved
  // output. This is the durable store — it survives even if scopedData is lost.
  await loadPlatformSessions();
  detection = {
    codex: !!(settings.detected && settings.detected.codex),
    claude: !!(settings.detected && settings.detected.claude),
    ollama: !!(settings.detected && settings.detected.ollama),
    opencode: !!(settings.detected && settings.detected.opencode),
    models: (settings.detected && settings.detected.models) || [],
    scannedAt: 0, // force a fresh scan at startup
    denied: !!(settings.detected && settings.detected.denied),
    // Restore the resolved direct-CLI paths so the launch-target picker can
    // list claude/codex/opencode immediately on a cold start, before the fresh
    // scan finishes. detectTools refreshes these with live values shortly after.
    claudePath: (settings.detected && settings.detected.claudePath) || null,
    codexPath: (settings.detected && settings.detected.codexPath) || null,
    opencodePath: (settings.detected && settings.detected.opencodePath) || null,
  };

  // Load the model list, retrying in the background when it comes back empty.
  // On a FRESH INSTALL the OS model service can still be warming up on the very
  // first boot: listModels() then returns [] (or rejects), the picker stayed
  // empty, and the app looked model-less until a full close+reopen. Retrying
  // for ~25s and re-rendering the picker fixes the first-run experience; the
  // picker also retries lazily on focus (see the focus listener below).
  await loadModels();
  if (!models.length) scheduleModelRetries();

  // model picker change → persist on the conversation (render never mutates state)
  el.modelPicker.addEventListener("change", () => {
    const c = activeConversation();
    if (c) { c.modelId = el.modelPicker.value; saveState(); }
    renderEffortPicker();
    renderTokenEstimator();
  });
  // Lazy recovery: if the picker was opened while the model list is empty (the
  // first-install warm-up case), reload it on the spot so the dropdown fills in.
  el.modelPicker.addEventListener("focus", () => {
    if (!models.length) loadModels();
  });
  el.effortPicker.addEventListener("change", () => {
    const c = activeConversation();
    if (c) { c.effort = selectedEffort(); saveState(); }
  });

  // top bar + left column
  el.settingsBtn.addEventListener("click", openSettings);
  if (el.newChatBtn) el.newChatBtn.addEventListener("click", newChatFromTopbar);
  if (el.newProjectTopBtn) el.newProjectTopBtn.addEventListener("click", newProject);

  // middle column
  el.copyConvBtn.addEventListener("click", copyConversation);
  el.attachBoardBtn.addEventListener("click", openBoardPicker);
  if (el.detachBoardBtn) el.detachBoardBtn.addEventListener("click", detachBoard);
  if (el.addFileBtn) el.addFileBtn.addEventListener("click", addFileFromPicker);
  // Image preview modal close handlers
  if (el.imagePreviewClose) el.imagePreviewClose.addEventListener("click", closeImagePreview);
  // Drag-and-drop file import (capability "fileDrop"): any file dropped on the
  // app window is added to the chat's attachments (images show a preview strip).
  try {
    window.chatoss.files.onDrop(async (files) => {
      if (!files || !files.length) return;
      for (const f of files) await addDroppedFile(f);
    });
  } catch (e) { console.warn("onDrop not available", e); }
  el.chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = el.chatInput.value.trim();
    if (running) {
      if (text) {
        // Mid-run message: interrupt the current orchestrator turn and continue
        // with the new message (delivered as a fresh turn, not a plain stop).
        interruptAndSend(text);
      } else if (abortController) {
        abortController.abort(); // plain stop — no new message
      }
      return;
    }
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
  el.chatInput.addEventListener("input", () => {
    autoResizeInput();
    // While a turn runs the send button doubles as Stop; typing flips it back
    // to Send so the user can see their message will be delivered.
    syncSendButton();
    renderTokenEstimator();
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

  // right column — view-mode switcher (squares / columns / rows)
  if (el.termViewSwitcher) {
    el.termViewSwitcher.addEventListener("click", (e) => {
      const btn = e.target.closest && e.target.closest(".term-view-btn");
      if (!btn) return;
      const view = btn.dataset.view;
      if (!view || view === state.termView) return;
      setTermView(view);
    });
  }

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
  el.alwaysModel.addEventListener("change", () => { syncEffortRows(); saveModelSelectionMode(); });
  el.complexityModelLow.addEventListener("change", () => { syncEffortRows(); saveModelSelectionMode(); });
  el.complexityModelMedium.addEventListener("change", () => { syncEffortRows(); saveModelSelectionMode(); });
  el.complexityModelHigh.addEventListener("change", () => { syncEffortRows(); saveModelSelectionMode(); });
  // Effort selects write straight into the per-target map (persisted live).
  bindEffortSelect(el.alwaysEffort, el.alwaysModel);
  bindEffortSelect(el.complexityEffortLow, el.complexityModelLow);
  bindEffortSelect(el.complexityEffortMedium, el.complexityModelMedium);
  bindEffortSelect(el.complexityEffortHigh, el.complexityModelHigh);

  el.rescanBtn.addEventListener("click", async () => {
    el.detectedList.innerHTML = "<div class='detected-scanning'>Scanning…</div>";
    await detectTools(true);
    renderDetectedList();
    // refresh the model pickers with the newly detected models, preserving
    // the saved selections where the model is still available.
    applyModelSelectionModeToUi();
  });

  // updates (Settings → Check for updates)
  el.checkUpdatesBtn.addEventListener("click", checkForUpdates);
  el.openReleasesBtn.addEventListener("click", openReleasesPage);

  // board picker
  el.boardPickerX.addEventListener("click", () => el.boardPicker.classList.add("hidden"));

  // Token estimator — toggle popover on click, close on outside click.
  if (el.tokenEstimatorBtn) {
    el.tokenEstimatorBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleTokenPopover();
    });
  }
  document.addEventListener("click", (e) => {
    if (!el.tokenPopover || el.tokenPopover.hidden) return;
    if (el.tokenEstimator && el.tokenEstimator.contains(e.target)) return;
    closeTokenPopover();
  });

  // history browser (past conversations + terminal sessions)
  initHistoryBrowser();

  // backdrop click closes modals
  for (const [modal, closer] of [
    [el.spawnModal, onSpawnCancel],
    [el.settingsPanel, () => el.settingsPanel.classList.add("hidden")],
    [el.boardPicker, () => el.boardPicker.classList.add("hidden")],
    [el.historyModal, closeHistoryBrowser],
    [el.imagePreviewModal, closeImagePreview],
  ]) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal || (e.target.classList && e.target.classList.contains("tc-backdrop"))) closer();
    });
  }

  // Esc closes any open modal (spawn first — its wait must resolve)
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!el.spawnModal.classList.contains("hidden")) onSpawnCancel();
    else if (!el.settingsPanel.classList.contains("hidden")) el.settingsPanel.classList.add("hidden");
    else if (!el.boardPicker.classList.contains("hidden")) el.boardPicker.classList.add("hidden");
    else if (!el.historyModal.classList.contains("hidden")) closeHistoryBrowser();
    else if (el.imagePreviewModal && !el.imagePreviewModal.classList.contains("hidden")) closeImagePreview();
    else if (el.tokenPopover && !el.tokenPopover.hidden) closeTokenPopover();
  });

  // column resizers (restores any saved layout)
  initColumnResizers();
  // terminal resize handles (columns width / rows height) — delegated on the grid
  initTermResize();

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
      // Keep the user terminal's PTY fitted when the window changes too.
      if (userTerm.open) requestAnimationFrame(userTermFit);
    }, 120);
  });

  // ---- User terminal (bottom drawer) wiring ----
  // Toggled by the sidebar footer icon OR the Cmd/Ctrl+J shortcut. Entirely
  // user-driven — the orchestrator never touches it.
  if (el.userTermBtn) el.userTermBtn.addEventListener("click", userTermToggle);
  if (el.userTermClose) el.userTermClose.addEventListener("click", userTermClose);
  if (el.userTermClear) el.userTermClear.addEventListener("click", () => userTermClear().catch((e) => console.warn("userTermClear", e)));
  if (el.userTermRestart) el.userTermRestart.addEventListener("click", () => userTermRestart().catch((e) => console.warn("userTermRestart", e)));
  initUserTermResizer();

  // Cmd+J (mac) / Ctrl+J toggles the bottom drawer. Only fires on the modifier
  // combo — a plain "j" while typing in any input (including the orchestrator's
  // chat box) must never toggle, so we require metaKey OR ctrlKey explicitly.
  document.addEventListener("keydown", (e) => {
    const isCombo = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey &&
      (e.key === "j" || e.key === "J" || e.code === "KeyJ");
    if (!isCombo) return;
    e.preventDefault();
    userTermToggle();
  });

  // Cmd+N (mac) / Ctrl+N — new chat in the current project, same as the
  // top-bar "New chat" button and the + on a project row. Repeated presses
  // reuse the one empty draft until a post is made (see newConversation).
  document.addEventListener("keydown", (e) => {
    const isCombo = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey &&
      (e.key === "n" || e.key === "N" || e.code === "KeyN");
    if (!isCombo) return;
    e.preventDefault();
    newChatFromTopbar();
  });

  // Wake the orchestrator when a delegated agent finishes its turn.
  startAutoFollow();

  // Periodic session health check: detect stalled agents (quiet but still
  // WORKING/STARTING) and nudge them back to life, or surface them so the user
  // can intervene. Runs every HEALTH_CHECK_MS while the app is open.
  setInterval(() => {
    runHealthCheck().catch((e) => console.warn("healthCheck", e));
  }, HEALTH_CHECK_MS);

  // Best-effort final flush of session snapshots when the app is closed or
  // hidden, so the Sessions column survives a close/reopen with the LATEST
  // output rather than whatever the debounced save last happened to write.
  // pagehide is the reliable signal (fires for both tab close and navigation);
  // beforeunload covers older browsers. visibilitychange covers the app being
  // backgrounded (the window may be torn down without a pagehide). These all
  // schedule an eager persistSessions() (canceling any pending debounce) — we
  // don't await inside the listener because pagehide may not wait on promises.
  const flushSessions = () => {
    // Cancel a pending debounced flush and run an immediate one instead.
    if (_persistSessionsTimer) { clearTimeout(_persistSessionsTimer); _persistSessionsTimer = null; }
    persistSessions().catch((e) => console.warn("flushSessions", e));
    userTermPersist();
    // Also flush the SQLite conversation mirror immediately (cancel the
    // debounce) so the very last message of a session is not lost to the
    // 700ms timer when the window closes right after it.
    if (_sqliteSyncTimer) { clearTimeout(_sqliteSyncTimer); _sqliteSyncTimer = null; }
    syncConversationsToSqlite().catch((e) => console.warn("flushSqliteSync", e));
  };
  // Kill the user's shell ONLY on a real app close — NOT on visibilitychange.
  // On macOS, swiping to another Space fires visibilitychange("hidden"); if we
  // killed the shell there, the prompt would vanish when the user swiped back.
  // The shell must stay alive (and its xterm mounted) until the user closes the
  // drawer with the × button, or the app actually quits.
  const flushAndShutdown = () => {
    flushSessions();
    userTermShutdown().catch((e) => console.warn("userTermShutdown", e));
  };
  window.addEventListener("pagehide", flushAndShutdown);
  window.addEventListener("beforeunload", flushAndShutdown);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flushSessions();
    } else if (document.visibilityState === "visible" && userTerm.open) {
      // Coming back from another Space: the shell + xterm persisted, but the
      // window dimensions may have shifted while we were away — refit so the
      // prompt stays correctly laid out.
      requestAnimationFrame(() => userTermFit());
    }
  });

  // initial render
  renderProjects();
  renderChat();
  renderSessionInfo();
  renderTokenEstimator();
  // Code editor column: bind events + restore the saved width (the pane stays
  // hidden until a file is opened).
  if (settings.editorWidth) editorState.size = settings.editorWidth;
  initEditor();
  // Render restored (persisted) terminal sessions as ended cards BEFORE the
  // empty-state check, so a reopen with prior sessions shows them instead of
  // "No active sessions". Newest first so the most recent work is on top.
  if (deadSessions.size) {
    const snaps = [...deadSessions.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    for (const snap of snaps) renderDeadSessionCard(snap);
  }
  ensureEmptyHint();
  // Apply the saved view mode (defaults to "squares") to the grid + switcher.
  setTermView(state.termView || "squares");
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

  // Restore the user terminal drawer if it was open on the last run. Done last
  // so the app's main layout is fully laid out before the drawer slides up.
  userTermRestore().catch((e) => console.warn("userTermRestore", e));
}

init().catch((e) => {
  console.error(e);
  el.loading.textContent = "Failed to start: " + (e && e.message ? e.message : String(e));
});
