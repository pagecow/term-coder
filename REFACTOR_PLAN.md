# REFACTOR_PLAN — Structural Map of `app.js`

> Read-only structural analysis. Produced by shell inspection only (grep/awk/sed/wc) — the 504 KB file was never loaded whole into context.

---

## 0. CRITICAL FINDING — a module split already exists in `js/`

Before any new refactor work begins, note this: **the repository already contains a complete ES-module split of `app.js`** in the `js/` directory, committed in the WIP commit `bf1d672` on the current `refactor-modules` branch.

- `js/` holds 25 files: `00-state.js` … `24-init.js` plus `main.js`.
- `js/` totals **10,516 lines** vs `app.js`'s **10,340 lines** — a near-1:1 split.
- The modules use real `export` statements (e.g. `js/00-state.js` exports `STORE_KEY`, `SETTINGS_KEY`; `js/24-init.js` exports `async function init()`).
- `js/main.js` imports every module in order and calls `init()`.
- **`index.html` still loads `app.js` directly** (`<script type="module" src="app.js"></script>` at line 502) and does **not** reference `js/main.js` or any `js/` module.

**Implication:** the "later refactor" this plan is meant to enable has already been performed as a first pass. The safe next step is to *verify the `js/` split against `app.js`* (function-for-function, and for any drift since the split was authored) and then flip `index.html` to load `js/main.js` — not to re-derive the module boundaries from scratch. The module map below doubles as the verification checklist.

---

## 1. Total line count

| File | Lines | Bytes |
|---|---|---|
| `app.js` | **10,340** | 504,786 |
| `index.html` | 1,xxx | 29,505 |
| `style.css` | — | 97,323 |

Top-level declarations in `app.js`:
- **266** top-level `function` / `async function` declarations.
- **98** top-level `const` / `let` declarations.

---

## 2. Top-level function declarations (name → line)

Full list, grouped by the section they live in (see §4 for module assignment). 266 total.

### State / sessions / health-check (lines 1–637)
| Function | Line |
|---|---|
| `loginShell` | 56 |
| `detectAgentError` | 240 |
| `sessionActivity` | 255 |
| `formatSessionStatusOutput` | 290 |
| `saveWorktrees` | 376 |
| `loadWorktrees` | 384 |
| `worktreeBranchForCwd` | 404 |
| `snapshotLiveSession` | 435 |
| `schedulePersistSessions` | 474 |
| `persistSessions` | 481 |
| `loadPersistedSessions` | 502 |
| `renderDeadSessionCard` | 535 |
| `dismissDeadSession` | 618 |

### SQLite persistence layer (lines 638–1095)
| Function | Line |
|---|---|
| `sqliteInterpolate` | 704 |
| `sqliteLiteral` | 720 |
| `_sqliteExecRaw` | 730 |
| `_sqliteQueryRaw` | 740 |
| `sqliteExec` | 750 |
| `sqliteQuery` | 758 |
| `sqliteInit` | 768 |
| `scheduleSqliteSync` | 825 |
| `syncConversationsToSqlite` | 833 |
| `sqlitePersistToolCall` | 875 |
| `sqliteDeleteConversation` | 887 |
| `sqliteDeleteProject` | 896 |
| `hydrateFromSqlite` | 914 |
| `sqliteSyncTerminalSessions` | 962 |
| `sqliteDeleteTerminalSession` | 979 |
| `sqliteGetTerminalMeta` | 986 |
| `decodeBase64` | 995 |
| `loadPlatformSessions` | 1004 |
| `sqliteSyncWorktrees` | 1065 |
| `sqliteHydrateWorktrees` | 1085 |

### History browser (lines 1096–1420)
| Function | Line |
|---|---|
| `fmtTime` | 1103 |
| `openHistoryBrowser` | 1114 |
| `closeHistoryBrowser` | 1119 |
| `renderHistoryBrowser` | 1123 |
| `renderHistoryConversations` | 1136 |
| `historyReopenConversation` | 1188 |
| `historyDeleteConversation` | 1206 |
| `renderHistoryTerminals` | 1215 |
| `historyViewTerminal` | 1326 |
| `historyKillTerminal` | 1375 |
| `initHistoryBrowser` | 1399 |

### Utils (lines 1553–1634)
| Function | Line |
|---|---|
| `esc` | 1554 |
| `basename` | 1559 |
| `uuid` | 1564 |
| `saveState` | 1569 |
| `saveSettings` | 1576 |
| `getProject` | 1580 |
| `getConversation` | 1581 |
| `activeConversation` | 1585 |
| `defaultCwd` | 1586 |
| `setStatus` | 1593 |
| `normalizeToolCall` | 1618 |

