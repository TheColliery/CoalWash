// CWK-023 — the config CLI, hermetically. Every cell that touches the filesystem
// SPAWNS THE REAL FILE as a child with HOME/USERPROFILE and TEMP pointed at a
// throwaway tree, and asserts the exit code AND the state effect on disk. A
// configurator is a WRITER: an assertion about its stdout proves nothing about
// the file it was supposed to leave alone.
//
// THE CENTRAL PROPERTY, and the one the order made a requirement rather than a
// nicety: INVALID INPUT LEAVES THE FILE BYTE-IDENTICAL. It is proven with a
// sha256 taken before and after the failing run — never by reading the file back
// and eyeballing it, which cannot tell "unchanged" from "rewritten identically
// enough to look unchanged".
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONFIG_SCHEMA } from './lib/config-schema.mjs';
import { flattenSchema, setPath, parseValue, firstWriteTarget } from './configure.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIGURE = path.join(HERE, 'configure.mjs');
const LEAVES = flattenSchema(CONFIG_SCHEMA).filter((r) => r.kind === 'leaf');

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/**
 * A throwaway HOME + a project root the loader will actually anchor on (CLAUDE.md
 * is one of config-load.mjs's own ROOT_MARKERS). Cleanup is registered the line
 * after allocation, before anything that can throw (scripts-quality.md §2).
 */
function sandbox(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-configure-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const proj = path.join(root, 'proj');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'CLAUDE.md'), '# fixture project\n');
  return { root, home, proj };
}

function run(sb, args) {
  return spawnSync(process.execPath, [CONFIGURE, ...args], {
    cwd: sb.proj,
    encoding: 'utf8',
    env: { ...process.env, HOME: sb.home, USERPROFILE: sb.home, TEMP: sb.root, TMP: sb.root, TMPDIR: sb.root, CLAUDE_CONFIG_DIR: '' },
  });
}

const projCfg = (sb) => path.join(sb.proj, '.claude', 'coal', 'coalwash.json');

// ---------------------------------------------------------------- flattener

test('CWK-023: every schema LEAF gets a flag and no CONTAINER does — counted by an independent walk', () => {
  // Non-circular on purpose: this walk is written here, separately from
  // flattenSchema, over the same schema. Two implementations agreeing is a
  // differential; flattenSchema agreeing with itself would be nothing.
  let leaves = 0;
  const containers = [];
  const walk = (spec, name) => {
    if (spec.type === 'object') {
      containers.push(name);
      for (const [k, sub] of Object.entries(spec.fields)) walk(sub, `${name}.${k}`);
      return;
    }
    leaves++;
  };
  for (const s of CONFIG_SCHEMA) walk(s, s.key);

  assert.strictEqual(LEAVES.length, leaves, 'flattenSchema must emit exactly one row per settable leaf');
  const flags = new Set(LEAVES.map((r) => r.flagKey));
  for (const c of containers) assert.ok(!flags.has(c), `a container is not settable: ${c}`);
  assert.ok(containers.length >= 4, `the schema has nested containers to skip (found ${containers.length})`);
});

test("CWK-023: the DOTTED spelling is verbatim, including this room's DEPTH-3 keys", () => {
  const flags = new Set(LEAVES.map((r) => r.flagKey));
  // CoalHearth's 6c0ccc3 ruling: the flag IS the key. A flat `--pileTok` would be
  // a second user-visible spelling of a key config-keys.mjs tracks dotted.
  for (const k of [
    'language',
    'retier.armPct',
    'estate.deleteCold',
    'estate.digCrush.singleFileTok',
    'estate.digCrush.pileTok',
    'estate.digCrush.fileCount',
    'estate.runBudget.maxSessionsPerRun',
    'estate.runBudget.maxBytesPerRun',
  ]) assert.ok(flags.has(k), `missing dotted flag --${k}`);
  // The depth-2 exemplar's splitter would have produced these instead.
  for (const k of ['singleFileTok', 'pileTok', 'digCrush', 'runBudget']) {
    assert.ok(!flags.has(k), `a bare/undotted spelling leaked into the flag set: --${k}`);
  }
});

// ------------------------------------------------------------- proto guard

