// Config-key drift gate — catch ship-text that names a config key which does
// not exist. Adapted from CoalMine's config-keys.mjs exemplar; the LISTS and
// the LOCATORS are ours, because our docs are shaped differently (see below).
//
// WHY OUR LOCATORS DIVERGE FROM THE EXEMPLAR, measured before porting:
// the exemplar harvests every backticked camelCase identifier out of markdown.
// Run against OUR ship-text that yields 96 candidates, 24 real keys and 72
// false positives (75% noise) -- because this room's docs backtick ENGINE
// FUNCTION names constantly (`applyPlan`, `mergeSafety`, `gateFiles`,
// `recordBinItem`...), and camelCase cannot tell a function from a config key.
// 56 of those 72 come from one file (references/method.md), a procedure doc
// that names engine internals by design. An allowlist of 72 bare strings would
// be larger than the schema itself and would be a bypass with no author.
//
// So we locate by STRUCTURE instead of by shape. Three markdown locators plus
// two runtime-text locators, measured together at 2 false positives, not 72:
//   L1 TABLE   -- the first cell of a markdown table row (our README key table)
//   L2 DOTTED  -- `container.leaf` where container is a known object/bandmap key
//   L3 CONFIG  -- a backticked ident on a line naming .coalwash.json, or under a
//                 heading whose text contains "Configure"
//   L4 NOTICE  -- a string literal inside an out.push(...) call in the conductor
//   L5 BUILDER -- every string literal in a notice-BUILDER file, comments stripped
//
// L4 REPLACES the exemplar's noticeRegion(text, 'TRANSLATIONS'). We have NO
// such block -- our conductor's top-level consts are numbers and Sets. Ported
// literally, noticeRegion would find start === -1, return '', scan zero bytes
// and report clean. That is the exact failure the first adopter hit. An
// out.push(...) call is self-delimiting, so it has no end sentinel to overrun.
//
// L5 EXISTS BECAUSE THE CONDUCTOR HAS **TWO** SANCTIONED CHANNELS AND L4 READS
// ONE. `console.log(out.join(...))` (the SessionStart context injection) is
// L4's. `process.stdout.write(JSON.stringify({decision:'block', reason}))` (the
// Stop blocking feedback) is not: its `reason` is built entirely in ask.mjs, by
// forceAuto / wizardEscalation / obeseAutoQuick / externalizeAdvisory. That file
// is a pure notice BUILDER -- every export returns user-facing prose -- so the
// whole file is the notice surface and the locator is every string literal in
// it, not a call-shaped region.
//
// COMMENT-STRIPPING IS LOAD-BEARING IN L5, NOT HYGIENE. Measured on ask.mjs:
// with comments stripped, 2 candidates / 1 real / 1 false positive. With them
// kept, 4 / 1 / 3 -- `breakEven` and `ceilingAsk` are named only in prose
// comments. A separate naive scan that stripped nothing measured 38 false
// positives, because an apostrophe inside a prose comment opens a fake string
// literal that swallows the code after it until the next apostrophe. That 38
// was the number used to justify leaving this channel unscanned; it was a
// property of the naive scan, not of the file.
//
// WHAT L5 DOES NOT BUY, stated so nobody over-claims it: this gate tests
// EXISTENCE. `externalizeAdvisory` shipped "raise `fatMultiple`" while that
// key's BEHAVIOUR was retired, but the key is still in CONFIG_SCHEMA
// (read-tolerated, ignored), so it resolves and no red fires. L5 catches a
// notice naming a key that does not exist -- not one naming a key that exists
// and no longer does anything. That second class needs a liveness check this
// gate does not attempt.
//
// The conductor is deliberately NOT scanned with L5's every-literal rule.
// Measured, it would be 7 candidates / 7 real / 0 false positives -- cheap, and
// still wrong: those 7 come from code like `clampedRead(cfg, 'coalwashMode')`,
// so it would widen the gate from SHIP-TEXT drift to code-vs-schema drift, a
// different and unstated purpose. L4 stays bounded to the notice channel.
//
// EXCLUDED SURFACES. Five root docs are gitignored internal working records
// (MEMORY.md, COALWASH_BLUEPRINT.md, LAB-ARCHIVE.md, ASSEMBLY-LINE.md,
// SENIOR-INCIDENT-AUDIT.md) -- verified per file with `git check-ignore`, not
// assumed. CHANGELOG.md is TRACKED and is excluded for a different and stronger
// reason: it names retired and planned keys BY DESIGN, so a red there would
// fire on accurate history. That makes including it wrong, not merely noisy.

