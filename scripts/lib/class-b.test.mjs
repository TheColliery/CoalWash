import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ccProjectSlug, ccMemoryDir, parseImports, discoverClassB, discoverRoleMemories, detectPlatform, containedIn, physicalOrNull, physicalForCreate, isCloudPlaceholder } from './class-b.mjs';
import { measureEntries } from './caliper.mjs';
import { spawnSync } from 'node:child_process';

// Hermetic: the real machine's CLAUDE_CONFIG_DIR must never leak into
// sandbox-home resolution (node --test runs each file in its own process).
delete process.env.CLAUDE_CONFIG_DIR;

function sandbox() {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwb-home-')));
  const proj = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwb-proj-')));
  return { home, proj };
}
function clean(...dirs) {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}
function write(p, content = 'x') {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

// ---------------------------------------------------------------------------
// CWK-082 findings-back — F1 (the cap flag made a FALSE statement) and F2 (an
// unreadable SUBDIRECTORY dropped content in silence: this unit's own headline
// defect, reachable again through the door the unit opened).
// ---------------------------------------------------------------------------

// Make `dir` unreadable, portably, or return null when this box/volume cannot.
// Capability PROBE, never a process.platform test (the room's own rule: 8.3
// names, case-folding and ACL enforcement are VOLUME properties). The probe
// asserts readdirSync actually throws, so an admin shell that bypasses the ACL
// is detected rather than silently producing a vacuous green.
function makeUnreadable(dir) {
  const attempts = [
    () => { fs.chmodSync(dir, 0o000); return () => { try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ } }; },
    () => {
      const who = process.env.USERNAME || process.env.USER || '';
      if (!who) return null;
      spawnSync('icacls', [dir, '/deny', `${who}:(OI)(CI)(RX)`], { stdio: 'ignore' });
      return () => { try { spawnSync('icacls', [dir, '/remove:d', who], { stdio: 'ignore' }); } catch { /* best effort */ } };
    },
  ];
  for (const attempt of attempts) {
    let restore = null;
    try { restore = attempt(); } catch { restore = null; }
    if (!restore) continue;
    let threw = false;
    try { fs.readdirSync(dir); } catch { threw = true; }
    if (threw) return restore;
    restore();
  }
  return null;
}

test('CWK-082 F2: an UNREADABLE memory subdirectory FLAGS — a partial read must never look like a complete one', (t) => {
  const { home, proj } = sandbox();
  let restore = null;
  try {
    // Capability probe FIRST, on a throwaway directory outside the store: the
    // skip decision must precede every assertion, or a skipped run reports a
    // leg as skipped that actually executed (ONE SKIPPABLE LEG PER TEST).
    const probeDir = path.join(proj, 'probe-can-lock');
    write(path.join(probeDir, 'x.md'), 'x');
    const probeRestore = makeUnreadable(probeDir);
    if (probeRestore) probeRestore();
    else { t.skip('this volume/account cannot make a directory unreadable — the arm would be vacuous'); return; }
    const mem = ccMemoryDir(proj, home);
    write(path.join(mem, 'MEMORY.md'), '# index');
    write(path.join(mem, 'readable.md'), 'visible');
    const locked = path.join(mem, 'locked');
    write(path.join(locked, 'hidden.md'), 'x'.repeat(20000));
    const before = discoverClassB({ projectRoot: proj, home });
    assert.ok(before.entries.some((e) => e.path.includes('hidden.md')), 'PRECONDITION: readable, the nested file IS discovered');
    restore = makeUnreadable(locked);
    assert.ok(restore, 'the probe said this volume CAN lock a directory, so this must not fail');
    const after = discoverClassB({ projectRoot: proj, home });
    assert.ok(!after.entries.some((e) => e.path.includes('hidden.md')), 'PRECONDITION: the content really did become invisible');
    assert.ok(after.flags.some((f) => /unreadable/i.test(f)),
      `the loss must be ANNOUNCED, not swallowed: ${JSON.stringify(after.flags)}`);
  } finally { if (restore) restore(); clean(home, proj); }
});

test('CWK-082 F2: an ABSENT memory store stays SILENT — the benign case the swallow was written for is not collateral', () => {
  const { home, proj } = sandbox();
  try {
    const d = discoverClassB({ projectRoot: proj, home }); // no memory dir at all
    assert.deepStrictEqual(d.flags.filter((f) => /unreadable/i.test(f)), [],
      'a store that was never created is not a store that failed to read — the control that keeps the F2 flag from crying wolf');
  } finally { clean(home, proj); }
});

test('CWK-082 F1: 526 files in ONE flat directory are read COMPLETELY and the cap stays SILENT — a flag that fires on a complete read trains the reader to ignore it', () => {
  const { home, proj } = sandbox();
  try {
    const mem = ccMemoryDir(proj, home);
    write(path.join(mem, 'MEMORY.md'), '# index');
    for (let i = 0; i < 526; i++) write(path.join(mem, `f${i}.md`), 'x');
    const d = discoverClassB({ projectRoot: proj, home });
    const memEntries = d.entries.filter((e) => e.path.startsWith(mem));
    assert.strictEqual(memEntries.length, 527, 'the inner loop finishes a directory it starts, so NOTHING was narrowed');
    assert.deepStrictEqual(d.flags.filter((f) => /memory store capped/.test(f)), [],
      'and therefore the cap must NOT announce itself — it narrowed nothing');
  } finally { clean(home, proj); }
});

