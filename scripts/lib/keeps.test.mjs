import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { keepsPath, loadKeeps, recordKeep, globalKeepsPath, loadGlobalKeeps, recordGlobalKeep, pendingUserKeeps } from './keeps.mjs';
import * as keepsModule from './keeps.mjs';
import { txDirFor, acquireLock } from './apply.mjs';

function sandbox() {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwk-proj-')));
}
function clean(...dirs) {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}

test('loadKeeps: [] when the file is missing, corrupt, or the wrong shape', () => {
  const proj = sandbox();
  try {
    assert.deepStrictEqual(loadKeeps(proj), []);
    fs.mkdirSync(txDirFor(proj), { recursive: true });
    fs.writeFileSync(keepsPath(proj), '{ not json', 'utf8');
    assert.deepStrictEqual(loadKeeps(proj), []);
    fs.writeFileSync(keepsPath(proj), JSON.stringify({ not: 'the schema' }), 'utf8');
    assert.deepStrictEqual(loadKeeps(proj), []);
    fs.writeFileSync(keepsPath(proj), '', 'utf8');
    assert.deepStrictEqual(loadKeeps(proj), []);
    // a bare array (no schema wrapper) is not the shipped shape -> unreadable
    fs.writeFileSync(keepsPath(proj), JSON.stringify([{ target: 'x' }]), 'utf8');
    assert.deepStrictEqual(loadKeeps(proj), []);
  } finally { clean(proj); }
});

test('recordKeep: writes a retrievable entry; the shared sandbox dir self-ignores', () => {
  const proj = sandbox();
  try {
    const r = recordKeep(proj, { target: 'dogfood-to-harden', reason: 'confirmed load-bearing 2026-07-09' });
    assert.strictEqual(r.ok, true);
    const keeps = loadKeeps(proj);
    assert.strictEqual(keeps.length, 1);
    assert.strictEqual(keeps[0].target, 'dogfood-to-harden');
    assert.strictEqual(keeps[0].reason, 'confirmed load-bearing 2026-07-09');
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(keeps[0].date), 'defaults to a YYYY-MM-DD date');
    const gi = path.join(txDirFor(proj), '.gitignore');
    assert.ok(fs.existsSync(gi), 'the shared sandbox dir self-ignores (privacy is code-enforced)');
    assert.strictEqual(fs.readFileSync(gi, 'utf8'), '*\n');
  } finally { clean(proj); }
});

test('recordKeep: re-adjudicating the SAME target upserts (no unbounded duplicate growth)', () => {
  const proj = sandbox();
  try {
    recordKeep(proj, { target: 'x', reason: 'first look', date: '2026-01-01' });
    recordKeep(proj, { target: 'x', reason: 'second look, still load-bearing', date: '2026-02-02' });
    const keeps = loadKeeps(proj);
    assert.strictEqual(keeps.length, 1, 'the same target replaces, not accumulates');
    assert.strictEqual(keeps[0].reason, 'second look, still load-bearing');
    assert.strictEqual(keeps[0].date, '2026-02-02');
  } finally { clean(proj); }
});

test('recordKeep: multiple distinct targets coexist', () => {
  const proj = sandbox();
  try {
    recordKeep(proj, { target: 'a', reason: 'r1' });
    recordKeep(proj, { target: 'b', reason: 'r2' });
    const targets = loadKeeps(proj).map((k) => k.target).sort();
    assert.deepStrictEqual(targets, ['a', 'b']);
  } finally { clean(proj); }
});

test('recordKeep: refuses a missing/empty/non-string target, nothing written', () => {
  const proj = sandbox();
  try {
    assert.strictEqual(recordKeep(proj, { reason: 'no target' }).ok, false);
    assert.strictEqual(recordKeep(proj, { target: '' }).ok, false);
    assert.strictEqual(recordKeep(proj, { target: 42 }).ok, false);
    assert.strictEqual(recordKeep(proj).ok, false);
    assert.strictEqual(fs.existsSync(keepsPath(proj)), false, 'nothing written on refusal');
  } finally { clean(proj); }
});

test('loadKeeps filters out malformed entries within an otherwise-valid keeps list', () => {
  const proj = sandbox();
  try {
    fs.mkdirSync(txDirFor(proj), { recursive: true });
    fs.writeFileSync(keepsPath(proj), JSON.stringify({ v: 1, keeps: [{ target: 'ok' }, 'garbage', null, 42, { reason: 'no target field' }] }), 'utf8');
    assert.deepStrictEqual(loadKeeps(proj), [{ target: 'ok' }]);
  } finally { clean(proj); }
});

test('keepsPath sits inside the same apply.mjs tx dir (<project>/.claude/coalwash/keeps.json)', () => {
  const proj = sandbox();
  try {
    assert.strictEqual(keepsPath(proj), path.join(txDirFor(proj), 'keeps.json'));
  } finally { clean(proj); }
});

test('R5: the on-disk shape carries the schema version (v:1) so a future schema bump is detectable', () => {
  const proj = sandbox();
  try {
    recordKeep(proj, { target: 'x' });
    const raw = JSON.parse(fs.readFileSync(keepsPath(proj), 'utf8'));
    assert.strictEqual(raw.v, 1);
    assert.ok(Array.isArray(raw.keeps));
  } finally { clean(proj); }
});

test('R5: a NEWER-schema keeps.json is READ-ONLY — loadKeeps [], recordKeep refuses, bytes untouched', () => {
  const proj = sandbox();
  try {
    fs.mkdirSync(txDirFor(proj), { recursive: true });
    const futureBytes = JSON.stringify({ v: 99, keeps: [{ target: 'future-thing', futureField: { nested: true } }] });
    fs.writeFileSync(keepsPath(proj), futureBytes, 'utf8');
    assert.deepStrictEqual(loadKeeps(proj), [], 'a newer schema is unreadable to this version, never guessed at');
    assert.strictEqual(recordKeep(proj, { target: 'y' }).ok, false, 'an older tool must not rewrite a newer artifact');
    assert.strictEqual(fs.readFileSync(keepsPath(proj), 'utf8'), futureBytes, 'the newer file is byte-untouched');
  } finally { clean(proj); }
});

// ---------------------------------------------------------------------------
// GLOBAL keeps (design-pass item, MEMORY.md "THE SHARED GLOBAL SLICE"): same
// shape/schema/upsert semantics, filed beside the global state file so an
// adjudicated keep on a global target shields it machine-wide.
// ---------------------------------------------------------------------------

test('global keeps: recordGlobalKeep writes beside the global state file, independent of any project', () => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwk-ghome-')));
  try {
    assert.deepStrictEqual(loadGlobalKeeps(home), []);
    const r = recordGlobalKeep(home, { target: 'global-claude-md-section', reason: 'shields it machine-wide' });
    assert.strictEqual(r.ok, true);
    const keeps = loadGlobalKeeps(home);
    assert.strictEqual(keeps.length, 1);
    assert.strictEqual(keeps[0].target, 'global-claude-md-section');
    assert.strictEqual(keeps[0].reason, 'shields it machine-wide');
    assert.ok(fs.existsSync(globalKeepsPath(home)));
    assert.strictEqual(globalKeepsPath(home), path.join(home, '.claude', '.coalwash-global-keeps.json'));
  } finally { clean(home); }
});

test('global keeps: upserts by target (same as the project store) and stays fully isolated from any project keeps.json', () => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwk-ghome2-')));
  const proj = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwk-proj-')));
  try {
    recordGlobalKeep(home, { target: 'x', reason: 'first look', date: '2026-01-01' });
    recordGlobalKeep(home, { target: 'x', reason: 'second look, still load-bearing', date: '2026-02-02' });
    assert.strictEqual(loadGlobalKeeps(home).length, 1, 'the same target replaces, not accumulates');
    assert.strictEqual(loadGlobalKeeps(home)[0].reason, 'second look, still load-bearing');

    recordKeep(proj, { target: 'x', reason: 'project-local, unrelated' }); // same target NAME, different store
    assert.strictEqual(loadKeeps(proj).length, 1);
    assert.strictEqual(loadKeeps(proj)[0].reason, 'project-local, unrelated');
    assert.strictEqual(loadGlobalKeeps(home).length, 1, 'the project write never touched the global store');
    assert.strictEqual(loadGlobalKeeps(home)[0].reason, 'second look, still load-bearing');
  } finally { clean(home, proj); }
});

