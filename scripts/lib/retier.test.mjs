// Hermetic tests for retier.mjs — RE-TIER (blueprint §19.3): the ENVELOPE
// (mechanism 1) x the TREATMENT TABLE (mechanism 2) and their combination
// point (the quota-driven-loss damage surface). Sandboxed HOME/project — the
// real ~/.claude is NEVER touched (repo pattern).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  OVERFLOW_BASENAME, resolveRetierCfg, envelopeFor, envelopeBand,
  RETIER_TREATMENTS, classifyRetier, assertTreatmentAllowed,
  planIndexDemotion, unreferencedTopics,
  extractClaims, reconcileClaims, topAnchors, probeAnchors,
  moveVerify, rollbackFromSnapshot, retierScan, retierScanLines,
  runRetier, runRetierReport,
} from './retier.mjs';
import { tokensEst } from './caliper.mjs';
import { restoreSession, ESTATE_INDEX_NAME } from './estate-archive.mjs';
import { acquireLock, globalLockPath } from './apply.mjs';
import { ccProjectSlug } from './class-b.mjs';
import { CONFIG_SCHEMA, clampedRead } from './config-schema.mjs';

delete process.env.CLAUDE_CONFIG_DIR;

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, 'cli.mjs');
const repoDir = path.resolve(here, '..', '..');

// The small test envelope (min legal target, so fixtures stay small):
// arm 600 · disarm 450 · fill 450.
const R = { targetTokens: 500, armPct: 20, disarmPct: 10, headroomPct: 10 };

function sandbox() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwrt-home-')));
  const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwrt-proj-')));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  return { home, proj };
}
function clean(...dirs) { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); }
function write(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}
function memDir(home, proj) {
  return path.join(home, '.claude', 'projects', ccProjectSlug(proj), 'memory');
}
// An over-arm index (> 600 tok at the R envelope): every bullet carries one
// UNIQUE wikilink (so dropping any one line is a visible structured-token
// drop) + the shared [[flock-law]] anchor (the top-referenced probe target).
function bigIndex(lines = 24) {
  const out = ['# Memory index', '', '- [Alpha topic](alpha-topic.md) — the referenced pointer [[flock-law]] v9.9.9'];
  for (let i = 0; i < lines; i++) {
    out.push(`- [[uniq-${i}]] bullet ${i} — a long index line carrying enough prose to be worth demoting when the envelope arms [[flock-law]] v9.9.9 \`key-${i}\``);
  }
  return out.join('\n') + '\n';
}
function seedMainStore(home, proj, { index = bigIndex() } = {}) {
  const dir = memDir(home, proj);
  write(path.join(dir, 'MEMORY.md'), index);
  write(path.join(dir, 'alpha-topic.md'), 'ALPHA-KEEP — referenced topic body, plain prose.\n');
  write(path.join(dir, 'zeta-old.md'), 'ZETA-ORIGINAL-BYTES — an unreferenced topic; plain prose, no structured tokens.\n');
  write(path.join(dir, 'state.json'), '{"machine":true}');
  write(path.join(dir, 'trace.jsonl'), '{"vendor":true}\n');
  return dir;
}
function estateCfg(home, over = {}) {
  return { compressAfterDays: 14, purgeAfterDays: 180, deleteCold: false, archiveDir: path.join(home, 'archive'), indexEnabled: true, ...over };
}

// ---------------------------------------------------------------------------
// 1. ENVELOPE — band math, clamps, hysteresis, fill-to-headroom
// ---------------------------------------------------------------------------

test('envelope: factory derivations match the locked spec (target 4125 -> arm 4950 / disarm ~3712 / fill = target - headroom)', () => {
  const e = envelopeFor(undefined);
  assert.strictEqual(e.targetTokens, 4125);
  assert.strictEqual(e.armAt, 4950);
  assert.strictEqual(e.disarmAt, Math.round(4125 * 0.9));
  assert.strictEqual(e.fillCeiling, Math.round(4125 * 0.9));
});

test('envelope: band math — under-disarm / dead-zone / over-arm, boundaries inclusive on the outer edges', () => {
  const e = envelopeFor(undefined); // arm 4950, disarm 3713
  assert.strictEqual(envelopeBand(4950, e), 'over-arm');
  assert.strictEqual(envelopeBand(6000, e), 'over-arm');
  assert.strictEqual(envelopeBand(4949, e), 'dead-zone');
  assert.strictEqual(envelopeBand(4750, e), 'dead-zone'); // the real main store's expected reading
  assert.strictEqual(envelopeBand(e.disarmAt, e), 'under-disarm');
  assert.strictEqual(envelopeBand(e.disarmAt + 1, e), 'dead-zone');
  assert.strictEqual(envelopeBand(100, e), 'under-disarm');
  assert.strictEqual(envelopeBand(NaN, e), 'under-disarm'); // unmeasurable -> the quiet end, never an action
});

