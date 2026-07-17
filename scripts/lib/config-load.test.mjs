import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { globalConfigPath, findProjectRoot, loadMergedConfig } from './config-load.mjs';

// realpath'd sandboxes: on macOS os.tmpdir() is a symlink (/var -> /private/var);
// resolving here keeps assertions in the same physical form the walk sees.
function sandbox() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-home-')));
  const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-proj-')));
  return { home, proj };
}
function clean(...dirs) {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}

test('globalConfigPath honors an explicit home', () => {
  const { home, proj } = sandbox();
  try {
    assert.strictEqual(globalConfigPath(home), path.join(home, '.claude', '.coalwash.json'));
  } finally { clean(home, proj); }
});

test('project config overlays global key-by-key (flat merge)', () => {
  const { home, proj } = sandbox();
  try {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', '.coalwash.json'), '{ "fullPercent": 10, "localOnly": true }');
    fs.writeFileSync(path.join(proj, '.coalwash.json'), '// project override\n{ "fullPercent": 4 }');
    const cfg = loadMergedConfig({ cwd: proj, home });
    assert.strictEqual(cfg.fullPercent, 4, 'project wins');
    assert.strictEqual(cfg.localOnly, true, 'global keys survive');
  } finally { clean(home, proj); }
});

test('the project walk finds the root from a nested cwd and STOPS at home', () => {
  const { home, proj } = sandbox();
  try {
    fs.writeFileSync(path.join(proj, '.coalwash.json'), '{ "fullPercent": 7 }');
    const nested = path.join(proj, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });
    assert.strictEqual(findProjectRoot(nested, home), proj);
    // a dir under home with NO marker anywhere below home: never escapes above home
    const bare = path.join(home, 'work', 'deep');
    fs.mkdirSync(bare, { recursive: true });
    assert.strictEqual(findProjectRoot(bare, home), bare, 'no marker -> falls back to startDir, never above home');
  } finally {
    clean(home, proj);
  }
});

test('a .git marker also roots the project', () => {
  const { home, proj } = sandbox();
  try {
    fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
    const nested = path.join(proj, 'src');
    fs.mkdirSync(nested);
    assert.strictEqual(findProjectRoot(nested, home), proj);
  } finally { clean(home, proj); }
});