test('CWK-023: setPath REFUSES a prototype-poisoning segment at either depth', () => {
  for (const segs of [['__proto__'], ['estate', '__proto__'], ['constructor'], ['a', 'prototype']]) {
    assert.throws(() => setPath({}, segs, 1), /refusing to write/, segs.join('.'));
  }
  assert.strictEqual({}.polluted, undefined, 'Object.prototype must be untouched');
});

// ------------------------------------------------------------------ values

test('CWK-023: a bandmap flag may name ONE band and the other keeps its value', () => {
  const spec = CONFIG_SCHEMA.find((s) => s.key === 'exercisePerBand');
  const r = parseValue('exercisePerBand', spec, 'full=quick', { obese: 'quick', full: 'full' });
  assert.deepStrictEqual(r.value, { obese: 'quick', full: 'quick' });
  // A band the schema does not declare is refused, not silently written.
  assert.match(parseValue('exercisePerBand', spec, 'lean=quick', undefined).error || '', /no band 'lean'/);
});

test('CWK-023: a stringList clears with "" and rejects nothing else silently', () => {
  const spec = CONFIG_SCHEMA.find((s) => s.key === 'managedPaths');
  assert.deepStrictEqual(parseValue('managedPaths', spec, '', undefined).value, []);
  assert.deepStrictEqual(parseValue('managedPaths', spec, 'a/b, c/d', undefined).value, ['a/b', 'c/d']);
});

// ------------------------------------------------------- first-write target

test('CWK-023: a first write lands in an agent dir the project ALREADY has, never a planted .claude', (t) => {
  const sb = sandbox(t);
  fs.mkdirSync(path.join(sb.proj, '.agents'), { recursive: true });
  const target = firstWriteTarget(sb.proj, sb.home);
  assert.ok(target.includes(`.agents${path.sep}coal`), `expected the existing .agents dir, got ${target}`);
  // With no agent dir at all, the loader's own candidate[0] is the answer.
  const bare = path.join(sb.root, 'bare');
  fs.mkdirSync(bare, { recursive: true });
  fs.writeFileSync(path.join(bare, 'CLAUDE.md'), '#\n');
  assert.ok(firstWriteTarget(bare, sb.home).includes(`.claude${path.sep}coal`));
});

// ----------------------------------------------------------------- the CLI

test('CWK-023: --help exits 0, is generated from the schema, and names --global', (t) => {
  const sb = sandbox(t);
  const r = run(sb, ['--help']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /--estate\.digCrush\.pileTok/, 'a depth-3 flag must appear in the generated help');
  assert.match(r.stdout, /--global/);
  assert.ok(!fs.existsSync(projCfg(sb)), '--help must write nothing');
});

test('CWK-023: a DEPTH-3 set writes only that path and leaves its siblings absent', (t) => {
  const sb = sandbox(t);
  const r = run(sb, ['--estate.digCrush.pileTok', '60000']);
  assert.strictEqual(r.status, 0, r.stderr);
  const cfg = JSON.parse(fs.readFileSync(projCfg(sb), 'utf8'));
  assert.deepStrictEqual(cfg, { estate: { digCrush: { pileTok: 60000 } } },
    'a minimal write, not a materialized default tree — clampedRead fills the rest at read time');
});

test('CWK-023: a set PRESERVES the sibling keys already in the file', (t) => {
  const sb = sandbox(t);
  fs.mkdirSync(path.dirname(projCfg(sb)), { recursive: true });
  fs.writeFileSync(projCfg(sb), JSON.stringify({ language: 'th', estate: { deleteCold: false, digCrush: { fileCount: 9 } } }, null, 2) + '\n');
  const r = run(sb, ['--estate.digCrush.pileTok', '60000']);
  assert.strictEqual(r.status, 0, r.stderr);
  const cfg = JSON.parse(fs.readFileSync(projCfg(sb), 'utf8'));
  assert.strictEqual(cfg.language, 'th');
  assert.strictEqual(cfg.estate.deleteCold, false);
  assert.strictEqual(cfg.estate.digCrush.fileCount, 9, 'a sibling under the same nested block must survive');
  assert.strictEqual(cfg.estate.digCrush.pileTok, 60000);
});

