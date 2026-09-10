// CoalWash configurator — edit .coalwash.json from the command line.
// Flags, parsing, validation and help all derive from ONE table
// (scripts/lib/config-schema.mjs, the same one verify.mjs and every runtime
// read use): a key added there is automatically settable, validated and
// documented here, with no second list to keep in step.
//
// CWK-023 — CoalWash is the SEVENTH adopter of the flock's configure.mjs
// standard (config is system #1 of the 5 Standard Systems, and a program whose
// tunables are settable only by hand-editing JSON is missing it). Ported from
// CoalLedger's 94e994f (the gated shape) plus CoalHearth's 6c0ccc3 (the dotted
// flag ruling) and CoalFace's generated-help shape. Same SHAPE, not a
// re-derivation from description. Adaptations from those files, each NAMED with
// its reason per one-flock consequence (2):
//
//   - THE FLATTENER IS OURS, and it had to be. CoalHearth's is the only sibling
//     with a nested schema and it is hard-wired to DEPTH 2 over an
//     object-of-objects (`Object.entries(CONFIG_SCHEMA)`, one nested loop).
//     Ours is an ARRAY of `{key, type, …}` specs whose nesting lives in
//     `fields`, and it reaches DEPTH 3 (`estate.digCrush.singleFileTok`) —
//     the first three-level key in the flock. So `flattenSchema` recurses on
//     `fields` instead of looping twice. Inheriting the exemplar's splitter
//     would have silently produced flags for `estate.digCrush` (an object) and
//     none at all for the three leaves under it.
//
//   - FLAG NAMING follows CoalHearth's ruling VERBATIM: a flag is the DOTTED
//     key exactly as the schema spells it (`--estate.digCrush.pileTok`,
//     `--retier.armPct`, bare `--language`). A flat `--pileTok` would be a
//     SECOND user-visible spelling of a key `scripts/config-keys.mjs` tracks
//     dotted — this room's own config-key drift gate — so the flat form is not
//     a style choice, it is a defect.
//
//   - `process.exitCode` + a natural return, NEVER `process.exit()`. Every
//     sibling's configure.mjs calls `process.exit()`; ours may not.
//     `node/runtime.md` §7 is explicit that `process.exit()` truncates pending
//     stdout writes, and CWK-071 swept this room for the class in r31 — a fresh
//     file reintroducing it would undo that sweep on its first day.
//
//   - THE ROOT WALK IS IMPORTED, never forked (`findProjectRoot`,
//     `projectConfigPath`, `projectConfigCandidates`, `globalConfigPath`). A
//     second root derivation is the twin-drift law's own failure shape and this
//     room has paid for it; the write target must land where the reader looks.
//
//   - NO LEGACY-LOCATION MIGRATION, deliberately, and it is a real divergence
//     from CoalLedger/CoalMine. Their configure.mjs MOVES a config found at the
//     legacy root path into an agent dir and DELETES the old file. Ours writes
//     back exactly where the config was found, legacy path included.
//     `config-load.mjs`'s own namespace-campaign header scopes this room to the
//     READ side ("CoalWash has NO project-config WRITER … so 'move on write'
//     has no code path to hook here"); a migrate-and-delete is a destructive
//     step that deserves its own unit and its own INSPECT, not a rider on the
//     CLI's first landing. Writing back to a legacy file that already exists
//     breaks nothing — the loader reads it at step 3 regardless.
//
//   - THE FIRST-WRITE HOME IS DERIVED FROM THE LOADER'S OWN CANDIDATE LIST, not
//     from a local copy of the agent-dir order. When no config exists anywhere,
//     `projectConfigPath` returns candidate[0] — a bare `.claude/…` even in a
//     project that only has `.agents/`. CoalLedger fixed that class with an
//     `ownDirDefault` helper we do not have; rather than fork the order into a
//     second source of truth, `firstWriteTarget` walks `projectConfigCandidates`
//     (exported, ordered, the loader's own) and takes the first whose agent dir
//     ALREADY exists on disk, falling back to candidate[0] exactly as the
//     loader does. No new constant, no second order to drift.
//
//   - A RETIRED KEY IS REFUSED, NOT WRITTEN. `RETIRED_KEYS` (`forceMode`) is
//     read-TOLERATED by the loader and read by nothing, so accepting
//     `--forceMode` would write a key that cannot ever take effect — a
//     consumer-less key, which this room's own schema header bans. The refusal
//     NAMES the retirement instead of falling through to a generic
//     "unrecognized option", because the two need different fixes. A retired
//     key already SITTING in the file is left untouched: the whole parsed
//     object is written back, so read-tolerated stays read-tolerated.
//
//   - `node/runtime.md` §1 does NOT bind this file and its static imports are
//     therefore correct. §1 binds a GATE — a file with an enumerate-and-report
//     contract (verify.mjs, consistency.mjs) — and names configure.mjs BY NAME
//     as out of scope. A crash here is an honest stack trace, not a gate faking
//     a clean run.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONFIG_SCHEMA, RETIRED_KEYS, validateValue, validateConfig } from './lib/config-schema.mjs';
import { parseJsonc } from './lib/jsonc.mjs';
import { projectConfigPath, projectConfigCandidates, globalConfigPath } from './lib/config-load.mjs';

