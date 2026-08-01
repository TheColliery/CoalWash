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
import { CONFIG_SCHEMA } from './config-schema.mjs';

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
  // W2-5 (task #22): a RELATIVE entry resolves against process.cwd() at READ
  // time, not set time -- if cwd happens to be the project root (an ordinary
  // hook invocation), globalConfigPath collapses onto projectConfigPath and
  // mergeSafety's whole trust boundary becomes a self-compare no-op. A shape
  // refusal belongs on the INPUT (node/runtime.md's own rule): reject a
  // non-absolute entry and fall through to the fixed default below, same as
  // an absent override.
  // LOW (re-inspect 2026-07-30): bare path.isAbsolute() is NOT enough on
  // win32 -- `/repo` and `\repo` both read isAbsolute()===true yet have NO
  // drive/UNC root (path.parse().root is just "/" or "\\", length 1), so
  // they are DRIVE-RELATIVE: path.resolve() prepends whatever the CURRENT
  // drive happens to be, the exact same "depends on transient process
  // state" instability this filter exists to remove. `path.parse(p).root`
  // length > 1 on win32 requires an actual drive letter (`C:\`) or a UNC
  // share (`\\server\share\`), either of which resolves identically no
  // matter what the current drive is. POSIX has no such distinction (its
  // one-and-only root IS the stable, fully-qualified form), so this extra
  // check is win32-only -- gating it globally would wrongly reject a
  // perfectly good `/home/user/.claude` on Linux/macOS.
  const isStableAbsolute = (p) => path.isAbsolute(p) && (process.platform !== 'win32' || path.parse(p).root.length > 1);
  const fromEnv = (c || '').split(',').map((s) => s.trim()).filter(Boolean).filter(isStableAbsolute);
  return fromEnv.length ? fromEnv : [path.join(home, '.claude')];
}

// Same-or-nested containment on PHYSICAL paths, case-folded per a real probe of the
// case behaviour of the directory it's checked against — never `process.platform`
// (node/runtime.md §4: case-insensitivity is a property of the volume, not the
// platform; macOS APFS is POSIX *and* case-insensitive by default, and a Windows
// NTFS directory can be flipped case-SENSITIVE per-directory since Windows 10 1803
// with no admin rights required). See `volumeCaseFolds` below for the probe itself,
// its documented fallback direction, and its known forgeability bound.
// Deliberate twin of explode.mjs's `isContainedIn` — ⚠️ NO LONGER IN STEP: this
// primitive was converted to the real probe above; `isContainedIn` was DELIBERATELY
// NOT converted in the same change (main's scope ruling — a sweep of this pattern
// across five sites is its own reviewed unit) and still folds on
// `process.platform === 'win32'`. The two now answer differently on a genuinely
// case-sensitive Windows directory — see the KNOWN, DECLARED TWIN DRIFT note in
// `twin-pin.test.mjs` for the measured detail; that module is the class-A engine
// and is EXCLUDED from the shipped dist, so importing it here would break the
// plugin, which is also why the drift cannot be closed by importing one from the
// other.
// Both arguments MUST already be canonical (a canonicalOrNull result). That used to
// be true only because every caller happened to do it — "it happens to be called
// correctly" is the same shape that produced the R4 escape, so it is now ENFORCED
// rather than assumed: a non-canonical argument fails CLOSED instead of being
// silently lexically compared. The check is free (no syscall) and idempotent on a
// real canonical path, which is always absolute and already normalized — though
// "canonical" here is a SHAPE check, not proof the argument was realpath-derived;
// see `findProjectRoot`'s `isBase` for a caller where that distinction matters.
export function isCanonicalShape(p) {
  return typeof p === 'string' && !!p && path.isAbsolute(p) && path.resolve(p) === p;
}

