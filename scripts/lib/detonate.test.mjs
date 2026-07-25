// Hermetic barrage for detonate.mjs — the SUPPORT engine that GATES the main reducer. Load-bearing
// asserts: the MECHANICAL gates (file · structure · path · params) refuse bad input; the engine does
// NOT judge waste-vs-content (the agent's cutTypes execute as given); the ADVISORY report only FLAGS
// free-form content (never blocks the cut); dry-run reports without touching the main engine; and the
// detonator NEVER throws (any internal error → refuse('internal')).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import { detonate, survey, MAX_WAVE_LINES, TYPE_CENSUS_MAX } from './detonate.mjs';
import { CLAUDE_DEFAULT_CUT_TYPES, sha256File, reduceFile, CHUNK, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES } from './explode.mjs';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-')); }
function rm(dir) { fs.rmSync(dir, { recursive: true, force: true }); }
function writeNdjson(dir, name, objs) {
  const buf = Buffer.from(objs.map((o) => (typeof o === 'string' ? o : JSON.stringify(o))).join('\n') + '\n', 'utf8');
  const p = path.join(dir, name); fs.writeFileSync(p, buf); return p;
}
function outTypes(outPath) {
  return fs.readFileSync(outPath, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l).type; } catch { return '__unparsed__'; } });
}

// bookkeeping (content-free, short strings) + real conversation (survives when not requested)
const CLAUDEISH = [
  { type: 'mode', v: 'plan' },
  { type: 'custom-title', title: 'my session' },
  { type: 'user', message: { role: 'user', content: 'hello world' } },
  { type: 'queue-operation', op: 'push' },
  { type: 'assistant', message: { role: 'assistant', content: 'hi there' } },
  { type: 'last-prompt', prompt: 'hello world' },
  { type: 'attachment', file: 'a.txt', content: 'DATA' },
];

// --- EXECUTE + ADVISORY REPORT (the refactor's core) --------------------------------------------------

test('execute: a clean agent cut-list → byte-exact output, cut reflects PRESENT types, report populated, source intact', () => {
  const dir = tmp();
  try {
    const src = writeNdjson(dir, 'a.jsonl', CLAUDEISH);
    const before = sha256File(src);
    const out = path.join(dir, 'a.reduced.jsonl');
    const snap = path.join(dir, 'snap');
    const r = detonate(src, { cutTypes: CLAUDE_DEFAULT_CUT_TYPES, outPath: out, snapshotDir: snap });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.verified, true);
    assert.strictEqual(r.triggered, true);
    assert.deepStrictEqual([...r.cut].sort(), [...CLAUDE_DEFAULT_CUT_TYPES].sort(), 'both present UI-state types are in cut (A4-rescoped pair)');
    assert.deepStrictEqual(r.droppedCutTypes, [], 'nothing dropped');
    for (const t of CLAUDE_DEFAULT_CUT_TYPES) {
      assert.ok(r.report.perType[t], `report has an entry for the present type ${t}`);
      assert.strictEqual(r.report.perType[t].unitCount, 1);
      assert.strictEqual(r.report.perType[t].freeFormCount, 0, `${t} is content-free`);
    }
    assert.ok(!r.report.perType.user, 'the report only covers REQUESTED cut-types (user was not requested)');
    assert.deepStrictEqual(outTypes(out), ['user', 'queue-operation', 'assistant', 'last-prompt', 'attachment'], 'the conversation survives in order — and so do queue-operation + last-prompt, which the A4 ruling removed from the blind default');
    assert.ok(fs.existsSync(snap), 'the snapshot store was created (main engine WAS triggered)');
    assert.strictEqual(sha256File(src), before, 'source byte-intact — the reduction writes a SEPARATE slim copy');
  } finally { rm(dir); }
});

test('ADVISORY: a requested type carrying free-form content is FLAGGED (freeFormCount>0 + redacted sample) but the cut STILL EXECUTES — the engine never judges, the agent decided', () => {
  const dir = tmp();
  try {
    const ORE = 'SECRET-ore-'.repeat(20); // 220 chars of prose the old front-sample gate could miss
    const objs = [
      { type: 'mode', v: 'plan' },
      { type: 'user', message: { role: 'user', content: ORE } },
      { type: 'assistant', message: { role: 'assistant', content: 'hi' } },
    ];
    const src = writeNdjson(dir, 'a.jsonl', objs);
    const before = sha256File(src);
    const out = path.join(dir, 'o.jsonl');
    const snap = path.join(dir, 's');
    // the AGENT chose to cut 'user' despite its free-form content — the engine executes that choice
    const r = detonate(src, { cutTypes: ['mode', 'user'], outPath: out, snapshotDir: snap });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.triggered, true, 'the cut executes — freeFormCount NEVER blocks');
    assert.ok(r.report.perType.user.freeFormCount > 0, 'the free-form user content is FLAGGED');
    assert.strictEqual(r.report.perType.mode.freeFormCount, 0, 'the content-free mode is not flagged');
    assert.ok(r.report.perType.user.sample.length >= 1, 'a redacted sample is offered');
    assert.match(r.report.perType.user.sample[0], /free-form/, 'the sample redacts the long string to a length marker');
    assert.ok(!/SECRET-ore/.test(r.report.perType.user.sample[0]), 'the ore itself is NOT dumped into the report');
    assert.deepStrictEqual([...r.cut].sort(), ['mode', 'user'], 'both requested present types are cut');
    assert.deepStrictEqual(outTypes(out), ['assistant'], 'only the un-cut conversation survives — the agent overrode the flag');
    assert.ok(fs.existsSync(snap), 'snapshot present');
    assert.strictEqual(sha256File(src), before, 'source byte-intact');
  } finally { rm(dir); }
});

test('dry-run (no outPath): returns the report with triggered:false — no output, no snapshot, main NEVER called, source untouched', () => {
  const dir = tmp();
  try {
    const objs = [{ type: 'mode', v: 'plan' }, { type: 'user', message: { content: 'y'.repeat(120) } }];
    const src = writeNdjson(dir, 'a.jsonl', objs);
    const before = sha256File(src);
    const out = path.join(dir, 'o.jsonl');
    const snap = path.join(dir, 's');
    const r = detonate(src, { cutTypes: ['mode', 'user'], snapshotDir: snap }); // NO outPath
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.verified, true);
    assert.strictEqual(r.triggered, false, 'a dry-run never triggers the reducer');
    assert.ok(r.report.perType.mode && r.report.perType.user, 'the report is populated for present requested types');
    assert.ok(r.report.perType.user.freeFormCount > 0, 'the advisory still flags free-form content in dry-run');
    assert.deepStrictEqual([...r.cut].sort(), ['mode', 'user']);
    assert.strictEqual(fs.existsSync(out), false, 'no output written');
    assert.strictEqual(fs.existsSync(snap), false, 'no snapshot store — the main engine was never called');
    assert.strictEqual(sha256File(src), before, 'source untouched');
  } finally { rm(dir); }
});

test('no 512KB ceiling: free-form content PAST the old 512KB sample boundary is still counted', () => {
  const dir = tmp();
  try {
    // ~600KB of content-free filler, THEN a free-form user unit — well past the old 512KB front sample
    const lines = [];
    let bytes = 0;
    while (bytes < 600 * 1024) {
      const line = JSON.stringify({ type: 'mode', v: 'plan', pad: 'p'.repeat(50) }); // 50-char pad < the 80 boundary
      lines.push(line);
      bytes += line.length + 1;
    }
    lines.push(JSON.stringify({ type: 'user', message: { content: 'z'.repeat(300) } }));
    const src = writeNdjson(dir, 'big.jsonl', lines);
    assert.ok(fs.statSync(src).size > 512 * 1024, 'fixture exceeds 512KB');
    const r = detonate(src, { cutTypes: ['user'], snapshotDir: path.join(dir, 's') }); // dry-run report
    assert.ok(r.report.perType.user, 'the past-512KB user unit was seen (whole-file scan, no ceiling)');
    assert.strictEqual(r.report.perType.user.unitCount, 1);
    assert.strictEqual(r.report.perType.user.freeFormCount, 1, 'its free-form content is counted despite being past 512KB');
  } finally { rm(dir); }
});

test('non-string cutTypes are SURFACED in droppedCutTypes (never silently dropped); the string types still execute', () => {
  const dir = tmp();
  try {
    const src = writeNdjson(dir, 'a.jsonl', CLAUDEISH);
    const out = path.join(dir, 'o.jsonl');
    const r = detonate(src, { cutTypes: ['mode', 123, {}, null, 'queue-operation'], outPath: out, snapshotDir: path.join(dir, 's') });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.droppedCutTypes, [123, {}, null], 'every non-string entry surfaced, in order');
    assert.deepStrictEqual([...r.cut].sort(), ['mode', 'queue-operation'], 'only the present string types are cut');
    const types = outTypes(out);
    assert.ok(!types.includes('mode') && !types.includes('queue-operation'));
  } finally { rm(dir); }
});

test('all-non-string cutTypes (no valid string, default not reachable) → REFUSED at the cutlist gate, drops surfaced', () => {
  const dir = tmp();
  try {
    const src = writeNdjson(dir, 'a.jsonl', CLAUDEISH);
    const r = detonate(src, { cutTypes: [123, {}], outPath: path.join(dir, 'o'), snapshotDir: path.join(dir, 's') });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.refused, true);
    assert.strictEqual(r.failedCheck, 'cutlist');
    assert.deepStrictEqual(r.droppedCutTypes, [123, {}]);
  } finally { rm(dir); }
});

test('json-single: a content-free record cuts to empty; a free-form record is FLAGGED field-agnostically but STILL cuts when requested', () => {
  const dir = tmp();
  try {
    // content-free single record → cut to empty
    const freeSrc = path.join(dir, 'free.json'); fs.writeFileSync(freeSrc, JSON.stringify({ type: 'mode', v: 'plan' }, null, 2));
    const rFree = detonate(freeSrc, { cutTypes: ['mode'], outPath: path.join(dir, 'free.out'), snapshotDir: path.join(dir, 's1') });
    assert.strictEqual(rFree.ok, true);
    assert.strictEqual(rFree.triggered, true);
    assert.strictEqual(rFree.report.perType.mode.freeFormCount, 0);
    assert.strictEqual(fs.statSync(path.join(dir, 'free.out')).size, 0, 'the single cut record reduces to empty');
    // free-form single record under an ARBITRARY field name ('note') → the old text/message/content
    // denylist would MISS it; the field-agnostic scan flags it, and the cut still executes
    const richSrc = path.join(dir, 'rich.json'); fs.writeFileSync(richSrc, JSON.stringify({ type: 'mode', note: 'q'.repeat(150) }, null, 2));
    const rRich = detonate(richSrc, { cutTypes: ['mode'], outPath: path.join(dir, 'rich.out'), snapshotDir: path.join(dir, 's2') });
    assert.strictEqual(rRich.ok, true);
    assert.strictEqual(rRich.triggered, true, 'the cut executes despite the free-form flag');
    assert.ok(rRich.report.perType.mode.freeFormCount > 0, 'the free-form note field is flagged field-agnostically');
    assert.strictEqual(fs.statSync(path.join(dir, 'rich.out')).size, 0, 'still cut to empty — the agent decided');
  } finally { rm(dir); }
});

