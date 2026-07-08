// fidelity-gate.mjs — THE load-bearing module: the mechanical, deterministic
// floor of the zero-fact-loss guarantee (blueprint §14.8, proven live: this
// exact diff caught 2 silent link-drops + 1 self-inventory undercount).
//
// Contract: diff orig-vs-new inventories of STRUCTURED tokens — [[wikilinks]],
// dates, version strings, frontmatter keys. ANY drop = FAIL with the exact
// list. Set semantics (distinct values): deduplicating a REPEATED mention of
// the same value is legitimate compaction; losing a VALUE entirely is a drop.
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
const VERSION_RE = /\bv?\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?\b/g;
// Built from char codes, never raw literals in source — a decomposed sara-am or a
// zero-width space is invisible/normalization-fragile under future edits (the
// edit-tool control-escape hazard).
const SARA_AM_DECOMPOSED = String.fromCharCode(0x0e4d, 0x0e32); // NIKHAHIT + SARA AA (the broken split of U+0E33)
const ZWSP = String.fromCharCode(0x200b); // zero-width space

function matchSet(text, re, group = 0) {
  const out = new Set();
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) out.add(m[group]);
  return out;
}

// Top-level frontmatter keys from a leading `---` YAML block (key names only —
// a dropped key is a dropped fact-slot; value edits are the semantic layer's call).
export function frontmatterKeys(text) {
  const s = String(text);
  if (!/^---\r?\n/.test(s)) return new Set();
  const end = /\r?\n---[ \t]*(?:\r?\n|$)/.exec(s.slice(3));
  if (!end) return new Set();
  const block = s.slice(3, 3 + end.index);
  const keys = new Set();
  for (const line of block.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+)\s*:/.exec(line);
    if (m) keys.add(m[1]);
  }
  return keys;
}

// Extract the full structured-token inventory of a text.
export function inventory(text) {
  const s = String(text);
  return {
    wikilinks: matchSet(s, WIKILINK_RE, 1),
    dates: new Set([...matchSet(s, ISO_DATE_RE), ...matchSet(s, DMY_DATE_RE)]),
    versions: matchSet(s, VERSION_RE),
    frontmatter: frontmatterKeys(s),
  };
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
    ...diffDrops(oi.frontmatter, ni.frontmatter, 'frontmatter-key-drop'),
  ];
  const warnings = [];

  // Encoding tripwires: fail on INTRODUCED corruption, warn on inherited.
  const origDecomposed = orig.includes(SARA_AM_DECOMPOSED);
  const nextDecomposed = next.includes(SARA_AM_DECOMPOSED);
  if (nextDecomposed && !origDecomposed) drops.push({ type: 'thai-sara-am-decomposed', value: 'U+0E4D+U+0E32 introduced (must stay U+0E33)' });
  else if (nextDecomposed && origDecomposed) warnings.push('decomposed Thai sara-am present in BOTH versions (pre-existing — consider NFC-normalizing separately)');

  if (next.charCodeAt(0) === 0xfeff && orig.charCodeAt(0) !== 0xfeff) drops.push({ type: 'bom-introduced', value: 'U+FEFF at file start' });
  if (next.includes(ZWSP) && !orig.includes(ZWSP)) drops.push({ type: 'zwsp-introduced', value: 'U+200B zero-width space' });

  return {
    pass: drops.length === 0,
    drops,
    warnings,
    counts: {
      wikilinks: { orig: oi.wikilinks.size, kept: oi.wikilinks.size - drops.filter((d) => d.type === 'wikilink-drop').length },
      dates: { orig: oi.dates.size, kept: oi.dates.size - drops.filter((d) => d.type === 'date-drop').length },
      versions: { orig: oi.versions.size, kept: oi.versions.size - drops.filter((d) => d.type === 'version-drop').length },
      frontmatter: { orig: oi.frontmatter.size, kept: oi.frontmatter.size - drops.filter((d) => d.type === 'frontmatter-key-drop').length },
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
