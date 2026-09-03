// Board #106. INPUT-CONTRACT.md is a PUBLISHED datasheet, tracked at the repo
// root, that a third-party store integration builds against. Nothing on our
// side previously tested the engine AGAINST that doc -- a drift would have
// surfaced only in the counterparty's own CI, after the fact. This file
// closes that gap: one test per section-6 claim, each against the REAL
// shipped door (readFrontmatter / frontmatterBlockParse / sniffUnrewritable
// / isPinned), never a re-implementation of the rule under test.
//
// SCOPE DERIVATION (board #109 instrument discipline): this file's coverage
// list is derived from INPUT-CONTRACT.md section 6's own claim list --
// every bullet and every one of its six sub-classes gets exactly one test.
// That is legitimate here because the contract IS the spec this suite
// exists to pin -- but it means this suite cannot catch a claim section 6
// itself forgot to state. It is a conformance suite, not an independent
// fuzz/adversarial pass.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFrontmatter, frontmatterKeys } from './fidelity-gate.mjs';
import { sniffUnrewritable, isPinned } from './apply.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function tmpFile(content) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwic-proj-')));
  const file = path.join(dir, 'f.md');
  fs.writeFileSync(file, content, 'utf8');
  return { dir, file };
}
function clean(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

// ── R3 premise check (board #106 order) ─────────────────────────────────
// The order's premise: R3 claimed section 6's fence-level refusal for an
// unclosed top `---` did not hold -- the engine classified it as `none`
// (washable). Probed directly against HEAD before writing anything below:
//   readFrontmatter('---\ntopic: x\nowner: y\n') -> { state: 'unverifiable',
//     why: 'frontmatter opens but never closes (unparseable)' }
// fidelity-gate.mjs:642 is the `!end` branch; its own header comment
// (fidelity-gate.mjs:598-618) documents this was fixed -- the classifier
// used to fall through to 'none' (the fallthrough that authorised a
// delete) and was corrected so every state is EARNED. R3 IS STALE AT THE
// CLASSIFIER. The test below is therefore GREEN ON ITS FIRST RUN by
// design -- not a manufactured red -- and its job is to pin the fix
// closed forever, plus prove the DOOR (not just the classifier) refuses
// end-to-end, which is what section 6 actually claims.
//
// A green-first assertion is not a vacuous one: see the mutation proof at
// the bottom of this file, which reverts the exact fix and confirms this
// same assertion goes RED against the pre-fix behaviour.
test('§6 R3 (verified LIVE at HEAD, not inherited): an unclosed top --- is refused at the FENCE, never reaching the six block checks', () => {
  // Content that is clean and would PASS every one of the six block checks
  // if it were ever parsed -- the only defect in this fixture is the
  // missing closing fence, isolating the fence-level refusal from the
  // block-level ones.
  const text = '---\ntopic: x\nowner: y\n';
  const fm = readFrontmatter(text);
  assert.strictEqual(fm.state, 'unverifiable', 'classifier: unclosed fence must not read as none');
  assert.match(fm.why, /never closes|does not close/, 'the refusal reason must name the fence, not a block-content class');
  // End-to-end through both real doors, not just the classifier:
  assert.ok(sniffUnrewritable(Buffer.from(text, 'utf8')), 'rewrite door refuses');
  const { dir, file } = tmpFile(text);
  try {
    assert.strictEqual(isPinned(file), true, 'delete door fail-closes (unverifiable counts as pinned = refuse)');
  } finally { clean(dir); }
});

// ── §6 bullet: NUL byte ──────────────────────────────────────────────────
test('§6 a NUL byte anywhere in the file -> refused outright as binary content', () => {
  const buf = Buffer.from('topic: x\nsome text with a NUL \x00 inside\n', 'utf8');
  assert.match(String(sniffUnrewritable(buf)), /NUL/i);
});

// ── §6 bullet: valid UTF-8, whole file ───────────────────────────────────
test('§6 a byte that does not round-trip UTF-8 -> WHOLE-FILE refusal from rewriting', () => {
  // 0x92 is a CP1252 right-single-quote byte; alone it is not valid UTF-8.
  const buf = Buffer.from([0x74, 0x6f, 0x70, 0x69, 0x63, 0x3a, 0x20, 0x92, 0x0a]);
  assert.match(String(sniffUnrewritable(buf)), /UTF-8/);
});

// ── §6 bullet: the fixed 64-character head, U+FFFD ───────────────────────
test('§6 U+FFFD inside the fixed 64-character head -> refusal (classifier, direct)', () => {
  // A literal replacement-char GLYPH, valid UTF-8 bytes (round-trips
  // cleanly through sniffUnrewritable's own check) -- isolates the
  // head-scan refusal from the earlier UTF-8-validity refusal.
  const text = 'x'.repeat(10) + '�' + 'y'.repeat(40) + '\n---\ntopic: z\n---\nbody';
  assert.strictEqual(readFrontmatter(text).state, 'unverifiable');
});
test('§6 U+FFFD inside the head, end-to-end through the rewrite door', () => {
  const text = 'x'.repeat(10) + '�' + 'y'.repeat(40) + '\ntopic: z\n';
  assert.ok(sniffUnrewritable(Buffer.from(text, 'utf8')));
});

// ── §6 bullet: a second U+FEFF right after a legal, stripped one ─────────
test('§6 a second U+FEFF sitting right after a first, legal, stripped BOM -> refusal', () => {
  const text = '﻿﻿---\ntopic: x\n---\nbody';
  const fm = readFrontmatter(text);
  assert.strictEqual(fm.state, 'unverifiable');
  assert.match(fm.why, /U\+FEFF/);
});

// ── §6 six block-readability classes, per-file INCAPACITY ────────────────
// F1 (board #106 INSPECT, MEDIUM): assert.ok(refused) alone pins the OUTCOME,
// not which of the six named classes produced it -- a guard going silently
// dead whose shape a neighbour also catches (proven live: disabling class 2's
// TAB guard falls through to class 3's "neither key/comment/list-item" refusal,
// same outcome, different guard, test stays green) would not be caught. Each
// test below now matches the reason string against the specific guard's own
// wording (read at source, fidelity-gate.mjs, never invented) -- the same
// treatment class 6 already had.
test('§6 block class 1: a bare CR anywhere in the block -> INCAPACITY refusal', () => {
  const text = '---\n' + 'topic: x\rowner: y\n' + '---\nbody';
  assert.match(String(sniffUnrewritable(Buffer.from(text, 'utf8'))), /bare CR/);
  const { dir, file } = tmpFile(text);
  try { assert.strictEqual(isPinned(file), true, 'delete door refuses too'); }
  finally { clean(dir); }
});
test('§6 block class 2: a TAB in the indentation -> INCAPACITY refusal', () => {
  const text = '---\ntopic: x\n\towner: y\n---\nbody';
  assert.match(String(sniffUnrewritable(Buffer.from(text, 'utf8'))), /TAB in the indentation/);
});
test('§6 block class 3: a line readable as neither key, comment, nor list item -> INCAPACITY refusal', () => {
  const text = '---\ntopic: x\njust some prose with no colon at all\n---\nbody';
  assert.match(String(sniffUnrewritable(Buffer.from(text, 'utf8'))), /as a key, a comment or a list item/);
});
test('§6 block class 4: a key indented LESS than the block\'s first line -> INCAPACITY refusal', () => {
  const text = '---\n  topic: x\nowner: y\n---\nbody';
  assert.match(String(sniffUnrewritable(Buffer.from(text, 'utf8'))), /indented LESS than the block's first line/);
});
test('§6 block class 5: a top-level key with a character outside printable ASCII -> INCAPACITY refusal', () => {
  const text = '---\ntöpic: x\n---\nbody';
  assert.match(String(sniffUnrewritable(Buffer.from(text, 'utf8'))), /outside printable ASCII/);
});
test('§6 block class 6: a top-level key opening with a YAML indicator (JSON body as frontmatter) -> INCAPACITY refusal', () => {
  const text = '---\n{"content": "hi"}\n---\nbody';
  const why = String(sniffUnrewritable(Buffer.from(text, 'utf8')));
  assert.match(why, /indicator/);
});

// SECONDARY ITEM (board #106): class 1 alone additionally probes the delete
// door (isPinned); classes 2-6 probe the rewrite door only. DELIBERATE, not
// an accident -- section 6's six classes are stated as a property of the
// FRONTMATTER BLOCK, reached identically by frontmatterBlockParse regardless
// of door, and the R3 test above already proves BOTH doors refuse
// end-to-end on the fence-level case. One class re-confirming door parity is
// enough to show the two doors are not silently diverging; repeating it
// across all six would be redundant coverage of the SAME routing fact, not
// six new facts. Ruling: keep class 1's door-parity check, leave 2-6
// rewrite-door-only.

// ── negative controls (what stops this suite being vacuous) ──────────────
test('§6 negative control: NO fence at all skips frontmatter checks but still faces NUL/UTF-8/64-head', () => {
  const cleanText = 'just plain prose\nno frontmatter here\n';
  assert.strictEqual(sniffUnrewritable(Buffer.from(cleanText, 'utf8')), null, 'a clean no-fence file washes');
  const withNul = 'plain prose\x00more';
  assert.match(String(sniffUnrewritable(Buffer.from(withNul, 'utf8'))), /NUL/i, 'NUL still refuses with no fence present');
});
test('§6 negative control: a clean file with valid frontmatter passes and its keys are preserved', () => {
  const text = '---\ntopic: hello\nowner: me\n---\nbody text here';
  assert.strictEqual(sniffUnrewritable(Buffer.from(text, 'utf8')), null);
  const keys = frontmatterKeys(text);
  assert.ok(keys.has('topic'));
  assert.ok(keys.has('owner'));
});

// ── MUTATION PROOF: every test above can FAIL ─────────────────────────────
// Board #106 rail: a conformance suite that passes against a broken engine
// is worse than none. Rather than assert this by construction, revert the
// exact guards under test in a THROWAWAY copy of the real source (written
// beside it so relative imports still resolve, dynamic-imported, then
// deleted) and confirm each assertion above flips against the reverted
// behaviour. This never touches the tracked engine file -- the mutant is
// created and destroyed within this one test, and a control assertion is
// re-run against the SAME mutant to prove the mutation was targeted, not a
// global break.
async function withMutant(sourceFile, patches, run) {
  const srcPath = path.join(__dirname, sourceFile);
  const original = fs.readFileSync(srcPath, 'utf8');
  let mutated = original;
  for (const [from, to] of patches) {
    assert.ok(mutated.includes(from), `mutation target not found verbatim in ${sourceFile} -- source drifted, re-derive the patch`);
    mutated = mutated.replace(from, to);
  }
  assert.notStrictEqual(mutated, original, 'mutation must actually change the source');
  const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  // DOT-PREFIXED, and that is load-bearing, not cosmetic (CWK-066 F1).
  // scripts/lib/ is both a SOURCE directory other tests copy and walk, and a
  // scratch directory tests write transients into. node --test runs files as
  // concurrent processes, so build-plugin.test.mjs's buildDist() can be
  // cpSync-ing this very directory while this mutant is created and deleted.
  // fs.cpSync enumerates, then lstats: a transient that vanishes in that window
  // throws ENOENT and reddens an unrelated test (measured -- see the commit).
  // The room already settled this with a dot-prefix convention that every
  // reader honours (build-plugin.mjs's hasStrayDotDir at :83 and :116/:148,
  // verify.mjs:47, root-provenance.test.mjs:111 -- all naming
  // `.cw-reexport-hop-*`, the sibling transient that lives here for the same
  // reason). cpSync consults its filter BEFORE the lstat, so a dot-prefixed
  // name is skipped and never stat'd. This mutant simply had not joined the
  // convention. It must stay IN this directory: apply.mjs has 8 relative
  // imports that only resolve beside their siblings.
  const mutantName = `.mutant-${sourceFile}-${stamp}.mjs`;
  assert.ok(mutantName.startsWith('.'), 'the mutant name must be dot-prefixed or every dist walk can race it');
  const mutantPath = path.join(__dirname, mutantName);
  fs.writeFileSync(mutantPath, mutated, 'utf8');
  try {
    const mod = await import(pathToFileURL(mutantPath).href);
    await run(mod);
  } finally {
    fs.rmSync(mutantPath, { force: true });
  }
}

test('MUTATION PROOF: fidelity-gate.mjs claims flip red against their pre-fix behaviour', async () => {
  await withMutant('fidelity-gate.mjs', [
    // R3: the exact fix this file documents at :598-618 -- restore the old
    // fallthrough (the unclosed-fence branch answered 'none').
    [
      "if (!end) return { state: 'unverifiable', block: '', why: truncated ? 'frontmatter opens and does not close inside the read window (unverifiable — the block may continue past it)' : 'frontmatter opens but never closes (unparseable)' };",
      "if (!end) return { state: 'none', block: '' };",
    ],
    // The six block-readability classes: neuter the refuse() sink.
    [
      'const refuse = (why) => { if (!unreadable) unreadable = why; };',
      'const refuse = (why) => {};',
    ],
    // 64-char-head NUL/U+FFFD guard: disable it.
    [
      "if (head.includes('\\u0000') || head.includes('\\uFFFD')) {",
      'if (false) {',
    ],
    // Double-BOM guard: disable it.
    [
      '  if (s.charCodeAt(0) === 0xfeff) {',
      '  if (false) {',
    ],
  ], async (mod) => {
    // R3 flips: unclosed fence now reads 'none', not 'unverifiable'.
    assert.strictEqual(mod.readFrontmatter('---\ntopic: x\nowner: y\n').state, 'none', 'R3 assertion must be capable of catching this exact regression');
    // Each of the six block classes flips: unreadable becomes null.
    const sixFixtures = [
      'topic: x\rowner: y',
      'topic: x\n\towner: y',
      'topic: x\njust some prose with no colon at all',
      '  topic: x\nowner: y',
      'töpic: x',
      '{"content": "hi"}',
    ];
    for (const block of sixFixtures) {
      assert.strictEqual(mod.frontmatterBlockParse(block).unreadable, null, `block class assertion must be capable of catching a disabled refuse(): ${block.slice(0, 30)}`);
    }
    // U+FFFD-in-head flips. The fence must open at position 0 (readFrontmatter's
    // fence regex is anchored there) with the glyph inside the first 64 chars,
    // so a disabled head-guard falls through to an ordinary, parseable block.
    const fffdText = '---\n' + '�' + '\ntopic: z\n---\nbody';
    assert.strictEqual(mod.readFrontmatter(fffdText).state, 'closed', 'U+FFFD-in-head assertion must be capable of catching a disabled guard');
    // Double-BOM flips.
    assert.notStrictEqual(mod.readFrontmatter('﻿﻿---\ntopic: x\n---\nbody').state, 'unverifiable', 'double-BOM assertion must be capable of catching a disabled guard');
    // CONTROL, same mutant: a clean valid file is UNAFFECTED by any of the
    // four patches above -- proves the mutation was targeted, not a global
    // break that would flip everything including a healthy fixture.
    assert.strictEqual(mod.readFrontmatter('---\ntopic: ok\n---\nbody').state, 'closed', 'control: an ordinary clean file must still parse on the mutant');
  });
});

test('MUTATION PROOF: apply.mjs sniffUnrewritable claims flip red against their pre-fix behaviour', async () => {
  await withMutant('apply.mjs', [
    [
      "  if (buf.includes(0)) return 'binary content (NUL byte) — flagged, not rewritten';",
      "  if (false) return 'unreachable';",
    ],
    [
      '  if (!Buffer.from(text, \'utf8\').equals(buf)) {',
      '  if (false) {',
    ],
  ], async (mod) => {
    // The NUL sits PAST the 64-char head-scan window so only sniffUnrewritable's
    // own full-buffer check (not fidelity-gate's head check) can catch it --
    // isolates the guard this mutation actually disabled.
    const nulBuf = Buffer.from('x'.repeat(80) + '\x00' + 'more text after the head window\n', 'utf8');
    assert.strictEqual(mod.sniffUnrewritable(nulBuf), null, 'NUL assertion must be capable of catching a disabled guard');
    // The invalid byte sits PAST the 64-char head-scan window (its decode
    // produces U+FFFD, which fidelity-gate's own head check would otherwise
    // independently catch) -- isolates sniffUnrewritable's own round-trip
    // guard, the one this mutation actually disabled.
    const badUtf8 = Buffer.concat([Buffer.from('x'.repeat(80) + '\n', 'utf8'), Buffer.from([0x92]), Buffer.from('\n', 'utf8')]);
    assert.strictEqual(mod.sniffUnrewritable(badUtf8), null, 'UTF-8-round-trip assertion must be capable of catching a disabled guard');
    // CONTROL: a clean file is still null on the mutant.
    assert.strictEqual(mod.sniffUnrewritable(Buffer.from('---\ntopic: ok\n---\nbody', 'utf8')), null, 'control: a clean file still passes on the mutant');
  });
});
