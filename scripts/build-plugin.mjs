#!/usr/bin/env node
// CoalWash dist build — assemble a CLEAN `plugin/` from source so the Claude
// Code marketplace serves ONLY the plugin (manifest + hooks + the engine
// under scripts/lib), never the repo's gate scripts, docs, or design files.
// Mirrors the CoalHearth build-plugin shape; marketplace.json `source` points
// at ./plugin. Run after editing hooks/scripts-lib/plugin.json — verify.mjs
// FAILs on drift. Node built-ins only.
//
// Named divergence from the hook-only siblings (one-flock rule: name it where
// it lives): CoalWash ships `scripts/lib/` in the dist because the ENGINE is
// cross-agent scripts (blueprint §7b code-core — any agent runs `node
// scripts/lib/... `), and the hooks/ conductor imports the same modules so hook
// and engine can never diverge. Tests are filtered out of the dist, and so is the
// UNWIRED class-A engine (see UNWIRED_ENGINE below).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(repo, 'plugin');

// EXACTLY what a Claude Code plugin loads — nothing the marketplace clone
// carries that a user does not need.
export const DIST_ITEMS = [
  path.join('.claude-plugin', 'plugin.json'),
  'commands',
  'hooks',
  'skills',
  path.join('scripts', 'lib'),
];

const isTest = (p) => /\.test\.[cm]?js$/.test(p);

// LANDED IN SOURCE, DELIBERATELY NOT SHIPPED — the class-A ULTRA at-rest reduce engine.
// explode.mjs/detonate.mjs landed on main with the class-A graduation (A1-A5), so source is the SSoT
// and the suite gates them like any other lib. But NOTHING in the shipped SKILL surface invokes them
// yet: shipping an engine no shipped code path can call would put unreachable code — and a live
// destructive reducer — in every user's plugin. So they are excluded from the build AND from both
// directions of the dist check, which is why verify.mjs PASSES with them present in scripts/lib/.
// This is a NAMED, deliberate divergence from "the dist carries all of scripts/lib", not an oversight.
// REVISIT at the class-A skill-wiring release: wire the SKILL surface, delete this block, rebuild —
// the engine then ships together with the caller that makes it reachable.
const UNWIRED_ENGINE = [
  path.join('scripts', 'lib', 'explode.mjs'),
  path.join('scripts', 'lib', 'detonate.mjs'),
];
const isUnwiredEngine = (rel) => UNWIRED_ENGINE.includes(rel);

// THE DIST WALK IS A DENYLIST, SO ANY STRAY UNDER A DIST_ITEM RIDES ALONG. A
// CoalHearth journal written by a command whose cwd happened to be scripts/lib
// left `scripts/lib/.claude/coalhearth/session_handoff.json` in the tree; the
// build copied it into plugin/ and checkDist cleared it as "has a source", so
// verify still printed "nothing leaked" (blind wave R1 / TP-6). It is gitignored,
// so a git install is safe — but the ZIP and `--plugin-dir` surfaces ship the
// directory as-is, SESSION CONTENT included. A dot-dir is never plugin payload:
// exclude it from the build AND assert its absence, the same explicit-absence
// belt UNWIRED_ENGINE uses (skipping a path in both walks is otherwise a blind
// spot). The stray FILE itself is CoalHearth's cwd-anchoring class, fixed in the
// CH room — this makes the dist immune to it and to any future stray dot-dir.
//
// Scoped BELOW the DIST_ITEM, never across it: `.claude-plugin/plugin.json` is
// itself a DIST_ITEM that legitimately starts with a dot, so a whole-path test
// silently dropped the plugin manifest from the dist — and, because the same test
// skipped it in both checkDist walks, verify still printed PASS. Caught here
// before commit; it is the identical exclusion-becomes-blind-spot shape this
// very fix exists to close, which is why `sub` is measured from the item root.
const hasStrayDotDir = (sub) => sub.split(/[\\/]/).some((seg) => seg.startsWith('.') && seg !== '.' && seg !== '..');

