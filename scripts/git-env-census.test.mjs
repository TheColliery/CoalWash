// CWK-136 -- the git-spawn census (scripts/git-env-census.mjs). Every fixture below is BUILT from parts (Q, call()), never
// written out as a literal git spawn: the real gate scans this very file, and a spelled-out `spawnSync('git', ...)`
// inside a string would be a finding against the test that pins the gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { censusGitSpawns, collectScriptsMjs } from './git-env-census.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const Q = String.fromCharCode(39);
// call('spawnSync', 'git', "['status']", 'env: gitEnv(d)') -> the text of one spawn call.
const call = (fn, cmd, args, opts) => `${fn}(${Q}${cmd}${Q}${args ? `, ${args}` : ''}${opts ? `, { ${opts} }` : ''});`;
const census = (text, rel = 'scripts/fixture.mjs') => censusGitSpawns([{ rel, text }]);

test('a git spawn with NO env: is a finding that names the file and the line', () => {
  const r = census(`const a = 1;\n${call('spawnSync', 'git', "['status']", 'cwd: dir')}\n`);
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0], /^scripts\/fixture\.mjs:2 spawnSync\('git', \.\.\.\) carries no 'env:'/);
});

test('the argv-less and options-less forms carry no env either', () => {
  assert.equal(census(call('execFileSync', 'git', "['add', '-A']")).findings.length, 1);
  assert.equal(census(call('spawnSync', 'git')).findings.length, 1);
});

test('env: process.env is a finding (the shape CWK-133 exists to stop)', () => {
  const r = census(call('spawnSync', 'git', "['init']", 'cwd: dir, env: process.env'));
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0], /names process\.env/);
});

test('env: { ...process.env, X } is a finding too: a spread of the ambient env is the same hole', () => {
  assert.equal(census(call('spawnSync', 'git', "['init']", "env: { ...process.env, GIT_CEILING_DIRECTORIES: base }")).findings.length, 1);
});

test('env: gitEnv(dir) passes and is COUNTED as the helper', () => {
  const r = census(call('spawnSync', 'git', "['init']", 'cwd: dir, env: gitEnv(path.dirname(dir))'));
  assert.deepEqual([r.findings.length, r.calls, r.viaHelper, r.other], [0, 1, 1, 0]);
});

test('STRICTER than "without the helper": gitEnv() with process.env spread after it is still refused', () => {
  const r = census(call('spawnSync', 'git', "['init']", 'env: { ...gitEnv(d), ...process.env }'));
  assert.equal(r.findings.length, 1, 'the spread order would re-add the GIT_* family the helper removed');
});

test('a LOCAL wrapper or variable passes and is COUNTED as unverified (the named limit, made visible)', () => {
  const wrapper = census(call('spawnSync', 'git', "['init']", 'env: hermeticGit(root)'));
  assert.deepEqual([wrapper.findings.length, wrapper.viaHelper, wrapper.other], [0, 0, 1]);
  const variable = census(call('spawnSync', 'git', "['init']", 'env: fixtureEnv'));
  assert.deepEqual([variable.findings.length, variable.other], [0, 1]);
  const shorthand = census(`${'spawnSync'}(${Q}git${Q}, ['init'], { cwd: dir, env });`);
  assert.deepEqual([shorthand.findings.length, shorthand.other], [0, 1]);
});

// UMB-456 (2): a VARIABLE env is followed to its `const` declaration, and an ALLOWLIST built from named keys passes. Every
// fixture is a whole function built from parts; the spawn line is never a literal (the real gate scans this file).
const fn = (...body) => ['function repoName() {', ...body, '  return r;', '}', ''].join('\n');
const spawnWith = (opts) => `  const r = ${'spawnSync'}(${Q}git${Q}, ['config', '--local', '--get', 'remote.origin.url'], { ${opts} });`;
const KEEP = "  const keep = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'GIT_CEILING_DIRECTORIES'];";
const PICK = '...Object.fromEntries(keep.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]))';
// The canon's own repoName() (.github templates/overlay-coal-skill/scripts/release-notes.mjs, blob f8d998d8, lines 34-36), byte
// for byte except the spawn line, which is built from parts.
const CANON_REPONAME = fn(KEEP, `  const env = { ${PICK}, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };`, spawnWith("encoding: 'utf8', timeout: 30000, env"));
const shape = (r) => [r.findings.length, r.calls, r.viaHelper, r.allowlist, r.refused, r.other];

