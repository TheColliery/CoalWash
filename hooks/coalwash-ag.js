#!/usr/bin/env node
'use strict';
// CoalWash conductor — Antigravity (AG 2.0) hooks.json adapter, authored
// against the CURRENT primary spec (antigravity.google/docs/hooks, AG 2.0
// v2.3.1, fetched 2026-07-23). This file is a THIN TRANSPORT shim: it
// normalizes AG's payload/event shape and calls the SAME handlers
// hooks/coalwash-conductor.js exports (one implementation, no divergence —
// the CoalHearth AG-port shape). The port changes the TRANSPORT only; every
// consent/cadence semantic (bands, once-per-crossing, consume-at-emission,
// 0h-GUARD run-gating) is byte-shared.
//
// THE v2.3.1 SPEC (deltas vs the 2026-07-12 pilot this adapter's reverted
// predecessor was built on — af74bc0):
//   - events: PreToolUse / PostToolUse / PreInvocation / PostInvocation /
//     Stop. SessionStart does NOT exist on AG.
//   - stdin: camelCase — conversationId · workspacePaths[] · transcriptPath ·
//     artifactDirectoryPath (+ per-event fields). NO `cwd`, NO
//     `hook_event_name` (the event rides argv from hooks.json), NO
//     session_id.
//   - PreInvocation out: {injectSteps:[{ephemeralMessage|userMessage|
//     toolCall}]} — `additionalContext` is GONE from the spec.
//   - Stop out: {decision:'continue', reason} re-enters the loop with reason
//     injected as a SYSTEM message; any other decision allows the stop. A
//     REAL enforcement channel now (the old advisory degrade is retired).
//   - PreToolUse out: decision REQUIRED (allow|deny|ask|force_ask).
//   - PostToolUse in: stepIdx + error ONLY (no toolCall!), out ignored ({}).
//
// Event mapping:
//   PreInvocation (per MODEL CALL) ->
//     (a) FIRST of a conversation: the SILENT SessionStart gauge (discovery +
//         measure + verdict + crossing arming), guarded to once per
//         conversation by an atomic wx tmp marker; every later call exits the
//         gauge at one existsSync (~free, Phoenix #3).
//     (b) EVERY call: the 0p SEATBELT sweep — AG's PostToolUse carries no
//         tool name/args and its output is ignored, so the CC PostToolUse
//         advisory CANNOT ride it; instead PreToolUse enqueues each guarded-
//         candidate write into a per-conversation tmp queue, and the NEXT
//         PreInvocation diffs {airbag snapshot, disk} via the SAME
//         handleSeatbelt and injects ONE ephemeralMessage on a structured-
//         token drop. Queue entries are consumed per check and re-enqueued by
//         the next write — the same cumulative-vs-baseline, advise-per-write
//         semantics as CC.
//   Stop -> the delivery/enforcement channel. A pending crossing surfaces as
//     {decision:'continue', reason:<the CC directive verbatim>}; nothing
//     pending -> {decision:'allow'}. LOOP BELT (double net): (1)
//     consume-at-emission already prevents a re-emit (byte-shared); (2) a
//     per-conversation tmp note stores the hash of the last-emitted reason —
//     an IDENTICAL reason re-arriving (= state-consume failed to persist)
//     emits 'allow' instead of looping. A DIFFERENT directive (a real second
//     crossing) passes.
//   PreToolUse (matcher: the 3 documented AG write tools) -> the 0p AIRBAG
//     (snapshot-on-first-write) + the seatbelt enqueue. ALWAYS answers
//     {decision:'ask'} — the neutral value ('ask' respects Always-Allow =
//     AG's native gating); NEVER 'allow' (a hook must not silently WIDEN
//     permissions) and NEVER 'deny' (CW is advisory — blocking = sabotage).
//   PostToolUse -> not registered (payload carries nothing usable); a
//     defensive dispatch answers the documented {} and does nothing.
//
// DELIBERATELY NOT PORTED (named limitations, see
// skills/coalwash/references/platform-ag.md):
//   - the self-update nudge (its payload `claude plugin update` is
//     CC-plugin-specific; AG installs by file-copy) — updateNudge:false, so
//     the shared stamp is never written from AG (a suppressed-print stamp
//     would starve the CC-side nudge);
//   - the 0o spawn meter: AG's PreToolUse fires BEFORE approval (counting
//     there over-counts denied spawns) and PostToolUse carries no tool name
//     (attribution would be a matcher-trust guess) — either way the
//     true-bill NUMBERS that justify the economic-dominance FULL force
//     would be fabricated; fail direction forbids it. Meter unwired on AG.
//   - AG-native class-B discovery (AGENTS.md/.agents/~/.gemini surfaces):
//     the gauge rides the existing discoverClassB — on a machine WITHOUT
//     ~/.claude, detectPlatform() returns 'unknown' and the gauge is INERT
//     by construction (no entries, no state written, no ~/.claude created).
//
// Phoenix-13 throughout: fail-silent, zero-dep, no network, no child
// process, no process.exit(). Every registered event answers its documented
// output contract with EXACTLY one JSON line on stdout.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const conductor = require('./coalwash-conductor.js');

