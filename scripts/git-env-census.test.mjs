// CWK-136 -- the git-spawn census (scripts/git-env-census.mjs). Every fixture below is BUILT from parts (Q, call(), sp()), never
// written out as a literal git spawn. Since 08d the census lexes each file and does not read string or template text as code, so a
// spelled-out spawn inside a string would no longer be found; the parts stay so the fixtures read the same under the pre-08d census,
// which the red-first run of the witness list feeds them to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { censusGitSpawns, collectScriptsMjs } from './git-env-census.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const Q = String.fromCharCode(39);
const BT = String.fromCharCode(96);
const BS = String.fromCharCode(92);
const DL = '$';
// call('spawnSync', 'git', "['status']", 'env: gitEnv(d)') -> the text of one spawn call.
const call = (fn, cmd, args, opts) => `${fn}(${Q}${cmd}${Q}${args ? `, ${args}` : ''}${opts ? `, { ${opts} }` : ''});`;
const census = (text, rel = 'scripts/fixture.mjs') => censusGitSpawns([{ rel, text }]);
const shape = (r) => [r.findings.length, r.calls, r.viaHelper, r.allowlist, r.refused];
const IMPORT = "import { gitEnv } from './git-env.mjs';";
const withImport = (text) => `${IMPORT}\n${text}`;

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
  assert.equal(census(call('spawnSync', 'git', "['init']", 'env: { ...process.env, GIT_CEILING_DIRECTORIES: base }')).findings.length, 1);
});

test('env: gitEnv(dir) passes and is COUNTED as the helper when gitEnv is the import of the room helper', () => {
  const r = census(withImport(call('spawnSync', 'git', "['init']", 'cwd: dir, env: gitEnv(path.dirname(dir))')));
  assert.deepEqual(shape(r), [0, 1, 1, 0, 0]);
});

test('08d: gitEnv() with no binding in the file, or bound by a parameter, is a finding: the census never trusts the name', () => {
  assert.deepEqual(shape(census(call('spawnSync', 'git', "['init']", 'env: gitEnv(d)'))), [1, 1, 0, 0, 1]);
  const shadowed = withImport(['function f(gitEnv) {', `  ${call('spawnSync', 'git', "['init']", 'env: gitEnv(d)')}`, '}', ''].join('\n'));
  assert.deepEqual(shape(census(shadowed)), [1, 1, 0, 0, 1]);
});

test("08d: a dynamic `const { gitEnv } = await import(... 'git-env.mjs' ...)` binds the room helper inside its block only (verify.mjs's form)", () => {
  const dyn = "  const { gitEnv } = await import(pathToFileURL(path.join(repo, 'scripts', 'git-env.mjs')).href);";
  const inside = ['async function g(repo) {', dyn, `  ${call('spawnSync', 'git', "['ls-files']", 'env: gitEnv(path.dirname(repo))')}`, '}', ''].join('\n');
  assert.deepEqual(shape(census(inside)), [0, 1, 1, 0, 0]);
  const outside = ['async function g(repo) {', dyn, '}', `function h(repo) { ${call('spawnSync', 'git', "['ls-files']", 'env: gitEnv(repo)')} }`, ''].join('\n');
  assert.deepEqual(shape(census(outside)), [1, 1, 0, 0, 1]);
});

test('STRICTER than "without the helper": gitEnv() with process.env spread after it is still refused', () => {
  const r = census(withImport(call('spawnSync', 'git', "['init']", 'env: { ...gitEnv(d), ...process.env }')));
  assert.equal(r.findings.length, 1, 'the spread order would re-add the GIT_* family the helper removed');
});

test('08d: a local WRAPPER, a variable with no const and the { env } shorthand with no const are FINDINGS (never an unverified pass)', () => {
  assert.deepEqual(shape(census(call('spawnSync', 'git', "['init']", 'env: hermeticGit(root)'))), [1, 1, 0, 0, 1]);
  assert.deepEqual(shape(census(call('spawnSync', 'git', "['init']", 'env: fixtureEnv'))), [1, 1, 0, 0, 1]);
  assert.deepEqual(shape(census(`${'spawnSync'}(${Q}git${Q}, ['init'], { cwd: dir, env });`)), [1, 1, 0, 0, 1]);
});

test('08d: an options object that spreads, or sets env twice, is a finding', () => {
  assert.deepEqual(shape(census(withImport(call('spawnSync', 'git', "['init']", 'env: gitEnv(d), ...opts')))), [1, 1, 0, 0, 1]);
  assert.deepEqual(shape(census(withImport(call('spawnSync', 'git', "['init']", 'env: gitEnv(d), env: process.env')))), [1, 1, 0, 0, 1]);
});

// UMB-456 (2): a VARIABLE env is followed to its `const` declaration, and an ALLOWLIST built from named keys passes. Every
// fixture is a whole function built from parts; the spawn line is never a literal.
const fn = (...body) => ['function repoName() {', ...body, '  return r;', '}', ''].join('\n');
const spawnWith = (opts) => `  const r = ${'spawnSync'}(${Q}git${Q}, ['config', '--local', '--get', 'remote.origin.url'], { ${opts} });`;
const KEEP_CANON = "  const keep = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'GIT_CEILING_DIRECTORIES'];";
const PICK = '...Object.fromEntries(keep.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]))';
// The canon's own repoName() (.github templates/overlay-coal-skill/scripts/release-notes.mjs, blob f8d998d8, lines 34-36), byte
// for byte except the spawn line, which is built from parts.
const CANON_REPONAME = fn(KEEP_CANON, `  const env = { ${PICK}, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };`, spawnWith("encoding: 'utf8', timeout: 30000, env"));