test('UMB-456 (2) witness 1: the canon release-notes allowlist (the { env } shorthand) passes, counted as allowlist, with no pin', () => {
  const r = census(CANON_REPONAME, 'scripts/release-notes.mjs');
  assert.deepEqual(shape(r), [0, 1, 0, 1, 0, 0], JSON.stringify(r.findings));
  assert.deepEqual(r.exempted, []);
});

test('UMB-456 (2) witness 2: a planted { ...process.env, GIT_CONFIG_NOSYSTEM } is REFUSED, by shorthand and by name', () => {
  for (const [decl, opts] of [['env', 'env'], ['built', 'env: built']]) {
    const r = census(fn(`  const ${decl} = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };`, spawnWith(opts)));
    assert.deepEqual(shape(r), [1, 1, 0, 0, 1, 0], opts);
    assert.match(r.findings[0], /^scripts\/fixture\.mjs:3 spawnSync\('git', \.\.\.\) passes an env, '\w+', that is no allowlist: it takes process\.env as a whole object, unfiltered/);
  }
});

test('UMB-456 (2) witness 3: a planted Object.assign({}, process.env) is REFUSED even with GIT_CONFIG_NOSYSTEM set', () => {
  const r = census(fn("  const env = Object.assign({}, process.env, { GIT_CONFIG_NOSYSTEM: '1' });", spawnWith('env')));
  assert.deepEqual(shape(r), [1, 1, 0, 0, 1, 0]);
  assert.match(r.findings[0], /whole object, unfiltered/);
});

test('UMB-456 (2) witness 4: an allowlist that adds GIT_DIR is REFUSED, in its key list or in the declaration', () => {
  const inList = census(fn(KEEP.replace("'HOME'", "'HOME', 'GIT_DIR'"), `  const env = { ${PICK}, GIT_CONFIG_NOSYSTEM: '1' };`, spawnWith('env')));
  assert.deepEqual(shape(inList), [1, 1, 0, 0, 1, 0]);
  assert.match(inList.findings[0], /it names GIT_DIR, which can aim git at another repository/);
  const inDecl = census(fn(KEEP, `  const env = { ${PICK}, GIT_CONFIG_NOSYSTEM: '1', GIT_DIR: dir };`, spawnWith('env')));
  assert.deepEqual(shape(inDecl), [1, 1, 0, 0, 1, 0]);
  assert.match(inDecl.findings[0], /it names GIT_DIR/);
});

test('UMB-456 (2) witness 5: an allowlist missing GIT_CONFIG_NOSYSTEM is REFUSED', () => {
  const r = census(fn(KEEP, `  const env = { ${PICK}, GIT_TERMINAL_PROMPT: '0' };`, spawnWith('env')));
  assert.deepEqual(shape(r), [1, 1, 0, 0, 1, 0]);
  assert.match(r.findings[0], /it does not set GIT_CONFIG_NOSYSTEM: '1'/);
});

test('UMB-456 (2): Object.entries(process.env) with no .filter( is REFUSED; with .filter( after it, that rule passes', () => {
  const bare = census(fn("  const env = { ...Object.fromEntries(Object.entries(process.env)), GIT_CONFIG_NOSYSTEM: '1' };", spawnWith('env')));
  assert.deepEqual(shape(bare), [1, 1, 0, 0, 1, 0]);
  const filtered = census(fn("  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k === 'PATH')), GIT_CONFIG_NOSYSTEM: '1' };", spawnWith('env')));
  assert.deepEqual(shape(filtered), [0, 1, 0, 1, 0, 0], JSON.stringify(filtered.findings));
});