test('global keeps: [] on missing/corrupt/wrong-shape/newer-schema, same conservative behavior as the project store', () => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwk-ghome3-')));
  try {
    assert.deepStrictEqual(loadGlobalKeeps(home), []);
    fs.mkdirSync(path.dirname(globalKeepsPath(home)), { recursive: true });
    fs.writeFileSync(globalKeepsPath(home), '{ not json', 'utf8');
    assert.deepStrictEqual(loadGlobalKeeps(home), []);
    const futureBytes = JSON.stringify({ v: 99, keeps: [{ target: 'future' }] });
    fs.writeFileSync(globalKeepsPath(home), futureBytes, 'utf8');
    assert.deepStrictEqual(loadGlobalKeeps(home), []);
    assert.strictEqual(recordGlobalKeep(home, { target: 'y' }).ok, false, 'an older tool must not rewrite a newer artifact');
    assert.strictEqual(fs.readFileSync(globalKeepsPath(home), 'utf8'), futureBytes, 'the newer file is byte-untouched');
  } finally { clean(home); }
});

test('recordKeep persists the beta.12 enforcement handle (anchor + anchorFile); a handle-less keep stays the old shape', () => {
  const proj = sandbox();
  try {
    recordKeep(proj, { target: 'f.md:clause', reason: 'adjudicated', anchor: 'the exact protected span', anchorFile: 'C:/store/f.md' });
    recordKeep(proj, { target: 'plain', reason: 'advisory only' });
    const keeps = loadKeeps(proj);
    const armed = keeps.find((k) => k.target === 'f.md:clause');
    assert.strictEqual(armed.anchor, 'the exact protected span');
    assert.strictEqual(armed.anchorFile, 'C:/store/f.md');
    const plain = keeps.find((k) => k.target === 'plain');
    assert.ok(!('anchor' in plain) && !('anchorFile' in plain), 'no undefined-field pollution on the pre-beta.12 shape');
  } finally { clean(proj); }
});

// grad6 W3-K2 (CoalBoard verdict): re-affirming an already-enforced keep
// (bumping just reason/date, the ordinary re-review shape) used to REBUILD
// the entry from only this call's own arguments -- omitting anchor/anchorFile
// silently downgraded it from mechanically ENFORCED to merely advisory, with
// no flag anywhere. Driven exactly as the wave drove it: record with an
// anchor, re-affirm without one, and the anchor must SURVIVE.
test('recordKeep: re-affirming WITHOUT anchor/anchorFile preserves the prior enforcement handle (never a silent downgrade)', () => {
  const proj = sandbox();
  try {
    recordKeep(proj, { target: 'f.md:clause', reason: 'first adjudication', anchor: 'the exact protected span', anchorFile: 'C:/store/f.md' });
    const reAffirmed = recordKeep(proj, { target: 'f.md:clause', reason: 'second look, still load-bearing', date: '2026-08-01' });
    assert.strictEqual(reAffirmed.ok, true);
    assert.strictEqual(reAffirmed.anchorDropped, false, 'nothing was requested this call -- preserving a PRIOR anchor is not a drop');
    const keeps = loadKeeps(proj);
    assert.strictEqual(keeps.length, 1);
    const entry = keeps[0];
    assert.strictEqual(entry.reason, 'second look, still load-bearing', 'the new reason/date must land');
    assert.strictEqual(entry.date, '2026-08-01');
    assert.strictEqual(entry.anchor, 'the exact protected span', 'the anchor must survive a re-affirm that did not supply one');
    assert.strictEqual(entry.anchorFile, 'C:/store/f.md', 'the anchorFile must survive too');
  } finally { clean(proj); }
});

test('recordKeep: a re-affirm that DOES supply a new anchor overrides (an intentional update, not a downgrade)', () => {
  const proj = sandbox();
  try {
    // grad9 F3, then grad10 F4: fixture lengthened TWICE past the rising
    // meaningful-anchor floor (8 real chars, then 20 chars + 2 words) — the
    // test's INTENT (a real new anchor overrides) is unchanged both times.
    recordKeep(proj, { target: 'f.md:clause', reason: 'first', anchor: 'old span of real text here', anchorFile: 'C:/store/f.md' });
    recordKeep(proj, { target: 'f.md:clause', reason: 'moved', anchor: 'new span of real text here', anchorFile: 'C:/store/f2.md' });
    const entry = loadKeeps(proj).find((k) => k.target === 'f.md:clause');
    assert.strictEqual(entry.anchor, 'new span of real text here');
    assert.strictEqual(entry.anchorFile, 'C:/store/f2.md');
  } finally { clean(proj); }
});

// grad7 ruling Root E / grad8 F4: the truthiness check ("anchor" alone) a
// whitespace-only string satisfies -- silently degrading a real, enforced
// keep to a single space with NO error and no visible sign anything broke
// (the KEEPS-GATE still reads anchor as present, so the entry still LOOKS
// enforced right up until it protects nothing).
test('RED-FIRST/root-E: a re-affirm passing a WHITESPACE-ONLY anchor does NOT overwrite the prior real anchor — real content is required to count as an intentional update', () => {
  const proj = sandbox();
  try {
    recordKeep(proj, { target: 'f.md:clause', reason: 'first adjudication', anchor: 'the exact protected span, fifteen-plus real characters', anchorFile: 'C:/store/f.md' });
    const r = recordKeep(proj, { target: 'f.md:clause', reason: 'accidental blank re-affirm', anchor: ' ', anchorFile: 'C:/store/f.md' });
    assert.strictEqual(r.ok, true, 'the write itself still succeeds (this is a merge decision, not a failure)');
    assert.strictEqual(r.anchorDropped, true, 'grad11 F5: the caller DID ask for an anchor this call, and it did not land — the return must say so');
    const entry = loadKeeps(proj).find((k) => k.target === 'f.md:clause');
    assert.strictEqual(entry.anchor, 'the exact protected span, fifteen-plus real characters', 'a whitespace-only anchor must NOT replace the prior real one');
    assert.strictEqual(entry.reason, 'accidental blank re-affirm', 'non-anchor fields still update normally — only the content-empty anchor is refused');
  } finally { clean(proj); }
});

test('RED-FIRST/root-E control: a re-affirm with a REAL (non-whitespace) new anchor still overrides normally — the fix does not over-refuse legitimate updates', () => {
  const proj = sandbox();
  try {
    recordKeep(proj, { target: 'f.md:clause', reason: 'first', anchor: 'old span of real text here', anchorFile: 'C:/store/f.md' });
    recordKeep(proj, { target: 'f.md:clause', reason: 'moved', anchor: '  new span with real content  ', anchorFile: 'C:/store/f2.md' });
    const entry = loadKeeps(proj).find((k) => k.target === 'f.md:clause');
    assert.strictEqual(entry.anchor, '  new span with real content  ', 'a real (surrounding-whitespace-only, not content-only) anchor still overrides — only a PURELY whitespace value is refused');
  } finally { clean(proj); }
});

// grad9 F3: whitespace-only was never the full class — a DEGENERATE-but-
// non-whitespace anchor ("e", "#", "the" — the lab's own examples) passed
// the old `trim().length>0` check and silently overwrote a real, much
// longer, adjudicated anchor on re-affirm.
for (const junk of ['e', '#', 'the']) {
  test(`RED-FIRST/F3-degenerate: a re-affirm passing the degenerate anchor ${JSON.stringify(junk)} does NOT overwrite the prior real anchor`, () => {
    const proj = sandbox();
    try {
      const real = 'the exact protected span, ninety-plus characters long so it is unmistakably a real adjudicated clause not a fragment';
      recordKeep(proj, { target: 'f.md:clause', reason: 'first adjudication', anchor: real, anchorFile: 'C:/store/f.md' });
      recordKeep(proj, { target: 'f.md:clause', reason: 'degenerate re-affirm', anchor: junk, anchorFile: 'C:/store/f.md' });
      const entry = loadKeeps(proj).find((k) => k.target === 'f.md:clause');
      assert.strictEqual(entry.anchor, real, `a degenerate anchor (${JSON.stringify(junk)}) must NOT replace the prior real one`);
    } finally { clean(proj); }
  });
}

// grad9 F3, OPPOSITE POLARITY: U+200B (ZERO WIDTH SPACE) is Cf, not in JS
// `\s` — the old check's `.trim()` does not strip it, so a ZWSP-only value
// passed as "real content" too, and would then PERMANENTLY false-refuse
// every future edit (nothing in real text ever contains a bare ZWSP).
test('RED-FIRST/F3-invisible: a re-affirm passing an INVISIBLE (U+200B-only) anchor does NOT overwrite the prior real anchor', () => {
  const proj = sandbox();
  try {
    const real = 'the exact protected span, ninety-plus characters long so it is unmistakably a real adjudicated clause not a fragment';
    recordKeep(proj, { target: 'f.md:clause', reason: 'first adjudication', anchor: real, anchorFile: 'C:/store/f.md' });
    recordKeep(proj, { target: 'f.md:clause', reason: 'invisible re-affirm', anchor: '\u200b\u200b\u200b', anchorFile: 'C:/store/f.md' });
    const entry = loadKeeps(proj).find((k) => k.target === 'f.md:clause');
    assert.strictEqual(entry.anchor, real, 'a ZWSP-only anchor must NOT replace the prior real one');
  } finally { clean(proj); }
});

