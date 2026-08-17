# Term Coder — Read-Only Code Audit

**Scope:** `app.js` (6,378 lines), plus `app.json` / `index.html` for manifest and load-path verification.
**Mode:** READ-ONLY. No application code was modified. This is a findings report + prioritized fix list for user approval before any edits.
**Auditor pass:** single continuous read of the key areas listed in the task, cross-checked against the four known bugs.

---

## Summary

Term Coder is a mature, defensively-coded orchestrator. The four "known bugs" the task asked me to cross-check are **all already fixed** in the current code, and in several cases the fix is documented inline with the bug number (e.g. `// BUG 1 FIX`, `// BUG 2 FIX`). The remaining findings are smaller: one genuine race condition (premature auto-follow wake during the trust/startup window), shell-injection inconsistencies in the worktree git commands, debug logging left in a hot path, an unkillable `setInterval`, a couple of dead-config items, and two platform features the app does not yet adopt (OS-level terminal-session persistence and the `sqlite` capability).

The trust handling, model selection, prompt submission, session lifecycle, and persistence (scopedData snapshots of live + dead sessions) are all sound. State is restored in the correct order at boot, gated calls are wrapped in try/catch, and the universal terminal monitor has watchdogs on every latching flag so a missed answer can never permanently blind the orchestrator.

### Verdict on the four known bugs

| # | Bug | Status | Evidence |
|---|-----|--------|----------|
| 1 | `trustMode "Ask each time"` ignored — trust auto-confirmed without asking | **FIXED** | `autoDriveStartup` `handleTrust()` re-reads `trustMode` fresh from scopedData (`loadTrustMode()`, app.js:1291) before branching; the `"ask"` branch `await`s `askTrustInChat()` (app.js:1301) and only confirms/denies after the user answers; only the `"always"` branch auto-confirms (app.js:1292-1298). The 12s safety timeout is explicitly blocked while `trustBusy` or `sawTrust && !trustHandled` (app.js:1410-1412). `loadTrustMode()` runs in `init()` before any session can spawn (app.js:6083). `send_to_session` also hard-blocks trust-bypassing keystrokes (app.js:1697). |
| 2 | Codex prompt typed but Enter never pressed (`write(text+'\r')`) | **FIXED** | Task submission uses `sendText(session, payload)` then `sendKey(session, "enter")` (app.js:1220/1233). `sendText` uses `session.paste()` (app.js:1012) and `sendKey` uses `session.key()` (app.js:1000); `write()` is only a legacy fallback when the host lacks `key`/`paste`. No `write(text + '\r')` pattern exists anywhere (grep confirms the only remaining `write()` calls are legacy fallbacks and `"\x0c"` Ctrl-L clears). Multi-line payloads are flattened only when bracketed-paste is off (app.js:1218-1219). |
| 3 | OS-level terminal persistence (`listSessions`/`attachSession`/`reattachSession`/`killSession`) | **NOT ADOPTED** | grep for all four APIs returns no matches. The app rolls its own equivalent: a `deadSessions` map + `persistSessions()`/`loadPersistedSessions()` that snapshot live+dead sessions to `scopedData` (`term-coder.sessions`) and restore them as read-only "ended" cards. This works but cannot reattach to a still-running PTY after reopen (see Finding F8). |
| 4 | `sqlite` capability for conversation/terminal history | **NOT ADOPTED** | `app.json` capabilities are `["chatApi","terminal","fileAccess","boards","notifications","clipboardWrite"]` — no `sqlite`. No `window.chatoss.db.*` calls exist. All persistence is `scopedData` key/value blobs (`STORE_KEY`, `SETTINGS_KEY`, `WORKTREES_KEY`, `SESSIONS_KEY`, plus per-field model-selection keys). See Finding F9. |

---

## Bugs found

