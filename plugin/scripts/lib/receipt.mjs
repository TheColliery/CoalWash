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
  return lines.join('\n');
}
