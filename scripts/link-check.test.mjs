// CW-017 — scripts/link-check.mjs. Two things are pinned here: the SLUG RULE, against data
// measured from GitHub's own render, and the GATE, against planted defects it must name.
//
// THE VECTORS ARE COPIED IN, never read from where they were measured: that file lives
// outside this repo, absent from any clone. Source:
//   CoalWorks/warehouse/slug-oracle-2026-09.test-vectors.json
//   sha256 85106848652e965675fbe5a9195601f8ff675575968f6e6531a6c9b70940c82d
// (byte-identical to CoalHearth's scratchpad/r34/out/test-vectors.json, which these rows were
// deep-compared to; companion record CoalWorks/warehouse/slug-oracle-2026-09.md, sha256
// 2a8acee03f15e28ff02c2ee37bc0f833954f4cf11fc9bdc14f9d5bd10450bf78 — the conformed-to scratch
// record, sha256 ae1ff6aefddc05e758f9cf0d6f5384e59e0cb0697b83fb2ebbc4ac2e9b0b099a, under a
// provenance comment line and a blank line).
// Every code point outside printable ASCII is written \u{…}, so an invisible one (VS16, ZWJ, ZWNJ, NBSP,
// TAB) cannot be lost by an editor; the literal was evaluated and deep-compared to the JSON
// before it was pasted. Rows 10 and 39 need their
// document's earlier duplicates, and are replayed.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { slugifyHeading, HeadingAnchors, headingAnchors, extractLinks, fragmentMatches, checkLinks } from './link-check.mjs';

const ENGINE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'link-check.mjs');

