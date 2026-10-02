import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { pointerCandidates, checkPointers, looksPathShaped, deriveIgnoredRoots, PENDING_POINTERS } from './pointer-check.mjs';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { gitEnv } from './git-env.mjs';

// FIXTURES ARE INPUT, NOT CLAIMS. Every backticked path below is DATA this test feeds
// the gate, never a statement this repo makes about its own tree. They keep their
// backticks on purpose: stripping them to keep some future scan quiet would launder the
// fixtures and leave the gate untested on exactly the shapes it exists to catch. There
// is no conflict today by construction — the shipped walk reads the 10 ship-text
// surfaces (skills/**.md, commands/*.md, and five root docs) and no source file at all.

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


// ---------------------------------------------------------------- CWK-079: SHAPE
//
// looksPathShaped feeds the IGNORE PROBE's candidate DISCOVERY only. The exhibits below
// are this room's own measured non-path population, taken from the 10 walked surfaces
// (11 tokens, 6 distinct first segments) — arithmetic and identifier pairs, not paths.

test('SHAPE-079: looksPathShaped rejects this room\'s own measured non-path tokens', () => {
  for (const tok of ['n/a', 'EVIDENCE=n/a', 'beforeBytes/afterBytes', 'alwaysBeforeTokens/alwaysAfterTokens', 'WIZARD-2/4', 'WIZARD-3/4']) {
    assert.strictEqual(looksPathShaped(tok), false, `${tok} is not a path and must not reach the probe`);
  }
});

test('SHAPE-079: looksPathShaped accepts a filename-shaped token, including one with a :line ref', () => {
  for (const tok of ['scripts/lib/apply.mjs', 'skills/coalwash/SKILL.md', 'scripts/verify.mjs:259']) {
    assert.strictEqual(looksPathShaped(tok), true, `${tok} is filename-shaped and must reach the probe`);
  }
});

test('SHAPE-079: looksPathShaped accepts an explicit trailing-slash directory reference', () => {
  assert.strictEqual(looksPathShaped('scripts/lib/'), true);
});

test('SHAPE-079 residue: a trailing slash is accepted with NO check on what precedes it', () => {
  assert.strictEqual(looksPathShaped('os.tmpdir()/coalwash/'), true,
    'named residue, not an oversight — see the function\'s own comment');
});

test('SHAPE-079 residue: an extensionless real path is DISCOVERY-excluded, never check-exempt', () => {
  assert.strictEqual(looksPathShaped('scripts/lib'), false,
    'excluded from DISCOVERY only — the NON-LOCAL pair below is why that is not the same as exempt');
  // INSPECT F5 — THE SEAM, asserted in the cell that already owns this residue rather
  // than in a new one (a hygiene round should not move the suite count). looksPathShaped
  // segments on '/' ALONE, so a Windows-separator token would be mis-segmented: measured
  // on the shipped function, a backslash token reads as ONE segment. That is unreachable
  // ONLY because pointerCandidates drops backslash tokens outright — a guarantee that
  // lives in the POSIX block far above and was connected to this function by nothing.
  // Asserted, not commented, so a future relaxation of that rule (or a second caller that
  // bypasses pointerCandidates) goes RED here instead of silently mis-segmenting.
  assert.deepStrictEqual(pointerCandidates('see `scripts' + String.fromCharCode(92) + 'lib' + String.fromCharCode(92) + 'apply.mjs` here'), [],
    'the backslash rule is what keeps looksPathShaped POSIX-only-safe');
  assert.strictEqual(looksPathShaped('scripts' + String.fromCharCode(92) + 'lib'), false,
    'and this is what it would do with one — mis-segmented, not evaluated');
});

// ---------------------------------------------------------- CWK-079: DERIVATION

// A real git repo, because the whole point of the change is what GIT answers for a path
// that is not on disk. A fake runCheckIgnore would prove only that our parser parses.
// HERMETIC ENV — the fixture's own worst failure, MEASURED not imagined. git
// exports GIT_DIR (and GIT_INDEX_FILE) to every hook it runs, so a suite run
// from `.githooks/pre-commit` hands these git calls the CALLER's repository.
// From the main worktree GIT_DIR is the relative ".git", which re-resolves
// harmlessly against `cwd: dir`; from a LINKED WORKTREE it is ABSOLUTE, and
// then `git init` in this fixture RE-INITIALISES THE REAL REPOSITORY instead
// of the temp dir — observed live: the parent repo's core.bare flipped to true
// and `check-ignore` answered against the real .gitignore, so a fixture cell
// that expects 2 ignored roots read 0. A test that can reconfigure the
// developer's own repo is not a hermetic test, whatever it asserts.
// Scrubbed rather than overridden: an inherited value we do not know about is
// exactly the class that produced this, so the family is DELETED, never re-set.
// CWK-133 CLOSED THE DENY-LIST'S OWN RESIDUE: this file used to carry a hand-listed set of
// fourteen names and NAMED the residue ("a git variable outside this list that redirects
// resolution"). A list is exactly what rots, so the scrub is now scripts/git-env.mjs's
// `gitEnv`: every GIT_-prefixed key out, whatever git adds under that prefix next, and the
// fixture's own parent as the ceiling. The variables it now also drops (authorship,
// paging, formatting) cannot matter to the two calls below, which only `init` and
// `check-ignore`; none of them commits.
const hermeticGitEnv = (dir) => gitEnv(path.dirname(dir));

