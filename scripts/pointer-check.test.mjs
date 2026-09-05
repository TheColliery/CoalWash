import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { pointerCandidates, checkPointers, PENDING_POINTERS } from './pointer-check.mjs';

// FIXTURES ARE INPUT, NOT CLAIMS. Every backticked path below is DATA this test feeds
// the gate, never a statement this repo makes about its own tree. They keep their
// backticks on purpose: stripping them to keep some future scan quiet would launder the
// fixtures and leave the gate untested on exactly the shapes it exists to catch. There
// is no conflict today by construction — the shipped walk reads the 9 ship-text
// surfaces (skills/**.md, commands/*.md, and four root docs) and no source file at all.

const S = (label, text, extra = {}) => ({ label, text, ...extra });
const base = {
  ourRoots: new Set(['scripts', 'skills', 'commands', 'hooks', 'plugin']),
  ignoredRoots: new Set(['scratchpad', 'docs', 'MEMORY.md', 'work']),
  agentHomes: new Set(['.claude', '.agents', '.gemini']),
  hasEntry: (dir, name) => dir === 'skills/coalwash' && name === 'references',
  resolve: (p) => (p === 'scripts/lib/apply.mjs' || p === 'skills/coalwash/references/method.md' ? 'tracked'
    : p === 'scripts/untracked-thing.mjs' ? 'untracked' : 'missing'),
};
const msgs = (f) => f.filter((x) => x.level === 'FAIL').map((x) => x.msg);

// ---------------------------------------------------------------- SHAPE

test('SHAPE: each drop reason removes its own token and nothing else', () => {
  const cases = [
    ['`node scripts/build.mjs x`', 'whitespace — a command, not a pointer'],
    ['`plugin/skills/<name>/SKILL.md`', 'angle placeholder'],
    ['`[project]/.claude/coalwash/`', 'square bracket — GLOB owns the [project]/ family'],
    ['`.claude/coalwash/**`', 'glob metacharacter'],
    ['`SKILL.md`', 'no directory component'],
    ['`~/.claude/projects/x`', 'home-relative'],
    ['`/etc/passwd`', 'absolute'],
    ['`https://example.com/a/b`', 'URL'],
    ['`../escape.md`', 'a `..` whole segment'],
    ['`./local.md`', 'a `.` whole segment'],
  ];
  for (const [text, why] of cases) {
    assert.deepStrictEqual(pointerCandidates(text), [], `should drop: ${why} (${text})`);
  }
  // ...while a real pointer survives every one of them.
  assert.deepStrictEqual(pointerCandidates('`scripts/lib/apply.mjs`'), ['scripts/lib/apply.mjs']);
});

test('SHAPE: a dot-DIR is NOT a dot-SEGMENT — `.github/workflows/ci.yml` survives', () => {
  assert.deepStrictEqual(pointerCandidates('`.github/workflows/ci.yml`'), ['.github/workflows/ci.yml']);
});

test('SHAPE: fenced blocks are stripped FIRST — a path inside a fence is an EXAMPLE, not a claim', () => {
  const text = ['```', 'see `scratchpad/gone.md`', '```', 'and `scripts/lib/apply.mjs`'].join('\n');
  assert.deepStrictEqual(pointerCandidates(text), ['scripts/lib/apply.mjs']);
});

// ---------------------------------------------------------------- POSIX PORTABILITY

test('POSIX: the backslash rule is PLATFORM-UNCONDITIONAL — asserted through both path flavours explicitly', () => {
  // A backslash is a legal FILENAME character on POSIX and a separator on Windows, so a
  // segment-scan rule is wrong on one of them by construction. Rejecting the CHARACTER
  // removes the platform from the question entirely. Asserted with path.win32 and
  // path.posix named rather than assuming the property carried across the port.
  assert.notStrictEqual(path.win32.sep, path.posix.sep, 'the two flavours genuinely differ');
  for (const tok of ['scripts/..\\..\\escape.md', 'scripts\\lib/apply.mjs', 'scripts\\lib\\apply.mjs']) {
    assert.deepStrictEqual(pointerCandidates('`' + tok + '`'), [], `rejected regardless of platform: ${tok}`);
  }
  // The module makes no platform decision at all: it imports no path module and branches
  // on no separator, so the same input yields the same output on every host.
  assert.deepStrictEqual(pointerCandidates('`scripts/lib/apply.mjs`'), ['scripts/lib/apply.mjs']);
});

