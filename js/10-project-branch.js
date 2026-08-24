import { loginShell, state } from "./00-state.js";
import { $, el } from "./04-dom.js";
import { activeConversation, esc, getProject, saveState, setStatus } from "./05-util.js";
import { selectProject } from "./11-projects.js";
import { boardNameCache, renderBoardChip } from "./12-markdown.js";
export async function openBoardPicker() {
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

// ---------- Project + git branch bar (under the composer) ----------
// Two clickable chips — project name and current branch — each opening a
// selector popover. The branch selector lists branches with the main branch
// pinned to the top, a search box to filter, and a "create new branch" action.
// Branch data comes from `git` via the terminal capability (same path the
// orchestrator's git tools use), so it reflects the real repo state.

// The main branch name for the active project, detected from the repo. We
// prefer the conventional names in order; fall back to the first branch.

// Which selector is currently open: "project" | "branch" | null.
export let pbOpen = null;

// Pure helper: given a list of branch names, return the main branch name
// (first of main/master present) or null. Exposed for tests.
export function detectMainBranch(branches) {
  const list = Array.isArray(branches) ? branches : [];
  for (const cand of ["main", "master"]) {
    if (list.includes(cand)) return cand;
  }
  return null;
}

// Pure helper: order branches with the main branch first, then the rest
// alphabetically (case-insensitive). Exposed for tests.
export function orderBranches(branches, mainBranch) {
  const list = Array.isArray(branches) ? branches.slice() : [];
  let main = mainBranch;
  if (!main) {
    for (const cand of ["main", "master"]) {
      if (list.includes(cand)) { main = cand; break; }
    }
  }
  const rest = list.filter((b) => b !== main).sort((a, b) =>
    String(a).toLowerCase().localeCompare(String(b).toLowerCase()));
  return main ? [main, ...rest] : rest;
}

// Pure helper: filter branch names by a case-insensitive substring query.
// Exposed for tests.
export function filterBranches(branches, query) {
  const q = String(query == null ? "" : query).trim().toLowerCase();
  if (!q) return Array.isArray(branches) ? branches.slice() : [];
  return (Array.isArray(branches) ? branches : []).filter((b) =>
    String(b).toLowerCase().includes(q));
}

// Run a git command in the active project folder. Returns trimmed output, or
// null on any failure (no project, terminal denied, non-zero exit).
export async function pbGit(cmd) {
  const p = getProject(state.activeProjectId);
  if (!p || !p.folderPath) return null;
  try {
    const r = await window.chatoss.terminal.exec(loginShell(cmd), { cwd: p.folderPath });
    if (r === null) return null;
    if (r.exitCode !== 0) return null;
    return (r.output || "").trim();
  } catch (e) {
    return null;
  }
}

// Fetch the current branch + full branch list for the active project.
// Returns { current, branches } or null when the project isn't a git repo.
export async function pbFetchBranches() {
  const p = getProject(state.activeProjectId);
  if (!p || !p.folderPath) return null;
  const current = await pbGit("git branch --show-current");
  const raw = await pbGit("git for-each-ref --format=%(refname:short) refs/heads");
  if (raw === null) return null;
  const branches = raw.split("\n").map((s) => s.trim()).filter(Boolean);
  return { current: current || null, branches };
}

// Render the two chips from current state (project name + last-known branch).
export function renderProjectBranchBar() {
  const p = getProject(state.activeProjectId);
  if (el.pbProjectName) el.pbProjectName.textContent = p ? p.name : "No project";
  if (el.pbProjectName) el.pbProjectName.title = p ? (p.folderPath || p.name) : "";
  if (el.pbBranchBtn) el.pbBranchBtn.disabled = !p;
  if (el.pbBranchName) {
    el.pbBranchName.textContent = state.currentBranch || "—";
    el.pbBranchName.title = state.currentBranch || "";
  }
}

// Close the selector popover (and clear any open state).
export function pbClose() {
  pbOpen = null;
  if (el.pbPopover) el.pbPopover.hidden = true;
  if (el.pbPopover) el.pbPopover.innerHTML = "";
  if (el.pbProjectBtn) el.pbProjectBtn.setAttribute("aria-expanded", "false");
  if (el.pbBranchBtn) el.pbBranchBtn.setAttribute("aria-expanded", "false");
}

// Open the project selector: a simple list of all projects.
export function pbOpenProjectSelector() {
  if (pbOpen === "project") { pbClose(); return; }
  pbOpen = "project";
  el.pbProjectBtn.setAttribute("aria-expanded", "true");
  el.pbBranchBtn.setAttribute("aria-expanded", "false");
  const pop = el.pbPopover;
  pop.innerHTML = "";
  pop.hidden = false;

  const list = document.createElement("ul");
  list.className = "pb-list";
  if (!state.projects.length) {
    const empty = document.createElement("div");
    empty.className = "pb-empty";
    empty.textContent = "No projects yet — add a folder to work in.";
    pop.appendChild(empty);
    return;
  }
  for (const p of state.projects) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pb-item" + (p.id === state.activeProjectId ? " is-current" : "");
    const name = document.createElement("span");
    name.className = "pb-name";
    name.textContent = p.name;
    btn.appendChild(name);
    if (p.id === state.activeProjectId) {
      const check = document.createElement("span");
      check.className = "pb-item-check";
      check.textContent = "✓";
      btn.appendChild(check);
    }
    btn.onclick = () => {
      pbClose();
      selectProject(p.id);
    };
    li.appendChild(btn);
    list.appendChild(li);
  }
  pop.appendChild(list);
}