test('config: freeStringMaxChars moves the free-form threshold (the key is LIVE, not cosmetic)', () => {
  const dir = tmp();
  try {
    const src = writeNdjson(dir, 'a.jsonl', [{ type: 'mode', note: 'x'.repeat(100) }]); // one 100-char string
    const snap = path.join(dir, 's');
    const rDefault = detonate(src, { cutTypes: ['mode'], snapshotDir: snap }); // default 80 → flagged
    assert.strictEqual(rDefault.report.perType.mode.freeFormCount, 1, 'a 100-char string trips the default-80 boundary');
    const rHigh = detonate(src, { cutTypes: ['mode'], snapshotDir: snap, freeStringMaxChars: 200 }); // 200 → not flagged
    assert.strictEqual(rHigh.report.perType.mode.freeFormCount, 0, 'raising freeStringMaxChars to 200 stops flagging the 100-char string');
    assert.strictEqual(rHigh.report.perType.mode.unitCount, 1, 'the unit is still counted, just not flagged');
  } finally { rm(dir); }
});

// --- MECHANICAL GATES (unchanged refusals) ------------------------------------------------------------

test('opaque file → REFUSED at the structure gate, main engine NEVER triggered (no output, no snapshot)', () => {
  const dir = tmp();
  try {
    const src = path.join(dir, 'notes.md'); fs.writeFileSync(src, '# Heading\n\nsome prose\n- a bullet\n');
    const out = path.join(dir, 'o.out');
    const snap = path.join(dir, 'snap');
    const r = detonate(src, { cutTypes: ['mode'], outPath: out, snapshotDir: snap });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.refused, true);
    assert.strictEqual(r.triggered, false);
    assert.strictEqual(r.failedCheck, 'structure');
    assert.strictEqual(fs.existsSync(out), false, 'no output — reduceToCompletion was never called');
    assert.strictEqual(fs.existsSync(snap), false, 'no snapshot store — reduceToCompletion was never called');
  } finally { rm(dir); }
});

test('outPath aliases the source → REFUSED at the path gate, source untouched', () => {
  const dir = tmp();
  try {
    const src = writeNdjson(dir, 'a.jsonl', CLAUDEISH);
    const before = sha256File(src);
    const r = detonate(src, { cutTypes: ['mode'], outPath: src, snapshotDir: path.join(dir, 's') });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.refused, true);
    assert.strictEqual(r.failedCheck, 'path');
    assert.match(r.reason, /alias|source/i);
    assert.strictEqual(sha256File(src), before, 'source byte-intact — never triggered');
  } finally { rm(dir); }
});

test('forged / non-finite params (budget 0/NaN, forged offset, present resume) → REFUSED at the params gate — the gap the main engine only no-ops on', () => {
  const dir = tmp();
  try {
    const src = writeNdjson(dir, 'a.jsonl', CLAUDEISH);
    const base = { cutTypes: ['mode'], outPath: path.join(dir, 'o.jsonl'), snapshotDir: path.join(dir, 's') };
    for (const bad of [
      { ...base, maxBytes: 0 },
      { ...base, maxLines: NaN },
      { ...base, maxLines: -1 },
      { ...base, offset: NaN },
      { ...base, offset: 5 },
      { ...base, resume: { outLen: NaN } },
      { ...base, resume: { outLen: 10 } }, // even a well-formed resume: detonate is fresh-only
    ]) {
      const r = detonate(src, bad);
      assert.strictEqual(r.ok, false, `${JSON.stringify({ maxBytes: bad.maxBytes, maxLines: bad.maxLines, offset: bad.offset, resume: bad.resume })} must refuse`);
      assert.strictEqual(r.refused, true);
      assert.strictEqual(r.failedCheck, 'params');
    }
    assert.strictEqual(fs.existsSync(path.join(dir, 'o.jsonl')), false, 'never triggered on any forged params');
  } finally { rm(dir); }
});

test('gate 5 MEMORY ceiling — a FINITE-but-huge per-wave budget (would let ONE wave buffer the whole file → O(filesize) RAM) is REFUSED, extending the Infinity guard to finite values; source untouched, never triggered', () => {
  const dir = tmp();
  try {
    const src = writeNdjson(dir, 'a.jsonl', CLAUDEISH);
    const before = sha256File(src);
    const out = path.join(dir, 'o.jsonl');
    const base = { cutTypes: ['mode'], outPath: out, snapshotDir: path.join(dir, 's') };
    for (const bad of [
      { ...base, maxBytes: 1e15 },                  // finite-but-huge byte budget — the reported OOM (kept[] concat = O(filesize))
      { ...base, maxLines: 1e15 },                  // finite-but-huge line budget (kept[] slot count = O(filesize))
      { ...base, maxBytes: 1e15, maxLines: 1e15 },  // the exact red-team repro
      { ...base, maxBytes: DEFAULT_MAX_BYTES + 1 }, // one byte OVER the ceiling → refused (the boundary)
      { ...base, maxLines: MAX_WAVE_LINES + 1 },    // one line OVER the ceiling → refused (the boundary)
      { ...base, maxBytes: Infinity },              // Infinity still refused (unchanged — the guard the finite case extends)
      { ...base, maxLines: Infinity },
    ]) {
      const r = detonate(src, bad);
      assert.strictEqual(r.ok, false, `${JSON.stringify({ maxBytes: bad.maxBytes, maxLines: bad.maxLines })} must refuse`);
      assert.strictEqual(r.refused, true);
      assert.strictEqual(r.failedCheck, 'params', 'an over-ceiling per-wave budget refuses at the params gate');
    }
    assert.strictEqual(fs.existsSync(out), false, 'never triggered on any over-ceiling budget');
    assert.strictEqual(sha256File(src), before, 'source byte-intact — no wave ever ran');
  } finally { rm(dir); }
});

test('gate 5 MEMORY ceiling — no regression: a budget AT the ceiling still reduces (one wave), and a legal in-window budget MULTI-WAVES byte-correctly (the streaming path is intact, waves stay > 1)', () => {
  const dir = tmp();
  try {
    // (A) the window is INCLUSIVE (<=): the LARGEST legal per-wave budget still executes on a small file
    const src = writeNdjson(dir, 'a.jsonl', CLAUDEISH);
    const rMax = detonate(src, { cutTypes: CLAUDE_DEFAULT_CUT_TYPES, outPath: path.join(dir, 'o.jsonl'), snapshotDir: path.join(dir, 's'), maxBytes: DEFAULT_MAX_BYTES, maxLines: MAX_WAVE_LINES });
    assert.strictEqual(rMax.ok, true, 'a budget exactly AT the ceiling is accepted (the [floor, ceiling] window is inclusive, not off-by-one)');
    assert.strictEqual(rMax.triggered, true);
    assert.deepStrictEqual(outTypes(path.join(dir, 'o.jsonl')), ['user', 'queue-operation', 'assistant', 'last-prompt', 'attachment'], 'the cut is still correct at the ceiling budget');

    // (B) a legal ABOVE-FLOOR budget still forces N>1 waves and the multi-wave reduce is byte-correct. >DEFAULT_MAX_LINES
    // units so a legal maxLines drives ≥2 waves; every 2000th unit is a KEPT 'user' with a unique marker, the rest
    // cuttable 'mode' → the surviving markers + their ORDER prove no wave dropped/duplicated/reordered a line across
    // the boundary. Fixture stays < CHUNK, so the (separate, don't-touch) re-read belts never enter here.
    const units = [];
    for (let i = 0; i < 22000; i++) units.push(i % 2000 === 0 ? { type: 'user', message: { content: `keep-${i}` } } : { type: 'mode', v: i });
    const keepers = units.filter((u) => u.type === 'user').map((u) => u.message.content); // keep-0 .. keep-20000, in order
    const big = writeNdjson(dir, 'big.jsonl', units);
    assert.ok(fs.statSync(big).size < CHUNK, 'the multi-wave fixture is under one CHUNK (isolates the line-driven wave split)');
    const out2 = path.join(dir, 'big.reduced.jsonl');
    const r = detonate(big, { cutTypes: ['mode'], outPath: out2, snapshotDir: path.join(dir, 's2'), maxLines: DEFAULT_MAX_LINES + 1000 }); // 21000 — legal, above the floor
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.triggered, true);
    assert.ok(r.waves > 1, `the legal budget still MULTI-waves (waves=${r.waves}) — the ceiling did not collapse streaming to one whole-file wave`);
    const got = fs.readFileSync(out2, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(got.every((u) => u.type === 'user'), 'only the kept type survives across all waves');
    assert.deepStrictEqual(got.map((u) => u.message.content), keepers, 'every kept unit survived byte-correct and IN ORDER across the wave boundary (no drop / dup / reorder)');
  } finally { rm(dir); }
});

test('file gate: a missing src and a directory src are both REFUSED (never a throw)', () => {
  const dir = tmp();
  try {
    const rMissing = detonate(path.join(dir, 'nope.jsonl'), { cutTypes: ['mode'], outPath: path.join(dir, 'o'), snapshotDir: path.join(dir, 's') });
    assert.strictEqual(rMissing.ok, false);
    assert.strictEqual(rMissing.failedCheck, 'file');
    const rDir = detonate(dir, { cutTypes: ['mode'], outPath: path.join(dir, 'o'), snapshotDir: path.join(dir, 's') });
    assert.strictEqual(rDir.ok, false);
    assert.strictEqual(rDir.failedCheck, 'file');
    assert.match(rDir.reason, /regular file/i);
  } finally { rm(dir); }
});

test('storeRoot containment: a src OUTSIDE the expected store root is REFUSED', () => {
  const dir = tmp();
  try {
    const inside = path.join(dir, 'store'); fs.mkdirSync(inside);
    const good = writeNdjson(inside, 'a.jsonl', CLAUDEISH);
    const outsider = writeNdjson(dir, 'b.jsonl', CLAUDEISH);
    const opts = { storeRoot: inside };
    const rIn = detonate(good, { cutTypes: ['mode'], outPath: path.join(dir, 'o1.jsonl'), snapshotDir: path.join(dir, 's1') }, opts);
    assert.strictEqual(rIn.ok, true, 'a src inside the store root passes');
    const rOut = detonate(outsider, { cutTypes: ['mode'], outPath: path.join(dir, 'o2.jsonl'), snapshotDir: path.join(dir, 's2') }, opts);
    assert.strictEqual(rOut.ok, false);
    assert.strictEqual(rOut.failedCheck, 'file');
  } finally { rm(dir); }
});