### Auto-detection (lines 1635–1758)
| Function | Line |
|---|---|
| `parseOllamaModels` | 1636 |
| `detectTools` | 1649 |

### PTY input (lines 2187–2686)
| Function | Line |
|---|---|
| `hasNativeInput` | 2206 |
| `sendKey` | 2209 |
| `sendText` | 2222 |
| `bracketedPasteOn` | 2234 |
| `parseTerminalEscapes` | 2254 |
| `stripAnsi` | 2284 |
| `cleanApprovalText` | 2333 |
| `autoDriveStartup` | 2379 |

### Tool handlers (lines 2687–3697)
| Function | Line |
|---|---|
| `resolveProject` | 2690 |
| `resolveBoardId` | 2694 |
| `toolHandler` | 2699 |

### Spawn modal (lines 3698–4013)
| Function | Line |
|---|---|
| `buildCliOptions` | 3706 |
| `syncSpawnModelRow` | 3728 |
| `openSpawnModal` | 3742 |
| `closeSpawnModal` | 3806 |
| `onSpawnStart` | 3814 |
| `onSpawnCancel` | 3910 |
| `spawnChosen` | 3914 |
| `renderDetectedList` | 4015 |

### Settings / updates / model-selection / launch-targets / effort (lines 4014–4550)
| Function | Line |
|---|---|
| `openSettings` | 4078 |
| `syncSettingsModelRow` | 4092 |
| `saveSettingsFromPanel` | 4097 |
| `parseVersion` | 4121 |
| `compareVersions` | 4127 |
| `fetchLatestVersion` | 4139 |
| `checkForUpdates` | 4185 |
| `openReleasesPage` | 4214 |
| `allOllamaModels` | 4228 |
| `availableOllamaModels` | 4243 |
| `availableLaunchTargets` | 4263 |
| `findLaunchTarget` | 4286 |
| `targetKind` | 4294 |
| `cliDefaultToTargetId` | 4323 |
| `launchTargetChoiceOptions` | 4336 |
| `populateModelSelect` | 4345 |
| `effortForTarget` | 4397 |
| `effortOptionsForTarget` | 4411 |
| `populateEffortSelect` | 4437 |
| `syncEffortRows` | 4451 |
| `bindEffortSelect` | 4461 |
| `showModelModePanel` | 4486 |
| `applyModelSelectionModeToUi` | 4494 |
| `saveModelSelectionMode` | 4516 |
| `persistModelSelection` | 4527 |
| `loadModelSelection` | 4537 |

### Trust / complexity (lines 4551–4823)
| Function | Line |
|---|---|
| `loadTrustMode` | 4553 |
| `persistTrustMode` | 4559 |
| `applyTrustModeToUi` | 4564 |
| `saveTrustMode` | 4570 |
| `askCommandApproval` | 4580 |
| `askTrustInChat` | 4607 |
| `assessComplexity` | 4676 |

### Board picker + project/branch bar (lines 4824–5424)
| Function | Line |
|---|---|
| `openBoardPicker` | 4825 |
| `detectMainBranch` | 4873 |
| `orderBranches` | 4883 |
| `filterBranches` | 4898 |
| `pbGit` | 4907 |
| `pbFetchBranches` | 4922 |
| `renderProjectBranchBar` | 4933 |
| `pbClose` | 4945 |
| `pbOpenProjectSelector` | 4954 |
| `pbOpenBranchSelector` | 4999 |
| `pbSwitchBranch` | 5132 |
| `pbCreateBranch` | 5156 |

### Projects / sidebar / file-tree / editor (lines 5186–6248)
| Function | Line |
|---|---|
| `renderProjects` | 5190 |
| `sessionsForActiveConversation` | 5433 |
| `paintProjSessions` | 5440 |
| `resetFileTree` | 5518 |
| `listDirEntries` | 5529 |
| `sortEntries` | 5548 |
| `loadDir` | 5556 |
| `ensureFileWatch` | 5566 |
| `renderFileTree` | 5589 |
| `repaintFileTree` | 5645 |
| `paintFileTree` | 5652 |
| `fileTreeNote` | 5716 |
| `fileIcon` | 5724 |
| `openFileInEditor` | 5767 |
| `openEditorPane` | 5795 |
| `closeEditorPane` | 5809 |
| `editorIsDirty` | 5829 |
| `editorRefreshDirty` | 5833 |
| `editorSetStatus` | 5840 |
| `editorSave` | 5846 |
| `editorConfirm` | 5864 |
| `initEditor` | 5888 |
| `renameProject` | 5965 |
| `renameConversation` | 5991 |
| `confirmDelete` | 6016 |
| `selectProject` | 6028 |
| `selectConversation` | 6052 |
| `newProject` | 6061 |
| `deleteProject` | 6078 |
| `nameFromFirstMessage` | 6100 |
| `conversationHasPosts` | 6116 |
| `preferredConversation` | 6123 |
| `toggleProjSection` | 6134 |
| `newConversation` | 6143 |
| `newChatFromTopbar` | 6176 |
| `syncTopNewButtons` | 6188 |
| `deleteConversation` | 6196 |
| `resolveBoardName` | 6212 |
| `renderBoardChip` | 6224 |
| `detachBoard` | 6241 |