### B1 — Premature auto-follow wake during the trust / pre-submission window
- **Severity:** P1 (spurious orchestrator turn; defended against real damage by the send_to_session trust guard, but burns a turn and can mislead the model)
- **Location:** universal monitor idle detector `app.js:5216-5229`; `sessionActivity` `app.js:159-172`; `autoFollowTick` `app.js:4743-4774`
- **Description:** The idle detector arms a 5s timer whenever it sees a prompt cursor and `!autoApproveBusy && !waitingForInput && !_idleTimer` (app.js:5216). It does **not** check `rec.trustState`. During the folder-trust dialog (which is quiet — no spinner), the terminal shows a prompt cursor, so after 5s the monitor sets `rec.waitingForInput = true` with the "(agent appears idle…)" message (app.js:5222-5224). Because `sessionActivity()` ranks `waitingForInput` above the `taskSubmittedAt` check (app.js:166 returns `"NEEDS INPUT"` before the `!s.taskSubmittedAt` branch at app.js:168), a session whose task was **never submitted yet** is reported as `NEEDS INPUT`. `autoFollowTick` then fires a "agent X is BLOCKED waiting for input" wake (app.js:4763-4765) the moment `fromOrchestrator` is set (app.js:1677) and the first classification was already recorded (`wasReported !== undefined`, app.js:4758).
- **Net effect:** while the user is still answering the trust pill picker, the orchestrator can be woken with a "BLOCKED" event for an agent that hasn't received its task. The orchestrator's attempt to send keystrokes is correctly blocked by the trust guard (app.js:1697), but it still consumes a model turn and may emit a confused message.
- **Suggested fix:** (a) add `&& rec.trustState !== "pending" && rec.trustState !== "asking"` to the idle-detector arm condition at app.js:5216, and/or (b) in `autoFollowTick`, skip sessions where `rec.taskSubmittedAt === 0` (a task that was never submitted cannot have "finished its turn"). Either alone closes the hole; both is belt-and-suspenders.

### B2 — Shell-injection inconsistency in `create_worktree`
- **Severity:** P2 (the model supplies `branchName`; a malicious/quirky value could inject shell tokens)
- **Location:** `toolHandler` `create_worktree`, app.js:1474
- **Description:** The `git worktree add` command interpolates `branch` and `mainBranch` with bare double-quotes inside a `zsh -lic "…"` wrapper:
  ```js
  loginShell(`git worktree add "${wtPath}" -b "${branch}" "${mainBranch}"`)
  ```
  Double quotes do not protect against `$`, backticks, or `"` in the value. The sibling `merge_worktree` case correctly uses `JSON.stringify(parentBranch)` / `JSON.stringify(branch)` (app.js:1538). `branchName` comes from the orchestrator model, so it is not fully trusted input.
- **Suggested fix:** use `JSON.stringify(branch)` and `JSON.stringify(mainBranch)` (and `wtPath`) consistently, exactly as `merge_worktree` already does. Also consider validating `branchName` against a git-ref-safe regex (`^[A-Za-z0-9._/-]+$`) before use.

### B3 — Silent session cancellation when Manual model mode has no detected models
- **Severity:** P3 (UX gap, no data loss)
- **Location:** `resolveSessionModel` manual branch app.js:2511-2517; `onSpawnStart` app.js:2086-2090
- **Description:** In Manual mode with zero available models, `resolveSessionModel` returns `null` (app.js:2512). `onSpawnStart` then calls `closeSpawnModal(null)` and returns (app.js:2088) — but the spawn modal was already hidden at app.js:2079 to make room for the pill picker, so the user sees the modal simply disappear with **no explanation**. The same silent-cancel happens in Always mode when no `alwaysModel` is configured and no models are detected (app.js:2493).
- **Suggested fix:** before hiding the modal (or on the `!model` path), set `el.spawnStatus.textContent` to an actionable message ("No models detected — run Re-scan in Settings, or switch Model Selection Mode") and keep the modal visible so the user can cancel/retry, rather than auto-dismissing.

### B4 — `send_to_session` reads the full session output on every call to check for trust text
- **Severity:** P3 (latency/context cost, not correctness)
- **Location:** `toolHandler` `send_to_session`, app.js:1693-1697
- **Description:** To decide whether to block trust-bypassing keystrokes, the handler does `await s.session.getOutput()` and `stripAnsi()`s the **entire** scrollback on every invocation (app.js:1694-1695), then regex-tests it. This is O(scrollback) per tool call and duplicates work the monitor already does. `rec.trustState` already tracks this exactly ("pending"/"asking").
- **Suggested fix:** gate on `s.trustState === "pending" || s.trustState === "asking"` (which the monitor + autoDriveStartup maintain) and drop the full-output read; fall back to the output read only if `trustState` is unexpectedly unset.

---

## Dead code

### D1 — "Live bridge probe" debug logging in `detectTools`
- **Location:** app.js:758-766
- **Description:** Every `detectTools()` run (startup, re-scan, and every `openSpawnModal` via `detectTools(false)`) logs `window.chatoss.terminal keys` and a per-method `typeof` check to the console, and stashes the result on `detection.bridge`. The `checks` array (app.js:762) tests session-level methods (`onData`, `onExit`, `write`, `resize`, `kill`) against the **terminal namespace** object, so those always log `undefined` — the probe is partly wrong as well as noisy.
- **`detection.bridge` is never read** (grep confirms only the write at app.js:766). Dead state.
- **Suggested fix:** remove the block (app.js:758-766) entirely, or gate it behind a debug flag. Keep `renderDetectedList()`/`applyModelSelectionModeToUi()` which follow it.

