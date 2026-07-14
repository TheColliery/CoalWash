#!/usr/bin/env node
'use strict';
// CoalWash conductor — Antigravity (AG 2.0 hooks.json) adapter. AG shipped a
// real IDE hook engine (empirical pilot 2026-07-12, corroborated vs the
// official docs 2026-07-13). This file is a THIN TRANSPORT shim: it normalizes
// AG's payload/event shape and calls the SAME handlers coalwash-conductor.js
// exports (one implementation, no divergence — the CoalHearth AG-port shape).
// The port changes the TRANSPORT only; every consent/cadence semantic (bands,
// once-per-crossing, consume-at-emission, 0h-GUARD run-gating) is byte-shared.
//
// Event mapping (AG has exactly 5 events; SessionStart is a valid name that
// NEVER fires there):
//   PreInvocation (FIRST of a session) -> the SILENT SessionStart gauge
//       (discovery + measure + verdict + crossing arming). PreInvocation fires
//       per MODEL CALL, so a per-session tmp marker (keyed on session_id)
//       guards it to exactly one gauge per session; every later call exits at
//       one fs.existsSync (~free, Phoenix #3). New session = new session_id =
//       new marker name, so a dead session's marker is inert by construction
//       (never a persisted "same session" proxy — the CoalHearth
//       cross-session-contamination class).
//   Stop        -> the delivery channel (per-RESPONSE on AG, CC semantics).
//       AG has NO {decision:'block'} Stop semantics — the pending
//       ask/directive is emitted as {additionalContext} instead: an HONEST
//       ADVISORY DEGRADE of CC's enforcement channel, named in
//       references/platform-ag.md. Consume-at-emission is unchanged.
//   PreToolUse  -> the 0p AIRBAG   (write-only snapshot; AG tool names
//   PostToolUse -> the 0p SEATBELT  normalized to the CC shape below).
//
// DELIBERATELY NOT PORTED (named limitations, see references/platform-ag.md):
//   - the self-update nudge (its payload `claude plugin update` is
//     CC-plugin-specific; AG installs by file-copy) — updateNudge:false;
//   - the 0o spawn meter (AG's subagent-spawn tool name is UNVERIFIED; a
//     wrong guess would silently inflate the true-bill NUMBERS that justify
//     the economic-dominance FULL force — fail direction forbids guessing);
//   - AG-native class-B discovery (AGENTS.md/.agents/~/.gemini surfaces):
//     the gauge rides the existing discoverClassB — on a machine WITHOUT
//     ~/.claude, detectPlatform() returns 'unknown' and the gauge is INERT
//     by construction (no entries, no state written, no ~/.claude created).
//
// stdin: AG core fields are snake_case (session_id, cwd, hook_event_name —
// already CC-compatible); only toolCall.* is camelCase and needs normalizing.
// Reader is DEFENSIVE (both casings, unknown tool -> no-op, garbage -> {}).
// stdout: the ONLY sanctioned emit is one {additionalContext} JSON line
// (camelCase key — pilot-confirmed; snake_case was AG's own wrong guess).
// Whether AG DELIVERS it into the agent's context is pilot-UNCONFIRMED —
// emitted per spec, nothing here claims validated-on-AG.
// Phoenix-13 throughout: fail-silent, zero-dep, no network, no child process,
// no process.exit().
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const conductor = require('./coalwash-conductor.js');

// Deterministic djb2 (Phoenix #8) — an arbitrary session key becomes a stable,
// filesystem-safe marker token (the CoalHearth ag-pre-invocation shape).
function hashKey(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h + s.charCodeAt(i)) >>> 0);
  return h.toString(36);
}

function firstString(obj, keys) {
  if (!obj || typeof obj !== 'object') return '';
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v) return v;
  }
  return '';
}
const pickObject = (v) => (v && typeof v === 'object' && !Array.isArray(v)) ? v : undefined;

// AG file-editing tool candidates -> CC 'Write'. Only `write_to_file` is
// pilot-named; the rest are plausible AG/Gemini-family guesses, UNVERIFIED —
// safe because the fail direction is a NO-OP (an unmapped write tool just
// isn't guarded; it never mutates state or emits). Same set as CoalHearth's
// shipped AG adapter (one flock). Extend as AG's tool schema is confirmed.
const AG_FILE_TOOLS = new Set([
  'write_to_file',
  'edit_file',
  'replace_file_content',
  'create_file',
  'apply_diff',
  'multiedit',
]);
// Plausible path-arg keys inside an AG file-tool's args, probed in order
// (toolCall.args keys are camelCase per the pilot; snake_case kept defensively).
const AG_PATH_KEYS = ['file_path', 'filePath', 'path', 'TargetFile', 'target_file', 'AbsolutePath', 'notebook_path'];
// CC vocab passthrough — if AG ever emits CC-shaped names they work natively.
const CC_WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

