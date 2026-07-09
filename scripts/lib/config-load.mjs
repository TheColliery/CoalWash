// CoalWash config path resolution — the flock-canonical cascade (global
// ~/.claude/.coalwash.json overlaid by the nearest project .coalwash.json).
// The project walk STOPS AT HOME (an upward config search that doesn't stop at
// home once escaped a HOME-overridden test sandbox into the real global config)
// and compares PHYSICAL paths on both sides (macOS /var -> /private/var symlink:
// a lexical `dir === home` never matches and the walk escapes above home).
//
// Pure + node built-ins only (fs, path, os).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseJsonc } from './jsonc.mjs';

export function claudeBaseDir(home = os.homedir()) {
  const c = process.env.CLAUDE_CONFIG_DIR;
  return (c && c.split(',')[0].trim()) || path.join(home, '.claude');
}
export function globalConfigPath(home = os.homedir()) {
  return path.join(claudeBaseDir(home), '.coalwash.json');
}

// realpath a dir to its PHYSICAL path, falling back to a lexical resolve if
// realpath throws (an absent dir has no realpath). Fail-open is correct here —
// this feeds a read-only COMPARE, not a delete (SKILL-REPO-PATTERN CI rules).
export function physicalDir(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

// Walk up from startDir looking for `.coalwash.json` or `.git` (project root
// marker); NEVER walk above `home` — stop there and fall back to startDir.
export function findProjectRoot(startDir = process.cwd(), home = os.homedir()) {
  let dir = physicalDir(startDir);
  const homeAbs = physicalDir(home);
  while (true) {
    if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, '.coalwash.json'))) return dir;
    if (dir === homeAbs) return startDir;
    const parent = path.dirname(dir);
    if (parent === dir) return startDir; // filesystem root reached
    dir = parent;
  }
}
export function projectConfigPath(cwd = process.cwd(), home = os.homedir()) {
  return path.join(findProjectRoot(cwd, home), '.coalwash.json');
}

function readJsonc(file) {
  try {
    let content = fs.readFileSync(file, 'utf8');
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
    const parsed = parseJsonc(content); // proto-pollution-guarded parse
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Safety-shaping keys merge MONOTONICALLY: a project may only move a value toward
// the SAFER end, never weaken a deliberate GLOBAL safety choice. This closes the
// trust boundary (a cloned untrusted repo's `.coalwash.json` cannot flip a user's
// global privacy/consent setting) AND preserves "shut it off per project" — off is
// the safe end, so a project may always disable. Every other key: project wins.
// Ordering index 0 = safest (least activity / no network).
const SAFER_ENUM = {
  coalwashMode: ['off', 'manual', 'auto'],
  updateMode: ['off', 'remind', 'ask', 'auto'],
};
const SAFER_TRUE = ['localOnly']; // a bool whose SAFE value is true (privacy opt-in)

export function mergeSafety(global, project) {
  const out = { ...global, ...project };
  for (const [key, order] of Object.entries(SAFER_ENUM)) {
    // Only constrain against an EXPLICIT global choice; if global uses the factory
    // default (key absent) the project is free to set anything.
    if (project[key] === undefined || global[key] === undefined) continue;
    const gi = order.indexOf(global[key]);
    const pi = order.indexOf(project[key]);
    if (gi === -1 || pi === -1) continue; // unknown value: leave the shallow-merge result
    out[key] = pi <= gi ? project[key] : global[key]; // project may not be LOUDER than global
  }
  for (const key of SAFER_TRUE) {
    if (global[key] === true) out[key] = true; // a project cannot turn OFF a global privacy opt-in
  }
  return out;
}

export function loadMergedConfig({ cwd = process.cwd(), home = os.homedir() } = {}) {
  const global = readJsonc(globalConfigPath(home));
  const project = readJsonc(projectConfigPath(cwd, home));
  return mergeSafety(global, project);
}
