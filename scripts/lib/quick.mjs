// quick.mjs — beta.12 item 7 (queue item 0b, "QUICK-CEILING EXPANSION"): the
// FIRST two Quick-tier ops promoted from agent-executed procedure
// (method.md §1, which has always been hand-run, never coded) into
// deterministic CODE. Both are LAB-GRADUATED at birth — named, real defects
// the wear campaign found, not speculative ceiling-chasing — and BOTH have
// since been RETIRED as text-mutators, safety-over-yield (see (1)/(2)):
//   (1) sweepResidue    — RETIRED as a text-mutator (IC-PIN wave-6, a blind
//       re-IC over wave-5). r1 #11's residue insight ("## Commits" left
//       behind after its content was cut) was right that the EMPTIED BODY is
//       our own knife's residue, but wrong that the HEADING LINE is too -- a
//       title is always content (often a full instruction, e.g. "## Do not
//       delete the audit log without sign-off"), exactly like queue 0b's own
//       already-shipped rule for a PRE-EXISTING empty heading ("placeholder =
//       intent = meaning"). Wave-6 makes the two cases CONSISTENT: neither a
//       pre-existing-empty heading NOR one emptied by this run is ever
//       auto-cut. Kept as a pipeline-shaped (origText, newText) no-op --
//       unchanged signature, so an existing call site needs no reshaping --
//       because flagEmptyHeadings already flags every empty-bodied heading it
//       finds in a single snapshot, catching the just-emptied case for free
//       once this function stops removing it.
//   (2) stripEmptyTables — RETIRED as a text-mutator (USER decision
//       2026-07-24, safety-over-yield). Born from r1 #11 ("nothing survives
//       because nothing exists"), its provable-residue/identity mechanism
//       went through SIX consecutive blind-IC waves -- content-header (the
//       origText provenance check) -> key-collision (a lossy joined-cells
//       key colliding two different headers) -> verbatim-key (anchoring to
//       the header's exact line bytes instead) -> uniqueness (a same-document
//       newText uniqueness gate) -> lazy-continuation-consumption -- each fix
//       closing ONE mechanism only for a new one to appear. No auto-cut = no
//       false-cut = the whole residue-distinction class becomes unreachable,
//       the same call (1)'s retirement made. Kept as a pipeline-shaped
//       (origText, newText) no-op -- unchanged signature, origText now
//       unused, so an existing call site needs no reshaping -- because
//       flagEmptyTables already flags every header+separator+zero-body-row
//       table it finds in a single snapshot, source-authored or emptied this
//       run alike, catching every case for free once this function stops
//       removing any of them; a human/semantic tier (the wizard) adjudicates
//       what it surfaces.
//   (3) flagEmptyHeadings — the GENERAL case (no orig-vs-new residue scope):
//       a bare empty heading found in a SINGLE snapshot is FLAGGED only,
//       never auto-cut (queue item 0b's named non-graduate; since wave-6 this
//       is the only place a just-emptied heading's title gets surfaced).
//   (4) flagEmptyTables  — the table's counterpart to (3), added wave-6: a
//       header+separator+ZERO-body-row table found in a SINGLE snapshot is
//       FLAGGED only, never auto-cut.
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

// Minimal GFM table recognition (LOGIC ported from CoalLedger md-ast.mjs
// splitRow/parseDelimiterRow — CW is zero-dep, so port the logic, never import
// cross-repo). The old loose TABLE_ROW_RE/TABLE_SEP_RE matched ANY pipe-bearing
// line + ANY bare `---`, so a setext heading "X | Y" over a `---` underline (or
// prose "A | B" over a thematic break) was destroyed as a phantom empty table.
// Split a table row into cells, honoring backslash-escaped pipes; a leading/
// trailing pipe delimits, it does not add a cell. Returns { cells, hadPipe }.
function splitCells(line) {
  const cells = [];
  let cur = '';
  let hadPipe = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length) { cur += c + line[i + 1]; i++; continue; }
    if (c === '|') { hadPipe = true; cells.push(cur); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur);
  const t = line.trim();
  if (cells.length && cells[0].trim() === '' && t.startsWith('|')) cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === '' && t.endsWith('|') && !t.endsWith('\\|')) cells.pop();
  return { cells: cells.map((c) => c.trim()), hadPipe };
}
const DELIM_CELL_RE = /^:?-+:?$/;
// A REAL GFM delimiter row: it HAS pipes (the task's rule; matches CoalLedger's
// `if (!hadPipe) return null`) and EVERY cell is `:?-+:?`. Returns the column
// count, or 0 when the line is not a delimiter row — so a bare `---` (no pipe)
// under a pipe-bearing line is a thematic break / setext underline, never a
// separator.
function delimiterCellCount(line) {
  const { cells, hadPipe } = splitCells(line);
  if (!hadPipe || !cells.length) return 0;
  return cells.every((c) => DELIM_CELL_RE.test(c)) ? cells.length : 0;
}

// CommonMark indented-code threshold (§4.4): a line starting with >=4 spaces
// or a tab is literal code, never GFM table syntax. A header/delimiter shape
// living there is not PROVABLY an empty table -> the broom's own "cut only
// provable garbage" rule says leave it. A 2-space-indented pipe shape is
// still real (loose-list-adjacent) prose and stays cuttable -- only the
// >=4-space/tab code threshold is skipped.
const INDENTED_CODE_RE = /^(?: {4,}|\t)/;