### Markdown / highlight / widgets (lines 6249–6854)
| Function | Line |
|---|---|
| `mdEscape` | 6254 |
| `mdInline` | 6264 |
| `mdRenderTable` | 6295 |
| `mdRenderList` | 6314 |
| `renderMarkdown` | 6344 |
| `hlLangFor` | 6446 |
| `hlLine` | 6463 |
| `hlEscape` | 6486 |
| `highlightCode` | 6492 |
| `renderCodeBlockHtml` | 6513 |
| `copyToClipboard` | 6531 |
| `createThinkingWidget` | 6561 |
| `createActivityCard` | 6628 |
| `buildActivityRecord` | 6712 |
| `createToolChip` | 6730 |

### Chat render (lines 6855–6974)
| Function | Line |
|---|---|
| `chatScrollListener` | 6860 |
| `scrollChatBottom` | 6867 |
| `maybeScrollChatBottom` | 6875 |
| `createTypingIndicator` | 6878 |
| `updateChatEmpty` | 6893 |
| `renderChat` | 6898 |
| `renderMessage` | 6929 |

### Models (lines 6975–7106)
| Function | Line |
|---|---|
| `loadModels` | 6979 |
| `scheduleModelRetries` | 6996 |
| `renderModelPicker` | 7014 |
| `selectedModelSupportsEffort` | 7051 |
| `orchestratorEffortLevels` | 7060 |
| `renderEffortPicker` | 7066 |
| `selectedModel` | 7101 |
| `selectedEffort` | 7102 |

### Token estimator (lines 7107–7246)
| Function | Line |
|---|---|
| `estimateTokens` | 7110 |
| `maxTokensForModel` | 7120 |
| `estimateToolTokens` | 7132 |
| `computeTokenBreakdown` | 7147 |
| `renderTokenEstimator` | 7172 |
| `renderTokenPopover` | 7204 |
| `openTokenPopover` | 7231 |
| `closeTokenPopover` | 7237 |
| `toggleTokenPopover` | 7242 |

### Attachments (lines 7247–7439)
| Function | Line |
|---|---|
| `getAttachments` | 7252 |
| `setAttachments` | 7258 |
| `renderAttachmentStrip` | 7267 |
| `removeAttachment` | 7308 |
| `openImagePreview` | 7314 |
| `closeImagePreview` | 7319 |
| `addFileFromPicker` | 7326 |
| `addFileByPath` | 7338 |
| `addDroppedFile` | 7368 |
| `addAttachment` | 7388 |
| `arrayBufferToBase64` | 7396 |
| `buildMessageContent` | 7405 |
| `clearAttachments` | 7436 |

### Copy conversation + system prompt (lines 7440–7768)
| Function | Line |
|---|---|
| `conversationToText` | 7443 |
| `syncCopyConvBtn` | 7467 |
| `copyConversation` | 7481 |
| `buildSystemPrompt` | 7508 |

### Send / orchestrator turn (lines 7769–8139)
| Function | Line |
|---|---|
| `runToolWithTimeout` | 7777 |
| `setRunning` | 7813 |
| `syncSendButton` | 7829 |
| `sendMessage` | 7842 |
| `runOrchestratorTurn` | 7891 |

### Mid-run delivery + auto-follow (lines 8140–8318)
| Function | Line |
|---|---|
| `waitForTurnEnd` | 8158 |
| `interruptAndSend` | 8172 |
| `autoFollowTick` | 8252 |
| `startAutoFollow` | 8296 |
| `stopAutoFollow` | 8314 |

### Terminal grid + health check (lines 8319–9083)
| Function | Line |
|---|---|
| `refreshSessionVisibility` | 8325 |
| `ensureEmptyHint` | 8343 |
| `setTermView` | 8354 |
| `renderTabs` | 8376 |
| `selectSession` | 8389 |
| `registerSession` | 8403 |
| `fitTerminal` | 8948 |
| `toggleExpand` | 8960 |
| `runHealthCheck` | 8973 |
| `closeSession` | 9013 |
| `renderSessionInfo` | 9063 |

