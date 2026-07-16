import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ccProjectSlug, ccMemoryDir, parseImports, discoverClassB, detectPlatform, containedIn, physicalOrNull, physicalForCreate } from './class-b.mjs';

// Hermetic: the real machine's CLAUDE_CONFIG_DIR must never leak into
// sandbox-home resolution (node --test runs each file in its own process).
delete process.env.CLAUDE_CONFIG_DIR;

function sandbox() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwb-home-')));
  const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwb-proj-')));
  return { home, proj };
}
function clean(...dirs) {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}
function write(p, content = 'x') {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

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

test('ccMemoryDir derives <base>/projects/<slug>/memory under the given home', () => {
  const { home, proj } = sandbox();
  try {
    const dir = ccMemoryDir(proj, home);
    assert.strictEqual(dir, path.join(home, '.claude', 'projects', ccProjectSlug(proj), 'memory'));
  } finally { clean(home, proj); }
});

test('parseImports: line-start @tokens only; ~/, absolute, and relative forms', () => {
  const { home } = sandbox();
  try {
    const text = ['@AGENTS.md', '  @~/global.md', 'not @inline.md', '@' + path.join(os.tmpdir(), 'abs.md'), '@two tokens ignored extra'].join('\n');
    const got = parseImports(text, '/base', home);
    assert.deepStrictEqual(got, [
      path.resolve('/base', 'AGENTS.md'),
      path.join(home, 'global.md'),
      path.join(os.tmpdir(), 'abs.md'),
    ]);
  } finally { clean(home); }
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
    const by = (p) => d.entries.find((e) => e.path === fs.realpathSync(p));

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
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwb-out-')));
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
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwb-escape-')));
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
    const sibling = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwb-sibling-')));
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
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwcb-pfc-')));
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
