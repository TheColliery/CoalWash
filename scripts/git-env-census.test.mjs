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

test('the REAL tree: every PRODUCTION git spawn (a non-test script) takes gitEnv() directly, none via a wrapper', () => {
  const prod = collectScriptsMjs(REPO).filter((f) => !f.rel.endsWith('.test.mjs'));
  const r = censusGitSpawns(prod);
  assert.ok(r.calls >= 3, `verify.mjs (two) and link-check.mjs (one) must be found (${r.calls} calls)`);
  assert.deepEqual([r.findings.length, r.other], [0, 0], `every non-test git spawn is the helper's, verified in its own text: ${JSON.stringify(r.findings)}`);
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
