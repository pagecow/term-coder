// 04-dom.js — classic script (converted from an ES module; see REFACTOR_PLAN.md).
// Exports are registered on the shared window.termCoder namespace (TC).
(function () {
"use strict";
const TC = window.termCoder = window.termCoder || {};
// ---------- DOM refs ----------
const $ = (id) => document.getElementById(id);
const el = {
  loading: $("app-loading"),
  // top bar
  settingsBtn: $("settings-btn"),
  newChatBtn: $("new-chat-btn"),
  newProjectTopBtn: $("new-project-top-btn"),
  // left
  projectList: $("project-list"),
  projSessionsBody: null,   // filled in by renderProjects (selected project only)
  projSessionsCount: null,
  // code editor column
  editor: $("code-editor"),
  rzEditor: $("rz-editor"),
  editorInput: $("editor-input"),
  editorFilename: $("editor-filename"),
  editorModifiedDot: $("editor-modified-dot"),
  editorSaveBtn: $("editor-save-btn"),
  editorCloseBtn: $("editor-close-btn"),
  editorStatus: $("editor-status"),
  // middle
  modelPicker: $("model-picker"),
  effortPicker: $("effort-picker"),
  copyConvBtn: $("copy-conv-btn"),
  addFileBtn: $("add-file-btn"),
  attachBoardBtn: $("attach-board-btn"),
  attachedBoardName: $("attached-board-name"),
  boardChip: $("board-chip"),
  detachBoardBtn: $("detach-board-btn"),
  attachmentStrip: $("attachment-strip"),
  imagePreviewModal: $("image-preview-modal"),
  imagePreviewImg: $("image-preview-img"),
  imagePreviewClose: $("image-preview-close"),
  chatLog: $("chat-log"),
  chatEmpty: $("chat-empty"),
  chatScroll: $("chat-scroll"),
  chatOverlay: $("chat-overlay"),
  chatJumpBtn: $("chat-jump-btn"),
  chatStatus: $("chat-status"),
  chatForm: $("chat-form"),
  chatInput: $("chat-input"),
  tokenEstimator: $("token-estimator"),
  tokenEstimatorBtn: $("token-estimator-btn"),
  tokenCount: $("token-count"),
  tokenMax: $("token-max"),
  tokenRingFill: $("token-ring-fill"),
  tokenPopover: $("token-popover"),
  sendBtn: $("send-btn"),
  sendIcon: document.querySelector("#send-btn .send-icon"),
  stopIcon: document.querySelector("#send-btn .stop-icon"),
  sessionInfo: $("session-info"),
  // project + branch bar (under the composer)
  pbBar: $("project-branch-bar"),
  pbProjectBtn: $("pb-project-btn"),
  pbProjectName: $("pb-project-name"),
  pbBranchBtn: $("pb-branch-btn"),
  pbBranchName: $("pb-branch-name"),
  pbPopover: $("pb-popover"),
  // right
  newSessionBtn: $("new-session-btn"),
  newSessionBtn2: $("new-session-btn-2"),
  termCount: $("term-count"),
  termGrid: $("term-grid"),
  termEmpty: $("term-empty"),
  termViewSwitcher: $("term-view-switcher"),
  // spawn modal
  spawnModal: $("spawn-modal"),
  spawnCli: $("spawn-cli"),
  spawnModelRow: $("spawn-model-row"),
  spawnModel: $("spawn-model"),
  spawnPrompt: $("spawn-prompt"),
  spawnCwd: $("spawn-cwd"),
  spawnRemember: $("spawn-remember"),
  spawnStatus: $("spawn-status"),
  spawnStart: $("spawn-start"),
  spawnCancel: $("spawn-cancel"),
  spawnCancelX: $("spawn-cancel-x"),
  // settings
  settingsPanel: $("settings-panel"),
  setCli: $("set-cli"),
  setModelRow: $("set-model-row"),
  setModel: $("set-model"),
  setCwd: $("set-cwd"),
  settingsSave: $("settings-save"),
  settingsCancel: $("settings-cancel"),
  detectedList: $("detected-list"),
  rescanBtn: $("rescan-btn"),
  // updates
  checkUpdatesBtn: $("check-updates-btn"),
  updateStatus: $("update-status"),
  openReleasesBtn: $("open-releases-btn"),
  // model selection mode
  modelModeRadios: $("model-mode-radios"),
  modelModeManual: $("model-mode-manual"),
  modelModeAlways: $("model-mode-always"),
  modelModeComplexity: $("model-mode-complexity"),
  alwaysModel: $("always-model"),
  complexityModelLow: $("complexity-model-low"),
  complexityModelMedium: $("complexity-model-medium"),
  complexityModelHigh: $("complexity-model-high"),
  // Per-target sub-agent effort selects (Model Selection Mode panels)
  alwaysEffort: $("always-effort"),
  complexityEffortLow: $("complexity-effort-low"),
  complexityEffortMedium: $("complexity-effort-medium"),
  complexityEffortHigh: $("complexity-effort-high"),
  // trust-folder mode
  trustModeRadios: $("trust-mode-radios"),
  autoFollow: $("auto-follow"),
  // board picker
  boardPicker: $("board-picker"),
  boardPickerList: $("board-picker-list"),
  boardPickerX: $("board-picker-x"),
  // history browser (modal)
  historyBtn: $("history-btn"),
  historyModal: $("history-modal"),
  historyCloseX: $("history-close-x"),
  historyRefresh: $("history-refresh"),
  historyTabs: $("history-tabs"),
  historyList: $("history-list"),
  // user terminal (bottom drawer) — entirely user-driven, separate from the
  // orchestrator's right-side AI sessions. Toggled by sidebar icon / Cmd+J.
  userTermBtn: $("user-term-btn"),
  userTermDrawer: $("user-term-drawer"),
  userTermResizer: $("user-term-resizer"),
  userTermCwd: $("user-term-cwd"),
  userTermMount: $("user-term-mount"),
  userTermClear: $("user-term-clear"),
  userTermRestart: $("user-term-restart"),
  userTermClose: $("user-term-close"),
};

// ---------- Utils ----------
// --- exports ---
Object.defineProperty(TC, "$", { get: () => $, configurable: true });
Object.defineProperty(TC, "el", { get: () => el, configurable: true });
})();
