// fidelity-gate.mjs — THE load-bearing module: the mechanical, deterministic
// floor of the zero-fact-loss guarantee (blueprint §14.8, proven live: this
// exact diff caught 2 silent link-drops + 1 self-inventory undercount).
//
// Contract: diff orig-vs-new inventories of STRUCTURED tokens — [[wikilinks]]
// (keyed by TARGET, so a display-text edit is not a drop), dates (canonicalized
// to YYYY-MM-DD, so an ISO<->DD-Mon-YYYY reformat of the same day is not a drop),
// version strings, link DESTINATIONS ([text](url) / <autolink> / bare URL),
// frontmatter keys, backtick `code spans` (keyed verbatim), fenced code-block
// content lines (whitespace-collapsed — the inline codespan RE is single-line,
// blind to what sits inside a ```fence```), double-quoted
// "spans"/"spans" (curly or straight, keyed by the quoted text — a style
// restyle is not a drop), and number-shaped tokens (ratios, percents, ~Nk /
// N.N forms, comma-grouped counts like 44,192 keyed comma-less, and bare
// integers of 2+ digits — a lone digit is excluded as prose noise;
// dates/versions/links are masked out first so their digits stay the more
// precise category's job, not double-counted here). ANY drop = FAIL
// with the exact list. Set semantics (distinct values): deduplicating a
// REPEATED mention of one value is legitimate compaction; losing a VALUE
// entirely is a drop.
//
// Class 9 — number-precision (beta.12, twice-justified: M29 "exact 44,192
// survives only as rounded 44k" + M12 "exact 64.6%" -> ~65%): a dropped exact
// numeric token (>= 2 significant digits) whose quantity SURVIVES only as a
// strictly-coarser rounded/approximated form is reported as
// 'number-precision' (with the surviving form named) instead of a bare
// 'number-drop' — false precision-laundering gets its own named, approvable
// class.
//
// Class 10 — evidence-anchor (beta.12, M27 EVIDENCE-ORPHANING: an authorized
// compression kept the claim "delivery 100% twice" but cut its transcript id
// c19e528b = a verdict without its receipt): an evidence token (issue ref,
// hex id, filename) sitting NEAR a proof-marker ("proven"/"verified"/
// "measured"/"confirmed"/"100%") in the original must not vanish while its
// marker still stands in the new text — a proven claim keeps >= 1 evidence
// anchor or the drop is named ('evidence-anchor-drop').
//
// Plus encoding-corruption tripwires on the NEW text (blueprint §14.3): a
// rewrite must never INTRODUCE a decomposed Thai sara-am (U+0E4D+U+0E32 for
// U+0E33 — renders identical, breaks search/sort/wrap), a BOM, or zero-width
// spaces. Pre-existing occurrences in the original are warnings, not failures
// (the gate blocks NEW corruption; it does not punish inherited state).
//
// For a MERGE (N sources -> 1 target) pass orig = the sources concatenated:
// the union inventory must survive into the merged text.
//
// Semantic prose fidelity (is this lesson load-bearing?) is the PAID layer
// (outsider/insider/human) — deliberately NOT this module's job.

