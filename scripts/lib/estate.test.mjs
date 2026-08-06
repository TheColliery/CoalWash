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
  reclaimableEstimate, estateReport, RECLAIM_HORIZON_MS, deriveEstateHorizonDays,
  resolveEstateHorizon,
} from './estate.mjs';
import { ccProjectSlug } from './class-b.mjs';

delete process.env.CLAUDE_CONFIG_DIR;

function sandbox() {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwe-home-')));
  const proj = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwe-proj-')));
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
  const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwe-out-')));
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
// board #55: deriveEstateHorizonDays — the horizon must UNDERCUT the
// platform's own cleanupPeriodDays, never mirror it
// ---------------------------------------------------------------------------

test('deriveEstateHorizonDays: ONE branchless formula, floor(cleanup/2) — NO floor at any value (closes the amendment\'s own named regression: the old max(7,…) floor left a TIGHTER-than-the-ratio window at cleanup=10)', () => {
  assert.strictEqual(deriveEstateHorizonDays(60), 30);
  assert.strictEqual(deriveEstateHorizonDays(30), 15);
  assert.strictEqual(deriveEstateHorizonDays(14), 7);
  assert.strictEqual(deriveEstateHorizonDays(10), 5, 'the old floor would have forced 7d here — TIGHTER than the 5d the ratio actually implies');
  assert.strictEqual(deriveEstateHorizonDays(7), 3);
  assert.strictEqual(deriveEstateHorizonDays(2), 1);
  assert.strictEqual(deriveEstateHorizonDays(1), 0, 'floor(1/2) = 0 is a valid output — the skip set (ACTIVE/roster), not a horizon floor, is what keeps this safe');
  // Unreadable/invalid input falls to the platform's own documented default (30 -> 15).
  assert.strictEqual(deriveEstateHorizonDays(NaN), 15);
  assert.strictEqual(deriveEstateHorizonDays(0), 15);
});

// ---------------------------------------------------------------------------
// resolveEstateHorizon — the ladder, one test per rung, each asserting BOTH
// the chosen horizon and the reported provenance (the amendment's own
// "fourth tense" requirement).
// ---------------------------------------------------------------------------

function writeSettings(dir, obj) {
  const p = path.join(dir, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj), 'utf8');
  return p;
}
function plantTranscript(home, slug, id, ageDays, now = Date.now()) {
  const dir = path.join(home, '.claude', 'projects', slug);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(p, '{}\n', 'utf8');
  const t = new Date(now - ageDays * 86400000);
  fs.utimesSync(p, t, t);
  return p;
}

test('resolveEstateHorizon rung 1: KEY READ + SANE — a present, sane project value binds; provenance names the project tier + file', () => {
  const { home, proj } = sandbox();
  try {
    fs.mkdirSync(path.join(proj, '.git'));
    const f = writeSettings(proj, { cleanupPeriodDays: 20 });
    const h = resolveEstateHorizon({ cwd: proj, home });
    assert.strictEqual(h.cleanupPeriodDays, 20);
    assert.strictEqual(h.rung, 'resolved');
    assert.strictEqual(h.file, f);
    assert.strictEqual(h.horizonDays, 10);
    assert.strictEqual(h.keyResolvedNow, true);
  } finally { clean(home, proj); }
});

test('resolveEstateHorizon rung 1: an ABSURD value (>3650, the amendment\'s own named example) is rejected as insane and falls through to rung 2', () => {
  const { home, proj } = sandbox();
  try {
    fs.mkdirSync(path.join(proj, '.git'));
    writeSettings(proj, { cleanupPeriodDays: 4000 }); // > 3650 -- a unit/semantics change, not a long retention
    const h = resolveEstateHorizon({ cwd: proj, home });
    assert.strictEqual(h.rung, 'documented-default', 'an absurd value must not be trusted as a real cleanupPeriodDays');
    assert.strictEqual(h.cleanupPeriodDays, 30);
    assert.strictEqual(h.keyResolvedNow, false);
  } finally { clean(home, proj); }
});