// --- MED: the detonator NEVER throws --------------------------------------------------------------------

test('MED — a number / object / array outPath makes path.resolve throw INSIDE the gated body → refuse(internal), NEVER an uncaught throw', () => {
  const dir = tmp();
  try {
    const src = writeNdjson(dir, 'a.jsonl', CLAUDEISH);
    const before = sha256File(src);
    for (const badOut of [42, {}, [1, 2]]) {
      const r = detonate(src, { cutTypes: ['mode'], outPath: badOut, snapshotDir: path.join(dir, 's') });
      assert.strictEqual(r.ok, false, `${JSON.stringify(badOut)} must return, not throw`);
      assert.strictEqual(r.refused, true);
      assert.strictEqual(r.failedCheck, 'internal', 'a throw inside the gated body → refuse(internal)');
    }
    assert.strictEqual(sha256File(src), before, 'source byte-intact — no cut on any thrown path');
  } finally { rm(dir); }
});

test('MED — an injected fs throw inside the gated body → refuse(internal), fd still closed, never propagates', () => {
  const dir = tmp();
  try {
    const src = writeNdjson(dir, 'a.jsonl', CLAUDEISH);
    const realRead = fs.readSync;
    fs.readSync = () => { throw new Error('injected disk error'); }; // node:fs is shared → detonate/explode see it
    let r;
    try {
      r = detonate(src, { cutTypes: ['mode'], outPath: path.join(dir, 'o.jsonl'), snapshotDir: path.join(dir, 's') });
    } finally {
      fs.readSync = realRead;
    }
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.refused, true);
    assert.strictEqual(r.failedCheck, 'internal');
    assert.match(r.reason, /injected disk error/);
  } finally { rm(dir); }
});

// --- ADVISORY HARDENING (#5 param · #2 depth · #3 aggregate) + #1 gate-4 belt -------------------------

test('#5 — an invalid freeStringMaxChars (NaN / non-number / ≤0) FALLS BACK to the default 80: it never BLINDS the signal and never over-flags, and the run never refuses on an advisory param', () => {
  const dir = tmp();
  try {
    // one 200-char ore unit (must stay flagged) + one short content-free unit (must stay UN-flagged)
    const src = writeNdjson(dir, 'a.jsonl', [
      { type: 'mode', note: 'o'.repeat(200) },
      { type: 'last-prompt', prompt: 'hi' },
    ]);
    const snap = path.join(dir, 's');
    for (const bad of [NaN, '80', -5, 0, undefined, null, {}]) {
      const r = detonate(src, { cutTypes: ['mode', 'last-prompt'], snapshotDir: snap, freeStringMaxChars: bad }); // dry-run
      assert.strictEqual(r.ok, true, `freeStringMaxChars=${String(bad)}: an advisory param NEVER refuses the run`);
      assert.strictEqual(r.report.perType.mode.freeFormCount, 1, `freeStringMaxChars=${String(bad)}: fell back to 80 → the 200-char string is still flagged (NaN did not blind it)`);
      assert.strictEqual(r.report.perType['last-prompt'].freeFormCount, 0, `freeStringMaxChars=${String(bad)}: a short content-free unit is NOT over-flagged (≤0 did not leak through)`);
    }
    // a VALID high value still moves the threshold (the fallback did not clobber a good value)
    const rHigh = detonate(src, { cutTypes: ['mode'], snapshotDir: snap, freeStringMaxChars: 500 });
    assert.strictEqual(rHigh.report.perType.mode.freeFormCount, 0, 'a valid 500 raises the bar → the 200-char string is not flagged');
  } finally { rm(dir); }
});

test('#3 aggregate — a PILE of individually-short strings (none > freeStringMaxChars) is flagged by the aggregate-byte signal; a single-string check alone would miss it, and the redacted sample still hides the ore bytes', () => {
  const dir = tmp();
  try {
    // 100 strings of 50 chars each (< the 80 default) = ~5KB of free-form no single-string check sees
    // (the real-world case is 20000×short = ~200KB; this compact pile proves the same mechanism)
    const parts = Array.from({ length: 100 }, (_, i) => `chunk-${i}-`.padEnd(50, 'x'));
    const src = writeNdjson(dir, 'a.jsonl', [{ type: 'mode', parts }]);
    const r = detonate(src, { cutTypes: ['mode'], snapshotDir: path.join(dir, 's') }); // dry-run
    assert.strictEqual(r.report.perType.mode.unitCount, 1);
    assert.strictEqual(r.report.perType.mode.freeFormCount, 1, 'the aggregate of short strings is flagged (not blinded by a single-string-only check)');
    assert.ok(r.report.perType.mode.sample[0].length <= 200, 'the sample is length-capped — the ~5KB of ore is not dumped into the report');
  } finally { rm(dir); }
});

test('#2 depth — a long string nested past the OLD WALK_DEPTH=6 cap is now caught (raised to 12), still bounded (a signal, never a total detector)', () => {
  const dir = tmp();
  try {
    // a 200-char ore string wrapped ~9 levels deep — past the old 6 cap, within the new 12
    let deep = { note: 'o'.repeat(200) };
    for (let i = 0; i < 8; i++) deep = { nest: deep };
    const src = writeNdjson(dir, 'a.jsonl', [{ type: 'mode', body: deep }]);
    const r = detonate(src, { cutTypes: ['mode'], snapshotDir: path.join(dir, 's') });
    assert.strictEqual(r.report.perType.mode.freeFormCount, 1, 'ore nested past the old depth-6 cap is caught by WALK_DEPTH=12');
  } finally { rm(dir); }
});

test('#1 belt — on an inode-less volume (stat.ino===0: exFAT/FAT/SMB) a SAME-directory outPath is fail-closed refused; a DIFFERENT-directory outPath is allowed; a normal (ino≠0) volume is UNCHANGED', () => {
  const dir = tmp();
  const realStat = fs.statSync;
  const realFstat = fs.fstatSync;
  try {
    const src = writeNdjson(dir, 'a.jsonl', CLAUDEISH);
    const sub = path.join(dir, 'sub'); fs.mkdirSync(sub);
    const before = sha256File(src);

    // (1) normal volume (real ino, no stub): a same-dir different-NAME outPath is ALLOWED — the belt only bites ino===0
    const rNormal = detonate(src, { cutTypes: ['mode'], outPath: path.join(dir, 'a.reduced.jsonl'), snapshotDir: path.join(dir, 's0') });
    assert.strictEqual(rNormal.ok, true, 'normal ino≠0: a same-dir outPath is allowed (unchanged behavior)');

    // force ino===0 everywhere (exFAT/FAT/SMB simulation) — the dev/ino hardlink backstop self-disables there.
    // BOTH stat entry points must be stubbed: gate 1 now fstats the FD (the CodeQL #23/#24 race fix), so a
    // statSync-only stub would leave a real ino on the object gate 4 inspects and the belt would never arm —
    // the simulation would silently stop reaching the code under test. A genuine inode-less volume reports
    // ino 0 through fstat too, so production behaviour is unchanged; only the stub had to follow the fd.
    fs.statSync = function (p, ...a) { const s = realStat.call(this, p, ...a); s.ino = 0; return s; };
    fs.fstatSync = function (fd, ...a) { const s = realFstat.call(this, fd, ...a); s.ino = 0; return s; };

    // (2) ino===0 + SAME-directory outPath → fail-closed refuse at the path gate
    const rSame = detonate(src, { cutTypes: ['mode'], outPath: path.join(dir, 'a.reduced2.jsonl'), snapshotDir: path.join(dir, 's1') });
    assert.strictEqual(rSame.ok, false);
    assert.strictEqual(rSame.refused, true);
    assert.strictEqual(rSame.failedCheck, 'path');
    assert.match(rSame.reason, /inode-less|same-directory|fail-closed/i);

    // (3) ino===0 + DIFFERENT-directory outPath → allowed (the belt over-refuses ONLY same-dir)
    const rDiff = detonate(src, { cutTypes: ['mode'], outPath: path.join(sub, 'o.jsonl'), snapshotDir: path.join(dir, 's2') });
    assert.notStrictEqual(rDiff.failedCheck, 'path', 'a different-directory outPath passes gate 4 even on an inode-less volume');
    assert.strictEqual(rDiff.ok, true, 'the different-dir cut still executes');
    assert.strictEqual(rDiff.triggered, true);

    assert.strictEqual(sha256File(src), before, 'source byte-intact throughout — the belt is defense-in-depth, no data loss either way');
  } finally {
    fs.statSync = realStat;
    fs.fstatSync = realFstat;
    rm(dir);
  }
});

// --- SURVEY (the stateless census / ore-detector) -----------------------------------------------------

test('survey: returns EVERY distinct type with unitCount + freeFormCount — a content-free bookkeeping type reads 0, a content type reads >0, both present', () => {
  const dir = tmp();
  try {
    const objs = [
      { type: 'mode', v: 'plan' },                             // content-free bookkeeping
      { type: 'mode', v: 'accept-edits' },                     // a second mode unit
      { type: 'user', message: { content: 'x'.repeat(200) } }, // content-bearing (past the 80 boundary)
      { type: 'assistant', message: { content: 'ok' } },       // short content, un-flagged
    ];
    const src = writeNdjson(dir, 'a.jsonl', objs);
    const r = survey(src);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.structure, 'ndjson');
    assert.strictEqual(r.totalUnits, 4, 'the census counts every parsed unit');
    assert.deepStrictEqual(Object.keys(r.types).sort(), ['assistant', 'mode', 'user'], 'EVERY distinct type is censused, not just requested ones');
    assert.strictEqual(r.types.mode.unitCount, 2, 'both mode units counted under one type key');
    assert.strictEqual(r.types.mode.freeFormCount, 0, 'the content-free bookkeeping type reads freeFormCount 0');
    assert.strictEqual(r.types.user.unitCount, 1);
    assert.ok(r.types.user.freeFormCount > 0, 'the content-bearing type reads freeFormCount >0');
    assert.ok(r.types.user.sample.length >= 1 && r.types.user.sample.length <= 2, 'a redacted sample (≤2) is offered');
    assert.match(r.types.user.sample[0], /free-form/, 'the long string is redacted to a length marker — ore bytes never dumped');
    assert.ok(!/xxxxxxxxxx/.test(JSON.stringify(r.types)), 'the raw ore is not present anywhere in the census');
  } finally { rm(dir); }
});

