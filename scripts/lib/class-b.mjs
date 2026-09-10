// class-b.mjs — per-platform class-B discovery (READ-ONLY).
//
// Class B = every FILE the platform auto-loads into context each session
// (memory index + governance) plus the recall-loaded memory store. Layout is
// platform-SPECIFIC -> DISCOVER, never hardcode paths. Claude Code adapter
// first; an unknown platform gets the conservative path (no discovery + flag).
//
// Safety: this module only READS + stats. Every candidate path is still
// realpath-resolved and CONTAINED (home tree or project tree, physical compare
// both sides); an unresolvable or escaping path is SKIPPED + flagged
// (fail-closed — a symlink pointing outside the trees is never followed).
// Content is never transformed here, so encoding (UTF-8, Thai U+0E33, curly
// quotes) can never be corrupted by discovery.
//
// MANAGED-ARTIFACT AUTO-DECLARATION (beta.12 item 6, arm-3 finding: 8/12
// "danger-direction" flags in the run-in-background lab turned out to be
// sync-owned rule packs, not accreted prose — "update-tools syncs them;
// local trim = drift the sync manager fights", the same washability class as
// skills). Every entry gains a `managed: boolean` tag (measured, never
// hidden from BMI — measurement jurisdiction is the WHOLE parcel; wash
// jurisdiction is the washable subset only) via TWO independent, additive
// signals, both computed from what this SINGLE discovery pass already read
// (no network, no second project, no new privacy surface):
//   (1) byte-identical-across-roots: a PROJECT rules-tree file
//       (.claude/rules/**) that is byte-for-byte identical to a GLOBAL
//       rules-tree file (<claudeBase>/rules/**) at the SAME relative tail —
//       almost certainly a synced mirror, generalizable to any pack name
//       (never hardcodes "ecc" or any project-specific directory name).
//   (2) managedPaths (config, `stringList`): an explicit path-PREFIX
//       declaration (relative to the entry's own scope root, forward-slash
//       form) for a managed tree the heuristic above cannot see (e.g. no
//       global counterpart exists locally to compare against).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { claudeBaseDir, canonicalOrNull, pathExists, isCanonicalShape } from './config-load.mjs';

const IMPORT_DEPTH_MAX = 5; // CC @import recursion cap (docs: max 5 hops)
const RULES_FILE_CAP = 500; // defensive cap on a runaway rules tree

// The conservative fallback flag for a non-Claude-Code platform. ONE source of
// truth so the estate/retier entry gates (estate-archive.mjs · retier.mjs)
// mirror discoverClassB's OWN fallback line VERBATIM — one-flock: the discovery
// gate and the estate/retier gates can never drift apart on the wording.
export const UNKNOWN_PLATFORM_FLAG = 'unknown platform: conservative — no auto-discovery; verify class-B scope manually; never auto-delete';