function gitFixture(gitignoreText) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-079-')));
  const r = spawnSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: dir, encoding: 'utf8', env: hermeticGitEnv(dir) });
  if (r.error || r.status !== 0) {
    // INSPECT F3 — the dir exists BEFORE git is probed, and on this path the caller gets
    // null, so its own finally{} holds no handle to remove. Leaving it re-opens board
    // #107's litter class on the one path nobody here runs (git is present on this box).
    // Cleaned HERE because this is the only scope that still has the name.
    fs.rmSync(dir, { recursive: true, force: true });
    return null; // git unavailable — caller SKIPs visibly
  }
  fs.writeFileSync(path.join(dir, '.gitignore'), gitignoreText);
  return dir;
}
const runner = (dir) => (names) => {
  // Same scrub as gitFixture above, same reason: an inherited GIT_DIR makes this
  // answer for the caller's repository rather than the fixture's.
  const ci = spawnSync('git', ['check-ignore', '-v', '--stdin'],
    { cwd: dir, encoding: 'utf8', env: hermeticGitEnv(dir), input: names.map((n) => n + "/").join('\n') + '\n' });
  return ci.error ? '' : ci.stdout;
};

test('DERIVE-079: the ignore set is EXISTENCE-INDEPENDENT — an absent gitignored root is still found', (t) => {
  const dir = gitFixture('throwaway-build/\n');
  if (!dir) return t.skip('git unavailable');
  try {
    assert.strictEqual(fs.existsSync(path.join(dir, 'throwaway-build')), false,
      'the fixture must NOT create the directory — absence is the whole point');
    const ign = deriveIgnoredRoots({
      surfaces: [S('README.md', 'see `throwaway-build/readme.md`')],
      runCheckIgnore: runner(dir),
    });
    assert.deepStrictEqual([...ign.ignored], ['throwaway-build'],
      'a disk-derived probe reads ZERO here, which is the defect CWK-079 removes');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('DERIVE-079: a CRLF .gitignore\'s blank line must not ignore EVERYTHING (the exemplar\'s shape does)', (t) => {
  const dir = gitFixture('docs/\r\n\r\nskills-lock.json\r\n');
  if (!dir) return t.skip('git unavailable');
  try {
    const ign = deriveIgnoredRoots({
      surfaces: [S('README.md', '`docs/x.md` and `zzz/y.md`')],
      runCheckIgnore: runner(dir),
    });
    assert.ok(ign.ignored.has('docs'), 'the REAL pattern must still match');
    assert.ok(!ign.ignored.has('zzz'), 'an unrelated root must NOT be ignored by a blank CRLF line');
    assert.strictEqual(ign.artefacts.length, 1, "the dropped row is REPORTED, never silently swallowed");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('DERIVE-079: agent homes are held out BEFORE the probe, and counted separately', () => {
  const ign = deriveIgnoredRoots({
    surfaces: [S('README.md', '`.claude/coalwash/keeps.json` and `scripts/lib/apply.mjs`')],
    agentHomes: new Set(['.claude', '.agents']),
    runCheckIgnore: () => '',
  });
  assert.deepStrictEqual([...ign.probed], ['scripts'], 'the agent home never reaches git');
  assert.strictEqual(ign.homesPresent, 1);
  assert.strictEqual(ign.cited.size, 2, 'CITED counts what the surfaces name; PROBED counts what git was asked');
});

test('DERIVE-079: CITED and PROBED are separate numbers, and a non-path token is in NEITHER', () => {
  const ign = deriveIgnoredRoots({
    surfaces: [S('README.md', '`scripts/lib/apply.mjs` `WIZARD-2/4` `n/a`')],
    runCheckIgnore: () => '',
  });
  assert.deepStrictEqual([...ign.cited], ['scripts']);
  assert.deepStrictEqual(ign.probed, ['scripts']);
});

// ------------------------------------------------------------ CWK-079: NON-LOCAL
//
// THE PROPERTY THE SHAPE TEST MUST NOT BE READ PAST. `looksPathShaped` gates DISCOVERY,
// never JUDGEMENT: an extensionless citation under a gitignored root is exempt only from
// contributing its OWN root. Alone it is silent; the moment ANY unrelated shape-qualified
// citation shares that root, it FAILs with it. Proven with a two-plant pair through the
// real derivation and the real checker — the verdict for plant A depends on plant B.

test('NON-LOCAL-079: an extensionless citation under a gitignored root is checked non-locally, not exempt', (t) => {
  const dir = gitFixture('throwaway-build/\n');
  if (!dir) return t.skip('git unavailable');
  try {
    const plantA = S('commands/stats.md', 'Notes: `throwaway-build/notes`.');
    const plantB = S('commands/update.md', 'Reference: `throwaway-build/readme.md`.');
    const check = (surfaces) => {
      const ign = deriveIgnoredRoots({ surfaces, runCheckIgnore: runner(dir) });
      return checkPointers({
        ...base, surfaces, ignoredRoots: ign.ignored, ourRoots: new Set(['commands']),
      });
    };

    // A ALONE: shape-rejected at discovery, nothing else names that root -> SILENT.
    assert.deepStrictEqual(msgs(check([plantA])), [],
      'plant A alone must stay silent — extensionless, so it discovers no root of its own');

    // A + B: B is filename-shaped, arms the root, and now BOTH are judged.
    const both = msgs(check([plantA, plantB]));
    assert.strictEqual(both.length, 2, `both plants must FAIL once the root is armed, got: ${both.join(" | ")}`);
    assert.ok(both.some((m) => m.includes('throwaway-build/notes') && /gitignored/.test(m)),
      'plant A was never exempt from the CHECK — only from discovering its own root');
    assert.ok(both.some((m) => m.includes('throwaway-build/readme.md') && /gitignored/.test(m)),
      'plant B, the citation that armed the root, must FAIL too');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
