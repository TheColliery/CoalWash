// ponytail: 1360 lines at declaration — a dependency-isolated engine (node builtins only, no shared-lib imports by class-A design): a split multiplies the files the dist-exclusion roster and the no-auto walk must each track, and the wave loop's cut/snapshot/resume halves share offset+byte bookkeeping a module seam would sever.
// explode.mjs — the MAIN engine of CoalWash's ULTRA class-A reducer (blueprint
// §19.6, the `.jsonl`/class-A "explode-reduce" mechanism). STEP 1 of the phased
// build: the destruction/reduction engine ONLY. The SUPPORT input-verify engine
// + the destruction ladder are separate later steps.
//
// WHAT IT DOES (the data-polarity view, §19.6 rail 6): a class-A transcript is
// signal (the real user/assistant conversation) buried in noise (valueless
// bookkeeping the platform re-creates every session — session titles, editor
// mode stamps). This engine KILLS the noise: it explodes
// a file into typed units on a DISCOVERED boundary, then hard-cuts exactly the
// caller-specified obj.types, byte-exact, snapshot-backed. Everything it does
// not verify as a cut-type, it KEEPS verbatim. WHICH types read as noise is a
// PER-FILE, MEASURED question, never an assumption — the A4 ruling at
// CLAUDE_DEFAULT_CUT_TYPES records two types that LOOK like bookkeeping and are
// not (a `last-prompt` is usually the only surviving copy of a user prompt).
//
// THE 7 LOCKED RAILS (§19.6 + the 2026-07-17 refinements):
//   1. INCOMPLETE BY DESIGN — the cut-type-list is an INPUT (cutTypes), not
//      baked in. CLAUDE_DEFAULT_CUT_TYPES is an observed convenience default for
//      the known Claude shape; the passed-in list is authoritative.
//   2. EXPLODE ON DISCOVERED STRUCTURE — discoverStructure classifies a file as
//      ndjson (Claude: newline-delimited JSON) / json-single (one JSON value —
//      a pretty-printed record) / opaque (pure text/no-delimiter/binary). No
//      format is hardcoded; the type FIELD is a caller input (typeField).
//   3. WAVE LOOP — reduceFile processes ONE bounded wave (maxLines|maxBytes),
//      stops at a clean line boundary, returns { done, nextOffset, checkpoint }
//      = "run again". A 50 MB+ file is never read whole; a mid-wave death loses
//      ONE wave (the source is never mutated; the output truncates back to the
//      last committed length and resumes).
//   4. MECHANICAL ทิ้ง — remove exactly cutTypes, byte-exact. A kept unit's
//      source bytes (including its exact CRLF/LF terminator) are reproduced
//      verbatim — ZERO corruption of survivors.
//   5. RECOVERY — snapshotSource is a byte-exact, content-addressed (sha256)
//      copy taken BEFORE any real cut; identical content deduplicates by hash
//      (mechanism, not git). restoreFromSnapshot round-trips byte-exact.
//   6. FAIL-CLOSED FLOOR — structure not discoverable (opaque) → skip, never
//      cut. A single unparseable/torn/typeless unit inside an ndjson file is
//      KEPT (never cut). Every uncertainty fails toward KEEPING.
//   7. Deterministic · zero-dep (node built-ins) · factory-locked — it executes
//      the caller's verified classification, never improvises one.
//
// NAMED DIVERGENCE (one-flock): rail 3 says "readline". This engine splits on
// raw bytes (0x0A) via fs.readSync chunks instead. REASON: readline strips the
// line terminator and cannot distinguish CRLF/LF or report byte offsets — both
// fatal to byte-exact survivor bytes (rail 4) and resumable waves (rail 3). The
// byte splitter IS streaming line-by-line (constant memory, one line at a time);
// it is a strict superset of readline's behaviour, chosen for exactness.
//
// SAFETY POSTURE: this engine READS the source and WRITES a reduced slim copy to
// a SEPARATE outPath — it NEVER mutates the source in place (the source stays the
// untouched original throughout; §19's slim-copy-not-replace doctrine). Deleting
// the original is a downstream decision gated by the destruction ladder, not
// this engine. dryRun (no outPath) measures only. An outPath that aims at the
// source by ANY route (case-variant / drive-case / symlink / hardlink) is refused
// fail-closed BEFORE any write (collidesWithSource) — never a silent truncate-then-
// ok:true; and the slim copy is written to an unpredictable temp + atomic-renamed, so the
// final path is never opened 'w'.
//
// NO ACTIVE-SESSION GUARD (by design, incomplete-by-design rail 1): this engine
// inspects neither filename, mtime, nor any "in_progress" journal — it faithfully
// reduces whatever src it is handed (always to a SEPARATE slim copy; the collision
// guard means even a same-file outPath cannot truncate the source). Excluding the
// LIVE session from the input set is the CALLER's responsibility (the estate/ULTRA
// ACTIVE band); the engine must NOT grow a dev-centric "current session" guess.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// --- source-collision defense (write-side realpath-and-contain) -------------
// MIRRORED from scripts/lib/class-b.mjs (physicalOrNull/physicalForCreate) — kept
// local ON PURPOSE (named one-flock divergence): this engine is a standalone
// zero-internal-coupling byte-splitter (the break harness loads it in isolation),
// so it must not drag the config-load chain in through class-b.
//
// ⚠️ SYNC OBLIGATION, NOW PROVEN LOAD-BEARING. This copy's own comments already knew
// "realpath does NOT normalize an 8.3 short name" (see collidesWithSource), yet the
// shipped class-B guard did not — one concept, two implementations, and the one that
// had learned it never taught the other. A short-name `outPath` therefore passed the
// store-containment check and CLOBBERED a prior snapshot's recovery blob: integrity
// held (the hash check refuses wrong bytes) but the UNDO NET's availability was gone
// (blind wave R3 / TP-3). Kept BYTE-EQUIVALENT to config-load.mjs `canonicalOrNull`;
// that function is the source of truth. Change one, change the other IN THE SAME
// COMMIT — an unsynced twin makes the "idiom is stable" claim above a lie.
// CAUGHT BY THE TWIN-PIN GATE ON ITS FIRST RUN, before it shipped: the R4 fix
// removed the 8.3 OUTPUT check from the class-B side (it is a pure false positive —
// `.native` expands a genuine alias, so the branch could only ever fire on a LEGAL
// name like `backup~1`) and this twin still carried it. A fifth wave of exactly the
// drift the four before it produced. The gate is `twin-pin.test.mjs`; keep the two
// bodies behaviourally identical or it goes red.
const WIN_UNC_OR_DEVICE_RE = /^[\\/]{2}/;
function physicalOrNull(p) {
  if (typeof p !== 'string' || !p) return null;
  if (process.platform === 'win32' && WIN_UNC_OR_DEVICE_RE.test(p)) return null; // INPUT side: where the ambiguity lives
  let out;
  try { out = fs.realpathSync.native(p); } catch { return null; }
  if (process.platform === 'win32' && WIN_UNC_OR_DEVICE_RE.test(out)) return null; // a mapped network drive resolves TO a UNC
  return out;
}
// Physical form of a path ABOUT TO BE CREATED (may not exist yet): realpath the
// deepest EXISTING ancestor, then reattach the missing tail so a `..` derivation or
// a symlinked intermediate dir surfaces at its REAL location.
// EXPORTED for the SUPPORT engine (detonate.mjs) to run the SAME src-not-inside-snapshotDir
// containment check as this floor (FIX 1 belt) — reuse, don't re-derive.
export function physicalForCreate(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    const phys = physicalOrNull(cur);
    if (phys) return tail.length ? path.join(phys, ...tail.reverse()) : phys;
    // TWIN of class-b.mjs physicalForCreate — same rule, same commit (sync obligation
    // above). Climbing is only legitimate over a segment that DOES NOT EXIST YET; a
    // segment that EXISTS but that physicalOrNull refused must fail CLOSED, or the
    // lexical tail-reattach skips the resolution the refusal demanded and a junction
    // planted there aims the write outside the store.
    try { fs.lstatSync(cur); return null; } catch { /* absent -> climbing is legitimate */ }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    tail.push(path.basename(cur));
    cur = parent;
  }
}
// ---------------------------------------------------------------------------
// CASE-FOLD CAPABILITY PROBE — case-insensitivity is a property of the VOLUME (in
// fact of the DIRECTORY), never of `process.platform` (node/runtime.md §4). macOS
// APFS is POSIX *and* case-insensitive by default; an NTFS directory can be flipped
// case-SENSITIVE per-directory since Windows 10 1803 with `fsutil file
// setCaseSensitiveInfo`, no admin rights. So `process.platform === 'win32'` is wrong
// in BOTH directions, and the wrong direction is not cosmetic — see the measured
// bypass in the `foldOnMiss` note below.
//
// TWIN, DECLARED: config-load.mjs keeps a private `volumeCaseFolds` of the same
// shape. This is a DUPLICATE and not an import, because config-load.mjs pulls in
// jsonc.mjs + config-schema.mjs and this engine must load in isolation (the break
// harness), and because this engine is excluded from the shipped dist. The price of
// duplicating rather than importing is a twin-pin row over THE PROBE ITSELF, which
// is paid in twin-pin.test.mjs. The convergence that would remove the duplicate — a
// node-builtins-only leaf module both sides import — is recommended and NOT built
// here: it needs config-load.mjs (another lane) plus a LIBS-roster and dist-shape
// decision, none of which are this lane's to make.
const CASE_FOLD_CACHE = new Map();
// BOUNDED CLAIM, NAMING ITS OWN FALSIFIER — read before touching the round-trip test.
// JS's Unicode case mapping and a volume's on-disk case table are DIFFERENT FUNCTIONS.
// They agree on the ordinary case and are KNOWN to disagree by at least two unrelated
// mechanisms: EXPANSION (`ß`.toUpperCase() === 'SS', one codepoint becomes two) and
// SINGLETON/COMPATIBILITY REMAP (U+212A KELVIN SIGN, U+1E9E, U+212B ANGSTROM,
// U+2126 OHM case-map onto ordinary letters NTFS's upcase table does not equate — the
// discriminator is the CODEPOINT, not the accent: plain `Å` U+00C5 folds correctly,
// ANGSTROM U+212B does not). A third mechanism almost certainly exists. We do not own
// the OS's table and cannot enumerate it, so this function claims NO completeness: an
// absolute here can only ever be falsified by the next codepoint, never proven right.
// What is CHECKED rather than assumed: a character whose flip does not round-trip back
// to itself through its own opposite is refused, routing the whole basename to a MISS.
function flipCase(s) {
  let out = '';
  let sawCaseChar = false;
  for (const ch of s) {
    const up = ch.toUpperCase();
    const down = ch.toLowerCase();
    if (up === down) { out += ch; continue; } // no case to flip (digit, symbol, many scripts)
    if (!(ch === up ? down.toUpperCase() === ch : up.toLowerCase() === ch)) return null;
    sawCaseChar = true;
    out += ch === up ? down : up;
  }
  return sawCaseChar ? out : null;
}
// Does the directory CONTAINING `anchorPhys` fold the case of its own entries — i.e.
// could a differently-cased sibling spelling denote the SAME file? Measured, not
// assumed: flip the case of `anchorPhys`'s own basename, stat the flipped spelling in
// that same parent, compare device+inode. READ-ONLY (no write, no temp, no cleanup
// race), so the primitive stays safe on a path we merely have READ access to.
//
// BOUND: this measures the PARENT's setting, which is the right question for the
// base-vs-sibling shape a containment compare makes. It is NOT a claim about the whole
// volume, nor about a directory nested deeper than `anchorPhys` — Windows sets this
// per-directory and a deeper child may disagree with its own parent.
//
// FOUR MISS MODES, and exactly one measured-sensitive mode. THE DISTINCTION IS THE
// WHOLE POINT and stating it loosely has already misled a reader: a MISS is
// (1) the OUTER stat of `anchorPhys` failing, (2) `anchorPhys` being a filesystem root
// with no parent, (3) no case-bearing character in the basename, (4) `flipCase`
// refusing an unstable character. The INNER stat of the flipped spelling throwing is
// NOT a miss — it is the MEASUREMENT that the directory is case-SENSITIVE, and it is
// the ordinary result on ext4. Folding those two together produces the false story
// "on Linux the probe misses and falls back to folding", which is not what this code
// does in either branch.
//
// THE MISS DIRECTION IS THE CALLER'S, NEVER THIS FUNCTION'S — there is no default, and
// that is deliberate. A miss fallback is a WRONG ANSWER in one direction, and WHICH
// direction is safe is decided by the calling guard's polarity, so a single baked-in
// default is guaranteed wrong at half the call sites:
//   REFUSE-polarity (contained ⇒ refuse): over-folding refuses MORE ⇒ pass true.
//   PERMIT-polarity (contained ⇒ proceed): over-folding permits MORE ⇒ pass false.
// Measured, not reasoned: with the old platform rule, on an `fsutil`-enabled
// case-sensitive directory holding genuinely distinct `store/` and `Store/` inodes,
// `restoreFromSnapshot` published ATTACKER-CHOSEN bytes to its toPath with
// `ok:true, verified:true` from a blob living in `Store/` while the caller had declared
// `store/` — the store-boundary check at the PERMIT site folded them into one. That is
// the inject/exfil vector this file's own BREAK 2 comment claims to have closed,
// re-opened along the case axis.
//
// FORGEABILITY, BOUNDED: anyone who can write to `anchorPhys`'s PARENT can plant a
// junction/hardlink at the flipped spelling (no admin) and push the probe toward
// `folds:true`. That is safe at a REFUSE caller (folding more only refuses more) and is
// an EXPOSURE at a PERMIT caller, which must treat this answer as untrusted input
// rather than assume the opposite default rescues it. The reverse forgery is not
// available through junctions (a plant can only make a failing stat succeed), but that
// is a claim about junctions and NOT a claim that a wrong `folds:false` cannot arise at
// all — the JS-vs-OS mapping mismatch bounded above is a separate, non-forgery route to
// exactly that, which is why it is routed to MISS instead of trusted.
//
// CACHES MEASURED ANSWERS ONLY, keyed on the exact path — never on `st.dev` (Windows
// sets this per-directory, so a device-keyed cache would learn from whichever directory
// probed first and misapply it to every other directory on the drive). A MISS is never
// cached: its value depends on the CALLER's `foldOnMiss`, so caching one would let the
// first caller's polarity freeze a wrong answer for the other one, process-wide.
//
// SUSPECTED, NOT CONFIRMED, RECORDED WITH ITS POLARITY: a MEASURED answer is never
// re-probed, so a directory whose case-sensitivity setting is toggled MID-PROCESS keeps
// its first reading. The direction matters and does not need re-deriving: a stale
// `folds:true` read by a PERMIT-polarity caller is an exposure in EXACTLY the direction
// this unit closed (over-folding admits a case-variant sibling); a stale `folds:false`
// there is safe (it only ever over-refuses). Both engines in this repo are short-lived
// CLI processes and this is unreached in practice — recorded as a bound, not fixed.
function volumeCaseFolds(anchorPhys, foldOnMiss) {
  if (CASE_FOLD_CACHE.has(anchorPhys)) return CASE_FOLD_CACHE.get(anchorPhys);
  let st;
  try { st = fs.statSync(anchorPhys, { bigint: true }); } catch { return foldOnMiss; } // miss (1)
  const parent = path.dirname(anchorPhys);
  const flipped = parent === anchorPhys ? null : flipCase(path.basename(anchorPhys)); // miss (2)/(3)/(4)
  if (flipped === null) return foldOnMiss;
  let folds;
  try {
    const flippedSt = fs.statSync(path.join(parent, flipped), { bigint: true });
    folds = flippedSt.dev === st.dev && flippedSt.ino === st.ino;
  } catch {
    folds = false; // MEASURED case-sensitive (the flipped spelling is not the same file) — NOT a miss
  }
  CASE_FOLD_CACHE.set(anchorPhys, folds);
  return folds;
}
// ---------------------------------------------------------------------------

