import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ccProjectSlug, ccMemoryDir, parseImports, discoverClassB, detectPlatform, containedIn, physicalOrNull } from './class-b.mjs';

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
