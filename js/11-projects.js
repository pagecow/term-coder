import { deadSessions, loginShell, sessions, settings, state } from "./00-state.js";
import { sessionActivity } from "./01-sessions.js";
import { sqliteDeleteConversation, sqliteDeleteProject } from "./02-sqlite.js";
import { $, el } from "./04-dom.js";
import { basename, getConversation, getProject, saveSettings, saveState, setStatus, uuid } from "./05-util.js";
import { pbFetchBranches, renderProjectBranchBar } from "./10-project-branch.js";
import { renderChat } from "./13-chat.js";
import { renderSessionInfo, selectSession } from "./20-terminal.js";
import { RZ_W, applyColWidths, shellEl } from "./22-resizers.js";
export let collapsedProjects = new Set();
// Codex-style sidebar: bold project rows with folder glyph + chevron, hover
// actions on the right, and the selected project's content (Conversations +
// Files tree) nested underneath with an indentation guide.
export function renderProjects() {
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
export function sessionsForActiveConversation() {
  const cid = state.activeConversationId;
  const live = [...sessions.values()].filter((s) => (s.conversationId || null) === cid);
  const dead = [...deadSessions.values()].filter((s) => (s.conversationId || null) === cid);
  return { live, dead };
}

export function paintProjSessions() {
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
export const HIDDEN_ENTRIES = new Set([".git", ".chatoss", ".DS_Store"]);
export const MAX_CHILDREN = 300;

export const fileTree = {
  projectPath: null,
  expanded: new Set(),  // absolute dir paths currently open
  cache: new Map(),     // absolute dir path -> [{ name, isDir }] | "denied"
  loading: new Set(),
  container: null,
  watchStop: null,
};

export function resetFileTree(projectPath) {
  fileTree.projectPath = projectPath;
  fileTree.expanded = new Set();
  fileTree.cache = new Map();
  fileTree.loading = new Set();
  if (fileTree.watchStop) {
    try { fileTree.watchStop(); } catch (e) { /* non-fatal */ }
    fileTree.watchStop = null;
  }
}

export async function listDirEntries(path) {
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

export function sortEntries(entries) {
  return entries
    .filter((e) => !HIDDEN_ENTRIES.has(e.name))
    .sort((a, b) => (a.isDir === b.isDir
      ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
      : (a.isDir ? -1 : 1)));
}

export async function loadDir(path, repaint) {
  if (fileTree.loading.has(path)) return;
  fileTree.loading.add(path);
  const entries = await listDirEntries(path);
  fileTree.loading.delete(path);
  fileTree.cache.set(path, entries === "denied" ? "denied" : sortEntries(entries));
  if (repaint) repaintFileTree();
}

// Start (or restart) the live watcher for the active project.
export function ensureFileWatch(projectPath) {
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

export function renderFileTree(project, container, opts) {
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
export function repaintFileTree() {
  const container = fileTree.container;
  if (!container || !container.isConnected || !fileTree.projectPath) return;
  const body = container.querySelector(".file-tree-body");
  if (body) paintFileTree(body, fileTree.projectPath);
}

export function paintFileTree(body, rootPath) {
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

export function fileTreeNote(text, depth) {
  const d = document.createElement("div");
  d.className = "file-tree-loading";
  d.textContent = text;
  d.style.setProperty("--depth", depth || 0);
  return d;
}

export function fileIcon(name) {
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
export const editorState = {
  path: null,          // absolute path of the open file (null = closed)
  original: "",        // contents as last saved (or as loaded)
  size: 360,           // persisted column width
};

export const isBinaryExt = (name) => {
  const ext = name.split(".").pop().toLowerCase();
  return ["png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "tiff", "pdf", "zip",
          "gz", "tar", "7z", "woff", "woff2", "ttf", "otf", "eot", "mp3", "mp4",
          "mov", "avi", "exe", "dll", "so", "dylib", "class", "jar", "bin", "o",
          "a", "wasm", "db", "sqlite", "sqlite3", "icns", "lock"].includes(ext);
};

export async function openFileInEditor(path) {
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

export function openEditorPane() {
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

export function closeEditorPane() {
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

export function editorIsDirty() {
  return !!editorState.path && el.editorInput.value !== editorState.original;
}

export function editorRefreshDirty() {
  const dirty = editorIsDirty();
  el.editorSaveBtn.disabled = !dirty;
  el.editorModifiedDot.classList.toggle("hidden", !dirty);
  if (dirty) editorSetStatus("Unsaved changes — press Save");
}

export function editorSetStatus(msg, isError) {
  el.editorStatus.textContent = msg || "";
  el.editorStatus.classList.toggle("is-error", !!isError);
  el.editorStatus.classList.remove("is-saving");
}

export async function editorSave() {
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
export function editorConfirm(question) {
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

export function initEditor() {
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
export function renameProject(p, nameText) {
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
export function renameConversation(p, c, nameEl) {
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
export function confirmDelete(fn, btn) {
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

export function selectProject(pid) {
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
  renderProjectBranchBar();
  // Refresh the branch chip for the newly selected project (async, non-blocking).
  state.currentBranch = null;
  pbFetchBranches().then((data) => {
    if (data && data.current) { state.currentBranch = data.current; renderProjectBranchBar(); }
  }).catch(() => {});
}
// Switching conversation must also refresh the footer line, which names the
// active conversation — it used to keep showing the previous one.
export function selectConversation(pid, cid) {
  state.activeProjectId = pid;
  state.activeConversationId = cid;
  saveState();
  renderProjects();
  renderChat();
  renderSessionInfo();
  renderProjectBranchBar();
}
export async function newProject() {
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
    renderProjectBranchBar();
  } catch (e) {
    setStatus("Project error: " + (e && e.message ? e.message : String(e)));
  }
}
export function deleteProject(p) {
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
  renderProjectBranchBar();
}
// Derive a short conversation name from the first user message: the first
// ~40–60 characters, cut cleanly at a word boundary with a trailing "…" when
// the message is longer than that. Returns fallback when text is empty, so a
// brand-new conversation keeps its "Conversation N" placeholder until the user
// actually sends something.
export function nameFromFirstMessage(text, fallback) {
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
export function conversationHasPosts(c) {
  return !!(c && c.messages && c.messages.some((m) => m.role === "user" && !m.event));
}

// Pick which conversation to open when none is selected: the newest one that
// has posts (empty drafts stay out of the way), falling back to the newest
// overall when every conversation is still empty.
export function preferredConversation(p) {
  if (!p || !p.conversations.length) return null;
  for (let i = p.conversations.length - 1; i >= 0; i--) {
    if (conversationHasPosts(p.conversations[i])) return p.conversations[i];
  }
  return p.conversations[p.conversations.length - 1];
}

// Files / Sessions section collapse — persisted per project in
// state.sectionCollapsed. Both are COLLAPSED by default: a section counts as
// expanded only when it was explicitly set to false.
export function toggleProjSection(pid, key) {
  if (!state.sectionCollapsed) state.sectionCollapsed = {};
  const cur = state.sectionCollapsed[pid] || {};
  const nowCollapsed = cur[key] !== false;
  state.sectionCollapsed[pid] = Object.assign({}, cur, { [key]: !nowCollapsed });
  saveState();
  renderProjects();
}

export function newConversation(p) {
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
export function newChatFromTopbar() {
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
export function syncTopNewButtons() {
  if (!el.newChatBtn) return;
  const hasProject = !!getProject(state.activeProjectId);
  el.newChatBtn.disabled = !hasProject;
  el.newChatBtn.title = hasProject
    ? "Start a new chat in the current project (⌘N / Ctrl+N)"
    : "Add a project folder first";
}
export function deleteConversation(p, c) {
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
