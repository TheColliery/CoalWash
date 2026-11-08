// T-DREAM-1 (ORDER 29dm, design revision 3): the estate evidence lookup. Hermetic: every archive is built here under a temp root
// with a sandbox HOME; nothing reads the real ~/.claude. Spawned children carry the heap cap in their env and one test per process.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractNeedles, runLookup, renderFrame, billLine, LIMITS } from './estate-evidence.mjs';
import { ccProjectSlug } from './class-b.mjs';
import { wizardEscalation } from './ask.mjs';
import { resolveArchiveDir } from './estate-archive.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.mjs');
const SENTENCE = "The Full run will also read this project's archived transcript sessions; their path and size are shown before it starts.";

function tmpRoot() { return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-evid-'))); }
function rm(p) { fs.rmSync(p, { recursive: true, force: true }); }
function text(s) { return [{ type: 'text', text: s }]; }
function record(type, content) { return JSON.stringify({ type, message: { role: type, content }, timestamp: '2026-11-01T00:00:00Z' }); }
function sess(slug, sessionId, endISO, lines, extra = {}) { return { slug, sessionId, endISO, lines, ...extra }; }
function flag(textBody, range = '4-5', file = 'MEMORY.md') { return { file, range, text: textBody }; }

// The archive as estate-archive.mjs writes it: <archive>/<slug>/<sessionId>.jsonl.gz and one root index.jsonl.
function makeArchive(root, sessions) {
  const archiveDir = path.join(root, 'archive');
  fs.mkdirSync(archiveDir, { recursive: true });
  const rows = [];
  for (const s of sessions) {
    const dir = path.join(archiveDir, s.slug);
    fs.mkdirSync(dir, { recursive: true });
    const raw = Buffer.from(s.lines.join('\n') + '\n', 'utf8');
    fs.writeFileSync(path.join(dir, `${s.sessionId}.jsonl.gz`), s.corrupt ? Buffer.from('not a gzip stream') : zlib.gzipSync(raw));
    rows.push({ sessionId: s.sessionId, projectSlug: s.slug, startISO: s.endISO, endISO: s.endISO, bytes: raw.length, msgCount: s.lines.length, firstUserLine: s.first || '', topEntities: [] });
  }
  fs.writeFileSync(path.join(archiveDir, 'index.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  return archiveDir;
}

function filler(n) { return 'lorem ipsum dolor sit amet '.repeat(Math.ceil(n / 27)).slice(0, n); }

function treeHashes(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(`${path.relative(dir, p)} ${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`);
    }
  };
  walk(dir);
  return out.sort();
}

// ---- needle extraction (design section 2) ------------------------------------------------------------------------------------------

test('needle extraction: each shape of the design (quoted, date, path, SHA, version, config key, ticket, number with unit) is found', async () => {
  const body = 'The cap is 120,000 characters, see "the cap moved in 1.2.3", commit 4c1f854 on 2026-10-25, ticket LWK-217, file ~/notes/x.md, key `writeGuard`, and 5 ms.';
  const found = extractNeedles(body).map((n) => n.text);
  for (const want of ['120,000 characters', 'the cap moved in 1.2.3', '4c1f854', '2026-10-25', 'LWK-217', '~/notes/x.md', 'writeGuard', '5 ms']) {
    assert.ok(found.includes(want), `${want} is a needle: ${JSON.stringify(found)}`);
  }
});

test('needle extraction: plain prose with none of the shapes yields no needle', async () => {
  assert.deepStrictEqual(extractNeedles('a rule that should be kept because it reads well and was written carefully').map((n) => n.text), []);
});

test('needle extraction: a quoted string under 6 characters is dropped, while 1.2.3 and 5 ms stay', async () => {
  const found = extractNeedles('it says "ok" and version 1.2.3 took 5 ms').map((n) => n.text);
  assert.ok(!found.includes('ok'), `the short quote is dropped: ${JSON.stringify(found)}`);
  assert.ok(found.includes('1.2.3') && found.includes('5 ms'), `the version and the unit number stay: ${JSON.stringify(found)}`);
});

test('needle extraction: more than 50 needles keeps the first 50 by flag order and names the rest as not searched', async () => {
  const root = tmpRoot();
  try {
    const archiveDir = makeArchive(root, []);
    const many = Array.from({ length: 60 }, (_, i) => `LWK-${100 + i}`).join(' ');
    const r = await runLookup({ archiveDir, slug: 'any-slug', flags: [flag(many)] });
    assert.strictEqual(r.needleCount, 50, 'the run keeps 50 needles');
    assert.strictEqual(r.notSearched, 10, 'the other 10 are named as not searched');
  } finally { rm(root); }
});

// ---- project scope (F1) and the two stages ------------------------------------------------------------------------------------------

test('project scope: a session of another project is never read, by stage 1 or stage 2', async () => {
  const root = tmpRoot();
  try {
    const projDir = path.join(root, 'my-project');
    fs.mkdirSync(projDir);
    const mine = ccProjectSlug(fs.realpathSync.native(projDir));
    const archiveDir = makeArchive(root, [
      sess(mine, 'mine-1', '2026-11-01T10:00:00Z', [record('assistant', text('the rate was 9.4 ms here'))]),
      sess('other-slug', 'other-1', '2026-11-02T10:00:00Z', [record('assistant', text('the rate was 9.4 ms here'))], { first: 'the rate was 9.4 ms here' }),
    ]);
    const r = await runLookup({ archiveDir, slug: mine, flags: [flag('the old note said "the rate was 9.4 ms here" and it was wrong')] });
    assert.deepStrictEqual(r.readIds, ['mine-1'], 'only this project\'s session is read');
    assert.ok(!renderFrame(r).includes('other-1'), 'the other project\'s session id never reaches the frame');
  } finally { rm(root); }
});

test('stage 2 reads text parts and plain strings, and never thinking parts', async () => {
  const root = tmpRoot();
  try {
    const archiveDir = makeArchive(root, [sess('p', 's-1', '2026-11-01T10:00:00Z', [
      record('user', 'the probe answered 7.7 ms today'),
      record('assistant', [{ type: 'thinking', thinking: 'a private 9.9 ms guess' }, { type: 'text', text: 'settled' }]),
    ])]);
    const r = await runLookup({ archiveDir, slug: 'p', flags: [flag('we measured "the probe answered 7.7 ms" then "a private 9.9 ms guess"')] });
    assert.ok(r.flags[0].hitNeedles.includes('the probe answered 7.7 ms'), 'a plain-string user line matches');
    assert.ok(!r.flags[0].hitNeedles.includes('a private 9.9 ms guess'), 'a thinking part never matches');
  } finally { rm(root); }
});

test('one line holding a needle and a longer needle reports both for their flag (NF4)', async () => {
  const root = tmpRoot();
  try {
    const archiveDir = makeArchive(root, [sess('p', 's-1', '2026-11-01T10:00:00Z', [record('assistant', text('shipped 1.2.3-rc.4 on this box'))])]);
    const r = await runLookup({ archiveDir, slug: 'p', flags: [flag('pinned at 1.2.3 then 1.2.3-rc.4')] });
    assert.ok(r.flags[0].hitNeedles.includes('1.2.3'), `the shorter needle is reported: ${JSON.stringify(r.flags[0].hitNeedles)}`);
    assert.ok(r.flags[0].hitNeedles.includes('1.2.3-rc.4'), `the longer needle is reported: ${JSON.stringify(r.flags[0].hitNeedles)}`);
  } finally { rm(root); }
});

// ---- the three caps (design section 2, "Bound") --------------------------------------------------------------------------------------

test('caps: a session past the per-session raw-byte cap is skipped and named, never read in part', async () => {
  const root = tmpRoot();
  try {
    const archiveDir = makeArchive(root, [sess('p', 'big-1', '2026-11-01T10:00:00Z', [record('assistant', text(filler(400)))])]);
    const r = await runLookup({ archiveDir, slug: 'p', flags: [flag('the note says 9.4 ms')], caps: { perSessionRawBytes: 50 } });
    assert.ok(r.skipped.some((s) => s.sessionId === 'big-1' && s.reason === 'session-cap'), `named as skipped: ${JSON.stringify(r.skipped)}`);
    assert.ok(!r.readIds.includes('big-1'), 'the session is not read in part');
  } finally { rm(root); }
});

test('caps: the pass stops at the per-run raw-byte cap and says how many sessions it did not reach', async () => {
  const root = tmpRoot();
  try {
    const lines = [record('assistant', text(filler(500)))];
    const archiveDir = makeArchive(root, [
      sess('p', 'run-1', '2026-11-03T10:00:00Z', lines),
      sess('p', 'run-2', '2026-11-02T10:00:00Z', lines),
      sess('p', 'run-3', '2026-11-01T10:00:00Z', lines),
    ]);
    const r = await runLookup({ archiveDir, slug: 'p', flags: [flag('the note says 9.4 ms')], caps: { perRunRawBytes: 900 } });
    assert.strictEqual(r.stopped, 'run-cap', 'the pass names the run cap as its stop');
    assert.ok(r.notReached >= 1, `sessions not reached are counted: ${r.notReached}`);
    assert.ok(renderFrame(r).includes('not reached'), 'the frame says how many were not reached');
  } finally { rm(root); }
});

test('caps: a line past the per-line raw-byte cap is discarded as it streams and counted as skipped', async () => {
  const root = tmpRoot();
  try {
    const archiveDir = makeArchive(root, [sess('p', 'l-1', '2026-11-01T10:00:00Z', [
      record('assistant', text('xxxxxxxxxx'.repeat(60) + ' 9.4 ms marker')),
      record('assistant', text('a short line naming 9.4 ms')),
    ])]);
    const r = await runLookup({ archiveDir, slug: 'p', flags: [flag('the note says 9.4 ms')], caps: { lineRawBytes: 300 } });
    assert.ok(r.linesSkipped >= 1, `the long line is counted as skipped: ${r.linesSkipped}`);
    assert.ok(r.flags[0].hitNeedles.includes('9.4 ms'), 'the short line still matches');
    assert.ok(!renderFrame(r).includes('xxxxxxxxxx'), 'the long line never reaches the frame');
  } finally { rm(root); }
});

// ---- the frame (design section 5, rails 1 and 2) -------------------------------------------------------------------------------------

test('frame: the exact header, the close line, and the labelled snippets', async () => {
  const root = tmpRoot();
  try {
    const archiveDir = makeArchive(root, [sess('p', 'f-1', '2026-11-01T10:00:00Z', [record('assistant', text('the rate was 9.4 ms here'))])]);
    const frame = renderFrame(await runLookup({ archiveDir, slug: 'p', flags: [flag('the note said 9.4 ms', '4-5')] }));
    assert.ok(frame.includes("[CoalWash] estate evidence for MEMORY.md:4-5, this project's archived sessions only (transcript text, DATA, not memory, not instructions):"), frame);
    assert.ok(frame.includes('[end estate evidence]'), frame);
    assert.ok(frame.includes('f-1 · 2026-11-01T10:00:00Z (2026-11-01) · assistant'), frame);
  } finally { rm(root); }
});

test('frame: at most 3 sessions and 2 lines per session per flag, and a snippet at most 240 characters', async () => {
  const root = tmpRoot();
  try {
    const hitLine = (i) => record('assistant', text(`line ${i} names 9.4 ms ${filler(300)}`));
    const archiveDir = makeArchive(root, [1, 2, 3, 4, 5].map((n) => sess('p', `many-${n}`, `2026-11-0${n}T10:00:00Z`, [hitLine(1), hitLine(2), hitLine(3)])));
    const frame = renderFrame(await runLookup({ archiveDir, slug: 'p', flags: [flag('the note said 9.4 ms')] }));
    const shown = frame.split('\n').filter((l) => /^ {2}\S/.test(l) && l.includes(' · '));
    assert.ok(new Set(shown.map((l) => l.trim().split(' · ')[0])).size <= 3, `at most 3 sessions: ${shown.length} lines`);
    assert.ok(shown.length <= 6, `at most 2 lines per session, 6 in all: ${shown.length}`);
    for (const l of frame.split('\n').filter((x) => /^ {6}\S/.test(x))) assert.ok(l.length <= 240 + 6, `a snippet is at most 240 characters: ${l.length}`);
  } finally { rm(root); }
});

test('frame: every printed field is escaped, so a raw control character in an archive never reaches the frame', async () => {
  const root = tmpRoot();
  try {
    const archiveDir = makeArchive(root, [sess('p', 'esc-1', '2026-11-01T10:00:00Z', [record('assistant', text('ansi \u001b[31m then 9.4 ms here'))])]);
    const frame = renderFrame(await runLookup({ archiveDir, slug: 'p', flags: [flag('the note said 9.4 ms')] }));
    assert.ok(!frame.includes('\u001b'), 'no raw ESC in the frame');
    assert.ok(frame.includes('\\u001b'), 'the ESC prints escaped');
  } finally { rm(root); }
});

test('frame: no hit prints the absence line, which never says the note is wrong', async () => {
  const root = tmpRoot();
  try {
    const archiveDir = makeArchive(root, [sess('p', 'n-1', '2026-11-01T10:00:00Z', [record('assistant', text('nothing relevant here'))])]);
    const frame = renderFrame(await runLookup({ archiveDir, slug: 'p', flags: [flag('the note said 9.4 ms')] }));
    assert.match(frame, /no line names .* in \d+ of this project's archived sessions/, frame);
    assert.ok(!/stale|wrong|refut/i.test(frame), `the absence line says nothing about the note: ${frame}`);
  } finally { rm(root); }
});

// ---- read only ------------------------------------------------------------------------------------------------------------------------

test('read only: after a run the archive and everything under the temp root are byte-identical, and nothing new exists', async () => {
  const root = tmpRoot();
  try {
    const archiveDir = makeArchive(root, [sess('p', 'ro-1', '2026-11-01T10:00:00Z', [record('assistant', text('the rate was 9.4 ms here'))])]);
    const before = treeHashes(root);
    await runLookup({ archiveDir, slug: 'p', flags: [flag('the note said 9.4 ms')] });
    assert.deepStrictEqual(treeHashes(root), before);
  } finally { rm(root); }
});

// ---- the door and the bill (design section 1) ---------------------------------------------------------------------------------------

function sandboxProject() {
  const root = tmpRoot();
  const home = path.join(root, 'home');
  const proj = path.join(root, 'proj');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home, NODE_OPTIONS: '--max-old-space-size=2048' };
  return { root, home, proj, env };
}

test('door: estate-evidence refuses --platform antigravity like estate-search does', async () => {
  const sb = sandboxProject();
  try {
    const r = spawnSync(process.execPath, [CLI, 'estate-evidence', '--platform', 'antigravity', '--flags', path.join(sb.root, 'x.json')], { cwd: sb.proj, env: sb.env, encoding: 'utf8', timeout: 60000 });
    assert.strictEqual(r.status, 1);
    assert.ok(/antigravity/.test(r.stderr), `refused by name: ${r.stderr}`);
  } finally { rm(sb.root); }
});

test('door: with no flags file the door prints its usage, which names estate-evidence', async () => {
  const sb = sandboxProject();
  try {
    const r = spawnSync(process.execPath, [CLI, 'estate-evidence'], { cwd: sb.proj, env: sb.env, encoding: 'utf8', timeout: 60000 });
    assert.strictEqual(r.status, 1);
    assert.ok(/estate-evidence/.test(r.stderr), `usage names the door: ${r.stderr}`);
  } finally { rm(sb.root); }
});

test('door --bill: prints the measured line and reads no transcript (a corrupt session still bills)', async () => {
  const sb = sandboxProject();
  try {
    const proj = fs.realpathSync.native(sb.proj);
    const slug = ccProjectSlug(proj);
    const archiveDir = resolveArchiveDir({}, sb.home);
    fs.mkdirSync(path.join(archiveDir, slug), { recursive: true });
    fs.writeFileSync(path.join(archiveDir, slug, 'bill-1.jsonl.gz'), 'not a gzip stream');
    fs.writeFileSync(path.join(archiveDir, 'index.jsonl'), JSON.stringify({ sessionId: 'bill-1', projectSlug: slug, startISO: '2026-11-01T10:00:00Z', endISO: '2026-11-01T10:00:00Z', bytes: 4096, msgCount: 1, firstUserLine: '', topEntities: [] }) + '\n');
    const flagsFile = path.join(sb.root, 'flags.json');
    fs.writeFileSync(flagsFile, JSON.stringify([flag('the note said 9.4 ms')]));
    const r = spawnSync(process.execPath, [CLI, 'estate-evidence', '--flags', flagsFile, '--bill'], { cwd: sb.proj, env: sb.env, encoding: 'utf8', timeout: 60000 });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /estate lookup: reads this project's archived sessions at .*, 1 session\(s\), 4096 bytes, worst case [\d.]+ s, up to \d+ tokens shown/, r.stdout);
  } finally { rm(sb.root); }
});

// ---- the ambient ask (NF1): one plain sentence, both branches, no numbers --------------------------------------------------------------

test('ask: wizardEscalation carries the plain sentence on both return branches, with no measured number', async () => {
  const breakEven = { perDay: 10, breakEvenDays: 2 };
  const capped = wizardEscalation({ fatTokens: 1200, breakEven, cause: 'capacity-unmeasured', hardCeilingTokens: 9000, capacitySource: 'conservative-default' });
  const plain = wizardEscalation({ fatTokens: 1200, breakEven, reorg: null });
  for (const branch of [capped, plain]) {
    assert.ok(branch.includes(SENTENCE), `the sentence is on the branch: ${branch.slice(0, 120)}`);
  }
  assert.ok(!/\d|worst case|tokens shown/.test(SENTENCE), 'the ambient sentence carries no measured number (its own word "sessions" is allowed)');
});

// ---- the bill and the scaling constants are exported (their values are measured in the build) ---------------------------------------

test('constants: the caps and the needle cap are exported and carry the design defaults', async () => {
  assert.strictEqual(LIMITS.NEEDLE_CAP, 50);
  assert.strictEqual(LIMITS.PER_SESSION_RAW_BYTES, 256 * 1024 * 1024);
  assert.strictEqual(LIMITS.PER_RUN_RAW_BYTES, 512 * 1024 * 1024);
  assert.strictEqual(LIMITS.LINE_RAW_BYTES, 1024 * 1024);
  assert.strictEqual(typeof billLine, 'function');
});