test('UMB-456 (2) witness 1: the canon release-notes allowlist (the { env } shorthand) passes, counted as allowlist, with no pin', () => {
  const r = census(CANON_REPONAME, 'scripts/release-notes.mjs');
  assert.deepEqual(shape(r), [0, 1, 0, 1, 0], JSON.stringify(r.findings));
  assert.deepEqual(r.exempted, []);
});

test('UMB-456 (2) witness 2: a planted { ...process.env, GIT_CONFIG_NOSYSTEM } is REFUSED, by shorthand and by name', () => {
  for (const [decl, opts] of [['env', 'env'], ['built', 'env: built']]) {
    const r = census(fn(`  const ${decl} = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };`, spawnWith(opts)));
    assert.deepEqual(shape(r), [1, 1, 0, 0, 1], opts);
    assert.match(r.findings[0], /^scripts\/fixture\.mjs:3 spawnSync\('git', \.\.\.\) passes an env that is no allowlist: '\w+' is no allowlist: it spreads process\.env/);
  }
});

test('UMB-456 (2) witness 3: a planted Object.assign({}, process.env) is REFUSED even with GIT_CONFIG_NOSYSTEM set', () => {
  const r = census(fn("  const env = Object.assign({}, process.env, { GIT_CONFIG_NOSYSTEM: '1' });", spawnWith('env')));
  assert.deepEqual(shape(r), [1, 1, 0, 0, 1]);
  assert.match(r.findings[0], /built as neither gitEnv\(\) nor an allowlist literal/);
});

test('UMB-456 (2) witness 4: an allowlist that adds GIT_DIR is REFUSED, in its key list or in the declaration', () => {
  const inList = census(fn(KEEP_CANON.replace("'HOME'", "'HOME', 'GIT_DIR'"), `  const env = { ${PICK}, GIT_CONFIG_NOSYSTEM: '1' };`, spawnWith('env')));
  assert.deepEqual(shape(inList), [1, 1, 0, 0, 1]);
  assert.match(inList.findings[0], /it names GIT_DIR, which can aim git at another repository/);
  const inDecl = census(fn(KEEP_CANON, `  const env = { ${PICK}, GIT_CONFIG_NOSYSTEM: '1', GIT_DIR: dir };`, spawnWith('env')));
  assert.deepEqual(shape(inDecl), [1, 1, 0, 0, 1]);
  assert.match(inDecl.findings[0], /it names GIT_DIR/);
});

test('UMB-456 (2) witness 5: an allowlist missing GIT_CONFIG_NOSYSTEM is REFUSED', () => {
  const r = census(fn(KEEP_CANON, `  const env = { ${PICK}, GIT_TERMINAL_PROMPT: '0' };`, spawnWith('env')));
  assert.deepEqual(shape(r), [1, 1, 0, 0, 1]);
  assert.match(r.findings[0], /it does not set GIT_CONFIG_NOSYSTEM: '1'/);
});

test('UMB-456 (2): a variable env that leads to gitEnv() counts as the helper; one that adds process.env beside it is refused', () => {
  const helper = census(withImport(fn('  const fixtureEnv = gitEnv(path.dirname(root));', spawnWith('env: fixtureEnv'))));
  assert.deepEqual(shape(helper), [0, 1, 1, 0, 0]);
  const mixed = census(withImport(fn('  const env = { ...gitEnv(d), ...process.env };', spawnWith('env'))));
  assert.deepEqual(shape(mixed), [1, 1, 0, 0, 1]);
  assert.match(mixed.findings[0], /it spreads gitEnv\(d\)/);
});

test('UMB-456 (2) control: a const in a CLOSED block is out of scope and not followed, so a parameter env is a finding', () => {
  const text = ['function a() { const env = { ...process.env }; return env; }', 'function b(env) {', spawnWith('env'), '  return r;', '}', ''].join('\n');
  assert.deepEqual(shape(census(text)), [1, 1, 0, 0, 1]);
});

test('process.env inside a STRING in the env value is not a reference', () => {
  assert.deepEqual(shape(census(withImport(call('spawnSync', 'git', "['init']", "env: gitEnv('process.env is a word here')")))), [0, 1, 1, 0, 0]);
});

test('a multi-line call is read whole: the env: on a later line counts, and its absence is found', () => {
  const ok = census(withImport(`${'spawnSync'}(${Q}git${Q}, [\n  'status',\n], {\n  cwd: dir,\n  env: gitEnv(d),\n});`));
  assert.deepEqual([ok.findings.length, ok.viaHelper], [0, 1]);
  const bad = census(`${'spawnSync'}(${Q}git${Q}, [\n  'status',\n], {\n  cwd: dir,\n});`);
  assert.equal(bad.findings.length, 1);
});

test('the spawn, execFile, execSync and async exec forms are all covered, the string form of execSync and exec included', () => {
  for (const [f, cmd] of [['spawn', 'git'], ['execFile', 'git'], ['execFileSync', 'git'], ['execSync', 'git add -A'], ['execSync', 'git'], ['exec', 'git status']]) {
    const r = census(call(f, cmd, cmd === 'git' ? "['x']" : '', 'cwd: d'));
    assert.equal(r.findings.length, 1, `${f}(${cmd}) with no env must be refused`);
  }
});