// ---------------------------------------------------------------------------
// path helpers
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// CWK-082 F2-R2 — WHY physicalOrNull REFUSED, so a silent skip can say which
// case it took.
//
// The F2 fix put `noteUnreadable` at the readdirSync sites. On the failure mode
// those flags exist to report, the refusal arrives ONE CALL EARLIER: on a
// read-denied path `fs.statSync` SUCCEEDS while `fs.realpathSync.native` throws
// EPERM, so `physicalOrNull` returns null and every guarded read below it is
// unreachable. Measured on the shipped engine, each with a restore control: a
// read-denied role store went 1 store -> 0; a read-denied CLAUDE.md took its
// whole @import closure with it, 3 entries / 1,516 tok -> 0 / 0. `flags: []` on
// both. The reviewer measured the same class on its own fixture at 97.5%.
//
// THE ROOT IS THAT null IS OVERLOADED. It means the legitimate, deliberately-
// silent "unresolvable candidate, fail-closed" case AND "this exists and I was
// refused", and the call site cannot tell them apart. This splits them.
//
// IT CHANGES NO BEHAVIOUR AND CANNOT FAIL OPEN. Every skip stays a skip and
// stays fail-closed; only the SILENCE changes. This function never produces a
// physical path, so nothing downstream can be admitted by it.
//
// THE SILENT CASE IS DECIDED BY THE lstat ERROR CODE, NOT BY A BOOLEAN — R3-F1,
// and this line used to ask `pathExists` instead. `lstat` needs TRAVERSE
// permission on the candidate's PARENT: deny the parent and it throws,
// `pathExists` returns false, and the old first line took the branch reserved
// for "genuinely absent" on a candidate that is not absent at all — it exists
// and is unreachable, which is exactly the condition this helper was built to
// separate. Measured on the shipped engine with a restore control: a project
// whose CLAUDE.md carries `@sub/NOTES.md` with `sub` denied went 4 entries -> 3
// with `flags: []`, and back to 4 when the deny came off; on that child, `lstat`
// reported EPERM while `pathExists` reported false.
//
// ENOENT and ENOTDIR are the ONLY silent codes — the same pair `noteUnreadable`
// already carves out at a walk root, for the same reason: nothing exists behind
// the path, so nothing was lost. Every other code means we were REFUSED before
// we could look, which is not absence.
//
// THIS DOES NOT RE-IMPLEMENT `pathExists`, which stays the right primitive for
// its own callers (physicalForCreate still uses it): that answers a yes/no about
// EXISTENCE for a trust decision, this reads an ERROR CODE for a report. Same
// syscall, different question — and a boolean provably cannot answer this one.
//
// The CODE for the resolve step is read by re-provoking the throw — a second
// syscall on a COLD path by construction, since the whole function runs only
// where `physicalOrNull` already returned null. That is a READ of the error,
// never a second decision.
//
// TOCTOU, BOUNDED (R3-F2 — the reasoning above was here and the bound was not).
// These are two syscalls on one path and they CAN disagree; that disagreement is
// the very mechanism this helper is built on (lstat succeeds where realpath
// throws), so a path that changes BETWEEN them is the same shape, not a new one.
// THE BOUND: a divergence can only mis-name a CODE or drop one gauge's flag. It
// cannot admit anything — the function returns no path. It cannot change a skip
// — that was already decided by the caller before this ran. And nothing
// downstream consumes the value: it reaches a flag string and stops, and the
// next gauge re-derives from scratch. That is why the two calls need no lock and
// no re-check. If a later change ever makes this return feed a DECISION, this
// bound is void and the pair needs one.
//
// UNCOMPARABLE is a real, separate case, not a fallback: `canonicalOrNull` also
// returns null WITHOUT throwing — a `\\?\` device or UNC spelling on win32, and
// a mapped network drive that native RESOLVES to a UNC form. Content is dropped
// there too, so it flags, under its own word rather than borrowed from an error.
function refusalCode(candidate) {
  try { fs.lstatSync(candidate); } catch (err) {
    const code = (err && err.code) || 'UNKNOWN';
    return (code === 'ENOENT' || code === 'ENOTDIR') ? null : code; // absent = silent; refused = named
  }
  // F-T3: THE SAME CARVE-OUT, THE SAME RULE, BOTH CALLS. This line used to pass
  // the second call's code through untouched, so `refusalFlag` — which calls
  // anything that is not UNCOMPARABLE `refused` — labelled an ABSENCE as a
  // PERMISSION problem five lines below the branch that carves absence out.
  // REACHED, not argued: a directory junction whose target is deleted lstats OK
  // and fails realpath with ENOENT, producing
  // `refused path (governance): DANGLING.md [ENOENT]`; a user then hunts an ACL
  // problem that does not exist. Nothing is behind a dangling link, so nothing
  // was lost, so the honest output is the same SILENCE the first call already
  // gives that pair.
  //
  // WHY (a) AND NOT (b), THE CODE-TO-NOUN MAP THE REVIEWER ALSO OFFERED —
  // measured before choosing (scratchpad/r32/probe-ft3-codes.mjs, win32):
  // ENOENT is the ONLY code observed reaching this second call at all. A junction
  // LOOP throws ELOOP from realpath but `lstat` fails first with ENOENT, so it
  // never arrives here; an overlong name likewise. Building a noun map for codes
  // nothing could be shown to reach would be inventing a classifier against a
  // measurement I do not have. With this carve-out every code that still reaches
  // `refusalFlag` is either UNCOMPARABLE or a genuine refusal, which is what
  // makes "the noun follows the code" true rather than nearly true.
  //
  // NAMED RESIDUAL: that argument rests on a win32 measurement. A POSIX box could
  // in principle deliver ELOOP here (its lstat may not fail first), and the word
  // would then read `refused` for a resolution failure. Unmeasured — no seat in
  // this room has a Linux box.
  try { fs.realpathSync.native(candidate); return 'UNCOMPARABLE'; } catch (err) {
    const code = (err && err.code) || 'UNKNOWN';
    return (code === 'ENOENT' || code === 'ENOTDIR') ? null : code;
  }
}

// R3-F3 — THE NOUN FOLLOWS THE CODE. This unit's whole contribution is
// separating UNRESOLVABLE (nothing to resolve; deliberately silent, fail-closed)
// from REFUSED (it exists, access denied), and a user-facing line reading
// "unresolvable path … [EPERM]" re-blurs the two at the one surface a user
// actually reads — the noun saying the path could not be resolved while the code
// says permission was denied. The neighbouring `unreadable directory (…)` family
// already gets this right, so the two had started disagreeing with each other.
// Only the genuine non-throwing case keeps the word `unresolvable`.
function refusalFlag(what, label, code) {
  const word = code === 'UNCOMPARABLE' ? 'unresolvable' : 'refused';
  return `${word} path (${what}): ${label} [${code}] — its contents are NOT counted`;
}

// A label for a flag: RELATIVE to a known root wherever possible, never an
// absolute path. Two reasons — a hand can act on it, and it stays
// sandbox-invariant, so a flag can never carry a tmpdir or a drive letter into
// a surface an equivalence test compares across two roots. Purely lexical, so
// it works on the unresolved path that just refused to canonicalize.
function relLabel(candidate, roots) {
  for (const r of roots) {
    if (!r) continue;
    const rel = path.relative(r, candidate);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  }
  return path.basename(candidate) || String(candidate);
}
// Physical form of a path; null when it cannot be resolved (absent/looping) —
// callers treat null as fail-closed (skip the candidate).
// Delegates to THE canonicalization primitive (config-load canonicalOrNull) so
// every class-B containment check inherits the win32 8.3 / UNC fail-closed rules.
export function physicalOrNull(p) {
  return canonicalOrNull(p);
}

// Is `p` (PHYSICAL) inside one of `roots` (PHYSICAL)? Equal counts as inside.
// CONTRACT ENFORCED (churn-lab Finding 1). This comparator is purely LEXICAL — it
// makes zero filesystem calls — and it disagreed with `physicalOrNull` about the
// same physical file in BOTH directions: fail-OPEN on a junction (says inside, the
// file is outside) and fail-CLOSED on an 8.3 short name (says outside, the file is
// inside). It is alias-aware for CASE and alias-blind for SHORT NAMES, and that
// asymmetry is not fixable here: case-folding comes free from `path.win32.relative`
// because `FOO`/`foo` are string-relatable, whereas `PROGRA~1` and `Program Files`
// have no transform relationship at all — the mapping lives in filesystem metadata
// and only a syscall can obtain it. So a lexical comparator cannot be made
// alias-aware; it can only REFUSE to answer a question it is unable to judge.
//
// Same fix, same helper, as `pathWithin` received in 5982e68 — deliberately not a
// second shape for one problem. A non-canonical argument now fails CLOSED instead
// of being silently compared as text. Free: no syscall, and idempotent on a real
// canonical path. This also explains why the lab found no reachable exploit — all
// 26 non-test call sites already canonicalize, so the contract was always real and
// merely unenforced; this makes the code say what the callers already do.
export function containedIn(p, roots) {
  if (!p) return false;
  if (!isCanonicalShape(p)) return false; // fail-closed: the caller must canonicalize
  for (const root of roots) {
    // A non-canonical ROOT is skipped rather than trusted — it cannot legitimately
    // admit anything, and an all-non-canonical root set therefore returns false.
    if (!root || !isCanonicalShape(root)) continue;
    const rel = path.relative(root, p);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return true;
  }
  return false;
}