// THE THREE-STATE CONTAINMENT ANSWER — 'inside' | 'outside' | 'unknown'.
//
// WHY THIS EXISTS (rung-5 §1.2, a CLASS not an instance): the old boolean conflated "provably
// outside" with "cannot tell", and `null` was folded into `false` under a comment claiming
// "fail-closed". That claim is only true where contained == PERMITTED. At a guard whose polarity
// is contained == REFUSE, `false` means ALLOW — so an unresolvable path walked straight through
// the guard. `physicalOrNull` returns null for every win32 UNC/device spelling BY DESIGN, and a
// broken junction anywhere in the ancestor chain produces one too, so this was reachable with
// `path.toNamespacedPath()` — Node's own documented helper, no exotic input required.
//
// The lesson, kept at the primitive so it cannot be re-learned per call site: **`null` is not a
// safe default; it is a value, and its meaning is decided by the CALLER'S POLARITY.** A boolean
// cannot carry that. This function refuses to answer when it does not know, and each caller must
// then say what "unknown" means for its own direction:
//   contained == PERMITTED  → require 'inside'   (`isContainedIn`, unchanged semantics)
//   contained == REFUSE     → require 'outside'  (`!== 'outside'` refuses inside AND unknown)
//
// `foldOnMiss` IS REQUIRED AND HAS NO DEFAULT — see `volumeCaseFolds` above for why a
// single baked-in default is guaranteed wrong at half the call sites. An OMITTED or
// non-boolean argument answers 'unknown', which REFUSES at both polarities
// (`!== 'outside'` refuses it; `=== 'inside'` refuses it) — so forgetting the argument
// fails CLOSED everywhere instead of silently inheriting the wrong direction. A plain
// `foldOnMiss = false` default would have failed OPEN at every REFUSE site.
export function containment(childPhys, basePhys, foldOnMiss) {
  if (typeof foldOnMiss !== 'boolean') return 'unknown';
  if (!childPhys || !basePhys) return 'unknown';
  const folds = volumeCaseFolds(basePhys, foldOnMiss); // anchored on the BASE — the twin anchors there too
  const norm = (s) => (folds ? s.toLowerCase() : s);
  const c = norm(childPhys);
  const b = norm(basePhys);
  return (c === b || c.startsWith(b.endsWith(path.sep) ? b : b + path.sep)) ? 'inside' : 'outside';
}
// Is `childPhys` the same as, or nested under, `basePhys`? Both args are PHYSICAL paths
// (realpath'd or physicalForCreate'd). Case-folding is decided by a real probe of the base's
// own directory, never by `process.platform` — see `volumeCaseFolds` above.
// PERMIT-POLARITY ONLY: unknown answers false, which is fail-closed *for a caller that
// requires containment to proceed* — never use this at a guard where containment means REFUSE;
// use `containment(..., true) !== 'outside'` there.
// THE MISS DIRECTION IS `false` (do NOT fold) AND IT IS NOT INHERITED FROM THE REFUSE SITES:
// at a PERMIT gate, folding a case-variant that the volume treats as a DISTINCT file turns
// "prove this is inside my store" into "permit a sibling directory I do not own" — measured as a
// live inject/exfil through `restoreFromSnapshot` (see `volumeCaseFolds`). Under-folding here
// costs at most a false REFUSAL of a legitimate case-variant ref, which is recoverable; the other
// direction publishes attacker-chosen bytes. The per-site derivation is pinned as a TEST in
// explode.test.mjs ('PERMIT vs REFUSE take OPPOSITE miss directions'), not left as this comment.
// EXPORTED so detonate.mjs reuses the identical containment primitive for its FIX 1 belt.
export function isContainedIn(childPhys, basePhys) {
  return containment(childPhys, basePhys, false) === 'inside';
}
// Does `candidate` resolve to the SAME physical file as `src` by any route a lexical
// path.resolve compare misses? TWO complementary checks (verified on win32):
//   (1) realpath BOTH sides + case-fold on win32 — realpath does NOT normalize
//       case or drive-letter case on Windows, so the fold is REQUIRED; catches a
//       case-variant, a c:/C: drive-case difference, and a symlink. `candidate`
//       may not exist yet, so physicalForCreate realpaths its deepest ancestor.
//   (2) dev+ino compare — catches a HARDLINK (a distinct name AND distinct realpath
//       but one underlying inode, which realpath is blind to). Skipped when ino is
//       unreported (0) to avoid false-positives on a filesystem without inodes.
// Returns a reason string on collision, else null.
// EXPORTED for the SUPPORT engine (detonate.mjs) to pre-check outPath aliasing BEFORE it triggers a
// reduction — reuse, don't re-derive this security-critical realpath-both-sides + dev/ino check.
export function collidesWithSource(candidate, src, srcFd) {
  const srcPhys = physicalOrNull(src);
  const candPhys = physicalForCreate(candidate);
  if (srcPhys && candPhys) {
    // CONVERTED with the containment primitives, not left on `process.platform` — demand 3 of the
    // twin unit: leaving this folding by PLATFORM while gate-4's belts fold by VOLUME is mixed
    // variants on two sides of one gate sequence, the exact bug class the header above already
    // names for `.native`-vs-plain. REFUSE-polarity (a match REFUSES the candidate), so a probe
    // MISS folds — over-folding reports a collision that is not one and costs a false refusal,
    // while under-folding MISSES a real case-variant alias and lets outPath truncate the source.
    // Anchored on `srcPhys`: the question is whether a differently-cased candidate name can denote
    // THIS file, which is its own parent directory's setting.
    // NOT merely a win32 fix — this closes a LIVE miss on macOS APFS, which is case-insensitive
    // and NOT win32, so the old rule did not fold there and a case-variant outPath aliasing the
    // source went undetected on the very platform whose default volume folds.
    const folds = volumeCaseFolds(srcPhys, true);
    const norm = (s) => (folds ? s.toLowerCase() : s);
    if (norm(srcPhys) === norm(candPhys)) return 'resolves to the source (case-variant / drive-case / symlink / same path)';
  }
  // dev+ino hardlink check — realpath is BLIND to a hardlink (distinct name AND distinct realpath, one inode).
  // WAVE-8 HARDENING: this now works even when the caller passes NO srcFd (we open src ourselves), so a consumer
  // trusting collidesWithSource ALONE is safe. Pre-fix a bare `collidesWithSource(candidate, src)` did
  // `fs.fstatSync(undefined)` → threw → caught → returned null = MISSED the hardlink (fail-OPEN). Every in-tree
  // caller passes srcFd (unchanged fast path); the self-open fires only for a bare (candidate, src) call.
  let ownFd = null;
  try {
    // BIGINT STATS ARE REQUIRED FOR CORRECTNESS ON win32, not a micro-optimisation.
    // An NTFS 64-bit File ID routinely exceeds 2^53, so the default NUMBER `ino`
    // is a ROUNDED double: measured on this box, ino ~3.3e16 has a ulp of 4, and
    // 4000 distinct files produced 5 identical (dev, ino) pairs. That made this
    // guard FALSE-POSITIVE on two unrelated files — refusing a legitimate reduce
    // and turning the suite random-red (blind wave R1 / TP-1, a 788/790 run).
    // `{ bigint: true }` compares the ID exactly: 0 collisions over the same 4000
    // files, and a real hardlink is still detected. The guard is not weakened —
    // the rounding was the bug, so exact compare removes the false positive
    // WITHOUT relaxing the true-positive hardlink catch.
    const opts = { bigint: true };
    let s;
    if (srcFd !== undefined && srcFd !== null) {
      s = fs.fstatSync(srcFd, opts);
    } else {
      ownFd = fs.openSync(src, 'r'); // src unopenable → throws → caught → null (not a detectable hardlink)
      s = fs.fstatSync(ownFd, opts);
    }
    const c = fs.statSync(candidate, opts); // an absent candidate throws → cannot be a hardlink to src
    if (s.ino !== 0n && s.dev === c.dev && s.ino === c.ino) return 'is a hardlink to the source (same device + inode)';
  } catch { /* candidate absent / src unopenable → not a detectable hardlink to src */ }
  finally { if (ownFd !== null) { try { fs.closeSync(ownFd); } catch { /* best effort */ } } }
  return null;
}

// Observed convenience default for the known Claude .jsonl shape (rail 1 — the
// PASSED-IN list is authoritative; this is only a fallback for the Claude
// platform). These two are pure UI/editor state the platform re-stamps every
// session (never the conversation): custom-title = the session label, mode =
// the editor mode stamp. Deliberately EXCLUDED (kept): user/assistant (the
// conversation), attachment (real file content), system (may carry meaningful
// directives), and the two types the A4 ruling below removed.
//
// THE A4 FIDELITY RULING (2026-07-25) — the default was RE-SCOPED from four types
// to this proven-lossless PAIR. A transcript census measured the two dropped
// types and neither is the valueless bookkeeping their names suggest:
//   · last-prompt     — in 64% of cases the unit is the SOLE surviving copy of a
//                       user prompt, NOT a re-stamped echo of a line that also
//                       lives on as a `user` unit. Cutting it blind destroys real
//                       user text that exists nowhere else in the file.
//   · queue-operation — content-free only CONDITIONALLY: a ~4% tail carries
//                       free-form payload. Lossless on most files, lossy on some
//                       — and "usually safe" is exactly what disqualifies a type
//                       from a BLIND default.
// The bar for membership here is not "usually noise", it is LOSSLESS ON EVERY
// FILE IT MEETS SIGHT-UNSEEN, because this list is what gets applied when the
// caller expressed no preference and nobody looked at the file.
//
// THE SAFE CONTRACT — how to cut MORE (deliberate, never blind): this default is a
// FLOOR, not a ceiling, and it is not the recommended path. A caller that wants
// last-prompt, queue-operation, or anything else cut passes an EXPLICIT cutTypes
// list DERIVED FROM THAT FILE's own survey — detonate's per-type `freeFormCount`
// (0 = content-free in THIS file) is the evidence that makes the cut deliberate
// instead of assumed. Per-file measurement is what makes an aggressive cut safe;
// baking the same type into the blind default is what made it unsafe. Do NOT
// re-add a type to this list to spare a caller the survey.
//
// PROVENANCE + THE ENGINE/AGENT BOUNDARY (harvested from the session's explode
// prototype, which reduced a real 50 MB Claude session 94.8%): the prototype hit
// that number by ALSO exploding assistant/attachment/system AND semantically
// filtering the surviving `user` lines — dropping user-ROLE lines that are
// actually noise (tool_result blocks, hook-injected <system-reminder>/<local-
// command>/<command-*>/<task-notification>, "[SYSTEM NOTIFICATION", compaction
// "This session is being continued", "Stop hook feedback:", "Caveat: The
// messages below"). That semantic drop is the AGENT's บีบ/ย่อ/ข้าม layer (§19.6
// rail 5), NOT this engine's mechanical ทิ้ง — and it belongs to the SEPARATE
// input-verify/distill step, not here. This engine stays purely mechanical: it
// cuts a `user` unit only if the caller puts 'user' in cutTypes; it never peers
// inside message.content to judge a survivor. The safe default therefore cuts
// ONLY the two un-debatable UI-state types; a caller wanting the aggressive
// digest passes its own bigger list, measured per the safe contract above.
export const CLAUDE_DEFAULT_CUT_TYPES = Object.freeze(['custom-title', 'mode']);

const NL = 0x0a;
// EXPORTED (CHUNK + DEFAULT_MAX_LINES + DEFAULT_MAX_BYTES) so detonate's gate references the SAME memory-
// granularity + line/byte budgets the engine actually reads with — single source of truth, no magic-number
// drift. A wave READS up to CHUNK per iteration, so a per-wave budget BELOW one CHUNK (or a maxLines that
// drains less than a chunk) cannot bound memory (a CHUNK is already buffered) and only forces the wave to
// re-read the chunk tail next wave = the O(waves × CHUNK) re-read explosion (L4) — the gated entry rejects a
// sub-floor budget. DEFAULT_MAX_BYTES is ALSO the gated CEILING: a per-wave budget ABOVE the factory budget
// lets ONE wave buffer the whole file's kept lines (peak RAM O(filesize) — the MEMORY twin of the re-read
// explosion), so the gated entry rejects an over-ceiling budget too (see detonate gate 5 / MAX_WAVE_LINES).
export const CHUNK = 1 << 20; // 1 MiB read granularity
export const DEFAULT_MAX_LINES = 20000; // per-wave line budget (bounded work — rail 3) · also the gated maxLines FLOOR
export const DEFAULT_MAX_BYTES = 16 * 1024 * 1024; // per-wave source-byte budget (16 × CHUNK) · also the gated maxBytes CEILING
// WAVE-8 L4-B: the TOTAL re-read work of a wave-DRIVEN reduce (reduceToCompletion) may not exceed this multiple
// of the FILESIZE. A sub-CHUNK per-wave budget on a file larger than one chunk re-reads a full chunk PER WAVE →
// projected re-read = waves × CHUNK; amplification = (waves × CHUNK)/size = CHUNK/advance, so an 8× cap requires
// advance ≥ CHUNK/8 ≈ 128 KiB. The OLD fixed 2 GiB absolute projection was too COARSE: a "merely terrible"
// sub-chunk budget (e.g. maxLines:64 on a 6 MB file ≈ 1900 waves ≈ 20 s of byte-identical output) projected
// ~1.9 GB < 2 GiB and sailed through. A filesize-RELATIVE cap refuses it while a legit sub-CHUNK budget (512 KiB
// → amplification 2×) still runs; a tiny file (< CHUNK) can never explode so it is exempt by the `size > CHUNK`
// guard below (the byte-exact tiny-file/tiny-budget tests stay permissive).
const REREAD_AMPLIFICATION_CAP = 8; // re-read work ceiling as a multiple of filesize (waves × CHUNK ≤ 8 × size) — the >CHUNK projection cap (upfront + after-wave-1 belts, and the >CHUNK cumulative regime)
// WAVE-14 L4 (the residual the blind red-team pinned AGAIN): the ≤CHUNK cumulative re-read ceiling is PURELY
// size-relative (REREAD_SUBCHUNK_CAP × size, NO absolute floor). The WAVE-13 form carried a Math.max(16 × size,
// 512 KiB) "trivial-I/O floor" — but that floor DOMINATED every sub-32 KiB file, so the ceiling was effectively
// "512 KiB of total re-read regardless of filesize", NOT a multiple of the file's OWN size: a ~4 KB dense file at
// maxLines:1 completed (ok:true, byte-correct) after re-reading 131× its own size, still "under" the 512 KiB floor.
// The floor was added to spare trivial I/O; it re-opened the exact hole it sat beside. Removing it bounds the ratio
// at EVERY size. CONSEQUENCE (correct, not a regression): a tiny file at a pathological tiny budget now REFUSES once
// re-read passes 16 × size — a few-KB file has no legit reason to wave (it fits one pass at any sane budget), so the
// refusal is right; a small file at a SANE budget stays well under 16 × size and completes byte-correct.
//
// THE ≤CHUNK MULTIPLE (measured, not guessed): a ≤CHUNK wave re-reads its whole shrinking TAIL every wave (scanWave
// reads min(CHUNK, tail) = the tail for a sub-CHUNK file), so a legit N-wave reduce re-reads ~N/2 × size — the suite's
// legit worst (bigCorpus(5000) / maxLines:300 → 17 waves) sits at 9.8× reReadAccum, well above the >CHUNK regime's 8×
// (a >CHUNK wave re-reads only ~one CHUNK, so 8× ⇔ advance ≥ CHUNK/8). The pathological grinds (WAVE-10: maxBytes:8192
// / 470 KB → 32×; the repro: maxLines:1 → 131×) sit far above. REREAD_SUBCHUNK_CAP = 16 bisects (9.8×, 32×) with
// ~1.6× / 2× margin. It is DISTINCT from REREAD_AMPLIFICATION_CAP on purpose (a named divergence): the two regimes
// have different per-wave re-read physics, so one constant cannot serve both — raising the shared cap to 16 would let
// a 64 KiB budget on a >CHUNK file (16× projected) sail past the projection guard.
const REREAD_SUBCHUNK_CAP = 16; // ≤CHUNK cumulative re-read ceiling multiple (whole-tail-per-wave physics; between the 9.8× legit-max and the 32× refuse-min; PURELY size-relative — no absolute floor, WAVE-14 L4)
// NB: both AUTO-path bounds are the trusted-loop (reduceToCompletion) ONLY; the BARE hand-driven path is already size-
// relative via minWaveAdvance (ceil(size / MAX_BARE_RESUME_WAVES) → ≤16 waves → re-read ≤ ~32× size). The generator on
// the AUTO path is scanWave re-reading min(CHUNK, tail) every wave (NOT a per-wave whole-source hash — that anchor runs
// only on !_trustedResume), so it cannot be removed without breaking the stateless-resumable-wave / crash-recovery
// design (a resume must re-read from its offset; it cannot carry an in-memory buffer across a process death) → the
// ceiling is the fix, not an incremental-hash change (the AUTO path's source-integrity check is ALREADY incremental).
// The BARE (hand-driven, !_trustedResume) resume wave-count cap. A bare resumed wave re-reads ~2× the WHOLE
// source EVERY wave (the L3 checkpoint anchor re-hashes the whole source + re-reduces the prefix [0, offset) —
// see minWaveAdvance), so its re-read is O(waves × size); the ONLY way to bound it is to bound the WAVE COUNT.
// ≤ this many resumed waves ⇒ total bare re-read ≤ ~2 × this × the filesize on EVERY size. 16 leaves 2× headroom
// above the largest legit bare drive the suite exercises (8 waves) while refusing every repro grind. DISTINCT
// from REREAD_AMPLIFICATION_CAP (a NAMED divergence): the trusted loop re-reads only ~one CHUNK + its own advance
// per wave, so it is bounded by the CHUNK-relative REREAD_AMPLIFICATION_CAP, not this size-relative wave cap.
const MAX_BARE_RESUME_WAVES = 16;
const DISCOVER_SAMPLE_LINES = 64;
const DISCOVER_SAMPLE_BYTES = 512 * 1024;
const DEFAULT_SLURP_CAP = 8 * 1024 * 1024; // a json-single file above this = opaque (don't slurp to verify)
// #7 DISPOSITION (accept): a file whose sampled FRONT is ≥ this rate of per-line
// JSON IS ndjson by definition — a cuttable line embedded in mostly-JSON "prose"
// gets cut (snapshot-backed), while every non-JSON line stays fail-closed KEPT. No
// cheap precision win exists (the front sample cannot see later prose without a
// full-file re-read), and a ≥90%-JSON doc is a pathological shape.
const NDJSON_MIN_PARSE_RATE = 0.9; // sample parse-rate for ndjson (tolerates a torn tail, rejects text/logs)

// The BARE-resume per-wave floor: the minimum bytes a hand-driven (untrusted, !_trustedResume) RESUMED wave must
// advance the offset. It bounds the re-read by bounding the WAVE COUNT to MAX_BARE_RESUME_WAVES.
// WHY size-relative (not CHUNK-relative): a BARE resumed wave re-reads ~2× the WHOLE source every wave — the L3
// ground-truth anchor re-hashes the whole source (sha256File, O(size)) AND re-reduces the prefix [0, offset)
// (O(offset)) to prove the checkpoint against the content-addressed snapshot; only the snapshot blob is reused.
// So the re-read is O(waves × size), and the only way to bound it is to bound the wave count: a wave that advances
// ≥ ceil(size / MAX_BARE_RESUME_WAVES) can happen at most MAX_BARE_RESUME_WAVES times, keeping the total bare
// re-read ≤ ~2 × MAX_BARE_RESUME_WAVES × the filesize on EVERY size. The offset is snapshot-anchored ground truth
// (the L3 anchor pins [0, offset) to the snapshot every wave), so a persisted/rebuilt checkpoint can neither reset
// nor forge it. The trusted drive loop (reduceToCompletion) does NOT pay this per-wave whole-source cost (it skips
// the anchor and re-reads only ~one CHUNK + its own advance per wave), so it is bounded by its OWN cumulative cap
// (REREAD_AMPLIFICATION_CAP, CHUNK-relative), NOT this floor — applying this floor there would wrongly refuse a
// legit small-budget many-wave reduce (the WAVE-9 L3 control), a NAMED divergence: different per-wave cost ⇒
// different floor.
// HISTORY (the WAVE-12 recalibration): the retired formula was `size > CHUNK ? CHUNK/CAP : size²/(CAP·CHUNK)`.
// It was calibrated for the trusted loop's CHUNK-per-wave cost but got APPLIED to the bare path's size-per-wave
// cost, so it (a) collapsed below one record for small files (a 15,575-byte file → a ~29-byte floor → a 1-record
// advance sailed through → 953× re-read at ok:true) and (b) pinned to a fixed 128 KiB above CHUNK (an 8 MiB file
// at maxBytes:132000 → 64 waves → 103× at ok:true). Bounding the wave count directly closes both.
function minWaveAdvance(size) {
  return Math.ceil(size / MAX_BARE_RESUME_WAVES);
}

// ---------------------------------------------------------------------------
// low-level byte-exact line streaming
// ---------------------------------------------------------------------------

// Read [start, start+len) from fd into a fresh buffer (loops until satisfied or
// EOF). Explicit position → never touches the fd cursor (deterministic).
function readRange(fd, start, len) {
  const buf = Buffer.allocUnsafe(len);
  let got = 0;
  while (got < len) {
    const n = fs.readSync(fd, buf, got, len - got, start + got);
    if (n <= 0) break;
    got += n;
  }
  return got === len ? buf : buf.subarray(0, got);
}

// Write the WHOLE buffer to fd, looping over SHORT writes. POSIX write(2) may write fewer bytes than
// asked and return the count WITHOUT throwing (the real disk-full / EINTR / overlay-fs shape) — a raw
// fs.writeSync that ignores the return publishes a TORN file yet reports success. The FIRST call keeps
// the bare (fd, buf) signature (write the whole buffer from position 0); the loop writes only the
// unwritten remainder. Zero progress on a non-empty remainder = genuine disk-full → THROW (caught by
// reduceFile's body try → ok:false, temp reaped). The loop cannot spin: each iteration advances `off`
// or throws.
function writeFull(fd, buf) {
  let off = fs.writeSync(fd, buf); // first write — bare signature (whole buffer)
  while (off < buf.length) {
    const n = fs.writeSync(fd, buf, off, buf.length - off); // remainder only
    if (n <= 0) throw new Error(`short write: only ${off}/${buf.length} bytes written (no progress — disk full?)`);
    off += n;
  }
  return off;
}

