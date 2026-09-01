// 07-spawn.js — classic script (converted from an ES module; see REFACTOR_PLAN.md).
// Exports are registered on the shared window.termCoder namespace (TC).
(function () {
"use strict";
const TC = window.termCoder = window.termCoder || {};
// One spawn dialog at a time: while the modal is open, its wait promise,
// resolver, and the opts it was opened with live here (module-private). These
// used to live in 04-dom.js as exported `let`s, but only this module reads or
// writes them — so with the module split they belong here, where assignment is
// legal (assigning to an imported binding would throw).
let spawnPromise = null;
let spawnResolve = null;
let spawnModalOpts = null;
function buildCliOptions() {
  const opts = [];
  const push = (value, label, detected) => {
    opts.push({ value, label: detected ? label : label + " (not detected)" });
  };
  // v1.28: chatoss launch is the ONLY launch path. The dropdown lists exactly
  // the tools CHATOSS_LAUNCH_TOOLS names — the single source of truth — so the
  // constant and the dropdown can never drift apart (D2). `detected` reflects
  // whether the `chatoss` command itself is installed (all three tools launch
  // through it, so they share one install state).
  for (const tool of TC.CHATOSS_LAUNCH_TOOLS) {
    push(tool.id, tool.label, TC.detection.chatoss);
  }
  return opts;
}

// The message shown whenever the `chatoss` command is missing — it is REQUIRED
// for Term Coder to launch agents. Kept here (next to the spawn flow) and
// reused by the spawn modal, the Settings detected list, and the orchestrator
// tool results.
function chatossMissingMessage() {
  return "The chatoss command isn't installed. Open ChatOSS Settings, click Launch, then click \"Install chatoss command\" — that must have been clicked for Term Coder to launch agents. Then click Re-scan and try again.";
}

function syncSpawnModelRow() {
  // The agent's model is resolved through Model Selection Mode and passed to
  // `chatoss launch <tool> --model <id>` — there is no separate model dropdown
  // in this modal, so always hide that row.
  TC.el.spawnModelRow.classList.add("hidden");
  TC.el.spawnModel.disabled = true;
}

/**
 * Open the spawn modal and return a Promise that resolves with
 *   { cli, model?, cwd, prompt, session }  on Start, or
 *   null                                   on Cancel.
 * If the modal is already open (e.g. the orchestrator called the tool twice),
 * the same promise is returned — one dialog, one choice, all waiters resolve.
 */
function openSpawnModal(opts) {
  // One dialog at a time: if the modal is already open (e.g. the orchestrator
  // called the tool twice), every waiter shares the same promise.
  if (spawnPromise) return spawnPromise;
  opts = opts || {};
  spawnModalOpts = opts;
  TC.el.spawnStatus.textContent = "";
  TC.el.spawnStart.disabled = false;

  // Create the wait promise FIRST so callers (the orchestrator tool) start
  // awaiting it immediately, then populate the UI asynchronously.
  let resolveFn;
  const promise = new Promise((resolve) => { resolveFn = resolve; });
  spawnPromise = promise;
  spawnResolve = resolveFn;

  (async () => {
    try {
      // Fresh-ish detection (cached 60s), so options only show what's installed.
      await TC.detectTools(false);

      // CLI options
      TC.el.spawnCli.innerHTML = "";
      const cliOpts = buildCliOptions();
      for (const o of cliOpts) {
        const opt = document.createElement("option");
        opt.value = o.value;
        opt.textContent = o.label;
        TC.el.spawnCli.appendChild(opt);
      }
      // cliHint from the tool call wins, then the saved Default agent
      // (normalized so legacy values from older builds still resolve), then
      // the first chatoss tool (opencode).
      let preselectCli = (opts.cliHint || "").trim() || null;
      if (!preselectCli) {
        const norm = TC.normalizeCliDefault(TC.settings.cliDefault);
        if (norm && cliOpts.some((o) => o.value === norm)) preselectCli = norm;
      }
      if (!preselectCli || !cliOpts.some((o) => o.value === preselectCli)) {
        preselectCli = cliOpts[0] ? cliOpts[0].value : null;
      }
      if (preselectCli) TC.el.spawnCli.value = preselectCli;
      syncSpawnModelRow();
      // The `chatoss` command is REQUIRED — if it isn't installed, say so up
      // front instead of letting the first Start fail with a dead terminal.
      TC.el.spawnStatus.textContent = TC.detection.chatoss ? "" : chatossMissingMessage();

      // cwd: tool call > settings default > active project folder
      let cwd = (opts.cwd || "").trim();
      if (!cwd) cwd = (TC.settings.cwdDefault || "").trim();
      if (!cwd) {
        const p = TC.getProject(TC.state.activeProjectId);
        cwd = p ? p.folderPath : "";
      }
      TC.el.spawnCwd.value = cwd;

      // prompt: tool call, else empty
      TC.el.spawnPrompt.value = (opts.prompt || "").trim();
      TC.el.spawnRemember.checked = false;

      TC.el.spawnModal.classList.remove("hidden");
    } catch (e) {
      // Never hang the waiters — degrade to a cancelled dialog.
      console.warn("openSpawnModal", e);
      closeSpawnModal(null);
    }
  })();

  return promise;
}

function closeSpawnModal(choice) {
  TC.el.spawnModal.classList.add("hidden");
  const r = spawnResolve;
  spawnResolve = null;
  spawnPromise = null;
  spawnModalOpts = null;
  if (r) r(choice);
}
async function onSpawnStart() {
  if (!spawnResolve) return;
  const cli = TC.el.spawnCli.value;
  const cwd = TC.el.spawnCwd.value.trim();
  const prompt = TC.el.spawnPrompt.value.trim();
  const remember = TC.el.spawnRemember.checked;

  if (!cli) { TC.el.spawnStatus.textContent = "Pick what to launch."; return; }
  if (!cwd) { TC.el.spawnStatus.textContent = "Enter a working directory."; return; }

  // ---- Route the session model through the configured Model Selection Mode ----
  // window.termCoder.resolveSessionModel(taskPrompt) encapsulates all three
  // modes (manual / always / complexity) and returns the ChatOSS model id to
  // pass to `chatoss launch <tool> --model <id>`, or null to cancel. The manual
  // mode renders a pill picker inside the chat stream via askChoice, so hide the
  // spawn modal while the choice is pending so the pills are visible and
  // clickable.
  TC.el.spawnModal.classList.add("hidden");
  let model = null;
  let noModels = false;
  try {
    // resolveSessionModel returns a ChatOSS MODEL id; the agent (tool) comes
    // from the dropdown above. spawnChosen combines the two.
    model = await window.termCoder.resolveSessionModel(prompt);
  } catch (e) {
    console.warn("resolveSessionModel", e);
    // B3: when there are NO ChatOSS models available at all (Manual/Always/
    // Complexity), resolveSessionModel throws an error with code "NO_MODELS"
    // instead of returning null (which would silently cancel). Show an
    // actionable message and keep the spawn modal open so the user can
    // cancel/retry, rather than auto-dismissing it with no explanation.
    if (e && e.code === "NO_MODELS") {
      noModels = true;
      model = null;
    }
  }
  if (!model) {
    if (noModels) {
      // Re-show the modal (it was hidden to make room for the pill picker) with
      // an actionable status message. Do NOT dismiss — let the user cancel or
      // go run Re-scan in Settings.
      TC.el.spawnModal.classList.remove("hidden");
      TC.el.spawnStatus.textContent = "No ChatOSS models available — run Re-scan in Settings, or open ChatOSS and pick a model.";
      TC.el.spawnStart.disabled = false;
    } else {
      // Dismissed / cancelled by the user — close silently.
      closeSpawnModal(null);
    }
    return;
  }

  if (remember) {
    // Remember the chosen AGENT (the chatoss launch tool from the dropdown) —
    // it round-trips through the Settings "Default agent" picker (the two
    // controls share the cliDefault value space and must agree). The MODEL is
    // governed by Model Selection Mode, not by this checkbox.
    TC.settings.cliDefault = cli;
    TC.settings.cwdDefault = cwd;
    TC.saveSettings();
  }

  // Batch mode (spawn_batch): the modal collected ONE launch choice for a whole
  // batch of parallel subtasks — resolve with the choice (including the model)
  // WITHOUT spawning a session here; the batch tool spawns each task itself.
  if (spawnModalOpts && spawnModalOpts.batchMode) {
    closeSpawnModal({ cli, cwd, prompt, model });
    return;
  }

  TC.el.spawnStart.disabled = true;
  TC.el.spawnStatus.textContent = "Starting…";
  TC.el.spawnModal.classList.remove("hidden");
  try {
    const session = await spawnChosen({ cli, cwd, prompt, model });
    if (!session) {
      TC.el.spawnStatus.textContent = "Terminal permission denied. Approve it in the system prompt and try again, or cancel.";
      TC.el.spawnStart.disabled = false;
      return; // keep the modal open so the user can retry/cancel
    }
    if (session.error) {
      TC.el.spawnStatus.textContent = session.error;
      TC.el.spawnStart.disabled = false;
      return;
    }
    closeSpawnModal({ cli, cwd, prompt, session });
  } catch (e) {
    TC.el.spawnStatus.textContent = "Error: " + (e && e.message ? e.message : String(e));
    TC.el.spawnStart.disabled = false;
  }
}

function onSpawnCancel() {
  closeSpawnModal(null);
}

async function spawnChosen(choice) {
  // v1.28: EVERY sub-agent session starts through the `chatoss` command —
  // `chatoss launch <tool> [--model <id>]` — which drives the real coding CLI
  // (OpenCode / Claude Code / Codex) with its model provider wired to ChatOSS.
  // The old `ollama launch` path and the direct-binary (raw:) path are gone.
  //
  //   choice.cli   — the agent tool id from the spawn-modal dropdown
  //                 ("opencode" | "claude-code" | "codex"); "" resolves to the
  //                 saved Default agent, then the first chatoss tool.
  //   choice.model — the ChatOSS model id from resolveSessionModel (back-compat:
  //                  choice.target is still honored), passed as --model.
  //
  // ALWAYS spawn through a login shell so `chatoss` (installed by the user via
  // ChatOSS Settings → Launch) resolves on the full PATH — the sandboxed
  // default shell has a minimal PATH.
  //
  // The chatoss command is REQUIRED for Term Coder to work. When detection ran
  // and it is missing, fail fast with the install guidance instead of spawning
  // a terminal that dies with "command not found".
  if (!TC.chatossPath && !(TC.detection && TC.detection.denied)) {
    return { error: chatossMissingMessage() };
  }

  // ── Resolve the agent tool ──
  const toolIds = TC.CHATOSS_LAUNCH_TOOLS.map((t) => t.id);
  const defaultTool = TC.normalizeCliDefault(TC.settings.cliDefault) || toolIds[0];
  // Normalize the incoming cli too — dropdown emits tool ids, but older callers
  // (cliHint, orchestrator tools) may still say "claude".
  const cliNorm = choice.cli ? TC.normalizeCliDefault(String(choice.cli)) : "ask";
  let tool = (cliNorm !== "ask" && toolIds.includes(cliNorm)) ? cliNorm : "";
  if (!tool) tool = toolIds.includes(defaultTool) ? defaultTool : toolIds[0];
  const toolEntry = TC.CHATOSS_LAUNCH_TOOLS.find((t) => t.id === tool) || TC.CHATOSS_LAUNCH_TOOLS[0];
  tool = toolEntry.tool; // the argument chatoss launch takes

  // ── Resolve the model (ChatOSS model id → --model) ──
  // choice.model is the id from resolveSessionModel; choice.target is the old
  // field name, still honored for callers that pass it. When neither is set,
  // fall back to the ChatOSS default model so the launched CLI skips its own
  // interactive model picker (autoDriveStartup types the task prompt into
  // whatever is on screen, so an in-terminal picker would swallow it).
  const model = (choice.model || choice.target || TC.defaultModelId || "").trim();
  const bin = TC.chatossPath || "chatoss";
  let inner = "exec " + JSON.stringify(bin) + " launch " + JSON.stringify(tool);
  if (model) inner += " --model " + JSON.stringify(model);
  const label = tool + " · " + TC.basename(choice.cwd);
  // effortTargetId: the MODEL id the effort level was saved under.
  const effortTargetId = model || null;

  // ── Per-model effort level (Settings → Model Selection Mode) ──
  // A Codex agent has a REAL reasoning-effort flag that accepts low/medium/high
  // (verified OpenAI codex CLI values) — chatoss launch passes extra args
  // through, so it lands on the real codex command line. Every other agent
  // (opencode / claude-code) has no effort flag, so the level is expressed as a
  // guidance line appended to the task brief — universal and harmless on CLIs
  // that don't parse it. Effort values are validated against the model's option
  // list before storage, so interpolating them is safe.
  const effort = TC.effortForTarget(effortTargetId);
  let effectivePrompt = choice.prompt;
  if (effort) {
    const isCodex = tool === "codex";
    if (isCodex && TC.CODEX_EFFORT_FLAG_VALUES.has(effort)) {
      inner += " --config 'model_reasoning_effort=\"" + effort + "\"'";
    } else if (TC.EFFORT_BRIEF[effort] && effectivePrompt) {
      effectivePrompt = effectivePrompt + "\n\n[" + TC.EFFORT_BRIEF[effort] + "]";
    } else if (effectivePrompt) {
      // Unknown/custom level (e.g. "max" on a model with no EFFORT_BRIEF entry):
      // append a generic instruction so the level is not silently dropped.
      effectivePrompt = effectivePrompt + "\n\n[Reasoning effort level: " + effort + "]";
    }
  }

  let session = null;
  try {
    session = await window.chatoss.terminal.spawn("zsh", { args: ["-lic", inner], cwd: choice.cwd, cols: 90, rows: 22 });
  } catch (e) {
    return { error: "Failed to start session: " + (e && e.message ? e.message : String(e)) };
  }
  if (!session) {
    // spawn returns null when denied by the user.
    return null; // denied
  }
  // The session handle is object-oriented: session.id, session.write, session.onData,
  // session.onExit, session.resize, session.kill. Pass the WHOLE handle to
  // registerSession so mount() can wire output→terminal and input→stdin.
  await TC.registerSession(session, "zsh", ["-lic", inner], choice.cwd, label);
  if (effectivePrompt) {
    // Don't write the prompt immediately — the CLI (Claude Code / Codex) shows a
    // "trust this folder?" dialog and sometimes a model picker at launch, and
    // typing the prompt too early dumps it into the wrong screen. autoDriveStartup
    // watches the live output, handles the trust dialog (per the Settings trust
    // policy: ask in chat, or always trust), and sends the prompt once the agent's
    // real input box is ready (with a 12s safety timeout).
    try { TC.autoDriveStartup(session, effectivePrompt, label, choice.cwd); } catch (e) { /* non-fatal */ }
  }
  return { id: session.id, label, cwd: choice.cwd };
}

// ---------- Settings panel ----------
function renderDetectedList() {
  if (!TC.el.detectedList) return;
  // Read the LIVE detection object. The persisted settings.detected snapshot
  // can be stale (restored from an older app version) and then disagrees with
  // the pickers, so always render what detection actually found.
  const d = TC.detection || { chatoss: false, codex: false, claude: false, opencode: false, denied: false };
  TC.el.detectedList.innerHTML = "";
  const row = (name, ok) => {
    const div = document.createElement("div");
    div.className = "detected-item";
    const mark = document.createElement("span");
    mark.className = ok ? "ok" : "no";
    mark.textContent = ok ? "✓" : "✗";
    div.appendChild(mark);
    div.appendChild(document.createTextNode(" " + name + (ok ? " installed" : " not found")));
    TC.el.detectedList.appendChild(div);
  };
  // chatoss comes FIRST and is REQUIRED — every agent launches through
  // `chatoss launch`, which only exists after the user clicks "Install
  // chatoss command" in ChatOSS Settings → Launch.
  row("chatoss (required)", !!d.chatoss);
  if (d.chatoss && d.chatossPath) {
    const div = document.createElement("div");
    div.className = "detected-item";
    div.textContent = "  chatoss: " + d.chatossPath;
    TC.el.detectedList.appendChild(div);
  }
  if (!d.chatoss) {
    const div = document.createElement("div");
    div.className = "detected-item";
    div.style.color = "var(--danger)";
    div.textContent = chatossMissingMessage();
    TC.el.detectedList.appendChild(div);
  }
  // The underlying coding CLIs are informational — `chatoss launch` drives
  // them, Term Coder never spawns them directly.
  row("claude-code CLI", !!d.claude);
  row("codex CLI", !!d.codex);
  row("opencode CLI", !!d.opencode);
  if (d.denied) {
    const div = document.createElement("div");
    div.className = "detected-item";
    div.style.color = "var(--danger)";
    div.textContent = "Terminal permission needed for auto-detection.";
    TC.el.detectedList.appendChild(div);
  }
}

function openSettings() {
  // Normalize the saved Default agent (legacy "claude" / "raw:*" / ollama-model
  // values from older builds map to the chatoss tools, anything unrecognized
  // falls back to "ask") — otherwise the select renders blank and Save would
  // silently clear the default.
  TC.el.setCli.value = TC.normalizeCliDefault(TC.settings.cliDefault) || "ask";
  TC.el.setCwd.value = TC.settings.cwdDefault || "";
  renderDetectedList();
  TC.applyModelSelectionModeToUi();
  TC.applyTrustModeToUi();
  if (TC.el.autoFollow) TC.el.autoFollow.checked = TC.settings.autoFollow !== false;
  TC.el.settingsPanel.classList.remove("hidden");
}

function syncSettingsModelRow() {
  // Model is chosen inside the launched terminal — no settings model row.
  if (TC.el.setModelRow) TC.el.setModelRow.classList.add("hidden");
}

function saveSettingsFromPanel() {
  TC.settings.cliDefault = TC.el.setCli.value;
  TC.settings.cwdDefault = TC.el.setCwd.value.trim();
  // Model Selection Mode persists to its own scopedData keys (handled by
  // saveModelSelectionMode), not the bundled settings blob. Sync it now so
  // any uncommitted picker value is captured on Save.
  TC.saveModelSelectionMode();
  TC.saveTrustMode();
  if (TC.el.autoFollow) TC.settings.autoFollow = !!TC.el.autoFollow.checked;
  TC.saveSettings();
  TC.el.settingsPanel.classList.add("hidden");
}

// ---------- Check for updates ----------
// The app cannot replace its own files, so "update" = notify + open the GitHub
// releases page for the user to install. APP_VERSION (top of file) must stay
// in sync with app.json's "version".
// --- exports ---
TC.buildCliOptions = buildCliOptions;
TC.chatossMissingMessage = chatossMissingMessage;
TC.syncSpawnModelRow = syncSpawnModelRow;
TC.openSpawnModal = openSpawnModal;
TC.closeSpawnModal = closeSpawnModal;
TC.onSpawnStart = onSpawnStart;
TC.onSpawnCancel = onSpawnCancel;
TC.spawnChosen = spawnChosen;
TC.renderDetectedList = renderDetectedList;
TC.openSettings = openSettings;
TC.syncSettingsModelRow = syncSettingsModelRow;
TC.saveSettingsFromPanel = saveSettingsFromPanel;
})();