// Prototype-pollution guard. `parseJsonc` already drops these at PARSE (so a
// poisoned file on disk cannot reach us), and the flag map is built from the
// schema so no `--__proto__` flag can exist in the first place. This set is the
// third, defensive layer at the WRITE point: a path segment that could poison
// Object.prototype is refused rather than assigned, so the guarantee does not
// depend on the other two staying correct.
const PROTO_GUARD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Flatten the schema to one row per SETTABLE leaf, in schema order.
 * `object` specs are containers: they emit a group row (help only, never a
 * flag) and recurse into `fields`. Everything else — including `bandmap` and
 * `stringList`, whose VALUES are structured but which the schema treats as one
 * key — is a leaf. Recursion, not two nested loops: this room reaches depth 3.
 */
export function flattenSchema(schema) {
  const rows = [];
  const walk = (spec, segs) => {
    const flagKey = segs.join('.');
    if (spec.type === 'object') {
      rows.push({ kind: 'group', flagKey, segs, spec });
      for (const [k, sub] of Object.entries(spec.fields)) walk(sub, [...segs, k]);
      return;
    }
    rows.push({ kind: 'leaf', flagKey, segs, spec, help: spec.help || describe(spec) });
  };
  for (const spec of schema) walk(spec, [spec.key]);
  return rows;
}

/** A leaf's own type/bounds/default, for a nested field that carries no help of its own. */
function describe(spec) {
  const bits = [spec.type];
  if (spec.values && Array.isArray(spec.values)) bits.push(spec.values.join('|'));
  if (spec.min != null || spec.max != null) bits.push(`${spec.min ?? ''}-${spec.max ?? ''}`);
  return `${bits.join(' ')} (default ${JSON.stringify(spec.def)})`;
}

const ROWS = flattenSchema(CONFIG_SCHEMA);
const LEAVES = ROWS.filter((r) => r.kind === 'leaf');
// The widest flag today is --estate.runBudget.maxSessionsPerRun (35 chars).
const PAD = 2 + Math.max(...LEAVES.map((r) => r.flagKey.length + 2), 10);

export function printHelp(log = console.log) {
  const lines = [
    'CoalWash Configurator Utility',
    'Usage: node scripts/configure.mjs [options]',
    '',
    'Options:',
  ];
  for (const row of ROWS) {
    if (row.kind === 'group') {
      // A container prints its help ONCE, above its own leaves. A nested
      // container with no help of its own (estate.digCrush, estate.runBudget)
      // prints nothing rather than repeating its parent's paragraph — the
      // leaves under it carry their own derived type/bounds line.
      if (!row.spec.help) continue;
      lines.push('');
      lines.push(`  ${row.flagKey}.* — ${row.spec.help}`);
      continue;
    }
    lines.push(`  ${('--' + row.flagKey).padEnd(PAD)} ${row.help}`);
  }
  lines.push('');
  lines.push(`  ${'--global'.padEnd(PAD)} Write ~/.claude/.coalwash.json (the global layer) instead of the project config`);
  lines.push(`  ${'--help, -h'.padEnd(PAD)} Show this help message`);
  lines.push('');
  lines.push('Value forms:');
  lines.push('  stringList   comma-separated; pass "" to clear the list');
  lines.push('  bandmap      comma-separated band=value pairs, e.g. obese=quick,full=full (unnamed bands keep their current value)');
  lines.push('');
  lines.push('Examples:');
  lines.push('  node scripts/configure.mjs --coalwashMode manual --language th');
  lines.push('  node scripts/configure.mjs --estate.digCrush.pileTok 60000');
  lines.push('  node scripts/configure.mjs --global --updateMode auto');
  log(lines.join('\n'));
}

/**
 * Parse one raw CLI value against a leaf spec. Returns { value } or { error }.
 * `current` is the value already in the config (used only by bandmap, so a user
 * may name one band without having to retype the other).
 */
