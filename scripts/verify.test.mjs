// VERIFY-GATE LIVENESS — the gate must REPORT its own failure, never die of it.
//
// WHAT WENT WRONG. verify.mjs carried two STATIC top-level imports of
// scripts/lib/ modules. ESM resolves a static import while linking the module
// graph, BEFORE the first try/catch in the file exists — so on a sparse
// caretaker bench (scripts/lib/ checked out minus config-schema.mjs) the gate
// died with a raw ERR_MODULE_NOT_FOUND and printed ZERO `FAIL <item>` lines.
// Every per-check wrap in that file was correct: a per-check wrap structurally
// cannot cover the file's own imports.
//
// WHY THIS OUTRANKS TIDINESS: a gate that dies is indistinguishable from a gate
// that was never run. The bench reported nothing, which reads exactly like
// nothing to report.
//
// WHAT THIS ASSERTS: the REAL verify.mjs, run against an EMPTY tree (the
// maximal form of "a required file is missing"), honours the fail-loud contract
// scripts-quality.md §1 sets and verify.mjs's own header claims — non-zero
// exit, one enumerated FAIL line per missing item, its own summary line, and no
// raw stack trace.
//
// PROVED RED, not assumed: restoring either static import empties stdout and
// puts an ERR_MODULE_NOT_FOUND trace on stderr, flipping assertions 2-4.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERIFY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'verify.mjs');