test('survey gates: an opaque file → refused (failedCheck structure); a missing src and a directory src → refused (failedCheck file); it never throws', () => {
  const dir = tmp();
  try {
    const md = path.join(dir, 'notes.md'); fs.writeFileSync(md, '# Heading\n\nprose, not json\n- a bullet\n');
    const rOpaque = survey(md);
    assert.strictEqual(rOpaque.ok, false);
    assert.strictEqual(rOpaque.refused, true);
    assert.strictEqual(rOpaque.triggered, false);
    assert.strictEqual(rOpaque.failedCheck, 'structure', 'cannot survey what we cannot parse');

    const rMissing = survey(path.join(dir, 'nope.jsonl'));
    assert.strictEqual(rMissing.ok, false);
    assert.strictEqual(rMissing.failedCheck, 'file');

    const rDir = survey(dir);
    assert.strictEqual(rDir.ok, false);
    assert.strictEqual(rDir.failedCheck, 'file');
    assert.match(rDir.reason, /regular file/i);
    // all three returned a value (never threw) — the census is fail-closed, not fail-loud
  } finally { rm(dir); }
});

test('survey is READ-ONLY: it writes zero bytes — no output file, no snapshot dir, the directory listing is unchanged', () => {
  const dir = tmp();
  try {
    const src = writeNdjson(dir, 'a.jsonl', CLAUDEISH);
    const before = fs.readdirSync(dir).sort();
    const r = survey(src);
    assert.strictEqual(r.ok, true);
    const after = fs.readdirSync(dir).sort();
    assert.deepStrictEqual(after, before, 'survey created NO file or dir (no output, no snapshot) — stateless + read-only, Phoenix-clean');
  } finally { rm(dir); }
});

test('survey: typeless units (an object with no string type, a non-string type) are grouped under the (untyped) key', () => {
  const dir = tmp();
  try {
    const objs = [
      { type: 'mode', v: 'plan' },
      { noType: 'here' }, // object with no `type` field → untyped
      { type: 123 },      // a non-string type → untyped
    ];
    const src = writeNdjson(dir, 'a.jsonl', objs);
    const r = survey(src);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.totalUnits, 3);
    assert.strictEqual(r.types.mode.unitCount, 1);
    assert.ok(r.types['(untyped)'], 'an (untyped) bucket exists');
    assert.strictEqual(r.types['(untyped)'].unitCount, 2, 'both typeless units land in (untyped)');
  } finally { rm(dir); }
});

// --- IC-PIN FIXES (destruction-ladder findings — SAFETY-CRITICAL regressions) -------------------------

test('FIX 1 (source-sacred) — src resolving INSIDE the snapshot store is REFUSED at both layers (detonate path gate + reduceFile floor); the source is byte-intact', () => {
  const dir = tmp();
  try {
    // (a) detonate: src basename == manifest.jsonl, snapshotDir == dirname(src) → the recovery manifest
    //     append would write INTO the source; the gate-4 belt refuses BEFORE triggering.
    const src = writeNdjson(dir, 'manifest.jsonl', CLAUDEISH);
    const before = sha256File(src);
    const out = path.join(dir, 'sub', 'out.jsonl'); // outside would-be, but the src check fires first
    const rDet = detonate(src, { cutTypes: ['mode'], outPath: out, snapshotDir: dir });
    assert.strictEqual(rDet.ok, false);
    assert.strictEqual(rDet.refused, true);
    assert.strictEqual(rDet.triggered, false, 'the main engine was never called');
    assert.strictEqual(rDet.failedCheck, 'path');
    assert.match(rDet.reason, /src must not resolve inside the snapshot store/i);
    assert.strictEqual(sha256File(src), before, 'source byte-intact — the manifest append never happened');
    assert.strictEqual(fs.existsSync(out), false, 'no output written');

    // (b) reduceFile FLOOR: src inside snapshotDir, outPath OUTSIDE it (so the OUTPATH guard passes and the
    //     SRC guard is what fires) → fail-closed, source untouched.
    const store = path.join(dir, 'store'); fs.mkdirSync(store);
    const srcIn = writeNdjson(store, 'manifest.jsonl', CLAUDEISH);
    const beforeIn = sha256File(srcIn);
    const rRed = reduceFile(srcIn, { cutTypes: ['mode'], outPath: path.join(dir, 'r.out.jsonl'), snapshotDir: store });
    assert.strictEqual(rRed.ok, false);
    assert.match(rRed.reason, /src must not resolve inside the snapshot store/i);
    assert.strictEqual(sha256File(srcIn), beforeIn, 'reduceFile never mutated the source');
  } finally { rm(dir); }
});