// Open the branch selector. Loads branches from git, pins main to the top,
// shows a search box, and offers a "create new branch" action.
export async function pbOpenBranchSelector() {
  if (pbOpen === "branch") { pbClose(); return; }
  const p = getProject(state.activeProjectId);
  if (!p) return;
  pbOpen = "branch";
  el.pbBranchBtn.setAttribute("aria-expanded", "true");
  el.pbProjectBtn.setAttribute("aria-expanded", "false");
  const pop = el.pbPopover;
  pop.innerHTML = "";
  pop.hidden = false;

  // Search box (always at the top of the selector).
  const search = document.createElement("input");
  search.type = "text";
  search.className = "pb-search";
  search.placeholder = "Filter branches…";
  search.setAttribute("aria-label", "Filter branches");
  pop.appendChild(search);

  const list = document.createElement("ul");
  list.className = "pb-list";
  pop.appendChild(list);

  const createBtn = document.createElement("button");
  createBtn.type = "button";
  createBtn.className = "pb-create";
  createBtn.innerHTML = '<span aria-hidden="true">＋</span><span>Create new branch…</span>';
  pop.appendChild(createBtn);

  let allBranches = [];
  let current = null;
  let mainBranch = null;

  const renderList = () => {
    const q = search.value;
    const filtered = filterBranches(allBranches, q);
    const ordered = orderBranches(filtered, mainBranch);
    list.innerHTML = "";
    if (!ordered.length) {
      const empty = document.createElement("div");
      empty.className = "pb-empty";
      empty.textContent = q ? "No branches match \"" + q + "\"." : "No branches yet.";
      list.appendChild(empty);
      return;
    }
    for (const b of ordered) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pb-item" + (b === current ? " is-current" : "");
      const name = document.createElement("span");
      name.className = "pb-name";
      name.textContent = b;
      btn.appendChild(name);
      if (b === mainBranch) {
        const tag = document.createElement("span");
        tag.className = "pb-item-sub";
        tag.textContent = "main";
        btn.appendChild(tag);
      } else if (b === current) {
        const check = document.createElement("span");
        check.className = "pb-item-check";
        check.textContent = "✓";
        btn.appendChild(check);
      }
      btn.onclick = () => {
        pbClose();
        pbSwitchBranch(b);
      };
      li.appendChild(btn);
      list.appendChild(li);
    }
  };

  search.addEventListener("input", renderList);

  createBtn.onclick = () => {
    // Replace the list with an inline "new branch" input row.
    pop.innerHTML = "";
    const row = document.createElement("div");
    row.className = "pb-create-row";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "form-input";
    input.placeholder = "New branch name";
    input.setAttribute("aria-label", "New branch name");
    const go = document.createElement("button");
    go.type = "button";
    go.className = "btn btn-primary btn-small";
    go.textContent = "Create";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn btn-ghost btn-small";
    cancel.textContent = "Cancel";
    row.appendChild(input);
    row.appendChild(go);
    row.appendChild(cancel);
    pop.appendChild(row);
    input.focus();
    const doCreate = async () => {
      const name = input.value.trim();
      if (!name) return;
      pbClose();
      await pbCreateBranch(name);
    };
    go.onclick = doCreate;
    cancel.onclick = () => { pbClose(); };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); doCreate(); }
      else if (e.key === "Escape") { e.preventDefault(); pbClose(); }
    });
  };

  // Load branches from git.
  const data = await pbFetchBranches();
  if (data === null) {
    list.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "pb-empty";
    empty.textContent = "Not a git repository (or git unavailable).";
    list.appendChild(empty);
    return;
  }
  allBranches = data.branches;
  current = data.current;
  mainBranch = detectMainBranch(allBranches);
  if (current) state.currentBranch = current;
  renderProjectBranchBar();
  renderList();
  search.focus();
}

// Switch the active project's working tree to the given branch.
export async function pbSwitchBranch(branch) {
  const p = getProject(state.activeProjectId);
  if (!p || !p.folderPath) return;
  setStatus("Switching to branch " + branch + "…");
  try {
    const r = await window.chatoss.terminal.exec(
      loginShell("git checkout " + JSON.stringify(branch)),
      { cwd: p.folderPath }
    );
    if (r === null) { setStatus("Branch switch denied (approve git)."); return; }
    if (r.exitCode !== 0) {
      setStatus("git checkout failed: " + (r.output || "").trim().slice(0, 200));
      return;
    }
    state.currentBranch = branch;
    saveState();
    renderProjectBranchBar();
    setStatus("Switched to branch " + branch + ".");
  } catch (e) {
    setStatus("Branch switch error: " + (e && e.message ? e.message : String(e)));
  }
}

// Create a new branch (off the current branch) and switch to it.
export async function pbCreateBranch(name) {
  const p = getProject(state.activeProjectId);
  if (!p || !p.folderPath) return;
  if (!/^[A-Za-z0-9._\/-]+$/.test(name)) {
    setStatus("Invalid branch name — use letters, digits, dot, underscore, slash, or hyphen.");
    return;
  }
  setStatus("Creating branch " + name + "…");
  try {
    const r = await window.chatoss.terminal.exec(
      loginShell("git checkout -b " + JSON.stringify(name)),
      { cwd: p.folderPath }
    );
    if (r === null) { setStatus("Branch creation denied (approve git)."); return; }
    if (r.exitCode !== 0) {
      setStatus("git checkout -b failed: " + (r.output || "").trim().slice(0, 200));
      return;
    }
    state.currentBranch = name;
    saveState();
    renderProjectBranchBar();
    setStatus("Created and switched to branch " + name + ".");
  } catch (e) {
    setStatus("Branch creation error: " + (e && e.message ? e.message : String(e)));
  }
}

// Collapse state — which projects have their body (conversations + files +
// sessions) hidden. Every project CAN be collapsed, unlike before where one
// project was always forced open.