const VECTORS = [
  /*  1 */ { heading: 'Commands', anchor: 'commands', needsHistory: false, where: 'CoalMine-README:145', clause: 'case: ASCII lowercased' },
  /*  2 */ { heading: '\u{1F525} CoalHearth', anchor: '-coalhearth', needsHistory: false, where: 'CoalHearth-README:3', clause: 'emoji dropped, its SPACE kept: leading hyphen' },
  /*  3 */ { heading: '\u{2699}\u{FE0F} Configure (.coalmine.json)', anchor: '\u{FE0F}-configure-coalminejson', needsHistory: false, where: 'CoalMine-README:171', clause: 'VS16 (U+FE0F, Mn) KEPT after its emoji is dropped' },
  /*  4 */ { heading: 'Claude Code \u{2014} validated', anchor: 'claude-code--validated', needsHistory: false, where: 'CoalHearth-README:83', clause: 'em dash dropped between two spaces: double hyphen' },
  /*  5 */ { heading: 'Gemini CLI \u{B7} Copilot CLI \u{B7} Devin CLI \u{B7} Kiro \u{B7} Augment \u{2014} works with (config-only ports)', anchor: 'gemini-cli--copilot-cli--devin-cli--kiro--augment--works-with-config-only-ports', needsHistory: false, where: 'CoalHearth-README:118', clause: 'middot dropped between spaces' },
  /*  6 */ { heading: '3. Verify & Uninstall', anchor: '3-verify--uninstall', needsHistory: false, where: 'CoalMine-README:139', clause: 'ampersand dropped between spaces' },
  /*  7 */ { heading: '[3.8.4] \u{2014} 2026-07-02', anchor: '384--2026-07-02', needsHistory: false, where: 'CoalMine-CHANGELOG:394', clause: 'brackets and dots dropped, digits kept' },
  /*  8 */ { heading: 'Option A3 \u{2014} claude.ai (web / desktop app)', anchor: 'option-a3--claudeai-web--desktop-app', needsHistory: false, where: 'CoalMine-README:119', clause: 'parentheses, colon, slash dropped' },
  /*  9 */ { heading: 'Fixed (carve round 4 \u{2014} the confirmation-wave REGRESSION, `1e66b4e`\'s own 4 lines)', anchor: 'fixed-carve-round-4--the-confirmation-wave-regression-1e66b4es-own-4-lines', needsHistory: false, where: 'CoalBoard-CHANGELOG:98', clause: 'inline code span: content kept, backticks and apostrophe dropped' },
  /* 10 */ { heading: 'Fixed', anchor: 'fixed-1', needsHistory: true, where: 'CoalMine-CHANGELOG:30', clause: 'duplicate heading in one document: -1 suffix' },
  /* 11 */ { heading: 'tab\u{9}between', anchor: 'tabbetween', needsHistory: false, where: 'PROBE:1', clause: 'TAB (Cc) dropped, not hyphenated' },
  /* 12 */ { heading: 'two  spaces', anchor: 'two--spaces', needsHistory: false, where: 'PROBE:2', clause: 'two SPACES: two hyphens, no collapse' },
  /* 13 */ { heading: 'nbsp\u{A0}inside', anchor: 'nbspinside', needsHistory: false, where: 'PROBE:4', clause: 'NBSP (U+00A0) dropped' },
  /* 14 */ { heading: 'ideo\u{3000}space zs', anchor: 'ideospace-zs', needsHistory: false, where: 'PROBE2:17', clause: 'ideographic space (U+3000) dropped' },
  /* 15 */ { heading: 'trailing bang !', anchor: 'trailing-bang-', needsHistory: false, where: 'PROBE:5', clause: 'trailing punctuation: trailing hyphen, no trim' },
  /* 16 */ { heading: 'snake_case_word raw', anchor: 'snake_case_word-raw', needsHistory: false, where: 'PROBE2:21', clause: 'intraword underscore KEPT (Pc)' },
  /* 17 */ { heading: 'an _uemph_ word', anchor: 'an-uemph-word', needsHistory: false, where: 'PROBE:25', clause: 'underscore emphasis delimiters removed' },
  /* 18 */ { heading: 'an *emph* and **strong** word', anchor: 'an-emph-and-strong-word', needsHistory: false, where: 'PROBE:24', clause: 'star emphasis delimiters removed' },
  /* 19 */ { heading: 'hyphen--run---kept', anchor: 'hyphen--run---kept', needsHistory: false, where: 'PROBE:13', clause: 'hyphen runs kept verbatim' },
  /* 20 */ { heading: 'en \u{2013} dash', anchor: 'en--dash', needsHistory: false, where: 'PROBE:11', clause: 'en dash (Pd, not hyphen-minus) dropped' },
  /* 21 */ { heading: '\u{E2B}\u{E31}\u{E27}\u{E02}\u{E49}\u{E2D} \u{E01}\u{E32}\u{E23}\u{E15}\u{E34}\u{E14}\u{E15}\u{E31}\u{E49}\u{E07}', anchor: '\u{E2B}\u{E31}\u{E27}\u{E02}\u{E49}\u{E2D}-\u{E01}\u{E32}\u{E23}\u{E15}\u{E34}\u{E14}\u{E15}\u{E31}\u{E49}\u{E07}', needsHistory: false, where: 'PROBE:14', clause: 'Thai: letters AND combining marks kept' },
  /* 22 */ { heading: '\u{65E5}\u{672C}\u{8A9E} \u{30C6}\u{30B9}\u{30C8}', anchor: '\u{65E5}\u{672C}\u{8A9E}-\u{30C6}\u{30B9}\u{30C8}', needsHistory: false, where: 'PROBE:15', clause: 'CJK letters kept' },
  /* 23 */ { heading: '\u{C9}COLE \u{3A3}\u{39F}\u{3A6}', anchor: '\u{E9}cole-\u{3C3}\u{3BF}\u{3C6}', needsHistory: false, where: 'PROBE:16', clause: 'non-ASCII uppercase lowercased' },
  /* 24 */ { heading: 'word\u{3A3} end', anchor: 'word\u{3C3}-end', needsHistory: false, where: 'PROBE3:4', clause: 'per-code-point lowercase: NO final sigma' },
  /* 25 */ { heading: '\u{130}stanbul case', anchor: 'i\u{307}stanbul-case', needsHistory: false, where: 'PROBE2:19', clause: 'U+0130 lowercases to i + U+0307 (kept)' },
  /* 26 */ { heading: 'x\u{B2} squared', anchor: 'x-squared', needsHistory: false, where: 'PROBE:17', clause: 'superscript digit (No) dropped' },
  /* 27 */ { heading: 'digit \u{663} nd', anchor: 'digit-\u{663}-nd', needsHistory: false, where: 'PROBE2:12', clause: 'non-ASCII decimal digit (Nd) kept' },
  /* 28 */ { heading: 'circled \u{24B6} so', anchor: 'circled-\u{24D0}-so', needsHistory: false, where: 'PROBE3:1', clause: 'Alphabetic symbol (So, Alphabetic=Yes) kept' },
  /* 29 */ { heading: '\u{1F468}\u{200D}\u{1F4BB} zwj coder', anchor: '\u{200D}-zwj-coder', needsHistory: false, where: 'PROBE:20', clause: 'ZWJ (Join_Control) KEPT between dropped emoji' },
  /* 30 */ { heading: 'zw\u{200C}nj cf', anchor: 'zw\u{200C}nj-cf', needsHistory: false, where: 'PROBE2:7', clause: 'ZWNJ (Join_Control) kept' },
  /* 31 */ { heading: 'zw\u{200B}sp cf', anchor: 'zwsp-cf', needsHistory: false, where: 'PROBE2:6', clause: 'ZWSP (Cf, not Join_Control) dropped' },
  /* 32 */ { heading: '1\u{FE0F}\u{20E3} keycap one', anchor: '1\u{FE0F}\u{20E3}-keycap-one', needsHistory: false, where: 'PROBE:21', clause: 'keycap: digit + VS16 + U+20E3 (Me) all kept' },
  /* 33 */ { heading: 'see [the docs](https://example.com) now', anchor: 'see-the-docs-now', needsHistory: false, where: 'PROBE:26', clause: 'link: text kept, URL gone' },
  /* 34 */ { heading: 'html <code>tag</code> inside', anchor: 'html-tag-inside', needsHistory: false, where: 'PROBE:27', clause: 'raw HTML tag removed, its text kept' },
  /* 35 */ { heading: 'amp &amp; entity', anchor: 'amp--entity', needsHistory: false, where: 'PROBE:29', clause: 'named entity decoded then dropped' },
  /* 36 */ { heading: 'num &#35; entity raw', anchor: 'num--entity-raw', needsHistory: false, where: 'PROBE2:23', clause: 'numeric entity decoded then dropped' },
  /* 37 */ { heading: 'escaped \\* star', anchor: 'escaped--star', needsHistory: false, where: 'PROBE:28', clause: 'backslash escape resolved then dropped' },
  /* 38 */ { heading: 'math = < > | ~ sm', anchor: 'math------sm', needsHistory: false, where: 'PROBE2:15', clause: 'Sm/Sk/Po run between spaces: one hyphen per space' },
  /* 39 */ { heading: 'Duplicate Heading 1', anchor: 'duplicate-heading-1-1', needsHistory: true, where: 'PROBE:33', clause: 'literal "-1" after two duplicates: -1-1' },
];