test('corrupt, BOM-prefixed, or missing config degrades to {} (never throws)', () => {
  const { home, proj } = sandbox();
  try {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', '.coalwash.json'), '{ not json');
    assert.deepStrictEqual(loadMergedConfig({ cwd: proj, home }), {});
    fs.writeFileSync(path.join(home, '.claude', '.coalwash.json'), String.fromCharCode(0xfeff) + '{ "fullPercent": 9 }');
    assert.strictEqual(loadMergedConfig({ cwd: proj, home }).fullPercent, 9, 'BOM stripped');
    fs.rmSync(path.join(home, '.claude', '.coalwash.json'));
    assert.deepStrictEqual(loadMergedConfig({ cwd: proj, home }), {});
  } finally { clean(home, proj); }
});

test('a poisoned project config cannot pollute Object.prototype through the merge', () => {
  const { home, proj } = sandbox();
  try {
    fs.writeFileSync(path.join(proj, '.coalwash.json'), '{ "__proto__": { "polluted": true }, "fullPercent": 5 }');
    const cfg = loadMergedConfig({ cwd: proj, home });
    assert.strictEqual(cfg.fullPercent, 5);
    assert.strictEqual(Object.prototype.polluted, undefined);
  } finally { clean(home, proj); }
});

// --- safer-value-wins monotonic merge (CoalBoard dogfood M3: an untrusted
//     project config must not weaken a deliberate GLOBAL safety choice) ---
function writeCfgs(home, proj, g, p) {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.coalwash.json'), JSON.stringify(g));
  fs.writeFileSync(path.join(proj, '.coalwash.json'), JSON.stringify(p));
}

test('monotonic: a project CANNOT disable a global localOnly:true (privacy opt-in holds)', () => {
  const { home, proj } = sandbox();
  try {
    writeCfgs(home, proj, { localOnly: true }, { localOnly: false });
    assert.strictEqual(loadMergedConfig({ cwd: proj, home }).localOnly, true, 'global privacy setting wins');
  } finally { clean(home, proj); }
});

test('monotonic: a project CAN enable localOnly the global left default (more private is allowed)', () => {
  const { home, proj } = sandbox();
  try {
    writeCfgs(home, proj, { fullPercent: 6 }, { localOnly: true });
    assert.strictEqual(loadMergedConfig({ cwd: proj, home }).localOnly, true, 'project may make it MORE private');
  } finally { clean(home, proj); }
});

test('monotonic: a project may SHUT OFF but not RE-ENABLE past global (the feature holds, the hole closes)', () => {
  const { home, proj } = sandbox();
  try {
    // global auto -> project off wins (the advertised "shut off per project")
    writeCfgs(home, proj, { coalwashMode: 'auto' }, { coalwashMode: 'off' });
    assert.strictEqual(loadMergedConfig({ cwd: proj, home }).coalwashMode, 'off', 'project may disable');
  } finally { clean(home, proj); }
  const s2 = sandbox();
  try {
    // global off (user disabled) -> project cannot re-enable to auto
    writeCfgs(s2.home, s2.proj, { coalwashMode: 'off' }, { coalwashMode: 'auto' });
    assert.strictEqual(loadMergedConfig({ cwd: s2.proj, home: s2.home }).coalwashMode, 'off', 'project cannot re-enable a globally-off tool');
  } finally { clean(s2.home, s2.proj); }
});

test('monotonic: a project cannot make updateMode LOUDER (off -> auto blocked); quieter is fine', () => {
  const { home, proj } = sandbox();
  try {
    writeCfgs(home, proj, { updateMode: 'off' }, { updateMode: 'auto' });
    assert.strictEqual(loadMergedConfig({ cwd: proj, home }).updateMode, 'off', 'no unsolicited network from a repo config');
  } finally { clean(home, proj); }
  const s2 = sandbox();
  try {
    writeCfgs(s2.home, s2.proj, { updateMode: 'ask' }, { updateMode: 'off' });
    assert.strictEqual(loadMergedConfig({ cwd: s2.proj, home: s2.home }).updateMode, 'off', 'quieter is always allowed');
  } finally { clean(s2.home, s2.proj); }
});

// --- H5: the safe-merge compare must be case-INSENSITIVE (the schema is) ---
test('H5: a case-variant project value cannot re-enable a globally-off skill (AUTO/Off case-fold)', () => {
  const { home, proj } = sandbox();
  try {
    writeCfgs(home, proj, { coalwashMode: 'off' }, { coalwashMode: 'AUTO' }); // uppercase bypass attempt
    assert.strictEqual(loadMergedConfig({ cwd: proj, home }).coalwashMode, 'off', 'AUTO must not out-rank a global off');
  } finally { clean(home, proj); }
});

test('H5: a cloned project cannot DISABLE the user global writeGuard airbag (any case); strengthening is allowed', () => {
  const { home, proj } = sandbox();
  try {
    writeCfgs(home, proj, { writeGuard: 'on' }, { writeGuard: 'Off' });
    assert.strictEqual(loadMergedConfig({ cwd: proj, home }).writeGuard, 'on', 'project may not weaken the airbag');
  } finally { clean(home, proj); }
  const s2 = sandbox();
  try {
    writeCfgs(s2.home, s2.proj, { writeGuard: 'off' }, { writeGuard: 'on' }); // the SAFE direction stays open
    assert.strictEqual(loadMergedConfig({ cwd: s2.proj, home: s2.home }).writeGuard, 'on', 'project may make it STRONGER');
  } finally { clean(s2.home, s2.proj); }
});

// --- H6: a UTF-16 config (what PowerShell `>` writes) must still parse ---
test('H6: a UTF-16LE global config kill switch is honored, not mojibake-dropped to defaults', () => {
  const { home, proj } = sandbox();
  try {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const cfg = path.join(home, '.claude', '.coalwash.json');
    const body = '{ "coalwashMode": "off" }';
    // UTF-16LE WITH BOM (Windows PowerShell `>` / Out-File default): the leading
    // U+FEFF encodes to the FF FE BOM bytes.
    fs.writeFileSync(cfg, Buffer.from(String.fromCharCode(0xfeff) + body, 'utf16le'));
    assert.strictEqual(loadMergedConfig({ cwd: proj, home }).coalwashMode, 'off', 'UTF-16LE BOM decoded, kill switch honored');
    // BOM-less UTF-16LE recovers via the NUL-byte signature (the ambiguous-decode
    // fail-toward-readable clause).
    fs.writeFileSync(cfg, Buffer.from(body, 'utf16le'));
    assert.strictEqual(loadMergedConfig({ cwd: proj, home }).coalwashMode, 'off', 'BOM-less UTF-16LE recovers via the NUL fallback');
  } finally { clean(home, proj); }
});