### Ask-choice component (lines 9084–9287)
| Function | Line |
|---|---|
| `setPromptPending` | 9120 |

### Column resizers (lines 9288–9398)
| Function | Line |
|---|---|
| `syncOverlayOffset` | 9258 |
| `initOverlayOffset` | 9272 |
| `shellEl` | 9295 |
| `currentColWidths` | 9297 |
| `applyColWidths` | 9311 |
| `resetColWidths` | 9336 |
| `initColumnResizers` | 9346 |

### Terminal resize + user terminal (lines 9399–9892)
| Function | Line |
|---|---|
| `initTermResize` | 9409 |
| `userTermCwd` | 9500 |
| `userTermSpawn` | 9512 |
| `userTermMount` | 9563 |
| `measureUserTermCells` | 9605 |
| `userTermFit` | 9636 |
| `userTermUnmount` | 9658 |
| `userTermKill` | 9664 |
| `userTermPersist` | 9675 |
| `userTermApplyHeight` | 9691 |
| `userTermOpen` | 9702 |
| `userTermClose` | 9761 |
| `userTermToggle` | 9777 |
| `userTermFocus` | 9783 |
| `userTermRestart` | 9790 |
| `userTermClear` | 9818 |
| `initUserTermResizer` | 9830 |
| `userTermRestore` | 9875 |
| `userTermShutdown` | 9889 |

### Init (lines 9893–10340)
| Function | Line |
|---|---|
| `init` | 9894 |

---

## 3. Top-level `const` / `let` state variables (name → line)

98 total. Grouped by owning section.

### Constants / paths (lines 1–59)
| Var | Line | Note |
|---|---|---|
| `STORE_KEY` | 5 | `"term-coder.state"` |
| `SETTINGS_KEY` | 6 | `"term-coder.settings"` |
| `WORKTREES_KEY` | 7 | `"term-coder.worktrees"` |
| `SESSIONS_KEY` | 13 | `"term-coder.sessions"` |
| `FALLBACK_MODELS` | 14 | default model list |
| `DETECT_TTL_MS` | 15 | 60s detection cache |
| `APP_VERSION` | 19 | `"1.22.0"` |
| `OLLAMA_LAUNCH_TOOLS` | 26 | launch-tool list |
| `ollamaPath` | 35 | `let` |
| `OLLAMA_GUESSES` | 36 | path guesses |
| `claudePath` | 45 | `let` |
| `codexPath` | 46 | `let` |
| `opencodePath` | 47 | `let` |
| `CLAUDE_GUESSES` | 50 | |
| `CODEX_GUESSES` | 51 | |
| `OPENCODE_GUESSES` | 52 | |

### State / settings / model-selection (lines 60–134)
| Var | Line | Note |
|---|---|---|
| `state` | 61 | `let` — core app state |
| `settings` | 70 | `let` |
| `modelSelection` | 87 | `let` |
| `MS_KEYS` | 101 | model-selection keys |
| `SUBAGENT_EFFORT_OPTIONS_BASE` | 106 | |
| `CODEX_EFFORT_FLAG_VALUES` | 115 | `Set` |
| `GENERIC_EFFORT_LEVELS` | 121 | |
| `trustMode` | 129 | `let` `"ask"` |
| `models` | 130 | `let` `[]` |
| `defaultModelId` | 131 | `let` |
| `running` | 132 | `let` |
| `abortController` | 133 | `let` |

### Token-estimator constants (lines 135–163)
| Var | Line | Note |
|---|---|---|
| `CONTEXT_WINDOW_MAP` | 139 | |
| `DEFAULT_CONTEXT_WINDOW` | 151 | 128000 |
| `SYSTEM_PROMPT_FALLBACK` | 154 | |
| `_lastSystemPrompt` | 155 | `let` |
| `_lastBreakdown` | 156 | `let` |
| `_lastMax` | 157 | `let` |

