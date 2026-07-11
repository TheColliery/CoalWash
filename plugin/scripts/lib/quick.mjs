// quick.mjs — beta.12 item 7 (queue item 0b, "QUICK-CEILING EXPANSION"): the
// FIRST two Quick-tier ops promoted from agent-executed procedure
// (method.md §1, which has always been hand-run, never coded) into
// deterministic CODE. Both are LAB-GRADUATED — named, real defects the wear
// campaign found, not speculative ceiling-chasing:
//   (1) sweepResidue    — r1 #11's residue, hit again at r3 ("## Commits"
//       heading left behind after its content was cut). Scope-limited to
//       "our own knife's residue": a heading MATCHED between orig and new by
//       (level,title) that had content in orig and has NONE in new. Never
//       touches a heading that was ALREADY empty before this edit (that is
//       queue item 0b's named non-graduate: a deliberate placeholder =
//       intent = meaning, flagEmptyHeadings' job, never an auto-cut).
//   (2) stripEmptyTables — r1 #11 again ("nothing survives because nothing
//       exists"): a GFM table reduced to header+separator+ZERO data rows is
//       UNCONDITIONALLY safe to remove (no orig needed — an empty table
//       conveys no content under any history, unlike an empty heading which
//       might be a deliberate section placeholder).
//   (3) flagEmptyHeadings — the GENERAL case (no orig-vs-new residue scope):
//       a bare empty heading found in a SINGLE snapshot is FLAGGED only,
//       never auto-cut (queue item 0b's named non-graduate).
//
// MECHANICAL-SHARE MEASUREMENT (queue 0b's precondition — "measure the
// mechanical share first from existing receipts... decide by number, not
// faith"): searched this repo's CHANGELOG.md and the org benchmark records
// (../../../.github/benchmarks/CoalWash/results/*.md, read 2026-07-11) for an
// existing Quick-vs-Full byte/token attribution. NONE EXISTS — the beta.6
// real dogfood clean and every wear-campaign round (arm-3, rounds 1-7, the
// Thai arm, the pressure arm) exercised the SEMANTIC outsider/adjudicator/
// executor pipeline exclusively; no receipted run has ever isolated a
// Quick-only pass, because until this file, the Quick tier was a
// hand-followed procedure (method.md §1), never executable code. The
// historical mechanical share is therefore 0% BY CONSTRUCTION — there was no
// code to attribute any saving to — so the "ceiling gap" is, trivially, as
// large as it can be. Combined with both rules being independently justified
// as NAMED, zero-FP-scoped fixes for REAL lab defects (never speculative),
// they ship per the precondition's own decision rule.
//
// Zero-dep, pure text-in/text-out (no fs): the caller (the agent, per the
// existing "compute new text -> gate -> apply" pattern) feeds the result
// into fidelity-gate.mjs then apply.mjs exactly like any other Quick op.

// A markdown ATX heading line: 1-6 #'s, a space, the title, an optional
// trailing closing-hash run stripped (CommonMark allows `## Title ##`).
const HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
// A GFM table row: at least one pipe, non-empty on the line (a bare `|` alone
// still counts — a 1-column table is valid GFM).
const TABLE_ROW_RE = /^[ \t]*\|.*\|?[ \t]*$|^[ \t]*\S.*\|.*$/;
// The separator row: pipes/colons/dashes/whitespace ONLY, each cell >= 1 dash
// (CommonMark's own minimum) — this is what distinguishes "header+separator"
// from two ordinary consecutive data rows.
const TABLE_SEP_RE = /^[ \t]*\|?(?:[ \t]*:?-+:?[ \t]*\|)*[ \t]*:?-+:?[ \t]*\|?[ \t]*$/;

function parseHeadings(text) {
  const lines = String(text).split(/\r?\n/);
  const heads = [];
  lines.forEach((line, i) => {
    const m = HEADING_RE.exec(line);
    if (m) heads.push({ level: m[1].length, title: m[2].trim(), line: i });
  });
  return { lines, heads };
}

