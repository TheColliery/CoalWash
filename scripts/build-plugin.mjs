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

export function buildDist(distRoot = dist) {
  fs.rmSync(distRoot, { recursive: true, force: true });
  for (const rel of DIST_ITEMS) {
    const src = path.join(repo, rel);
    const dst = path.join(distRoot, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(src, dst, { recursive: true, filter: (s) => !isTest(s) && !isUnwiredEngine(path.relative(repo, s)) }); // recursive always; EXCLUDE *.test.* (dev-only, clean-clone) + the unwired class-A engine
  }
}

// Every source file under DIST_ITEMS must exist in distRoot AND match
// byte-for-byte, distRoot must hold nothing under those items without a source
// (orphan), and no top-level entry may exist that no DIST_ITEM accounts for.
// Returns [] when in sync.
export function checkDist(distRoot = dist) {
  const out = [];
  const filesUnder = (root, rel) => {
    if (isTest(rel) || isUnwiredEngine(rel)) return []; // excluded from the dist -> excluded here too, both directions
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) return [];
    if (fs.statSync(abs).isDirectory()) return fs.readdirSync(abs).flatMap((n) => filesUnder(root, path.join(rel, n)));
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
  const allowedTops = new Set(DIST_ITEMS.map((rel) => rel.split(path.sep)[0]));
  if (fs.existsSync(distRoot)) {
    for (const name of fs.readdirSync(distRoot)) {
      if (!allowedTops.has(name)) out.push(`orphan top-level in plugin/ (no DIST_ITEM): ${name}`);
    }
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