### Detection / sessions / health-check (lines 164–238)
| Var | Line | Note |
|---|---|---|
| `detection` | 164 | `let` object |
| `sessions` | 167 | `Map` — live sessions |
| `deadSessions` | 179 | `Map` |
| `ORCH_SENTINEL_RE` | 189 | orchestrator marker regex |
| `APPROVE_BUSY_TIMEOUT_MS` | 195 | 45000 |
| `APPROVE_COOLDOWN_MS` | 200 | 1800 |
| `TURN_IDLE_MS` | 206 | 4000 |
| `MIN_WORK_BYTES` | 210 | 200 |
| `HEALTH_CHECK_MS` | 219 | 5 min |
| `STALL_QUIET_MS` | 220 | 10 min |
| `NUDGE_COOLDOWN_MS` | 221 | 10 min |
| `NUDGE_TEXT` | 222 | |
| `AGENT_ERROR_PATTERNS` | 228 | |
| `ERROR_LOOP_THRESHOLD` | 238 | 3 |

### Persisted sessions (lines 375–473)
| Var | Line | Note |
|---|---|---|
| `worktreeMeta` | 375 | `Map` |
| `_persistSessionsTimer` | 473 | `let` |

### SQLite (lines 673–824)
| Var | Line | Note |
|---|---|---|
| `SQLITE_DB` | 673 | `"termcoder"` |
| `sqliteReady` | 674 | `let` |
| `sqliteInitPromise` | 675 | `let` |
| `sqliteApiShape` | 693 | `let` |
| `sqliteHandle` | 694 | `let` |
| `sqliteName` | 695 | `let` |
| `_sqliteSyncTimer` | 824 | `let` |

### History (line 1101)
| Var | Line | Note |
|---|---|---|
| `historyTab` | 1101 | `let` `"conversations"` |

### Spawn modal (lines 1416–1419)
| Var | Line | Note |
|---|---|---|
| `spawnPromise` | 1416 | `let` |
| `spawnResolve` | 1417 | `let` |
| `spawnModalOpts` | 1419 | `let` |

### DOM refs (lines 1422–1423)
| Var | Line | Note |
|---|---|---|
| `$` | 1422 | `(id) => document.getElementById(id)` |
| `el` | 1423 | big object of cached DOM refs |

### Orchestrator tools (lines 1760–2199)
| Var | Line | Note |
|---|---|---|
| `ORCHESTRATOR_TOOLS` | 1760 | JSON schema array |
| `LEGACY_KEY_BYTES` | 2199 | |

### Updates (lines 4114–4117)
| Var | Line | Note |
|---|---|---|
| `UPDATES_APP_JSON_URL` | 4114 | |
| `UPDATES_CONTENTS_API_URL` | 4115 | |
| `UPDATES_RELEASES_API_URL` | 4116 | |
| `UPDATES_RELEASES_PAGE_URL` | 4117 | |

### Effort (line 4477)
| Var | Line | Note |
|---|---|---|
| `EFFORT_BRIEF` | 4477 | |

### Project/branch (line 4869)
| Var | Line | Note |
|---|---|---|
| `pbOpen` | 4869 | `let` |

### Projects / file-tree / editor (lines 5186–6211)
| Var | Line | Note |
|---|---|---|
| `collapsedProjects` | 5186 | `Set` |
| `HIDDEN_ENTRIES` | 5506 | `Set` |
| `MAX_CHILDREN` | 5507 | 300 |
| `fileTree` | 5509 | cache object |
| `editorState` | 5753 | |
| `isBinaryExt` | 5759 | `(name) => …` |
| `boardNameCache` | 6211 | `{}` |

### Highlight (line 6433)
| Var | Line | Note |
|---|---|---|
| `HL_KEYWORDS` | 6433 | |

### Chat scroll (line 6859)
| Var | Line | Note |
|---|---|---|
| `chatAutoScroll` | 6859 | `let` |

### Models (line 6995)
| Var | Line | Note |
|---|---|---|
| `_modelRetryScheduled` | 6995 | `let` |

### Copy conversation (line 7465)
| Var | Line | Note |
|---|---|---|
| `copyConvTimer` | 7465 | `let` |

### Send (lines 7775–7776)
| Var | Line | Note |
|---|---|---|
| `TOOL_TIMEOUT_MS` | 7775 | 90s |
| `TOOL_TIMEOUT_OVERRIDES` | 7776 | |

### Mid-run / auto-follow (lines 8151–8250)
| Var | Line | Note |
|---|---|---|
| `midRunDeliveryInFlight` | 8151 | `let` |
| `interruptDeliveryActive` | 8152 | `let` |
| `autoFollowTimer` | 8247 | `let` |
| `statusRefreshTimer` | 8248 | `let` |
| `lastAutoFollowAt` | 8249 | `let` |
| `AUTO_FOLLOW_COOLDOWN_MS` | 8250 | 8000 |

### Ask-choice (line 9113)
| Var | Line | Note |
|---|---|---|
| `pendingChoices` | 9113 | `let` |