// Physical form of a path ABOUT TO BE CREATED (it may not exist yet, so
// realpathSync alone fails): realpath the deepest EXISTING ancestor, then
// reattach the missing tail. path.resolve collapses any `..` LEXICALLY before
// the walk, and the existing part resolves PHYSICALLY — so both a
// `..`-carrying derivation and a symlinked intermediate dir surface at their
// REAL location for a containedIn check. Write-side realpath-and-contain, the
// destination twin of physicalOrNull (loss class #57 / the git
// GHSA-2hvf-7c8p-28fx side-artifact-path mechanism). null = no existing
// ancestor at all -> fail-closed.
export function physicalForCreate(p) {
  let cur = path.resolve(p);
  const tail = []; // ponytail: local mutation, never escapes
  for (;;) {
    const phys = physicalOrNull(cur);
    if (phys) return tail.length ? path.join(phys, ...tail.reverse()) : phys;
    // A FAIL-CLOSED PRIMITIVE BECOMES FAIL-OPEN AT THE FIRST CALLER THAT TREATS null
    // AS "CLIMB HIGHER AND GUESS LEXICALLY". Climbing is only legitimate over a
    // segment that DOES NOT EXIST YET (the whole point: resolve the deepest existing
    // ancestor of a path about to be created). A segment that EXISTS but that
    // physicalOrNull refused is the opposite case — reattaching the tail across it
    // skips the very resolution the refusal demanded, and a junction planted there
    // then aims the write outside the guarded store (the GHSA-2hvf-7c8p-28fx /
    // loss-class-#57 threat this function exists to close). Fail closed instead.
    if (pathExists(cur)) return null;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    tail.push(path.basename(cur));
    cur = parent;
  }
}

// #57(d) CLOUD-PLACEHOLDER READ POISON (MASTER-LOSS-TAXONOMY.md #57 4th member):
// a OneDrive Files-On-Demand / iCloud-optimized placeholder returns SHORT/stub
// bytes on a plain read() with NO throw and the SAME wrong bytes on every
// re-read — so the R1 external-writer guard (which proves a file did not CHANGE
// between two reads) is structurally BLIND (zero drift = self-consistent
// nonsense), and a copy-verify-then-delete or a prose rewrite trusts the stub:
// the WARM gzip round-trip matches (both sides the same stub) and deletes the
// real original, or a rewrite writes a truncated body that clobbers the
// not-yet-hydrated content when it syncs UP. Sniff the dehydrated signal from
// METADATA ONLY (never a content read — the read is exactly what a placeholder
// poisons): a REGULAR file whose logical size > 0 but which has ZERO
// physically-allocated blocks (`blocks === 0`) is not hydrated (macOS iCloud /
// Linux network-mount placeholders).
//
// ⚠ PLATFORM CALIBRATION — win32 is a NAMED RESIDUAL, detected via the reparse
// attribute, NOT via blocks (rationale corrected 2026-07-16 from field data, #8).
// The earlier note claimed Node reports `blocks === 0` for EVERY win32 file — that
// premise is DISPROVEN: on current libuv `blocks` is LIVE on win32, allocation-
// proportional (8192 B -> 16, 1 MiB -> 2048), `blocks === 0` only for the sub-512 B
// MFT-resident class (measured on two NTFS boxes, Node v24.11/24.17, #8; the old
// "always 0" was version drift from old libuv docs). The blocks sniff STILL stays a
// NO-OP on win32, now for the correct FIDELITY-FIRST reason: a legitimate NTFS
// SPARSE file shares the exact `size>0 / blocks===0` fingerprint of a dehydrated
// stub, and the signal that actually distinguishes them — the reparse attribute
// FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS — is NOT exposed by Node's `fs`. #8's live-
// fire proved the predicate only against a SYNTHETIC `fsutil sparse` file, never a
// REAL OneDrive/iCloud reparse stub (that cell stays unmeasured) — so a blocks-only
// sniff here would over-refuse real sparse files while being unproven against real
// stubs. The real fix is a native/PowerShell reparse-attribute read swapped in at
// the two injectable call sites (estate archiveSession `isPlaceholder`, applyPlan
// `opts.isPlaceholder`); until then win32 returns false and the R1 external-writer
// guard + copy-verify byte-compare remain the nets. The signal is CORRECT on POSIX
// where blocks is real.
//
// POSITIVE-SIGNAL ONLY (fail toward NORMAL, never flag-everything): an
// unreadable stat, an absent/NaN `blocks`, a non-file, or win32 = NOT flagged —
// the guard fires ONLY on a PROVEN stub, so a caller skips+reports rather than
// archives/rewrites it. `statSync`/`platform` are injectable — a real
// placeholder cannot be created inside a hermetic sandbox, so tests feed a
// synthetic stat + the platform they want to exercise.
export function isCloudPlaceholder(p, { statSync = fs.lstatSync, platform = process.platform } = {}) {
  if (platform === 'win32') return false; // win32 NAMED residual — reparse-attribute upgrade path, not blocks (see calibration note, #8)
  try {
    const st = statSync(p);
    if (!st || typeof st.isFile !== 'function' || !st.isFile()) return false;
    const size = Number(st.size);
    const blocks = Number(st.blocks);
    return Number.isFinite(size) && size > 0 && Number.isFinite(blocks) && blocks === 0;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Claude Code adapter
// ---------------------------------------------------------------------------

// CC's per-project memory dir slug: the absolute project path with every
// non-alphanumeric char replaced by '-'. ⚠️ version-sensitive CC internal
// (verified against live ~/.claude/projects entries 2026-07-09); if the derived
// dir does not exist, discovery just contributes no memory entries — safe.
export function ccProjectSlug(projectRoot) {
  return path.resolve(projectRoot).replace(/[^A-Za-z0-9]/g, '-');
}
export function ccMemoryDir(projectRoot, home = os.homedir()) {
  return path.join(claudeBaseDir(home), 'projects', ccProjectSlug(projectRoot), 'memory');
}

export function detectPlatform(home = os.homedir()) {
  try {
    if (process.env.CLAUDE_CONFIG_DIR || fs.existsSync(claudeBaseDir(home))) return 'claude-code';
  } catch {}
  return 'unknown';
}

// Parse `@path` import lines from a CLAUDE.md-style file (CC memory imports).
// Line-start tokens only; `~/` resolves to home; relative paths resolve against
// the importing file's directory.
export function parseImports(text, fileDir, home = os.homedir()) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*@(\S+)\s*$/.exec(line);
    if (!m) continue;
    const raw = m[1];
    if (raw.startsWith('~/') || raw === '~') out.push(path.join(home, raw.slice(1)));
    else if (path.isAbsolute(raw)) out.push(raw);
    else out.push(path.resolve(fileDir, raw));
  }
  return out;
}