test('verify.mjs REPORTS missing scripts/lib files instead of dying on them', () => {
  // verify.mjs derives `repo` from its OWN location, so a lone copy in an empty
  // tree makes every required file missing — no repo copy, no mutation of the
  // real checkout. Fixture root canonicalized the engine's way (.native).
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-verifygate-')));
  try {
    const dest = path.join(root, 'scripts', 'verify.mjs');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(VERIFY, dest);

    const r = spawnSync(process.execPath, [dest], { encoding: 'utf8' });
    const stdout = r.stdout ?? '';
    const stderr = r.stderr ?? '';

    assert.notStrictEqual(r.status, 0, `fail LOUD: everything is missing, exit must be non-zero\n${stdout}`);
    assert.doesNotMatch(stderr, /ERR_MODULE_NOT_FOUND/, `the gate must not die on its own imports\n${stderr}`);
    assert.doesNotMatch(stderr, /^\s+at /m, `a raw stack trace is the banned failure mode\n${stderr}`);
    // The two libs verify.mjs used to import statically; any lib would do, these
    // are the ones whose absence used to be fatal.
    for (const lib of ['config-schema.mjs', 'jsonc.mjs']) {
      assert.ok(stdout.includes(`FAIL scripts/lib/${lib} missing`),
        `every missing lib gets its own enumerated FAIL line (${lib})\n${stdout}`);
    }
    assert.match(stdout, /\nVERIFY: FAIL \(\d+\)/, `the run must reach its own summary line\n${stdout}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// board #64: DESC_CAP walked skill/command frontmatter only; plugin.json's own
// description field was unchecked. This runs the REAL verify.mjs against a
// full-tree copy (every top-level path verify.mjs itself reads — see the
// `path.join(repo, ...)` enumeration this list is drawn from) so both the
// pristine-passes and the over-cap-fails legs exercise the actual gate, not a
// stand-in. Proved RED first, by hand, before this test existed — see
// desccap-cw-return.md for the manual transcript.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// CWK-066 F1: this fixture copies the WHOLE tree, including scripts/lib/ --
// which is also where tests write short-lived transients (.cw-reexport-hop-*
// from config-load.test.mjs, the mutation-proof mutants from
// input-contract.test.mjs). node --test runs files as concurrent processes, so
// an unfiltered cpSync can enumerate a transient and then lstat it after it is
// gone: ENOENT, reddening THIS test for something another file did. A bare
// cpSync races even a DOT-PREFIXED transient -- measured -- because the
// convention only protects readers that actually honour it. This is that
// honouring; it is NARROWER than build-plugin.mjs's hasStrayDotDir at :83, for
// the reason stated immediately below.
// SCOPED TO WHERE SCRATCH ACTUALLY LIVES, not to dot-names in general. A
// blanket dot-exclusion is WRONG for this fixture and was caught reddening it
// on the first attempt: platform-configs/.coalwash.json is a dot FILE that must
// copy, and plugin/.claude-plugin/ is a dot DIR that must copy. build-plugin.mjs
// can use a blanket rule because it copies .claude-plugin as its OWN DIST_ITEM,
// so the dot is the item root; this fixture copies plugin/ wholesale, where the
// same directory is a CHILD. The transients are all dot-prefixed files directly
// under scripts/lib -- .cw-reexport-hop-* (config-load.test.mjs) and .mutant-*
// (input-contract.test.mjs) -- so that, and only that, is what is skipped.
// SEGMENT COMPARISON, NOT A REGEX, and that is deliberate. The first version of
// this was /^scripts[\\/]lib[\\/]\./ written through a shell heredoc, which ate
// the backslash and shipped /^scripts[\/]lib[\/]\./ -- a class containing only
// the forward slash. path.relative returns BACKSLASHES on Windows, so the
// predicate matched nothing and the fix was inert on the platform it was
// measured on. Caught by the session-end canary. Splitting on path.sep has no
// escape to lose.
const notScratch = (s) => {
  const seg = path.relative(REPO, s).split(path.sep);
  return !(seg[0] === 'scripts' && seg[1] === 'lib' && (seg[2] || '').startsWith('.'));
};

test('verify.mjs: an over-cap .claude-plugin/plugin.json description FAILs the gate', () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-desccap-')));
  try {
    for (const rel of [
      '.claude-plugin', '.github', 'LICENSE', 'NOTICE', 'commands', 'hooks',
      'platform-configs', 'plugin', 'scripts', 'skills',
      // The config-key drift gate NAMES its ship-text surfaces rather than
      // existsSync-filtering them, so an absent one is REPORTED as unreadable
      // instead of silently shrinking the scan. That is the property worth
      // having, so the fixture grows to match rather than the gate softening.
      'README.md', 'SECURITY.md', 'PRIVACY.md', 'CONTRIBUTING.md', 'INPUT-CONTRACT.md',
    ]) {
      const src = path.join(REPO, rel);
      if (!fs.existsSync(src)) continue;
      fs.cpSync(src, path.join(root, rel), { recursive: true, filter: notScratch });
    }
    const dest = path.join(root, 'scripts', 'verify.mjs');
    const run = () => spawnSync(process.execPath, [dest], { encoding: 'utf8' });

    const clean = run();
    assert.strictEqual(clean.status, 0, `pristine copy must PASS\n${clean.stdout}${clean.stderr}`);
    assert.match(clean.stdout, /ok\s+\.claude-plugin\/plugin\.json: \d+ chars \(cap 1024\)/,
      `pristine PASS line must name the real char count\n${clean.stdout}`);

    const pjPath = path.join(root, '.claude-plugin', 'plugin.json');
    const pj = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
    pj.description = 'x'.repeat(1100);
    fs.writeFileSync(pjPath, JSON.stringify(pj, null, 2) + '\n', 'utf8');

    const over = run();
    assert.strictEqual(over.status, 1, 'an over-cap plugin.json description must FAIL with exit 1');
    assert.match(over.stdout, /FAIL\s+\.claude-plugin\/plugin\.json: description 1100 chars exceeds the 1024-char cap/,
      `the FAIL line must name the file, the exact length, and the cap\n${over.stdout}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('verify.mjs: a truthy NON-STRING plugin.json description FAILs loud, never silently reads as 0 chars', () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-desccap-nonstring-')));
  try {
    for (const rel of [
      '.claude-plugin', '.github', 'LICENSE', 'NOTICE', 'commands', 'hooks',
      'platform-configs', 'plugin', 'scripts', 'skills',
      // The config-key drift gate NAMES its ship-text surfaces rather than
      // existsSync-filtering them, so an absent one is REPORTED as unreadable
      // instead of silently shrinking the scan. That is the property worth
      // having, so the fixture grows to match rather than the gate softening.
      'README.md', 'SECURITY.md', 'PRIVACY.md', 'CONTRIBUTING.md', 'INPUT-CONTRACT.md',
    ]) {
      const src = path.join(REPO, rel);
      if (!fs.existsSync(src)) continue;
      fs.cpSync(src, path.join(root, rel), { recursive: true, filter: notScratch });
    }
    const pjPath = path.join(root, '.claude-plugin', 'plugin.json');
    const pj = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
    pj.description = 123; // truthy non-string — must never read as 0 chars and pass
    fs.writeFileSync(pjPath, JSON.stringify(pj, null, 2) + '\n', 'utf8');

    const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'verify.mjs')], { encoding: 'utf8' });
    assert.strictEqual(r.status, 1, 'a non-string description must FAIL, not silently pass as 0 chars');
    assert.match(r.stdout, /FAIL\s+\.claude-plugin\/plugin\.json: description is not a string \(number\)/,
      `must name the actual type, not silently report 0 chars\n${r.stdout}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// CW-015 (b), r34: EVERY verify.mjs spawn above runs OUTSIDE a git repository, so
// verify.mjs's `pointers (ship-text vs the tree):` block took its named "git
// unavailable" skip in all of them. Its wiring could be deleted with the suite fully
// green — a gate the suite could not observe. This runs the REAL gate inside a REAL
// repository and plants one citation of each kind the block exists to refuse.
//
// THE FIXTURE RAIL, and each clause is a measured incident, not caution:
// - the tree lives under os.tmpdir(), never under this repo;
// - git is invoked with `-C <fixture>` on EVERY call, and with every GIT_* variable
//   scrubbed. A suite run from `.githooks/pre-commit` inherits GIT_DIR, and from a
//   linked worktree it is ABSOLUTE — scripts/pointer-check.test.mjs's CWK-079 header
//   records `git init` in a fixture re-initialising the REAL repository that way. The
//   scrub is a PREFIX, not that file's list: wider by construction, and no roster to
//   keep in step with it;
// - the fixture's own `.git` is ASSERTED to exist before anything else touches it: a
//   git command with no `.git` beside it walks UP to the nearest repository (on
//   2026-09-10 a fixture's `git config core.bare true` did exactly that and broke the
//   umbrella);
// - and this test runs NO `git config` at all. `git add` fills the index, which is
//   what `ls-files` answers from, so no commit, no identity and no signing config.
//
// WHY NOT `core.bare true`, which CoalHearth's 0413924 sets: there it builds a
// FAIL-LOUD test for a check-ignore that cannot run. A bare repository refuses
// `check-ignore` outright, which would switch off exactly the gitignored-root branch
// this test needs to see. That other test is a different question, reported
// separately rather than folded in here.
//
// THE TREE IS THE TRACKED FILE LIST, copied from disk: it is what a clone has, which
// is the question the pointer gate asks.
const hermeticGit = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));

// The tracked tree in a real repo, fenced per the rail above. Returns null when git is
// unavailable (the caller skips visibly). The dir is cleaned HERE if building it throws,
// and by the caller's finally once this returns.
function trackedTreeRepo() {
  const listed = spawnSync('git', ['-C', REPO, 'ls-files', '-z'], { encoding: 'utf8', env: hermeticGit() });
  if (listed.error || listed.status !== 0) return null;
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-verify-git-')));
  try {
    const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env: hermeticGit() });
    const init = git('init', '-q', '-b', 'main');
    assert.strictEqual(init.status, 0, `git init in the fixture failed\n${init.stderr}`);
    assert.ok(fs.statSync(path.join(root, '.git')).isDirectory(),
      'FIXTURE RAIL: the fixture must own its .git before any other git call, or git walks UP to a real repository');

    for (const rel of listed.stdout.split('\0').filter(Boolean)) {
      const src = path.join(REPO, rel);
      if (!fs.existsSync(src)) continue; // deleted in the working tree, not yet committed
      const dest = path.join(root, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
    const added = git('add', '-A');
    assert.strictEqual(added.status, 0, `git add in the fixture failed\n${added.stderr}`);
    const tracked = git('ls-files');
    assert.ok(tracked.stdout.includes('scripts/verify.mjs'), `the fixture index must hold the tree\n${tracked.stderr}`);
    const run = () => spawnSync(process.execPath, [path.join(root, 'scripts', 'verify.mjs')], { encoding: 'utf8', env: hermeticGit() });
    return { root, git, run };
  } catch (e) { fs.rmSync(root, { recursive: true, force: true }); throw e; }
}

test('verify.mjs inside a REAL git repo: the pointer-drift block RUNS, and a missing, an untracked and a gitignored citation each FAIL', (t) => {
  const fx = trackedTreeRepo();
  if (!fx) return t.skip('git unavailable');
  const { root, git, run } = fx;
  try {

    // CLEAN: the block runs and reports both of its own coverage lines.
    const clean = run();
    assert.strictEqual(clean.status, 0, `the tracked tree must PASS inside a repo\n${clean.stdout}${clean.stderr}`);
    assert.doesNotMatch(clean.stdout, /pointer check: git unavailable/,
      `inside a real repo the pointer block must RUN, never take its no-git skip\n${clean.stdout}`);
    assert.match(clean.stdout, /ok\s+gitignored-root citations: \d+ distinct first segment\(s\) cited and shape-qualified/,
      `the ignore-derivation line must print\n${clean.stdout}`);
    assert.match(clean.stdout, /ok\s+every path this repo points at from \d+ ship-text surface\(s\) \(\d+ in-scope citations\) resolves to a TRACKED file/,
      `the resolution line must print\n${clean.stdout}`);

    // PLANTED: one citation per refusal the block exists to make. `scratchpad/` is a
    // gitignored root in this repo's .gitignore; asserted here so the leg cannot pass
    // on a .gitignore that stopped saying so.
    const ignored = git('check-ignore', 'scratchpad/');
    assert.strictEqual(ignored.status, 0, `the gitignored leg needs scratchpad/ ignored in the fixture\n${ignored.stdout}${ignored.stderr}`);
    // The untracked plant sits in a NEW top-level dir on purpose: a file under
    // scripts/lib/ also trips the LIBS roster and the dist-mirror gates (measured), and
    // then exit 1 would say nothing about the pointer block.
    fs.mkdirSync(path.join(root, 'r34-probe'));
    fs.writeFileSync(path.join(root, 'r34-probe', 'untracked-probe.txt'), 'on disk, never added\n');
    fs.appendFileSync(path.join(root, 'README.md'),
      '\nPlanted by verify.test.mjs: `scripts/lib/r34-no-such-engine.mjs`, `r34-probe/untracked-probe.txt`, `scratchpad/r34-probe-notes.md`.\n');

    const planted = run();
    assert.strictEqual(planted.status, 1, `three bad citations must FAIL the gate\n${planted.stdout}${planted.stderr}`);
    assert.match(planted.stdout, /\nVERIFY: FAIL \(3\)/,
      `exactly the three planted citations fail — any other count means the exit code is not this block's\n${planted.stdout}`);
    assert.match(planted.stdout, /FAIL\s+README\.md cites `scripts\/lib\/r34-no-such-engine\.mjs`, which does not resolve in this repo/,
      `the MISSING citation must be named\n${planted.stdout}`);
    assert.match(planted.stdout, /FAIL\s+README\.md cites `r34-probe\/untracked-probe\.txt`, which exists here but is UNTRACKED/,
      `the UNTRACKED citation must be named\n${planted.stdout}`);
    assert.match(planted.stdout, /FAIL\s+README\.md cites `scratchpad\/r34-probe-notes\.md`, which lives under the gitignored `scratchpad`/,
      `the GITIGNORED citation must be named\n${planted.stdout}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// r34 F1: `git check-ignore` exits 0 (something fed is ignored), 1 (nothing is), or
// anything else when it CANNOT ANSWER. A bare repository is the portable way to reach
// the third case with the real git binary: `ls-files` still answers from the index, so
// the block does not take its no-git skip, while check-ignore exits 128 ("this operation
// must be run in a work tree"). Measured before the fix: the gate read "0 gitignored",
// let a citation under a gitignored root fall out of scope, and printed VERIFY: PASS.
test('verify.mjs in a BARE repo: a check-ignore that cannot answer FAILs the gate — never a "0 gitignored" read as clean', (t) => {
  const fx = trackedTreeRepo();
  if (!fx) return t.skip('git unavailable');
  const { root, git, run } = fx;
  try {
    fs.appendFileSync(path.join(root, 'README.md'), '\nPlanted by verify.test.mjs: `scratchpad/r34-probe-notes.md`.\n');
    // FIXTURE RAIL, re-asserted at the ONE `git config` call site: without its own .git
    // beside it, this is the call that walks up and reconfigures a real repository.
    assert.ok(fs.statSync(path.join(root, '.git')).isDirectory(), 'FIXTURE RAIL: own .git before `git config`');
    const bare = git('config', 'core.bare', 'true');
    assert.strictEqual(bare.status, 0, `git config in the fixture failed\n${bare.stderr}`);
    const probe = git('check-ignore', 'scratchpad/');
    assert.ok(probe.status !== 0 && probe.status !== 1,
      `precondition: in a bare repo check-ignore must be UNANSWERABLE, got exit ${probe.status}\n${probe.stderr}`);

    const r = run();
    assert.strictEqual(r.status, 1, `an unanswered check-ignore must FAIL the gate\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /FAIL\s+git check-ignore --stdin exited \d+/,
      `the FAIL must name the probe and its exit status\n${r.stdout}`);
    assert.doesNotMatch(r.stdout, /ok\s+gitignored-root citations:/,
      `no ok line may count ignored roots from a probe that never answered\n${r.stdout}`);
    assert.doesNotMatch(r.stdout, /ok\s+every path this repo points at/,
      `the resolution ok line rests on the ignore set, so it must not print either\n${r.stdout}`);
    assert.match(r.stdout, /\nVERIFY: FAIL \(1\)/,
      `exactly one failure, this one — any other count means the exit code is not this probe's\n${r.stdout}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
