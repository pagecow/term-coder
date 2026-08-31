// 06-tools.js — classic script (converted from an ES module; see REFACTOR_PLAN.md).
// Exports are registered on the shared window.termCoder namespace (TC).
(function () {
"use strict";
const TC = window.termCoder = window.termCoder || {};
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
  const rec = TC.sessions.get(session.id);
  if (rec) {
    rec.trustState = "pending";
    rec.trustMode = TC.trustMode;
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
    try { await TC.loadTrustMode(); } catch (_) {}
    // R3: capture the just-loaded mode into a LOCAL so the ask/always branch
    // below can't observe a concurrent change of the shared `trustMode`
    // variable between this await and the check (e.g. the user toggling it in
    // Settings while a second trust dialog is in flight). Behavior unchanged.
    const mode = TC.trustMode;
    if (mode === "always") {
      if (rec) rec.trustMode = "always";
      await confirmTrust();
      if (rec) rec.trustState = "confirmed";
      trustBusy = false;
      return;
    }
    if (rec) rec.trustMode = "ask";
    // mode === "ask" — ask in chat, wait for the answer.
    const ok = await TC.askTrustInChat(folderLabel);
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
  return TC.getProject(args && args.projectId) || TC.getProject(TC.state.activeProjectId) || TC.state.projects[0] || null;
}
// Resolve the board the model means: the id it passed, else the conversation's attached board.
function resolveBoardId(args) {
  const c = TC.activeConversation();
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
          TC.loginShell("git rev-parse --is-inside-work-tree 2>/dev/null"),
          { cwd: base }
        );
        if (checkRepo === null) return "Error: terminal permission denied (approve git to continue)";
        const isRepo = (checkRepo.output || "").trim() === "true";
        if (!isRepo) {
          // Initialize the repo, add everything, and make an initial commit so
          // there's a HEAD for worktree branches to branch from.
          const initCmd = "git init && git add -A && git commit -m \"initial commit (auto-created by Term Coder for worktree isolation)\"";
          const initR = await window.chatoss.terminal.exec(TC.loginShell(initCmd), { cwd: base });
          if (initR === null) return "Error: terminal permission denied (approve git to continue)";
          if (initR.exitCode !== 0) {
            return "Failed to auto-initialize git repo (exit " + initR.exitCode + "):\n" + initR.output +
              "\n\nThe project folder is not a git repository, so a worktree cannot be created. " +
              "Ask the user to initialize git in the project folder first.";
          }
        }

        // Make sure the parent directory for the worktree exists.
        await window.chatoss.terminal.exec(TC.loginShell("mkdir -p \"" + base + "/.chatoss/worktrees\""), { cwd: base });

        // Determine the current (main) branch so we can branch the worktree off it
        // and later merge it back. We stash this in the session record's project
        // metadata so merge_worktree knows where to merge to.
        const branchR = await window.chatoss.terminal.exec(
          TC.loginShell("git branch --show-current"),
          { cwd: base }
        );
        const mainBranch = (branchR && branchR.output || "").trim() || "main";

        const r = await window.chatoss.terminal.exec(
          TC.loginShell("git worktree add " + JSON.stringify(wtPath) + " -b " + JSON.stringify(branch) + " " + JSON.stringify(mainBranch)),
          { cwd: base }
        );
        if (r === null) return "Error: terminal permission denied (approve git to continue)";
        if (r.exitCode !== 0) return "git worktree failed (exit " + r.exitCode + "):\n" + r.output;

        // Track worktree metadata so merge_worktree can find the parent branch.
        // Persisted — the merge almost always happens in a LATER turn.
        TC.worktreeMeta.set(branch, { wtPath, parentBranch: mainBranch, projectPath: base });
        TC.saveWorktrees();
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
        const meta = branch ? TC.worktreeMeta.get(branch) : null;
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
            TC.loginShell("git add -A && git commit -m " + JSON.stringify(commitMsg) + " --allow-empty"),
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
          TC.loginShell("git status --porcelain"),
          { cwd: base }
        );
        if (dirtyR === null) return "Error: terminal permission denied (approve git to continue)";
        if ((dirtyR.output || "").trim()) {
          const wipR = await window.chatoss.terminal.exec(
            TC.loginShell("git add -A && git commit -m " + JSON.stringify("WIP: commit uncommitted work before merging " + branch)),
            { cwd: base }
          );
          if (wipR === null) return "Error: terminal permission denied (approve git to continue)";
        }

        // Switch to the parent branch in the MAIN project folder and merge.
        const mergeMsg = "Merge worktree branch " + branch + " into " + parentBranch;
        const mergeR = await window.chatoss.terminal.exec(
          TC.loginShell("git checkout " + JSON.stringify(parentBranch) + " && git merge --no-ff " + JSON.stringify(branch) + " -m " + JSON.stringify(mergeMsg)),
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
          await window.chatoss.terminal.exec(TC.loginShell("git worktree remove \"" + wtPath + "\" --force"), { cwd: base });
        }
        await window.chatoss.terminal.exec(TC.loginShell("git branch -D \"" + branch + "\""), { cwd: base });
        TC.worktreeMeta.delete(branch);
        TC.saveWorktrees();

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
        const matchedSession = [...TC.sessions.values()].find(
          (s) => s.worktreeBranch === branch || (wtPath && String(s.cwd || "") === wtPath)
        );
        let deletedNote = "";
        if (matchedSession) {
          const act = TC.sessionActivity(matchedSession);
          const finished = (act === "IDLE" || act === "EXITED");
          // Mark the session's worktree as merged regardless, so its persisted
          // snapshot (if it survives a reopen) shows the merged state.
          matchedSession.merged = true;
          TC.persistSessions().catch((e) => console.warn("persistSessions merge", e));
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
                await TC.closeSession(matchedSession.id);
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
        const s = args.sessionId ? TC.sessions.get(args.sessionId) : null;
        if (!s) return "Error: no such session " + (args.sessionId || "(none given)") + ". Call list_sessions to see what exists.";
        const label = s.label || s.id;
        const wasCwd = s.cwd || "(unknown)";
        await TC.closeSession(s.id);
        return "Closed session " + args.sessionId + " (" + label + ") in " + wasCwd + "." +
          (args.reason ? " Reason recorded: " + args.reason : "") +
          " Its context and any unsaved work are gone. If that worktree still needs work, you may now start a fresh agent in it.";
      }
      case "list_worktrees": {
        if (!TC.worktreeMeta.size) return "No open worktrees. Create one with create_worktree before spawning a coding agent.";
        // Flag stale entries (directory gone) so the orchestrator can prune them.
        const lines = [];
        for (const [branch, m] of [...TC.worktreeMeta.entries()]) {
          let stale = false;
          if (m.wtPath) {
            const t = await window.chatoss.terminal.exec(
              TC.loginShell("test -d " + JSON.stringify(m.wtPath) + " && echo yes || echo no"),
              { cwd: (m.projectPath || undefined) }
            );
            stale = !(t && (t.output || "").trim() === "yes");
          }
          lines.push("  branch " + branch + " | parent " + (m.parentBranch || "main") + " | path " + (m.wtPath || "(unknown)") +
            (stale ? "  [STALE: directory gone — purge with prune_worktrees or delete_worktree]" : ""));
        }
        return "OPEN WORKTREES (" + TC.worktreeMeta.size + "):\n" + lines.join("\n") +
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
          const existing = [...TC.sessions.values()].find(
            (s) => s.active !== false && norm(s.cwd) === norm(cwd)
          );
          if (existing) {
            const act = TC.sessionActivity(existing);
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
        //
        // Model Selection Mode is authoritative for non-manual modes: in
        // "always" / "complexity" the user's configured target launches
        // DIRECTLY — a pinned Default agent must not veto it (it used to, so
        // the orchestrator spawned Claude even when Settings said Always =
        // <ollama model>). Manual mode keeps the remembered-default fast path.
        const msMode = (TC.modelSelection && TC.modelSelection.modelSelectionMode) || "manual";
        if (msMode !== "manual") {
          let target = null;
          try {
            target = await TC.resolveSessionModel(args.taskPrompt || "");
          } catch (e) {
            if (e && e.code === "NO_MODELS") {
              return "No launch targets detected. Run Re-scan in Settings, install ollama/a CLI, or switch Model Selection Mode.";
            }
            throw e;
          }
          if (!target) return "Cancelled by user — do not start the session; ask the user how to proceed or stop.";
          const session = await TC.spawnChosen({ cli: "", cwd, prompt: args.taskPrompt || "", target });
          if (!session) return "Terminal permission denied. Approve it in the system prompt and try again.";
          if (session.error) return session.error;
          const rec2 = TC.sessions.get(session.id);
          if (rec2) rec2.fromOrchestrator = true;
          return "session " + session.id + " started: " + session.label + " in " + session.cwd +
            " (launched with the configured " + (msMode === "always" ? "\"Always use a specific target\"" : "Select-by-complexity") + " target — no dialog shown). " +
            "The app types and submits your taskPrompt automatically once the agent is ready. " +
            "Monitor it with wait_for_session (returns when its turn finishes) — do NOT wait for the process to exit; coding CLIs are REPLs and never do.";
        }
        const defId = TC.cliDefaultToTargetId(TC.settings.cliDefault);
        const defTarget = defId ? TC.findLaunchTarget(defId) : null;
        if (defTarget) {
          const session = await TC.spawnChosen({ cli: "", cwd, prompt: args.taskPrompt || "", target: defId });
          if (!session) return "Terminal permission denied. Approve it in the system prompt and try again.";
          if (session.error) return session.error;
          const rec = TC.sessions.get(session.id);
          if (rec) rec.fromOrchestrator = true;
          return "session " + session.id + " started: " + session.label + " in " + session.cwd +
            " (using your saved default launch — no dialog shown). The app types and submits your taskPrompt automatically once the agent is ready. " +
            "Monitor it with wait_for_session (returns when its turn finishes) — do NOT wait for the process to exit; coding CLIs are REPLs and never do.";
        }
        const choice = await TC.openSpawnModal({
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
          const rec = TC.sessions.get(choice.session.id);
          if (rec) rec.fromOrchestrator = true;
          return "session " + choice.session.id + " started: " + choice.session.label + " in " + choice.session.cwd +
            ". The app types and submits your taskPrompt automatically once the agent is ready. " +
            "Monitor it with wait_for_session (returns when its turn finishes) — do NOT wait for the process to exit; coding CLIs are REPLs and never do.";
        }
        return "Error: session did not start";
      }
      case "send_to_session": {
        // Default to the most recently started session if no sessionId given.
        let s = args.sessionId ? TC.sessions.get(args.sessionId) : null;
        if (!s && TC.sessions.size) { s = [...TC.sessions.values()].pop(); }
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
            TC.renderTabs();
            TC.renderSessionInfo();
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
        let s = args.sessionId ? TC.sessions.get(args.sessionId) : null;
        if (!s && TC.sessions.size) { s = [...TC.sessions.values()].pop(); }
        if (!s) return "Error: no active sessions. Start one with start_cli_session first.";
        return await TC.formatSessionStatusOutput(s, null, { full: !!args.full, maxChars: args.maxChars });
      }
      case "list_sessions": {
        // Summarize every coding-agent session at a glance so the orchestrator
        // can coordinate parallel work without guessing from raw screen text.
        if (!TC.sessions.size) return "No active sessions. Start one with start_cli_session first.";
        const recs = [...TC.sessions.values()];
        const tally = { WORKING: 0, IDLE: 0, "NEEDS INPUT": 0, STARTING: 0, EXITED: 0 };
        const lines = recs.map((s) => {
          const act = TC.sessionActivity(s);
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
        let s = args.sessionId ? TC.sessions.get(args.sessionId) : null;
        if (!s && TC.sessions.size) { s = [...TC.sessions.values()].pop(); }
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
          const act = TC.sessionActivity(s);
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
          return await TC.formatSessionStatusOutput(
            s,
            "[SESSION: " + (s.label || s.id) + " | STATUS: STALLED — the agent has produced almost no output since it was launched]\n" +
            "[LIKELY CAUSE: the task text is sitting in the agent's input box without having been submitted, or the CLI is still on a startup screen. Look at the output below: if you can see the task text next to the input prompt, call send_to_session({ sessionId: \"" + s.id + "\", key: \"enter\" }) to press Enter. If the CLI is showing a menu or dialog, tell the user what it says instead of keystroking it.]"
          );
        }
        if (s.active === false) return await TC.formatSessionStatusOutput(s);
        if (reason === "IDLE") {
          return await TC.formatSessionStatusOutput(
            s,
            "[SESSION: " + (s.label || s.id) + " | STATUS: RUNNING | AGENT TURN COMPLETE — it has been idle at its input prompt for " +
            Math.round((Date.now() - (s.lastOutputAt || Date.now())) / 1000) + "s]\n" +
            "[NOTE: the CLI is still running (that is normal — it is a REPL and will not exit). Read the output below to confirm the subtask is done, then merge its worktree. To give it more work, use send_to_session.]"
          );
        }
        if (reason === "ERROR LOOP") {
          return await TC.formatSessionStatusOutput(
            s,
            "[SESSION: " + (s.label || s.id) + " | STATUS: STUCK ON A REPEATING ERROR (" + (s.errorCount || 0) + "x)]\n" +
            "[ERROR: " + (s.lastErrorText || "(see output)") + "]\n" +
            "[WHAT TO DO: this agent is retrying something that will keep failing. TALK TO IT — call send_to_session({ sessionId: \"" + s.id + "\", text: \"<a plain-language correction>\", key: \"enter\" }) telling it what to do differently. For example, if the error is about image input, tell it that its model cannot read images and it should work from the code instead. Do NOT close this session and do NOT start a second agent in the same worktree — correcting the running agent keeps its context and its work.]"
          );
        }
        if (reason === "NEEDS INPUT") return await TC.formatSessionStatusOutput(s);
        // Timed out while the agent was still actively working.
        return await TC.formatSessionStatusOutput(
          s,
          "[SESSION: " + (s.label || s.id) + " | STATUS: STILL WORKING (timed out after " + timeout + "ms without going idle)]"
        );
      }
      case "list_project_files": {
        const p = resolveProject(args);
        if (!p) return "Error: no project selected. Ask the user to add a project folder first.";
        const r = await window.chatoss.terminal.exec(TC.loginShell("ls -la"), { cwd: p.folderPath });
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
        const r = await window.chatoss.terminal.exec(TC.loginShell("git branch --show-current"), { cwd: p.folderPath });
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
          const r = await window.chatoss.terminal.exec(TC.loginShell(cmd), { cwd: base });
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
          TC.loginShell("git add -A && git commit -m " + JSON.stringify(msg)),
          { cwd: p.folderPath }
        );
        if (r === null) return "Error: terminal permission denied (approve git to continue)";
        if (r.exitCode !== 0) return "git commit failed (exit " + r.exitCode + "):\n" + r.output;
        return "Committed:\n" + r.output;
      }
      case "git_push": {
        const p = resolveProject(args);
        if (!p) return "Error: no project selected. Ask the user to add a project folder first.";
        let r = await window.chatoss.terminal.exec(TC.loginShell("git push"), { cwd: p.folderPath });
        if (r === null) return "Error: terminal permission denied (approve git to continue)";
        if (r.exitCode !== 0 && /no upstream branch|--set-upstream/i.test(r.output || "")) {
          r = await window.chatoss.terminal.exec(TC.loginShell("git push -u origin HEAD"), { cwd: p.folderPath });
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
        // Keep any matching APP_VERSION constant in root-level JS files (and the
        // js/ module folder) in sync.
        const updatedFiles = [];
        const scanDir = async (dir, prefix) => {
          try {
            const entries = await window.chatoss.files.listDir(dir);
            for (const ent of (entries || [])) {
              if (!ent) continue;
              const name = ent.name || "";
              if (ent.kind === "dir") {
                if (name === "js") await scanDir(dir + "/" + name, prefix + name + "/");
                continue;
              }
              if (!/\.(js|mjs|cjs)$/.test(name)) continue;
              const fpath = dir + "/" + name;
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
                  updatedFiles.push(prefix + name);
                }
              } catch (e) { /* skip unreadable files */ }
            }
          } catch (e) { /* listDir unavailable — app.json alone is still bumped */ }
        };
        await scanDir(base, "");
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
          const r = await window.chatoss.terminal.exec(TC.loginShell(cmd), { cwd: base });
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
          files = ["app.json", "index.html", "js", "style.css", "icon.svg", "libs"];
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
        return await TC.runHealthCheck();
      }
      case "worktree_git_status": {
        const branch = String(args.branchName || "").trim();
        const meta = branch ? TC.worktreeMeta.get(branch) : null;
        const wtPath = (meta && meta.wtPath) || String(args.worktreePath || "").trim();
        if (!wtPath) return "Error: pass branchName (from list_worktrees) or worktreePath.";
        const run = async (cmd) => {
          const r = await window.chatoss.terminal.exec(TC.loginShell(cmd), { cwd: wtPath });
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
        // ONE launch choice for the whole batch: in non-manual Model Selection
        // Mode the configured target applies to every task (no dialog); in
        // manual mode the saved default if pinned, otherwise a single spawn
        // dialog (batchMode — no session spawned yet).
        const msMode = (TC.modelSelection && TC.modelSelection.modelSelectionMode) || "manual";
        let cli = "";
        let target = null;
        if (msMode !== "manual") {
          try {
            target = await TC.resolveSessionModel(tasks[0] ? String(tasks[0].prompt || "") : "");
          } catch (e) {
            if (e && e.code === "NO_MODELS") {
              return "No launch targets detected. Run Re-scan in Settings, install ollama/a CLI, or switch Model Selection Mode.";
            }
            throw e;
          }
          if (!target) return "Cancelled by user — do not start the batch; ask the user how to proceed or stop.";
        } else {
          const defId = TC.cliDefaultToTargetId(TC.settings.cliDefault);
          const defTarget = defId ? TC.findLaunchTarget(defId) : null;
          target = defId || null;
          if (!defTarget) {
            const choice = await TC.openSpawnModal({
              source: "tool",
              cwd: base,
              prompt: "BATCH: " + tasks.length + " parallel subtasks — pick the launch to use for ALL of them.",
              batchMode: true,
            });
            if (!choice) return "Cancelled by user — do not start the batch; ask the user how to proceed or stop.";
            cli = choice.cli || "";
            target = choice.target || null;
          }
        }
        const results = [];
        for (const t of tasks) {
          const name = String(t.name || "").trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
          const prompt = String(t.prompt || "").trim();
          if (!name || !prompt) { results.push("SKIPPED (missing name/prompt): " + JSON.stringify(t)); continue; }
          const branch = name;
          const wtPath = base + "/.chatoss/worktrees/" + branch;
          const branchR = await window.chatoss.terminal.exec(TC.loginShell("git branch --show-current"), { cwd: base });
          const mainBranch = (branchR && branchR.output || "").trim() || "main";
          const r = await window.chatoss.terminal.exec(
            TC.loginShell("git worktree add " + JSON.stringify(wtPath) + " -b " + JSON.stringify(branch) + " " + JSON.stringify(mainBranch)),
            { cwd: base }
          );
          if (r === null) { results.push("FAILED " + name + ": terminal permission denied"); continue; }
          if (r.exitCode !== 0) { results.push("FAILED " + name + ": " + (r.output || "").trim().slice(0, 200)); continue; }
          TC.worktreeMeta.set(branch, { wtPath, parentBranch: mainBranch, projectPath: base });
          TC.saveWorktrees();
          const session = await TC.spawnChosen({ cli, cwd: wtPath, prompt, target });
          if (!session) { results.push("FAILED " + name + ": terminal permission denied"); continue; }
          if (session.error) { results.push("FAILED " + name + ": " + session.error); continue; }
          const rec = TC.sessions.get(session.id);
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
        const meta = branch ? TC.worktreeMeta.get(branch) : null;
        const wtPath = (meta && meta.wtPath) || String(args.worktreePath || "").trim();
        if (!wtPath && !branch) return "Error: pass branchName or worktreePath of the worktree to delete.";
        const parentBranch = (meta && meta.parentBranch) || "main";
        // Commit any uncommitted work in the worktree first so it is at least
        // captured in the branch's history (and reported below) before the
        // branch is deleted — nothing is lost silently.
        if (wtPath) {
          const commitR = await window.chatoss.terminal.exec(
            TC.loginShell("git add -A && git commit -m " + JSON.stringify("WIP: commit uncommitted work before deleting " + (branch || wtPath)) + " --allow-empty"),
            { cwd: wtPath }
          );
          if (commitR === null) return "Error: terminal permission denied (approve git to continue)";
        }
        // Report the unmerged commits that will be discarded.
        let discardNote = "";
        if (branch) {
          const logR = await window.chatoss.terminal.exec(
            TC.loginShell("git log --oneline " + JSON.stringify(parentBranch) + ".." + JSON.stringify(branch)),
            { cwd: base }
          );
          if (logR && (logR.output || "").trim()) {
            discardNote = "\nDISCARDED unmerged commits on " + branch + ":\n" + logR.output.trim();
          }
        }
        if (wtPath) {
          const rmR = await window.chatoss.terminal.exec(TC.loginShell("git worktree remove " + JSON.stringify(wtPath) + " --force"), { cwd: base });
          if (rmR === null) return "Error: terminal permission denied (approve git to continue)";
          if (rmR.exitCode !== 0) return "git worktree remove failed (exit " + rmR.exitCode + "):\n" + rmR.output;
        }
        if (branch) {
          const brR = await window.chatoss.terminal.exec(TC.loginShell("git branch -D " + JSON.stringify(branch)), { cwd: base });
          if (brR === null) return "Error: terminal permission denied (approve git to continue)";
          if (brR.exitCode !== 0) return "git branch -D failed (exit " + brR.exitCode + "):\n" + brR.output;
        }
        if (branch) { TC.worktreeMeta.delete(branch); TC.saveWorktrees(); }
        return "Deleted worktree " + (branch || wtPath) + " (directory removed, branch deleted, bookkeeping purged)." + discardNote;
      }
      case "prune_worktrees": {
        const entries = [...TC.worktreeMeta.entries()];
        if (!entries.length) return "No worktree bookkeeping entries to prune.";
        const purged = [];
        const kept = [];
        for (const [branch, m] of entries) {
          const proj = (m && m.projectPath) || "";
          const wtPath = (m && m.wtPath) || "";
          let dirExists = false, branchExists = false;
          if (wtPath) {
            const t = await window.chatoss.terminal.exec(
              TC.loginShell("test -d " + JSON.stringify(wtPath) + " && echo yes || echo no"),
              { cwd: proj || undefined }
            );
            dirExists = !!(t && (t.output || "").trim() === "yes");
          }
          if (proj && branch) {
            const b = await window.chatoss.terminal.exec(
              TC.loginShell("git branch --list " + JSON.stringify(branch)),
              { cwd: proj }
            );
            branchExists = !!(b && (b.output || "").trim());
          }
          if (!dirExists && !branchExists) {
            TC.worktreeMeta.delete(branch);
            purged.push(branch + " (dir gone, branch gone)");
          } else {
            kept.push(branch + (dirExists ? "" : " [dir gone]") + (branchExists ? "" : " [branch gone]"));
          }
        }
        if (purged.length) TC.saveWorktrees();
        // Report real git worktrees on disk that are NOT in bookkeeping.
        let orphans = "";
        const p = resolveProject(args);
        if (p) {
          const base = p.folderPath.replace(/\/+$/, "");
          const wl = await window.chatoss.terminal.exec(TC.loginShell("git worktree list --porcelain"), { cwd: base });
          if (wl && wl.output) {
            const real = new Set();
            for (const line of wl.output.split("\n")) {
              if (line.startsWith("worktree ")) real.add(line.slice(9).trim());
            }
            const known = new Set([...TC.worktreeMeta.values()].map((x) => x && x.wtPath).filter(Boolean));
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
// --- exports ---
Object.defineProperty(TC, "ORCHESTRATOR_TOOLS", { get: () => ORCHESTRATOR_TOOLS, configurable: true });
Object.defineProperty(TC, "LEGACY_KEY_BYTES", { get: () => LEGACY_KEY_BYTES, configurable: true });
TC.hasNativeInput = hasNativeInput;
TC.sendKey = sendKey;
TC.sendText = sendText;
TC.bracketedPasteOn = bracketedPasteOn;
TC.parseTerminalEscapes = parseTerminalEscapes;
TC.stripAnsi = stripAnsi;
TC.cleanApprovalText = cleanApprovalText;
TC.autoDriveStartup = autoDriveStartup;
TC.resolveProject = resolveProject;
TC.resolveBoardId = resolveBoardId;
TC.toolHandler = toolHandler;
})();
