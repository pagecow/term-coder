import { CODEX_EFFORT_FLAG_VALUES, OLLAMA_LAUNCH_TOOLS, claudePath, codexPath, detection, ollamaPath, opencodePath, settings, state } from "./00-state.js";
import { el, spawnModalOpts, spawnPromise, spawnResolve } from "./04-dom.js";
import { basename, detectTools, getProject, saveSettings } from "./05-util.js";
import { autoDriveStartup } from "./06-tools.js";
import { EFFORT_BRIEF, allOllamaModels, applyModelSelectionModeToUi, applyTrustModeToUi, effortForTarget, findLaunchTarget, saveModelSelectionMode, saveTrustMode } from "./08-settings.js";
import { registerSession } from "./20-terminal.js";
export function buildCliOptions() {
  const opts = [];
  const push = (value, label, detected) => {
    opts.push({ value, label: detected ? label : label + " (not detected)" });
  };
  // D2: the ollama-launch entries come from OLLAMA_LAUNCH_TOOLS (the single
  // source of truth) so the constant and the dropdown can never drift apart.
  // `detected` here reflects whether ollama itself is available (these all
  // launch THROUGH ollama), matching the previous per-line behavior.
  for (const tool of OLLAMA_LAUNCH_TOOLS) {
    push(tool.id, tool.label, detection.ollama);
  }
  // Direct binaries (launch the real CLI without ollama), only if installed.
  // These are a manual fallback; the model picker also offers claude/codex
  // directly as launch targets. Order matches the default-agents spec:
  // opencode, claude, codex.
  if (detection.opencode) push("raw:opencode", "opencode  (direct binary)", true);
  if (detection.claude) push("raw:claude", "claude  (direct binary)", true);
  if (detection.codex) push("raw:codex", "codex  (direct binary)", true);
  return opts;
}

export function syncSpawnModelRow() {
  // "ollama launch <tool>" opens its own model picker inside the terminal, so
  // there's no separate model dropdown — always hide that row.
  el.spawnModelRow.classList.add("hidden");
  el.spawnModel.disabled = true;
}

/**
 * Open the spawn modal and return a Promise that resolves with
 *   { cli, model?, cwd, prompt, session }  on Start, or
 *   null                                   on Cancel.
 * If the modal is already open (e.g. the orchestrator called the tool twice),
 * the same promise is returned — one dialog, one choice, all waiters resolve.
 */
export function openSpawnModal(opts) {
  // One dialog at a time: if the modal is already open (e.g. the orchestrator
  // called the tool twice), every waiter shares the same promise.
  if (spawnPromise) return spawnPromise;
  opts = opts || {};
  spawnModalOpts = opts;
  el.spawnStatus.textContent = "";
  el.spawnStart.disabled = false;

  // Create the wait promise FIRST so callers (the orchestrator tool) start
  // awaiting it immediately, then populate the UI asynchronously.
  let resolveFn;
  const promise = new Promise((resolve) => { resolveFn = resolve; });
  spawnPromise = promise;
  spawnResolve = resolveFn;

  (async () => {
    try {
      // Fresh-ish detection (cached 60s), so options only show what's installed.
      await detectTools(false);

      // CLI options
      el.spawnCli.innerHTML = "";
      const cliOpts = buildCliOptions();
      for (const o of cliOpts) {
        const opt = document.createElement("option");
        opt.value = o.value;
        opt.textContent = o.label;
        el.spawnCli.appendChild(opt);
      }
      let preselectCli = (opts.cliHint || "").trim() || null;
      if (!preselectCli && settings.cliDefault && settings.cliDefault !== "ask" && cliOpts.some((o) => o.value === settings.cliDefault)) {
        preselectCli = settings.cliDefault;
      }
      if (!preselectCli || !cliOpts.some((o) => o.value === preselectCli)) {
        preselectCli = detection.claude ? "claude" : (detection.codex ? "codex" : (cliOpts[0] ? cliOpts[0].value : "claude"));
      }
      el.spawnCli.value = preselectCli;
      syncSpawnModelRow();

      // cwd: tool call > settings default > active project folder
      let cwd = (opts.cwd || "").trim();
      if (!cwd) cwd = (settings.cwdDefault || "").trim();
      if (!cwd) {
        const p = getProject(state.activeProjectId);
        cwd = p ? p.folderPath : "";
      }
      el.spawnCwd.value = cwd;

      // prompt: tool call, else empty
      el.spawnPrompt.value = (opts.prompt || "").trim();
      el.spawnRemember.checked = false;

      el.spawnModal.classList.remove("hidden");
    } catch (e) {
      // Never hang the waiters — degrade to a cancelled dialog.
      console.warn("openSpawnModal", e);
      closeSpawnModal(null);
    }
  })();

  return promise;
}