const SHAPE = /^[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*$/;
const TICK = String.fromCharCode(96);
const BACKTICKED = TICK + '([A-Za-z][A-Za-z0-9_.]*)' + TICK;
// A dotted token ending in a file extension is a MODULE, never a key path
// (`retier.mjs` is the live example this exists for).
const FILE_EXT = /\.(mjs|cjs|js|json|md|yml|yaml|ps1|sh|txt)$/;
// A `${...}` interpolation inside a notice template literal. Written as a plain
// literal ON PURPOSE, after a char-code build of the same pattern shipped a live
// bug: assembled from String.fromCharCode the `$` is not escaped, so the engine
// reads it as the end-of-input ANCHOR and `${` can never match. The regex looked
// right, compiled fine, and stripped nothing. Escape the `$` and `{` here; the
// bash-heredoc hazard that motivated the char-code trick is avoided by editing
// this file with a file-writing tool, never by weakening the pattern.
const INTERP = /\$\{[^}]*\}/g;

/** Keys documented before they exist. Rule 1: an entry that now RESOLVES fails. */
export const PENDING_KEYS = Object.freeze({});

/**
 * Identifiers a locator reaches that are not config keys. Rule 2: an entry no
 * surface mentions any more fails as stale. Every entry states WHY it lands in
 * a config locator at all -- a bare string here would be a bypass with no author.
 */
export const NOT_CONFIG = Object.freeze({
  oneLineResult:
    "receipt.mjs's exported one-line receipt builder. ask.mjs's forceAuto names it inside the "
    + 'directive text so the agent knows which function produces the line it must push, which is '
    + 'why L5 reaches it: it is a function name deliberately printed in user-facing prose.',
  projectConfigPath:
    'a function in config-load.mjs that RESOLVES the per-project config path. It is named in '
    + "references/platform-cc.md's config-location prose, which is precisely why L3's "
    + 'config-context locator reaches it: the sentence is about where the config lives.',
});

/**
 * Schema keys the KEY_SHAPE rule cannot see, each with its own reason. An
 * UNDECLARED blind key is a hard FAIL: acquiring a blind spot must never be
 * silent. Rule 3: an entry that leaves the schema, or that starts matching
 * KEY_SHAPE, fails as stale.
 */
export const BLIND_KEYS = Object.freeze({
  language: 'a single all-lowercase word; no interior capital for the shape rule to key on.',
  retier: 'an all-lowercase container key (its LEAVES are camelCase and are seen normally).',
  estate: 'an all-lowercase container key (its LEAVES are camelCase and are seen normally).',
  obese: "a BAND NAME, not a coined key -- the lowercase domain of exercisePerBand's bandmap.",
  full: "a BAND NAME, and additionally an ordinary English word this room's prose uses constantly.",
});

/** Every leaf name in a schema entry, flattened (a bare leaf resolves without its parent). */
export function schemaKeyNames(schema) {
  const out = new Set();
  const walk = (spec, name) => {
    out.add(name);
    if (spec.fields) for (const [k, s] of Object.entries(spec.fields)) walk(s, k);
    else if (spec.type === 'bandmap' && spec.def) for (const k of Object.keys(spec.def)) out.add(k);
  };
  for (const e of schema) walk(e, e.key);
  return out;
}

/** Container keys whose sub-keys are written dotted in docs. */
function containersOf(schema) {
  return schema.filter((s) => s.fields || s.type === 'bandmap').map((s) => s.key);
}

function addIdent(set, raw) {
  if (FILE_EXT.test(raw)) return;
  for (const seg of raw.split('.')) if (SHAPE.test(seg)) set.add(seg);
}

/** L1: the first cell of a markdown table row. */
export function tableKeys(text) {
  const out = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    const cell = line.split('|')[1] || '';
    for (const m of cell.matchAll(new RegExp(BACKTICKED, 'g'))) addIdent(out, m[1]);
  }
  return out;
}

/** L2: `container.leaf` where container is a known object/bandmap key. */
export function dottedKeys(text, containers) {
  const out = new Set();
  if (!containers.length) return out;
  const re = new RegExp(TICK + '(?:' + containers.join('|') + ')\\.([A-Za-z][A-Za-z0-9_.]*)' + TICK, 'g');
  for (const m of text.matchAll(re)) addIdent(out, m[1]);
  return out;
}

