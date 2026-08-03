// Hermetic barrage for explode.mjs — the MAIN ULTRA class-A reducer (§19.6).
// Everything runs in-process on byte-exact tmp fixtures (no live store, no
// network). The load-bearing assertions: explode-accurate on structured input ·
// fail-closed on unverifiable · snapshot byte-exact · recovery restores · ZERO
// corruption of kept units (survivor bytes are reproduced verbatim, terminators
// and all) · the wave loop is resumable and a mid-wave death loses one wave.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execSync } from 'node:child_process';
import {
  discoverStructure, reduceFile, reduceToCompletion,
  snapshotSource, restoreFromSnapshot, sha256File, collidesWithSource,
  CLAUDE_DEFAULT_CUT_TYPES, SNAPSHOT_MANIFEST, isContainedIn, physicalForCreate,
  containment,
} from './explode.mjs';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cwx-')); }
function rm(dir) { fs.rmSync(dir, { recursive: true, force: true }); }
// True when the FS folds case (win32 + default macOS): the case-variant of a name
// is the SAME file. Detected, not assumed (macOS-default is case-insensitive too).
function caseInsensitiveFS(dir) {
  const p = path.join(dir, 'CaseProbe.tmp'); fs.writeFileSync(p, 'x');
  const ins = fs.existsSync(path.join(dir, 'caseprobe.tmp'));
  fs.rmSync(p, { force: true });
  return ins;
}

// Build a jsonl Buffer from unit objects. eol default '\n'; finalNoEol drops the
// last terminator (the torn/last-line-no-newline shape). Returns { buf, lines }
// where lines[i] is the EXACT byte slice of unit i (terminator included).
function buildJsonl(objs, { eol = '\n', finalNoEol = false } = {}) {
  const lines = objs.map((o, i) => {
    const body = typeof o === 'string' ? o : JSON.stringify(o);
    const term = finalNoEol && i === objs.length - 1 ? '' : eol;
    return Buffer.from(body + term, 'utf8');
  });
  return { buf: Buffer.concat(lines), lines };
}
function write(dir, name, buf) { const p = path.join(dir, name); fs.writeFileSync(p, buf); return p; }
// Expected reduced output = concat of the source line-slices whose type ∉ cut.
function expectKept(lines, objs, typeField, cut) {
  const cutSet = new Set(cut);
  const kept = [];
  objs.forEach((o, i) => {
    const t = o && typeof o === 'object' && !Array.isArray(o) ? o[typeField] : undefined;
    if (!(typeof t === 'string' && cutSet.has(t))) kept.push(lines[i]);
  });
  return Buffer.concat(kept);
}

const CLAUDEISH = [
  { type: 'mode', v: 'plan' },
  { type: 'user', message: { role: 'user', content: 'hello world' } },
  { type: 'custom-title', title: 'x' },
  { type: 'assistant', message: { role: 'assistant', content: 'hi there' } },
  { type: 'queue-operation', op: 'push' },
  { type: 'last-prompt', prompt: 'hello world' },
  { type: 'attachment', file: 'a.txt', content: 'DATA' },
];

// ---------------------------------------------------------------------------
// 1. explode-accurate on structured input + ZERO corruption of survivors
// ---------------------------------------------------------------------------

test('ndjson: cuts exactly cutTypes, keeps the rest byte-exact (survivors verbatim)', () => {
  const dir = tmp();
  try {
    const { buf, lines } = buildJsonl(CLAUDEISH);
    const src = write(dir, 'a.jsonl', buf);
    const out = path.join(dir, 'a.reduced.jsonl');
    const snap = path.join(dir, 'snap');
    const r = reduceToCompletion(src, { cutTypes: CLAUDE_DEFAULT_CUT_TYPES, outPath: out, snapshotDir: snap });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.structure, 'ndjson');
    assert.strictEqual(r.unitsSeen, 7);
    assert.strictEqual(r.unitsCut, 2, 'mode+custom-title (the A4-rescoped default pair)');
    assert.strictEqual(r.unitsKept, 5, 'user+assistant+attachment survive — and so do queue-operation+last-prompt, which the A4 ruling removed from the blind default');
    const expected = expectKept(lines, CLAUDEISH, 'type', CLAUDE_DEFAULT_CUT_TYPES);
    assert.ok(fs.readFileSync(out).equals(expected), 'output is the byte-exact concat of kept source lines');
    // survivors are still valid, unmodified JSON of the SAME objects
    const gotObjs = fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.deepStrictEqual(gotObjs.map((o) => o.type), ['user', 'assistant', 'queue-operation', 'last-prompt', 'attachment']);
  } finally { rm(dir); }
});

test('byte-exact survivors with CRLF terminators and a final line with no newline', () => {
  const dir = tmp();
  try {
    const { buf, lines } = buildJsonl(CLAUDEISH, { eol: '\r\n', finalNoEol: true });
    const src = write(dir, 'crlf.jsonl', buf);
    const out = path.join(dir, 'crlf.reduced.jsonl');
    const r = reduceToCompletion(src, { cutTypes: ['mode', 'queue-operation'], outPath: out, snapshotDir: path.join(dir, 's') });
    assert.strictEqual(r.unitsCut, 2);
    const expected = expectKept(lines, CLAUDEISH, 'type', ['mode', 'queue-operation']);
    const got = fs.readFileSync(out);
    assert.ok(got.equals(expected), 'CRLF terminators and the no-newline final line are preserved verbatim');
    // the attachment (final, no newline) survived with its exact bytes incl. no trailing terminator
    assert.ok(got.includes(Buffer.from('"content":"DATA"}')), 'final no-newline survivor intact');
  } finally { rm(dir); }
});

test('bizarre/unknown obj.type is KEPT (only cutTypes are cut)', () => {
  const dir = tmp();
  try {
    const objs = [{ type: 'wibble', x: 1 }, { type: 'user', message: { content: 'hi' } }, { type: 'mode' }];
    const { buf } = buildJsonl(objs);
    const src = write(dir, 'b.jsonl', buf);
    const r = reduceToCompletion(src, { cutTypes: ['mode'], outPath: path.join(dir, 'o.jsonl'), snapshotDir: path.join(dir, 's') });
    assert.strictEqual(r.unitsCut, 1, 'only mode');
    assert.strictEqual(r.unitsKept, 2, 'the unknown "wibble" type survives — never cut');
    const kept = fs.readFileSync(path.join(dir, 'o.jsonl'), 'utf8');
    assert.ok(kept.includes('wibble'));
  } finally { rm(dir); }
});

test('typeless / non-object units (no type, array, bare string, number) are KEPT — a cut needs a verified type', () => {
  const dir = tmp();
  try {
    const objs = ['{"foo":1}', '[1,2,3]', '"just a string"', '42', '{"type":"mode"}'];
    const { buf } = buildJsonl(objs);
    const src = write(dir, 'c.jsonl', buf);
    const r = reduceToCompletion(src, { cutTypes: ['mode'], outPath: path.join(dir, 'o.jsonl'), snapshotDir: path.join(dir, 's') });
    assert.strictEqual(r.unitsCut, 1, 'only the typed mode unit');
    assert.strictEqual(r.unitsKept, 4, 'typeless object, array, string, number all kept');
  } finally { rm(dir); }
});

// ---------------------------------------------------------------------------
// 2. fail-toward-keeping within a discovered ndjson: malformed / torn units kept
// ---------------------------------------------------------------------------

test('malformed JSON line inside a confidently-ndjson file is KEPT verbatim (never cut)', () => {
  const dir = tmp();
  try {
    // A realistically-proportioned transcript (a rare corrupt line among many
    // good ones — as real data is): confidently ndjson, the broken line survives.
    const objs = [];
    for (let i = 0; i < 12; i++) objs.push({ type: i % 3 === 0 ? 'mode' : 'user', message: { content: `m${i}` } });
    objs.splice(6, 0, '{this is not json — a stray corrupt line'); // inject mid-file
    const { buf, lines } = buildJsonl(objs);
    const src = write(dir, 'd.jsonl', buf);
    const out = path.join(dir, 'o.jsonl');
    const r = reduceToCompletion(src, { cutTypes: ['mode'], outPath: out, snapshotDir: path.join(dir, 's') });
    assert.strictEqual(r.structure, 'ndjson');
    assert.strictEqual(r.unitsUnparsed, 1);
    assert.ok(r.unitsCut >= 1, 'the mode lines are cut');
    // the malformed line (a raw non-JSON string entry) is among the kept
    // survivors, byte-exact (expectKept keeps it: typeof !== 'object' → no type)
    const expected = expectKept(lines, objs, 'type', ['mode']);
    assert.ok(fs.readFileSync(out).equals(expected), 'the unparseable line survives byte-exact');
  } finally { rm(dir); }
});

test('truncated/torn final object is KEPT (fail-closed within ndjson)', () => {
  const dir = tmp();
  try {
    const objs = [{ type: 'user', message: { content: 'a' } }, { type: 'mode' }, '{"type":"assistant","message":{"content":"cut off mid'];
    const { buf, lines } = buildJsonl(objs, { finalNoEol: true });
    const src = write(dir, 'e.jsonl', buf);
    const out = path.join(dir, 'o.jsonl');
    const r = reduceToCompletion(src, { cutTypes: ['mode'], outPath: out, snapshotDir: path.join(dir, 's') });
    assert.strictEqual(r.unitsCut, 1, 'mode cut');
    const expected = Buffer.concat([lines[0], lines[2]]); // torn tail kept
    assert.ok(fs.readFileSync(out).equals(expected), 'the torn final object survives — we never cut what we could not parse');
  } finally { rm(dir); }
});

// ---------------------------------------------------------------------------
// 3. fail-closed FLOOR: unverifiable structure → skip, never destroy
// ---------------------------------------------------------------------------

test('opaque (markdown / pure text) → skipped, NOTHING cut, NO output written', () => {
  const dir = tmp();
  try {
    const src = write(dir, 'notes.md', Buffer.from('# Heading\n\nsome prose\n- a bullet\n', 'utf8'));
    const out = path.join(dir, 'o.out');
    const r = reduceToCompletion(src, { cutTypes: ['mode'], outPath: out, snapshotDir: path.join(dir, 's') });
    assert.strictEqual(r.skipped, true);
    assert.strictEqual(r.structure, 'opaque');
    assert.strictEqual(r.bytesCut, 0, 'a file we cannot discover is never cut');
    assert.strictEqual(fs.existsSync(out), false, 'no reduced output for an opaque file');
  } finally { rm(dir); }
});

test('empty file → opaque skip, no crash', () => {
  const dir = tmp();
  try {
    const src = write(dir, 'empty.jsonl', Buffer.alloc(0));
    const r = reduceToCompletion(src, { cutTypes: ['mode'] });
    assert.strictEqual(r.skipped, true);
    assert.strictEqual(r.structure, 'opaque');
    assert.strictEqual(r.bytesCut, 0);
  } finally { rm(dir); }
});

test('non-UTF8 / binary → opaque skip (never mis-parsed, never cut)', () => {
  const dir = tmp();
  try {
    const bin = Buffer.from([0x00, 0xff, 0xfe, 0x01, 0x0a, 0x80, 0x81, 0x0a, 0x00, 0xc0]);
    const src = write(dir, 'blob.bin', bin);
    const out = path.join(dir, 'o.out');
    const r = reduceToCompletion(src, { cutTypes: ['mode'], outPath: out, snapshotDir: path.join(dir, 's') });
    assert.strictEqual(r.skipped, true, 'binary is not discoverable structure → skip');
    assert.strictEqual(fs.existsSync(out), false);
  } finally { rm(dir); }
});

test('mixed structure (half json lines, half prose) below the parse-rate → opaque skip', () => {
  const dir = tmp();
  try {
    const src = write(dir, 'mixed.txt', Buffer.from('{"type":"user"}\nnot json here\nalso prose\n{"type":"mode"}\nmore prose\n', 'utf8'));
    const r = reduceToCompletion(src, { cutTypes: ['mode'], outPath: path.join(dir, 'o'), snapshotDir: path.join(dir, 's') });
    assert.strictEqual(r.skipped, true, 'ambiguous structure fails closed — we do not destroy what we cannot confidently parse');
  } finally { rm(dir); }
});

// ---------------------------------------------------------------------------
// 4. BOM preserved; json-single (pretty-printed) + real AG single-line shape
// ---------------------------------------------------------------------------

test('leading UTF-8 BOM is structural — preserved, never part of a cuttable unit', () => {
  const dir = tmp();
  try {
    const { buf, lines } = buildJsonl([{ type: 'mode' }, { type: 'user', message: { content: 'x' } }]);
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const src = write(dir, 'bom.jsonl', Buffer.concat([bom, buf]));
    const out = path.join(dir, 'o.jsonl');
    const disc = (() => { const fd = fs.openSync(src, 'r'); try { return discoverStructure(fd, fs.fstatSync(fd).size); } finally { fs.closeSync(fd); } })();
    assert.strictEqual(disc.structure, 'ndjson');
    assert.strictEqual(disc.bomLen, 3);
    const r = reduceToCompletion(src, { cutTypes: ['mode'], outPath: out, snapshotDir: path.join(dir, 's') });
    assert.strictEqual(r.unitsCut, 1);
    const got = fs.readFileSync(out);
    assert.ok(got.subarray(0, 3).equals(bom), 'the BOM survives even though the first unit (mode) was cut');
    assert.ok(got.subarray(3).equals(lines[1]), 'and the kept unit follows byte-exact');
  } finally { rm(dir); }
});

test('json-single (pretty-printed single object): non-matching type → NO-OP SKIP (no byte-identical rewrite, WAVE-8 L4-C); matching type → cut to empty', () => {
  const dir = tmp();
  try {
    const pretty = Buffer.from(JSON.stringify({ type: 'server-notice', msg: 'restarted' }, null, 2), 'utf8');
    const src = write(dir, 'one.json', pretty);
    const disc = (() => { const fd = fs.openSync(src, 'r'); try { return discoverStructure(fd, fs.fstatSync(fd).size); } finally { fs.closeSync(fd); } })();
    assert.strictEqual(disc.structure, 'json-single');
    // non-matching type: a "cut" would rewrite the whole file byte-identical = a no-op → SKIPPED, nothing written
    const outKeep = path.join(dir, 'keep.json');
    const rk = reduceToCompletion(src, { cutTypes: ['other'], outPath: outKeep, snapshotDir: path.join(dir, 's') });
    assert.strictEqual(rk.skipped, true, 'a no-op json-single keep is skipped, not a byte-identical rewrite');
    assert.strictEqual(rk.unitsCut, 0);
    assert.strictEqual(fs.existsSync(outKeep), false, 'no wasteful copy published on the no-op skip');
    // matching type → a real cut → empty output
    const outCut = path.join(dir, 'cut.json');
    const rc = reduceToCompletion(src, { cutTypes: ['server-notice'], outPath: outCut, snapshotDir: path.join(dir, 's') });
    assert.strictEqual(rc.unitsCut, 1);
    assert.strictEqual(fs.statSync(outCut).size, 0, 'a cut single-object file reduces to empty');
  } finally { rm(dir); }
});

test('Antigravity shape: single-line message JSON, typeField="sender", cut sender=system', () => {
  const dir = tmp();
  try {
    // real AG messages are single-line JSON objects (probe-confirmed) → ndjson, 1 unit each
    const objs = [
      { id: '1', sender: 'system', priority: 'MESSAGE_PRIORITY_LOW', hideFromUser: true, content: '[Notice] server restart' },
      { id: '2', sender: 'user', content: 'do the thing' },
      { id: '3', sender: 'system', hideFromUser: true, content: '[Notice] subagents stopped' },
    ];
    const { buf, lines } = buildJsonl(objs);
    const src = write(dir, 'ag.jsonl', buf);
    const out = path.join(dir, 'o.jsonl');
    const r = reduceToCompletion(src, { cutTypes: ['system'], typeField: 'sender', outPath: out, snapshotDir: path.join(dir, 's') });
    assert.strictEqual(r.unitsCut, 2, 'two system notices cut');
    assert.strictEqual(r.unitsKept, 1, 'the user message survives');
    assert.ok(fs.readFileSync(out).equals(lines[1]), 'the AG user message is byte-exact');
  } finally { rm(dir); }
});

// ---------------------------------------------------------------------------
// 5. the WAVE LOOP: bounded, resumable, mid-wave death loses one wave
// ---------------------------------------------------------------------------

function bigCorpus(n) {
  const objs = [];
  for (let i = 0; i < n; i++) {
    const t = i % 3 === 0 ? 'queue-operation' : (i % 3 === 1 ? 'user' : 'assistant');
    objs.push({ type: t, i, pad: 'x'.repeat(40 + (i % 17)) });
  }
  return objs;
}

test('wave loop: a big file reduces in MANY bounded waves, output identical to a single wave (byte-for-byte)', () => {
  const dir = tmp();
  try {
    const objs = bigCorpus(5000);
    const { buf } = buildJsonl(objs);
    const src = write(dir, 'big.jsonl', buf);
    // one giant wave (reference)
    const ref = path.join(dir, 'ref.jsonl');
    const r1 = reduceToCompletion(src, { cutTypes: ['queue-operation'], outPath: ref, snapshotDir: path.join(dir, 's1'), maxLines: 1e9, maxBytes: 1e9 });
    assert.strictEqual(r1.waves, 1);
    // many small waves
    const many = path.join(dir, 'many.jsonl');
    const r2 = reduceToCompletion(src, { cutTypes: ['queue-operation'], outPath: many, snapshotDir: path.join(dir, 's2'), maxLines: 300 });
    assert.ok(r2.waves > 10, `expected many waves, got ${r2.waves}`);
    assert.strictEqual(r2.done, true);
    assert.strictEqual(r1.unitsCut, r2.unitsCut);
    assert.strictEqual(r1.unitsKept, r2.unitsKept);
    assert.ok(fs.readFileSync(ref).equals(fs.readFileSync(many)), 'the wave-split reduction is byte-identical to the single-pass reduction');
    // and byte-identical to the independently-computed expected
    const { lines } = buildJsonl(objs);
    assert.ok(fs.readFileSync(many).equals(expectKept(lines, objs, 'type', ['queue-operation'])));
  } finally { rm(dir); }
});

test('mid-wave death: the engine REFUSES to resume when the output size ≠ the checkpoint outLen (closes the L3#2 fail-open forged-shrink hole); recovery = the caller truncates to its TRUSTED checkpoint outLen, then resumes byte-identical', () => {
  const dir = tmp();
  try {
    const objs = bigCorpus(2000);
    const { buf } = buildJsonl(objs);
    const src = write(dir, 'big.jsonl', buf);
    const straight = path.join(dir, 'straight.jsonl');
    reduceToCompletion(src, { cutTypes: ['queue-operation'], outPath: straight, snapshotDir: path.join(dir, 's0'), maxLines: 1e9, maxBytes: 1e9 });

    const out = path.join(dir, 'resumed.jsonl');
    const opts = { cutTypes: ['queue-operation'], outPath: out, snapshotDir: path.join(dir, 's1'), maxLines: 250 };
    // wave 1
    const w1 = reduceFile(src, { ...opts, offset: 0, resume: null });
    assert.strictEqual(w1.done, false);
    // wave 2
    const w2 = reduceFile(src, { ...opts, offset: w1.nextOffset, resume: w1.checkpoint });
    assert.strictEqual(w2.done, false);
    // SIMULATE a crash mid-wave-3: a partial garbage tail on the output → curOutSize > checkpoint.outLen.
    fs.appendFileSync(out, 'PARTIAL-DEAD-WAVE-GARBAGE');
    // L3#2: the engine no longer BLINDLY truncates a caller-provided outLen (that was the forged-shrink
    // fail-open) — an output size that disagrees with the checkpoint is REFUSED fail-closed, both directions.
    const refused = reduceFile(src, { ...opts, offset: w2.nextOffset, resume: w2.checkpoint });
    assert.strictEqual(refused.ok, false, 'a partial tail (curOutSize ≠ outLen) is refused, never silently truncated');
    assert.match(refused.reason, /outLen|output file size|committed/i);
    // RECOVERY (caller owns the truncate): a caller that TRUSTS its persisted checkpoint truncates the output
    // back to the committed length ITSELF, then resumes → byte-identical to a clean run.
    fs.truncateSync(out, w2.checkpoint.outLen);
    let ckpt = w2.checkpoint;
    let off = w2.nextOffset;
    let guard = 0;
    for (;;) {
      const w = reduceFile(src, { ...opts, offset: off, resume: ckpt });
      assert.strictEqual(w.ok, true);
      if (w.done) break;
      off = w.nextOffset; ckpt = w.checkpoint;
      if (++guard > 100000) throw new Error('runaway');
    }
    assert.ok(fs.readFileSync(out).equals(fs.readFileSync(straight)), 'after the caller-owned truncate, the resume completes byte-identical to a clean run');
  } finally { rm(dir); }
});

test('dry-run measures without writing (no outPath, no snapshotDir needed)', () => {
  const dir = tmp();
  try {
    const { buf } = buildJsonl(CLAUDEISH);
    const src = write(dir, 'a.jsonl', buf);
    const r = reduceToCompletion(src, { cutTypes: CLAUDE_DEFAULT_CUT_TYPES });
    assert.strictEqual(r.dryRun, true);
    assert.strictEqual(r.unitsCut, 2);
    assert.ok(r.bytesCut > 0 && r.reductionPct > 0);
    assert.deepStrictEqual(fs.readdirSync(dir), ['a.jsonl'], 'dry-run wrote nothing');
  } finally { rm(dir); }
});

// ---------------------------------------------------------------------------
// 6. snapshot byte-exact + recovery restores + content-hash dedup + gate
// ---------------------------------------------------------------------------

test('real cut without snapshotDir is REFUSED (rail 5: no snapshot, no destroy)', () => {
  const dir = tmp();
  try {
    const { buf } = buildJsonl(CLAUDEISH);
    const src = write(dir, 'a.jsonl', buf);
    const r = reduceFile(src, { cutTypes: ['mode'], outPath: path.join(dir, 'o.jsonl') }); // no snapshotDir
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /snapshot/i);
    assert.strictEqual(fs.existsSync(path.join(dir, 'o.jsonl')), false, 'nothing written when the snapshot gate refuses');
  } finally { rm(dir); }
});

test('in-place reduce (outPath === src) is REFUSED and leaves the source untouched (no self-truncation)', () => {
  const dir = tmp();
  try {
    const { buf } = buildJsonl(CLAUDEISH);
    const src = write(dir, 'a.jsonl', buf);
    const before = sha256File(src);
    const r = reduceFile(src, { cutTypes: ['mode'], outPath: src, snapshotDir: path.join(dir, 's') });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /in-place|truncate|differ/i);
    assert.strictEqual(sha256File(src), before, 'the source is byte-identical — the engine refused before any open-for-write');
  } finally { rm(dir); }
});

