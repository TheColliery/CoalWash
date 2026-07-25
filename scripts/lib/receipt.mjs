// receipt.mjs — the terse, plain-text numbers block (blueprint §2b + gap #4 +
// §11b): the receipt IS the credibility mechanism — deterministic byte/KB
// numbers a stranger can reproduce, token numbers clearly labelled "~est".
// PLAIN + TERSE by design: no box-art, no ASCII decoration, no progress
// narration (a token-saver must be token-lean in its own output). Receipts
// carry METRICS ONLY — never memory-content snippets (§9b data-leak rule).

function kb(n) {
  return `${(n / 1024).toFixed(1)} KB`;
}
function ktok(n) {
  if (!Number.isFinite(n)) return '?';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
}

// One-line RESULT surface (beta.12 item 2 — MEMORY.md "DISPLAY FORMAT FINAL"
// / "COLLAPSED TO ONE SENTENCE EVER"): the single line CoalWash speaks after
// EVERY wash — a big clean, a small clean, the autonomous broom, the FULL
// force-run, all the SAME template, only the numbers differ.
//
// ALWAYS SPEAKS — กฎเหล็ก (USER 2026-07-25). This REVERSES the beta.12 trim
// ("cutting nothing is SILENCE", returns null, per the user's own
// "แค่นี้พอ...การมีใบเสร็จมันรกด้วย"). The reversal is deliberate and the
// reason is the loop above it: once the OBESE sweep re-fires on every new fat
// inflow, a silent zero-cut run is indistinguishable from a run that never
// happened, and the user cannot tell a working autopilot from a dead one. A
// zero line is the proof of life. NEVER reintroduce the null return.
//
// Canonical form is the user's: `ตัดไขมัน X tok (−Y%)` — TWO numbers, which is
// also what SKILL.md always claimed ("ONE line, two numbers") while the code
// shipped three. The EN string below is the BASELINE (series language standard:
// factory auto follows the conversation, EN needs no extra work); the agent
// renders the PROSE in the user's language and keeps the numbers and the unit
// `tok` VERBATIM. This is the terse PUSH surface; buildReceipt's full block
// stays the opt-in PULL surface (/stats or the wizard, never advertised).
export function oneLineResult(opts) {
  const { cutTokens, cutPercent } = opts || {};
  // Clamped, never null: a nonsensical negative cut renders as a clean zero
  // rather than a garbled line — the old code returned null here, and silence
  // is exactly what the กฎเหล็ก forbids.
  const cut = Math.max(0, Math.round(Number(cutTokens) || 0));
  const pct = Number.isFinite(cutPercent) ? Math.max(0, Math.round(cutPercent)) : 0;
  return `[CoalWash] cut ~${ktok(cut)} tok (−${pct}%)`;
}

// r = {
//   when?: ISO date string,
//   beforeBytes, afterBytes,                    — whole class-B store (deterministic)
//   alwaysBeforeTokens, alwaysAfterTokens,      — the every-session cost (~est)
//   oneTimeCostTokens?,                         — this run's spend (~est; 0 for a pure-mechanical Quick)
//   removed, trimmed, kept, flaggedKept?,       — counts
//   gatePass: bool, gateDrops?: number,
//   breakEvenSessions?: number,
//   dryRun?: bool,
// }
export function buildReceipt(r) {
  const lines = [];
  lines.push(`CoalWash receipt${r.dryRun ? ' (dry-run — nothing touched)' : ''} · ${r.when || new Date().toISOString().slice(0, 10)}`);
  const pct = r.beforeBytes > 0 ? ((r.afterBytes - r.beforeBytes) / r.beforeBytes) * 100 : 0;
  lines.push(`class B: ${kb(r.beforeBytes)} -> ${kb(r.afterBytes)} (${pct <= 0 ? '' : '+'}${pct.toFixed(1)}%)`);
  const savedPerSession = (r.alwaysBeforeTokens || 0) - (r.alwaysAfterTokens || 0);
  lines.push(`always-loaded: ~${ktok(r.alwaysBeforeTokens || 0)} -> ~${ktok(r.alwaysAfterTokens || 0)} tok/session (~est) · saves ~${ktok(Math.max(0, savedPerSession))} tok/session`);
  if (r.oneTimeCostTokens != null) {
    const be = r.breakEvenSessions;
    lines.push(`one-time cost: ~${ktok(r.oneTimeCostTokens)} tok (~est) · break-even: ${be == null || !Number.isFinite(be) ? 'n/a' : `~${Math.ceil(be)} session(s)`}`);
  }
  lines.push(`removed ${r.removed || 0} · trimmed ${r.trimmed || 0} · kept ${r.kept || 0}${r.flaggedKept ? ` · flagged-kept ${r.flaggedKept}` : ''}`);
  // Degrade to "unknown" when the gate field was never provided — undefined/
  // null must never read as FAIL (a false failure with no data behind it is
  // worse than admitting we don't know, per the series' honest-ceiling rule).
  lines.push(r.gatePass == null
    ? 'fidelity gate: unknown (fields not provided)'
    : r.gatePass
      ? 'fidelity gate: PASS (0 facts lost — links/dates/versions/frontmatter all preserved)'
      : `fidelity gate: FAIL — ${r.gateDrops || '?'} drop(s); the apply is BLOCKED until every drop is restored`);
  // wikilink-orphan advisory (apply.mjs deadLinkLine — one line, never a
  // block): present only when a deleted topic is still referenced.
  if (r.deadLinkLine) lines.push(r.deadLinkLine);
  return lines.join('\n');
}