// IC-PIN wave-5 FIX 2: a table's delimiter row must sit at the SAME leading
// indentation as its header. INDENTED_CODE_RE on the header alone is not
// enough -- a header at column 0 paired with a >=4-space/tab-indented
// delimiter (or any indent MISMATCH between the two, even under the code
// threshold) is not a provable GFM table pair.
const LEADING_WS_RE = /^[ \t]*/;
const leadingWs = (line) => LEADING_WS_RE.exec(line)[0];

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

// (1) sweepResidue: RETIRED as a text-mutator (IC-PIN wave-6). A heading
// TITLE is always content -- deleting it (as this function used to do for a
// heading matched between origText/newText that had a body in orig and none
// in new) can destroy a load-bearing instruction whose "body" just happens
// to be empty right now. This makes the just-emptied case consistent with
// the pre-existing-empty-heading case (queue 0b: "placeholder = intent =
// meaning") -- both are preserved, never auto-cut. Kept as a named
// (origText, newText) pass-through -- unchanged signature, so an existing
// call site needs no reshaping -- because flagEmptyHeadings (below) already
// flags every empty-bodied heading it finds in a single snapshot, catching
// the just-emptied case for free once this function stops removing it.
export function sweepResidue(origText, newText) {
  return String(newText);
}

// Shared GFM table-candidate walk: scans `lines` and, for each STRUCTURALLY
// VALID header+delimiter pair, calls onTable(headerLineIdx, headerCells,
// bodyRowCount) then skips past the whole consumed block (header +
// delimiter + every contiguous non-blank line after it, GFM's lazy body-row
// rule) so a real data row is never re-offered as a fresh candidate header
// (adjacent dash-shaped rows are lazy continuation body rows of the SAME
// table, not a second table). Used by flagEmptyTables below -- the sole
// remaining caller since stripEmptyTables's own cut mechanism (and its
// scanTables provenance helper) was retired 2026-07-24 -- one definition of
// "what is a table".
function forEachTableCandidate(lines, onTable) {
  let i = 0;
  while (i < lines.length - 1) {
    const header = lines[i];
    if (!header.includes('|')) { i++; continue; } // no pipe -> a setext/thematic/prose line, never a table header
    if (INDENTED_CODE_RE.test(header)) { i++; continue; } // >=4-space/tab indent -> CommonMark literal code, not provably a table
    const delimLine = lines[i + 1];
    // IC-PIN wave-5 FIX 2: the delimiter must share the header's own
    // (non-code) indent -- a >=4-space/tab-indented delimiter, or one whose
    // indent differs from the header's, is not a provable GFM table pair
    // even when the header alone looks table-shaped.
    if (INDENTED_CODE_RE.test(delimLine) || leadingWs(delimLine) !== leadingWs(header)) { i++; continue; }
    const sepCount = delimiterCellCount(delimLine);
    if (!sepCount) { i++; continue; } // line i+1 is not a real GFM delimiter row
    if (delimiterCellCount(header)) { i++; continue; } // the header must not itself be a delimiter (two separators in a row)
    const { cells: headerCells } = splitCells(header);
    if (headerCells.length !== sepCount) { i++; continue; } // COLUMN-COUNT MISMATCH -> a `---` under pipe-prose, not a table
    let j = i + 2;
    while (j < lines.length && lines[j].trim() !== '') j++;
    onTable(i, headerCells, j - (i + 2));
    i = j; // skip past the whole consumed block, empty or not
  }
}

// (2) stripEmptyTables: RETIRED as a text-mutator (USER decision 2026-07-24,
// safety-over-yield). Its provable-residue/identity mechanism went through
// SIX consecutive blind-IC waves -- content-header -> key-collision ->
// verbatim-key -> uniqueness -> lazy-continuation-consumption -- each fix
// closing ONE mechanism only for a new one to appear (see the top-of-file
// note (2) for the full chain). No auto-cut = no false-cut = the whole
// residue-distinction class becomes unreachable, the same call (1)'s
// retirement made. Kept as a named (origText, newText) pass-through --
// unchanged signature, origText now unused, so an existing call site needs
// no reshaping -- because flagEmptyTables (below) already flags every
// header+separator+zero-body-row table it finds in a single snapshot,
// source-authored or emptied this run alike, catching every case for free
// once this function stops removing any of them.
export function stripEmptyTables(origText, newText) {
  return String(newText);
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

// (4) flagEmptyTables: the table's counterpart to flagEmptyHeadings -- the
// GENERAL case, no orig-vs-new scope. A header+separator table with ZERO
// body rows found in ONE snapshot is FLAGGED only, never auto-cut (a
// header-only table might be deliberate callout/schema content, the same
// "intent = meaning" reasoning as a placeholder heading). Since
// stripEmptyTables's cut mechanism was retired (2026-07-24), this is the
// ONLY surface an empty table -- source-authored or emptied this run alike
// -- is ever reported through. Returns [{line, header}].
export function flagEmptyTables(text) {
  const lines = String(text).split(/\r?\n/);
  const out = [];
  forEachTableCandidate(lines, (line, headerCells, bodyRows) => {
    if (bodyRows === 0) out.push({ line, header: headerCells.join(' | ') });
  });
  return out;
}