// Normalize an AG PreToolUse/PostToolUse payload into the CC shape the shared
// airbag/seatbelt handlers dispatch on ({session_id, tool_name, tool_input}).
// null = not a recognized file-write tool -> the caller no-ops (degrade-safe).
function normalizeWrite(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const toolCall = pickObject(payload.toolCall) || pickObject(payload.tool_call) || {};
  const name = firstString(payload, ['tool_name', 'toolName']) || firstString(toolCall, ['name']) || '';
  const args = pickObject(payload.tool_input) || pickObject(toolCall.args) || {};
  if (CC_WRITE_TOOLS.has(name)) {
    return { session_id: payload.session_id, tool_name: name, tool_input: args };
  }
  if (AG_FILE_TOOLS.has(name) || AG_FILE_TOOLS.has(name.toLowerCase())) {
    const filePath = firstString(args, AG_PATH_KEYS);
    if (!filePath) return null; // no path -> nothing to guard
    return { session_id: payload.session_id, tool_name: 'Write', tool_input: { file_path: filePath } };
  }
  return null;
}

async function main() {
  const payload = await conductor.readStdinJson(); // budgeted, never blocks past 30ms
  const event = (payload && (payload.hook_event_name || payload.hookEventName)) || process.argv[2] || '';
  // AG's hook cwd is unverified — the payload's `cwd` (the workspace) is
  // authoritative for findProjectRoot; chdir is process-local and fail-safe.
  const cwd = payload && typeof payload.cwd === 'string' ? payload.cwd : '';
  if (cwd) { try { process.chdir(cwd); } catch { /* keep the spawn cwd */ } }
  // The sanctioned AG injection channel — ONE single-line JSON object.
  const agEmit = (text) => console.log(JSON.stringify({ additionalContext: String(text) }));

  if (event === 'PreInvocation') {
    // Once-per-session guard (see header). No key -> cannot dedupe across
    // turns -> skip silently (Phoenix #12) rather than gauge every model call.
    const key = firstString(payload, ['session_id', 'sessionId', 'transcript_path', 'transcriptPath']);
    if (!key) return;
    const marker = path.join(os.tmpdir(), `coalwash-ag-gauge-${hashKey(key)}.marker`);
    let alreadyRan = false;
    try { alreadyRan = fs.existsSync(marker); } catch { /* unreadable tmp -> treat as first run */ }
    if (alreadyRan) return; // the ~free per-model-call happy path
    // Marker BEFORE the gauge (the v1.2.1 crash-safe-throttle ordering). A
    // failed write may re-gauge next call — harmless: the gauge is SILENT by
    // design (band collapse), so a repeat costs milliseconds, never noise.
    // ponytail: session markers accumulate ~1 tiny file/session in tmp,
    // OS-reaped (AG's Stop is per-response, so no safe delete point exists).
    try { fs.writeFileSync(marker, String(Date.now()), 'utf8'); } catch { /* may repeat, silent */ }
    return conductor.handleSessionStart(payload, { emit: agEmit, updateNudge: false });
  }
  if (event === 'Stop') return conductor.handleStop(payload, { emit: agEmit });
  if (event === 'PreToolUse') {
    const input = normalizeWrite(payload);
    if (input) return conductor.handleAirbag(input);
    return; // unknown tool -> no-op (degrade-safe)
  }
  if (event === 'PostToolUse') {
    const input = normalizeWrite(payload);
    if (input) return conductor.handleSeatbelt(input, { emit: agEmit });
    return; // unknown tool (incl. spawns — the meter is deliberately unwired on AG)
  }
  // Unknown/missing event -> no-op. Deliberately NOT the CC conductor's
  // gauge fallthrough: on AG the gauge belongs to the guarded PreInvocation
  // branch only — an unguarded fallthrough would re-gauge on every unmapped
  // event.
}

main().catch(() => {
  // Phoenix #4: fail-silent, never throw, never crash the parent agent.
});
// No process.exit() — Phoenix #4 (would truncate the sanctioned stdout write above).