export function closeSpawnModal(choice) {
  el.spawnModal.classList.add("hidden");
  const r = spawnResolve;
  spawnResolve = null;
  spawnPromise = null;
  spawnModalOpts = null;
  if (r) r(choice);
}
export async function onSpawnStart() {
  if (!spawnResolve) return;
  const cli = el.spawnCli.value;
  const cwd = el.spawnCwd.value.trim();
  const prompt = el.spawnPrompt.value.trim();
  const remember = el.spawnRemember.checked;

  if (!cli) { el.spawnStatus.textContent = "Pick what to launch."; return; }
  if (!cwd) { el.spawnStatus.textContent = "Enter a working directory."; return; }

  // ---- Route the session model through the configured Model Selection Mode ----
  // window.termCoder.resolveSessionModel(taskPrompt) encapsulates all three
  // modes (manual / always / complexity) and returns the model to use, or null
  // to cancel. The manual mode renders a pill picker inside the chat stream via
  // askChoice, so hide the spawn modal while the choice is pending so the pills
  // are visible and clickable.
  el.spawnModal.classList.add("hidden");
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
      el.spawnModal.classList.remove("hidden");
      el.spawnStatus.textContent = "No models detected — run Re-scan in Settings, or switch Model Selection Mode.";
      el.spawnStart.disabled = false;
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
    const tgt = findLaunchTarget(target);
    settings.cliDefault = (tgt && tgt.kind === "direct") ? ("raw:" + tgt.id) : cli;
    settings.cwdDefault = cwd;
    saveSettings();
  }

  // Batch mode (spawn_batch): the modal collected ONE launch choice for a whole
  // batch of parallel subtasks — resolve with the choice (including the target)
  // WITHOUT spawning a session here; the batch tool spawns each task itself.
  if (spawnModalOpts && spawnModalOpts.batchMode) {
    closeSpawnModal({ cli, cwd, prompt, target });
    return;
  }

  el.spawnStart.disabled = true;
  el.spawnStatus.textContent = "Starting…";
  el.spawnModal.classList.remove("hidden");
  try {
    const session = await spawnChosen({ cli, cwd, prompt, target });
    if (!session) {
      el.spawnStatus.textContent = "Terminal permission denied. Approve it in the system prompt and try again, or cancel.";
      el.spawnStart.disabled = false;
      return; // keep the modal open so the user can retry/cancel
    }
    if (session.error) {
      el.spawnStatus.textContent = session.error;
      el.spawnStart.disabled = false;
      return;
    }
    closeSpawnModal({ cli, cwd, prompt, session });
  } catch (e) {
    el.spawnStatus.textContent = "Error: " + (e && e.message ? e.message : String(e));
    el.spawnStart.disabled = false;
  }
}

export function onSpawnCancel() {
  closeSpawnModal(null);
}