test('CWK-023: an OUT-OF-RANGE value exits non-zero and leaves the file BYTE-IDENTICAL', (t) => {
  const sb = sandbox(t);
  fs.mkdirSync(path.dirname(projCfg(sb)), { recursive: true });
  fs.writeFileSync(projCfg(sb), JSON.stringify({ language: 'th' }, null, 2) + '\n');
  const before = sha(projCfg(sb));
  // 300000 is past estate.digCrush.pileTok's own max (200000).
  const r = run(sb, ['--estate.digCrush.pileTok', '300000']);
  assert.notStrictEqual(r.status, 0, `invalid input must exit non-zero\n${r.stdout}`);
  assert.match(r.stderr, /Nothing was written/);
  assert.strictEqual(sha(projCfg(sb)), before, 'the config must be byte-identical after a rejected run');
});

test('CWK-023: one bad flag in a multi-flag run rejects the WHOLE run — no half-applied config', (t) => {
  const sb = sandbox(t);
  fs.mkdirSync(path.dirname(projCfg(sb)), { recursive: true });
  fs.writeFileSync(projCfg(sb), JSON.stringify({ language: 'th' }, null, 2) + '\n');
  const before = sha(projCfg(sb));
  const r = run(sb, ['--quickVsFull', 'full', '--updateCheckDays', '9999']);
  assert.notStrictEqual(r.status, 0, r.stdout);
  assert.strictEqual(sha(projCfg(sb)), before, 'the VALID half of the run must not land either');
});

test('CWK-023: an unrecognized flag exits non-zero and writes nothing at all', (t) => {
  const sb = sandbox(t);
  const r = run(sb, ['--noSuchKey', 'x']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /Unrecognized option/);
  assert.ok(!fs.existsSync(projCfg(sb)), 'a rejected run must not create a config file');
});

test('CWK-023: a RETIRED key is refused BY NAME, and an existing one in the file survives a write', (t) => {
  const sb = sandbox(t);
  fs.mkdirSync(path.dirname(projCfg(sb)), { recursive: true });
  fs.writeFileSync(projCfg(sb), JSON.stringify({ forceMode: 'off' }, null, 2) + '\n');
  const before = sha(projCfg(sb));

  const refused = run(sb, ['--forceMode', 'off']);
  assert.notStrictEqual(refused.status, 0);
  assert.match(refused.stderr, /RETIRED key/, 'the refusal must name the retirement, not read as an unknown flag');
  assert.strictEqual(sha(projCfg(sb)), before);

  // Read-tolerated means read-tolerated: a legacy key already on disk is written
  // back untouched rather than being dropped by the tool that refuses to SET it.
  const ok = run(sb, ['--language', 'en']);
  assert.strictEqual(ok.status, 0, ok.stderr);
  const cfg = JSON.parse(fs.readFileSync(projCfg(sb), 'utf8'));
  assert.strictEqual(cfg.forceMode, 'off');
  assert.strictEqual(cfg.language, 'en');
});

test('CWK-023: --global writes the global layer where the LOADER looks for it', (t) => {
  const sb = sandbox(t);
  const r = run(sb, ['--global', '--updateMode', 'auto']);
  assert.strictEqual(r.status, 0, r.stderr);
  const g = path.join(sb.home, '.claude', '.coalwash.json');
  assert.ok(fs.existsSync(g), `expected the global config at ${g}`);
  assert.strictEqual(JSON.parse(fs.readFileSync(g, 'utf8')).updateMode, 'auto');
  assert.ok(!fs.existsSync(projCfg(sb)), '--global must not also write the project layer');
});

test('CWK-023: a MALFORMED existing config is reported, never silently overwritten', (t) => {
  const sb = sandbox(t);
  fs.mkdirSync(path.dirname(projCfg(sb)), { recursive: true });
  fs.writeFileSync(projCfg(sb), '{ this is not json\n');
  const before = sha(projCfg(sb));
  const r = run(sb, ['--language', 'en']);
  assert.notStrictEqual(r.status, 0);
  assert.strictEqual(sha(projCfg(sb)), before, 'refusing beats rebuilding: the user’s bytes are still there to fix');
});

// ---------------------------------------------------------------------------
// r32 FINDINGS-BACK — F-R32-2 [HIGH] and F-R32-4 [LOW].
// ---------------------------------------------------------------------------

