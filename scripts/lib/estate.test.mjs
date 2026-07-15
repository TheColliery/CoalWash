// Hermetic tests for estate.mjs — the class-A ESTATE layer, P1 (report tier
// ONLY). Every test runs against a sandboxed HOME; the real machine's
// ~/.claude/projects/ must never leak in (node --test runs each file in its
// own process, but CLAUDE_CONFIG_DIR could still redirect claudeBaseDir).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  discoverEstateCC, detectOrphanSlugs, measureEstate, attributeTranscript,
  reclaimableEstimate, estateReport, RECLAIM_HORIZON_MS,
} from './estate.mjs';
import { ccProjectSlug } from './class-b.mjs';

delete process.env.CLAUDE_CONFIG_DIR;

function sandbox() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwe-home-')));
  const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwe-proj-')));
  return { home, proj };
}
function clean(...dirs) {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}
function write(p, content = 'x') {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}
function slugDirFor(home, proj) {
  return path.join(home, '.claude', 'projects', ccProjectSlug(proj));
}
function jsonlUserLine(cwd, content) {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content }, cwd })}\n`;
}

// ---------------------------------------------------------------------------
// discoverEstateCC
// ---------------------------------------------------------------------------

test('discoverEstateCC: finds flat *.jsonl transcripts, tool-results/ files, and other per-session-dir files; excludes memory/ and coalwash/', () => {
  const { home, proj } = sandbox();
  try {
    const slugDir = slugDirFor(home, proj);
    write(path.join(slugDir, 'sess-a.jsonl'), jsonlUserLine(proj, 'hello'));
    write(path.join(slugDir, 'sess-b.jsonl'), 'y'.repeat(50));
    write(path.join(slugDir, 'sess-a', 'tool-results', 'r1.txt'), 'z'.repeat(20));
    write(path.join(slugDir, 'sess-a', 'subagents', 'agent-1.jsonl'), 'w'.repeat(30));
    // Must be EXCLUDED: not a known session id (class-B's own jurisdiction / CW's own state).
    write(path.join(slugDir, 'memory', 'MEMORY.md'), 'should not appear');
    write(path.join(slugDir, 'coalwash', 'state.json'), '{}');

    const entries = discoverEstateCC({ projectRoot: proj, home });
    const byType = { transcript: [], 'tool-results': [], other: [] };
    for (const e of entries) byType[e.type].push(e);

    assert.strictEqual(byType.transcript.length, 2, 'both flat jsonl files found');
    assert.strictEqual(byType['tool-results'].length, 1);
    assert.strictEqual(byType.other.length, 1, 'the subagents/ file, tagged other');
    assert.ok(!entries.some((e) => e.path.includes('MEMORY.md')), 'memory/ excluded — class-b.mjs jurisdiction');
    assert.ok(!entries.some((e) => e.path.includes('state.json')), "coalwash/ (CW's own state) excluded");
    for (const e of entries) {
      assert.ok(Number.isFinite(e.bytes) && e.bytes >= 0);
      assert.ok(Number.isFinite(e.mtimeMs));
    }
  } finally { clean(home, proj); }
});

test('discoverEstateCC: fail-silent — a missing projects dir, or a project with no CC estate yet, returns []', () => {
  const { home, proj } = sandbox();
  try {
    assert.deepStrictEqual(discoverEstateCC({ projectRoot: proj, home }), [], 'no ~/.claude/projects/ at all');
    fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
    assert.deepStrictEqual(discoverEstateCC({ projectRoot: proj, home }), [], 'projects/ exists but this project has no slug dir');
  } finally { clean(home, proj); }
});

test('discoverEstateCC: realpath-contain rejects an out-of-tree junction inside a session dir (Windows-unprivileged; skips visibly elsewhere)', (t) => {
  const { home, proj } = sandbox();
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwe-out-')));
  try {
    const slugDir = slugDirFor(home, proj);
    write(path.join(slugDir, 'sess-a.jsonl'), 'x');
    write(path.join(outside, 'secret.txt'), 'not yours'.repeat(50));
    const linkPath = path.join(slugDir, 'sess-a', 'tool-results', 'escape-link');
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    try {
      // 'junction' is the unprivileged shim on Windows (no admin/dev-mode
      // needed, unlike a real symlink) — the room's own established pattern
      // (class-b.test.mjs G1).
      fs.symlinkSync(outside, linkPath, 'junction');
    } catch (e) {
      t.skip(`junction creation unavailable on this host: ${e.message}`);
      return;
    }
    const entries = discoverEstateCC({ projectRoot: proj, home });
    assert.ok(!entries.some((e) => e.path.includes('secret.txt')), 'content reached only via the escaping junction never surfaces');
  } finally { clean(home, proj, outside); }
});

// ---------------------------------------------------------------------------
// measureEstate
// ---------------------------------------------------------------------------

test('measureEstate: sums total bytes and rolls up per type correctly', () => {
  const entries = [
    { path: 'a', bytes: 100, type: 'transcript' },
    { path: 'b', bytes: 250, type: 'transcript' },
    { path: 'c', bytes: 30, type: 'tool-results' },
    { path: 'd', bytes: 7, type: 'other' },
  ];
  const m = measureEstate(entries);
  assert.strictEqual(m.files, 4);
  assert.strictEqual(m.totalBytes, 387);
  assert.deepStrictEqual(m.perType.transcript, { files: 2, bytes: 350 });
  assert.deepStrictEqual(m.perType['tool-results'], { files: 1, bytes: 30 });
  assert.deepStrictEqual(m.perType.other, { files: 1, bytes: 7 });
});

test('measureEstate: empty/non-array input is inert, never throws', () => {
  assert.deepStrictEqual(measureEstate([]), { files: 0, totalBytes: 0, perType: {} });
  assert.deepStrictEqual(measureEstate(undefined), { files: 0, totalBytes: 0, perType: {} });
});

// ---------------------------------------------------------------------------
// reclaimableEstimate
// ---------------------------------------------------------------------------

test('reclaimableEstimate: only entries older than the horizon count, labeled ~est', () => {
  const now = Date.now();
  const entries = [
    { bytes: 1000, mtimeMs: now - RECLAIM_HORIZON_MS - 86400000 }, // 1 day past the horizon
    { bytes: 500, mtimeMs: now - 3600000 }, // 1 hour old — nowhere near the horizon
    { bytes: 200 }, // no mtimeMs at all — doubt -> never counted
  ];
  const r = reclaimableEstimate(entries, { now });
  assert.strictEqual(r.files, 1);
  assert.strictEqual(r.bytes, 1000);
  assert.strictEqual(r.est, true);
  assert.strictEqual(r.horizonDays, 30);
});

// ---------------------------------------------------------------------------
// attributeTranscript
// ---------------------------------------------------------------------------

test('attributeTranscript: derives age from mtime and a topic hint from a trivial first user turn', () => {
  const { home, proj } = sandbox();
  try {
    const f = path.join(home, 'notes.jsonl');
    write(f, `${JSON.stringify({ type: 'system', note: 'ignored' })}\n${jsonlUserLine(proj, 'plan the release')}`);
    const now = Date.now();
    const ageMs = 5 * 86400000;
    fs.utimesSync(f, new Date(now - ageMs), new Date(now - ageMs));
    const st = fs.statSync(f);
    const a = attributeTranscript({ path: f, bytes: st.size, type: 'transcript', mtimeMs: st.mtimeMs }, { now });
    assert.strictEqual(a.ageDays, 5);
    assert.strictEqual(a.topic, 'plan the release');
  } finally { clean(home, proj); }
});

test('attributeTranscript: a non-trivial first user turn (array content) degrades to null topic, never throws', () => {
  const { home, proj } = sandbox();
  try {
    const f = path.join(home, 'notes2.jsonl');
    const line = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] }, cwd: proj });
    write(f, `${line}\n`);
    const a = attributeTranscript({ path: f, bytes: 10, type: 'transcript', mtimeMs: Date.now() });
    assert.strictEqual(a.topic, null);
  } finally { clean(home, proj); }
});

test('attributeTranscript: non-transcript entries never sniff a topic', () => {
  const a = attributeTranscript({ path: '/x/f.txt', bytes: 10, type: 'tool-results', mtimeMs: Date.now() });
  assert.strictEqual(a.topic, null);
});

// ---------------------------------------------------------------------------
// detectOrphanSlugs
// ---------------------------------------------------------------------------

test('detectOrphanSlugs: a slug whose cwd no longer exists is flagged; a live project is not', () => {
  const { home, proj } = sandbox();
  const goneProj = path.join(fs.realpathSync(os.tmpdir()), 'cwe-gone-' + Date.now());
  try {
    // Live project — its own slug dir must NOT be reported as an orphan.
    write(path.join(slugDirFor(home, proj), 'sess.jsonl'), jsonlUserLine(proj, 'alive'));

    // A second slug dir standing in for a project that has since been deleted.
    const goneSlugDir = path.join(home, '.claude', 'projects', ccProjectSlug(goneProj));
    write(path.join(goneSlugDir, 'sess.jsonl'), jsonlUserLine(goneProj, 'orphaned'));
    write(path.join(goneSlugDir, 'sess', 'tool-results', 'r.txt'), 'p'.repeat(40));

    const orphans = detectOrphanSlugs({ home });
    assert.strictEqual(orphans.length, 1);
    assert.strictEqual(orphans[0].cwd, goneProj);
    assert.ok(orphans[0].bytes > 0, 'sums the orphaned slug dir\'s own bytes');
    assert.ok(!orphans.some((o) => o.cwd === proj), 'the live project never flagged');
  } finally { clean(home, proj); if (fs.existsSync(goneProj)) fs.rmSync(goneProj, { recursive: true, force: true }); }
});

test('detectOrphanSlugs: a slug with no readable cwd (no jsonl) is skipped, never guessed into either bucket', () => {
  const { home, proj } = sandbox();
  try {
    // An empty slug dir — nothing to sniff a cwd from.
    fs.mkdirSync(path.join(home, '.claude', 'projects', 'no-jsonl-here'), { recursive: true });
    const orphans = detectOrphanSlugs({ home });
    assert.deepStrictEqual(orphans, []);
  } finally { clean(home, proj); }
});

test('detectOrphanSlugs: fail-silent on a missing projects dir', () => {
  const { home, proj } = sandbox();
  try {
    assert.deepStrictEqual(detectOrphanSlugs({ home }), []);
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// estateReport — end-to-end assembly
// ---------------------------------------------------------------------------

test('estateReport: assembles a P1 report — text + summary, honest empty state on a bare sandbox', () => {
  const { home, proj } = sandbox();
  try {
    const r = estateReport({ projectRoot: proj, home });
    assert.match(r.text, /report-only, P1/);
    assert.match(r.text, /P2 \(retention\/archive\)/);
    assert.match(r.summary, /^\[CoalWash\] estate:/);
    assert.strictEqual(r.measured.files, 0);
    assert.strictEqual(r.orphans.length, 0);
    assert.ok(!r.text.includes('undefined') && !r.text.includes('NaN'), 'no leaked placeholder on a zero-estate project');
  } finally { clean(home, proj); }
});

test('estateReport: real numbers roll up when there is estate to measure, and per-transcript prompt text never leaks into the report', () => {
  const { home, proj } = sandbox();
  try {
    const slugDir = slugDirFor(home, proj);
    write(path.join(slugDir, 'sess-a.jsonl'), jsonlUserLine(proj, 'a very private prompt nobody else should see'));
    write(path.join(slugDir, 'sess-a', 'tool-results', 'r1.txt'), 'z'.repeat(20));

    const r = estateReport({ projectRoot: proj, home });
    assert.strictEqual(r.measured.files, 2);
    assert.ok(r.measured.totalBytes > 0);
    assert.ok(!r.text.includes('a very private prompt'), 'the aggregate report is metrics-only, never prompt content');
    assert.ok(!r.summary.includes('a very private prompt'));
  } finally { clean(home, proj); }
});
