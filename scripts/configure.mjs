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
import { projectConfigPath, projectConfigCandidates, globalConfigPath, loadMergedConfig } from './lib/config-load.mjs';

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

function printHelp() {
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
  console.log(lines.join('\n'));
}

/**
 * Parse one raw CLI value against a leaf spec. Returns { value } or { error }.
 * `current` is the value already in the config (used only by bandmap, so a user
 * may name one band without having to retype the other).
 */
// ponytail: 58 lines at declaration — ONE switch over the schema's own type
// space, and the cohesion unit is THAT SPACE, not the line count. Splitting the
// arms into a helper per type would scatter the one property that matters — that
// the CLI parser and the JSON validator cannot drift — across a file per type,
// and a new schema type would then need a new file rather than a new arm. The
// number is HISTORY.
//
// ⚠️ THE SHAPE CLAIM THIS COMMENT FIRST MADE WAS A FALSE UNIVERSAL, and it is
// retracted here rather than reworded away (F-RG-1). It said "Every arm is the
// same three steps (turn one CLI string into a JS value, hand it to
// validateValue, return {value} or {error})". Two of the seven arms are not.
//
// MEASURED over the switch body itself, never read by eye
// (scratchpad/r32/probe-rg1-arms.mjs — it strips comments before matching, so a
// MENTION of validateValue is never counted as a CALL, which is this dispatch's
// own defect class one layer down): 7 arms · 5 CALL validateValue (int|number,
// enum, string, stringList, bandmap) · 1 returns a value WITHOUT it (bool) · 1
// returns only an error (default).
//
// SO THE PROPERTY, STATED OVER THE ARMS THAT ACTUALLY CARRY IT: those five each
// turn one CLI string into a JS value, hand it to validateValue, and return
// {value} or {error} — that is where CLI-vs-JSON drift is possible and where the
// shared call is what closes it. `bool` is the NAMED EXCEPTION and needs no
// call: its own guard rejects everything but the exact strings 'true' and
// 'false', so `raw === 'true'` is a boolean by construction, while
// validateValue's bool branch is `typeof v === 'boolean'` — strictly weaker,
// with nothing left to reject. `default` reaches no value at all. THE CODE IS
// CORRECT AND THE CLAIM WAS NOT: do not "fix" the bool arm by adding a call that
// can only ever pass.
//
// THE COHESION ARGUMENT IS UNCHANGED BY THIS, and bool's exemption is itself an
// argument for it — whether an arm needs the validator is decided by reading it
// beside its six siblings, which a helper-per-type split makes impossible.
//
// FOURTH instance of the wrong-WHY class in this one dispatch, and it sat inside
// the commit written to close the third: a comment whose stated reason the code
// does not support survives every gate this room owns, because nothing
// downstream ever fails when only the reason is wrong.
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
function valueAtPath(obj, segs) {
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

// ponytail: 183 lines at declaration — ONE user-visible transaction, and every
// early return in it is a REFUSAL that must leave the file untouched. Resolve
// the target, read, parse, apply, validate, write, report: splitting it hands
// half the refusals to a helper that cannot return from main, so each one
// becomes a sentinel the caller must re-check — which is precisely how a
// refusal turns into a fall-through, the F-R32-2 defect this file has already
// paid for once. The number is HISTORY, not a live claim.
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
  let readErr = null;
  try {
    let content = fs.readFileSync(cfgPath, 'utf8');
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
    raw = content;
  } catch (err) { readErr = err; }
  // F-R32-2: AN EMPTY CATCH HERE MADE AN UNREADABLE FILE INDISTINGUISHABLE FROM
  // AN ABSENT ONE, and the difference is the user's whole config. On an
  // EPERM/EACCES read of a file that IS there, `raw` stayed null, `cfg` stayed
  // {}, the edits landed on {}, and the write target was STILL that same file
  // (existence and readability are different questions) — so the tool rebuilt a
  // config from nothing over one that was really there, exit 0, "Successfully
  // updated". Measured with a control: three keys in, one key out.
  //
  // IT IS THE SAME CLASS AS ee7975a, this dispatch's own headline commit — a read
  // failure read as absence. There it cost a measurement; here it costs the file.
  // And the file already knew better five lines down: the MALFORMED branch below
  // refuses for exactly this reason, in its own words.
  //
  // KEYED ON err.code, NEVER existsSync (node/runtime.md §7: message text is
  // unstable, the code is Node's own committed identity). ENOENT/ENOTDIR are the
  // only ABSENCE codes — the same pair class-b.mjs carves out at both refusal
  // calls, this room's one absence vocabulary. Anything else means the file is
  // there and we could not read it.
  //
  // THIS IS ALSO THE ANSWER TO THE WRITE-TARGET HALF: rather than reconciling
  // "content came from a failed read" with "target came from existsSync", the
  // state where those two can disagree is REMOVED — a failed read never reaches
  // the write at all.
  if (readErr && readErr.code !== 'ENOENT' && readErr.code !== 'ENOTDIR') {
    console.error(`Error: ${cfgPath} exists but could not be read (${readErr.code || 'UNKNOWN'}). Nothing was written — an unreadable config is not an absent one, and rebuilding it from defaults would destroy every key it holds.`);
    process.exitCode = 1;
    return;
  }
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
      // F-R32-4: consume the next token ONLY when it cannot be a flag of its own.
      // The old unconditional `i++` assumed whatever follows an unknown flag is
      // its VALUE; given `--nosuchkey --language en` it swallowed `--language`
      // and then reported `en` — a token the user typed as a VALUE — as a second
      // unrecognized FLAG, sending the reader at the wrong word.
      if (args[i + 1] !== undefined && !args[i + 1].startsWith('--')) i++;
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

  // THE WRITE HAS ITS OWN try AND NOTHING ELSE IS INSIDE IT. Everything below
  // the write is REPORTING about a file that already exists on disk, and a throw
  // there must never be reported as a write failure. Saying something false
  // about what just happened is the exact class F-R32-3 closed; it must not come
  // back through its own fix.
  //
  // ⚠️ THE TRIGGER THIS COMMENT FIRST NAMED DOES NOT REPRODUCE, and it is
  // retracted here rather than reworded away (F-RR-1). It said "loadMergedConfig
  // lives one line down, an unreadable global config is enough to make it
  // throw". It is not, and nothing else I could build is either.
  // `loadMergedConfig` calls `readJsonc` twice, and `readJsonc` wraps its ENTIRE
  // body — read, BOM strip, parse, shape check — in one try/catch that returns
  // `{ data: {}, unreadable }`; it has no throwing path.
  //
  // MEASURED, ten shapes, all returning normally
  // (scratchpad/r32/probe-rr1-trigger.mjs): a malformed global · a malformed
  // project · a global that is an ARRAY · a DIRECTORY at either config path · a
  // UTF-16 global · an 8 MiB global of junk · a read-DENIED global · a
  // traversal-DENIED project parent · and a valid-config control. The one
  // remaining idea — `process.cwd()` throwing on a deleted cwd, which is the
  // CALLER's expression rather than the loader — is unreachable on this box:
  // Windows refuses to remove a directory that is a live process's cwd (EPERM).
  //
  // SO THE HONEST STATE IS: NO REPRODUCING TRIGGER IS KNOWN, and I am not
  // inventing a second one to replace the first. THE SPLIT STAYS ANYWAY, on the
  // structural reason above rather than on a reachable bug: the guard costs one
  // branch, and the alternative it prevents is a report that LIES about what
  // just happened — telling a user their write failed over a file already on
  // disk. What is NOT claimed: that this catch is provably dead. Ten shapes
  // returned normally; that is not a proof of never.
  //
  // AND THERE IS A SECOND REASON THAT DOES NOT DEPEND ON THAT MEASUREMENT AT
  // ALL (F-RG-2), which matters because the first reason is a claim about
  // TODAY's `readJsonc`: a future edit could give it a throwing path and
  // nothing would send anyone back to re-read this comment. The only call to
  // `loadMergedConfig` below this point sits inside its OWN try, whose catch
  // already degrades to a NAMED unknown ("the file was
  // written, but the merged config could not be re-read to check which values
  // will actually be honoured"). So even if that loader learns to throw
  // tomorrow, it cannot reach this outer catch — and that inner guard was
  // ALREADY IN THE TREE AT 7fd06dd ITSELF, the commit whose own message named
  // the loader as the trigger. The named trigger was false twice over when it
  // was written: the mechanism does not fire, and it was already caught one
  // frame in if it ever did.
  //
  // AND WHY THE RETRACTION IS VISIBLE RATHER THAN A QUIET EDIT: the next reader
  // who trusts a named trigger writes its fixture, watches it pass at both
  // commits, finds no defect, and concludes the split was unnecessary — a wrong
  // WHY that sends the next reader to DELETE a correct fix. Third instance of
  // the wrong-WHY class in this one dispatch (F-R32-1, this, and the return's
  // own wording), and the sharpest: the earlier one mis-described a mechanism
  // that fires, this one named one that cannot.
  try {
    fs.mkdirSync(path.dirname(writePath), { recursive: true });
    fs.writeFileSync(writePath, JSON.stringify(next, null, 2) + '\n', 'utf8');
  } catch (e) {
    console.error(`Error: Failed to write to config file: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  {
    if (hadComments) {
      console.warn('Note: inline comments were stripped (this tool writes plain JSON). Every key stays documented in platform-configs/.coalwash.json.');
    }
    // F-R32-3: SAY WHAT WILL ACTUALLY BE READ. hooks-safety.md §9 clamps every
    // consent-bearing key SAFER-VALUE-WINS on merge, so a PROJECT config may make
    // one quieter but never weaker — and this tool used to write `writeGuard:
    // "off"`, echo it back, and print "Successfully updated" while every reader
    // kept getting `"on"`. The user turned their airbag off, was told it worked,
    // and the airbag stayed on.
    //
    // WARN, NOT REFUSE — the head's ruling, and the reasons are worth keeping
    // beside the code: the clamp is a READ-side security property rather than a
    // write-side prohibition, so refusing would turn a rail that protects the
    // user into one that blocks them; a project value is legitimately meaningful
    // the moment their global stance changes; and §9's own recorded residual is
    // that an honest write and a hostile one are BYTE-IDENTICAL, so refusing
    // would punish the honest one for no security gain.
    //
    // The comparison is against the LOADER's own merged read, never a
    // re-derivation of the clamp here — one implementation, and it answers the
    // only question that matters: what will a reader get?
    let clamped = [];
    try {
      const effective = loadMergedConfig({ cwd: process.cwd() });
      clamped = edits
        .map((e) => ({ key: e.segs.join('.'), wrote: e.value, reads: valueAtPath(effective, e.segs) }))
        .filter((x) => JSON.stringify(x.wrote) !== JSON.stringify(x.reads));
    } catch (e) {
      // Degrade to a NAMED unknown, never to silence and never to a false
      // success: the write happened, and we simply cannot say which values a
      // reader will honour.
      console.warn(`Note: the file was written, but the merged config could not be re-read to check which values will actually be honoured (${e.message}).`);
    }

    if (clamped.length) {
      console.log(`Wrote ${writePath} — but see the warning below.`);
    } else {
      console.log(`Successfully updated configuration in: ${writePath}`);
    }
    console.log(JSON.stringify(next, null, 2));
    for (const c of clamped) {
      console.warn(`\nWarning: ${c.key} will NOT be read at the value you set.`);
      console.warn(`  written: ${JSON.stringify(c.wrote)}    every read returns: ${JSON.stringify(c.reads)}`);
      console.warn('  A consent-bearing key merges SAFER-VALUE-WINS (hooks-safety.md §9): a project');
      console.warn('  config may make it quieter, never weaker, because a cloned repo ships a project');
      console.warn('  config and its bytes are indistinguishable from yours.');
      console.warn(`  To make this take effect, set it on the GLOBAL layer instead:`);
      console.warn(`      node scripts/configure.mjs --global --${c.key} ${typeof c.wrote === 'string' ? c.wrote : JSON.stringify(c.wrote)}`);
    }
  }
}

// RUN ONLY AS THE ENTRY POINT. The test file imports flattenSchema/parseValue/
// setPath/firstWriteTarget to exercise them directly; without this guard that
// import would execute main() against the TEST RUNNER's argv. Every sibling's
// configure.mjs calls main() unconditionally because nothing imports one — ours
// is imported, so it needs the guard.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