test('CWK-082 F1: a walk that GENUINELY narrows still flags, and names what it did not reach', () => {
  const { home, proj } = sandbox();
  try {
    const mem = ccMemoryDir(proj, home);
    write(path.join(mem, 'MEMORY.md'), '# index');
    for (let i = 0; i < 526; i++) write(path.join(mem, 'd' + i, 'f.md'), 'x'); // 526 dirs x 1 file -> the dir cap bites
    const d = discoverClassB({ projectRoot: proj, home });
    const flag = d.flags.find((f) => /memory store capped/.test(f));
    assert.ok(flag, `a walk that stopped early MUST announce it: ${JSON.stringify(d.flags)}`);
    assert.match(flag, /unvisited|remain/i, `and say what it never reached: ${flag}`);
  } finally { clean(home, proj); }
});
test('ccProjectSlug: every non-alphanumeric char becomes a dash, deterministically', () => {
  const abs = path.resolve(os.tmpdir(), 'A b', 'c.d');
  const slug = ccProjectSlug(abs);
  assert.match(slug, /^[A-Za-z0-9-]+$/);
  assert.strictEqual(slug, ccProjectSlug(abs), 'deterministic');
  assert.strictEqual(slug, abs.replace(/[^A-Za-z0-9]/g, '-'));
  if (process.platform === 'win32') {
    assert.strictEqual(ccProjectSlug('C:\\a b\\c'), 'C--a-b-c');
  }
});

// ---------------------------------------------------------------------------
// CWK-082 L1 — the memory store's discovery walk. Step 4 was a FLAT readdir, so
// a *.md one directory down was reachable by NO step (step 3 is recursive but
// anchored at .claude/rules; steps 1-2 reach a file only through an @import
// closure). MEASURED by INSPECT §3a: the same 49,515 bytes read 12,384 tok as a
// SIBLING and 631 tok in a SUBDIR — 11,753 tok invisible, flags EMPTY on both.
// ---------------------------------------------------------------------------

test('CWK-082 L1: a *.md in a memory SUBDIRECTORY is discovered — the same file one dir down is not a free exit from the gauge', () => {
  const { home, proj } = sandbox();
  try {
    const mem = ccMemoryDir(proj, home);
    write(path.join(mem, 'MEMORY.md'), '# index');
    write(path.join(mem, 'sibling.md'), 'flat recall file');
    write(path.join(mem, 'notes', 'deep.md'), 'moved one directory down');
    write(path.join(mem, 'notes', 'deeper', 'deepest.md'), 'moved two directories down');
    const d = discoverClassB({ projectRoot: proj, home });
    const paths = d.entries.map((e) => e.path);
    assert.ok(paths.includes(path.join(mem, 'notes', 'deep.md')), 'a nested recall file is discovered');
    assert.ok(paths.includes(path.join(mem, 'notes', 'deeper', 'deepest.md')), 'and so is one two levels down');
    assert.ok(paths.includes(path.join(mem, 'sibling.md')), 'the flat sibling still works (control: the widening did not replace step 4)');
  } finally { clean(home, proj); }
});

test('CWK-082 L1 INVARIANT: the widening lands in m.total ONLY — m.alwaysLoaded is byte-identical with and without a nested file', () => {
  const { home, proj } = sandbox();
  try {
    const mem = ccMemoryDir(proj, home);
    write(path.join(mem, 'MEMORY.md'), '# index\n' + 'index muscle line\n'.repeat(40));
    const before = measureEntries(discoverClassB({ projectRoot: proj, home }).entries);
    // 40 KB of DISTINCT content one directory down — big enough that any leak
    // into the always-loaded slice would be unmissable.
    let big = '';
    for (let i = 0; i < 1200; i++) big += `nested distinct muscle line ${i}\n`;
    write(path.join(mem, 'notes', 'big.md'), big);
    const after = measureEntries(discoverClassB({ projectRoot: proj, home }).entries);
    assert.strictEqual(after.alwaysLoaded.bytes, before.alwaysLoaded.bytes,
      'the nested file must NOT inflate the main BMI: alwaysLoaded bytes unchanged');
    assert.strictEqual(after.alwaysLoaded.tokensEst, before.alwaysLoaded.tokensEst,
      'nor its token estimate');
    assert.strictEqual(after.alwaysLoaded.files, before.alwaysLoaded.files, 'nor its file count');
    assert.ok(after.totalBytes > before.totalBytes + 30000,
      'and the bytes DO land in m.total — the non-vacuity control, without which the three equalities above would pass on a walk that found nothing');
  } finally { clean(home, proj); }
});

test('CWK-082 L1: a nested MEMORY.md is a RECALL file, never a second always-loaded index', () => {
  const { home, proj } = sandbox();
  try {
    const mem = ccMemoryDir(proj, home);
    write(path.join(mem, 'MEMORY.md'), '# the real index');
    write(path.join(mem, 'archive', 'MEMORY.md'), '# a moved-aside copy, NOT loaded by the platform');
    const d = discoverClassB({ projectRoot: proj, home });
    const nested = d.entries.find((e) => e.path === path.join(mem, 'archive', 'MEMORY.md'));
    assert.ok(nested, 'it is discovered');
    assert.strictEqual(nested.alwaysLoaded, false, 'but only the TOP-LEVEL MEMORY.md is the index');
    assert.strictEqual(nested.kind, 'memory');
    const top = d.entries.find((e) => e.path === path.join(mem, 'MEMORY.md'));
    assert.strictEqual(top.alwaysLoaded, true, 'control: the real index is still the index');
    assert.strictEqual(top.kind, 'memory-index');
  } finally { clean(home, proj); }
});

