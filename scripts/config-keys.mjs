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
// one hook locator, measured together at 1 false positive, not 72:
//   L1 TABLE   -- the first cell of a markdown table row (our README key table)
//   L2 DOTTED  -- `container.leaf` where container is a known object/bandmap key
//   L3 CONFIG  -- a backticked ident on a line naming .coalwash.json, or under a
//                 heading whose text contains "Configure"
//   L4 NOTICE  -- a string literal inside an out.push(...) call in the conductor
//
// L4 REPLACES the exemplar's noticeRegion(text, 'TRANSLATIONS'). We have NO
// such block -- our conductor's top-level consts are numbers and Sets. Ported
// literally, noticeRegion would find start === -1, return '', scan zero bytes
// and report clean. That is the exact failure the first adopter hit. An
// out.push(...) call is self-delimiting, so it has no end sentinel to overrun.

const SHAPE = /^[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*$/;
const TICK = String.fromCharCode(96);
const BACKTICKED = TICK + '([A-Za-z][A-Za-z0-9_.]*)' + TICK;
// A dotted token ending in a file extension is a MODULE, never a key path
// (`retier.mjs` is the live example this exists for).
const FILE_EXT = /\.(mjs|cjs|js|json|md|yml|yaml|ps1|sh|txt)$/;
// A `${...}` interpolation inside a notice template literal. Built from char
// codes rather than written inline: this room's own recorded hazard is that a
// backslash-escaped regex does not survive a bash heredoc, and it bit twice
// while writing this file.
const INTERP = /\$\{[^}]*\}/g;

/** Keys documented before they exist. Rule 1: an entry that now RESOLVES fails. */
export const PENDING_KEYS = Object.freeze({});

/**
 * Identifiers a locator reaches that are not config keys. Rule 2: an entry no
 * surface mentions any more fails as stale. Every entry states WHY it lands in
 * a config locator at all -- a bare string here would be a bypass with no author.
 */
export const NOT_CONFIG = Object.freeze({
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

/**
 * @returns {{findings: {level:'FAIL'|'SKIP', msg:string}[], scanned:number, coverage:object}}
 */
export function checkConfigKeys({
  schema, retiredKeys = [], mdFiles = [], hookFiles = [], read,
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
    if (!r.lines) findings.push({ level: 'FAIL', msg: `config keys: the notice locator matched ZERO out.push( sites in ${f} — a locator that finds nothing reports clean, so this is a broken locator, not a clean file` });
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
      blind: Object.keys(blind).length,
    },
  };
}
