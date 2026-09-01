// 10-project-branch.js — classic script (converted from an ES module; see REFACTOR_PLAN.md).
// Exports are registered on the shared window.termCoder namespace (TC).
(function () {
"use strict";
const TC = window.termCoder = window.termCoder || {};
async function openBoardPicker() {
  const c = TC.activeConversation();
  if (!c) { TC.setStatus("Select a conversation first."); return; }
  TC.el.boardPickerList.innerHTML = "<div class='detected-scanning'>Loading boards…</div>";
  TC.el.boardPicker.classList.remove("hidden");
  try {
    const list = await window.chatoss.boards.list();
    TC.el.boardPickerList.innerHTML = "";
    if (!list || !list.length) {
      TC.el.boardPickerList.innerHTML = "<div class='settings-hint'>No Kanban boards available. Mount the Kanban section first.</div>";
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
        TC.boardNameCache[b.id] = b.name;
        TC.saveState();
        TC.el.boardPicker.classList.add("hidden");
        TC.renderBoardChip();
      };
      TC.el.boardPickerList.appendChild(btn);
    }
  } catch (e) {
    TC.el.boardPickerList.innerHTML = "<div class='settings-hint'>Boards error: " + TC.esc(e && e.message ? e.message : String(e)) + "</div>";
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
let pbOpen = null;

// Pure helper: given a list of branch names, return the main branch name
// (first of main/master present) or null. Exposed for tests.
function detectMainBranch(branches) {
  const list = Array.isArray(branches) ? branches : [];
  for (const cand of ["main", "master"]) {
    if (list.includes(cand)) return cand;
  }
  return null;
}

// Pure helper: order branches with the main branch first, then the rest
// alphabetically (case-insensitive). Exposed for tests.
function orderBranches(branches, mainBranch) {
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
function filterBranches(branches, query) {
  const q = String(query == null ? "" : query).trim().toLowerCase();
  if (!q) return Array.isArray(branches) ? branches.slice() : [];
  return (Array.isArray(branches) ? branches : []).filter((b) =>
    String(b).toLowerCase().includes(q));
}

// Run a git command in the active project folder. Returns trimmed output, or
// null on any failure (no project, terminal denied, non-zero exit).
async function pbGit(cmd) {
  const p = TC.getProject(TC.state.activeProjectId);
  if (!p || !p.folderPath) return null;
  try {
    // Fast path: run git directly. The sandboxed shell's PATH is minimal, but
    // git usually resolves there (Apple's /usr/bin/git on macOS) and this skips
    // the ~1.2s zsh login-shell startup PER COMMAND — two sequential probes
    // made the branch chip take ~3-5s to appear. Fall back to the login shell
    // on ANY failure: a machine where git only exists on the full user PATH,
    // or a shim that errors without Xcode CLT (exit 1, not 127).
    let r = await window.chatoss.terminal.exec(cmd, { cwd: p.folderPath });
    if (r === null || r.exitCode !== 0) {
      r = await window.chatoss.terminal.exec(TC.loginShell(cmd), { cwd: p.folderPath });
    }
    if (r === null) return null;
    if (r.exitCode !== 0) return null;
    return (r.output || "").trim();
  } catch (e) {
    return null;
  }
}

// In-memory cache of the last successful branch fetch, keyed by project id, so
// the selector popup renders instantly and refreshes in the background.
const pbCache = new Map(); // project id -> { current, branches }

// Fetch the current branch + full branch list for the active project.
// Returns { current, branches } or null when the project isn't a git repo.
// On success the result is cached (pbCache) and the last-known branch is
// persisted per project (state.projectBranches) so the chip and popup render
// instantly next time.
async function pbFetchBranches() {
  const p = TC.getProject(TC.state.activeProjectId);
  if (!p || !p.folderPath) return null;
  const pid = p.id;
  const current = await pbGit("git branch --show-current");
  // The --format value is single-quoted INSIDE the command string. loginShell
  // wraps commands in `zsh -lic "…"`, and those outer double quotes are stripped
  // before zsh parses the line — so a bare %(refname:short) is a zsh parse error
  // ("missing end of string", exit 1), which made every repo report "Not a git
  // repository". Quoting the format survives every shell layer.
  const raw = await pbGit("git for-each-ref --format='%(refname:short)' refs/heads");
  if (raw === null) return null;
  const branches = raw.split("\n").map((s) => s.trim()).filter(Boolean);
  const data = { current: current || null, branches };
  pbCache.set(pid, data);
  if (data.current) {
    // Per-project record is always safe to write; the global chip value only
    // when this project is still the active one (the fetch is async and the
    // user may have switched projects while it ran).
    TC.state.projectBranches[pid] = data.current;
    if (TC.state.activeProjectId === pid) TC.state.currentBranch = data.current;
    TC.saveState();
  }
  return data;
}

// Render the two chips from current state (project name + last-known branch).
function renderProjectBranchBar() {
  const p = TC.getProject(TC.state.activeProjectId);
  if (TC.el.pbProjectName) TC.el.pbProjectName.textContent = p ? p.name : "No project";
  if (TC.el.pbProjectName) TC.el.pbProjectName.title = p ? (p.folderPath || p.name) : "";
  if (TC.el.pbBranchBtn) TC.el.pbBranchBtn.disabled = !p;
  if (TC.el.pbBranchName) {
    TC.el.pbBranchName.textContent = TC.state.currentBranch || "—";
    TC.el.pbBranchName.title = TC.state.currentBranch || "";
  }
}

// Close the selector popover (and clear any open state).
function pbClose() {
  pbOpen = null;
  if (TC.el.pbPopover) TC.el.pbPopover.hidden = true;
  if (TC.el.pbPopover) TC.el.pbPopover.innerHTML = "";
  if (TC.el.pbProjectBtn) TC.el.pbProjectBtn.setAttribute("aria-expanded", "false");
  if (TC.el.pbBranchBtn) TC.el.pbBranchBtn.setAttribute("aria-expanded", "false");
}

// Open the project selector: a simple list of all projects.
function pbOpenProjectSelector() {
  if (pbOpen === "project") { pbClose(); return; }
  pbOpen = "project";
  TC.el.pbProjectBtn.setAttribute("aria-expanded", "true");
  TC.el.pbBranchBtn.setAttribute("aria-expanded", "false");
  const pop = TC.el.pbPopover;
  pop.innerHTML = "";
  pop.hidden = false;

  const list = document.createElement("ul");
  list.className = "pb-list";
  if (!TC.state.projects.length) {
    const empty = document.createElement("div");
    empty.className = "pb-empty";
    empty.textContent = "No projects yet — add a folder to work in.";
    pop.appendChild(empty);
    return;
  }
  for (const p of TC.state.projects) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pb-item" + (p.id === TC.state.activeProjectId ? " is-current" : "");
    const name = document.createElement("span");
    name.className = "pb-name";
    name.textContent = p.name;
    btn.appendChild(name);
    if (p.id === TC.state.activeProjectId) {
      const check = document.createElement("span");
      check.className = "pb-item-check";
      check.textContent = "✓";
      btn.appendChild(check);
    }
    btn.onclick = () => {
      pbClose();
      TC.selectProject(p.id);
    };
    li.appendChild(btn);
    list.appendChild(li);
  }
  pop.appendChild(list);
}

// Open the branch selector. Loads branches from git, pins main to the top,
// shows a search box, and offers a "create new branch" action.
async function pbOpenBranchSelector() {
  if (pbOpen === "branch") { pbClose(); return; }
  const p = TC.getProject(TC.state.activeProjectId);
  if (!p) return;
  pbOpen = "branch";
  TC.el.pbBranchBtn.setAttribute("aria-expanded", "true");
  TC.el.pbProjectBtn.setAttribute("aria-expanded", "false");
  const pop = TC.el.pbPopover;
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
  let replaced = false; // true once the create button swaps the popover into create-row mode

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

  createBtn.onclick = (e) => {
    // stopPropagation is REQUIRED: this handler replaces the popover's contents,
    // which detaches the button mid-click. The document-level outside-click
    // handler would then see a target that is no longer inside the bar
    // (contains() is false for detached nodes) and close the popover instantly,
    // making "Create new branch…" look like a dead button.
    e.stopPropagation();
    // Replace the list with an inline "new branch" input row.
    replaced = true;
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

  // Render instantly from the cache (or a loading hint), then refresh from git
  // in the background — the popup used to sit empty for ~3-5s while two
  // sequential zsh login-shell probes ran.
  const cached = pbCache.get(p.id);
  if (cached) {
    allBranches = cached.branches;
    current = cached.current;
    mainBranch = detectMainBranch(allBranches);
    renderList();
  } else {
    const loading = document.createElement("div");
    loading.className = "pb-empty";
    loading.textContent = "Loading branches…";
    list.appendChild(loading);
  }

  // Load branches from git.
  const data = await pbFetchBranches();
  // The user may have closed the popover or switched it into create-row mode
  // while the fetch ran — don't clobber either state with a late render.
  if (replaced || pbOpen !== "branch") return;
  if (data === null) {
    // Keep showing the cached list when the refresh fails (stale beats blank);
    // only report "not a git repository" when we have nothing at all.
    if (!cached) {
      list.innerHTML = "";
      const empty = document.createElement("div");
      empty.className = "pb-empty";
      empty.textContent = "Not a git repository (or git unavailable).";
      list.appendChild(empty);
    }
    return;
  }
  allBranches = data.branches;
  current = data.current;
  mainBranch = detectMainBranch(allBranches);
  renderProjectBranchBar();
  renderList();
  search.focus();
}

// Switch the active project's working tree to the given branch.
async function pbSwitchBranch(branch) {
  const p = TC.getProject(TC.state.activeProjectId);
  if (!p || !p.folderPath) return;
  TC.setStatus("Switching to branch " + branch + "…");
  try {
    const r = await window.chatoss.terminal.exec(
      TC.loginShell("git checkout " + JSON.stringify(branch)),
      { cwd: p.folderPath }
    );
    if (r === null) { TC.setStatus("Branch switch denied (approve git)."); return; }
    if (r.exitCode !== 0) {
      TC.setStatus("git checkout failed: " + (r.output || "").trim().slice(0, 200));
      return;
    }
    TC.state.currentBranch = branch;
    TC.saveState();
    renderProjectBranchBar();
    TC.setStatus("Switched to branch " + branch + ".");
  } catch (e) {
    TC.setStatus("Branch switch error: " + (e && e.message ? e.message : String(e)));
  }
}

// Create a new branch (off the current branch) and switch to it.
async function pbCreateBranch(name) {
  const p = TC.getProject(TC.state.activeProjectId);
  if (!p || !p.folderPath) return;
  if (!/^[A-Za-z0-9._\/-]+$/.test(name)) {
    TC.setStatus("Invalid branch name — use letters, digits, dot, underscore, slash, or hyphen.");
    return;
  }
  TC.setStatus("Creating branch " + name + "…");
  try {
    const r = await window.chatoss.terminal.exec(
      TC.loginShell("git checkout -b " + JSON.stringify(name)),
      { cwd: p.folderPath }
    );
    if (r === null) { TC.setStatus("Branch creation denied (approve git)."); return; }
    if (r.exitCode !== 0) {
      TC.setStatus("git checkout -b failed: " + (r.output || "").trim().slice(0, 200));
      return;
    }
    TC.state.currentBranch = name;
    TC.saveState();
    renderProjectBranchBar();
    TC.setStatus("Created and switched to branch " + name + ".");
  } catch (e) {
    TC.setStatus("Branch creation error: " + (e && e.message ? e.message : String(e)));
  }
}

// Collapse state — which projects have their body (conversations + files +
// sessions) hidden. Every project CAN be collapsed, unlike before where one
// project was always forced open.
// --- exports ---
Object.defineProperty(TC, "pbOpen", { get: () => pbOpen, set: (v) => { pbOpen = v; }, configurable: true });
TC.openBoardPicker = openBoardPicker;
TC.detectMainBranch = detectMainBranch;
TC.orderBranches = orderBranches;
TC.filterBranches = filterBranches;
TC.pbGit = pbGit;
TC.pbFetchBranches = pbFetchBranches;
TC.renderProjectBranchBar = renderProjectBranchBar;
TC.pbClose = pbClose;
TC.pbOpenProjectSelector = pbOpenProjectSelector;
TC.pbOpenBranchSelector = pbOpenBranchSelector;
TC.pbSwitchBranch = pbSwitchBranch;
TC.pbCreateBranch = pbCreateBranch;
})();