// The utf8 text of a line for PARSING only (its exact bytes are what we keep).
// Strips a single trailing \n and a preceding \r. Invalid utf8 → U+FFFD → the
// JSON.parse fails → the unit is KEPT (fail-closed), never mis-cut.
export function lineText(lineBuf) {
  let end = lineBuf.length;
  if (end > 0 && lineBuf[end - 1] === NL) end--;
  if (end > 0 && lineBuf[end - 1] === 0x0d) end--;
  return lineBuf.toString('utf8', 0, end);
}

// Stream complete lines from fd starting at `startOffset`, invoking
// onLine(lineBuf, isLast) with the EXACT source bytes of each line (terminator
// included, except a final line with no newline). Stops after a completed line
// once maxLines OR maxBytes is reached (a line is atomic — never split), or at
// EOF. Returns { nextOffset, done }: nextOffset is always a clean line boundary,
// so a wave that stops mid-file leaves no torn carry (the remainder is re-read
// next wave). Memory = one line + one chunk at a time (never the whole file).
//
// BYTE BUDGET DURING ACCUMULATION (fail-closed): maxBytes/maxLines only stop on a
// line EMIT, so a file with NO newline (or a single unit >> maxBytes) would grow
// `carry` unbounded — a 100 MB "line" O(n²)-concats into multi-GB and OOMs. So the
// unconsumed carry is bounded by maxBytes too: once it reaches maxBytes with no
// newline WHILE MORE DATA IS PENDING (offset < size), this single line is larger
// than the whole wave budget = PATHOLOGICAL — stop and return { overlong: true }.
// The caller treats overlong as opaque/skip (never emit the runaway carry, never
// cut). Read overshoot is bounded to maxBytes + one CHUNK.
//   FIX 2-R3 — the overlong check is gated on `offset < size` (MORE data pending).
// At true EOF (offset >= size) the carry IS the final line — a legitimate final
// unit with no trailing newline (the engine's documented mid-write shape) whose
// bytes merely exceed a small maxBytes must NOT be misclassified as pathological;
// the loop exits and the EOF handler below emits it BYTE-EXACT. Reaching EOF with
// carry >= maxBytes is only possible when the terminal read completes the file, so
// the carry stays bounded (< maxBytes + one CHUNK) — a truly oversized MID-file
// unit (carry >= maxBytes AND offset < size) still correctly flags overlong.
// EXPORTED for the SUPPORT engine (detonate.mjs) to stream a file's units for its advisory report
// (whole-file, constant-memory) — reuse this byte-exact splitter, don't re-derive it. Behavior-preserving.
export function scanWave(fd, size, startOffset, maxLines, maxBytes, onLine) {
  let offset = startOffset;
  let carry = null; // bytes read but not yet a complete line
  let carryStart = startOffset; // source offset of carry[0]
  let lines = 0;
  let bytes = 0;
  while (offset < size) {
    if (lines >= maxLines || bytes >= maxBytes) return { nextOffset: carryStart, done: false };
    const toRead = Math.min(CHUNK, size - offset);
    const region = readRange(fd, offset, toRead);
    if (!region.length) break;
    offset += region.length;
    carry = carry ? Buffer.concat([carry, region]) : region;
    let base = 0;
    let idx;
    while ((idx = carry.indexOf(NL, base)) !== -1) {
      const lineBuf = carry.subarray(base, idx + 1); // includes \n; no-mutation invariant → safe to hold
      onLine(lineBuf, false);
      lines++;
      bytes += lineBuf.length;
      carryStart += lineBuf.length;
      base = idx + 1;
      if (lines >= maxLines || bytes >= maxBytes) return { nextOffset: carryStart, done: false };
    }
    carry = base < carry.length ? carry.subarray(base) : null; // keep the unconsumed tail; carryStart already tracks it
    // FIX 2-R3: overlong fires ONLY when more data is pending (offset < size) — a truly oversized MID-file
    // unit. At EOF (offset >= size) the carry is the final no-newline line → fall through to the EOF handler
    // (emitted byte-exact), never misclassified as pathological when maxBytes < its bytes but > the prefix.
    if (offset < size && carry && carry.length >= maxBytes) return { nextOffset: carryStart, done: false, overlong: true }; // single line > wave budget mid-file → pathological
  }
  if (carry && carry.length) { onLine(carry, true); } // EOF: final line with no trailing \n (incl. one whose bytes exceed a small maxBytes — FIX 2-R3)
  return { nextOffset: size, done: true };
}

// ---------------------------------------------------------------------------
// structure discovery (rail 2 / rail 6)
// ---------------------------------------------------------------------------

// Classify an open file WITHOUT reading it whole: sample the front, decide by
// per-line JSON-parseability. A leading UTF-8 BOM is detected and reported as a
// structural prefix (bomLen) the reducer always preserves — never part of a
// cuttable unit. Returns { structure: 'ndjson'|'json-single'|'opaque', bomLen,
// reason }.
export function discoverStructure(fd, size, { sampleLines = DISCOVER_SAMPLE_LINES, sampleBytes = DISCOVER_SAMPLE_BYTES, slurpCapBytes = DEFAULT_SLURP_CAP } = {}) {
  if (!size) return { structure: 'opaque', bomLen: 0, reason: 'empty file' };
  const head = readRange(fd, 0, Math.min(3, size));
  const bomLen = head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 3 : 0;

  let sampled = 0;
  let parsed = 0;
  let lastParsed = true;
  let lastIsEof = false;
  const scan = scanWave(fd, size, bomLen, sampleLines, sampleBytes, (lineBuf, isLast) => {
    const text = lineText(lineBuf);
    if (!text.trim()) return; // blank lines don't count toward the parse-rate
    sampled++;
    let ok = true;
    try { JSON.parse(text); } catch { ok = false; }
    if (ok) parsed++;
    lastParsed = ok;
    lastIsEof = isLast; // true only for the EOF line with no trailing newline
  });
  // A torn EOF tail (a half-flushed final object, no trailing newline) is the
  // EXPECTED mid-write shape of a live transcript — it is not evidence against
  // ndjson, so it is excluded from the rate denominator. During the reduce it is
  // KEPT verbatim ONLY because it fails to parse (rail 6: unparseable → never cut);
  // a COMPLETE final line that merely lacks a trailing newline still parses and IS
  // cut when its type is in cutTypes, exactly like any other unit. Everything else
  // counts.
  const tornTail = lastIsEof && !lastParsed;
  const denom = sampled - (tornTail ? 1 : 0);
  if (denom >= 1 && parsed / denom >= NDJSON_MIN_PARSE_RATE) {
    return { structure: 'ndjson', bomLen, reason: `ndjson (${parsed}/${sampled} sampled lines parsed${tornTail ? ', torn tail excluded' : ''})` };
  }
  // Newline-SPARSE front: the sample scan bailed on a single line larger than its
  // whole byte budget (overlong). It is not ndjson, and slurp-verifying would
  // re-read the very bytes we just bounded → fail-closed to opaque WITHOUT the
  // slurp (this is the memory bound: a 100 MB single line is never materialized).
  if (scan.overlong) {
    return { structure: 'opaque', bomLen, reason: 'newline-sparse front exceeds the sample byte budget (not ndjson; not slurp-verified — pathological single line)' };
  }
  // Not line-delimited JSON. A small file MIGHT be one pretty-printed JSON value
  // (a single record) — verify by slurping (bounded by slurpCapBytes). Above the
  // cap we refuse to slurp → opaque → fail-closed skip.
  if (size - bomLen <= slurpCapBytes) {
    try {
      JSON.parse(readRange(fd, bomLen, size - bomLen).toString('utf8'));
      return { structure: 'json-single', bomLen, reason: 'single JSON value' };
    } catch { /* not a single JSON value either */ }
  }
  return { structure: 'opaque', bomLen, reason: `no ndjson delimiter (sample ${parsed}/${sampled} parsed) and not a single JSON value${size - bomLen > slurpCapBytes ? ' (too large to slurp-verify)' : ''}` };
}

// A parsed unit's type token, or null. Only a plain object's string-valued
// `typeField` is a type; an array/number/string/typeless unit yields null and is
// therefore NEVER cut (a cut needs a VERIFIED type in cutSet — rail 6).
// #14 (WONTFIX, contrived): a duplicate `type` key (e.g. {"type":"user","type":"mode"})
// resolves last-wins per the JSON spec (JSON.parse), so the last value decides the
// cut. No JSON serializer emits duplicate keys, so a platform never writes this; a
// raw-byte type scan to "fix" it would be wrong (spec-divergent) and costly.
function unitType(obj, typeField) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const t = obj[typeField];
  return typeof t === 'string' ? t : null;
}

// ---------------------------------------------------------------------------
// the reducer (one wave)
// ---------------------------------------------------------------------------

function fail(reason) {
  return {
    ok: false, skipped: false, reason, structure: null, dryRun: true,
    unitsSeen: 0, unitsCut: 0, unitsKept: 0, unitsUnparsed: 0, bytesSeen: 0, bytesCut: 0, bytesKept: 0,
    done: true, nextOffset: 0, checkpoint: null, outPath: null, snapshotPath: null,
  };
}

