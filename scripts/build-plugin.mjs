#!/usr/bin/env node
// CoalWash dist build — assemble a CLEAN `plugin/` from source so the Claude
// Code marketplace serves ONLY the plugin (manifest + bin + hooks + the engine
// under scripts/lib), never the repo's gate scripts, docs, or design files.
// Mirrors the CoalHearth build-plugin shape; marketplace.json `source` points
// at ./plugin. Run after editing bin/hooks/scripts-lib/plugin.json — verify.mjs
// FAILs on drift. Node built-ins only.
//
// Named divergence from the hook-only siblings (one-flock rule: name it where
// it lives): CoalWash ships `scripts/lib/` in the dist because the ENGINE is
// cross-agent scripts (blueprint §7b code-core — any agent runs `node
// scripts/lib/... `), and the bin/ conductor imports the same modules so hook
// and engine can never diverge. Tests are filtered out of the dist.

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

export function buildDist(distRoot = dist) {
  fs.rmSync(distRoot, { recursive: true, force: true });
  for (const rel of DIST_ITEMS) {
    const src = path.join(repo, rel);
    const dst = path.join(distRoot, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(src, dst, { recursive: true, filter: (s) => !isTest(s) }); // recursive always; EXCLUDE *.test.* — dev-only tests never ship (clean-clone)
  }
}

// Every source file under DIST_ITEMS must exist in distRoot AND match
// byte-for-byte, distRoot must hold nothing under those items without a source
// (orphan), and no top-level entry may exist that no DIST_ITEM accounts for.
// Returns [] when in sync.
export function checkDist(distRoot = dist) {
  const out = [];
  const filesUnder = (root, rel) => {
    if (isTest(rel)) return []; // excluded from the dist -> excluded here too, both directions
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