// ---------------------------------------------------------------- THREE STATES

test('STATE tracked: a resolving citation is silent', () => {
  const f = checkPointers({ ...base, surfaces: [S('README.md', '`scripts/lib/apply.mjs`')] });
  assert.deepStrictEqual(msgs(f), []);
  assert.strictEqual(f.checked, 1, 'and it was COUNTED — silence is not a skip');
});

test('STATE gitignored: FAILs, and the message names the root', () => {
  const f = checkPointers({ ...base, surfaces: [S('README.md', '`scratchpad/probe.mjs`')] });
  assert.strictEqual(msgs(f).length, 1);
  assert.match(msgs(f)[0], /gitignored/);
  assert.match(msgs(f)[0], /scratchpad/);
});

test('STATE gitignored: a top-level FILE root FAILs too — the enumeration must not be dirs-only', () => {
  // The adoption hazard for THIS room: our .gitignore is dominated by top-level FILES.
  const f = checkPointers({ ...base, surfaces: [S('README.md', '`MEMORY.md/section`')] });
  assert.strictEqual(msgs(f).length, 1);
  assert.match(msgs(f)[0], /gitignored/);
});

test('STATE untracked: exists here but a clone does not have it', () => {
  const f = checkPointers({ ...base, surfaces: [S('README.md', '`scripts/untracked-thing.mjs`')] });
  assert.strictEqual(msgs(f).length, 1);
  assert.match(msgs(f)[0], /UNTRACKED/);
});

test('STATE missing: does not resolve at all', () => {
  const f = checkPointers({ ...base, surfaces: [S('README.md', '`scripts/nope.mjs`')] });
  assert.strictEqual(msgs(f).length, 1);
  assert.match(msgs(f)[0], /does not resolve/);
});

// ---------------------------------------------------------------- ORDER

test('ORDER: a PENDING declaration cannot launder a GITIGNORED path', () => {
  // The gitignored branch runs BEFORE pending, deliberately: a declaration excuses a
  // path that does not exist YET, never one that exists and is unreachable from a clone.
  const f = checkPointers({
    ...base,
    surfaces: [S('README.md', '`scratchpad/probe.mjs`')],
    pending: [{ path: 'scratchpad/probe.mjs', reason: 'trying to launder it' }],
  });
  assert.ok(msgs(f).some((m) => /gitignored/.test(m)), 'the declaration must not silence it');
});

test('ORDER: an agent home is checked BEFORE the gitignored branch', () => {
  // .claude/ is gitignored HERE and is also the user-tree path our shipped prose names.
  // Wrong order = a FAIL on a correct citation.
  const f = checkPointers({
    ...base,
    ignoredRoots: new Set(['.claude', 'scratchpad']),
    surfaces: [S('PRIVACY.md', '`.claude/coalwash/keeps.json`')],
  });
  assert.deepStrictEqual(msgs(f), []);
});

test('ORDER: an agent home matches the EXACT first segment — `.claude-plugin/` is OURS', () => {
  // A bare startsWith('.claude') would swallow .claude-plugin/plugin.json, a real
  // tracked file of ours, and silently drop it from coverage.
  const f = checkPointers({
    ...base,
    ourRoots: new Set(['.claude-plugin']),
    resolve: () => 'missing',
    surfaces: [S('README.md', '`.claude-plugin/plugin.json`')],
  });
  assert.strictEqual(msgs(f).length, 1, '.claude-plugin must stay IN scope, not be taken for .claude');
});

// ---------------------------------------------------------------- SCOPE

test('SCOPE citer-relative: `references/method.md` from its own skill dir RESOLVES', () => {
  const f = checkPointers({ ...base, surfaces: [S('skills/coalwash/SKILL.md', '`references/method.md`')] });
  assert.deepStrictEqual(msgs(f), []);
  assert.strictEqual(f.checked, 1, 'it is CHECKED, not skipped — that is the whole point');
});

test('SCOPE: without the citer-relative test the same token is SILENTLY skipped (the QUIET symptom)', () => {
  // Our measured symptom is the quiet one, not a loud false positive: `references` does
  // not exist at the repo root, so a root-anchored gate finds no base and drops the
  // citation from coverage without a word. This pins the difference as a COUNT.
  const rootAnchoredOnly = { ...base, hasEntry: () => false };
  const f = checkPointers({ ...rootAnchoredOnly, surfaces: [S('skills/coalwash/SKILL.md', '`references/method.md`')] });
  assert.deepStrictEqual(msgs(f), [], 'silent — no finding at all');
  assert.strictEqual(f.checked, 0, 'and UNCOUNTED: a skipped citation, not a passing one');
});