test('snapshot is byte-exact and recovery restores the original byte-for-byte', () => {
  const dir = tmp();
  try {
    const { buf } = buildJsonl(bigCorpus(1200), { eol: '\r\n' });
    const src = write(dir, 'orig.jsonl', buf);
    const snapDir = path.join(dir, 'snap');
    const snap = snapshotSource(src, snapDir);
    assert.strictEqual(snap.ok, true);
    assert.strictEqual(snap.sha256, sha256File(src));
    assert.ok(fs.readFileSync(snap.snapshotPath).equals(buf), 'the snapshot blob is byte-exact');
    // recover to a fresh path
    const restored = path.join(dir, 'restored.jsonl');
    const res = restoreFromSnapshot(snap.sha256, restored, { snapshotDir: snapDir, original: src });
    assert.strictEqual(res.ok, true);
    assert.ok(fs.readFileSync(restored).equals(buf), 'restore is byte-identical to the original');
  } finally { rm(dir); }
});

test('content-hash dedup: identical content snapshots once (deduped by hash)', () => {
  const dir = tmp();
  try {
    const { buf } = buildJsonl(CLAUDEISH);
    const a = write(dir, 'a.jsonl', buf);
    const b = write(dir, 'b.jsonl', Buffer.from(buf)); // identical content, different name
    const snapDir = path.join(dir, 'snap');
    const s1 = snapshotSource(a, snapDir);
    const s2 = snapshotSource(b, snapDir);
    assert.strictEqual(s1.sha256, s2.sha256);
    assert.strictEqual(s1.deduped, false);
    assert.strictEqual(s2.deduped, true, 'the second identical snapshot deduplicates by hash');
    const blobs = fs.readdirSync(snapDir).filter((n) => /^[0-9a-f]{64}$/.test(n));
    assert.strictEqual(blobs.length, 1, 'one content-addressed blob for identical content');
  } finally { rm(dir); }
});

test('a full reduce leaves the SOURCE untouched (engine writes a slim copy, never mutates the original)', () => {
  const dir = tmp();
  try {
    const { buf } = buildJsonl(CLAUDEISH);
    const src = write(dir, 'a.jsonl', buf);
    const before = sha256File(src);
    reduceToCompletion(src, { cutTypes: CLAUDE_DEFAULT_CUT_TYPES, outPath: path.join(dir, 'o.jsonl'), snapshotDir: path.join(dir, 's') });
    assert.strictEqual(sha256File(src), before, 'the source .jsonl is byte-identical after the reduce — never mutated in place');
  } finally { rm(dir); }
});

// ---------------------------------------------------------------------------
// 7. determinism + unicode integrity
// ---------------------------------------------------------------------------

test('deterministic: same input + cutlist → identical output bytes across runs', () => {
  const dir = tmp();
  try {
    const { buf } = buildJsonl(bigCorpus(800));
    const src = write(dir, 'a.jsonl', buf);
    const o1 = path.join(dir, 'o1.jsonl'); const o2 = path.join(dir, 'o2.jsonl');
    reduceToCompletion(src, { cutTypes: ['queue-operation'], outPath: o1, snapshotDir: path.join(dir, 's1'), maxLines: 137 });
    reduceToCompletion(src, { cutTypes: ['queue-operation'], outPath: o2, snapshotDir: path.join(dir, 's2'), maxLines: 999 });
    assert.ok(fs.readFileSync(o1).equals(fs.readFileSync(o2)), 'different wave sizes, identical bytes');
  } finally { rm(dir); }
});

test('unicode survivors intact (Thai / emoji / multi-byte kept byte-exact through the cut)', () => {
  const dir = tmp();
  try {
    const objs = [
      { type: 'mode' },
      { type: 'user', message: { content: 'สวัสดีครับ ทำงานแปลนิยาย 🐑 — em—dash และ …' } },
      { type: 'queue-operation' },
      { type: 'assistant', message: { content: '日本語 テスト' } },
    ];
    const { buf, lines } = buildJsonl(objs);
    const src = write(dir, 'u.jsonl', buf);
    const out = path.join(dir, 'o.jsonl');
    reduceToCompletion(src, { cutTypes: ['mode', 'queue-operation'], outPath: out, snapshotDir: path.join(dir, 's') });
    const expected = Buffer.concat([lines[1], lines[3]]);
    assert.ok(fs.readFileSync(out).equals(expected), 'multi-byte UTF-8 survivors are byte-exact');
  } finally { rm(dir); }
});

// ---------------------------------------------------------------------------
// 8. ADVERSARIAL: source-collision (CRITICAL), memory bound (HIGH), resume
//    validation + dedup verify (MED), unverified-restore honesty (LOW).
//    (Break vectors from the ULTRA break barrage — inv3/5/6/7.)
// ---------------------------------------------------------------------------

test('CRITICAL: a case-variant outPath never truncates the source (realpath + case-fold guard)', () => {
  const dir = tmp();
  try {
    const { buf } = buildJsonl(CLAUDEISH);
    const src = write(dir, 'LiveSession.jsonl', buf);
    const before = sha256File(src);
    const outVariant = path.join(dir, 'livesession.jsonl'); // SAME file on a case-insensitive FS
    const r = reduceFile(src, { cutTypes: CLAUDE_DEFAULT_CUT_TYPES, outPath: outVariant, snapshotDir: path.join(dir, 's') });
    assert.strictEqual(sha256File(src), before, 'the source is byte-identical — never truncated');
    if (caseInsensitiveFS(dir)) {
      assert.strictEqual(r.ok, false, 'on a case-insensitive FS the variant IS the source → refused fail-closed');
      assert.match(r.reason, /source/i);
    }
  } finally { rm(dir); }
});

test('CRITICAL: a drive-letter case-variant outPath never truncates the source (win32)', (t) => {
  if (process.platform !== 'win32') { t.skip('drive letters are win32-only'); return; }
  const dir = tmp();
  try {
    const { buf } = buildJsonl(CLAUDEISH);
    const src = write(dir, 'store.jsonl', buf); // C:\...
    const before = sha256File(src);
    const outDriveLo = src.charAt(0).toLowerCase() + src.slice(1); // c:\... (same file)
    const r = reduceFile(src, { cutTypes: CLAUDE_DEFAULT_CUT_TYPES, outPath: outDriveLo, snapshotDir: path.join(dir, 's') });
    assert.strictEqual(r.ok, false, 'c: vs C: is the same file → refused');
    assert.strictEqual(sha256File(src), before, 'source byte-identical');
  } finally { rm(dir); }
});

test('CRITICAL: a hardlink outPath (same inode, different name) never truncates the source', (t) => {
  const dir = tmp();
  try {
    const { buf } = buildJsonl(CLAUDEISH);
    const src = write(dir, 'orig.jsonl', buf);
    const before = sha256File(src);
    const hard = path.join(dir, 'hard.jsonl');
    try { fs.linkSync(src, hard); } catch (e) { t.skip(`hardlink unavailable (${e.code})`); return; }
    const r = reduceFile(src, { cutTypes: CLAUDE_DEFAULT_CUT_TYPES, outPath: hard, snapshotDir: path.join(dir, 's') });
    // realpath is BLIND to a hardlink (distinct names) — the dev+ino check catches it.
    assert.strictEqual(r.ok, false, 'a hardlink to src shares its inode → refused');
    assert.match(r.reason, /hardlink|source/i);
    assert.strictEqual(sha256File(src), before, 'source byte-identical');
  } finally { rm(dir); }
});

test('CRITICAL: a symlink outPath pointing at the source never truncates it (realpath guard)', (t) => {
  const dir = tmp();
  try {
    const { buf } = buildJsonl(CLAUDEISH);
    const src = write(dir, 'real.jsonl', buf);
    const before = sha256File(src);
    const link = path.join(dir, 'link.jsonl');
    try { fs.symlinkSync(src, link); } catch (e) { t.skip(`symlink unavailable (${e.code})`); return; }
    const r = reduceFile(src, { cutTypes: CLAUDE_DEFAULT_CUT_TYPES, outPath: link, snapshotDir: path.join(dir, 's') });
    assert.strictEqual(r.ok, false, 'a symlink to src resolves to src → refused');
    assert.strictEqual(sha256File(src), before, 'source byte-identical');
  } finally { rm(dir); }
});

test('temp+rename publishes outPath atomically and leaves no .tmp leftover (multi-wave)', () => {
  const dir = tmp();
  try {
    const { buf } = buildJsonl(CLAUDEISH);
    const src = write(dir, 'a.jsonl', buf);
    const sub = path.join(dir, 'sub');
    const out = path.join(sub, 'a.reduced.jsonl');
    const r = reduceToCompletion(src, { cutTypes: CLAUDE_DEFAULT_CUT_TYPES, outPath: out, snapshotDir: path.join(dir, 's'), maxLines: 2 });
    assert.strictEqual(r.done, true);
    assert.ok(fs.existsSync(out), 'outPath published');
    assert.deepStrictEqual(fs.readdirSync(sub).filter((f) => f.includes('.tmp')), [], 'no per-pid .tmp file remains');
  } finally { rm(dir); }
});

test('HIGH: a large newline-sparse file → opaque with BOUNDED reads (never the whole file, no OOM)', () => {
  const dir = tmp();
  try {
    const src = path.join(dir, 'noln.jsonl');
    const SIZE = 8 * 1024 * 1024; // 8 MB, NO newline
    const fd = fs.openSync(src, 'w');
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    for (let i = 0; i < 8; i++) fs.writeSync(fd, chunk);
    fs.closeSync(fd);
    const realRead = fs.readSync.bind(fs);
    let readBytes = 0;
    fs.readSync = (...a) => { const n = realRead(...a); if (n > 0) readBytes += n; return n; };
    let r;
    try { r = reduceToCompletion(src, { cutTypes: ['x'], outPath: path.join(dir, 'o'), snapshotDir: path.join(dir, 's') }); }
    finally { fs.readSync = realRead; }
    assert.strictEqual(r.skipped, true, 'newline-sparse front → opaque skip');
    assert.strictEqual(r.structure, 'opaque');
    assert.ok(readBytes < SIZE * 0.5, `bounded reads: ${(readBytes / 1048576).toFixed(1)}MB of 8MB — never materialized whole`);
    assert.strictEqual(fs.existsSync(path.join(dir, 'o')), false, 'no output for an opaque file');
  } finally { rm(dir); }
});

test('HIGH: a mid-file line larger than the wave budget → opaque skip, bounded scan (no OOM)', () => {
  const dir = tmp();
  try {
    const src = path.join(dir, 'bigline.jsonl');
    const fd = fs.openSync(src, 'w');
    fs.writeSync(fd, '{"type":"user","a":1}\n');           // small — discovery sees ndjson
    fs.writeSync(fd, '{"type":"user","b":"');
    const chunk = Buffer.alloc(1024 * 1024, 0x62);
    for (let i = 0; i < 16; i++) fs.writeSync(fd, chunk);   // 16 MB inside one JSON string
    fs.writeSync(fd, '"}\n{"type":"user","a":2}\n');
    fs.closeSync(fd);
    // DRY-RUN isolates the SCAN read from the (necessary, streaming, constant-memory)
    // snapshot hash — the OOM vector is carry accumulation, and the scan must BAIL on
    // the overlong line rather than buffer the whole 16 MB.
    const realRead = fs.readSync.bind(fs);
    let readBytes = 0;
    fs.readSync = (...a) => { const n = realRead(...a); if (n > 0) readBytes += n; return n; };
    let dry;
    try { dry = reduceFile(src, { cutTypes: ['x'], maxBytes: 65536, maxLines: 4 }); }
    finally { fs.readSync = realRead; }
    assert.strictEqual(dry.skipped, true, 'a single unit >> wave budget → fail-closed opaque skip');
    assert.ok(readBytes < 4 * 1024 * 1024, `bounded scan: ${(readBytes / 1048576).toFixed(1)}MB, not the whole 16MB line`);
    // real reduce: fail-closed leaves NO output and NO leftover temp (source untouched)
    const out = path.join(dir, 'o.jsonl');
    const r = reduceFile(src, { cutTypes: ['x'], outPath: out, snapshotDir: path.join(dir, 's'), maxBytes: 65536, maxLines: 4 });
    assert.strictEqual(r.skipped, true);
    assert.strictEqual(fs.existsSync(out), false, 'the unpublished temp was discarded — no output');
    assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp')), [], 'no leftover temp');
  } finally { rm(dir); }
});

test('MED: snapshot dedup VERIFIES the existing blob (a poisoned pre-seed is overwritten, not trusted)', () => {
  const dir = tmp();
  try {
    const { buf } = buildJsonl(CLAUDEISH);
    const src = write(dir, 's.jsonl', buf);
    const snapDir = path.join(dir, 'snap');
    fs.mkdirSync(snapDir, { recursive: true });
    const sha = sha256File(src);
    fs.writeFileSync(path.join(snapDir, sha), Buffer.from('POISON — not the source at all\n', 'utf8'));
    const snap = snapshotSource(src, snapDir);
    assert.strictEqual(snap.ok, true);
    assert.strictEqual(snap.deduped, false, 'the poisoned blob failed its own hash → NOT deduped');
    assert.ok(fs.readFileSync(path.join(snapDir, sha)).equals(buf), 'the blob was overwritten with the true source');
  } finally { rm(dir); }
});

test('MED: resume with a missing outPath fails gracefully (ok:false), never an uncaught ENOENT throw', () => {
  const dir = tmp();
  try {
    const { buf } = buildJsonl(bigCorpus(200));
    const src = write(dir, 's.jsonl', buf);
    const w1 = reduceFile(src, { cutTypes: ['queue-operation'], outPath: path.join(dir, 'good.jsonl'), snapshotDir: path.join(dir, 's'), maxLines: 50 });
    assert.strictEqual(w1.done, false, 'wave 1 leaves more to do');
    // real (clean-boundary, valid-outLen) checkpoint but a DIFFERENT, non-existent outPath
    const r = reduceFile(src, { cutTypes: ['queue-operation'], outPath: path.join(dir, 'missing.jsonl'), snapshotDir: path.join(dir, 's'), offset: w1.nextOffset, resume: w1.checkpoint });
    assert.strictEqual(r.ok, false, 'graceful refusal, not a throw');
    assert.match(r.reason, /outPath does not exist/i);
  } finally { rm(dir); }
});

test('MED: resume with a too-LARGE outLen is refused (no zero-extend — the exact-match guard rejects both directions)', () => {
  const dir = tmp();
  try {
    const { buf } = buildJsonl(bigCorpus(200));
    const src = write(dir, 's.jsonl', buf);
    const out = path.join(dir, 'out.jsonl');
    const w1 = reduceFile(src, { cutTypes: ['queue-operation'], outPath: out, snapshotDir: path.join(dir, 's'), maxLines: 50 });
    const committed = fs.statSync(out).size;
    const bad = { ...w1.checkpoint, outLen: committed + 10_000 }; // claim more than exists
    const r = reduceFile(src, { cutTypes: ['queue-operation'], outPath: out, snapshotDir: path.join(dir, 's'), offset: w1.nextOffset, resume: bad });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /outLen|output file size|committed/i);
    assert.strictEqual(fs.statSync(out).size, committed, 'the committed output is untouched by the refusal');
  } finally { rm(dir); }
});

test('MED: resume at a non-line-boundary offset is refused (no torn fragment leaks into output)', () => {
  const dir = tmp();
  try {
    const { buf } = buildJsonl(bigCorpus(200));
    const src = write(dir, 's.jsonl', buf);
    const out = path.join(dir, 'out.jsonl');
    const w1 = reduceFile(src, { cutTypes: ['queue-operation'], outPath: out, snapshotDir: path.join(dir, 's'), maxLines: 50 });
    const r = reduceFile(src, { cutTypes: ['queue-operation'], outPath: out, snapshotDir: path.join(dir, 's'), offset: w1.nextOffset + 10, resume: w1.checkpoint });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /line boundary/i);
  } finally { rm(dir); }
});

test('L3#2 (WAVE-6): a FORGED resume outLen SHRUNK below the committed length is REFUSED — never silently truncates good bytes into a torn seam (the exact-match guard closes the shrink direction the old `<= curOutSize` missed)', () => {
  const dir = tmp();
  try {
    const { buf } = buildJsonl(bigCorpus(200));
    const src = write(dir, 's.jsonl', buf);
    const out = path.join(dir, 'out.jsonl');
    const w1 = reduceFile(src, { cutTypes: ['queue-operation'], outPath: out, snapshotDir: path.join(dir, 's'), maxLines: 50 });
    assert.strictEqual(w1.done, false, 'wave 1 leaves more to do');
    const trueCommitted = fs.statSync(out).size; // the CLEAN committed length — NO partial tail
    // forge outLen SHRUNK below the true committed length. It is IN-RANGE for the OLD `committed <= curOutSize`
    // guard, which would truncateSync(out, forged) — dropping GOOD committed bytes — then resume from the
    // (correct) srcOffset = a corrupted-JSONL seam reported ok:true. The exact-match guard refuses it.
    const forged = { ...w1.checkpoint, outLen: trueCommitted - 20 };
    const r = reduceFile(src, { cutTypes: ['queue-operation'], outPath: out, snapshotDir: path.join(dir, 's'), offset: w1.nextOffset, resume: forged });
    assert.strictEqual(r.ok, false, 'a shrunk outLen is refused (pre-fix: silent tear, ok:true)');
    assert.match(r.reason, /outLen|output file size|committed/i);
    assert.strictEqual(fs.statSync(out).size, trueCommitted, 'the committed output was NOT truncated by the forged value');
  } finally { rm(dir); }
});

test('COMPLETENESS (checkpoint structure field): a resume carrying a forged NON-ndjson structure is REFUSED before any snapshot/write (only ndjson has resumable waves)', () => {
  const dir = tmp();
  try {
    const { buf } = buildJsonl(bigCorpus(200));
    const src = write(dir, 's.jsonl', buf);
    const out = path.join(dir, 'out.jsonl');
    const w1 = reduceFile(src, { cutTypes: ['queue-operation'], outPath: out, snapshotDir: path.join(dir, 's'), maxLines: 50 });
    // forge the checkpoint's structure to 'json-single' — a resume must only continue an ndjson stream (pre-fix
    // this routed to the whole-file json-single branch, IGNORING the offset and rewriting the whole file ok:true)
    const forged = { ...w1.checkpoint, structure: 'json-single' };
    const r = reduceFile(src, { cutTypes: ['queue-operation'], outPath: out, snapshotDir: path.join(dir, 's'), offset: w1.nextOffset, resume: forged });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /ndjson|structure/i);
  } finally { rm(dir); }
});

test('COMPLETENESS (checkpoint offset field): a NEGATIVE resume offset is refused by the EXPLICIT boundary guard (a clean early refusal, not the cryptic downstream readSync throw it fell through to before)', () => {
  const dir = tmp();
  try {
    const { buf } = buildJsonl(bigCorpus(50));
    const src = write(dir, 's.jsonl', buf);
    const out = path.join(dir, 'out.jsonl');
    const w1 = reduceFile(src, { cutTypes: ['queue-operation'], outPath: out, snapshotDir: path.join(dir, 's'), maxLines: 20 });
    const r = reduceFile(src, { cutTypes: ['queue-operation'], outPath: out, snapshotDir: path.join(dir, 's'), offset: -5, resume: w1.checkpoint });
    assert.strictEqual(r.ok, false, 'fail-closed both directions');
    // the EXPLICIT guard names the boundary ("resume: offset … out of range"); without it a negative offset
    // still fail-closes, but only via the downstream readSync throw ("reduce failed: …") — a fragile, cryptic
    // path. Asserting the explicit reason proves the early boundary refusal fired (before the write-setup).
    assert.match(r.reason, /resume: offset/i);
  } finally { rm(dir); }
});

test('WAVE-7 L3-A (BREAK 2): a non-hash-named ref is REFUSED (never published unverified) — the basename-shape discriminator is dead; UPPERCASE-hex is refused too; a content-addressed ref still restores + verifies', () => {
  const dir = tmp();
  try {
    // PRE-FIX: a non-sha basename SKIPPED hash-verify and was copied to toPath with ok:true, verified:false
    // (a read-anything-to-toPath inject/exfil path). NOW a ref that is not a verifiable in-store
    // content-address is REFUSED, never published.
    const blob = write(dir, 'arbitrary-name.bin', Buffer.from('a blob restored by explicit path\n'));
    const dest = path.join(dir, 'restored.out');
    const r = restoreFromSnapshot(blob, dest);
    assert.strictEqual(r.ok, false, 'a non-content-addressed ref is refused, never published unverified');
    assert.strictEqual(r.verified, false, 'verified is accurate (false) on the refusal');
    assert.match(r.reason, /content-address|sha256|verifiable/i);
    assert.strictEqual(fs.existsSync(dest), false, 'nothing was copied out to toPath');
    // an UPPERCASE-hex basename (this store only ever writes lowercase sha256) is likewise NOT a verifiable
    // in-store content-address → refused (pre-fix the lowercase-only regex made uppercase SKIP verify).
    const upper = write(dir, 'A'.repeat(64), Buffer.from('uppercase-hex-named foreign blob\n'));
    const rU = restoreFromSnapshot(upper, path.join(dir, 'u.out'));
    assert.strictEqual(rU.ok, false, 'an UPPERCASE-hex ref is refused (the store emits only lowercase sha256)');
    assert.strictEqual(fs.existsSync(path.join(dir, 'u.out')), false, 'nothing copied out for the uppercase ref');
    // a legitimate content-addressed (lowercase-sha) blob still restores AND is hash-verified (no regression)
    const snapDir = path.join(dir, 'snap');
    const src = write(dir, 's.jsonl', buildJsonl(CLAUDEISH).buf);
    const snap = snapshotSource(src, snapDir);
    const r2 = restoreFromSnapshot(snap.sha256, path.join(dir, 'r2.out'), { snapshotDir: snapDir, original: src });
    assert.strictEqual(r2.ok, true, 'a sha-named blob restore succeeds');
    assert.strictEqual(r2.verified, true, 'a sha-named blob restore IS hash-verified');
    assert.ok(fs.readFileSync(path.join(dir, 'r2.out')).equals(buildJsonl(CLAUDEISH).buf), 'and is byte-exact');
  } finally { rm(dir); }
});

// ---------------------------------------------------------------------------
// 9. OUTPUT-WRITE + RECOVERY hardening (empirically found in the ULTRA re-break —
//    the fail-closed discipline of reduceFile's SOURCE side extended to the OUTPUT
//    path and restoreFromSnapshot). Every documented export returns { ok:false }
//    on a bad path — it NEVER propagates a raw fs throw.
// ---------------------------------------------------------------------------

