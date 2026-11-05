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
import { retierScanLines } from './retier.mjs';

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

test('printed fields: writeguard-list prints a snapshot name escaped, the stored name stays raw', (t) => {
  const proj = tmp('cwg-pf-');
  const home = tmp('cwg-home-');
  try {
    fs.mkdirSync(path.join(proj, '.git'));
    const sdir = path.join(proj, '.claude', 'coalwash', 'writeguard', 'S1');
    fs.mkdirSync(sdir, { recursive: true });
    const name = 'a' + BIDI + 'b.md';
    try { fs.writeFileSync(path.join(sdir, name), 'snapshot'); } catch { t.skip('this volume refuses a right-to-left override in a file name'); return; }
    const r = spawnSync(process.execPath, [CLI, 'writeguard-list'], { cwd: proj, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8', timeout: 120000 });
    assert.ok(!r.stdout.includes(BIDI), 'the raw override must not reach stdout: ' + JSON.stringify(r.stdout));
    assert.ok(r.stdout.includes('a' + ESCAPED + 'b.md'), 'the name is escaped on its line: ' + JSON.stringify(r.stdout));
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