test('CWK-098 vectors: all 39 reproduce GitHub\'s anchor — 37 on their own, rows 10 and 39 after their replayed duplicates', () => {
  assert.strictEqual(VECTORS.length, 39);
  const REPLAY = {
    10: ['Fixed'],                                                   // CoalMine-CHANGELOG's first `### Fixed`
    39: ['Duplicate Heading', 'Duplicate Heading', 'Duplicate Heading'],
  };
  let alone = 0;
  let replayed = 0;
  VECTORS.forEach((v, i) => {
    const row = i + 1;
    const counter = new HeadingAnchors();
    if (v.needsHistory) {
      assert.ok(REPLAY[row], `row ${row} needs history the test does not replay`);
      for (const h of REPLAY[row]) counter.next(slugifyHeading(h));
      replayed++;
    } else {
      assert.strictEqual(slugifyHeading(v.heading), v.anchor, `row ${row} (${v.clause}, ${v.where}): the base slug`);
      alone++;
    }
    assert.strictEqual(counter.next(slugifyHeading(v.heading)), v.anchor, `row ${row} (${v.clause}, ${v.where})`);
  });
  assert.deepStrictEqual([alone, replayed], [37, 2]);
});

test('CWK-098 replayed rows: the earlier duplicates themselves read as GitHub numbers them', () => {
  const a = new HeadingAnchors();
  assert.deepStrictEqual(['Fixed', 'Fixed'].map((h) => a.next(slugifyHeading(h))), ['fixed', 'fixed-1']);
  const b = new HeadingAnchors();
  assert.deepStrictEqual(
    ['Duplicate Heading', 'Duplicate Heading', 'Duplicate Heading', 'Duplicate Heading 1'].map((h) => b.next(slugifyHeading(h))),
    ['duplicate-heading', 'duplicate-heading-1', 'duplicate-heading-2', 'duplicate-heading-1-1'],
  );
});