test('a call in a // comment, a /* */ comment or a string is not code; a non-git command is never a call', () => {
  assert.equal(census(`// ${call('spawnSync', 'git', "['x']")}\n`).calls, 0);
  assert.equal(census(`/* ${call('spawnSync', 'git', "['x']")} */\n`).calls, 0);
  assert.equal(census(`const s = "${call('spawnSync', 'git', "['x']").replace(/"/g, Q)}";\n`).calls, 0);
  assert.equal(census(`#!/usr/bin/env node\n${call('spawnSync', 'git', "['x']")}\n`).calls, 1, 'a shebang line is skipped, the code after it is read');
  assert.equal(census(`${call('spawnSync', 'node', "['x']", 'cwd: d')}\n${call('execSync', 'fsutil file setCaseSensitiveInfo x')}\n`).calls, 0);
});

test('two calls, one bad: exactly the bad one is found, with ITS line', () => {
  const text = `${IMPORT}\n${call('spawnSync', 'git', "['a']", 'env: gitEnv(d)')}\n\n${call('spawnSync', 'git', "['b']", 'cwd: d')}\n`;
  const r = census(text);
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0], /:4 /);
  assert.deepEqual([r.calls, r.viaHelper], [2, 1]);
});

test('an unbalanced call is a finding, never a silent skip', () => {
  const r = census(`${'spawnSync'}(${Q}git${Q}, ['x'], { cwd: d`);
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0], /unbalanced parens/);
});

test('the census reports its coverage: files scanned, calls found', () => {
  const r = censusGitSpawns([{ rel: 'a.mjs', text: withImport(call('spawnSync', 'git', '[]', 'env: gitEnv(d)')) }, { rel: 'b.mjs', text: 'const x = 1;\n' }]);
  assert.deepEqual([r.scanned, r.calls], [2, 1]);
});

// 08d THE WITNESS LIST (U/scratchpad/dispatch/08d-census-witness-list.md, round 2 included): one fixture per vector, fed to the
// census. Where a vector declares a `const env`, both call forms run: the shorthand `{ env }` and `env: env`. Each was watched RED on
// the pre-08d census (ae78580) before the grammar landed, or is marked already red-safe in the return's per-vector table.
const sp = (opts) => `  const r = ${'spawnSync'}(${Q}git${Q}, ['status'], { ${opts} });`;
const fnBody = (...lines) => ['function f(d) {', ...lines, '  return r;', '}'].join('\n');
const file = (...parts) => [...parts, ''].join('\n');
const KEEP = "  const keep = ['PATH', 'HOME'];";
const ALLOW = `{ ${PICK}, GIT_CONFIG_NOSYSTEM: '1' }`;
const BOTH = ['env', 'env: env'];
const withEnv = (...lines) => (o) => file(fnBody(...lines, sp(o)));