test('resolveEstateHorizon rung 2: KEY ABSENT everywhere — the documented default (30) applies, NORMAL not a failure, rung named "documented-default"', () => {
  const { home, proj } = sandbox();
  try {
    const h = resolveEstateHorizon({ cwd: proj, home });
    assert.strictEqual(h.rung, 'documented-default');
    assert.strictEqual(h.cleanupPeriodDays, 30);
    assert.strictEqual(h.horizonDays, 15);
    assert.strictEqual(h.file, null);
    assert.strictEqual(h.keyResolvedNow, false);
  } finally { clean(home, proj); }
});

test('resolveEstateHorizon rung 3: the observed floor overrides ONE-WAY when materially below the assumed value (real evidence near the boundary, nothing survived to it)', () => {
  const { home, proj } = sandbox();
  try {
    fs.mkdirSync(path.join(proj, '.git'));
    writeSettings(proj, { cleanupPeriodDays: 30 }); // assumed 30d
    plantTranscript(home, 'slugA', 'sess1', 20); // real evidence: 20d >= 30*0.5(=15) AND < 30 -> fires
    const h = resolveEstateHorizon({ cwd: proj, home });
    assert.strictEqual(h.floorApplied, true);
    assert.strictEqual(h.observedFloorDays, 20);
    assert.strictEqual(h.cleanupPeriodDays, 20, 'bound to the OBSERVED value, not the settings value, once the cross-check fires');
    assert.strictEqual(h.horizonDays, 10);
  } finally { clean(home, proj); }
});

test('resolveEstateHorizon rung 3: a FRESH-INSTALL observed floor (well below half the assumed period) is NOT material — no evidence near the boundary means no override, avoiding a false-aggressive horizon on day one', () => {
  const { home, proj } = sandbox();
  try {
    fs.mkdirSync(path.join(proj, '.git'));
    writeSettings(proj, { cleanupPeriodDays: 30 });
    plantTranscript(home, 'slugA', 'sess1', 3); // 3d << 15 (30*0.5) -- not enough history to say anything
    const h = resolveEstateHorizon({ cwd: proj, home });
    assert.strictEqual(h.floorApplied, false, 'a 3-day-old file on a fresh install is not evidence the real sweep is aggressive');
    assert.strictEqual(h.observedFloorDays, 3, 'still reported, informationally');
    assert.strictEqual(h.cleanupPeriodDays, 30);
  } finally { clean(home, proj); }
});

test('resolveEstateHorizon rung 3: an observed floor ABOVE the assumed value NEVER raises the horizon — the one-way rule, the data-loss direction is forbidden', () => {
  const { home, proj } = sandbox();
  try {
    fs.mkdirSync(path.join(proj, '.git'));
    writeSettings(proj, { cleanupPeriodDays: 10 });
    plantTranscript(home, 'slugA', 'sess1', 25); // a file has survived FAR past the assumed 10d
    const h = resolveEstateHorizon({ cwd: proj, home });
    assert.strictEqual(h.floorApplied, false, 'observed-above-assumed is reported, never used to widen the horizon');
    assert.strictEqual(h.observedFloorDays, 25);
    assert.strictEqual(h.cleanupPeriodDays, 10, 'stays bound to the settings value -- raising would be the forbidden direction');
  } finally { clean(home, proj); }
});

test('resolveEstateHorizon rung 4: NOTHING ESTABLISHABLE — a resolved -> unresolved transition distrusts even the documented default, uses the small conservative constant (7d) directly, no halving applied to it', () => {
  const { home, proj } = sandbox();
  try {
    // no settings anywhere this run -> keyResolvedNow=false; priorKeyResolved=true simulates
    // the key having resolved LAST run (a caller-supplied transition signal).
    const h = resolveEstateHorizon({ cwd: proj, home, priorKeyResolved: true });
    assert.strictEqual(h.rung, 'nothing-establishable');
    assert.strictEqual(h.horizonDays, 7);
    assert.strictEqual(h.transitionJustLost, true);
    assert.strictEqual(h.keyResolvedNow, false);
  } finally { clean(home, proj); }
});

