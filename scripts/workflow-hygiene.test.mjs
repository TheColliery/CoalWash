// CWK-154 (the .github deputy's UMB-216 courier, this room's half): the workflow hygiene the template canon carries, pinned.
// Static reads of this repo's own files, hermetic, no network. Every pin here is a fact a reviewer would otherwise re-derive with
// `grep` (the courier's own proof lines: `grep -c timeout-minutes .github/workflows/*.yml`, `grep -L persist-credentials ...`).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WF_DIR = path.join(repo, '.github', 'workflows');
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const workflows = fs.readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f)).sort().map((f) => ({ file: f, text: read(path.join(WF_DIR, f)) }));

// The job blocks of a workflow: the 2-space-indented keys directly under the top-level `jobs:`.
function jobsOf(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start < 0) return [];
  const jobs = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i]) && lines[i].trim() !== '') break; // the next top-level key ends the block
    const m = /^  ([A-Za-z0-9_-]+):\s*$/.exec(lines[i]);
    if (m) jobs.push({ name: m[1], at: i, body: [] });
    else if (jobs.length) jobs[jobs.length - 1].body.push(lines[i]);
  }
  return jobs;
}

test('CWK-154 (2): there are workflows to check (a vacuous pass reads clean)', () => {
  assert.ok(workflows.length >= 7, `${workflows.length} workflow files`);
  assert.ok(workflows.reduce((n, w) => n + jobsOf(w.text).length, 0) >= 8, 'at least the 8 jobs the room had when this pin was written');
});

test('CWK-154 (2): EVERY job of EVERY workflow declares timeout-minutes (testing.md: every run has a finite clock)', () => {
  const missing = [];
  for (const w of workflows) {
    for (const j of jobsOf(w.text)) {
      const m = j.body.map((l) => /^    timeout-minutes:\s*(\d+)\b/.exec(l)).find(Boolean);
      if (!m) missing.push(`${w.file}:${j.name}`);
      else assert.ok(Number(m[1]) >= 1 && Number(m[1]) <= 60, `${w.file}:${j.name} timeout-minutes ${m[1]} is a real bound (1..60)`);
    }
  }
  assert.deepStrictEqual(missing, [], `jobs with no timeout-minutes: ${missing.join(', ')}`);
});

test('CWK-154 (2): every actions/checkout in a workflow that pushes nothing sets persist-credentials: false', () => {
  const bad = [];
  for (const w of workflows) {
    const lines = w.text.split('\n');
    lines.forEach((l, i) => {
      if (!/uses:\s*actions\/checkout@/.test(l)) return;
      // the step's own `with:` block: the following lines at deeper indent than the `uses:` line's step
      const indent = /^(\s*)/.exec(l)[1].length;
      let ok = false;
      for (let k = i + 1; k < lines.length; k++) {
        const t = lines[k];
        if (t.trim() !== '' && /^(\s*)/.exec(t)[1].length < indent) break;
        if (/^\s*- /.test(t) && /^(\s*)/.exec(t)[1].length <= indent) break;
        if (/persist-credentials:\s*false\b/.test(t)) { ok = true; break; }
      }
      if (!ok) bad.push(`${w.file}:${i + 1}`);
    });
  }
  assert.deepStrictEqual(bad, [], `checkouts that keep the token in the git config: ${bad.join(', ')}`);
});

test('CWK-154 (1): dependabot-auto-merge.yml passes the PR URL through env, never interpolated into the run script', () => {
  const w = workflows.find((x) => x.file === 'dependabot-auto-merge.yml');
  assert.ok(w, 'the workflow exists');
  assert.match(w.text, /^\s+PR_URL:\s*\$\{\{\s*github\.event\.pull_request\.html_url\s*\}\}\s*$/m, 'PR_URL is set from the event in env');
  const runLines = w.text.split('\n').filter((l) => /^\s+run:/.test(l));
  assert.ok(runLines.some((l) => l.includes('"$PR_URL"')), 'the run line uses the env variable');
  for (const l of runLines) assert.ok(!/\$\{\{/.test(l), `no expression interpolated into a run line: ${l.trim()}`);
});

test('CWK-154 (3): .gitignore names .coalboard/', () => {
  assert.match(read(path.join(repo, '.gitignore')), /^\.coalboard\/\s*$/m);
});

test('CWK-154 (2): the suite runner has a finite clock -- a per-test bound on node --test and a whole-run bound on its spawn, under the CI job clock', () => {
  const src = read(path.join(repo, 'scripts', 'test.mjs'));
  const per = /const TEST_TIMEOUT_MS = (\d+);/.exec(src);
  const run = /const RUN_TIMEOUT_MS = (\d+);/.exec(src);
  assert.ok(per && run, 'both constants are declared');
  assert.ok(src.includes('`--test-timeout=${TEST_TIMEOUT_MS}`'), 'node --test receives --test-timeout');
  assert.match(src, /spawnSync\([^)]*timeout:\s*RUN_TIMEOUT_MS/, 'the spawn carries the whole-run timeout');
  const gate = workflows.find((w) => w.file === 'ci.yml');
  const gateMin = Number(/timeout-minutes:\s*(\d+)/.exec(gate.text)[1]);
  assert.ok(Number(run[1]) < gateMin * 60000, `the run bound ${run[1]} ms stays under the CI gate's ${gateMin}-minute clock`);
  assert.ok(Number(per[1]) < Number(run[1]), 'a test bound under the run bound');
});