### Resizers (lines 9271–9293)
| Var | Line | Note |
|---|---|---|
| `overlayRO` | 9271 | `let` |
| `RZ_W` | 9292 | 5 |
| `COL_MIN` | 9293 | `{projects, chat, terminals}` |

### Terminal resize / user terminal (lines 9406–9484)
| Var | Line | Note |
|---|---|---|
| `TERM_MIN_W` | 9406 | 200 |
| `TERM_MIN_H` | 9407 | 120 |
| `USER_TERM_KEY` | 9483 | `"term-coder.userTerm"` |
| `userTerm` | 9484 | `let` object |

---

## 4. Proposed module grouping

The section comment markers in `app.js` (all `// ---------- X ----------` style) map **one-to-one** onto the existing `js/` filenames. The grouping below is therefore both the *proposed* split and the *verification checklist* for the already-authored `js/` split.

| # | Module (proposed file) | Line range | Section marker(s) | Functions |
|---|---|---|---|---|
| 00 | **state** | 1–637 | State (60), Token-estimator consts (135), Health-check consts (212), Persisted sessions (420) | `loginShell`, `detectAgentError`, `sessionActivity`, `formatSessionStatusOutput`, `saveWorktrees`, `loadWorktrees`, `worktreeBranchForCwd`, `snapshotLiveSession`, `schedulePersistSessions`, `persistSessions`, `loadPersistedSessions`, `renderDeadSessionCard`, `dismissDeadSession` |
| 01 | **sessions** | (folded into state in `js/`) | — | (see note) |
| 02 | **sqlite** | 638–1095 | SQLite layer (638), API-shape (677), Conversations (814), Terminal mirror (956), Worktrees mirror (1063) | `sqliteInterpolate` … `sqliteHydrateWorktrees` (20 fns) |
| 03 | **history** | 1096–1420 | History browser (1096) | `fmtTime` … `initHistoryBrowser` (11 fns) |
| 04 | **dom** | 1421–1552 | DOM refs (1421) | `$`, `el` (no functions) |
| 05 | **util** | 1553–1634 | Utils (1553) | `esc` … `normalizeToolCall` (11 fns) |
| 06 | **tools** | 1635–3697 | Auto-detection (1635), ORCHESTRATOR_TOOLS (1759), PTY input (2187, 2242), Tool handlers (2687) | `parseOllamaModels`, `detectTools`, `hasNativeInput`, `sendKey`, `sendText`, `bracketedPasteOn`, `parseTerminalEscapes`, `stripAnsi`, `cleanApprovalText`, `autoDriveStartup`, `resolveProject`, `resolveBoardId`, `toolHandler` |
| 07 | **spawn** | 3698–4013 | Spawn modal (3698) | `buildCliOptions` … `renderDetectedList` (8 fns) |
| 08 | **settings** | 4014–4550 | Settings (4014), Updates (4110), Model-selection (4220), Launch targets (4248), Effort (4388) | `openSettings` … `loadModelSelection` (25 fns) |
| 09 | **complexity** | 4551–4823 | Folder-trust (4551), Model resolution (4646) | `loadTrustMode` … `assessComplexity` (7 fns) |
| 10 | **project-branch** | 4824–5424 | Board picker (4824), Project+branch bar (4858) | `openBoardPicker` … `pbCreateBranch` (12 fns) |
| 11 | **projects** | 5186–6248 | Sidebar sessions (5425), File tree (5498), Editor (5750) | `renderProjects` … `detachBoard` (43 fns) |
| 12 | **markdown** | 6249–6854 | Markdown (6249), Highlight (6427), Thinking widget (6550), Activity card (6623), Tool chip (6726) | `mdEscape` … `createToolChip` (15 fns) |
| 13 | **chat** | 6855–6974 | Chat scroll (6855), Typing (6877), Render chat (6892) | `chatScrollListener` … `renderMessage` (7 fns) |
| 14 | **models** | 6975–7106 | Model loading (6975) | `loadModels` … `selectedEffort` (8 fns) |
| 15 | **tokens** | 7107–7246 | Token estimator (7107) | `estimateTokens` … `toggleTokenPopover` (9 fns) |
| 16 | **attachments** | 7247–7439 | Attachments (7247) | `getAttachments` … `clearAttachments` (13 fns) |
| 17 | **system-prompt** | 7440–7768 | Copy conversation (7440), Build system prompt (7507) | `conversationToText`, `syncCopyConvBtn`, `copyConversation`, `buildSystemPrompt` |
| 18 | **send** | 7769–8139 | Send message (7769) | `runToolWithTimeout` … `runOrchestratorTurn` (5 fns) |
| 19 | **autofollow** | 8140–8318 | Mid-run delivery (8140), Auto-follow (8240) | `waitForTurnEnd`, `interruptAndSend`, `autoFollowTick`, `startAutoFollow`, `stopAutoFollow` |
| 20 | **terminal** | 8319–9083 | Terminal grid (8319), Health check (8968) | `refreshSessionVisibility` … `renderSessionInfo` (11 fns) |
| 21 | **askchoice** | 9084–9287 | Multiple-choice component (9084) | `setPromptPending` |
| 22 | **resizers** | 9288–9398 | Column resizers (9288) | `syncOverlayOffset` … `initColumnResizers` (7 fns) |
| 23 | **userterm** | 9399–9892 | Terminal resize (9399), user terminal (9470) | `initTermResize` … `userTermShutdown` (19 fns) |
| 24 | **init** | 9893–10340 | Init (9893) | `init` |