test('UMB-456 (2): a variable env that leads to gitEnv() counts as the helper; one that adds process.env beside it is refused', () => {
  const helper = census(fn('  const fixtureEnv = gitEnv(path.dirname(root));', spawnWith('env: fixtureEnv')));
  assert.deepEqual(shape(helper), [0, 1, 1, 0, 0, 0]);
  const mixed = census(fn('  const env = { ...gitEnv(d), ...process.env };', spawnWith('env')));
  assert.deepEqual(shape(mixed), [1, 1, 0, 0, 1, 0]);
  assert.match(mixed.findings[0], /names process\.env beside gitEnv\(\)/);
});

test('UMB-456 (2) control: a const in a CLOSED block is out of scope and not followed; a parameter env stays other (the named limit)', () => {
  const text = ['function a() { const env = { ...process.env }; return env; }', 'function b(env) {', spawnWith('env'), '  return r;', '}', ''].join('\n');
  assert.deepEqual(shape(census(text)), [0, 1, 0, 0, 0, 1]);
});

test('process.env inside a STRING in the env value is not a reference', () => {
  assert.equal(census(call('spawnSync', 'git', "['init']", "env: gitEnv('process.env is a word here')")).findings.length, 0);
});

test('a multi-line call is read whole: the env: on a later line counts, and its absence is found', () => {
  const ok = census(`${'spawnSync'}(${Q}git${Q}, [\n  'status',\n], {\n  cwd: dir,\n  env: gitEnv(d),\n});`);
  assert.deepEqual([ok.findings.length, ok.viaHelper], [0, 1]);
  const bad = census(`${'spawnSync'}(${Q}git${Q}, [\n  'status',\n], {\n  cwd: dir,\n});`);
  assert.equal(bad.findings.length, 1);
});

test('the spawn, execFile and execSync forms are all covered, the string form of execSync included', () => {
  for (const [fn, cmd] of [['spawn', 'git'], ['execFile', 'git'], ['execFileSync', 'git'], ['execSync', 'git add -A'], ['execSync', 'git']]) {
    const r = census(call(fn, cmd, cmd === 'git' ? "['x']" : '', 'cwd: d'));
    assert.equal(r.findings.length, 1, `${fn}(${cmd}) with no env must be refused`);
  }
});

test('a call on a // comment line is skipped, and a non-git command is never a call', () => {
  assert.equal(census(`// ${call('spawnSync', 'git', "['x']")}\n`).calls, 0);
  assert.equal(census(`${call('spawnSync', 'node', "['x']", 'cwd: d')}\n${call('execSync', 'fsutil file setCaseSensitiveInfo x')}\n`).calls, 0);
});

test('two calls, one bad: exactly the bad one is found, with ITS line', () => {
  const text = `${call('spawnSync', 'git', "['a']", 'env: gitEnv(d)')}\n\n${call('spawnSync', 'git', "['b']", 'cwd: d')}\n`;
  const r = census(text);
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0], /:3 /);
  assert.deepEqual([r.calls, r.viaHelper], [2, 1]);
});

test('an unbalanced call is a finding, never a silent skip', () => {
  const r = census(`${'spawnSync'}(${Q}git${Q}, ['x'], { cwd: d`);
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0], /unbalanced parens/);
});

test('the census reports its coverage: files scanned, calls found', () => {
  const r = censusGitSpawns([{ rel: 'a.mjs', text: call('spawnSync', 'git', '[]', 'env: gitEnv(d)') }, { rel: 'b.mjs', text: 'const x = 1;\n' }]);
  assert.deepEqual([r.scanned, r.calls], [2, 1]);
});