const MUST_FAIL = [
  ['F1', withEnv('  const base = { ...process.env };', "  const env = { ...base, GIT_CONFIG_NOSYSTEM: '1' };"), BOTH],
  ['F1b', withEnv('  const extra = process.env;', "  const env = { ...extra, GIT_CONFIG_NOSYSTEM: '1' };"), BOTH],
  ['F1c', withEnv('  const e = process.env;', "  const env = { ...Object.fromEntries(Object.entries(e)), GIT_CONFIG_NOSYSTEM: '1' };"), BOTH],
  ['F2', withEnv("  const env = { ...Object.fromEntries(Object.entries(process.env)), GIT_CONFIG_NOSYSTEM: '1' };"), BOTH],
  ['F3', withEnv("  const env = { ...Object.fromEntries(Object.entries(process.env).filter(() => true)), GIT_CONFIG_NOSYSTEM: '1' };"), BOTH],
  ['F4', withEnv("  const env = { ...process['env'], GIT_CONFIG_NOSYSTEM: '1' };"), BOTH],
  ['F5', (o) => file("import { env as penv } from 'node:process';", fnBody("  const env = { ...penv, GIT_CONFIG_NOSYSTEM: '1' };", sp(o))), BOTH],
  ['F6', (o) => file(IMPORT, fnBody(sp(o))), ['env: { ...gitEnv(d), ...process.env }']],
  ['F7', (o) => file(IMPORT, fnBody('  const base = { ...process.env };', '  const env = { ...gitEnv(d), ...base };', sp(o))), BOTH],
  ['F8', withEnv("  const env = { GIT_CONFIG_NOSYSTEM: '1', extra: { ...process.env } };"), BOTH],
  ['F9', withEnv(KEEP, "  const env = { ...Object.fromEntries(keep.filter(Boolean).map((k) => [k, process.env[k]]).concat(Object.entries(process.env))), GIT_CONFIG_NOSYSTEM: '1' };"), BOTH],
  ['F10', withEnv(KEEP, "  const env = { ...Object.fromEntries(keep.filter(Boolean).flatMap(() => Object.entries(process.env))), GIT_CONFIG_NOSYSTEM: '1' };"), BOTH],
  ['F11', withEnv("  const env = { GIT_CONFIG_NOSYSTEM: '1', all: process.env };"), BOTH],
  ['F12', (o) => file('function all() { return process.env; }', fnBody("  const env = { ...Object.fromEntries(Object.entries(all())), GIT_CONFIG_NOSYSTEM: '1' };", sp(o))), BOTH],
  ['F13', (o) => file("function mk(x) { if (x) return { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1' }; return process.env; }", fnBody(sp(o))), ['env: mk(d)']],
  ['F14', (o) => file("import { sandboxEnv } from './elsewhere.mjs';", fnBody(sp(o))), ['env: sandboxEnv(d)']],
  ['F15', withEnv(KEEP, `  const env = ${ALLOW};`, '  Object.assign(env, process.env);'), BOTH],
  ['F16', withEnv("  const env = { GIT_CONFIG_NOSYSTEM: '1' };", '  for (const k of Object.keys(process.env)) env[k] = process.env[k];'), BOTH],
  ['F17', withEnv(KEEP, `  const env = ${ALLOW};`, "  env.GIT_DIR = '/elsewhere/.git';"), BOTH],
  ['F18', withEnv("  const KEYS = ['PATH'];", "  KEYS.push('GIT_DIR');", "  const env = { ...Object.fromEntries(KEYS.map((k) => [k, process.env[k]])), GIT_CONFIG_NOSYSTEM: '1' };"), BOTH],
  ['F19', withEnv("  const keep = ['PATH', 'GIT_DIR'];", `  const env = ${ALLOW};`), BOTH],
  ['F20', withEnv("  const k2 = ['GIT_DIR'];", "  const keep = ['PATH', ...k2];", `  const env = ${ALLOW};`), BOTH],
  ['F21', withEnv("  const keep = ['PATH', 'GIT_' + 'DIR'];", `  const env = ${ALLOW};`), BOTH],
  ['F22', withEnv("  const env = { GIT_CONFIG_NOSYSTEM: '1', ['GIT' + '_DIR']: process.env['GIT' + '_DIR'] };"), BOTH],
  ['F23', withEnv(KEEP, `  const env = { ${PICK}, GIT_CONFIG_NOSYSTEM: '0' };`), BOTH],
  ['F24', withEnv(KEEP, `  const env = { ${PICK}, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_NOSYSTEM: '0' };`), BOTH],
  ['F25', withEnv(KEEP, "  const over = { GIT_CONFIG_NOSYSTEM: '0' };", `  const env = { GIT_CONFIG_NOSYSTEM: '1', ${PICK}, ...over };`), BOTH],
  ['F26', withEnv(KEEP, `  const env = { ${PICK} };`), BOTH],
  ['F27', withEnv(KEEP, `  const env = { ${PICK}, GIT_CONFIG_NOSYSTEM: flag };`), BOTH],
  ['F28', withEnv(KEEP, `  const env = { ${PICK}, /* GIT_CONFIG_NOSYSTEM: '1' */ };`), BOTH],
  ['F29', withEnv(KEEP, `  const env = { ${PICK}, GIT_CONFIG_NOSYSTEM: '1', git_dir: d };`), BOTH],
  ['F30', withEnv(KEEP, `  const env = { ${PICK}, GIT_CONFIG_NOSYSTEM: '1', GIT_DIR: d };`), BOTH],
  ['F31', (o) => file(`function a() {\n${KEEP}\n  const env = ${ALLOW};\n  return env;\n}`, fnBody("  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };", sp(o))), BOTH],
  ['F32', (o) => file(KEEP.trim(), `const env = ${ALLOW};`, fnBody('  let env = { ...process.env };', sp(o))), BOTH],
  ['F33', (o) => file(KEEP.trim(), `const env = ${ALLOW};`, fnBody(sp(o)).replace('function f(d)', 'function f(env)')), BOTH],
  ['F34', (o) => file(KEEP.trim(), `function a() { const e2 = ${ALLOW}; return e2; }`, fnBody("  const e2 = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };", sp(o))), ['env: e2']],
  ['F35', withEnv(KEEP, `  const env = ${ALLOW};`, '  const alias = env;', '  for (const k in process.env) alias[k] = process.env[k];'), BOTH],
  ['F36', (o) => file('function fill(o) { for (const k in process.env) o[k] = process.env[k]; }', fnBody(KEEP, `  const env = ${ALLOW};`, '  fill(env);', sp(o))), BOTH],
  ['F37', withEnv(KEEP, `  const env = ${ALLOW};`, "  Reflect.set(env, 'GIT_DIR', d);"), BOTH],
  ['F38', withEnv(KEEP, `  const env = ${ALLOW};`, '  const alias = env;', '  alias.GIT_DIR = d;'), BOTH],
  ['F39', withEnv(KEEP, `  const env = ${ALLOW};`, '  Object.assign(Object(env), { GIT_DIR: d });'), BOTH],
  ['F40', withEnv(KEEP, `  const env = ${ALLOW};`, "  env.__defineGetter__('GIT_DIR', () => d);"), BOTH],
  // F41: a quote inside a regex or a template value desyncs a quote model; the lexer reads both, and the literal refuses them.
  ['F41a', withEnv(`  const env = { A: /"/, B: "x", ...process.env, GIT_CONFIG_NOSYSTEM: '1' };`), BOTH],
  ['F41b', withEnv(`  const env = { A: ${BT}${DL}{"${BT}"}${BT}, ...process.env, GIT_CONFIG_NOSYSTEM: '1' };`), BOTH],
  ['F41c', withEnv(KEEP, `  const env = { ${PICK}, A: /'/.source, GIT_DIR: d, B: '', GIT_CONFIG_NOSYSTEM: '1' };`), BOTH],
  ['F41d', withEnv(KEEP, `  const env = ${ALLOW};`, "  if (d) /'/.test(d); env.GIT_DIR = d; if (d) /'/.test(d);"), BOTH],
  ['F42a', (o) => file('function gitEnv() { return { ...process.env }; }', fnBody(sp(o))), ['env: gitEnv()']],
  ['F42b', (o) => file('const gitTestEnv = () => process.env;', fnBody(sp(o))), ['env: gitTestEnv()']],
  ['F42c', (o) => file(IMPORT, fnBody(sp(o)).replace('function f(d)', 'function f(gitEnv)')), ['env: gitEnv()']],
  // NEW candidate rows for the list (this room's coder, 08d): a key the child inherits, and a GIT_* name hidden behind an escape.
  ['N1', withEnv(KEEP, `  const env = { ${PICK}, __proto__: d, GIT_CONFIG_NOSYSTEM: '1' };`), BOTH],
  ['N2', withEnv(`  const keep = ['PATH', 'GIT${BS}x5fDIR'];`, `  const env = ${ALLOW};`), BOTH],
  ['N3', withEnv(KEEP, `  const env = { ${PICK}, GIT${BS}u005fDIR: d, GIT_CONFIG_NOSYSTEM: '1' };`), BOTH],
  // 08d RE-INSPECT rows (fire 24's NR-*). NR-1: a call on a line the lexer may read as regex text is COUNTED, never hidden (R24-2);
  // `() => {} / 1` is a SyntaxError on one line and the census still counts it, and an `of` it cannot read refuses even a clean env.
  ['NR-1a', () => file(fnBody(`  const v = {} / 1; const r = ${'spawnSync'}(${Q}git${Q}, ['status'], { env: process.env }); const w = 2 / 1;`)), ['{} / 1']],
  ['NR-1b', () => file(fnBody(`  const v = () => {} / 1; const r = ${'spawnSync'}(${Q}git${Q}, ['status'], { env: process.env }); const w = 2 / 1;`)), ['() => {} / 1']],
  ['NR-1c', () => file(fnBody(`  const of = 4; const v = of / 2; const r = ${'spawnSync'}(${Q}git${Q}, ['status'], { env: process.env }); const w = 1 / 1;`)), ['of / 2']],
  ['NR-1d', () => file(IMPORT, fnBody(`  const of = 4; const v = of / 2; const r = ${'spawnSync'}(${Q}git${Q}, ['status'], { env: gitEnv(d) }); const w = 1 / 1;`)), ['of / 2, a clean env']],
  // ...and a write to a followed const hidden by such a guess refuses the const (a function value's `}`, or `of`, then `/`).
  ['NR-1e', withEnv(KEEP, `  const env = ${ALLOW};`, '  const g = function () {} / 1; env.GIT_DIR = d; const h = 2 / 1;'), BOTH],
  ['NR-1f', withEnv(KEEP, `  const env = ${ALLOW};`, '  const of = 4; const v = of / 2; env.GIT_DIR = d; const w = 1 / 1;'), BOTH],
  // NR-2: the options are the argument node reads -- the one after the args array, else the 2nd; execSync and exec the 2nd (R24-1).
  ['NR-2a', () => file(IMPORT, fnBody(`  const r = ${'spawnSync'}(${Q}git${Q}, ['status'], { env: process.env }, { env: gitEnv(d) });`)), ['a 4th object after the options']],
  ['NR-2b', () => file(IMPORT, fnBody(`  const r = ${'spawnSync'}(${Q}git${Q}, { env: process.env }, { env: gitEnv(d) });`)), ['the options as the 2nd argument, then an extra object']],
  ['NR-2c', () => file(IMPORT, fnBody(`  const r = ${'execSync'}(${Q}git status${Q}, { env: process.env }, { env: gitEnv(d) });`)), ['execSync, then an extra object']],
  ['NR-2d', () => file(IMPORT, fnBody("  const a = ['status'];", `  const r = ${'spawnSync'}(${Q}git${Q}, a, { env: process.env }, { env: gitEnv(d) });`)), ['the args a variable (W-B)']],
  ['NR-2e', () => file(IMPORT, `const git = (a) => ${'spawnSync'}(${Q}git${Q}, a, { env: gitEnv(a) });`), ['the args a plain parameter']],
  ['NR-2f', () => file(IMPORT, `const git = (...a) => ${'spawnSync'}(${Q}git${Q}, a, { env: gitEnv(a) });`), ['a rest parameter named again in its body']],
  // NR-3: gitEnv bound by a destructured parameter, a for-of pattern or a method parameter is not the room helper (R24-3).
  ['NR-3a', () => file(IMPORT, `function f({ gitEnv }) { const r = ${'spawnSync'}(${Q}git${Q}, ['init'], { env: gitEnv(d) }); return r; }`), ['function f({ gitEnv })']],
  ['NR-3b', () => file(IMPORT, `const f = ({ gitEnv }) => ${'spawnSync'}(${Q}git${Q}, ['init'], { env: gitEnv(d) });`), ['({ gitEnv }) =>']],
  ['NR-3c', () => file(IMPORT, `for (const { gitEnv } of mods) ${'spawnSync'}(${Q}git${Q}, ['init'], { env: gitEnv(d) });`), ['for (const { gitEnv } of mods)']],
  ['NR-3d', () => file(IMPORT, `const o = { run(gitEnv) { return ${'spawnSync'}(${Q}git${Q}, ['init'], { env: gitEnv(d) }); } };`), ['a method parameter']],
  // NR-7: the locator counts a space, a newline or `?.` between the name and its paren (R24-4).
  ['NR-7a', () => file(fnBody(`  const r = ${'spawnSync'} (${Q}git${Q}, ['status'], { env: process.env });`)), ['a space before the paren']],
  ['NR-7b', () => file(fnBody(`  const r = ${'spawnSync'}\n    (${Q}git${Q}, ['status'], { env: process.env });`)), ['a newline before the paren']],
  ['NR-7c', () => file(fnBody(`  const r = ${'spawnSync'}?.(${Q}git${Q}, ['status'], { env: process.env });`)), ['an optional call']],
  // R1/R2 (recognition): the spawn is COUNTED, then judged.
  ['R1', () => file(fnBody(`  const r = ${'spawnSync'}(${BT}git${BT}, ['status'], { env: process.env });`)), ['template']],
  ['R2', () => file(fnBody(`  const r = ${'spawnSync'}(${Q}git.exe${Q}, ['status'], { env: process.env });`)), ['git.exe']],
  ['R2b', () => file(fnBody(`  const r = ${'spawnSync'}(${Q}C:/Program Files/Git/bin/git.exe${Q}, ['status'], { env: process.env });`)), ['windows path']],
  ['R2c', () => file(fnBody(`  const r = ${'spawnSync'}(${Q}/usr/bin/git${Q}, ['status'], { env: process.env });`)), ['posix path']],
  ['R3', () => file(fnBody(`  const r = ${'exec'}(${Q}git status${Q}, { env: process.env }, () => {});`)), ['async exec']],
];