> **Note on `01-sessions`:** the `js/` split has a dedicated `01-sessions.js`, but in `app.js` the session-persistence functions (`saveWorktrees` … `dismissDeadSession`) live inside the *State* section (lines 420–637) rather than a separately-marked "sessions" section. The `js/` author chose to split state-vs-sessions; the section markers alone would put them together. This is the one place the `js/` boundaries differ from the comment markers — worth verifying during review.

---

## 5. Cross-dependencies & safe extraction order

Universal dependencies (referenced by nearly every module):
- **`el`** (DOM refs) — **389** references across `app.js`.
- **`state`** — **93** references.
- **`settings`** — **38** references.
- **`window.chatoss`** (platform bridge) — **117** references.

Key directed edges (consumer → provider), verified by grep:

| Consumer module | Calls into (provider) | Evidence |
|---|---|---|
| chat (13) | markdown (12) | `renderMessage` → `renderMarkdown` (6961, 6963) |
| chat (13) | tokens (15) | `renderChat` → `renderTokenEstimator` (6927) |
| send (18) | markdown (12) | `runOrchestratorTurn` → `renderMarkdown` (7966, 8060) |
| send (18) | tokens (15) | `sendMessage`/turn → `renderTokenEstimator` (8136) |
| send (18) | system-prompt (17) | `runOrchestratorTurn` → `buildSystemPrompt` (7975) |
| send (18) | tools (06) | `runToolWithTimeout` → `toolHandler` (7796) |
| send (18) | attachments (16) | `buildMessageContent` |
| terminal (20) | markdown (12) | `renderSessionInfo` → `renderMarkdown` (9155) |
| terminal (20) | sqlite (02) | `registerSession`/`closeSession` persist via sqlite |
| tools (06) | spawn (07) | `toolHandler` → `openSpawnModal`/`spawnChosen` (2967, 2976, 3558, 3585) |
| tools (06) | terminal (20) | `toolHandler` → `registerSession` (3088) |
| spawn (07) | detection (06) | `onSpawnStart` → `detectTools` (3761) |
| projects (11) | project-branch (10) | `selectProject` → `renderProjectBranchBar`/`pbFetchBranches` (6043–6093) |
| projects (11) | sqlite (02) | delete/rename persist via sqlite |
| projects (11) | file-tree/editor (self) | internal |
| history (03) | projects (11) | `historyReopenConversation` → `renderProjects` (1197) |
| history (03) | terminal (20) | `historyViewTerminal` → `attachSession` |
| complexity (09) | (self) | `askTrustInChat` → `assessComplexity` (4796) |
| init (24) | **everything** | `init` wires all modules |

### Recommended extraction order (leaf-first)

Extract modules with **no incoming dependencies** first, working toward the entry point. The `js/` numbering already reflects this order:

1. **state (00)** — root; nothing depends on it, it depends on nothing.
2. **dom (04)** — root; `el`/`$` only.
3. **util (05)** — depends on state/dom only.
4. **markdown (12)** — self-contained ("no dependencies" per comment at 6249).
5. **tokens (15)** — depends on state/dom/models.
6. **models (14)** — depends on state/dom/util.
7. **sqlite (02)** — depends on state/dom/util.
8. **complexity (09)** — depends on state/dom/util.
9. **resizers (22)** — depends on state/dom/util.
10. **askchoice (21)** — depends on state/dom/util.
11. **attachments (16)** — depends on state/dom/util.
12. **settings (08)** — depends on state/dom/util/models.
13. **project-branch (10)** — depends on state/dom/util.
14. **spawn (07)** — depends on state/dom/util/detection/models.
15. **tools (06)** — depends on state/dom/util/spawn/terminal/sqlite.
16. **system-prompt (17)** — depends on state/dom/util/tokens/models.
17. **chat (13)** — depends on state/dom/util/markdown/tokens/models.
18. **terminal (20)** — depends on state/dom/util/sqlite.
19. **projects (11)** — depends on state/dom/util/sqlite/project-branch.
20. **send (18)** — depends on state/dom/util/tools/system-prompt/tokens/chat/attachments/models.
21. **autofollow (19)** — depends on state/dom/util/send/terminal.
22. **userterm (23)** — depends on state/dom/util.
23. **init (24)** — depends on everything; extract last.

