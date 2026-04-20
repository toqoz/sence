import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { buildFenceArgs, teeMonitorLog } from "../executor.js";
import { audit, isSignificantDenial } from "../auditor.js";
import { callCodex, loadExtendsTemplate } from "../suggester.js";
import { ensurePolicy, writePolicy, diffPolicy, validatePolicy, mergePolicy, defaultPolicyForProfile, additionsToPatch, assessAddition } from "../policy.js";
import { isInsideTmux, sendEscape, capturePaneContent, displayPopup, supportsPopup, currentPane, prefillInput } from "../tmux.js";
import { shellQuote } from "../cli.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHEATSHEET = readFileSync(join(__dirname, "..", "..", "docs", "fence-cheatsheet.md"), "utf-8");
const INTERACTIVE_SCHEMA = join(__dirname, "..", "..", "docs", "interactive-schema.json");

const DEBOUNCE_MS = 1500;

const ESC_WAIT_MS = 2000;
const KILL_WAIT_MS = 3000;

// Interactive mode must not write to stderr while the wrapped TUI owns the
// pane (even post-kill, residual output would clutter the pane the user
// returns to). Route sence status/error messages to the monitor log file.
function logEvent(logPath, msg) {
  if (!logPath) return;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, msg.endsWith("\n") ? msg : msg + "\n");
  } catch {
    // best-effort
  }
}

function buildInteractivePrompt({ currentPolicy, auditSummary, screenContent, originalCommand }) {
  const tmpl = loadExtendsTemplate(currentPolicy);
  const templateSection = tmpl
    ? `## Baseline from "extends": "${tmpl.name}"

fence(1) merges this template under the current fence.json at runtime. Treat
every entry below as already granted — no need to propose them.

\`\`\`json
${tmpl.json.trim()}
\`\`\`
`
    : `## Baseline

The current fence.json does not extend a template; it starts from an empty
policy.
`;

  return `## Task

Propose a flat list of additions to the child fence.json so the agent can
resume, and if possible the exact command to resume the agent session.

You do NOT need to emit the full fence.json, diff existing arrays, or re-list
entries that are already granted. sence will append your additions to the
existing arrays, dedupe against current and the baseline template, and reject
any entry that violates the safety rules below.

## Rules

- Cover EVERY denial in the audit. Each \`deniedFiles\` / \`deniedNetwork\`
  entry should produce at least one addition, unless intentionally skipped
  for safety (note in rationale).
- Every addition must directly address a denial from the audit above.
  Do NOT propose tightening (extra command.deny, network.deny, etc.) for
  anything that was not denied — the goal is the smallest change to resume
  the agent, not a hardening pass.
- Prefer narrow wildcards ("*.npmjs.org") over broad ones ("*").
- Never propose credential paths under allowRead/allowWrite (sence will
  block them regardless). Never propose broad home globs.
- Assign riskLevel per entry: "low" / "medium" / "high". Informational only.
- Set relatedDenial to a short trace string identifying the unblocked denial.
- Set resumeCommand to null if the session ID is not visible in the screen.

## Reference

${CHEATSHEET}

${templateSection}
## Original command

${JSON.stringify(originalCommand)}

## Current fence.json (child)

${JSON.stringify(currentPolicy, null, 2)}

## Audit (denied events)

${JSON.stringify(auditSummary, null, 2)}

## Captured screen content

\`\`\`
${screenContent.slice(-4000)}
\`\`\`

## Output

Reply with ONLY this JSON:

{"proposedAdditions":[{"kind":"...","value":"...","riskLevel":"low|medium|high","rationale":"...","relatedDenial":"..."}],"explanation":"one short sentence","resumeCommand":"command to resume or null"}`;
}

function runInteractiveSuggester({ currentPolicy, auditSummary, screenContent, originalCommand, model }) {
  const prompt = buildInteractivePrompt({ currentPolicy, auditSummary, screenContent, originalCommand });
  return callCodex({ prompt, schemaPath: INTERACTIVE_SCHEMA, model });
}