### D2 — `OLLAMA_LAUNCH_TOOLS` lists two tools the UI never offers
- **Location:** constant app.js:17; `buildCliOptions` app.js:1967-1972
- **Description:** `OLLAMA_LAUNCH_TOOLS` has 8 entries (`… "openclaw", "opencode", … "droid"`), but `buildCliOptions` only pushes 6 (`claude`, `codex`, `chatgpt`, `hermes`, `opencode`, `copilot`). `openclaw` and `droid` are in the constant but never appear in the spawn dropdown. (`opencode` is offered; `openclaw` is not.)
- **Suggested fix:** either add the missing tools to `buildCliOptions` or trim the constant to match, so the constant is a true source of truth.

### D3 — Unkillable status-refresh `setInterval`
- **Location:** `startAutoFollow`, app.js:4782-4784
- **Description:** A second `setInterval(() => { … paintProjSessions(); }, 2000)` is created with no handle stored, so it can never be cleared. `startAutoFollow` guards against double-creation via `autoFollowTimer` (app.js:4777), so only one instance is created per load — but it runs for the entire app lifetime with no teardown, unlike `autoFollowTimer` which is at least clearable in principle.
- **Suggested fix:** store the handle (`const statusRefreshTimer = setInterval(...)`), and clear both timers together if/when auto-follow is ever torn down (e.g. on a future "disable auto-follow" path). Low priority given the app is single-page and long-lived.

---

## Fragile state / race conditions

### R1 — Two concurrent `onData` watchers during startup (intentional but ordering-sensitive)
- **Location:** `registerSession` monitor app.js:5059; `autoDriveStartup` watcher app.js:1316
- **Description:** Each spawned session has **two** `session.onData` subscriptions until the task is submitted: the universal monitor (set up in `registerSession`) and the startup watcher (set up in `autoDriveStartup`). This is deliberate — the monitor owns approvals/idle/errors, startup owns trust/model-loading/ready-state. It works because the monitor explicitly refuses to act on trust text (`classifyApprovalPrompt` returns `null` for trust dialogs, app.js:4988) and startup pauses via `trustBusy`. The fragility is that correctness depends on this exclusion being maintained in two places; the idle detector's missing `trustState` guard (B1) is exactly such a lapse. No change needed beyond B1, but worth a comment cross-linking the two watchers.

### R2 — `finish()` references `rec`/`unsub` before their declaration line
- **Location:** `autoDriveStartup`, `finish()` at app.js:1183-1241 references `rec` (declared app.js:1282) and `unsub` (declared app.js:1313)
- **Description:** `finish` is a closure that reads `rec` and `unsub`, both declared with `const` *after* `finish` in the function body. This is safe only because `finish` is never called synchronously before those lines execute (it is invoked from the `onData` callback or the 12s `setTimeout`, both async). It is correct under TDZ semantics but fragile — a future refactor that calls `finish()` earlier would throw `ReferenceError: Cannot access 'rec' before initialization`.
- **Suggested fix:** hoist `const rec = sessions.get(session.id)` (and the `rec.trustState`/`rec.trustMode` setup) above `finish`, or move `finish` below the `unsub` declaration. Low priority; purely defensive.

### R3 — `loadTrustMode()` re-read is awaited after setting `trustBusy`, but `trustMode` is a module-level mutable
- **Location:** `handleTrust`, app.js:1288-1311
- **Description:** The design is careful: `trustBusy = true` is set before the first `await` (app.js:1289) so the `onData` watcher pauses during the fresh `loadTrustMode()` read. `trustMode` is a module-level `let` shared by all sessions, so if two sessions hit their trust dialog simultaneously, the second `loadTrustMode()` can overwrite the first's value between the first's read and its branch. In practice sessions trust one-at-a-time and `trustMode` only changes via the Settings UI (`saveTrustMode`), so this is unlikely to bite — but it is a shared-mutable race by construction.
- **Suggested fix:** capture `const mode = trustMode;` immediately after `loadTrustMode()` and branch on the local `mode` rather than re-reading the shared `trustMode` in the `ask`/`always` checks. Minimal change, removes the shared-mutable read window.