// The body text between heading[idx] and the next heading of level <= its
// own (or EOF) — trimmed, so pure whitespace/blank lines count as empty.
function headingBody(lines, heads, idx) {
  const h = heads[idx];
  let endLine = lines.length;
  for (let j = idx + 1; j < heads.length; j++) {
    if (heads[j].level <= h.level) { endLine = heads[j].line; break; }
  }
  return lines.slice(h.line + 1, endLine).join('\n').trim();
}

// (1) sweepResidue: a heading matched by (level,title) between origText and
// newText that HAD a body in orig and has NONE in new is our own knife's
// residue — remove the heading line (its body is already empty, nothing
// else to delete) plus one following blank line (avoids a double-blank
// scar). A heading absent from orig (a brand-new heading in newText) is
// never touched — only a MATCHED, newly-emptied heading qualifies.
export function sweepResidue(origText, newText) {
  const orig = parseHeadings(String(origText));
  const next = parseHeadings(String(newText));
  const toRemove = new Set();
  for (let i = 0; i < next.heads.length; i++) {
    const h = next.heads[i];
    const origIdx = orig.heads.findIndex((oh) => oh.title === h.title && oh.level === h.level);
    if (origIdx === -1) continue; // not present before this edit -> not our residue
    const origBody = headingBody(orig.lines, orig.heads, origIdx);
    if (!origBody) continue; // already empty before this edit -> flagEmptyHeadings' job, never auto-cut here
    const newBody = headingBody(next.lines, next.heads, i);
    if (!newBody) toRemove.add(h.line);
  }
  if (!toRemove.size) return String(newText);
  const out = [];
  for (let i = 0; i < next.lines.length; i++) {
    if (toRemove.has(i)) {
      if (i + 1 < next.lines.length && next.lines[i + 1].trim() === '') i++;
      continue;
    }
    out.push(next.lines[i]);
  }
  return out.join('\n');
}

// (2) stripEmptyTables: a table block (header row + separator row) with ZERO
// following data rows is removed whole — unconditional, no orig needed
// ("nothing survives because nothing exists" — an empty table conveys no
// content under any history, unlike an empty heading).
export function stripEmptyTables(text) {
  const lines = String(text).split(/\r?\n/);
  const toRemove = new Set();
  for (let i = 0; i < lines.length - 1; i++) {
    if (toRemove.has(i)) continue;
    if (!TABLE_ROW_RE.test(lines[i]) || TABLE_SEP_RE.test(lines[i])) continue; // header itself must not ALSO look like a bare separator
    if (!TABLE_SEP_RE.test(lines[i + 1])) continue;
    const hasDataRow = i + 2 < lines.length && TABLE_ROW_RE.test(lines[i + 2]) && !TABLE_SEP_RE.test(lines[i + 2]);
    if (hasDataRow) continue;
    toRemove.add(i);
    toRemove.add(i + 1);
  }
  if (!toRemove.size) return String(text);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (toRemove.has(i)) {
      if (!toRemove.has(i - 1) && i + 1 < lines.length && lines[i + 1].trim() === '' && !toRemove.has(i + 1)) { /* leave the single trailing blank as-is */ }
      continue;
    }
    out.push(lines[i]);
  }
  return out.join('\n');
}

// (3) flagEmptyHeadings: the GENERAL case, no orig-vs-new scope — a bare
// empty heading found in ONE snapshot. FLAGGED ONLY, never auto-cut
// (queue item 0b's named non-graduate: a deliberate placeholder = intent =
// meaning). Returns [{line, level, title}].
export function flagEmptyHeadings(text) {
  const { lines, heads } = parseHeadings(String(text));
  const out = [];
  for (let i = 0; i < heads.length; i++) {
    if (!headingBody(lines, heads, i)) out.push({ line: heads[i].line, level: heads[i].level, title: heads[i].title });
  }
  return out;
}
