// Tests for full worktree CRUD authority: delete_worktree (remove without
// merging) and prune_worktrees (purge stale bookkeeping entries), plus the
// stale-flagging in list_worktrees. The orchestrator must never again report
// "there's no tool for me to purge stale worktree entries".
const fs = require("fs");
const path = require("path");
const { assert, test, run } = require("./harness");

const SRC = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

test("delete_worktree tool is defined and handled", () => {
  assert(/name: "delete_worktree"/.test(SRC), "delete_worktree schema missing");
  assert(/case "delete_worktree":/.test(SRC), "delete_worktree handler missing");
  assert(/git worktree remove .*--force/.test(SRC), "must remove the worktree directory");
  assert(/git branch -D/.test(SRC), "must delete the branch");
  assert(/worktreeMeta\.delete\(branch\)/.test(SRC), "must purge the bookkeeping entry");
});

test("delete_worktree never loses work silently — WIP commit + discard report", () => {
  assert(/WIP: commit uncommitted work before deleting/.test(SRC),
    "must commit uncommitted work before deleting");
  assert(/DISCARDED unmerged commits/.test(SRC),
    "must report the discarded unmerged commits");
});

test("prune_worktrees tool is defined and handled", () => {
  assert(/name: "prune_worktrees"/.test(SRC), "prune_worktrees schema missing");
  assert(/case "prune_worktrees":/.test(SRC), "prune_worktrees handler missing");
  assert(/test -d/.test(SRC), "must check directory existence");
  assert(/git branch --list/.test(SRC), "must check branch existence");
  assert(/PRUNED \d+ stale bookkeeping entries/.test(SRC) || /PRUNED " \+ purged\.length/.test(SRC),
    "must report what was purged");
});

test("prune_worktrees purges entries whose dir AND branch are gone, keeps the rest", () => {
  assert(/if \(!dirExists && !branchExists\)/.test(SRC),
    "an entry is stale only when BOTH the directory and the branch are gone");
  assert(/worktreeMeta\.delete\(branch\)/.test(SRC), "stale entries must be purged");
  assert(/saveWorktrees\(\)/.test(SRC), "purges must be persisted");
});

test("prune_worktrees reports real git worktrees missing from bookkeeping", () => {
  assert(/git worktree list --porcelain/.test(SRC), "must read the real worktree list");
  assert(/Real git worktrees NOT in bookkeeping/.test(SRC),
    "must report orphaned on-disk worktrees");
});

test("list_worktrees flags stale entries so the orchestrator can prune them", () => {
  assert(/STALE: directory gone — purge with prune_worktrees or delete_worktree/.test(SRC),
    "list_worktrees must flag entries whose directory is gone");
});

test("system prompt grants full worktree authority (CRUD)", () => {
  assert(/YOU HAVE FULL AUTHORITY OVER WORKTREE MANAGEMENT \(CRUD\)/.test(SRC),
    "the system prompt must grant full worktree authority");
  assert(/never tell the user a cleanup is 'a ChatOSS-side task'/.test(SRC),
    "the orchestrator must never punt worktree cleanup to the platform");
});

run();
