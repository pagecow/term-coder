// Tests for the 7 platform-bug fixes (all app-level — the platform already
// provides isWaitingForInput/onStateChange/onDegenerateOutput; the app just
// never used them):
//
//   1. Idle detection: sessionActivity now trusts the platform PTY state
//      (ptyIdle) so opencode/codex sessions flip to IDLE when they finish.
//   2. Health check: runHealthCheck nudges stalled sessions + health_check tool.
//   3. Degenerate output: onDegenerateOutput subscription + status surfacing.
//   4. Remember defaults: start_cli_session skips the spawn modal when a
//      default launch is pinned.
//   5. Worktree git status tool + auto-commit on session close.
//   6. spawn_batch tool (one call spawns all parallel subtasks).
//   7. Default agents list: ollama launch first, only opencode/claude/codex.
const fs = require("fs");
const path = require("path");
const { assert, test, run } = require("./harness");
const { allModulesSrc } = require("./module-src.js");

const SRC = allModulesSrc();
const HTML = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

// ---------------------------------------------------------------------------
// 1. Idle detection via platform PTY state
// ---------------------------------------------------------------------------

test("sessionActivity treats ptyIdle as IDLE (with the trust-dialog guard)", () => {
  assert(/s\.ptyIdle && !trustBlocked/.test(SRC),
    "sessionActivity must accept ptyIdle as the idle signal");
  assert(/const trustBlocked = s\.trustState === "pending" \|\| s\.trustState === "asking"/.test(SRC),
    "ptyIdle must not read as IDLE while the trust dialog is up");
});

