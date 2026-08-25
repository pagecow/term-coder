// 24-init.js — classic script (converted from an ES module; see REFACTOR_PLAN.md).
// Exports are registered on the shared window.termCoder namespace (TC).
(function () {
"use strict";
const TC = window.termCoder = window.termCoder || {};
async function init() {
  // restore state + settings
  try {
    const saved = await window.chatoss.scopedData.get(TC.STORE_KEY);
    // `state` is an imported binding (read-only) — merge INTO the exported
    // object instead of rebinding it. 00-state.js already declares the same
    // defaults the old code spelled out here.
    if (saved) Object.assign(TC.state, saved);
    if (!TC.state.sectionCollapsed) TC.state.sectionCollapsed = {};
  } catch (e) { console.warn("restore state", e); }
  // Hydrate conversations + messages from the private SQLite DB (the durable
  // history store). scopedData may be stale or lost after an orchestration
  // session; SQLite is authoritative for conversation history.
  await TC.hydrateFromSqlite();
  try {
    const savedSettings = await window.chatoss.scopedData.get(TC.SETTINGS_KEY);
    // Imported binding — merge in place (same result as the old rebind).
    if (savedSettings) Object.assign(TC.settings, savedSettings);
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
      if (TC.settings[legacyField] != null) {
        try {
          const existing = await window.chatoss.scopedData.get(msKey);
          if (existing === undefined || existing === null) {
            await window.chatoss.scopedData.set(msKey, TC.settings[legacyField]);
          }
        } catch (e) { /* non-fatal */ }
        delete TC.settings[legacyField];
        migratedAny = true;
      }
    }
    if (migratedAny) TC.saveSettings();
  }
  // Restore Model Selection Mode from its own scopedData keys, then render the UI.
  await TC.loadModelSelection();
  // Restore the folder-trust policy ("ask" | "always").
  await TC.loadTrustMode();
  // Restore worktrees created in earlier sessions so they stay mergeable after a
  // reload (buildSystemPrompt surfaces them; list_worktrees enumerates them).
  await TC.loadWorktrees();
  // Restore persisted terminal sessions as read-only "ended" cards so the user
  // immediately sees what ran, what's finished, and the last output — even
  // though the live PTY processes are gone. (Must run AFTER loadWorktrees so
  // worktreeBranchForCwd can match against the restored worktreeMeta.)
  await TC.loadPersistedSessions();
  // Merge in the OS-persisted terminal sessions (terminal.listSessions): the
  // OS now keeps sessions across window close AND app restart, so reattach
  // still-live ones and show ended ones as read-only cards with their saved
  // output. This is the durable store — it survives even if scopedData is lost.
  await TC.loadPlatformSessions();
  // Imported binding — mutate the exported detection object in place.
  Object.assign(TC.detection, {
    codex: !!(TC.settings.detected && TC.settings.detected.codex),
    claude: !!(TC.settings.detected && TC.settings.detected.claude),
    ollama: !!(TC.settings.detected && TC.settings.detected.ollama),
    opencode: !!(TC.settings.detected && TC.settings.detected.opencode),
    models: (TC.settings.detected && TC.settings.detected.models) || [],
    scannedAt: 0, // force a fresh scan at startup
    denied: !!(TC.settings.detected && TC.settings.detected.denied),
    // Restore the resolved direct-CLI paths so the launch-target picker can
    // list claude/codex/opencode immediately on a cold start, before the fresh
    // scan finishes. detectTools refreshes these with live values shortly after.
    claudePath: (TC.settings.detected && TC.settings.detected.claudePath) || null,
    codexPath: (TC.settings.detected && TC.settings.detected.codexPath) || null,
    opencodePath: (TC.settings.detected && TC.settings.detected.opencodePath) || null,
  });

  // Load the model list, retrying in the background when it comes back empty.
  // On a FRESH INSTALL the OS model service can still be warming up on the very
  // first boot: listModels() then returns [] (or rejects), the picker stayed
  // empty, and the app looked model-less until a full close+reopen. Retrying
  // for ~25s and re-rendering the picker fixes the first-run experience; the
  // picker also retries lazily on focus (see the focus listener below).
  await TC.loadModels();
  if (!TC.models.length) TC.scheduleModelRetries();

  // model picker change → persist on the conversation (render never mutates state)
  TC.el.modelPicker.addEventListener("change", () => {
    const c = TC.activeConversation();
    if (c) { c.modelId = TC.el.modelPicker.value; TC.saveState(); }
    TC.renderEffortPicker();
    TC.renderTokenEstimator();
  });
  // Lazy recovery: if the picker was opened while the model list is empty (the
  // first-install warm-up case), reload it on the spot so the dropdown fills in.
  TC.el.modelPicker.addEventListener("focus", () => {
    if (!TC.models.length) TC.loadModels();
  });
  TC.el.effortPicker.addEventListener("change", () => {
    const c = TC.activeConversation();
    if (c) { c.effort = TC.selectedEffort(); TC.saveState(); }
  });

  // top bar + left column
  TC.el.settingsBtn.addEventListener("click", TC.openSettings);
  if (TC.el.newChatBtn) TC.el.newChatBtn.addEventListener("click", TC.newChatFromTopbar);
  if (TC.el.newProjectTopBtn) TC.el.newProjectTopBtn.addEventListener("click", TC.newProject);

  // middle column
  TC.el.copyConvBtn.addEventListener("click", TC.copyConversation);
  TC.el.attachBoardBtn.addEventListener("click", TC.openBoardPicker);
  if (TC.el.detachBoardBtn) TC.el.detachBoardBtn.addEventListener("click", TC.detachBoard);
  if (TC.el.addFileBtn) TC.el.addFileBtn.addEventListener("click", TC.addFileFromPicker);
  // Image preview modal close handlers
  if (TC.el.imagePreviewClose) TC.el.imagePreviewClose.addEventListener("click", TC.closeImagePreview);
  // Drag-and-drop file import (capability "fileDrop"): any file dropped on the
  // app window is added to the chat's attachments (images show a preview strip).
  try {
    window.chatoss.files.onDrop(async (files) => {
      if (!files || !files.length) return;
      for (const f of files) await TC.addDroppedFile(f);
    });
  } catch (e) { console.warn("onDrop not available", e); }
  TC.el.chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = TC.el.chatInput.value.trim();
    if (TC.running) {
      if (text) {
        // Mid-run message: interrupt the current orchestrator turn and continue
        // with the new message (delivered as a fresh turn, not a plain stop).
        TC.interruptAndSend(text);
      } else if (TC.abortController) {
        TC.abortController.abort(); // plain stop — no new message
      }
      return;
    }
    TC.sendMessage();
  });
  // Enter sends, Shift+Enter newline
  TC.el.chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      TC.el.chatForm.requestSubmit();
    }
  });
  // Smooth auto-resize: the textarea grows with content up to a max height.
  const autoResizeInput = () => {
    TC.el.chatInput.style.height = "auto";
    TC.el.chatInput.style.height = Math.min(TC.el.chatInput.scrollHeight, 160) + "px";
    // Keep the askChoice overlay above the now-taller composer.
    TC.syncOverlayOffset();
  };
  TC.el.chatInput.addEventListener("input", () => {
    autoResizeInput();
    // While a turn runs the send button doubles as Stop; typing flips it back
    // to Send so the user can see their message will be delivered.
    TC.syncSendButton();
    TC.renderTokenEstimator();
  });

  // Chat scroll tracking — show the "Jump to latest" button when scrolled up,
  // and pause auto-scroll while streaming so the user can read history.
  if (TC.el.chatScroll) {
    TC.el.chatScroll.addEventListener("scroll", TC.chatScrollListener, { passive: true });
  }
  if (TC.el.chatJumpBtn) {
    TC.el.chatJumpBtn.addEventListener("click", () => TC.scrollChatBottom(true));
  }
  // Delegated copy handler for code-block copy buttons.
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest && e.target.closest("[data-code-copy]");
    if (!btn) return;
    const codeEl = document.getElementById(btn.getAttribute("data-code-copy"));
    if (!codeEl) return;
    const text = codeEl.textContent || "";
    const ok = await TC.copyToClipboard(text);
    const orig = btn.textContent;
    btn.textContent = ok ? "Copied!" : "Failed";
    btn.classList.toggle("is-copied", !!ok);
    setTimeout(() => { btn.textContent = orig; btn.classList.remove("is-copied"); }, 1400);
  });

  // right column — both "new session" buttons open the SAME spawn modal
  const openManualSpawn = () => {
    TC.openSpawnModal({ source: "manual" }).then((choice) => {
      if (!choice) return; // cancelled — session already started inside onSpawnStart
    });
  };
  TC.el.newSessionBtn.addEventListener("click", openManualSpawn);
  if (TC.el.newSessionBtn2) TC.el.newSessionBtn2.addEventListener("click", openManualSpawn);

  // right column — view-mode switcher (squares / columns / rows)
  if (TC.el.termViewSwitcher) {
    TC.el.termViewSwitcher.addEventListener("click", (e) => {
      const btn = e.target.closest && e.target.closest(".term-view-btn");
      if (!btn) return;
      const view = btn.dataset.view;
      if (!view || view === TC.state.termView) return;
      TC.setTermView(view);
    });
  }

  // spawn modal
  TC.el.spawnCli.addEventListener("change", TC.syncSpawnModelRow);
  TC.el.spawnStart.addEventListener("click", TC.onSpawnStart);
  TC.el.spawnCancel.addEventListener("click", TC.onSpawnCancel);
  TC.el.spawnCancelX.addEventListener("click", TC.onSpawnCancel);
  TC.el.spawnPrompt.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); TC.onSpawnStart(); }
  });

  // settings panel
  TC.el.setCli.addEventListener("change", TC.syncSettingsModelRow);
  TC.el.settingsSave.addEventListener("click", TC.saveSettingsFromPanel);
  TC.el.settingsCancel.addEventListener("click", () => TC.el.settingsPanel.classList.add("hidden"));

  // Model Selection Mode — radios toggle pickers live + persist immediately.
  TC.el.modelModeRadios.addEventListener("change", (e) => {
    if (e.target && e.target.name === "model-mode") {
      TC.showModelModePanel(e.target.value);
      TC.saveModelSelectionMode();
    }
  });
  TC.el.alwaysModel.addEventListener("change", () => { TC.syncEffortRows(); TC.saveModelSelectionMode(); });
  TC.el.complexityModelLow.addEventListener("change", () => { TC.syncEffortRows(); TC.saveModelSelectionMode(); });
  TC.el.complexityModelMedium.addEventListener("change", () => { TC.syncEffortRows(); TC.saveModelSelectionMode(); });
  TC.el.complexityModelHigh.addEventListener("change", () => { TC.syncEffortRows(); TC.saveModelSelectionMode(); });
  // Effort selects write straight into the per-target map (persisted live).
  TC.bindEffortSelect(TC.el.alwaysEffort, TC.el.alwaysModel);
  TC.bindEffortSelect(TC.el.complexityEffortLow, TC.el.complexityModelLow);
  TC.bindEffortSelect(TC.el.complexityEffortMedium, TC.el.complexityModelMedium);
  TC.bindEffortSelect(TC.el.complexityEffortHigh, TC.el.complexityModelHigh);

  TC.el.rescanBtn.addEventListener("click", async () => {
    TC.el.detectedList.innerHTML = "<div class='detected-scanning'>Scanning…</div>";
    await TC.detectTools(true);
    TC.renderDetectedList();
    // refresh the model pickers with the newly detected models, preserving
    // the saved selections where the model is still available.
    TC.applyModelSelectionModeToUi();
  });

  // updates (Settings → Check for updates)
  TC.el.checkUpdatesBtn.addEventListener("click", TC.checkForUpdates);
  TC.el.openReleasesBtn.addEventListener("click", TC.openReleasesPage);

  // board picker
  TC.el.boardPickerX.addEventListener("click", () => TC.el.boardPicker.classList.add("hidden"));

  // project + branch bar (under the composer)
  if (TC.el.pbProjectBtn) TC.el.pbProjectBtn.addEventListener("click", (e) => { e.stopPropagation(); TC.pbOpenProjectSelector(); });
  if (TC.el.pbBranchBtn) TC.el.pbBranchBtn.addEventListener("click", (e) => { e.stopPropagation(); TC.pbOpenBranchSelector(); });
  // Close the selector on outside click.
  document.addEventListener("click", (e) => {
    if (TC.pbOpen && TC.el.pbPopover && !TC.el.pbPopover.hidden) {
      if (TC.el.pbBar && TC.el.pbBar.contains(e.target)) return;
      TC.pbClose();
    }
  });

  // Token estimator — toggle popover on click, close on outside click.
  if (TC.el.tokenEstimatorBtn) {
    TC.el.tokenEstimatorBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      TC.toggleTokenPopover();
    });
  }
  document.addEventListener("click", (e) => {
    if (!TC.el.tokenPopover || TC.el.tokenPopover.hidden) return;
    if (TC.el.tokenEstimator && TC.el.tokenEstimator.contains(e.target)) return;
    TC.closeTokenPopover();
  });

  // history browser (past conversations + terminal sessions)
  TC.initHistoryBrowser();

  // backdrop click closes modals
  for (const [modal, closer] of [
    [TC.el.spawnModal, TC.onSpawnCancel],
    [TC.el.settingsPanel, () => TC.el.settingsPanel.classList.add("hidden")],
    [TC.el.boardPicker, () => TC.el.boardPicker.classList.add("hidden")],
    [TC.el.historyModal, TC.closeHistoryBrowser],
    [TC.el.imagePreviewModal, TC.closeImagePreview],
  ]) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal || (e.target.classList && e.target.classList.contains("tc-backdrop"))) closer();
    });
  }

  // Esc closes any open modal (spawn first — its wait must resolve)
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!TC.el.spawnModal.classList.contains("hidden")) TC.onSpawnCancel();
    else if (!TC.el.settingsPanel.classList.contains("hidden")) TC.el.settingsPanel.classList.add("hidden");
    else if (!TC.el.boardPicker.classList.contains("hidden")) TC.el.boardPicker.classList.add("hidden");
    else if (!TC.el.historyModal.classList.contains("hidden")) TC.closeHistoryBrowser();
    else if (TC.el.imagePreviewModal && !TC.el.imagePreviewModal.classList.contains("hidden")) TC.closeImagePreview();
    else if (TC.el.tokenPopover && !TC.el.tokenPopover.hidden) TC.closeTokenPopover();
    else if (TC.pbOpen) TC.pbClose();
  });

  // column resizers (restores any saved layout)
  TC.initColumnResizers();
  // terminal resize handles (columns width / rows height) — delegated on the grid
  TC.initTermResize();

  // window resize → re-clamp a saved layout, then refit visible terminals
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (TC.settings.layout && TC.settings.layout.projects && TC.settings.layout.chat) {
        // Re-clamp: the window may now be narrower than the saved widths.
        TC.applyColWidths(TC.settings.layout.projects, TC.settings.layout.chat, { fit: false });
      }
      for (const rec of TC.sessions.values()) TC.fitTerminal(rec);
      // Keep the user terminal's PTY fitted when the window changes too.
      if (TC.userTerm.open) requestAnimationFrame(TC.userTermFit);
    }, 120);
  });

  // ---- User terminal (bottom drawer) wiring ----
  // Toggled by the sidebar footer icon OR the Cmd/Ctrl+J shortcut. Entirely
  // user-driven — the orchestrator never touches it.
  if (TC.el.userTermBtn) TC.el.userTermBtn.addEventListener("click", TC.userTermToggle);
  if (TC.el.userTermClose) TC.el.userTermClose.addEventListener("click", TC.userTermClose);
  if (TC.el.userTermClear) TC.el.userTermClear.addEventListener("click", () => TC.userTermClear().catch((e) => console.warn("userTermClear", e)));
  if (TC.el.userTermRestart) TC.el.userTermRestart.addEventListener("click", () => TC.userTermRestart().catch((e) => console.warn("userTermRestart", e)));
  TC.initUserTermResizer();

  // Cmd+J (mac) / Ctrl+J toggles the bottom drawer. Only fires on the modifier
  // combo — a plain "j" while typing in any input (including the orchestrator's
  // chat box) must never toggle, so we require metaKey OR ctrlKey explicitly.
  document.addEventListener("keydown", (e) => {
    const isCombo = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey &&
      (e.key === "j" || e.key === "J" || e.code === "KeyJ");
    if (!isCombo) return;
    e.preventDefault();
    TC.userTermToggle();
  });

  // Cmd+N (mac) / Ctrl+N — new chat in the current project, same as the
  // top-bar "New chat" button and the + on a project row. Repeated presses
  // reuse the one empty draft until a post is made (see newConversation).
  document.addEventListener("keydown", (e) => {
    const isCombo = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey &&
      (e.key === "n" || e.key === "N" || e.code === "KeyN");
    if (!isCombo) return;
    e.preventDefault();
    TC.newChatFromTopbar();
  });

  // Wake the orchestrator when a delegated agent finishes its turn.
  TC.startAutoFollow();

  // Periodic session health check: detect stalled agents (quiet but still
  // WORKING/STARTING) and nudge them back to life, or surface them so the user
  // can intervene. Runs every HEALTH_CHECK_MS while the app is open.
  setInterval(() => {
    TC.runHealthCheck().catch((e) => console.warn("healthCheck", e));
  }, TC.HEALTH_CHECK_MS);

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
    TC.cancelPendingPersistSessions();
    TC.persistSessions().catch((e) => console.warn("flushSessions", e));
    TC.userTermPersist();
    // Also flush the SQLite conversation mirror immediately (cancel the
    // debounce) so the very last message of a session is not lost to the
    // 700ms timer when the window closes right after it.
    TC.cancelPendingSqliteSync();
    TC.syncConversationsToSqlite().catch((e) => console.warn("flushSqliteSync", e));
  };
  // Kill the user's shell ONLY on a real app close — NOT on visibilitychange.
  // On macOS, swiping to another Space fires visibilitychange("hidden"); if we
  // killed the shell there, the prompt would vanish when the user swiped back.
  // The shell must stay alive (and its xterm mounted) until the user closes the
  // drawer with the × button, or the app actually quits.
  const flushAndShutdown = () => {
    flushSessions();
    TC.userTermShutdown().catch((e) => console.warn("userTermShutdown", e));
  };
  window.addEventListener("pagehide", flushAndShutdown);
  window.addEventListener("beforeunload", flushAndShutdown);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flushSessions();
    } else if (document.visibilityState === "visible" && TC.userTerm.open) {
      // Coming back from another Space: the shell + xterm persisted, but the
      // window dimensions may have shifted while we were away — refit so the
      // prompt stays correctly laid out.
      requestAnimationFrame(() => TC.userTermFit());
    }
  });

  // initial render
  TC.renderProjects();
  TC.renderChat();
  TC.renderSessionInfo();
  TC.renderTokenEstimator();
  TC.renderProjectBranchBar();
  // Code editor column: bind events + restore the saved width (the pane stays
  // hidden until a file is opened).
  if (TC.settings.editorWidth) TC.editorState.size = TC.settings.editorWidth;
  TC.initEditor();
  // Render restored (persisted) terminal sessions as ended cards BEFORE the
  // empty-state check, so a reopen with prior sessions shows them instead of
  // "No active sessions". Newest first so the most recent work is on top.
  if (TC.deadSessions.size) {
    const snaps = [...TC.deadSessions.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    for (const snap of snaps) TC.renderDeadSessionCard(snap);
  }
  TC.ensureEmptyHint();
  // Apply the saved view mode (defaults to "squares") to the grid + switcher.
  TC.setTermView(TC.state.termView || "squares");
  TC.renderTabs();

  // hide loading
  TC.el.loading.classList.add("hidden");

  // Overlay offset tracking — AFTER the first render and after the loading veil
  // is gone, so the composer stack it measures is actually laid out. Measuring
  // during event binding read a session-info of height 0 and left the askChoice
  // picker overlapping the composer until the next resync.
  TC.initOverlayOffset();
  requestAnimationFrame(TC.syncOverlayOffset);

  // auto-detection at startup (non-blocking; cached 60s). If terminal is
  // denied, everything degrades to "ask" mode — no crash.
  TC.detectTools(true).catch((e) => console.warn("detect", e));

  // Restore the user terminal drawer if it was open on the last run. Done last
  // so the app's main layout is fully laid out before the drawer slides up.
  TC.userTermRestore().catch((e) => console.warn("userTermRestore", e));
}
// --- exports ---
TC.init = init;
})();