export function parseValue(flagKey, spec, raw, current) {
  if (raw === undefined) return { error: `${flagKey} needs a value` };
  switch (spec.type) {
    case 'bool':
      if (raw !== 'true' && raw !== 'false') return { error: `${flagKey} needs true or false` };
      return { value: raw === 'true' };
    case 'int':
    case 'number': {
      // Number() (not parseInt) so a float like "5.9" or a garbage tail like
      // "50abc" is REJECTED rather than silently truncated to 5/50.
      // validateValue then enforces int-ness and min/max — the SAME check
      // verify.mjs runs on the JSON value, so the CLI parser and the JSON
      // validator cannot drift apart.
      const n = Number(raw);
      const err = validateValue(spec, n);
      if (err) return { error: `${flagKey} ${err}` };
      return { value: n };
    }
    case 'enum': {
      const v = raw.toLowerCase();
      const err = validateValue(spec, v);
      if (err) return { error: `${flagKey} ${err}` };
      return { value: v };
    }
    case 'string': {
      const err = validateValue(spec, raw);
      if (err) return { error: `${flagKey} ${err}` };
      return { value: raw };
    }
    case 'stringList': {
      if (raw === '' || raw === '""') return { value: [] };
      const items = raw.split(',').map((s) => s.trim()).filter(Boolean);
      const err = validateValue(spec, items);
      if (err) return { error: `${flagKey} ${err}` };
      return { value: items };
    }
    case 'bandmap': {
      // A bandmap is ONE key whose value is a per-band map, and validateValue
      // requires EVERY band present — so the pairs are laid over the value
      // already in force (the file's, else the factory default) rather than
      // replacing it. Naming one band therefore leaves the other alone instead
      // of failing validation for a band the user never mentioned.
      const base = (current && typeof current === 'object' && !Array.isArray(current)) ? { ...current } : { ...spec.def };
      for (const pair of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
        const eq = pair.indexOf('=');
        if (eq < 1) return { error: `${flagKey} needs band=value pairs (e.g. ${Object.keys(spec.def).map((k) => `${k}=${spec.def[k]}`).join(',')})` };
        const band = pair.slice(0, eq).trim();
        if (!(band in spec.def)) return { error: `${flagKey} has no band '${band}' (bands: ${Object.keys(spec.def).join(', ')})` };
        base[band] = pair.slice(eq + 1).trim().toLowerCase();
      }
      const err = validateValue(spec, base);
      if (err) return { error: `${flagKey} ${err}` };
      return { value: base };
    }
    default:
      return { error: `internal: unknown spec type '${spec.type}'` };
  }
}

/** Read the value currently at a dotted path (undefined when any hop is absent). */
export function valueAtPath(obj, segs) {
  let cur = obj;
  for (const s of segs) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[s];
  }
  return cur;
}

/**
 * Write a value at a dotted path, creating plain intermediate objects and
 * PRESERVING every sibling already present. Throws on a prototype-poisoning
 * segment — unreachable through the schema-built flag map, and asserted anyway.
 */
export function setPath(obj, segs, value) {
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i];
    if (PROTO_GUARD_KEYS.has(s)) throw new Error(`refusing to write through '${s}'`);
    if (!cur[s] || typeof cur[s] !== 'object' || Array.isArray(cur[s])) cur[s] = {};
    cur = cur[s];
  }
  const last = segs[segs.length - 1];
  if (PROTO_GUARD_KEYS.has(last)) throw new Error(`refusing to write '${last}'`);
  cur[last] = value;
  return obj;
}

/**
 * Where a first-ever write lands. `projectConfigPath` returns candidate[0] when
 * nothing exists yet, which plants `.claude/` even in a project that only has
 * `.agents/`. Walk the loader's OWN ordered candidate list and take the first
 * whose agent dir already exists; fall back to candidate[0] exactly as the
 * loader does. Derived from the loader's list, never a second copy of the order.
 */