for (const [id, make, forms] of MUST_FAIL) {
  for (const form of forms) {
    test(`08d witness ${id} (${form}): COUNTED and a finding, never a pass`, () => {
      const r = census(make(form));
      assert.ok(r.calls === 1 && r.findings.length === 1 && r.refused === 1, `${id} (${form}): ${JSON.stringify(shape(r))} ${r.findings[0] ?? '(no finding)'}`);
    });
  }
}

// P2: the canon release-notes.test.mjs sandboxEnv at blob 7e779ef8 (lines 20 and 27-32), byte for byte; its spawn built from parts.
const SANDBOX = [
  "const BASE_ENV_KEYS = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT'];",
  'const sandboxEnv = (dir) => ({',
  '  ...Object.fromEntries(BASE_ENV_KEYS.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])),',
  "  HOME: dir, USERPROFILE: dir, TEMP: dir, TMP: dir, TMPDIR: dir, GIT_CEILING_DIRECTORIES: path.dirname(dir), GIT_CONFIG_NOSYSTEM: '1',",
  `  HOMEDRIVE: process.platform === 'win32' ? path.parse(dir).root.replace(/[${BS}${BS}/]+${DL}/, '') : undefined,`,
  "  HOMEPATH: process.platform === 'win32' ? dir.slice(path.parse(dir).root.length - 1) : undefined,",
  '});',
].join('\n');