test('resolveEstateHorizon rung 4: NOT triggered when priorKeyResolved is null (no history) or false (already unresolved last time, not a NEW transition)', () => {
  const { home, proj } = sandbox();
  try {
    const noHistory = resolveEstateHorizon({ cwd: proj, home, priorKeyResolved: null });
    assert.strictEqual(noHistory.rung, 'documented-default');
    assert.strictEqual(noHistory.transitionJustLost, false);

    const alreadyUnresolved = resolveEstateHorizon({ cwd: proj, home, priorKeyResolved: false });
    assert.strictEqual(alreadyUnresolved.rung, 'documented-default');
    assert.strictEqual(alreadyUnresolved.transitionJustLost, false, 'staying unresolved is not a NEW transition');
  } finally { clean(home, proj); }
});

test('resolveEstateHorizon rung 5: an unbound retention-shaped key is REPORTED by name and value, never auto-bound to it', () => {
  const { home, proj } = sandbox();
  try {
    fs.mkdirSync(path.join(proj, '.git'));
    writeSettings(proj, { cleanupPeriodDays: 30, retentionWindowDays: 5 }); // an unknown sibling
    const h = resolveEstateHorizon({ cwd: proj, home });
    assert.strictEqual(h.cleanupPeriodDays, 30, 'never bound to the guessed key');
    assert.strictEqual(h.candidateKeys.length, 1);
    assert.strictEqual(h.candidateKeys[0].key, 'retentionWindowDays');
    assert.strictEqual(h.candidateKeys[0].value, 5);
  } finally { clean(home, proj); }
});

test('resolveEstateHorizon rung 6: keyResolvedNow is a plain OUTPUT — the function never writes; the SAME cwd/home returns the identical value on repeated pure calls', () => {
  const { home, proj } = sandbox();
  try {
    fs.mkdirSync(path.join(proj, '.git'));
    writeSettings(proj, { cleanupPeriodDays: 20 });
    const h1 = resolveEstateHorizon({ cwd: proj, home });
    const h2 = resolveEstateHorizon({ cwd: proj, home });
    assert.strictEqual(h1.keyResolvedNow, true);
    assert.deepStrictEqual(h1, h2, 'purity: no hidden state mutated by the first call changes the second');
    assert.strictEqual(fs.existsSync(path.join(home, 'coal')), false, 'estate.mjs itself never writes -- no coal/ dir appears from this call alone');
  } finally { clean(home, proj); }
});

test('estateReport: wires the ladder end-to-end and states the binding in the report text, including the small-horizon WARN', () => {
  const { home, proj } = sandbox();
  try {
    fs.mkdirSync(path.join(proj, '.git'));
    writeSettings(proj, { cleanupPeriodDays: 4 }); // -> horizon 2d, triggers the small-horizon WARN
    const r = estateReport({ projectRoot: proj, home });
    assert.strictEqual(r.horizon.cleanupPeriodDays, 4);
    assert.strictEqual(r.horizon.horizonDays, 2);
    assert.match(r.text, /horizon binding: cleanupPeriodDays=4d \(resolved/);
    assert.match(r.text, /WARN: the derived reclaim horizon \(2d\) is small/);
    assert.strictEqual(r.cleanup, undefined, 'the amendment folds the old separate cleanup field into horizon');
  } finally { clean(home, proj); }
});

test('estateReport: a bare sandbox (no settings anywhere) states the documented default plainly, no WARN, no crash', () => {
  const { home, proj } = sandbox();
  try {
    const r = estateReport({ projectRoot: proj, home });
    assert.match(r.text, /horizon binding: cleanupPeriodDays=30d \(documented-default\) -> reclaim horizon 15d/);
    assert.ok(!r.text.includes('WARN'), '15d is not small');
    assert.ok(!r.text.includes('undefined') && !r.text.includes('NaN'));
  } finally { clean(home, proj); }
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
  const goneProj = path.join(fs.realpathSync.native(os.tmpdir()), 'cwe-gone-' + Date.now());
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