test('envelope: config clamps — out-of-range degrades to the factory default per sub-key (target 500-6250, pcts 5-50)', () => {
  const spec = CONFIG_SCHEMA.find((s) => s.key === 'retier');
  assert.ok(spec, 'retier key present in the schema');
  assert.deepStrictEqual(clampedRead({}, 'retier'), spec.def, 'absent -> full defaults');
  assert.deepStrictEqual(clampedRead({ retier: { targetTokens: 100 } }, 'retier'), spec.def, 'under min 500 -> default');
  assert.deepStrictEqual(clampedRead({ retier: { targetTokens: 7000 } }, 'retier'), spec.def, 'over the CC hard cap 6250 -> default');
  assert.deepStrictEqual(
    clampedRead({ retier: { targetTokens: 1000, armPct: 60, disarmPct: 4 } }, 'retier'),
    { targetTokens: 1000, armPct: 20, disarmPct: 10, headroomPct: 10 },
    'valid sub-key kept, each invalid sub-key degrades ALONE',
  );
  // defense-in-depth resolver mirrors the clamp
  assert.deepStrictEqual(resolveRetierCfg({ targetTokens: 400, armPct: 55 }), { targetTokens: 4125, armPct: 20, disarmPct: 10, headroomPct: 10 });
});

test('envelope: hysteresis no-flap — a store washed into the dead zone (between disarm and arm) does NOT re-trigger', () => {
  const { home, proj } = sandbox();
  try {
    // ~480 tok index: over disarm (450), under arm (600) = the dead zone
    const midLines = ['# Memory index', ''];
    for (let i = 0; i < 22; i++) midLines.push(`- dead zone filler line ${i} with enough prose to sit between the watermarks after a wash`);
    write(path.join(memDir(home, proj), 'MEMORY.md'), midLines.join('\n') + '\n');
    const tok = tokensEst(fs.readFileSync(path.join(memDir(home, proj), 'MEMORY.md'), 'utf8'));
    const env = envelopeFor(R);
    assert.strictEqual(envelopeBand(tok, env), 'dead-zone', `fixture must sit in the dead zone (got ${tok} tok vs [${env.disarmAt}..${env.armAt}])`);
    const res = runRetier({ projectRoot: proj, home, retier: R, estate: estateCfg(home) });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.refused, true);
    assert.match(res.reason, /dead zone, no action/);
  } finally { clean(home, proj); }
});