function statBytes(p) {
  try { const st = fs.statSync(p); return st.isFile() ? st.size : null; } catch { return null; }
}

// Discover the Claude Code class-B set for one project.
// Returns { platform, entries, flags } where each entry =
//   { path (physical), bytes, scope: 'global'|'project',
//     kind: 'governance'|'memory-index'|'memory', alwaysLoaded: bool,
//     managed: bool }
// alwaysLoaded on CC = the CLAUDE.md walk + its @imports + the memory index;
// individual memory files + non-imported rules load on demand (recall cost).
// `managed` (beta.12 item 6): true = a sync-owned artifact (byte-identical to
// a same-relative-path file under the OTHER scope's rules tree, or matching a
// configured `managedPaths` prefix) — MEASURED like anything else (BMI must
// never undercount the parcel) but never a wash candidate (same class as
// skills/commands/hooks; see SKILL.md's four washability tests).
// ponytail: 319 lines at declaration, nesting depth 6 — ONE discovery pass over
// ONE habitat, and the length is the habitat, not the function. Every step shares
// three pieces of state that make it correct: `add` (which owns dedupe, the
// realpath-and-contain gate, the inherited-vs-room tier decision and now the
// F2-R2 refusal flags), `seen`, and `flags`. Splitting the steps into siblings
// would either pass that closure around as parameters — the same coupling with
// more surface — or duplicate it, which is this room's twin-drift lesson by
// name. The depth is the walks: a stack loop, its readdir loop, and the per-entry
// branch, none of which can flatten without losing the cap/flag accounting the
// F1 fix depends on. Declared at the CWK-082 F2-R2 round, which added ~10 lines
// to a function already well past the signal; the N is HISTORY, not a live claim.
export function discoverClassB({ projectRoot = process.cwd(), home = os.homedir(), platform, managedPaths = [] } = {}) {
  const plat = platform || detectPlatform(home);
  const flags = [];
  if (plat !== 'claude-code') {
    return {
      platform: plat,
      entries: [],
      inherited: [],
      flags: [UNKNOWN_PLATFORM_FLAG],
      roleMemories: [],
    };
  }

  // FAIL-CLOSED (parity with apply.mjs containment): an unresolvable root is
  // null rather than a non-physical lexical fallback — discovery is "contained
  // the same way" as the write path, as SECURITY.md claims. The project-anchored
  // walks below are skipped when projPhys is null (nothing to contain against).
  const homePhys = physicalOrNull(home);
  const projPhys = physicalOrNull(projectRoot);
  // F2-R2: a refused ROOT is the widest instance of the class — every walk
  // anchored on it is skipped, so the gauge reports a near-empty store. Loud.
  for (const [label, raw, phys] of [['home', home, homePhys], ['projectRoot', projectRoot, projPhys]]) {
    if (phys) continue;
    const code = refusalCode(raw);
    if (code) flags.push(refusalFlag(label, '.', code));
  }
  const roots = [homePhys, projPhys].filter(Boolean);
  const seen = new Set();
  const entries = [];
  // #22's SIBLING TIER, and the reason this file already argued for one.
  // NESTED-HABITAT (series law): a governance-measuring tool models THREE tiers
  // — global (~/.claude) / INHERITED-ANCESTOR (the umbrella above the room) /
  // room-owned — never a flat global/project pair. The role-memory tier below
  // implements the room-owned half of that law and cites the CoalTipple
  // false-FULL lesson by name; the ancestor half was never built, so the
  // umbrella's CLAUDE.md closure kept landing in `entries` as scope 'project'.
  // MEASURED 2026-07-25, one gauge run per room at one moment: the umbrella
  // alone is 30,487 tok = 85% of the 36,000 hard ceiling BEFORE a room holds one
  // byte of its own, and it FALSE-FULLed three rooms (CoalTipple by 76 tokens —
  // the exemplar the docket named). No room's own content was near the ceiling.
  //
  // A ROOM CANNOT ACT ON ITS UMBRELLA, in either direction: it may not wash it
  // (law clause 2 — that is the umbrella room's jurisdiction, and washing it
  // from here is cross-room contamination), and it cannot externalize it, which
  // is the exact advice a capHit FULL gives. So an inherited file must not sit
  // in `entries`: everything downstream of `entries` is a verdict the room is
  // told to ACT on. Splitting the tier fixes the measurement and removes the
  // mutation exposure in one move, and leaves the cost REPORTABLE (returned as
  // its own field) rather than invisible.
  const inherited = [];
  // Windows paths are case-insensitive -> lowercase the dedupe key there ONLY
  // (lowercasing on POSIX would wrongly merge two case-distinct files).
  const dedupeKey = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  // rules-tree entries only, tracked separately for the byte-identical-
  // across-roots cross-check below (relTail = the path under its OWN
  // rules root, forward-slashed — the generalizable pairing key: never
  // hardcodes a pack name like "ecc", works for any synced directory).
  const rulesSeen = []; // [{ entry, relTail }]

  // `upTree` = this candidate came from the CLAUDE.md ancestor walk, the ONLY
  // step that can reach above the room. The tier is then decided PER FILE by
  // LOCATION, not by which step queued it, so an @import that escapes upward out
  // of the room's own CLAUDE.md is classified correctly too.
  //
  // WHY THE FLAG AND NOT AN UNCONDITIONAL LOCATION TEST — the trap I nearly shipped:
  // the global memory store (step 4, ~/.claude/projects/<slug>/memory) is tagged
  // scope 'project' and sits OUTSIDE projPhys, so an unconditional "outside the
  // room ⇒ inherited" test would silently drop the one global store CoalWash
  // actually washes out of the cap. Outside-the-room and not-the-room's are
  // different questions; only the ancestor walk asks the second one.
  const add = (candidate, { scope, kind, alwaysLoaded, upTree = false }) => {
    const phys = physicalOrNull(candidate);
    if (!phys) {
      // F2-R2: the skip is unchanged and still fail-closed. What is new is that
      // it SAYS SO when the candidate exists — a refused governance file takes
      // its entire @import closure out of the measure with it.
      const code = refusalCode(candidate);
      if (code) flags.push(refusalFlag('governance', relLabel(candidate, [projPhys, homePhys]), code));
      return null;
    }
    if (!containedIn(phys, roots)) {
      // THE ABSOLUTE PATH HERE IS DELIBERATE, and this note exists because two of
      // my own returns NAMED it as the one flag in this file that is not
      // sandbox-invariant, without checking whether it CAN be relativized. It
      // cannot. This flag fires precisely BECAUSE the candidate escaped every
      // root, so `relLabel` finds no root to relativize against and falls through
      // to a bare basename — which, on a path the reader has to go and FIND
      // outside their own trees, is strictly worse than the absolute form (the
      // same disambiguation lesson as the residue/coverage lines, pointing the
      // other way here). RULED, not a residue: do not "fix" this into a basename.
      flags.push(`skipped (outside home/project trees): ${candidate}`);
      return null;
    }
    if (seen.has(dedupeKey(phys))) return phys;
    const bytes = statBytes(phys);
    if (bytes == null) {
      // Same class, one call later: `phys` canonicalized, so the file EXISTED a
      // moment ago. A stat that fails now is a real mid-walk loss, not absence.
      flags.push(`unstattable file: ${relLabel(phys, [projPhys, homePhys])} — its bytes are NOT counted`);
      return null;
    }
    seen.add(dedupeKey(phys));
    const isInherited = upTree && projPhys && !containedIn(phys, [projPhys]);
    (isInherited ? inherited : entries).push({ path: phys, bytes, scope, kind, alwaysLoaded, managed: false });
    return phys;
  };

  // A governance file + its @import closure (depth-capped, cycle-safe).
  const addWithImports = (file, scope, upTree = false) => {
    const queue = [{ file, depth: 0 }];
    while (queue.length) {
      const { file: f, depth } = queue.shift();
      const phys = add(f, { scope, kind: 'governance', alwaysLoaded: true, upTree });
      if (!phys || depth >= IMPORT_DEPTH_MAX) continue;
      let text;
      try { text = fs.readFileSync(phys, 'utf8'); } catch (err) {
        // r32, THE (a) FORK. This `continue` dropped the whole @import closure
        // of a governance file whose CONTENT could not be read, with flags: [].
        // Pre-existing since cec4a4d (beta.1); measured in r31 at 4 entries -> 2.
        //
        // WHY refusalCode() IS THE WRONG INSTRUMENT HERE, stated because the
        // obvious reading is to reuse it: refusalCode RE-PROBES with lstat and
        // realpathSync.native, and on exactly the fixture that produces this loss
        // BOTH succeed — the path resolves, only the READ is denied — so it
        // returns null and no flag would ever fire. The error's own code is the
        // only witness to a failure that happens at the read itself.
        //
        // NO ENOENT/ENOTDIR CARVE-OUT, and that is deliberate rather than an
        // omission: the silence carve-out exists for a candidate that never
        // existed. `phys` canonicalized one call ago, so the file DID exist a
        // moment ago and an ENOENT now is a real mid-walk loss — identical
        // reasoning to the `unstattable file` sibling directly above, which
        // likewise carves nothing out.
        //
        // THE MESSAGE IS NOT WIDER THAN THE TRUTH: add() already succeeded, so
        // the file's OWN bytes ARE counted. What vanishes is everything it
        // imports.
        const code = (err && err.code) || 'UNKNOWN';
        flags.push(`unreadable governance file: ${relLabel(phys, [projPhys, homePhys])} [${code}] — its own bytes ARE counted, its @import closure is NOT`);
        continue;
      }
      for (const imp of parseImports(text, path.dirname(phys), home)) {
        queue.push({ file: imp, depth: depth + 1 });
      }
    }
  };

  // 1. Global governance: <claude-base>/CLAUDE.md + its import closure.
  addWithImports(path.join(claudeBaseDir(home), 'CLAUDE.md'), 'global');

  // 2. Project governance: the CLAUDE.md up-tree walk (projectRoot up to home,
  //    physical compare, never above home) + each file's import closure.
  //    Skipped when the project root did not resolve (fail-closed).
  if (projPhys) {
    let dir = projPhys;
    while (true) {
      const cl = path.join(dir, 'CLAUDE.md');
      if (fs.existsSync(cl)) addWithImports(cl, 'project', true);
      if (dir === homePhys) break;
      const parent = path.dirname(dir);
      if (parent === dir) break; // filesystem root
      dir = parent;
    }
  }

  // 3. Rules tree(s) (<root>/.claude/rules/**/*.md or, for the global root,
  //    <claudeBase>/rules/**/*.md): class-B governance store; loads on demand
  //    for the subtree -> alwaysLoaded false unless a file was already pulled
  //    in via an @import above (dedupe keeps the stronger entry). Walked for
  //    BOTH the project root and the global claude base — the SAME function,
  //    scope-parameterized — so the byte-identical-across-roots managed check
  //    below has a global side to compare a project file against (most
  //    installs have no global rules tree; the walk is then a harmless no-op,
  //    same as the existing "missing memory dir" pattern).
  //    Symlink/junction safety (verified empirically, G1): a Dirent from
  //    readdirSync(withFileTypes) reports a symlink/junction's OWN type
  //    (isSymbolicLink() true), never isDirectory()/isFile() — so a
  //    symlinked-outside entry here is silently SKIPPED by construction,
  //    never traversed. Anything that DOES reach add() below is still
  //    realpath-and-contained regardless (defense in depth, not the only gate).
  // ---------------------------------------------------------------------
  // CWK-082 findings-back F2 — an unreadable directory used to `continue` in
  // SILENCE at every walk site below, so a subtree the gauge could not read
  // simply weighed nothing and `flags` stayed EMPTY. Measured: a locked
  // memory subdir took the store from 7,586 to 2,613 tok with flags []. This
  // unit exists to stop the gauge under-counting in silence and had opened a
  // new way to do exactly that, one layer in.
  //
  // The ONE case that stays silent is the case the swallow was written for: a
  // store that was never CREATED. That is decided by the error CODE on the
  // walk ROOT (node/runtime.md §7 — key on err.code, never err.message); a
  // subtree that vanished or refused MID-walk existed a moment ago and its
  // loss is real, so it says so.
  //
  // The flag carries the path RELATIVE to the walk root: enough for a hand to
  // act on, and sandbox-invariant, so it can never carry an absolute home
  // path into a surface an equivalence test compares across two roots.
  const noteUnreadable = (err, dir, root, what) => {
    const code = (err && err.code) || 'UNKNOWN';
    if (dir === root && (code === 'ENOENT' || code === 'ENOTDIR')) return; // never created — not a failed read
    const rel = dir === root ? '.' : path.relative(root, dir).split(path.sep).join('/');
    flags.push(`unreadable directory (${what}): ${rel} [${code}] — its contents are NOT counted`);
  };
  const walkRulesTree = (rulesRoot, scope) => {
    const stack = [rulesRoot];
    let count = 0, dirs = 0;
    // Cap BOTH the .md count AND the directory traversal (Phoenix #3): a deep/wide
    // tree with many dirs but few .md files would otherwise keep count < cap
    // forever and readdirSync the whole tree every SessionStart.
    while (stack.length && count < RULES_FILE_CAP && dirs < RULES_FILE_CAP) {
      const dir = stack.pop();
      dirs++;
      let names;
      try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { noteUnreadable(err, dir, rulesRoot, `rules tree, scope ${scope}`); continue; }
      for (const d of names) {
        const p = path.join(dir, d.name);
        if (d.isDirectory()) stack.push(p);
        else if (d.isFile() && d.name.endsWith('.md')) {
          const phys = add(p, { scope, kind: 'governance', alwaysLoaded: false });
          count++;
          if (phys) {
            const entry = entries.find((e) => e.path === phys);
            if (entry) rulesSeen.push({ entry, relTail: path.relative(rulesRoot, phys).split(path.sep).join('/') });
          }
        }
      }
    }
    // CWK-082 findings-back F1 — the flag fires on what ACTUALLY HAPPENED, not
    // on the counter reaching the cap. 526 files in ONE flat directory takes
    // `count` past the cap and narrows NOTHING (the inner loop finishes the
    // directory it starts), and a flag that announces a complete read trains
    // the reader to ignore it — the cry-wolf failure this whole flag exists to
    // prevent. A non-empty stack at loop exit is the exact, cheap predicate:
    // directories were queued and never visited, so their contents are missing.
    if (stack.length) flags.push(`rules tree capped (${count} files / ${dirs} dirs at cap ${RULES_FILE_CAP}, scope ${scope}) — ${stack.length} director${stack.length === 1 ? 'y' : 'ies'} left UNVISITED, their contents are NOT counted`);
  };
  if (projPhys) walkRulesTree(path.join(projPhys, '.claude', 'rules'), 'project');
  if (homePhys) walkRulesTree(path.join(claudeBaseDir(home), 'rules'), 'global');

  // 4. Memory store: ~/.claude/projects/<slug>/memory/ — MEMORY.md is the
  //    always-loaded index; every OTHER *.md in the tree loads on recall.
  //
  //    RECURSIVE since CWK-082 L1, and the flat readdir it replaces was a free
  //    exit from the gauge — not a theory. MEASURED (INSPECT §3a, four arms,
  //    identical bytes on disk, through the SHIPPED discover->measure pair):
  //    the same 49,515 bytes read 12,384 tok as memory/big-notes.md and 631 tok
  //    as memory/notes/big-notes.md. 11,753 tok invisible, and flags EMPTY on
  //    BOTH arms, so nothing anywhere said content had left. Step 3
  //    (walkRulesTree) recurses but is anchored at .claude/rules; steps 1-2
  //    reach a file only through an @import closure; so a *.md one directory
  //    down was reachable by NO step. A band computed on that is not
  //    "undercounting in the safe direction" — it reports LEAN on a store that
  //    never shrank, which is a different failure. 0l capture-all is the law
  //    being restored: MEASURE everything, THEN filter jurisdiction.
  //
  //    IT CANNOT INFLATE THE MAIN'S BMI, and that is this change's own bound:
  //    only the TOP-LEVEL MEMORY.md is the index (depth === 0), so every entry
  //    the widening adds carries alwaysLoaded:false and lands in m.total ONLY,
  //    never m.alwaysLoaded — the same split the room already ruled for role
  //    memories. Pinned by its own invariant test rather than argued here
  //    (class-b.test.mjs, "the widening lands in m.total ONLY").
  //
  //    Capped on files AND dirs with a FLAG when it trips — deliberately the
  //    SAME shape and the SAME constant as walkRulesTree above rather than a
  //    second number to keep in step: a capped walk that says nothing is a
  //    silently partial gauge. Symlink safety rides the same Dirent property
  //    step 3 documents (a junction reports isSymbolicLink(), never
  //    isDirectory()/isFile(), so it is skipped by construction) — which is
  //    also why this now reads with { withFileTypes: true }.
  //
  //    RESIDUE, NAMED not closed — this closes the SUBDIR shape and nothing
  //    wider. Recursion reaches only INSIDE memDir, so a class-B-shaped .md
  //    placed ADJACENT to the store (INSPECT's OUTSIDE arm,
  //    <project>/notes/big-notes.md) is still reachable by no step, and content
  //    moved fully OUT of the store is beyond this gauge BY DESIGN. Do not read
  //    this walk as covering either.
  {
    const memDir = ccMemoryDir(projectRoot, home);
    const stack = [{ dir: memDir, depth: 0 }];
    let count = 0, dirs = 0;
    while (stack.length && count < RULES_FILE_CAP && dirs < RULES_FILE_CAP) {
      const { dir, depth } = stack.pop();
      dirs++;
      let names;
      try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { noteUnreadable(err, dir, memDir, 'memory store'); continue; }
      for (const d of names) {
        const p = path.join(dir, d.name);
        if (d.isDirectory()) { stack.push({ dir: p, depth: depth + 1 }); continue; }
        if (!d.isFile() || !d.name.endsWith('.md')) continue;
        const isIndex = depth === 0 && d.name === 'MEMORY.md';
        add(p, {
          scope: 'project',
          kind: isIndex ? 'memory-index' : 'memory',
          alwaysLoaded: isIndex,
        });
        count++;
      }
    }
    if (stack.length) flags.push(`memory store capped (${count} files / ${dirs} dirs at cap ${RULES_FILE_CAP}) — ${stack.length} director${stack.length === 1 ? 'y' : 'ies'} left UNVISITED, their contents are NOT counted`);
  }

  // ---------------------------------------------------------------------
  // MANAGED-ARTIFACT AUTO-DECLARATION (beta.12 item 6) — runs once, after
  // every entry is known, over what THIS single pass already read (no extra
  // fs walk, no network, no second project).
  // ---------------------------------------------------------------------

  // Signal (1): byte-identical-across-roots. Group rules-tree entries by
  // relTail; wherever the SAME relative path exists under BOTH the project
  // and the global rules root, compare content (cheap byte-length check
  // first — a length mismatch can never be identical, avoids a wasted read).
  // Both sides of an identical pair are tagged: the pairing itself, not which
  // side is "the source", is what proves a sync relationship exists.
  {
    const byTail = new Map();
    for (const r of rulesSeen) {
      const bucket = byTail.get(r.relTail) || [];
      bucket.push(r);
      byTail.set(r.relTail, bucket);
    }
    for (const bucket of byTail.values()) {
      const proj = bucket.filter((r) => r.entry.scope === 'project');
      const glob = bucket.filter((r) => r.entry.scope === 'global');
      for (const p of proj) {
        for (const g of glob) {
          if (p.entry.bytes !== g.entry.bytes) continue; // cheap pre-check
          let same = false;
          try { same = Buffer.compare(fs.readFileSync(p.entry.path), fs.readFileSync(g.entry.path)) === 0; } catch { same = false; }
          if (same) { p.entry.managed = true; g.entry.managed = true; }
        }
      }
    }
  }

  // Signal (2): managedPaths (config) — an explicit prefix declaration,
  // relative to the entry's OWN scope root, forward-slash form. Silently
  // ignores a non-array/malformed input (config-schema.mjs already clamps
  // this at the read site; this is defense in depth, never a throw).
  if (Array.isArray(managedPaths) && managedPaths.length) {
    const prefixes = managedPaths.filter((s) => typeof s === 'string' && s).map((s) => s.split(path.sep).join('/'));
    if (prefixes.length) {
      for (const e of entries) {
        if (e.managed) continue; // already tagged by signal (1)
        const scopeRoot = e.scope === 'global' ? homePhys : projPhys;
        if (!scopeRoot) continue;
        const rel = path.relative(scopeRoot, e.path).split(path.sep).join('/');
        if (prefixes.some((pfx) => rel === pfx || rel.startsWith(pfx.endsWith('/') ? pfx : pfx + '/'))) e.managed = true;
      }
    }
  }

  return { platform: plat, entries, inherited, flags, roleMemories: discoverRoleMemories({ projectRoot, home, flags }) };
}