// Does the directory CONTAINING `dirPhys` (its parent) fold the case of its own
// entries — i.e. would a differently-cased sibling of `dirPhys` collide with it?
// Measured, not assumed: flip the case of `dirPhys`'s own basename and stat the
// flipped spelling in that same parent; if it resolves to the SAME file (device +
// inode), the parent folds. Read-only (no write, no temp file, no cleanup race) so
// the primitive stays safe to call on a path we merely have READ access to, which
// containment checks routinely do.
// BOUND: this measures the PARENT's own setting, which is right for the
// base-vs-sibling shape `pathWithin` compares — it is NOT a claim about the whole
// volume or about a child directory nested deeper than `dirPhys` itself, since
// Windows sets case-sensitivity per directory and a deeper child could disagree
// with its own parent.
//
// CACHED PER ROOT PATH, NEVER PER DEVICE. Windows 10 1803+ sets case-sensitivity
// PER-DIRECTORY — two directories on the SAME device can disagree. A device-keyed
// cache would learn from whichever directory happened to probe first and silently
// misapply that answer to every other directory sharing the drive. Caching per
// exact `dirPhys` string keeps each root's answer correctly isolated; repeat
// callers on the SAME root (the common case — `touchesClaudeBase` re-checking one
// claudeBaseDir many times) still hit the cache.
const CASE_FOLD_CACHE = new Map();
// THE CLAIM THIS FUNCTION MAKES IS BOUNDED, NOT UNIVERSAL — read this before
// changing the round-trip check below. JS's Unicode case mapping and a volume's
// own on-disk case-fold table are DIFFERENT FUNCTIONS: they agree on the ordinary
// case (plain ASCII letters, and most single-codepoint accented letters), and they
// are KNOWN to disagree by at least two distinct, unrelated mechanisms —
//   EXPANSION:  `ß`.toUpperCase() === 'SS' (one codepoint becomes two)
//   SINGLETON/COMPATIBILITY REMAP: U+212A KELVIN SIGN, U+1E9E LATIN CAPITAL SHARP
//     S, U+212B ANGSTROM SIGN all case-map onto an ordinary letter under JS's
//     Unicode rules, which NTFS's per-codepoint upcase table does not honour —
//     the discriminator is the CODEPOINT, not the accent: plain `Å` (U+00C5)
//     folds correctly here, `Å` ANGSTROM (U+212B) does not.
// We do not own the OS's case table, cannot enumerate every place it disagrees
// with JS, and a third mechanism almost certainly exists — an absolute claim of
// completeness here is UNFALSIFIABLE in the wrong direction: it can only ever be
// proven wrong by the next codepoint, never proven right. So this function makes
// no such claim. What IS true, and checked below rather than assumed: a character
// whose flip does not round-trip back to itself through its own opposite is
// refused (treated as a probe MISS) rather than guessed at.
function flipCase(s) {
  let out = '';
  let sawCaseChar = false;
  for (const ch of s) {
    const up = ch.toUpperCase();
    const down = ch.toLowerCase();
    if (up === down) { out += ch; continue; } // no case to flip (digit, symbol, many scripts)
    // ROUND-TRIP CHECK, per character, not per whole string: `ch` must return to
    // itself by going through its OWN opposite. This is what actually catches
    // BOTH known mechanisms with one condition — an expansion changes what comes
    // back (`ß`.toLowerCase().toUpperCase() → 'SS'.toLowerCase() → 'ss' ≠ 'ß'),
    // and a singleton remap does too (KELVIN SIGN's lowercase is ordinary 'k',
    // whose uppercase is ordinary 'K', which is not the Kelvin sign) — verified
    // against the room's own ordinary-name regression set (`plain`, `Mixed123`,
    // `dot.name-x_y`, `.claude`, `ALLCAPS`) before shipping: none of them miss.
    if (!(ch === up ? down.toUpperCase() === ch : up.toLowerCase() === ch)) return null;
    sawCaseChar = true;
    out += ch === up ? down : up;
  }
  return sawCaseChar ? out : null;
}
// A probe MISS (no case-bearing character in the basename to flip, `flipCase`
// refusing an unstable character per its own bounded comment, `dirPhys` is a
// filesystem root with no parent, or the stat itself fails) falls back to the
// FOLDING answer, never the exact-match one.
//
// THAT FALLBACK IS A KNOWN, NAMED WRONG ANSWER IN ONE DIRECTION — say so plainly,
// not just "safe default": on a directory that is genuinely case-SENSITIVE, the
// true answer is `folds:false`, and MISS→fold answers `true`. That is WRONG. It is
// the correct TRADE for both callers this file ships today: of `pathWithin`'s two
// call sites below, `touchesClaudeBase` is a real trust boundary (REFUSE-polarity —
// folding MORE only ever REFUSES more, fail closed) and `findProjectRoot`'s `isBase`
// is declared non-security (state hygiene only, see its own comment). Folding LESS
// on a directory that actually folds would MISS a same-file match and fail OPEN,
// which is the direction that matters for a REFUSE caller. A future PERMIT-polarity
// caller of this exported function would need the OPPOSITE fallback, and must also
// read the forgeability note below before relying on it — this fallback choice does
// not by itself close that gap.
//
// FORGEABILITY, BOUNDED THE SAME WAY: a junction/hardlink planted by anyone who can
// write to `dirPhys`'s PARENT (no admin needed) can make the flipped spelling
// resolve to the same file, pushing the probe toward `folds:true` even on a
// genuinely case-sensitive directory — `touchesClaudeBase`'s REFUSE-polarity stays
// safe either way (forcing `folds:true` only refuses more). Forcing the OPPOSITE
// (`folds:false` on a directory that truly folds) via a plant is not possible
// through THIS mechanism, because a junction can only make a stat that would
// otherwise fail SUCCEED, never the reverse — but that is a claim about junctions,
// not a claim that `folds:false` can never arise wrongly by any means: the
// JS-vs-OS case-mapping mismatch this file already bounds above (`flipCase`'s own
// comment) is a SEPARATE, non-forgery route to exactly that wrong answer, which is
// why it is routed to MISS instead of trusted. A future PERMIT-polarity caller
// inherits both exposures and must treat the probe as untrusted input, not merely
// pick an "opposite default" — and that caller is not hypothetical in general:
// explode.mjs's `isContainedIn` (this primitive's unconverted twin, see the header
// above) documents ITSELF as "PERMIT-POLARITY ONLY" with a LIVE consumer (the
// snapshot-ref store-boundary check) that requires containment to be TRUE before
// proceeding. That twin still folds on `process.platform`, not this probe, so
// today's forgeability exposure is this function's own risk only — but it is
// exactly the shape a converted twin would inherit, which is why the divergence
// note points here.
function volumeCaseFolds(dirPhys) {
  if (CASE_FOLD_CACHE.has(dirPhys)) return CASE_FOLD_CACHE.get(dirPhys);
  let st;
  try { st = fs.statSync(dirPhys, { bigint: true }); } catch { return true; } // probe miss -> fold (REFUSE-polarity safe default, see above); NOT cached — a transient stat failure must not freeze a wrong answer for the process lifetime
  const parent = path.dirname(dirPhys);
  const flipped = parent === dirPhys ? null : flipCase(path.basename(dirPhys));
  let folds;
  if (flipped === null) {
    folds = true; // probe miss (root, or no case-bearing char) -> fold (see above)
  } else {
    try {
      const flippedSt = fs.statSync(path.join(parent, flipped), { bigint: true });
      folds = flippedSt.dev === st.dev && flippedSt.ino === st.ino;
    } catch {
      folds = false; // the flipped spelling does not resolve at all -> case-sensitive volume
    }
  }
  CASE_FOLD_CACHE.set(dirPhys, folds);
  return folds;
}
export function pathWithin(childPhys, basePhys) {
  if (!childPhys || !basePhys) return false; // fail-closed
  if (!isCanonicalShape(childPhys) || !isCanonicalShape(basePhys)) return false; // fail-closed: caller must canonicalize
  const norm = (s) => (volumeCaseFolds(basePhys) ? s.toLowerCase() : s);
  const c = norm(childPhys);
  const b = norm(basePhys);
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
    if (base) return pathWithin(target, base) || pathWithin(base, target);
    // A TWO-SIDED CONTAINMENT COMPARE HAS TWO ATTACK INPUTS. Hardening the subject
    // while letting "the reference didn't resolve" be a free pass is the same
    // false-completeness shape one axis over — and it was exploitable: a
    // CLAUDE_CONFIG_DIR spelled UNC or `\\?\` made this return false for EVERY
    // anchor, turning the whole guard into a no-op (settings.json took a
    // SessionStart command hook; a cached plugin conductor.js was rewritten).
    // So split the two meanings that were conflated:
    //   ABSENT        -> not a constraint. Nothing to contain, no settings.json to
    //                    protect; refusing would lock out every anchor on a fresh
    //                    install that has no ~/.claude yet.
    //   PRESENT but unresolvable -> REFUSE. It is real config territory wearing a
    //                    spelling we cannot compare against, i.e. exactly the case
    //                    the guard exists for.
    return pathExists(b);
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
// A SHAPE-REFUSAL BELONGS ON THE INPUT, WHERE THE AMBIGUITY LIVES — never on the
// canonicalizer's OUTPUT, where canonicalization has already resolved it away.
// The previous revision tested an 8.3 pattern against `out` and had it exactly
// backwards (measured): a REAL alias `…\A-DIRE~1` is EXPANDED by native, so the
// branch never fired on one; while `…\PROGRA~1` and `…\backup~1` — real
// directories whose LEGAL long names merely look 8.3-ish — come back unchanged and
// were REFUSED. Pure false positive, and an expensive one: it made a project at
// `…\work\backup~1\myproject` unwashable and silently switched off the writeguard
// airbag for `notes~1.md`. There is no residual 8.3 ambiguity to refuse: if the
// path exists, native resolves the alias; if it does not, native throws and we
// return null. So the check is GONE rather than moved.
const WIN_UNC_OR_DEVICE_RE = /^[\\/]{2}/; // \\server\share AND \\?\ / \\.\ device paths
export function canonicalOrNull(p) {
  if (typeof p !== 'string' || !p) return null;
  // INPUT-side shape refusal: `\\?\` switches OFF Windows path normalization, and a
  // UNC spelling of a local dir can never be compared against a drive-letter root.
  if (process.platform === 'win32' && WIN_UNC_OR_DEVICE_RE.test(p)) return null;
  let out;
  try { out = fs.realpathSync.native(p); } catch { return null; }
  // OUTPUT-side, and this one is NOT a duplicate of the input check: a mapped
  // network drive (`Z:\…`) has an ordinary input shape but native RESOLVES it to a
  // UNC form, which is again incomparable with a drive-letter root.
  if (process.platform === 'win32' && WIN_UNC_OR_DEVICE_RE.test(out)) return null;
  return out;
}

// Does the path exist at all (without following the final link)? Used to tell
// "absent" apart from "present but unresolvable" — a distinction two guards below
// depend on, and conflating them is how a fail-closed check becomes a free pass.
export function pathExists(p) {
  try { fs.lstatSync(p); return true; } catch { return false; }
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
  // "same dir, case-folded" is now TWO rules, not one: `norm` in `pathWithin`
  // keys the fold decision on its OWN `basePhys` argument, so `pathWithin(d, b)`
  // and `pathWithin(b, d)` may each fold differently, since the two calls hand
  // different anchors (b, then d) to the probe — impossible before this fix, when
  // one platform-wide rule governed both calls.
  // NOT bounded to a future edge case — `d` and `b` are NOT always `.native`-derived
  // today. `physicalDir` (both are built from it, directly or via `path.dirname`)
  // falls back to a bare lexical `path.resolve` whenever the path does not exist yet
  // — the ordinary case on a fresh install with no `~/.claude` yet (this file's own
  // `touchesClaudeBase` comment names exactly that scenario). `isCanonicalShape`
  // passes a lexical resolve too (it checks SHAPE — absolute and idempotent under
  // `path.resolve` — never that it was realpath-derived), so `pathWithin` proceeds
  // rather than refusing. State hygiene either way, not a security check — but a
  // future edit that starts trusting this comment's canonicalization claim inherits
  // a wrong assumption, so it is corrected rather than merely narrowed.
  const isBase = (d) => bases.some((b) => pathWithin(d, b) && pathWithin(b, d));
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

// W2-3 (task #22): distinguishes "no file" (a real position -- the user never
// configured this layer, so the schema default IS their stance) from "a file
// EXISTS but this process could not read/decode/parse it" (an UNKNOWN
// position). The old code returned a bare {} for both, so a corrupted GLOBAL
// file read identically to an absent one -- if the user had an explicit
// `coalwashMode: "off"` and the file later got mangled (a botched edit, a
// crash mid-write), the kill switch silently reverted to the schema default
// ("auto"), a fail-OPEN on the one channel meant to fail closed. `unreadable`
// is true only when `pathExists` confirms the file is there and reading it
// still failed; callers decide what "unknown" means for their own keys
// (mergeSafety below assumes the SAFEST stance, never the schema default).
function readJsonc(file) {
  const existed = pathExists(file);
  try {
    let content = decodeConfigText(fs.readFileSync(file)); // raw bytes -> encoding-sniffed text
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1); // strip any residual BOM char
    const parsed = parseJsonc(content); // proto-pollution-guarded parse
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { data: parsed, unreadable: false };
    return { data: {}, unreadable: existed }; // wrong shape (array/null/scalar) on an EXISTING file
  } catch {
    return { data: {}, unreadable: existed };
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

// WAVE-2 R2 (2026-07-27): a missing global is NOT "no constraint" -- it is the
// schema's declared default, which IS the user's stance until they say
// otherwise. The prior comment here ("if global uses the factory default,
// the project is free to set anything") was the bug: a cloned repo's project
// config is untrusted PRECISELY in the common case where the user never wrote
// a global config at all, and that was exactly the case with zero protection.
// This map is the schema DEFAULT per key, used as the effective global value
// whenever no real global value was set -- never a second, independently
// maintained "what's safe" table.
const SCHEMA_DEFAULT = Object.fromEntries(CONFIG_SCHEMA.map((s) => [s.key, s.def]));

// task #22 (W2-1 HIGH, blind-wave W2 batch): mergeSafety's top-level
// `{...global, ...project}` never looked INSIDE an object-typed schema key
// (`estate`, `retier`) -- a project config could set `estate.deleteCold:
// true` wholesale, defeating a global `deleteCold:false` with zero
// resistance -- the enum/bool clamps above never fire on a field one level
// deeper. SAFER_OBJECT_BOOL names the sub-keys that need the SAME
// safer-value-wins clamp (a boolean gating an outward action is an enum of
// two, hooks-safety.md §9); every OTHER sub-key of these objects stays
// plain project-wins, same discipline as every top-level non-safety key.
//
// CORRECTED (re-inspect 2026-07-30 -- the original comment here overstated
// what deleteCold gates): `estate.deleteCold` is NOT the sole gate on file
// removal in the estate tier. It gates exactly one transition -- whether a
// COLD session (older than `purgeAfterDays`) is archived-then-DELETED
// automatically, versus staying report-only for a human to run the
// first-party purge command. The WARM band (older than `compressAfterDays`,
// estate-archive.mjs's own header comment) ALREADY archives-then-removes
// the ORIGINAL file UNCONDITIONALLY -- no consent gate at all, by design,
// even under the factory default -- because it is copy-VERIFY-then-delete
// (byte-compared before the original goes) and fully restorable. That is
// the real line: `deleteCold` changes the SHAPE of consent (unlocks a class
// of automatic, not-easily-undone action that otherwise needs a human to
// run the purge command by hand); `purgeAfterDays`/`compressAfterDays` only
// move the EDGE of a mechanism that was already running, already safe, and
// already consent-free before this fix existed. Widening or narrowing that
// edge is not the same kind of escalation `estate.deleteCold` is -- which is
// why only the boolean is clamped here.
//
// `estate.purgeAfterDays` is DELIBERATELY NOT listed below (a named decline,
// not an oversight, and NOT because "deleteCold already gates it" -- that
// claim is false, per the WARM-band reasoning above). The real reason: (1)
// the action it paces (WARM's archive-then-remove-original) was never
// consent-gated to begin with, so a project shifting its boundary is not
// unlocking a new capability the way a `deleteCold` escalation would; (2) a
// SENTINEL HAZARD makes it unsafe to clamp with the ordered-list mechanism
// this file already has: `0` means "never becomes cold" (estate-archive.mjs
// resolveEstateCfg's own comment) -- the WIDEST possible WARM window, since
// nothing ever graduates out of WARM's unconditional archive-then-delete
// into COLD's report-only rest state -- yet `0` sits at the schema's
// numeric FLOOR, where an ordinary safer-index clamp would read it as the
// SAFEST value. Safety here is not monotone in the raw number (narrowest,
// safest WARM window sits NEAR `compressAfterDays`; it widens again toward
// either extreme), so SAFER_ENUM's ordered-list pattern cannot be reused
// as-is. Left as a named, flagged decline rather than force-fit a clamp
// shape that would silently mis-rank the sentinel.
const SAFER_OBJECT_BOOL = { estate: { deleteCold: false } };
const OBJECT_SCHEMA_KEYS = CONFIG_SCHEMA.filter((s) => s.type === 'object').map((s) => s.key);

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// Per-sub-key merge for ONE object-typed config key (never a wholesale
// project-replaces-the-whole-object, W2-2): a project setting even ONE
// sub-key used to discard every OTHER sub-key the user's global config had
// customized, silently clobbered to whatever the schema default fills in
// downstream. One level of recursion only -- a NESTED block a project also
// touches (e.g. `estate.digCrush`) may still wholesale-replace at that
// inner level; none of its fields are consent/spend/outward-bearing, so the
// residual is a minor correctness case, not a security one, and recursing
// further would be the over-hardening skill-authoring.md §2 warns against.
function mergeObjectKey(key, globalObj, projectObj, globalUnreadable) {
  const g = isPlainObject(globalObj) ? globalObj : {};
  const p = isPlainObject(projectObj) ? projectObj : {};
  const merged = { ...g, ...p };
  const bools = SAFER_OBJECT_BOOL[key];
  if (bools) {
    for (const [subKey, safeValue] of Object.entries(bools)) {
      // effective global stance for this sub-key: explicit value, else the
      // schema default -- UNLESS the whole global file is unreadable (W2-3),
      // in which case assume the SAFEST value, never the schema default.
      const gv = globalUnreadable ? safeValue : (g[subKey] === undefined ? safeValue : g[subKey]);
      const pv = p[subKey];
      // pv undefined -> nothing the project asked to change, effective global
      // stands. pv === safeValue -> quieten, always allowed. Anything else
      // (the escalated value, OR junk -- K1's "junk gets no say") only wins
      // if the effective global itself already holds it.
      merged[subKey] = pv === undefined ? gv : (pv === safeValue ? safeValue : gv);
    }
  }
  return merged;
}

export function mergeSafety(global, project, { globalUnreadable = false } = {}) {
  const out = { ...global, ...project };
  for (const key of OBJECT_SCHEMA_KEYS) {
    if (global[key] !== undefined || project[key] !== undefined) {
      out[key] = mergeObjectKey(key, global[key], project[key], globalUnreadable);
    }
  }
  for (const [key, order] of Object.entries(SAFER_ENUM)) {
    // W2-3: the whole global file was unreadable -- the user's real stance
    // is UNKNOWN, not absent. Assume the SAFEST index unconditionally
    // (index 0 can never be escalated past), regardless of what the project
    // asks -- never the schema default, which can be weaker than what the
    // user actually had set before the file broke.
    if (globalUnreadable) { out[key] = order[0]; continue; }
    if (project[key] === undefined) continue; // nothing the project asked to change
    const globalVal = global[key] === undefined ? SCHEMA_DEFAULT[key] : global[key];
    // CASE-FOLD to match the schema's case-insensitive enum. Comparing raw
    // case let a project 'AUTO' miss the lookup (indexOf -> -1) and fall
    // through to the shallow-merge (project wins), re-enabling a globally-off
    // skill (H5).
    let gi = order.indexOf(String(globalVal).toLowerCase());
    const pi = order.indexOf(String(project[key]).toLowerCase());
    // An unreadable GLOBAL VALUE (parsed fine, but this one key's value is
    // invalid) reads as the schema default (the WAVE-2 R2 rule extended from
    // absent to invalid — the user's position cannot be read, and the
    // declared default IS their position until they say otherwise); index 0
    // is the unreachable-by-construction last resort (every SCHEMA_DEFAULT
    // is a member of its own order). This is distinct from `globalUnreadable`
    // above (the whole FILE was unreadable) -- there, even the default is
    // too permissive to trust, so the safest index wins unconditionally.
    if (gi === -1) gi = order.indexOf(String(SCHEMA_DEFAULT[key]).toLowerCase());
    if (gi === -1) gi = 0;
    // K1 (graduation-lab round 2): an INVALID project value gets NO say —
    // the old `continue` here left the shallow-merge result (project wins)
    // for the downstream clamp to land on the SCHEMA DEFAULT, so a global
    // `off` was defeated by every junk value (`'nope'`, null, {}, ' auto '):
    // escalation by being wrong. Junk = treated as absent = the effective
    // global stands. And the resolved value is stored CANONICAL (order[i],
    // lowercase) — the old code compared the folded spelling but stored the
    // RAW one ('Off'), leaving a trap for any consumer that does not
    // normalize (check one spelling, act on that same spelling).
    out[key] = order[pi !== -1 && pi <= gi ? pi : gi];
  }
  for (const key of SAFER_TRUE) {
    // a project cannot turn OFF a global privacy opt-in; an unreadable
    // global (W2-3) assumes the safe value (true) unconditionally, same
    // rule as the enum loop above.
    if (globalUnreadable || global[key] === true) out[key] = true;
  }
  return out;
}

export function loadMergedConfig({ cwd = process.cwd(), home = os.homedir() } = {}) {
  const g = readJsonc(globalConfigPath(home));
  const p = readJsonc(projectConfigPath(cwd, home));
  return mergeSafety(g.data, p.data, { globalUnreadable: g.unreadable });
}
