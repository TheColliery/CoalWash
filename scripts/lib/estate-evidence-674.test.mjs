// ORDER 29dm fire 674 (INSPECT 673): the bill with no flags file, the frame's line counts, scope (bare ids and containment), the caps
// while streaming, RE-TIER rows, and the mutant kills (stage-1 order, record-type prefilter, echo threshold). Hermetic: temp roots and
// a sandbox HOME; nothing reads the real ~/.claude. Helpers are the same shapes as estate-evidence.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runLookup, renderFrame } from './estate-evidence.mjs';
import { ccProjectSlug } from './class-b.mjs';
import { resolveArchiveDir } from './estate-archive.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.mjs');
const MIB = 1024 * 1024;

const tmpRoot = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-evid674-')));
const rm = (p) => fs.rmSync(p, { recursive: true, force: true });
const text = (s) => [{ type: 'text', text: s }];
const record = (type, content) => JSON.stringify({ type, message: { role: type, content }, timestamp: '2026-11-01T00:00:00Z' });
const flag = (body) => ({ file: 'MEMORY.md', range: '4-5', text: body });
const row = (sessionId, slug, endISO, extra = {}) => ({ sessionId, projectSlug: slug, startISO: endISO, endISO, bytes: 100, msgCount: 1, firstUserLine: '', topEntities: [], ...extra });

// Writes archive/<slug>/<id>.jsonl.gz for each session and one root index.jsonl with the given rows.
function makeArchive(root, sessions, extraRows = []) {
  const archiveDir = path.join(root, 'archive');
  const rows = [];
  for (const s of sessions) {
    fs.mkdirSync(path.join(archiveDir, s.slug), { recursive: true });
    const raw = Buffer.from(s.lines.join('\n') + '\n', 'utf8');
    fs.writeFileSync(path.join(archiveDir, s.slug, `${s.sessionId}.jsonl.gz`), zlib.gzipSync(raw));
    rows.push(row(s.sessionId, s.slug, s.endISO, { bytes: raw.length, firstUserLine: s.first || '' }));
  }
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.writeFileSync(path.join(archiveDir, 'index.jsonl'), [...rows, ...extraRows].map((r) => JSON.stringify(r)).join('\n') + '\n');
  return archiveDir;
}

function sandboxProject() {
  const root = tmpRoot();
  const home = path.join(root, 'home');
  const proj = path.join(root, 'proj');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home, NODE_OPTIONS: '--max-old-space-size=2048' };
  return { root, home, proj, env };
}

test('bill (674 item 1): --bill prints with no flags file, states an estimate, and a non-zero per-flag token figure', () => {
  const sb = sandboxProject();
  try {
    const slug = ccProjectSlug(fs.realpathSync.native(sb.proj));
    const archiveDir = resolveArchiveDir({}, sb.home);
    fs.mkdirSync(path.join(archiveDir, slug), { recursive: true });
    fs.writeFileSync(path.join(archiveDir, slug, 'b-1.jsonl.gz'), 'not a gzip stream');
    fs.writeFileSync(path.join(archiveDir, 'index.jsonl'), JSON.stringify(row('b-1', slug, '2026-11-01T10:00:00Z', { bytes: 4096 })) + '\n');
    const r = spawnSync(process.execPath, [CLI, 'estate-evidence', '--bill'], { cwd: sb.proj, env: sb.env, encoding: 'utf8', timeout: 60000 });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /up to 400 tokens per flag/, r.stdout);
    assert.match(r.stdout, /about [\d.]+ s \(estimated\)/, r.stdout);
  } finally { rm(sb.root); }
});

test('frame (674 item 2): lines over the line cap are printed as their own count, in the absence line and the closing notes', () => {
  const frame = renderFrame({ flags: [{ file: 'M.md', range: '1-2', needles: ['v1.15.12'], hitNeedles: [], lines: [] }], readIds: ['s-1'], skipped: [{ sessionId: 'x', reason: 'unreadable' }], stopped: null, notReached: 0, linesSkipped: 1, notSearched: 0 });
  assert.match(frame, /1 line\(s\) over the line cap/, frame);
  assert.match(frame, /1 session\(s\) skipped by a cap or unreadable/, frame);
});

test('scope (674 item 3): an index row whose sessionId is not a bare id is refused and named as bad-id, never read', async () => {
  const root = tmpRoot();
  try {
    const slug = 'scope-slug';
    const archiveDir = makeArchive(root, [{ slug, sessionId: 'ok-1', endISO: '2026-11-01T10:00:00Z', lines: [record('assistant', text('the rate was 9.4 ms here'))] }],
      [row('../other-slug/evil', slug, '2026-11-02T10:00:00Z')]);
    fs.mkdirSync(path.join(archiveDir, 'other-slug'), { recursive: true });
    fs.writeFileSync(path.join(archiveDir, 'other-slug', 'evil.jsonl.gz'), zlib.gzipSync(Buffer.from(record('assistant', text('the rate was 9.4 ms here')) + '\n')));
    const r = await runLookup({ archiveDir, slug, flags: [flag('the note said "the rate was 9.4 ms here"')] });
    assert.ok(!r.readIds.includes('../other-slug/evil'), 'the traversal id is not read');
    assert.ok(r.skipped.some((s) => s.sessionId === '../other-slug/evil' && s.reason === 'bad-id'), JSON.stringify(r.skipped));
  } finally { rm(root); }
});

