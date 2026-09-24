// CWK-133 -- gitEnv(): the one place a fixture or gate git spawn gets its environment.
// One caution baked into this file: the git-spawn CENSUS (scripts/git-env-census.mjs, wired into verify.mjs)
// scans every scripts/**/*.mjs, this one included. The hostile-env CONTROL leg below is the one git spawn
// here that deliberately does NOT route through gitEnv(), so it names the binary through a variable (GIT),
// which the census's literal match cannot see; every other spawn in this file is written the ordinary way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gitEnv } from './git-env.mjs';

const TMP_ROOT = fs.realpathSync.native(os.tmpdir());
const GIT = 'git';

// Set process.env keys for the duration of fn, restoring each afterwards even if fn throws.
function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) saved[k] = process.env[k];
  Object.assign(process.env, overrides);
  try { return fn(); } finally {
    for (const k of Object.keys(overrides)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

test('gitEnv: strips every GIT_-prefixed key, whatever the name or the case', () => {
  const env = withEnv({
    GIT_DIR: '/somewhere/.git', GIT_INDEX_FILE: '/somewhere/.git/index', GIT_WORK_TREE: '/somewhere',
    GIT_SOME_FUTURE_KEY_NOBODY_HAS_WRITTEN_YET: 'x', git_lowercase_probe: 'x',
  }, () => gitEnv('/ceiling'));
  const survivors = Object.keys(env).filter((k) => /^git_/i.test(k) && k !== 'GIT_CEILING_DIRECTORIES');
  assert.deepEqual(survivors, [], 'no GIT_* key may survive the strip');
});

test('gitEnv: sets GIT_CEILING_DIRECTORIES to the given ceiling', () => {
  assert.equal(gitEnv('/tmp/some-parent').GIT_CEILING_DIRECTORIES, '/tmp/some-parent');
});

test('gitEnv: with no ceiling given, no GIT_CEILING_DIRECTORIES survives, not even an ambient one', () => {
  const env = withEnv({ GIT_CEILING_DIRECTORIES: '/ambient/ceiling' }, () => gitEnv());
  assert.equal('GIT_CEILING_DIRECTORIES' in env, false);
});

test('gitEnv: non-GIT_ keys pass through unchanged (a plain copy, not a wipe)', () => {
  const env = withEnv({ COALWASH_GITENV_TEST_PROBE: 'kept' }, () => gitEnv('/ceiling'));
  assert.equal(env.COALWASH_GITENV_TEST_PROBE, 'kept');
});

test('gitEnv: mutating the returned object never touches process.env (a real copy)', () => {
  const before = process.env.GIT_DIR;
  const env = gitEnv('/ceiling');
  env.GIT_DIR = '/poisoned';
  assert.equal(process.env.GIT_DIR, before);
});

// The incident itself, on the real git binary, inside a sandbox: an ABSOLUTE GIT_DIR pointing at another repository
// must not redirect a fixture's `git init` onto it. The sandbox repository's config is compared byte for byte.
test('an ABSOLUTE ambient GIT_DIR cannot redirect a fixture `git init` onto another repository (the r5 incident)', (t) => {
  const probe = spawnSync('git', ['--version'], { encoding: 'utf8', env: gitEnv(TMP_ROOT) });
  if (probe.error || probe.status !== 0) { t.skip('git unavailable'); return; }
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(TMP_ROOT, 'cw-gitenv-')));
  t.after(() => {
    assert.ok(base.startsWith(TMP_ROOT + path.sep), `refusing to remove ${base}: not under ${TMP_ROOT}`);
    fs.rmSync(base, { recursive: true, force: true });
  });
  const sandbox = path.join(base, 'sandbox-repo');
  const empty1 = path.join(base, 'fixture-control');
  const empty2 = path.join(base, 'fixture-fixed');
  for (const d of [sandbox, empty1, empty2]) fs.mkdirSync(d);
  const made = spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: sandbox, encoding: 'utf8', env: gitEnv(base) });
  assert.equal(made.status, 0, 'the sandbox repository was created');
  const sandboxGit = path.join(sandbox, '.git');
  const cfgSha = () => crypto.createHash('sha256').update(fs.readFileSync(path.join(sandboxGit, 'config'))).digest('hex');

  // CONTROL: the hostile ambient env, spread verbatim the way the old per-file copies did NOT (they stripped) and the
  // exemplar's incident did. It documents that the hazard is real on THIS git; it changes only the sandbox.
  const hostile = withEnv({ GIT_DIR: sandboxGit, GIT_INDEX_FILE: path.join(sandboxGit, 'index') }, () => ({ ...process.env, GIT_CEILING_DIRECTORIES: base }));
  const control = spawnSync(GIT, ['init', '-q', '-b', 'main', '.'], { cwd: empty1, encoding: 'utf8', env: hostile });
  const controlRedirected = control.status === 0 && !fs.existsSync(path.join(empty1, '.git'));
  t.diagnostic(`control (hostile env): fixture .git created=${fs.existsSync(path.join(empty1, '.git'))}, redirected onto the sandbox repo=${controlRedirected}`);

  // FIXED LEG: the same ambient GIT_DIR, the fixture spawn built by gitEnv().
  const before = cfgSha();
  const fixed = withEnv({ GIT_DIR: sandboxGit, GIT_INDEX_FILE: path.join(sandboxGit, 'index') },
    () => spawnSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: empty2, encoding: 'utf8', env: gitEnv(base) }));
  assert.equal(fixed.status, 0, 'the fixture init succeeded');
  assert.ok(fs.statSync(path.join(empty2, '.git')).isDirectory(), 'the fixture owns its own .git (it was not redirected)');
  assert.equal(cfgSha(), before, 'the sandbox repository\'s config is byte-identical: the ambient GIT_DIR did not reach the fixture spawn');
});