// CodeQL #42 (js/incomplete-multi-character-sanitization) flags renderInline's single-pass
// raw-HTML-tag strip. It stays single-pass because GitHub keeps an ALLOWED tag's inner text,
// which one pass reproduces and a loop to a fixed point would not. (GitHub ESCAPES a DISALLOWED
// tag such as `<script>` to literal text instead, which neither reproduces: a declared bound in
// the engine header, measured on GitHub's own render by the r34c room INSPECT.) The strip is not
// a security boundary, and this test pins why: after lowercasing, SLUG_DROP deletes every `<`
// and `>`, and no anchor this engine builds can carry either character.
test('CodeQL #42: no slug and no heading anchor ever contains < or >, whatever tag shape the heading holds', () => {
  const SHAPES = [
    '<scr<script>ipt>',
    '<<a>b>',
    '<<<x>>>',
    '<script',
    'unterminated <script src=x',
    '&lt;script&gt;alert(1)&lt;/script&gt;',
    '&#60;img&#62;',
    '`<script>` in a code span',
  ];
  for (const heading of SHAPES) {
    const slug = slugifyHeading(heading);
    assert.ok(!/[<>]/.test(slug), `slug ${JSON.stringify(slug)} from ${JSON.stringify(heading)} contains < or >`);
    for (const anchor of headingAnchors(`# ${heading}\n`)) {
      assert.ok(!/[<>]/.test(anchor), `anchor ${JSON.stringify(anchor)} from ${JSON.stringify(heading)} contains < or >`);
    }
  }
});

test('an empty slug is registered but never linkable; the next empty one is "-1", which is', () => {
  const doc = '## \u{1F525}\n\ntext\n\n## \u{1F680}\n\n## real\n';
  assert.deepStrictEqual([...headingAnchors(doc)].sort(), ['-1', 'real']);
});

test('headingAnchors: frontmatter and fenced blocks are not headings; a closing sequence is not heading text', () => {
  const doc = [
    '---', 'name: x', '# not a heading', '---',
    '## Real One ##',
    '```md', '## fenced', '```',
    '~~~~', '# tilde fenced', '~~~', 'still inside: a shorter closer does not close', '~~~~',
    '#nospace',
    '####### seven',
    '# After',
  ].join('\n');
  assert.deepStrictEqual([...headingAnchors(doc)].sort(), ['after', 'real-one']);
});