// Deny a FILE's CONTENT while its PATH still resolves. Same capability the
// (a)-fork cell needs in class-b.test.mjs, and deliberately NOT imported from
// there: a test helper crossing test files is a shared fixture with two owners,
// and this one has to live where the CLI's own cells are. The acceptance test is
// both halves — the read must throw AND the path must still exist — because a
// helper that also broke the path would be testing a different finding.
//
// (RD) alone, never (RX): (RX) removes Read AND Execute and takes resolution
// down with it, which is the state this finding is NOT about.
function makeUnreadableFile(target) {
  const attempts = [
    () => { const m = fs.statSync(target).mode; fs.chmodSync(target, 0o000); return () => { try { fs.chmodSync(target, m); } catch { /* best effort */ } }; },
    () => {
      const who = process.env.USERNAME || process.env.USER || '';
      if (!who) return null;
      spawnSync('icacls', [target, '/deny', who + ':(RD)'], { stdio: 'ignore' });
      return () => { try { spawnSync('icacls', [target, '/remove:d', who], { stdio: 'ignore' }); } catch { /* best effort */ } };
    },
  ];
  for (const attempt of attempts) {
    let restore = null;
    try { restore = attempt(); } catch { restore = null; }
    if (!restore) continue;
    let threw = false;
    try { fs.readFileSync(target, 'utf8'); } catch { threw = true; }
    if (threw && fs.existsSync(target)) return restore;
    restore();
  }
  return null;
}

test('F-R32-2: an UNREADABLE existing config is REFUSED, never rebuilt from nothing over the top of it', (t) => {
  const sb = sandbox(t);
  let restore = null;
  try {
    // Probe FIRST, on a throwaway, before any assertion (ONE SKIPPABLE LEG).
    const probe = path.join(sb.proj, 'probe-deny.json');
    fs.writeFileSync(probe, '{}');
    const probeUndo = makeUnreadableFile(probe);
    if (!probeUndo) {
      t.skip('this volume/account cannot deny a FILE READ while leaving the file present — the arm would be vacuous');
      return;
    }
    probeUndo();

    const cfgFile = projCfg(sb);
    fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
    const original = JSON.stringify({ fileMaxSizeKb: 40, language: 'th', quickVsFull: 'full' }, null, 2) + '\n';

    // CONTROL — the identical command on a READABLE config keeps every key.
    fs.writeFileSync(cfgFile, original);
    const okRun = run(sb, ['--updateCheckDays', '30']);
    assert.strictEqual(okRun.status, 0, okRun.stderr);
    const kept = Object.keys(JSON.parse(fs.readFileSync(cfgFile, 'utf8'))).sort();
    assert.deepStrictEqual(kept, ['fileMaxSizeKb', 'language', 'quickVsFull', 'updateCheckDays'],
      'CONTROL: a readable config keeps its other keys — without this the arm below proves nothing');

    // ARM — same command, read denied. The file must come back byte-identical.
    fs.writeFileSync(cfgFile, original);
    const before = sha(cfgFile);
    restore = makeUnreadableFile(cfgFile);
    assert.ok(restore, 'the probe said this box CAN deny a file read, so this must not fail');
    const denied = run(sb, ['--updateCheckDays', '30']);
    restore();
    restore = null;

    assert.notStrictEqual(denied.status, 0,
      'an existing config that cannot be READ must not be treated as ABSENT: ' + denied.stdout);
    assert.doesNotMatch(denied.stdout, /Successfully updated/,
      'it must not report success over a file it could not read');
    assert.strictEqual(sha(cfgFile), before,
      'the user KEYS must survive byte-for-byte — the whole contract of this tool is that a failed run changes nothing');
  } finally {
    if (restore) restore();
  }
});

test('F-R32-4: an unrecognized flag does not swallow the NEXT FLAG as its value', (t) => {
  const sb = sandbox(t);
  const r = run(sb, ['--nosuchkey', '--language', 'en']);
  assert.notStrictEqual(r.status, 0);
  const unrecognized = r.stderr.split(/\r?\n/).filter((l) => /Unrecognized option/.test(l));
  assert.strictEqual(unrecognized.length, 1,
    'exactly ONE unrecognized flag was typed; a second error names a token the user never typed as a flag: ' + JSON.stringify(unrecognized));
  assert.match(unrecognized[0], /--nosuchkey/);
  assert.doesNotMatch(r.stderr, /Unrecognized option 'en'/,
    "'en' is the VALUE of --language and must never be reported as a flag");
  assert.ok(!fs.existsSync(projCfg(sb)), 'a rejected run still writes nothing');
});