export async function runInteractiveMode({ command, policyPath, snapshotDir, profile, suggest = "auto", model, logPath }) {
  if (!isInsideTmux()) {
    process.stderr.write("[sence] --interactive requires tmux.\n");
    process.exit(2);
  }

  const paneId = currentPane();
  if (!paneId) {
    process.stderr.write("[sence] Could not detect tmux pane.\n");
    process.exit(2);
  }

  let currentPolicy;
  try {
    currentPolicy = ensurePolicy(policyPath, { snapshotDir, defaultPolicy: defaultPolicyForProfile(profile) });
  } catch (err) {
    process.stderr.write(
      `[sence] Fatal: ${policyPath} is corrupt — ${err.message}\n` +
      `[sence] Fix or remove the file manually.\n`,
    );
    process.exit(2);
  }
  const fenceArgs = buildFenceArgs({ command, settingsPath: policyPath });

  const { exitCode, denials, interventionApproved } = await runAndMonitor({
    fenceArgs,
    paneId,
    logPath,
    suggest,
  });

  if (denials.length === 0) {
    // No denials — normal exit
    process.exit(exitCode);
  }

  if (interventionApproved !== true) {
    const reason = suggest === "never" ? "--suggest never" : "user declined";
    logEvent(logPath, `[sence] Skipping suggestions (${reason}), ${denials.length} denial(s) detected.`);
    process.exit(exitCode);
  }

  // Capture screen after kill (shows session ID / resume info)
  const screenContent = capturePaneContent(paneId);

  // Audit
  const monitorLog = denials.join("\n");
  const auditSummary = audit({ exitCode, monitorLog });

  // Suggest
  logEvent(logPath, "[sence] Analyzing sandbox violations...");
  const rec = runInteractiveSuggester({
    currentPolicy,
    auditSummary,
    screenContent,
    originalCommand: command,
    model,
  });

  if (rec.error || !Array.isArray(rec.proposedAdditions)) {
    logEvent(logPath, `[sence] Suggester error: ${rec.error || "no proposal"}`);
    process.exit(exitCode);
  }

  const acceptedAdditions = [];
  const blockedAdditions = [];
  for (const add of rec.proposedAdditions) {
    const verdict = assessAddition(add);
    if (verdict.block) blockedAdditions.push({ ...add, blockReason: verdict.reason });
    else acceptedAdditions.push(add);
  }

  const tmpl = loadExtendsTemplate(currentPolicy);
  const patch = additionsToPatch(currentPolicy, acceptedAdditions, { templateEntries: tmpl?.entries ?? null });
  const mergedPolicy = mergePolicy(currentPolicy, patch);

  const policyDiff = diffPolicy(currentPolicy, mergedPolicy);
  if (!policyDiff) {
    logEvent(logPath, "[sence] No policy changes suggested.");
    if (blockedAdditions.length > 0) {
      logEvent(logPath, "[sence] Blocked additions:");
      for (const b of blockedAdditions) logEvent(logPath, `  - ${b.kind} ${b.value}: ${b.blockReason}`);
    }
    process.exit(exitCode);
  }

  const errors = validatePolicy(mergedPolicy);
  if (errors.length > 0) {
    logEvent(logPath, "[sence] Refusing unsafe policy:");
    for (const e of errors) logEvent(logPath, `  - ${e}`);
    process.exit(exitCode);
  }

  // Step 1: Show policy diff, ask to apply
  const policyAccepted = await askPolicyApply({
    auditSummary,
    explanation: rec.explanation,
    acceptedAdditions,
    blockedAdditions,
    policyDiff,
    paneId,
    logPath,
  });

  if (policyAccepted) {
    writePolicy(policyPath, mergedPolicy, { snapshotDir });
    logEvent(logPath, `[sence] Policy updated: ${policyPath}`);
  } else {
    logEvent(logPath, "[sence] Policy not changed.");
  }

  // Step 2: Prefill resume command in the pane (user reviews before running)
  // NOTE: The resume command is LLM-generated.
  if (rec.resumeCommand) {
    const resumeCmd = `sence --interactive -- ${rec.resumeCommand}`;
    logEvent(logPath, `[sence] Suggested resume command: ${resumeCmd}`);
    prefillInput(paneId, resumeCmd);
  }

  process.exit(exitCode);
}