test('extractLinks: code spans, fences, escapes, footnotes and frontmatter carry no links; definitions, images and raw href do', () => {
  const doc = [
    '---', 'link: [fm](nope.md)', '---',
    'a `[t](in-code.md)` span and ``two `[t](in-code2.md)` ticks``',
    'an escaped \\[x](escaped.md) bracket',
    '```', '[t](fenced.md)', '```',
    'real [one](a.md "title") and ![img](<b c.png>) and [nested [x]](d.md#h)',
    '[label]: defined.md',
    '[^1]: a footnote, not a link',
    '<a href="html.md">x</a> <img src=\'pic.png\'>',
  ].join('\n');
  assert.deepStrictEqual(extractLinks(doc).map((l) => l.dest), ['a.md', '<b c.png>', 'd.md#h', 'defined.md', 'html.md', 'pic.png']);
});

test('fragmentMatches follows the HTML Standard: raw, then percent-decoded, then "top"; otherwise case-sensitive', () => {
  const thai = '\u{E2B}\u{E31}\u{E27}\u{E02}\u{E49}\u{E2D}-\u{E01}\u{E32}\u{E23}\u{E15}\u{E34}\u{E14}\u{E15}\u{E31}\u{E49}\u{E07}';
  const anchors = new Set([thai, 'install']);
  assert.strictEqual(fragmentMatches(thai, anchors), true, 'GitHub emits it raw');
  assert.strictEqual(fragmentMatches(encodeURIComponent(thai), anchors), true, 'a percent-encoded link matches on the decoded step');
  assert.strictEqual(fragmentMatches('', anchors), true);
  assert.strictEqual(fragmentMatches('TOP', anchors), true);
  assert.strictEqual(fragmentMatches('Install', anchors), false, 'no case folding');
  assert.strictEqual(fragmentMatches('%E0%B8', anchors), false, 'a truncated sequence decodes to U+FFFD and matches nothing');
});

// A plain directory for the in-process checks — the tracked set is passed in, so no git.
function docsTree(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-linkcheck-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  put('docs/guide.md', '# Guide\n\n## Install\n\n## Install\n\n## ÉCOLE — note\n');
  put('src/tool.mjs', 'export {};\n');
  put('untracked.md', '# stray\n');
  put('README.md', [
    '# Top Title',
    '[guide](docs/guide.md) [dir](docs) [root](/src/tool.mjs) [line](src/tool.mjs#L3-L9) [self](#top-title)',
    '[dup](docs/guide.md#install-1) [raw](docs/guide.md#école--note) [enc](docs/guide.md#%C3%A9cole--note)',
    '[mail](mailto:x@y.z) [web](https://example.com/#nope) [empty]() [top](#top)',
    '[BROKEN-FILE](docs/missing.md)',
    '[BROKEN-ANCHOR](docs/guide.md#install-2)',
    '[UNTRACKED](untracked.md)',
    '[OUT](../outside.md)',
    '[CODE-FRAG](src/tool.mjs#main)',
    '[DIR-FRAG](docs#x)',
  ].join('\n'));
  return { root, tracked: new Set(['README.md', 'docs/guide.md', 'src/tool.mjs']) };
}

test('checkLinks: every planted defect is named at its line; every valid shape is silent', (t) => {
  const { root, tracked } = docsTree(t);
  const r = checkLinks({ root, files: ['README.md'], tracked });
  assert.deepStrictEqual(r.findings.map((f) => `${f.line}: ${f.msg}`), [
    '5: link `docs/missing.md` — does not resolve in this repo',
    '6: link `docs/guide.md#install-2` — no heading in docs/guide.md renders the anchor #install-2',
    '7: link `untracked.md` — exists here but is NOT TRACKED — a clone does not have it',
    '8: link `../outside.md` — leaves the repository',
    '9: link `src/tool.mjs#main` — #main is not a line anchor, and src/tool.mjs is not Markdown',
    '10: link `docs#x` — has an anchor on a directory, which this gate cannot check',
  ]);
  assert.strictEqual(r.external, 2);
  assert.strictEqual(r.checked, 15);
});

