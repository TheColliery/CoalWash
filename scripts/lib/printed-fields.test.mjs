// Printed fields are escaped at the sites that print a file-, listing- or index-derived value, and the index is written owner-only.
// The witnesses plant a right-to-left override (U+202E): a legal character in a Windows file name, and a control character to
// the printed line. Each witness goes red on the unfixed source.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { searchLines, appendIndexRow } from './estate-archive.mjs';
import { retierScanLines, runRetierReport } from './retier.mjs';
import { deadLinkLine } from './apply.mjs';
import { runEstateReport } from './estate-archive.mjs';
import { projectConfigPath } from './config-load.mjs';

const BIDI = String.fromCharCode(0x202e);
const ESCAPED = '\\u202e'; // the room's escape text for U+202E, as the printed line holds it
const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, 'cli.mjs');

function tmp(prefix) { return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); }
function clean(...dirs) { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); }

test('printed fields: a search row with a non-numeric message count prints escaped, a finite count prints as a number', () => {
  const row = (msgCount) => ({ sessionId: 's1', projectSlug: 'p', startISO: '2026-01-01T00:00:00Z', endISO: '2026-01-02T00:00:00Z', bytes: 10, msgCount, firstUserLine: 'hi' });
  const forged = searchLines([row('7' + BIDI + 'x')]);
  assert.ok(!forged.includes(BIDI), 'the raw override must not reach the printed line');
  assert.ok(forged.includes(ESCAPED), 'the message count is escaped on its line');
  assert.ok(searchLines([row(12)]).includes('12 msg'), 'a finite count still prints as a number');
});

test('printed fields: a retier store label with a right-to-left override prints escaped on its line', () => {
  const scan = {
    env: { targetTokens: 1, armAt: 1, disarmAt: 1, fillCeiling: 1 },
    overArm: 0,
    flags: [],
    stores: [{ label: 'store' + BIDI + 'x', band: 'under', indexTokens: 1, plannedLineDemotions: 0, plannedTopicDemotions: 0, shortfall: false }],
  };
  const out = String(retierScanLines(scan));
  assert.ok(!out.includes(BIDI), 'the raw override must not reach the printed line');
  assert.ok(out.includes('store' + ESCAPED + 'x'), 'the store label is escaped on its line');
});

test('printed fields: a store collectStores skipped prints as one escaped line with its reason', () => {
  // A control character cannot be put in a folder name on Windows, so the skip entry is built directly: the printed line is what is pinned.
  const scan = {
    env: { targetTokens: 1, armAt: 1, disarmAt: 1, fillCeiling: 1 },
    overArm: 0,
    flags: [],
    stores: [],
    skipped: [{ label: 'agent:a' + BIDI + 'b\nc', reason: 'the MEMORY.md name resolves to x' + '\u0007' + 'y, not this store' }],
  };
  const out = String(retierScanLines(scan));
  assert.ok(!out.includes(BIDI), 'the raw override must not reach the printed line');
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(out), 'no raw control character reaches the printed output');
  const line = out.split('\n').find((l) => l.includes('agent:a' + ESCAPED + 'b'));
  assert.ok(line, 'the skipped store prints as one line with its label escaped');
  assert.ok(line.includes('resolves to x'), 'the same line carries the reason');
  assert.strictEqual(out.split('\n').filter((l) => l.includes('agent:a' + ESCAPED)).length, 1, 'one line per skipped store');
});