const WIKILINK_RE = /\[\[([^[\]]+)\]\]/g;
const ISO_DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g;
// The series' DD-Mon-YYYY house style ("15-Jun-2026") — used heavily in memory files.
const DMY_DATE_RE = /\b\d{1,2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{4}\b/g;
// GREEDY whole dotted-numeric run (3+ parts): `1.2.3.4` extracts as one whole
// token, never the fragment `1.2.3` — else the SET-based inventory collapses a
// standalone `1.2.3` with `1.2.3.4`, and a genuine DROP of `1.2.3` while
// `1.2.3.4` survives goes UNDETECTED (silent version loss through the gate).
const VERSION_RE = /\bv?\d+\.\d+(?:\.\d+)+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?\b/g;
// A `v`-PREFIXED short version (v1.2) slips VERSION_RE (not 3-part) and its
// leading `v` kills the \b the number scan needs ("1.2" in "v1.2" is never a
// bare decimal); REQUIRING the `v` keeps genuine bare decimals (0.92) in the
// number class. Trailing `(?:\.\d+)*` is GREEDY for the SAME whole-run reason:
// `v1.2.3.4` extracts whole, never the fragment `v1.2.3` that would re-add the
// dropped token to the new inventory and defeat VERSION_RE's collapse fix.
const V_SHORT_VERSION_RE = /\bv\d+\.\d+(?:\.\d+)*(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?\b/g;
// Link DESTINATIONS are the most common fact-carrier in prose docs — a dropped
// [text](url), <autolink>, or bare URL is a lost fact the wikilink RE never saw.
const MDLINK_DEST_RE = /\]\(\s*<?([^\s)>]+)/g; // the URL after ](  (strips an optional < and any title)
const AUTOLINK_RE = /<((?:https?|ftp|mailto):[^>\s]+)>/g;
const BAREURL_RE = /(?:https?|ftp):\/\/[^\s<>()[\]]+/g;
const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
// Canonicalize a date to YYYY-MM-DD so a reformat between the two endorsed house
// formats (ISO <-> DD-Mon-YYYY) of the SAME day is NOT counted as a drop.
function canonDate(d) {
  const m = /^(\d{1,2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{4})$/.exec(d);
  return m ? `${m[3]}-${MONTHS[m[2]]}-${m[1].padStart(2, '0')}` : d;
}
// Built from char codes, never raw literals in source — a decomposed sara-am or a
// zero-width space is invisible/normalization-fragile under future edits (the
// edit-tool control-escape hazard).
const SARA_AM_DECOMPOSED = String.fromCharCode(0x0e4d, 0x0e32); // NIKHAHIT + SARA AA (the broken split of U+0E33)
const ZWSP = String.fromCharCode(0x200b); // zero-width space
// Trojan-Source bidi overrides + zero-width joiner (CVE-2021-42574 class): an
// INVISIBLE char a rewrite introduces can reorder/hide the DISPLAYED text so a
// memory file reads one way but MEANS another. Built from char codes (never raw
// literals — the invisible-char-in-source hazard); the encoding-theme sibling of
// the sara-am/BOM/ZWSP tripwires (shared with CoalLedger/CoalMine).
const BIDI_ZW_CTRL = [
  [0x202a, 'LRE'], [0x202b, 'RLE'], [0x202c, 'PDF'], [0x202d, 'LRO'], [0x202e, 'RLO'],
  [0x2066, 'LRI'], [0x2067, 'RLI'], [0x2068, 'FSI'], [0x2069, 'PDI'], [0x200d, 'ZWJ'],
].map(([cp, name]) => [String.fromCharCode(cp), name, `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`]);

// Backtick inline-code spans (`...`) — a dropped identifier/command/flag is a
// dropped fact the prose regexes above never see (a Full/semantic merge this
// session silently dropped `checkSharedReferences` from a compaction — this is
// the mechanical floor closing that hole). Single-line: markdown inline code
// never spans a paragraph break, matching every other regex in this module.
const CODESPAN_RE = /`([^`\n]+)`/g;

// Fenced code blocks (```/~~~, GFM). CODESPAN_RE is single-line by design, so it
// NEVER sees content INSIDE a fence — a rewrite that drops or alters a
// command/flag/path in a ```fenced``` example passed the gate blind while the
// INLINE form of the SAME token FAILED. Inventory each fence's CONTENT lines as
// tokens (whitespace-collapsed, so a reindent is not a drop; set semantics, so a
// reorder/dedup is not a drop) — a dropped/changed fence line then fails the
// gate exactly as an inline codespan drop does.
const FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
// TODO(ic): this tracks ```/~~~ fences only — a CommonMark >=4-space/tab
// INDENTED code block is invisible to it, so this gate still can't ACCOUNT
// for a drop inside one. Not fixed here: a correct detector needs paragraph-
// interruption + list/blockquote-indent context this line-local fence state
// machine doesn't track — a wrong heuristic risks mis-classifying real
// nested-list prose as "protected code" and masking a genuine drop, which is
// worse than the current honest gap. (The broom's empty-table cut was retired
// to flag-only 2026-07-24, so there is NO broom-side mitigation to lean on —
// a standalone gate gap, not an asymmetry with a broom counterpart.)
export function fencedLines(text) {
  const out = new Set();
  let fence = null; // { char, len } while inside a fence
  for (const line of String(text).split(/\r?\n/)) {
    const m = FENCE_LINE_RE.exec(line);
    if (fence) {
      // a closing fence: same fence char, run length >= the opener's, nothing
      // but whitespace after the run.
      if (m && m[1][0] === fence.char && m[1].length >= fence.len && m[2].trim() === '') { fence = null; continue; }
      const collapsed = line.trim().replace(/\s+/g, ' ');
      if (collapsed) out.add(collapsed);
    } else if (m) {
      // an opener: a backtick fence's info string may not contain a backtick
      // (CommonMark) — otherwise it is inline code on one line, not a fence.
      if (m[1][0] === '`' && m[2].includes('`')) continue;
      fence = { char: m[1][0], len: m[1].length };
    }
  }
  return out;
}