test('checkLinks: an unreadable input file is a finding, never a skipped clean file', (t) => {
  const { root, tracked } = docsTree(t);
  const r = checkLinks({ root, files: ['no-such.md'], tracked });
  assert.strictEqual(r.findings.length, 1);
  assert.match(r.findings[0].msg, /cannot read this file/);
});

// The CLI reads tracked-ness from git, so its checks run in a REAL repository — fenced the
// way scripts/verify.test.mjs fences its own: os.tmpdir(), `-C` and a GIT_*-scrubbed env on
// every git call, the fixture's own .git asserted first, and no `git config` anywhere.
const hermeticGit = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
function cliRepo(t) {
  const init = spawnSync('git', ['--version'], { encoding: 'utf8', env: hermeticGit() });
  if (init.error || init.status !== 0) return null;
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-linkcheck-git-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env: hermeticGit() });
  assert.strictEqual(git('init', '-q', '-b', 'main').status, 0, 'git init in the fixture');
  assert.ok(fs.statSync(path.join(root, '.git')).isDirectory(), 'FIXTURE RAIL: the fixture owns its .git');
  const run = (...files) => spawnSync(process.execPath, [ENGINE, ...files], { cwd: root, encoding: 'utf8', env: hermeticGit() });
  return { root, git, run };
}

test('CLI: planted broken link and anchor exit 1 and are named; the fixed tree exits 0; no files exits 1', (t) => {
  const fx = cliRepo(t);
  if (!fx) return t.skip('git unavailable');
  const { root, git, run } = fx;
  fs.writeFileSync(path.join(root, 'A.md'), '# Alpha\n\nsee [b](B.md#beta) and [gone](missing.md) and [bad](B.md#gamma)\n');
  fs.writeFileSync(path.join(root, 'B.md'), '# Beta\n');
  assert.strictEqual(git('add', '-A').status, 0);

  const broken = run('A.md', 'B.md');
  assert.strictEqual(broken.status, 1, broken.stdout + broken.stderr);
  assert.match(broken.stdout, /FAIL A\.md:3: link `missing\.md` — does not resolve in this repo/);
  assert.match(broken.stdout, /FAIL A\.md:3: link `B\.md#gamma` — no heading in B\.md renders the anchor #gamma/);
  assert.match(broken.stdout, /\nlink-check: 2 finding\(s\) across 2 file\(s\)/);

  fs.writeFileSync(path.join(root, 'A.md'), '# Alpha\n\nsee [b](B.md#beta)\n');
  const clean = run('A.md', 'B.md');
  assert.strictEqual(clean.status, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout, /^link-check: 0 finding\(s\) across 2 file\(s\) — 1 internal link\(s\) checked/m);

  const none = run();
  assert.strictEqual(none.status, 1);
  assert.match(none.stdout, /no files given/);
});

// r34c C: the main-module guard compared import.meta.url (Node resolves the entry file to its
// REALPATH) with argv[1] (the path it was invoked by). Through a symlink or a junction the two
// differ and main() never ran: exit 0, no output, a silent pass on the gate's only mechanism.
// A directory junction needs no admin rights on Windows; a host that cannot make one skips.
test('CLI: invoked through a directory junction, the engine still runs (no files: refuses, exit 1)', (t) => {
  const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-linkcheck-junction-'));
  t.after(() => fs.rmSync(holder, { recursive: true, force: true })); // rmSync does not follow a junction (probed)
  const link = path.join(holder, 'scripts-link');
  try {
    fs.symlinkSync(path.dirname(ENGINE), link, 'junction');
  } catch (e) {
    return t.skip(`cannot create a junction or directory symlink on this host (${e.code || e.message})`);
  }
  const r = spawnSync(process.execPath, [path.join(link, 'link-check.mjs')], { cwd: holder, encoding: 'utf8' });
  assert.strictEqual(r.status, 1, `through the junction: exit ${r.status}, output ${JSON.stringify(r.stdout + r.stderr)}`);
  assert.match(r.stdout, /no files given/);
});