test('printed fields: writeguard-list prints only the names the writer makes; a hostile name is never printed and stays stored', (t) => {
  const proj = tmp('cwg-pf-');
  const home = tmp('cwg-home-');
  try {
    fs.mkdirSync(path.join(proj, '.git'));
    const sdir = path.join(proj, '.claude', 'coalwash', 'writeguard', 'S1');
    fs.mkdirSync(sdir, { recursive: true });
    const name = 'a' + BIDI + 'b.md';
    try { fs.writeFileSync(path.join(sdir, name), 'snapshot'); } catch { t.skip('this volume refuses a right-to-left override in a file name'); return; }
    const valid = 'ok--' + 'a'.repeat(64); // the shape snapName writes: its name is printed as it is
    fs.writeFileSync(path.join(sdir, valid), 'snapshot');
    const r = spawnSync(process.execPath, [CLI, 'writeguard-list'], { cwd: proj, env: { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: home, TMP: home, TEMP: home }, encoding: 'utf8', timeout: 120000 });
    assert.ok(!r.stdout.includes(BIDI), 'the raw override must not reach stdout: ' + JSON.stringify(r.stdout));
    assert.ok(!r.stdout.includes('ab.md'), 'a name outside the writer\'s shape is not listed: ' + JSON.stringify(r.stdout));
    assert.ok(r.stdout.includes(valid), 'a name in the writer\'s shape is printed as it is: ' + JSON.stringify(r.stdout));
    assert.ok(fs.readdirSync(sdir).includes(name), 'the stored name is untouched');
  } finally { clean(proj, home); }
});

test('printed fields: a new estate index is written owner-only, and an existing index keeps its mode', (t) => {
  const dir = tmp('cwg-idx-');
  try {
    const probe = path.join(dir, 'probe.bin');
    fs.writeFileSync(probe, 'p');
    fs.chmodSync(probe, 0o600);
    if ((fs.statSync(probe).mode & 0o777) !== 0o600) { t.skip('POSIX modes are not kept on this volume, so the mode cannot be read here'); return; }
    const fresh = path.join(dir, 'fresh');
    fs.mkdirSync(fresh);
    assert.strictEqual(appendIndexRow(fresh, { sessionId: 'a' }), true);
    assert.strictEqual(fs.statSync(path.join(fresh, 'index.jsonl')).mode & 0o777, 0o600, 'a new index is owner-only');
    const kept = path.join(dir, 'kept');
    fs.mkdirSync(kept);
    fs.writeFileSync(path.join(kept, 'index.jsonl'), '');
    fs.chmodSync(path.join(kept, 'index.jsonl'), 0o644);
    assert.strictEqual(appendIndexRow(kept, { sessionId: 'b' }), true);
    assert.strictEqual(fs.statSync(path.join(kept, 'index.jsonl')).mode & 0o777, 0o644, 'an existing index keeps its mode');
  } finally { clean(dir); }
});

test('printed fields: the RE-TIER report prints a store label, a kept file and a flagged file escaped', () => {
  const name = 'a' + BIDI + 'b.md';
  const out = runRetierReport({
    ok: true,
    stores: [{ label: 'store' + BIDI + 'x', movedLines: 0, topicsArchived: 0, indexTokensBefore: 1, indexTokensAfter: 1, shortfall: false }],
    snapshotDir: 'snap' + BIDI, indexRows: 0,
    kept: [{ path: name, reason: 'why' + BIDI }],
    flagged: [{ path: name, reason: 'why' }],
  });
  assert.ok(!out.includes(BIDI), 'the raw override must not reach the report');
  assert.ok(out.includes('store' + ESCAPED + 'x'), 'the store label is escaped');
  assert.ok(out.includes('KEPT a' + ESCAPED + 'b.md'), 'the kept file is escaped');
  assert.ok(out.includes('snap' + ESCAPED), 'the undo line snapshot folder is escaped');
  assert.ok(out.includes('FLAGGED a' + ESCAPED + 'b.md'), 'the flagged file is escaped');
});

test('printed fields: a failed RE-TIER report prints its error and a flagged file escaped', () => {
  const out = runRetierReport({ ok: false, error: 'bad' + BIDI, flagged: [{ path: 'a' + BIDI + 'b.md', reason: 'why' }] });
  assert.ok(!out.includes(BIDI), 'the raw override must not reach the report');
  assert.ok(out.includes('bad' + ESCAPED), 'the error text is escaped');
});

test('printed fields: the #55 line prints a key and a file name escaped', () => {
  const scan = {
    env: { targetTokens: 1, armAt: 1, disarmAt: 1, fillCeiling: 1 },
    overArm: 0,
    stores: [],
    flags: [{ key: 'k' + BIDI, claims: [{ store: 's', file: 'f' + BIDI + '.md', value: '1.0' }, { store: 't', file: 'g.md', value: '2.0' }] }],
  };
  const out = String(retierScanLines(scan));
  assert.ok(!out.includes(BIDI), 'the raw override must not reach the printed line');
  assert.ok(out.includes('f' + ESCAPED + '.md'), 'the file name is escaped');
});