// Reduce ONE bounded wave of `src`. cutTypes = the authoritative cut-list;
// typeField = where the type lives (default 'type'). outPath omitted → DRY-RUN
// (measure, write nothing). A REAL cut requires snapshotDir (rail 5: no
// snapshot, no destroy). Drive it across waves with reduceToCompletion, or by
// hand: pass back { offset: r.nextOffset, resume: r.checkpoint } until r.done.
export function reduceFile(src, opts = {}) {
  const {
    cutTypes: cutTypesRaw, typeField = 'type',
    outPath = null, snapshotDir = null,
    offset = 0, resume = null,
    maxLines = DEFAULT_MAX_LINES, maxBytes = DEFAULT_MAX_BYTES,
    sampleLines = DISCOVER_SAMPLE_LINES, sampleBytes = DISCOVER_SAMPLE_BYTES,
    slurpCapBytes = DEFAULT_SLURP_CAP,
    // INTERNAL flag — set ONLY by reduceToCompletion's own loop, which feeds back its OWN self-consistent
    // checkpoints on a source it verifies once at completion. It SKIPS the per-wave resume ground-truth anchor
    // (cluster 1) so a many-wave drive never pays O(waves × size). A bare / hand-driven / crash-recovery
    // reduceFile resume (the untrusted surface) leaves it false → the anchor runs (closes L3 + L-META).
    _trustedResume = false,
  } = opts || {};
  const dryRun = !outPath;
  // BREAK 3-A (WAVE-7 L4 — the exported PRIMITIVE self-guards its own cutTypes, no longer trusting the
  // detonate wrapper): ONLY an OMITTED (undefined) cutTypes takes the convenience factory default; every
  // other NON-ARRAY (null / {} / a bare string / a number) is a MALFORMED request → REFUSE fail-closed,
  // never silently run a byte-identical no-op rewrite (the pre-fix `Array.isArray(x) ? x : []` filtered a
  // non-array to an empty set and ran ok:true unitsCut:0). An array with no usable string entry ([] or
  // [123]) → REFUSE ("nothing to cut"). Mirrors detonate's gate so a DIRECT call is as safe as the gate.
  if (cutTypesRaw !== undefined && !Array.isArray(cutTypesRaw)) {
    return fail(`cutTypes must be an array or omitted (got ${cutTypesRaw === null ? 'null' : 'a ' + typeof cutTypesRaw}) — a non-array request is refused, never silently defaulted`);
  }
  // L4 nit (WAVE-9): an EXPLICIT array must be ALL non-empty strings. A MIXED array (['mode', null]) was
  // silently `.filter`-sanitized to its string subset and then RAN a DESTRUCTIVE write — violating the
  // project's no-silent-sanitize-and-continue standard (coding-style.md / ASVS V2: reject bad input, never
  // sanitize-and-continue). Fail-closed on ANY non-string / empty-string element (count only, never the raw
  // value — a Symbol throws when stringified, same discipline as the maxLines reason below). The omitted
  // factory default is all-strings by construction, so it never trips this.
  if (Array.isArray(cutTypesRaw)) {
    const bad = cutTypesRaw.filter((t) => typeof t !== 'string' || t.length === 0).length;
    if (bad) return fail(`cutTypes must contain only non-empty strings — ${bad} invalid entr${bad === 1 ? 'y' : 'ies'} (a mixed cut-list is refused, never silently sanitized to its string subset and run)`);
  }
  const cutSet = new Set((cutTypesRaw === undefined ? CLAUDE_DEFAULT_CUT_TYPES : cutTypesRaw).filter((t) => typeof t === 'string'));
  if (!cutSet.size) return fail('no string cut-types requested (an empty / all-non-string cut-list is refused — nothing to cut; omit cutTypes for the factory default)');
  // #4: a per-wave budget of 0 (or negative / NaN) makes NO wave ever emit a line → the wave loop
  // re-discovers + re-snapshots the file ~10M times before the guard trips. Fail-closed on a
  // non-positive budget. (Infinity = "one unbounded wave" stays valid: `Infinity >= 1` is true.)
  // The `typeof` short-circuits BEFORE the `>= 1` coercion, so a Symbol / valueOf-throwing object can
  // never throw a TypeError out of the API here; the reason interpolates `typeof` (never the raw value,
  // which would itself throw when stringified for a Symbol).
  if (typeof maxLines !== 'number' || !(maxLines >= 1)) return fail(`maxLines must be a number >= 1 (got a ${typeof maxLines})`);
  if (typeof maxBytes !== 'number' || !(maxBytes >= 1)) return fail(`maxBytes must be a number >= 1 (got a ${typeof maxBytes})`);
  let fd;
  try { fd = fs.openSync(src, 'r'); } catch (e) { return fail(`cannot open source: ${e.message}`); }
  // #1/#7: the output fd + its unpredictable temp are tracked at FUNCTION scope so the single catch/finally
  // below closes the fd and removes the unpublished temp on ANY throw — the documented exports never
  // propagate a raw fs error; they always return { ok:false }. The happy path nulls both once consumed
  // (fd closed, temp renamed), so the finally is a pure safety net that fires only on the throw path.
  let out = null;
  let tmpPath = null;
  // F2 [MEDIUM, rung-2 R1 lab] — UNPREDICTABLE temp name, not `${outPath}.${pid}.tmp`. This is the
  // SAME fix `snapshotSource`'s blob temp already carries (see its own comment for the full
  // reasoning): a pid is guessable/observable, so a per-pid temp path can be PRE-PLACED by anyone
  // able to write the destination directory. Lab W2 attacked all 5 structurally-identical
  // `O_EXCL`-guarded write-temp sites in this file; only the blob temp had this fix, and the other
  // 4 (this one, the json-single output temp, the ndjson-output temp, and restoreFromSnapshot's own
  // temp) still used the predictable form. All 5 held under attack ON THIS BOX only because
  // file-symlink creation is EPERM here without Developer Mode — the SAME limitation the blob
  // temp's own comment already names as unconfirmed, not refuted. If that deeper claim is ever true
  // on some box, it was true at all 4 unfixed sites, not just the one that had been fixed — closed
  // here at all 4, one flock. Random naming removes the PRECONDITION (an attacker cannot pre-place
  // at a path it cannot predict) rather than arguing about EXCL semantics; EXCL stays as the second
  // belt (cross-nature: one guard defeats prediction, the other defeats a race).
  // ONE suffix, generated ONCE per call (not per wave): wave-1 is the only wave that ever creates
  // this temp (a resume wave appends to the already-published outPath, see below), and the SAME
  // string must be used by the pre-flight collision/containment checks below AND the actual write —
  // checking one candidate and writing a DIFFERENT one would validate a string that is never used.
  const tmpSuffix = dryRun ? '' : crypto.randomBytes(12).toString('hex');
  try {
    // Refuse to write the slim copy over the SOURCE by ANY route a lexical
    // path.resolve compare misses (case-variant on a case-insensitive FS, c:/C:
    // drive-case, symlink, or a hardlink) — the wave-1 'w' open would TRUNCATE the
    // source BEFORE it is read, and the old lexical guard silently returned ok:true
    // after destroying it. Fail-closed, BOTH sides realpath'd (series hard-won rule)
    // + a dev/ino check realpath cannot do. Also guards the unpredictable temp so IT can
    // never alias the source either.
    if (!dryRun) {
      const detail = collidesWithSource(outPath, src, fd) || collidesWithSource(`${outPath}.${tmpSuffix}.tmp`, src, fd);
      if (detail) return fail(`outPath must differ from the source: ${detail} — writing over it would truncate the source before reading (in-place replace is the destruction ladder's gated step)`);
      // #6: the slim copy (and its temp) must never land INSIDE the snapshot store — writing over
      // manifest.jsonl or a content-addressed blob would corrupt the rail-5 recovery net the cut
      // rests on. REFUSE-POLARITY: only a PROVEN 'outside' may proceed, so an unresolvable path
      // (win32 device spelling, broken junction in the chain) refuses instead of walking through —
      // the old `isContainedIn(...)` folded that unknown into false == ALLOW (rung-5 §1.2).
      if (snapshotDir) {
        const snapReal = physicalForCreate(snapshotDir);
        if (containment(physicalForCreate(outPath), snapReal, true) !== 'outside' || containment(physicalForCreate(`${outPath}.${tmpSuffix}.tmp`), snapReal, true) !== 'outside') { // REFUSE-polarity: a probe MISS folds (over-refuses)
          return fail(`outPath must not resolve inside the snapshot store (${snapshotDir}), and must be resolvable enough to prove it — it would overwrite a recovery blob or manifest`);
        }
        // FIX 1 (source-sacred): src must not resolve INSIDE snapshotDir either. snapshotSource appends
        // manifest.jsonl (and writes content blobs) into snapshotDir — a src that IS the manifest path
        // (basename manifest.jsonl with snapshotDir == dirname(src)) or a blob path gets CORRUPTED by that
        // recovery write. The guard asymmetry only checked outPath; mirror it to src — REFUSE-polarity,
        // so unknown refuses (this is the site whose "fail-closed" comment was false before §1.2).
        if (containment(physicalOrNull(src), snapReal, true) !== 'outside') { // REFUSE-polarity: a probe MISS folds (over-refuses)
          return fail(`src must not resolve inside the snapshot store (${snapshotDir}) — snapshotSource writes the manifest/blobs there and would corrupt the source`);
        }
        // FIX 1-R2 (source-sacred, the ALIAS the FIX 1 path-guard above misses): the path-containment
        // check only catches a src whose PATH resolves inside snapshotDir. It does NOT catch a
        // <snapshotDir>/manifest.jsonl that is a HARDLINK to a src living OUTSIDE snapshotDir — snapshotSource's
        // appendFileSync follows the hardlink and writes the manifest row INTO the source (sha changes,
        // ok:true, silent). Guard the manifest WRITE TARGET against aliasing src the same way outPath is
        // guarded — collidesWithSource (realpath both sides + the dev/ino hardlink check realpath is blind
        // to), fail-closed. FIX 1's path-guard STAYS above (defense-in-depth); this adds the alias guard
        // the write target always needed. (A legit manifest.jsonl is a fresh regular file — distinct inode,
        // distinct realpath — so this never false-refuses a normal / resumed run.)
        if (collidesWithSource(path.join(snapshotDir, SNAPSHOT_MANIFEST), src, fd)) {
          return fail('the snapshot manifest path aliases the source (hardlink / dev+ino) — the manifest append would corrupt the source');
        }
      }
    }
    const size = fs.fstatSync(fd).size;
    // L4 CLASS FIX (WAVE-11) — the re-read amplification ceiling is now a GROUND-TRUTH per-wave floor enforced AFTER
    // the scan (see the minWaveAdvance check below the overlong branch), NOT a caller-supplied `readAccum` counter.
    // The retired counter lived in the checkpoint the caller holds and passes back as `resume`; a persist-then-resume
    // caller who reset/omitted it re-armed the O(size²) explosion at ok:true (the OMITTED case == the FORGED case).
    // The floor is derived from the offset (which the L3 anchor pins to the content-addressed snapshot), so it can be
    // neither reset nor reconstructed. reduceToCompletion drives its OWN in-loop cumulative ceiling (also ground-truth).
    // Discover once, on wave 1 (offset 0). A resumed wave trusts the first wave's
    // discovery carried in `resume` (the file is not re-sampled mid-stream).
    const struct = offset === 0
      ? discoverStructure(fd, size, { sampleLines, sampleBytes, slurpCapBytes })
      : { structure: (resume && resume.structure) || 'ndjson', bomLen: (resume && resume.bomLen) || 0 };

    // COMPLETENESS (checkpoint `structure` field, fail-closed): only ndjson produces a resumable wave
    // (json-single/opaque are single-shot — they return done:true, checkpoint:null, never a resume). So a
    // resume (offset !== 0) whose checkpoint carries a NON-ndjson structure is a forged/corrupt token — a
    // 'json-single' would route to the whole-file json-single branch below and IGNORE the offset (rewriting
    // the whole file, ok:true); an 'opaque' would hit the skip below (ok:true, false success). Refuse it BEFORE
    // the snapshot/write. Unreachable via detonate (gate 5 rejects offset/resume) — a raw-drive GIGO close.
    if (offset !== 0 && struct.structure !== 'ndjson') {
      return fail(`resume: only ndjson has resumable waves (checkpoint structure '${struct.structure}' is a forged/corrupt token — refused)`);
    }

    if (struct.structure === 'opaque') {
      return {
        ok: true, skipped: true, structure: 'opaque', reason: struct.reason, dryRun,
        unitsSeen: 0, unitsCut: 0, unitsKept: 0, unitsUnparsed: 0, bytesSeen: 0, bytesCut: 0, bytesKept: 0,
        done: true, nextOffset: size, checkpoint: null, outPath: null, snapshotPath: null,
      };
    }

    // DATA-level no-op fast-path for json-single (cluster 2C / WAVE-8 L4-C): the whole file is ONE unit — decide
    // cut-ness NOW, BEFORE the snapshot. If its type is NOT requested, a "real cut" would just rewrite the whole
    // file byte-identical = a no-op; take the zero-I/O skip (no snapshot, no rewrite) uniform with the opaque
    // skip, never a byte-identical copy reported ok:true/skipped:false (the fix-7 "extract" contract was too
    // narrow — a byte-identical rewrite is not a legitimate extract on ANY structure). A MATCH (cut the lone
    // unit → empty output) IS a real cut and falls through to the snapshot + json-single branch below.
    if (struct.structure === 'json-single' && !dryRun) {
      const buf = readRange(fd, 0, size);
      const body = struct.bomLen ? buf.subarray(struct.bomLen) : buf;
      let obj = null;
      try { obj = JSON.parse(body.toString('utf8')); } catch { /* verified in discovery — defensive */ }
      if (!cutSet.has(unitType(obj, typeField))) {
        return {
          ok: true, skipped: true, structure: 'json-single',
          reason: 'the single record is not a requested cut-type — nothing to cut (no-op skip, source untouched, no snapshot/output written)', dryRun,
          unitsSeen: 1, unitsCut: 0, unitsKept: 1, unitsUnparsed: 0, bytesSeen: size, bytesCut: 0, bytesKept: size,
          done: true, nextOffset: size, checkpoint: null, outPath: null, snapshotPath: null,
        };
      }
    }

    // Rail 5: a real cut is snapshot-gated on EVERY wave, not wave 1 alone. Take the
    // content-addressed snapshot on wave 1; a resumed wave carries its path via `resume`
    // for the TRUSTED loop only (below) — an UNTRUSTED hand-driven resume never trusts
    // that string.
    //
    // PRE-FIX DEFECT (rung-2 rail-5, CRITICAL, source-confirmed): this whole gate lived
    // inside `if (!dryRun && offset === 0)`, so a direct `reduceFile(src, {offset:N>0, ...})`
    // — a shipped, documented calling convention (see `_trustedResume`'s own comment above,
    // naming exactly this as the untrusted surface) — never required `snapshotDir` at all,
    // and `snapshotPath` below was seeded straight from the caller-supplied `resume.snapshotPath`
    // with NO check that any blob existed there. Content was destroyed, `ok:true` returned, and
    // the reported `snapshotPath` could name a blob nobody ever created — a caller reading that
    // field believes an undo net exists when none does; worse than a bare bypass, since a bypass
    // that REPORTS a net makes the caller act as if one is there.
    let snapshotPath = (resume && resume.snapshotPath) || null;
    let snapWasFresh = false; // L4 nit-b: true when THIS call COPIED a new blob (not a dedup of a shared one)
    if (!dryRun) {
      if (!snapshotDir) return fail('refusing to reduce without snapshotDir (rail 5: no snapshot, no destroy)');
      if (offset === 0) {
        const snap = snapshotSource(src, snapshotDir);
        if (!snap.ok) return fail(`snapshot failed: ${snap.reason}`);
        snapshotPath = snap.snapshotPath;
        snapWasFresh = !snap.deduped;
      } else if (!_trustedResume) {
        // UNTRUSTED resume: never trust the caller's `resume.snapshotPath` string — it is
        // public input (`sha256File` is exported, so anyone can compute a plausible-looking
        // name), and `src` is opened read-only for the whole reduce (never mutated by this
        // engine across waves — the write goes to `outPath`, a different file by construction;
        // `collidesWithSource` above already refuses `outPath === src`). So the true wave-1
        // blob's content-address is INDEPENDENTLY RE-DERIVABLE from `src`'s current bytes; a
        // legitimate multi-wave drive's source has not changed since the snapshot was taken,
        // so this is exact, not a heuristic. Compute the expected path ourselves and require a
        // REAL, self-consistent (filename === its own hash) blob to exist there — a forged,
        // stale, or never-created claim refuses. The caller-supplied string is never read.
        const expected = path.join(snapshotDir, sha256File(src));
        let verified = false;
        try { verified = fs.existsSync(expected) && sha256File(expected) === path.basename(expected); } catch { /* unreadable -> not verified */ }
        if (!verified) return fail('resume: no verifiable snapshot blob for this source in the store (rail 5: no snapshot, no destroy)');
        snapshotPath = expected;
      }
      // _trustedResume (reduceToCompletion's own loop, offset>0): keeps the `snapshotPath`
      // already carried from `resume` above, unchanged. It was created by THIS SAME trusted
      // call chain a few lines up the loop, never caller-forgeable, and re-hashing `src` on
      // every wave to re-verify it would cost O(waves x size) for no added safety — the same
      // performance trade the resume ground-truth anchor below already makes for this exact flag.
    }

    // json-single: the whole (small, already-verified) file is exactly one unit.
    // DISPOSITION (#8): a type-match cuts the WHOLE file to empty. Kept cuttable ON
    // PURPOSE — rail 1 makes cutTypes authoritative (the caller decides), the cut is
    // snapshot-backed, and it fires ONLY on the caller putting this lone value's type
    // in cutTypes (the CLAUDE default types are ndjson bookkeeping, so a stray
    // json-single record is kept by default). A caller who does not want it cut
    // simply omits its type.
    if (struct.structure === 'json-single') {
      const buf = readRange(fd, 0, size);
      const body = struct.bomLen ? buf.subarray(struct.bomLen) : buf;
      let obj = null;
      try { obj = JSON.parse(body.toString('utf8')); } catch { /* verified in discovery — defensive */ }
      const cut = cutSet.has(unitType(obj, typeField));
      if (!dryRun) {
        fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
        // OWNERSHIP, NOT DETECTION: `tmpPath` is the finally's reap target, so it is assigned only
        // AFTER the exclusive create RETURNS. Assigning it first made a non-null `tmpPath` mean
        // "a temp path was computed"; it now means "we created this file, so we may delete it".
        // See the reap comment in the finally for the measured defect this closes.
        const candidate = `${outPath}.${tmpSuffix}.tmp`;
        out = fs.openSync(candidate, 'wx'); // unpredictable temp, O_EXCL: a fresh inode, or EEXIST-fail-closed — never write THROUGH a pre-existing alias (hardlink/symlink) planted at tmpPath; the final path is never opened 'w'
        tmpPath = candidate; // created by US → the reaper owns it
        if (!cut) writeFull(out, buf); // kept → byte-exact whole file; cut → empty (writeFull loops short writes)
        fs.fsyncSync(out);
        fs.closeSync(out); out = null;
        const tmpSize = fs.statSync(tmpPath).size, wantSize = cut ? 0 : buf.length; // belt: never publish a torn temp
        if (tmpSize !== wantSize) throw new Error(`refusing to publish a torn output: temp is ${tmpSize} of ${wantSize} bytes`);
        fs.renameSync(tmpPath, outPath); tmpPath = null; // atomic publish (on any throw above, the finally closes the fd + removes the temp)
      }
      return {
        ok: true, skipped: false, structure: 'json-single', dryRun,
        unitsSeen: 1, unitsCut: cut ? 1 : 0, unitsKept: cut ? 0 : 1, unitsUnparsed: 0,
        bytesSeen: size, bytesCut: cut ? size : 0, bytesKept: cut ? 0 : size,
        done: true, nextOffset: size, checkpoint: null, outPath: dryRun ? null : outPath, snapshotPath,
      };
    }

    // ndjson: wave-scan from the resume offset (bomLen on wave 1).
    const startOffset = offset === 0 ? struct.bomLen : offset;
    // Resume-state validation (offset > 0): the checkpoint is a caller-persisted
    // token — bound it fail-closed so a foreign / tampered / torn / premature resume
    // cannot throw uncaught, and a tampered snapshot BLOB is caught by the restore
    // hash-verify. (The source is only READ, never a source risk.) HONEST LIMIT
    // (FIX 6-R2, was over-claimed): a forged but in-range `resume.outLen` on a
    // hand-driven manual resume is GIGO on a trusted checkpoint token (documented at
    // the guard below) — it CAN tear or drop a line in the OUTPUT; only an OUT-OF-RANGE
    // outLen is mechanically refused (proving in-range truth needs a full re-scan). This
    // is UNREACHABLE through the guarded entry points detonate() / reduceToCompletion(),
    // which never accept a caller offset/resume — only a raw hand-driven reduceFile reaches it.
    if (offset !== 0) {
      // COMPLETENESS (checkpoint `offset`/`srcOffset` field, fail-closed BOTH directions): a resume offset
      // must sit in (0, size]. offset > size was already refused; a NEGATIVE offset previously skipped this
      // whole block (`offset > 0` was false) and only fail-closed via a downstream readSync throw — make it
      // an EXPLICIT refusal so both directions are validated at the gate, not by a caught exception.
      if (offset < 0 || offset > size) return fail(`resume: offset ${offset} out of range [1, ${size}] (a resume continues an in-progress wave)`);
      if (startOffset > 0 && startOffset < size) {
        const prevByte = readRange(fd, startOffset - 1, 1); // must sit right after a newline
        if (!(prevByte.length === 1 && prevByte[0] === NL)) return fail('resume: offset is not on a line boundary (torn fragment refused)');
      }
      if (!dryRun) {
        if (!fs.existsSync(outPath)) return fail('resume: outPath does not exist (nothing to append to — foreign or premature checkpoint)');
        // Recovery-path fail-CLOSED (same class as the restore-store fix): a resumed wave MUST carry a
        // FINITE outLen. A missing / NaN / Infinity / non-object outLen previously coerced to 0 →
        // truncateSync(outPath, 0) silently WIPED the prior committed output, re-appended partial, and
        // still reported ok:true. A checkpoint is persisted + reloaded for crash recovery, so a corrupt
        // one is a real scenario, not just caller misuse — refuse, never truncate-to-0-and-append. This
        // guard DOMINATES the write-setup truncate below (same offset>0 && !dryRun path runs first).
        if (!(resume && Number.isFinite(resume.outLen))) return fail('resume: a resumed wave requires a finite outLen (corrupt/forged checkpoint — refused)');
        const curOutSize = fs.statSync(outPath).size;
        const committed = resume.outLen; // validated finite just above
        // L3#2 (WAVE-6, fail-closed BOTH directions): the committed outLen MUST equal the output's CURRENT
        // size. The old guard only rejected outLen > curOutSize (zero-extend); an outLen SHRUNK below the true
        // committed length was in-range, so truncateSync(outPath, committed) dropped GOOD committed bytes, the
        // resume re-appended from the (correct) srcOffset, and the seam between the forged length and the true
        // one was a silently-torn output reported ok:true. The engine has no independent record of the true
        // committed length (the checkpoint IS the record), so the only sound check without a full re-scan is:
        // the output on disk must already sit at EXACTLY the checkpoint's length — any disagreement (a partial
        // crash tail OR a forged shrink) fails closed. A clean multi-wave loop (reduceToCompletion) always
        // satisfies this (each wave writes then records the exact length). A crash-recovery caller that TRUSTS
        // its persisted checkpoint truncates the output to `committed` ITSELF, then resumes — the truncate
        // decision moves to the caller who owns the trust, never blind on an attacker-controllable token.
        if (committed !== curOutSize) return fail(`resume: outLen ${committed} must equal the output file size ${curOutSize} (a resume continues from the EXACT committed length — a smaller value would drop committed bytes into a torn seam, a larger would zero-extend; truncate to the trusted checkpoint length before resuming)`);
        // RESUME GROUND-TRUTH ANCHOR (cluster 1 / WAVE-8 L3 + L-META): the checks above validate each checkpoint
        // field IN ISOLATION (offset in range + on a line boundary · outLen finite + == the output size ·
        // structure ndjson) but NEVER consult the held snapshot — so a checkpoint whose fields disagree with
        // EACH OTHER (L3: an offset that implies more/fewer consumed records than outLen → records dropped or
        // duplicated at the resume seam) or with the ACTUAL source (L-META: the source rewritten since the
        // checkpoint → a v1-prefix + v2-suffix splice) passes and tears the output at ok:true. The snapshot the
        // checkpoint references IS the byte-exact source AS OF the checkpoint (content-addressed) — use it as the
        // anchor: it was HELD but UNUSED here (a bogus snapshotPath used to return ok:true). Skipped for
        // reduceToCompletion's own trusted, self-consistent loop (_trustedResume — it verifies source-stability
        // ONCE at completion). ponytail: (a) is O(size) + (b) is O(offset) per BARE resume — fine for a single
        // crash-recovery resume; the trusted loop skips it so a many-wave drive never pays O(waves × size).
        if (!_trustedResume) {
          // (a) SOURCE-DESYNC: the current source must STILL hash to the checkpoint snapshot's content-address
          // (its basename is the sha256 of the source as of the checkpoint). A source changed since the
          // checkpoint = fail-closed refuse, never splice two source states.
          // `resume` is non-null HERE BY DOMINANCE, not by luck: the outLen guard above (same
          // `offset !== 0 && !dryRun` block) already refused a falsy resume, so the old `resume &&`
          // was provably dead. Naming the dependency instead of re-testing it — if that guard ever
          // moves out from under this block, this line is one of the things that must move with it.
          const expectSha = typeof resume.snapshotPath === 'string' ? path.basename(resume.snapshotPath) : '';
          if (!/^[0-9a-f]{64}$/.test(expectSha)) {
            return fail('resume: a real-cut resume requires the checkpoint snapshotPath (the content-addressed source anchor) — missing or malformed (forged/corrupt checkpoint refused)');
          }
          if (sha256File(src) !== expectSha) {
            return fail('resume: the source changed since the checkpoint (its sha256 no longer matches the held snapshot) — refusing to splice a torn output across two source states (restore from the snapshot)');
          }
          // (b) OFFSET↔OUTLEN: re-derive the committed length by reducing the source prefix [0, offset) with the
          // SAME cut logic (the source is now proven == the snapshot). A forged/stale (offset, outLen) pair —
          // individually valid but mutually inconsistent — reduces to a DIFFERENT length than claimed → refuse.
          let derivedOutLen = struct.bomLen || 0; // BOM is preserved verbatim (outLen starts at the BOM length)
          scanWave(fd, offset, struct.bomLen || 0, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, (lineBuf) => {
            const lt = lineText(lineBuf);
            if (!lt.trim()) { derivedOutLen += lineBuf.length; return; } // blank line kept verbatim
            let po = null, pOk = true;
            try { po = JSON.parse(lt); } catch { pOk = false; }
            if (!(pOk && cutSet.has(unitType(po, typeField)))) derivedOutLen += lineBuf.length; // kept (unparseable/typeless/non-cut)
          });
          if (derivedOutLen !== committed) {
            return fail(`resume: checkpoint (offset ${offset}, outLen ${committed}) is inconsistent — the source prefix [0, ${offset}) reduces to ${derivedOutLen} bytes, not ${committed} (a forged/stale checkpoint would drop or duplicate records at the resume seam — refused)`);
          }
        }
      }
    }

    // Write setup: wave 1 → an unpredictable TEMP (atomic-renamed to outPath at wave end, so
    // the final path is NEVER opened 'w'); resume waves append to the published
    // outPath (an 'a' after truncate-to-committed, not a truncate-to-zero).
    let outLen = 0; // out + tmpPath are function-scoped (declared above for the catch/finally)
    if (!dryRun) {
      if (offset === 0) {
        fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
        // OWNERSHIP-AFTER-CREATE (same rule as the json-single site above): the reap target is set
        // only once the exclusive create has succeeded, so the finally can never unlink a file the
        // engine did not make.
        const candidate = `${outPath}.${tmpSuffix}.tmp`;
        out = fs.openSync(candidate, 'wx'); // O_EXCL fresh inode (source-sacred by construction — same class as the json-single temp + the manifest); wave-1 rename breaks any hardlink at outPath before a resume ever appends
        tmpPath = candidate; // created by US → the reaper owns it
        if (struct.bomLen) { writeFull(out, readRange(fd, 0, struct.bomLen)); outLen = struct.bomLen; } // BOM is structural — always preserved (writeFull loops short writes)
      } else {
        // Resume: append to the published outPath. The `committed === curOutSize` guard above makes this
        // truncate a PROVABLE NO-OP (the output already sits at the committed length) — kept purely as
        // defense-in-depth (if that guard is ever relaxed, this still pins the file to the committed length
        // before appending, never a coerce-to-0 wipe). The caller owns any partial-tail truncate BEFORE
        // resuming (see the outLen guard note) — the engine never truncates on an untrusted checkpoint length.
        const committed = resume.outLen;
        fs.truncateSync(outPath, committed);
        out = fs.openSync(outPath, 'a');
        outLen = committed;
      }
    }

    let unitsSeen = 0;
    let unitsCut = 0;
    let unitsKept = 0;
    let unitsUnparsed = 0;
    let bytesSeen = 0;
    let bytesCut = 0;
    let bytesKept = 0;
    const kept = []; // this wave's kept line bytes, flushed once at wave end (bounded by maxBytes)
    // CLUSTER 1 / L3 (WAVE-9): in the TRUSTED drive loop reduceToCompletion feeds back its own checkpoints
    // and (pre-fix) verified the source ONCE at completion (whole-file sha vs the wave-1 snapshot). That
    // was defeated two ways: (a) a mid-loop change REVERTED to the snapshot's hash before completion → the
    // end check passed → torn v1-prefix+vN-suffix at ok:true; (b) even a non-reverted change was caught only
    // AFTER the torn bytes were appended → a crash in that window left a torn COMMITTED output. Fix: hash the
    // exact bytes this wave CONSUMES (live, from the lines scanWave emits — cut, kept, AND blank, in order =
    // exactly [startOffset, nextOffset)) and, BELOW, compare against the snapshot's SAME range BEFORE the
    // flush. Revert-proof (we hash what we consumed, not a re-read a revert can race) and torn-proof (a bad
    // wave never flushes). Only in the trusted loop's write path; a hand-driven resume keeps its own anchor.
    const regionHash = (!dryRun && _trustedResume) ? crypto.createHash('sha256') : null;

    const onLine = (lineBuf) => {
      bytesSeen += lineBuf.length;
      if (regionHash) regionHash.update(lineBuf); // consumed-region hash: EVERY line's exact bytes, before the cut branch
      const text = lineText(lineBuf);
      if (!text.trim()) { bytesKept += lineBuf.length; if (out) kept.push(lineBuf); return; } // blank line — structural, kept verbatim
      unitsSeen++;
      let obj = null;
      let parsed = true;
      try { obj = JSON.parse(text); } catch { parsed = false; }
      if (!parsed) unitsUnparsed++;
      const cut = parsed && cutSet.has(unitType(obj, typeField)); // unparseable/typeless → cut=false → KEPT (rail 6)
      if (cut) { unitsCut++; bytesCut += lineBuf.length; return; }
      unitsKept++;
      bytesKept += lineBuf.length;
      if (out) kept.push(lineBuf);
    };

    const r = scanWave(fd, size, startOffset, maxLines, maxBytes, onLine);
    if (r.overlong) {
      // A single unit larger than the whole wave byte-budget is pathological (a wave-budget-sized
      // "line" can never be emitted → it would loop forever or OOM). Fail-closed: never emit the
      // runaway carry, never cut. out/tmpPath are cleaned by the finally — a wave-1 temp is
      // discarded (outPath never created); a resume's committed outPath fd is closed but its
      // published bytes remain (source untouched throughout).
      if (offset === 0 || dryRun) {
        // Wave 1 (or any dry-run measure): nothing was ever published → the file is genuinely
        // KEPT WHOLE / untouched (opaque skip).
        return {
          ok: true, skipped: true, structure: 'opaque',
          reason: 'a single unit exceeds the wave byte-budget (pathological line — fail-closed skip, source untouched)', dryRun,
          unitsSeen: 0, unitsCut: 0, unitsKept: 0, unitsUnparsed: 0, bytesSeen: 0, bytesCut: 0, bytesKept: 0,
          done: true, nextOffset: size, checkpoint: null, outPath: null, snapshotPath,
        };
      }
      // #5 real resume: prior waves already published a PARTIAL reduction at outPath — byte-exact
      // for what it holds but INCOMPLETE (the loop cannot pass the giant line). NOT the "kept
      // whole/untouched" skip signal: fail-closed (ok:false) so the caller never mistakes the
      // partial for a finished reduce; outPath is reported (reduceToCompletion propagates it, so
      // both entry points agree), and the snapshot backs full recovery.
      return {
        ok: false, skipped: false, structure: 'ndjson',
        reason: 'a single unit exceeds the wave byte-budget mid-stream (pathological line — reduction abandoned; a partial reduced file remains at outPath, source untouched, restore from snapshot)', dryRun,
        unitsSeen: 0, unitsCut: 0, unitsKept: 0, unitsUnparsed: 0, bytesSeen: 0, bytesCut: 0, bytesKept: 0,
        done: true, nextOffset: size, checkpoint: null, outPath, snapshotPath,
      };
    }
    // L4 AMPLIFICATION CEILING (WAVE-11/12) — GROUND-TRUTH per-wave floor bounding the BARE resumed-wave COUNT.
    // Untrusted hand-driven resume ONLY (offset > 0, !_trustedResume): reduceToCompletion runs its own in-loop
    // cumulative ceiling; wave 1 (offset 0) is not amplification; a `done`/overlong wave is handled above. Each bare
    // resumed wave re-reads ~2× the whole source (the L3 anchor re-hashes it + re-reduces the prefix), so bounding
    // the COUNT to MAX_BARE_RESUME_WAVES bounds the total re-read (see minWaveAdvance). The advance is measured from
    // the snapshot-anchored offset (ground truth) so the caller cannot reset or reconstruct it. Placed AFTER the
    // overlong branch so an overlong wave keeps its own abandoned verdict, and BEFORE the flush so a refused wave
    // leaves the committed output byte-intact (the resume opened outPath 'a' but nothing is appended until the flush).
    if (offset !== 0 && !_trustedResume && !r.done) {
      const advance = r.nextOffset - startOffset;
      const floor = minWaveAdvance(size);
      if (advance < floor) {
        return fail(`per-wave budget too small for the ${size}-byte file — this resumed wave advanced only ${advance} bytes (below the ${floor}-byte floor = ceil(size / ${MAX_BARE_RESUME_WAVES})). A hand-driven resumed wave re-reads ~2× the whole source (the L3 checkpoint anchor re-hashes the source + re-reduces the prefix), so the floor caps the resumed-wave count at ${MAX_BARE_RESUME_WAVES} to keep total re-read within ~${2 * MAX_BARE_RESUME_WAVES}× the filesize (an O(waves × size) explosion otherwise). The floor is derived from the snapshot-verified offset, so a persisted checkpoint cannot reset it. Raise maxBytes/maxLines or omit them for the safe defaults`);
      }
    }
    // DATA-level no-op fast-path for ndjson (cluster 2C / WAVE-8 L4-C): a wave that processed the WHOLE file in
    // ONE pass (offset===0 → done) and cut NOTHING is a byte-identical no-op — do NOT publish a wasteful rewrite;
    // return skipped:true, uniform with the opaque/json-single skip. (A MULTI-wave all-absent reduce is caught at
    // reduceToCompletion's completion level.) The unpublished temp is reaped by the finally.
    // L4 nit-b (WAVE-9): match json-single's no-op (which takes NO snapshot) — a streaming ndjson pass MUST
    // snapshot before it can know cut===0, so a blob was written; if it was FRESH this call (snapWasFresh —
    // NOT a dedup of a blob another source references) remove it so a no-op leaves no orphan, and report
    // snapshotPath:null like json-single. Guarded on snapWasFresh: never unlink a shared/pre-existing blob.
    // ponytail: the manifest AUDIT row for this run is left (an aid, not a gate — a restore of that original
    // then cleanly refuses on the absent blob); deleting one row mid-file is not worth the churn.
    if (!dryRun && offset === 0 && r.done && unitsCut === 0) {
      if (snapWasFresh && typeof snapshotPath === 'string') {
        try { fs.unlinkSync(snapshotPath); } catch { /* best-effort: a no-op leaves no orphan; a shared/absent blob is simply left */ }
        snapshotPath = null;
      }
      return {
        ok: true, skipped: true, structure: 'ndjson',
        reason: 'none of the requested cut-types are present — nothing to cut (no-op skip, source untouched, no output/snapshot written)', dryRun,
        unitsSeen, unitsCut: 0, unitsKept, unitsUnparsed, bytesSeen, bytesCut: 0, bytesKept,
        done: true, nextOffset: size, checkpoint: null, outPath: null, snapshotPath,
      };
    }
    // CLUSTER 1 / L3 (WAVE-9) — INCREMENTAL source-integrity check, BEFORE the flush. The bytes this wave
    // consumed ([startOffset, r.nextOffset)) must byte-match the wave-1 snapshot's SAME range; on the FINAL
    // wave the snapshot must ALSO end exactly where we stopped (a source truncated to a shorter prefix
    // mid-loop is a change too — the short-read + size guards cover grow/shrink, the digest covers a
    // same-length content swap). A mismatch THROWS → the body catch returns ok:false and the flush below
    // NEVER runs, so no torn (spliced) bytes ever land in the committed output; the finally reaps the wave-1
    // temp / leaves a resume's committed prefix byte-intact (source untouched — restore from the snapshot).
    // O(size) total across the loop (regions are forward-disjoint); this REPLACES the old end-only check.
    if (regionHash && snapshotPath) {
      const regionLen = r.nextOffset - startOffset;
      const snap = sha256FileRange(snapshotPath, startOffset, regionLen);
      const desync = snap.read !== regionLen                       // source grew / snapshot shorter than the region
        || snap.digest !== regionHash.digest('hex')                // same-position content changed
        || (r.done && fs.statSync(snapshotPath).size !== r.nextOffset); // final wave: source truncated to a shorter prefix
      if (desync) {
        throw new Error(`source changed mid-reduction: the bytes consumed this wave [${startOffset}, ${r.nextOffset}) no longer match the wave-1 snapshot — refusing to append a torn (spliced) output (restore from the snapshot)`);
      }
    }
    if (out) {
      if (kept.length) { const blob = Buffer.concat(kept); writeFull(out, blob); outLen += blob.length; } // writeFull loops short writes → no torn flush
      fs.fsyncSync(out);
      fs.closeSync(out); out = null;
      if (tmpPath) {
        const tmpSize = fs.statSync(tmpPath).size; // belt: never publish a torn temp as ok:true
        if (tmpSize !== outLen) throw new Error(`refusing to publish a torn output: temp is ${tmpSize} of ${outLen} bytes`);
        fs.renameSync(tmpPath, outPath); tmpPath = null; // wave 1: atomic publish (temp → final)
      }
    }
    return {
      ok: true, skipped: false, structure: 'ndjson', dryRun,
      unitsSeen, unitsCut, unitsKept, unitsUnparsed, bytesSeen, bytesCut, bytesKept,
      done: r.done, nextOffset: r.nextOffset,
      checkpoint: r.done ? null : { srcOffset: r.nextOffset, outLen, structure: 'ndjson', bomLen: struct.bomLen || 0, snapshotPath },
      outPath: dryRun ? null : outPath, snapshotPath,
    };
  } catch (e) {
    return fail(`reduce failed: ${e.message}`); // #1: ANY fs error (bad outPath, ENOTDIR, rename race, disk full…) → ok:false, never a raw throw
  } finally {
    // Non-throwing cleanup (each op is individually caught so the finally can never mask the return):
    // close the output fd and remove the unpublished temp if a throw left them behind. On the
    // happy path both are already null (fd closed, temp renamed) → this is inert. #7: a temp orphaned
    // between write and rename is reaped here. (A stale temp from an EARLIER crashed run is not swept
    // here — this cleanup only knows and reaps the ONE randomly-suffixed `tmpPath` this call itself
    // created; a leftover from a prior run carries a DIFFERENT random suffix and is simply invisible
    // to this reap, not deliberately spared. The CoalWash lock prevents a concurrent same-outPath run
    // from existing at all.)
    //
    // THE REAP TARGET IS AN OWNERSHIP CLAIM, NOT A COMPUTED PATH (lab-grad2 N4, measured). This
    // comment used to read "already renamed away, or never created" — a TWO-case comment for a
    // THREE-case reality, and the third case is CREATED BY SOMEBODY ELSE. `tmpPath` was assigned
    // before the O_EXCL open, so a user file planted at `<outPath>.<pid>.tmp` made the open throw
    // EEXIST (the guard working) and then this line DELETED that file: never created by us, never
    // snapshotted, no bin, no recovery path. Both assignments now happen AFTER the create returns,
    // so reaching this line with a non-null `tmpPath` PROVES the engine made the file.
    if (out !== null) { try { fs.closeSync(out); } catch { /* already closed on the happy path */ } }
    if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch { /* already renamed away by the atomic publish */ } }
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

// Drive the wave loop to completion, accumulating counts. The convenience path
// for a whole-file reduce/measure (a caller that wants "N/M done — run again"
// surfaced can call reduceFile directly). Returns the summed result + waves +
// reductionPct.
export function reduceToCompletion(src, opts = {}) {
  opts = opts || {}; // the `= {}` default only catches `undefined`; a caller passing null would throw at `!opts.outPath`
  const acc = {
    ok: true, skipped: false, structure: null, dryRun: !opts.outPath, waves: 0,
    unitsSeen: 0, unitsCut: 0, unitsKept: 0, unitsUnparsed: 0, bytesSeen: 0, bytesCut: 0, bytesKept: 0,
    snapshotPath: null, outPath: opts.outPath || null, done: false, reason: null,
  };
  // BREAK 3-B (WAVE-7 L4 — the size-relative re-read-explosion floor lives on the DRIVE loop, where the
  // explosion happens; a single reduceFile wave can't explode). Stat once: a sub-CHUNK per-wave BYTE budget
  // on a file larger than one read chunk drives O(size/maxBytes) waves that EACH re-read a full chunk. Refuse
  // UPFRONT (exact + content-independent) when the projection blows the re-read budget. A tiny budget on a
  // file within one chunk can NEVER explode (each wave re-reads ≤ the whole small file) → the byte-exact
  // tests' tiny-budget/tiny-fixture calls stay permissive; the maxLines / any-residual case is belted after
  // wave 1 (content-aware) below.
  let size = 0;
  try { size = fs.statSync(src).size; } catch { /* reduceFile fails-closed on wave 1 if src is unstattable */ }
  const effMaxBytes = (opts.maxBytes !== undefined) ? opts.maxBytes : DEFAULT_MAX_BYTES;
  if (size > CHUNK && Number.isFinite(effMaxBytes) && effMaxBytes >= 1 && effMaxBytes < CHUNK
      && (size / effMaxBytes) * CHUNK > REREAD_AMPLIFICATION_CAP * size) { // WAVE-8 L4-B: filesize-relative, not a fixed 2 GiB
    acc.ok = false;
    acc.reason = `maxBytes ${effMaxBytes} is too small for a ${size}-byte file — it projects ~${Math.ceil(size / effMaxBytes)} waves each re-reading up to a ${CHUNK}-byte chunk (~${Math.ceil(CHUNK / effMaxBytes)}× the filesize of re-reads, over the ${REREAD_AMPLIFICATION_CAP}× cap — an O(waves × CHUNK) re-read explosion); raise maxBytes to at least ${Math.ceil(CHUNK / REREAD_AMPLIFICATION_CAP)} bytes on a large file, or omit it for the default`;
    return acc;
  }
  let offset = 0;
  let resume = null;
  let guard = 0;
  let reReadAccum = 0; // GROUND-TRUTH cumulative re-read, summed from THIS loop's own offset progression — never read
                       // from a caller-supplied/reconstructable checkpoint field (the retired readAccum's defeat).
  for (;;) {
    let r;
    // _trustedResume: THIS loop feeds back its OWN self-consistent checkpoints, so a resume wave skips the
    // per-wave ground-truth anchor (cluster 1) for O(size) perf; source-stability is verified ONCE at completion.
    try { r = reduceFile(src, { ...opts, offset, resume, _trustedResume: true }); }
    catch (e) { acc.ok = false; acc.reason = `reduceFile threw (defensive — should never happen): ${e.message}`; return acc; } // #1: belt-and-suspenders; reduceFile is now fail-closed
    acc.waves++;
    acc.structure = r.structure;
    if (!r.ok) { acc.ok = false; acc.reason = r.reason; return acc; }
    // FIX 3-R3 (skipped-branch honesty): a skip WROTE NOTHING (opaque structure, or a >budget unit bailed
    // on wave 1) → do NOT echo acc.outPath (init'd to opts.outPath for the write path) as if a slim copy
    // exists, and DO surface reduceFile's real snapshotPath (real for a wave-1 overlong skip; null for an
    // opaque/dry-run skip) instead of the acc's init null. (The ok:false resume-overlong branch below KEEPS
    // acc.outPath — a partial IS on disk there; only the skipped branch had nothing written.)
    if (r.skipped) { acc.skipped = true; acc.reason = r.reason; acc.done = true; acc.outPath = null; acc.snapshotPath = r.snapshotPath; return acc; }
    acc.unitsSeen += r.unitsSeen; acc.unitsCut += r.unitsCut; acc.unitsKept += r.unitsKept; acc.unitsUnparsed += r.unitsUnparsed;
    acc.bytesSeen += r.bytesSeen; acc.bytesCut += r.bytesCut; acc.bytesKept += r.bytesKept;
    if (r.snapshotPath) acc.snapshotPath = r.snapshotPath;
    if (r.done) {
      acc.done = true;
      acc.reductionPct = acc.bytesSeen ? Number((100 * acc.bytesCut / acc.bytesSeen).toFixed(2)) : 0;
      // BREAK 3-C (WAVE-7 L4): an ndjson EXECUTE that completed cutting ZERO units is a wasteful byte-identical
      // no-op copy (the caller requested types none of which are present). Refuse it HONESTLY (ok:false, no
      // output) rather than silently reporting ok:true over a pointless whole-file rewrite — the raw-layer
      // mirror of detonate's all-absent gate. The snapshot STAYS (rail-5 recovery). json-single keep-all (a
      // single verified-record extract — a DEFINED, tested primitive contract) is deliberately NOT refused; a
      // dry-run/preview (no outPath) still reports. Honest post-hoc refuse+cleanup: streaming can't know
      // all-absence before the snapshot/writes, so preventing the I/O is detonate's report-first job — this
      // guarantees the raw ndjson path never returns a silent ok:true over a no-op.
      if (!acc.dryRun && acc.structure === 'ndjson' && acc.unitsCut === 0) {
        if (acc.outPath) { try { fs.unlinkSync(acc.outPath); } catch { /* best-effort cleanup of the no-op copy */ } }
        // WAVE-8 L4-C: a data-level cut=0 is a no-op SKIP (uniform with the opaque/json-single fast-path), not a
        // refuse — ok stays true, skipped:true, the byte-identical rewrite removed. (fix-7's ok:false was
        // over-narrow; a MULTI-wave all-absent lands here, a single-wave one at reduceFile's ndjson skip.)
        acc.skipped = true;
        acc.reason = 'none of the requested cut-types are present in the file — nothing to cut (a no-op ndjson reduction is skipped; source untouched, no output written)';
        acc.outPath = null;
      }
      // LOOP SOURCE-ANCHOR (cluster 1 / L3, WAVE-9): the old end-ONLY whole-file re-hash lived here — it was
      // defeated by a mid-loop change reverted before completion, and caught a non-revert change only AFTER
      // torn bytes were already committed. It is now REPLACED by reduceFile's per-wave INCREMENTAL check
      // (each trusted wave verifies its consumed region vs the snapshot BEFORE flushing — see the region
      // block in reduceFile), which is revert-proof, torn-proof (a bad wave never flushes), and strictly
      // covers this whole loop (the per-wave regions partition the file). No end-of-loop hash needed.
      return acc;
    }
    const prevOffset = offset;
    offset = r.nextOffset;
    resume = r.checkpoint;
    // FIX (wave-progress fail-fast — the concurrent-write HANG class): a reached-here wave is ok && !skipped && !done,
    // so it MUST advance (an overlong/torn wave returns ok:false above; a done wave returned above). A non-advancing
    // offset = a bug or a concurrent-write race corrupting the resume state → it would spin doing ZERO real work up to
    // the 10M guard = minutes-to-hours of 100% CPU (the observed runaway). Fail CLOSED instantly instead of looping.
    if (offset <= prevOffset) { acc.ok = false; acc.reason = `wave made no progress (offset stuck at ${offset}, did not advance past ${prevOffset} — concurrent write or corrupt resume state)`; return acc; }
    // BREAK 3-B belt (WAVE-7 L4, content-aware): the upfront maxBytes floor can't see a small maxLines (its
    // per-wave BYTE drain depends on line length). After wave 1 the ACTUAL advance reveals the real drain — a
    // tiny advance on a > CHUNK file projects the same O(waves × CHUNK) re-read explosion → refuse NOW (one
    // cheap wave in) instead of the >30s hang. Never fires on a file within one chunk (each wave re-reads ≤
    // the whole small file), so the tiny-fixture tests are untouched.
    if (prevOffset === 0 && size > CHUNK) {
      const advance = offset; // wave 1 consumed [0, offset)
      if (advance > 0 && advance < CHUNK && (size / advance) * CHUNK > REREAD_AMPLIFICATION_CAP * size) { // WAVE-8 L4-B: filesize-relative
        if (!acc.dryRun && acc.outPath) { try { fs.unlinkSync(acc.outPath); } catch { /* best-effort cleanup of wave 1's partial */ } }
        acc.ok = false;
        acc.reason = `per-wave budget too small for the ${size}-byte file — wave 1 advanced only ${advance} bytes, projecting ~${Math.ceil(size / advance)} waves each re-reading a full chunk (~${Math.ceil(CHUNK / advance)}× the filesize of re-reads, over the ${REREAD_AMPLIFICATION_CAP}× cap — an O(waves × CHUNK) re-read explosion); raise maxBytes/maxLines or omit them for the safe defaults`;
        return acc;
      }
    }
    // L4 CUMULATIVE re-read cap (WAVE-9 front-loaded backstop + WAVE-10 ≤CHUNK class fix) — the general guard the
    // two wave-1 projections above miss. The per-wave re-read (a ≤CHUNK wave re-reads its whole remainder, a >CHUNK
    // wave ~one chunk per lines-batch) is summed HERE from THIS loop's own offset progression — ground truth, never
    // a caller-supplied checkpoint field (the WAVE-11 fix: the retired readAccum counter lived in the checkpoint the
    // caller reconstructs, so a persist-then-resume caller could reset it to 0). Same math, uncheatable source: bounds
    // BOTH a FRONT-LOADED > CHUNK grind (a big wave-1 advance ≥ CHUNK slips the after-wave-1 belt, the maxLines limiter
    // slips the upfront maxBytes cap → thousands of tail waves) AND the ≤CHUNK single-chunk path the old `size > CHUNK`
    // gate EXEMPTED. CEILING is SIZE-RELATIVE at every size (WAVE-13 L4), by regime (the two have different per-wave
    // re-read physics — see the REREAD_SUBCHUNK_CAP note): a >CHUNK wave re-reads ~one CHUNK → REREAD_AMPLIFICATION_CAP ×
    // size (8×, UNCHANGED, matches the two projection guards); a ≤CHUNK wave re-reads its whole shrinking TAIL →
    // REREAD_SUBCHUNK_CAP × size (16×, PURELY size-relative — NO absolute floor). The WAVE-13 form carried a
    // Math.max(16 × size, 512 KiB) floor, but that floor DOMINATED every sub-32 KiB file → the ceiling was effectively
    // "512 KiB regardless of filesize", so a ~4 KB dense file at maxLines:1 re-read 131× its OWN size at ok:true (the
    // residual the blind red-team pinned, WAVE-14 L4). The pure size-relative form bounds the ratio at EVERY size; a
    // tiny file at a pathological budget REFUSES past 16× (correct — no legit reason to wave), a small file at a sane
    // budget stays under 16× and completes. A legit bounded-wave reduce reads well under the ceiling and is untouched (the WAVE-9 L3
    // control: maxLines:400 / ~155 KB re-reads ~6.5× < the 16× ≤CHUNK ceiling; the wave-loop: maxLines:300 / ~435 KB
    // re-reads ~9.8× < 16×). The boundary is CONTINUITY-SAFE: a just-over-CHUNK file gets the STRICTER 8× (never looser
    // than its just-under sibling — the WAVE-10 discontinuity concern is preserved in the safe direction). this wave's
    // ACTUAL re-read (ground truth) = the source scan (a wave reads ≥ its advance, and ≥ one CHUNK when it re-reads a
    // chunk tail for a sub-CHUNK budget) PLUS the trusted-loop per-wave snapshot region-hash, which re-reads exactly
    // `advance` bytes of the snapshot (sha256FileRange, cluster 1). WAVE-12: counting only the source scan UNDERcounted
    // by ~Σadvance = one filesize, so the drive finished at ~1.2× the stated cap; adding the region-hash term makes it honest.
    reReadAccum += Math.max(offset - prevOffset, Math.min(CHUNK, size - prevOffset)) + (offset - prevOffset);
    const reReadCeiling = size > CHUNK
      ? REREAD_AMPLIFICATION_CAP * size                                    // >CHUNK: ~one CHUNK re-read per wave (unchanged 8×)
      : REREAD_SUBCHUNK_CAP * size;                                        // ≤CHUNK: whole-tail re-read per wave (16× — PURELY size-relative, no absolute floor: WAVE-14 L4)
    if (reReadAccum > reReadCeiling) {
      if (!acc.dryRun && acc.outPath) { try { fs.unlinkSync(acc.outPath); } catch { /* best-effort cleanup of the partial */ } }
      acc.ok = false;
      acc.reason = `per-wave budget too small for the ${size}-byte file — the drive has re-read ~${reReadAccum} bytes over ${acc.waves} waves (past the size-relative re-read ceiling ${reReadCeiling} B [${size > CHUNK ? REREAD_AMPLIFICATION_CAP : REREAD_SUBCHUNK_CAP}× filesize] — an O(waves × re-read) explosion that grinds a sub-budget on ANY file size, small files included); raise maxBytes/maxLines or omit them for the safe defaults`;
      return acc;
    }
    if (++guard > 10_000_000) { acc.ok = false; acc.reason = 'wave guard tripped'; return acc; } // never hang (pathological many-wave backstop)
  }
}

// ---------------------------------------------------------------------------
// recovery — content-addressed snapshot store (rail 5, mechanism-not-git)
// ---------------------------------------------------------------------------

export const SNAPSHOT_MANIFEST = 'manifest.jsonl';

// Streaming sha256 of a file (constant memory — never slurps).
export function sha256File(p) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(p, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    let off = 0;
    const buf = Buffer.allocUnsafe(CHUNK);
    while (off < size) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - off), off);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
      off += n;
    }
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

