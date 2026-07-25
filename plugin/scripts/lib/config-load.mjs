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

// The ONE dir CoalWash writes to. Must agree with claudeBaseDirs() below or the dir
// the code actually writes to ends up outside the guarded set — which is exactly what
// a leading empty entry (`",X"`) used to do: `.split(',')[0]` was `''`, so this fell
// through to ~/.claude while the plural form reported only X (R3 / LOW).
export function claudeBaseDir(home = os.homedir()) {
  return claudeBaseDirs(home)[0];
}
// EVERY configured base dir, not just the first. `claudeBaseDir` returns entry[0]
// because a single write target must be unambiguous — but a SECURITY exclusion that
// covers 1 of N is incoherent: a cwd under entry[1] was still handed out as a project
// anchor and rewrote its own settings.json (blind wave R2 / TP-3). Callers deciding
// "is this path config territory?" must ask about all of them.
// ⚠️ Whether Claude Code itself honours a comma list is unverified offline; this
// code's own `.split(',')` asserts it does, so the guard matches the parse.
export function claudeBaseDirs(home = os.homedir()) {
  const c = process.env.CLAUDE_CONFIG_DIR;
  const fromEnv = (c || '').split(',').map((s) => s.trim()).filter(Boolean);
  return fromEnv.length ? fromEnv : [path.join(home, '.claude')];
}

// Same-or-nested containment on PHYSICAL paths, case-folded on win32 (realpath does
// NOT normalize case or drive-letter case on Windows). Deliberate twin of
// explode.mjs's `isContainedIn` (which documents the same win32 caveat): that module
// is the class-A engine and is EXCLUDED from the shipped dist, so importing it here
// would break the plugin. Named divergence, not drift — keep the two in step.
export function pathWithin(childPhys, basePhys) {
  if (!childPhys || !basePhys) return false; // fail-closed
  const norm = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
  const c = norm(path.resolve(childPhys));
  const b = norm(path.resolve(basePhys));
  return c === b || c.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}
// Is `p` inside ANY configured base dir, or does it CONTAIN one? Either direction
// means the path straddles config territory. Physical on both sides, fail-closed.
// A path we cannot canonicalize counts as TOUCHING — the answer a security caller
// needs is "may I trust this anchor?", and "I could not resolve it" is not a yes.
// (Returning false here would turn every refused shape back into a fail-open.)
export function touchesClaudeBase(p, home = os.homedir()) {
  const target = canonicalOrNull(p);
  if (!target) return true; // unresolvable ANCHOR: refuse
  return claudeBaseDirs(home).some((b) => {
    const base = canonicalOrNull(b);
    // An absent/unresolvable BASE is not a constraint — it cannot contain anything and
    // holds no settings.json to protect. Refusing here instead would lock out every
    // anchor on a fresh install (no ~/.claude yet). Asymmetric on purpose: the
    // unresolvable side that matters is the anchor, above.
    if (!base) return false;
    return pathWithin(target, base) || pathWithin(base, target);
  });
}
export function globalConfigPath(home = os.homedir()) {
  return path.join(claudeBaseDir(home), '.coalwash.json');
}

// THE canonicalization primitive. Every containment/security decision in the
// engine resolves through this one function, so a path-form the OS treats as an
// alias cannot make one guard disagree with another.
//
// WHY `.native` AND WHY SHAPE-REFUSAL (all measured on win32, 8.3 creation ENABLED
// = the Windows per-volume default; blind wave R3):
//   fs.realpathSync('…\CW-HOM~1\CLAUDE~1')  -> returns the 8.3 form UNEXPANDED
//   fs.realpathSync.native(same)            -> expands to the long form
//   fs.realpathSync('\\?\C:\…')             -> THROWS EISDIR (the old code then
//                                              fail-OPENed to path.resolve)
//   both variants on '\\localhost\C$\…'     -> leave the UNC form UNCOLLAPSED
// So a short-name or UNC spelling of the SAME directory compared unequal to its
// long/local spelling and walked straight through every containment guard: a
// short-name cwd rewrote settings.json and a plugin conductor.js, a UNC cwd
// rewrote settings.json, and the older home-swallow guard fell to the same trick
// (~/.ssh/authorized_keys gained a key). One primitive, one fix, every guard.
//
// FAIL CLOSED, never lexical: a form we cannot canonicalize returns null and the
// CALLER refuses. The previous `catch { return path.resolve(p) }` was the fail-open
// that made an unresolvable shape look like a clean path.
const WIN_UNC_OR_DEVICE_RE = /^[\\/]{2}/;               // \\server\share AND \\?\ / \\.\ device paths
const WIN_SHORT_8_3_RE = /(^|[\\/])[^\\/]{1,8}~\d+(\.[^\\/]{1,3})?([\\/]|$)/;
export function canonicalOrNull(p) {
  if (typeof p !== 'string' || !p) return null;
  let out;
  try { out = fs.realpathSync.native(p); } catch { return null; }
  if (process.platform !== 'win32') return out; // these shapes are win32-only; `a~1` is a legal POSIX name
  // Refuse the shapes native does NOT canonicalize. A UNC spelling of a local dir
  // stays UNC, so it can never be compared against a drive-letter root; `\\?\`
  // switches OFF Windows path normalization entirely. Neither is a form a real
  // project cwd needs, and refusing is recoverable (run from the normal path).
  if (WIN_UNC_OR_DEVICE_RE.test(p) || WIN_UNC_OR_DEVICE_RE.test(out)) return null;
  if (WIN_SHORT_8_3_RE.test(out)) return null; // an 8.3 component survived native — do not guess
  return out;
}

