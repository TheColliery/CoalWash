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

// UMB-133 hole (2): the candidate list grew a second legacy entry
// (`.claude/.coalwash.json`). `firstWriteTarget`'s existing `basename !==
// 'coal'` check already excludes ANY non-canonical candidate by SHAPE, not by
// a hand-enumerated list of legacy paths -- so it should skip the new one for
// the same reason it already skips the root legacy, with no code change owed
// here. Proven, not merely read: an EXISTING nested-legacy file at
// `.claude/.coalwash.json` (the file the writer would plant a SECOND config
// into if this check ever narrowed) still routes a first write to the
// candidate the project ALREADY has, never to the legacy address itself.
test('CWK-023: firstWriteTarget skips BOTH legacy shapes even when the nested one already exists -- never plants a second config beside it', (t) => {
  const sb = sandbox(t);
  fs.mkdirSync(path.join(sb.proj, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(sb.proj, '.claude', '.coalwash.json'), '{}\n');
  const target = firstWriteTarget(sb.proj, sb.home);
  // MESSAGE CORRECTED (UMB-133 INSPECT F3): this pins `firstWriteTarget`'s own
  // SHAPE check and nothing else. It does NOT say where a real run writes --
  // with this fixture's file on disk the production path never calls this
  // function at all (`configure.mjs`: writePath = exists(found) ? found :
  // firstWriteTarget(...)), so the composed behaviour is the NEXT test's, not
  // this one's. The old message claimed the composed property and this
  // assertion could not carry it.
  assert.ok(target.includes(`.claude${path.sep}coal${path.sep}coalwash.json`),
    `firstWriteTarget must return the canonical .claude/coal/coalwash.json for a project with no config anywhere, never either legacy address; got ${target}`);
  assert.notStrictEqual(target, path.join(sb.proj, '.claude', '.coalwash.json'));
});

// UMB-133 INSPECT F3, the COMPOSED half -- the claim the unit above cannot
// reach. `README.md`'s promise is that a config sitting at either LEGACY path
// is written back THERE, never moved, and this unit is what newly extended
// that promise to the nested shape, so it is precisely the claim that owes a
// test. This spawns the REAL writer rather than calling a helper: the
// discriminator lives in configure.mjs's own `exists(found) ? found :
// firstWriteTarget(...)` line, which no test of `firstWriteTarget` can see.
test('CWK-023: a real write with a NESTED legacy present lands IN that legacy and creates no canonical file -- the config is never silently relocated', (t) => {
  const sb = sandbox(t);
  const nested = path.join(sb.proj, '.claude', '.coalwash.json');
  fs.mkdirSync(path.join(sb.proj, '.claude'), { recursive: true });
  fs.writeFileSync(nested, `${JSON.stringify({ language: 'en' }, null, 2)}\n`);

  const r = run(sb, ['--fileMaxSizeKb', '31']);
  assert.strictEqual(r.status, 0, r.stderr);

  const after = JSON.parse(fs.readFileSync(nested, 'utf8'));
  assert.strictEqual(after.fileMaxSizeKb, 31, 'the key must land in the legacy file the loader actually reads');
  assert.strictEqual(after.language, 'en', 'the pre-existing content must survive the write');
  assert.ok(!fs.existsSync(projCfg(sb)),
    'no canonical file may appear: a silent relocation would leave the user with two configs, one of which the loader stops reading');
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

// ---------------------------------------------------------------------------
// r32 FINDINGS-BACK — F-R32-3 [MED]. The head ruled WARN, not REFUSE: the clamp
// is a READ-side security property, not a write-side prohibition, and a project
// value is legitimately meaningful the moment the user's global stance changes.
// So the write proceeds and the CLI must say what will actually be READ.
// ---------------------------------------------------------------------------

test('F-R32-3: a project write no read will honour is NAMED, with the effective value and --global', (t) => {
  const sb = sandbox(t);
  const r = run(sb, ['--writeGuard', 'off']);

  // The write itself still happens — the ruling is WARN, not REFUSE.
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(fs.readFileSync(projCfg(sb), 'utf8')).writeGuard, 'off',
    'the ruling is WARN: the value the user asked for is still written to their file');

  const out = r.stdout + r.stderr;
  assert.match(out, /writeGuard/, 'the warning must name the KEY');
  assert.match(out, /"on"/, 'the warning must name the EFFECTIVE value every read returns');
  assert.match(out, /--global/, 'the warning must point at the path that DOES take effect');
  assert.doesNotMatch(r.stdout, /Successfully updated configuration/,
    'the success line must stop overstating when a key it just wrote will not be read at that value');
});

test('F-R32-3 CONTROL: an UNCLAMPED key is written, honoured, and NOT warned about', (t) => {
  const sb = sandbox(t);
  // Without this control the cell above would pass just as well against a CLI
  // that warned on every key — which would be a different defect, not a fix.
  const r = run(sb, ['--language', 'th']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(fs.readFileSync(projCfg(sb), 'utf8')).language, 'th');
  assert.match(r.stdout, /Successfully updated configuration/,
    'an honoured write keeps the plain success line');
  assert.doesNotMatch(r.stdout + r.stderr, /will NOT be read/,
    'a key nothing clamps must draw no warning at all');
});

test('F-R32-3: --global IS honoured, so the warning fires on the PROJECT path only', (t) => {
  const sb = sandbox(t);
  const r = run(sb, ['--global', '--writeGuard', 'off']);
  assert.strictEqual(r.status, 0, r.stderr);
  const g = path.join(sb.home, '.claude', '.coalwash.json');
  assert.strictEqual(JSON.parse(fs.readFileSync(g, 'utf8')).writeGuard, 'off');
  assert.doesNotMatch(r.stdout + r.stderr, /will NOT be read/,
    'the global layer is where a consent-bearing key DOES take effect — warning here would be false');
  assert.match(r.stdout, /Successfully updated configuration/);
});

// CWK-137 D3: `estate.archiveDir` is read from the GLOBAL layer only, so a PROJECT write of it is ignored by every reader. The
// F-R32-3 machinery above already notices (it compares the written value with the loader's own merged read); what it said
// about WHY was the consent-clamp story ("safer-value-wins"), which is false for this key: nothing here is safer or weaker, the
// project layer simply has no say in where a user's transcripts are archived. The write still proceeds (WARN, not REFUSE).
test('CWK-137 D3: a PROJECT write of estate.archiveDir is named as ignored, for the RIGHT reason (global-only, not the consent clamp)', (t) => {
  const sb = sandbox(t);
  const dest = path.join(sb.home, 'my-archive');
  const r = run(sb, ['--estate.archiveDir', dest]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(fs.readFileSync(projCfg(sb), 'utf8')).estate.archiveDir, dest, 'WARN, not REFUSE: the value is still written');
  const out = r.stdout + r.stderr;
  assert.match(out, /estate\.archiveDir will NOT be read at the value you set/, 'the warning names the KEY');
  assert.match(out, /GLOBAL config only/, 'and states the real reason');
  assert.doesNotMatch(out, /SAFER-VALUE-WINS|consent-bearing/, 'the consent-clamp explanation is false for this key and must not be printed');
  assert.match(out, /--global --estate\.archiveDir/, 'and points at the path that DOES take effect');
  assert.doesNotMatch(out, /every read returns: undefined/, 'an unset effective value reads as unset, never the word "undefined"');
  assert.doesNotMatch(r.stdout, /Successfully updated configuration/);
});

test('CWK-137 D3: --global estate.archiveDir IS honoured, so no warning fires', (t) => {
  const sb = sandbox(t);
  const dest = path.join(sb.home, 'my-archive');
  const r = run(sb, ['--global', '--estate.archiveDir', dest]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(sb.home, '.claude', '.coalwash.json'), 'utf8')).estate.archiveDir, dest);
  assert.doesNotMatch(r.stdout + r.stderr, /will NOT be read/);
  assert.match(r.stdout, /Successfully updated configuration/);
});