test('FIX 1 / 8.3 REGRESSION — the src-inside-store belt fires when the store is spelled as a win32 SHORT NAME (mixed realpath variants used to make it silently miss)', (t) => {
  if (process.platform !== 'win32') { t.skip('8.3 is a win32 form'); return; }
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-83belt-')));
  try {
    const store = path.join(dir, 'SNAPSHOT-STORE-LONGNAME');
    fs.mkdirSync(store, { recursive: true });
    // same idiom as explode.test.mjs R3/TP-3 — an args-array spawnSync mangles the
    // cmd quoting and `%~sI` comes back unexpanded
    const short = execSync(`cmd /c for %I in ("${store}") do @echo %~sI`, { encoding: 'utf8' }).trim();
    if (!short || short === store) { t.skip('8.3 creation disabled on this volume'); return; }

    // src lives INSIDE the store and is deliberately NOT named manifest.jsonl, so the
    // narrower manifest-alias check cannot cover for the belt.
    //
    // THE SHORT SPELLING MUST BE ON THE **SRC** SIDE. The belt is
    // `isContainedIn(realOrNull(src), physicalForCreate(snapshotDir))`: the store side
    // goes through physicalForCreate, which expands either spelling, so handing the
    // store in short proves nothing — both variants agree and the test passes even
    // with the defect restored (verified: it did). Only `src` runs through the helper
    // under test, so only a short-spelled src can tell the variants apart.
    writeNdjson(store, 'victim.jsonl', CLAUDEISH);
    const src = path.join(short, 'victim.jsonl'); // same file, SHORT spelling
    const before = sha256File(src);
    const r = detonate(src, { cutTypes: ['mode'], outPath: path.join(dir, 'out.jsonl'), snapshotDir: store });

    assert.strictEqual(r.ok, false, 'a src inside the snapshot store is refused however the store is spelled');
    assert.strictEqual(r.failedCheck, 'path', 'it is the PATH gate that refuses');
    assert.match(r.reason, /src must not resolve inside the snapshot store/i,
      'the SRC belt is what fires — pre-fix realOrNull used the non-expanding realpathSync, so isContainedIn compared a short spelling against an expanded one, returned false, and this belt was skipped entirely');
    assert.strictEqual(r.triggered, false, 'refused BEFORE the reducer ran (pre-fix the gate fell through and the deeper floor had to catch it)');
    assert.strictEqual(sha256File(src), before, 'source byte-intact');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('CodeQL #23/#24 (js/file-system-race) — gate 1 sizes the read from the FD, not from a path-stat: a stale/again-changed path-stat cannot shrink the census', () => {
  const dir = tmp();
  const realStat = fs.statSync;
  try {
    const src = writeNdjson(dir, 's.jsonl', Array.from({ length: 100 }, (_, i) => ({ type: 'user', i })));
    const trueSize = realStat.call(fs, src).size;
    // Simulate the TOCTOU deterministically: the path-stat reports a file 1/10th the real size,
    // exactly as it would if the file grew between a statSync(path) and the openSync(path).
    // The engine must never see this, because it stats the FD it actually reads.
    fs.statSync = function (p, ...rest) {
      const st = realStat.call(fs, p, ...rest);
      if (String(p) === src && !rest.length) { try { Object.defineProperty(st, 'size', { value: Math.floor(trueSize / 10) }); } catch { /* frozen stat — leave it */ } }
      return st;
    };
    const r = survey(src);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.totalUnits, 100,
      'the whole file is censused. Pre-fix gate 1 did statSync(path) then openSync(path) and sized the read from the PATH stat, so a stale size silently truncated the census to 10/100 — and the census is what the agent reads to choose cutTypes, so an undercount understates a content-bearing type on the destructive decision path');
  } finally { fs.statSync = realStat; rm(dir); }
});

test('RUNG5 A2 PARSER PARITY — the census reads a line through the REDUCER\'s lineText: a BOM-prefixed unit counts as unparsed, and is never advertised as cuttable', () => {
  const dir = tmp();
  try {
    const objs = Array.from({ length: 40 }, (_, i) => ({ type: 'user', i }));
    const src = writeNdjson(dir, 's.jsonl', objs);
    // splice a U+FEFF-prefixed unit in: JS `.trim()` treats a BOM as whitespace, the reducer's
    // lineText does not. Enough good lines around it that discovery still classifies ndjson.
    const lines = fs.readFileSync(src, 'utf8').split('\n').filter(Boolean);
    lines.splice(20, 0, '﻿' + JSON.stringify({ type: 'mode', i: 'BOMMED' }));
    fs.writeFileSync(src, lines.join('\n') + '\n', 'utf8');

    const r = survey(src);
    assert.strictEqual(r.ok, true, 'the file is still ndjson — this is about parity, not discovery');
    assert.strictEqual(r.unitsUnparsed, 1,
      'the BOM unit is COUNTED as unparsed. Pre-fix the census `.trim()`ed before parsing, so it parsed, and unitsUnparsed reported 0 — the honesty counter read zero for a unit the census had silently mis-typed');
    assert.ok(!r.types || !r.types.mode,
      'and it is NOT advertised as a cuttable type: pre-fix the census offered `mode` as 1 cuttable unit while the reducer refused to parse that very line, so an agent acting on the census got a no-op cut');

    // the reducer is the authority; parity means it agrees
    const rr = reduceFile(src, { cutTypes: ['mode'], outPath: path.join(dir, 'o.jsonl'), snapshotDir: path.join(dir, 's') });
    assert.strictEqual(rr.unitsCut || 0, 0, 'the reducer cuts nothing here — which is exactly what the census must now predict');
  } finally { rm(dir); }
});

test('FIX 2 (prototype pollution) — a unit typed as a JS builtin name (__proto__ / constructor) is censused as a real own-key: no vanish, no undercount, no census collapse, no Object.prototype pollution', () => {
  const dir = tmp();
  try {
    // (a) short-content builtin-named types → each appears with the right count; no type vanishes
    const src = writeNdjson(dir, 'a.jsonl', [
      { type: 'mode', v: 'plan' },
      { type: '__proto__', v: 'x' },
      { type: 'constructor', v: 'y' },
      { type: '__proto__', v: 'z' },
      { type: 'hasOwnProperty', v: 'w' },
    ]);
    const r = survey(src);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.types['__proto__'].unitCount, 2, '__proto__ is a real OWN-key with the right count (not Object.prototype)');
    assert.strictEqual(r.types.constructor.unitCount, 1);
    assert.strictEqual(r.types.hasOwnProperty.unitCount, 1);
    assert.strictEqual(r.totalUnits, 5, 'no unit vanished — totalUnits is complete');
    assert.strictEqual(({}).unitCount, undefined, 'Object.prototype was NOT polluted (unitCount)');
    assert.strictEqual(({}).freeFormCount, undefined, 'Object.prototype was NOT polluted (freeFormCount)');

    // (b) a __proto__ unit with >80-char content → the census does NOT collapse (without the fix,
    //     rec.sample.push runs against Object.prototype whose .sample is undefined → throws → refuse('internal')).
    const src2 = writeNdjson(dir, 'b.jsonl', [
      { type: '__proto__', data: 'q'.repeat(120) },
      { type: 'user', message: { content: 'hi' } },
    ]);
    const r2 = survey(src2);
    assert.strictEqual(r2.ok, true, 'no internal collapse — the >80-char __proto__ unit did not throw');
    assert.strictEqual(r2.types['__proto__'].unitCount, 1, 'the free-form __proto__ unit is counted');
    assert.ok(r2.types['__proto__'].freeFormCount > 0, 'its free-form content is flagged, on a real own-key');
    assert.strictEqual(r2.types.user.unitCount, 1, 'the type AFTER the __proto__ unit is still present');
  } finally { rm(dir); }
});

test('FIX 3 (giant-unit census truncation) — a >16MB single unit BETWEEN two normal units is STEPPED OVER: the type after it is still censused; FIX 7-R2 now NAMES the giant\'s recovered type (content still not classified), never a silent tail-loss', () => {
  const dir = tmp();
  try {
    // one unit larger than the 16MB per-wave carry bound, wedged between two normal units. It must exceed
    // the bound by MORE than one CHUNK (1MiB) so scanWave's carry hits >= maxBytes a full chunk BEFORE it
    // reads the line's terminating newline (else the newline lands in the same chunk that crosses 16MB and
    // the line gets emitted, not overlonged) → 20MB gives a clean 4MiB margin.
    const giant = { type: 'giant', data: 'x'.repeat(20 * 1024 * 1024) };
    const src = writeNdjson(dir, 'big.jsonl', [{ type: 'before', v: 1 }, giant, { type: 'after', v: 2 }]);
    assert.ok(fs.statSync(src).size > 16 * 1024 * 1024, 'fixture holds a >16MB unit');
    const r = survey(src);
    assert.strictEqual(r.ok, true);
    assert.ok(r.types.before, 'the type BEFORE the giant unit is censused');
    assert.ok(r.types.after, 'the type AFTER the giant unit is STILL censused (was silently truncated before the fix)');
    // FIX 7-R2 recovers the giant's TYPE token via a bounded front-read, so the type is NAMED — but its CONTENT
    // is still never classified (unitCount 0, never buffered). FIX META (WAVE-9): the giant ALSO counts toward
    // the complete oversizedSkipped total (was 0 pre-fix — it vanished from any totalUnits+unitsUnparsed+
    // oversizedSkipped reconcile), with the per-type oversizedCount as the finer breakdown.
    assert.ok(r.types.giant, 'the giant\'s TYPE is NAMED (FIX 7-R2 front-read) — no longer silently absent from the census');
    assert.strictEqual(r.types.giant.unitCount, 0, 'its CONTENT is NOT classified (the giant is never buffered)');
    assert.strictEqual(r.types.giant.oversizedCount, 1, 'named via oversizedCount — the finer per-type breakdown');
    assert.strictEqual(r.oversizedSkipped, 1, 'FIX META: the over-budget unit counts toward the COMPLETE oversized total (pre-fix: 0 — it vanished from the reconcile)');
    assert.strictEqual(r.totalUnits, 2, 'only the two normal units are content-classified (the giant is not counted in totalUnits)');
    assert.strictEqual(r.totalUnits + r.unitsUnparsed + r.oversizedSkipped, 3, 'every physical unit reconciles: 2 normal + 0 unparsed + 1 oversized = 3');
  } finally { rm(dir); }
});

test('FIX 4 (never-throws) — a throwing getter on opts (detonate) / opts (survey), read BEFORE the fd try, returns refuse(internal) and NEVER throws out of the function', () => {
  const dir = tmp();
  try {
    const src = writeNdjson(dir, 'a.jsonl', CLAUDEISH);

    let rDet, threwDet = false;
    try { rDet = detonate(src, {}, { get storeRoot() { throw new Error('boom'); } }); }
    catch { threwDet = true; }
    assert.strictEqual(threwDet, false, 'detonate did NOT throw — the hostile getter was caught');
    assert.strictEqual(rDet.ok, false);
    assert.strictEqual(rDet.refused, true);
    assert.strictEqual(rDet.failedCheck, 'internal');

    let rSur, threwSur = false;
    try { rSur = survey(src, { get typeField() { throw new Error('boom2'); } }); }
    catch { threwSur = true; }
    assert.strictEqual(threwSur, false, 'survey did NOT throw — the hostile getter was caught');
    assert.strictEqual(rSur.ok, false);
    assert.strictEqual(rSur.refused, true);
    assert.strictEqual(rSur.failedCheck, 'internal');
  } finally { rm(dir); }
});

test('FIX 5 (fake-0 depth calibration) — WALK_DEPTH 18 REACHES ore that WALK_DEPTH 12 missed, and STILL misses ore past 18 (floor-not-ceiling: the cap MOVES the boundary, it never removes the miss — Rice)', () => {
  const dir = tmp();
  try {
    // wrap a 200-char ore string in `d` nested containers → the ore-bearing object sits at depth (1 + d)
    const nest = (d) => { let x = { note: 'o'.repeat(200) }; for (let i = 0; i < d; i++) x = { nest: x }; return x; };

    // caught: ore-object at depth 14 — past the OLD 12 cap (was fake-0), within the new 18
    const rIn = survey(writeNdjson(dir, 'in.jsonl', [{ type: 'mode', body: nest(13) }]));
    assert.strictEqual(rIn.ok, true);
    assert.ok(rIn.types.mode.freeFormCount >= 1, 'ore at depth ~14 is now REACHED by WALK_DEPTH=18 (was missed at 12)');

    // still missed: ore-object at depth 26 — past the new 18 cap (the honest-ceiling caveat holds)
    const rOut = survey(writeNdjson(dir, 'out.jsonl', [{ type: 'mode', body: nest(25) }]));
    assert.strictEqual(rOut.ok, true);
    assert.strictEqual(rOut.types.mode.freeFormCount, 0, 'ore past the depth cap is STILL missed — the cap moved the boundary, never removed the miss (Rice)');
  } finally { rm(dir); }
});

// --- IC-PIN FIX ROUND 2 (2nd destruction-ladder wave — wave-1 fixes held EXCEPT FIX 1) -----------------

test('FIX 1-R2 (source-sacred, hardlink-alias) — a <snapshotDir>/manifest.jsonl HARDLINKED to a src OUTSIDE snapshotDir is REFUSED at both layers (detonate belt + reduceFile floor); the source is byte-intact (the manifest append never fires)', (t) => {
  const dir = tmp();
  try {
    // src lives OUTSIDE snapshotDir, so the FIX 1 PATH-containment guard passes — only the ALIAS guard can
    // catch the manifest.jsonl hardlink that points back at src (the variant wave-1's path-guard missed).
    const src = writeNdjson(dir, 'src.jsonl', CLAUDEISH);
    const snap = path.join(dir, 'snap'); fs.mkdirSync(snap);
    const manifestLink = path.join(snap, 'manifest.jsonl');
    try { fs.linkSync(src, manifestLink); } catch (e) { t.skip(`hardlink unavailable (${e.code})`); return; }
    const before = sha256File(src);

    // (a) detonate belt: refuse BEFORE triggering (triggered:false), source untouched
    const rDet = detonate(src, { cutTypes: ['mode'], outPath: path.join(dir, 'out.jsonl'), snapshotDir: snap });
    assert.strictEqual(rDet.ok, false);
    assert.strictEqual(rDet.refused, true);
    assert.strictEqual(rDet.triggered, false, 'the main engine was never called');
    assert.strictEqual(rDet.failedCheck, 'path');
    assert.match(rDet.reason, /aliases the source|hardlink/i);
    assert.strictEqual(fs.existsSync(path.join(dir, 'out.jsonl')), false, 'no output written');

    // (b) reduceFile floor: the same alias guard fires at the low level, fail-closed
    const rRed = reduceFile(src, { cutTypes: ['mode'], outPath: path.join(dir, 'r.out.jsonl'), snapshotDir: snap });
    assert.strictEqual(rRed.ok, false);
    assert.match(rRed.reason, /aliases the source|hardlink/i);

    assert.strictEqual(sha256File(src), before, 'source byte-intact — the manifest append (which would follow the hardlink INTO src) never happened');
  } finally { rm(dir); }
});

test('FIX 2-R2 (explicit [] ≠ omitted) — cutTypes:[] REFUSES at the cutlist gate (cut NOTHING, no output), while an OMITTED cutTypes still applies the factory default: the two now DIFFER', () => {
  const dir = tmp();
  try {
    const src = writeNdjson(dir, 'a.jsonl', CLAUDEISH);
    const before = sha256File(src);

    // explicit [] = "cut nothing" (the programmatic caller decided nothing is cuttable) → refuse, no output
    const out1 = path.join(dir, 'o1.jsonl');
    const rEmpty = detonate(src, { cutTypes: [], outPath: out1, snapshotDir: path.join(dir, 's1') });
    assert.strictEqual(rEmpty.ok, false);
    assert.strictEqual(rEmpty.refused, true);
    assert.strictEqual(rEmpty.failedCheck, 'cutlist', 'explicit [] is refused, never conflated with the default');
    assert.deepStrictEqual(rEmpty.cut, [], 'nothing cut');
    assert.strictEqual(fs.existsSync(out1), false, 'no output written — the reducer was never triggered');
    assert.strictEqual(sha256File(src), before, 'source untouched');

    // OMITTED cutTypes = "no preference" → the convenience default STILL applies (unchanged behaviour)
    const out2 = path.join(dir, 'o2.jsonl');
    const rOmit = detonate(src, { outPath: out2, snapshotDir: path.join(dir, 's2') });
    assert.strictEqual(rOmit.ok, true);
    assert.strictEqual(rOmit.triggered, true, 'an omitted cutTypes still applies the factory default');
    assert.deepStrictEqual([...rOmit.cut].sort(), [...CLAUDE_DEFAULT_CUT_TYPES].sort(), 'the 2 default UI-state types are cut (A4-rescoped pair)');

    assert.notStrictEqual(rEmpty.ok, rOmit.ok, 'explicit [] and omitted now DIFFER (was conflated before FIX 2-R2)');
  } finally { rm(dir); }
});

test('FIX 3-R2 (aggregate redaction leak) — an AGGREGATE-flagged unit (many short strings, none >80B, sum >1024B) redacts to STRUCTURE + a «free-form» marker, never a WALL of raw prose: a planted ore run is absent from the sample', () => {
  const dir = tmp();
  try {
    // 50 strings of 25 bytes each = 1250B (> the 1024 aggregate bound) with NONE > the 80-byte single-string
    // bound → the unit is flagged ONLY by the aggregate signal. A distinctive ore run is planted deep (#20).
    const parts = Array.from({ length: 50 }, (_, i) => (`seg${i}-`).padEnd(25, 'y'));
    parts[20] = 'PLANTED_ORE_XYZ'.padEnd(25, 'z');
    const src = writeNdjson(dir, 'a.jsonl', [{ type: 'mode', parts }]);
    const r = survey(src);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.types.mode.unitCount, 1);
    assert.strictEqual(r.types.mode.freeFormCount, 1, 'flagged by the aggregate signal (no single string is long)');
    const sample = r.types.mode.sample[0];
    assert.ok(sample.length <= 200, 'the sample stays length-capped');
    assert.match(sample, /free-form/, 'FIX 3-R2: the redaction collapses within the sample (impossible pre-fix — no single string is >80, so no collapse would occur without the aggregate budget)');
    assert.ok(!/PLANTED_ORE_XYZ/.test(sample), 'the planted ore run is NOT dumped into the sample');
    assert.ok(!/PLANTED_ORE_XYZ/.test(JSON.stringify(r.types)), 'and nowhere else in the census either');
  } finally { rm(dir); }
});

