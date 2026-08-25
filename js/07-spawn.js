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
  // D2: the ollama-launch entries come from OLLAMA_LAUNCH_TOOLS (the single
  // source of truth) so the constant and the dropdown can never drift apart.
  // `detected` here reflects whether ollama itself is available (these all
  // launch THROUGH ollama), matching the previous per-line behavior.
  for (const tool of TC.OLLAMA_LAUNCH_TOOLS) {
    push(tool.id, tool.label, TC.detection.ollama);
  }
  // Direct binaries (launch the real CLI without ollama), only if installed.
  // These are a manual fallback; the model picker also offers claude/codex
  // directly as launch targets. Order matches the default-agents spec:
  // opencode, claude, codex.
  if (TC.detection.opencode) push("raw:opencode", "opencode  (direct binary)", true);
  if (TC.detection.claude) push("raw:claude", "claude  (direct binary)", true);
  if (TC.detection.codex) push("raw:codex", "codex  (direct binary)", true);
  return opts;
}

function syncSpawnModelRow() {
  // "ollama launch <tool>" opens its own model picker inside the terminal, so
  // there's no separate model dropdown — always hide that row.
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
      let preselectCli = (opts.cliHint || "").trim() || null;
      if (!preselectCli && TC.settings.cliDefault && TC.settings.cliDefault !== "ask" && cliOpts.some((o) => o.value === TC.settings.cliDefault)) {
        preselectCli = TC.settings.cliDefault;
      }
      if (!preselectCli || !cliOpts.some((o) => o.value === preselectCli)) {
        preselectCli = TC.detection.claude ? "claude" : (TC.detection.codex ? "codex" : (cliOpts[0] ? cliOpts[0].value : "claude"));
      }
      TC.el.spawnCli.value = preselectCli;
      syncSpawnModelRow();

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
  // modes (manual / always / complexity) and returns the model to use, or null
  // to cancel. The manual mode renders a pill picker inside the chat stream via
  // askChoice, so hide the spawn modal while the choice is pending so the pills
  // are visible and clickable.
  TC.el.spawnModal.classList.add("hidden");
  let target = null;
  let noModels = false;
  try {
    // resolveSessionModel returns a LAUNCH TARGET id — a direct CLI name
    // ("claude"/"codex") or an ollama model name. spawnChosen routes on it.
    target = await window.termCoder.resolveSessionModel(prompt);
  } catch (e) {
    console.warn("resolveSessionModel", e);
    // B3: when there are NO detected models/targets at all (Manual/Always/
    // Complexity), resolveSessionModel throws an error with code "NO_MODELS"
    // instead of returning null (which would silently cancel). Show an
    // actionable message and keep the spawn modal open so the user can
    // cancel/retry, rather than auto-dismissing it with no explanation.
    if (e && e.code === "NO_MODELS") {
      noModels = true;
      target = null;
    }
  }
  if (!target) {
    if (noModels) {
      // Re-show the modal (it was hidden to make room for the pill picker) with
      // an actionable status message. Do NOT dismiss — let the user cancel or
      // go run Re-scan in Settings.
      TC.el.spawnModal.classList.remove("hidden");
      TC.el.spawnStatus.textContent = "No models detected — run Re-scan in Settings, or switch Model Selection Mode.";
      TC.el.spawnStart.disabled = false;
    } else {
      // Dismissed / cancelled by the user — close silently.
      closeSpawnModal(null);
    }
    return;
  }

  if (remember) {
    // Remember the CHOSEN LAUNCH TARGET, not merely the spawn-modal dropdown
    // tool. The launch target id (from resolveSessionModel) is what the next
    // session applies automatically — for a direct-CLI launch that's "claude" /
    // "codex" / "opencode", persisted as the set-cli-style "raw:<id>" value so
    // it round-trips through the Settings "Default agent" picker (the two
    // controls share the cliDefault value space and must agree). Ollama launches
    // (target is an ollama model) have no self-contained set-cli value, so fall
    // back to the dropdown's ollama-tool id — consistent with the picker, and
    // auto-applied only when it maps to a concrete target.
    const tgt = TC.findLaunchTarget(target);
    TC.settings.cliDefault = (tgt && tgt.kind === "direct") ? ("raw:" + tgt.id) : cli;
    TC.settings.cwdDefault = cwd;
    TC.saveSettings();
  }

  // Batch mode (spawn_batch): the modal collected ONE launch choice for a whole
  // batch of parallel subtasks — resolve with the choice (including the target)
  // WITHOUT spawning a session here; the batch tool spawns each task itself.
  if (spawnModalOpts && spawnModalOpts.batchMode) {
    closeSpawnModal({ cli, cwd, prompt, target });
    return;
  }

  TC.el.spawnStart.disabled = true;
  TC.el.spawnStatus.textContent = "Starting…";
  TC.el.spawnModal.classList.remove("hidden");
  try {
    const session = await spawnChosen({ cli, cwd, prompt, target });
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
  // choice.target is the launch-target id from resolveSessionModel — either a
  // direct CLI name ("claude"/"codex") or an ollama model name. choice.cli is
  // the ollama launch tool from the spawn-modal dropdown (used only for the
  // ollama path) or a "raw:<bin>" manual override.
  //
  // ALWAYS spawn through a login shell so `ollama` (and any user-installed CLI)
  // resolves on the full PATH — the sandboxed default shell has a minimal PATH,
  // which is exactly what caused "Unable to spawn ollama … not found in PATH".
  let inner, label;
  // effortTargetId: which launch-target id to look the effort up under. The raw:
  // dropdown path names a binary directly, so its id IS the bin name.
  let effortTargetId = null;
  let codexFlagApplied = false; // true once --config model_reasoning_effort is on the command line
  // Manual raw-binary override from the dropdown (kept for backward compat and
  // for CLIs not yet covered by the launch-target picker).
  if (choice.cli && choice.cli.startsWith("raw:")) {
    const bin = choice.cli.slice(4);
    effortTargetId = bin;
    inner = "exec " + bin;
    label = bin + " · " + TC.basename(choice.cwd);
  } else {
    // Route by the chosen launch target.
    const target = TC.findLaunchTarget(choice.target);
    if (target) effortTargetId = target.id;
    if (target && target.kind === "direct") {
      // ── Direct CLI launch ── run the REAL binary via the terminal capability,
      // NOT through ollama. Uses the resolved absolute path (claudePath /
      // codexPath / opencodePath) so it survives the sandbox's minimal PATH.
      inner = "exec " + JSON.stringify(target.bin);
      label = target.id + " · " + TC.basename(choice.cwd);
    } else {
      // ── Ollama launch path (existing) ── the dropdown's tool selects the
      // agent; the target id (an ollama model name) is passed as --model.
      const bin = TC.ollamaPath || "ollama";
      const tool = choice.cli || "claude";
      inner = "exec " + JSON.stringify(bin) + " launch " + tool;
      // Apply the resolved model as a CLI flag so the launched agent uses it
      // instead of opening its own model picker. choice.model is kept as a
      // back-compat fallback for any caller still passing the old field.
      const model = target ? target.model : choice.model;
      if (model) {
        inner += " --model " + JSON.stringify(model);
      }
      label = tool + " · " + TC.basename(choice.cwd);
    }
  }

  // ── Per-target effort level (Settings → Model Selection Mode) ──
  // Direct Codex has a REAL reasoning-effort flag that accepts low/medium/high
  // (verified OpenAI codex CLI values). Apply it on the command line ONLY when
  // the chosen effort is one of those safe values — if a future model exposes a
  // non-codex level like "max" for a codex target, we fall back to a guidance
  // line instead of passing an invalid flag. Every other agent (claude /
  // opencode / anything under `ollama launch`) has no effort flag, so the level
  // is expressed as a guidance line appended to the task brief — universal and
  // harmless on CLIs that don't parse it. Effort values are validated against
  // the target's option list before storage, so interpolating them is safe.
  const effort = TC.effortForTarget(effortTargetId);
  let effectivePrompt = choice.prompt;
  if (effort) {
    const isCodex = /^exec "?[^"]*codex/.test(inner);
    if (isCodex && TC.CODEX_EFFORT_FLAG_VALUES.has(effort)) {
      inner += " --config 'model_reasoning_effort=\"" + effort + "\"'";
      codexFlagApplied = true;
    } else if (TC.EFFORT_BRIEF[effort] && effectivePrompt) {
      effectivePrompt = effectivePrompt + "\n\n[" + TC.EFFORT_BRIEF[effort] + "]";
    } else if (effectivePrompt) {
      // Unknown/custom level (e.g. "max" on a non-codex target with no EFFORT_BRIEF entry):
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
  // Read the LIVE detection object — the same source the launch-target pickers
  // (and the chat pill picker) consume via availableOllamaModels() — NOT the
  // persisted settings.detected snapshot. The snapshot can be stale (restored
  // from an older app version) and then disagrees with the pickers, which is
  // exactly the "Settings shows fewer models than the chat picker" bug.
  const d = TC.detection || { codex: false, claude: false, ollama: false, opencode: false, models: [], denied: false };
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
  row("codex", !!d.codex);
  row("claude", !!d.claude);
  row("ollama", !!d.ollama);
  row("opencode", !!d.opencode);
  // Show the resolved direct-CLI paths so the user can confirm the real
  // binaries were found (these are what "claude"/"codex"/"opencode" launch
  // targets use).
  if (d.claude && d.claudePath) {
    const div = document.createElement("div");
    div.className = "detected-item";
    div.textContent = "  claude direct: " + d.claudePath;
    TC.el.detectedList.appendChild(div);
  }
  if (d.codex && d.codexPath) {
    const div = document.createElement("div");
    div.className = "detected-item";
    div.textContent = "  codex direct: " + d.codexPath;
    TC.el.detectedList.appendChild(div);
  }
  if (d.opencode && d.opencodePath) {
    const div = document.createElement("div");
    div.className = "detected-item";
    div.textContent = "  opencode direct: " + d.opencodePath;
    TC.el.detectedList.appendChild(div);
  }
  // The COMPLETE ollama model list (terminal detection + local models from the
  // ChatOSS chat model list — the same source the model picker at the top of
  // the AI chat section uses), so Settings shows every detected model.
  const ollamaModels = TC.allOllamaModels();
  if (d.ollama || ollamaModels.length) {
    const div = document.createElement("div");
    div.className = "detected-item";
    div.textContent = "ollama models (" + ollamaModels.length + "): " + (ollamaModels.join(", ") || "(none)");
    TC.el.detectedList.appendChild(div);
  }
  if (d.denied) {
    const div = document.createElement("div");
    div.className = "detected-item";
    div.style.color = "var(--danger)";
    div.textContent = "Terminal permission needed for auto-detection.";
    TC.el.detectedList.appendChild(div);
  }
}

function openSettings() {
  // Fall back to "ask" when the saved default isn't among the current options
  // (e.g. a legacy "ollama" value from an older build) — otherwise the select
  // renders blank and Save would silently clear the default.
  const cliValues = Array.from(TC.el.setCli.options).map((o) => o.value);
  TC.el.setCli.value = cliValues.includes(TC.settings.cliDefault) ? TC.settings.cliDefault : "ask";
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