// RETARGETED by the CWK-082 findings-back (F1). The original fixture put 520
// files in ONE subdirectory — a walk that FINISHES, since the inner loop always
// completes a directory it starts — so it took `count` past the cap while
// narrowing NOTHING, and the flag it asserted was a false statement. It now
// trips the FILE cap with a directory still QUEUED, and proves the loss it
// announces rather than trusting the counter. The SILENT twin (the same shape
// minus the queued directory) sits beside the other F1 cells above.
test('CWK-082 L1: a runaway memory tree is CAPPED and the cap FLAGS — a capped walk is never silently partial', () => {
  const { home, proj } = sandbox();
  try {
    const mem = ccMemoryDir(proj, home);
    write(path.join(mem, 'MEMORY.md'), '# index');
    for (let i = 0; i < 520; i++) write(path.join(mem, `f${i}.md`), 'x');
    write(path.join(mem, 'never-reached', 'deep.md'), 'x'); // queued, never visited
    const d = discoverClassB({ projectRoot: proj, home });
    assert.ok(d.flags.some((f) => /memory store capped/.test(f)), `the cap announces itself: ${JSON.stringify(d.flags)}`);
    assert.ok(!d.entries.some((e) => e.path.includes('deep.md')),
      'and the flag is TRUE — the queued directory really was left unread');
  } finally { clean(home, proj); }
});

test('ccMemoryDir derives <base>/projects/<slug>/memory under the given home', () => {
  const { home, proj } = sandbox();
  try {
    const dir = ccMemoryDir(proj, home);
    assert.strictEqual(dir, path.join(home, '.claude', 'projects', ccProjectSlug(proj), 'memory'));
  } finally { clean(home, proj); }
});

test('parseImports: line-start @tokens only; ~/, absolute, and relative forms', () => {
  const { home, proj } = sandbox();
  try {
    const text = ['@AGENTS.md', '  @~/global.md', 'not @inline.md', '@' + path.join(os.tmpdir(), 'abs.md'), '@two tokens ignored extra'].join('\n');
    const got = parseImports(text, '/base', home);
    assert.deepStrictEqual(got, [
      path.resolve('/base', 'AGENTS.md'),
      path.join(home, 'global.md'),
      path.join(os.tmpdir(), 'abs.md'),
    ]);
  } finally { clean(home, proj); }
});

test('discoverClassB (CC): governance walk + @import closure + rules + memory store', () => {
  const { home, proj } = sandbox();
  try {
    // global governance + import
    write(path.join(home, '.claude', 'CLAUDE.md'), '@RTK.md\nglobal rules');
    write(path.join(home, '.claude', 'RTK.md'), 'rtk');
    // project governance + imports
    write(path.join(proj, 'CLAUDE.md'), '@AGENTS.md\n@MEMORY.md');
    write(path.join(proj, 'AGENTS.md'), 'agents');
    write(path.join(proj, 'MEMORY.md'), 'memory pointer');
    // rules tree (on-demand governance)
    write(path.join(proj, '.claude', 'rules', 'ecc', 'style.md'), 'rule');
    // memory store
    const mem = ccMemoryDir(proj, home);
    write(path.join(mem, 'MEMORY.md'), '# index');
    write(path.join(mem, 'lesson-one.md'), 'a lesson');
    write(path.join(mem, 'notes.txt'), 'ignored — not .md');

    const d = discoverClassB({ projectRoot: proj, home, platform: 'claude-code' });
    const by = (p) => d.entries.find((e) => e.path === fs.realpathSync.native(p));

    assert.strictEqual(d.platform, 'claude-code');
    for (const p of ['CLAUDE.md', 'AGENTS.md', 'MEMORY.md'].map((n) => path.join(proj, n))) {
      const e = by(p);
      assert.ok(e, `missing entry ${p}`);
      assert.strictEqual(e.scope, 'project');
      assert.strictEqual(e.kind, 'governance');
      assert.strictEqual(e.alwaysLoaded, true);
    }
    assert.strictEqual(by(path.join(home, '.claude', 'CLAUDE.md')).scope, 'global');
    assert.strictEqual(by(path.join(home, '.claude', 'RTK.md')).alwaysLoaded, true, '@import closure is always-loaded');
    assert.strictEqual(by(path.join(proj, '.claude', 'rules', 'ecc', 'style.md')).alwaysLoaded, false, 'non-imported rules load on demand');
    assert.strictEqual(by(path.join(mem, 'MEMORY.md')).kind, 'memory-index');
    assert.strictEqual(by(path.join(mem, 'MEMORY.md')).alwaysLoaded, true);
    assert.strictEqual(by(path.join(mem, 'lesson-one.md')).kind, 'memory');
    assert.strictEqual(by(path.join(mem, 'lesson-one.md')).alwaysLoaded, false);
    assert.strictEqual(d.entries.some((e) => e.path.endsWith('notes.txt')), false);
  } finally { clean(home, proj); }
});

test('an @import cycle terminates and counts each file once', () => {
  const { home, proj } = sandbox();
  try {
    write(path.join(proj, 'CLAUDE.md'), '@a.md');
    write(path.join(proj, 'a.md'), '@b.md');
    write(path.join(proj, 'b.md'), '@a.md'); // cycle
    const d = discoverClassB({ projectRoot: proj, home, platform: 'claude-code' });
    const names = d.entries.map((e) => path.basename(e.path)).sort();
    assert.deepStrictEqual(names, ['CLAUDE.md', 'a.md', 'b.md']);
  } finally { clean(home, proj); }
});

