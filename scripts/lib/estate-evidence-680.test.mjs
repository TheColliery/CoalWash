// ORDER 29dn fire 680 (T-DREAM-1b, the CodeRabbit t326 findings and RE-INSPECT 677): the long-token bound (CR7), the run-cap charge for
// aborted reads (CR4, L3) and the bounded stored hits (CR6). Hermetic: temp roots and a child process with a deadline.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { runLookup, LIMITS } from './estate-evidence.mjs';

const MODULE_URL = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'estate-evidence.mjs')).href;
const tmpRoot = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-evid680-')));
const rm = (p) => fs.rmSync(p, { recursive: true, force: true });

// CR7: extraction in a child process with a deadline. At the quadratic pattern the scan outlives the deadline and the child is killed.
function extractInChild(bodyExpr) {
  const code = `import { extractNeedles } from ${JSON.stringify(MODULE_URL)}; const t = ${bodyExpr}; const t0 = Date.now(); extractNeedles(t); console.log(String(Date.now() - t0));`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL', env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_OPTIONS: '--max-old-space-size=2048' } });
}

test('long token (680 CR7): a 200,000-character unbroken word token is scanned without a quadratic blow-up', () => {
  const r = extractInChild("'a'.repeat(200000)");
  assert.strictEqual(r.error, undefined, `the child timed out or failed: ${r.error && r.error.code}`);
  assert.strictEqual(r.status, 0, r.stderr);
  console.log(`CR7 timing, 200,000 word characters (path and identifier patterns): ${r.stdout.trim()} ms`);
});

test('long token (680 CR7): a 200,000-character run of "1," is scanned without a quadratic blow-up', () => {
  const r = extractInChild("'1,'.repeat(100000)");
  assert.strictEqual(r.error, undefined, `the child timed out or failed: ${r.error && r.error.code}`);
  assert.strictEqual(r.status, 0, r.stderr);
  console.log(`CR7 timing, 200,000 characters of "1," (number pattern): ${r.stdout.trim()} ms`);
});

test('run cap (680 CR4, L3): reads that stop on the session cap are charged to the run total, so the run ends at the per-run cap', async () => {
  const root = tmpRoot();
  try {
    const slug = 'cap4-slug';
    const dir = path.join(root, 'archive', slug);
    fs.mkdirSync(dir, { recursive: true });
    const raw = Buffer.from('x'.repeat(600) + '\n', 'utf8');
    const rows = [];
    for (const n of [1, 2, 3]) {
      fs.writeFileSync(path.join(dir, `c-${n}.jsonl.gz`), zlib.gzipSync(raw));
      // The index claims 100 bytes, so the pre-check admits each session and the stream itself exceeds the 500-byte session cap.
      rows.push({ sessionId: `c-${n}`, projectSlug: slug, startISO: `2026-11-0${n}T10:00:00Z`, endISO: `2026-11-0${n}T10:00:00Z`, bytes: 100, msgCount: 1, firstUserLine: '', topEntities: [] });
    }
    fs.writeFileSync(path.join(root, 'archive', 'index.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const r = await runLookup({ archiveDir: path.join(root, 'archive'), slug, flags: [{ file: 'M.md', range: '1-1', text: 'the note said 9.4 ms' }], caps: { perSessionRawBytes: 500, perRunRawBytes: 1000 } });
    assert.strictEqual(r.stopped, 'run-cap', `the run ends at the per-run cap: ${JSON.stringify({ stopped: r.stopped, skipped: r.skipped, rawBytesRead: r.rawBytesRead })}`);
  } finally { rm(root); }
});

test('stored hits (680 CR6): a session where every line matches keeps at most LINES_PER_SESSION hit records per flag, and the needle still counts', async () => {
  const root = tmpRoot();
  try {
    const slug = 'hits-slug';
    const dir = path.join(root, 'archive', slug);
    fs.mkdirSync(dir, { recursive: true });
    const lines = Array.from({ length: 50 }, (_, i) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `the rate was 9.4 ms here, line ${i}` }] }, timestamp: '2026-11-01T00:00:00Z' }));
    fs.writeFileSync(path.join(dir, 'h-1.jsonl.gz'), zlib.gzipSync(Buffer.from(lines.join('\n') + '\n', 'utf8')));
    const raw = Buffer.byteLength(lines.join('\n') + '\n', 'utf8');
    fs.writeFileSync(path.join(root, 'archive', 'index.jsonl'), JSON.stringify({ sessionId: 'h-1', projectSlug: slug, startISO: '2026-11-01T10:00:00Z', endISO: '2026-11-01T10:00:00Z', bytes: raw, msgCount: 50, firstUserLine: '', topEntities: [] }) + '\n');
    const r = await runLookup({ archiveDir: path.join(root, 'archive'), slug, flags: [{ file: 'M.md', range: '1-1', text: 'the note said 9.4 ms' }] });
    assert.strictEqual(r.hitRecordsKept, LIMITS.LINES_PER_SESSION, `stored hit records: ${r.hitRecordsKept}`);
    assert.deepStrictEqual(r.flags[0].hitNeedles, ['9.4 ms'], 'the needle still counts as matched');
  } finally { rm(root); }
});
