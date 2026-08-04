import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { keepsPath, loadKeeps, recordKeep, globalKeepsPath, loadGlobalKeeps, recordGlobalKeep } from './keeps.mjs';
import { txDirFor } from './apply.mjs';

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
    const ok = recordKeep(proj, { target: 'dogfood-to-harden', reason: 'confirmed load-bearing 2026-07-09' });
    assert.strictEqual(ok, true);
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
    assert.strictEqual(recordKeep(proj, { reason: 'no target' }), false);
    assert.strictEqual(recordKeep(proj, { target: '' }), false);
    assert.strictEqual(recordKeep(proj, { target: 42 }), false);
    assert.strictEqual(recordKeep(proj), false);
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
    assert.strictEqual(recordKeep(proj, { target: 'y' }), false, 'an older tool must not rewrite a newer artifact');
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
    const ok = recordGlobalKeep(home, { target: 'global-claude-md-section', reason: 'shields it machine-wide' });
    assert.strictEqual(ok, true);
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
    assert.strictEqual(recordGlobalKeep(home, { target: 'y' }), false, 'an older tool must not rewrite a newer artifact');
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
    assert.strictEqual(reAffirmed, true);
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
    assert.strictEqual(r, true, 'the write itself still succeeds (this is a merge decision, not a failure)');
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
      const ok = recordKeep(proj, { target: 'f.md:clause', reason: 'test', anchor: junk, anchorFile: 'C:/store/f.md' });
      assert.strictEqual(ok, true, 'the write itself still succeeds — this is a merge/acceptance decision, not a failure');
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
    // -- only the SPECIFIC invisible-rendering codepoints are.
    const thai = 'สวัสดีครับ ยินดีต้อนรับเข้าสู่ระบบของเรา'; // real Thai sentence, well over the floor
    const ok = recordKeep(proj, { target: 'f.md:thai', reason: 'test', anchor: thai, anchorFile: 'C:/store/f.md' });
    assert.strictEqual(ok, true);
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
      const ok = recordKeep(proj, { target: 'f.md:clause', reason: 'test', anchor, anchorFile: 'C:/store/f.md' });
      assert.strictEqual(ok, true);
      const entry = loadKeeps(proj).find((k) => k.target === 'f.md:clause');
      assert.strictEqual(entry.anchor, anchor, `${label} must become a real enforcement handle -- no word delimiter needed`);
    } finally { clean(proj); }
  });
}

test('RED-FIRST/HIGH2-short-real-phrase: "git rev-parse HEAD" (16 stripped chars, 3 words, under the OLD 20-char floor) is enforced — short and real is not the same as non-distinctive', () => {
  const proj = sandbox();
  try {
    const anchor = 'git rev-parse HEAD';
    const ok = recordKeep(proj, { target: 'f.md:cmd', reason: 'test', anchor, anchorFile: 'C:/store/f.md' });
    assert.strictEqual(ok, true);
    const entry = loadKeeps(proj).find((k) => k.target === 'f.md:cmd');
    assert.strictEqual(entry.anchor, anchor, 'a short, genuinely distinctive command must not be refused for its length alone');
  } finally { clean(proj); }
});

test('RED-FIRST/HIGH2-junk-still-refused: the reported junk shapes stay refused under the new distinct-character measure too', () => {
  const proj = sandbox();
  try {
    for (const junk of ['whatever', '!!!!!!!!', 'e', '#', 'the']) {
      const ok = recordKeep(proj, { target: `f.md:${junk}`, reason: 'test', anchor: junk, anchorFile: 'C:/store/f.md' });
      assert.strictEqual(ok, true, `write itself still succeeds for ${JSON.stringify(junk)}`);
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
