import { running, sessions, settings } from "./00-state.js";
import { sessionActivity } from "./01-sessions.js";
import { el } from "./04-dom.js";
import { activeConversation } from "./05-util.js";
import { paintProjSessions } from "./11-projects.js";
import { sendMessage } from "./18-send.js";
import { pendingChoices } from "./21-askchoice.js";
export let autoFollowTimer = null;
export let statusRefreshTimer = null; // D3: handle for the sidebar status-refresh interval, cleared together with autoFollowTimer
export let lastAutoFollowAt = 0;
export const AUTO_FOLLOW_COOLDOWN_MS = 8000;

export function autoFollowTick() {
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

export function startAutoFollow() {
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
export function stopAutoFollow() {
  if (autoFollowTimer) { clearInterval(autoFollowTimer); autoFollowTimer = null; }
  if (statusRefreshTimer) { clearInterval(statusRefreshTimer); statusRefreshTimer = null; }
}

// ---------- Right column: terminal grid ----------
// Show/hide each terminal square (live) and ended card (dead) based on whether
// it belongs to the ACTIVE conversation, and keep the empty-state hint + count
// badge in sync with the visible total. Sessions are scoped per conversation
// (rec.conversationId), so switching conversations shows only that
// conversation's terminals and a fresh chat starts with an empty grid.