// #22 ROLE-MEMORY DISCOVERY (promoted from retier.mjs's collectStores into the
// central discovery layer so gauge/wash/stats SEE per-role stores too): native
// subagent role-memories at <project>/.claude/agent-memory/<role>/ — a MEMORY.md
// index + sibling *.md topic files. Returned as a SEPARATE `roleMemories` field
// on discoverClassB (per-store), NEVER folded into `entries`.
//
// NESTED-HABITAT (the reason for the separate field, series law): a role store
// loads into a SUB when that role spawns — NOT into the MAIN every session. So
// it must be its OWN tier, never blended into the main's always-loaded
// footprint. Keeping it out of `entries` makes the main gauge (measureEntries ->
// BMI/floor/force/break-even, all off `entries`) BYTE-IDENTICAL with or without
// role dirs — a cap/verdict the ROOM acts on is computed on room-owned only,
// never on a habitat the room cannot act on (the CoalTipple-false-FULL lesson).
// This also unlocks the docketed #55 cross-store detector (per-store measures
// are its input) — but that detector is NOT built here; this is discovery+report
// only. The roster is stable (a new role dir is found by construction — a
// mirror, never a hardcoded list; the 0l capture-all discipline).
//
// Each store: { store: 'agent:<role>', dir, index: {path,bytes}|null,
// memories: [{path,bytes}], bytes, files }. Every path realpath-and-contained
// (fail-closed), symlink dirs never followed (Dirent own-type). CC-only (an
// unknown platform gets [] — the agent-memory layout is a native-subagent
// feature, conservative elsewhere, mirroring discoverClassB's own gate).
// CWK-082 findings-back F2 — `flags` is an OPTIONAL SINK, and it is the one
// channel this function has: it returns a plain array, so a role store it
// cannot read has nowhere else to announce itself. discoverClassB passes its
// own flags array (the single shipped caller). RESIDUE, named not closed: a
// future standalone caller that passes no sink still loses the notice — the
// flag is raised at the failing read either way, but nobody is listening.
// ponytail: 84 lines at declaration — MY edit took this past the 50 signal, and
// the growth is entirely the F2-R2 flag arms: five silent skips became five
// named ones, each an if-block with its own reason. Splitting them out would put
// the reason further from the skip it explains, which is the opposite of what
// the finding was about. Nesting stays AT 4, not over. The N is HISTORY.
export function discoverRoleMemories({ projectRoot = process.cwd(), home = os.homedir(), flags = [] } = {}) {
  // F2-R2, the same class at every door of this function. Each skip is
  // UNCHANGED and still fail-closed; each now says which case it took.
  const note = (what, label, code) => flags.push(refusalFlag(what, label, code));
  const projPhys = physicalOrNull(projectRoot);
  if (!projPhys) {
    const code = refusalCode(projectRoot);
    if (code) note('role stores: projectRoot', '.', code);
    return [];
  }
  const homePhys = physicalOrNull(home);
  if (!homePhys) {
    const code = refusalCode(home);
    // A refused home does not stop the walk — projPhys still anchors it — but it
    // NARROWS the containment roots, so a legitimately-home-rooted store can be
    // skipped below as out-of-roots. Say it here, where the cause is known.
    if (code) note('role stores: home', '.', code);
  }
  const roots = [homePhys, projPhys].filter(Boolean);
  const agentBase = path.join(projPhys, '.claude', 'agent-memory');
  let roles = [];
  try { roles = fs.readdirSync(agentBase, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch (err) {
    const code = (err && err.code) || 'UNKNOWN';
    // An absent agent-memory dir is the ordinary case (no role stores). Any
    // OTHER code means the dir is there and refused — a real, silent loss.
    if (code !== 'ENOENT' && code !== 'ENOTDIR') flags.push(`unreadable directory (role stores): . [${code}] — its contents are NOT counted`);
    return [];
  }
  const out = [];
  for (const role of roles) {
    const dirPhys = physicalOrNull(path.join(agentBase, role));
    if (!dirPhys) {
      const code = refusalCode(path.join(agentBase, role));
      if (code) note(`role store ${role}`, role, code);
      continue; // fail-closed, unchanged
    }
    if (!containedIn(dirPhys, roots)) {
      // THE containedIn HALF, ruled rather than left silent: `add()` already
      // flags its own out-of-roots skip (`skipped (outside home/project trees)`)
      // and this twin did not. A role dir symlinked outside the trees is still
      // REFUSED — the fail-closed behaviour is untouched — but a whole store
      // leaving the measure is not something to learn about by subtraction.
      flags.push(`skipped (outside home/project trees): role store ${role}`);
      continue;
    }
    let names = [];
    try { names = fs.readdirSync(dirPhys, { withFileTypes: true }); } catch (err) {
      // This dir came back from a Dirent that said isDirectory(), so it EXISTS:
      // any failure here is a real read failure, never the never-created case.
      flags.push(`unreadable directory (role store ${role}): ${role} [${(err && err.code) || 'UNKNOWN'}] — its contents are NOT counted`);
      continue;
    }
    let index = null;
    const memories = [];
    let bytes = 0;
    for (const d of names) {
      if (!d.isFile() || !d.name.endsWith('.md')) continue; // a symlink Dirent reports its own type — never followed
      const phys = physicalOrNull(path.join(dirPhys, d.name));
      if (!phys) {
        // ONE LOOP DEEPER than the finding names, swept in the same batch: a
        // single refused file inside a readable store drops out of the store
        // total. Measured on the shipped engine: 2 files / 1,500 B -> 1 / 300.
        const code = refusalCode(path.join(dirPhys, d.name));
        if (code) note(`role store ${role}`, `${role}/${d.name}`, code);
        continue;
      }
      if (!containedIn(phys, roots)) {
        flags.push(`skipped (outside home/project trees): ${role}/${d.name}`);
        continue;
      }
      const b = statBytes(phys);
      if (b == null) {
        flags.push(`unstattable file: ${role}/${d.name} — its bytes are NOT counted`);
        continue;
      }
      bytes += b;
      if (d.name === 'MEMORY.md') index = { path: phys, bytes: b };
      else memories.push({ path: phys, bytes: b });
    }
    if (!index && !memories.length) continue; // an empty dir is not a store
    out.push({ store: `agent:${role}`, dir: dirPhys, index, memories, bytes, files: (index ? 1 : 0) + memories.length });
  }
  return out;
}