export async function spawnChosen(choice) {
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
    label = bin + " · " + basename(choice.cwd);
  } else {
    // Route by the chosen launch target.
    const target = findLaunchTarget(choice.target);
    if (target) effortTargetId = target.id;
    if (target && target.kind === "direct") {
      // ── Direct CLI launch ── run the REAL binary via the terminal capability,
      // NOT through ollama. Uses the resolved absolute path (claudePath /
      // codexPath / opencodePath) so it survives the sandbox's minimal PATH.
      inner = "exec " + JSON.stringify(target.bin);
      label = target.id + " · " + basename(choice.cwd);
    } else {
      // ── Ollama launch path (existing) ── the dropdown's tool selects the
      // agent; the target id (an ollama model name) is passed as --model.
      const bin = ollamaPath || "ollama";
      const tool = choice.cli || "claude";
      inner = "exec " + JSON.stringify(bin) + " launch " + tool;
      // Apply the resolved model as a CLI flag so the launched agent uses it
      // instead of opening its own model picker. choice.model is kept as a
      // back-compat fallback for any caller still passing the old field.
      const model = target ? target.model : choice.model;
      if (model) {
        inner += " --model " + JSON.stringify(model);
      }
      label = tool + " · " + basename(choice.cwd);
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
  const effort = effortForTarget(effortTargetId);
  let effectivePrompt = choice.prompt;
  if (effort) {
    const isCodex = /^exec "?[^"]*codex/.test(inner);
    if (isCodex && CODEX_EFFORT_FLAG_VALUES.has(effort)) {
      inner += " --config 'model_reasoning_effort=\"" + effort + "\"'";
      codexFlagApplied = true;
    } else if (EFFORT_BRIEF[effort] && effectivePrompt) {
      effectivePrompt = effectivePrompt + "\n\n[" + EFFORT_BRIEF[effort] + "]";
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
  await registerSession(session, "zsh", ["-lic", inner], choice.cwd, label);
  if (effectivePrompt) {
    // Don't write the prompt immediately — the CLI (Claude Code / Codex) shows a
    // "trust this folder?" dialog and sometimes a model picker at launch, and
    // typing the prompt too early dumps it into the wrong screen. autoDriveStartup
    // watches the live output, handles the trust dialog (per the Settings trust
    // policy: ask in chat, or always trust), and sends the prompt once the agent's
    // real input box is ready (with a 12s safety timeout).
    try { autoDriveStartup(session, effectivePrompt, label, choice.cwd); } catch (e) { /* non-fatal */ }
  }
  return { id: session.id, label, cwd: choice.cwd };
}

// ---------- Settings panel ----------
export function renderDetectedList() {
  if (!el.detectedList) return;
  // Read the LIVE detection object — the same source the launch-target pickers
  // (and the chat pill picker) consume via availableOllamaModels() — NOT the
  // persisted settings.detected snapshot. The snapshot can be stale (restored
  // from an older app version) and then disagrees with the pickers, which is
  // exactly the "Settings shows fewer models than the chat picker" bug.
  const d = detection || { codex: false, claude: false, ollama: false, opencode: false, models: [], denied: false };
  el.detectedList.innerHTML = "";
  const row = (name, ok) => {
    const div = document.createElement("div");
    div.className = "detected-item";
    const mark = document.createElement("span");
    mark.className = ok ? "ok" : "no";
    mark.textContent = ok ? "✓" : "✗";
    div.appendChild(mark);
    div.appendChild(document.createTextNode(" " + name + (ok ? " installed" : " not found")));
    el.detectedList.appendChild(div);
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
    el.detectedList.appendChild(div);
  }
  if (d.codex && d.codexPath) {
    const div = document.createElement("div");
    div.className = "detected-item";
    div.textContent = "  codex direct: " + d.codexPath;
    el.detectedList.appendChild(div);
  }
  if (d.opencode && d.opencodePath) {
    const div = document.createElement("div");
    div.className = "detected-item";
    div.textContent = "  opencode direct: " + d.opencodePath;
    el.detectedList.appendChild(div);
  }
  // The COMPLETE ollama model list (terminal detection + local models from the
  // ChatOSS chat model list — the same source the model picker at the top of
  // the AI chat section uses), so Settings shows every detected model.
  const ollamaModels = allOllamaModels();
  if (d.ollama || ollamaModels.length) {
    const div = document.createElement("div");
    div.className = "detected-item";
    div.textContent = "ollama models (" + ollamaModels.length + "): " + (ollamaModels.join(", ") || "(none)");
    el.detectedList.appendChild(div);
  }
  if (d.denied) {
    const div = document.createElement("div");
    div.className = "detected-item";
    div.style.color = "var(--danger)";
    div.textContent = "Terminal permission needed for auto-detection.";
    el.detectedList.appendChild(div);
  }
}

export function openSettings() {
  // Fall back to "ask" when the saved default isn't among the current options
  // (e.g. a legacy "ollama" value from an older build) — otherwise the select
  // renders blank and Save would silently clear the default.
  const cliValues = Array.from(el.setCli.options).map((o) => o.value);
  el.setCli.value = cliValues.includes(settings.cliDefault) ? settings.cliDefault : "ask";
  el.setCwd.value = settings.cwdDefault || "";
  renderDetectedList();
  applyModelSelectionModeToUi();
  applyTrustModeToUi();
  if (el.autoFollow) el.autoFollow.checked = settings.autoFollow !== false;
  el.settingsPanel.classList.remove("hidden");
}

export function syncSettingsModelRow() {
  // Model is chosen inside the launched terminal — no settings model row.
  if (el.setModelRow) el.setModelRow.classList.add("hidden");
}

export function saveSettingsFromPanel() {
  settings.cliDefault = el.setCli.value;
  settings.cwdDefault = el.setCwd.value.trim();
  // Model Selection Mode persists to its own scopedData keys (handled by
  // saveModelSelectionMode), not the bundled settings blob. Sync it now so
  // any uncommitted picker value is captured on Save.
  saveModelSelectionMode();
  saveTrustMode();
  if (el.autoFollow) settings.autoFollow = !!el.autoFollow.checked;
  saveSettings();
  el.settingsPanel.classList.add("hidden");
}

// ---------- Check for updates ----------
// The app cannot replace its own files, so "update" = notify + open the GitHub
// releases page for the user to install. APP_VERSION (top of file) must stay
// in sync with app.json's "version".