export function buildDist(distRoot = dist) {
  fs.rmSync(distRoot, { recursive: true, force: true });
  for (const rel of DIST_ITEMS) {
    const src = path.join(repo, rel);
    const dst = path.join(distRoot, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(src, dst, { recursive: true, filter: (s) => !isTest(s) && !isUnwiredEngine(path.relative(repo, s)) && !hasStrayDotDir(path.relative(src, s)) }); // recursive always; EXCLUDE *.test.* (dev-only, clean-clone) + the unwired class-A engine + any stray dot-dir BELOW the item
  }
}

// Every source file under DIST_ITEMS must exist in distRoot AND match
// byte-for-byte, distRoot must hold nothing under those items without a source
// (orphan), and no top-level entry may exist that no DIST_ITEM accounts for.
// Returns [] when in sync.
export function checkDist(distRoot = dist) {
  const out = [];
  const filesUnder = (root, rel, item = rel) => {
    if (isTest(rel) || isUnwiredEngine(rel) || hasStrayDotDir(path.relative(item, rel))) return []; // excluded from the dist -> excluded here too, both directions
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) return [];
    if (fs.statSync(abs).isDirectory()) return fs.readdirSync(abs).flatMap((n) => filesUnder(root, path.join(rel, n), item));
    return [rel];
  };
  for (const item of DIST_ITEMS) {
    for (const rel of filesUnder(repo, item)) {
      const d = path.join(distRoot, rel);
      if (!fs.existsSync(d)) out.push(`missing in plugin/: ${rel}`);
      else if (fs.readFileSync(path.join(repo, rel)).compare(fs.readFileSync(d)) !== 0) out.push(`stale in plugin/: ${rel}`);
    }
    for (const rel of filesUnder(distRoot, item)) {
      if (!fs.existsSync(path.join(repo, rel))) out.push(`orphan in plugin/ (no source): ${rel}`);
    }
  }
  // The exclusion above must not become a BLIND SPOT: skipping these paths in both walks means a
  // hand-copied engine file in the dist would otherwise pass unnoticed (it has a source, so the
  // orphan check clears it). Assert absence explicitly instead.
  for (const rel of UNWIRED_ENGINE) {
    if (fs.existsSync(path.join(distRoot, rel))) out.push(`unwired class-A engine present in plugin/ (must not ship until the SKILL surface wires it): ${rel}`);
  }
  // ASSERT ABSENCE OVER EXACTLY THE SET THE EXCLUSION REMOVES — no wider, no
  // NARROWER. The exclusion drops any dot-named SEGMENT, files included; the first
  // version of this assert enumerated DIRECTORIES only, so a dist-only dot-FILE
  // orphan that the pre-exclusion gate used to catch became invisible (blind wave R2
  // / TP-4). One notch short of the set is the same blind spot in miniature.
  const strayDotEntriesIn = (root, rel) => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return [];
    return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
      const r = path.join(rel, e.name);
      if (e.name.startsWith('.')) return [r];           // dot FILE or dot DIR — both excluded, both asserted
      return e.isDirectory() ? strayDotEntriesIn(root, r) : [];
    });
  };
  for (const item of DIST_ITEMS) {
    // from the item ROOT down — a DIST_ITEM that is itself dot-named is legitimate.
    for (const rel of strayDotEntriesIn(distRoot, item)) out.push(`stray dot-entry in plugin/ (never plugin payload — it rode the dist walk): ${rel}`);
  }
  // NOTHING IN THE DIST IS UNACCOUNTED FOR, AT ANY DEPTH. Three waves running, this
  // gate was blind one level away from wherever it had just been taught to look: a
  // top-level allowlist admitted `scripts`, and the per-parent check only covered
  // FILE-shaped items — so `scripts/lib` being a DIRECTORY item at depth 2 meant
  // `plugin/scripts/` itself was NEVER walked. Proven blind: `plugin/scripts/leak.mjs`,
  // `plugin/scripts/junk/deep/x.mjs`, and `plugin/scripts/.claude/coalhearth/…` — the
  // literal R1 incident file, one directory up (R3 / TP-2).
  // So state the invariant GENERALLY instead of enumerating cases: every entry in the
  // dist is either covered by a DIST_ITEM (filesUnder already byte-checks those) or an
  // ANCESTOR directory on the way to one. Anything else is an orphan, whatever its depth.
  const underItem = (rel) => DIST_ITEMS.some((it) => rel === it || rel.startsWith(it + path.sep));
  const ancestorOfItem = (rel) => DIST_ITEMS.some((it) => it.startsWith(rel + path.sep));
  const sweepUnaccounted = (rel) => {
    const abs = path.join(distRoot, rel);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? path.join(rel, e.name) : e.name;
      if (underItem(r)) continue;                                   // a DIST_ITEM's own subtree
      if (e.isDirectory() && ancestorOfItem(r)) { sweepUnaccounted(r); continue; } // on the way to one
      out.push(`orphan in plugin/ (no DIST_ITEM accounts for it): ${r}`);
    }
  };
  if (fs.existsSync(distRoot)) sweepUnaccounted('');
  // THE RULE, so a FOURTH exclusion inherits it by construction: EVERY exclusion
  // sharing the filesUnder walks owns an absence-assert over exactly what it removes.
  // UNWIRED_ENGINE had one, the dot-entry exclusion gained one, and `isTest` — the
  // third — had none, so anything named *.test.* INSIDE a DIST_ITEM was invisible in
  // both directions (sweepUnaccounted skips it too: it IS under a DIST_ITEM). Proven
  // blind for plugin/scripts/lib/pwned.test.mjs, plugin/hooks/pwned.test.js, and an
  // `x.test.mjs/` DIRECTORY — an unlimited unchecked subtree. Fourth wave for this
  // shape; adding the assert is not enough, the invariant has to be the thing stated.
  const testEntriesIn = (rel) => {
    const abs = path.join(distRoot, rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return [];
    return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
      const r = path.join(rel, e.name);
      if (isTest(e.name)) return [r];                       // file OR directory
      return e.isDirectory() ? testEntriesIn(r) : [];
    });
  };
  for (const item of DIST_ITEMS) {
    for (const rel of testEntriesIn(item)) out.push(`test artifact present in plugin/ (dev-only, never ships — clean-clone): ${rel}`);
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--check')) {
    const f = checkDist();
    if (f.length) { console.error('plugin/ dist OUT OF SYNC:\n' + f.map((x) => '  ' + x).join('\n') + '\n-> run: node scripts/build-plugin.mjs'); process.exit(1); }
    console.log('plugin/ dist in sync with source.');
  } else {
    buildDist();
    console.log('plugin/ dist built (plugin.json + commands + hooks + skills + scripts/lib) from source.');
  }
}