// Deterministic djb2 (Phoenix #8) — an arbitrary conversation key becomes a
// stable, filesystem-safe token (the CoalHearth ag-pre-invocation shape).
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

// One JSON line on stdout — the only sanctioned emission (Phoenix #13).
function answer(obj) { try { process.stdout.write(JSON.stringify(obj)); } catch { /* fail-silent */ } }

// The per-conversation key: conversationId is the documented UUID;
// transcriptPath is the documented per-conversation fallback; session_id kept
// for CC-shaped defensive passthrough.
function conversationKey(payload) {
  return firstString(payload, ['conversationId', 'session_id', 'sessionId', 'transcriptPath', 'transcript_path']);
}

// AG write tools per the v2.3.1 docs -> their CC analogues (the conductor's
// WRITE_TOOLS belt then verifies from the payload's OWN toolCall.name — never
// a guess). An unlisted tool is simply not guarded (no-op fail direction).
const AG_WRITE_TOOLS = { write_to_file: 'Write', replace_file_content: 'Edit', multi_replace_file_content: 'MultiEdit' };
// Documented path arg for all three: TargetFile. CC-shape keys kept defensively.
const AG_PATH_KEYS = ['TargetFile', 'target_file', 'file_path', 'filePath'];
// CC vocab passthrough — if a payload ever arrives CC-shaped it works natively.
const CC_WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

// Normalize an AG PreToolUse payload into the CC shape the shared airbag
// handler dispatches on ({session_id, tool_name, tool_input}). null = not a
// recognized file-write tool -> the caller no-ops (degrade-safe).
function normalizeWrite(payload, sessionKey) {
  if (!payload || typeof payload !== 'object') return null;
  const toolCall = pickObject(payload.toolCall) || pickObject(payload.tool_call) || {};
  const name = firstString(toolCall, ['name']) || firstString(payload, ['tool_name', 'toolName']) || '';
  const args = pickObject(toolCall.args) || pickObject(payload.tool_input) || {};
  if (CC_WRITE_TOOLS.has(name)) {
    const filePath = firstString(args, AG_PATH_KEYS);
    if (!filePath) return null;
    return { session_id: sessionKey, tool_name: name, tool_input: { file_path: filePath } };
  }
  if (name in AG_WRITE_TOOLS) {
    const filePath = firstString(args, AG_PATH_KEYS);
    if (!filePath) return null; // no path -> nothing to guard
    return { session_id: sessionKey, tool_name: AG_WRITE_TOOLS[name], tool_input: { file_path: filePath } };
  }
  return null;
}

// ---- per-conversation tmp state (OS-reaped; AG offers no safe delete point:
// Stop fires per execution loop, not per conversation end) -----------------
function tmpFile(prefix, key) { return path.join(os.tmpdir(), `${prefix}-${hashKey(key)}`); }

// The seatbelt write-queue: paths written since the last sweep. Corrupt /
// unreadable -> empty (a lost enqueue costs one advisory — the safe direction).
const QUEUE_CAP = 64;
function readQueue(key) {
  try {
    const q = JSON.parse(fs.readFileSync(tmpFile('coalwash-ag-wg', key) + '.json', 'utf8'));
    return Array.isArray(q) ? q.filter((p) => typeof p === 'string').slice(0, QUEUE_CAP) : [];
  } catch { return []; }
}
function writeQueue(key, q) {
  try { fs.writeFileSync(tmpFile('coalwash-ag-wg', key) + '.json', JSON.stringify(q.slice(0, QUEUE_CAP)), 'utf8'); }
  catch { /* fail-silent — a lost enqueue costs one advisory, never blocks */ }
}
function enqueueWrite(key, filePath) {
  const q = readQueue(key);
  if (!q.includes(filePath)) { q.push(filePath); writeQueue(key, q); }
}

