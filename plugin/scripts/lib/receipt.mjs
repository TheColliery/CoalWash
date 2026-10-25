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
  const raw = Math.round(Number(cutTokens) || 0);
  // grad6 R1-R5 (CoalBoard verdict): this used to clamp a negative cut to a
  // CLEAN ZERO (`Math.max(0, ...)`) rather than return null — correct, per
  // the กฎเหล็ก above (never silence). But clamping all the way to zero
  // means a run that GREW the store (cutTokens < 0, e.g. new content added
  // faster than anything was cut) prints the IDENTICAL line a genuine no-op
  // clean prints — "cut ~0 tok (−0%)" either way, so growth is
  // indistinguishable from a working, quiet autopilot. Never let a negative
  // delta collapse into the same zero a real zero produces: report growth
  // explicitly, using the same "+"/no-sign convention buildReceipt already
  // uses for a store that grew (see the `pct <= 0 ? '' : '+'` line above).
  if (raw < 0) {
    const grownPct = Number.isFinite(cutPercent) ? Math.abs(Math.round(cutPercent)) : 0;
    return `[CoalWash] grew ~${ktok(-raw)} tok (+${grownPct}%)`;
  }
  const pct = Number.isFinite(cutPercent) ? Math.max(0, Math.round(cutPercent)) : 0;
  return `[CoalWash] cut ~${ktok(raw)} tok (−${pct}%)`;
}

// CWK2-062 + INSPECT 170 + INSPECT 172 + INSPECT 182: the gate's PASS line. It names what the gate checks (the list
// below), never "facts lost": the gate reads STRUCTURED tokens only (fidelity-gate.mjs), so a PASS proves no structured
// drop beyond the plan's own approvedDrops, and nothing about prose. A drop value is caller data (a link target, a file
// name, a fenced code line), so each member renders as a JSON string: quoted, with every C0 control escaped by JSON
// itself. escapeRawControls then escapes the rest of the class. A backslash-u literal typed into source can arrive as
// the raw character (AGENTS, the escape-transit hazard), so every escape here is built from code points.
const FIDELITY_LISTED_MAX = 5;
const FIDELITY_CHECKED = 'checked: links, dates, versions, frontmatter keys, code, quotes, numbers';
const BACKSLASH = String.fromCharCode(92);
const UNRENDERABLE = '<unrenderable>';
// The whole class of characters a terminal, a log or a bidi-aware renderer can act on: Cc (C0, DEL, C1), Cf (the bidi
// controls, the zero-width characters, the BOM, the tag characters), and the line and paragraph separators Zl and Zp.
// A display spoof on a consent-adjacent line is the Trojan Source class (CVE-2021-42574); one property test covers it.
const RAW_CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
function isRawControl(ch) {
  return RAW_CONTROL.test(ch);
}
// The escape text for one raw character: \uXXXX in the BMP, \u{...} above it (a four-digit form cannot hold U+E0001).
function escapeText(cp) {
  const hex = cp.toString(16);
  return cp > 0xffff ? `${BACKSLASH}u{${hex}}` : `${BACKSLASH}u${hex.padStart(4, '0')}`;
}
function escapeRawControls(text) {
  let out = '';
  for (const ch of text) {
    out += isRawControl(ch) ? escapeText(ch.codePointAt(0)) : ch;
  }
  return out;
}
// A member's text: a string is itself; anything else is its JSON text. null means the member cannot be rendered (a
// BigInt, a cyclic object, a throwing toJSON or toString). Two unrenderable members share a key and collapse; no JSON
// plan can carry one (INSPECT 182), so that stays as it is.
function memberForm(member) {
  try {
    if (typeof member === 'string') return member;
    return JSON.stringify(member) ?? String(member);
  } catch {
    return null;
  }
}
// The unrenderable sentinel is printed bare, so it can never equal a quoted string entry (F182-3). A renderable member
// is its form, JSON-quoted and escaped.
function receiptText(entry) {
  return entry.form === null ? UNRENDERABLE : escapeRawControls(JSON.stringify(entry.form));
}
// apply.mjs holds approvedDrops as a Set. Here a member's key is its type plus its form, so a string and a non-string
// with the same rendered form (null and 'null') stay two drops (R172-3), while two equal strings stay one. The Set
// matches these keys for strings and the other primitives; a JSON object or array is compared by identity there and by
// its text here.
function fidelityPassLine(approved) {
  const entries = [...new Map(approved.map((m) => {
    const form = memberForm(m);
    return [`${typeof m}:${form ?? 'unrenderable'}`, { form }];
  })).values()];
  if (entries.length === 0) return `fidelity gate: PASS (no structured-token drop; ${FIDELITY_CHECKED})`;
  const shown = entries.slice(0, FIDELITY_LISTED_MAX).map(receiptText).join(', ');
  const more = entries.length > FIDELITY_LISTED_MAX ? ` +${entries.length - FIDELITY_LISTED_MAX} more` : '';
  return `fidelity gate: PASS (no structured-token drop beyond the ${entries.length} the plan approved: ${shown}${more}; ${FIDELITY_CHECKED})`;
}

// r = {
//   when?: ISO date string,
//   beforeBytes, afterBytes,                    — whole class-B store (deterministic)
//   alwaysBeforeTokens, alwaysAfterTokens,      — the every-session cost (~est)
//   oneTimeCostTokens?,                         — this run's spend (~est; 0 for a pure-mechanical Quick)
//   removed, trimmed, kept, flaggedKept?,       — counts
//   gatePass: bool, gateDrops?: number,
//   approvedDrops?: string[],                   — CWK2-062: the plan's own "type:value"
//     list (apply.mjs plan.approvedDrops). The PASS line names what the gate
//     checked and, when this is non-empty, the count and the drops (at most
//     FIDELITY_LISTED_MAX named, then "+N more"). The gate proves no STRUCTURED
//     token dropped; it says nothing about prose facts, so no line claims it.
//   breakEvenSessions?: number,
//   dryRun?: bool,
//   pendingUserKeeps?: number,                  — board #129: count of keeps.mjs's
//     pendingUserKeeps(loadKeeps(...)) — a keep whose own reason names the
//     user as decision-holder and has not yet had that decision returned to
//     them. Fill it every run this store carries any (not only wizard runs)
//     — it is the mechanism that stops "settled" from meaning "an agent
//     decided and never asked."
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
      ? fidelityPassLine(Array.isArray(r.approvedDrops) ? r.approvedDrops : [])
      : `fidelity gate: FAIL — ${r.gateDrops || '?'} drop(s); the apply is BLOCKED until every drop is restored`);
  // wikilink-orphan advisory (apply.mjs deadLinkLine — one line, never a
  // block): present only when a deleted topic is still referenced.
  if (r.deadLinkLine) lines.push(r.deadLinkLine);
  // board #129: a keep the agent is NOT authorized to have settled alone —
  // absent/0 renders nothing (a store with none stays silent, matching every
  // other optional line here); present only to say the count, never the
  // targets (that list lives in keeps.json for the human to open, not in a
  // receipt this room's own doctrine keeps metrics-only, §9b).
  if (r.pendingUserKeeps > 0) lines.push(`${r.pendingUserKeeps} keep(s) await YOUR decision — the reason named you, not the agent (see .claude/coalwash/keeps.json)`);
  return lines.join('\n');
}