test('printed fields: the dead-link advisory prints a topic name escaped', () => {
  const out = String(deadLinkLine(['a' + BIDI]));
  assert.ok(!out.includes(BIDI), 'the raw override must not reach the advisory');
  assert.ok(out.includes('a' + ESCAPED), 'the topic name is escaped');
});

test('printed fields: a project config with a control character at a parse error prints it escaped, never raw', (t) => {
  const proj = tmp('cwg-cfg' + BIDI + '-');
  const home = tmp('cwg-cfghome-');
  try {
    fs.mkdirSync(path.join(proj, '.git'));
    const cfg = projectConfigPath(proj, home);
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.writeFileSync(cfg, '{"coalwashMode": x\u001b[31mFORG', 'utf8');
    const r = spawnSync(process.execPath, [path.join(here, '..', 'configure.mjs'), '--coalwashMode', 'auto'], { cwd: proj, env: { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: home, TMP: home, TEMP: home }, encoding: 'utf8', timeout: 120000 });
    assert.strictEqual(r.status, 1, 'a parse error exits non-zero: ' + r.stderr);
    assert.ok(!r.stderr.includes('\u001b'), 'no raw escape character on stderr: ' + JSON.stringify(r.stderr));
    assert.ok(!r.stderr.includes(BIDI), 'the config path prints escaped, never raw: ' + JSON.stringify(r.stderr));
    assert.ok(r.stderr.includes('\\u001b'), 'the escape is printed as text: ' + JSON.stringify(r.stderr));
  } finally { clean(proj, home); }
});

test('printed fields: writeguard-restore prints the snapshot name escaped on stderr, and the stored name stays raw', (t) => {
  const proj = tmp('cwg-rs-');
  const home = tmp('cwg-rshome-');
  try {
    fs.mkdirSync(path.join(proj, '.git'));
    const sdir = path.join(proj, '.claude', 'coalwash', 'writeguard', 'S1');
    fs.mkdirSync(sdir, { recursive: true });
    const name = 'a' + BIDI + 'b.md';
    try { fs.writeFileSync(path.join(sdir, name), 'snapshot'); } catch { t.skip('this volume refuses a right-to-left override in a file name'); return; }
    const r = spawnSync(process.execPath, [CLI, 'writeguard-restore', name], { cwd: proj, env: { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: home, TMP: home, TEMP: home }, encoding: 'utf8', timeout: 120000 });
    assert.ok(!r.stderr.includes(BIDI), 'the raw override must not reach stderr: ' + JSON.stringify(r.stderr));
    assert.ok(r.stderr.includes('a' + ESCAPED + 'b.md'), 'the name is escaped on stderr: ' + JSON.stringify(r.stderr));
    assert.ok(fs.readdirSync(sdir).includes(name), 'the stored name is untouched');
    const missing = 'z' + BIDI + 'y.md';
    const r2 = spawnSync(process.execPath, [CLI, 'writeguard-restore', missing], { cwd: proj, env: { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: home, TMP: home, TEMP: home }, encoding: 'utf8', timeout: 120000 });
    assert.ok(!r2.stderr.includes(BIDI), 'the not-found name is not raw on stderr: ' + JSON.stringify(r2.stderr));
    assert.ok(r2.stderr.includes('z' + ESCAPED + 'y.md'), 'the not-found name is escaped: ' + JSON.stringify(r2.stderr));
  } finally { clean(proj, home); }
});

test('printed fields: the estate run report prints a session id, a reason and a left file name escaped', () => {
  const out = runEstateReport({ ok: true, archived: [{ id: 's' + BIDI, bytes: 0, files: 0, unpruned: ['n' + BIDI + '.txt'] }], failed: [{ id: 'f' + BIDI, reason: 'why' + BIDI }], activeSkipped: 0, bytesFreed: 0, indexRows: 0, archiveDir: 'a', coldListed: [], cfg: {} });
  assert.ok(!out.includes(BIDI), 'the raw override must not reach the report');
  assert.ok(out.includes('n' + ESCAPED + '.txt'), 'the left file name is escaped');
});