test('envelope: the demote pass fills only to target - headroom (post <= fillCeiling, and not everything demotable is moved)', () => {
  const env = envelopeFor(R);
  const index = bigIndex();
  const p = planIndexDemotion(index, env);
  assert.ok(p.movedLines.length > 0, 'over-arm index demotes');
  assert.ok(p.tokensAfter <= env.fillCeiling, `fills to <= fillCeiling (${p.tokensAfter} <= ${env.fillCeiling})`);
  const candidates = index.split('\n').filter((l) => l.trim() && !/^\s*#/.test(l)).length;
  assert.ok(p.movedLines.length < candidates, 'stops once it fits — never empties the index');
  // deterministic: same input -> same plan
  assert.deepStrictEqual(planIndexDemotion(index, env), p);
});

// ---------------------------------------------------------------------------
// 2. TREATMENT TABLE — every type x every treatment; ทิ้ง absent; fail-closed
// ---------------------------------------------------------------------------

test('table: every type x every treatment cell — allowed passes, anything stronger than the ceiling is REFUSED loud', () => {
  const allTreatments = ['skip', 'demote', 'condense-via-gate', 'ultra-bands', 'discard'];
  const expected = {
    'class-b-index': ['skip', 'condense-via-gate'],
    'class-b-topic': ['skip', 'demote', 'condense-via-gate'],
    governance: ['skip'],
    'machine-parsed': ['skip'],
    'vendor-artifact': ['skip', 'ultra-bands'],
    unknown: ['skip'],
  };
  assert.deepStrictEqual(
    Object.fromEntries(Object.entries(RETIER_TREATMENTS).map(([k, v]) => [k, [...v]])),
    expected,
    'the CODE table matches the locked spec cells',
  );
  for (const [type, allowed] of Object.entries(expected)) {
    for (const t of allTreatments) {
      if (allowed.includes(t)) assert.strictEqual(assertTreatmentAllowed(type, t), true, `${type} x ${t} allowed`);
      else assert.throws(() => assertTreatmentAllowed(type, t), /refused/, `${type} x ${t} refused`);
    }
  }
});

test("table: 'discard' (ทิ้ง) exists NOWHERE — refused for every type including unknown ones (fail-closed)", () => {
  for (const type of Object.keys(RETIER_TREATMENTS)) {
    assert.ok(!RETIER_TREATMENTS[type].includes('discard'), `${type} carries no discard cell`);
    assert.throws(() => assertTreatmentAllowed(type, 'discard'), /refused/);
  }
  assert.throws(() => assertTreatmentAllowed('never-heard-of-it', 'discard'), /refused/);
  assert.throws(() => assertTreatmentAllowed('never-heard-of-it', 'demote'), /refused/, 'unknown TYPE falls closed to skip-only');
  assert.strictEqual(assertTreatmentAllowed('never-heard-of-it', 'skip'), true);
});

test('table: classification by path+shape is fail-closed — ambiguous -> unknown -> skip-only', () => {
  assert.strictEqual(classifyRetier({ path: null }), 'unknown');
  assert.strictEqual(classifyRetier({}), 'unknown');
  assert.strictEqual(classifyRetier({ path: '/x/random.md' }), 'unknown', 'a .md outside every known shape is AMBIGUOUS -> unknown');
  assert.strictEqual(classifyRetier({ path: '/p/.claude/projects/s/memory/MEMORY.md' }), 'class-b-index');
  assert.strictEqual(classifyRetier({ path: '/p/.claude/agent-memory/coder/MEMORY.md' }), 'class-b-index');
  assert.strictEqual(classifyRetier({ path: '/p/.claude/agent-memory/coder/topic.md' }), 'class-b-topic');
  assert.strictEqual(classifyRetier({ path: '/p/CLAUDE.md' }), 'governance');
  assert.strictEqual(classifyRetier({ path: '/p/.claude/rules/x.md' }), 'governance');
  assert.strictEqual(classifyRetier({ path: '/p/state.json' }), 'machine-parsed');
  assert.strictEqual(classifyRetier({ path: '/p/skills/x/SKILL.md' }), 'machine-parsed', 'program markdown = machine-parsed');
  assert.strictEqual(classifyRetier({ path: '/h/.claude/projects/s/abc.jsonl' }), 'vendor-artifact');
  assert.strictEqual(classifyRetier({ path: '/h/.claude/projects/s/x/tool-results/r.txt' }), 'vendor-artifact');
  // discovery kind wins when present
  assert.strictEqual(classifyRetier({ path: '/anything', kind: 'memory-index' }), 'class-b-index');
  assert.strictEqual(classifyRetier({ path: '/anything', kind: 'governance' }), 'governance');
});

test('table: machine-parsed + vendor artifacts in a store dir are reported skip/ultra-bands and NEVER touched by a run', () => {
  const { home, proj } = sandbox();
  try {
    seedMainStore(home, proj);
    const statePath = path.join(memDir(home, proj), 'state.json');
    const jsonlPath = path.join(memDir(home, proj), 'trace.jsonl');
    const stateOrig = fs.readFileSync(statePath, 'utf8');
    const jsonlOrig = fs.readFileSync(jsonlPath, 'utf8');
    const scan = retierScan({ projectRoot: proj, home, retier: R });
    const items = scan.stores[0].items;
    const state = items.find((i) => i.path === statePath);
    const jsonl = items.find((i) => i.path === jsonlPath);
    assert.strictEqual(state.type, 'machine-parsed');
    assert.strictEqual(state.treatment, 'skip');
    assert.strictEqual(jsonl.type, 'vendor-artifact');
    assert.strictEqual(jsonl.treatment, 'ultra-bands', "vendor's only lever = ULTRA's own bands (delegation, not a RE-TIER move)");
    const res = runRetier({ projectRoot: proj, home, retier: R, estate: estateCfg(home) });
    assert.strictEqual(res.ok, true, runRetierReport(res));
    assert.strictEqual(fs.readFileSync(statePath, 'utf8'), stateOrig, 'machine-parsed byte-identical after the run');
    assert.strictEqual(fs.readFileSync(jsonlPath, 'utf8'), jsonlOrig, 'vendor artifact byte-identical after the run');
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// 2b. WEAR-CAMPAIGN ROUND 1 regression traps (#2 classify · #3 index-off strand · #4 pin)
// ---------------------------------------------------------------------------

test('#2: governance/program .md in a store dir is classified skip-only (NAME/PATH identity beats the memory-dir catch-all) and is NEVER demoted; a genuine topic still demotes', () => {
  const { home, proj } = sandbox();
  const now = Date.now();
  try {
    const dir = seedMainStore(home, proj); // over-arm index + zeta-old.md (unreferenced, demotable)
    // governance/program files sitting IN the memory dir, all UNREFERENCED — the
    // old topic loop hardcoded class-b-topic, so these demoted off the live tree.
    write(path.join(dir, 'CLAUDE.md'), 'CLAUDE governance body — not a memory topic\n');
    write(path.join(dir, 'AGENTS.md'), 'AGENTS governance body — not a memory topic\n');
    write(path.join(dir, 'SKILL.md'), 'SKILL program body — not a memory topic\n');
    // classification is NAME/PATH-driven, not directory-driven (the root fix)
    assert.strictEqual(classifyRetier({ path: path.join(dir, 'CLAUDE.md') }), 'governance');
    assert.strictEqual(classifyRetier({ path: path.join(dir, 'AGENTS.md') }), 'governance');
    assert.strictEqual(classifyRetier({ path: path.join(dir, 'SKILL.md') }), 'machine-parsed');
    assert.strictEqual(classifyRetier({ path: path.join(dir, 'zeta-old.md') }), 'class-b-topic', 'a genuine topic stays class-b-topic');
    assert.strictEqual(classifyRetier({ path: path.join(dir, 'MEMORY.md') }), 'class-b-index', 'the index itself is unchanged (regression guard)');
  // round-2 Finding A: NAME identity is CASE-INSENSITIVE (Windows/macOS ship platforms) — a
  // mis-cased or cross-agent governance name must NOT slip past to class-b-topic.
  assert.strictEqual(classifyRetier({ path: path.join(dir, 'claude.md') }), 'governance', 'lowercase claude.md = governance');
  assert.strictEqual(classifyRetier({ path: path.join(dir, 'Agents.md') }), 'governance', 'mixed-case Agents.md = governance');
  assert.strictEqual(classifyRetier({ path: path.join(dir, 'GEMINI.md') }), 'governance', 'cross-agent GEMINI.md = governance');
  assert.strictEqual(classifyRetier({ path: path.join(dir, 'Skill.md') }), 'machine-parsed', 'mixed-case Skill.md = machine-parsed');

    const res = runRetier({ projectRoot: proj, home, retier: R, estate: estateCfg(home), now });
    assert.strictEqual(res.ok, true, runRetierReport(res));
    for (const g of ['CLAUDE.md', 'AGENTS.md', 'SKILL.md']) {
      assert.ok(fs.existsSync(path.join(dir, g)), `${g} stays in the live tree (skip-only, never demoted)`);
    }
    assert.ok(!fs.existsSync(path.join(dir, 'zeta-old.md')), 'the genuine unreferenced topic still demotes as before');
    // the scan report carries the HONEST type + skip treatment (no longer a hardcoded class-b-topic)
    const item = retierScan({ projectRoot: proj, home, retier: R }).stores[0].items.find((i) => path.basename(i.path) === 'CLAUDE.md');
    assert.strictEqual(item.type, 'governance');
    assert.strictEqual(item.treatment, 'skip');
  } finally { clean(home, proj); }
});

test('#3: indexEnabled:false — a demotion that is the SOLE live home of a top-anchor is DROPPED (topic kept live so the anchor stays reachable); indexEnabled:true archives + persists it for real', () => {
  const { home, proj } = sandbox();
  const now = Date.now();
  try {
    const dir = memDir(home, proj);
    // zeta-old.md is UNREFERENCED and the ONLY home of a heavily-repeated anchor
    // [[zeta-secret]] — a top anchor that lives nowhere else in the tree.
    const zetaBody = '# zeta\n\n' + Array(25).fill('- [[zeta-secret]] a unique anchor that lives ONLY in this topic').join('\n') + '\n';
    const seed = () => {
      write(path.join(dir, 'MEMORY.md'), bigIndex());
      write(path.join(dir, 'alpha-topic.md'), 'ALPHA-KEEP referenced\n');
      write(path.join(dir, 'zeta-old.md'), zetaBody);
    };

    // index OFF -> the dig row would NOT persist, so demoting zeta would strand
    // [[zeta-secret]] (unreachable). The guard KEEPS zeta live; the run still
    // succeeds (index lines demote) and the anchor stays in the tree.
    seed();
    const off = runRetier({ projectRoot: proj, home, retier: R, estate: estateCfg(home, { indexEnabled: false }), now });
    assert.strictEqual(off.ok, true, runRetierReport(off));
    assert.ok(fs.existsSync(path.join(dir, 'zeta-old.md')), 'sole-anchor-home topic kept live when it cannot be indexed');
    assert.ok(fs.readFileSync(path.join(dir, 'zeta-old.md'), 'utf8').includes('[[zeta-secret]]'), 'the top anchor stays reachable in the live tree');
    assert.ok(off.kept.some((k) => k.path.endsWith('zeta-old.md') && /indexEnabled off/.test(k.reason)), 'the keep is recorded with the #3 reason');

    // index ON (fresh store) -> zeta archives for real and the anchor is persisted.
    clean(dir); seed();
    const on = runRetier({ projectRoot: proj, home, retier: R, estate: estateCfg(home, { indexEnabled: true }), now: now + 1 });
    assert.strictEqual(on.ok, true, runRetierReport(on));
    assert.ok(!fs.existsSync(path.join(dir, 'zeta-old.md')), 'with the index ON the topic archives for real');
    const idxText = fs.readFileSync(path.join(estateCfg(home).archiveDir, ESTATE_INDEX_NAME), 'utf8');
    assert.ok(idxText.includes('zeta-secret'), 'the anchor is persisted in the dig index (search-reachable)');
  } finally { clean(home, proj); }
});

test('#4: a PINNED demote-candidate protects itself WITHOUT vetoing the rest of the multi-store plan (applyPlan\'s pin guard would abort the whole run)', () => {
  const { home, proj } = sandbox();
  const now = Date.now();
  try {
    const mainDir = seedMainStore(home, proj); // over-arm index + zeta-old.md (demotable)
    write(path.join(mainDir, 'pinned-topic.md'), '---\npinned: true\n---\nPINNED unreferenced body — must never be demoted.\n');
    // a SECOND over-arm store with its own demotable topic
    const agentDir = path.join(proj, '.claude', 'agent-memory', 'coder');
    write(path.join(agentDir, 'MEMORY.md'), bigIndex());
    write(path.join(agentDir, 'coder-orphan.md'), 'CODER-ORPHAN unreferenced body\n');

    const res = runRetier({ projectRoot: proj, home, retier: R, estate: estateCfg(home), now });
    assert.strictEqual(res.ok, true, `the pin must not abort the whole run: ${runRetierReport(res)}`);
    assert.ok(fs.existsSync(path.join(mainDir, 'pinned-topic.md')), 'the pinned topic protects itself (never a demote candidate)');
    assert.ok(!fs.existsSync(path.join(mainDir, 'zeta-old.md')), 'the main store\'s normal topic still demotes');
    assert.ok(!fs.existsSync(path.join(agentDir, 'coder-orphan.md')), 'the OTHER store\'s demotion is NOT vetoed by the pin');
  } finally { clean(home, proj); }
});

test('#4: a PINNED index skips hop-1 line demotion (index left byte-identical, no overflow) but does not block the store\'s topic demotions', () => {
  const { home, proj } = sandbox();
  const now = Date.now();
  try {
    const dir = memDir(home, proj);
    write(path.join(dir, 'MEMORY.md'), '---\npinned: true\n---\n' + bigIndex()); // pinned + over-arm
    write(path.join(dir, 'alpha-topic.md'), 'ALPHA referenced\n');
    write(path.join(dir, 'zeta-old.md'), 'ZETA unreferenced\n');
    const idxOrig = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8');
    const res = runRetier({ projectRoot: proj, home, retier: R, estate: estateCfg(home), now });
    assert.strictEqual(res.ok, true, runRetierReport(res));
    assert.strictEqual(fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8'), idxOrig, 'pinned index untouched (hop-1 skipped, not-even-offered)');
    assert.ok(!fs.existsSync(path.join(dir, OVERFLOW_BASENAME)), 'no overflow created for a pinned index');
    assert.ok(!fs.existsSync(path.join(dir, 'zeta-old.md')), 'the unreferenced topic still demotes (the pin protects only itself)');
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// 3. THE COMBINATION — the wear-round: pressure resolves by DEMOTION only
// ---------------------------------------------------------------------------

test('combination: an over-arm store DEMOTES (lines + unreferenced topic files moved byte-identical) and NEVER summarizes/deletes — the quota-loss trap', () => {
  const { home, proj } = sandbox();
  const now = Date.now();
  try {
    const dir = seedMainStore(home, proj);
    const indexOrig = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8');
    const zetaOrig = fs.readFileSync(path.join(dir, 'zeta-old.md'), 'utf8');
    const alphaOrig = fs.readFileSync(path.join(dir, 'alpha-topic.md'), 'utf8');
    // a second (agent) store UNDER arm — must stay untouched (per-store envelope)
    const agentIdx = path.join(proj, '.claude', 'agent-memory', 'coder', 'MEMORY.md');
    write(agentIdx, '# Memory — coder\n\n- one small line\n');

    const estate = estateCfg(home);
    const res = runRetier({ projectRoot: proj, home, retier: R, estate, now });
    assert.strictEqual(res.ok, true, runRetierReport(res));

    // hop-1: index lines moved BYTE-IDENTICAL to the overflow topic file
    const indexNew = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8');
    const overflow = fs.readFileSync(path.join(dir, OVERFLOW_BASENAME), 'utf8');
    const env = envelopeFor(R);
    assert.ok(tokensEst(indexNew) <= env.fillCeiling, 'index filled only to target - headroom');
    assert.ok(indexNew.includes(`](${OVERFLOW_BASENAME})`), 'index keeps a pointer to the overflow (reachable by normal recall)');
    for (const line of indexOrig.split('\n')) {
      if (!line.trim()) continue;
      assert.ok(indexNew.includes(line) || overflow.includes(line), `original line survives VERBATIM somewhere (never summarized): ${line.slice(0, 60)}`);
    }
    // hop-2: the unreferenced topic FILE moved to the archive tier, content byte-identical
    const slug = ccProjectSlug(proj);
    const gz = path.join(estate.archiveDir, slug, `retier-${now}-0.zeta-old.md.gz`);
    assert.ok(fs.existsSync(gz), 'unreferenced topic archived');
    assert.strictEqual(zlib.gunzipSync(fs.readFileSync(gz)).toString('utf8'), zetaOrig, 'archived content BYTE-IDENTICAL');
    assert.ok(!fs.existsSync(path.join(dir, 'zeta-old.md')), 'demoted topic left the topic tier (moved, not copied)');
    // reachable back: the dig row + estate-restore round-trip
    const idx = fs.readFileSync(path.join(estate.archiveDir, ESTATE_INDEX_NAME), 'utf8');
    assert.ok(idx.includes('zeta-old.md') && idx.includes(`retier-${now}-0`), 'dig-index row appended (estate-search reachable)');
    const restored = restoreSession(`retier-${now}-0`, { archiveDir: estate.archiveDir });
    assert.strictEqual(restored.ok, true);
    assert.strictEqual(fs.readFileSync(path.join(restored.dir, restored.files[0].rel), 'utf8'), zetaOrig, 'estate-restore round-trips byte-exact');
    clean(restored.dir);
    // referenced topic + the under-arm agent store: untouched
    assert.strictEqual(fs.readFileSync(path.join(dir, 'alpha-topic.md'), 'utf8'), alphaOrig, 'referenced topic stays');
    assert.strictEqual(fs.readFileSync(agentIdx, 'utf8'), '# Memory — coder\n\n- one small line\n', 'under-arm store untouched');
    // hysteresis integration: the washed store sits at/below the fill line -> a second run does not re-trigger
    const again = runRetier({ projectRoot: proj, home, retier: R, estate, now: now + 1 });
    assert.strictEqual(again.refused, true, 'no re-trigger after a completed pass (no-flap)');
  } finally { clean(home, proj); }
});

test('combination: mid-pass failure (external writer during apply) -> WHOLE-RUN rollback, every mutated file restored byte-identical, stray archives cleaned', () => {
  const { home, proj } = sandbox();
  const now = Date.now();
  try {
    const dir = seedMainStore(home, proj);
    const indexOrig = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8');
    const zetaPath = path.join(dir, 'zeta-old.md');
    const estate = estateCfg(home);
    // A foreign writer lands mid-run, ridden into place by the BLESSED `gzip`
    // benign-injectable (it fires in the gz-write loop, BEFORE applyPlan's delete
    // step — the same window a co-writer / cloud-sync hits). No production seam:
    // the archive still holds the pre-foreign bytes (buf is captured in memory);
    // only the on-disk topic changes, tripping applyPlan's external-writer guard.
    let foreign = false;
    const gzipForeignWriter = (buf) => {
      if (!foreign) { fs.appendFileSync(zetaPath, 'FOREIGN-WRITER\n'); foreign = true; }
      return zlib.gzipSync(buf);
    };
    const res = runRetier({ projectRoot: proj, home, retier: R, estate, now, gzip: gzipForeignWriter });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.rolledBack, true, `whole-run rollback (got: ${res.error})`);
    assert.match(res.error || '', /external writer/);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8'), indexOrig, 'index restored BYTE-IDENTICAL');
    assert.ok(!fs.existsSync(path.join(dir, OVERFLOW_BASENAME)), 'created overflow removed by the rollback');
    assert.ok(fs.existsSync(zetaPath), 'the delete never landed');
    const slugDir = path.join(estate.archiveDir, ccProjectSlug(proj));
    const gzLeft = fs.existsSync(slugDir) ? fs.readdirSync(slugDir).filter((n) => n.endsWith('.gz')) : [];
    assert.deepStrictEqual(gzLeft, [], 'this run\'s stray .gz cleaned on failure');
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// 4. GATE WIRING — fidelity gate, top-anchor probe + rollback, #55 reconcile
// ---------------------------------------------------------------------------

// MOVE-VERIFY's block on a real lossy plan + the top-anchor probe's miss
// detection are proven directly on the exported functions (moveVerify /
// probeAnchors — see "helpers + rails" below). The two former runRetier
// fault-injection tests were RETIRED with the production `tamperForTests` seam
// (a corruption hook must not ship in an engine that moves real bytes), and
// their faults can't be produced with real data anyway: demotion moves whole
// lines verbatim by construction, and the strand-guard protects sole-home
// anchors — only a bug (or a seam) could corrupt indexNew / lose an anchor
// post-apply. What the post-apply test uniquely exercised — the rollback
// wrapper — is unit-tested here (external-writer rollback stays covered by the
// gzip-injected test above):
test('gate wiring: rollbackFromSnapshot restores every manifest original byte-exact + removes this run\'s created files (the probe-miss undo path)', () => {
  const { home, proj } = sandbox();
  try {
    const snapDir = path.join(proj, 'snap');
    fs.mkdirSync(snapDir, { recursive: true });
    const orig1 = path.join(proj, 'a.md');
    write(orig1, 'PRISTINE-A');
    fs.writeFileSync(path.join(snapDir, 'f0'), 'PRISTINE-A'); // the verified backup
    fs.writeFileSync(path.join(snapDir, 'manifest.json'), JSON.stringify([{ snap: 'f0', original: orig1 }]));
    const created = path.join(proj, 'created-overflow.md');
    write(created, 'an overflow this run created');
    fs.writeFileSync(orig1, 'VANDALIZED-AFTER-COMMIT'); // the committed tree lost the anchor
    const failed = rollbackFromSnapshot(snapDir, [created], [proj]); // trusted roots = the project store tree
    assert.strictEqual(failed, 0, 'clean rollback (0 restore failures)');
    assert.strictEqual(fs.readFileSync(orig1, 'utf8'), 'PRISTINE-A', 'original restored byte-exact');
    assert.strictEqual(fs.existsSync(created), false, 'this run\'s created file removed');
    assert.strictEqual(rollbackFromSnapshot(path.join(proj, 'no-such-snap'), [], [proj]), -1, 'an unreadable manifest -> -1 (fail-loud sentinel)');
  } finally { clean(home, proj); }
});

test('H1: rollbackFromSnapshot REFUSES a manifest original OUTSIDE the trusted roots (poisoned-manifest close)', () => {
  const { home, proj } = sandbox();
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwrt-victim-')));
  try {
    const victim = path.join(outside, 'victim.md');
    write(victim, 'PRISTINE-OUTSIDE');
    const snapDir = path.join(proj, 'snap');
    fs.mkdirSync(snapDir, { recursive: true });
    fs.writeFileSync(path.join(snapDir, 'f0'), 'ATTACKER PAYLOAD');
    fs.writeFileSync(path.join(snapDir, 'manifest.json'), JSON.stringify([{ snap: 'f0', original: victim }]));
    const failed = rollbackFromSnapshot(snapDir, [], [proj]); // trusted roots = the project store tree only
    assert.ok(failed >= 1, 'an out-of-root target is counted as a refusal, never silently written');
    assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'PRISTINE-OUTSIDE', 'the outside file must be UNTOUCHED');
  } finally { clean(home, proj, outside); }
});

test('H1: rollbackFromSnapshot restores a DELETED original (non-existent target) via parent-resolved containment (do not over-block)', () => {
  const { home, proj } = sandbox();
  try {
    const store = path.join(proj, 'memory'); fs.mkdirSync(store, { recursive: true });
    const snapDir = path.join(proj, 'snap2'); fs.mkdirSync(snapDir, { recursive: true });
    const gone = path.join(store, 'demoted-topic.md'); // a committed DELETE being undone — the file is GONE
    fs.writeFileSync(path.join(snapDir, 'f0'), 'PRISTINE-TOPIC');
    fs.writeFileSync(path.join(snapDir, 'manifest.json'), JSON.stringify([{ snap: 'f0', original: gone }]));
    assert.strictEqual(fs.existsSync(gone), false, 'precondition: the restore target does not exist yet');
    const failed = rollbackFromSnapshot(snapDir, [], [proj]);
    assert.strictEqual(failed, 0, 'a deleted original still restores (its parent resolves inside the trusted root)');
    assert.strictEqual(fs.readFileSync(gone, 'utf8'), 'PRISTINE-TOPIC');
  } finally { clean(home, proj); }
});

test('gate wiring: #55 reconcile flags a planted cross-store version contradiction in the REPORT (no auto-fix, scan mutates nothing)', () => {
  const { home, proj } = sandbox();
  try {
    const dir = seedMainStore(home, proj, { index: '# Memory index\n\n- small\n' });
    write(path.join(dir, 'widget-status.md'), 'CoalWidget v1.2.0 is LIVE and verified.\n');
    const agentTopic = path.join(proj, '.claude', 'agent-memory', 'coder', 'widget-note.md');
    write(path.join(proj, '.claude', 'agent-memory', 'coder', 'MEMORY.md'), '# Memory — coder\n\n- [widget](widget-note.md) — note\n');
    write(agentTopic, 'CoalWidget v2.0.0 shipped; the old claim is closed.\n');
    const before = fs.readdirSync(dir).sort();
    const scan = retierScan({ projectRoot: proj, home, retier: R });
    const flag = scan.flags.find((f) => f.key === 'version:coalwidget');
    assert.ok(flag, `cross-store contradiction flagged (got: ${JSON.stringify(scan.flags.map((f) => f.key))})`);
    const values = new Set(flag.claims.map((c) => c.value));
    assert.ok(values.has('1.2.0') && values.has('2.0.0'), 'both incompatible claims named');
    const stores = new Set(flag.claims.map((c) => c.store));
    assert.ok(stores.size >= 2, 'claims come from DIFFERENT stores');
    assert.ok(retierScanLines(scan).includes('#55 cross-store contradiction [version:coalwidget]'), 'the report line carries the flag');
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), before, 'scan is report-only — nothing created/removed');
  } finally { clean(home, proj); }
});

test('gate wiring: run respects the GLOBAL lock — held elsewhere -> deferred:true, nothing touched', () => {
  const { home, proj } = sandbox();
  try {
    const dir = seedMainStore(home, proj);
    const indexOrig = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8');
    const lock = acquireLock(globalLockPath(home), { sessionId: 'other-session' });
    assert.ok(lock.acquired);
    try {
      const res = runRetier({ projectRoot: proj, home, retier: R, estate: estateCfg(home) });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.deferred, true);
      assert.strictEqual(fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8'), indexOrig);
      assert.ok(!fs.existsSync(path.join(dir, OVERFLOW_BASENAME)));
    } finally { lock.release(); }
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// helpers + rails
// ---------------------------------------------------------------------------

test('helpers: topAnchors counts most-referenced wikilinks/versions/codespans; probeAnchors reports only true misses', () => {
  const anchors = topAnchors(['[[a]] [[a]] [[a]] `cmd-x` v1.2.3', '[[a]] `cmd-x` v1.2.3 [[b]]'], 3);
  assert.strictEqual(anchors[0].token, 'a');
  assert.strictEqual(anchors[0].count, 4);
  assert.deepStrictEqual(probeAnchors(anchors, ['[[a]] `cmd-x` v1.2.3 [[b]] everything survives']), []);
  const misses = probeAnchors(anchors, ['only [[a]] survives']);
  assert.ok(misses.length >= 1 && misses.every((m) => m.token !== 'a'));
});

test('helpers: moveVerify passes a verbatim move and fails a lossy one; unreferencedTopics keeps anything referenced (safe direction)', () => {
  const orig = '# I\n\n- [[keep-me]] line one `tok-1`\n- [[move-me]] line two `tok-2`\n';
  const indexNew = '# I\n\n- [[keep-me]] line one `tok-1`\n';
  const moved = ['- [[move-me]] line two `tok-2`'];
  assert.strictEqual(moveVerify({ origIndex: orig, indexNew, overflowText: moved.join('\n') + '\n', movedLines: moved }).ok, true);
  const lossy = moveVerify({ origIndex: orig, indexNew, overflowText: 'nothing here\n', movedLines: moved });
  assert.strictEqual(lossy.ok, false);
  assert.ok(lossy.missing.length === 1);
  const store = {
    topics: [
      { path: '/s/ref.md', basename: 'ref.md', text: 'plain', mtimeMs: 1 },
      { path: '/s/orphan-zzz.md', basename: 'orphan-zzz.md', text: 'plain', mtimeMs: 2 },
    ],
  };
  const all = 'the index mentions (ref.md) but never the other\nplain\nplain';
  assert.deepStrictEqual(unreferencedTopics(store, all).map((t) => t.basename), ['orphan-zzz.md']);
});

test('platform gate (armor #2): a non-Claude-Code home → retierScan refuses + runRetier no-ops (conservative flag); with ~/.claude the gate keys CC — detectPlatform, not a hardcode', () => {
  const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwrt-npproj-')));
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwrt-nphome-'))); // NO ~/.claude
  try {
    const scan = retierScan({ projectRoot: proj, home, retier: R });
    assert.strictEqual(scan.platform, 'unknown');
    assert.match(scan.verdict, /never auto-delete/, 'the verbatim conservative flag rides the verdict');
    assert.deepStrictEqual(scan.stores, [], 'no CC memory layout scanned');
    const run = runRetier({ projectRoot: proj, home, retier: R });
    assert.strictEqual(run.refused, true, 'a no-op is RE-TIER\'s own refusal shape, nothing touched');
    assert.strictEqual(run.platform, 'unknown');

    // flip: ~/.claude present → the gate keys CC (an over-arm store is scanned).
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    write(path.join(memDir(home, proj), 'MEMORY.md'), bigIndex());
    const scan2 = retierScan({ projectRoot: proj, home, retier: R });
    assert.notStrictEqual(scan2.platform, 'unknown', 'a CC home is no longer gated');
    assert.strictEqual(scan2.overArm, 1, 'the over-arm store is scanned on the CC path');
  } finally { clean(home, proj); }
});

test('rail: RE-TIER is wizard-only — no hook wires it (grep hooks/ for retier = 0)', () => {
  const hooksDir = path.join(repoDir, 'hooks');
  // Single directory read carries the file-type (no separate statSync — closes
  // the check-then-use TOCTOU CodeQL js/file-system-race flagged).
  for (const d of fs.readdirSync(hooksDir, { withFileTypes: true })) {
    if (!d.isFile()) continue;
    const content = fs.readFileSync(path.join(hooksDir, d.name), 'utf8').toLowerCase();
    assert.ok(!content.includes('retier'), `hooks/${d.name} must not reference retier (run-gate law)`);
  }
});

test('cli: retier-scan is report-only and prints the bill; retier-run refuses loud (exit 1) on a lean store', () => {
  const { home, proj } = sandbox();
  try {
    fs.writeFileSync(path.join(proj, '.coalwash.json'), '{}');
    write(path.join(memDir(home, proj), 'MEMORY.md'), '# Memory index\n\n- one small line\n');
    const env = { ...process.env, HOME: home, USERPROFILE: home, TEMP: home, TMP: home, CLAUDE_CONFIG_DIR: '' };
    const scan = spawnSync(process.execPath, [CLI, 'retier-scan'], { cwd: proj, env, encoding: 'utf8', timeout: 20000 });
    assert.strictEqual(scan.status, 0, scan.stderr);
    assert.ok(scan.stdout.includes('[CoalWash] RE-TIER scan'), scan.stdout);
    assert.ok(scan.stdout.includes('target ~4125') && scan.stdout.includes('arm ~4950'), 'the bill names the envelope');
    const run = spawnSync(process.execPath, [CLI, 'retier-run'], { cwd: proj, env, encoding: 'utf8', timeout: 20000 });
    assert.strictEqual(run.status, 1, 'refusal is loud');
    assert.ok(run.stdout.includes('RE-TIER refused') && run.stdout.includes('dead zone, no action'), run.stdout);
  } finally { clean(home, proj); }
});

test('claims: extractClaims derives version + status subjects deterministically', () => {
  const claims = extractClaims('CoalWidget v1.2.0 is LIVE.\n[[coalhearth]] journal wired since v1.3.0.\n', 'f.md', 'main');
  assert.ok(claims.some((c) => c.kind === 'version' && c.subject === 'coalwidget' && c.value === '1.2.0'));
  assert.ok(claims.some((c) => c.kind === 'status' && c.subject === 'coalwidget' && c.value === 'live'));
  assert.ok(claims.some((c) => c.kind === 'status' && c.subject === 'coalhearth' && c.value === 'wired'));
  // one store repeating versions (its own history) is NOT a cross-store contradiction
  const one = reconcileClaims([{ label: 'main', indexPath: '/m/MEMORY.md', indexText: 'X v1.0.0 then X v2.0.0', topics: [] }]);
  assert.deepStrictEqual(one, []);
});

test('#57 write-side containment on the RE-TIER archive hop: a slug dir symlinked outside the archive root is refused — topic KEPT in the live tree, escape reported, nothing written through the link', () => {
  const { home, proj } = sandbox();
  try {
    const dir = seedMainStore(home, proj);
    const archiveDir = path.join(home, 'archive');
    const outside = path.join(home, 'outside-target');
    fs.mkdirSync(outside, { recursive: true });
    fs.mkdirSync(archiveDir, { recursive: true });
    // junction = the unprivileged Windows shim; POSIX ignores the type arg.
    fs.symlinkSync(outside, path.join(archiveDir, ccProjectSlug(proj)), 'junction');
    const res = runRetier({ projectRoot: proj, home, retier: R, estate: estateCfg(home) });
    assert.strictEqual(res.ok, true, res.error || res.reason); // hop-1 index demotion still lands
    assert.ok(fs.existsSync(path.join(dir, 'zeta-old.md')), 'the demote candidate stays in the live tree (fail-closed)');
    assert.ok(res.kept.some((k) => /escapes the archive root/.test(k.reason)), `escape reported via kept (got ${JSON.stringify(res.kept)})`);
    assert.deepStrictEqual(fs.readdirSync(outside), [], 'nothing written through the link');
    assert.ok(runRetierReport(res).includes('escapes the archive root'), 'the report surfaces the KEPT line');
  } finally { clean(home, proj); }
});