test('SCOPE: a path into someone else\'s tree is out of scope, not a finding', () => {
  const f = checkPointers({ ...base, surfaces: [S('README.md', '`TheColliery/.github/benchmarks`')] });
  assert.deepStrictEqual(msgs(f), []);
  assert.strictEqual(f.checked, 0);
});

// ---------------------------------------------------------------- HISTORY-ONLY

test('HISTORY-ONLY: a renamed path is forgiven, a gitignored one never was correct', () => {
  const surfaces = [S('CHANGELOG.md', '`scripts/gone.mjs` and `scratchpad/probe.mjs`', { historyOnly: true })];
  const f = checkPointers({ ...base, surfaces });
  const m = msgs(f);
  assert.strictEqual(m.length, 1, 'exactly one — the gitignored citation');
  assert.match(m[0], /gitignored/);
});

// ---------------------------------------------------------------- EXPIRY

test('EXPIRY: a PENDING entry that now resolves must be deleted', () => {
  const f = checkPointers({
    ...base,
    surfaces: [S('README.md', '`scripts/lib/apply.mjs`')],
    pending: [{ path: 'scripts/lib/apply.mjs', reason: 'landing next unit' }],
  });
  assert.ok(msgs(f).some((m) => /now resolves — delete the entry/.test(m)));
});

test('EXPIRY: a PENDING entry nothing cites must be deleted', () => {
  const f = checkPointers({
    ...base,
    surfaces: [S('README.md', '`scripts/lib/apply.mjs`')],
    pending: [{ path: 'scripts/orphan.mjs', reason: 'nobody points at it' }],
  });
  assert.ok(msgs(f).some((m) => /no in-scope surface cites it/.test(m)));
});

test('EXPIRY: a bare string with no reason is a bypass with no author', () => {
  const f = checkPointers({
    ...base,
    surfaces: [S('README.md', '`scripts/nope.mjs`')],
    pending: [{ path: 'scripts/nope.mjs' }],
  });
  assert.ok(msgs(f).some((m) => /no reason/.test(m)));
});

// ---------------------------------------------------------------- WIRING

test('WIRING: an unreadable surface is NAMED, never silently dropped', () => {
  const f = checkPointers({ ...base, surfaces: [S('README.md', null)] });
  assert.ok(f.some((x) => x.level === 'SKIP' && /could not read README\.md/.test(x.msg)));
});

test('WIRING: no resolve() supplied FAILs loud rather than reporting clean', () => {
  const f = checkPointers({ surfaces: [S('README.md', '`scripts/x.mjs`')] });
  assert.strictEqual(msgs(f).length, 1);
  assert.match(msgs(f)[0], /cannot answer its own question/);
});

test('WIRING: PENDING_POINTERS ships EMPTY, and the empty list is the measurement', () => {
  assert.deepStrictEqual(PENDING_POINTERS, []);
});

test('WIRING: history-only is a SURFACE property, never a per-path allowlist', () => {
  // There is deliberately no HISTORY_ONLY_POINTERS list. The flag rides the surface,
  // and this pins that the mechanism reached by that flag actually works -- so nobody
  // re-adds an exported constant naming a mechanism that does not exist.
  const f = checkPointers({ ...base, surfaces: [S('CHANGELOG.md', '`scripts/gone.mjs`', { historyOnly: true })] });
  assert.deepStrictEqual(msgs(f), [], 'a stale-but-once-correct path is forgiven on a history surface');
});

// ---------------------------------------------------------------- NON-CIRCULARITY

test('NON-CIRCULAR: membership and verdict are SEPARATE predicates', () => {
  // The circular-count trap: if `checked` only counted paths that resolve, the gate
  // could never fire and the measurement would still read clean. Same in-scope token,
  // two different resolve() answers -> checked identical, findings differ.
  const surfaces = [S('README.md', '`scripts/lib/apply.mjs`')];
  const good = checkPointers({ ...base, surfaces });
  const bad = checkPointers({ ...base, surfaces, resolve: () => 'missing' });
  assert.strictEqual(good.checked, bad.checked, 'membership does not depend on the verdict');
  assert.strictEqual(msgs(good).length, 0);
  assert.strictEqual(msgs(bad).length, 1);
});