test('RED-FIRST/F3 control: a real anchor at/above the meaningful-length floor still overrides normally — the fix does not over-refuse a genuinely short-but-real update', () => {
  const proj = sandbox();
  try {
    recordKeep(proj, { target: 'f.md:clause', reason: 'first', anchor: 'the old ninety-plus char span used only to seed a real prior entry here', anchorFile: 'C:/store/f.md' });
    // grad10 F4 raised the floor to 20 chars + 2 words, then grad10-round-2
    // HIGH-2 replaced the word-count leg with a distinct-character floor
    // (script-agnostic) and lowered the length floor to 12 -- "8+chars!"
    // (round 9's own control fixture, 8 chars) sits BELOW it either way;
    // this fixture clears both the length and distinct-char floors.
    recordKeep(proj, { target: 'f.md:clause', reason: 'moved', anchor: 'genuinely real anchor text', anchorFile: 'C:/store/f2.md' });
    const entry = loadKeeps(proj).find((k) => k.target === 'f.md:clause');
    assert.strictEqual(entry.anchor, 'genuinely real anchor text', 'a real anchor at the floor still overrides — only sub-floor junk is refused');
  } finally { clean(proj); }
});

// grad10 F4 [HIGH, content-loss]: round 9's 8-char floor is a LENGTH proxy
// for DISTINCTIVENESS, and the proxy does not hold — "whatever" and
// "!!!!!!!!" both clear 8 chars, and both are common/repeated enough to
// coincidentally recur in unrelated boilerplate even after the clause they
// were meant to name is gone, so a rewrite deleting that clause still finds
// the word "surviving" elsewhere and goes through unflagged. Applies to a
// FIRST-TIME record (no prior to fall back to), not only a re-affirm — the
// keep gets NO enforcement handle at all rather than a worthless one.
for (const junk of ['whatever', '!!!!!!!!']) {
  test(`RED-FIRST/F4-distinctiveness: a FIRST-TIME record with the non-distinctive anchor ${JSON.stringify(junk)} gets NO enforcement handle`, () => {
    const proj = sandbox();
    try {
      const r = recordKeep(proj, { target: 'f.md:clause', reason: 'test', anchor: junk, anchorFile: 'C:/store/f.md' });
      assert.strictEqual(r.ok, true, 'the write itself still succeeds — this is a merge/acceptance decision, not a failure');
      assert.strictEqual(r.anchorDropped, true, 'grad11 F5: a real anchor was requested and did not clear the floor — the return must say so, not read like an ordinary advisory keep');
      assert.strictEqual(r.anchorStored, false);
      const entry = loadKeeps(proj).find((k) => k.target === 'f.md:clause');
      assert.ok(entry, 'the keep entry itself is still recorded (target/reason/date) — advisory shape, pre-beta.12');
      assert.strictEqual(entry.anchor, undefined, `${JSON.stringify(junk)} must NOT become an enforcement handle — it is not distinctive enough to trust`);
    } finally { clean(proj); }
  });
}

test('RED-FIRST/F4-distinctiveness control: a real multi-word phrase at the SAME length as "whatever"-class junk still gets an enforcement handle', () => {
  const proj = sandbox();
  try {
    // "a rare specific phrase indeed" -- stripped 26 chars, well above both
    // the length floor (12) and the distinct-character floor (6, this
    // phrase has ~11 distinct chars); must NOT be over-refused.
    recordKeep(proj, { target: 'f.md:clause', reason: 'test', anchor: 'a rare specific phrase indeed', anchorFile: 'C:/store/f.md' });
    const entry = loadKeeps(proj).find((k) => k.target === 'f.md:clause');
    assert.strictEqual(entry.anchor, 'a rare specific phrase indeed', 'a genuinely distinctive short phrase must still be accepted');
  } finally { clean(proj); }
});

// grad10 F5 [MEDIUM, both polarities]: `\p{Cf}` alone missed FOUR more
// invisible/degenerate classes reproducing the SAME bug: combining marks
// (Mn), controls beyond `\s` (Cc), and two specific non-strippable-category
// codepoints (Hangul filler U+3164 is Lo, Braille blank U+2800 is So).
// Each ×8 (mirroring the lab's own repro shape) should read as degenerate,
// same as round 9's "e"/"#"/"the".
//
// grad11 F5 correction: Mn is NO LONGER in the strip set (see keeps.mjs own
// header comment on stripInvisible). The U+0300 row below is still
// correctly refused, but now through the ORDINARY length floor (8 raw
// chars < 12), the same door as any other too-short junk -- not through
// invisible-stripping. The other three rows are unaffected; Cc/Lo/So were
// never touched by that fix.
const F5_INVISIBLE = {
  'U+0300 combining grave (Mn)': '\u0300'.repeat(8),
  'U+0001 control (Cc)': '\u0001'.repeat(8),
  'U+3164 Hangul filler (Lo)': '\u3164'.repeat(8),
  'U+2800 Braille blank (So)': '\u2800'.repeat(8),
};
for (const [label, junk] of Object.entries(F5_INVISIBLE)) {
  test(`RED-FIRST/F5-invisible: a re-affirm passing ${label} does NOT overwrite the prior real anchor`, () => {
    const proj = sandbox();
    try {
      const real = 'the exact protected span, ninety-plus characters long so it is unmistakably a real adjudicated clause not a fragment';
      recordKeep(proj, { target: 'f.md:clause', reason: 'first adjudication', anchor: real, anchorFile: 'C:/store/f.md' });
      recordKeep(proj, { target: 'f.md:clause', reason: 'invisible re-affirm', anchor: junk, anchorFile: 'C:/store/f.md' });
      const entry = loadKeeps(proj).find((k) => k.target === 'f.md:clause');
      assert.strictEqual(entry.anchor, real, `${label} must NOT replace the prior real one`);
    } finally { clean(proj); }
  });
}

test('RED-FIRST/F5-invisible control: real CJK/Thai text (containing legitimate combining marks and Lo-category letters) is NOT wrongly rejected as invisible', () => {
  const proj = sandbox();
  try {
    // Thai script legitimately combines base consonants with Mn vowel/tone
    // marks; CJK ideographs are legitimately Lo. Neither is what F5 strips
    // -- only the SPECIFIC invisible-rendering codepoints are. (grad11 F5:
    // Mn used to ALSO be stripped, on the theory that undercounting is
    // always safe -- it is not, for exactly this content. Fixed at source.)
    const thai = 'สวัสดีครับ ยินดีต้อนรับเข้าสู่ระบบของเรา'; // real Thai sentence, well over the floor
    const r = recordKeep(proj, { target: 'f.md:thai', reason: 'test', anchor: thai, anchorFile: 'C:/store/f.md' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.anchorDropped, false, 'a real Thai clause over the floor must not read as dropped');
    const entry = loadKeeps(proj).find((k) => k.target === 'f.md:thai');
    assert.strictEqual(entry.anchor, thai, 'real Thai text must be accepted as a distinctive anchor, verbatim');
  } finally { clean(proj); }
});

// grad10-round-2 HIGH-2 [content-loss, silent and total]: F4's word-count
// requirement assumed every script marks word boundaries with whitespace.
// The ABOVE Thai control has a phrase-level space in it and so passed the
// old word-count test too -- false comfort, per the reviewer's own finding.
// These fixtures are genuinely SPACE-FREE (real Thai/Japanese/Chinese
// clauses, single unbroken run), which the OLD design refused outright and
// SILENTLY (recordKeep still returns true; the anchor is simply dropped).
const HIGH2_NO_DELIMITER = {
  'Thai, no phrase spaces (50 chars)': 'การป้องกันข้อมูลส่วนบุคคลเป็นสิ่งสำคัญมากในยุคดิจิทัลปัจจุบันนี้อย่างแน่นอน',
  'Japanese (31 chars)': 'これは実際に保護されるべき重要な設定項目についての具体的な説明文です',
  'Chinese (24 chars)': '这是一个真正需要保护的重要配置项目的具体说明',
};
for (const [label, anchor] of Object.entries(HIGH2_NO_DELIMITER)) {
  test(`RED-FIRST/HIGH2-no-delimiter: ${label} — a real, space-free clause is enforced as a real anchor`, () => {
    const proj = sandbox();
    try {
      const r = recordKeep(proj, { target: 'f.md:clause', reason: 'test', anchor, anchorFile: 'C:/store/f.md' });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.anchorDropped, false);
      const entry = loadKeeps(proj).find((k) => k.target === 'f.md:clause');
      assert.strictEqual(entry.anchor, anchor, `${label} must become a real enforcement handle -- no word delimiter needed`);
    } finally { clean(proj); }
  });
}