const MUST_PASS = [
  ['P1 (the canon repoName)', () => CANON_REPONAME, ['env'], 'allowlist'],
  ['P2 (the canon sandboxEnv helper)', () => file(SANDBOX, `const git = (cwd, ...a) => ${'spawnSync'}(${Q}git${Q}, a, { cwd, encoding: 'utf8', timeout: 30000, env: sandboxEnv(cwd) });`), ['helper'], 'allowlist'],
  ['P3', (o) => file(IMPORT, fnBody(sp(o))), ['env: gitEnv(d)'], 'helper'],
  ['P3 (const)', (o) => file(IMPORT, fnBody('  const env = gitEnv(d);', sp(o))), BOTH, 'helper'],
  ['P4', (o) => file(fnBody(sp(o))), ["env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_NOSYSTEM: '1' }"], 'allowlist'],
  ['P5', withEnv("  const keep = ['PATH', 'HOME'];", "  const env = { ...Object.fromEntries(keep.filter((k) => k in process.env).map((k) => [k, process.env[k]])), GIT_CONFIG_NOSYSTEM: '1' };"), BOTH, 'allowlist'],
  ['P6', withEnv(KEEP, `  const env = { ${PICK}, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_CEILING_DIRECTORIES: d };`), BOTH, 'allowlist'],
  ['P7 ({} / 1 is a division, as node reads it)', () => file(IMPORT, fnBody(`  const v = {} / 1; const r = ${'spawnSync'}(${Q}git${Q}, ['status'], { env: gitEnv(d) }); const w = 2 / 1;`)), ['{} / 1'], 'helper'],
  ['P6 (a pick const)', withEnv(KEEP, `  const pick = ${PICK.slice(3)};`, "  const env = { ...pick, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_CEILING_DIRECTORIES: d };"), BOTH, 'allowlist'],
];

for (const [id, make, forms, cls] of MUST_PASS) {
  for (const form of forms) {
    test(`08d witness ${id} (${form}): passes as ${cls}, with no finding and no pin`, () => {
      const r = census(make(form));
      assert.deepEqual(shape(r), cls === 'helper' ? [0, 1, 1, 0, 0] : [0, 1, 0, 1, 0], `${id} (${form}): ${r.findings[0] ?? ''}`);
      assert.deepEqual(r.exempted, []);
    });
  }
}