// LENIENT variant — NON-SECURITY USE ONLY (the findProjectRoot marker walk, which
// must keep walking over dirs that do not exist). Falls back to a lexical resolve.
// Anything making a trust decision MUST use canonicalOrNull and refuse on null.
export function physicalDir(p) {
  return canonicalOrNull(p) ?? path.resolve(p);
}

// Project-root markers, in the order a project actually declares itself.
// `CLAUDE.md` = the GOVERNANCE root — the same up-tree governance walk
// discoverClassB §2 already performs, added here because it was the missing
// third marker: a project that declares itself by governance and NOT by git
// (this series' own umbrella: CLAUDE.md/AGENTS.md/MEMORY.md, no `.git`) matched
// nothing, so the walk ran to home and fell back to the RAW startDir — a
// DIFFERENT "project root" for every SUBDIR. Field damage (2026-07-25): a
// session resumed from a subdir minted a spurious `~/.claude/projects/<slug>/`
// per subdir (the rc.3 OS-scatter class, new form) and split ONE project's BMI
// floor/crossings across those slugs.
//   `AGENTS.md` is deliberately NOT a marker: Codex reads a CHAIN of per-DIRECTORY
//   AGENTS.md files, so treating one as a root would re-create the very
//   per-subdir scatter this fixes.
// Adding a marker can only make the walk stop LOWER — a NARROWER, fail-closed
// containment anchor for apply.mjs — except in exactly the no-marker fallback
// above, where the governance root IS the correct answer.
const ROOT_MARKERS = ['.git', '.coalwash.json', 'CLAUDE.md'];

// Walk up from startDir looking for a project-root marker; NEVER walk above
// `home` — stop there and fall back to startDir.
//
// CONFIG-DIR AWARENESS HERE IS STATE HYGIENE. THE SECURITY DECISION IS NOT HERE.
// `~/.claude/CLAUDE.md` (the user's global instruction file) matches the CLAUDE.md
// marker, so without this skip a cwd under the config dir would resolve its project
// root to the config dir and CoalWash would keep per-project STATE for a directory
// that is not a project. Skipping the marker there keeps that state sane.
//
// It is NOT a security boundary, and an earlier revision of this comment WRONGLY
// claimed "the base dir is therefore NEVER a project root … walks out to the
// fail-closed startDir fallback". Running proved otherwise (blind wave R2): the two
// `return startDir` exits below hand back the RAW cwd untested, so a cwd AT the
// config dir still yields it as the anchor; and a case-variant CLAUDE_CONFIG_DIR
// slipped past the compare entirely. Both reached applyPlan and mutated a victim.
// A wrong claim in a security comment is worse than an undocumented residual — the
// next reviewer stops looking.
//
// WHAT ACTUALLY HOLDS: `applyPlan` refuses ANY anchor that touches a configured base
// dir, in either direction, case-folded, across every CLAUDE_CONFIG_DIR entry
// (`touchesClaudeBase`). That is one check at the TRUST BOUNDARY, in the opposite
// nature to this resolver — stacking more conditions in here is what R2 walked past
// twice. Do not re-add a security claim to this function.
export function findProjectRoot(startDir = process.cwd(), home = os.homedir()) {
  let dir = physicalDir(startDir);
  const homeAbs = physicalDir(home);
  const bases = claudeBaseDirs(home).map(physicalDir);
  const isBase = (d) => bases.some((b) => pathWithin(d, b) && pathWithin(b, d)); // same dir, case-folded
  while (true) {
    if (!isBase(dir) && ROOT_MARKERS.some((m) => fs.existsSync(path.join(dir, m)))) return dir;
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