function runAndMonitor({ fenceArgs, paneId, logPath, suggest }) {
  return new Promise((resolve) => {
    const child = spawn(fenceArgs[0], fenceArgs.slice(1), {
      stdio: ["inherit", "inherit", "inherit", "pipe"],
    });

    let denials = [];
    let debounceTimer = null;
    let interrupted = false;
    let exited = false;
    // "accept" | "continue" | "deny" | null (never prompted)
    let finalDecision = null;

    const cleanup = () => {
      if (!exited) {
        child.kill("SIGKILL");
      }
      process.exit(130);
    };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);

    const gracefulKill = () => {
      sendEscape(paneId);
      setTimeout(() => {
        if (exited) return;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!exited) child.kill("SIGKILL");
        }, KILL_WAIT_MS);
      }, ESC_WAIT_MS);
    };

    teeMonitorLog(child.stdio[3], (line) => {
      if (!isSignificantDenial(line)) return;
      denials.push(line);

      if (interrupted) return;
      interrupted = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        logEvent(logPath, `[sence] Denial detected (${denials.length}); prompting user.`);
        for (const d of denials) logEvent(logPath, `  ${d}`);
        const decision = askIntervention({
          denials,
          logPath,
          suggestEnabled: suggest !== "never",
        });
        logEvent(logPath, `[sence] User decision: ${decision}.`);

        if (decision === "continue") {
          // Agent keeps running. Reset so future denials re-prompt, and drop
          // already-acknowledged ones so the next popup shows only new info.
          denials = [];
          interrupted = false;
          return;
        }

        finalDecision = decision; // "accept" or "deny"
        gracefulKill();
      }, DEBOUNCE_MS);
    }, { logPath });

    // Mark exited early so the kill-ladder above short-circuits, but wait
    // for "close" so the fd3 pipe drains and no trailing denial is lost.
    child.on("exit", () => {
      exited = true;
    });

    child.on("close", (code, signal) => {
      if (debounceTimer) clearTimeout(debounceTimer);
      process.removeListener("SIGINT", cleanup);
      process.removeListener("SIGTERM", cleanup);
      resolve({
        exitCode: code ?? (signal ? 128 : 0),
        denials,
        interventionApproved: finalDecision === "accept",
      });
    });
  });
}

// Returns one of: "accept" | "continue" | "deny".
// - accept:   kill the agent and run the LLM suggestion flow (prefill resume)
// - continue: leave the agent running; denial already logged
// - deny:     kill the agent; skip the suggestion flow
// With suggestEnabled=false (--suggest never), only "continue" / "deny" are
// offered — "close" in the UI, internally "deny".
function askIntervention({ denials, logPath, suggestEnabled }) {
  // Env bypass: skip the popup and use the specified decision. Intended for
  // tests and headless/automated sence runs. Not exposed as a CLI flag.
  const envDefault = process.env.SENCE_INTERVENTION;
  if (envDefault === "accept" || envDefault === "continue" || envDefault === "deny") {
    logEvent(logPath, `[sence] SENCE_INTERVENTION=${envDefault}: skipping popup.`);
    return envDefault;
  }

  if (!supportsPopup()) {
    // Old tmux: cannot prompt. Preserve prior behavior (always kill + LLM)
    // when suggestions are enabled; otherwise just kill.
    logEvent(logPath, "[sence] Cannot prompt — tmux popup unavailable. Defaulting.");
    return suggestEnabled ? "accept" : "deny";
  }

  const lines = [];
  lines.push("=== Sandbox Denial Detected ===");
  lines.push("");
  const shown = denials.slice(0, 20);
  for (const d of shown) lines.push(`  ${d}`);
  if (denials.length > shown.length) {
    lines.push(`  … and ${denials.length - shown.length} more`);
  }
  lines.push("");

  let promptLine;
  let caseBlock;
  if (suggestEnabled) {
    lines.push("  [a]ccept   — kill agent, run LLM suggestion, prefill resume command");
    lines.push("  [c]ontinue — leave agent running (denial is logged)");
    lines.push("  [d]eny     — kill agent; skip suggestion");
    lines.push("");
    promptLine = `printf "[a]ccept / [c]ontinue / [d]eny? [a/c/D] "`;
    caseBlock = [
      `case "$answer" in`,
      `  a|A) echo accept ;;`,
      `  c|C) echo continue ;;`,
      `  *) echo deny ;;`,
      `esac`,
    ];
  } else {
    lines.push("Running with --suggest never (LLM suggestions disabled).");
    lines.push("");
    lines.push("  [c]ontinue — leave agent running");
    lines.push("  [k]close   — kill agent");
    lines.push("");
    promptLine = `printf "[c]ontinue / [k]close? [c/K] "`;
    caseBlock = [
      `case "$answer" in`,
      `  c|C) echo continue ;;`,
      `  *) echo deny ;;`,
      `esac`,
    ];
  }
  const content = lines.join("\n");

  const tmpDir = mkdtempSync(join(tmpdir(), "sence-intervene-"));
  const reviewFile = join(tmpDir, "denial.txt");
  const scriptFile = join(tmpDir, "ask.sh");
  const resultFile = join(tmpDir, "result");

  writeFileSync(reviewFile, content);
  writeFileSync(scriptFile, [
    "#!/bin/sh",
    `cat ${shellQuote(reviewFile)}`,
    promptLine,
    `read answer`,
    `{`,
    ...caseBlock,
    `} > ${shellQuote(resultFile)}`,
  ].join("\n") + "\n");

  displayPopup({ command: `sh ${shellQuote(scriptFile)}` });

  try {
    const decision = readFileSync(resultFile, "utf-8").trim();
    if (decision === "accept" || decision === "continue" || decision === "deny") {
      return decision;
    }
    return "deny";
  } catch {
    return "deny";
  }
}