test('#1: a bad outPath (ancestor is a FILE) returns ok:false — the fs throw never escapes the API', () => {
  const dir = tmp();
  try {
    const { buf } = buildJsonl(CLAUDEISH);
    const src = write(dir, 'a.jsonl', buf);
    const ancFile = write(dir, 'iamafile.txt', Buffer.from('not a dir'));
    const out = path.join(ancFile, 'child', 'o.jsonl'); // ancestor is a FILE → mkdirSync throws ENOTDIR
    let threw = null, r = null;
    try { r = reduceFile(src, { cutTypes: ['mode'], outPath: out, snapshotDir: path.join(dir, 's') }); }
    catch (e) { threw = e; }
    assert.strictEqual(threw, null, 'no uncaught throw escapes the documented API');
    assert.strictEqual(r.ok, false, 'returns a fail-closed result');
    assert.strictEqual(fs.existsSync(out), false, 'nothing published');
  } finally { rm(dir); }
});

test('#1/#7: outPath that is an existing DIRECTORY fails ok:false and reaps its temp (no rename-throw orphan)', () => {
  const dir = tmp();
  try {
    const { buf } = buildJsonl(CLAUDEISH);
    const src = write(dir, 'a.jsonl', buf);
    const before = sha256File(src);
    const outDir = path.join(dir, 'out-is-a-dir');
    fs.mkdirSync(outDir); // renameSync(temp, dir) throws EPERM/ENOTEMPTY
    let threw = null, r = null;
    try { r = reduceFile(src, { cutTypes: ['mode'], outPath: outDir, snapshotDir: path.join(dir, 's') }); }
    catch (e) { threw = e; }
    assert.strictEqual(threw, null, 'the rename-onto-a-dir throw is caught, not propagated');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(sha256File(src), before, 'source untouched');
    assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp')), [], 'the per-pid temp was reaped by the finally (Phoenix #1 — no orphan on the throw path)');
  } finally { rm(dir); }
});

test('#1: reduceToCompletion returns ok:false on a throwing outPath, never propagates the throw', () => {
  const dir = tmp();
  try {
    const { buf } = buildJsonl(CLAUDEISH);
    const src = write(dir, 'a.jsonl', buf);
    const ancFile = write(dir, 'f.txt', Buffer.from('x'));
    const out = path.join(ancFile, 'nope', 'o.jsonl');
    let threw = null, r = null;
    try { r = reduceToCompletion(src, { cutTypes: ['mode'], outPath: out, snapshotDir: path.join(dir, 's') }); }
    catch (e) { threw = e; }
    assert.strictEqual(threw, null);
    assert.strictEqual(r.ok, false);
  } finally { rm(dir); }
});

test('#1 CROSS-PROCESS: concurrent workers racing a SHARED snapshotDir + SAME outPath never throw — each exits 0 with a { ok } result', async () => {
  // The in-process test above cannot reach a rename/manifest/truncate race between REAL processes.
  // This spawns real node workers that each reduceToCompletion (no try/catch of their own, like
  // h4-worker.mjs) → an uncaught throw would exit 1 with EMPTY stdout. The fail-closed contract:
  // under ANY contention every export returns { ok:false }, never a raw throw; the source stays intact.
  const dir = tmp();
  try {
    const engineUrl = new URL('./explode.mjs', import.meta.url).href;
    const workerPath = path.join(dir, 'worker.mjs');
    fs.writeFileSync(workerPath,
      `import { reduceToCompletion } from ${JSON.stringify(engineUrl)};\n` +
      `const [,, src, out, snap] = process.argv;\n` +
      `const r = reduceToCompletion(src, { cutTypes: ['mode'], outPath: out, snapshotDir: snap, maxLines: 40 });\n` +
      `process.stdout.write(JSON.stringify({ ok: r.ok }));\n`); // NO try/catch — a throw must surface as exit 1
    const { buf } = buildJsonl(bigCorpus(400));
    const src = write(dir, 'src.jsonl', buf);
    const srcBefore = sha256File(src);
    const out = path.join(dir, 'SAME.jsonl');      // SAME outPath from every worker (rename race)
    const snap = path.join(dir, 'shared-snap');     // SHARED store (mkdir/copy/manifest-append race)
    const runKid = () => new Promise((res) => {
      const c = spawn(process.execPath, [workerPath, src, out, snap]);
      let o = '', e = '';
      c.stdout.on('data', (d) => (o += d));
      c.stderr.on('data', (d) => (e += d));
      c.on('close', (code) => res({ code, o: o.trim(), e: e.trim() }));
    });
    // two rounds of 5 concurrent workers widens the race window (green regardless of timing WITH the
    // guard; a removed guard crashes intermittently → the regression surfaces).
    for (let round = 0; round < 2; round++) {
      const results = await Promise.all([runKid(), runKid(), runKid(), runKid(), runKid()]);
      for (const r of results) {
        assert.strictEqual(r.code, 0, `a concurrent worker crashed (exit ${r.code}) — an uncaught throw escaped the fail-closed API. stderr: ${r.e.slice(0, 200)}`);
        assert.match(r.o, /"ok":(true|false)/, 'each worker returned a { ok } result, never an empty-stdout crash');
      }
    }
    assert.strictEqual(sha256File(src), srcBefore, 'the source survived concurrent misuse byte-intact');
  } finally { rm(dir); }
});

test('#1 DETERMINISTIC: an injected fs throw mid-write (the Windows rename-race EPERM) → ok:false, no throw, temp reaped', () => {
  // The cross-process test above only THROWS on hardware whose fs actually locks during a concurrent
  // rename (AV/Defender, slow disk) — it can pass vacuously elsewhere. Inject the throw directly to
  // prove the contract non-flakily: patch fs.renameSync to throw the exact EPERM a racing rename
  // raises (same monkeypatch pattern the OOM tests use on fs.readSync). Removing reduceFile's body
  // catch makes THIS test fail deterministically → it is a real regression guard, not a lucky pass.
  const dir = tmp();
  try {
    const { buf } = buildJsonl(CLAUDEISH);
    const src = write(dir, 'a.jsonl', buf);
    const before = sha256File(src);
    const out = path.join(dir, 'o.jsonl');
    const realRename = fs.renameSync;
    fs.renameSync = () => { const e = new Error('EPERM: operation not permitted, rename'); e.code = 'EPERM'; throw e; };
    let threw = null, r = null;
    try { r = reduceFile(src, { cutTypes: ['mode'], outPath: out, snapshotDir: path.join(dir, 's') }); }
    catch (e) { threw = e; }
    finally { fs.renameSync = realRename; }
    assert.strictEqual(threw, null, 'the injected rename throw is CAUGHT, never propagated out of the API');
    assert.strictEqual(r.ok, false, 'returns fail-closed');
    assert.strictEqual(sha256File(src), before, 'source untouched');
    assert.strictEqual(fs.existsSync(out), false, 'nothing published (the unrenamed temp is not the output)');
    assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp')), [], 'the per-pid temp was reaped by the finally on the injected-throw path');
    // reduceToCompletion swallows it too (its own try-wrap + reduceFile's catch)
    const realRename2 = fs.renameSync;
    fs.renameSync = () => { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; };
    let threw2 = null, rc = null;
    try { rc = reduceToCompletion(src, { cutTypes: ['mode'], outPath: path.join(dir, 'o2.jsonl'), snapshotDir: path.join(dir, 's2') }); }
    catch (e) { threw2 = e; }
    finally { fs.renameSync = realRename2; }
    assert.strictEqual(threw2, null, 'reduceToCompletion never propagates the throw either');
    assert.strictEqual(rc.ok, false);
  } finally { rm(dir); }
});

test('#2: restoreFromSnapshot refuses a snapshotDir-relative ref that escapes the store (path traversal)', () => {
  const dir = tmp();
  try {
    const snapDir = path.join(dir, 'snaps');
    fs.mkdirSync(snapDir, { recursive: true });
    const secret = write(dir, 'SECRET.txt', Buffer.from('TOP SECRET bytes outside the store'));
    const toPath = path.join(dir, 'exfil.txt');
    const rel = path.relative(snapDir, secret).replace(/\\/g, '/'); // ../SECRET.txt
    const r = restoreFromSnapshot(rel, toPath, { snapshotDir: snapDir });
    assert.strictEqual(r.ok, false, 'a "../" ref is refused fail-closed');
    assert.match(r.reason, /traversal|escapes/i);
    assert.strictEqual(fs.existsSync(toPath), false, 'nothing was copied out of the store');
  } finally { rm(dir); }
});

test('#3: restoreFromSnapshot VERIFIES before publishing — a corrupt blob never clobbers toPath', () => {
  const dir = tmp();
  try {
    const snapDir = path.join(dir, 'snaps');
    const src = write(dir, 'orig.txt', Buffer.from('the true original content'));
    const snap = snapshotSource(src, snapDir);
    fs.writeFileSync(snap.snapshotPath, Buffer.from('CORRUPTED — no longer hashes to its name')); // bit-rot / tamper
    const toPath = write(dir, 'recover-here.txt', Buffer.from('PRE-EXISTING good data'));
    const before = fs.readFileSync(toPath);
    const r = restoreFromSnapshot(snap.sha256, toPath, { snapshotDir: snapDir });
    assert.strictEqual(r.ok, false, 'hash mismatch → fail');
    assert.match(r.reason, /mismatch/i);
    assert.strictEqual(r.verified, false, 'BREAK 2: verified is ACCURATE on a mismatch (pre-fix it lyingly returned verified:true on this refusal path)');
    assert.ok(fs.readFileSync(toPath).equals(before), 'toPath is NOT overwritten with unverified bytes (copy→verify→rename)');
    assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp')), [], 'the unverified temp was removed');
  } finally { rm(dir); }
});

test('#3: a corrupt-blob restore with toPath === src leaves the SOURCE byte-intact (no self-corruption)', () => {
  const dir = tmp();
  try {
    const snapDir = path.join(dir, 'snaps');
    const src = write(dir, 'live.jsonl', buildJsonl(CLAUDEISH).buf);
    const snap = snapshotSource(src, snapDir);
    const before = sha256File(src);
    fs.writeFileSync(snap.snapshotPath, Buffer.from('CORRUPT'));
    const r = restoreFromSnapshot(snap.sha256, src, { snapshotDir: snapDir }); // restore ONTO the source
    assert.strictEqual(r.ok, false);
    assert.strictEqual(sha256File(src), before, 'the source is byte-identical — a failed verify never touched it');
  } finally { rm(dir); }
});

test('L1 (WAVE-6, restore DESTINATION): a FOREIGN but hash-VALID ref restored to toPath===src is REFUSED when src is declared protected — a foreign snapshot never overwrites the live source (the destination sibling of the L3#1 ref guard)', () => {
  const dir = tmp();
  try {
    const snapDir = path.join(dir, 'snaps');
    const src = write(dir, 'live.jsonl', buildJsonl(CLAUDEISH).buf);
    const before = sha256File(src);
    // snapshot a DIFFERENT (foreign) file — a valid, hash-verifiable blob whose content is NOT src's.
    const foreign = write(dir, 'foreign.jsonl', Buffer.from('{"type":"user","message":"totally different bytes"}\n'));
    const fsnap = snapshotSource(foreign, snapDir);
    assert.ok(fsnap.ok && fsnap.sha256, 'the foreign blob snapshotted (a valid hash-named ref)');
    // restore the FOREIGN blob ONTO src, declaring src protected → MUST refuse (pre-fix: ok:true, verified:true,
    // src overwritten — the hash-verify passes because the blob matches its OWN name, never that it is src's content).
    const r = restoreFromSnapshot(fsnap.sha256, src, { snapshotDir: snapDir, src });
    assert.strictEqual(r.ok, false, 'a foreign ref cannot overwrite the protected source');
    assert.match(r.reason, /source|alias/i);
    assert.strictEqual(sha256File(src), before, 'the source is byte-identical — the restore-destination guard held');
    // and the same restore to a SCRATCH toPath (not src) is still allowed + verified
    const scratch = path.join(dir, 'scratch.out');
    const ok = restoreFromSnapshot(fsnap.sha256, scratch, { snapshotDir: snapDir, src, original: foreign });
    assert.strictEqual(ok.ok, true, 'restoring to a scratch path (not the protected src) still works');
    assert.strictEqual(ok.verified, true);
  } finally { rm(dir); }
});

test('#4: a non-positive wave budget (maxLines:0 / maxBytes:0) fails ok:false — no non-progress hang', () => {
  const dir = tmp();
  try {
    const { buf } = buildJsonl(CLAUDEISH);
    const src = write(dir, 'a.jsonl', buf);
    const snap = path.join(dir, 's');
    const rL = reduceFile(src, { cutTypes: ['mode'], outPath: path.join(dir, 'oL.jsonl'), snapshotDir: snap, maxLines: 0 });
    assert.strictEqual(rL.ok, false);
    assert.match(rL.reason, /maxLines/);
    const rB = reduceFile(src, { cutTypes: ['mode'], outPath: path.join(dir, 'oB.jsonl'), snapshotDir: snap, maxBytes: 0 });
    assert.strictEqual(rB.ok, false);
    assert.match(rB.reason, /maxBytes/);
    // reduceToCompletion returns on the FIRST wave (no ~10M re-discover/re-snapshot loop)
    const rC = reduceToCompletion(src, { cutTypes: ['mode'], maxBytes: 0 });
    assert.strictEqual(rC.ok, false);
    assert.strictEqual(rC.waves, 1, 'failed on wave 1, never looped');
    // Infinity stays valid — "one unbounded wave" (Infinity >= 1); do not tighten this to Number.isFinite
    const rInf = reduceFile(src, { cutTypes: ['mode'], outPath: path.join(dir, 'oInf.jsonl'), snapshotDir: path.join(dir, 's2'), maxLines: Infinity, maxBytes: Infinity });
    assert.strictEqual(rInf.ok, true, 'an Infinity budget is a valid single unbounded wave');
  } finally { rm(dir); }
});

test('#5: overlong on a RESUME wave abandons ok:false (not the kept-whole skip), partial remains, outPath consistent', () => {
  const dir = tmp();
  try {
    // >=64 small ndjson lines so DISCOVERY (64-line front sample) classifies ndjson and never sees
    // the giant; then ONE line larger than the 1 MiB read chunk so a LATER (resume) wave trips overlong.
    // WAVE-11: the small section (~627 KiB, 80 × ~8 KB) + the per-wave byte budget (200 KiB) are BOTH sized
    // above the ground-truth re-read floor (CHUNK/CAP = 128 KiB for this > CHUNK file) so the amplification
    // ceiling does NOT preempt — each pre-giant wave advances ~200 KiB ≥ the floor, and the giant is reached
    // (and abandoned as overlong) on a resume wave. A tiny budget (e.g. 2048) is a 512× amplification on a
    // > CHUNK file and is now correctly refused by the floor BEFORE the giant — that is a different (and tested)
    // path, so this test uses a realistic budget to isolate the overlong-on-resume behavior.
    const small = [];
    for (let i = 0; i < 80; i++) small.push(JSON.stringify({ type: i % 2 ? 'mode' : 'user', i, pad: 'x'.repeat(8000) }));
    const giant = JSON.stringify({ type: 'user', big: 'y'.repeat(1200 * 1024) }); // > CHUNK (1 MiB)
    const src = write(dir, 'resume-overlong.jsonl', Buffer.from(small.join('\n') + '\n' + giant + '\n', 'utf8'));
    const out = path.join(dir, 'o.jsonl');
    const snap = path.join(dir, 's');
    const opts = { cutTypes: ['mode'], outPath: out, snapshotDir: snap, maxBytes: 200 * 1024, maxLines: 100000 };
    // wave 1: small byte budget → stops on a boundary BEFORE the giant, publishing a real partial
    const w1 = reduceFile(src, { ...opts, offset: 0, resume: null });
    assert.strictEqual(w1.ok, true);
    assert.strictEqual(w1.structure, 'ndjson', 'discovery saw ndjson (the giant is past the 64-line sample)');
    assert.strictEqual(w1.done, false, 'wave 1 stopped before the giant — more to do');
    assert.ok(fs.existsSync(out), 'a partial reduced file was published by wave 1');
    // drive resume waves until the overlong trips
    let r = w1, guard = 0;
    while (!r.done && r.ok) {
      r = reduceFile(src, { ...opts, offset: r.nextOffset, resume: r.checkpoint });
      if (++guard > 1000) throw new Error('runaway');
    }
    assert.strictEqual(r.ok, false, 'a resume abandoning on a pathological line is ok:false, NOT skipped/opaque');
    assert.strictEqual(r.skipped, false, 'not the kept-whole/untouched skip signal');
    assert.match(r.reason, /abandoned|pathological/i);
    assert.strictEqual(r.outPath, out, 'outPath is reported (the partial that remains), consistent with reduceToCompletion');
    assert.ok(fs.existsSync(out), 'the partial from prior waves remains on disk (source untouched, snapshot backs recovery)');
    // reduceToCompletion agrees: ok:false AND reports the path (not null)
    const o2 = path.join(dir, 'o2.jsonl');
    const rc = reduceToCompletion(src, { cutTypes: ['mode'], outPath: o2, snapshotDir: path.join(dir, 's2'), maxBytes: 200 * 1024, maxLines: 100000 });
    assert.strictEqual(rc.ok, false);
    assert.strictEqual(rc.outPath, o2, 'reduceToCompletion reports the same outPath — no null/path mismatch between the two entry points');
  } finally { rm(dir); }
});

test('#6: an outPath resolving INSIDE the snapshot store is refused (never overwrites a recovery blob/manifest)', () => {
  const dir = tmp();
  try {
    const { buf } = buildJsonl(CLAUDEISH);
    const src = write(dir, 'a.jsonl', buf);
    const before = sha256File(src);
    const snap = path.join(dir, 'snaps');
    // aim the slim copy straight at the recovery manifest
    const rM = reduceFile(src, { cutTypes: ['mode'], outPath: path.join(snap, SNAPSHOT_MANIFEST), snapshotDir: snap });
    assert.strictEqual(rM.ok, false);
    assert.match(rM.reason, /snapshot store|recovery/i);
    // and at a content-blob path inside the store
    const rB = reduceFile(src, { cutTypes: ['mode'], outPath: path.join(snap, 'deadbeef'), snapshotDir: snap });
    assert.strictEqual(rB.ok, false);
    assert.strictEqual(sha256File(src), before, 'source untouched by either refusal');
    // a sibling outPath OUTSIDE the store still works (guard is containment, not name)
    const rOk = reduceFile(src, { cutTypes: ['mode'], outPath: path.join(dir, 'ok.jsonl'), snapshotDir: snap });
    assert.strictEqual(rOk.ok, true, 'a normal outPath beside the store is unaffected');
  } finally { rm(dir); }
});

// ---------------------------------------------------------------------------
// 10. round-3 re-break: torn-write (writeFull), restore-fail-open on a missing
//     store, and uncaught-throw on a non-numeric budget / null opts. Each test
//     FAILS against the raw pre-fix engine (proven non-vacuous by construction).
// ---------------------------------------------------------------------------

test('#r3-1a: writeFull LOOPS a short write to completion — BOM + kept-flush sites, output byte-exact (raw writeSync would tear it)', () => {
  const dir = tmp();
  try {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const src = write(dir, 'bom.jsonl', Buffer.concat([bom, buildJsonl(bigCorpus(60)).buf]));
    // reference: an unfaulted reduce
    const ref = path.join(dir, 'ref.jsonl');
    reduceToCompletion(src, { cutTypes: ['queue-operation'], outPath: ref, snapshotDir: path.join(dir, 's0'), maxLines: 1e9, maxBytes: 1e9 });
    const refBytes = fs.readFileSync(ref);
    // fault: short the FIRST bare-signature writeSync of each distinct size once (the BOM=3B write AND
    // the big kept-flush blob) → a real partial write, no throw. writeFull must loop the remainder.
    const realWrite = fs.writeSync;
    const shortedSizes = new Set();
    fs.writeSync = (fd, data, ...rest) => {
      if (rest.length === 0 && Buffer.isBuffer(data) && data.length >= 2 && !shortedSizes.has(data.length)) {
        shortedSizes.add(data.length);
        return realWrite(fd, data, 0, Math.max(1, Math.floor(data.length / 2))); // half FOR REAL, short count
      }
      return realWrite(fd, data, ...rest);
    };
    const out = path.join(dir, 'o.jsonl');
    let r;
    try { r = reduceToCompletion(src, { cutTypes: ['queue-operation'], outPath: out, snapshotDir: path.join(dir, 's1'), maxLines: 1e9, maxBytes: 1e9 }); }
    finally { fs.writeSync = realWrite; }
    assert.ok(shortedSizes.has(3), 'the 3-byte BOM write (L456 site) was short-written');
    assert.ok(shortedSizes.size >= 2, 'the big kept-flush write (L521 site) was short-written too');
    assert.strictEqual(r.ok, true, 'writeFull looped both remainders → the run succeeds');
    assert.ok(fs.readFileSync(out).equals(refBytes), 'output is COMPLETE + byte-identical to an unfaulted run (raw writeSync would leave a torn BOM + half-flush)');
  } finally { rm(dir); }
});

test('#r3-1b: a ZERO-PROGRESS write (genuine disk-full) at the kept-flush → ok:false, no torn output published, source intact, temp reaped', () => {
  const dir = tmp();
  try {
    const src = write(dir, 'a.jsonl', buildJsonl(bigCorpus(60)).buf);
    const before = sha256File(src);
    const realWrite = fs.writeSync;
    // every big write makes NO progress (returns 0) → writeFull's remainder write hits n<=0 → throws
    fs.writeSync = (fd, data, ...rest) => (Buffer.isBuffer(data) && data.length > 200 ? 0 : realWrite(fd, data, ...rest));
    const out = path.join(dir, 'o.jsonl');
    let threw = null, r = null;
    try { r = reduceToCompletion(src, { cutTypes: ['queue-operation'], outPath: out, snapshotDir: path.join(dir, 's'), maxLines: 1e9, maxBytes: 1e9 }); }
    catch (e) { threw = e; }
    finally { fs.writeSync = realWrite; }
    assert.strictEqual(threw, null, 'the short write surfaces as a CAUGHT fail, not an uncaught throw');
    assert.strictEqual(r.ok, false, 'fail-closed (raw writeSync would publish a truncated file as ok:true)');
    assert.strictEqual(fs.existsSync(out), false, 'NO torn output published');
    assert.strictEqual(sha256File(src), before, 'source byte-intact');
    assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp')), [], 'the temp was reaped');
  } finally { rm(dir); }
});

test('#r3-1c (WAVE-8 update): a json-single NO-OP (type not requested) SKIPS with ZERO writes — proven robust even with fs.writeSync broken (the write path is never reached, no torn file, source intact)', () => {
  const dir = tmp();
  try {
    // WAVE-8 L4-C moved the byte-identical json-single keep to a NO-OP skip BEFORE the snapshot/write, so this
    // spot no longer does a large keep-write; instead we PROVE the skip touches no write at all (a broken >200-byte
    // writeSync would tear/throw if it did). The ndjson torn-write fail-closed guarantee is still covered by #r3-1a/b.
    const pretty = Buffer.from(JSON.stringify({ type: 'keep-me', data: 'x'.repeat(500) }, null, 2), 'utf8'); // > 200 bytes
    const src = write(dir, 'one.json', pretty);
    const before = sha256File(src);
    const realWrite = fs.writeSync;
    fs.writeSync = (fd, data, ...rest) => (Buffer.isBuffer(data) && data.length > 200 ? 0 : realWrite(fd, data, ...rest));
    const out = path.join(dir, 'o.json');
    let threw = null, r = null;
    try { r = reduceFile(src, { cutTypes: ['other'], outPath: out, snapshotDir: path.join(dir, 's') }); } // no match → no-op SKIP (never writes)
    catch (e) { threw = e; }
    finally { fs.writeSync = realWrite; }
    assert.strictEqual(threw, null);
    assert.strictEqual(r.skipped, true, 'a json-single no-op skips before any write — the broken writeSync is never reached');
    assert.strictEqual(fs.existsSync(out), false, 'no output published (skip, not a rewrite)');
    assert.strictEqual(sha256File(src), before, 'source byte-intact');
  } finally { rm(dir); }
});

test('#r3-2: restoreFromSnapshot FAILS CLOSED when snapshotDir is unresolvable (a ../ ref cannot escape a missing store)', () => {
  const dir = tmp();
  try {
    const secret = write(dir, 'SECRET.txt', Buffer.from('TOP SECRET outside the store'));
    const missing = path.join(dir, 'store', 'nested', 'gone'); // does NOT exist
    const toPath = path.join(dir, 'exfil.txt');
    const rel = path.relative(missing, secret).replace(/\\/g, '/'); // ../../../SECRET.txt
    const r = restoreFromSnapshot(rel, toPath, { snapshotDir: missing });
    assert.strictEqual(r.ok, false, 'unresolvable store → refuse (was fail-OPEN: skipped containment when baseReal was null)');
    assert.match(r.reason, /unresolvable|contained|traversal|escapes/i);
    assert.strictEqual(fs.existsSync(toPath), false, 'nothing copied out');
    // control: an EXISTING store still refuses the ../ ref
    const realStore = path.join(dir, 'realstore'); fs.mkdirSync(realStore, { recursive: true });
    const r2 = restoreFromSnapshot(path.relative(realStore, secret).replace(/\\/g, '/'), path.join(dir, 'e2.txt'), { snapshotDir: realStore });
    assert.strictEqual(r2.ok, false, 'existing-store traversal still refused');
    // and a LEGIT in-store ref still restores byte-exact
    const s = write(dir, 's.jsonl', buildJsonl(CLAUDEISH).buf);
    const snap = snapshotSource(s, realStore);
    const restored = path.join(dir, 'restored.jsonl');
    const r3 = restoreFromSnapshot(snap.sha256, restored, { snapshotDir: realStore, original: s });
    assert.strictEqual(r3.ok, true, 'a legit in-store ref still restores');
    assert.ok(fs.readFileSync(restored).equals(buildJsonl(CLAUDEISH).buf), 'byte-exact');
  } finally { rm(dir); }
});

test('#r3-3: a non-numeric budget (Symbol / valueOf-throws) and null opts → ok:false, never an uncaught throw', () => {
  const dir = tmp();
  try {
    const src = write(dir, 'a.jsonl', buildJsonl(CLAUDEISH).buf);
    const cases = [
      ['reduceFile maxLines=Symbol', () => reduceFile(src, { cutTypes: ['mode'], maxLines: Symbol('x') })],
      ['reduceFile maxBytes=Symbol', () => reduceFile(src, { cutTypes: ['mode'], maxBytes: Symbol('y') })],
      ['reduceFile maxLines=valueOf-throws', () => reduceFile(src, { cutTypes: ['mode'], maxLines: { valueOf() { throw new Error('boom'); } } })],
      ['reduceToCompletion(src, null)', () => reduceToCompletion(src, null)],
      ['reduceToCompletion maxBytes=Symbol', () => reduceToCompletion(src, { cutTypes: ['mode'], maxBytes: Symbol('z') })],
    ];
    for (const [label, fn] of cases) {
      let threw = null, r = null;
      try { r = fn(); } catch (e) { threw = e; }
      assert.strictEqual(threw, null, `${label} must NOT throw out of the API (typeof short-circuits before the >=1 coercion)`);
      assert.ok(r && typeof r.ok === 'boolean', `${label} returns a result object`);
    }
    // the budget cases are specifically ok:false (reduceToCompletion(null) is a valid no-op measure)
    assert.strictEqual(reduceFile(src, { cutTypes: ['mode'], maxBytes: Symbol('q') }).ok, false);
  } finally { rm(dir); }
});

test('#r4: a resume wave with a non-finite outLen (missing/NaN/Infinity/{}/null) REFUSES ok:false — the committed output is NOT truncated', () => {
  const dir = tmp();
  try {
    const src = write(dir, 'a.jsonl', buildJsonl(bigCorpus(200)).buf);
    const out = path.join(dir, 'o.jsonl');
    const opts = { cutTypes: ['queue-operation'], outPath: out, snapshotDir: path.join(dir, 's'), maxLines: 50 };
    // wave 1: publishes a real partial committed output + a valid checkpoint
    const w1 = reduceFile(src, { ...opts, offset: 0, resume: null });
    assert.strictEqual(w1.done, false, 'wave 1 leaves more to do');
    const committed = fs.readFileSync(out);
    assert.ok(committed.length > 0, 'wave 1 committed a partial output');
    const srcHash = sha256File(src);
    // a corrupt/forged checkpoint on a resume (offset>0) whose outLen is not finite must REFUSE and
    // leave the committed output byte-UNCHANGED (the pre-fix coerce-to-0 would truncateSync(out, 0)).
    const corrupt = [
      { ...w1.checkpoint, outLen: undefined },
      { ...w1.checkpoint, outLen: NaN },
      { ...w1.checkpoint, outLen: Infinity },
      { ...w1.checkpoint, outLen: -Infinity },
      { srcOffset: w1.nextOffset, structure: 'ndjson' }, // outLen missing entirely ({})
      null, // no checkpoint at all with offset>0
    ];
    for (const ck of corrupt) {
      const r = reduceFile(src, { ...opts, offset: w1.nextOffset, resume: ck });
      assert.strictEqual(r.ok, false, `resume with outLen=${ck && ck.outLen} must refuse fail-closed`);
      assert.match(r.reason, /finite outLen|corrupt|forged/i);
      assert.ok(fs.readFileSync(out).equals(committed), 'the committed output was NOT truncated (pre-fix coerce-to-0 wipes it)');
    }
    assert.strictEqual(sha256File(src), srcHash, 'source byte-intact throughout');
    // CONTROL: a LEGIT resume (finite in-range outLen) still appends to completion, byte-exact
    let r = w1, guard = 0;
    while (!r.done && r.ok) { r = reduceFile(src, { ...opts, offset: r.nextOffset, resume: r.checkpoint }); if (++guard > 1000) throw new Error('runaway'); }
    assert.strictEqual(r.ok, true, 'a valid resume chain completes');
    const ref = path.join(dir, 'ref.jsonl');
    reduceToCompletion(src, { cutTypes: ['queue-operation'], outPath: ref, snapshotDir: path.join(dir, 's2'), maxLines: 1e9, maxBytes: 1e9 });
    assert.ok(fs.readFileSync(out).equals(fs.readFileSync(ref)), 'the completed valid-resume output is byte-identical to a single-pass reduce');
  } finally { rm(dir); }
});

// ---------------------------------------------------------------------------
// 11. IC-PIN FIX ROUND 3 (3rd destruction-ladder wave — SYSTEMIC/root fixes,
//     not route patches). FIX 1-R3 manifest safe-by-construction · FIX 2-R3
//     scanWave EOF-not-overlong (the byte-exact core). Each FAILS against the
//     pre-fix engine (proven non-vacuous by construction).
// ---------------------------------------------------------------------------

test('FIX 1-R3 (manifest safe-BY-CONSTRUCTION) — snapshotSource never writes through src when <snapshotDir>/manifest.jsonl is a HARDLINK to src (the ino:0 hole where the dev/ino + realpath belts self-disable); a fresh run still records its row', (t) => {
  const dir = tmp();
  const realStat = fs.statSync;
  const realFstat = fs.fstatSync;
  try {
    // (A) THE ROOT PROPERTY — snapshotSource has NO alias guard (it is the LAST line; the belts live in
    //     reduceFile/detonate and self-disable on an ino:0 volume). Pre-place manifest.jsonl AS A HARDLINK
    //     to src; the old appendFileSync would follow it straight INTO src. The temp→rename keeps src intact.
    const src = write(dir, 'src.jsonl', buildJsonl(CLAUDEISH).buf);
    const snap = path.join(dir, 'snap'); fs.mkdirSync(snap);
    const manifestLink = path.join(snap, SNAPSHOT_MANIFEST);
    try { fs.linkSync(src, manifestLink); } catch (e) { t.skip(`hardlink unavailable (${e.code})`); return; }
    const before = sha256File(src);
    const s1 = snapshotSource(src, snap);
    assert.strictEqual(s1.ok, true, 'snapshot succeeded');
    assert.strictEqual(sha256File(src), before, 'SOURCE BYTE-INTACT — the temp→rename never wrote through the hardlinked manifest into src');
    assert.match(fs.readFileSync(manifestLink, 'utf8'), new RegExp(s1.sha256), 'the manifest recorded this run\'s row (sha present)');

    // (B) END-TO-END under a simulated ino:0 volume: force stat/fstat ino to 0 so the reduceFile FLOOR belt
    //     (collidesWithSource dev/ino) self-disables AND realpath is hardlink-blind → the flow REACHES
    //     snapshotSource, whose construction is now the load-bearing guard. src OUTSIDE snapshotDir.
    const src2 = write(dir, 'src2.jsonl', buildJsonl(CLAUDEISH).buf);
    const snap2 = path.join(dir, 'snap2'); fs.mkdirSync(snap2);
    try { fs.linkSync(src2, path.join(snap2, SNAPSHOT_MANIFEST)); } catch (e) { t.skip(`hardlink unavailable (${e.code})`); return; }
    const before2 = sha256File(src2);
    // ino-unreporting volume. The guard reads BIGINT stats (win32 NTFS ids exceed
    // 2^53 — see the TP-1 test), so the stub must zero the field in the SAME
    // precision the caller asked for, else `0 !== 0n` leaves the belt armed and
    // this test stops simulating the ino:0 hole it exists to cover.
    const zeroIno = (s, a) => { s.ino = (a[0] && a[0].bigint) ? 0n : 0; return s; };
    fs.statSync = function (p, ...a) { return zeroIno(realStat.call(this, p, ...a), a); };
    fs.fstatSync = function (fd, ...a) { return zeroIno(realFstat.call(this, fd, ...a), a); };
    let rRed;
    try { rRed = reduceFile(src2, { cutTypes: ['mode'], outPath: path.join(dir, 'out2.jsonl'), snapshotDir: snap2 }); }
    finally { fs.statSync = realStat; fs.fstatSync = realFstat; }
    assert.strictEqual(rRed.ok, true, 'the belts self-disabled on ino:0 (proving they MISSED the alias) and the run completed via snapshotSource\'s construction');
    assert.strictEqual(sha256File(src2), before2, 'SOURCE BYTE-INTACT end-to-end — snapshotSource\'s temp→rename saved it when the belts could not (pre-fix the append followed the hardlink into src2)');

    // (C) a NORMAL run (no alias) still records rows — two snapshots → two manifest lines (read-existing + write + rename accumulates)
    const clean = path.join(dir, 'clean-snap');
    const a = write(dir, 'a.jsonl', buildJsonl(CLAUDEISH).buf);
    const b = write(dir, 'b.jsonl', buildJsonl([{ type: 'mode' }, { type: 'user', message: { content: 'x' } }]).buf);
    snapshotSource(a, clean);
    snapshotSource(b, clean);
    const rows = fs.readFileSync(path.join(clean, SNAPSHOT_MANIFEST), 'utf8').split('\n').filter(Boolean);
    assert.strictEqual(rows.length, 2, 'a fresh manifest accumulates a row per snapshot');
    for (const line of rows) JSON.parse(line); // each row is valid JSON
  } finally {
    fs.statSync = realStat; fs.fstatSync = realFstat;
    rm(dir);
  }
});

test('FIX 2-R3 (EOF-not-overlong) — a final line with NO trailing newline whose bytes EXCEED a small maxBytes (but the prefix is under it) is KEPT/CUT BYTE-EXACT, ok:true, NOT skipped:true (pre-fix scanWave misclassified it as a pathological oversized unit)', () => {
  const dir = tmp();
  try {
    const prefix = { type: 'mode', v: 'plan' };                                // ~24 bytes
    const finalBig = { type: 'user', message: { content: 'z'.repeat(300) } };  // ~340 bytes, NO trailing \n
    const { lines } = buildJsonl([prefix, finalBig], { finalNoEol: true });
    const src = write(dir, 'noeol.jsonl', Buffer.concat(lines));
    const maxBytes = 100; // prefix(24) < 100 < finalBig(~340) — the exact band FIX 2-R3 unbreaks
    // (a) KEEP the final unit (cut only the prefix's type)
    const outKeep = path.join(dir, 'keep.jsonl');
    const rk = reduceToCompletion(src, { cutTypes: ['mode'], outPath: outKeep, snapshotDir: path.join(dir, 's1'), maxBytes });
    assert.strictEqual(rk.ok, true, 'ok:true — the final no-newline line is a legit unit, not pathological');
    assert.notStrictEqual(rk.skipped, true, 'NOT the opaque/skipped bail (the FIX 2-R3 regression — pre-fix this was skipped:true)');
    assert.strictEqual(rk.structure, 'ndjson', 'stays ndjson (pre-fix the overlong forced opaque)');
    assert.ok(fs.readFileSync(outKeep).equals(lines[1]), 'the final no-newline unit survives BYTE-EXACT (terminator-free bytes verbatim)');
    // (b) CUT the final unit (its type is requested) → removed byte-exact, prefix kept
    const outCut = path.join(dir, 'cut.jsonl');
    const rc = reduceToCompletion(src, { cutTypes: ['user'], outPath: outCut, snapshotDir: path.join(dir, 's2'), maxBytes });
    assert.strictEqual(rc.ok, true);
    assert.strictEqual(rc.unitsCut, 1, 'the final no-newline unit IS cuttable when its type is requested');
    assert.ok(fs.readFileSync(outCut).equals(lines[0]), 'only the prefix survives, byte-exact');
  } finally { rm(dir); }
});

test('FIX 2-R3 core-integrity — a real-shaped multi-line ndjson file whose FINAL unit has no newline AND exceeds a tiny maxBytes reduces BYTE-IDENTICAL across tiny vs single-wave (the wave loop stays byte-exact after the EOF-overlong fix; pre-fix the tiny-wave run abandoned on the final unit)', () => {
  const dir = tmp();
  try {
    // bigCorpus(60) (~5.6 KB) + a ~540B final no-newline unit: still forces >10 tiny-maxBytes waves and reaches the
    // final >maxBytes unit on a RESUME wave, WITHOUT the pathological re-read the amplification ceiling now refuses
    // (WAVE-13 L4: maxBytes:200 on the old ~26 KB corpus was a 72× grind = correctly refused; the byte-exactness this
    // test proves needs many waves, not a giant corpus). Final unit stays > maxBytes:200 → the EOF-overlong path fires.
    const objs = [...bigCorpus(60), { type: 'user', message: { content: 'z'.repeat(500) } }]; // final unit ~540B
    const { buf, lines } = buildJsonl(objs, { finalNoEol: true }); // final unit has NO trailing newline
    const src = write(dir, 'shape.jsonl', buf);
    const cut = ['queue-operation'];
    // single wave (reference) — the final unit emits at EOF regardless (carry < 1e9)
    const ref = path.join(dir, 'ref.jsonl');
    const rRef = reduceToCompletion(src, { cutTypes: cut, outPath: ref, snapshotDir: path.join(dir, 's0'), maxLines: 1e9, maxBytes: 1e9 });
    assert.strictEqual(rRef.ok, true);
    // tiny byte budget → MANY waves; the >maxBytes final no-newline unit is reached on a RESUME wave and
    // must emit byte-exact at EOF (pre-fix: overlong on the resume wave → ok:false abandoned).
    const tiny = path.join(dir, 'tiny.jsonl');
    const rTiny = reduceToCompletion(src, { cutTypes: cut, outPath: tiny, snapshotDir: path.join(dir, 's1'), maxBytes: 200 });
    assert.strictEqual(rTiny.ok, true, 'the tiny-wave run COMPLETES (pre-fix it abandoned on the final >maxBytes unit)');
    assert.ok(rTiny.waves > 10, `expected many waves, got ${rTiny.waves}`);
    assert.ok(fs.readFileSync(tiny).equals(fs.readFileSync(ref)), 'tiny-wave reduction is byte-identical to the single-pass reduction');
    assert.ok(fs.readFileSync(tiny).equals(expectKept(lines, objs, 'type', cut)), 'and byte-identical to the independently-computed kept set');
  } finally { rm(dir); }
});

// ---------------------------------------------------------------------------
// WAVE-5 IC-pin — the CLASS: a guard placed at the wrong LAYER (only in callers,
// not the exported primitive) fails OPEN under a direct call. Every exported
// primitive must SELF-guard.
// ---------------------------------------------------------------------------

test('L1 (WAVE-5 source-sacred) — snapshotSource SELF-GUARDS: a src resolving INSIDE snapshotDir (named manifest.jsonl at dirname==snapshotDir) is REFUSED and the source stays byte-intact (guard in the primitive, not only its callers)', () => {
  const dir = tmp();
  try {
    const snapDir = path.join(dir, 'snap');
    fs.mkdirSync(snapDir, { recursive: true });
    // src IS the manifest path: basename manifest.jsonl, dirname == snapshotDir. reduceFile/detonate refuse
    // this at their floor/belt, but a DIRECT snapshotSource call must self-refuse — else the manifest
    // temp→rename REPLACES src with existing+row (source corruption reported ok:true).
    const src = path.join(snapDir, SNAPSHOT_MANIFEST);
    const original = Buffer.from('{"type":"user","message":"real conversation content"}\n', 'utf8');
    fs.writeFileSync(src, original);
    const before = sha256File(src);
    const r = snapshotSource(src, snapDir);
    assert.strictEqual(r.ok, false, 'a direct snapshotSource call with src inside the store is refused (pre-fix: ok:true after corrupting src)');
    assert.match(r.reason, /inside the snapshot store/i);
    assert.ok(fs.readFileSync(src).equals(original), 'the source bytes are UNCHANGED — no manifest/blob write reached the source');
    assert.strictEqual(sha256File(src), before, 'source sha unchanged');
  } finally { rm(dir); }
});

test('L3#1 (WAVE-5 restore fail-OPEN) — an ABSOLUTE ref OUTSIDE the declared snapshotDir is REFUSED, never read+published unverified (the store boundary binds absolute refs too); an absolute ref INSIDE the store still restores + verifies', () => {
  const dir = tmp();
  try {
    const snapDir = path.join(dir, 'snap');
    fs.mkdirSync(snapDir, { recursive: true });
    // an arbitrary file OUTSIDE the store — pre-fix an absolute ref took the else-branch, was copied to
    // toPath UNVERIFIED (ok:true, verified:false) = a read-anything-to-toPath exfil vector.
    const secret = write(dir, 'secret.txt', Buffer.from('TOP SECRET — outside the store\n'));
    assert.ok(path.isAbsolute(secret));
    const toPath = path.join(dir, 'exfil.out');
    const r = restoreFromSnapshot(secret, toPath, { snapshotDir: snapDir });
    assert.strictEqual(r.ok, false, 'an absolute ref escaping the declared store is refused (pre-fix: ok:true, exfiltrated)');
    assert.match(r.reason, /escapes the store|traversal|out-of-store|unresolvable/i);
    assert.ok(!fs.existsSync(toPath), 'nothing was exfiltrated to toPath');
    // control: a legit absolute ref INSIDE the store still restores AND is hash-verified (no regression)
    const src = write(dir, 's.jsonl', buildJsonl(CLAUDEISH).buf);
    const snap = snapshotSource(src, snapDir);
    assert.strictEqual(snap.ok, true);
    assert.ok(path.isAbsolute(snap.snapshotPath) && snap.snapshotPath.startsWith(snapDir), 'the snapshot blob path is absolute + inside the store');
    const r2 = restoreFromSnapshot(snap.snapshotPath, path.join(dir, 'ok.out'), { snapshotDir: snapDir, original: src });
    assert.strictEqual(r2.ok, true, 'an absolute ref INSIDE the store still restores');
    assert.strictEqual(r2.verified, true, 'and is hash-verified (basename is the sha)');
  } finally { rm(dir); }
});

// ---------------------------------------------------------------------------
// WAVE-7 IC-pin — the TWO-LAYER root closed: every EXPORTED PRIMITIVE self-guards
// its own inputs fail-closed (no longer trusting the detonate wrapper). Hardened
// at the raw layer: reduceFile / reduceToCompletion / restoreFromSnapshot. Each
// FAILS against the pre-fix engine (proven non-vacuous by construction).
// ---------------------------------------------------------------------------

// A > 1 MiB (CHUNK) ndjson fixture: many small typed units so the front sample sees ndjson AND the file spans
// several read chunks (needed to exercise the size-relative re-read floor at the raw layer).
function bigNdjson(dir, name, { units = 18000, type = 'user' } = {}) {
  const objs = [];
  for (let i = 0; i < units; i++) objs.push({ type, i, pad: 'y'.repeat(40) });
  const { buf } = buildJsonl(objs);
  return { src: write(dir, name, buf), size: buf.length, objs };
}

test('WAVE-7 L1 (BREAK 1): restoreFromSnapshot INTRINSICALLY refuses to clobber a populated toPath (incl. the live source) with NO opt-in src context; a fresh dest is unaffected; force:true is the explicit override', () => {
  const dir = tmp();
  try {
    const snapDir = path.join(dir, 'snap');
    const src = write(dir, 'live.jsonl', buildJsonl(CLAUDEISH).buf);
    const before = sha256File(src);
    const foreign = write(dir, 'foreign.jsonl', Buffer.from('{"type":"user","message":"totally different bytes"}\n'));
    const fsnap = snapshotSource(foreign, snapDir); // a foreign but hash-VALID blob
    // (a) restore the foreign blob ONTO the source with src OMITTED (the pre-fix opt-in bypass) → the INTRINSIC
    //     clobber guard refuses (pre-fix: ok:true, verified:true, source overwritten).
    const r = restoreFromSnapshot(fsnap.sha256, src, { snapshotDir: snapDir }); // NO src, NO force
    assert.strictEqual(r.ok, false, 'a populated destination (the live source) is not clobbered without force, even with src omitted');
    assert.strictEqual(r.verified, false, 'refused → verified false');
    assert.match(r.reason, /overwrite|clobber|non-empty|exists/i);
    assert.strictEqual(sha256File(src), before, 'source byte-identical — the intrinsic guard held with NO opt-in context');
    // (b) a FRESH scratch dest is unaffected (no false-refuse) and IS verified
    const fresh = path.join(dir, 'fresh.out');
    const rFresh = restoreFromSnapshot(fsnap.sha256, fresh, { snapshotDir: snapDir, original: foreign });
    assert.strictEqual(rFresh.ok, true, 'restoring to a fresh path still works (the guard bites only a populated dest)');
    assert.strictEqual(rFresh.verified, true);
    // (c) force:true is the explicit override (calibrated, not lock-tight)
    const populated = write(dir, 'populated.out', Buffer.from('stale bytes to be replaced'));
    const rForce = restoreFromSnapshot(fsnap.sha256, populated, { snapshotDir: snapDir, force: true, original: foreign });
    assert.strictEqual(rForce.ok, true, 'force:true overrides the clobber guard for an intentional overwrite');
    assert.ok(fs.readFileSync(populated).equals(fs.readFileSync(foreign)), 'and publishes the verified bytes');
  } finally { rm(dir); }
});

test('WAVE-7 L4-A (BREAK 3-A): the exported PRIMITIVES self-guard cutTypes — a NON-ARRAY (null/{}/bare string/number/bool), [] and [non-strings] REFUSE (no silent no-op rewrite); an OMITTED cutTypes still defaults', () => {
  const dir = tmp();
  try {
    const src = write(dir, 'a.jsonl', buildJsonl(CLAUDEISH).buf);
    const before = sha256File(src);
    // DIRECT reduceFile calls (the raw primitive, NOT via detonate): every malformed / empty cut-list refuses
    for (const [i, bad] of [null, {}, 'mode', 42, true, [], [123, {}]].entries()) {
      const out = path.join(dir, `o-${i}.jsonl`);
      const r = reduceFile(src, { cutTypes: bad, outPath: out, snapshotDir: path.join(dir, `s-${i}`) });
      assert.strictEqual(r.ok, false, `reduceFile cutTypes=${JSON.stringify(bad)} must refuse (pre-fix: filtered to [] and ran ok:true, a byte-identical no-op rewrite)`);
      assert.match(r.reason, /cutTypes|cut-list|cut-types/i);
      assert.strictEqual(fs.existsSync(out), false, 'nothing written on a malformed cut-list');
    }
    // reduceToCompletion propagates the primitive's refusal (the driver is guarded too)
    const rc = reduceToCompletion(src, { cutTypes: null, outPath: path.join(dir, 'oc.jsonl'), snapshotDir: path.join(dir, 'sc') });
    assert.strictEqual(rc.ok, false, 'reduceToCompletion inherits the primitive cutTypes guard');
    // an OMITTED cutTypes still applies the factory default (convenience preserved — only undefined defaults)
    const rDef = reduceFile(src, { outPath: path.join(dir, 'def.jsonl'), snapshotDir: path.join(dir, 'sdef') });
    assert.strictEqual(rDef.ok, true, 'omitted cutTypes → the factory default (still works)');
    assert.strictEqual(rDef.unitsCut, CLAUDE_DEFAULT_CUT_TYPES.length, 'the 2 default UI-state types are cut (A4-rescoped pair)');
    assert.strictEqual(sha256File(src), before, 'source byte-intact throughout');
  } finally { rm(dir); }
});

test('WAVE-7 L4-B (BREAK 3-B): reduceToCompletion refuses a sub-CHUNK budget that would re-read-explode on a > CHUNK file (maxBytes:1 AND maxLines:2), FAST (no hang); a tiny budget on a TINY file still passes (size-RELATIVE); a legit sub-CHUNK budget on the big file works', () => {
  const dir = tmp();
  try {
    const { src, size } = bigNdjson(dir, 'big.jsonl');
    assert.ok(size > (1 << 20), `fixture spans multiple chunks (${size} bytes)`);
    const t0 = Date.now();
    // (a) maxBytes:1 on a > CHUNK file → refused UPFRONT (the O(waves × CHUNK) projection), in milliseconds
    const rB = reduceToCompletion(src, { cutTypes: ['user'], outPath: path.join(dir, 'oB'), snapshotDir: path.join(dir, 'sB'), maxBytes: 1 });
    assert.strictEqual(rB.ok, false, 'maxBytes:1 on a big file is refused (the re-read explosion)');
    assert.match(rB.reason, /re-read|explosion|chunk|too small/i);
    assert.strictEqual(fs.existsSync(path.join(dir, 'oB')), false, 'no output on the upfront refusal');
    // (b) maxLines:2 on the same big file → refused by the content-aware after-wave-1 belt
    const rL = reduceToCompletion(src, { cutTypes: ['user'], outPath: path.join(dir, 'oL'), snapshotDir: path.join(dir, 'sL'), maxLines: 2 });
    assert.strictEqual(rL.ok, false, 'maxLines:2 on a big file is refused (the belt caught the tiny per-wave drain)');
    assert.match(rL.reason, /re-read|explosion|chunk|too small/i);
    assert.strictEqual(fs.existsSync(path.join(dir, 'oL')), false, 'the wave-1 partial was cleaned up on the belt refusal');
    assert.ok(Date.now() - t0 < 15000, 'both refusals were FAST — no multi-minute hang (the wave-7 L4 symptom)');
    // (c) size-RELATIVE: a tiny budget on a TINY fixture still passes byte-exact (never absolute-floored)
    const small = write(dir, 'small.jsonl', buildJsonl(CLAUDEISH).buf);
    const refSmall = path.join(dir, 'ref-small.jsonl');
    reduceToCompletion(small, { cutTypes: CLAUDE_DEFAULT_CUT_TYPES, outPath: refSmall, snapshotDir: path.join(dir, 'srs'), maxLines: 1e9, maxBytes: 1e9 });
    for (const [i, bud] of [{ maxBytes: 1 }, { maxBytes: 64 }, { maxLines: 2 }].entries()) {
      const out = path.join(dir, `st-${i}.jsonl`);
      const rSmall = reduceToCompletion(small, { cutTypes: CLAUDE_DEFAULT_CUT_TYPES, outPath: out, snapshotDir: path.join(dir, `sss-${i}`), ...bud });
      assert.strictEqual(rSmall.ok, true, `${JSON.stringify(bud)} on a TINY file still passes (the floor is size-relative, not an absolute maxBytes>=CHUNK)`);
      assert.ok(fs.readFileSync(out).equals(fs.readFileSync(refSmall)), 'and is byte-identical to a single-pass reduce');
    }
    // (d) a legit sub-CHUNK budget on the BIG file (projection under the cap) still runs to completion byte-exact
    const refBig = path.join(dir, 'ref-big.jsonl');
    reduceToCompletion(src, { cutTypes: ['user'], outPath: refBig, snapshotDir: path.join(dir, 'srb'), maxLines: 1e9, maxBytes: 1e9 });
    const bigOut = path.join(dir, 'big-out.jsonl');
    const rBig = reduceToCompletion(src, { cutTypes: ['user'], outPath: bigOut, snapshotDir: path.join(dir, 'sbb'), maxBytes: 512 * 1024 });
    assert.strictEqual(rBig.ok, true, 'a sub-CHUNK-but-safe budget (512 KiB) on the big file still runs');
    assert.ok(rBig.waves > 1, 'it drove multiple waves');
    assert.ok(fs.readFileSync(bigOut).equals(fs.readFileSync(refBig)), 'byte-identical to the single-pass reduce');
  } finally { rm(dir); }
});

test('WAVE-8 L4-C (data-level no-op = SKIP, both structures): reduceToCompletion whose cut-types are ALL ABSENT skips (ok:true, skipped:true, NO output) on ndjson AND json-single — never a byte-identical no-op rewrite; a dry-run still reports', () => {
  const dir = tmp();
  try {
    const src = write(dir, 'a.jsonl', buildJsonl(CLAUDEISH).buf);
    const before = sha256File(src);
    const out = path.join(dir, 'o.jsonl');
    // (a) ndjson EXECUTE, all-absent → SKIP + no output (pre-fix-7: ok:true byte-identical copy; fix-7: ok:false refuse)
    const r = reduceToCompletion(src, { cutTypes: ['ghost', 'nosuchtype'], outPath: out, snapshotDir: path.join(dir, 's') });
    assert.strictEqual(r.skipped, true, 'an all-absent ndjson execute is a no-op skip (uniform with the opaque skip)');
    assert.strictEqual(r.unitsCut, 0);
    assert.match(r.reason, /nothing to cut|present|no-op/i);
    assert.strictEqual(fs.existsSync(out), false, 'the no-op output was not published (cleaned up)');
    assert.strictEqual(sha256File(src), before, 'source untouched');
    // (b) a DRY-RUN of the same request still reports (measures, never skips-as-no-op)
    const dry = reduceToCompletion(src, { cutTypes: ['ghost'] });
    assert.strictEqual(dry.ok, true, 'a dry-run of an all-absent request still reports (preview)');
    assert.strictEqual(dry.unitsCut, 0);
    // (c) json-single non-matching type → SKIP too (fix-7's ndjson-only carve-out was too narrow — a byte-identical
    //     rewrite is not a legitimate "extract" on any structure)
    const pretty = Buffer.from(JSON.stringify({ type: 'server-notice', msg: 'x' }, null, 2), 'utf8');
    const one = write(dir, 'one.json', pretty);
    const outOne = path.join(dir, 'one.out');
    const rOne = reduceToCompletion(one, { cutTypes: ['other'], outPath: outOne, snapshotDir: path.join(dir, 's1') });
    assert.strictEqual(rOne.skipped, true, 'json-single all-absent is a no-op skip too (no byte-identical rewrite)');
    assert.strictEqual(fs.existsSync(outOne), false, 'no wasteful copy published for the json-single no-op');
  } finally { rm(dir); }
});

// ---------------------------------------------------------------------------
// WAVE-8 regressions (the 3 fix clusters). Each FAILS without its fix.
// ---------------------------------------------------------------------------

test('WAVE-8 L3 (resume anchor — offset↔outLen): a checkpoint whose offset + outLen are each individually valid but MUTUALLY inconsistent (offset jumped ahead of the honest outLen) is REFUSED — no silent record drop/dup at the seam', () => {
  const dir = tmp();
  try {
    const objs = bigCorpus(120);
    const { buf } = buildJsonl(objs);
    const src = write(dir, 'sess.jsonl', buf);
    const out = path.join(dir, 'out.jsonl');
    const opts = { cutTypes: ['queue-operation'], outPath: out, snapshotDir: path.join(dir, 's'), maxLines: 15 };
    // wave 1 → honest partial (output size == checkpoint.outLen) + a REAL checkpoint (real snapshotPath)
    const w1 = reduceFile(src, { ...opts, offset: 0, resume: null });
    assert.strictEqual(w1.done, false);
    assert.strictEqual(fs.statSync(out).size, w1.checkpoint.outLen);
    // a DIFFERENT valid source line boundary FURTHER into the file (the forged offset)
    let laterOffset = w1.nextOffset;
    for (let p = w1.nextOffset, seen = 0; p < buf.length && seen < 20; p++) { if (buf[p] === 0x0a) { seen++; laterOffset = p + 1; } }
    assert.ok(laterOffset > w1.nextOffset, 'found a later line boundary');
    // FORGE: keep the honest output + honest outLen (committed === curOutSize passes), jump the offset ahead. Pre-fix
    // every isolated field check passes → the resume drops records [w1.nextOffset, laterOffset) at the seam, ok:true.
    const r = reduceFile(src, { ...opts, offset: laterOffset, resume: w1.checkpoint });
    assert.strictEqual(r.ok, false, 'a mutually-inconsistent (offset, outLen) checkpoint is refused (pre-fix: ok:true, records silently dropped)');
    assert.match(r.reason, /inconsistent|reduces to|seam/i);
    // CONTROL: the HONEST checkpoint (offset == w1.nextOffset) still resumes fine — the anchor never blocks a real resume
    const r2 = reduceFile(src, { ...opts, offset: w1.nextOffset, resume: w1.checkpoint });
    assert.strictEqual(r2.ok, true, 'the honest resume is unaffected by the anchor');
  } finally { rm(dir); }
});

test('WAVE-8 L-META (resume anchor — source-desync): a source REWRITTEN between the checkpoint and the resume (length-preserving) is REFUSED — never splices a v1-prefix + v2-suffix into a torn output at ok:true', () => {
  const dir = tmp();
  try {
    const mk = (tag) => buildJsonl(Array.from({ length: 100 }, (_, i) => ({ type: i % 4 === 0 ? 'queue-operation' : 'user', i, tag: `${tag}${i}` }))).buf;
    const src = write(dir, 'sess.jsonl', mk('ORIG'));
    const out = path.join(dir, 'out.jsonl');
    const opts = { cutTypes: ['queue-operation'], outPath: out, snapshotDir: path.join(dir, 's'), maxLines: 20 };
    const w1 = reduceFile(src, { ...opts, offset: 0, resume: null });
    assert.strictEqual(w1.done, false);
    // an external process rewrites the source in place, SAME byte length (cloud-sync / compaction pulls a newer copy)
    const v2 = Buffer.from(fs.readFileSync(src).toString('utf8').replace(/ORIG/g, 'HAKD'), 'utf8');
    assert.strictEqual(v2.length, fs.statSync(src).size, 'the rewrite is length-preserving');
    // CodeQL js/file-system-race (#25) — DISMISSED, and the reason lives here so it is not
    // re-litigated: the read/stat/write trio below is not a check-then-act guard, it IS the
    // simulated external writer this test exists to provoke. `src` lives in a per-test mkdtemp dir
    // that no other actor can name, the suite is single-process, and the stat is an ASSERTION about
    // the replacement buffer's length, not a precondition protecting the write. There is no second
    // writer to race, so there is no flake: a genuine concurrent modification would fail the
    // length assertion loudly rather than corrupt anything. Re-open this if the fixture ever moves
    // to a shared directory or the suite gains intra-file concurrency.
    fs.writeFileSync(src, v2);
    // resume from the byte-exact-correct checkpoint — the source no longer matches the held snapshot
    const r = reduceFile(src, { ...opts, offset: w1.nextOffset, resume: w1.checkpoint });
    assert.strictEqual(r.ok, false, 'a source-desync resume is refused (pre-fix: ok:true, a torn v1+v2 splice)');
    assert.match(r.reason, /source .*changed|snapshot/i);
    assert.strictEqual(fs.statSync(out).size, w1.checkpoint.outLen, 'the committed partial is untouched by the refused resume');
  } finally { rm(dir); }
});

test('WAVE-8 L4-B (budget-floor amplification): a sub-CHUNK budget the OLD fixed 2 GiB projection permitted (but that re-reads many× the filesize) is REFUSED by the filesize-relative amplification cap — FAST, no grind', () => {
  const dir = tmp();
  try {
    const { src, size } = bigNdjson(dir, 'big.jsonl'); // > CHUNK
    assert.ok(size > (1 << 20), `fixture spans multiple chunks (${size} bytes)`);
    const t0 = Date.now();
    // 64 KiB per-wave budget on a > CHUNK file: re-read amplification = CHUNK/64KiB = 16× the filesize. The OLD 2 GiB
    // absolute projection ALLOWED it (~16 × ~1.2 MB ≈ 19 MB ≪ 2 GiB) → it ground through many waves at ok:true; the
    // 8× filesize-relative cap refuses it.
    const r = reduceToCompletion(src, { cutTypes: ['user'], outPath: path.join(dir, 'o'), snapshotDir: path.join(dir, 's'), maxBytes: 64 * 1024 });
    assert.strictEqual(r.ok, false, 'a 64 KiB budget on a > CHUNK file is refused (16× re-read amplification over the 8× cap; pre-fix: ok:true after grinding)');
    assert.match(r.reason, /re-read|explosion|chunk|too small|amplif/i);
    assert.strictEqual(fs.existsSync(path.join(dir, 'o')), false, 'no output published on the refusal');
    assert.ok(Date.now() - t0 < 10000, 'the refusal is fast — no grind');
  } finally { rm(dir); }
});

test('WAVE-8 L4-C (reduceFile data-level no-op): reduceFile with a VALID cut-list matching ZERO records SKIPS (no byte-identical rewrite) on BOTH ndjson AND json-single; json-single takes no snapshot at all', () => {
  const dir = tmp();
  try {
    // ndjson all-absent (single wave) → skipped:true, no output (the wave-1 snapshot stays — streaming can't pre-know cut=0)
    const nd = write(dir, 'nd.jsonl', buildJsonl([{ type: 'user', a: 1 }, { type: 'assistant', b: 2 }]).buf);
    const rn = reduceFile(nd, { cutTypes: ['ghost'], outPath: path.join(dir, 'nd.out'), snapshotDir: path.join(dir, 'nds') });
    assert.strictEqual(rn.skipped, true, 'ndjson all-absent is a no-op skip (pre-fix: ok:true + a byte-identical rewrite)');
    assert.strictEqual(rn.unitsCut, 0);
    assert.strictEqual(fs.existsSync(path.join(dir, 'nd.out')), false, 'no no-op output published (ndjson)');
    // json-single non-matching type → skipped:true, no output AND no snapshot (decided before the snapshot)
    const js = write(dir, 'one.json', Buffer.from(JSON.stringify({ type: 'server-notice', msg: 'x' }, null, 2), 'utf8'));
    const jsSnap = path.join(dir, 'jss');
    const rj = reduceFile(js, { cutTypes: ['ghost'], outPath: path.join(dir, 'one.out'), snapshotDir: jsSnap });
    assert.strictEqual(rj.skipped, true, 'json-single keep-all is a no-op skip (pre-fix: ok:true + a byte-identical copy)');
    assert.strictEqual(rj.unitsCut, 0);
    assert.strictEqual(fs.existsSync(path.join(dir, 'one.out')), false, 'no no-op output published (json-single)');
    assert.strictEqual(fs.existsSync(jsSnap), false, 'json-single no-op takes NO snapshot (zero I/O, uniform with the opaque skip)');
    // CONTROL: a json-single whose type IS requested is a real cut → empty output (the no-op skip never over-fires)
    const jc = write(dir, 'two.json', Buffer.from(JSON.stringify({ type: 'mode', v: 'plan' }, null, 2), 'utf8'));
    const rc = reduceFile(jc, { cutTypes: ['mode'], outPath: path.join(dir, 'two.out'), snapshotDir: path.join(dir, 'jsc') });
    assert.strictEqual(rc.skipped !== true && rc.unitsCut === 1, true, 'a matching json-single is a real cut, not skipped');
    assert.strictEqual(fs.statSync(path.join(dir, 'two.out')).size, 0, 'the matched single record cuts to empty');
  } finally { rm(dir); }
});

test('WAVE-8 (collidesWithSource hardening): the exported guard catches a HARDLINK even called with NO srcFd (a consumer trusting it alone is safe; pre-fix a bare call missed it → fail-open)', (t) => {
  const dir = tmp();
  try {
    const src = write(dir, 'src.bin', Buffer.from('hello'));
    const link = path.join(dir, 'link.bin');
    try { fs.linkSync(src, link); } catch (e) { t.skip(`hardlink unsupported here (${e.code})`); return; }
    // bare call: NO srcFd argument (the fail-open case the hardening closes)
    const detail = collidesWithSource(link, src);
    assert.ok(detail && /hardlink/i.test(detail), 'a bare collidesWithSource(candidate, src) still detects the hardlink (pre-fix: null — fail-open)');
    // a distinct file is NOT flagged
    const other = write(dir, 'other.bin', Buffer.from('world'));
    assert.strictEqual(collidesWithSource(other, src), null, 'a distinct file is not a collision');
  } finally { rm(dir); }
});

// --- IC-PIN WAVE-9 (fix-round-9) — the trusted-loop / streaming-loop / census family ------------------

// Build two same-length versions of an ndjson file differing ONLY by a tag substring, so a torn (spliced)
// multi-wave output is detectable by the presence of the OTHER version's tag in a KEPT unit.
function twoVersions(units = 4000) {
  const mk = (tag) => Array.from({ length: units }, (_, i) =>
    JSON.stringify({ type: i % 2 ? 'mode' : 'keepme', i, tag })).join('\n') + '\n';
  return { v1: Buffer.from(mk('AAAA'), 'utf8'), v2: Buffer.from(mk('BBBB'), 'utf8') };
}

test('WAVE-9 L3 (trusted-loop source-integrity): a source CHANGED mid-loop then REVERTED to the wave-1 snapshot hash before completion is CAUGHT at the wave that reads it — never a torn v1+v2+v1 splice at ok:true; an unmodified-source multi-wave reduce is byte-identical to single-pass', () => {
  const dir = tmp();
  const realOpen = fs.openSync;
  try {
    const { v1, v2 } = twoVersions();
    // CONTROL: an unmodified-source multi-wave reduce == single-pass, all AAAA kept (KEEP DRY — legit path).
    const cSrc = write(dir, 'ctl.jsonl', v1);
    const single = path.join(dir, 'ctl.single'); reduceToCompletion(cSrc, { cutTypes: ['mode'], outPath: single, snapshotDir: path.join(dir, 'cs1'), maxLines: 1e9, maxBytes: 1e9 });
    const many = path.join(dir, 'ctl.many'); const cr = reduceToCompletion(cSrc, { cutTypes: ['mode'], outPath: many, snapshotDir: path.join(dir, 'cs2'), maxLines: 400 });
    assert.strictEqual(cr.ok, true, 'the legit unmodified multi-wave reduce still succeeds');
    assert.ok(Buffer.compare(fs.readFileSync(single), fs.readFileSync(many)) === 0, 'multi-wave == single-pass byte-identical (no false-positive from the incremental check)');
    assert.strictEqual(fs.readFileSync(many, 'utf8').includes('BBBB'), false, 'the legit output is pure v1 (AAAA)');

    // ATTACK: revert-splice. Wave 2 reads v2, then the source reverts to v1 before completion → the OLD
    // end-only whole-file sha check passes (source == snapshot at the end) → torn v1+v2+v1 at ok:true.
    const src = write(dir, 'atk.jsonl', v1);
    const out = path.join(dir, 'atk.out');
    const plan = { 1: 'v2', 2: 'v1' }; // 1st reopen (wave 2) → v2 ; 2nd reopen (wave 3) → revert to v1
    let n = 0;
    fs.openSync = function (p, ...a) {
      if (String(p) === src && a[0] === 'r' && fs.existsSync(out)) { n++; if (plan[n]) fs.writeFileSync(src, plan[n] === 'v2' ? v2 : v1); }
      return realOpen.call(this, p, ...a);
    };
    const r = reduceToCompletion(src, { cutTypes: ['mode'], outPath: out, snapshotDir: path.join(dir, 'as'), maxLines: 400 });
    fs.openSync = realOpen;
    // Post-fix: the incremental per-wave check catches v2 at the wave that reads it → fail-closed, no torn commit.
    assert.strictEqual(r.ok, false, 'the mid-loop change is caught (pre-fix: ok:true with a torn v1+v2+v1 splice)');
    assert.match(r.reason, /source changed mid-reduction|snapshot/i, 'the reason names the source-integrity failure');
    const committed = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
    assert.strictEqual(committed.includes('BBBB'), false, 'NO torn (v2/BBBB) bytes are ever committed to the output');
  } finally { fs.openSync = realOpen; rm(dir); }
});

test('WAVE-9 L4 (cumulative re-read cap): a FRONT-LOADED file (first maxLines records ≥ CHUNK so the wave-1 projections pass, then a tiny tail that re-reads per wave) is aborted FAST by the cumulative counter — the wave-1 estimate alone let it grind thousands of waves', () => {
  const dir = tmp();
  try {
    // First 64 units LARGE (each ~20KB → wave-1 advance ~1.28MB ≥ CHUNK, so the after-wave-1 belt's
    // `advance < CHUNK` guard SKIPS it; maxLines is the limiter so the upfront maxBytes cap skips too) +
    // a tiny tail (each ~re-read per wave). Both wave-1 projections pass → only the cumulative cap catches it.
    const front = Array.from({ length: 64 }, (_, i) => JSON.stringify({ type: 'user', i, pad: 'y'.repeat(20 * 1024) }));
    const tail = Array.from({ length: 30000 }, (_, i) => JSON.stringify({ type: 'mode', i }));
    const src = write(dir, 'front.jsonl', Buffer.from(front.concat(tail).join('\n') + '\n', 'utf8'));
    const size = fs.statSync(src).size;
    assert.ok(size > (1 << 20), `fixture spans multiple chunks (${size} bytes)`);
    const out = path.join(dir, 'front.out');
    const t0 = Date.now();
    const r = reduceToCompletion(src, { cutTypes: ['mode'], outPath: out, snapshotDir: path.join(dir, 's'), maxLines: 64 });
    const elapsed = Date.now() - t0;
    assert.strictEqual(r.ok, false, 'the front-loaded re-read explosion is REFUSED (pre-fix: ok:true after grinding thousands of waves)');
    assert.match(r.reason, /re-read|explosion|amplif/i, 'the reason names the re-read explosion');
    assert.ok(r.waves < 200, `aborted early — ${r.waves} waves, not the thousands the wave-1 projection let through`);
    assert.ok(elapsed < 10000, `fast refusal (${elapsed}ms) — no multi-second grind`);
    assert.strictEqual(fs.existsSync(out), false, 'no partial output left on the refusal');
  } finally { rm(dir); }
});

test('WAVE-10 L4 (≤CHUNK single-chunk re-read cap): a SUB-1MB file with a small maxBytes drove O(size²/budget) re-reads (34× the filesize at ok:true) because every amplification guard was `size > CHUNK`-gated — the path-independent cumulative cap now REFUSES it, and the CHUNK-boundary discontinuity (a just-over-CHUNK file was already refused at the SAME budget) is resolved', () => {
  const dir = tmp();
  try {
    // ~489 KB (< CHUNK = 1 MiB) — the exact size class of the agent-memory files this engine exists to process.
    // Half cuttable (the repro's shape): a small per-wave budget forces ~61 tail waves, each re-reading the whole
    // ≤CHUNK remainder → 16.2 MB read (34× the filesize), reported ok:true PRE-FIX (all three projections skip a
    // ≤CHUNK file). The cumulative counter — now `size > CHUNK`-un-gated with a CAP × max(size, CHUNK) ceiling —
    // aborts it near the same 8-chunk absolute floor a just-over-CHUNK file already hit.
    const objs = [];
    for (let i = 0; i < 4400; i++) objs.push({ type: i % 2 ? 'mode' : 'keep', v: i, pad: 'x'.repeat(80) });
    const { buf } = buildJsonl(objs);
    const src = write(dir, 'sub1mb.jsonl', buf);
    assert.ok(buf.length < (1 << 20) && buf.length > 400 * 1024, `fixture is sub-CHUNK but non-trivial (${buf.length} bytes)`);
    const out = path.join(dir, 'o.jsonl');
    // meter the ACTUAL source bytes read — the O(size²/budget) explosion that was unguarded pre-fix
    const realRead = fs.readSync.bind(fs);
    let readBytes = 0;
    fs.readSync = (...a) => { const n = realRead(...a); if (n > 0) readBytes += n; return n; };
    let r;
    const t0 = Date.now();
    try { r = reduceToCompletion(src, { cutTypes: ['mode'], outPath: out, snapshotDir: path.join(dir, 's'), maxBytes: 8192 }); }
    finally { fs.readSync = realRead; }
    assert.strictEqual(r.ok, false, 'a sub-1MB file + maxBytes:8192 is REFUSED (pre-fix: ok:true after grinding ~34× the filesize)');
    assert.match(r.reason, /re-read|explosion|amplif|budget/i, 'the reason names the re-read explosion');
    // capped near the ≤CHUNK size-relative ceiling 16× filesize ≈ 7.5 MB for this ~470 KB file (the size term always
    // dominated here — 16× filesize ≫ the retired 512 KiB floor, so WAVE-14 L4 removing the floor left this ceiling
    // unchanged), below the 16.2 MB the unguarded ≤CHUNK grind read — the fail-without-fix corroboration of ok:false.
    assert.ok(readBytes < 12 * 1024 * 1024, `bounded re-read: ${(readBytes / 1048576).toFixed(1)}MB — capped, not the ~16MB the unguarded grind read`);
    assert.ok(Date.now() - t0 < 10000, 'fast refusal — no multi-second grind');
    assert.strictEqual(fs.existsSync(out), false, 'no partial output left on the refusal');
    // The FURTHER-pathological budgets (the repro's maxLines:1 / maxBytes:64 = 2207× / 41s cases) are refused too.
    const rTiny = reduceToCompletion(src, { cutTypes: ['mode'], outPath: path.join(dir, 'o2.jsonl'), snapshotDir: path.join(dir, 's2'), maxLines: 1 });
    assert.strictEqual(rTiny.ok, false, 'maxLines:1 on the same sub-1MB file is refused too (the 2207× case)');
  } finally { rm(dir); }
});

test('WAVE-13 L4 (few-KB AUTO-drive size-relative ceiling): a FEW-KB ndjson file at maxLines:1 via reduceToCompletion — which completed ok:true/done:true byte-correct pre-fix while re-reading ~100-340× its OWN size (bounded only by the retired ABSOLUTE 8 MiB = 8 × CHUNK ceiling, which floored every sub-CHUNK file) — is now REFUSED with total re-read bounded to a small constant × FILESIZE (the ceiling is size-relative at every size — purely 16 × filesize in the ≤CHUNK regime; WAVE-14 L4 removed the 512 KiB floor this fixture used to ride). Metered with an independent fs read-counter; a healthy budget on the SAME tiny file still completes ok:true byte-correct', () => {
  const dir = tmp();
  const realRead = fs.readSync.bind(fs);
  try {
    // ~8 KiB ndjson, 1/3 cuttable — the exact shape of the blind red-team repro (w13-L4/REPRO-amplify.mjs).
    const objs = [];
    for (let i = 0; i < 210; i++) objs.push({ type: i % 3 === 0 ? 'drop' : 'keep', i, pad: 'x'.repeat(10) });
    const { buf } = buildJsonl(objs);
    const src = write(dir, 'tiny.jsonl', buf);
    const size = fs.statSync(src).size;
    assert.ok(size > 4 * 1024 && size < 16 * 1024, `few-KB sub-CHUNK fixture (${size} bytes)`);

    // an INDEPENDENT physical-read meter (proves the byte bound, not the engine's self-report)
    let readBytes = 0;
    fs.readSync = (...a) => { const n = realRead(...a); if (typeof n === 'number' && n > 0) readBytes += n; return n; };
    const r = reduceToCompletion(src, { cutTypes: ['drop'], outPath: path.join(dir, 'o.jsonl'), snapshotDir: path.join(dir, 's'), maxLines: 1 });
    fs.readSync = realRead;

    // Post-fix: refused (the maxLines:1 grind is a pathological budget), NOT ok:true after a hundreds× re-read.
    assert.strictEqual(r.ok, false, 'the few-KB maxLines:1 auto-drive is REFUSED (pre-fix: ok:true/done:true after re-reading ~100-340× the filesize under the 8 MiB absolute ceiling)');
    assert.match(r.reason, /re-read|explosion|amplif|budget/i, 'the reason names the re-read amplification');
    // total re-read bounded to a small constant × FILESIZE — ~16× (the ≤CHUNK ceiling) + the ~2× one-time overhead
    // (discovery + snapshot), FAR below the ~900 KB the unbounded grind read on this 8 KB file. WAVE-14 L4 removed the
    // 512 KiB floor this fixture used to ride, so the bound is now PURELY size-relative (tightened from < 1 MiB accordingly).
    assert.ok(readBytes < 32 * size, `bounded re-read: ${(readBytes / 1024).toFixed(0)}KB (${(readBytes / size).toFixed(1)}× filesize) — a small multiple of the ${size}-byte file, not the ~900 KB unbounded grind`);
    assert.strictEqual(fs.existsSync(path.join(dir, 'o.jsonl')), false, 'no partial output left on the refusal');

    // NO false-positive: a HEALTHY budget on the SAME tiny file completes ok:true byte-correct (the ceiling only
    // refuses the pathological grind, never a legitimate reduce of a small file).
    const good = reduceToCompletion(src, { cutTypes: ['drop'], outPath: path.join(dir, 'g.jsonl'), snapshotDir: path.join(dir, 's2') });
    assert.strictEqual(good.ok, true, 'a default-budget reduce of the same tiny file still succeeds ok:true');
    const ref = objs.filter((o) => o.type !== 'drop').map((o) => JSON.stringify(o)).join('\n') + '\n';
    assert.strictEqual(fs.readFileSync(path.join(dir, 'g.jsonl'), 'utf8'), ref, 'the healthy reduce is byte-correct (all non-drop units kept verbatim)');
  } finally { fs.readSync = realRead; rm(dir); }
});

// ---------------------------------------------------------------------------
// WAVE-14 L4 — the ≤CHUNK re-read ceiling is PURELY size-relative (the 512 KiB
// trivial-I/O floor removed). That floor DOMINATED the 16×size term for any
// sub-32 KiB file, so the ceiling was effectively "512 KiB of re-read regardless
// of filesize": a ~4 KB dense file at maxLines:1 completed ok:true/done:true
// after re-reading 131× its OWN size (532 KB), still under the floor. The floor
// I added to spare trivial I/O re-opened the exact hole it sat beside.
// ---------------------------------------------------------------------------

test('WAVE-14 L4 (≤CHUNK ceiling PURELY size-relative — 512 KiB floor removed): a TINY dense ndjson file (254 × ~16 B records, ~4 KB) at maxLines:1 via reduceToCompletion — which completed ok:true/done:true byte-correct pre-fix while re-reading 131× its OWN size (532 KB) because the retired 512 KiB absolute floor DOMINATED the size term for a sub-32 KiB file — is now REFUSED, cumulative re-read bounded at 16× filesize; the SAME file at a sane budget still completes ok:true byte-correct (the fix bites ONLY the pathological budget)', () => {
  const dir = tmp();
  const realRead = fs.readSync.bind(fs);
  try {
    // the blind red-team repro shape (w14-L4/repro.mjs): 254 dense ~16 B records, half 'drop'/half 'keep' → F ≈ 4064 B.
    const N = 254;
    const objs = [];
    for (let i = 0; i < N; i++) objs.push({ type: i % 2 ? 'drop' : 'keep' });
    const { buf, lines } = buildJsonl(objs);
    const src = write(dir, 'tiny.ndjson', buf);
    const F = buf.length;
    assert.ok(F > 2 * 1024 && F < 8 * 1024, `few-KB dense fixture (${F} bytes) — smaller than the retired 512 KiB floor it used to hide under`);
    const before = sha256File(src);

    // an INDEPENDENT physical-read meter (proves the byte bound, not the engine's self-report)
    let readBytes = 0;
    fs.readSync = (...a) => { const n = realRead(...a); if (typeof n === 'number' && n > 0) readBytes += n; return n; };
    const r = reduceToCompletion(src, { cutTypes: ['drop'], outPath: path.join(dir, 'o.ndjson'), snapshotDir: path.join(dir, 's'), maxLines: 1 });
    fs.readSync = realRead;

    // REFUSED, and CLEANLY (pre-fix: ok:true/done:true at 131× the filesize, sitting under the 512 KiB floor).
    assert.strictEqual(r.ok, false, 'the ~4 KB maxLines:1 auto-drive is REFUSED (pre-fix: ok:true/done:true after re-reading 131× the filesize, under the retired 512 KiB floor)');
    assert.strictEqual(r.done, false, 'a refused drive is not "done"');
    assert.match(r.reason, /size-relative re-read ceiling/i, 'an honest reason NAMES the size-relative bound (not an absolute floor)');
    assert.match(r.reason, /16. filesize/, 'and names the 16× filesize ceiling');
    // the engine's cumulative WAVE re-read is bounded at 16× F; the physical fs read adds only the ~2× one-time
    // overhead (discovery sample + snapshot copy), so total < 24× F — categorically below the 131× F (532 KB) the
    // pre-fix floored ceiling permitted at ok:true (the fail-without-fix corroboration: restore the floor → ~131× returns).
    assert.ok(readBytes < 24 * F, `bounded re-read: ${(readBytes / 1024).toFixed(0)}KB (${(readBytes / F).toFixed(1)}× filesize) — the 16× ceiling + one-time overhead, NOT the 131× (532 KB) unbounded-under-the-floor grind`);
    // source intact, no torn/partial output published on the refusal
    assert.strictEqual(sha256File(src), before, 'source byte-identical — the refused drive never mutated it');
    assert.strictEqual(fs.existsSync(path.join(dir, 'o.ndjson')), false, 'no partial output left on the refusal (clean fail-closed)');

    // NO false-positive: the SAME tiny file at SANE budgets completes ok:true byte-correct, re-read UNDER 16× F.
    // (the pathological driver was maxLines:1 = 254 waves; a handful of waves fits the same file well under the ceiling.)
    const ref = expectKept(lines, objs, 'type', ['drop']);
    for (const bud of [{}, { maxLines: 16 }, { maxLines: 64 }]) {
      const d2 = tmp();
      let good = 0;
      fs.readSync = (...a) => { const n = realRead(...a); if (typeof n === 'number' && n > 0) good += n; return n; };
      const rg = reduceToCompletion(src, { cutTypes: ['drop'], outPath: path.join(d2, 'g.ndjson'), snapshotDir: path.join(d2, 's'), ...bud });
      fs.readSync = realRead;
      assert.strictEqual(rg.ok, true, `the SAME ~4 KB file at a sane budget ${JSON.stringify(bud)} still completes ok:true (only the pathological maxLines:1 refuses)`);
      assert.ok(fs.readFileSync(path.join(d2, 'g.ndjson')).equals(ref), 'and is byte-correct (every non-drop unit kept verbatim)');
      assert.ok(good < 16 * F, `and its re-read (${(good / F).toFixed(1)}× filesize) stays UNDER 16× — a legit small reduction is never false-refused`);
      rm(d2);
    }
  } finally { fs.readSync = realRead; rm(dir); }
});

test('WAVE-14 L4 (no-false-positive battery): a range of small files × SANE budgets all complete ok:true byte-correct with re-read UNDER 16× filesize — removing the 512 KiB floor never false-refuses a legitimate small reduction (the key gate: a leniency removed must not start refusing honest work)', () => {
  const dir = tmp();
  const realRead = fs.readSync.bind(fs);
  try {
    const mkCorpus = (n, pad = 30) => { const objs = []; for (let i = 0; i < n; i++) objs.push({ type: i % 3 === 0 ? 'drop' : 'keep', i, pad: 'y'.repeat(pad) }); return objs; };
    // [label, objs, opts] — tens-of-KB down to a few-KB, at default / few-wave maxLines / maxBytes budgets. Each is a
    // handful of honest waves whose re-read falls UNDER 16× filesize naturally (measured 4–7× here), so none rides the
    // retired floor. INCLUDES the exact sub-32 KiB range where the removed floor used to dominate the ceiling.
    const cases = [
      ['20 KB, default budget (1 wave)', mkCorpus(300), {}],
      ['20 KB, maxLines:50 (~7 waves)', mkCorpus(300), { maxLines: 50 }],
      ['40 KB, maxLines:100', mkCorpus(600), { maxLines: 100 }],
      ['40 KB, maxBytes:8192', mkCorpus(600), { maxBytes: 8192 }],
      ['8 KB, maxLines:20', mkCorpus(120), { maxLines: 20 }],
      ['5 KB, maxLines:20', mkCorpus(70), { maxLines: 20 }],
    ];
    cases.forEach(([label, objs, opts], i) => {
      const { buf, lines } = buildJsonl(objs);
      const src = write(dir, `f${i}.jsonl`, buf);
      const size = buf.length;
      const ref = expectKept(lines, objs, 'type', ['drop']);
      const out = path.join(dir, `o${i}.jsonl`);
      let readBytes = 0;
      fs.readSync = (...a) => { const n = realRead(...a); if (typeof n === 'number' && n > 0) readBytes += n; return n; };
      const r = reduceToCompletion(src, { cutTypes: ['drop'], outPath: out, snapshotDir: path.join(dir, `s${i}`), ...opts });
      fs.readSync = realRead;
      assert.strictEqual(r.ok, true, `${label}: a legit small reduction still completes ok:true (the floor removal never false-refuses honest work)`);
      assert.ok(fs.readFileSync(out).equals(ref), `${label}: byte-correct (every non-drop unit kept verbatim)`);
      assert.ok(readBytes < 16 * size, `${label}: re-read ${(readBytes / size).toFixed(1)}× is UNDER 16× filesize (a legit reduce falls under the ceiling naturally, no floor needed)`);
    });
  } finally { fs.readSync = realRead; rm(dir); }
});

test('WAVE-11 L4 (forged/omitted-readAccum resume): a HAND-DRIVEN reduceFile drive that rebuilds `resume` each wave WITHOUT the internal re-read counter (the persist-then-resume shape — a caller who serialized only the load-bearing-LOOKING fields offset/outLen/snapshotPath/structure/bomLen) is now REFUSED ok:false and BOUNDED — the amplification ceiling is derived from the snapshot-verified OFFSET, not a caller-supplied counter it can reset to 0', () => {
  const dir = tmp();
  try {
    // ~189 KiB ndjson, ~1/3 cuttable (the REPRO-forged-checkpoint fixture shape). maxLines:1 → one line per wave →
    // a tiny advance that, IF the caller could reset the re-read counter, would grind O(size²) at ok:true/done:true
    // (measured 8003× filesize / 1477 MiB on this 189 KiB file pre-fix).
    const objs = [];
    for (let i = 0; i < 4000; i++) objs.push({ id: i, type: i % 3 === 0 ? 'cut' : 'keep', payload: 'x'.repeat(10) });
    const { buf } = buildJsonl(objs);
    const src = write(dir, 'victim.jsonl', buf);
    assert.ok(buf.length > 150 * 1024 && buf.length < 256 * 1024, `~189 KiB fixture (${buf.length} bytes)`);
    // an INDEPENDENT physical-read meter (proves the byte bound, not the engine's self-report)
    const realRead = fs.readSync.bind(fs);
    let readBytes = 0;
    fs.readSync = (...a) => { const n = realRead(...a); if (n > 0) readBytes += n; return n; };
    // each rebuilt checkpoint carries ONLY the fields a naive persist-then-resume caller would serialize — NO
    // internal counter (the OMITTED case, byte-for-byte identical to a deliberately FORGED reset).
    const rebuild = (cp) => ({ srcOffset: cp.srcOffset, outLen: cp.outLen, structure: cp.structure, bomLen: cp.bomLen, snapshotPath: cp.snapshotPath });
    let r, tripped = false, guard = 0;
    try {
      const opts = { cutTypes: ['cut'], outPath: path.join(dir, 'out.jsonl'), snapshotDir: path.join(dir, 's'), maxLines: 1 };
      r = reduceFile(src, { ...opts, offset: 0, resume: null });
      while (r.ok && !r.done) {
        r = reduceFile(src, { ...opts, offset: r.nextOffset, resume: rebuild(r.checkpoint) });
        if (!r.ok) { tripped = true; break; }
        if (++guard > 100000) throw new Error('runaway — the guard did NOT fire (unbounded grind, the pre-fix shape)');
      }
    } finally { fs.readSync = realRead; }
    assert.strictEqual(tripped, true, 'the drive is REFUSED (ok:false) — it never runs to ok:true/done:true doing O(size²) work');
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /re-read|amplif|budget|advanced only/i, 'the reason names the re-read amplification ceiling');
    assert.ok(readBytes < 12 * 1024 * 1024, `bounded re-read: ${(readBytes / 1048576).toFixed(2)}MiB — capped, not the ~1477 MiB a caller-reset counter let the pre-fix engine grind`);
  } finally { rm(dir); }
});