// r34c C: the main-module guard compared import.meta.url (Node resolves the entry file to its
// REALPATH) with argv[1] (the path it was invoked by). Through a symlink or a junction the two
// differ and main() never ran: exit 0, no output, and no config written. A host that cannot
// make a directory junction skips.
test('r34c C: invoked through a directory junction, configure.mjs still runs (--help prints the help)', (t) => {
  const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-configure-junction-'));
  t.after(() => fs.rmSync(holder, { recursive: true, force: true })); // rmSync does not follow a junction (probed)
  const link = path.join(holder, 'scripts-link');
  try {
    fs.symlinkSync(path.dirname(fileURLToPath(import.meta.url)), link, 'junction');
  } catch (e) {
    return t.skip(`cannot create a junction or directory symlink on this host (${e.code || e.message})`);
  }
  const r = spawnSync(process.execPath, [path.join(link, 'configure.mjs'), '--help'],
    { cwd: holder, encoding: 'utf8', env: { ...process.env, HOME: holder, USERPROFILE: holder } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /CoalWash Configurator Utility/, `through the junction: output ${JSON.stringify(r.stdout + r.stderr)}`);
});

// CWK-137: the project write goes through writeRepoFile, contained in the project root.
// The project's `.claude/coal` directory is a link to a directory OUTSIDE the project;
// the write is refused loudly and the outside directory keeps exactly its one file.
test('CWK-137: a project config write whose directory links OUTSIDE the project is REFUSED, and the outside file is untouched', (t) => {
  const sb = sandbox(t);
  const outside = path.join(sb.root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep me\n');
  fs.mkdirSync(path.join(sb.proj, '.claude'));
  try {
    fs.symlinkSync(outside, path.join(sb.proj, '.claude', 'coal'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (e) {
    return t.skip(`cannot create a directory link on this host (${e.code || e.message})`);
  }
  const before = sha(path.join(outside, 'keep.txt'));
  const r = run(sb, ['--fileMaxSizeKb', '31']);
  assert.strictEqual(r.status, 1, `exit ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /\[refused\]/, 'the refusal is loud');
  assert.match(r.stderr, /nothing was written/);
  assert.deepStrictEqual(fs.readdirSync(outside), ['keep.txt'], 'no config and no temp file lands in the outside directory');
  assert.strictEqual(sha(path.join(outside, 'keep.txt')), before);
});

// CWK-120 ride-along (a), UMB-174: a parsed body that is not a plain object is never accepted as the config.
// The old `parseJsonc(raw) || {}` turned a FALSY body (null, 0, false, "") into an EMPTY config, so a write landed
// on {} over a file that held something the tool did not understand; the truthy shapes ([], "x", 42) were already
// refused by the shape check below it. Every body must exit 1, name the reason and leave the file byte-identical.
for (const [name, body] of [['null', 'null'], ['0', '0'], ['false', 'false'], ['an empty string', '""'], ['an array', '[]'], ['a string', '"x"'], ['a number', '42']]) {
  test(`CWK-120 (a): a config whose body is ${name} is REFUSED as not a JSON object, and the file stays byte-identical`, (t) => {
    const sb = sandbox(t);
    fs.mkdirSync(path.dirname(projCfg(sb)), { recursive: true });
    fs.writeFileSync(projCfg(sb), body + '\n');
    const before = sha(projCfg(sb));
    const r = run(sb, ['--language', 'en']);
    assert.strictEqual(r.status, 1, `a ${name} body must be refused (exit ${r.status}): ${r.stderr}`);
    assert.match(r.stderr, /does not hold a JSON object/);
    assert.match(r.stderr, /Nothing was written/);
    assert.strictEqual(sha(projCfg(sb)), before, 'refusing beats rebuilding: the bytes are still there to fix');
  });
}

test('UMB-174: a UTF-8 BOM before a valid object still PARSES, and the write keeps the key it held', (t) => {
  const sb = sandbox(t);
  fs.mkdirSync(path.dirname(projCfg(sb)), { recursive: true });
  fs.writeFileSync(projCfg(sb), String.fromCharCode(0xfeff) + '{ "updateCheckDays": 9 }\n');
  const r = run(sb, ['--language', 'en']);
  assert.strictEqual(r.status, 0, `a BOM-prefixed valid config must be edited, not refused: ${r.stderr}`);
  const written = fs.readFileSync(projCfg(sb), 'utf8');
  const after = JSON.parse(written.charCodeAt(0) === 0xfeff ? written.slice(1) : written);
  assert.strictEqual(after.updateCheckDays, 9, 'the key the BOM-prefixed file held survives the write');
  assert.strictEqual(after.language, 'en');
});