test('an @import escaping BOTH trees is skipped and flagged (fail-closed reads)', () => {
  const { home, proj } = sandbox();
  const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwb-out-')));
  try {
    write(path.join(outside, 'secret.md'), 'outside');
    write(path.join(proj, 'CLAUDE.md'), '@' + path.join(outside, 'secret.md'));
    const d = discoverClassB({ projectRoot: proj, home, platform: 'claude-code' });
    assert.strictEqual(d.entries.some((e) => e.path.includes('secret')), false);
    assert.ok(d.flags.some((f) => f.startsWith('skipped (outside')), 'escape is flagged');
  } finally { clean(home, proj, outside); }
});

test('an unresolvable (dangling) @import is skipped without noise', () => {
  const { home, proj } = sandbox();
  try {
    write(path.join(proj, 'CLAUDE.md'), '@does-not-exist.md');
    const d = discoverClassB({ projectRoot: proj, home, platform: 'claude-code' });
    assert.strictEqual(d.entries.length, 1, 'only CLAUDE.md itself');
  } finally { clean(home, proj); }
});

test('unknown platform -> conservative: no discovery, an explicit flag, never auto-delete guidance', () => {
  const { home, proj } = sandbox();
  try {
    const d = discoverClassB({ projectRoot: proj, home, platform: 'goose' });
    assert.deepStrictEqual(d.entries, []);
    assert.ok(d.flags[0].includes('never auto-delete'));
  } finally { clean(home, proj); }
});

test('detectPlatform: claude-code iff the claude base dir exists (env cleared above)', () => {
  const { home, proj } = sandbox();
  try {
    assert.strictEqual(detectPlatform(home), 'unknown');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    assert.strictEqual(detectPlatform(home), 'claude-code');
  } finally { clean(home, proj); }
});

test('missing memory dir contributes nothing and does not crash', () => {
  const { home, proj } = sandbox();
  try {
    write(path.join(proj, 'CLAUDE.md'), 'no imports');
    const d = discoverClassB({ projectRoot: proj, home, platform: 'claude-code' });
    assert.strictEqual(d.entries.length, 1);
  } finally { clean(home, proj); }
});