// Double-quoted spans — curly "..." (the series' house style) and straight
// "..." — a verbatim QUOTE (a user's exact words) dropped during a
// "compaction" is exactly the loss the semantic layer alone already missed
// live once (blueprint-cited incident). Keyed on the quoted TEXT itself so a
// straight<->curly restyle of the SAME words is not a drop (same precedent as
// the date canonicalization above).
const LDQUO = String.fromCharCode(0x201c); // left double quotation mark
const RDQUO = String.fromCharCode(0x201d); // right double quotation mark
const CURLY_QUOTE_RE = new RegExp(`${LDQUO}([^${RDQUO}\\n]+)${RDQUO}`, 'g');
const STRAIGHT_QUOTE_RE = /"([^"\n]+)"/g;

// Numeric tokens likely to be a FACT (a count, a score, a ratio) rather than
// incidental prose filler. A bare single digit is noise (list markers, "a
// 3-sub lane") and is excluded from the plain-integer form; a ratio or percent
// stays eligible at any digit count because the surrounding syntax (/ or %)
// already disambiguates intent. Order matters (first alternative to match at
// a position wins): the k-shorthand and percent forms are tried before the
// bare decimal/integer forms so "43%"/"~150k" register as themselves rather
// than fragmenting into a bare number.
// H2 — SIGN CAPTURE: an optional leading polarity is captured INTO the token so
// "-43%" and "43%" (or "-44,192" and "44,192") are DISTINCT tokens and a
// sign-inverted rewrite is a genuine drop, not a silent pass. The lookbehind
// keeps it a GENUINE sign: a '-'/'+' counts only when NOT preceded by a word
// char, a digit, or '.', so an inter-word/inter-digit hyphen ("3-sub", a
// "15-20" range) stays a separator — bare-number matching is byte-identical to
// before (a negative token is 'unknown' to parseNumToken, so it falls to the
// plain number-drop path, the safe over-flag direction; negative
// precision-laundering is not sub-classified — a rare case, still a hard drop).
const SIGN = '(?:(?<![\\w.])[-+])?';
const MAGNITUDE_RE = new RegExp(`${SIGN}\\b\\d+(?:\\.\\d+)?[kK]\\b`, 'g'); // "150k", "-1.5k" — a leading ~ (if any) is prose, not part of the tracked value
const PERCENT_RE = new RegExp(`${SIGN}\\b\\d+(?:\\.\\d+)?%`, 'g'); // "5%", "-43.5%" — single digits OK, % disambiguates
const RATIO_RE = new RegExp(`${SIGN}\\b\\d+/\\d+\\b`, 'g'); // "4/5", "22/12" — single digits OK, / disambiguates
const DECIMAL_RE = new RegExp(`${SIGN}\\b\\d+\\.\\d+\\b`, 'g'); // "3.8", "-0.92" — the decimal point disambiguates
const INTEGER_RE = new RegExp(`${SIGN}\\b\\d{2,}\\b`, 'g'); // bare integers: 2+ digits only (the noisy single-digit case excluded)
// Comma-grouped counts ("44,192", "1,234.5", optionally "%"-suffixed) — the
// house style for large exact numbers. Without this form the generic scan
// FRAGMENTS "44,192" into 44 + 192, so a rounded rewrite ("44k") slips the
// diff whenever the fragments coincidentally survive elsewhere (the M29 live
// loss shape). Tried FIRST so the grouped token is claimed whole; keyed
// COMMA-LESS ("44192") so a 44,192 <-> 44192 regroup of the SAME value is not
// a drop (same precedent as the date canonicalization above).
const COMMA_NUM_RE = new RegExp(`${SIGN}\\b\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?\\b%?`, 'g'); // "-44,192" keeps its sign (stripped comma-less to "-44192")