test('08d witness P2: the real scripts/release-notes.test.mjs (the canon overlay, blob 7e779ef8) passes with no pin: both its git spawns take sandboxEnv(), one allowlist literal', () => {
  const rel = 'scripts/release-notes.test.mjs';
  const files = collectScriptsMjs(REPO).filter((f) => f.rel === rel);
  const r = censusGitSpawns(files);
  assert.deepEqual([CENSUS.gitBlobId(files[0].text), shape(r), r.exempted], ['7e779ef8b224c4c0942e11899ed29da4ee847269', [0, 2, 0, 2, 0], []]);
});

test('08d witness P1: the real scripts/release-notes.mjs (the canon overlay, blob f8d998d8) passes alone as one allowlist, with no pin', () => {
  const rel = 'scripts/release-notes.mjs';
  const r = censusGitSpawns(collectScriptsMjs(REPO).filter((f) => f.rel === rel));
  assert.deepEqual([shape(r), r.exempted], [[0, 1, 0, 1, 0], []]);
});

test('the REAL tree: every PRODUCTION git spawn (a non-test script) takes the room helper or an allowlist env, and only the canon gate is pinned', () => {
  const prod = collectScriptsMjs(REPO).filter((f) => !f.rel.endsWith('.test.mjs'));
  const r = censusGitSpawns(prod);
  assert.ok(r.calls >= 3, `verify.mjs (two) and link-check.mjs (one) must be found (${r.calls} calls)`);
  assert.deepEqual(r.findings, [], 'every non-test git spawn is the helper or an allowlist, read in its own text');
  assert.deepEqual(r.exempted, ['scripts/secret-gate.mjs'], 'the canon secret-gate.mjs is the one pinned production file (its own gitEnv keeps GIT_INDEX_FILE)');
});

test('the REAL tree: every git spawn under scripts/ is clean, and the locator finds some (a zero would be a dead locator)', () => {
  const files = collectScriptsMjs(REPO);
  const r = censusGitSpawns(files);
  assert.deepEqual(r.findings, [], 'no git spawn under scripts/ may lack a readable env');
  assert.ok(files.length > 30, `the walk must reach the tree (${files.length} files)`);
  assert.ok(r.calls > 0 && r.viaHelper > 0, `the locator must find git spawns (${r.calls} calls, ${r.viaHelper} via the helper)`);
});

// The census header NAMES four bypasses of the call LOCATOR instead of widening it. This pins them, so the named list cannot rot:
// if one is ever closed, this test goes red on purpose, and the fix is to delete that item from the header's list (and this leg)
// in the same change. Every fixture is a spawn that would be a FINDING if the census saw it.
test('the six NAMED locator bypasses are not counted (a named limit, pinned so the header list cannot rot)', () => {
  const unseen = [
    ['(1) a command that is not a literal', `const GIT = ${Q}git${Q};\n${'spawnSync'}(GIT, ['status'], { env: process.env });`],
    ['(2) a renamed import', `import { ${'spawnSync'} as run } from 'node:child_process';\nrun(${Q}git${Q}, ['status'], { env: process.env });`],
    ['(2) an alias', `const run = ${'spawnSync'};\nrun(${Q}git${Q}, ['status'], { env: process.env });`],
    ['(3) a shell that runs git', `${'spawnSync'}(${Q}sh${Q}, ['-c', 'git status'], { env: process.env });`],
    ['(4) a command string that quotes the path', `${'execSync'}(${Q}"C:/Program Files/Git/bin/git.exe" status${Q}, { env: process.env });`],
    ['(5) a computed member', `const cp = await import('node:child_process');\ncp[${Q}spawnSync${Q}](${Q}git${Q}, ['status'], { env: process.env });`],
    ['(6) an indirect call', `${'spawnSync'}.call(null, ${Q}git${Q}, ['status'], { env: process.env });\nReflect.apply(${'spawnSync'}, null, [${Q}git${Q}, ['status'], { env: process.env }]);`],
  ];
  for (const [name, text] of unseen) assert.deepEqual([census(text).calls, census(text).findings.length], [0, 0], `${name}: not counted at all`);
  // control: the SAME env through a located form IS counted and refused, so the zeros above are the bypass and not a dead locator
  assert.deepEqual(shape(census(`${'spawnSync'}(${Q}git${Q}, ['status'], { env: process.env });`)), [1, 1, 0, 0, 1]);
  assert.deepEqual(shape(census(`cp.${'spawnSync'}(${Q}git${Q}, ['status'], { env: process.env });`)), [1, 1, 0, 0, 1], 'a member call is counted');
});

// CodeQL #52 (fire 31): the census builds RegExps from names. Every caller passes an identifier today, so no census route reaches a
// metacharacter; the escape is tested directly: a RegExp built from a name with any metacharacter matches that name and nothing else.
test('fire 31 (CodeQL #52): escapeRegExp escapes every regex metacharacter, so a RegExp built from a name matches only that name', () => {
  const wrong = [];
  for (const m of ['.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', BS]) {
    const name = `a${m}b`;
    let ok;
    try { const re = new RegExp(`^${CENSUS.escapeRegExp(name)}${DL}`); ok = re.test(name) && !re.test('axb') && !re.test('ab'); } catch { ok = false; }
    if (!ok) wrong.push(m);
  }
  assert.deepEqual(wrong, [], 'each listed metacharacter makes the built RegExp match something other than the name, or throw');
});

