import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { globalConfigPath, findProjectRoot, loadMergedConfig, claudeBaseDir, claudeBaseDirs, touchesClaudeBase, canonicalOrNull, mergeSafety } from './config-load.mjs';

// realpath'd sandboxes: on macOS os.tmpdir() is a symlink (/var -> /private/var);
// resolving here keeps assertions in the same physical form the walk sees.
function sandbox() {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-home-')));
  const proj = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-proj-')));
  return { home, proj };
}
function clean(...dirs) {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}

// WAVE-2 R2: a missing global config is not "no constraint" -- it is the
// schema default, and the schema default for writeGuard IS the safe position
// ('on'). No global file exists at all (the common case: most users never
// write one) is the exact scenario an untrusted cloned repo's project config
// is written to defeat.
test('mergeSafety: NO global at all + project sets writeGuard weaker than the schema default -> clamped to the default, never the project value', () => {
  const merged = mergeSafety({}, { writeGuard: 'off' });
  assert.strictEqual(merged.writeGuard, 'on', 'a cloned repo with no global config must not be able to disable the undo net for gitignored governance files');
});

test('mergeSafety: NO global + project sets updateMode weaker (auto) than the schema default (ask) -> clamped to the default', () => {
  const merged = mergeSafety({}, { updateMode: 'auto' });
  assert.strictEqual(merged.updateMode, 'ask', 'a cloned repo with no global config must not be able to turn on standing-consent self-update checks');
});

test('mergeSafety: NO global + project moves SAFER than the schema default -> project value stands, the clamp never over-tightens', () => {
  // coalwashMode default is 'auto' (the weakest end of its own order) -- a
  // project asking for the SAFER 'off' with no global present must be honored,
  // proving the fix clamps only the weakening direction, not every deviation.
  assert.strictEqual(mergeSafety({}, { coalwashMode: 'off' }).coalwashMode, 'off');
  assert.strictEqual(mergeSafety({}, { writeGuard: 'on' }).writeGuard, 'on', 'matching the default exactly must never be rejected');
});

// K1 (graduation-lab round 2): an INVALID project value ESCALATED. The old
// unknown-value branch was `continue` — "leave the shallow-merge result
// (schema clamps it downstream)" — but the shallow merge is project-wins and
// the downstream clamp lands on the SCHEMA DEFAULT, not on the global's
// stance: global `coalwashMode:'off'` + project `'nope'` resolved ACTIVE
// ('auto'). An invalid project value now gets NO say: the effective global
// (real, else the schema default) stands, stored CANONICAL.
test('K1: an invalid project value must not displace a global off (the escalation-by-junk hole)', () => {
  for (const junk of ['nope', ' auto ', null, 0, true, {}, [], 42]) {
    const merged = mergeSafety({ coalwashMode: 'off' }, { coalwashMode: junk });
    assert.strictEqual(merged.coalwashMode, 'off',
      `project ${JSON.stringify(junk)} must not defeat a global off (got ${JSON.stringify(merged.coalwashMode)})`);
  }
  // same hole on updateMode: global 'off' + junk must stay 'off', never the
  // schema default 'ask' (standing-consent update checks re-enabled by junk)
  assert.strictEqual(mergeSafety({ updateMode: 'off' }, { updateMode: 'garbage' }).updateMode, 'off');
});

test('K1: an invalid project value with NO global lands on the schema default CANONICALLY (no stance to defend, none invented)', () => {
  assert.strictEqual(mergeSafety({}, { coalwashMode: 'nope' }).coalwashMode, 'auto', 'no global stance -> the schema default, by the clamp itself, not by downstream luck');
  assert.strictEqual(mergeSafety({}, { writeGuard: [] }).writeGuard, 'on');
});

test('K1: a CASE VARIANT of a valid value resolves CANONICAL at the merge layer — check one spelling, act on that same spelling', () => {
  // 'Off' case-folds to a valid value and wins the safer-compare, but the old
  // code stored the RAW string — every clampedRead consumer normalizes, so
  // the end-to-end blast was merge-layer-only; canonical storage removes the
  // trap for any future raw-compare consumer.
  assert.strictEqual(mergeSafety({ coalwashMode: 'off' }, { coalwashMode: 'Off' }).coalwashMode, 'off');
  assert.strictEqual(mergeSafety({}, { coalwashMode: 'MANUAL' }).coalwashMode, 'manual');
  // an INVALID-cased GLOBAL is defended too: its stance reads as its folded
  // self, and the stored result is canonical
  assert.strictEqual(mergeSafety({ coalwashMode: 'OFF' }, { coalwashMode: 'auto' }).coalwashMode, 'off', 'a raw-cased global stance still clamps the project escalation');
});

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