// Streaming sha256 of the byte range [start, start+len) of a file (constant memory). Returns
// { digest, read } — `read` < len means the file was SHORTER than the range (the caller treats a short
// read as a mismatch: the snapshot no longer covers what the source produced). Used by the trusted drive
// loop's INCREMENTAL per-wave source-integrity check (cluster 1 / L3): each wave hashes the source region
// it CONSUMED (accumulated live from the bytes it read) against the wave-1 snapshot's SAME range — so a
// mid-loop source change is caught at the wave that reads it, revert-proof, without re-reading the source.
export function sha256FileRange(p, start, len) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(1, len)));
    let off = 0;
    while (off < len) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, len - off), start + off);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
      off += n;
    }
    return { digest: h.digest('hex'), read: off };
  } finally { fs.closeSync(fd); }
}

// Byte-exact snapshot BEFORE a cut. Content-addressed: the blob lives at
// <snapshotDir>/<sha256>; identical content deduplicates (skip re-copy). A
// manifest.jsonl row maps original→hash (restore lookup, dedup audit). copyFile
// is byte-exact by construction.
export function snapshotSource(src, snapshotDir) {
  try {
    // L1 (WAVE-5) SOURCE-SACRED SELF-GUARD — the exported PRIMITIVE must not lean on a caller's guard.
    // Everything snapshotSource writes lands INSIDE snapshotDir (the content-addressed blob + manifest.jsonl).
    // If src RESOLVES INSIDE snapshotDir a write target IS the source: src named `manifest.jsonl` with
    // snapshotDir==dirname(src) makes the manifest path === src, and the manifest temp→rename below REPLACES
    // src with existing+row (source corruption, formerly ok:true). reduceFile's floor (:411) + detonate's
    // gate-4 belt (:369) both refuse this, but a DIRECT call to this primitive bypassed them — so the guard
    // must live HERE too (one-flock, same containment primitive). The ALIAS (hardlink) route stays closed
    // safe-by-construction by the wx+rename manifest write below + content-addressing for the blob; this
    // containment check closes the LITERAL src-inside-store route an alias defense cannot (a same path is not
    // an alias). REFUSE-POLARITY: 'unknown' refuses too — this comment used to say "Fail-closed" while the
    // boolean form let an unresolvable src through (rung-5 §1.2, the third false claim in this file).
    if (containment(physicalOrNull(src), physicalForCreate(snapshotDir), true) !== 'outside') { // REFUSE-polarity: a probe MISS folds (over-refuses)
      return { ok: false, reason: `src resolves inside the snapshot store (${snapshotDir}) — snapshotSource writes the manifest/blobs there and would corrupt the source (refused)` };
    }
    const sha = sha256File(src);
    fs.mkdirSync(snapshotDir, { recursive: true });
    const snapshotPath = path.join(snapshotDir, sha);
    let deduped = false;
    // Content-addressed dedup MUST verify the existing blob really hashes to its own
    // name before trusting it — a pre-seeded / corrupted blob at the hash path is NOT
    // the source, and blindly deduping to it would make the "snapshot" a lie the
    // whole rail-5 recovery rests on. If it fails, overwrite with the true source.
    //
    // ...AND CONTENT EQUALITY IS NOT ENOUGH: A BACKUP MUST ALSO BE INDEPENDENT (rung-5 A7).
    // A hardlink (or symlink) to `src` placed at the blob path hashes EXACTLY equal to `sha` —
    // it IS the source — so the content check passed it and the store recorded a "snapshot"
    // that is the same bytes on disk as the thing it is meant to protect. Measured: plant a
    // hardlink, snapshotSource returns ok:true deduped:true, then rewrite the source and the
    // "backup" reads the new content. The undo net was a lie, silently. A snapshot's whole
    // job is to survive the source changing, so independence is part of the definition, not
    // an extra check. `collidesWithSource` (realpath both sides + dev/ino) is the same
    // primitive gate 4 uses — reused here rather than re-derived.
    const aliasOfSrc = fs.existsSync(snapshotPath) ? collidesWithSource(snapshotPath, src) : null;
    if (!aliasOfSrc && fs.existsSync(snapshotPath) && sha256File(snapshotPath) === sha) deduped = true;
    else {
      // WRITE THE BLOB VIA temp->rename, NEVER copyFileSync ONTO the blob path.
      // A bare `copyFileSync(src, snapshotPath)` FOLLOWS a symlink sitting at the destination, so
      // anyone able to write the store could pre-place a link at <store>/<sha> aimed anywhere and
      // this line would push the SOURCE's bytes through it — an arbitrary write reported as ok:true.
      // (Proved: a planted link made snapshotSource overwrite a file outside the store.) The
      // existsSync/hash dedup above cannot stop it: a link to a wrong-content file fails the hash
      // check and falls straight into this branch, which is the write.
      // COPYFILE_EXCL alone is NOT the fix here (unlike the restore temp): dedup REQUIRES overwriting
      // a wrong-hash blob, and EXCL would refuse that. So use the manifest writer's idiom instead —
      // an O_EXCL fresh inode at an unpredictable temp (see below), then an atomic rename that
      // REPLACES the directory entry (rename does not follow a link at the destination). A stale
      // temp at THIS suffix fails the snapshot loudly, which is rail 5 behaving correctly: no
      // snapshot, no destroy.
      // UNPREDICTABLE temp name, not `<blob>.<pid>.tmp`. A pid is guessable and observable, so a
      // per-pid temp path can be PRE-PLACED by anyone able to write the store — and the lab reports
      // that on win32 a DANGLING symlink sitting there defeats COPYFILE_EXCL/`wx` (the existence
      // check follows the link, finds nothing, and the create proceeds THROUGH it). I could not
      // reproduce that specific bypass on this box — file-symlink creation is EPERM here — so I am
      // not relying on the EXCL semantics being what I hope. Random naming removes the PRECONDITION
      // instead of arguing about the primitive: an attacker cannot pre-place at a path it cannot
      // predict. EXCL stays as the second belt (cross-nature: one guard defeats prediction, the
      // other defeats a race). 12 bytes of CSPRNG, and `crypto` is already imported.
      const blobTmp = `${snapshotPath}.${crypto.randomBytes(12).toString('hex')}.tmp`;
      try {
        fs.copyFileSync(src, blobTmp, fs.constants.COPYFILE_EXCL);
        fs.renameSync(blobTmp, snapshotPath);
      } catch (e) {
        try { if (fs.existsSync(blobTmp)) fs.unlinkSync(blobTmp); } catch { /* best-effort reap */ }
        return { ok: false, reason: `snapshot blob write failed: ${e.message}` };
      }
    }
    const bytes = fs.statSync(snapshotPath).size;
    // FIX 1-R3 (source-sacred, safe-BY-CONSTRUCTION — closes the WHOLE manifest-alias class at the root,
    // not one route). The old appendFileSync opened the manifest path in append mode; if
    // <snapshotDir>/manifest.jsonl was an ALIAS of src (a hardlink the dev/ino guard misses on an ino:0
    // volume, or a TOCTOU-raced linkSync between the collidesWithSource check and this write), the append
    // followed the alias straight INTO the source — sha changed, ok:true, silent. Make the write safe
    // REGARDLESS of any alias the way outPath already is: read any existing manifest, write existing+row to
    // a FRESH O_EXCL temp (`wx` — a pre-placed alias AT the temp → EEXIST → caught → manifest skipped this
    // run; otherwise a brand-new inode nothing else names), then atomic-rename it onto the manifest path.
    // The rename REPLACES a hardlinked manifest entry with the fresh inode → src's OTHER name is untouched.
    // The source inode is NEVER opened for write; the only read of an aliased existing manifest reads src
    // bytes into `existing` = harmless (the garbage lands in the manifest-aid, never src). Any failure skips
    // the manifest (it is an aid, not a gate). Do NOT unlink-then-create on EEXIST — that reintroduces the
    // race wx closes; a stale unpredictable-suffix temp from a crash simply skips the manifest that run (acceptable for an aid).
    //
    // GRADUATION-RECORD RESIDUAL (cost, KNOWN + ACCEPTED — a class-a-ultra prototype note): this read-whole +
    // rewrite + rename is O(M) in the manifest's current row count, so N snapshots to ONE shared store cost
    // O(N²) cumulative (measured ~3.4→14.4ms/call over 12k rows). It is NOT reduced to an O(1) appendFileSync
    // because the temp→rename IS the load-bearing safety construction, and an in-place append is fundamentally
    // incompatible with it: the FIX-1-R3 property (proved by explode.test.mjs 'FIX 1-R3', case B) is that a
    // manifest.jsonl HARDLINKED to src stays harmless EVEN ON an ino:0 volume where the dev/ino alias belts (the
    // reduceFile:535 / detonate:476 collidesWithSource pre-checks) SELF-DISABLE. An O(1) append can only stay safe
    // by DETECTING the alias (dev/ino — which is exactly what fails on ino:0) or by REPLACING the inode (which is
    // the O(M) rewrite). There is no O(1) append that survives the ino:0 + hardlink case, so restoring the append
    // would reopen FIX-1-R3 for that case (and for any DIRECT caller of this exported primitive, which by design
    // leans on NO caller guard). Severity is LOW/by-design here: O(N²) only bites a LONG-LIVED, SHARED store at
    // ~30k+ snapshots; the real ULTRA/estate caller's store is per-batch/short-lived (few snapshots per run), so
    // the row count never reaches the knee. UPGRADE PATH if a long-lived shared store ever emerges: give that
    // store an append-only journal compacted out-of-band (verify the destination inode ONCE at store creation,
    // not per row), or shard the manifest per run — a store-lifecycle change, never an inline per-snapshot swap
    // that trades this safety for speed. Under-fix over reopening a source-corruption hole.
    const manifestPath = path.join(snapshotDir, SNAPSHOT_MANIFEST);
    // rung-2 F3 — captured ONCE, at snapshot time, so a later restore's ownership check has something
    // canonical to compare against without re-deriving it from a possibly-since-moved/deleted `src`.
    // `originalCanonical` closes spelling drift (case/slash/8.3/UNC/trailing-separator); `originalDev`/
    // `originalIno` close what realpath cannot (a hardlink alias, a same-volume rename) — see the
    // OWNERSHIP comment on `restoreFromSnapshot` for the full mechanism + named residuals. Neither can
    // fail this write: `physicalForCreate` returns null rather than throwing, and the stat is try/caught.
    const originalCanonical = physicalForCreate(src);
    let originalDev = null;
    let originalIno = null;
    try {
      const st = fs.statSync(src, { bigint: true });
      originalDev = st.dev.toString();
      originalIno = st.ino.toString();
    } catch { /* src unreadable at snapshot time -> dev/ino fallback unavailable; canonical string may still help */ }
    const row = `${JSON.stringify({ original: src, originalCanonical, originalDev, originalIno, sha256: sha, bytes, at: new Date().toISOString(), deduped })}\n`;
    // F2 [MEDIUM, rung-2 R1 lab] — UNPREDICTABLE temp name, matching the blob temp above (see its own
    // comment for the full reasoning): the old `${manifestPath}.${pid}.tmp` was a guessable/observable
    // pre-placement target, one of the 4 sites that still used it while only the blob temp had this fix.
    const manifestTmp = `${manifestPath}.${crypto.randomBytes(12).toString('hex')}.tmp`;
    // OWNERSHIP-AFTER-CREATE + AN HONEST RETURN (lab-grad2 N5 — the same reaper defect as reduceFile's,
    // and this was its worst instance). The finally used to `existsSync → unlink` the temp path
    // unconditionally, so a user file planted at the (then-predictable) manifest temp path was DELETED by
    // the cleanup after `wx` had correctly refused to write through it — and the function still returned a
    // bare `{ok:true}`. Deleting a file with no snapshot and no bin is the furnace with no stop on the
    // way (house rule 2026-07-27: bins are not the furnace, but past the bin IS), and reporting success
    // over it is the same class as a rollback claiming clean over a partial.
    // `manifestOwned` is set only once `wx` has returned, so the reap can only ever remove our own inode.
    let manifestOwned = null;
    let manifestSkipped = false;
    try {
      let existing = '';
      try { existing = fs.readFileSync(manifestPath, 'utf8'); } catch { /* absent → start fresh */ }
      // GUARDED write (openSync 'wx' + writeFull), NOT fs.writeFileSync: writeFull THROWS on a zero-progress
      // writeSync (the overlay-fs / disk-full shape), whereas fs.writeFileSync's internal `while (length) writeSync`
      // loop SPINS FOREVER on a writeSync that returns 0 without throwing — the same fail-closed discipline the
      // output write already uses (one-flock with writeFull). wx = O_EXCL: fresh inode, or EEXIST → caught → the
      // manifest is skipped (never write through an aliased src).
      const fd = fs.openSync(manifestTmp, 'wx');
      manifestOwned = manifestTmp; // wx returned → this inode is ours → the reaper may remove it
      try { writeFull(fd, Buffer.from(existing + row, 'utf8')); } finally { fs.closeSync(fd); }
      fs.renameSync(manifestTmp, manifestPath); // atomic: the fresh inode replaces any aliased manifest entry
      manifestOwned = null; // renamed away — nothing left to reap
    } catch { manifestSkipped = true; /* manifest is an aid, not a gate — any failure skips it, NEVER writes through src's inode */ }
    finally { if (manifestOwned) { try { fs.unlinkSync(manifestOwned); } catch { /* best-effort reap of a mid-write temp — pure hygiene: each call's fresh random suffix can never collide with a later call's O_EXCL regardless */ } } }
    // The snapshot itself STANDS on a skipped manifest — the blob is the undo net, the manifest is an
    // audit aid (that split is deliberate and unchanged). What changes is that the skip is SAID: a
    // caller can no longer read an unqualified ok:true as "the audit row landed".
    return { ok: true, sha256: sha, snapshotPath, deduped, bytes, manifestSkipped };
  } catch (e) { return { ok: false, reason: e.message }; }
}