test("registerSession wires the platform PTY state (onStateChange + isWaitingForInput poll)", () => {
  assert(/session\.onStateChange\(/.test(SRC), "must subscribe onStateChange");
  assert(/session\.isWaitingForInput\(\)/.test(SRC), "must poll isWaitingForInput");
  assert(/w === true/.test(SRC) && /w === false/.test(SRC),
    "must handle the three-state result (true/false/'unsupported')");
  assert(/ptyPollTimer = setInterval\(pollPty, 10000\)/.test(SRC),
    "must poll the PTY state on a timer (covers restored sessions)");
});

// ---------------------------------------------------------------------------
// 2. Health check
// ---------------------------------------------------------------------------

test("runHealthCheck detects stalls and nudges with the are-you-working prompt", () => {
  assert(/async function runHealthCheck\(\)/.test(SRC), "runHealthCheck missing");
  assert(/STALL_QUIET_MS/.test(SRC), "stall threshold missing");
  assert(/are you still working\? continue/.test(SRC), "nudge text missing");
  assert(/rec\.session\.paste\(TC\.NUDGE_TEXT\)/.test(SRC), "nudge must paste the text");
  assert(/rec\.session\.key\("enter"\)/.test(SRC), "nudge must press enter");
  assert(/NUDGE_COOLDOWN_MS/.test(SRC), "nudges must be rate-limited");
  assert(/setInterval\(\(\) => \{\s*TC\.runHealthCheck\(\)/.test(SRC),
    "the health check must run on a timer");
});

test("health_check tool is defined and handled", () => {
  assert(/name: "health_check"/.test(SRC), "health_check schema missing");
  assert(/case "health_check":/.test(SRC), "health_check handler missing");
});

// ---------------------------------------------------------------------------
// 3. Degenerate output recovery
// ---------------------------------------------------------------------------

test("registerSession subscribes onDegenerateOutput and interrupts on fire", () => {
  assert(/session\.onDegenerateOutput\(/.test(SRC), "must subscribe onDegenerateOutput");
  assert(/rec\.degenerate = true/.test(SRC), "must flag the session");
  assert(/session\.key\("ctrl\+c"\)/.test(SRC), "must interrupt with ctrl+c");
});

test("degenerate state is surfaced to the orchestrator", () => {
  assert(/DEGENERATE OUTPUT/.test(SRC), "status output must surface the degenerate state");
  assert(/close_session and respawn/.test(SRC), "status must tell the orchestrator to respawn");
});

// ---------------------------------------------------------------------------
// 4. Remember defaults — skip the modal when a default is pinned
// ---------------------------------------------------------------------------

test("start_cli_session skips the spawn modal when a default launch is pinned", () => {
  assert(/const defId = TC\.cliDefaultToTargetId\(TC\.settings\.cliDefault\)/.test(SRC),
    "start_cli_session must read the saved default");
  assert(/using your saved default launch — no dialog shown/.test(SRC),
    "the skip path must report that no dialog was shown");
});

// ---------------------------------------------------------------------------
// 5. Worktree git status tool + auto-commit on close
// ---------------------------------------------------------------------------

test("worktree_git_status tool is defined and handled", () => {
  assert(/name: "worktree_git_status"/.test(SRC), "worktree_git_status schema missing");
  assert(/case "worktree_git_status":/.test(SRC), "worktree_git_status handler missing");
  assert(/git status --porcelain/.test(SRC), "must show uncommitted changes");
  assert(/git diff --stat/.test(SRC), "must show a diff stat");
});

test("closeSession auto-commits the worktree so a killed agent's work is resumable", () => {
  assert(/WIP: commit uncommitted work before closing/.test(SRC),
    "closeSession must commit the worktree's uncommitted work");
  assert(/worktreeBranchForCwd\(rec\.cwd\)/.test(SRC),
    "the auto-commit must detect the worktree from the session cwd");
});

// ---------------------------------------------------------------------------
// 6. Batch spawn
// ---------------------------------------------------------------------------

test("spawn_batch tool is defined and handled", () => {
  assert(/name: "spawn_batch"/.test(SRC), "spawn_batch schema missing");
  assert(/case "spawn_batch":/.test(SRC), "spawn_batch handler missing");
  assert(/at most 8 tasks per batch/.test(SRC), "batch size must be capped");
  assert(/BATCH SPAWN/.test(SRC), "batch result summary missing");
});

test("spawn_batch creates a worktree AND spawns a session per task in one call", () => {
  assert(/git worktree add/.test(SRC), "batch must create worktrees");
  assert(/spawnChosen\(\{ cli, cwd: wtPath, prompt, target \}\)/.test(SRC),
    "batch must spawn each agent in its worktree");
  assert(/worktreeMeta\.set\(branch, \{ wtPath, parentBranch: mainBranch, projectPath: base \}\)/.test(SRC),
    "batch must track worktree metadata for later merges");
});

test("spawn modal supports batchMode (one choice, no session spawned)", () => {
  assert(/spawnModalOpts && spawnModalOpts\.batchMode/.test(SRC),
    "onSpawnStart must resolve without spawning in batch mode");
  assert(/batchMode: true/.test(SRC), "spawn_batch must open the modal in batch mode");
});

// ---------------------------------------------------------------------------
// 7. Default agents list — ollama launch first, only 3 targets
// ---------------------------------------------------------------------------

test("Settings default-agent picker lists ollama launch first, only opencode/claude/codex", () => {
  const setCli = HTML.slice(HTML.indexOf('<select id="set-cli"'), HTML.indexOf("</select>", HTML.indexOf('<select id="set-cli"')) + 9);
  const values = [...setCli.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(values, ["ask", "opencode", "claude", "codex", "raw:opencode", "raw:claude", "raw:codex"],
    "set-cli options drifted: " + JSON.stringify(values));
  assert(!/chatgpt|hermes|copilot/.test(setCli), "chatgpt/hermes/copilot must be gone from the picker");
});

test("buildCliOptions offers direct binaries in opencode, claude, codex order", () => {
  const fn = SRC.slice(SRC.indexOf("function buildCliOptions"), SRC.indexOf("function syncSpawnModelRow"));
  const order = [];
  for (const m of fn.matchAll(/push\("raw:([a-z]+)"/g)) order.push(m[1]);
  assert.deepStrictEqual(order, ["opencode", "claude", "codex"],
    "direct-binary order drifted: " + JSON.stringify(order));
});

run();