### R4 — `assessComplexity` is keyword-based and can mis-map "low" tasks that mention one medium verb
- **Location:** app.js:2421-2472
- **Description:** Not a bug per se — the heuristic is well-reasoned and the inline comments explain why length is not used as a proxy. The one fragile spot: a pure read task that also contains a single `MUTATE` word (e.g. "read the auth module and *fix* the typo in a comment") falls through the `INSPECT && !MUTATE` fast path (app.js:2445) and is scored as medium/high. This only affects which model is auto-selected in Complexity mode; it never blocks or crashes.
- **Suggested fix:** none required; note for awareness. If tighter mapping is wanted, require ≥2 distinct MUTATE verbs before leaving the "low" branch.

### R5 — `buildSystemPrompt` reads every live session's full output via `getOutput()` each turn
- **Location:** app.js:4387-4393
- **Description:** The per-turn live snapshot does `await s.session.getOutput()` for every session (app.js:4390) and strips ANSI, to include the last 12 screen lines in the system prompt. This is an async PTY read per session per turn. It is bounded (12 lines kept) and wrapped in try/catch, so it is not a correctness bug, but on N sessions it adds N round-trips to every orchestrator turn and the universal monitor already maintains `lastOutputAt`/idle state. The snapshot is genuinely useful (the prompt explicitly tells the model to read it first), so this is a latency observation, not a defect.
- **Suggested fix:** optional — cache the stripped tail in the monitor (it already processes every chunk) and read from `rec._lastCleanTail` instead of re-fetching. Only worth doing if turn latency with many sessions becomes a problem.

---

## Platform features not yet adopted

### F8 — OS-level terminal-session persistence (`listSessions` / `attachSession` / `reattachSession` / `killSession`)
- **Current behavior:** the app persists **snapshots** (status + last ~6KB of output) to `scopedData` and restores them as read-only "ended" cards (`loadPersistedSessions`, app.js:376-403). A live session killed by an app restart becomes a dead card — it cannot be reattached.
- **Opportunity:** ChatOSS now persists terminal sessions at the OS level. `reattachSession(id)` could turn a "session ended" card back into a **live** terminal after reopen when the underlying PTY is still running, and `listSessions()` could reconcile the app's `deadSessions` map with sessions the OS knows are still alive (e.g. after a ChatOSS restart rather than a full quit). `killSession(id)` would let the app clean up orphaned OS sessions it no longer tracks.
- **Caveat:** the app's snapshot model is a deliberate, simple fallback that always works. Adopting OS persistence is an enhancement, not a fix; it should layer on top of the existing snapshots (snapshots still cover the full-quit case where PTYs are gone).

### F9 — `sqlite` capability for conversation + terminal history
- **Current behavior:** all state is `scopedData` key/value blobs — `term-coder.state` (projects/conversations/messages), `term-coder.sessions` (session snapshots), `term-coder.worktrees`, plus per-field model-selection keys. Conversation messages (including full orchestrator turns with `toolCalls` results) live inside the `state` blob and are read/written wholesale by `saveState()` (app.js:611).
- **Opportunity:** as conversations grow, the single `STORE_KEY` blob gets large and is rewritten in full on every `saveState()`. The `sqlite` capability (`window.chatoss.db.open/exec/query/close`) would let conversations/messages and session-output history be row-addressable and incrementally written, reducing per-turn write cost and enabling history search/pruning without loading the whole blob. `app.json` would add `"sqlite"` to `capabilities` (no prompt; declare-only).
- **Caveat:** a real migration (move messages to SQLite, keep `state` for lightweight prefs) is non-trivial and should be its own task with a one-time migration from the existing `scopedData` blob. Not a defect — a scalability path.

---

## Prioritized fix list

### P0 — none
No correctness or data-loss bugs were found. The four known bugs are already fixed. Nothing here blocks normal use.

### P1
1. **B1 — Premature auto-follow wake during trust/pre-submission window.** Add a `trustState` guard to the idle detector (app.js:5216) and/or a `taskSubmittedAt === 0` guard to `autoFollowTick`. Prevents spurious orchestrator turns while the user is approving trust. *(User action: approve the fix approach.)*

### P2
2. **B2 — `create_worktree` shell-injection inconsistency.** Switch the `git worktree add` line (app.js:1474) to `JSON.stringify(...)` for `branch`/`mainBranch`/`wtPath` to match `merge_worktree`, and optionally validate `branchName`.
3. **D1 — Remove the `detectTools` "live bridge probe" debug logging** (app.js:758-766) and the dead `detection.bridge` field. Runs on every detection; partly incorrect and never consumed.
4. **R3 — Capture `trustMode` into a local after `loadTrustMode()`** in `handleTrust` (app.js:1291-1298) to close the shared-mutable read window for concurrent trust dialogs.