export function firstWriteTarget(cwd, home) {
  const candidates = projectConfigCandidates(cwd, home);
  for (const c of candidates) {
    // An agent-dir candidate is <root>/<agentDir>/coal/coalwash.json. The LEGACY
    // root dotfile is in the same list and is recognised by NOT sitting under a
    // `coal` dir — skipped here, because its parent is the project root, which
    // always exists, so a naive existence test would hand every first write to
    // the legacy location. It stays reachable only as candidates[0]'s fallback,
    // which is what the loader itself returns.
    if (path.basename(path.dirname(c)) !== 'coal') continue;
    if (fs.existsSync(path.dirname(path.dirname(c)))) return c;
  }
  return candidates[0];
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  const globalIdx = args.indexOf('--global');
  const isGlobal = globalIdx !== -1;
  if (isGlobal) args.splice(globalIdx, 1);

  const found = isGlobal ? globalConfigPath() : projectConfigPath(process.cwd());
  // The READ path is where the loader looks. The WRITE path is the same file
  // when one exists, else the first-write home above. `projectConfigPath`
  // already returns candidate[0] on a miss, so "exists" is the discriminator.
  const cfgPath = found;
  const writePath = isGlobal ? found : (fs.existsSync(found) ? found : firstWriteTarget(process.cwd()));

  let cfg = {};
  let hadComments = false;
  let raw = null;
  // One read via try/catch, no existsSync precheck — no check-to-use gap. BOM
  // stripped via charCodeAt, this room's own established shape (never a typed
  // U+FEFF literal: a raw BOM pasted into source gets converted by the tool
  // layer, a hazard this room has paid for more than once).
  try {
    let content = fs.readFileSync(cfgPath, 'utf8');
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
    raw = content;
  } catch {}
  if (raw !== null) {
    hadComments = raw.includes('//');
    try {
      cfg = parseJsonc(raw) || {}; // proto-pollution-guarded parse (jsonc.mjs)
    } catch (e) {
      // A malformed config is a FAILURE the user must see, and it is also the
      // one case where refusing is strictly better than the siblings' rebuild:
      // overwriting an unparseable file destroys whatever the user meant to
      // write there, and this tool's whole contract below is "invalid input
      // changes nothing on disk". So: report, leave the file byte-identical,
      // exit non-zero.
      console.error(`Error: ${cfgPath} is not valid JSON/JSONC (${e.message}). Nothing was written — fix or remove the file and re-run.`);
      process.exitCode = 1;
      return;
    }
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    console.error(`Error: ${cfgPath} does not hold a JSON object. Nothing was written.`);
    process.exitCode = 1;
    return;
  }

  const byFlag = new Map(LEAVES.map((r) => ['--' + r.flagKey, r]));
  const retired = new Set(RETIRED_KEYS);

  // PARSE EVERYTHING FIRST, WRITE NOTHING YET. Any error at all leaves the file
  // byte-identical — a half-applied config is worse than a rejected one.
  const errors = [];
  const edits = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const row = byFlag.get(flag);
    if (!row) {
      const bare = flag.replace(/^--/, '');
      if (retired.has(bare)) {
        errors.push(`'${bare}' is a RETIRED key — read-tolerated for an existing config, but nothing reads it, so setting it would have no effect. Refusing to write a key with no consumer.`);
      } else {
        errors.push(`Unrecognized option '${flag}' (run --help for every flag)`);
      }
      i++; // skip whatever followed it; it was never a value we understood
      continue;
    }
    const parsed = parseValue(row.flagKey, row.spec, args[++i], valueAtPath(cfg, row.segs));
    if (parsed.error) { errors.push(parsed.error); continue; }
    edits.push({ segs: row.segs, value: parsed.value });
  }

  if (!edits.length && !errors.length) {
    console.error('Error: nothing to set (run --help for every flag)');
    process.exitCode = 1;
    return;
  }

  // Apply to a CLONE, then validate the whole result through the schema's own
  // validator — one implementation, never a second validator here.
  const next = JSON.parse(JSON.stringify(cfg));
  if (!errors.length) {
    for (const e of edits) {
      try { setPath(next, e.segs, e.value); } catch (err) { errors.push(err.message); }
    }
  }
  if (!errors.length) errors.push(...validateConfig(next));

  if (errors.length) {
    for (const e of errors) console.error(`Error: ${e}`);
    console.error('Nothing was written.');
    process.exitCode = 1;
    return;
  }

  try {
    fs.mkdirSync(path.dirname(writePath), { recursive: true });
    fs.writeFileSync(writePath, JSON.stringify(next, null, 2) + '\n', 'utf8');
    if (hadComments) {
      console.warn('Note: inline comments were stripped (this tool writes plain JSON). Every key stays documented in platform-configs/.coalwash.json.');
    }
    console.log(`Successfully updated configuration in: ${writePath}`);
    console.log(JSON.stringify(next, null, 2));
  } catch (e) {
    console.error(`Error: Failed to write to config file: ${e.message}`);
    process.exitCode = 1;
  }
}

// RUN ONLY AS THE ENTRY POINT. The test file imports flattenSchema/parseValue/
// setPath/firstWriteTarget to exercise them directly; without this guard that
// import would execute main() against the TEST RUNNER's argv. Every sibling's
// configure.mjs calls main() unconditionally because nothing imports one — ours
// is imported, so it needs the guard.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