The only true cycle risk is **tools ↔ spawn ↔ terminal** (tools calls spawn and terminal; spawn calls detection which lives in tools). In the `js/` split this is resolved by keeping detection + PTY + tool-handlers together in `06-tools.js` (the largest module, 112 KB) and having `07-spawn.js` import from it. If a finer split is desired later, `detection`/`PTY-input` should be pulled out of `06-tools.js` into their own leaf module first.

---

## 6. `index.html` script loading order

- Line 20: `<script src="libs/xterm.js"></script>` (UMD global)
- Line 21: `<script src="libs/xterm-addon-fit.js"></script>` (UMD global)
- Line 22–26: inline `<script>` that flattens `window.FitAddon` for the bridge.
- End of `<body>`: **26 classic `<script src="js/NN-*.js">` tags** — the app entry points.

### Why classic scripts, not ES modules (the v1.23.0 breakage)

The first modular release (v1.23.0) shipped the `js/` split as **ES modules**
(`<script type="module" src="js/main.js">` with `import`/`export`). It broke in
two ways:

1. **Read-only import bindings.** Several modules reassigned bindings imported
   from `00-state.js` (`state = …`, `models = …`, `running = …`,
   `abortController = …`, `detection = …`, `trustMode = …`, `ollamaPath = …`).
   In ES modules imported bindings are read-only, so the app died with
   `Failed to start: Attempted to assign to readonly property.` Fixed by
   mutating in place (`Object.assign(state, …)`, `models.splice(…)`) and by
   adding setter functions (`setOllamaPath`, `updateRunning`, …) in
   `00-state.js`.

2. **The ChatOSS preview cannot fetch module imports.** The preview harness
   serves the app as an `about:srcdoc` document in a Tauri webview (base URL
   `tauri://localhost`) and inlines the entry module. Relative `import`
   specifiers then resolve against `tauri://localhost` and the module fetches
   fail (opaque-origin CORS), so the module graph never evaluates — the preview
   shows the static skeleton plus a generic "Script error". Classic
   `<script src>` tags load fine (that is how `libs/xterm.js` always worked).

So the modules are now **classic scripts** that share the `window.termCoder`
namespace (the same namespace the app already used for `askChoice` /
`resolveSessionModel` / `getModelSelectionConfig`):

- Each file is an IIFE: `(function () { "use strict"; const TC = window.termCoder = window.termCoder || {}; … })();`
- `const` exports become getter properties on `TC`; `let` exports become
  getter+setter properties (live bindings); functions are assigned directly.
- Cross-module references read/write `TC.<name>`.
- Load order in `index.html`: `04-dom.js` first (builds `el`), then
  `00-state.js`, then `01`–`24` in numeric order, then `main.js` (calls
  `TC.init()`). Order is not load-critical because all cross-module references
  happen inside functions, but the numeric order is kept for readability.

`app.js` (the 504 KB monolith) has been deleted; the tests in `tests/` read the
module sources via `tests/module-src.js` (`moduleSrc` / `allModulesSrc` /
`makeTC`).

---

## 7. Recommendation

1. **Do not re-derive the split.** The `js/` directory already implements the exact module boundaries described above (00–24 + main.js), committed in `bf1d672`.
2. **Verify, don't rewrite.** Diff each `js/NN-*.js` against the corresponding `app.js` line range in §4 to confirm no function was dropped or drifted (the split was authored as a WIP; `app.js` has since been the live file).
3. **Resolve the one boundary ambiguity** — `01-sessions.js` vs the State section (see §4 note).
4. **Flip the entry point** — change `index.html` line 502 to `src="js/main.js"`, then smoke-test the full app (spawn, send, terminal, history, settings, token estimator) before deleting `app.js`.
5. **Optional finer split later** — pull `detection` + `PTY-input` out of `06-tools.js` (112 KB) into a leaf module to break the tools↔spawn↔terminal cycle.