async function main() {
  const payload = await conductor.readStdinJson(); // budgeted, never blocks past 30ms
  // The event rides argv (hooks.json: `node coalwash-ag.js <Event>`) — AG's
  // stdin carries NO event name. CC-shaped fields kept as fallback.
  const event = process.argv[2] || (payload && (payload.hook_event_name || payload.hookEventName)) || '';
  // AG spawns hook processes with cwd = the hooks.json dir (grounded vs the
  // installed build), NOT the workspace — workspacePaths[0] is the documented
  // workspace; chdir is process-local and fail-safe (CJS requires are
  // __dirname-anchored, so only project detection depends on cwd).
  const ws = payload && Array.isArray(payload.workspacePaths) ? payload.workspacePaths : [];
  const cwd = firstString(payload, ['cwd']) || (typeof ws[0] === 'string' ? ws[0] : '');
  if (cwd) { try { process.chdir(cwd); } catch { /* keep the spawn cwd */ } }
  const key = conversationKey(payload);

  if (event === 'PreInvocation') {
    const inject = []; // ephemeralMessage lines collected from the shared handlers
    // (a) once-per-conversation gauge. No key -> cannot dedupe across model
    // calls -> skip the gauge (Phoenix #12) rather than gauge every call.
    if (key) {
      const marker = tmpFile('coalwash-ag-gauge', key) + '.marker';
      let first = false;
      // Atomic wx create — marker BEFORE the gauge (crash-safe-throttle
      // ordering). EEXIST -> already gauged. Any other failure -> treat as
      // first run; a repeat gauge is SILENT by design (band collapse), so it
      // costs milliseconds, never noise.
      try { fs.writeFileSync(marker, String(Date.now()), { flag: 'wx' }); first = true; }
      catch (e) { first = !(e && e.code === 'EEXIST'); }
      if (first) {
        await conductor.handleSessionStart({ ...(pickObject(payload) || {}), session_id: key }, {
          emit: (text) => inject.push(String(text)),
          updateNudge: false, // CC-plugin-specific payload + shared-stamp starvation — see header
        });
      }
      // (b) the seatbelt sweep: consume the write-queue; handleSeatbelt does
      // ALL the gating (mode/writeGuard/guarded/baseline/clean) and advisory
      // building — one implementation. A clean check stays silent and the
      // path leaves the queue; the next write re-enqueues it (CC's
      // advise-per-write cadence).
      const q = readQueue(key);
      if (q.length) {
        writeQueue(key, []);
        for (const p of q) {
          await conductor.handleSeatbelt(
            { session_id: key, tool_name: 'Write', tool_input: { file_path: p } },
            { emit: (text) => inject.push(String(text)) },
          );
        }
      }
    }
    return answer(inject.length ? { injectSteps: [{ ephemeralMessage: inject.join('\n') }] } : {});
  }

  if (event === 'Stop') {
    let emitted = false;
    await conductor.handleStop({ ...(pickObject(payload) || {}), session_id: key }, {
      emit: (reason) => {
        emitted = true;
        const text = String(reason);
        // Loop belt (net 2): if the state-side consume failed to persist, the
        // SAME reason arrives again next Stop — answer 'allow' instead of
        // re-entering the loop forever. A different directive passes.
        const note = key ? tmpFile('coalwash-ag-stop', key) + '.txt' : '';
        const h = hashKey(text);
        if (note) {
          let prev = '';
          try { prev = fs.readFileSync(note, 'utf8'); } catch { /* first emission */ }
          if (prev === h) return answer({ decision: 'allow' });
          try { fs.writeFileSync(note, h, 'utf8'); }
          catch { return answer({ decision: 'allow' }); } // can't arm the belt -> fail toward silence, never toward a loop
        }
        answer({ decision: 'continue', reason: text });
      },
    });
    if (!emitted) answer({ decision: 'allow' }); // decision is REQUIRED on Stop — nothing pending = allow
    return;
  }

  if (event === 'PreToolUse') {
    // decision is REQUIRED. 'ask' is the neutral answer (respects Always-
    // Allow = AG's native gating); the airbag never widens ('allow') nor
    // blocks ('deny') a write — emitted FIRST so an airbag failure can never
    // leave the tool call unanswered.
    const input = normalizeWrite(payload, key);
    answer({ decision: 'ask' });
    if (input) {
      await conductor.handleAirbag(input); // write-only snapshot, emits nothing
      if (key) enqueueWrite(key, input.tool_input.file_path); // arm the PreInvocation seatbelt sweep
    }
    return;
  }

  if (event === 'PostToolUse') return answer({}); // payload carries no toolCall; documented output is {}

  // Unknown/missing event -> the least-wrong universal answer. Deliberately
  // NOT the CC conductor's gauge fallthrough: on AG the gauge belongs to the
  // guarded PreInvocation branch only.
  return answer({});
}

main().catch(() => {
  // Phoenix #4: fail-silent, never throw, never crash the parent agent.
});
// No process.exit() — Phoenix #4 (would truncate the sanctioned stdout write above).
