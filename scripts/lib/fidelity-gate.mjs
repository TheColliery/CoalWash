// fidelity-gate.mjs — THE load-bearing module: the mechanical, deterministic
// floor of the fidelity claim (blueprint §14.8, proven live: this exact diff
// caught 2 silent link-drops + 1 self-inventory undercount).
//
// WHAT THE GATE PROVES: every structured token that went in came out — at
// VALUE grain (a vanished value is a drop) and at MENTION grain (a value
// surviving on fewer distinct lines than it occupied is a drop; multiset,
// board disposition 2 2026-07-27). WHAT IT CANNOT SEE: surviving values
// TRADING PLACES — `pass 878 / fail 0` rewritten as `pass 0 / fail 878`
// reports 0 drops, because a positionless compare has no notion of which
// surviving token was bound to which. Re-pairing/value-swaps are the SEMANTIC
// layer's charter (references/method.md §4's outsider จี้), never this
// gate's — so do not skip the human read on a wash because "the gate passed".
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
// with the exact list. Multiset-over-distinct-lines semantics (board
// disposition 2 — supersedes the original "set semantics" paragraph): losing
// a VALUE entirely is a drop, and a value surviving on FEWER DISTINCT LINES
// than it occupied is a drop too (occurrence collapse — `878`x3 -> x1 passed
// the old set diff silently). Removing an EXACT-duplicate line stays free BY
// CONSTRUCTION: occurrences are counted once per distinct line, which is the
// mechanical broom's own dup-cut spec (an identical line survives, so the
// removal is information-free).
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

// Every OCCURRENCE, in order (the multiset layer's primitive; matchSet above
// stays the set layer's). One extraction keying shared by both layers — two
// implementations of one keying would be the twin-drift shape (R2/R3).
function matchList(text, re, group = 0) {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[group]);
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
// LIST form (every occurrence) — the ONE scan both layers project from:
// `numberTokens` (set) and the multiset layer's counts.
function numberScanList(text) {
  let working = maskOut(text, [ISO_DATE_RE, DMY_DATE_RE, VERSION_RE, V_SHORT_VERSION_RE, MDLINK_DEST_RE, AUTOLINK_RE, BAREURL_RE]);
  const out = [];
  // Comma-grouped first (most specific), keyed comma-less — see COMMA_NUM_RE.
  for (const v of matchList(working, COMMA_NUM_RE, 0)) out.push(v.replace(/,/g, ''));
  working = maskOut(working, [COMMA_NUM_RE]);
  for (const re of [MAGNITUDE_RE, PERCENT_RE, RATIO_RE, DECIMAL_RE, INTEGER_RE]) {
    out.push(...matchList(working, re, 0));
    working = maskOut(working, [re]);
  }
  return out;
}
function numberTokens(text) {
  return new Set(numberScanList(text));
}

// Per-class OCCURRENCE lists — the multiset layer's extraction, sharing every
// regex and every keying rule (wikilink target-only, date canonicalization,
// comma-less number keys, quoted-text keys) with the set inventory below.
// Overlapping extractors are CHAINED WITH MASKING here (versions: whole-run
// before v-short; links: md-dest before autolink before bare) because one
// physical token matched by two patterns must count ONCE — a set dedups that
// for free, a count does not (an md-link restyled to a bare link would
// otherwise read 2 -> 1 = a false occurrence drop on a legitimate restyle).
// Set-projection is unchanged: masking removes only spans the earlier pattern
// already claimed, so new Set(list) equals the old union-of-matchSets.
function tokenLists(s) {
  const versions = matchList(s, VERSION_RE, 0);
  const vMasked = maskOut(s, [VERSION_RE]);
  versions.push(...matchList(vMasked, V_SHORT_VERSION_RE, 0));
  const links = matchList(s, MDLINK_DEST_RE, 1);
  let lMasked = maskOut(s, [MDLINK_DEST_RE]);
  links.push(...matchList(lMasked, AUTOLINK_RE, 1));
  lMasked = maskOut(lMasked, [AUTOLINK_RE]);
  links.push(...matchList(lMasked, BAREURL_RE, 0));
  return {
    wikilinks: matchList(s, WIKILINK_RE, 1).map((v) => v.split('|')[0].trim()),
    dates: [...matchList(s, ISO_DATE_RE, 0), ...matchList(s, DMY_DATE_RE, 0)].map(canonDate),
    versions,
    links,
    codespans: matchList(s, CODESPAN_RE, 1),
    quotes: [...matchList(s, CURLY_QUOTE_RE, 1), ...matchList(s, STRAIGHT_QUOTE_RE, 1)],
    numbers: numberScanList(s),
  };
}