test('RED-FIRST/HIGH2-short-real-phrase: "git rev-parse HEAD" (16 stripped chars, 3 words, under the OLD 20-char floor) is enforced — short and real is not the same as non-distinctive', () => {
  const proj = sandbox();
  try {
    const anchor = 'git rev-parse HEAD';
    const r = recordKeep(proj, { target: 'f.md:cmd', reason: 'test', anchor, anchorFile: 'C:/store/f.md' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.anchorDropped, false);
    const entry = loadKeeps(proj).find((k) => k.target === 'f.md:cmd');
    assert.strictEqual(entry.anchor, anchor, 'a short, genuinely distinctive command must not be refused for its length alone');
  } finally { clean(proj); }
});

test('RED-FIRST/HIGH2-junk-still-refused: the reported junk shapes stay refused under the new distinct-character measure too', () => {
  const proj = sandbox();
  try {
    for (const junk of ['whatever', '!!!!!!!!', 'e', '#', 'the']) {
      const r = recordKeep(proj, { target: `f.md:${junk}`, reason: 'test', anchor: junk, anchorFile: 'C:/store/f.md' });
      assert.strictEqual(r.ok, true, `write itself still succeeds for ${JSON.stringify(junk)}`);
      assert.strictEqual(r.anchorDropped, true, `${JSON.stringify(junk)} was requested and did not clear the floor`);
      const entry = loadKeeps(proj).find((k) => k.target === `f.md:${junk}`);
      assert.strictEqual(entry.anchor, undefined, `${JSON.stringify(junk)} must still get NO enforcement handle`);
    }
    // a LONGER pure-repetition string must also be refused -- the length
    // floor alone can always be cleared by repeating one character; the
    // distinct-character floor is what actually closes that door.
    const longRepeat = '!'.repeat(30);
    recordKeep(proj, { target: 'f.md:longrepeat', reason: 'test', anchor: longRepeat, anchorFile: 'C:/store/f.md' });
    const entry2 = loadKeeps(proj).find((k) => k.target === 'f.md:longrepeat');
    assert.strictEqual(entry2.anchor, undefined, 'a 30-char single-character repeat clears the length floor but must still be refused (1 distinct char < 6)');
  } finally { clean(proj); }
});

// ---------------------------------------------------------------------------
// grad11 STEP 1 — F5, the dispatch's own two named sub-defects, reproduced
// with the dispatch's own exact examples.
// ---------------------------------------------------------------------------

test('grad11 F5 floor-value: the dispatch\'s own 3-line YAML anchor (whitespace-stripped to 9 chars under the OLD rule) now clears the floor', () => {
  const proj = sandbox();
  try {
    const anchor = 'a: 1\nb: 2\nc: 3';
    const r = recordKeep(proj, { target: 'f.md:yaml', reason: 'test', anchor, anchorFile: 'C:/store/f.md' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.anchorDropped, false, 'an ordinary 3-key multi-line anchor must not be treated as too short');
    const entry = loadKeeps(proj).find((k) => k.target === 'f.md:yaml');
    assert.strictEqual(entry.anchor, anchor, 'stored verbatim, not the whitespace-collapsed measuring form');
  } finally { clean(proj); }
});

test('grad11 F5 floor-value: the dispatch\'s own Thai example ("ห้ามลบไฟล์นี้", 13 codepoints -> 9 under the OLD Mn-stripping rule) now clears the floor', () => {
  const proj = sandbox();
  try {
    const anchor = 'ห้ามลบไฟล์นี้';
    const r = recordKeep(proj, { target: 'f.md:thai-short', reason: 'test', anchor, anchorFile: 'C:/store/f.md' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.anchorDropped, false, 'a real 13-codepoint Thai clause must not be treated as too short because its combining marks were stripped');
    const entry = loadKeeps(proj).find((k) => k.target === 'f.md:thai-short');
    assert.strictEqual(entry.anchor, anchor);
  } finally { clean(proj); }
});

test('grad11 F5 floor-value control: whitespace-padding still refuses -- collapsing runs is not the same as counting them', () => {
  const proj = sandbox();
  try {
    const anchor = 'x' + ' '.repeat(20); // "x" + padding -- must still read as ~1 real char
    const r = recordKeep(proj, { target: 'f.md:padded', reason: 'test', anchor, anchorFile: 'C:/store/f.md' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.anchorDropped, true, 'whitespace padding must not manufacture a passing length');
    const entry = loadKeeps(proj).find((k) => k.target === 'f.md:padded');
    assert.strictEqual(entry.anchor, undefined);
  } finally { clean(proj); }
});

test('grad11 F5 return-contract: recordKeepAt returns an object, never a bare boolean', () => {
  const proj = sandbox();
  try {
    const r = recordKeep(proj, { target: 'x', reason: 'r' });
    assert.strictEqual(typeof r, 'object');
    assert.notStrictEqual(r, null);
    assert.strictEqual(typeof r.ok, 'boolean');
    assert.strictEqual(typeof r.anchorDropped, 'boolean');
    assert.strictEqual(typeof r.anchorStored, 'boolean');
  } finally { clean(proj); }
});
// ---------------------------------------------------------------------------
// PENDING-USER (board #129, THE USER-OWNED CLASS): a keep whose own reason
// names the user as decision-holder must not settle silently. Opposite
// clearing rule from anchor/anchorFile on purpose (see keeps.mjs's own
// comment) -- undefined preserves, explicit false clears, explicit true sets.
// ---------------------------------------------------------------------------

test('recordKeep: pendingUser:true persists with a pendingSince date; plain keeps carry neither field', () => {
  const proj = sandbox();
  try {
    recordKeep(proj, { target: 'user-owned-thing', reason: 'this is the user own tradeoff', pendingUser: true, pendingSince: '2026-08-23' });
    recordKeep(proj, { target: 'plain', reason: 'ordinary agent-decided keep' });
    const keeps = loadKeeps(proj);
    const pending = keeps.find((k) => k.target === 'user-owned-thing');
    assert.strictEqual(pending.pendingUser, true);
    assert.strictEqual(pending.pendingSince, '2026-08-23');
    const plain = keeps.find((k) => k.target === 'plain');
    assert.ok(!('pendingUser' in plain) && !('pendingSince' in plain), 'no field pollution on an ordinary keep');
  } finally { clean(proj); }
});

test('recordKeep: re-affirming WITHOUT mentioning pendingUser PRESERVES it (the standing violation must not silently re-settle)', () => {
  const proj = sandbox();
  try {
    recordKeep(proj, { target: 'x', reason: 'user own tradeoff', pendingUser: true, pendingSince: '2026-08-23' });
    // an ordinary re-affirm from a caller that has never heard of this mechanism
    const reAffirmed = recordKeep(proj, { target: 'x', reason: 'user own tradeoff, re-reviewed', date: '2026-09-01' });
    // r33 ascent: the lane's grad11 F5 return contract ascends, so the bare
    // boolean this compared against is now `{ ok, anchorDropped, anchorStored }`.
    // Same claim, one field deeper — and it additionally pins the shape.
    assert.strictEqual(reAffirmed.ok, true);
    const entry = loadKeeps(proj).find((k) => k.target === 'x');
    assert.strictEqual(entry.reason, 'user own tradeoff, re-reviewed', 'the new reason must still land');
    assert.strictEqual(entry.pendingUser, true, 'pendingUser must survive an omit -- this is the whole point of the mechanism');
    assert.strictEqual(entry.pendingSince, '2026-08-23', 'the ORIGINAL pendingSince survives too, never reset by an unrelated re-affirm');
  } finally { clean(proj); }
});

test('recordKeep: pendingUser:false EXPLICITLY clears it (the only way -- the user actually answered)', () => {
  const proj = sandbox();
  try {
    recordKeep(proj, { target: 'x', reason: 'user own tradeoff', pendingUser: true, pendingSince: '2026-08-23' });
    recordKeep(proj, { target: 'x', reason: 'user confirmed keep, 2026-09-01', pendingUser: false });
    const entry = loadKeeps(proj).find((k) => k.target === 'x');
    assert.ok(!('pendingUser' in entry) && !('pendingSince' in entry), 'an explicit false clears both fields');
  } finally { clean(proj); }
});

test('pendingUserKeeps: filters to exactly the pending entries, [] on none/malformed input', () => {
  assert.deepStrictEqual(pendingUserKeeps([]), []);
  assert.deepStrictEqual(pendingUserKeeps(null), []);
  assert.deepStrictEqual(pendingUserKeeps(undefined), []);
  const list = [
    { target: 'a', pendingUser: true },
    { target: 'b' },
    { target: 'c', pendingUser: false },
    { target: 'd', pendingUser: 'true' }, // truthy string is NOT the boolean -- must not match
  ];
  assert.deepStrictEqual(pendingUserKeeps(list).map((k) => k.target), ['a']);
});

// U7 (CB board 2026-08-31) -- the same alias-at-the-temp class apply.mjs's
// writeDurable carries, at the SECONDARY sites the board's sweep clause points
// at. keeps.json lives in the PROJECT tree (txDirFor), the same trust zone as a
// class-B memory file: anything with project write access can pre-place an
// alias. The old temp was `<file>.tmp`, fully derivable, written with a plain
// writeFileSync -- which follows it. Cure = CSPRNG suffix + flag 'wx'.
//
// A hardlink is the unprivileged stand-in for the EPERM-blocked file symlink on
// this box; it aliases an inode the same way for a write.
function hardlinkCapable() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cwk-hlprobe-'));
  try {
    const a = path.join(d, 'a');
    fs.writeFileSync(a, 'x');
    fs.linkSync(a, path.join(d, 'b'));
    return true;
  } catch {
    return false;
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
}

test('U7: recordKeep never writes THROUGH an alias planted at its temp -- the file outside the project is untouched and the record fails closed', (t) => {
  // ONE skippable leg, capability-PROBED: without hardlink creation the plant
  // cannot be built, so the test would pass vacuously rather than prove anything.
  if (!hardlinkCapable()) { t.skip('this volume refuses hardlink creation -- the unprivileged stand-in for the EPERM-blocked file symlink cannot be planted here'); return; }
  const proj = sandbox();
  const victim = path.join(proj, 'VICTIM-outside-the-store.txt');
  fs.writeFileSync(victim, 'VICTIM ORIGINAL', 'utf8');
  const realWrite = fs.writeFileSync;
  let planted = null;
  fs.writeFileSync = (p, ...rest) => {
    if (planted === null && typeof p === 'string' && p.includes('.tmp')) {
      planted = p;
      try { fs.linkSync(victim, p); } catch { /* a pre-existing entry is itself the fail-closed case */ }
    }
    return realWrite(p, ...rest);
  };
  let ok;
  try {
    ok = recordKeep(proj, { target: 'MEMORY.md', reason: 'u7' });
  } finally { fs.writeFileSync = realWrite; }
  try {
    assert.ok(planted, 'the plant fired (a temp path was written) -- otherwise this test proves nothing');
    assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'VICTIM ORIGINAL', 'the file outside the project is UNTOUCHED (pre-fix the plain write follows the planted alias and truncates it)');
    // r33 ascent: `.ok`, for the same reason as the pendingUser test above.
    // NOTE the direction — `{ ok: false }` is TRUTHY, so a test written as a
    // truthiness check would have started passing VACUOUSLY here. Swept: this
    // file and apply.test.mjs contain no such check (every other assertion on
    // this return already reads `.ok`).
    assert.strictEqual(ok.ok, false, 'the record fails closed on EEXIST at the O_EXCL temp, never silently through the alias');
    assert.deepStrictEqual(loadKeeps(proj), [], 'and nothing was recorded');
  } finally { clean(proj); }
});

// ---------------------------------------------------------------------------
// fire 126 (18a item 3): keeps.json's read-modify-write runs under its own lock. The seam is the store's temp write
// (fs.writeFileSync on `<store>.<hex>.tmp`): a second recorder, a thief or an unreadable lock is put there, inside the
// first recorder's read-modify-write, the moment between its read and its rename.
// ---------------------------------------------------------------------------
function atKeepsTemp(file, fn, { after = false } = {}) {
  const real = fs.writeFileSync;
  let fired = false;
  fs.writeFileSync = function patched(p, ...rest) {
    const hit = !fired && String(p).startsWith(`${file}.`) && String(p).endsWith('.tmp');
    if (hit) fired = true;
    if (hit && !after) fn();
    const out = real.call(fs, p, ...rest);
    if (hit && after) fn();
    return out;
  };
  return () => { fs.writeFileSync = real; return fired; };
}
function faultReads(lockPath) {
  const real = fs.openSync;
  const want = path.resolve(lockPath);
  const f = { armed: false };
  fs.openSync = function patched(p, flags, ...rest) {
    const isRead = typeof flags === 'number' && (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) === 0;
    if (f.armed && isRead && path.resolve(String(p)) === want) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    return real.call(fs, p, flags, ...rest);
  };
  f.restore = () => { fs.openSync = real; };
  return f;
}
const targetsIn = (keeps) => keeps.map((k) => k.target).sort();
// read through the namespace so this file still loads against a keeps.mjs that predates the lock (the red-first run)
const KEEPS_LOCK_STALE_MS = keepsModule.KEEPS_LOCK_STALE_MS ?? 5000;

for (const [scope, mk] of [
  ['project', () => { const proj = sandbox(); return { dirs: [proj], file: keepsPath(proj), rec: (o) => recordKeep(proj, o), load: () => loadKeeps(proj) }; }],
  ['global', () => { const home = sandbox(); return { dirs: [home], file: globalKeepsPath(home), rec: (o) => recordGlobalKeep(home, o), load: () => loadGlobalKeeps(home) }; }],
]) {
  test(`fire 126: two ${scope} keep recorders interleaved inside the read-modify-write never drop one another: the second is refused while the first holds the lock, and on retry both entries stand`, () => {
    const s = mk();
    try {
      assert.strictEqual(s.rec({ target: 'base', reason: 'already there' }).ok, true);
      let second = null;
      const done = atKeepsTemp(s.file, () => { second = s.rec({ target: 'second', reason: 'recorded meanwhile' }); });
      const first = s.rec({ target: 'first', reason: 'recorded first' });
      assert.strictEqual(done(), true, 'the seam fired inside the first recorder');
      assert.strictEqual(first.ok, true, JSON.stringify(first));
      assert.ok(second, 'the second recorder ran inside the first one');
      // the invariant: no call that answered ok has lost its entry
      for (const [name, r] of [['first', first], ['second', second]]) {
        if (r.ok) assert.ok(targetsIn(s.load()).includes(name), `${name} answered ok, so its entry must be on disk`);
      }
      assert.strictEqual(second.ok, false, 'the second recorder could not take the lock the first held');
      assert.ok(second.error.includes(`keeps lock: another recorder holds ${s.file}.lock`) && second.error.includes('nothing was written'), second.error);
      assert.strictEqual(s.rec({ target: 'second', reason: 'recorded meanwhile' }).ok, true, 'the caller records it again');
      assert.deepStrictEqual(targetsIn(s.load()), ['base', 'first', 'second']);
      assert.strictEqual(fs.existsSync(`${s.file}.lock`), false, 'the lock is released');
    } finally { clean(...s.dirs); }
  });
}

test('fire 126: a keeps lock held by another recorder refuses the record and writes nothing', () => {
  const proj = sandbox();
  try {
    assert.strictEqual(recordKeep(proj, { target: 'base' }).ok, true);
    const before = fs.readFileSync(keepsPath(proj));
    const held = JSON.stringify({ sessionId: 'other', pid: 1, at: Date.now(), token: 'other:1:1' });
    fs.writeFileSync(`${keepsPath(proj)}.lock`, held);
    const r = recordKeep(proj, { target: 'blocked' });
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.ok(r.error.includes(`keeps lock: another recorder holds ${keepsPath(proj)}.lock`), r.error);
    assert.deepStrictEqual(fs.readFileSync(keepsPath(proj)), before, 'the store is unchanged');
    assert.strictEqual(fs.readFileSync(`${keepsPath(proj)}.lock`, 'utf8'), held, 'the other recorder\'s lock is untouched');
  } finally { clean(proj); }
});

test('fire 126: a keep recorder robbed of its lock before the rename refuses and leaves the new holder\'s store standing', () => {
  const proj = sandbox();
  const lockPath = `${keepsPath(proj)}.lock`;
  try {
    assert.strictEqual(recordKeep(proj, { target: 'base' }).ok, true);
    const thiefStore = JSON.stringify({ v: 1, keeps: [{ target: 'base', reason: '', date: '2026-10-18' }, { target: 'thief', reason: 'the new holder', date: '2026-10-18' }] });
    let thief = null;
    const done = atKeepsTemp(keepsPath(proj), () => {
      const old = new Date(Date.now() - KEEPS_LOCK_STALE_MS - 60000);
      fs.utimesSync(lockPath, old, old);
      thief = acquireLock(lockPath, { sessionId: 'thief', staleMs: KEEPS_LOCK_STALE_MS });
      assert.ok(thief.acquired && thief.stale, JSON.stringify(thief));
      fs.writeFileSync(keepsPath(proj), thiefStore); // the new holder's own write
    }, { after: true });
    const r = recordKeep(proj, { target: 'robbed' });
    done();
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.ok(r.error.startsWith(`keeps lock stolen: another recorder took over ${lockPath} after it went stale (5 s)`) && r.error.includes('the store on disk stands'), r.error);
    assert.strictEqual(fs.readFileSync(keepsPath(proj), 'utf8'), thiefStore, 'the new holder\'s store was not overwritten');
    assert.deepStrictEqual(fs.readdirSync(path.dirname(keepsPath(proj))).filter((n) => n.endsWith('.tmp')), [], 'no temp left');
    assert.strictEqual(thief.owns(), true, 'the release left the thief\'s lock alone');
  } finally { clean(proj); }
});

test('fire 126: a keep recorder whose lock turns unreadable before the rename refuses honestly and names the lock it left', () => {
  const proj = sandbox();
  const lockPath = `${keepsPath(proj)}.lock`;
  const fault = faultReads(lockPath);
  try {
    assert.strictEqual(recordKeep(proj, { target: 'base' }).ok, true);
    const before = fs.readFileSync(keepsPath(proj));
    const done = atKeepsTemp(keepsPath(proj), () => { fault.armed = true; }, { after: true });
    const r = recordKeep(proj, { target: 'unread' });
    done();
    fault.restore();
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.ok(r.error.startsWith(`keeps lock unreadable: ${lockPath} could not be read for about one second (EBUSY`), r.error);
    assert.ok(!r.error.includes('took over'), r.error);
    assert.deepStrictEqual(fs.readFileSync(keepsPath(proj)), before, 'nothing written');
    assert.strictEqual(r.lockLeft, `The lock file ${lockPath} could not be read to confirm it is this run's own (EBUSY), so it was left in place: a later run defers until it goes stale (5 s), or remove it by hand once no CoalWash run is active.`, 'the keeps lock names its own 5 s window, never the 30-minute one (E1 t182 #1)');
    assert.strictEqual(fs.existsSync(lockPath), true);
  } finally { fault.restore(); clean(proj); }
});

test('fire 126: a keeps lock whose holder lets go during the retries is taken on a later attempt, and the record lands', () => {
  const proj = sandbox();
  const lockPath = `${keepsPath(proj)}.lock`;
  const realWait = Atomics.wait;
  try {
    assert.strictEqual(recordKeep(proj, { target: 'base' }).ok, true);
    fs.writeFileSync(lockPath, JSON.stringify({ sessionId: 'other', pid: 1, at: Date.now(), token: 'other:1:1' }));
    let pauses = 0;
    // the seam: the retry's pause; the other recorder finishes (removes its lock) during the first one
    Atomics.wait = function patched(...args) { if (++pauses === 1) fs.rmSync(lockPath, { force: true }); return realWait.apply(Atomics, args); };
    let r;
    try { r = recordKeep(proj, { target: 'later' }); } finally { Atomics.wait = realWait; }
    assert.ok(pauses >= 1, 'the recorder retried');
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(targetsIn(loadKeeps(proj)), ['base', 'later']);
  } finally { Atomics.wait = realWait; clean(proj); }
});

test('fire 126: a store a newer CoalWash wrote while this recorder waited for the lock is re-checked inside the lock and left untouched', () => {
  const proj = sandbox();
  const lockPath = `${keepsPath(proj)}.lock`;
  const realWait = Atomics.wait;
  try {
    assert.strictEqual(recordKeep(proj, { target: 'base' }).ok, true);
    fs.writeFileSync(lockPath, JSON.stringify({ sessionId: 'newer', pid: 1, at: Date.now(), token: 'newer:1:1' }));
    const newerStore = JSON.stringify({ v: 2, keeps: [{ target: 'base' }], extra: 'a newer schema' });
    let pauses = 0;
    // the seam: during the first retry pause, a newer CoalWash finishes its own record (a v2 store) and lets go of the lock
    Atomics.wait = function patched(...args) {
      if (++pauses === 1) { fs.writeFileSync(keepsPath(proj), newerStore); fs.rmSync(lockPath, { force: true }); }
      return realWait.apply(Atomics, args);
    };
    let r;
    try { r = recordKeep(proj, { target: 'mine' }); } finally { Atomics.wait = realWait; }
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.strictEqual(fs.readFileSync(keepsPath(proj), 'utf8'), newerStore, 'the newer store is read-only to us');
    assert.strictEqual(fs.existsSync(lockPath), false, 'and the lock was still released');
  } finally { Atomics.wait = realWait; clean(proj); }
});

// ---------------------------------------------------------------------------
// fire 129 (INSPECT 128 M128-1, N128-1): on Windows a rename over a store another handle holds open fails EPERM (the lock
// serialises writers, never readers). The rename is retried with the lock re-checked before each try, no temp is ever left,
// and a lock path that is not a plain file refuses at once. The seam is fs.renameSync on the store (POSIX has no EPERM there);
// one more leg holds a REAL read handle where the volume refuses that rename, skipping visibly by a probe elsewhere.
// ---------------------------------------------------------------------------
const KEEPS_RENAME_WAIT_MS = keepsModule.KEEPS_RENAME_WAIT_MS ?? 50; // through the namespace, as KEEPS_LOCK_STALE_MS above
function failRenames(file, { n = Infinity, code = 'EPERM' } = {}) {
  const real = fs.renameSync;
  const f = { tries: 0, failed: 0 };
  fs.renameSync = function patched(from, to, ...rest) {
    if (path.resolve(String(to)) === path.resolve(file)) {
      f.tries++;
      if (f.failed < n) { f.failed++; throw Object.assign(new Error(`${code}: operation not permitted, rename '${from}' -> '${to}'`), { code }); }
    }
    return real.call(fs, from, to, ...rest);
  };
  f.restore = () => { fs.renameSync = real; };
  return f;
}
const tempsBeside = (file) => fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith(`${path.basename(file)}.`) && n.endsWith('.tmp'));

test('fire 129: a keep record whose rename meets a reader holding the store open for a moment is retried and lands, leaving no temp', () => {
  const proj = sandbox();
  try {
    assert.strictEqual(recordKeep(proj, { target: 'base' }).ok, true);
    const f = failRenames(keepsPath(proj), { n: 3 });
    let r;
    try { r = recordKeep(proj, { target: 'later' }); } finally { f.restore(); }
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(f.tries, 4, 'three failed renames, then the one that landed');
    assert.deepStrictEqual(targetsIn(loadKeeps(proj)), ['base', 'later']);
    assert.deepStrictEqual(tempsBeside(keepsPath(proj)), [], 'no temp left');
  } finally { clean(proj); }
});

test('fire 129: a keep record whose rename keeps failing refuses with "record the keep again", leaves the store as it was and no temp', () => {
  const proj = sandbox();
  try {
    assert.strictEqual(recordKeep(proj, { target: 'base' }).ok, true);
    const before = fs.readFileSync(keepsPath(proj));
    const f = failRenames(keepsPath(proj));
    let r;
    try { r = recordKeep(proj, { target: 'never' }); } finally { f.restore(); }
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.ok(r.error.startsWith(`keeps write: the store ${keepsPath(proj)} could not be replaced (EPERM, 10 attempts ${KEEPS_RENAME_WAIT_MS} ms apart`), r.error);
    assert.ok(r.error.endsWith('record the keep again'), r.error);
    assert.strictEqual(f.tries, 10);
    assert.deepStrictEqual(fs.readFileSync(keepsPath(proj)), before, 'the store is unchanged');
    assert.deepStrictEqual(tempsBeside(keepsPath(proj)), [], 'no temp left');
    assert.strictEqual(fs.existsSync(`${keepsPath(proj)}.lock`), false, 'the lock is released');
  } finally { clean(proj); }
});

test('fire 129: a lock stolen while the rename waits out a reader still refuses at the next retry, and its temp is removed', () => {
  const proj = sandbox();
  const lockPath = `${keepsPath(proj)}.lock`;
  const realWait = Atomics.wait;
  try {
    assert.strictEqual(recordKeep(proj, { target: 'base' }).ok, true);
    const f = failRenames(keepsPath(proj));
    let thief = null;
    // the seam: the rename retry's own pause; the recorder stalls there long enough to be robbed
    Atomics.wait = function patched(arr, idx, val, ms) {
      if (ms === KEEPS_RENAME_WAIT_MS && !thief) {
        const old = new Date(Date.now() - KEEPS_LOCK_STALE_MS - 60000);
        fs.utimesSync(lockPath, old, old);
        thief = acquireLock(lockPath, { sessionId: 'thief', staleMs: KEEPS_LOCK_STALE_MS });
      }
      return realWait.call(Atomics, arr, idx, val, ms);
    };
    let r;
    try { r = recordKeep(proj, { target: 'robbed' }); } finally { Atomics.wait = realWait; f.restore(); }
    assert.ok(thief && thief.acquired, 'the thief took the lock during the wait');
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.ok(r.error.startsWith(`keeps lock stolen: another recorder took over ${lockPath}`) && r.error.endsWith('record the keep again'), r.error);
    assert.strictEqual(f.tries, 1, 'no rename was tried after the theft');
    assert.deepStrictEqual(tempsBeside(keepsPath(proj)), [], 'no temp left');
    assert.strictEqual(thief.owns(), true);
  } finally { Atomics.wait = realWait; clean(proj); }
});

test('fire 129: a keep record whose rename fails for another reason leaves no temp either', () => {
  const proj = sandbox();
  try {
    assert.strictEqual(recordKeep(proj, { target: 'base' }).ok, true);
    const f = failRenames(keepsPath(proj), { code: 'ENOSPC' });
    let r;
    try { r = recordKeep(proj, { target: 'full' }); } finally { f.restore(); }
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.ok(r.error.startsWith('ENOSPC'), r.error);
    assert.strictEqual(f.tries, 1, 'a non-transient code is not retried');
    assert.deepStrictEqual(tempsBeside(keepsPath(proj)), [], 'no temp left');
  } finally { clean(proj); }
});

// the capability: does this volume refuse a rename over a file another handle holds open? (Windows does; POSIX does not)
function renameRefusedWhileOpen() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwk-probe-')));
  try {
    fs.writeFileSync(path.join(dir, 'a'), 'a');
    fs.writeFileSync(path.join(dir, 'b'), 'b');
    const fd = fs.openSync(path.join(dir, 'a'), 'r');
    try { fs.renameSync(path.join(dir, 'b'), path.join(dir, 'a')); return false; } catch (e) { return ['EPERM', 'EACCES', 'EBUSY'].includes(e && e.code); } finally { fs.closeSync(fd); }
  } finally { clean(dir); }
}

test('fire 129: a REAL read handle held on keeps.json across the rename is outwaited: the record lands once it closes, no temp left', (t) => {
  if (!renameRefusedWhileOpen()) { t.skip('this volume lets a rename replace a file another handle holds open (POSIX): the seam legs above cover the retry'); return; }
  const proj = sandbox();
  const realWait = Atomics.wait;
  let fd = null;
  try {
    assert.strictEqual(recordKeep(proj, { target: 'base' }).ok, true);
    fd = fs.openSync(keepsPath(proj), 'r');
    let closedAt = 0;
    // the reader finishes during the recorder's first rename wait
    Atomics.wait = function patched(arr, idx, val, ms) {
      if (ms === KEEPS_RENAME_WAIT_MS && fd !== null) { fs.closeSync(fd); fd = null; closedAt++; }
      return realWait.call(Atomics, arr, idx, val, ms);
    };
    let r;
    try { r = recordKeep(proj, { target: 'later' }); } finally { Atomics.wait = realWait; }
    assert.strictEqual(closedAt, 1, 'the first rename really failed on the open handle and waited');
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(targetsIn(loadKeeps(proj)), ['base', 'later']);
    assert.deepStrictEqual(tempsBeside(keepsPath(proj)), [], 'no temp left');
  } finally { Atomics.wait = realWait; if (fd !== null) fs.closeSync(fd); clean(proj); }
});

test('N128-1: a keeps lock path that is a directory refuses at once, says what it found, and spends no retry', () => {
  const proj = sandbox();
  const lockPath = `${keepsPath(proj)}.lock`;
  const realWait = Atomics.wait;
  try {
    assert.strictEqual(recordKeep(proj, { target: 'base' }).ok, true);
    const before = fs.readFileSync(keepsPath(proj));
    fs.mkdirSync(lockPath);
    let pauses = 0;
    Atomics.wait = function patched(...args) { pauses++; return realWait.apply(Atomics, args); };
    let r;
    try { r = recordKeep(proj, { target: 'blocked' }); } finally { Atomics.wait = realWait; }
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.ok(r.error.startsWith(`keeps lock: ${lockPath} is not a plain file (it is a directory)`) && r.error.includes('no retry was spent'), r.error);
    assert.ok(!r.error.includes('another recorder holds'), r.error);
    assert.strictEqual(pauses, 0, 'not one retry pause');
    assert.deepStrictEqual(fs.readFileSync(keepsPath(proj)), before);
    assert.strictEqual(fs.statSync(lockPath).isDirectory(), true, 'the planted directory is left alone');
  } finally { Atomics.wait = realWait; clean(proj); }
});

// ---------------------------------------------------------------------------
// fire 133 (E1 t182 #2, RE-INSPECT 131 L131-1): a lock or store that can never be written says so at once, spends no retry,
// and never tells the caller to record the keep again. Seams: the lock's `wx` open (fs.openSync) and the store's rename
// (fs.renameSync); one leg uses a REAL read-only store where a probe shows the volume refuses that rename.
// ---------------------------------------------------------------------------
// `times`: how many creates fail before the real open is let through (fire 136); default, every one.
function failLockCreate(lockPath, code, times = Infinity) {
  const real = fs.openSync;
  const f = { tries: 0 };
  fs.openSync = function patched(p, flags, ...rest) {
    if (flags === 'wx' && path.resolve(String(p)) === path.resolve(lockPath) && f.tries < times) { f.tries++; throw Object.assign(new Error(`${code}: permission denied, open '${p}'`), { code }); }
    return real.call(fs, p, flags, ...rest);
  };
  f.restore = () => { fs.openSync = real; };
  return f;
}
function countPauses() {
  const real = Atomics.wait;
  const c = { n: 0 };
  Atomics.wait = function patched(...args) { c.n++; return real.apply(Atomics, args); };
  c.restore = () => { Atomics.wait = real; };
  return c;
}

// fire 136 (RE-INSPECT 135 M135-1) amends this leg: EACCES on the create is also what contention looks like on Windows, so an
// unwritable ~/.claude now spends the 40-attempt budget before it refuses, and the refusal says how many attempts it made.
test('fire 133: a global keeps lock that cannot be created (an unwritable ~/.claude) refuses after the retry budget and says how many attempts it made', () => {
  const home = sandbox();
  const lockPath = `${globalKeepsPath(home)}.lock`;
  try {
    assert.strictEqual(recordGlobalKeep(home, { target: 'base' }).ok, true);
    const before = fs.readFileSync(globalKeepsPath(home));
    const f = failLockCreate(lockPath, 'EACCES');
    const pauses = countPauses();
    let r;
    try { r = recordGlobalKeep(home, { target: 'blocked' }); } finally { pauses.restore(); f.restore(); }
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.ok(r.error.startsWith(`keeps lock: ${lockPath} could not be created after 40 attempts (EACCES)`), r.error);
    assert.ok(!r.error.includes('waiting will not change it') && !r.error.includes('another recorder holds'), r.error);
    assert.strictEqual(f.tries, 40, 'the whole budget');
    assert.strictEqual(pauses.n, 39, 'one pause between attempts');
    assert.deepStrictEqual(fs.readFileSync(globalKeepsPath(home)), before);
  } finally { clean(home); }
});

// ---------------------------------------------------------------------------
// fire 136 (RE-INSPECT 135 M135-1 and its LOW): a create or read-back error that can pass under contention is retried inside the
// budget, and called final only once the budget is spent.
// ---------------------------------------------------------------------------
test('fire 136: a keeps lock create refused with EPERM for a moment is retried and the keep lands', () => {
  const proj = sandbox();
  const lockPath = `${keepsPath(proj)}.lock`;
  try {
    assert.strictEqual(recordKeep(proj, { target: 'base' }).ok, true);
    const f = failLockCreate(lockPath, 'EPERM', 3);
    let r;
    try { r = recordKeep(proj, { target: 'landed' }); } finally { f.restore(); }
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(f.tries, 3, 'three refused creates, then the real one');
    assert.deepStrictEqual(loadKeeps(proj).map((k) => k.target).sort(), ['base', 'landed']);
    assert.strictEqual(fs.existsSync(lockPath), false, 'the lock is released');
  } finally { clean(proj); }
});

test('fire 136: a keeps lock create that EPERM refuses every time is called final only after 40 attempts, and says so', () => {
  const proj = sandbox();
  const lockPath = `${keepsPath(proj)}.lock`;
  try {
    assert.strictEqual(recordKeep(proj, { target: 'base' }).ok, true);
    const before = fs.readFileSync(keepsPath(proj));
    const f = failLockCreate(lockPath, 'EPERM');
    let r;
    try { r = recordKeep(proj, { target: 'blocked' }); } finally { f.restore(); }
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.strictEqual(r.error, `keeps lock: ${lockPath} could not be created after 40 attempts (EPERM); nothing was written — record the keep again, and if it fails the same way again, check that the folder can be written`);
    assert.strictEqual(f.tries, 40);
    assert.deepStrictEqual(fs.readFileSync(keepsPath(proj)), before);
  } finally { clean(proj); }
});

test('fire 136: a keeps lock create error that cannot pass by waiting (EROFS) still refuses at once', () => {
  const proj = sandbox();
  const lockPath = `${keepsPath(proj)}.lock`;
  try {
    assert.strictEqual(recordKeep(proj, { target: 'base' }).ok, true);
    const f = failLockCreate(lockPath, 'EROFS');
    const pauses = countPauses();
    let r;
    try { r = recordKeep(proj, { target: 'blocked' }); } finally { pauses.restore(); f.restore(); }
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.ok(r.error.startsWith(`keeps lock: ${lockPath} could not be taken (lock error: EROFS`) && r.error.includes('waiting will not change it'), r.error);
    assert.strictEqual(f.tries, 1, 'one attempt');
    assert.strictEqual(pauses.n, 0, 'not one retry pause');
  } finally { clean(proj); }
});

// The LOW: the read-back of a lock this recorder has just created fails (a passing indexer handle). The seam refuses the first
// LOCK_READ_RETRIES + 1 reads of the lock with EBUSY, the whole read-back of the first attempt, then lets reads through.
test('fire 136: a keeps lock whose read-back a passing handle refuses is retried, never refused as permanent', () => {
  const proj = sandbox();
  const lockPath = `${keepsPath(proj)}.lock`;
  try {
    assert.strictEqual(recordKeep(proj, { target: 'base' }).ok, true);
    const real = fs.openSync;
    let refused = 0;
    fs.openSync = function patched(p, flags, ...rest) {
      if (typeof flags === 'number' && (flags & fs.constants.O_RDWR) === 0 && (flags & fs.constants.O_WRONLY) === 0 && path.resolve(String(p)) === path.resolve(lockPath) && refused < 9) {
        refused++;
        throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${p}'`), { code: 'EBUSY' });
      }
      return real.call(fs, p, flags, ...rest);
    };
    let r;
    try { r = recordKeep(proj, { target: 'raced' }); } finally { fs.openSync = real; }
    assert.strictEqual(refused, 9, 'the whole first read-back was refused');
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.ok(!r.error.includes('could not be taken') && !r.error.includes('waiting will not change it'), r.error);
    assert.ok(r.error.includes(`another recorder holds ${lockPath}`) && r.error.endsWith('record the keep again'), r.error);
  } finally { clean(proj); }
});

test('fire 133: a read-only keeps store refuses at once with what it is, spends no retry and leaves no temp', () => {
  const proj = sandbox();
  try {
    assert.strictEqual(recordKeep(proj, { target: 'base' }).ok, true);
    const before = fs.readFileSync(keepsPath(proj));
    fs.chmodSync(keepsPath(proj), 0o444);
    const f = failRenames(keepsPath(proj)); // the rename Windows refuses over a read-only file (EPERM), on every OS
    let r;
    try { r = recordKeep(proj, { target: 'blocked' }); } finally { f.restore(); fs.chmodSync(keepsPath(proj), 0o644); }
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.ok(r.error.startsWith(`keeps write: the store ${keepsPath(proj)} is read-only`) && r.error.includes('clear the read-only attribute'), r.error);
    assert.ok(!r.error.includes('another program may be holding it open') && !r.error.includes('record the keep again'), r.error);
    assert.strictEqual(f.tries, 1, 'no rename retry');
    assert.deepStrictEqual(fs.readFileSync(keepsPath(proj)), before);
    assert.deepStrictEqual(tempsBeside(keepsPath(proj)), [], 'no temp left');
  } finally { try { fs.chmodSync(keepsPath(proj), 0o644); } catch { /* absent */ } clean(proj); }
});

test('fire 133: a keeps store that is a directory refuses at once with what it is, spends no retry and leaves no temp', () => {
  const proj = sandbox();
  try {
    fs.mkdirSync(keepsPath(proj), { recursive: true });
    const f = failRenames(keepsPath(proj)); // Windows refuses a rename onto a directory with EPERM; the seam makes it so on every OS
    let r;
    try { r = recordKeep(proj, { target: 'blocked' }); } finally { f.restore(); }
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.ok(r.error.startsWith(`keeps write: the store ${keepsPath(proj)} is a directory`) && r.error.includes('move the directory away'), r.error);
    assert.ok(!r.error.includes('record the keep again'), r.error);
    assert.strictEqual(f.tries, 1, 'no rename retry');
    assert.strictEqual(fs.statSync(keepsPath(proj)).isDirectory(), true, 'the directory is left alone');
    assert.deepStrictEqual(tempsBeside(keepsPath(proj)), [], 'no temp left');
  } finally { clean(proj); }
});

// the capability: does this volume refuse a rename over a read-only file? (Windows does; POSIX renames over it)
function renameRefusedOverReadOnly() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwk-probe-ro-')));
  try {
    fs.writeFileSync(path.join(dir, 'a'), 'a');
    fs.writeFileSync(path.join(dir, 'b'), 'b');
    fs.chmodSync(path.join(dir, 'a'), 0o444);
    try { fs.renameSync(path.join(dir, 'b'), path.join(dir, 'a')); return false; } catch (e) { return ['EPERM', 'EACCES', 'EBUSY'].includes(e && e.code); }
  } finally { try { fs.chmodSync(path.join(dir, 'a'), 0o644); } catch { /* gone */ } clean(dir); }
}

