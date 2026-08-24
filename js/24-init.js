import { HEALTH_CHECK_MS, SETTINGS_KEY, STORE_KEY, abortController, claudePath, codexPath, deadSessions, detection, models, opencodePath, running, sessions, settings, state } from "./00-state.js";
import { _persistSessionsTimer, loadPersistedSessions, loadWorktrees, persistSessions, renderDeadSessionCard } from "./01-sessions.js";
import { _sqliteSyncTimer, hydrateFromSqlite, loadPlatformSessions, syncConversationsToSqlite } from "./02-sqlite.js";
import { closeHistoryBrowser, initHistoryBrowser } from "./03-history.js";
import { el } from "./04-dom.js";
import { activeConversation, detectTools, saveSettings, saveState } from "./05-util.js";
import { onSpawnCancel, onSpawnStart, openSettings, openSpawnModal, renderDetectedList, saveSettingsFromPanel, syncSettingsModelRow, syncSpawnModelRow } from "./07-spawn.js";
import { applyModelSelectionModeToUi, bindEffortSelect, checkForUpdates, loadModelSelection, loadTrustMode, openReleasesPage, saveModelSelectionMode, showModelModePanel, syncEffortRows } from "./08-settings.js";
import { openBoardPicker, pbClose, pbOpen, pbOpenBranchSelector, pbOpenProjectSelector, renderProjectBranchBar } from "./10-project-branch.js";
import { editorState, initEditor, newChatFromTopbar, newProject, renderProjects } from "./11-projects.js";
import { copyToClipboard, detachBoard } from "./12-markdown.js";
import { chatScrollListener, renderChat, scrollChatBottom } from "./13-chat.js";
import { loadModels, renderEffortPicker, scheduleModelRetries, selectedEffort } from "./14-models.js";
import { closeTokenPopover, renderTokenEstimator, toggleTokenPopover } from "./15-tokens.js";
import { addDroppedFile, addFileFromPicker, closeImagePreview, copyConversation } from "./16-attachments.js";
import { interruptAndSend, sendMessage, syncSendButton } from "./18-send.js";
import { startAutoFollow } from "./19-autofollow.js";
import { ensureEmptyHint, fitTerminal, renderSessionInfo, renderTabs, runHealthCheck, setTermView } from "./20-terminal.js";
import { initOverlayOffset, syncOverlayOffset } from "./21-askchoice.js";
import { applyColWidths, initColumnResizers, initTermResize } from "./22-resizers.js";
import { initUserTermResizer, userTerm, userTermClear, userTermClose, userTermFit, userTermPersist, userTermRestart, userTermRestore, userTermShutdown, userTermToggle } from "./23-userterm.js";
export async function init() {
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

  // project + branch bar (under the composer)
  if (el.pbProjectBtn) el.pbProjectBtn.addEventListener("click", (e) => { e.stopPropagation(); pbOpenProjectSelector(); });
  if (el.pbBranchBtn) el.pbBranchBtn.addEventListener("click", (e) => { e.stopPropagation(); pbOpenBranchSelector(); });
  // Close the selector on outside click.
  document.addEventListener("click", (e) => {
    if (pbOpen && el.pbPopover && !el.pbPopover.hidden) {
      if (el.pbBar && el.pbBar.contains(e.target)) return;
      pbClose();
    }
  });

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
    else if (pbOpen) pbClose();
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
  renderProjectBranchBar();
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