/** L3: a config-context line -- names .coalwash.json, or sits under a "Configure" heading. */
export function configProseKeys(text) {
  const out = new Set();
  let inCfg = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^#{2,4}\s/.test(line)) inCfg = /configure/i.test(line);
    if (!inCfg && !line.includes('.coalwash.json')) continue;
    for (const m of line.matchAll(new RegExp(BACKTICKED, 'g'))) addIdent(out, m[1]);
  }
  return out;
}

/**
 * L4: string literals inside out.push(...) -- the conductor's only user-facing
 * notice channel. Returns { keys, lines, chars } so the caller can PRINT what
 * the scan actually covered: a locator that silently matches nothing reports
 * clean, which is indistinguishable from a locator that found no defect.
 */
export function noticeKeys(text) {
  const out = new Set();
  const all = text.split(/\r?\n/);
  const hit = all.filter((l) => l.includes('out.push('));
  for (const line of hit) {
    // Strip ${...} interpolations FIRST: an interpolated expression is CODE
    // (`m.alwaysLoaded.tokensEst`, `bmiTxt`), not user-facing text naming a key.
    // Measured against this room's own history -- without this, three internal
    // field names were harvested from beta.1-beta.11 notice lines as if they
    // were config keys the docs had invented.
    const prose = line.replace(INTERP, ' ');
    for (const m of prose.matchAll(/[A-Za-z][A-Za-z0-9]{2,}/g)) if (SHAPE.test(m[0])) out.add(m[0]);
  }
  return { keys: out, lines: hit.length, chars: hit.reduce((n, l) => n + l.length, 0), total: all.length };
}

const BS = String.fromCharCode(92);
// Every string literal: single, double, or template -- escape-aware so a quote
// inside a literal does not end it early.
const ANY_LITERAL = new RegExp(
  "'((?:[^'" + BS + BS + ']|' + BS + BS + ".)*)'"
  + '|"((?:[^"' + BS + BS + ']|' + BS + BS + '.)*)"'
  + '|' + TICK + '((?:[^' + TICK + BS + BS + ']|' + BS + BS + '.)*)' + TICK,
  'g',
);

/**
 * Strip comments BEFORE harvesting literals. Not hygiene: an apostrophe in a
 * prose comment ("the hook's own") opens a literal that swallows the code after
 * it, which is what made a naive scan of ask.mjs measure 38 false positives.
 * A `//` preceded by `:` is left alone so a URL inside a literal survives.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/).map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
}

/**
 * L5: every string literal in a notice-BUILDER file (one whose exports return
 * user-facing prose). Returns { keys, literals } so the caller can PRINT the
 * literal count -- zero literals means the locator matched nothing, which reads
 * exactly like a clean file and must FAIL instead.
 */
export function builderKeys(text) {
  const out = new Set();
  const src = stripComments(text);
  let literals = 0;
  for (const m of src.matchAll(ANY_LITERAL)) {
    literals++;
    const body = (m[1] || m[2] || m[3] || '').replace(INTERP, ' ');
    for (const w of body.matchAll(/[A-Za-z][A-Za-z0-9]{2,}/g)) if (SHAPE.test(w[0])) out.add(w[0]);
  }
  return { keys: out, literals };
}

/**
 * @returns {{findings: {level:'FAIL'|'SKIP', msg:string}[], scanned:number, coverage:object}}
 */