test('FIX 4-R2 (byte-aware single-string signal) — a non-ASCII string of ~40 chars / ~120 bytes is now FLAGGED by signal (a) (byte budget), while a short ASCII and a short non-ASCII string stay UN-flagged (the boundary holds both ways)', () => {
  const dir = tmp();
  try {
    // Thai (3 bytes/char): 40 chars = 120 bytes → String.length 40 (< the 80 char boundary the OLD (a) used,
    // so it was MISSED) but byteLength 120 (> the 80-byte budget the NEW (a) uses → caught). A single string,
    // so the aggregate signal (b) (>1024B) does NOT fire — ONLY the byte-aware (a) catches it.
    const thai40 = 'ก'.repeat(40); // 40 chars, 120 bytes
    const thai20 = 'ก'.repeat(20); // 20 chars, 60 bytes (< 80 bytes → must stay un-flagged)
    const ascii20 = 'x'.repeat(20); // 20 chars, 20 bytes (< 80 bytes → must stay un-flagged)
    const src = writeNdjson(dir, 'a.jsonl', [
      { type: 'mode', note: thai40 },
      { type: 'last-prompt', prompt: thai20 },
      { type: 'queue-operation', op: ascii20 },
    ]);
    const r = survey(src);
    assert.strictEqual(r.ok, true);
    assert.ok(r.types.mode.freeFormCount >= 1, 'FIX 4-R2: a 40-char/120-byte non-ASCII string is caught by the BYTE-aware (a) (a char-length (a) missed it)');
    assert.strictEqual(r.types['last-prompt'].freeFormCount, 0, 'a 20-char/60-byte non-ASCII string stays UN-flagged (byte budget not over-triggering short multibyte)');
    assert.strictEqual(r.types['queue-operation'].freeFormCount, 0, 'a 20-byte ASCII string stays UN-flagged (the boundary holds the other way too)');
  } finally { rm(dir); }
});

test('FIX 5-R2 (gate-4 belt symmetry) — a detonate outPath resolving INSIDE the snapshot store is REFUSED at the belt (failedCheck path), no mutation', () => {
  const dir = tmp();
  try {
    const src = writeNdjson(dir, 'a.jsonl', CLAUDEISH); // OUTSIDE snapshotDir, no manifest alias
    const before = sha256File(src);
    const snap = path.join(dir, 'snap'); fs.mkdirSync(snap);
    const insideOut = path.join(snap, 'out.jsonl'); // an outPath INSIDE the snapshot store → belt refuses
    const r = detonate(src, { cutTypes: ['mode'], outPath: insideOut, snapshotDir: snap });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.refused, true);
    assert.strictEqual(r.triggered, false);
    assert.strictEqual(r.failedCheck, 'path');
    assert.match(r.reason, /outPath must not resolve inside the snapshot store/i);
    assert.strictEqual(fs.existsSync(insideOut), false, 'no output written');
    assert.strictEqual(sha256File(src), before, 'source untouched');
  } finally { rm(dir); }
});

// FIX 6-R2 is a doc-only comment correction in explode.mjs (reduceFile's over-claiming resume-validation
// header) — no runtime behaviour changes, so no test; verified by the comment edit itself.

test('FIX 7-R2 (oversized-type name recovery) — a >20MB unit whose type appears NOWHERE else is NAMED in the census via a bounded front-read (unitCount 0, oversizedCount 1); the surrounding normal types are still counted', () => {
  const dir = tmp();
  try {
    // a >16MB (per-wave-budget) unit whose type "giant-only-type" lives ONLY here (20MB for a clean overlong
    // margin, same reasoning as the FIX 3 test). Its content is never buffered/classified, but its TYPE token
    // sits at the object front → recoverable by a bounded 4KB front-read.
    const giant = { type: 'giant-only-type', data: 'x'.repeat(20 * 1024 * 1024) };
    const src = writeNdjson(dir, 'big.jsonl', [{ type: 'norm-before', v: 1 }, giant, { type: 'norm-after', v: 2 }]);
    assert.ok(fs.statSync(src).size > 16 * 1024 * 1024, 'fixture holds a >16MB unit');
    const r = survey(src);
    assert.strictEqual(r.ok, true);
    assert.ok(r.types['giant-only-type'], 'the oversized-only type APPEARS in the census (front-read recovery) — not silently absent');
    assert.strictEqual(r.types['giant-only-type'].unitCount, 0, 'its CONTENT is not classified (never buffered)');
    assert.strictEqual(r.types['giant-only-type'].oversizedCount, 1, 'named via oversizedCount — the census gap is honest');
    assert.ok(r.types['norm-before'] && r.types['norm-after'], 'the surrounding normal types are STILL counted');
    assert.strictEqual(r.totalUnits, 2, 'only the two normal units contribute to totalUnits (the giant is not content-classified)');
  } finally { rm(dir); }
});

// --- IC-PIN FIX ROUND 3 (3rd destruction-ladder wave — SYSTEMIC/root fixes) ---------------------------

test('FIX 3-R3 (census↔cutter honesty) — a >maxBytes MID-file unit makes the reducer SKIP the whole file; detonate reports skipped:true with cut:[] (never vouching un-cut types), the REAL snapshotPath (not null), and NO phantom outPath; the source is intact', () => {
  const dir = tmp();
  try {
    // ndjson: a small 'before' unit, a 3MB single unit (> the 1MiB maxBytes floor by MORE than one CHUNK, so
    // scanWave's carry crosses >= maxBytes a full chunk BEFORE the giant's terminating newline → a genuine
    // mid-file overlong in the cutter), then a small 'after'. Discovery samples 'before' (parses) → ndjson (the
    // parse-rate check precedes overlong), so gate 2 passes; the report (16MB bound) counts all types.
    // maxBytes = CHUNK (1MiB) is the detonate FLOOR (L4): a sub-chunk budget is now refused at gate 5, so the
    // oversized-skip scenario is exercised at the smallest LEGAL budget with a unit that genuinely exceeds it.
    const src = writeNdjson(dir, 'big.jsonl', [{ type: 'before', v: 1 }, { type: 'giant', data: 'x'.repeat(3 * 1024 * 1024) }, { type: 'after', v: 2 }]);
    const before = sha256File(src);
    const out = path.join(dir, 'out.jsonl');
    const snap = path.join(dir, 'snap');
    const r = detonate(src, { cutTypes: ['before', 'after'], outPath: out, snapshotDir: snap, maxBytes: 1024 * 1024 });
    assert.strictEqual(r.ok, true, 'a skip is ok:true (source untouched), not a failure');
    assert.strictEqual(r.triggered, true, 'the reducer WAS invoked (all gates passed)');
    assert.strictEqual(r.skipped, true, 'the reducer SKIPPED the whole file (a >maxBytes mid-file unit bailed it)');
    assert.deepStrictEqual(r.cut, [], 'FIX 3-R3: cut does NOT vouch for the requested types — NONE were actually cut (pre-fix cut listed before+after)');
    assert.ok(r.report.perType.before, 'the census still SAW before (the report ran at the 16MB bound)');
    assert.ok(r.snapshotPath, 'the REAL snapshotPath is surfaced — a rail-5 snapshot IS on disk (pre-fix it was null)');
    assert.ok(fs.existsSync(r.snapshotPath), 'and it exists');
    assert.strictEqual(r.outPath, null, 'NO phantom outPath — nothing was written (pre-fix it echoed the never-written path)');
    assert.strictEqual(fs.existsSync(out), false, 'the slim copy was never written');
    assert.strictEqual(sha256File(src), before, 'source byte-intact');
  } finally { rm(dir); }
});

test('L4 (WAVE-6): detonate REFUSES a sub-floor per-wave budget (the re-read-explosion hang) — maxBytes < CHUNK / maxLines < the factory line budget are rejected at gate 5; the safe defaults + at-floor values still execute', () => {
  const dir = tmp();
  try {
    const src = writeNdjson(dir, 'a.jsonl', CLAUDEISH);
    const base = { cutTypes: ['mode'], outPath: path.join(dir, 'o.jsonl'), snapshotDir: path.join(dir, 's') };
    // the exact values the WAVE-6 red-team HUNG on (a real user passing a small cap): each forces the wave to
    // consume << one CHUNK, so the next wave re-reads the chunk tail → O(waves × CHUNK) on a large file. Refused
    // at the gate (pre-fix `>= 1` let them through, then the reduce hung).
    for (const bad of [{ maxBytes: 1.5 }, { maxBytes: 1000 }, { maxBytes: 512 * 1024 }, { maxLines: 2 }, { maxLines: 10 }, { maxLines: 1000 }]) {
      const r = detonate(src, { ...base, ...bad });
      assert.strictEqual(r.ok, false, `${JSON.stringify(bad)} must refuse (sub-floor per-wave budget)`);
      assert.strictEqual(r.failedCheck, 'params');
    }
    // the DEFAULT (no budget) and AT-floor values (1 CHUNK / 20000 lines) still execute
    const rDefault = detonate(src, { ...base, outPath: path.join(dir, 'od.jsonl'), snapshotDir: path.join(dir, 'sd') });
    assert.strictEqual(rDefault.ok, true, 'omitting the budget uses the safe factory defaults');
    const rFloor = detonate(src, { ...base, outPath: path.join(dir, 'of.jsonl'), snapshotDir: path.join(dir, 'sf'), maxBytes: 1024 * 1024, maxLines: 20000 });
    assert.strictEqual(rFloor.ok, true, 'at-floor budgets are accepted');
  } finally { rm(dir); }
});