test('WAVE-11 L4 (no false-positive): a LEGIT large HAND-DRIVEN multi-wave reduce (a > CHUNK file + a healthy 512 KiB budget → every wave advances well over the 128 KiB floor) still completes ok:true, byte-identical to a single-pass — the ground-truth floor never refuses honest progress', () => {
  const dir = tmp();
  try {
    const objs = [];
    for (let i = 0; i < 30000; i++) objs.push({ type: i % 4 === 0 ? 'mode' : 'user', i, pad: 'z'.repeat(40) });
    const { buf, lines } = buildJsonl(objs);
    const src = write(dir, 'big.jsonl', buf);
    assert.ok(buf.length > (1 << 20), `fixture spans multiple chunks (${buf.length} bytes)`);
    const cut = ['mode'];
    const ref = path.join(dir, 'ref.jsonl');
    reduceToCompletion(src, { cutTypes: cut, outPath: ref, snapshotDir: path.join(dir, 's0'), maxLines: 1e9, maxBytes: 1e9 });
    // hand-driven multi-wave with a healthy 512 KiB budget (advance ≫ the 128 KiB floor)
    const out = path.join(dir, 'out.jsonl');
    const opts = { cutTypes: cut, outPath: out, snapshotDir: path.join(dir, 's1'), maxBytes: 512 * 1024 };
    let r = reduceFile(src, { ...opts, offset: 0, resume: null }), waves = 1, guard = 0;
    while (r.ok && !r.done) {
      r = reduceFile(src, { ...opts, offset: r.nextOffset, resume: r.checkpoint });
      waves++;
      if (++guard > 1000) throw new Error('runaway');
    }
    assert.strictEqual(r.ok, true, 'a healthy-budget hand-driven drive completes ok:true (no false-positive from the amplification floor)');
    assert.strictEqual(r.done, true);
    assert.ok(waves > 1, `drove multiple waves (${waves})`);
    assert.ok(fs.readFileSync(out).equals(fs.readFileSync(ref)), 'byte-identical to the single-pass reduction');
    assert.ok(fs.readFileSync(out).equals(expectKept(lines, objs, 'type', cut)), 'and to the independently-computed kept set');
  } finally { rm(dir); }
});