function matchSet(text, re, group = 0) {
  const out = new Set();
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) out.add(m[group]);
  return out;
}

// Blank out every match of `re` (same-length spaces, so nothing merges across
// the gap) — used to remove already-precisely-tracked spans (dates/versions/
// links) from the text BEFORE the generic number scan, so their digits are not
// re-flagged redundantly under number-drop, and so an ENDORSED reformat (the
// ISO<->DD-Mon-YYYY date swap) never registers as a numeric drop.
function maskOut(text, res) {
  let out = text;
  for (const re of res) {
    re.lastIndex = 0;
    out = out.replace(re, (m) => ' '.repeat(m.length));
  }
  return out;
}

// Numeric-token inventory, scanned on text with dates/versions/links already
// masked out (see maskOut above). The 5 forms are tried MOST-specific first,
// each claimed span masked before the next (less-specific) pattern runs — so
// "43%" registers as itself, not ALSO as a redundant bare "43"; "0.92" is not
// ALSO a redundant bare "92". Order: magnitude (~Nk) > percent > ratio >
// decimal > bare integer (2+ digits only — a lone digit is prose noise).
function numberTokens(text) {
  let working = maskOut(text, [ISO_DATE_RE, DMY_DATE_RE, VERSION_RE, V_SHORT_VERSION_RE, MDLINK_DEST_RE, AUTOLINK_RE, BAREURL_RE]);
  const out = new Set();
  // Comma-grouped first (most specific), keyed comma-less — see COMMA_NUM_RE.
  for (const v of matchSet(working, COMMA_NUM_RE, 0)) out.add(v.replace(/,/g, ''));
  working = maskOut(working, [COMMA_NUM_RE]);
  for (const re of [MAGNITUDE_RE, PERCENT_RE, RATIO_RE, DECIMAL_RE, INTEGER_RE]) {
    for (const v of matchSet(working, re, 0)) out.add(v);
    working = maskOut(working, [re]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// class 9 — number-precision (exact -> rounded survivor detection)
// ---------------------------------------------------------------------------

// Parse one inventoried numeric token: { kind, value, ulp, sig }.
//   kind  'percent' | 'plain' | 'ratio' (a ratio has no rounding notion and
//         never participates in the precision check).
//   value the quantity the token states ("44k" -> 44000, "64.6%" -> 64.6).
//   ulp   the unit-in-last-place its own REPRESENTATION claims: "44k" speaks
//         in thousands -> 1000 · "1.5k" -> 100 · "64.6%" -> 0.1 · a bare
//         integer's trailing zeros coarsen it ("44000" -> 1000, "44192" -> 1).
//   sig   significant digits, leading zeros excluded ("0.92" -> 2).
function parseNumToken(tok) {
  const percent = tok.endsWith('%');
  const body = percent ? tok.slice(0, -1) : tok;
  if (/^\d+\/\d+$/.test(body)) return { kind: 'ratio' };
  let value, ulp;
  const k = /^(\d+(?:\.\d+)?)[kK]$/.exec(body);
  if (k) {
    const decs = (k[1].split('.')[1] || '').length;
    value = Number(k[1]) * 1000;
    ulp = 1000 / 10 ** decs;
  } else if (/^\d+(?:\.\d+)?$/.test(body)) {
    const decs = (body.split('.')[1] || '').length;
    value = Number(body);
    ulp = decs > 0 ? 1 / 10 ** decs : 10 ** /0*$/.exec(body)[0].length;
  } else {
    return { kind: 'unknown' };
  }
  const sig = body.replace(/[.kK]/g, '').replace(/^0+/, '').length; // digits only — the k suffix is scale, not a significant digit ("5k" = 1 sig digit)
  return { kind: percent ? 'percent' : 'plain', value, ulp, sig };
}

// A dropped exact token "survives only as a rounded form" when a surviving
// token of the SAME kind (percent<->percent, plain<->plain incl. the k-form)
// states the same quantity at STRICTLY coarser precision and agrees with it
// to within its own unit-in-last-place: |orig - cand| < cand.ulp covers
// round, floor, and ceil writers alike while staying too tight to match an
// unrelated number ("43k" never claims 44,192). >= 2 significant digits on
// the ORIG side per the class definition (a 1-digit token has no precision
// to launder). Returns the surviving form, or null.
function roundedSurvivor(origTok, nextTokens) {
  const o = parseNumToken(origTok);
  if ((o.kind !== 'percent' && o.kind !== 'plain') || o.sig < 2) return null;
  for (const cand of nextTokens) {
    const c = parseNumToken(cand);
    if (c.kind !== o.kind) continue;
    if (!(c.ulp > o.ulp)) continue; // must be strictly coarser
    if (Math.abs(o.value - c.value) < c.ulp) return cand;
  }
  return null;
}

// ---------------------------------------------------------------------------
// class 10 — evidence anchors (proof-marker citations)
// ---------------------------------------------------------------------------

// Proof markers per the class definition: the four words + a literal "100%".
const CLAIM_MARKER_RE = /\b(?:proven|verified|measured|confirmed)\b|\b100%/gi;
// Evidence shapes (conservative allowlist — precision over recall, the broom
// asymmetry): issue refs (#2014) · lowercase hex ids of 7-40 chars (7 = the
// git short-hash floor, 40 = a full SHA-1; must mix letters AND digits so a
// plain number or an English word can never match — transcript ids like
// c19e528b qualify) · filenames carrying a known extension.
const ISSUE_REF_RE = /#\d+\b/g;
const HEX_ID_RE = /\b[0-9a-f]{7,40}\b/g;
const FILE_REF_RE = /\b[\w][\w.-]*\.(?:md|mjs|cjs|js|json|jsonc|ps1|txt|yml|yaml|log|py|ts|sh)\b/g;
// "Near" = within this many chars of the marker, clamped to the marker's own
// line on both sides (evidence on another line belongs to another claim).
// Birth certificate: the M27 incident's citation sat ~40 chars from its claim;
// 200 spans a long parenthetical citation while staying inside one clause of
// the house's single-line bullet style.
const EVIDENCE_WINDOW_CHARS = 200;

const isHexEvidence = (tok) => /[a-f]/.test(tok) && /\d/.test(tok);

// Evidence tokens sitting near a proof-marker: Map token -> the marker string
// it anchors (first marker seen wins; set semantics downstream).
export function evidenceAnchors(text) {
  const s = String(text);
  const out = new Map();
  CLAIM_MARKER_RE.lastIndex = 0;
  let m;
  while ((m = CLAIM_MARKER_RE.exec(s)) !== null) {
    const lineStart = s.lastIndexOf('\n', m.index) + 1;
    let lineEnd = s.indexOf('\n', m.index);
    if (lineEnd === -1) lineEnd = s.length;
    const from = Math.max(lineStart, m.index - EVIDENCE_WINDOW_CHARS);
    const to = Math.min(lineEnd, m.index + m[0].length + EVIDENCE_WINDOW_CHARS);
    const win = s.slice(from, to);
    const toks = [
      ...matchSet(win, ISSUE_REF_RE),
      ...[...matchSet(win, HEX_ID_RE)].filter(isHexEvidence),
      ...matchSet(win, FILE_REF_RE),
    ];
    for (const t of toks) if (!out.has(t)) out.set(t, m[0]);
  }
  return out;
}

// Top-level frontmatter keys from a leading `---` YAML block (key names only —
// a dropped key is a dropped fact-slot; value edits are the semantic layer's call).
// Key shape: everything from column 0 up to the SEPARATOR colon — not just
// `[A-Za-z0-9_-]` (that narrowing silently dropped any other key shape, e.g.
// a dotted `coalwash.updateMode`, `$ref`, a `/`-path key, a unicode key: the
// key never matched, so DROPPING it passed the gate clean, a silent miss of
// the contract this function promises). The SEPARATOR is the colon YAML 1.2
// treats as ending a plain-scalar key — one followed by whitespace or EOL
// (`(?=\s|$)`) — NOT merely the first `:` in the line: a plain-scalar key may
// itself embed a colon not followed by a space (`a:b: value` -> key `a:b`);
// matching only the first `:` collapsed `a:b`/`a:c`/bare `a` all down to
// `"a"`, so dropping `a:b` while `a` survived passed the gate clean (a second
// silent miss, closed by widening the capture past an embedded colon to the
// real separator). Column-0 anchor keeps it TOP-LEVEL ONLY (an indented
// `  nested: x` line has no non-space char at position 0, so it stays
// excluded — by design). `#`/`-` are excluded as a first char so a YAML
// comment or a `- list:` sequence item inside the block is never mistaken
// for a key.
export function frontmatterKeys(text) {
  const s = String(text);
  if (!/^---\r?\n/.test(s)) return new Set();
  const end = /\r?\n---[ \t]*(?:\r?\n|$)/.exec(s.slice(3));
  if (!end) return new Set();
  const block = s.slice(3, 3 + end.index);
  const keys = new Set();
  for (const line of block.split(/\r?\n/)) {
    const m = /^([^\s:#-][^\n]*?)\s*:(?=\s|$)/.exec(line);
    if (m) keys.add(m[1]);
  }
  return keys;
}

// Extract the full structured-token inventory of a text.
export function inventory(text) {
  const s = String(text);
  // Wikilinks key on the TARGET only ([[Target|Display]] -> Target): editing the
  // display text is not a fact drop, so it must not fail the gate.
  const wikilinks = new Set();
  for (const v of matchSet(s, WIKILINK_RE, 1)) wikilinks.add(v.split('|')[0].trim());
  const dates = new Set([...matchSet(s, ISO_DATE_RE), ...matchSet(s, DMY_DATE_RE)].map(canonDate));
  const links = new Set([
    ...matchSet(s, MDLINK_DEST_RE, 1),
    ...matchSet(s, AUTOLINK_RE, 1),
    ...matchSet(s, BAREURL_RE, 0),
  ]);
  const quotes = new Set([...matchSet(s, CURLY_QUOTE_RE, 1), ...matchSet(s, STRAIGHT_QUOTE_RE, 1)]);
  return {
    wikilinks,
    dates,
    versions: new Set([...matchSet(s, VERSION_RE), ...matchSet(s, V_SHORT_VERSION_RE)]),
    links,
    frontmatter: frontmatterKeys(s),
    codespans: matchSet(s, CODESPAN_RE, 1),
    quotes,
    numbers: numberTokens(s),
    fencedLines: fencedLines(s),
  };
}

// The structured-token "drop keys" of a text — the `${type}:${value}` set the
// gate WOULD emit if this whole text vanished. Used by apply.mjs's delete/merge
// gate (H3: a delete drops the removed file's tokens too) and by RE-TIER to
// pre-approve a demoted topic's tokens (it archives them externally, so the
// drop is honest and its archive+probe owns recovery). Numbers key as plain
// 'number-drop' (a vanished file has no rounded survivor).
export function inventoryDropKeys(text) {
  const inv = inventory(text);
  const keys = new Set();
  const add = (set, type) => { for (const v of set) keys.add(`${type}:${v}`); };
  add(inv.wikilinks, 'wikilink-drop');
  add(inv.dates, 'date-drop');
  add(inv.versions, 'version-drop');
  add(inv.links, 'link-drop');
  add(inv.frontmatter, 'frontmatter-key-drop');
  add(inv.codespans, 'codespan-drop');
  add(inv.quotes, 'quote-drop');
  add(inv.numbers, 'number-drop');
  add(inv.fencedLines, 'fenced-line-drop');
  return keys;
}

function diffDrops(origSet, newSet, type) {
  const drops = [];
  for (const v of origSet) if (!newSet.has(v)) drops.push({ type, value: v });
  return drops;
}

// The gate. Returns { pass, drops: [{type, value}], warnings: [string], counts }.
// pass === true  <=>  zero structured-token drops AND zero introduced corruption.
export function checkFidelity(origText, newText) {
  const orig = String(origText);
  const next = String(newText);
  const oi = inventory(orig);
  const ni = inventory(next);

  const drops = [
    ...diffDrops(oi.wikilinks, ni.wikilinks, 'wikilink-drop'),
    ...diffDrops(oi.dates, ni.dates, 'date-drop'),
    ...diffDrops(oi.versions, ni.versions, 'version-drop'),
    ...diffDrops(oi.links, ni.links, 'link-drop'),
    ...diffDrops(oi.frontmatter, ni.frontmatter, 'frontmatter-key-drop'),
    ...diffDrops(oi.codespans, ni.codespans, 'codespan-drop'),
    ...diffDrops(oi.quotes, ni.quotes, 'quote-drop'),
    ...diffDrops(oi.fencedLines, ni.fencedLines, 'fenced-line-drop'),
  ];
  // Numbers: a dropped value with a strictly-coarser rounded survivor is the
  // class-9 'number-precision' shape (survivor named, approval key stays the
  // orig token: "number-precision:<value>"); a vanished value stays the plain
  // class-8 'number-drop'. One entry per dropped value, never both.
  for (const v of oi.numbers) {
    if (ni.numbers.has(v)) continue;
    const survivor = roundedSurvivor(v, ni.numbers);
    drops.push(survivor ? { type: 'number-precision', value: v, survivor } : { type: 'number-drop', value: v });
  }
  // Class 10 — evidence anchors: an orig evidence token near a proof-marker
  // must not vanish (set semantics: moved elsewhere = kept) while its marker
  // still stands in the new text. Marker gone too = a whole-claim cut, which
  // the plan carries as content adjudication, not an orphaning. ACCEPTED
  // FAIL-SAFE BIAS: markerAlive is a GLOBAL check — cutting a whole claim
  // whose marker WORD recurs in some OTHER surviving claim still flags
  // (over-flag, approvable by name), because pairing a marker occurrence to
  // "its" claim across a rewrite is not mechanically decidable; under-flagging
  // an orphaned proof would be the unsafe direction (broom asymmetry).
  const evOrig = evidenceAnchors(orig);
  for (const [tok, marker] of evOrig) {
    if (next.includes(tok)) continue;
    const markerAlive = /^100%$/i.test(marker)
      ? next.includes('100%')
      : new RegExp(`\\b${marker}\\b`, 'i').test(next);
    if (markerAlive) drops.push({ type: 'evidence-anchor-drop', value: tok, marker });
  }
  const warnings = [];

  // Encoding tripwires: fail on INTRODUCED corruption, warn on inherited.
  const origDecomposed = orig.includes(SARA_AM_DECOMPOSED);
  const nextDecomposed = next.includes(SARA_AM_DECOMPOSED);
  if (nextDecomposed && !origDecomposed) drops.push({ type: 'thai-sara-am-decomposed', value: 'U+0E4D+U+0E32 introduced (must stay U+0E33)' });
  else if (nextDecomposed && origDecomposed) warnings.push('decomposed Thai sara-am present in BOTH versions (pre-existing — consider NFC-normalizing separately)');

  if (next.charCodeAt(0) === 0xfeff && orig.charCodeAt(0) !== 0xfeff) drops.push({ type: 'bom-introduced', value: 'U+FEFF at file start' });
  if (next.includes(ZWSP) && !orig.includes(ZWSP)) drops.push({ type: 'zwsp-introduced', value: 'U+200B zero-width space' });
  // Trojan-Source bidi overrides + ZWJ (introduced only — blocks NEW corruption,
  // never punishes inherited state, matching the sara-am tripwire above).
  for (const [ch, name, u] of BIDI_ZW_CTRL) {
    if (next.includes(ch) && !orig.includes(ch)) drops.push({ type: 'bidi-control-introduced', value: `${u} ${name} (Trojan-Source bidi/zero-width) introduced` });
  }
  // Position-0 BOM is the file-start check above; a MID-STRING U+FEFF (zero-width
  // no-break space) is an invisible smuggle that check misses.
  const midBom = String.fromCharCode(0xfeff);
  if (next.slice(1).includes(midBom) && !orig.slice(1).includes(midBom)) drops.push({ type: 'bom-introduced', value: 'U+FEFF mid-string (zero-width no-break space)' });

  return {
    pass: drops.length === 0,
    drops,
    warnings,
    counts: {
      wikilinks: { orig: oi.wikilinks.size, kept: oi.wikilinks.size - drops.filter((d) => d.type === 'wikilink-drop').length },
      dates: { orig: oi.dates.size, kept: oi.dates.size - drops.filter((d) => d.type === 'date-drop').length },
      versions: { orig: oi.versions.size, kept: oi.versions.size - drops.filter((d) => d.type === 'version-drop').length },
      links: { orig: oi.links.size, kept: oi.links.size - drops.filter((d) => d.type === 'link-drop').length },
      frontmatter: { orig: oi.frontmatter.size, kept: oi.frontmatter.size - drops.filter((d) => d.type === 'frontmatter-key-drop').length },
      codespans: { orig: oi.codespans.size, kept: oi.codespans.size - drops.filter((d) => d.type === 'codespan-drop').length },
      quotes: { orig: oi.quotes.size, kept: oi.quotes.size - drops.filter((d) => d.type === 'quote-drop').length },
      numbers: { orig: oi.numbers.size, kept: oi.numbers.size - drops.filter((d) => d.type === 'number-drop' || d.type === 'number-precision').length },
      fencedLines: { orig: oi.fencedLines.size, kept: oi.fencedLines.size - drops.filter((d) => d.type === 'fenced-line-drop').length },
      evidenceAnchors: { orig: evOrig.size, kept: evOrig.size - drops.filter((d) => d.type === 'evidence-anchor-drop').length },
    },
  };
}

// Gate a batch of rewrites: pairs = [{ path, orig, next }].
// Returns { pass, files: [{path, ...result}], drops: [{path, type, value}] } —
// one failing file fails the batch (all-or-nothing feeds apply.mjs).
export function gateFiles(pairs) {
  const files = [];
  const drops = [];
  for (const { path: p, orig, next } of pairs) {
    const r = checkFidelity(orig, next);
    files.push({ path: p, ...r });
    for (const d of r.drops) drops.push({ path: p, ...d });
  }
  return { pass: drops.length === 0, files, drops };
}
