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

// Decode raw config bytes to text, sniffing the encoding (H6). Node's default
// 'utf8' read turns a UTF-16 file (what Windows PowerShell `>` / Out-File writes
// by default) into mojibake -> JSON.parse fails -> {} -> the user's kill switch
// (`coalwashMode: off`) is silently dropped. Sniff the BOM and decode
// accordingly; a BOM-less file with a surviving NUL (the UTF-16-of-ASCII
// signature — valid JSONC never contains a NUL) re-decodes as UTF-16LE. This
// fails toward a READABLE config (the safer direction: honor the kill switch)
// rather than a silently-ignored one.
function decodeConfigText(buf) {
  if (buf.length >= 2) {
    const b0 = buf[0], b1 = buf[1];
    if (b0 === 0xff && b1 === 0xfe) return buf.toString('utf16le', 2); // UTF-16 LE BOM
    if (b0 === 0xfe && b1 === 0xff) { // UTF-16 BE BOM: byte-swap to LE, then decode
      const s = Buffer.from(buf.subarray(2));
      if (s.length % 2 === 0) s.swap16();
      return s.toString('utf16le');
    }
    if (buf.length >= 3 && b0 === 0xef && b1 === 0xbb && buf[2] === 0xbf) return buf.toString('utf8', 3); // UTF-8 BOM
  }
  // BOM-less: a NUL BYTE (0x00) never appears in valid UTF-8 JSONC but is the
  // signature of UTF-16-of-ASCII (char, NUL, char, NUL...) - re-decode as
  // UTF-16LE (ambiguous -> fail toward a readable kill switch, the safe way).
  if (buf.includes(0)) return buf.toString('utf16le');
  return buf.toString('utf8'); // no BOM, no NUL: UTF-8, the common case
}

function readJsonc(file) {
  try {
    let content = decodeConfigText(fs.readFileSync(file)); // raw bytes -> encoding-sniffed text
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1); // strip any residual BOM char
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
// Index 0 = the SAFEST end a project may never be weaker than (for coalwashMode/
// updateMode that is also the quietest; for writeGuard it is the MOST protective
// value `on`, so activity and safety point opposite ways there — the invariant
// is "project may not move PAST global toward the higher/weaker index").
const SAFER_ENUM = {
  coalwashMode: ['off', 'manual', 'auto'],
  updateMode: ['off', 'remind', 'ask', 'auto'],
  // writeGuard (the airbag): `on` is safest, `off` weakest. A cloned untrusted
  // repo may make it STRONGER but must never DISABLE the user's undo net (the
  // MED from the same audit — a project config could turn the airbag off).
  writeGuard: ['on', 'snapshot-only', 'off'],
};
const SAFER_TRUE = ['localOnly']; // a bool whose SAFE value is true (privacy opt-in)

export function mergeSafety(global, project) {
  const out = { ...global, ...project };
  for (const [key, order] of Object.entries(SAFER_ENUM)) {
    // Only constrain against an EXPLICIT global choice; if global uses the factory
    // default (key absent) the project is free to set anything.
    if (project[key] === undefined || global[key] === undefined) continue;
    // CASE-FOLD to match the schema's case-insensitive enum (config-schema.mjs
    // validates/normalizes via toLowerCase). Comparing raw case let a project
    // 'AUTO'/'Off' miss the lookup (indexOf -> -1) and fall through to the
    // shallow-merge (project wins), re-enabling a globally-off skill (H5).
    const gi = order.indexOf(String(global[key]).toLowerCase());
    const pi = order.indexOf(String(project[key]).toLowerCase());
    if (gi === -1 || pi === -1) continue; // genuinely unknown value: leave the shallow-merge result (schema clamps it downstream)
    out[key] = pi <= gi ? project[key] : global[key]; // project may not move PAST global toward the weaker end
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