// Does `p` exist AND hold bytes? The restore's intrinsic clobber guard (WAVE-7 L1): only a POPULATED
// destination is protected from a silent overwrite (a fresh/empty path is free to write). Absent /
// unstattable → not a clobber (fail toward allowing a legitimate fresh restore).
function existsPopulated(p) {
  try { return fs.statSync(p).size > 0; } catch { return false; }
}

// Restore a content-addressed snapshot byte-exact to `toPath`, ALWAYS hash-verified (rail 5 round-trip).
// `ref` = a sha256 hex, or a path whose BASENAME is the sha (the only thing this store emits). FAIL-CLOSED
// BY DEFAULT (WAVE-7 L1 + L3): (1) the ref MUST be a verifiable in-store content-address — a ref whose
// basename is not a 64-char lowercase-hex sha256 is REFUSED, never copied out unverified (kills the old
// read-anything-to-toPath exfil branch); (2) the bytes are ALWAYS hash-verified against that content-address
// before publishing — a mismatch is refused with an ACCURATE verified:false (never the old lying
// verified:true); (3) source/clobber protection is INTRINSIC — an existing, POPULATED toPath (incl. the live
// source) is NOT overwritten without an explicit `force:true`, so NO opt-in guard-context is needed to stay
// safe. `src` (OPTIONAL, kept) only yields a sharper "you aimed at the protected source" diagnostic when a
// caller declares one; the intrinsic clobber refusal is the load-bearing default guard. Restoring to a
// fresh/empty scratch/target path is unaffected; overwriting a populated file is opt-in via force.
//
// OWNERSHIP (rung-2, HIGH — the PRIMITIVE must not lean on a caller's guard, the same posture
// `snapshotSource`'s own L1 self-guard above already takes). The hash check proves BYTE-INTEGRITY —
// this blob really is the bytes named by its hash. It proves NOTHING about AUTHORIZATION: the store
// directory is directly enumerable (`readdirSync` lists every hash, no manifest read required) and,
// pre-fix, ANY ref discoverable that way restored for ANY caller. MEASURED, not reasoned: a per-tenant
// `snapshotDir` shared across two roles let an ORDINARY, non-adversarial "recover everything visible in
// the shared undo-net store" caretaker script land role A's secret content in role B's own recovery
// directory — no malice required, only the caretaker discipline a shared store invites (`scratchpad/
// cw-lab-rung2-r1/coord-verify/verify-crosstenant.mjs`, real run).
//
// `original` is REQUIRED — UNCONDITIONALLY, not gated on whether the caller passed `snapshotDir`. An
// earlier version of this comment claimed the explicit-blob-path mode "is not an enumerable shared space
// and is already fully secured by the hash check" — MEASURED FALSE (`scratchpad/cw-lab-rung2-r2/
// coord-verify/verify-bypass.mjs`, real run): the SAME caller, handing this function the absolute blob
// path it already holds instead of naming the directory separately, is not an attack technique — it is
// the identical call with a different, equally natural shape, and it walked straight past the `if
// (snapshotDir)` gate. The gate is gone; `ownershipDir` (below) is `snapshotDir` when the caller named
// one, else the directory the blob physically lives in (`blob` has already passed `existsSync` by this
// point, so its `dirname` always resolves) — ONE code path, not two.
//
// The caller must ASSERT which source path it believes this blob is a snapshot OF, checked against the
// manifest row `snapshotSource` wrote for that hash — an unconfirmed assertion, or a manifest that cannot
// confirm it (absent / unreadable / no matching row), REFUSES. This converts "restore any blob you can
// reach" into "prove you know what this blob is for."
//
// CANONICALIZED, not raw string equality (rung-2 F3). `row.original === original` refused the SAME
// physical file on a case difference, a drive-letter-case difference, forward slashes, a trailing
// separator, a `\\?\` prefix, or a confirmed-real 8.3 alias — the anti-data-loss mechanism refusing in
// exactly the situations that produce data loss. Two independent, ALREADY-ESTABLISHED mechanisms in this
// file close it, matched to what each can and cannot do:
//   (1) REALPATH STRING (`physicalForCreate`, not the stricter `physicalOrNull`): closes every spelling
//       variant above. `physicalForCreate` is used here — not the exists-or-null primitive — because a
//       restore target commonly does NOT exist (the file is gone; that is the reason someone is
//       restoring it) and an unresolvable side must fail closed, never throw, never fall back to a
//       lexical compare (rung-2 F3 rail 2). `physicalForCreate` realpaths the deepest EXISTING ancestor
//       and reattaches a missing tail LITERALLY — so a gone file whose PARENT still exists still gets its
//       directory portion normalized, and an entirely unresolvable path (parent gone too, or a win32
//       device/UNC shape) returns null, which this check treats as unconfirmable, never as a match.
//   (2) DEV+INO (`{bigint:true}`, the SAME NTFS-64-bit-safe idiom `collidesWithSource` already uses for
//       exactly this reason): closes what (1) CANNOT — MEASURED, not assumed (a hardlink alias and a
//       same-volume rename/move both keep the SAME inode; realpath resolves each NAME independently and
//       does not collapse them — `collidesWithSource`'s own comment already says realpath "is blind to a
//       hardlink"). A hardlinked alias of the true original, or the original renamed/moved on the SAME
//       volume, confirms via dev+ino even though its realpath string differs from the row's.
//       WHAT THIS LEG OPENS, not just what it closes (INSPECT MED-LOW, named here; rung-2 F4, HIGH,
//       was dispatched specifically to close it — see below for why it only narrows). dev+ino
//       is recorded at SNAPSHOT time and compared against a stat taken at RESTORE time — an inode
//       REUSED between those two moments grants ownership to a genuinely different file.
//
//       rung-2 F4 [HIGH, CORRECTED 2026-08-05] — `devinoContradicts` (below, in `restoreFromSnapshot`)
//       was built to close this: when the declared original still exists, its LIVE dev+ino is checked
//       against the row's, and a disagreement overrides a stale `canonMatch` instead of merely failing
//       to help it. MEASURED FALSE AS A FULL CLOSE, not reasoned — real CI (GitHub Actions run
//       30937712605, `ubuntu-latest` node 22 AND 24) proves the shipped fix (`6f261e4`) does not close
//       the recycled-path case on ext4: `unlinkSync` immediately followed by `writeFileSync` at the same
//       path, under low allocation pressure, lets the OS hand the NEW file the SAME inode number the
//       OLD one held — `devinoMatch` then computes TRUE for a genuinely different file, same as
//       `canonMatch` (same path string), and the row confirms. `windows-latest`/`macos-latest` stay
//       green on the identical test because NTFS/APFS do not reproduce that recycling pattern in this
//       CI matrix — the test is not flaky, it is honestly platform-dependent (master-loss-taxonomy
//       class #57, FILESYSTEM-SEMANTICS-ASSUMPTION BREAK — the code assumed "a live dev/ino match
//       reliably identifies the same file," which ext4 violates under exactly this access pattern).
//
//       CONFIRMED WITH RAW NUMBERS, not left as deduction from the test's pass/fail alone (GitHub
//       Actions run 30939561156, a one-shot printing diagnostic, deleted after this landed):
//         linux  (ubuntu, node 22): before.ino=8917289 after.ino=8917289  -> IDENTICAL (recycled)
//         win32  (windows, node 22): before.ino=8162774324769855 after.ino=8444249301480511 -> DIFFERENT
//         darwin (macos, node 24): before.ino=2882206 after.ino=2882207 -> DIFFERENT (sequential)
//       Three platforms, one immediate unlink+recreate at one path: only Linux recycles the inode
//       at CI scale. This is measured, not inferred from the assertion's own outcome.
//
//       Birthtime/ctime were considered and NOT added as a fix — CONFIRMED unreliable with a second
//       diagnostic (run 30940310775, deleted after this landed), not left as a reasoned guess:
//         ubuntu · node 24 (F4's own test RED here): sameIno=true sameBirthtime=true sameCtime=true —
//           dev/ino, birthtime AND ctime all IDENTICAL. The whole unlink+recreate landed inside one
//           millisecond tick; no stat-time field distinguishes the two files at that resolution.
//         ubuntu · node 22 (F4's own test GREEN here, a DIFFERENT probe instance, same run): the
//           diagnostic's own unlink+recreate DID recycle the inode (sameIno=true) yet birthtime
//           differed by exactly 1ms — recycling is a per-attempt RACE against ext4's free-inode
//           state, not a fixed property of one CI run; the same machine recycles on one attempt and
//           not the next.
//       Two consequences: (1) the sub-millisecond-collision risk this paragraph originally predicted
//       is REAL, not hypothetical — node 24's run hit it exactly; (2) even where birthtime DOES
//       differ, it cannot be trusted as a general fix because the SAME machine, SAME code, adjacent
//       runs, produced BOTH outcomes. A signal that sometimes helps and sometimes doesn't is not a
//       security boundary. No OS-reported stat field (dev, ino, birthtime, ctime) closes this
//       reliably at this operation's natural timescale — AT MILLISECOND resolution.
//
//       A THIRD diagnostic (run 30941217882, deleted after this landed) checked whether the
//       collision was a real physical tie or a DISPLAY-RESOLUTION artifact, by reading the SAME
//       bigint stat's ctimeNs/birthtimeNs fields instead of its Ms ones:
//         ubuntu · node 22: before.birthtimeNs=1785870006585535727 after=1785870006586474805
//           -> DIFFER by ~939,078 ns (~0.94ms) -- genuinely two ticks, not one.
//         ubuntu · node 24: before.birthtimeNs=1785870005367425059 after=1785870005368065787
//           -> DIFFER by ~640,728 ns (~0.64ms) -- the SAME run whose Ms-truncated reading showed
//           "IDENTICAL" above; at ns resolution the two operations were never actually simultaneous,
//           only close enough to round into the same millisecond bucket.
//       Read as MECHANISM, not luck: unlink+writeFileSync is a real kernel round-trip (VFS lookup,
//       journal commit, page-cache update) costing hundreds of microseconds minimum on any real
//       hardware -- the observed gap is that cost, not a coin-flip against clock-tick granularity.
//       This is the OPPOSITE shape from the ms-level finding: there, "sometimes 0 sometimes not"
//       meant genuine physical collision at that resolution; here, a single ns-resolution sample
//       showing separation is consistent with a real, structural lower bound on inter-syscall
//       latency -- encouraging, but ONE sample per platform is not the repeated-trial proof this
//       room's own DIAG-#2 lesson (a favorable single sample IS NOT a security boundary) demands
//       before trusting a timing signal. NOT adopted as the closing mechanism on that basis.
//
//       THE BELT WAS CONSIDERED AND DOES NOT FIT THIS CASE, stated so nobody re-tries it blind. The
//       existing belt (see `collidesWithSource`/gate-4-shaped fail-closed refusals elsewhere in this
//       file) fires when identity CANNOT BE COMPUTED AT ALL (e.g. `stat.ino === 0`, an inode-less
//       volume) -- an ABSENCE trigger. Leg 3's attack is the opposite shape: dev/ino ARE computable
//       and DO match (the row's recorded values and the live recreated file's values are identical,
//       by inode recycling) -- a PRESENT-BUT-WRONG signal, not an absent one. The belt itself is
//       UNCHANGED, and remains correct for its own, different (inode-less) case.
//
//       TIER 2 (ctimeNs) — ATTEMPTED AND REVERTED, 2026-08-05, SAME DAY. `ctimeNs` was tried as the
//       tier-2 discriminator ("same dev/ino, does ctimeNs also disagree?"), following directly from
//       the ns-measurement two paragraphs up. It directly REGRESSED a real, pre-existing legitimate
//       case (`RUNG5 A6`: restoring a snapshot back over a since-modified source), caught by this
//       room's own full-suite-before-commit discipline before it shipped. Root cause, MEASURED twice
//       by direct isolated probe, not reasoned: `ctime` bumps on ANY write to an inode's content, not
//       only when the inode is reused for a different file. A recycled inode (File B created fresh at
//       a path File A used to occupy) and a genuinely-modified original (File A, same inode, content
//       rewritten) both present the IDENTICAL signature — "same dev/ino, a later ctime than what the
//       manifest recorded" — because both are, respectively, a creation event and a write event, and
//       POSIX/NTFS ctime semantics do not distinguish "this inode's OWNER changed" from "this inode's
//       CONTENT changed". No refinement of the ctime comparison closes this; the filesystem does not
//       expose the fact tier 2 needed. This is a durable NEGATIVE finding, the same class as F2's own
//       "not patchable at this layer" — reverted from both the manifest write side (`originalCtimeNs`
//       is not recorded) and the restore side (no ctimeNs comparison exists), leaving no dead
//       machinery behind.
//
//       DISPOSITION: NARROWED, NOT CLOSED — unchanged from before tier 2 was attempted. `6f261e4`
//       correctly and verifiably (all 3 CI platforms, Legs 1-2 of the F4 test) closes the SIMPLER
//       attack: an attacker declares a FALSE original while the TRUE original persists untouched. The
//       recycled-path variant (Leg 3) is a confirmed-live residual on Linux, bounded exactly as this
//       paragraph already said before F4 was attempted: under F2's own threat model (STEP 2, below) an
//       attacker with store write can forge a row outright, so this adds nothing there; without store
//       write they would additionally need the path recycled at them AND the row's exact values —
//       narrower than F2's residual, but not closed by any dev/ino/ctime signal this function can read
//       at restore time (tier 2 was the best-available metadata attempt, and it is now confirmed
//       insufficient, not merely untried). Closing it fully needs one of: (a) an out-of-band,
//       CoalWash-owned identity marker this stateless CLI does not currently maintain (a persistent
//       watch/generation-counter, or a per-snapshot token that survives incidental recycling but not a
//       deliberate copy — real new infrastructure, not a stat-field swap), or (b) extending F2's
//       operational boundary (trusted-tenant-only store, operator-arranged isolation) to explicitly
//       cover ordinary filesystem churn AT THE ORIGINAL PATH, not merely store-write access — since
//       this residual needs no store access at all, only ordinary delete+recreate activity at a
//       tracked path. NEITHER IS BUILT HERE — both are a design decision for whoever owns this engine's
//       wiring, per the state-schema-guard convention (AGENTS.md), not something to build unilaterally
//       under one dispatch. The `rung-2 F4 [HIGH]` test's Leg 3 stays `test.todo()` and stays RED on
//       `ubuntu-latest` — that is the correct, honest state until one of the above lands. It still
//       RUNS every gate on every platform and still PRINTS; it does not fail the build, but reading
//       "does not fail the build" as "the gap is closed" would be exactly the mistake this whole
//       investigation exists to prevent.
// Both are recomputed fresh at restore time from the CALLER's declared `original` — the manifest row
// carries its OWN canonical + dev/ino, captured once at snapshot time — and a match on EITHER mechanism
// confirms. Neither can MERGE two genuinely different originals (rung-2 F3 rail 1): two distinct real
// files canonicalize to two distinct realpath strings (MEASURED — `scratchpad/…/probe-canon.mjs`, no
// collision across upper/lower/forward-slash spellings of one file vs a second, different file in the
// same directory) and two distinct files never share a device+inode pair by construction. A LEGACY row
// written before this fix (no `originalCanonical` field at all) falls back to the OLD exact-string
// compare for THAT row only — a real migration concern for a manifest that outlives a code upgrade
// mid-batch, not a new merge risk (still exact equality, nothing new to collide).
//
// NAMED RESIDUAL, NOT CLOSED: "source renamed" / "workspace moved" is closed ONLY when the file still
// exists at the NEW location on the SAME volume (dev+ino survives a same-volume rename) and the caller
// declares that new location. A CROSS-VOLUME move (a new inode by construction) or a fully DELETED file
// declared under a spelling that differs from the one recorded at snapshot time has no available identity
// signal — no mechanism here, or plausible without a rename/move-tracking log this file does not keep,
// can recover it. Named, not built: out of scope for "canonicalize the compare."
//
// STEP 2 (F2, HIGH) — THE STORE'S THREAT MODEL, STATED AS A BOUNDARY, NOT A FOOTNOTE. A reviewer
// tried to refute "not patchable at this layer" and could not: it enumerated SEVEN candidate fixes at
// this layer and killed all seven with reasons (a disk cross-check — the attacker just declares their
// own real file · blob-hash-equals-current-content — defeats the product, a restore exists BECAUSE the
// original is gone · file uid/ACL — no per-row provenance, meaningless on win32, a shared store shares
// the file · a hash-chained/append-only manifest — the chain is computable from PUBLIC data, only a
// KEYED MAC resists forgery · blob metadata — the blob is genuine and victim-written, it says nothing
// about who may restore it · refusing ambiguous same-sha rows — breaks the legitimate dedup case
// (rot-canary self-catch: NOT F3 rail-1, which tests non-merge of DIFFERENT files — the real dedup
// control is `attack3-manifest-path.mjs` §3d, two distinct originals sharing one deduped blob, both
// restoring correctly) and the attacker has write access anyway · per-tenant isolation — this IS the
// deployment-side answer below, not a code fix). The gap is AUTHENTICATION, and authentication needs a
// secret or a trust boundary this store does not have.
//
// THE BOUNDARY, stated plainly for whoever is reading this to understand what the store actually
// promises:
//   1. THE STORE IS TRUSTED-TENANT-ONLY. CORRECTED 2026-08-05 (source: `cw-lab-rung2-r4/LAB-RECORD.md`
//      §"The F1 sibling attempt" Attempt B) — this point used to state the precondition as "write
//      access to snapshotDir's manifest"; that is SUFFICIENT but was never NECESSARY. The attack needs only
//      (a) READ access to the victim's blob bytes, by ANY means (a direct copy, a listing — the
//      store is content-addressed, so possessing the bytes IS possessing a valid ref), plus
//      (b) ordinary WRITE access to any directory the restoring process can reach — the attacker's
//      OWN, never the victim's. The attacker declares their own directory as `snapshotDir` and
//      forges their own manifest there; F1-b's fix (snapshotDir now required) does not close this,
//      since the attacker already owns a directory that satisfies the requirement. (MEASURED:
//      `scratchpad/cw-lab-rung2-r2/w1/attack3-manifest-path.mjs` §3e, AND re-verified against a
//      SCHEMA-AWARE forgery that also fabricates matching `originalCanonical`/`originalDev`/
//      `originalIno` — both leak the victim's content, `ok:true`.) This is not a bug awaiting a
//      fix; it is the boundary.
//   2. THE MITIGATION IS ISOLATION, and it is the OPERATOR's to arrange, not the engine's to enforce —
//      a `snapshotDir` per trust domain, so no shared manifest for a co-tenant to write into exists in
//      the first place.
//   3. WHAT OWNERSHIP CHECKING DOES BUY, so this is never read as "the check is worthless": it closes
//      the CARETAKER-DISCIPLINE failure mode — the realistic one, and the one the lab actually
//      reproduced first (an ordinary, non-adversarial "recover everything visible in a shared store"
//      script) — and it forces a DETERMINED attacker's read of the manifest into an EXPLICIT,
//      code-visible forged claim instead of a silent, undetectable enumeration. Both layers (the check
//      here, and per-tenant isolation) hold at once, by design; neither substitutes for the other.
//
// REJECTED, so it is on record as weighed rather than invented after the fact: WRITER-IDENTITY /
// signing infrastructure for manifest rows. This is real key-management infrastructure this codebase
// has never had (no caller/session/tenant identity is threaded through any function in this file),
// built for a threat that isolation already answers — over-build.
//
// LANDING PRECONDITION: this engine is UNWIRED in the shipped `plugin/` dist today (see the
// UNWIRED_ENGINE mechanism in `scripts/build-plugin.mjs`), which is the only reason F2 is a landing
// precondition rather than an already-shipped incident. THIS ENGINE MUST NOT BE WIRED INTO DIST until
// EITHER per-tenant manifests exist (closing F2 in code) OR the three-point boundary above is in the
// SHIPPED `SECURITY.md` text (closing F2 by disclosure) — the wiring decision is where that choice
// gets made, not here.
//
// COST, inheriting a PRE-EXISTING accepted precedent, not a new one: a restore now ALWAYS reads the whole
// manifest (was: only when `snapshotDir` given) — O(M) in its row count, the same order as
// `snapshotSource`'s own already-accepted O(N²) manifest-write cost (see its comment: "the real
// ULTRA/estate caller's store is per-batch/short-lived, few snapshots per run, the row count never
// reaches the knee"). The same reasoning covers this read; a long-lived shared store hitting that knee is
// the pre-existing upgrade trigger, not a new one this check introduces.
export function restoreFromSnapshot(ref, toPath, opts) {
  // `= {}` only defaults `undefined`, so an explicit null third argument threw on
  // destructuring — the one caller shape that crashed a primitive whose own contract
  // (below) is that it never throws. Normalize first, destructure after.
  const { snapshotDir = null, src = null, force = false, original = null } = (opts && typeof opts === 'object') ? opts : {};
  // A RECOVERY PRIMITIVE MUST NEVER THROW. Every other bad ref returns a fail-closed
  // {ok:false}, but a non-string ref reached path.isAbsolute and threw
  // ERR_INVALID_ARG_TYPE — the one input shape that crashes the caller instead of
  // telling it no, in the code path a user reaches only when something has already
  // gone wrong (R3 / LOW).
  if (typeof ref !== 'string' || !ref) {
    return { ok: false, verified: false, reason: `snapshot ref must be a non-empty string (got ${ref === null ? 'null' : typeof ref}) — refused` };
  }
  // L3#1 (store-boundary containment): when a store is declared, EVERY ref — relative OR absolute — must
  // resolve INSIDE it (an absolute out-of-store ref is an exfil vector). Realpath-and-contain, fail-closed.
  let blob;
  if (snapshotDir) {
    const baseReal = physicalOrNull(snapshotDir);
    if (!baseReal) {
      return { ok: false, verified: false, reason: `snapshot store unresolvable (${snapshotDir}) — cannot verify the ref stays contained (refused)` };
    }
    const joined = path.isAbsolute(ref) ? ref : path.join(snapshotDir, ref);
    if (!isContainedIn(physicalForCreate(joined), baseReal)) {
      return { ok: false, verified: false, reason: `snapshot ref escapes the store (path traversal / out-of-store ref refused): ${ref}` };
    }
    blob = joined;
  } else {
    blob = ref; // no store context: an explicit blob path — still content-verified below (BREAK 2), never trusted blind
  }
  if (typeof blob !== 'string' || !fs.existsSync(blob)) return { ok: false, verified: false, reason: `snapshot blob not found: ${blob}` };
  // BREAK 2 (WAVE-7 L3-A): ALWAYS hash-verify against the expected content-address — kill the old
  // basename-shape DISCRIMINATOR that SKIPPED verify for a non-hex basename and published unverified bytes
  // (ok:true, verified:false = a read-anything-to-toPath inject/exfil vector; an UPPERCASE-hex ref this store
  // never writes slipped it too). The store emits ONLY lowercase-sha256 blobs (sha256File → lowercase hex),
  // so a ref whose basename is not a 64-char lowercase-hex is NOT a verifiable in-store content-address →
  // REFUSED, never published. (A legitimate content-addressed blob still restores — its bytes are verified;
  // only unverifiable/foreign refs are refused.)
  const expect = path.basename(blob);
  if (!/^[0-9a-f]{64}$/.test(expect)) {
    return { ok: false, verified: false, reason: `snapshot ref is not a verifiable content-address (basename '${expect}' is not a sha256) — refused, never published unverified` };
  }
  // #3 copy→verify→(guard)→rename: copy to an unpredictable temp, hash-verify, guard the destination, THEN
  // atomic rename — toPath is NEVER touched until the bytes are proven AND the clobber/alias guards pass. A
  // mismatch or a refused destination leaves toPath (incl. a toPath===src) byte-intact.
  // F2 [MEDIUM, rung-2 R1 lab] — UNPREDICTABLE temp name, matching the blob temp in snapshotSource (see
  // its own comment for the full reasoning): the old `${toPath}.${pid}.tmp` was guessable/observable and,
  // being the RECOVERY path, a pre-placed alias here would have the undo net destroy a bystander while
  // restoring — one of the 4 sites that still used it while only the blob temp had this fix.
  const tmpPath = `${toPath}.${crypto.randomBytes(12).toString('hex')}.tmp`;
  // OWNERSHIP-AFTER-CREATE (the reduceFile/manifest reaper class, FOUND HERE BY GREPPING every
  // predictable temp rather than by a report — this site was not in the finding). It matters most
  // here: this is the RECOVERY path, so the failure mode was the undo net destroying a bystander
  // while restoring. `tmpOwned` is set only once COPYFILE_EXCL has returned; the outer catch reaps
  // that, never the bare path. Note the EEXIST case is exactly the one the comment below calls
  // "fails the restore loudly" — it must fail loudly WITHOUT deleting whatever caused the EEXIST.
  let tmpOwned = null;
  try {
    fs.mkdirSync(path.dirname(path.resolve(toPath)), { recursive: true });
    // COPYFILE_EXCL = the O_EXCL half of the temp→rename idiom this file already uses at its two
    // write sites (`openSync(tmpPath, 'wx')`). This RECOVERY path predated that idiom and was the
    // one temp created WITHOUT exclusive semantics: `${toPath}.${pid}.tmp` is fully predictable, and
    // a plain copyFileSync both overwrites an existing file AND follows a symlink planted at the
    // destination — so anyone able to write toPath's directory could aim the restored bytes
    // somewhere else, on the undo net itself. EXCL makes the temp a fresh inode or nothing.
    // A stale temp at THIS EXACT random suffix (vanishingly unlikely, but not the point) fails the
    // restore loudly (EEXIST -> the catch below) instead of being silently reused; that matches the
    // manifest writer's documented choice NOT to unlink-then-create, which would reopen the very race
    // EXCL closes. (rung-2 findings-back item 3: this was the 5th of 5 "per-pid"/"same-pid" comments
    // in the file, the one the previous sweep of 4 missed — the pattern was the finding, not the line.)
    fs.copyFileSync(blob, tmpPath, fs.constants.COPYFILE_EXCL);
    tmpOwned = tmpPath; // EXCL returned → this inode is ours → the catch may reap it
    const got = sha256File(tmpPath);
    if (got !== expect) {
      try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
      // BREAK 2: `verified` is ACCURATE — a hash MISMATCH is not verified (the old code lyingly returned
      // verified:true on this refusal path). ok:false + verified:false, toPath untouched.
      return { ok: false, verified: false, sha256: got, reason: `restore hash mismatch: expected ${expect}, got ${got}` };
    }
    // The bytes are content-verified. Guard the DESTINATION before publishing (BREAK 1).
    // (a) A PRECISE source-alias diagnostic when the caller declares a protected `src` (kept, now redundant
    //     with the intrinsic clobber below but the sharper message).
    //
    // GATED ON `!force` (rung-5 A6). This branch used to fire UNCONDITIONALLY, which broke the
    // PRIMARY undo: restoring a snapshot back OVER the file it was taken from is the whole point of
    // the recovery store, and a caller doing exactly that — declaring `src` so the engine knows what
    // it is protecting, and passing `force:true` to authorise the overwrite — was refused anyway.
    // Worse, the refusal told them to "pass force:true" while ignoring the force:true they had
    // already set: a message naming the flag it does not read. The honest caller was punished for
    // being explicit (omit `src` and the same restore succeeded), and the operator meeting this is
    // by definition mid-recovery. This is the sharper DIAGNOSTIC for the clobber guard below, and
    // that guard is force-gated — so this one must be too, or the two disagree about what force
    // means. Without `force` the refusal still fires, with its precise alias reason.
    if (!force && src != null) {
      let srcFd = null;
      try { srcFd = fs.openSync(src, 'r'); } catch { /* src unopenable → not a live file to protect */ }
      if (srcFd != null) {
        try {
          const collision = collidesWithSource(toPath, src, srcFd) || collidesWithSource(tmpPath, src, srcFd);
          if (collision) {
            try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
            return { ok: false, verified: false, reason: `toPath aliases the protected source (${collision}) — a restore would overwrite the live source; restore to a scratch/target path, or pass force:true` };
          }
        } finally { try { fs.closeSync(srcFd); } catch { /* already closed */ } }
      }
    }
    // (b) INTRINSIC clobber refusal (BREAK 1 — the fail-CLOSED-by-default guard, no opt-in context needed):
    //     never silently overwrite an existing POPULATED destination (incl. the live source, incl. an alias
    //     the diagnostic above didn't cover) without an explicit force. A fresh/scratch/empty toPath is free.
    if (!force && existsPopulated(toPath)) {
      try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
      return { ok: false, verified: false, reason: `toPath exists and is non-empty — refusing to overwrite it without force:true (a restore never silently clobbers a populated destination, incl. the live source)` };
    }
    // (c) OWNERSHIP (rung-2, see the function header) — UNCONDITIONAL, not gated on whether the caller
    // named `snapshotDir`. The caller must ASSERT `original` (the source path it believes this blob
    // came from) AND declare `snapshotDir` (WHERE to consult the manifest that confirms it); the
    // manifest must CONFIRM `original` via a CANONICALIZED compare (rung-2 F3, see the function
    // header); any of the three missing/failing refuses. Placed LAST, after every existing guard: a
    // ref that was already going to be refused (bad shape, traversal, hash mismatch, alias, clobber)
    // keeps its own, more specific reason — this only additionally gates restores that would
    // otherwise have SUCCEEDED.
    //
    // rung-2 F1-b: `ownershipDir` used to fall back to `path.dirname(blob)` when `snapshotDir` was
    // omitted — the blob is UNTRUSTED INPUT (the very reference being restored), so that fallback let
    // the ownership ORACLE be chosen by the same party being asked the question: copy a victim's blob
    // into an attacker-owned directory, write a self-consistent single-row manifest beside it (the
    // lab's `cw-lab-rung2-r3` construction — internally-consistent `original`/`originalCanonical`/
    // `originalDev`/`originalIno`, all matching a file the attacker genuinely owns), and the engine
    // consults the attacker's own manifest to authorize the attacker's own restore. `snapshotDir` is
    // now REQUIRED — a caller that does not know its own snapshot directory has no business asking
    // for a confirmed restore.
    if (typeof original !== 'string' || !original) {
      try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
      return { ok: false, verified: false, reason: `ownership not declared: opts.original is required — the store is a shared, enumerable content-address space (directly, or via its own directory), and a restore must assert which source it believes this blob is a snapshot of (refused, never served on a bare hash discovery)` };
    }
    if (typeof snapshotDir !== 'string' || !snapshotDir) {
      try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
      return { ok: false, verified: false, reason: `ownership oracle undeclared: opts.snapshotDir is required — deriving the manifest directory from the untrusted blob reference lets whoever controls that path also supply the manifest that confirms it (refused, never derived from the restored reference itself)` };
    }
    const ownershipDir = snapshotDir;
    // rung-2 F3 rail 2: unresolvable fails CLOSED (declaredCanonical/declaredDev/declaredIno stay null,
    // never a lexical fallback) — the declared original may legitimately be GONE (that is the point of
    // a restore), so `physicalForCreate` degrades gracefully rather than `physicalOrNull`'s hard refuse.
    const declaredCanonical = physicalForCreate(original);
    let declaredDev = null;
    let declaredIno = null;
    try {
      const dst = fs.statSync(original, { bigint: true });
      declaredDev = dst.dev.toString();
      declaredIno = dst.ino.toString();
    } catch { /* declared original does not exist (or is unreadable) at restore time -> dev/ino unavailable */ }
    const manifestPath = path.join(ownershipDir, SNAPSHOT_MANIFEST);
    let manifestText = null;
    try { manifestText = fs.readFileSync(manifestPath, 'utf8'); } catch { /* absent/unreadable -> cannot confirm */ }
    let confirmed = false;
    let devinoContradicted = false; // rung-2 F4: at least one row's live dev/ino disagreed with its own canonMatch
    if (manifestText !== null) {
      for (const line of manifestText.split('\n')) {
        if (!line) continue;
        let row; try { row = JSON.parse(line); } catch { continue; } // a malformed row confirms nothing, never crashes the restore
        if (!row || row.sha256 !== expect) continue;
        const canonMatch = row.originalCanonical != null && declaredCanonical != null && row.originalCanonical === declaredCanonical;
        const devinoAvailable = row.originalDev != null && row.originalIno != null && declaredDev != null && declaredIno != null;
        const devinoMatch = devinoAvailable && row.originalDev === declaredDev && row.originalIno === declaredIno;
        // rot-canary self-catch: fall back to the OLD exact-string compare whenever the row has NO
        // usable canonical identity to compare against — either a row written before this fix
        // (`originalCanonical === undefined`, the key never existed) OR a row where snapshot-time
        // canonicalization genuinely FAILED (`originalCanonical === null`, `physicalForCreate`
        // returned null for `src` at snapshot time — a narrow race, src vanishing between the hash
        // read and the canonicalization call). Without this second leg, such a row is confirmable by
        // NOTHING — not canonical (never captured), not dev/ino (also failed, or absent) — even for
        // its own exact original spelling, which is a genuine AVAILABILITY regression vs the OLD
        // code (a bare string compare that never depended on canonicalization succeeding at all).
        // Still exact equality either way, no new merge risk.
        const legacyExactMatch = row.originalCanonical == null && row.original === original;
        // rung-2 F4 [HIGH]: canonMatch is a PATH-SPELLING compare and says nothing about WHAT
        // currently occupies that path. When the declared original still exists (dev/ino were
        // captured live), a dev/ino comparison is available and authoritative — the identity of the
        // FILE, not the string naming it. A row whose recorded dev/ino disagrees with that live
        // reading describes a DIFFERENT file that used to live at this path (deleted, then a new
        // file recreated at the same name — ordinary lifecycle, no attacker required) and must
        // override a stale canonMatch, not merely fail to help it. When the original is genuinely
        // gone (the point of a restore), declaredDev/declaredIno stay null, devinoAvailable is
        // false, and canonMatch alone authorizes exactly as before — this leg only bites when a
        // live, computable identity check contradicts the path string.
        // rung-2 F4 TIER 2 — ATTEMPTED, REVERTED (2026-08-05). A ctimeNs comparison was built here
        // and directly REGRESSED a legitimate case, caught by this room's own full-suite-before-commit
        // discipline (RUNG5 A6, restoring a snapshot back over a since-MODIFIED source): `ctime`
        // updates on ANY write to an inode's content, not only when the inode is reused for a
        // different file — confirmed twice by direct measurement (two isolated probes, both platforms
        // of this box), not merely reasoned. A recycled inode and a genuinely-modified original are
        // therefore STRUCTURALLY INDISTINGUISHABLE by dev/ino + ctime alone: both present as "same
        // dev/ino, later ctime". This is a durable negative finding, not a bug in the check's
        // wiring — no refinement of the ctime comparison closes it, because the filesystem does not
        // record the information tier 2 needed (whether the inode's OWNER changed, only that its
        // content did). See the OWNERSHIP header above for the full writeup and what remains true.
        const devinoContradicts = devinoAvailable && !devinoMatch;
        if (devinoContradicts) { devinoContradicted = true; continue; }
        if (canonMatch || devinoMatch || legacyExactMatch) { confirmed = true; break; }
      }
    }
    if (!confirmed) {
      try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
      // rung-2 F4: a devino contradiction gets its OWN reason, never the generic "unconfirmed"
      // message — that message reads identically to an honest manifest miss, and this is not one;
      // it is a live, computable identity check that actively DISAGREED with a row's path string.
      const reason = devinoContradicted
        ? `ownership contradicted: '${original}' currently resolves to a different file (dev/ino mismatch) than the one the manifest row for this blob (sha256 ${expect}) describes — refused (the path was recycled since the snapshot was taken)`
        : `ownership unconfirmed: the store's manifest does not record '${original}' as the source of this blob (sha256 ${expect}) — refused (the manifest is absent, unreadable, or has no matching row)`;
      return { ok: false, verified: false, reason };
    }
    fs.renameSync(tmpPath, toPath); // atomic publish — only content-verified, destination-guarded, OWNERSHIP-confirmed bytes land here
    return { ok: true, sha256: got, verified: true };
  } catch (e) {
    // ONLY our own inode. The EEXIST that lands here is precisely the case where the temp path
    // holds somebody ELSE's file — reaping the bare path would delete it while refusing to write it.
    if (tmpOwned) { try { fs.unlinkSync(tmpOwned); } catch { /* best effort */ } }
    return { ok: false, verified: false, reason: `restore write failed: ${e.message}` };
  }
}