test('scope (674 item 3): a .gz that is a symlink out of the slug folder is refused as outside-slug, and its target is never read', async (t) => {
  const root = tmpRoot();
  try {
    const slug = 'link-slug';
    const archiveDir = makeArchive(root, [{ slug: 'other-slug', sessionId: 'target', endISO: '2026-11-01T10:00:00Z', lines: [record('assistant', text('the rate was 9.4 ms here'))] }],
      [row('lnk', slug, '2026-11-03T10:00:00Z')]);
    fs.mkdirSync(path.join(archiveDir, slug), { recursive: true });
    try { fs.symlinkSync(path.join(archiveDir, 'other-slug', 'target.jsonl.gz'), path.join(archiveDir, slug, 'lnk.jsonl.gz')); } catch { t.skip('this account cannot make a file symlink here'); return; }
    const r = await runLookup({ archiveDir, slug, flags: [flag('the note said "the rate was 9.4 ms here"')] });
    assert.ok(!r.readIds.includes('lnk'), 'the link is not read');
    assert.ok(r.skipped.some((s) => s.sessionId === 'lnk' && s.reason === 'outside-slug'), JSON.stringify(r.skipped));
  } finally { rm(root); }
});

test('caps (674 item 4): a newline-free stream past the per-session cap stops before the stream ends', async () => {
  const root = tmpRoot();
  try {
    const slug = 'cap-slug';
    const archiveDir = makeArchive(root, []);
    fs.mkdirSync(path.join(archiveDir, slug), { recursive: true });
    fs.writeFileSync(path.join(archiveDir, slug, 'nonl-1.jsonl.gz'), zlib.gzipSync(Buffer.alloc(4 * MIB, 0x61)));
    fs.writeFileSync(path.join(archiveDir, 'index.jsonl'), JSON.stringify(row('nonl-1', slug, '2026-11-01T10:00:00Z')) + '\n');
    const r = await runLookup({ archiveDir, slug, flags: [flag('the note said 9.4 ms')], caps: { perSessionRawBytes: MIB } });
    assert.ok(r.skipped.some((s) => s.sessionId === 'nonl-1' && s.reason === 'session-cap'), JSON.stringify(r.skipped));
    assert.ok(r.rawBytesRead < 2 * MIB, `the stream stopped near the cap: read ${r.rawBytesRead} bytes of 4 MiB`);
  } finally { rm(root); }
});

test('reach (674 item 5): a RE-TIER topic row is skipped silently, never listed as unreadable', async () => {
  const root = tmpRoot();
  try {
    const slug = 'rt-slug';
    const archiveDir = makeArchive(root, [{ slug, sessionId: 'ok-2', endISO: '2026-11-01T10:00:00Z', lines: [record('assistant', text('the rate was 9.4 ms here'))] }],
      [row('retier-1-0', slug, '2026-11-02T10:00:00Z', { retier: true })]);
    const r = await runLookup({ archiveDir, slug, flags: [flag('the note said 9.4 ms')] });
    assert.ok(!r.skipped.some((s) => s.sessionId === 'retier-1-0'), JSON.stringify(r.skipped));
    assert.ok(r.readIds.includes('ok-2'), 'the transcript still reads');
  } finally { rm(root); }
});

test('stage 1 (674 item 6): a stage-1 hit is read before a newer session that does not hit', async () => {
  const root = tmpRoot();
  try {
    const slug = 'ord-slug';
    const archiveDir = makeArchive(root, [
      { slug, sessionId: 'new-1', endISO: '2026-11-05T10:00:00Z', lines: [record('assistant', text('nothing here'))] },
      { slug, sessionId: 'old-1', endISO: '2026-11-01T10:00:00Z', lines: [record('assistant', text('the rate was 9.4 ms here'))], first: 'the rate was 9.4 ms here' },
    ]);
    const r = await runLookup({ archiveDir, slug, flags: [flag('the note said "the rate was 9.4 ms here"')] });
    assert.strictEqual(r.readIds[0], 'old-1', `read order: ${JSON.stringify(r.readIds)}`);
  } finally { rm(root); }
});

test('prefilter (674 item 6): system and summary records holding a needle never match', async () => {
  const root = tmpRoot();
  try {
    const slug = 'pf-slug';
    const archiveDir = makeArchive(root, [{ slug, sessionId: 'pf-1', endISO: '2026-11-01T10:00:00Z', lines: [record('system', text('the rate was 9.4 ms here')), record('summary', text('the rate was 9.4 ms here'))] }]);
    const r = await runLookup({ archiveDir, slug, flags: [flag('the note said "the rate was 9.4 ms here"')] });
    assert.deepStrictEqual(r.flags[0].hitNeedles, [], 'no system or summary record matches');
  } finally { rm(root); }
});

test('echo (674 item 6): a flag of 60 characters or more is labelled when a line repeats its head; a shorter flag never is', async () => {
  const root = tmpRoot();
  try {
    const slug = 'echo-slug';
    const long = 'the note said the cap moved to 120,000 characters in release 1.2.3 and we keep it';
    assert.ok(long.length >= 60, 'the long flag is at least 60 characters');
    const archiveDir = makeArchive(root, [{ slug, sessionId: 'echo-1', endISO: '2026-11-01T10:00:00Z', lines: [record('assistant', text(long + ' confirmed by the owner'))] }]);
    const longFrame = renderFrame(await runLookup({ archiveDir, slug, flags: [flag(long)] }));
    assert.ok(longFrame.includes('echo of the note'), longFrame);
    const shortFrame = renderFrame(await runLookup({ archiveDir, slug, flags: [flag('the note said 9.4 ms')] }));
    assert.ok(!shortFrame.includes('echo of the note'), 'a flag under 60 characters is never labelled');
  } finally { rm(root); }
});