async function askPolicyApply({ auditSummary, explanation, acceptedAdditions = [], blockedAdditions = [], policyDiff, paneId, logPath }) {
  const lines = [];
  lines.push("=== Sandbox Violation ===");
  lines.push("");
  for (const net of auditSummary.deniedNetwork) lines.push(`  denied network: ${net.host}:${net.port}`);
  for (const file of auditSummary.deniedFiles) lines.push(`  denied file: ${file.path} (${file.action})`);
  lines.push("");
  if (explanation) lines.push(`Recommendation: ${explanation}`);
  if (acceptedAdditions.length > 0) {
    lines.push("");
    lines.push("Proposed additions:");
    for (const a of acceptedAdditions) {
      lines.push(`  [${a.riskLevel ?? "?"}] ${a.kind} ${a.value} — ${a.rationale ?? ""}`);
    }
  }
  if (blockedAdditions.length > 0) {
    lines.push("");
    lines.push("Blocked by sence safety rules (not applied):");
    for (const b of blockedAdditions) {
      lines.push(`  ! ${b.kind} ${b.value} — ${b.blockReason}`);
    }
  }
  lines.push("");
  lines.push("Proposed policy diff:");
  lines.push(policyDiff);
  lines.push("");
  const content = lines.join("\n");

  if (supportsPopup()) {
    const tmpDir = mkdtempSync(join(tmpdir(), "sence-review-"));
    const reviewFile = join(tmpDir, "review.txt");
    const scriptFile = join(tmpDir, "review.sh");
    const resultFile = join(tmpDir, "result");

    writeFileSync(reviewFile, content);
    writeFileSync(scriptFile, [
      "#!/bin/sh",
      `cat ${shellQuote(reviewFile)}`,
      `printf "Apply this policy change? [y/N] "`,
      `read answer`,
      `case "$answer" in`,
      `  y|Y|yes|YES) echo "ACCEPTED" > ${shellQuote(resultFile)} ;;`,
      `  *) echo "REJECTED" > ${shellQuote(resultFile)} ;;`,
      `esac`,
    ].join("\n") + "\n");

    displayPopup({ command: `sh ${shellQuote(scriptFile)}` });

    let accepted = false;
    try {
      accepted = readFileSync(resultFile, "utf-8").trim() === "ACCEPTED";
    } catch {
      accepted = false;
    }
    logEvent(logPath, `[sence] Policy patch ${accepted ? "accepted" : "rejected"} by user.`);
    return accepted;
  }

  // No popup (tmux < 3.2): cannot prompt without polluting the pane.
  // Log the proposal and reject so the user has a record and no silent apply.
  logEvent(logPath, "[sence] Cannot prompt for review — tmux popup unavailable. Rejecting by default.");
  logEvent(logPath, content);
  return false;
}