test('containedIn / physicalOrNull primitives behave (equal counts as inside; absent = null)', () => {
  const { home, proj } = sandbox();
  try {
    assert.strictEqual(containedIn(home, [home]), true);
    assert.strictEqual(containedIn(path.join(home, 'x'), [home]), true);
    assert.strictEqual(containedIn(path.resolve(home, '..'), [home]), false);
    assert.strictEqual(containedIn(null, [home]), false);
    assert.strictEqual(physicalOrNull(path.join(home, 'nope', 'nope.md')), null);
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// G1: symlink/junction escape safety on the DISCOVERY/measure walk, and win32
// case-insensitive containment (apply.mjs's realpath-and-contain was already
// covered live; this pins the SAME property on the read-only discovery side).
// ---------------------------------------------------------------------------

test('G1: a directory junction inside .claude/rules pointing OUTSIDE the trees leaks nothing (Windows-unprivileged; skips visibly elsewhere)', (t) => {
  const { home, proj } = sandbox();
  const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwb-escape-')));
  try {
    write(path.join(proj, '.claude', 'rules', 'real-rule.md'), 'a real rule');
    write(path.join(outside, 'leaked-secret.md'), 'SHOULD NEVER APPEAR IN DISCOVERY');
    const linkPath = path.join(proj, '.claude', 'rules', 'escape-link');
    try {
      // 'junction' is the unprivileged shim on Windows (no admin/dev-mode
      // needed, unlike a real symlink) — the room's own established pattern.
      fs.symlinkSync(outside, linkPath, 'junction');
    } catch (e) {
      t.skip(`junction creation unavailable on this host: ${e.message}`);
      return;
    }
    const d = discoverClassB({ projectRoot: proj, home, platform: 'claude-code' });
    assert.strictEqual(d.entries.some((e) => e.path.includes('leaked-secret')), false, 'the outside file must never appear in discovery');
    assert.ok(d.entries.some((e) => e.path.endsWith('real-rule.md')), 'the real rule is still discovered');
    assert.strictEqual(d.entries.some((e) => e.path.includes('escape-link')), false, 'the junction entry itself is not treated as governance content');
  } finally { clean(home, proj, outside); }
});

test('G1: containment is case-INSENSITIVE-safe on win32 — a differently-cased inside path is still recognized as inside, an outside sibling is never wrongly included', (t) => {
  if (process.platform !== 'win32') { t.skip('case-insensitivity is a win32-specific property'); return; }
  const { home, proj } = sandbox();
  try {
    const rootPhys = physicalOrNull(proj);
    const insideMismatchedCase = path.join(proj, 'file.md').toUpperCase();
    write(path.join(proj, 'file.md'), 'x');
    assert.strictEqual(containedIn(physicalOrNull(insideMismatchedCase), [rootPhys]), true, 'a case-differing but genuinely-inside path is recognized as contained');
    const sibling = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwb-sibling-')));
    try {
      assert.strictEqual(containedIn(physicalOrNull(sibling), [rootPhys]), false, 'a genuinely-outside sibling is never wrongly contained');
    } finally { clean(sibling); }
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// G4: discovery must never wash its own recovery layer — CoalWash's own
// .claude/coalwash/ tx artifacts, and a sibling session-state dir shaped like
// CoalHearth's, must never surface as discovered class-B content.
// ---------------------------------------------------------------------------

test('G4: CoalWash\'s own .claude/coalwash/ artifacts (snapshot/journal/keeps/lock) never surface as discovered class-B', () => {
  const { home, proj } = sandbox();
  try {
    write(path.join(proj, '.claude', 'rules', 'real-rule.md'), 'a real rule');
    const cw = path.join(proj, '.claude', 'coalwash');
    write(path.join(cw, 'snap-123', 'manifest.json'), '[]');
    write(path.join(cw, 'snap-123', 'snap.complete'), '123');
    write(path.join(cw, 'journal.json'), '{}');
    write(path.join(cw, 'keeps.json'), '[]');
    write(path.join(cw, '.coalwash.lock'), '{}');
    write(path.join(cw, '.gitignore'), '*\n');

    const d = discoverClassB({ projectRoot: proj, home, platform: 'claude-code' });
    assert.strictEqual(d.entries.some((e) => e.path.includes('coalwash')), false, 'no .claude/coalwash/ artifact ever enters the discovered set');
    assert.ok(d.entries.some((e) => e.path.endsWith('real-rule.md')), 'the real rule is still discovered');
  } finally { clean(home, proj); }
});

test('G4: a sibling session-state dir shaped like CoalHearth\'s (.claude/coalhearth/) never surfaces either', () => {
  const { home, proj } = sandbox();
  try {
    write(path.join(proj, '.claude', 'rules', 'real-rule.md'), 'a real rule');
    const ch = path.join(proj, '.claude', 'coalhearth');
    write(path.join(ch, 'journal.json'), '{}');
    write(path.join(ch, 'handoff.md'), 'session recovery state, not class-B memory');

    const d = discoverClassB({ projectRoot: proj, home, platform: 'claude-code' });
    assert.strictEqual(d.entries.some((e) => e.path.includes('coalhearth')), false, 'a sibling session-state dir is never discovered');
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// MANAGED-ARTIFACT AUTO-DECLARATION (beta.12 item 6, arm-3 finding): a
// sync-owned rule pack is tagged `managed: true` — MEASURED (never hidden
// from BMI) but excluded from wash proposals downstream (SKILL-level
// discipline). Two independent signals: byte-identical-across-roots, and the
// managedPaths config prefix.
// ---------------------------------------------------------------------------

test('every discovered entry defaults managed:false', () => {
  const { home, proj } = sandbox();
  try {
    write(path.join(proj, 'CLAUDE.md'), 'no imports');
    const d = discoverClassB({ projectRoot: proj, home, platform: 'claude-code' });
    assert.ok(d.entries.length > 0);
    assert.ok(d.entries.every((e) => e.managed === false));
  } finally { clean(home, proj); }
});

test('managed (1) byte-identical-across-roots: a project rules file mirroring a global rules file at the SAME relative tail is tagged managed on BOTH sides', () => {
  const { home, proj } = sandbox();
  try {
    const shared = 'this pack is synced verbatim by an external tool';
    write(path.join(proj, '.claude', 'rules', 'ecc', 'domain', 'shared-pack.md'), shared);
    write(path.join(home, '.claude', 'rules', 'ecc', 'domain', 'shared-pack.md'), shared);
    // A genuinely project-only rule (no global counterpart) stays unmanaged.
    write(path.join(proj, '.claude', 'rules', 'ecc', 'domain', 'project-only.md'), 'local rule, never synced');

    const d = discoverClassB({ projectRoot: proj, home, platform: 'claude-code' });
    const projSide = d.entries.find((e) => e.path.endsWith(path.join('ecc', 'domain', 'shared-pack.md')) && e.scope === 'project');
    const globSide = d.entries.find((e) => e.path.endsWith(path.join('ecc', 'domain', 'shared-pack.md')) && e.scope === 'global');
    assert.ok(projSide && globSide, 'both sides of the pair are discovered');
    assert.strictEqual(projSide.managed, true, 'the project mirror is tagged managed');
    assert.strictEqual(globSide.managed, true, 'the global source is tagged managed too (the pairing itself proves the sync relationship)');

    const localOnly = d.entries.find((e) => e.path.endsWith('project-only.md'));
    assert.strictEqual(localOnly.managed, false, 'a file with no global counterpart is never mis-tagged managed');
  } finally { clean(home, proj); }
});

test('managed (1) is content-aware, not name-aware: a same-named file with DIFFERENT content is never tagged managed (a real local edit, not a mirror)', () => {
  const { home, proj } = sandbox();
  try {
    write(path.join(proj, '.claude', 'rules', 'ecc', 'diverged.md'), 'the project has since customized this rule');
    write(path.join(home, '.claude', 'rules', 'ecc', 'diverged.md'), 'the original global rule text');

    const d = discoverClassB({ projectRoot: proj, home, platform: 'claude-code' });
    const projSide = d.entries.find((e) => e.path.endsWith(path.join('ecc', 'diverged.md')) && e.scope === 'project');
    assert.strictEqual(projSide.managed, false, 'diverged content is a real local customization, never auto-declared managed');
  } finally { clean(home, proj); }
});

test('managed (1) generalizes to any pack name — never hardcodes "ecc" or any project-specific directory', () => {
  const { home, proj } = sandbox();
  try {
    const shared = 'a totally differently-named shared pack';
    write(path.join(proj, '.claude', 'rules', 'whatever-pack-name', 'nested', 'file.md'), shared);
    write(path.join(home, '.claude', 'rules', 'whatever-pack-name', 'nested', 'file.md'), shared);
    const d = discoverClassB({ projectRoot: proj, home, platform: 'claude-code' });
    const projSide = d.entries.find((e) => e.path.endsWith(path.join('whatever-pack-name', 'nested', 'file.md')) && e.scope === 'project');
    assert.strictEqual(projSide.managed, true);
  } finally { clean(home, proj); }
});

test('managed (2) managedPaths config: an explicit prefix (relative to the entry\'s own scope root) tags matching entries managed', () => {
  const { home, proj } = sandbox();
  try {
    write(path.join(proj, '.claude', 'rules', 'vendor-pack', 'a.md'), 'vendor content');
    write(path.join(proj, '.claude', 'rules', 'my-own', 'b.md'), 'my own rule');
    const d = discoverClassB({ projectRoot: proj, home, platform: 'claude-code', managedPaths: ['.claude/rules/vendor-pack'] });
    const vendor = d.entries.find((e) => e.path.endsWith(path.join('vendor-pack', 'a.md')));
    const own = d.entries.find((e) => e.path.endsWith(path.join('my-own', 'b.md')));
    assert.strictEqual(vendor.managed, true);
    assert.strictEqual(own.managed, false);
  } finally { clean(home, proj); }
});

test('managed (2) managedPaths: an empty/absent/malformed list is a harmless no-op, never throws', () => {
  const { home, proj } = sandbox();
  try {
    write(path.join(proj, '.claude', 'rules', 'a.md'), 'x');
    for (const managedPaths of [undefined, [], null, 'not-an-array', [123]]) {
      assert.doesNotThrow(() => discoverClassB({ projectRoot: proj, home, platform: 'claude-code', managedPaths }));
      const d = discoverClassB({ projectRoot: proj, home, platform: 'claude-code', managedPaths });
      assert.ok(d.entries.every((e) => e.managed === false));
    }
  } finally { clean(home, proj); }
});

test('managed: both signals can independently tag the same discovery pass', () => {
  const { home, proj } = sandbox();
  try {
    const shared = 'synced content';
    write(path.join(proj, '.claude', 'rules', 'ecc', 'mirrored.md'), shared);
    write(path.join(home, '.claude', 'rules', 'ecc', 'mirrored.md'), shared);
    write(path.join(proj, '.claude', 'rules', 'vendor-only', 'x.md'), 'declared managed by config, no global mirror exists');
    const d = discoverClassB({ projectRoot: proj, home, platform: 'claude-code', managedPaths: ['.claude/rules/vendor-only'] });
    assert.strictEqual(d.entries.find((e) => e.path.endsWith(path.join('ecc', 'mirrored.md')) && e.scope === 'project').managed, true);
    assert.strictEqual(d.entries.find((e) => e.path.endsWith(path.join('vendor-only', 'x.md'))).managed, true);
  } finally { clean(home, proj); }
});

test('physicalForCreate (#57 write-side twin of physicalOrNull): resolves the deepest EXISTING ancestor physically, reattaches the missing tail, collapses `..`, surfaces a symlinked intermediate at its REAL location, null when nothing exists', () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwcb-pfc-')));
  try {
    // missing tail reattached under the existing physical ancestor
    assert.strictEqual(physicalForCreate(path.join(base, 'a', 'b', 'c.gz')), path.join(base, 'a', 'b', 'c.gz'));
    // `..` collapsed lexically BEFORE the walk -> the escape is visible to containedIn
    const escaped = physicalForCreate(path.join(base, 'inside', '..', '..', 'evil.gz'));
    assert.strictEqual(escaped, path.join(path.dirname(base), 'evil.gz'));
    assert.strictEqual(containedIn(escaped, [base]), false, 'the collapsed path fails containment');
    // a symlinked intermediate dir resolves to its target (junction = unprivileged Windows shim)
    const outside = path.join(base, 'outside');
    const root = path.join(base, 'root');
    fs.mkdirSync(outside, { recursive: true });
    fs.mkdirSync(root, { recursive: true });
    fs.symlinkSync(outside, path.join(root, 'link'), 'junction');
    const viaLink = physicalForCreate(path.join(root, 'link', 'new.gz'));
    assert.strictEqual(viaLink, path.join(outside, 'new.gz'), 'symlink resolved to the real location');
    assert.strictEqual(containedIn(viaLink, [root]), false, 'the linked-out dest fails containment against root');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// #57(d) cloud-placeholder read poison — the dehydrated-stub metadata sniff
// (positive-signal only; a real placeholder cannot be created in a sandbox, so
// the stat is injected — blocks:0 + size>0 is the dehydrated signal).
// ---------------------------------------------------------------------------

test('isCloudPlaceholder (POSIX): blocks:0 & size>0 = placeholder; any allocated block or size 0 or non-file or unreadable = NOT (fail toward normal)', () => {
  const file = (over) => ({ isFile: () => true, size: 100, blocks: 8, ...over });
  // platform pinned to a POSIX value where Stats.blocks is meaningful
  const st = (v) => ({ statSync: () => v, platform: 'linux' });
  // the dehydrated signal — the ONLY true case
  assert.strictEqual(isCloudPlaceholder('x', st(file({ blocks: 0 }))), true, 'size>0 + blocks 0 = dehydrated placeholder');
  // hydrated / normal files
  assert.strictEqual(isCloudPlaceholder('x', st(file({ blocks: 8 }))), false, 'allocated blocks = real file');
  assert.strictEqual(isCloudPlaceholder('x', st(file({ blocks: 1 }))), false, 'even one block = not a placeholder');
  // empty file: size 0 is legitimately blocks 0 — never a placeholder
  assert.strictEqual(isCloudPlaceholder('x', st(file({ size: 0, blocks: 0 }))), false, 'an empty file (size 0) is not a placeholder');
  // a directory / non-file
  assert.strictEqual(isCloudPlaceholder('x', st(file({ isFile: () => false, blocks: 0 }))), false, 'a non-file is never a placeholder');
  // blocks absent / NaN on some platform -> cannot prove -> NOT flagged (fail toward normal)
  assert.strictEqual(isCloudPlaceholder('x', st(file({ blocks: undefined }))), false, 'absent blocks = cannot prove = not flagged (skill stays usable)');
  // unreadable stat (throws) -> false, never throws
  assert.strictEqual(isCloudPlaceholder('x', { statSync: () => { throw new Error('ENOENT'); }, platform: 'linux' }), false, 'an unreadable stat is swallowed -> false');
});

test('isCloudPlaceholder (win32): NAMED RESIDUAL — the blocks sniff stays a no-op there (a legit NTFS sparse file shares the size>0/blocks===0 stub fingerprint, and the reparse attribute that distinguishes them is unexposed by Node fs); blocks is LIVE on current win32 (#8) but the no-op stands per fidelity-first (upgrade path = a native reparse-attribute read)', () => {
  const dehydrated = { statSync: () => ({ isFile: () => true, size: 100, blocks: 0 }), platform: 'win32' };
  assert.strictEqual(isCloudPlaceholder('x', dehydrated), false, 'win32 never flags on blocks — fidelity-first no-op (sparse-fingerprint collision), not a miss');
});

// ---------------------------------------------------------------------------
// #22 role-memory discovery — per-store, separate from entries, nested-habitat
// (a role store loads into a SUB, never the main parcel -> never inflates the
// main's always-loaded footprint).
// ---------------------------------------------------------------------------

test('#22 role-memory discovery: agent-memory/<role>/ stores are found PER-STORE in roleMemories, kept OUT of entries; the main always-loaded footprint is byte-identical with or without the role dirs', () => {
  const { home, proj } = sandbox();
  try {
    // main store (entries) — governance + memory index
    write(path.join(home, '.claude', 'CLAUDE.md'), 'global rules');
    write(path.join(proj, 'CLAUDE.md'), 'project rules');
    const mem = ccMemoryDir(proj, home);
    write(path.join(mem, 'MEMORY.md'), '# main index');
    write(path.join(mem, 'lesson.md'), 'a main recall lesson');

    // baseline BEFORE any role dir exists
    const before = discoverClassB({ projectRoot: proj, home, platform: 'claude-code' });
    assert.deepStrictEqual(before.roleMemories, [], 'no role dirs yet');

    // add two role stores
    write(path.join(proj, '.claude', 'agent-memory', 'coder', 'MEMORY.md'), '# coder index');
    write(path.join(proj, '.claude', 'agent-memory', 'coder', 'craft.md'), 'a coder lesson');
    write(path.join(proj, '.claude', 'agent-memory', 'reviewer', 'MEMORY.md'), '# reviewer index');

    const after = discoverClassB({ projectRoot: proj, home, platform: 'claude-code' });

    // all three stores are discovered: main (entries) + 2 role stores (roleMemories)
    assert.strictEqual(after.roleMemories.length, 2, 'both role stores discovered');
    assert.deepStrictEqual(after.roleMemories.map((r) => r.store).sort(), ['agent:coder', 'agent:reviewer']);
    const coder = after.roleMemories.find((r) => r.store === 'agent:coder');
    assert.ok(coder.index && /coder\b/.test(coder.index.path), 'per-store: the MEMORY.md index is reported');
    assert.strictEqual(coder.memories.length, 1, 'per-store: the sibling topic file is reported');
    assert.strictEqual(coder.files, 2);
    assert.ok(coder.bytes > 0);

    // NESTED-HABITAT invariant: role stores never touch entries, so the main
    // always-loaded footprint is BYTE-IDENTICAL with or without them.
    assert.strictEqual(after.entries.some((e) => e.path.includes('agent-memory')), false, 'role memories are a separate tier, never in entries');
    assert.deepStrictEqual(measureEntries(after.entries).alwaysLoaded, measureEntries(before.entries).alwaysLoaded, 'the main always-loaded footprint excludes the role stores (no BMI/floor inflation)');
  } finally { clean(home, proj); }
});

test('#22 role-memory discovery: standalone helper is fail-closed (a role dir symlinked outside the trees is skipped) and CC-gated (unknown platform -> [] via discoverClassB)', () => {
  const { home, proj } = sandbox();
  try {
    write(path.join(proj, '.claude', 'agent-memory', 'coder', 'MEMORY.md'), '# coder');
    const direct = discoverRoleMemories({ projectRoot: proj, home });
    assert.strictEqual(direct.length, 1, 'the helper finds the role store directly');
    // unknown platform routes through discoverClassB's conservative gate
    const unknown = discoverClassB({ projectRoot: proj, home, platform: 'goose' });
    assert.deepStrictEqual(unknown.roleMemories, [], 'an unknown platform gets no role discovery (conservative)');
  } finally { clean(home, proj); }
});

test('R4/TP-2 [SECURITY]: physicalForCreate never reattaches a tail across an EXISTING but unresolvable segment — a junction whose target is unresolvable cannot aim a write outside the guarded root', (t) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwb-pfc-')));
  try {
    const store = path.join(dir, 'store');
    const outside = path.join(dir, 'OUTSIDE');
    fs.mkdirSync(store, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });

    // Control: an ordinary junction resolves, so containment SEES the escape and refuses.
    const jn = path.join(store, 'esc');
    try { fs.symlinkSync(outside, jn, 'junction'); } catch (e) { t.skip(`junction unavailable (${e.code})`); return; }
    const resolved = physicalForCreate(path.join(jn, 'payload.gz'));
    assert.ok(resolved === null || !containedIn(resolved, [fs.realpathSync.native(store)]),
      'a junction out of the store is never reported as inside it');

    // The climb itself: a path under a dir that EXISTS resolves normally...
    const fresh = path.join(store, 'newdir', 'newfile.gz');
    const okPath = physicalForCreate(fresh);
    assert.ok(okPath && containedIn(okPath, [fs.realpathSync.native(store)]), 'a genuinely absent tail still resolves (that is the function\'s job)');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// churn-lab Finding 1 — the lexical comparator must REFUSE what it cannot judge.
// ORACLE INDEPENDENCE (the brief's warning): the expected answer comes from
// `physicalOrNull` — a filesystem call — never from `isCanonicalShape`, the helper
// the fix is built on. A check that shares its oracle proves only self-consistency.
test('Finding 1: containedIn REFUSES a non-canonical argument instead of disagreeing with physical truth', (t) => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwcb-f1-')));
  try {
    const real = path.join(base, 'real');
    const outside = path.join(base, 'outside');
    fs.mkdirSync(real, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });

    // sanity: the honest case still works, so a blanket `false` cannot pass this
    assert.strictEqual(containedIn(path.join(real, 'f.md'), [real]), true, 'a canonical pair is still contained');

    // FAIL-OPEN direction: a junction inside `real` pointing OUT. Lexically the
    // child looks contained; physically it is not. Refusal is the correct answer.
    let link = null;
    try {
      link = path.join(real, 'link');
      fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch { link = null; }
    if (link) {
      const via = path.join(link, 'f.md');
      const physically = physicalOrNull(path.dirname(via)); // INDEPENDENT oracle
      assert.strictEqual(containedIn(physically, [real]), false,
        'physical truth: the junction target is OUTSIDE real — the honest verdict is not-contained');
    }

    // Non-canonical spellings of a genuinely-inside path: all refused, because a
    // lexical comparator cannot know whether they resolve inside or out.
    for (const [label, spelling] of [
      ['dot-dot', path.join(real, 'sub', '..', 'f.md').replace(`${path.sep}f.md`, `${path.sep}sub${path.sep}..${path.sep}f.md`)],
      ['relative', 'f.md'],
      ['trailing separator', `${real}${path.sep}`],
      ['empty', ''],
      ['non-string', 42],
    ]) {
      if (label === 'dot-dot' && path.resolve(spelling) === spelling) continue; // already normalized here
      assert.strictEqual(containedIn(spelling, [real]), false, `${label} must be REFUSED, never lexically compared`);
    }

    // and a non-canonical ROOT cannot admit anything
    assert.strictEqual(containedIn(path.join(real, 'f.md'), [`${real}${path.sep}`]), false,
      'a non-canonical root is skipped, not trusted');
    if (!link) t.skip('junction unavailable — the fail-OPEN leg could not be built (capability proven absent)');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// NESTED-HABITAT tier split, at the discovery layer (the sibling of #22's role
// tier, which this file already implements and documents). An ancestor's
// governance is NOT room-owned: the room can neither wash it (law clause 2 —
// that is the umbrella room's jurisdiction) nor externalize it, which is the
// exact advice a capHit FULL gives.
// ---------------------------------------------------------------------------
test('NESTED-HABITAT: ancestor governance lands in `inherited`, room governance in `entries` — and the GLOBAL memory store stays in `entries`', () => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwnh-home-')));
  try {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const umb = path.join(home, 'work', 'umbrella');
    const room = path.join(umb, 'room');
    fs.mkdirSync(room, { recursive: true });
    fs.writeFileSync(path.join(umb, 'CLAUDE.md'), '# umbrella\n@AGENTS.md\n', 'utf8');
    fs.writeFileSync(path.join(umb, 'AGENTS.md'), 'umbrella rules\n', 'utf8');
    fs.writeFileSync(path.join(room, 'CLAUDE.md'), '# room\n@MEMORY.md\n', 'utf8');
    fs.writeFileSync(path.join(room, 'MEMORY.md'), 'room memory\n', 'utf8');
    // the GLOBAL memory store CoalWash actually washes — scope 'project', but it
    // lives under HOME, OUTSIDE the room. It must NOT be mistaken for inherited.
    const gstore = ccMemoryDir(room, home);
    fs.mkdirSync(gstore, { recursive: true });
    fs.writeFileSync(path.join(gstore, 'MEMORY.md'), 'global index\n', 'utf8');

    const d = discoverClassB({ projectRoot: room, home, platform: 'claude-code' });
    // Assert the tier EXISTS before dereferencing it, so a body without it fails
    // as an assertion naming the missing tier — never a TypeError, which reads
    // exactly like a broken test rather than a proved defect.
    assert.ok(Array.isArray(d.inherited), 'discoverClassB must return the inherited-ancestor tier as its own field (nested-habitat law: three tiers, never a flat global/project pair)');
    const inh = d.inherited.map((e) => path.basename(e.path)).sort();
    const own = d.entries.map((e) => e.path);
    assert.deepStrictEqual(inh, ['AGENTS.md', 'CLAUDE.md'], 'the umbrella CLAUDE.md AND its @import closure are the ancestor tier');
    assert.ok(own.includes(path.join(room, 'CLAUDE.md')) && own.includes(path.join(room, 'MEMORY.md')), 'the room\'s own governance stays room-owned');
    assert.ok(own.includes(path.join(gstore, 'MEMORY.md')),
      'THE TRAP: the global memory store is outside the room but is NOT inherited — outside-the-room and not-the-room\'s are different questions');
    assert.ok(!own.some((p) => p.startsWith(umb + path.sep) && !p.startsWith(room + path.sep)),
      'no ancestor file may remain in entries — everything downstream of entries is a verdict the room is told to ACT on');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