test('BOM-prefixed config degrades cleanly; a genuinely MISSING config is {} (never throws)', () => {
  const { home, proj } = sandbox();
  try {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', '.coalwash.json'), String.fromCharCode(0xfeff) + '{ "fullPercent": 9 }');
    assert.strictEqual(loadMergedConfig({ cwd: proj, home }).fullPercent, 9, 'BOM stripped');
    fs.rmSync(path.join(home, '.claude', '.coalwash.json'));
    assert.deepStrictEqual(loadMergedConfig({ cwd: proj, home }), {}, 'a genuinely absent global is a real position (schema default), not "unknown"');
  } finally { clean(home, proj); }
});

// W2-3 (task #22, blind-wave W2): a global file that EXISTS but fails to
// read/decode/parse is an UNKNOWN stance, not an absent one -- the old code
// collapsed both to {} and let a corrupted kill switch silently revert to
// the schema default ("auto"), which can be WEAKER than whatever the user
// had actually set. Moved out of the old combined test above (which
// asserted the bug's own shape as "expected") into its own red-first case.
test('W2-3: a PRESENT-but-corrupt global config assumes the SAFEST stance on every safety key, never the schema default (the kill switch cannot silently revert to "auto")', () => {
  const { home, proj } = sandbox();
  try {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', '.coalwash.json'), '{ not json');
    const cfg = loadMergedConfig({ cwd: proj, home });
    assert.strictEqual(cfg.coalwashMode, 'off', 'schema default is "auto" -- the safest index must win instead');
    assert.strictEqual(cfg.updateMode, 'off', 'schema default is "ask" -- the safest index must win instead');
    assert.strictEqual(cfg.writeGuard, 'on', 'writeGuard\'s safest end is "on" (matches its own default here, still must not regress)');
    assert.strictEqual(cfg.localOnly, true, 'privacy opt-in assumed on an unreadable global');
  } finally { clean(home, proj); }
});

test('W2-3: an unreadable global still cannot be ESCALATED past by a project value (the project gets no more say than usual)', () => {
  const { home, proj } = sandbox();
  try {
    writeCfgs(home, proj, {}, { coalwashMode: 'auto', updateMode: 'auto', writeGuard: 'off', localOnly: false });
    fs.writeFileSync(path.join(home, '.claude', '.coalwash.json'), '{ broken'); // overwrite with corrupt bytes
    const cfg = loadMergedConfig({ cwd: proj, home });
    assert.strictEqual(cfg.coalwashMode, 'off');
    assert.strictEqual(cfg.updateMode, 'off');
    assert.strictEqual(cfg.writeGuard, 'on');
    assert.strictEqual(cfg.localOnly, true);
  } finally { clean(home, proj); }
});

test('W2-3: a MISSING global (never written at all) is unaffected -- unreadable only fires when the file EXISTS', () => {
  const { home, proj } = sandbox();
  try {
    fs.writeFileSync(path.join(proj, '.coalwash.json'), JSON.stringify({ coalwashMode: 'auto' }));
    const cfg = loadMergedConfig({ cwd: proj, home });
    assert.strictEqual(cfg.coalwashMode, 'auto', 'no global file at all -> the project value is honored (schema default "auto" imposes no constraint here)');
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

// --- task #22 (W2-1 HIGH): object-typed keys get the SAME safer-value-wins
//     clamp one level deep, and the merge itself is per-sub-key (W2-2) ---
test('W2-1 HIGH: a project cannot flip estate.deleteCold false->true (the archive-then-DELETE gate for live transcripts)', () => {
  const { home, proj } = sandbox();
  try {
    writeCfgs(home, proj,
      { estate: { deleteCold: false, purgeAfterDays: 3650, compressAfterDays: 365 } },
      { estate: { deleteCold: true, purgeAfterDays: 1, compressAfterDays: 1 } });
    const cfg = loadMergedConfig({ cwd: proj, home });
    assert.strictEqual(cfg.estate.deleteCold, false, 'the clone-borne project value must not win');
  } finally { clean(home, proj); }
});

test('W2-1: a global deleteCold:true (a real, deliberate opt-in) is honored -- the clamp blocks ESCALATION, not the user\'s own choice', () => {
  const { home, proj } = sandbox();
  try {
    writeCfgs(home, proj, { estate: { deleteCold: true } }, {});
    assert.strictEqual(loadMergedConfig({ cwd: proj, home }).estate.deleteCold, true);
  } finally { clean(home, proj); }
});

test('W2-1: a project MAY quieten deleteCold true->false (turning it off is always allowed)', () => {
  const { home, proj } = sandbox();
  try {
    writeCfgs(home, proj, { estate: { deleteCold: true } }, { estate: { deleteCold: false } });
    assert.strictEqual(loadMergedConfig({ cwd: proj, home }).estate.deleteCold, false);
  } finally { clean(home, proj); }
});

test('W2-1: NO global config at all -- the schema default (false) still blocks a project deleteCold:true', () => {
  const { proj } = sandbox();
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-home-'))); // no .claude dir at all
  try {
    fs.writeFileSync(path.join(proj, '.coalwash.json'), JSON.stringify({ estate: { deleteCold: true } }));
    assert.strictEqual(loadMergedConfig({ cwd: proj, home }).estate.deleteCold, false);
  } finally { clean(home, proj); }
});

test('W2-1: a junk deleteCold value gets no say -- the effective global stands (K1\'s own rule, one level deeper)', () => {
  const { home, proj } = sandbox();
  try {
    for (const junk of ['true', 1, 'yes', null, {}]) {
      writeCfgs(home, proj, { estate: { deleteCold: false } }, { estate: { deleteCold: junk } });
      assert.strictEqual(loadMergedConfig({ cwd: proj, home }).estate.deleteCold, false, `junk ${JSON.stringify(junk)} must not escalate`);
    }
  } finally { clean(home, proj); }
});

test('W2-2: a project touching ONE estate sub-key no longer clobbers the user\'s OTHER global sub-keys to schema defaults', () => {
  const { home, proj } = sandbox();
  try {
    writeCfgs(home, proj,
      { estate: { deleteCold: false, purgeAfterDays: 3650, compressAfterDays: 365, archiveDir: 'D:/my-archive' } },
      { estate: { indexEnabled: false } });
    const cfg = loadMergedConfig({ cwd: proj, home });
    assert.strictEqual(cfg.estate.purgeAfterDays, 3650, 'global sub-key must survive a partial project override');
    assert.strictEqual(cfg.estate.compressAfterDays, 365);
    assert.strictEqual(cfg.estate.archiveDir, 'D:/my-archive');
    assert.strictEqual(cfg.estate.indexEnabled, false, 'the project\'s own touched sub-key still wins');
  } finally { clean(home, proj); }
});

test('W2-2: the same one-level merge applies to `retier` too (no consent sub-keys there, plain project-wins per sub-key)', () => {
  const { home, proj } = sandbox();
  try {
    writeCfgs(home, proj, { retier: { targetTokens: 6250, armPct: 50 } }, { retier: { headroomPct: 5 } });
    const cfg = loadMergedConfig({ cwd: proj, home });
    assert.strictEqual(cfg.retier.targetTokens, 6250, 'global sub-key survives');
    assert.strictEqual(cfg.retier.armPct, 50);
    assert.strictEqual(cfg.retier.headroomPct, 5, 'project sub-key wins on its own key');
  } finally { clean(home, proj); }
});

test('mergeSafety: object-key merge tolerates a non-object/malformed value on either side without throwing', () => {
  assert.doesNotThrow(() => mergeSafety({ estate: 'not an object' }, { estate: { deleteCold: true } }));
  assert.doesNotThrow(() => mergeSafety({ estate: { deleteCold: false } }, { estate: null }));
  assert.doesNotThrow(() => mergeSafety({ estate: [1, 2] }, {}));
  const merged = mergeSafety({ estate: 'not an object' }, { estate: { deleteCold: true } });
  assert.strictEqual(merged.estate.deleteCold, false, 'a malformed global counts as absent -> schema default (false) still holds');
});

// --- W2-5: a RELATIVE CLAUDE_CONFIG_DIR must never collapse global onto project ---
test('W2-5: a relative CLAUDE_CONFIG_DIR is rejected -- claudeBaseDirs falls back to the fixed ~/.claude default', () => {
  const prev = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CLAUDE_CONFIG_DIR = '.';
    const { home } = sandbox();
    try {
      assert.deepStrictEqual(claudeBaseDirs(home), [path.join(home, '.claude')], 'a relative entry must not survive into the base-dir list');
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});

test('W2-5/LOW: a DRIVE-RELATIVE entry (isAbsolute()===true, no drive/UNC root) is rejected on win32 -- resolution still depends on the current drive', { skip: process.platform !== 'win32' && 'win32-only shape' }, () => {
  const prev = process.env.CLAUDE_CONFIG_DIR;
  try {
    const { home } = sandbox();
    try {
      process.env.CLAUDE_CONFIG_DIR = '/repo'; // isAbsolute() is true here, but there is no drive letter
      assert.deepStrictEqual(claudeBaseDirs(home), [path.join(home, '.claude')], 'a drive-relative entry must not survive -- path.resolve("/repo") depends on the CURRENT drive');
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});

test('W2-5: an ABSOLUTE CLAUDE_CONFIG_DIR entry still passes through unchanged (only relative shapes are refused)', () => {
  const prev = process.env.CLAUDE_CONFIG_DIR;
  try {
    const { home } = sandbox();
    try {
      const abs = path.join(home, 'alt-config');
      process.env.CLAUDE_CONFIG_DIR = abs;
      assert.deepStrictEqual(claudeBaseDirs(home), [abs]);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});

test('W2-5: CLAUDE_CONFIG_DIR="." pointed at the project root no longer collapses global==project (mergeSafety keeps its trust boundary)', () => {
  const prev = process.env.CLAUDE_CONFIG_DIR;
  const cwdWas = process.cwd();
  try {
    const { home, proj } = sandbox();
    try {
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(home, '.claude', '.coalwash.json'), JSON.stringify({ coalwashMode: 'off' }));
      fs.writeFileSync(path.join(proj, '.coalwash.json'), JSON.stringify({ coalwashMode: 'auto' }));
      process.env.CLAUDE_CONFIG_DIR = '.';
      process.chdir(proj);
      // LOW (re-inspect 2026-07-30): a raw string compare only proves the two
      // SPELLINGS differ, not that they point at different FILES (a symlink,
      // case-folding, or a trailing-slash difference could make two distinct
      // strings resolve to the same physical file). Both files already exist
      // at this point, so resolve the real filesystem identity of each and
      // compare THAT.
      assert.notStrictEqual(fs.realpathSync.native(globalConfigPath(home)), fs.realpathSync.native(path.join(proj, '.coalwash.json')), 'global must not resolve onto the project file');
      const cfg = loadMergedConfig({ cwd: proj, home });
      assert.strictEqual(cfg.coalwashMode, 'off', 'the global off-switch must still clamp the project value');
    } finally { process.chdir(cwdWas); clean(home, proj); }
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
  }
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

// ---------------------------------------------------------------------------
// ROOT-ANCHORED DERIVATION (2026-07-25 field fix, layer 1). A project that
// declares itself by GOVERNANCE and not by git used to match no marker at all,
// so the walk ran to home and fell back to the raw cwd — a different "project
// root" per subdir, which minted a spurious ~/.claude/projects/<slug>/ per subdir.
// ---------------------------------------------------------------------------

test('root-anchor: a governance-only project (CLAUDE.md, no .git) resolves to the SAME root from its root and from any deep subdir', () => {
  const { home, proj } = sandbox();
  try {
    fs.writeFileSync(path.join(proj, 'CLAUDE.md'), '# room entrypoint\n'); // governance root, deliberately NO .git
    const deep = path.join(proj, 'scratchpad', 'virus-hunt');
    fs.mkdirSync(deep, { recursive: true });
    assert.strictEqual(findProjectRoot(proj, home), proj, 'root resolves to itself');
    assert.strictEqual(findProjectRoot(deep, home), proj, 'deep subdir resolves to the SAME root (was: the raw subdir)');
    assert.strictEqual(findProjectRoot(path.join(proj, 'scratchpad'), home), proj, 'mid subdir too');
  } finally { clean(home, proj); }
});

test('root-anchor: AGENTS.md is deliberately NOT a root marker (Codex reads a per-DIRECTORY chain — treating one as a root would re-create the subdir scatter)', () => {
  const { home, proj } = sandbox();
  try {
    const sub = path.join(proj, 'pkg');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(proj, '.git'), 'gitdir: elsewhere\n'); // worktree-style marker file
    fs.writeFileSync(path.join(sub, 'AGENTS.md'), '# per-package instructions\n');
    assert.strictEqual(findProjectRoot(sub, home), proj, 'a nested AGENTS.md does not anchor a root');
  } finally { clean(home, proj); }
});

test('root-anchor: a nested repo still wins over its governance parent (walk stops LOWER = the fail-closed direction)', () => {
  const { home, proj } = sandbox();
  try {
    fs.writeFileSync(path.join(proj, 'CLAUDE.md'), '# umbrella\n');
    const room = path.join(proj, 'RoomRepo');
    fs.mkdirSync(path.join(room, 'scripts', 'lib'), { recursive: true });
    fs.mkdirSync(path.join(room, '.git'), { recursive: true });
    assert.strictEqual(findProjectRoot(path.join(room, 'scripts', 'lib'), home), room, 'the nearer repo root wins, not the umbrella');
  } finally { clean(home, proj); }
});

test('root-anchor: no marker anywhere still falls back to startDir (unchanged fail-closed behavior)', () => {
  const { home, proj } = sandbox();
  try {
    const deep = path.join(proj, 'a', 'b');
    fs.mkdirSync(deep, { recursive: true });
    assert.strictEqual(findProjectRoot(deep, home), deep, 'unmarked tree: unchanged');
  } finally { clean(home, proj); }
});

test('TP-4 [SECURITY]: the Claude base dir is NEVER a project root — ~/.claude/CLAUDE.md (the user global instruction file) must not make ~/.claude a trusted anchor', () => {
  const { home, proj } = sandbox();
  try {
    const claude = path.join(home, '.claude');
    const deep = path.join(claude, 'projects', 'C--some-proj', 'memory');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(claude, 'CLAUDE.md'), '# global user instructions\n'); // the real, documented file
    assert.notStrictEqual(findProjectRoot(deep, home), claude, '~/.claude is NOT a project root (it would become an applyPlan trusted root -> settings.json hook injection)');
    assert.strictEqual(findProjectRoot(deep, home), deep, 'no other marker -> the fail-closed startDir fallback, exactly as before CLAUDE.md was a marker');
    // the exclusion is the BASE DIR, not "any dot-dir": a real project keeps working
    fs.writeFileSync(path.join(proj, 'CLAUDE.md'), '# a real room\n');
    const sub = path.join(proj, 'a', 'b');
    fs.mkdirSync(sub, { recursive: true });
    assert.strictEqual(findProjectRoot(sub, home), proj, 'the state-scatter fix still holds for REAL projects');
  } finally { fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true }); clean(home, proj); }
});

test('TP-4: the exclusion follows CLAUDE_CONFIG_DIR (derived, never hardcoded)', () => {
  const { home, proj } = sandbox();
  const prev = process.env.CLAUDE_CONFIG_DIR;
  try {
    const alt = path.join(home, 'altconfig');
    fs.mkdirSync(alt, { recursive: true });
    fs.writeFileSync(path.join(alt, 'CLAUDE.md'), '# global\n');
    process.env.CLAUDE_CONFIG_DIR = alt;
    const deep = path.join(alt, 'projects', 'x');
    fs.mkdirSync(deep, { recursive: true });
    assert.notStrictEqual(findProjectRoot(deep, home), alt, 'the relocated base dir is excluded too');
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
    clean(home, proj);
  }
});

test('R2/TP-1+TP-3: touchesClaudeBase is case-folded and covers EVERY CLAUDE_CONFIG_DIR entry (the raw `dir !== claudeAbs` compare missed a drive-case variant, and only entry[0] was ever excluded)', () => {
  const { home, proj } = sandbox();
  const prev = process.env.CLAUDE_CONFIG_DIR;
  try {
    const a = path.join(home, 'cfgA'); const b = path.join(home, 'cfgB');
    fs.mkdirSync(path.join(a, 'projects'), { recursive: true });
    fs.mkdirSync(path.join(b, 'projects'), { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = `${a},${b}`;
    assert.deepStrictEqual(claudeBaseDirs(home), [a, b], 'both entries are known');
    for (const base of [a, b]) {
      assert.strictEqual(touchesClaudeBase(base, home), true, 'the base dir itself');
      assert.strictEqual(touchesClaudeBase(path.join(base, 'projects', 'x'), home), true, 'a path INSIDE it');
      // TWO MECHANISMS, ONE RESULT — and this line conflated them TWICE before
      // landing here, each time keyed to the wrong axis.
      //   v1 asserted `=== (platform === 'win32')`: red on macOS, because the axis
      //      is the VOLUME (APFS is case-insensitive), not the OS.
      //   v2 asserted `=== caseInsensitiveFs`: red on ubuntu, because the RESULT is
      //      true on every volume — only the ROUTE differs.
      // The routes — and MEASURED, because the obvious label for the first one is
      // wrong: on a case-INsensitive volume realpathSync.native NORMALIZES the
      // casing (C:\USERS\... comes back C:\Users\...), so the variant resolves to
      // the identical canonical string and containment is reached by RESOLUTION,
      // not by pathWithin's case-fold. (That fold is a separate belt, for spellings
      // that differ without resolving differently — a drive-case anchor.) On a
      // case-sensitive volume the variant does not exist at all, canonicalOrNull
      // returns null, and the R4/TP-1 rule fires instead: present-but-unresolvable
      // ANCHOR is REFUSED. Right answer, two different roads. A claim that only
      // means something on one volume has to be stated as two claims, so: assert
      // the invariant that holds everywhere, then pin WHICH road actually ran here
      // — otherwise this passes as "true for some reason" and detects neither.
      const variant = base.toUpperCase();
      const caseInsensitiveFs = fs.existsSync(variant);
      assert.strictEqual(touchesClaudeBase(variant, home), true,
        'a case variant is refused on EVERY volume — by case-fold where it resolves, fail-closed where it does not');
      if (caseInsensitiveFs) {
        assert.notStrictEqual(canonicalOrNull(variant), null,
          'case-INsensitive volume: the variant RESOLVES (realpath normalizes casing), so RESOLUTION is what produced the refusal');
      } else {
        assert.strictEqual(canonicalOrNull(variant), null,
          'case-sensitive volume: the variant does not resolve, so the FAIL-CLOSED anchor rule is what produced it');
      }
    }
    assert.strictEqual(touchesClaudeBase(home, home), true, 'a path CONTAINING a base dir (either direction)');
    assert.strictEqual(touchesClaudeBase(proj, home), false, 'an unrelated project does NOT touch config territory');
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
    clean(home, proj);
  }
});

// ---------------------------------------------------------------------------
// R3/TP-1 — the canonicalization PRIMITIVE. win32 has path spellings that name the
// same directory but that realpathSync does not canonicalize; every containment
// guard in the engine routes through canonicalOrNull, so it fails CLOSED on them.
// ---------------------------------------------------------------------------
function shortName(p) {
  try { return execSync(`cmd /c for %I in ("${p}") do @echo %~sI`, { encoding: 'utf8' }).trim(); } catch { return p; }
}

test('R3/TP-1: canonicalOrNull EXPANDS an 8.3 short name (plain realpathSync does not) so a short and long spelling compare EQUAL', (t) => {
  if (process.platform !== 'win32') { t.skip('8.3 is a win32 form'); return; }
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'CW-LONGDIRNAME-FOR-8DOT3-')));
  try {
    const s = shortName(dir);
    if (s === dir) { t.skip('8.3 creation disabled on this volume'); return; }
    // DELIBERATELY the plain variant — this line IS the contrast the test exists to
    // draw, so it must never be swept to `.native` along with the fixture roots.
    // (It was, once: the CI-red sweep that aligned every fixture with the engine's
    // canonicalizer hit this too and silently inverted the assertion's meaning.)
    assert.notStrictEqual(fs.realpathSync(s), dir, 'plain realpathSync leaves the 8.3 form (the bug)');
    assert.strictEqual(canonicalOrNull(s), dir, 'canonicalOrNull expands it to the long form');
    assert.strictEqual(canonicalOrNull(s), canonicalOrNull(dir), 'both spellings canonicalize to ONE value');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('R3/TP-1: canonicalOrNull refuses BY SHAPE the forms it cannot canonicalize — UNC and \\\\?\\ — instead of fail-opening to path.resolve', (t) => {
  if (process.platform !== 'win32') { t.skip('UNC / \\\\?\\ are win32 forms'); return; }
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-shape-')));
  try {
    assert.strictEqual(canonicalOrNull('\\\\localhost\\' + dir[0] + '$' + dir.slice(2)), null, 'UNC refused (native does not collapse it to the drive-letter form)');
    assert.strictEqual(canonicalOrNull('\\\\?\\' + dir), null, '\\\\?\\ refused (it switches OFF Windows path normalization)');
    assert.strictEqual(canonicalOrNull(dir), dir, 'the ordinary form still canonicalizes — no false refusal');
    assert.strictEqual(canonicalOrNull(path.join(dir, 'does-not-exist')), null, 'an unresolvable path is null, NOT a lexical path.resolve fallback');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('R3/TP-1: touchesClaudeBase treats an UNCANONICALIZABLE path as touching — "I could not resolve it" is not a yes', () => {
  const { home, proj } = sandbox();
  try {
    assert.strictEqual(touchesClaudeBase(path.join(proj, 'nope', 'gone'), home), true, 'unresolvable => refuse (a false here would restore the fail-open)');
    assert.strictEqual(touchesClaudeBase(proj, home), false, 'a real project dir still passes');
  } finally { clean(home, proj); }
});

test('R3/LOW: claudeBaseDir agrees with claudeBaseDirs when CLAUDE_CONFIG_DIR has a leading empty entry (the dir the code WRITES to must be in the guarded set)', () => {
  const { home, proj } = sandbox();
  const prev = process.env.CLAUDE_CONFIG_DIR;
  try {
    const x = path.join(home, 'cfgX');
    fs.mkdirSync(x, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = `,${x}`;
    assert.deepStrictEqual(claudeBaseDirs(home), [x]);
    assert.strictEqual(claudeBaseDir(home), x, 'singular no longer falls through to ~/.claude while plural reports X');
    assert.strictEqual(touchesClaudeBase(x, home), true, 'and the write target is guarded');
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
    clean(home, proj);
  }
});

test('R4/TP-2: a LEGAL long name that merely looks 8.3-ish is NOT refused — the previous check tested the canonicalizer OUTPUT, where a real alias has already been expanded, so it could only ever fire on legal names', () => {
  const { home, proj } = sandbox();
  try {
    for (const name of ['PROGRA~1', 'backup~1', 'notes~2', 'a~1', 'x~10']) {
      const d = path.join(proj, name);
      fs.mkdirSync(d, { recursive: true });
      assert.strictEqual(canonicalOrNull(d), d, `${name} is a legal directory name and must canonicalize (it made such a project unwashable and switched off the writeguard airbag)`);
      assert.strictEqual(touchesClaudeBase(d, home), false, `${name} is not config territory`);
    }
  } finally { clean(home, proj); }
});

test('R4/TP-1 [SECURITY]: an unresolvable BASE must REFUSE, not switch the guard off — absent is "no constraint", present-but-unresolvable is "refuse"', () => {
  const { home, proj } = sandbox();
  const prev = process.env.CLAUDE_CONFIG_DIR;
  try {
    // ABSENT base -> not a constraint (a fresh install with no ~/.claude must still work)
    process.env.CLAUDE_CONFIG_DIR = path.join(home, 'never-created');
    assert.strictEqual(touchesClaudeBase(proj, home), false, 'absent base => not a constraint');

    // PRESENT but spelled in a form we refuse to canonicalize -> refuse EVERY anchor
    const real = path.join(home, 'cfgReal');
    fs.mkdirSync(real, { recursive: true });
    if (process.platform === 'win32') {
      process.env.CLAUDE_CONFIG_DIR = '\u005C\u005C?\u005C' + real;   // \?\ spelling of a REAL config dir
      assert.strictEqual(touchesClaudeBase(proj, home), true, 'present-but-unresolvable base => refuse (pre-fix this returned false for EVERY anchor and the whole guard became a no-op)');
      process.env.CLAUDE_CONFIG_DIR = '\u005C\u005Clocalhost\u005C' + real[0] + '$' + real.slice(2); // UNC spelling
      assert.strictEqual(touchesClaudeBase(proj, home), true, 'UNC-spelled base => refuse');
    }
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
    clean(home, proj);
  }
});