test('L4-secondary (WAVE-6): a detonate whose requested cut-types are ALL ABSENT is REFUSED — no wasted snapshot + full-rewrite no-op; a dry-run of the same request still reports normally', () => {
  const dir = tmp();
  try {
    const src = writeNdjson(dir, 'a.jsonl', CLAUDEISH);
    const before = sha256File(src);
    const out = path.join(dir, 'o.jsonl');
    const snap = path.join(dir, 's');
    // neither type is in the file → cut would be [] → executing = a byte-identical no-op copy (wasted ~2× I/O).
    const r = detonate(src, { cutTypes: ['nosuchtype', 'alsomissing'], outPath: out, snapshotDir: snap });
    assert.strictEqual(r.ok, false, 'nothing to cut → refused (pre-fix: triggered:true, cut:[], a full no-op rewrite)');
    assert.strictEqual(r.failedCheck, 'cutlist');
    assert.ok(r.report, 'the census is returned so the caller sees the requested types are absent');
    assert.strictEqual(fs.existsSync(out), false, 'no output written');
    assert.strictEqual(fs.existsSync(snap), false, 'no snapshot taken — the destructive path never ran');
    assert.strictEqual(sha256File(src), before, 'source untouched');
    // execute-only: a dry-run (no outPath) of the same request is still a normal report, never a refusal
    const dry = detonate(src, { cutTypes: ['nosuchtype'], snapshotDir: snap });
    assert.strictEqual(dry.ok, true, 'a dry-run reports normally — the wasted-work refuse is execute-only');
    assert.strictEqual(dry.triggered, false);
  } finally { rm(dir); }
});

test('FIX 4-R3 (redact byte-parity) — a unit whose SOLE content is a non-ASCII string of 30 chars / 90 bytes (FLAGGED via the byte-aware signal) is COLLAPSED in the census sample to «free-form …», never dumped raw (pre-fix the char-length collapse left the 90-byte Thai string verbatim)', () => {
  const dir = tmp();
  try {
    // 'ก' = U+0E01 = 3 UTF-8 bytes. 30 chars = 90 bytes: OVER the 80-BYTE flag boundary (isFreeFormBearing
    // flags it) but UNDER the 80-CHAR boundary redactUnit used pre-fix (so it was NOT collapsed → dumped raw).
    const thai90 = 'ก'.repeat(30);
    const src = writeNdjson(dir, 'a.jsonl', [{ type: 'mode', note: thai90 }]);
    const r = survey(src);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.types.mode.unitCount, 1);
    assert.ok(r.types.mode.freeFormCount >= 1, 'the 90-byte non-ASCII string IS flagged (byte-aware signal)');
    const sample = r.types.mode.sample[0];
    assert.match(sample, /free-form/, 'FIX 4-R3: the flagged non-ASCII string is COLLAPSED in the sample (byte-parity with the flag)');
    assert.ok(!sample.includes(thai90), 'the raw Thai string is NOT dumped into the sample');
    assert.ok(!/ก/.test(JSON.stringify(r.types)), 'and no raw Thai byte appears anywhere in the census');
  } finally { rm(dir); }
});

// --- WAVE-5 IC-pin — the CLASS: a validation branch that fails OPEN (routes malformed input to a
//     destructive default), and a cap that under-reports with NO compensating signal ---------------------

test('L4#1 (WAVE-5 gate-bypass) — a NON-ARRAY cutTypes (null / {} / a bare string / a number) is REFUSED at the cutlist gate, NEVER silently substituted with the destructive factory default and EXECUTED; only an OMITTED cutTypes defaults', () => {
  const dir = tmp();
  try {
    const src = writeNdjson(dir, 'a.jsonl', CLAUDEISH);
    const before = sha256File(src);
    for (const [i, bad] of [null, {}, 'mode', 42, true].entries()) {
      const out = path.join(dir, `o-${i}.jsonl`);
      const r = detonate(src, { cutTypes: bad, outPath: out, snapshotDir: path.join(dir, `s-${i}`) });
      assert.strictEqual(r.ok, false, `cutTypes=${JSON.stringify(bad)} must refuse (pre-fix: fell to the factory default and cut its categories)`);
      assert.strictEqual(r.refused, true);
      assert.strictEqual(r.failedCheck, 'cutlist');
      assert.strictEqual(r.triggered, false, 'the main engine was NEVER triggered');
      assert.ok(!fs.existsSync(out), 'nothing was written');
    }
    assert.strictEqual(sha256File(src), before, 'source byte-intact throughout');
    // control: an OMITTED cutTypes STILL applies the convenience factory default (the distinction is preserved)
    const outDef = path.join(dir, 'def.jsonl');
    const rDef = detonate(src, { outPath: outDef, snapshotDir: path.join(dir, 'sdef') });
    assert.strictEqual(rDef.ok, true, 'an OMITTED cutTypes still defaults (convenience preserved — only undefined defaults)');
    assert.strictEqual(rDef.triggered, true);
    assert.deepStrictEqual([...rDef.cut].sort(), [...CLAUDE_DEFAULT_CUT_TYPES].sort(), 'the factory default was applied on omission');
  } finally { rm(dir); }
});

test('L6 (WAVE-5 survey fake-0) — a unit whose only structure is PAST the depth cap reports freeFormCount 0 WITH a compensating depthCappedCount signal (never a silent lie); a shallow unit carries NO such signal (no false alarm)', () => {
  const dir = tmp();
  try {
    const nest = (d) => { let x = { note: 'o'.repeat(200) }; for (let i = 0; i < d; i++) x = { nest: x }; return x; };
    // ore-object at depth ~26 — PAST WALK_DEPTH=18: the walk is truncated, freeFormCount stays 0 (Rice), but the
    // TRUNCATION must be SIGNALLED so the agent does not read the 0 as proof-of-content-free and delete real content.
    const rCapped = survey(writeNdjson(dir, 'deep.jsonl', [{ type: 'mode', body: nest(25) }]));
    assert.strictEqual(rCapped.ok, true);
    assert.strictEqual(rCapped.types.mode.freeFormCount, 0, 'ore past the cap is still missed (floor-not-ceiling — the cap moves, never removes, the miss)');
    assert.ok(rCapped.types.mode.depthCappedCount >= 1, 'BUT the truncated walk is SIGNALLED (pre-fix: silently absent → the 0 was an undetectable lie)');
    // control 1: a shallow content-free unit → 0 free-form AND NO depthCapped signal (the signal fires ONLY on a real truncation)
    const rShallow = survey(writeNdjson(dir, 'flat.jsonl', [{ type: 'mode', v: 'plan' }]));
    assert.strictEqual(rShallow.types.mode.freeFormCount, 0);
    assert.strictEqual(rShallow.types.mode.depthCappedCount, undefined, 'a fully-inspected content-free unit carries no false depth-cap signal');
    // control 2: a shallow ore unit → flagged, and no depthCapped noise (ore found before any cap)
    const rOre = survey(writeNdjson(dir, 'ore.jsonl', [{ type: 'user', message: { content: 'x'.repeat(200) } }]));
    assert.ok(rOre.types.user.freeFormCount >= 1);
    assert.strictEqual(rOre.types.user.depthCappedCount, undefined, 'a flagged unit needs no depth-cap signal (the cap was never the deciding factor)');
  } finally { rm(dir); }
});

// --- WAVE-7 META (BREAK 4): the census carries a compensating signal for unparseable BODY content ---------

test('WAVE-7 META (BREAK 4) — survey + detonate.report SURFACE unparseable BODY units (unitsUnparsed): a clean front sample can no longer hide unparseable content behind a "totalUnits N" that silently omits it (the fake-0 class)', () => {
  const dir = tmp();
  try {
    // 100 clean typed lines (the front sample sees ndjson) THEN 5000 unparseable real-content lines AFTER it —
    // past the discovery sample, so gate 2 accepts ndjson and the census pass meets them.
    const lines = [];
    for (let i = 0; i < 100; i++) lines.push(JSON.stringify({ type: 'user', i }));
    for (let i = 0; i < 5000; i++) lines.push(`this is real unparseable body content line ${i} — not JSON at all`);
    const src = path.join(dir, 'mixed.jsonl');
    fs.writeFileSync(src, Buffer.from(lines.join('\n') + '\n', 'utf8'));
    // survey: totalUnits counts the 100 parseable; unitsUnparsed SURFACES the 5000 (pre-fix: silently dropped)
    const s = survey(src);
    assert.strictEqual(s.ok, true);
    assert.strictEqual(s.structure, 'ndjson', 'the clean front sample classified ndjson');
    assert.strictEqual(s.totalUnits, 100, 'the 100 typed units are censused');
    assert.strictEqual(s.unitsUnparsed, 5000, 'the 5000 unparseable BODY lines are SURFACED, not silently omitted (fake-0 class closed)');
    // reduceFile's own accounting agrees (the signal source the census now carries)
    const rf = reduceFile(src, { cutTypes: ['ghost'] }); // dry-run measure
    assert.strictEqual(rf.unitsUnparsed, 5000, 'reduceFile computes the same count the census now surfaces');
    // detonate().report carries it too (dry-run)
    const d = detonate(src, { cutTypes: ['user'], snapshotDir: path.join(dir, 's') });
    assert.strictEqual(d.report.unitsUnparsed, 5000, 'detonate().report carries the unaccounted-body signal');
    // a fully-clean census surfaces zero (no false signal)
    const clean = writeNdjson(dir, 'clean.jsonl', CLAUDEISH);
    assert.strictEqual(survey(clean).unitsUnparsed, 0, 'a fully-parseable census reports unitsUnparsed 0');
  } finally { rm(dir); }
});