// --- IC-PIN WAVE-12 (fix-round-12) — the size-relative bare-resume floor (minWaveAdvance recalibration) ---------
// The retired minWaveAdvance formula (`size > CHUNK ? CHUNK/CAP : size²/(CAP·CHUNK)`) was calibrated for the
// TRUSTED loop's CHUNK-per-wave cost but got applied to the BARE (hand-driven) path, whose per-wave cost is ~2×
// the WHOLE source (the L3 anchor re-hashes the source + re-reduces the prefix). So it (a) COLLAPSED below one
// record for a small file (a ~15.5 KB file → a ~29-byte floor → a 1-record advance sailed through → 953× re-read
// at ok:true/done:true) and (b) PINNED to a constant 131072 above CHUNK (an > 2 MiB file at maxBytes:132000 → a
// 132000-byte advance > 131072 → 100×+ re-read at ok:true). The fix bounds the bare resumed-wave COUNT to
// MAX_BARE_RESUME_WAVES (=16) via a SIZE-relative floor ceil(size/16), so total bare re-read ≤ ~2×16 = 32× the
// filesize on EVERY size. Each sub-case FAILS against the pre-fix engine (proven by the metered re-read bound).
test('WAVE-12 L4 (bare-resume re-read explosion — size-relative floor): a hand-driven reduceFile persist-then-resume drive whose per-wave advance falls below ceil(size/16) is REFUSED ok:false and BOUNDED both BELOW CHUNK (the collapsed-floor 953× case) and ABOVE CHUNK (the pinned-floor 103× case); a healthy above-floor drive and a legit overlong record are unaffected', () => {
  const dir = tmp();
  const realRead = fs.readSync.bind(fs);
  // Hand-drive a BARE reduceFile persist-then-resume loop exactly like a naive persist-then-resume caller (feeds
  // back offset + the returned checkpoint), metering physical bytes read via an fs.readSync wrapper.
  const drive = (src, budget, tag) => {
    let readBytes = 0;
    fs.readSync = (...a) => { const k = realRead(...a); if (k > 0) readBytes += k; return k; };
    let r, waves = 0, guard = 0;
    try {
      const opts = { cutTypes: ['mode'], outPath: path.join(dir, `o_${tag}`), snapshotDir: path.join(dir, `s_${tag}`), ...budget };
      r = reduceFile(src, { ...opts, offset: 0, resume: null }); waves = 1;
      while (r.ok && !r.done) {
        r = reduceFile(src, { ...opts, offset: r.nextOffset, resume: r.checkpoint }); waves++;
        if (++guard > 200000) throw new Error('runaway — the floor did NOT fire (the pre-fix O(size²) grind)');
      }
    } finally { fs.readSync = realRead; }
    return { r, waves, readBytes, size: fs.statSync(src).size };
  };
  try {
    // (A) BELOW CHUNK — a ~16 KB file, maxLines:1 (one record per wave, ~39-byte advance). The pre-fix size²
    //     floor collapsed to ~31 bytes (< the record) so a 1-record advance sailed through → ~800× re-read at
    //     ok:true/done:true (the repro's 953× class — record size chosen so N²·recBytes < 8·CHUNK = the collapse zone).
    const small = write(dir, 'small.jsonl', buildJsonl(Array.from({ length: 400 }, (_, i) => ({ type: i % 2 ? 'mode' : 'keep', i, pad: 'x'.repeat(8) }))).buf);
    const a = drive(small, { maxLines: 1 }, 'A');
    assert.ok(a.size < (1 << 20), `case A is a ≤1MB file (${a.size} bytes)`);
    assert.strictEqual(a.r.ok, false, 'a 1-record-per-wave bare drive is REFUSED (pre-fix: the collapsed size² floor let it grind to 953× at ok:true/done:true)');
    assert.match(a.r.reason, /re-read|advanced only|floor|amplif|too small/i);
    assert.ok(a.readBytes < 20 * a.size, `bounded re-read: ${(a.readBytes / a.size).toFixed(1)}× — capped, not the ~953× the collapsed floor let it grind`);

    // (B) ABOVE CHUNK — a > 2 MiB file (so ceil(size/16) > 132000) at maxBytes:132000. The pre-fix floor was
    //     pinned to a constant 131072 < 132000 so the advance sailed through → 64 waves → 103× at ok:true.
    const big = write(dir, 'big.jsonl', buildJsonl(Array.from({ length: 30000 }, (_, i) => ({ type: i % 2 ? 'mode' : 'keep', i, pad: 'x'.repeat(50) }))).buf);
    const b = drive(big, { maxBytes: 132000 }, 'B');
    assert.ok(b.size > (1 << 20), `case B spans multiple chunks (${b.size} bytes)`);
    assert.ok(b.size > 16 * 132000, 'and is large enough that a 132000-byte advance is below ceil(size/16) — the size-relative floor bites where the pinned constant 131072 did not');
    assert.strictEqual(b.r.ok, false, 'a 132000-byte advance on a > 2 MiB file is REFUSED (pre-fix: the constant 131072 floor let it through → 64 waves → 103× at ok:true)');
    assert.match(b.r.reason, /re-read|advanced only|floor|amplif|too small/i);
    assert.ok(b.readBytes < 32 * b.size, `bounded re-read: ${(b.readBytes / b.size).toFixed(1)}× — capped, not the ~103× the pinned floor let it grind`);
    assert.ok(b.waves <= 3, `refused at the first resumed wave (${b.waves} waves), never the ~64-wave grind`);

    // (C) reduceToCompletion (the trusted auto-drive, the milder 9.8× case): the SAME sub-CHUNK budget is bounded
    //     by the cumulative re-read cap — now HONEST (counts the per-wave snapshot region-hash it used to omit).
    let rcRead = 0;
    fs.readSync = (...aa) => { const k = realRead(...aa); if (k > 0) rcRead += k; return k; };
    let rc;
    try { rc = reduceToCompletion(big, { cutTypes: ['mode'], outPath: path.join(dir, 'o_C'), snapshotDir: path.join(dir, 's_C'), maxBytes: 132000 }); }
    finally { fs.readSync = realRead; }
    assert.ok(rc.ok === false || rc.done, 'reduceToCompletion refuses OR completes — never hangs');
    assert.ok(rcRead < 12 * b.size, `reduceToCompletion re-read stays bounded: ${(rcRead / b.size).toFixed(1)}× (the cumulative cap holds)`);

    // (D) NO FALSE-POSITIVE — a HEALTHY above-floor bare multi-wave drive (512 KiB budget ≫ ceil(size/16))
    //     completes ok:true, byte-identical to a single-pass reduction.
    const ref = path.join(dir, 'ref.jsonl');
    reduceToCompletion(big, { cutTypes: ['mode'], outPath: ref, snapshotDir: path.join(dir, 's_ref'), maxLines: 1e9, maxBytes: 1e9 });
    const d = drive(big, { maxBytes: 512 * 1024 }, 'D');
    assert.strictEqual(d.r.ok, true, 'a healthy 512 KiB-budget bare drive completes ok:true (advance ≫ the floor — no false-positive)');
    assert.strictEqual(d.r.done, true);
    assert.ok(d.waves > 1, `drove multiple waves (${d.waves})`);
    assert.ok(fs.readFileSync(path.join(dir, 'o_D')).equals(fs.readFileSync(ref)), 'byte-identical to the single-pass reduction');

    // (E) NO FALSE-POSITIVE — a legit OVERLONG single record (bigger than the budget) still refuses via the
    //     OVERLONG branch, NOT the wave-advance floor (the two paths stay distinct; the pre-giant resume waves
    //     clear ceil(size/16), reach the giant, and abandon on overlong).
    const ov = write(dir, 'ov.jsonl', Buffer.from(
      Array.from({ length: 80 }, (_, i) => JSON.stringify({ type: i % 2 ? 'mode' : 'user', i, pad: 'x'.repeat(8000) })).join('\n') +
      '\n' + JSON.stringify({ type: 'user', big: 'y'.repeat(1200 * 1024) }) + '\n', 'utf8'));
    const oOpts = { cutTypes: ['mode'], outPath: path.join(dir, 'o_E'), snapshotDir: path.join(dir, 's_E'), maxBytes: 200 * 1024, maxLines: 100000 };
    let r = reduceFile(ov, { ...oOpts, offset: 0, resume: null }), guard = 0;
    while (r.ok && !r.done) { r = reduceFile(ov, { ...oOpts, offset: r.nextOffset, resume: r.checkpoint }); if (++guard > 1000) throw new Error('runaway'); }
    assert.strictEqual(r.ok, false, 'the overlong record is refused');
    assert.match(r.reason, /abandoned|pathological/i, 'via the OVERLONG branch');
    assert.doesNotMatch(r.reason, /advanced only|ceil\(size/i, 'NOT the wave-advance floor (the two paths stay distinct)');
  } finally { fs.readSync = realRead; rm(dir); }
});

test('WAVE-9 L4 nit-a (no silent sanitize): reduceFile REFUSES a MIXED cut-list ([\'mode\', null] / [\'mode\', 123] / [\'mode\', \'\']) fail-closed — never sanitizes to the string subset and RUNS a destructive write; a clean all-string list still runs', () => {
  const dir = tmp();
  try {
    const src = write(dir, 'm.jsonl', buildJsonl(CLAUDEISH).buf);
    const before = sha256File(src);
    for (const bad of [['mode', null], ['mode', 123], ['mode', ''], ['mode', {}]]) {
      const out = path.join(dir, 'o');
      const r = reduceFile(src, { cutTypes: bad, outPath: out, snapshotDir: path.join(dir, 's') });
      assert.strictEqual(r.ok, false, `a mixed cut-list ${JSON.stringify(bad)} is refused (pre-fix: silently sanitized to ['mode'] and RAN a destructive write)`);
      assert.match(r.reason, /non-empty strings|mixed cut-list|invalid entr/i, 'the reason names the malformed cut-list');
      assert.strictEqual(fs.existsSync(out), false, 'no output written on the refusal');
    }
    assert.strictEqual(sha256File(src), before, 'the source is untouched by every refused mixed request');
    // CONTROL: a clean all-string list still runs (the guard bites only the malformed shape).
    const rc = reduceFile(src, { cutTypes: ['mode', 'queue-operation'], outPath: path.join(dir, 'ok.out'), snapshotDir: path.join(dir, 's2') });
    assert.strictEqual(rc.ok, true, 'a clean all-string cut-list still runs');
    assert.strictEqual(rc.unitsCut, 2, 'both requested present types are cut');
  } finally { rm(dir); }
});

test('WAVE-9 L4 nit-b (no orphan snapshot): an ndjson all-absent no-op reduceFile skip leaves NO orphan snapshot blob (matches json-single), reporting snapshotPath:null — pre-fix a fresh blob was written for a byte-identical no-op', () => {
  const dir = tmp();
  try {
    const snapDir = path.join(dir, 'snap');
    const src = write(dir, 'nd.jsonl', buildJsonl([{ type: 'user', a: 1 }, { type: 'assistant', b: 2 }]).buf);
    const r = reduceFile(src, { cutTypes: ['ghost'], outPath: path.join(dir, 'nd.out'), snapshotDir: snapDir });
    assert.strictEqual(r.skipped, true, 'the all-absent reduce is a no-op skip');
    assert.strictEqual(r.snapshotPath, null, 'no snapshot reported for a no-op (pre-fix: a blob path)');
    // no 64-hex content-addressed blob was left behind (the manifest audit row is allowed — an aid, not a gate)
    const blobs = fs.existsSync(snapDir) ? fs.readdirSync(snapDir).filter((f) => /^[0-9a-f]{64}$/.test(f)) : [];
    assert.deepStrictEqual(blobs, [], 'no orphan snapshot blob written for the no-op (matches json-single)');
    // CONTROL: a REAL cut DOES snapshot (the guard only bites the no-op).
    const rc = reduceFile(src, { cutTypes: ['user'], outPath: path.join(dir, 'nd2.out'), snapshotDir: path.join(dir, 'snap2') });
    assert.strictEqual(typeof rc.snapshotPath, 'string', 'a real cut still snapshots');
    assert.ok(fs.readdirSync(path.join(dir, 'snap2')).some((f) => /^[0-9a-f]{64}$/.test(f)), 'the real cut wrote a content-addressed blob');
  } finally { rm(dir); }
});

test('TP-1 (win32 rounded-ino): two DISTINCT files whose Number(ino) collides are NOT reported as a hardlink — the guard compares the 64-bit id exactly (bigint), so a rounding coincidence can no longer refuse a legit reduce', () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-ino-')));
  try {
    // On win32 an NTFS 64-bit File ID routinely exceeds 2^53, so Number(ino) is a
    // ROUNDED double (measured ulp = 4 at ~3.3e16) and distinct files DO collide.
    // Find a real colliding pair if this filesystem produces one; assert the guard
    // is clean either way (elsewhere the loop simply finds none).
    const seen = new Map();
    let a = null, b = null;
    for (let i = 0; i < 4000 && !a; i++) {
      const p = path.join(dir, `f${i}.bin`);
      fs.writeFileSync(p, `x${i}`);
      const key = `${fs.statSync(p).dev}:${fs.statSync(p).ino}`; // the OLD number-precision key
      if (seen.has(key)) { a = seen.get(key); b = p; } else seen.set(key, p);
    }
    if (a) {
      assert.notStrictEqual(fs.readFileSync(a, 'utf8'), fs.readFileSync(b, 'utf8'), 'the pair really is two different files');
      assert.strictEqual(collidesWithSource(b, a), null, 'a rounded-ino coincidence is NOT a collision (pre-fix: "is a hardlink to the source" -> reduce refused, random-red gate)');
    }
    // The true positive must survive the precision change.
    const src = path.join(dir, 'src.txt');
    fs.writeFileSync(src, 'payload');
    const link = path.join(dir, 'link.txt');
    try {
      fs.linkSync(src, link);
      assert.ok(/hardlink/i.test(collidesWithSource(link, src) || ''), 'a REAL hardlink is still caught exactly');
    } catch { /* no hardlink support here — the FP half above still ran */ }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('R3/TP-3: a SHORT-NAME snapshot store cannot slip past store containment — the undo net stays available (a short outPath used to clobber a prior snapshot blob)', (t) => {
  if (process.platform !== 'win32') { t.skip('8.3 is a win32 form'); return; }
  // The 8.3 SPECIMEN in this test is `short` below (minted by `%~sI`) and it is
  // assertively used; this sandbox root is not the contrast being drawn, so it
  // takes `.native` like every other root.
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'CW-LONGSTORE-NAME-FOR-8DOT3-')));
  try {
    const store = path.join(dir, 'SNAPSHOT-STORE-LONGNAME');
    fs.mkdirSync(store, { recursive: true });
    let short;
    short = execSync(`cmd /c for %I in ("${store}") do @echo %~sI`, { encoding: 'utf8' }).trim(); // no catch: a throw here must FAIL, not masquerade as "8.3 disabled"
    if (short === store) { t.skip('8.3 creation disabled on this volume'); return; }

    const src = write(dir, 'src.jsonl', buildJsonl(CLAUDEISH).buf);
    const snap = snapshotSource(src, store);
    assert.strictEqual(snap.ok, true, 'a snapshot exists to protect');

    // The short spelling must canonicalize to the SAME store, so containment sees it.
    assert.ok(isContainedIn(physicalForCreate(path.join(short, 'blob')), physicalForCreate(store)),
      'a short-name path inside the store is recognised AS inside it (pre-fix it compared unequal, so a write there escaped the check)');

    // and the recovery blob still restores byte-exact
    const out = path.join(dir, 'restored.jsonl');
    const r = restoreFromSnapshot(snap.sha256, out, { snapshotDir: store, original: src });
    assert.strictEqual(r.ok, true, `restore still works: ${r.reason || ''}`);
    assert.strictEqual(sha256File(out), snap.sha256, 'recovery blob byte-exact — the undo net is available');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('RUNG5 §1.2 NULL-POLARITY: an UNRESOLVABLE src/outPath REFUSES at every contained==REFUSE guard — a fail-closed null must never read as ALLOW', () => {
  const dir = tmp();
  try {
    const store = path.join(dir, 'store'); fs.mkdirSync(store, { recursive: true });
    const src = path.join(store, 'victim.jsonl');
    fs.writeFileSync(src, '{"type":"mode"}\n{"type":"user"}\n');
    const before = sha256File(src);
    // path.toNamespacedPath is NODE'S OWN documented long-path helper, not a contrived spelling.
    // physicalOrNull rejects every win32 device/UNC form by design, so it yields null here — and a
    // broken junction anywhere in the ancestor chain produces the same null on any platform.
    const nsSrc = path.toNamespacedPath(src);
    const nsStore = path.toNamespacedPath(store);

    const rSnap = snapshotSource(nsSrc, nsStore);
    assert.strictEqual(rSnap.ok, false,
      'snapshotSource must REFUSE a src it cannot prove is outside the store. Pre-fix, isContainedIn folded the unresolvable path into false, and because this guard is REFUSE-polarity, false meant ALLOW — the store write proceeded against a src living inside the store');
    const rRed = reduceFile(nsSrc, { cutTypes: ['mode'], outPath: path.join(dir, 'o.jsonl'), snapshotDir: nsStore });
    assert.strictEqual(rRed.ok, false, 'reduceFile floor refuses the same shape (both #6 and FIX-1 legs are REFUSE-polarity)');
    assert.strictEqual(sha256File(src), before, 'source byte-intact');

    // The permit-polarity caller keeps its ORIGINAL meaning — the fix must not invert it.
    assert.strictEqual(isContainedIn(null, store), false, 'permit-polarity: unknown is still not-contained (twin-pin behaviour unchanged)');
  } finally { rm(dir); }
});

test('RUNG5 A7 BLOB INDEPENDENCE: an ALIAS of the source planted at <store>/<sha> is never accepted as its own backup — a snapshot must survive the source changing', (t) => {
  const dir = tmp();
  try {
    const store = path.join(dir, 'store'); fs.mkdirSync(store, { recursive: true });
    const src = path.join(dir, 'src.txt'); fs.writeFileSync(src, 'ORIGINAL-PRECIOUS-BYTES');
    const sha = sha256File(src);
    try {
      fs.linkSync(src, path.join(store, sha)); // the alias hashes EXACTLY equal to sha — it IS the source
    } catch (e) {
      t.skip(`cannot create a hardlink here (${e.code}) — capability genuinely absent, not assumed`);
      return;
    }
    const r = snapshotSource(src, store);
    assert.strictEqual(r.ok, true, 'the snapshot still succeeds — the alias is replaced by a real blob, not refused');
    assert.strictEqual(r.deduped, false,
      'the alias must NOT be deduped-to. Content equality is trivially satisfied by the source itself; pre-fix this returned deduped:true and the store recorded a "backup" that was the same bytes on disk as the thing it protects');

    // THE DAMAGE, made explicit: destroy the source and the backup must still hold the original.
    fs.writeFileSync(src, 'DESTROYED');
    assert.strictEqual(fs.readFileSync(path.join(store, sha), 'utf8'), 'ORIGINAL-PRECIOUS-BYTES',
      'the blob is INDEPENDENT of the source. Pre-fix it read "DESTROYED" — the undo net silently held nothing');
  } finally { rm(dir); }
});

test('BLOB-SYMLINK: a link planted at <store>/<sha> can never make snapshotSource write THROUGH it — the blob lands via temp->rename, the outside victim is untouched', (t) => {
  const dir = tmp();
  try {
    const store = path.join(dir, 'store'); fs.mkdirSync(store, { recursive: true });
    const src = path.join(dir, 'src.txt'); fs.writeFileSync(src, 'SECRET-SOURCE-BYTES');
    const victim = path.join(dir, 'VICTIM.txt'); fs.writeFileSync(victim, 'original-victim');
    const sha = sha256File(src);
    try {
      fs.symlinkSync(victim, path.join(store, sha), 'file');
    } catch (e) {
      t.skip(`cannot create a symlink here (${e.code}) — capability genuinely absent, not assumed`);
      return;
    }
    const r = snapshotSource(src, store);
    assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'original-victim',
      'the file OUTSIDE the store is untouched. Pre-fix, copyFileSync followed the planted link and pushed the source bytes through it — an arbitrary write that still reported ok:true');
    assert.strictEqual(r.ok, true, 'and the snapshot still succeeds — the link entry is replaced, not followed');
    assert.strictEqual(sha256File(path.join(store, sha)), sha, 'the blob at the content-address really is the source (a real undo net, not a lie)');
  } finally { rm(dir); }
});

test('R3/LOW: restoreFromSnapshot never THROWS on a bad ref — a recovery primitive answers {ok:false}, it does not crash the caller', () => {
  // NOTE: toPath is a per-test sandbox path, NOT a predictable name in the shared system tmpdir.
  // The old `path.join(os.tmpdir(), 'cw-nope.jsonl')` was a fixed name every concurrent run would
  // share, and it was the taint source CodeQL traced into sha256File for #22.
  const dir = tmp();
  try {
  for (const bad of [undefined, null, 42, '', {}]) {
    const r = restoreFromSnapshot(bad, path.join(dir, 'cw-nope.jsonl'), {});
    assert.strictEqual(r.ok, false, `${String(bad)} => fail-closed`);
    assert.strictEqual(r.verified, false);
  }
  } finally { rm(dir); }
});

test('RUNG5 A6 PRIMARY UNDO: restoring a snapshot back OVER its own source succeeds when the caller declares src AND passes force — the refusal must not name a flag it ignores', () => {
  const dir = tmp();
  try {
    const store = path.join(dir, 'store');
    const src = path.join(dir, 'live.jsonl'); fs.writeFileSync(src, 'GOOD-ORIGINAL');
    const snap = snapshotSource(src, store);
    fs.writeFileSync(src, 'CORRUPTED-BY-A-BAD-RUN'); // the disaster the undo net exists for

    const r = restoreFromSnapshot(snap.sha256, src, { snapshotDir: store, src, force: true, original: src });
    assert.strictEqual(r.ok, true,
      'the PRIMARY undo must work. Pre-fix the src-alias branch fired unconditionally, so a caller who declared src (being explicit about what it protects) and set force:true was refused — by a message telling them to pass force:true, which they had already passed');
    assert.strictEqual(fs.readFileSync(src, 'utf8'), 'GOOD-ORIGINAL', 'the source really is restored');

    // and WITHOUT force the precise alias refusal still fires — force is the whole difference
    fs.writeFileSync(src, 'CORRUPTED-AGAIN');
    const rNo = restoreFromSnapshot(snap.sha256, src, { snapshotDir: store, src });
    assert.strictEqual(rNo.ok, false, 'no force → still refused');
    assert.match(rNo.reason, /alias|overwrite|force/i, 'and the refusal still explains itself');
    assert.strictEqual(fs.readFileSync(src, 'utf8'), 'CORRUPTED-AGAIN', 'a refused restore leaves the destination untouched');
  } finally { rm(dir); }
});

// ---------------------------------------------------------------------------
// THE TEMP REAPER OWNS ONLY WHAT IT CREATED (lab-grad2 N4/N5, and two more of
// the same class found by grepping every predictable temp in the file).
//
// Every write site here opens a per-pid temp with O_EXCL precisely so it never
// writes THROUGH a pre-existing alias. That guard works. Then the cleanup path
// deletes the thing the guard just refused to touch — a file the engine did not
// create, never snapshotted, and has no recovery path for. The comment at the
// reduceFile finally said "already renamed away, or never created": a two-case
// comment for a three-case reality, and the third case is "created by somebody
// else".
//
// House rule this violates (2026-07-27): bins are not the furnace, but past the
// bin IS the furnace. A delete that never passed a bin and has no snapshot is
// the furnace with no stop on the way, which is the shape that rule forbids.
//
// The fix is ownership, not detection: assign the reap variable only AFTER the
// exclusive create returns, so a non-null reap target PROVES we made it. That
// removes the precondition instead of arguing with the primitive.
// ---------------------------------------------------------------------------

const REAPER_VICTIM = 'PRECIOUS-USER-BYTES-THE-ENGINE-NEVER-MADE\n';

test('the temp reaper NEVER deletes a file the engine did not create (4 sites, incl. the recovery path)', () => {
  const dir = tmp();
  // F2 [MEDIUM, rung-2 R1 lab]: all 4 temps below are now UNPREDICTABLE (crypto.randomBytes(12)),
  // which is the whole point — it removes the PRECONDITION this test's own collision technique
  // relies on (pre-placing a file at a path the caller can guess in advance). To still exercise the
  // reaper-ownership invariant under a real collision, `crypto.randomBytes` is stubbed to a FIXED
  // value for the duration of this test ONLY (the file's own established convention — see the
  // `real...`-backup stubs elsewhere in this suite) so the resulting temp path is predictable HERE,
  // by the test, without reopening the predictability hole in the shipped engine.
  const FIXED_SUFFIX = '0102030405060708090a0b0c'; // crypto.randomBytes(12).toString('hex') of a fixed buffer
  const realRandomBytes = crypto.randomBytes;
  crypto.randomBytes = (n) => (n === 12 ? Buffer.from(FIXED_SUFFIX, 'hex') : realRandomBytes(n));
  try {
    const survived = (p) => fs.existsSync(p) && fs.readFileSync(p, 'utf8') === REAPER_VICTIM;
    const ndjson = buildJsonl(Array.from({ length: 30 }, (_, i) => ({ type: i % 3 ? 'user' : 'mode', i }))).buf;
    const breaches = [];

    // SITE 1 — reduceFile, ndjson wave-1 temp.
    {
      const d = path.join(dir, 's1'); fs.mkdirSync(d);
      const src = path.join(d, 's.jsonl'); fs.writeFileSync(src, ndjson);
      const outPath = path.join(d, 'o.jsonl');
      const victim = `${outPath}.${FIXED_SUFFIX}.tmp`;
      fs.writeFileSync(victim, REAPER_VICTIM);
      const r = reduceFile(src, { cutTypes: ['mode'], outPath, snapshotDir: path.join(d, 'store') });
      assert.strictEqual(r.ok, false, 'site 1: O_EXCL refuses to write through the planted file');
      if (!survived(victim)) breaches.push('site 1 (reduceFile ndjson wave-1)');
    }
    // SITE 2 — reduceFile, json-single temp.
    {
      const d = path.join(dir, 's2'); fs.mkdirSync(d);
      // PRETTY-PRINTED on purpose: a single-LINE JSON object is discovered as one-line ndjson and
      // never reaches the json-single writer at all. The mutation battery caught that — the first
      // version of this leg read as covering site 2 while exercising site 1's code path.
      const src = path.join(d, 's.json'); fs.writeFileSync(src, JSON.stringify({ type: 'mode', a: 1 }, null, 2));
      const outPath = path.join(d, 'o.json');
      const victim = `${outPath}.${FIXED_SUFFIX}.tmp`;
      fs.writeFileSync(victim, REAPER_VICTIM);
      const r = reduceFile(src, { cutTypes: ['mode'], outPath, snapshotDir: path.join(d, 'store') });
      assert.strictEqual(r.ok, false, 'site 2: O_EXCL refuses to write through the planted file');
      if (!survived(victim)) breaches.push('site 2 (reduceFile json-single)');
    }
    // SITE 3 — snapshotSource, manifest temp. The WORST one: it reaped and still
    // returned ok:true, so nothing in the return told a caller anything happened.
    {
      const d = path.join(dir, 's3'); fs.mkdirSync(d);
      const src = path.join(d, 's.jsonl'); fs.writeFileSync(src, ndjson);
      const store = path.join(d, 'store'); fs.mkdirSync(store);
      const victim = path.join(store, `${SNAPSHOT_MANIFEST}.${FIXED_SUFFIX}.tmp`);
      fs.writeFileSync(victim, REAPER_VICTIM);
      const r = snapshotSource(src, store);
      if (!survived(victim)) breaches.push('site 3 (snapshotSource manifest)');
      // The snapshot itself legitimately still succeeds — the manifest is an aid,
      // not a gate — but a skipped audit row must be SURFACED, never implied by an
      // unqualified ok:true over an unclean state.
      assert.strictEqual(r.ok, true, 'site 3: the blob is written, so the snapshot stands');
      if (r.manifestSkipped !== true) {
        breaches.push('site 3 SURFACING (ok:true over a skipped audit row said nothing — the rollback-claims-clean-over-partial class)');
      }
    }
    // SITE 4 — restoreFromSnapshot's temp. NOT named in the finding; found by
    // grepping every predictable temp. It is on the RECOVERY path, i.e. the undo
    // net destroying a bystander while restoring.
    {
      const d = path.join(dir, 's4'); fs.mkdirSync(d);
      const src = path.join(d, 's.jsonl'); fs.writeFileSync(src, ndjson);
      const store = path.join(d, 'store'); fs.mkdirSync(store);
      const snap = snapshotSource(src, store);
      assert.strictEqual(snap.ok, true, 'site 4 setup: snapshot taken');
      const toPath = path.join(d, 'restored.jsonl');
      const victim = `${toPath}.${FIXED_SUFFIX}.tmp`;
      fs.writeFileSync(victim, REAPER_VICTIM);
      const r = restoreFromSnapshot(snap.snapshotPath, toPath, {});
      assert.strictEqual(r.ok, false, 'site 4: EXCL refuses the planted temp');
      if (!survived(victim)) breaches.push('site 4 (restoreFromSnapshot, RECOVERY path)');
    }

    assert.deepStrictEqual(breaches, [],
      `the engine DELETED a file it never created (no snapshot, no bin, no recovery) at:\n  ${breaches.join('\n  ')}`);
  } finally { crypto.randomBytes = realRandomBytes; rm(dir); }
});

// THE CONTROL, and it is not optional: "never unlink anything" would pass the
// test above while leaking a temp on every failed run. A temp the engine DID
// create must still be reaped.
test('the temp reaper STILL reaps a temp the engine DID create (the fix must not become a leak)', () => {
  const dir = tmp();
  try {
    const src = path.join(dir, 's.jsonl');
    fs.writeFileSync(src, buildJsonl(Array.from({ length: 30 }, (_, i) => ({ type: i % 3 ? 'user' : 'mode', i }))).buf);
    const outPath = path.join(dir, 'sub', 'o.jsonl');

    // Force a failure AFTER the engine has created its own temp: a snapshotDir that
    // cannot be created makes the reduce fail downstream of the wave-1 temp open.
    const blocker = path.join(dir, 'blocker'); fs.writeFileSync(blocker, 'x');
    const r = reduceFile(src, { cutTypes: ['mode'], outPath, snapshotDir: path.join(blocker, 'store') });
    assert.strictEqual(r.ok, false, 'the run fails (snapshotDir is under a regular file)');

    const stray = fs.existsSync(path.dirname(outPath))
      ? fs.readdirSync(path.dirname(outPath)).filter((f) => f.endsWith('.tmp'))
      : [];
    assert.deepStrictEqual(stray, [], 'no orphan temp is left behind by a failed run');
  } finally { rm(dir); }
});

// ---------------------------------------------------------------------------
// CASE-FOLD CAPABILITY: the containment primitives fold by a real probe of the
// directory, never by `process.platform`.
//
// THE FIXTURE IS THE POINT. Every assertion below needs a directory whose case
// behaviour DISAGREES with what `process.platform` would have claimed, because on
// an ordinary tmpdir the old rule and the probe give the same answer and the test
// would pass on both engines — vacuous. On Windows that directory is built with
// `fsutil file setCaseSensitiveInfo` (per-directory since 10 1803, no admin); on a
// case-sensitive POSIX volume an ordinary mkdir already is one.
//
// CAPABILITY-PROBED, NEVER PLATFORM-GATED — gating this on `process.platform` would
// be the exact defect under test. The probe is the OUTCOME we need: two same-name
// different-case directories that are genuinely DISTINCT inodes. If that cannot be
// built here, the capability is proven absent and the caller skips VISIBLY.
function caseSensitiveDir() {
  const root = fs.realpathSync.native(tmp());
  const holder = path.join(root, 'holder');
  fs.mkdirSync(holder);
  try { execSync(`fsutil file setCaseSensitiveInfo "${holder}" enable`, { stdio: 'ignore' }); } catch { /* not win32, or refused — the inode check below is the real verdict */ }
  try {
    const lower = path.join(holder, 'store');
    const upper = path.join(holder, 'Store');
    fs.mkdirSync(lower);
    fs.mkdirSync(upper); // on a FOLDING volume this throws EEXIST — capability absent
    const a = fs.statSync(lower, { bigint: true });
    const b = fs.statSync(upper, { bigint: true });
    if (a.ino === b.ino) { rm(root); return null; } // same file: the volume folded them
    return { root, holder, lower, upper };
  } catch { rm(root); return null; }
}

test('CASE-FOLD: a genuinely case-sensitive directory is NOT folded — the store-boundary check refuses a case-variant sibling (was a live inject/exfil)', (t) => {
  const cs = caseSensitiveDir();
  if (!cs) { t.skip('no case-sensitive directory can be built here (capability proven absent by distinct-inode check, not assumed)'); return; }
  try {
    // The attacker owns `Store/` — a DIFFERENT directory from the declared store `store/`
    // — and plants a self-consistent content-addressed blob in it: the basename IS the
    // sha256 of its own bytes, so the content-address verification cannot separate them.
    // The ONLY thing standing between the caller and attacker-chosen bytes is the
    // store-boundary containment check, and folding case dissolves it.
    const evil = Buffer.from('ATTACKER-CHOSEN BYTES\n');
    const sha = crypto.createHash('sha256').update(evil).digest('hex');
    fs.writeFileSync(path.join(cs.upper, sha), evil);
    const toPath = path.join(cs.root, 'restored.out');

    const r = restoreFromSnapshot(path.join(cs.upper, sha), toPath, { snapshotDir: cs.lower });
    assert.strictEqual(r.ok, false,
      'a blob living in a case-variant SIBLING of the declared store must NOT restore. ' +
      'Measured on the pre-fix engine: ok:true, verified:true, and the attacker bytes landed on disk.');
    assert.strictEqual(fs.existsSync(toPath), false, 'nothing may be published when the ref escapes the store');
    assert.match(r.reason, /escapes the store/);

    // NOT VACUOUS, and this is the half that catches an over-refusing "fix": a
    // genuinely in-store blob must still restore on this same directory. Taken through
    // `snapshotSource` (not a raw blob write) so it also has the manifest row the F1
    // ownership check (see restoreFromSnapshot's header) now requires — the realistic
    // shape, since every real snapshot in this engine is created that way.
    const goodSrc = path.join(cs.root, 'good-src.txt');
    fs.writeFileSync(goodSrc, 'legitimate\n');
    const goodSnap = snapshotSource(goodSrc, cs.lower);
    assert.strictEqual(goodSnap.ok, true, 'sanity: the control snapshot itself succeeds');
    const okPath = path.join(cs.root, 'good.out');
    const r2 = restoreFromSnapshot(goodSnap.sha256, okPath, { snapshotDir: cs.lower, original: goodSrc });
    assert.strictEqual(r2.ok, true, `an in-store blob must still restore (got ${r2.reason})`);
    assert.strictEqual(fs.readFileSync(okPath, 'utf8'), 'legitimate\n');
  } finally { rm(cs.root); }
});

test('CASE-FOLD: PERMIT and REFUSE take OPPOSITE miss directions, and an OMITTED direction refuses at BOTH', () => {
  // Demand 2 of the twin unit: the per-call-site derivation must exist as a TEST, not
  // as a comment. A probe MISS is forced with a basename carrying NO case-bearing
  // character (miss mode 3) — no filesystem trickery needed, and it is the one miss
  // mode reachable portably.
  const root = fs.realpathSync.native(tmp());
  try {
    const base = path.join(root, '2026');   // digits only: flipCase finds nothing to flip -> MISS
    fs.mkdirSync(base);
    const child = path.join(base, 'x');
    fs.mkdirSync(child);

    // Sanity: this really IS a miss, not an accident of the fixture — a name WITH a
    // case-bearing character on the same volume measures instead of missing.
    assert.strictEqual(containment(child, base, true), 'inside', 'sanity: the real child is inside either way');

    // The discriminator: a case-variant child. Under fold-on-miss it reads inside;
    // under no-fold-on-miss it reads outside. Same inputs, opposite answers, and the
    // ONLY difference is the direction the CALLER supplied.
    const variant = child.toUpperCase();
    assert.strictEqual(containment(variant, base, true), 'inside',
      'REFUSE-polarity passes true: a miss FOLDS, so a case-variant reads inside and the guard over-REFUSES (safe)');
    assert.strictEqual(containment(variant, base, false), 'outside',
      'PERMIT-polarity passes false: a miss does NOT fold, so a case-variant is not proven inside and the guard refuses (safe)');

    // isContainedIn is the PERMIT projection and must carry the PERMIT direction —
    // NOT inherit the REFUSE sites' default. This is the assertion that goes red if
    // someone "simplifies" the two defaults back into one.
    assert.strictEqual(isContainedIn(variant, base), false,
      'isContainedIn is PERMIT-polarity: an unproven case-variant must not be admitted');

    // A FORGOTTEN direction must fail CLOSED at BOTH polarities, not silently pick one.
    assert.strictEqual(containment(child, base), 'unknown', 'an omitted foldOnMiss answers unknown');
    assert.strictEqual(containment(child, base, 'true'), 'unknown', 'a non-boolean foldOnMiss answers unknown');
    assert.notStrictEqual(containment(child, base), 'outside', 'unknown REFUSES at a `!== outside` guard');
    assert.notStrictEqual(containment(child, base), 'inside', 'unknown REFUSES at an `=== inside` guard');
  } finally { rm(root); }
});

// ---------------------------------------------------------------------------
// F1 [HIGH, rung-2 R1 lab] — the content-addressed snapshot store had no ownership check.
// The blob store is directly enumerable (readdirSync lists every hash, no manifest read
// needed) and restoreFromSnapshot verified byte-integrity but never checked that `ref`
// came from a file the restoring caller owns. MEASURED end-to-end, real run, not reasoned:
// scratchpad/cw-lab-rung2-r1/coord-verify/verify-crosstenant.mjs — an ORDINARY, non-
// adversarial "recover everything visible in the shared undo-net store" caretaker script
// (not an attacker fixture) landed CODER role's secret content in REVIEWER role's own
// recovery directory. This test reproduces that exact scenario directly against this
// engine (not the frozen lab copy) and pins BOTH directions: the leak refused, and a
// correctly-declared legitimate restore unaffected.
test('F1 [HIGH]: a shared snapshotDir cannot be blindly recovered from — ownership must be declared and confirmed against the manifest', () => {
  const dir = tmp();
  try {
    fs.mkdirSync(path.join(dir, 'agent-memory', 'coder'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'agent-memory', 'reviewer'), { recursive: true });
    const roleA = write(dir, path.join('agent-memory', 'coder', 'MEMORY.md'), Buffer.from(
      JSON.stringify({ type: 'mode', value: 'x' }) + '\n' +
      JSON.stringify({ type: 'user', text: 'CODER role secret: prod DB password is hunter2' }) + '\n'));
    const roleB = write(dir, path.join('agent-memory', 'reviewer', 'MEMORY.md'), Buffer.from(
      JSON.stringify({ type: 'mode', value: 'y' }) + '\n' +
      JSON.stringify({ type: 'user', text: 'REVIEWER role note: nothing sensitive' }) + '\n'));
    // A plausible, UNREMARKABLE wiring choice — one shared snapshotDir per project, not an
    // adversarial setup.
    const sharedSnap = path.join(dir, '.claude', 'coalwash', 'snapshots');

    const resA = reduceFile(roleA, { outPath: roleA + '.reduced', snapshotDir: sharedSnap, cutTypes: ['mode'] });
    const resB = reduceFile(roleB, { outPath: roleB + '.reduced', snapshotDir: sharedSnap, cutTypes: ['mode'] });
    assert.strictEqual(resA.ok, true);
    assert.strictEqual(resB.ok, true);

    // The REVIEWER's own recovery tooling discovers a hash by LISTING the shared store — no
    // manifest read, no declared original. The exact shape of the lab's caretaker script.
    const blobs = fs.readdirSync(sharedSnap).filter((f) => !f.endsWith('.tmp') && f !== 'manifest.jsonl');
    assert.strictEqual(blobs.length, 2, 'sanity: both roles snapshotted');
    const recoverDir = path.join(dir, 'agent-memory', 'reviewer', 'recovered');
    fs.mkdirSync(recoverDir, { recursive: true });

    const results = blobs.map((b) => restoreFromSnapshot(b, path.join(recoverDir, b + '.txt'), { snapshotDir: sharedSnap }));
    // RED-FIRST: pre-fix, every one of these returned ok:true and the loop below found the
    // secret. Post-fix, EVERY bare-hash-discovery restore is refused — ownership undeclared.
    assert.ok(results.every((r) => r.ok === false), `every undeclared-ownership restore must refuse (got ${JSON.stringify(results.map((r) => r.ok))})`);
    assert.ok(results.every((r) => /ownership not declared/.test(r.reason)), 'the refusal reason names the missing declaration, not a generic error');
    const leaked = fs.existsSync(recoverDir) && fs.readdirSync(recoverDir).some((f) => fs.readFileSync(path.join(recoverDir, f), 'utf8').includes('hunter2'));
    assert.strictEqual(leaked, false, 'CODER role secret content must NOT land in REVIEWER role recovery dir');

    // NOT VACUOUS (a fix that just refuses everything proves nothing): the SAME blob restores
    // when the caller correctly declares what it believes the original is, and the manifest
    // confirms it — the legitimate, single-tenant restore path is unaffected. (roleA's own
    // hash, resolved directly so the test doesn't assume array order from readdirSync.)
    const roleAHash = sha256File(roleA);
    assert.ok(blobs.includes(roleAHash), 'sanity: roleA really is one of the discovered blobs');
    const legit = restoreFromSnapshot(roleAHash, path.join(dir, 'legit.out'), { snapshotDir: sharedSnap, original: roleA });
    assert.strictEqual(legit.ok, true, `a correctly-declared legitimate restore must succeed (got ${legit.reason})`);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'legit.out'), 'utf8'), fs.readFileSync(roleA, 'utf8'));

    // IMPERSONATION: a caller that has READ the manifest and deliberately claims the WRONG
    // original for a blob it does not own must still be refused — ownership is CONFIRMED
    // against the manifest, never merely asserted.
    const roleBHash = sha256File(roleB);
    const impersonate = restoreFromSnapshot(roleBHash, path.join(dir, 'impersonate.out'), { snapshotDir: sharedSnap, original: roleA });
    assert.strictEqual(impersonate.ok, false, 'a false ownership claim (right hash, wrong declared original) must be refused, not merely trusted');
    assert.match(impersonate.reason, /ownership unconfirmed/);
  } finally { rm(dir); }
});