// CWK-174 + 08d: the BLOB-PINNED carriers. Each is carried BYTE-EQUAL from its source and cannot be edited room-side, so the census
// exempts exactly its path, and ONLY while its git blob id equals the pinned id: an edit, or a re-sync that moves the blob, turns the
// entry back into findings. Each entry quotes, exactly, the findings it hides (the trailing remedy text cut). A room-local, named
// divergence; an entry comes out the day its source carries an env the census reads and the carrier is re-copied.
import * as CENSUS from './git-env-census.mjs'; // namespace import: a name the pre-fix tree never exported fails an ASSERTION, not the link
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { gitEnv } from './git-env.mjs';

const OPEN = "passes an env that is no allowlist: ";
const STRIP = "its fromEntries reads Object.entries(process.env).filter(([k]) => !/^GIT_/i.tes..., not a named key list";
const viaGitEnv = (more) => `${OPEN}the helper 'gitEnv' returns a literal that is no allowlist: ${STRIP}; ${more}`;
const NO_NOSYS = "it does not set GIT_CONFIG_NOSYSTEM: '1' in its own text";
const GLOBAL = 'it names GIT_CONFIG_GLOBAL, which can aim git at another repository';
const ASSIGNED = `${OPEN}'gitEnv' does not return one object literal`; // d0db994d: gitEnv = () => (envSeen = { ...withoutGit(), ... })
const ARGS = (name) => `passes ${name} where node reads the args array or the options, so the census cannot tell which argument is the options`;
const CARRIERS = {
  'scripts/secret-gate.mjs': ['856956a1cca6f716e5507f6c23ac90ed34cbbe5f', [
    `57 execFileSync('git', ...) ${ARGS('a')}`,
    `60 execFileSync('git', ...) ${viaGitEnv(NO_NOSYS)}`,
  ]],
  'scripts/secret-gate.test.mjs': ['71452210d6a6f793895bc502557fce7e1f3e890c', [
    `40 execFileSync('git', ...) ${OPEN}it spreads gitEnv(); 'extra' is no const the census can read here; ${NO_NOSYS}`,
    `200 execFileSync('git', ...) ${viaGitEnv(GLOBAL)}`,
    `225 execFileSync('git', ...) ${viaGitEnv(GLOBAL)}`,
  ]],
  'scripts/secret-scan.test.mjs': ['d0db994df855ccd647f3ded878a6867bb198e196', [
    `547 spawnSync('git', ...) ${ARGS('args')}`,
    `548 execFileSync('git', ...) ${ARGS('args')}`,
    `715 spawnSync('git', ...) ${ASSIGNED}`,
    `820 execFileSync('git', ...) ${ASSIGNED}`,
    `825 execFileSync('git', ...) ${ASSIGNED}`,
  ]],
};
const carrierText = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const unpinned = (rel) => censusGitSpawns([{ rel: 'scripts/unpinned-copy.test.mjs', text: carrierText(rel) }]).findings
  .map((f) => f.replace(/^scripts\/unpinned-copy\.test\.mjs:/, '').replace(/ -- take gitEnv\(\) from scripts\/git-env\.mjs, or build the env as one literal of named keys with GIT_CONFIG_NOSYSTEM: '1' \(UMB-456 \(2\)\)$/, ''));

test('CWK-174: the exemption names EXACTLY the carried files that need it, each with its pinned blob id', () => {
  assert.ok(CENSUS.EXEMPT_CARRIERS, 'EXEMPT_CARRIERS is exported');
  assert.deepEqual(Object.fromEntries(Object.entries(CENSUS.EXEMPT_CARRIERS).sort()), Object.fromEntries(Object.entries(CARRIERS).map(([rel, [id]]) => [rel, id]).sort()));
});

test('CWK-174: the pinned ids are the real source blobs -- the carriers on disk hash to them (git hash-object --no-filters)', () => {
  for (const [rel, [id]] of Object.entries(CARRIERS)) {
    const viaGit = execFileSync('git', ['hash-object', '--no-filters', rel], { cwd: REPO, encoding: 'utf8', env: gitEnv(REPO) }).trim();
    assert.equal(viaGit, id, `${rel} is the pinned source blob`);
    assert.equal(CENSUS.gitBlobId?.(carrierText(rel)), id, `gitBlobId() (the census's own hash) agrees for ${rel}`);
  }
});

test('CWK-174: a carrier whose bytes equal its pinned blob is exempt, and the exemption is REPORTED', () => {
  for (const rel of Object.keys(CARRIERS)) {
    const r = censusGitSpawns([{ rel, text: carrierText(rel) }]);
    assert.deepEqual(r.findings, [], `${rel} is exempt while it is the pinned blob`);
    assert.deepEqual(r.exempted, [rel], 'and the exemption is named in the report');
  }
});

// R14 INSPECT F-R14-5: an exemption that hides no finding is attack surface for nothing. Every entry EARNS its place, and the findings it
// hides are exactly the ones quoted above (a moved line or a changed reason turns this red, so the quote cannot drift from the code).
test('CWK-174 + 08d: every exempt carrier earns its entry -- the same bytes at an unpinned path are EXACTLY the quoted findings', () => {
  for (const rel of Object.keys(CENSUS.EXEMPT_CARRIERS)) {
    assert.ok(unpinned(rel).length > 0, `${rel}: the pin hides nothing, so it must not be there`);
    assert.deepEqual(unpinned(rel), CARRIERS[rel][1], `${rel}: the findings the pin hides`);
  }
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