### P3
5. **B3 — Silent cancel when Manual/Always mode has no models.** Show an actionable status message instead of auto-dismissing the spawn modal (app.js:2086-2090 / 2512 / 2493).
6. **B4 — `send_to_session` full-output trust check.** Gate on `rec.trustState` instead of re-reading the whole scrollback per call (app.js:1693-1697).
7. **D2 — `OLLAMA_LAUNCH_TOOLS` vs `buildCliOptions` mismatch.** Reconcile the constant (8 tools) with the offered options (6).
8. **D3 — Store the status-refresh `setInterval` handle** so it can be cleared (app.js:4782-4784).
9. **R2 — Hoist `rec`/`unsub` declarations above `finish()`** in `autoDriveStartup` to remove the TDZ-ordering fragility (app.js:1183 vs 1282/1313).
10. **R5 (optional) — Cache stripped session tails in the monitor** to avoid N `getOutput()` round-trips per turn in `buildSystemPrompt` (app.js:4390). Only if multi-session turn latency is observed.

### Enhancement track (separate tasks, not bug fixes)
- **F8 — Adopt OS-level terminal persistence** (`listSessions`/`attachSession`/`reattachSession`/`killSession`) to reattach still-running PTYs after an app reopen, layered on top of the existing snapshot fallback.
- **F9 — Adopt the `sqlite` capability** for conversation/message and session-history storage to replace wholesale `scopedData` blob rewrites as conversations grow (requires a one-time migration).

---

## Verification notes (what I read, by line range)

- State + persistence: `saveWorktrees` 259-275, `persistSessions`/`schedulePersistSessions` 311-370, `loadPersistedSessions` 376-403, `saveState`/`saveSettings` 611-618, `init` restore order 6042-6099, flush-on-close 6296-6333.
- Trust handling: `autoDriveStartup` 1129-1413 (incl. `handleTrust` 1288-1311, `confirmTrust`/`denyTrust` 1246-1257, safety timeout 1410-1412), `loadTrustMode`/`persistTrustMode`/`applyTrustModeToUi`/`saveTrustMode` 2321-2343, `askTrustInChat` 2369-2384, `send_to_session` trust guard 1689-1699, monitor trust exclusion 4983-4988 + 5085-5086.
- Prompt submission: `sendText`/`sendKey`/`hasNativeInput`/`bracketedPasteOn` 995-1029, `finish()` 1183-1241, `parseTerminalEscapes` 1043-1062.
- Model selection: `loadModelSelection` 2309-2317, `getModelSelectionConfig` 2388-2398, `resolveSessionModel` 2477-2518, `assessComplexity` 2421-2472, `availableOllamaModels` 2235-2238, `onSpawnStart` 2063-2118, `spawnChosen` 2124-2169.
- Tools: `toolHandler` 1427-2169 (`create_worktree` 1431-1485, `merge_worktree` 1486-1548, `start_cli_session` 1632-1683, `send_to_session` 1684-1771, `read_session` 1772-1781, `list_sessions` 1782-1810, `wait_for_session` 1811-1870+), `ORCHESTRATOR_TOOLS` schema 771+, `runToolWithTimeout` 4457-4473.
- Monitor + lifecycle: `registerSession` 4849-5291 (universal monitor 5050-5232, idle detector 5216-5229, exit callback 5248-5273), `closeSession` 5313-5333, `fitTerminal` 5293-5303.
- Orchestration loop: `buildSystemPrompt` 4208-4456 (live snapshot 4352-4425), `sendMessage`/`runTurn` 4488-4730, `autoFollowTick`/`startAutoFollow` 4743-4785, `newConversation` 3393-3403.
- User terminal: `userTermSpawn`/`userTermMount` 5660-5720 (write `"\x0c"` clears at 5899-5900, 5969-5972 — legitimate Ctrl-L).
- Detection: `parseOllamaModels` 675-686, `detectTools` 688-768 (debug probe 758-766).
- Manifest: `app.json` capabilities confirmed (`sqlite`, `webSearch`, `hostHttp`, `webview` all absent); `index.html` loads `app.js` as `type="module"` (line 381).

**No application files (`app.js`, `index.html`, `style.css`, `app.json`) were modified. The only file created is this report.**