// F2 [MEDIUM, rung-2 R1 lab]: STRUCTURAL proof of unpredictability (independent of the reaper
// test's stubbed-collision technique above). Watches the directory DURING each write and asserts
// the in-flight temp basename is never the OLD `${name}.${pid}.tmp` form at any of the 4 sites —
// pinning the property the fix claims, not just its downstream effect.
test('F2 [MEDIUM]: none of the 4 write-temp sites use the predictable ${name}.${pid}.tmp form', () => {
  const dir = tmp();
  const pidPattern = new RegExp(`\.${process.pid}\.tmp$`);
  const seenTmp = [];
  const realOpenSync = fs.openSync;
  fs.openSync = (p, ...rest) => {
    if (typeof p === 'string' && p.endsWith('.tmp')) seenTmp.push(path.basename(p));
    return realOpenSync(p, ...rest);
  };
  try {
    const ndjson = buildJsonl(Array.from({ length: 10 }, (_, i) => ({ type: i % 2 ? 'user' : 'mode', i }))).buf;
    // site 1 (ndjson wave-1) + site 3 (manifest, via snapshotSource inside reduceFile)
    const src1 = write(dir, 's1.jsonl', ndjson);
    const store = path.join(dir, 'store');
    const r1 = reduceFile(src1, { cutTypes: ['mode'], outPath: path.join(dir, 'o1.jsonl'), snapshotDir: store });
    assert.strictEqual(r1.ok, true);
    // site 2 (json-single)
    const src2 = write(dir, 's2.json', JSON.stringify({ type: 'mode', a: 1 }));
    const r2 = reduceFile(src2, { cutTypes: ['mode'], outPath: path.join(dir, 'o2.json'), snapshotDir: store });
    assert.strictEqual(r2.ok, true);
    // site 4 (restore)
    const r4 = restoreFromSnapshot(r1.snapshotPath, path.join(dir, 'restored.jsonl'), { snapshotDir: store, original: src1 });
    assert.strictEqual(r4.ok, true);

    assert.ok(seenTmp.length >= 4, `sanity: at least 4 temps observed (got ${seenTmp.length}: ${seenTmp.join(', ')})`);
    const predictable = seenTmp.filter((t) => pidPattern.test(t));
    assert.deepStrictEqual(predictable, [], `predictable pid-suffixed temp(s) still in use: ${predictable.join(', ')}`);
  } finally { fs.openSync = realOpenSync; rm(dir); }
});