test('WAVE-9 META (census reconcile): an over-budget VALID cut-type unit is counted in oversizedSkipped (the COMPLETE oversized total) in BOTH survey and detonate.report — pre-fix a typed-recovered oversized read oversizedSkipped:0 and VANISHED from the totalUnits+unitsUnparsed+oversizedSkipped reconcile', () => {
  const dir = tmp();
  try {
    // a >16MB (per-wave-budget) 'mode' unit among small keepers — a VALID cut-type the REDUCE path fail-
    // closed-skips-and-reports; the census must not silently drop it. 20MB for a clean overlong margin.
    const big = { type: 'mode', pad: 'p'.repeat(20 * 1024 * 1024) };
    const src = writeNdjson(dir, 'over.jsonl', [{ type: 'user', m: 'HEAD' }, big, { type: 'user', m: 'TAIL' }]);
    assert.ok(fs.statSync(src).size > 16 * 1024 * 1024, 'fixture holds a >16MB unit');
    // survey (wantSet=null): every physical unit reconciles
    const sv = survey(src);
    assert.strictEqual(sv.ok, true);
    assert.strictEqual(sv.oversizedSkipped, 1, 'the over-budget mode unit counts toward the COMPLETE oversized total (pre-fix: 0 — vanished)');
    assert.strictEqual(sv.types.mode.oversizedCount, 1, 'named by type in the finer per-type breakdown (unitCount 0 — content never buffered)');
    assert.strictEqual(sv.types.mode.unitCount, 0, 'the oversized mode unit is NOT content-classified');
    assert.strictEqual(sv.totalUnits + sv.unitsUnparsed + sv.oversizedSkipped, 3, 'every physical unit reconciles: 2 user + 0 unparsed + 1 oversized = 3');
    // detonate.report (wantSet=Set(['mode'])): the requested oversized type also counts in oversizedSkipped
    const d = detonate(src, { cutTypes: ['mode'], snapshotDir: path.join(dir, 's') }); // dry-run
    assert.strictEqual(d.report.oversizedSkipped, 1, 'detonate.report also surfaces the requested over-budget unit in oversizedSkipped (pre-fix: 0)');
    assert.strictEqual(d.report.perType.mode.oversizedCount, 1, 'per-type oversizedCount names it in detonate mode too');
  } finally { rm(dir); }
});

test('type-cardinality cap: a unique-type-per-line flood bounds perType to TYPE_CENSUS_MAX (O(cap) memory, not O(N)) — overflow units stay ACCOUNTED (typesTruncated + otherTypesUnits, totalUnits complete, reconcile holds); a normal file is byte-identical (no flag); detonate.report (wantSet) is untouched', () => {
  const dir = tmp();
  try {
    // (a) ADVERSARIAL: every line a UNIQUE `type` → without the cap perType is O(distinct-types)=O(N) (the
    //     confirmed self-OOM: a 42MB unique-type flood measured ~449MB peak). The cap bounds it to O(cap).
    const overflow = 250;
    const flood = TYPE_CENSUS_MAX + overflow;
    const floodObjs = [];
    for (let i = 0; i < flood; i++) floodObjs.push({ type: 't' + i, i });
    const src = writeNdjson(dir, 'flood.jsonl', floodObjs);
    const s = survey(src);
    assert.strictEqual(s.ok, true);
    assert.strictEqual(s.structure, 'ndjson');
    assert.ok(Object.keys(s.types).length <= TYPE_CENSUS_MAX, 'perType is BOUNDED to the cap — memory O(cap), not O(distinct-types)');
    assert.strictEqual(Object.keys(s.types).length, TYPE_CENSUS_MAX, 'the flood fills exactly TYPE_CENSUS_MAX named slots, then stops allocating');
    assert.strictEqual(s.typesTruncated, true, 'the census SIGNALS it was bounded (never a silent truncation)');
    assert.strictEqual(s.otherTypesUnits, overflow, 'the units under un-named (overflow) types are counted in aggregate');
    assert.strictEqual(s.totalUnits, flood, 'totalUnits stays COMPLETE — every parsed unit accounted (named + overflow), no undercount');
    assert.strictEqual(s.totalUnits + s.unitsUnparsed + s.oversizedSkipped, flood, 'the physical-unit reconcile holds through the cap');
    assert.strictEqual(s.types.t0.unitCount, 1, 'a named type still carries its real count');

    // (b) NO-REGRESSION: a normal few-type file → IDENTICAL shape, NO truncation fields present.
    const normal = writeNdjson(dir, 'normal.jsonl', CLAUDEISH);
    const n = survey(normal);
    assert.strictEqual(n.ok, true);
    assert.strictEqual(n.totalUnits, CLAUDEISH.length, 'every unit censused');
    assert.strictEqual(n.typesTruncated, undefined, 'a normal file carries NO truncation flag (shape identical to pre-cap)');
    assert.strictEqual(n.otherTypesUnits, undefined, 'and no otherTypesUnits field');
    const distinctNormal = new Set(CLAUDEISH.map((o) => o.type)).size;
    assert.strictEqual(Object.keys(n.types).length, distinctNormal, 'all its distinct types are named, none dropped');

    // (c) detonate's requested-types path (wantSet a Set) is UNTOUCHED — bounded by |cutTypes|, not the file's
    //     cardinality. Run over the SAME flood file: the report holds only the requested type, never truncates.
    const d = detonate(src, { cutTypes: ['t0'], snapshotDir: path.join(dir, 's') }); // dry-run (no outPath)
    assert.strictEqual(d.report.typesTruncated, false, 'detonate.report never truncates — the cap gate is a no-op on the wantSet path');
    assert.strictEqual(Object.keys(d.report.perType).length, 1, 'the report holds ONLY the requested type — bounded by |cutTypes|, independent of file cardinality');
    assert.strictEqual(d.report.otherTypesUnits, 0, 'no overflow on the bounded path');
  } finally { rm(dir); }
});

test('BUG-1 breadth cap: a fat-breadth unit (huge array of short strings) redacts to a BOUNDED, capped sample that STILL flags the free-form content; a normal unit is unaffected (no breadth marker, redacted as before)', () => {
  const dir = tmp();
  try {
    // A tool_result with a 200k-element array of short strings — the realistic dir-listing / grep-output / token-id
    // shape. Pre-fix redactUnit materialized the WHOLE array and JSON.stringify rendered it WHOLE before the
    // 200-char slice → an O(unit) build PEAK and a V8 SlicedString that RETAINED the multi-MB parent in the census.
    const fat = { type: 'tool_result', content: Array.from({ length: 200000 }, (_, i) => 'itm' + (i % 1000)) };
    const src = writeNdjson(dir, 'fat.jsonl', [{ type: 'user', message: 'hi' }, fat]);
    const s = survey(src);
    assert.strictEqual(s.ok, true);
    assert.strictEqual(s.types.tool_result.unitCount, 1);
    assert.ok(s.types.tool_result.freeFormCount >= 1, 'the fat unit is STILL flagged free-form-bearing — the breadth cap bounds the PREVIEW, never the detection (honesty preserved)');
    const sample = s.types.tool_result.sample[0];
    assert.ok(sample.length <= 200, 'the census sample is bounded to SAMPLE_STR_CAP (200) — no O(unit) string lands in the returned census');
    assert.ok(sample.startsWith('{"type":"tool_result"'), 'the sample still shows the redacted STRUCTURE (which field carries the content), not a wall of raw prose');

    // NO-REGRESSION: a small normal unit (well under WALK_BREADTH nodes) redacts EXACTLY as before — the breadth
    // cap is a no-op below the budget, so no spurious "…(N more)" truncation marker appears.
    const small = writeNdjson(dir, 'small.jsonl', [{ type: 'mode', note: 'x'.repeat(200) }]);
    const n = survey(small);
    assert.strictEqual(n.types.mode.sample[0], '{"type":"mode","note":"«free-form 200 chars»"}', 'a normal unit redacts byte-identically to pre-fix (long string collapsed; NO breadth truncation)');
    assert.ok(!n.types.mode.sample[0].includes('more)'), 'no breadth-truncation marker on a normal unit (the cap never fired)');
  } finally { rm(dir); }
});

test('BUG-1 retention: the returned census does NOT retain O(unit) — a fat-breadth unit is redacted to a FLAT, bounded sample so retained heap is filesize-INDEPENDENT (the V8 SlicedString parent is defeated). Runs a --expose-gc child (post-GC heapUsed).', () => {
  const dir = tmp();
  try {
    // Measuring RETAINED heap needs global.gc() → the suite runs without --expose-gc, so spawn a child that has it.
    // The child builds a ~12MB ndjson whose fat unit is UNDER REPORT_MAX_BYTES (classified + sampled), runs survey,
    // GCs, and asserts the census it still HOLDS retains < 8MB. Pre-fix this held ~20-25MB (the SlicedString parent
    // of the multi-MB stringified redaction); post-fix it holds only the flat ≤200-char sample (~KB).
    const detonateUrl = JSON.stringify(new URL('./detonate.mjs', import.meta.url).href);
    const dirUrl = JSON.stringify(dir.replace(/\\/g, '/'));
    const child = [
      `import { survey } from ${detonateUrl};`,
      `import fs from 'node:fs'; import path from 'node:path';`,
      `const dir = ${dirUrl};`,
      // build in a function so the transient source array is GC'd before the baseline is taken
      `function build(){ const a = new Array(1200000); for (let i=0;i<a.length;i++) a[i] = 'itm'+(i%100000);`,
      `  const fd = fs.openSync(path.join(dir,'big.jsonl'),'w');`,
      `  for (let i=0;i<5;i++) fs.writeSync(fd, JSON.stringify({type:'user',message:'hi'+i})+'\\n');`, // small lines first → passes the ndjson sniff
      `  fs.writeSync(fd, JSON.stringify({type:'tool_result',content:a})+'\\n'); fs.closeSync(fd); }`,
      `build();`,
      `global.gc(); global.gc();`,
      `const base = process.memoryUsage().heapUsed;`,
      `const census = survey(path.join(dir,'big.jsonl'));`,
      `global.gc(); global.gc();`,
      `const retainedMB = (process.memoryUsage().heapUsed - base) / (1<<20);`,
      `if (!census.ok) { console.error('survey refused: '+census.reason); process.exit(3); }`,
      `const s = census.types.tool_result.sample[0] || '';`, // reading census here also keeps it referenced past the measurement
      `if (s.length > 200) { console.error('sample not capped: '+s.length); process.exit(4); }`,
      `if (!(census.types.tool_result.freeFormCount >= 1)) { console.error('fat unit not flagged'); process.exit(5); }`,
      `if (retainedMB > 8) { console.error('census RETAINS O(unit): retainedMB='+retainedMB.toFixed(1)+' (SlicedString parent held)'); process.exit(6); }`,
      `console.log('OK retainedMB='+retainedMB.toFixed(2));`,
    ].join('\n');
    const r = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', child], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `retention-proof child failed (status ${r.status}): ${r.stderr || r.stdout}`);
    assert.match(r.stdout, /OK retainedMB=/, 'the child ran the full measurement');
  } finally { rm(dir); }
});
