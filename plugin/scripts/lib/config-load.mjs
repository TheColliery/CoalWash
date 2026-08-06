// ponytail: 805 lines at declaration (board #55/#56, 2026-08-06; the count is
// the tripwire's own PRE-declaration reading — this comment block adds ~10
// more, so `wc -l` on the committed file reads slightly higher; re-derive
// with `wc -l` for the CURRENT size, per this rule's own "N is history, not
// a live claim") — this file is
// every settings-cascade + path-canonicalization + case-fold primitive CoalWash
// shares across both lanes (pathWithin/touchesClaudeBase/canonicalOrNull/
// volumeCaseFolds/readCleanupPeriodDays/discoverRetentionCandidateKeys); every
// one of them is a security- or correctness-load-bearing trust-boundary check
// with an extensive HISTORY of subtle, hard-won fixes (see the R2/R3/R4/board-
// ruling comments throughout) — splitting it would scatter one cohesive trust
// boundary's reasoning across files, which is exactly the shape this room's own
// "twin drift" lesson warns against. Not split.
//
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
// Deliberate twin of explode.mjs's `isContainedIn`. THE TWIN IS NOT A COPY, and
// must never be "unified" into one — class-A is EXCLUDED from the shipped dist
// and must load standalone, so importing either engine from the other would
// break the plugin. Both engines now take their `foldOnMiss` as a REQUIRED
// per-call-site argument (CoalBoard ruling, 2026-08-01) rather than one baked-in
// default — class-A's `containment` because it genuinely carries BOTH
// containment polarities on one primitive; this file's `volumeCaseFolds`
// because a required parameter with no default is what a board found FOUR
// text-scanning fix rounds could not deliver (see `volumeCaseFolds`'s own
// header for the finding and why this file stops at "required", never adopting
// class-A's three-value 'unknown' shape — this file has no live PERMIT caller
// to need it).
//
// WHETHER "BOTH HALVES ARE CONVERTED" DEPENDS ON WHICH TREE IS READING THIS —
// name the branch, never assert it as a global fact. On `main`, once both lanes
// are merged, both engines are converted. On the `class-b` lane's OWN checkout,
// `explode.mjs` is whatever `class-a` last landed; a caretaker on this lane MUST
// re-derive the other side's state (`git show origin/class-a:...`) rather than
// trust a comment here — a prior version of this exact paragraph stated
// "BOTH HALVES ARE NOW CONVERTED" unconditionally and that was FALSE the moment
// it was read from `class-b`'s own tree, which never received class-A's commits.
// Agreement between the two is enforced by `twin-pin.test.mjs` at ASSEMBLY (a
// station-5-only gate, unrunnable meaningfully from either lane alone), never by
// a claim in this comment.
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
//
// SUSPECTED, NOT CONFIRMED, RECORDED WITH ITS POLARITY (station-3 findings-back,
// F4 — the mirror of explode.mjs's own identical note on its copy of this cache):
// a MEASURED answer is never re-probed, so a directory whose case-sensitivity is
// toggled MID-PROCESS keeps its first reading. This file's callers are ALL
// REFUSE-polarity (`touchesClaudeBase`, `isBase`, and apply.mjs's KEEPS-GATE), so
// the direction is the mirror of explode.mjs's PERMIT-polarity note: a stale
// cached `folds:true` only ever OVER-refuses (safe); a stale cached `folds:false`
// UNDER-folds, which is the fail-OPEN direction at a REFUSE gate. Every engine in
// this repo is a short-lived CLI process and this is unreached in practice —
// recorded as a bound, not fixed, matching the sibling file's own treatment.
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
// THERE ARE TWO STATS IN THIS FUNCTION AND THEY FAIL IN OPPOSITE DIRECTIONS.
// Do not collapse them into one clause — an earlier version of this comment said
// "or the stat itself fails" without saying WHICH, and that single word cost the
// org a day: it was read as covering both, repeated to several agents, and landed
// in a pushed commit message as the stated mechanism for a revert (see the
// CHANGELOG entry for this landing).
//
//   OUTER stat — `statSync(dirPhys)`, the directory being probed. A failure here
//   means the probe could not even establish its own reference identity, so
//   nothing can be compared: that IS a MISS, and it falls back to FOLDING.
//
//   INNER stat — `statSync(parent/flipped)`, the flipped spelling. A failure here
//   is NOT a miss, it is the probe SUCCEEDING: the flipped spelling does not
//   resolve, therefore the directory does not fold, therefore `folds = false`,
//   which is the CORRECT answer and the opposite of the fallback. This is the
//   ordinary result on any case-sensitive volume (ext4, an fsutil-enabled NTFS
//   directory) for an ordinary basename.
//
// A probe MISS is therefore exactly three things: no case-bearing character in the
// basename to flip, `flipCase` refusing an unstable character per its own bounded
// comment, or `dirPhys` being a filesystem root with no parent — plus the OUTER
// stat failure above. Every one of them falls back to the CALLER's declared
// `foldOnMiss`, never a real exact-match measurement — "the folding answer" only
// because every caller today happens to declare REFUSE (`true`); a future PERMIT
// caller declaring `false` would get the opposite fallback on the identical miss.
//
// A MISS ANSWERING `foldOnMiss` IS A KNOWN, NAMED WRONG ANSWER IN ONE DIRECTION —
// say so plainly, not just "safe": on a directory that is genuinely case-SENSITIVE,
// the true answer is `folds:false`; a REFUSE caller passing `true` gets `folds:true`
// on a miss, which is WRONG but the correct TRADE for what today's two callers of
// `pathWithin` need — `touchesClaudeBase` is a real trust boundary (REFUSE-polarity:
// folding MORE only ever REFUSES more, fail closed) and `findProjectRoot`'s `isBase`
// is declared non-security (state hygiene only, see its own comment). Folding LESS
// on a directory that actually folds would MISS a same-file match and fail OPEN,
// which is the direction that matters for a REFUSE caller. A PERMIT-polarity caller
// would pass `false` and needs the OPPOSITE trade, and must also read the
// forgeability note below before relying on it — passing the opposite boolean does
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
// (passing `false`) inherits both exposures and must treat the probe as untrusted
// input, not merely pass the opposite boolean — and that caller is not hypothetical
// in general: explode.mjs's `isContainedIn` documents ITSELF as "PERMIT-POLARITY
// ONLY" with a LIVE consumer (the snapshot-ref store-boundary check) that requires
// containment to be TRUE before proceeding. That twin is capability-probed too
// (`ebc8f60`) and takes the miss direction as its OWN required argument, answering
// 'unknown' — refusing at BOTH polarities — when its caller supplies none. So the
// exposure described above is bounded to THIS function's own REFUSE-polarity
// callers; it is NOT a property the pair shares, and a future PERMIT caller HERE
// would still need the forgeability treatment on top of passing `false`, not merely
// the flipped boolean by itself.
// `foldOnMiss` IS REQUIRED AND HAS NO DEFAULT — CoalBoard ruling 2026-08-01
// (`CW-POLARITY-REACH-BOARD-2026-08-01.md`), replacing `DEMAND-2/polarity-reach`
// (config-load.test.mjs, four fix rounds in one day, deleted in the same commit as
// this change). That guard scanned SOURCE TEXT for readers of this function and
// pinned an allowlist of who was safe to call it with the old implicit default —
// a scan is a DETECTED property, defeatable by any shape it did not enumerate
// (a namespace import, a second import line, a dynamic import, a re-export hop, a
// CJS `require`, a polarity-preserving rewrite that keeps the same call COUNT).
// Four of those were proven to defeat it, blind, in one board round. A REQUIRED
// parameter with no default makes reach STRUCTURAL instead of detected: every
// caller, however it obtained this function reference, must supply a real
// boolean at the call site or the language itself refuses to answer — verified
// below by throwing, never by returning a plausible-looking value a careless
// caller's `? :` could silently misread. EXACTLY class-A's own shape
// (`explode.mjs`'s `volumeCaseFolds(anchorPhys, foldOnMiss)` / `containment`),
// adapted to this file's return type: class-A's `containment` returns a
// three-value STRING ('inside'/'outside'/'unknown') because it has genuine
// live callers of BOTH polarities that must each interpret an unknown answer
// correctly; this file has never had — and does not now gain — a live
// PERMIT-polarity caller (this function's only 3 call sites, all REFUSE, are
// listed below), so there is no safe boolean to fall back to on a bad argument.
// A boolean silently coerced through truthy/falsy `? :` cannot represent
// "unknown" the way a compared string can, so this file THROWS instead of
// inventing a three-state contract nothing here needs — least mechanism for
// the polarity this file actually has, not a copy of class-A's for its own sake.
//
// THE THREE CALL SITES, their polarity, and why each is REFUSE:
//   `pathWithin`'s `norm`, below — its only 2 callers, `touchesClaudeBase` (a
//     real trust boundary) and `findProjectRoot`'s `isBase` (declared
//     non-security), are REFUSE. NOT because folding more narrows `isBase`'s
//     own root selection — it does not: `isBase(dir)=true` skips `dir`'s own
//     marker check and keeps climbing (`findProjectRoot`'s while-loop), which
//     can select a WIDER root than `dir` when a marker exists further up, so
//     folding more can widen the picked anchor at THIS function alone. The
//     safety is `applyPlan`'s `touchesClaudeBase` refusing any anchor that
//     touches config territory, in either direction, at the actual trust
//     boundary — a check `isBase` does not perform and does not need to.
//   `apply.mjs`'s `samePathForKeep` (2 call sites) — a MATCH makes a pinned
//     keep BIND and EXCLUDE the action, so folding more only ever refuses more.
// `pathWithin` itself is NOT threaded a `foldOnMiss` parameter (unlike class-A's
// `isUnder`, which threads `containment`'s): it has no live caller that needs
// anything but REFUSE, so adding API surface for a polarity nobody uses would be
// exactly the over-hardening skill-authoring.md §2 forbids. If a PERMIT-polarity
// consumer of path containment is ever needed here, it earns its own function
// when it exists, matching this file's own YAGNI precedent everywhere else.
export function volumeCaseFolds(dirPhys, foldOnMiss) {
  if (typeof foldOnMiss !== 'boolean') {
    throw new TypeError(`volumeCaseFolds: foldOnMiss is REQUIRED, no default — every caller must declare its polarity explicitly (REFUSE callers pass true; a future PERMIT caller must pass false and read the forgeability note above first). Got ${JSON.stringify(foldOnMiss)}.`);
  }
  if (CASE_FOLD_CACHE.has(dirPhys)) return CASE_FOLD_CACHE.get(dirPhys);
  let st;
  try { st = fs.statSync(dirPhys, { bigint: true }); } catch { return foldOnMiss; } // OUTER stat: a real probe MISS -> the caller's own declared direction. NEVER cached (see below) — a transient stat failure must not freeze a wrong answer for the process lifetime.
  const parent = path.dirname(dirPhys);
  const flipped = parent === dirPhys ? null : flipCase(path.basename(dirPhys));
  // MISS (root, or no case-bearing char) -> the caller's declared direction,
  // returned DIRECTLY, bypassing the cache below on purpose. This branch's
  // answer now IS `foldOnMiss` itself — a value that can differ PER CALLER for
  // the identical `dirPhys` (the whole point of making it a required argument).
  // The cache is keyed on `dirPhys` alone; caching a miss answer would let
  // whichever caller happened to probe this path FIRST silently overwrite every
  // later caller's own declared polarity for the same path — a cross-caller
  // leak through the cache that would defeat the required parameter as
  // thoroughly as the implicit default it replaces. A genuinely MEASURED answer
  // below has no such dependency (the volume's real case-sensitivity does not
  // depend on who is asking) and is cached exactly as before. Matches class-A's
  // own `volumeCaseFolds`, which does not cache either of its miss branches for
  // the identical reason.
  if (flipped === null) return foldOnMiss;
  let folds;
  try {
    const flippedSt = fs.statSync(path.join(parent, flipped), { bigint: true });
    folds = flippedSt.dev === st.dev && flippedSt.ino === st.ino;
  } catch {
    folds = false; // INNER stat: NOT a miss — the probe SUCCEEDED. The flipped spelling does not resolve, so the directory is genuinely case-SENSITIVE. Opposite direction to the outer catch above, deliberately.
  }
  CASE_FOLD_CACHE.set(dirPhys, folds);
  return folds;
}
export function pathWithin(childPhys, basePhys) {
  if (!childPhys || !basePhys) return false; // fail-closed
  if (!isCanonicalShape(childPhys) || !isCanonicalShape(basePhys)) return false; // fail-closed: caller must canonicalize
  // REFUSE-polarity, explicit — see volumeCaseFolds's own header for why this is
  // hardcoded here rather than threaded as a parameter of pathWithin itself.
  const norm = (s) => (volumeCaseFolds(basePhys, true) ? s.toLowerCase() : s);
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

// board #55 (owner-ordered): the PLATFORM's own `cleanupPeriodDays` (Claude Code's session-
// retention setting), not CoalWash's own `.coalwash.json` — READ, never assumed. Verified live
// (code.claude.com/docs/en/settings, fetched at build time — a version-sensitive fact per
// source-grounding, re-check at revalidate): key `cleanupPeriodDays`, default 30, min 1, deletes
// at STARTUP. Verified cascade, HIGHEST wins: Managed > Local > Project > User — a 4-tier
// cascade, not the 2-tier project/user shorthand this docket's own dispatch text used; the
// difference matters (an org enforcing a short retention via Managed settings must win).
//
// MANAGED settings has THREE real delivery mechanisms and this reads exactly ONE of them:
// (1) file-based (`managed-settings.json` under a fixed per-OS path) — read here.
// (2) Windows Registry (`HKLM`/`HKCU`...\Policies\ClaudeCode`) — NOT read: no zero-dep node
//     builtin reads the registry (Phoenix #2), and a native module is out of scope for this
//     engine's discipline. Named as an honest ceiling, not a silent gap.
// (3) server-delivered (claude.ai admin console / self-hosted gateway) — NOT read: no local
//     file exists for this tier at all: nothing to read.
// `managed-settings.d/*.json` drop-ins are also NOT read — their merge order past the base file
// is not specified precisely enough (by what this fetch verified) to implement without
// guessing, and guessing a merge order is worse than declining to.
// So: an org enforcing cleanupPeriodDays via registry policy or server delivery is invisible to
// this function; it falls through to whichever LOWER tier is actually readable. This narrows
// the guarantee from "the platform's real value" to "the platform's real value on every
// delivery mechanism this engine can read without a new dependency" — stated here so nobody
// mistakes the narrower claim for the wider one.
//
// INSPECT F2 (2026-08-06), one platform fact this cascade does not model: per CC's own docs,
// an UNREADABLE settings file makes the platform PAUSE its whole retention sweep (unless a
// managed value is present), never fall through to a lower tier and keep sweeping at that
// value. This function, by contrast, treats an unreadable tier as "keep looking" — modelling
// "find a number" rather than "predict whether the platform is sweeping at all". The direction
// is SAFE (a paused real sweep deletes nothing, while this cascade still reports a number and
// estate.mjs's horizon still assumes a sweep is happening, so the worst case is OVER-reporting
// what's reclaimable, never under-reporting it) — but it is a real, named gap between what this
// function's header describes and what the platform actually does on that one input shape.
function managedSettingsPath() {
  if (process.platform === 'win32') return 'C:\\Program Files\\ClaudeCode\\managed-settings.json';
  if (process.platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json';
  return '/etc/claude-code/managed-settings.json'; // linux/WSL, the documented Linux/WSL path
}

// Returns { days, source, file }. `source` is one of managed/local/project/user/default — the
// derivation this reads FEEDS the estate horizon's own report (board #55 item 5: state which
// value was read, from where). A file that EXISTS but is unreadable/malformed is skipped to the
// NEXT tier (readJsonc's `unreadable` flag) rather than treated as "key absent, use default" —
// the same distinguishing discipline `mergeSafety` already applies to CoalWash's own config,
// extended here to the platform's. A missing/unresolvable project root just drops the
// local/project tiers and proceeds to user/default — never throws.
//
// Shared by readCleanupPeriodDays and discoverRetentionCandidateKeys (rung 5 of the estate
// horizon ladder, estate.mjs) — one candidate-tier list, not two independently-drifting copies.
function settingsCascadeCandidates({ cwd = process.cwd(), home = os.homedir() } = {}) {
  const candidates = [{ source: 'managed', file: managedSettingsPath() }];
  let projectRoot = null;
  try { projectRoot = findProjectRoot(cwd, home); } catch { /* no project root -> skip local/project tiers */ }
  if (projectRoot) {
    candidates.push({ source: 'local', file: path.join(projectRoot, '.claude', 'settings.local.json') });
    candidates.push({ source: 'project', file: path.join(projectRoot, '.claude', 'settings.json') });
  }
  candidates.push({ source: 'user', file: path.join(claudeBaseDir(home), 'settings.json') });
  return candidates;
}

// board #55 AMENDMENT (owner, 2026-08-05), ladder rung 1: SANE, not just present. A value must
// be a positive INTEGER within a plausible range — reject 0, negatives, non-integers, and an
// absurd magnitude (>3650 = >10 years — that is not "a long retention", it is the key having
// been repurposed to a different unit or a different meaning; trusting it would silently bind
// the estate horizon to garbage). The upper bound is deliberately generous (10 years, not a
// tight guess) — the point is catching a UNIT/SEMANTICS change, not second-guessing a genuinely
// long-lived org policy.
const CLEANUP_DAYS_MAX_SANE = 3650;
function saneCleanupDays(v) {
  return Number.isFinite(v) && Number.isInteger(v) && v >= 1 && v <= CLEANUP_DAYS_MAX_SANE;
}

export function readCleanupPeriodDays({ cwd = process.cwd(), home = os.homedir() } = {}) {
  for (const { source, file } of settingsCascadeCandidates({ cwd, home })) {
    const { data, unreadable } = readJsonc(file);
    if (unreadable) continue; // present but broken -> try the next tier, never guess
    const v = data && data.cleanupPeriodDays;
    if (saneCleanupDays(v)) return { days: v, source, file };
  }
  return { days: 30, source: 'default', file: null }; // the documented default, key absent everywhere readable
}

// board #55 AMENDMENT, ladder rung 5: CANDIDATE-NAME DISCOVERY, report-only, NEVER auto-bound.
// Scans the same settings cascade for any OTHER key whose name suggests a retention/cleanup
// concern (`/cleanup|retention|prune|expire|purge/i`) — the signal that would catch a renamed
// or replaced `cleanupPeriodDays` before this engine ever silently trusts a guess. Every match
// is returned by name/value/source for the estate report to print; binding to a guessed key
// would be inventing semantics, which is exactly the failure this whole ladder exists to avoid.
export function discoverRetentionCandidateKeys({ cwd = process.cwd(), home = os.homedir() } = {}) {
  const RETENTION_KEY_RE = /cleanup|retention|prune|expire|purge/i;
  const found = [];
  for (const { source, file } of settingsCascadeCandidates({ cwd, home })) {
    const { data, unreadable } = readJsonc(file);
    if (unreadable || !data || typeof data !== 'object') continue;
    for (const key of Object.keys(data)) {
      if (key === 'cleanupPeriodDays') continue; // the known key -- not a "candidate"
      if (RETENTION_KEY_RE.test(key)) found.push({ key, value: data[key], source, file });
    }
  }
  return found;
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