test('the REAL tree: every PRODUCTION git spawn (a non-test script) takes gitEnv() or an allowlist env, verified in its own text, none via a wrapper', () => {
  const prod = collectScriptsMjs(REPO).filter((f) => !f.rel.endsWith('.test.mjs'));
  const r = censusGitSpawns(prod);
  assert.ok(r.calls >= 3, `verify.mjs (two) and link-check.mjs (one) must be found (${r.calls} calls)`);
  assert.deepEqual([r.findings.length, r.other], [0, 0], `every non-test git spawn is the helper's or an allowlist, verified in its own text: ${JSON.stringify(r.findings)}`);
  const notes = censusGitSpawns(prod.filter((f) => f.rel === 'scripts/release-notes.mjs'));
  assert.deepEqual([notes.calls, notes.allowlist, notes.exempted.length], [1, 1, 0], 'UMB-456 (2): the canon release-notes.mjs repoName() is followed and judged an allowlist, with no pin');
});

test('the REAL tree: every git spawn under scripts/ is clean, and the locator finds some (a zero would be a dead locator)', () => {
  const files = collectScriptsMjs(REPO);
  const r = censusGitSpawns(files);
  assert.deepEqual(r.findings, [], 'no git spawn under scripts/ may lack the helper env');
  assert.ok(files.length > 30, `the walk must reach the tree (${files.length} files)`);
  assert.ok(r.calls > 0 && r.viaHelper > 0, `the locator must find git spawns (${r.calls} calls, ${r.viaHelper} via the helper)`);
});

// CWK-137 F-10: the census header NAMES three bypasses instead of widening the locator. This pins them, so the named list
// cannot rot: if a bypass is ever closed, this test goes red on purpose, and the fix is to delete that item from the
// header's list (and this leg) in the same change. Every fixture is a spawn that would be a FINDING if the census saw it.
test('the three NAMED bypasses pass unseen (a named limit, pinned so the header list cannot rot)', () => {
  // (1) process['env'] in the env value: counted as `other`, never refused
  const bracket = census(call('spawnSync', 'git', "['status']", "env: process['env']"));
  assert.deepEqual([bracket.findings.length, bracket.calls, bracket.other], [0, 1, 1], "bracket access to process.env is NOT refused");
  // (2) a command literal that does not start with `git` + quote/space: not located at all
  for (const cmd of ['git.exe', 'C:/Program Files/Git/bin/git.exe', '/usr/bin/git']) {
    const r = census(call('spawnSync', cmd, "['status']", 'cwd: dir'));
    assert.deepEqual([r.findings.length, r.calls], [0, 0], `${cmd}: an unlocated spawn is neither counted nor refused (this one carries no env at all)`);
  }
  // (3) the async exec(): not in the located call list
  const asyncExec = census(`${'exec'}(${Q}git status${Q}, () => {});`);
  assert.deepEqual([asyncExec.findings.length, asyncExec.calls], [0, 0], 'async exec() is not located');
  // control: the SAME shape through a located form IS refused, so the zeros above are the bypass and not a dead locator
  assert.equal(census(call('spawnSync', 'git', "['status']", 'cwd: dir')).findings.length, 1);
});

// CWK-174: the house secret scan's TEST file scripts/secret-scan.test.mjs (Bankfire source blob 4433fb56, order 08c) carries ONE refused
// spawn, its control read of a decoy repository at line 593 with an env that strips every GIT_* key but sets no GIT_CONFIG_NOSYSTEM (the
// UMB-456 (2) allowlist rule; routed to the source to fix there). It is carried BYTE-EQUAL and cannot be edited room-side, so the census
// exempts exactly that path, and ONLY while its git blob id equals the id pinned below: an edit, or a re-sync that moves the blob, turns the
// entry back into a finding. (R14 F-R14-5: scripts/secret-gate.test.mjs was pinned too and exempted nothing; it takes its environment where
// it spawns, and an entry that hides no finding is refused by the last test below.) A room-local, named divergence; DELETE the entry when
// the source fix lands and the carrier is re-copied.
import * as CENSUS from './git-env-census.mjs'; // namespace import: a name the pre-fix tree never exported fails an ASSERTION, not the link
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { gitEnv } from './git-env.mjs';