export function checkConfigKeys({
  schema, retiredKeys = [], mdFiles = [], hookFiles = [], builderFiles = [], read,
  // Injectable so a test can exercise the LOCATORS against a fixture schema
  // without also having to satisfy the live allowlists. Production callers pass
  // none of these and get the real, shipped lists.
  pending = PENDING_KEYS, notConfig = NOT_CONFIG, blind = BLIND_KEYS,
}) {
  const findings = [];
  const known = schemaKeyNames(schema);
  const containers = containersOf(schema);
  const retired = new Set(retiredKeys);
  const seen = new Map(); // ident -> Set(file)
  let complete = true;
  let scanned = 0;

  const note = (k, f) => { if (!seen.has(k)) seen.set(k, new Set()); seen.get(k).add(f); };

  for (const f of mdFiles) {
    let text;
    try { text = read(f); } catch (e) { complete = false; findings.push({ level: 'FAIL', msg: `config keys: cannot read ${f} (${e.message})` }); continue; }
    scanned++;
    for (const k of tableKeys(text)) note(k, f);
    for (const k of dottedKeys(text, containers)) note(k, f);
    for (const k of configProseKeys(text)) note(k, f);
  }
  const notice = { lines: 0, chars: 0, total: 0 };
  for (const f of hookFiles) {
    let text;
    try { text = read(f); } catch (e) { complete = false; findings.push({ level: 'FAIL', msg: `config keys: cannot read ${f} (${e.message})` }); continue; }
    scanned++;
    const r = noticeKeys(text);
    notice.lines += r.lines; notice.chars += r.chars; notice.total += r.total;
    for (const k of r.keys) note(k, f);
    if (!r.lines) findings.push({ level: 'FAIL', msg: `config keys: the L4 notice locator matched ZERO out.push( sites in ${f} — a locator that finds nothing reports clean, so this is a broken locator, not a clean file` });
  }
  const builder = { literals: 0, files: 0 };
  for (const f of builderFiles) {
    let text;
    try { text = read(f); } catch (e) { complete = false; findings.push({ level: 'FAIL', msg: `config keys: cannot read ${f} (${e.message})` }); continue; }
    scanned++;
    const r = builderKeys(text);
    builder.literals += r.literals; builder.files++;
    for (const k of r.keys) note(k, f);
    if (!r.literals) findings.push({ level: 'FAIL', msg: `config keys: the L5 builder locator matched ZERO string literals in ${f} — a locator that finds nothing reports clean, so this is a broken locator, not a clean file` });
  }

  // PRECONDITION: a schema key the shape rule cannot see must be DECLARED.
  for (const k of known) {
    if (SHAPE.test(k)) continue;
    if (!(k in blind)) findings.push({ level: 'FAIL', msg: `config keys: schema key '${k}' fails KEY_SHAPE and is not declared in BLIND_KEYS — an undeclared blind spot` });
  }
  // Rule 3: a BLIND_KEYS entry that left the schema, or that now matches the shape.
  for (const k of Object.keys(blind)) {
    if (!known.has(k)) findings.push({ level: 'FAIL', msg: `config keys: BLIND_KEYS names '${k}', which is no longer a schema key — drop the entry` });
    else if (SHAPE.test(k)) findings.push({ level: 'FAIL', msg: `config keys: BLIND_KEYS names '${k}', which now matches KEY_SHAPE and is seen normally — drop the entry` });
  }
  // Rule 1: a PENDING key that now resolves.
  for (const k of Object.keys(pending)) {
    if (known.has(k)) findings.push({ level: 'FAIL', msg: `config keys: PENDING_KEYS names '${k}', which now EXISTS in the schema — drop the entry` });
  }
  // Rule 2: a NOT_CONFIG entry no surface mentions any more (gated on a complete scan).
  for (const k of Object.keys(notConfig)) {
    if (seen.has(k)) continue;
    if (complete) findings.push({ level: 'FAIL', msg: `config keys: NOT_CONFIG names '${k}', which no scanned surface mentions any more — drop the entry` });
    else findings.push({ level: 'SKIP', msg: `config keys: NOT_CONFIG '${k}' unmentioned, but the scan was INCOMPLETE — cannot rule it stale` });
  }

  // THE CHECK ITSELF.
  const unknown = [];
  for (const [k, files] of seen) {
    if (known.has(k) || retired.has(k) || k in notConfig || k in pending) continue;
    unknown.push(k);
    findings.push({ level: 'FAIL', msg: `config keys: ship-text names '${k}' as a config key, but no such key exists in the schema — ${[...files].join(', ')}` });
  }

  const blindSkips = Object.entries(blind).map(([k, why]) => ({ level: 'SKIP', msg: `config keys: '${k}' is not detectable by KEY_SHAPE — ${why}` }));
  findings.push(...blindSkips);

  return {
    findings,
    scanned,
    coverage: {
      complete,
      candidates: seen.size,
      resolved: [...seen.keys()].filter((k) => known.has(k)).length,
      retiredSeen: [...seen.keys()].filter((k) => retired.has(k)),
      unknown,
      notice,
      builder,
      blind: Object.keys(blind).length,
    },
  };
}
