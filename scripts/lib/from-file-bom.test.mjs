// Hermetic test for the --from and --to-file readers and a byte order mark. node/runtime.md section 8: a file another tool
// may have written (Windows PowerShell 5.1 Set-Content -Encoding utf8 writes one) is read as UTF-8 with one leading U+FEFF
// stripped. The mark is built from its code point, never typed, so it cannot be lost or doubled by a tool in between.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lineFromFile, linesFromFile } from './cli.mjs';

delete process.env.CLAUDE_CONFIG_DIR; // hermetic: sandbox home only
const BOM = String.fromCharCode(0xfeff);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.mjs');
const ID = '1700000000009-dddddddddddd';

function sandbox() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwbom-')));
  const home = path.join(root, 'home');
  const proj = path.join(root, 'proj');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home };
  return { root, home, proj, env };
}

test('restore --from: a byte order mark before a shaped id is stripped, so the id reaches the bin lookup', () => {
  const sb = sandbox();
  try {
    const file = path.join(sb.proj, 'id.txt');
    fs.writeFileSync(file, BOM + ID + '\r\n', 'utf8');
    const r = spawnSync(process.execPath, [CLI, 'restore', '--from', file], { cwd: sb.proj, env: sb.env, encoding: 'utf8', timeout: 60000 });
    assert.ok(!/does not hold a name in the shape/.test(r.stderr), `the mark reached the shape check: ${r.stderr}`);
    assert.ok(r.stderr.includes(`id '${ID}' not found`), `the id reached the bin lookup: ${r.stderr}`);
  } finally { fs.rmSync(sb.root, { recursive: true, force: true }); }
});

test('--to-file: a byte order mark before a folder is not part of the folder the file names', () => {
  const sb = sandbox();
  try {
    const folder = path.join(sb.root, 'restore-here');
    const file = path.join(sb.proj, 'to.txt');
    fs.writeFileSync(file, BOM + folder + '\r\n', 'utf8');
    assert.strictEqual(lineFromFile(file, null), folder, 'the value is the folder the file names, with no mark in front');
  } finally { fs.rmSync(sb.root, { recursive: true, force: true }); }
});

test('--to-file: a file over its bound is refused, and nothing it holds is read (F656-8 regression leg, green before and after the handle read)', () => {
  const sb = sandbox();
  try {
    const file = path.join(sb.proj, 'big.txt');
    fs.writeFileSync(file, 'x'.repeat(600), 'utf8');
    assert.throws(() => lineFromFile(file, null), /is not a plain file of at most 512 bytes; nothing was read/);
    const list = path.join(sb.proj, 'biglist.txt');
    fs.writeFileSync(list, 'y'.repeat(70 * 1024), 'utf8');
    assert.throws(() => linesFromFile(list), /is not a plain file of at most 65536 bytes; nothing was read/);
  } finally { fs.rmSync(sb.root, { recursive: true, force: true }); }
});

test('--from list (dig-gauge): a byte order mark before the first path is stripped, the path list keeps its order', () => {
  const sb = sandbox();
  try {
    const a = path.join(sb.root, 'a.jsonl');
    const b = path.join(sb.root, 'b.jsonl');
    const file = path.join(sb.proj, 'list.txt');
    fs.writeFileSync(file, BOM + a + '\r\n' + b + '\r\n', 'utf8');
    assert.deepStrictEqual(linesFromFile(file), [a, b]);
  } finally { fs.rmSync(sb.root, { recursive: true, force: true }); }
});