const CARRIERS = {
  'scripts/secret-scan.test.mjs': '4433fb56bc97d1facc3fb27804e1934c0577115f',
};
const carrierText = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

test('CWK-174: the exemption names EXACTLY the one carried test file that needs it, with its pinned blob id (R14 F-R14-5: the secret-gate test spawns git with its own env and needs none)', () => {
  assert.ok(CENSUS.EXEMPT_CARRIERS, 'EXEMPT_CARRIERS is exported');
  assert.deepEqual(Object.fromEntries(Object.entries(CENSUS.EXEMPT_CARRIERS).sort()), CARRIERS);
});

test('CWK-174: the pinned ids are the real canon blobs -- the carriers on disk hash to them (git hash-object --no-filters)', () => {
  for (const [rel, id] of Object.entries(CARRIERS)) {
    const viaGit = execFileSync('git', ['hash-object', '--no-filters', rel], { cwd: REPO, encoding: 'utf8', env: gitEnv(REPO) }).trim();
    assert.equal(viaGit, id, `${rel} is the pinned canon blob`);
    assert.equal(CENSUS.gitBlobId?.(carrierText(rel)), id, `gitBlobId() (the census's own hash) agrees for ${rel}`);
  }
});

test('CWK-174: a carrier whose bytes equal its pinned blob is exempt, and the exemption is REPORTED', () => {
  for (const rel of Object.keys(CARRIERS)) {
    const text = carrierText(rel);
    const bare = censusGitSpawns([{ rel: 'scripts/elsewhere.test.mjs', text }]); // the same text at an UNPINNED path: what it would cost without the pin
    const r = censusGitSpawns([{ rel, text }]);
    assert.deepEqual(r.findings, [], `${rel} is exempt while it is the pinned blob`);
    assert.deepEqual(r.exempted, [rel], 'and the exemption is named in the report');
    assert.ok(bare.findings.length > 0, 'control: without the pin the same text IS a finding (the locator sees it)');
  }
});

// R14 INSPECT F-R14-5: the pin for scripts/secret-gate.test.mjs exempted NOTHING (the same bytes at an unpinned path yield 0 findings; only
// secret-scan.test.mjs yields 3), while the header and verify's "2 ... EXEMPT" line claimed two. An exemption that hides no finding is
// attack surface for nothing, and it makes the printed size of the unverified set a claim the code does not back. So every entry must
// EARN its place: without its pin, its own bytes are a finding.
test('R14 F-R14-5: every exempt carrier earns its entry -- the same bytes at an unpinned path ARE findings (an inert pin is refused)', () => {
  for (const rel of Object.keys(CENSUS.EXEMPT_CARRIERS)) {
    const bare = censusGitSpawns([{ rel: 'scripts/unpinned-copy.test.mjs', text: carrierText(rel) }]);
    assert.ok(bare.findings.length > 0, `${rel}: the pin hides nothing, so it must not be there`);
  }
  const gate = censusGitSpawns([{ rel: 'scripts/unpinned-copy.test.mjs', text: carrierText('scripts/secret-gate.test.mjs') }]);
  assert.deepEqual(gate.findings, [], 'control: the secret-gate test really does need no exemption (it takes its environment where it spawns)');
});

test('CWK-174: ONE edited byte makes a carrier a finding again (the exemption is the blob, never the path)', () => {
  const rel = 'scripts/secret-scan.test.mjs';
  const r = censusGitSpawns([{ rel, text: `${carrierText(rel)}\n// one more line\n` }]);
  assert.ok(r.findings.length > 0, 'an edited carrier is refused');
  assert.deepEqual(r.exempted, [], 'and no longer exempt');
});

test('CWK-174: the same bytes at another path are NOT exempt (the pin is keyed by path AND blob)', () => {
  const r = censusGitSpawns([{ rel: 'scripts/copy-of-secret-scan.test.mjs', text: carrierText('scripts/secret-scan.test.mjs') }]);
  assert.ok(r.findings.length > 0);
  assert.deepEqual(r.exempted, []);
});