// The multiset layer's text: DISTINCT lines only, first-occurrence order.
// Counting occurrences per distinct line is what makes an exact-duplicate-line
// cut (the broom's own charter: an identical line survives, information-free
// BY SPEC) free BY CONSTRUCTION, while a value collapsing across DIFFERENT
// lines is a genuine occurrence drop. Only the single-line token classes are
// counted this way — the block-level classes (fencedLines, frontmatter) are
// excluded because deduplicating lines would corrupt their parsers (two
// identical ``` lines are an opener AND a closer).
function distinctLineText(text) {
  const seen = new Set();
  for (const line of String(text).split(/\r?\n/)) seen.add(line);
  return [...seen].join('\n');
}
function occurrenceCounts(text) {
  const lists = tokenLists(distinctLineText(text));
  const out = {};
  for (const [cls, list] of Object.entries(lists)) {
    const m = new Map();
    for (const v of list) m.set(v, (m.get(v) || 0) + 1);
    out[cls] = m;
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
// real separator). ~~Column-0 anchor keeps it TOP-LEVEL ONLY (an indented
// `  nested: x` line has no non-space char at position 0, so it stays
// excluded — by design).~~ **RETRACTED 2026-07-28 (round 7, G4-2/G4-3):
// COLUMN 0 WAS NEVER THE DEFINITION OF TOP LEVEL, and calling it "by design"
// is what stopped six rounds of readers looking at this line.** A YAML block
// mapping may sit at any consistent indentation, so one leading space made a
// real top-level key invisible to BOTH consumers — the gate inventoried
// nothing, and `isPinned` read a plainly-marked file as unpinned and applyPlan
// DELETED it. Top level is now the block's OWN root column; the genuinely
// nested case the sentence above meant is still excluded, by depth relative to
// that root. See `frontmatterBlockParse`. `#`/`-` are excluded as a first char
// so a YAML comment or a `- list:` sequence item inside the block is never
// mistaken for a key.
// ── THE FRONTMATTER PRIMITIVE (2026-07-27, the encoding-preamble CRITICAL) ──
// ONE answer to "does this text open with a frontmatter block", for all three
// callers that used to ask it with their own copy of `/^---\r?\n/`:
// `isPinned` and `sniffUnrewritable` (apply.mjs — BOTH gate destruction) and
// `frontmatterKeys` below. Three copies of a lexical test is the twin-drift
// shape this room has already paid for twice (R2's case-fold, R3's 8.3 short
// name); R3's law is FIX THE PRIMITIVE, NEVER THE GUARDS.
//
// WHAT WAS WRONG, and it was the DIRECTION, not the regex. `/^---\r?\n/` is a
// LEXICAL test on decoded text being asked a question about the FILE, and its
// NO answer was read as "definitely not frontmatter". Anything in front of the
// fence makes it say NO: a 3-byte UTF-8 BOM (Notepad, `Set-Content`, any
// editor with BOM-on-save) or a UTF-16 preamble (PowerShell 5.1's `>` default).
// So a `pinned: true` file gained a BOM and `applyPlan` DELETED it — the one
// thing the README promises three times is untouchable.
//
// TRI-STATE, because "I could not tell" is not "no". Same shape, and for the
// same reason, as the class-A containment primitive's outside/inside/unknown:
// the primitive reports what it knows and EACH CALLER DECLARES ITS OWN SAFE
// DIRECTION. A two-valued answer forces the unknown case to masquerade as one
// of the two, and it always ends up masquerading as the permissive one.
//   'none'         — decodable, and it does not open with a fence.
//   'closed'       — decodable, opens and closes; `block` is the body.
//   'unverifiable' — the head is not decodable UTF-8 text (an encoding
//                    preamble), OR it opens and never closes in the text given.
//
// ONE leading U+FEFF is STRIPPED rather than refused: a UTF-8 BOM is a legal
// signature and the file is fully decodable, so the honest answer is to parse
// it — which makes the pin promise TRUE for those files instead of merely
// refusing to work on them. Undecodable encodings cannot be parsed at all and
// take the fail-closed branch. A SECOND U+FEFF still at the head after that
// one legal strip is not a signature — Unicode defines exactly one, at offset
// 0 — it is a re-encode artifact whose reading is ambiguous (junk signature
// vs deliberate ZWNBSP content), i.e. the tri-state's "I could not tell":
// unverifiable, never 'none' (station-3 measured 'none' deleting a
// double-BOM'd pinned file through applyPlan). Position 0 ONLY — a ZWNBSP
// deeper in the head is legal content and must not join the refuse set.
//
// SCAN WINDOW, and why it is small: `isPinned` decodes a 64 KB byte window, so
// a multi-byte character straddling that boundary decodes to U+FFFD at the END
// of the string. Scanning the whole text for U+FFFD would refuse a perfectly
// good large file on a truncation artefact. A real encoding preamble is at
// offset 0, so only the head is scanned.
const FM_HEAD_SCAN = 64;
// THE FENCE-LINE TAIL — what may follow `---` on the opening fence line.
//
// THIS LINE HAS NOW BEEN REPAIRED FOUR TIMES, and the first three failed the
// SAME way: each ENUMERATED what was allowed to be ignored (`` -> `[ \t]` ->
// White_Space|Cf|Cc), which left `'none'` — the answer that ends in a DELETE —
// as the FALLTHROUGH. Any codepoint nobody had classified therefore landed on
// the destroying side automatically. Station 3 walked ten more through the
// third list (U+3164 HANGUL FILLER, U+2800 BRAILLE PATTERN BLANK, U+FE0F
// VS-16, U+034F CGJ, combining marks…), and not one of them is White_Space,
// Cf or Cc.
//
// SO THE FIX IS THE POLARITY, NOT A LONGER LIST. `'none'` must be EARNED: a
// tail yields it only by containing a printable-ASCII glyph. Everything else —
// invisible, unassigned, non-ASCII, or a codepoint no standard has classified
// yet — takes the refusing branch. That is a property of the 94-member
// ALLOWLIST below, checkable by reading it; it is NOT a claim about Unicode
// coverage. The previous version of this comment made exactly that claim
// ("an unlisted invisible byte cannot exist") and it was false within a day.
//
// REJECTED, recorded so nobody re-derives it: `\p{Default_Ignorable_Code_Point}`
// is the closest real property and covers only 8 of station 3's 10 (U+2800 and
// combining marks are not default-ignorable) — a fifth list with a residual.
// `\p{Mn}` / `\p{Lo}` swallow real letters (U+3164 is `Lo`, exactly like
// ordinary Hangul, and renders as nothing).
//
// THE PRICE, NAMED AND PINNED BY A TEST: a tail of legitimately VISIBLE
// non-ASCII prose is refused too. That is a YIELD loss (the file is not
// washed), never a SAFETY loss (it is not deleted either) — the deliberate
// direction for a primitive whose `'none'` authorises destruction.
const FM_TAIL_FENCE = /^[ \t]*$/;      // empty or the ordinary editor artifact = a fence
const FM_TAIL_VISIBLE = /[\x21-\x7E]/; // printable ASCII, space and tab excluded
// THE CLOSING FENCE, TWO READINGS — and the difference is WHO GAVE US THE TEXT.
// `$` in the whole-text form means END OF FILE, which is a legitimate close (a
// file that ends `\n---` with no trailing newline). When the caller handed us a
// TRUNCATED PREFIX, the very same `$` means END OF THE WINDOW, and a `\n---`
// landing on that cut FABRICATES a close: the block "ends" at the window, every
// key past it is invisible, and `isPinned` returned false for a file whose pin
// sat one byte further on -> applyPlan deleted it (G3-2, reproduced end to end).
// apply.mjs's PIN_READ_BYTES comment has always said "a block that does not
// close within this = unverifiable"; this is the line that makes the code do it.
// A truncated read therefore requires a REAL line terminator after the fence —
// end-of-string proves nothing about a string someone else cut.
const FM_CLOSE = /\r?\n---[ \t]*(?:\r?\n|$)/;
const FM_CLOSE_TRUNCATED = /\r?\n---[ \t]*\r?\n/;
export function readFrontmatter(text, { truncated = false } = {}) {
  let s = String(text);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1); // UTF-8 BOM: legal signature (exactly one), parse on
  if (s.charCodeAt(0) === 0xfeff) {
    return { state: 'unverifiable', block: '', why: 'a second U+FEFF after the legal BOM strip — an encoding preamble (double-encode artifact), not readable frontmatter' };
  }
  const head = s.slice(0, FM_HEAD_SCAN);
  // NUL = UTF-16/32 interleaving (or binary); U+FFFD = bytes that were not
  // valid UTF-8 (a UTF-16/32 BOM decodes to replacement characters).
  if (head.includes('\u0000') || head.includes('\uFFFD')) {
    return { state: 'unverifiable', block: '', why: 'the head is not decodable UTF-8 text (an encoding preamble — UTF-16/32 BOM, NUL-interleaved, or binary)' };
  }
  // THE OPENING FENCE — fixed FOUR TIMES. Each repair before this one closed
  // the reported characters and left the hole open for the ones nobody had
  // reported: one invisible byte in the tail switches off the pin refusal on
  // delete, the pin refusal on the unattended rewrite, and the unclosed-fence
  // refusal, all at once. The defect was never WHICH bytes were listed — it
  // was that `'none'` (which authorises a delete) was the FALLTHROUGH. The
  // tail classification above inverts that: see FM_TAIL_VISIBLE.
  //
  // The proof needed no external standard, which is why it is trustworthy: the
  // SAME byte on the CLOSING fence already answered 'unverifiable'. A primitive
  // that says "cannot tell" at one fence and "no frontmatter" at the other is
  // wrong at one of them, and 'none' is the answer that ends in a delete.
  //
  // THE CLOSING FENCE BELOW DELIBERATELY KEEPS `[ \t]*` AND IS NOT GIVEN THIS
  // TRI-STATE — do not "finish the symmetry". Its accept-set is already
  // identical; only its MISS behaviour differs, and that difference is
  // conservative by construction: an unmatched close either finds a later
  // `---` (an OVER-inclusive block — more keys inventoried, and isPinned's
  // /^pinned\s*:\s*true\s*$/m matches anywhere in it, so a pin can only gain)
  // or finds none and returns 'unverifiable' anyway. There is no reading of a
  // bad closing fence that yields a permissive answer.
  const open = /^---([^\r\n]*)\r?\n/.exec(s);
  // Fence-SHAPED but a line discipline this tooling does not parse: a bare CR
  // (classic-Mac) line terminator. Every scan in this module splits on \r?\n,
  // so parsing on would be a guess wearing a parse.
  const cr = open ? null : /^---([^\r\n]*)\r/.exec(s);
  const tail = open ? open[1] : (cr ? cr[1] : null);
  if (tail !== null && !FM_TAIL_FENCE.test(tail)) {
    // EARN 'none', never fall through to it: prose that merely starts with
    // three dashes (`--- a/file.txt`, `----`) proves itself by carrying a
    // printable-ASCII glyph, and stays washable. Anything else is refused.
    if (FM_TAIL_VISIBLE.test(tail)) return { state: 'none', block: '' };
    return { state: 'unverifiable', block: '', why: 'the opening fence line carries no printable-ASCII glyph after --- — fence-shaped, and this tooling cannot say whether it is frontmatter' };
  }
  if (cr) {
    return { state: 'unverifiable', block: '', why: 'the opening fence line ends in a bare CR (classic-Mac line endings) — a line discipline this tooling cannot faithfully parse' };
  }
  if (!open) return { state: 'none', block: '' };
  // Slice from the opener's OWN newline (not past it) so the closing-fence
  // regex, which anchors on a preceding newline, still sees an immediately
  // following `---`; for the bare `---\n` opener this is byte-identical to
  // the old fixed slice(3).
  const bodyStart = open[0].length - (open[0].endsWith('\r\n') ? 2 : 1);
  const end = (truncated ? FM_CLOSE_TRUNCATED : FM_CLOSE).exec(s.slice(bodyStart));
  if (!end) return { state: 'unverifiable', block: '', why: truncated ? 'frontmatter opens and does not close inside the read window (unverifiable — the block may continue past it)' : 'frontmatter opens but never closes (unparseable)' };
  return { state: 'closed', block: s.slice(bodyStart, bodyStart + end.index) };
}

// ── ONE READER FOR THE BLOCK (2026-07-28, G3-1) ────────────────────────────
// `readFrontmatter` gave every caller the same BLOCK and then each caller ran
// its own regex over it. `frontmatterKeys` parsed it as key/value lines while
// `isPinned` (apply.mjs) ran a private /^pinned\s*:\s*true\s*$/m — two readers,
// one block, OPPOSITE answers, and the answer that loses ends in a DELETE. Six
// spellings THIS FUNCTION ITSELF counted as a `pinned` key were deletable
// through the shipped door: `True`, `TRUE`, `"pinned": true`, a trailing
// `# comment`, YAML 1.1 `yes`, and a quoted `"true"`. The primitive was fixed
// four times on WHAT PRECEDES the fence; nobody had looked at the predicate
// reading what the primitive returned.
//
// SO THERE IS ONE PARSE PER LINE, AND THE CONSUMERS PROJECT IT — the same
// ONE-EXTRACTION-TWO-VIEWS shape as tokenLists -> inventory, and for the same
// reason: a second extraction site is the twin-drift the room has paid for
// three times, and a sync comment is not a guard.
//
// WHY AN ENTRY CARRIES `strict`, and this is the part that is easy to get
// backwards: MERGING TWO READERS CAN BE LOOSER THAN EITHER ONE. Measured, on a
// real input — `pinned:true` (no space after the colon) is protected by the
// retired pin regex and is NOT a key to `frontmatterKeys`, because a YAML
// mapping needs whitespace or end-of-line after the colon. Handing the pin
// question straight to the gate's parser would therefore have UNPROTECTED a
// file that is protected today, while fixing the six spellings. So the strict
// shape (what the gate inventories, byte-identical to before) and the loose
// shape (a colon-bearing line a human plainly meant as a key) both come out of
// this one parse, and each consumer declares which it needs.
// ── ROUND 7: THE QUESTION IS INVERTED ───────────────────────────────────────
// Rounds 1-6 all asked "is there a pin?" and were repaired by widening what
// counts as one. **"No marker found" is an answer a wrong parse always
// produces**; "every line of this block is accounted for" is not. So this
// reader now returns TWO things — the entries, and whether the block is
// PROVABLY readable — and the destroying consumer requires the proof.
//
// TOP-LEVEL IS THE BLOCK'S OWN ROOT COLUMN, NOT COLUMN 0 (G4-2/G4-3). Both key
// regexes anchored on `^[^\s...]`, so ONE leading space stopped a line being an
// entry at all: `frontmatterKeys` inventoried nothing and `isPinned` saw no pin
// and applyPlan DELETED the file. A YAML block mapping may sit at any
// consistent indentation, so a uniformly-indented block is a ROOT mapping and
// its keys are top-level — an independent oracle (js-yaml) reads
// `" pinned: true"` as `{pinned: true}`, and no shipped document of ours puts a
// column constraint on the marker. The root column is set by the first
// non-blank, non-comment line (YAML ignores comments for indentation).
//
// WHAT WE UNDERSTAND, AND WHY THAT IS ENOUGH WITHOUT A YAML PARSER: we do not
// need to know what a line MEANS, only whether it can be a TOP-LEVEL KEY. A
// block scalar's content, a nested mapping and a sequence item are all required
// by YAML to be MORE indented than their parent, so nothing at a deeper column
// can ever be a root key — those lines are understood by position alone. That
// leaves the root column itself, where every line must be a key, a comment, a
// sequence item or blank. Anything else refuses.
//
// THE PRICE, NAMED AND MEASURED (550 real frontmatter blocks across the flock:
// 4 refused, all four lab padding fixtures, 0 real class-B files): a flow
// mapping at the root, a `?` explicit key, a `%` directive, a `...` document
// end, tab indentation, or a non-ASCII top-level key makes the file
// UNWASHABLE — flagged with a reason, never deleted and never rewritten. Yield
// loss, never safety loss, and the user is told how to get the yield back.
const KEY_STRICT = /^([^\s:#-][^\n]*?)\s*:(?=\s|$)([^\n]*)$/;
const KEY_LOOSE = /^([^\s:#-][^\n]*?)\s*:([^\n]*)$/;
const SEQ_ITEM = /^-(?:[ \t][^\n]*)?$/;
// Show an invisible byte AS a codepoint — the whole value of the message to a
// user is seeing the character they cannot see in their editor.
const showLine = (s) => JSON.stringify(String(s).slice(0, 60).replace(/[^\x20-\x7E]/g, (c) => `U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`));
export function frontmatterBlockParse(block) {
  const entries = [];
  let root = null;
  let unreadable = null;
  const refuse = (why) => { if (!unreadable) unreadable = why; };
  // THE LINE BASIS (round-7 residual, CLOSED). "Every line accounted for"
  // inherits the correctness of this split, and YAML 1.2 breaks on a LONE CR
  // too (`b-break ::= CRLF | CR | LF`) while `/\r?\n/` does not — so a
  // MIXED-ending block was joined into fewer lines than the author wrote, each
  // joined line still matched a key regex, and `  title: x<CR>  pinned: true`
  // — a top-level pin by YAML — was deleted through the shipped door. A bare
  // CR therefore refuses the BLOCK, the same discipline (and for the same
  // reason) as `readFrontmatter`'s `cr` fence branch: no per-line verdict can
  // be trusted when the lines themselves are mis-cut. Fixed HERE, at the
  // split's owner, never in a caller. The ENTRIES still parse on the joined
  // basis below — the inventory's permissive consumer keeps what it always
  // read (byte-identical), only the readability proof changes.
  if (/\r(?!\n)/.test(String(block))) {
    refuse('the block contains a bare CR line break (mixed line endings) — a line discipline this tooling cannot faithfully parse, so no per-line reading of this block can be trusted');
  }
  for (const line of String(block).split(/\r?\n/)) {
    if (!/\S/.test(line)) continue; // blank
    if (/^[ ]*\t/.test(line)) { refuse(`a TAB in the indentation of ${showLine(line)} — YAML forbids tabs for indentation, so this block has no column to read`); continue; }
    const indent = /^[ ]*/.exec(line)[0].length;
    const body = line.slice(indent);
    if (body[0] === '#') continue; // a comment sits at any column and never sets the root
    if (root === null) root = indent;
    if (indent > root) continue; // deeper than the root: nested mapping, sequence item or block-scalar content — cannot be a top-level key
    if (SEQ_ITEM.test(body)) continue; // the root is a SEQUENCE: it has no top-level mapping keys at all
    const strict = KEY_STRICT.exec(body);
    // The strict form is the pre-existing key regex UNCHANGED (its lookahead
    // backtracking is load-bearing: `a:b c: d` keys as `a:b c`, not `a`), plus
    // a value capture that cannot alter where the key match ends. It is applied
    // to the line with its indentation REMOVED, which is byte-identical to the
    // old behaviour at column 0 and is the whole fix everywhere else.
    const m = strict || KEY_LOOSE.exec(body);
    if (!m) { refuse(`CoalWash cannot read ${showLine(line)} as a key, a comment or a list item`); continue; }
    // THE UNION, and it is deliberate. Round 5 shipped a regression by assuming
    // a merge was a widening without measuring the other direction. On a
    // mixed-indentation block the two readings disagree, so BOTH count: the
    // inventory may never LOSE a key the old column-0 anchor saw.
    const top = indent === root || indent === 0;
    if (indent < root) refuse(`the key line ${showLine(line)} is indented LESS than the block's first line — CoalWash cannot tell which column is the document root`);
    if (top && /[^\x20-\x7E]/.test(m[1])) refuse(`the top-level key in ${showLine(line)} contains a character outside printable ASCII — CoalWash cannot tell whether it is the \`pinned\` marker`);
    // A key that OPENS with one of YAML's own indicator characters is not a
    // plain scalar, so this line is not the plain `key: value` we can read:
    // `{pinned: true}` is a FLOW mapping whose real key is `pinned`, and we
    // keyed it as `{pinned` and called the file unpinned. The set is closed and
    // cited (YAML's c-indicator list) rather than fitted to the cases we hit —
    // `:`/`#`/`-` are already excluded by the key regex above, and the two
    // QUOTE characters are deliberately kept, because a quoted key is a legal
    // plain key that `unquote` already reads (`"pinned": true` is PINNED today).
    if (top && /^[,[\]{}&*!|>%@`?]/.test(m[1])) refuse(`the top-level key in ${showLine(line)} opens with a YAML indicator character — this is flow or explicit-key syntax, not the plain \`key: value\` line CoalWash reads`);
    entries.push({ key: m[1], value: m[2], strict: !!strict, top });
  }
  return { entries, unreadable };
}

export function frontmatterKeys(text) {
  const fm = readFrontmatter(text);
  // 'none' and 'unverifiable' both yield no keys — UNCHANGED semantics for the
  // unverifiable case on purpose. Whether an un-inventoriable frontmatter should
  // make the GATE refuse (rather than silently inventory nothing) is a separate
  // open question and is NOT decided here; this change only stops a BOM from
  // emptying the inventory of a file that is perfectly readable.
  if (fm.state !== 'closed') return new Set();
  // STRICT ONLY — the inventory keeps exactly the key SHAPE it has always kept.
  // The loose entries exist for the pin gate, which needs a floor, not a census.
  //
  // AND IT DELIBERATELY IGNORES `unreadable`, which is the opposite of what the
  // destroying consumer does with it — same primitive, two consumers, OPPOSITE
  // safe directions. `isPinned` refuses an unreadable block because its
  // permissive answer DELETES a file; an inventory's permissive answer is
  // reporting FEWER drops, so the safe move here is to keep every key we did
  // manage to read. Do not "make these consistent".
  return new Set(frontmatterBlockParse(fm.block).entries.filter((e) => e.strict && e.top).map((e) => e.key));
}

// Extract the full structured-token inventory of a text — PROJECTED from the
// same tokenLists extraction the multiset layer counts. ONE extraction, two
// views (set here, occurrence counts there): a keying rule (wikilink
// target-only, date canonicalization, comma-less number keys) lives in
// tokenLists and cannot diverge between the layers — a second extraction site
// would be the twin-drift shape (R2/R3), and a sync comment is not a guard.
// The masked chaining inside tokenLists is set-projection-neutral (its header
// says why), so this projection equals the old union-of-matchSets.
export function inventory(text) {
  const s = String(text);
  const lists = tokenLists(s);
  return {
    wikilinks: new Set(lists.wikilinks),
    dates: new Set(lists.dates),
    versions: new Set(lists.versions),
    links: new Set(lists.links),
    frontmatter: frontmatterKeys(s),
    codespans: new Set(lists.codespans),
    quotes: new Set(lists.quotes),
    numbers: new Set(lists.numbers),
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
  // ── THE MULTISET LAYER (board disposition 2, 2026-07-27) ──────────────────
  // A value that SURVIVES but on fewer DISTINCT lines than it occupied is a
  // reported drop too: `878` stated on 3 lines surviving on 1 passed the old
  // set diff silently — a token dropped inside the gate's existing promise.
  // The entry reuses the SAME type and therefore the SAME approval key
  // (`number-drop:878`) — the wizard/RE-TIER channels need no new grammar,
  // and approving a full drop of a value also approves its occurrence drop
  // (strictly fewer bytes lost than approved = the safe direction). Counted
  // once per distinct line, so the broom's exact-duplicate-line cut is free
  // BY CONSTRUCTION; emitted only when the value survives on BOTH sides
  // (kept > 0) — a vanished value is the set layer's plain full drop above.
  {
    const oc = occurrenceCounts(orig);
    const nc = occurrenceCounts(next);
    const occDrop = (cls, type) => {
      for (const [v, co] of oc[cls]) {
        if (co < 2) continue; // one mention cannot collapse
        const ck = nc[cls].get(v) || 0;
        // kept>0 only: a vanished value is the set layer's full drop above.
        // The set-membership guard covers the one edge where the deduped text
        // and the full text can disagree (a multi-line md-link whose second
        // half sat on a duplicated line) — conservative-miss, never a double
        // or contradictory entry.
        if (ck > 0 && ck < co && oi[cls].has(v) && ni[cls].has(v)) {
          drops.push({ type, value: v, occurrences: { orig: co, kept: ck } });
        }
      }
    };
    occDrop('wikilinks', 'wikilink-drop');
    occDrop('dates', 'date-drop');
    occDrop('versions', 'version-drop');
    occDrop('links', 'link-drop');
    occDrop('codespans', 'codespan-drop');
    occDrop('quotes', 'quote-drop');
    occDrop('numbers', 'number-drop');
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

  // counts report DISTINCT VALUES (orig/kept) — an occurrence-grade entry
  // (value still present, fewer mentions) must not subtract from `kept`, so
  // the filter excludes entries carrying `occurrences`.
  const fullDrops = (...types) => drops.filter((d) => types.includes(d.type) && !d.occurrences).length;
  return {
    pass: drops.length === 0,
    drops,
    warnings,
    counts: {
      wikilinks: { orig: oi.wikilinks.size, kept: oi.wikilinks.size - fullDrops('wikilink-drop') },
      dates: { orig: oi.dates.size, kept: oi.dates.size - fullDrops('date-drop') },
      versions: { orig: oi.versions.size, kept: oi.versions.size - fullDrops('version-drop') },
      links: { orig: oi.links.size, kept: oi.links.size - fullDrops('link-drop') },
      frontmatter: { orig: oi.frontmatter.size, kept: oi.frontmatter.size - fullDrops('frontmatter-key-drop') },
      codespans: { orig: oi.codespans.size, kept: oi.codespans.size - fullDrops('codespan-drop') },
      quotes: { orig: oi.quotes.size, kept: oi.quotes.size - fullDrops('quote-drop') },
      numbers: { orig: oi.numbers.size, kept: oi.numbers.size - fullDrops('number-drop', 'number-precision') },
      fencedLines: { orig: oi.fencedLines.size, kept: oi.fencedLines.size - fullDrops('fenced-line-drop') },
      evidenceAnchors: { orig: evOrig.size, kept: evOrig.size - fullDrops('evidence-anchor-drop') },
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