test('fire 133: a REAL read-only keeps.json refuses at once with what it is and leaves no temp', (t) => {
  if (!renameRefusedOverReadOnly()) { t.skip('this volume renames over a read-only file (POSIX): the seam leg above covers the wording'); return; }
  const proj = sandbox();
  try {
    assert.strictEqual(recordKeep(proj, { target: 'base' }).ok, true);
    fs.chmodSync(keepsPath(proj), 0o444);
    const pauses = countPauses();
    let r;
    try { r = recordKeep(proj, { target: 'blocked' }); } finally { pauses.restore(); fs.chmodSync(keepsPath(proj), 0o644); }
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.ok(r.error.startsWith(`keeps write: the store ${keepsPath(proj)} is read-only`), r.error);
    assert.strictEqual(pauses.n, 0, 'no rename retry pause');
    assert.deepStrictEqual(tempsBeside(keepsPath(proj)), [], 'no temp left');
  } finally { try { fs.chmodSync(keepsPath(proj), 0o644); } catch { /* absent */ } clean(proj); }
});

// fire 133: the lost-race refusals mean another holder exists, so they are retried like any held lock (never refused as
// permanent). The seam lands another holder's write on the lock right after this recorder's own (its fsyncSync on the lock fd),
// which is what a racing creator or a second stale-lock stealer does.
function anotherHolderWritesAfterUs(lockPath, wantFlags) {
  const realOpen = fs.openSync;
  const realFsync = fs.fsyncSync;
  const f = { fd: null, fired: 0 };
  fs.openSync = function patched(p, flags, ...rest) {
    const fd = realOpen.call(fs, p, flags, ...rest);
    if (f.fd === null && !f.fired && path.resolve(String(p)) === path.resolve(lockPath) && wantFlags(flags)) f.fd = fd;
    return fd;
  };
  fs.fsyncSync = function patched(fd, ...rest) {
    const out = realFsync.call(fs, fd, ...rest);
    if (fd === f.fd && !f.fired) { f.fired++; f.fd = null; fs.writeFileSync(lockPath, JSON.stringify({ sessionId: 'racer', pid: 1, at: Date.now(), token: 'racer:1:1' })); }
    return out;
  };
  f.restore = () => { fs.openSync = realOpen; fs.fsyncSync = realFsync; };
  return f;
}
for (const [name, plant, wantFlags] of [
  ['an exclusive create that loses the race', () => {}, (flags) => flags === 'wx'],
  ['a stale-lock takeover that loses the race', (lockPath) => {
    fs.writeFileSync(lockPath, JSON.stringify({ sessionId: 'dead', pid: 1, at: 0, token: 'dead:1:1' }));
    const old = new Date(Date.now() - KEEPS_LOCK_STALE_MS - 60000);
    fs.utimesSync(lockPath, old, old);
  }, (flags) => typeof flags === 'number' && (flags & fs.constants.O_RDWR) !== 0],
]) {
  test(`fire 133: ${name} is another holder, so the recorder waits for it and never calls it permanent`, () => {
    const proj = sandbox();
    const lockPath = `${keepsPath(proj)}.lock`;
    try {
      assert.strictEqual(recordKeep(proj, { target: 'base' }).ok, true);
      plant(lockPath);
      const f = anotherHolderWritesAfterUs(lockPath, wantFlags);
      let r;
      try { r = recordKeep(proj, { target: 'raced' }); } finally { f.restore(); }
      assert.strictEqual(f.fired, 1, 'the other holder wrote right after this recorder');
      assert.strictEqual(r.ok, false, JSON.stringify(r));
      assert.ok(r.error.includes(`another recorder holds ${lockPath}`) && r.error.endsWith('record the keep again'), r.error);
      assert.ok(!r.error.includes('could not be taken'), 'never refused as permanent');
    } finally { clean(proj); }
  });
}
