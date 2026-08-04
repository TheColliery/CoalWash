// ponytail: 1047 lines at declaration — one atomic transaction: applyPlan and recoverDangling are two halves of a single snapshot/rollback protocol, and the containment + provenance guards (the R5 rule) thread through both; a split scatters guards that must be audited in one view.
// apply.mjs — the all-or-nothing transactional apply (blueprint §14.5 + §14.11,
// gap #3): snapshot-marker -> write .tmp -> fsync -> atomic rename -> verify ->
// deletes LAST -> commit; a step failure rolls back from the snapshot. The
// strongest honest guarantee: nothing mutates until a complete, marked snapshot
// exists on disk, so the worst outcome of a crash BEFORE that marker is "the run
// did not happen". Honest ceiling (do not over-claim): if the ROLLBACK's own
// restore fails (e.g. the disk filled), the store can be left MIXED — that case
// is reported as rolledBack:'partial'/'rollback-failed', the journal + snapshot
// are KEPT as the backstop, and a cold-start recovery re-attempts rather than
// clearing over it. So: "wholesale on the common path; partial-and-flagged, with
// the snapshot retained, when a restore itself fails" — never a silent mixed state.
//
// Prior-art shape: WAL + atomic-rename (git ref updates, SQLite, dpkg) — ported,
// not invented. Honest ceiling: fsync is not stronger than the drive's write
// cache (the SQLite/Postgres caveat); the snapshot is the last backstop. On
// Windows, directory fsync is unsupported -> best-effort (wrapped, non-fatal).
//
// Safety gates enforced IN CODE here (they do not depend on agent diligence):
//   - realpath-and-contain BOTH sides on EVERY touched path; fail-closed
//     (an unresolvable or escaping path aborts before anything mutates).
//   - deletes/merges execute when the PLAN carries them — authorization is
//     PLAN-SOURCED (the adjudicated plan IS the authorization; no separate
//     approval flag); safety instead lives in UNDO: a verified snapshot
//     before the first mutation and a whole-run rollback on any failure.
//   - a `pinned: true` frontmatter file refuses delete AND rewrite (gap #1 PIN).
//   - .coalwash.lock: atomic-create + session-id + stale-timeout;
//     defer-on-doubt (an unreadable or fresh foreign lock = held -> defer).
//   - content is written VERBATIM as UTF-8 (no BOM added, no re-encoding, no
//     normalization) — the engine can never decompose Thai U+0E33 or alter
//     line endings; what the caller passed is byte-for-byte what lands.
//   - external-writer guard (the WHS KB946676 stale-commit / cloud-sync
//     co-writer class): every rewrite/delete target is re-read immediately
//     before its mutation and byte-compared against the plan's recorded
//     baseline; a mismatch aborts the whole txn via rollback, naming the file.
//   - snapshot restorability verify (the GitLab all-backups-dead class): every
//     snapshot copy is read back and byte-compared BEFORE the completion
//     marker lands or any destructive step runs.
//   - binary/unparseable sniff (the e2defrag rewrite-what-you-can't-parse
//     class): a NUL-bearing or frontmatter-unclosable rewrite target is
//     FLAGGED and excluded, never rewritten; the run continues on the rest.
//   - own-artifact retention (the ReFS thin-pool leak class): stale completed
//     snapshots are swept at preflight; a dangling txn's snapshot is NEVER
//     swept (recovery owns it).
//   - KEEPS-GATE (beta.12, the r3 "laundering channel" close): an adjudicated
//     keep carrying an anchor (keeps.mjs, project + global stores) binds the
//     EXECUTOR mechanically — a plan action that would erase the anchor from
//     its file is excluded pre-mutation (the file stays untouched) and named,
//     model-independently.
//
// This is a user-invoked engine module (CLI discipline: fail LOUD via the
// returned result object), NOT a Phoenix hook — but it still never throws
// across the API boundary; every path returns { ok, ... }.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { checkFidelity, inventoryDropKeys, readFrontmatter, frontmatterBlockParse } from './fidelity-gate.mjs';
// findProjectRoot: the room's ONE trusted-anchor idiom (cli.mjs/recoverDangling
// derive projectRoot from cwd through it, never from untrusted plan/journal data).
import { claudeBaseDir, findProjectRoot, touchesClaudeBase, canonicalOrNull, volumeCaseFolds } from './config-load.mjs';
// #57(d): the ONE cloud-placeholder read-poison sniff, shared with the estate
// WARM path (one helper, called at both trust points — not a second copy). A
// pure read-only metadata stat; apply keeps its OWN physicalOrNull/containedIn
// (security-audit locality), but this stub-sniff is imported to stay single-source.
import { isCloudPlaceholder, ccMemoryDir, physicalForCreate, containedIn } from './class-b.mjs';
// NOTE a deliberate module cycle: keeps.mjs imports txDirFor/ensureSelfIgnore
// from THIS file. Both sides bind function declarations used only at CALL
// time, so ESM resolves the cycle safely regardless of entry order. tailings.mjs
// forms the SAME shape of cycle (it imports txDirFor/ensureSelfIgnore from
// here; this file imports sweepFatBin/sweepStoreOld from there) — identical
// reasoning, identical safety.
import { loadKeepsAt, KEEPS_NAME, globalKeepsPath } from './keeps.mjs';
// beta.12 item 4: the two bins' retention sweep (fat-bin 30d / store.old 60d,
// retention.mjs's pure policy; 0i adds the store-proportional size cap)
// piggybacks on this SAME preflight touchpoint — a sibling housekeeping call
// to sweepSnapshots below, same fail-silent discipline (a bin failure must
// never block the wash it runs alongside). 0h: recordBinItem is fed from the
// COMMIT below — applyPlan is the one choke-point every cut flows through
// (Quick/Force/wizard all apply through here), so wiring it here wires every
// cut site at once.
import { sweepFatBin, sweepStoreOld, recordBinItem, FAT_BIN_NAME, STORE_OLD_NAME } from './tailings.mjs';
import { TIER1_KEEP_ALL_MS } from './retention.mjs'; // the keep-all floor, for the cap-conflict receipt line (never restate the number)
// 0i V2: the bins' size budget is a multiple of the MEASURED STORE — read
// from the session gauge's cached verdict (caliper state; zero new I/O
// beyond one small state read). caliper imports only config-load/jsonc, so
// this adds no module cycle.
import { loadState } from './caliper.mjs';
// Wikilink-orphan advisory (the git filter-branch cross-reference lesson):
// ONE reference-detection implementation, shared with RE-TIER — never
// duplicated. NOTE the same deliberate module-cycle shape as keeps.mjs/
// tailings.mjs above (retier.mjs imports applyPlan from THIS file): both sides
// bind function declarations used only at CALL time, so ESM resolves the
// cycle safely — identical reasoning, identical safety.
import { unreferencedTopics } from './retier.mjs';

export const LOCK_STALE_MS = 30 * 60 * 1000; // a lock older than 30min is presumed dead
export const KEEP_SNAPSHOTS = 3; // post-success snapshot dirs retained (backup §7.6)
// grad10-round-2 LOW-7: test-only regression counters. Read by nobody in any
// production code path — a plain integer increment costs nothing measurable,
// and it exists because wall-clock could not isolate the KEEPS-GATE's own
// memoization signal from applyPlan's own I/O at any fixture scale (see
// apply.test.mjs's CALL COUNT tests for the measurement that established
// this). Reset to 0 by a test before the call it is measuring.
export const __testHooks = { linePartsMapCalls: 0 };
const JOURNAL_NAME = 'journal.json'; // CoalHearth-visible WAL location: <project>/.claude/coalwash/journal.json
const LOCK_NAME = '.coalwash.lock';
const GLOBAL_LOCK_NAME = '.coalwash-global.lock'; // the global-slice lock, at the ~/.claude root (an inert engine primitive; task #13 moved only the per-project state + update stamp, not this lock)
const SNAP_MARKER = 'snap.complete';

// A target whose files live in the user home's GLOBAL class-B (the global
// CLAUDE.md closure — class-b.mjs's own scope:'global') additionally locks
// HERE, beside the global state file — a per-project lock alone cannot see
// TWO DIFFERENT projects both mutating the same global file (design-pass item,
// MEMORY.md "THE SHARED GLOBAL SLICE").
export function globalLockPath(home = os.homedir()) {
  return path.join(claudeBaseDir(home), GLOBAL_LOCK_NAME);
}

// ---------------------------------------------------------------------------
// small durable-write helpers
// ---------------------------------------------------------------------------
// Exported so estate-archive.mjs reuses the SAME durability primitive (H4 —
// flock-canonical strength, not a second copy). NOTE the module cycle it forms
// (estate-archive -> apply -> retier -> estate-archive): both are function
// DECLARATIONS bound at CALL time, so ESM resolves it safely — identical
// reasoning to the keeps/bins/retier cycles documented in the header.
export function writeDurable(p, data) {
  const fd = fs.openSync(p, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
export function fsyncDirBestEffort(dir) {
  // POSIX: makes the rename itself durable. Windows: opening a dir fd throws —
  // best-effort by design (honest ceiling, documented above).
  try {
    const fd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch { /* best-effort */ }
}
// Atomic replace: write sibling .tmp -> fsync -> rename over target.
// #57 FILESYSTEM-SEMANTICS-ASSUMPTION (MASTER-LOSS-TAXONOMY): rename is atomic
// ONLY within one directory on one filesystem — cross-device it throws EXDEV
// (the Claude Code #32533 class). tmp derives from target, so same-dir holds
// by construction; the assert keeps the invariant EXPLICIT against a future
// edit pointing tmp at os.tmpdir(). An EXDEV (or any rename failure) surfaces
// to applyPlan's step catch -> whole-run rollback, which also sweeps the
// `.coalwash-tmp` sibling — fail-closed, target untouched, no stranded tmp.
function atomicWrite(target, content) {
  const tmp = target + '.coalwash-tmp';
  if (path.dirname(tmp) !== path.dirname(target)) {
    throw new Error(`atomicWrite invariant: tmp must be a same-directory sibling of ${target}`);
  }
  writeDurable(tmp, content);
  fs.renameSync(tmp, target);
  fsyncDirBestEffort(path.dirname(target));
}

// 0h: what a rewrite CUT — the lines present in the gated original and
// absent from the rewritten text (blank lines skipped; set-membership, so a
// merely MOVED line is not "removed"). Line granularity is deliberate: the
// Quick rules are line-structural and the wizard shrink drops wording by the
// line; the byte-perfect whole-store undo stays the snapshot's job — the bin
// is the browsable per-item graveyard, not a second snapshot.
function removedLines(origText, newText) {
  const next = new Set(String(newText).split(/\r?\n/));
  return String(origText).split(/\r?\n/).filter((l) => l.trim() && !next.has(l));
}

// SHARED whitespace-normalized substring survival — grad7 ruling Root B: the
// merge-pair content-containment check (below, in applyPlan) reused this
// technique via a comment ("reusing the KEEPS-GATE's own technique") but the
// KEEPS-GATE's own `norm` was a LOCAL const the merge-pair block never saw —
// the author believed they had copied it; two divergent copies of one
// intended helper is the exact twin-drift shape this file's own case-fold
// primitives were already fixed for (see config-load.mjs). Hoisted to module
// scope so there is now ONE function, not a belief that two matched.
// Collapses all whitespace runs (incl. line-ending differences: CRLF vs LF,
// re-indentation) to a single space — survives the transforms round-8 named
// (CRLF-normalize, re-indent). Does NOT survive a transform that removes
// content outright (frontmatter-strip-before-absorb, section-reorder that
// drops a section) — those are content changes, not whitespace reshaping,
// and no substring check of any shape can distinguish "reshaped" from
// "shortened" without a real diff; named as the fix's honest limit, not
// silently claimed closed.
// grad7 findings-back (round 9 dispatch): the hoist above closed the twin-
// drift but paid for it — a caller with a hot loop over MANY needles against
// the SAME haystacks (the KEEPS-GATE below: one call per keep, per action)
// re-ran normWhitespace() over every haystack on EVERY call, even though the
// haystacks themselves are constant for the whole loop. Measured: 98ms ->
// 3,183ms at 1.2MB of post-texts / 500 miss-path calls (20 keeps x 25
// actions) — a 32.5x regression on the apply hot path. Fix: an OPTIONAL
// third argument lets a hot-loop caller pre-normalize its haystacks ONCE and
// pass them in; textSurvives stays the single shared helper (the whole point
// of the hoist) rather than growing a second, drifting copy for "the fast
// case". A caller that doesn't pass it (the merge-pair check, a bounded,
// cold call) keeps the old lazy-normalize-per-call behavior unchanged.
const normWhitespace = (s) => String(s).replace(/\s+/g, ' ').trim();

// grad9 F2 [HIGH, content-loss]: the flatten-everything normalizer above is
// blind to semantic indentation BY CONSTRUCTION — collapsing every run of
// `\s+` (newlines included) into one space erases the difference between
// "the whole block shifted by a constant amount" (round 8's own CRLF/
// re-indent tolerance target, legitimate) and "one line moved to a
// DIFFERENT relative depth than its neighbors" (a Python statement dedented
// out of a loop, a YAML key re-parented — same tokens, different program,
// per grad9's own fixtures). Fix the CLASS: a needle spanning MORE THAN ONE
// LINE is checked with a window-relative indentation match instead — every
// contiguous run of haystack lines the same length as the needle is tried;
// each line's own internal whitespace is collapsed (still tolerates reflow/
// CRLF), but a haystack line's indentation RELATIVE TO ITS OWN WINDOW must
// equal the needle's indentation relative to ITS OWN first line, exactly. A
// uniform shift of the whole block passes (every line's relative offset is
// unchanged, whichever window start it lands on); a shift of ONE line
// relative to its neighbors fails, at every possible window. Single-line
// needles have no relative structure to defend (there is nothing to be
// relative TO) and fall through to the flatten-everything check below,
// preserving the pre-existing cross-newline prose-reflow tolerance (a
// sentence hard-wrapped mid-phrase) that a multi-line algorithm would break.
function lineParts(s) {
  return String(s).replace(/\r\n?/g, '\n').split('\n').map((line) => {
    const m = /^([ \t]*)(.*)$/s.exec(line);
    return { indent: m[1].length, text: m[2].replace(/[ \t]+/g, ' ').trimEnd() };
  });
}
// grad10 F8 [MEDIUM, false-refusal x3]: exact character-DELTA equality was
// too strict. A uniform tabs->spaces reformat SCALES every level's delta
// (1 tab = 1 char at level 1, 2 tabs = 2 chars at level 2; converted to
// 4-space indents that becomes +4 vs +8 -- proportional, not additive), so
// the exact-delta check refused an ordinary reformat; the same shape hit a
// cosmetic 2-space-vs-3-space list re-indent. Dense RANK of each line's
// indent, not the raw delta: two sequences carrying the SAME relative order
// (line i more/equally/less indented than line j, for every pair) rank
// identically regardless of the absolute unit or scale. A REAL structural
// change (a line moving to a DIFFERENT relative depth than its neighbors --
// the python-dedent / yaml-reparent shapes round 9's fix targets) changes
// at least one pairwise relationship and therefore the rank sequence too --
// cheap O(n log n) stand-in for the O(n^2) pairwise-sign comparison it is
// equivalent to.
function denseRank(indents) {
  const sorted = [...new Set(indents)].sort((a, b) => a - b);
  const rankOf = new Map(sorted.map((v, i) => [v, i]));
  return indents.map((v) => rankOf.get(v));
}
// grad10 F9 [perf, off-subject]: the needle side of a multi-line comparison
// is CONSTANT across every haystack in one `.some()` sweep (one needle, N
// haystacks) — parsing/ranking it inside the per-haystack function meant
// re-doing that work N times for the SAME needle on every single call.
// Hoisted out: `textSurvives` computes it once and hands the pre-computed
// needle down; `indentRelativeSurvives` never re-derives it. This closed a
// second instance of the SAME class the haystack-side fix (below) closes —
// found while proving the haystack-side fix's own perf test, not in the
// dispatch's findings; same root cause, same commit, worth fixing together
// rather than leaving a matching hole one parameter over.
function needleIndentShape(needle, origParts) {
  const n = lineParts(needle);
  const nRanks = denseRank(n.map((l) => l.indent));
  // grad10 F8: an ABSOLUTE-INDENT-EQUALITY gate here (round-10-round-2's
  // HIGH-1 fix) is RETIRED as of grad11 STEP 2 -- RULING-LAYER-3 Amendment 4
  // proved it is a classifier-cell guard, not an invariant guard: F4 showed a
  // trailing blank line (parses to indent 0) makes an otherwise-uniform
  // needle classify as non-uniform "by construction", routing it around the
  // gate entirely, and F9 showed the gate false-refuses a legitimate whole-
  // document reindent (absolute indent changes; the RELATIVE structure to
  // what encloses it does not). `uniform`/`atZero` still classify the needle
  // (used below to choose which structural check applies), but neither
  // bucket carries its own indent-magnitude rule anymore -- see
  // `ancestorChain`/`flattenSurvives` above for the replacement.
  const uniform = new Set(nRanks).size <= 1;
  const atZero = uniform && n[0].indent === 0;
  const shape = { n, nRanks, uniform, atZero, indent0: n[0].indent, flatNeedle: atZero ? normWhitespace(needle) : null, origChain: null };
  // grad11 STEP 2: locate the anchor's TRUE position in the file's OWN
  // original bytes (origParts = lineParts(origBuf), passed by the KEEPS-GATE
  // call site ONLY when checking a keep against ITS OWN file -- never for the
  // cross-file migration sweep, where no "original position in THIS file"
  // exists to derive a chain from). -1 (not located) degrades to no chain,
  // which callers below treat as "cannot verify structurally" -- never a
  // silent pass, see indentRelativeSurvives's own fallback ordering.
  if (origParts) {
    const pos = locateStructural(shape, origParts);
    if (pos !== -1) shape.origChain = ancestorChain(origParts, pos, n[0].indent);
  }
  return shape;
}
function indentRelativeSurvives(shape, haystack, haystackParts, strict = true) {
  const { n, nRanks, atZero, flatNeedle, origChain } = shape;
  const h = haystackParts || lineParts(haystack);
  // grad11 STEP 2 perf (bonus, pre-existing loop): same head-line-text
  // pre-filter as locateStructural's own header comment -- reject the cheap
  // way (one string compare) before paying for denseRank at a position that
  // was always going to fail on `h[start+0].text !== n[0].text` anyway.
  // Pre-existing from round 9/10, not introduced this round; folded in here
  // because it directly reduces the cost this round's own perf check found.
  for (let start = 0; start + n.length <= h.length; start++) {
    if (h[start].text !== n[0].text) continue;
    const hRanks = denseRank(h.slice(start, start + n.length).map((l) => l.indent));
    let ok = true;
    for (let j = 0; j < n.length && ok; j++) {
      if (h[start + j].text !== n[j].text || hRanks[j] !== nRanks[j]) ok = false;
    }
    // grad11 STEP 2: replaces round-10-round-2's absolute-indent gate. When
    // this shape's origin chain is known (checking the anchor against ITS
    // OWN file), a candidate window must preserve that SAME chain among its
    // own enclosing lines -- new ancestors (deeper nesting) are tolerated,
    // dropping an original one is not. When no origChain is available
    // (cross-file migration; the anchor could never have had "an original
    // position" in a file it did not come from), this check is a no-op and
    // the rank+text match above is the whole test -- unchanged behaviour for
    // the migration case, named as a residual in the round's own return.
    if (ok && origChain) { if (!chainPreserved(origChain, ancestorChain(h, start, h[start].indent))) ok = false; }
    if (ok) return true;
  }
  // grad11 STEP 2 [F3]: the flatten fallback ITSELF is where a needle whose
  // OWN lines are all flush-left (atZero) gets checked once the exact
  // rank+text loop above finds no match -- which is exactly what happens
  // when an interior line has been REPARENTED (its own rank changed, so the
  // rank loop correctly fails), and the old code then re-matched on
  // flattened text alone, discarding that failure entirely. `flattenSurvives`
  // additionally requires the matched span's contributing lines to share ONE
  // indent value -- true for a genuine reflow (indentation was never
  // introduced), false for an in-place reparent (one line's indent changed
  // while its neighbours' did not).
  if (atZero) return flattenSurvives(flatNeedle, h, strict);
  return false;
}
// grad11 STEP 2 [CRITICAL, F3+F4+F9 — one predicate, not three]: RULING-LAYER-3
// Amendment 4's construction proved no partition over {needle, post-text} can
// separate a legitimate whole-block move from content escaping its enclosing
// scope -- the two produce BYTE-IDENTICAL windows when the distinguishing
// line (what used to come immediately before the anchor) sits outside both
// inputs. The fix is not a smarter bucket; it is a wider FRAME: locate the
// anchor's own TRUE position in the file's ORIGINAL bytes (origBuf, already
// staged 120+ lines above this file's KEEPS-GATE and unread by it until now),
// derive its ANCESTOR CHAIN (the stack of enclosing lines, outer-to-inner, by
// indent), and require the SAME chain to survive -- by text, in order -- among
// whatever encloses the matched window in the new text. New ancestors may be
// INSERTED (nesting deeper is F9/H4's own legitimate shape); no ORIGINAL
// ancestor may be DROPPED (losing the enclosing line is exactly what content
// escaping a loop/section does). Blank lines carry no structure and are
// skipped when walking for ancestors, closing F4's own bypass (a blank line
// parses to indent 0 and used to make an otherwise-uniform anchor classify as
// non-uniform "by construction", routing it around the absolute-indent gate
// entirely -- the gate this replaces).
function ancestorChain(parts, spanStart, spanIndent) {
  const chain = [];
  // FOUND-DURING-BUILD: seeding `shallowest` at Infinity let a line at the
  // SAME (or greater) indent as the span's own first line register as an
  // "ancestor" -- a SIBLING statement, not an enclosing one. A body dedented
  // to sit flush with its own former loop header (the header text unchanged,
  // only the body's indent dropped) then read as "still enclosed by that
  // header", because the header was merely the shallowest line SEEN, never
  // checked against the span's OWN depth. Seeding with `spanIndent` makes
  // the walk ask the right question from line one: is this STRICTLY
  // SHALLOWER than what it is supposed to enclose?
  let shallowest = spanIndent;
  for (let i = spanStart - 1; i >= 0; i--) {
    const l = parts[i];
    if (!l.text) continue; // blank line -- no structure to record
    if (l.indent < shallowest) { chain.unshift(l.text); shallowest = l.indent; }
    if (shallowest === 0) break; // top-level reached; nothing can enclose it further
  }
  return chain;
}
// Is `origChain` a (possibly proper) SUBSEQUENCE of `candChain`, matched by
// exact line text, in the SAME relative order? A candidate chain may carry
// EXTRA entries (deepened nesting, fine); it may not be missing any original
// entry (an enclosing line that vanished, the loss this check exists to
// catch) or have them out of order (a reordering this codebase has never
// observed but which a stack-based ancestor walk makes free to also reject).
function chainPreserved(origChain, candChain) {
  // FOUND-DURING-BUILD (F9/FR3): an exact-text compare here is TOO STRICT --
  // it refuses a legitimate reflow of the ancestor line ITSELF (e.g. a list
  // marker widened from "- " to "-   ", the F9 list-continuation-shift
  // fixture), because the two spellings of the SAME enclosing line are not
  // byte-identical even though nothing structural moved. Compare each
  // ancestor entry the same way the whole file already tolerates whitespace
  // reflow elsewhere (normWhitespace) -- membership/order is still exact
  // (a missing or reordered ancestor still fails), only its own internal
  // spacing is forgiven.
  let i = 0;
  const normOrig = origChain.map(normWhitespace);
  for (const t of candChain) {
    const nt = normWhitespace(t);
    if (i < normOrig.length && normOrig[i] === nt) i++;
  }
  return i === normOrig.length;
}
// Locate the needle's own exact structural position within `parts` (the SAME
// text+rank match indentRelativeSurvives uses below) -- called ONCE, against
// a file's OWN original lineParts, to derive where the anchor TRULY sat. -1
// if not found (a keep whose anchor does not verbatim-appear in its own
// recorded original -- defensive; should not happen for a real keep, whose
// anchor names literal original content, but the caller degrades safely).
function locateStructural(shape, parts) {
  const { n, nRanks } = shape;
  // grad11 STEP 2 perf: check the cheap head-line TEXT match before paying
  // for `denseRank` (an O(N) allocation+sort) at every candidate position.
  // A needle genuinely absent from `parts` (the common shape on a large,
  // unrelated document -- the round's own worst-case perf probe) rejects on
  // this one comparison at nearly every position instead of building and
  // ranking the whole window first. Measured: ~28% of the round's total
  // fixture cost was this scan running to completion needlessly; this cuts
  // it back toward a single linear pass. Behavior-identical -- `ok` would
  // have gone false at j=0 anyway on a head mismatch.
  for (let start = 0; start + n.length <= parts.length; start++) {
    if (parts[start].text !== n[0].text) continue;
    const ranks = denseRank(parts.slice(start, start + n.length).map((l) => l.indent));
    let ok = true;
    for (let j = 0; j < n.length && ok; j++) {
      if (parts[start + j].text !== n[j].text || ranks[j] !== nRanks[j]) ok = false;
    }
    if (ok) return start;
  }
  return -1;
}
// The atZero/flatten path's own structural guard (F3's fix): map the
// flattened haystack's character offsets back to the ORIGINAL lines that
// contributed them, so a substring match can be checked for INTERNAL indent
// uniformity across whatever span it covers. A reflow (F8-prose-reflow,
// LEGIT-A) never introduces indentation -- every contributing line stays at
// its own flat 0 (or one shared value) -- so a uniform span is safe. A
// reparent WITHIN the anchor's own captured lines (F3's exact shape: a
// flush-left multi-key YAML/statement block where one interior line gets
// indented under its neighbour, text order otherwise untouched) shows up as
// a NON-uniform span even though the flattened text still matches exactly --
// that mismatch is the signal the old raw `.includes()` check discarded.
function flattenWithLineMap(parts) {
  const chunks = [];
  let flat = '';
  for (let i = 0; i < parts.length; i++) {
    const t = parts[i].text;
    if (!t) continue; // blank lines contribute nothing to the flattened text
    if (flat.length) flat += ' ';
    const startAt = flat.length;
    flat += t;
    chunks.push({ lineIndex: i, start: startAt, end: flat.length });
  }
  return { flat, chunks };
}
// WAVE-6 HIGH (cw-class-b-reviewer, INSPECT on 36e4bfa): the uniformity
// requirement below is CONSUMER-SPECIFIC, not a universal property of "did
// this text survive". `strict` (default true) gates it: the KEEPS-GATE
// asks whether an exact protected span's MEANING survives, and a reparent
// changes meaning even when the flattened text still matches -- refuse.
// The merge-pair check (apply.mjs's own applyPlan, ~line 1197) asks only
// whether a deleted file's content was ABSORBED somewhere, so nothing was
// silently destroyed -- a reparent during absorption loses no bytes, and
// refusing there was the actual bug: it makes the merge-pair check
// wrongly conclude "not absorbed", letting BOTH halves proceed
// independently (source survives + destination also gets the content) --
// two copies, the exact defect grad6 §1b exists to prevent. This was
// round 11's own regression: `flattenSurvives` did not exist before that
// round (the merge-pair path only ever went through `textSurvives`'s
// plain single-line-style flatten), so the merge-pair consumer inherited
// a NEW gate it never asked for, silently, through the shared helper.
function flattenSurvives(flatNeedle, haystackParts, strict = true) {
  const { flat, chunks } = flattenWithLineMap(haystackParts);
  const idx = flat.indexOf(flatNeedle);
  if (idx === -1) return false;
  if (!strict) return true;
  const end = idx + flatNeedle.length;
  const spanIndents = new Set();
  for (const c of chunks) { if (c.start < end && c.end > idx) spanIndents.add(haystackParts[c.lineIndex].indent); }
  return spanIndents.size <= 1;
}
// WAVE-6 HIGH: `strict` (default true, the KEEPS-GATE's own need) threads
// through to flattenSurvives's uniformity check -- see that function's own
// header for the two consumers' different questions. The merge-pair check
// (applyPlan, ~:1197) is the one caller that passes `false`.
function textSurvives(needle, haystacks, normHaystacks, haystackLineParts, strict = true) {
  if (haystacks.some((t) => t.includes(needle))) return true;
  // grad10 F3 [HIGH, content-loss]: was `.includes('\n')`, LF-only -- a
  // needle whose lines are joined by a bare CR (no LF anywhere) classified
  // as single-line and fell through to the old flatten check, restoring
  // the EXACT pre-round-9 behaviour for that one line-ending shape.
  // `lineParts` itself already normalizes CRLF *and* bare CR to LF
  // (`replace(/\r\n?/g, '\n')`); the CLASSIFICATION test needs the same
  // breadth or it never reaches code that already handles the shape.
  if (/\r|\n/.test(String(needle))) {
    // grad10 F9 [perf, off-subject]: pass the precomputed lineParts (if the
    // caller memoized them) instead of re-parsing every haystack on every
    // call -- the multi-line path used to branch BEFORE ever touching the
    // memo the KEEPS-GATE below already builds for the single-line path,
    // so a multi-line keep re-parsed every haystack on every one of its
    // (keep x action) calls. Same class as the regression round 9 paid for
    // once already (that one was normWhitespace; this is lineParts). The
    // needle side is hoisted once per textSurvives() call too (see
    // needleIndentShape's own header) — same haystack-vs-needle split the
    // single-line branch below already makes for normWhitespace.
    const shape = needleIndentShape(needle);
    return haystacks.some((t, i) => indentRelativeSurvives(shape, t, haystackLineParts && haystackLineParts[i], strict));
  }
  const normNeedle = normWhitespace(needle);
  const norms = normHaystacks || haystacks.map(normWhitespace);
  return norms.some((t) => t.includes(normNeedle));
}

// grad11 STEP 2: the STRICT, ancestor-chain-aware check -- used ONLY when
// checking a keep's anchor against the SAME file it was recorded against
// (origText = that file's own original bytes, read once already for the
// staging/fidelity baseline). Never applied to any OTHER file's content: a
// migrated anchor has no "original position" in a file it did not come
// from, so the chain check would be meaningless there and would FALSE-REFUSE
// a legitimate merge (rail #2) -- the KEEPS-GATE call site below falls back
// to the existing, unchanged, cross-file `textSurvives` sweep for that case.
//
// WAVE-8 (cw-class-b-reviewer): the single-line branch that used to sit here
// was DELETED, not merely left unreachable. `b3a9893` gates this function's
// ONE call site on `/\r|\n/.test(k.anchor)`, so a single-line anchor is now
// NEVER routed here at all -- the branch had become dead code, and a
// mutation proved it: inverting its answer to `return false` left the whole
// suite green (1095/1095), because nothing could reach it to notice.
//
// The equivalence claim that branch existed to preserve -- "the fallback's
// whole-plan scan is a SUPERSET of the own-file-only check, so nothing the
// strict check would have found is lost" -- is NOT carried by a dead twin;
// dead code cannot fail when the thing it claims to mirror changes. What
// DOES carry it is predicate identity: for a single-line anchor, this
// function's own deleted branch and `textSurvives`'s single-line branch ran
// the IDENTICAL two checks (`includes`, then `normWhitespace(...).includes`)
// -- so removing the twin and routing single-line anchors through the one
// remaining implementation (the fallback, `textSurvives`) does not narrow
// coverage, it just stops maintaining a second copy of the same test.
//
// The real backstop -- verified by mutation, not asserted -- is that a
// FUTURE tightening of `textSurvives`'s single-line branch (:493-498) is
// caught by the KEEPS-GATE's own single-line ACCEPTANCE tests, which the
// WAVE-7 sweep made non-vacuous: "a whitespace-reflowed anchor still
// matches" (pins the HAYSTACK-side normWhitespace tolerance), "an
// IRREGULAR-whitespace anchor still matches a clean rewritten haystack"
// (pins the NEEDLE-side tolerance -- normNeedle = normWhitespace(needle),
// :496; added at WAVE-8 RE-INSPECT after a six-mutation sweep found the
// haystack-side test alone left the needle side uncovered: an irregular
// anchor whose clause was reflowed-and-kept would be wrongly REFUSED under
// a needle-side-only tightening, with the whole suite green), "an anchor
// MIGRATED to another file... passes", and the CALL COUNT single-line-only
// test. Tested directly, both sides: stripping textSurvives's normWhitespace
// tolerance on either side (haystack-only or needle-only) reddens its
// matching test immediately -- restored after confirming.
//
// A future caller of THIS function with a single-line anchor (violating the
// one precondition the current call site enforces) does not crash -- it
// falls through to the ancestor-chain-aware multi-line path below. Measured
// across six single-line cases (incl. reindented and nested): the fallthrough
// agreed with the deleted shortcut on all six -- NO LOOSER, never observed
// stricter. If a new call site needs the old single-line shortcut back, gate
// it the same way the existing one does, rather than reintroducing an
// untested twin.
function survivesOwnFile(anchor, newContent, origText) {
  if (String(newContent).includes(anchor)) return true; // exact substring -- unambiguous either way
  const shape = needleIndentShape(anchor, lineParts(origText));
  return indentRelativeSurvives(shape, newContent);
}

// ---------------------------------------------------------------------------
// wikilink-orphan advisory (post-apply, NEVER a block) — the git
// filter-branch cross-reference lesson: RE-TIER's unreferencedTopics() keeps
// a still-referenced topic in the tree, but the ordinary Quick/Full plan path
// had no equivalent — a plan could delete a topic some SURVIVING file still
// points at ([[wikilink]] / name mention) with no signal. A deliberate delete
// is legitimate, so this only earns ONE advisory line on the receipt.
// ---------------------------------------------------------------------------
const DEADLINK_FILE_CAP = 2000; // defensive walk bound; hitting it only under-reports (advisory-safe)

// Surviving .md files under the plan's own roots. The tx dir subtree is
// excluded — its snapshots/bins CONTAIN the deleted bytes and would mark
// every delete "still referenced". Bounded, fail-silent per entry.
function collectMdFiles(root, txPhys, out) {
  if (out.length >= DEADLINK_FILE_CAP) return;
  let st = null;
  try { st = fs.statSync(root); } catch { return; }
  if (st.isFile()) { if (/\.md$/i.test(root)) out.push(root); return; }
  if (!st.isDirectory()) return;
  if (txPhys && physicalOrNull(root) === txPhys) return; // never read our own snapshots/bins
  let names;
  try { names = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const d of names) {
    if (out.length >= DEADLINK_FILE_CAP) return;
    const p = path.join(root, d.name);
    if (d.isDirectory()) collectMdFiles(p, txPhys, out);
    else if (d.isFile() && /\.md$/i.test(d.name)) out.push(p);
  }
}

// Basenames of deleted .md topics that surviving files still reference.
// Reuses RE-TIER's reference test VERBATIM: a deleted topic modeled with
// EMPTY own-text is "unreferenced" iff no survivor mentions its basename or
// stem; everything NOT unreferenced is still pointed at -> the advisory set.
function deadLinkScan(actionable, physRoots, txDir) {
  const deleted = actionable.filter((a) => a.type === 'delete' && /\.md$/i.test(a.phys));
  if (!deleted.length) return [];
  const txPhys = physicalOrNull(txDir);
  const files = [];
  for (const root of physRoots) collectMdFiles(root, txPhys, files);
  if (!files.length) return [];
  const surviving = files
    .map((p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } })
    .join('\n');
  const topics = deleted.map((a) => ({ path: a.phys, basename: path.basename(a.phys), text: '', mtimeMs: 0 }));
  const unref = new Set(unreferencedTopics({ topics }, surviving).map((t) => t.path));
  return topics.filter((t) => !unref.has(t.path)).map((t) => t.basename);
}

// The ONE advisory line (program-built; a caller places it on the receipt
// verbatim). null when there is nothing to say — silence is the norm.
export function deadLinkLine(deadLinks) {
  if (!Array.isArray(deadLinks) || !deadLinks.length) return null;
  const head = deadLinks.slice(0, 5).join(', ');
  return `advisory: ${deadLinks.length} deleted topic(s) still referenced by surviving files (possible dead [[link]]s): ${head}${deadLinks.length > 5 ? ', …' : ''} — a deliberate delete is fine; recovery door: cli.mjs restore <id>`;
}

// Routes through THE canonicalization primitive (config-load canonicalOrNull):
// .native so an 8.3 short name expands, and a shape it cannot canonicalize (UNC,
// \\?\) yields null so the caller fails closed. Was a bare realpathSync, which
// left a short-name / UNC alias comparing UNEQUAL to the same real directory —
// defeating both the config-territory guard and the older home-swallow guard.
function physicalOrNull(p) {
  return canonicalOrNull(p);
}
// CONSOLIDATED (R5): the duplicate local copy is GONE — apply.mjs imports THE
// containment primitive from class-b.mjs, which already carried the exported twin
// (bodies were identical but for the `export` keyword, and this module already
// imported class-b, so the dedup cost no new dependency edge). One concept, one
// implementation. The class-A engine keeps its own standalone twin ON PURPOSE — it
// may not import this chain — and twin-pin.test.mjs pins the two BEHAVIOURALLY,
// which is exactly why class-A is free to diverge structurally: there is no shared
// primitive to twin, and there does not need to be.

// Flag-not-rewrite sniff (ports e2defrag's rewrite-what-you-can't-parse; the
// NUL-sniff mirrors CoalLedger beta.5's doc-unreadable guard, flock-canonical):
// a NUL byte marks binary/undecodable content; an opening frontmatter fence
// that never closes marks a file our frontmatter tooling cannot faithfully
// parse. Either way the REWRITE is refused (flagged to the caller) — deletes
// are not sniffed, they stay behind the stricter pinned + containment gates
// (delete authorization itself is plan-sourced, below; UNDO is the safety net).
export function sniffUnrewritable(buf) {
  if (buf.includes(0)) return 'binary content (NUL byte) — flagged, not rewritten';
  const text = buf.toString('utf8');
  // ── THE ROUND TRIP (USER ruling 2026-07-28) ────────────────────────────────
  // A REWRITE reads the file as TEXT, so a byte that is not valid UTF-8 came
  // back as U+FFFD and was then written OVER the original — the live file lost
  // the byte, permanently. Measured through the shipped door: `sniffUnrewritable`
  // returned null and applyPlan reported ok.
  //
  // THE GATE CANNOT COVER THIS, which is why the refusal has to live here:
  // checkFidelity compares structured tokens of before and after, and BOTH sides
  // were decoded the same lossy way, so the inventories match and nothing drops.
  //
  // WHY A ROUND TRIP AND NOT AN ENCODING DETECTOR: a detector guesses, and a
  // wrong guess is a NEW risk on a tool that overwrites memory. `decode ->
  // re-encode -> compare bytes` asks the only question that matters — can this
  // file survive the trip we are about to put it through — and answers it
  // exactly, deterministically, with no table and no heuristic. Valid UTF-8 is
  // byte-identical through it whatever the script; Thai, CJK and emoji pass by
  // construction, and a control test pins that so nobody reads this as an
  // ASCII rule.
  //
  // ORDER: after the NUL check (cheaper, and it already catches UTF-16/binary)
  // and BEFORE readFrontmatter — there is no point parsing a decode that is
  // already known to be lossy.
  //
  // THE DECLARED TRADE: a non-UTF-8 file is FLAGGED, not washed. Yield loss,
  // never safety loss, and the user has a way out — convert it to UTF-8 and
  // CoalWash treats it normally — so the message says so rather than reporting
  // a vague "unverifiable" that sounds like CoalWash is confused about its own
  // state.
  // DELETES DO NOT PASS THROUGH THIS GUARD — nothing is rewritten and the bins
  // bank the original bytes. They are NOT decode-free, though, and the earlier
  // wording here ("deletes never decode") was an absolute in a scope paragraph,
  // which is exactly what stops the next reader looking: `isPinned` decodes a
  // 64 KiB head on every delete to read the pin. That decode fails CLOSED —
  // undecodable head, or a block that does not close inside the window, is
  // `unverifiable` = pinned = refuse — so the delete path is safe by its own
  // gate, not by never decoding.
  if (!Buffer.from(text, 'utf8').equals(buf)) {
    return 'not valid UTF-8 — a legacy single-byte encoding (CP1252 / Latin-1, e.g. a Notepad "ANSI" save) or another non-UTF-8 encoding: rewriting it would replace the undecodable bytes with U+FFFD and lose them permanently — flagged, not rewritten (convert the file to UTF-8 and CoalWash will wash it normally)';
  }
  // ONE frontmatter primitive, shared with isPinned and the gate's
  // frontmatterKeys (fidelity-gate.mjs) — see its comment for why a private
  // `/^---\r?\n/` here was blind to a BOM. This caller's safe direction: an
  // unverifiable head means "do not rewrite".
  const fm = readFrontmatter(text);
  if (fm.state === 'unverifiable') return `${fm.why} — flagged, not rewritten`;
  // ROUND 7 (amended rc.10). `pinVerdict` also refuses an unreadable block —
  // since the two-tier gate, per-file there too (incapacity never aborts the
  // plan any more; only a MARKER pin does). This sniff stays the rewrite
  // path's FIRST refusal because it reads the FULL text (the pin window is
  // 64 KiB) and its reason names the user's problem plus the way out rather
  // than a pin-shaped message.
  const parsed = frontmatterBlockParse(fm.block);
  if (parsed.unreadable) {
    return `${parsed.unreadable}: CoalWash cannot prove which frontmatter keys are top-level, so it will not rewrite this file — flagged, not rewritten (put the block on one indentation as plain \`key: value\` lines, or remove the frontmatter, and CoalWash will wash it normally)`;
  }
  return null;
}

// pinned: true in a leading frontmatter block = PIN-protected (gap #1) —
// immune to trim/delete. FAIL-CLOSED: any state we cannot verify counts as
// pinned (refuse to touch), matching the realpath/containment fail-closed
// discipline — "untouchable at all" must not degrade to fail-open on a read
// error or a frontmatter block we could not fully read.
const PIN_READ_BYTES = 65536; // covers any sane frontmatter; a block that does not close within this = unverifiable
// WHAT CLEARS A PIN, and it is an ALLOWLIST because the OTHER answer deletes
// files. Round 4 fixed the fence by making `'none'` EARNED; this is the same
// polarity one layer up: `pinned:` present and NOT pinned is earned by one of
// these three explicit negations, and every other value — `maybe`, `0`, `[]`,
// empty, or a spelling nobody has thought of — refuses. Three members, checkable
// by reading them; that is a statement about THIS LIST, not about YAML.
// THE PRICE, pinned by its own test: a `pinned: n` (YAML 1.1 false) file is
// refused too. Yield loss, never safety loss — the deliberate direction for a
// predicate whose `false` authorises destruction.
const PIN_CLEARED = new Set(['false', 'no', 'off']);
// THE FLOOR (round 6). This is the predicate G3-1 retired, and it is here as a
// CLAUSE rather than as a test oracle because a test cannot protect a file.
// G3-1 kept it in the suite instead and asserted a universal — "whatever it
// protected stays protected" — over SEVEN hand-written strings. The universal
// was false: `\s` spans LINE TERMINATORS and a one-parse-per-LINE reader cannot,
// so `pinned` + newline + `: true` was PIN-protected before G3-1 and DELETED
// after it (1458 of the 19683 shapes this regex admits, measured against the
// pre-fix engine as the control).
// WHAT IS CLAIMED, AND ITS BOUND: over the block `readFrontmatter` returns, this
// predicate's verdict is OR'd in, so its protected set is a floor BY
// CONSTRUCTION — same regex, same input, and a `true` here can never be undone
// below. That is a statement about THIS clause, not about pin spellings in
// general, and the per-slot sweep in the suite is what proves the clause is
// actually wired.
// WHY THIS IS NOT THE TWO-READER DEFECT COMING BACK: G3-1's bug was two readers
// disagreeing where the answer that LOSES authorises a delete. This is a
// monotone widening — it can only ever ADD pins, never remove one — so there is
// no verdict it can win that costs a file. Do not "simplify" it away.
const RETIRED_PIN_FLOOR = /^pinned\s*:\s*true\s*$/m;
const unquote = (s) => (s.length > 1 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0] ? s.slice(1, -1) : s);
// A YAML comment starts at ` #`; stripping it can only ever REMOVE characters,
// so it cannot manufacture a member of PIN_CLEARED out of quoted content (an
// unbalanced quote survives unquote and misses the set).
const pinValueClears = (raw) => PIN_CLEARED.has(unquote(String(raw).trim().replace(/\s+#.*$/, '').trim()).trim().toLowerCase());
const pinKey = (k) => unquote(String(k).trim()).trim().toLowerCase() === 'pinned';
// THE VERDICT CARRIES ITS TIER (rc.9 station-3 MED — the whole-plan DELETE
// abort). `pinned` is the boolean every caller always had; `marker` says WHY:
//   marker: true  — a pin was actually READ (`pinned: true` via the floor or a
//                   parsed entry). A plan naming such a file violated an
//                   explicit user marker -> the plan is malformed, distrust it
//                   whole (applyPlan aborts, unchanged behaviour).
//   marker: false — refusal from INCAPACITY (unverifiable head, unreadable
//                   block, read error). That is CoalWash's own limitation, not
//                   the plan's fault -> applyPlan refuses that file PER-FILE
//                   (untouched, flagged with the way out) and the rest of the
//                   plan proceeds — the same channel sniffUnrewritable gives
//                   rewrites. The refused file itself is equally safe on both
//                   tiers; the tier only decides whether the REST of the plan
//                   is trusted.
//
// CORRECTED (grad6 §1c, round-6 CoalBoard verdict): each bullet above is true
// on its own, but read together they read as if the two `marker: true` paths
// (the RETIRED_PIN_FLOOR regex and the parsed-entry check) are the COMMON
// outcome for anything pin-shaped, with incapacity as the exception. Measured
// the other way: a 63-cell battery (spelling variants x junk-shapes of
// "something pin-like") landed 42 of 63 on INCAPACITY, not the marker path,
// BECAUSE `parsed.unreadable` (the incapacity check, just below) runs BEFORE
// the parsed-entry check and intercepts anything the block-reader cannot
// fully account for -- which is most real-world junk. So "via the floor or a
// parsed entry" is a NARROW, exact-conforming trigger (the whole frontmatter
// block must be cleanly, completely parseable), not a broad catch for
// anything that merely resembles a pin; the common case for messy/malformed
// content is the gentler per-file incapacity refusal below, not a whole-plan
// abort.
function pinVerdict(file) {
  try {
    const fd = fs.openSync(file, 'r');
    let head;
    let truncated;
    try {
      const buf = Buffer.alloc(PIN_READ_BYTES);
      const n = fs.readSync(fd, buf, 0, PIN_READ_BYTES, 0);
      head = buf.toString('utf8', 0, n);
      // COMPLETENESS IS A PROPERTY OF THE FILE, NEVER OF THE READ. This line
      // used to be `n < PIN_READ_BYTES` — "a short read reached EOF" — which
      // infers completeness from the byte COUNT, and `read(2)` may legally
      // return fewer bytes than asked for. #57 FILESYSTEM-SEMANTICS below
      // already names the mounts where that happens. A short read then looked
      // exactly like end-of-file, `$` fabricated a close, and G3-2 was open
      // again on any such mount. `fstat` answers the actual question and is
      // exact, so it also closes the residual the byte count carried: a file of
      // EXACTLY PIN_READ_BYTES was treated as truncated, which refused the one
      // complete shape that closes only via `$` (last bytes = the fence).
      // Taken AFTER the read on purpose: a concurrent append then shows up as
      // truncated, which is the safe direction.
      truncated = fs.fstatSync(fd).size > n;
    } finally {
      fs.closeSync(fd);
    }
    // ONE frontmatter primitive (fidelity-gate.mjs readFrontmatter), shared with
    // sniffUnrewritable above and the gate's frontmatterKeys. THE LINE THAT USED
    // TO BE HERE — `if (!/^---\r?\n/.test(head)) return false; // no frontmatter
    // opener = definitely not pinned` — was this whole function's contract
    // inverted by one word. "definitely" was a confident claim that was simply
    // false: a 3-byte UTF-8 BOM in front of the fence makes the test say no, so a
    // `pinned: true` file read as UNPINNED and applyPlan DELETED it. The docstring
    // above already promised fail-closed; that line was the one place the code
    // did not do it. Each state's direction is now declared explicitly rather
    // than falling out of a boolean's default branch.
    // `truncated` is the whole of G3-2: `head` is a 64 KiB WINDOW, and until
    // this argument existed the primitive read the end of that window as a
    // legitimate end-of-file. A `\n---` landing on the cut therefore fabricated
    // a close and every key past it — including the pin — went unseen.
    const fm = readFrontmatter(head, { truncated });
    // Unverifiable = an undecodable head (encoding preamble) OR an opener that
    // does not close inside PIN_READ_BYTES -> refuse to touch.
    if (fm.state === 'unverifiable') return { pinned: true, marker: false, why: fm.why || 'frontmatter unverifiable inside the pin read window' };
    if (fm.state === 'none') return { pinned: false, marker: false }; // decodable, and genuinely no frontmatter
    // ONE READER (G3-1). This used to be a PRIVATE /^pinned\s*:\s*true\s*$/m
    // over the block the primitive returned, while fidelity-gate's
    // frontmatterKeys parsed the SAME block with a different regex — and the
    // gate counted a `pinned` key in six spellings this predicate called
    // unpinned, so applyPlan deleted them. The fix is not a cleverer regex (that
    // would be the sixth patch on this one line); it is that there is now only
    // one parse of the block, and this caller declares its own safe direction
    // over the entries — LOOSE ENTRIES INCLUDED, because the retired regex
    // protected `pinned:true` (no space) that the gate's strict key shape does
    // not see, and a merge that drops it would be LOOSER than what it replaced.
    // That reasoning was right and INCOMPLETE — the loose entry covers what one
    // LINE can hold, and the retired regex also spanned line terminators. So its
    // verdict is OR'd in as the floor (see RETIRED_PIN_FLOOR).
    if (RETIRED_PIN_FLOOR.test(fm.block)) return { pinned: true, marker: true };
    // ROUND 7 — THE QUESTION IS INVERTED, and that is the whole change. Six
    // repairs before this one asked "is there a pin?" and answered it more
    // cleverly each time; the seventh breach (an indented `pinned: true`, read
    // as no-pin and DELETED) landed anyway. `unreadable` makes the destroying
    // branch require a POSITIVE proof instead: every line of the block is
    // accounted for, or this file is untouchable.
    //
    // WHAT THAT BUYS, AND EXACTLY WHERE IT STOPS — station 3 found the edge and
    // it is worth more than the slogan. The claim holds against every way a line
    // can be MIS-CLASSIFIED: a wrong verdict about a line we HAVE cannot
    // manufacture "accounted for", it can only break it, which is the safe side.
    // **It is bounded by the line-splitting it counts over — and that bound is
    // now ENFORCED rather than named (rc.10, closing the round-7 residual).**
    // YAML 1.2 also breaks on a LONE CR (`b-break ::= CRLF | CR | LF`) while
    // the reader splits on `/\r?\n/`, so a mixed-ending block used to join
    // `  title: x<CR>  pinned: true` — a top-level pin by YAML — into one
    // accounted-for line, and the file was deletable. `frontmatterBlockParse`
    // now refuses a block containing a bare CR (the same discipline as
    // `readFrontmatter`'s `cr` fence branch), so a wrong line basis lands on
    // `unreadable` = this refusing branch, never on "accounted for".
    const parsed = frontmatterBlockParse(fm.block);
    if (parsed.unreadable) return { pinned: true, marker: false, why: parsed.unreadable };
    return parsed.entries.some((e) => e.top && pinKey(e.key) && !pinValueClears(e.value))
      ? { pinned: true, marker: true }
      : { pinned: false, marker: false };
  } catch {
    // read error on a file we are about to mutate -> refuse (fail-closed);
    // incapacity, not a marker read.
    return { pinned: true, marker: false, why: 'read error while checking the pin (fail-closed)' };
  }
}
export function isPinned(file) {
  return pinVerdict(file).pinned; // the boolean every existing caller keeps — decisions byte-identical
}

// ---------------------------------------------------------------------------
// lock — atomic-create + session-id + stale-timeout + defer-on-doubt
// ---------------------------------------------------------------------------
// NAMED ASSUMPTION (#57 FILESYSTEM-SEMANTICS): O_EXCL ('wx') exclusive-create
// is atomic on a LOCAL filesystem; a network/cloud-synced mount (NFS, sync
// clients) may break that exclusivity — the SVN BDB-on-NFS lesson. The cheap
// conservative belt: EVERY acquire (fresh and stale-steal alike) re-reads the
// lock after writing and must find its OWN token — a foreign token means the
// "win" was a lost race a broken O_EXCL let through -> defer (fail-closed;
// the stale-steal path already did this, the fresh path now matches). No
// mount-detection is attempted (over-harden).
// A per-acquire owner TOKEN so the release and the stale-takeover can prove
// ownership (never delete a lock another run now holds). hrtime.bigint() is a
// monotonic counter (not wall-clock) — distinct on every call, so two acquires
// in one process never collide; two processes differ by pid.
function ownerToken(sessionId) {
  return `${sessionId}:${process.pid}:${process.hrtime.bigint()}`;
}
function readLockToken(lockPath) {
  try { return JSON.parse(fs.readFileSync(lockPath, 'utf8')).token ?? null; } catch { return null; }
}
export function acquireLock(lockPath, { sessionId = String(process.pid), staleMs = LOCK_STALE_MS, now = Date.now() } = {}) {
  const token = ownerToken(sessionId);
  const body = JSON.stringify({ sessionId, pid: process.pid, at: now, token });
  // release deletes the lock ONLY if it still carries OUR token (a slow/suspended
  // holder whose lock was stolen must not delete the new holder's lock — HIGH #4).
  const releaseIfOwner = () => { try { if (readLockToken(lockPath) === token) fs.rmSync(lockPath, { force: true }); } catch {} };
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    ensureSelfIgnore(path.dirname(lockPath));
    const fd = fs.openSync(lockPath, 'wx'); // atomic create: exactly one fresh acquirer wins
    try { fs.writeSync(fd, body); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    // compare-after-write (the header's named-assumption belt): a foreign
    // token on re-read = O_EXCL did not actually exclude us -> defer.
    if (readLockToken(lockPath) !== token) return { acquired: false, reason: 'exclusive-create acquire lost a race (non-local filesystem?) — deferring' };
    return { acquired: true, release: releaseIfOwner };
  } catch (e) {
    if (e && e.code !== 'EEXIST') return { acquired: false, reason: `lock error: ${e.message}` };
  }
  // Lock exists — stale takeover ONLY when demonstrably old; any doubt = defer.
  try {
    const st = fs.statSync(lockPath);
    if (now - st.mtimeMs > staleMs) {
      // STEAL IN PLACE (no rm -> no missing-file window a third writer could slip
      // through). Two racing stealers overwrite the same file; whoever's write
      // lands last owns it, the other's compare-after-write fails -> it defers
      // (worst case both defer on a byte-interleave = a safe retry, never a
      // double-hold). Fixed width via truncate so a shorter write leaves no tail.
      const fd = fs.openSync(lockPath, 'r+');
      try { fs.ftruncateSync(fd, 0); fs.writeSync(fd, body, 0); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      if (readLockToken(lockPath) === token) return { acquired: true, stale: true, release: releaseIfOwner };
      return { acquired: false, reason: 'stale-lock takeover lost a race — deferring' };
    }
  } catch { /* unreadable lock = doubt = defer */ }
  return { acquired: false, reason: 'another CoalWash run (or a live session) holds the store — deferring' };
}

// ---------------------------------------------------------------------------
// the transaction
// ---------------------------------------------------------------------------
export function txDirFor(projectRoot) {
  return path.join(projectRoot, '.claude', 'coalwash');
}

// The tx dir self-ignores: a `.gitignore` containing `*` INSIDE it keeps the
// journal/snapshots (memory-content copies) out of version control even when
// the user's project tracks `.claude/` — code-enforced, not a doc promise.
// Best-effort (fail-silent): a read-only fs must never block the transaction.
export function ensureSelfIgnore(dir) {
  // Exclusive create (no exists-then-write TOCTOU): two racing writers both try
  // 'wx'; one wins, the other gets EEXIST — both harmless (the content is
  // identical). Any other error is swallowed (best-effort, must never block a tx).
  try { fs.writeFileSync(path.join(dir, '.gitignore'), '*\n', { flag: 'wx' }); }
  catch (e) { if (e && e.code !== 'EEXIST') { /* read-only fs etc — ignore */ } }
}

// plan = {
//   projectRoot: IGNORED — the transaction dir + lock + the containment trust
//     anchor come from the CALLER (opts.projectRoot, else findProjectRoot(cwd)),
//     NEVER this field (untrusted plan data; see the derivation in applyPlan). A
//     caller may still set it for documentation, but the engine does not read it.
//   roots: [abs...]            — the declared class-B roots writes may touch,
//   actions: [{ type: 'rewrite'|'create'|'delete', path, content?, expectedOrig?, scope? }],
//     expectedOrig (optional, rewrite/delete): the content the caller SCANNED
//     and gated against. When provided, the external-writer guard compares the
//     live file against it — covering the whole scan -> apply window,
//     including any wait before the mutation (a cloud-sync clobber during
//     that wait is caught). When absent, the baseline is the content staged
//     at applyPlan time (the intra-transaction window only).
//     scope (optional, 'global'|'project', def 'project'): 'global' means this
//     target lives in the user home's global class-B (e.g. the global
//     CLAUDE.md closure) — the transaction ALSO takes a lock beside the global
//     state file (globalLockPath) so two DIFFERENT projects' runs can never
//     interleave writes to the same global file, which a per-project lock
//     alone cannot see.
//   sessionId?: string,
//   origin?: 'program-cut'|'wizard-cut' (def 'program-cut') — 0h bin routing:
//     which graveyard this plan's cuts land in. Program cuts (Quick/Force
//     structural rules) ride the default -> FAT bin; a WIZARD-tier plan
//     (deletes, shrink rewrites) declares 'wizard-cut' -> the wizard bin
//     (store.old). Anything else folds to 'program-cut' (recordBinItem's own
//     rule — garbage never persists).
// }
// Delete/merge authorization is PLAN-SOURCED, not a separate flag: a delete
// action present in actions[] is authorized by having come from the
// adjudicated plan (the insider-adjudication step) — same trust boundary as
// `approvedDrops` below. There is no `deletesApproved` field to set; UNDO
// (snapshot + whole-run rollback) is the safety net instead of pre-approval.
// opts.projectRoot — the CALLER-TRUSTED project root (the containment anchor +
//   tx-dir/bins/state home). A trusted caller (cli.mjs, runRetier) passes its
//   cwd-derived findProjectRoot value here; when absent, applyPlan derives it from
//   opts.cwd || process.cwd(). This is the ONE channel that can widen containment,
//   so it must never be sourced from the (untrusted) plan.
// opts.cwd (def process.cwd()) — only feeds the findProjectRoot fallback above.
// opts.home (def os.homedir()) — where globalLockPath resolves; override for
// hermetic tests, exactly like opts.txDir/opts.now/opts.keepSnapshots.
// Returns { ok, deferred?, error?, applied?, snapshotDir?, rolledBack?, flagged? }.

// THE ANCHOR GATE — ONE primitive, both mutating doors. Returns
// { ok:true, roots } or { ok:false, error }.
//
// `applyPlan` and `recoverDangling` are the two functions that MUTATE the store,
// and both build the SAME trusted-root set from the same project anchor. Until
// this was extracted, only applyPlan carried the two guards in front of that
// derivation — so recoverDangling was applyPlan WITHOUT THE GUARDS. A
// repo-shipped `.claude/coalwash/journal.json`, reached through `cli.mjs gauge`
// (Step 0 of every run, and the /stats front door), could therefore ride a
// home-collapsed or config-territory anchor into restoring attacker bytes over
// ~/.claude/settings.json and rmSync-ing ~/.ssh — exit 0, and the journal is
// deleted on the success path so the evidence self-destructs. R5 closed the
// SOURCE axis of that function (snapDir bound to the caller-derived tx dir);
// the TARGET axis was never enumerated.
//
// WHY THIS IS EXTRACTED AND NOT PASTED — recorded so nobody re-does the wrong
// fix. Copying the two guards above recoverDangling's derivation is six correct
// lines and the twin-drift shape this room has now paid for three times (R2's
// case-fold, R3's 8.3 short name, detonate's mixed realpath variant): two peer
// functions with duplicated guards diverge the moment someone hardens one side,
// and the divergence ships silently because both still LOOK guarded. R3's law is
// FIX THE PRIMITIVE, NEVER THE GUARDS.
//
// `trustedAnchor` = the caller supplied its OWN anchor (applyPlan's
// opts.projectRoot: cli.mjs / runRetier) instead of deriving it from cwd. It
// skips ONLY the home-swallow check, which exists for a DERIVATION collapsing to
// home. recoverDangling never sets it: its `projectRoot` parameter is whatever
// its caller derived from cwd, and it has no way to tell a derived anchor from a
// vouched one, so it takes the fail-closed reading.
function trustedRootsForAnchor(projectRoot, home, { trustedAnchor = false } = {}) {
  // SECURITY — DERIVED-ANCHOR HOME-SWALLOW GUARD (untrusted-anchor path only).
  // When the anchor is DERIVED, findProjectRoot can collapse it to home: cwd=home
  // with no marker (returns home), OR a non-git cwd under a home that itself
  // carries ~/.git (versioned dotfiles) — the walk climbs past the unmarked
  // project to the ~/.git marker and returns home. A home-level anchor puts ~
  // ITSELF into the trusted roots below, so the containment gate faithfully
  // authorizes a forged roots:[home] to delete ~/.ssh AND inject a hook into
  // ~/.claude/settings.json => code execution next session. Refuse fail-closed
  // when the anchor SWALLOWS home (is home, or an ancestor of it) — realpath BOTH
  // sides, the room's own containedIn (home inside anchor === anchor contains
  // home). A derived anchor BELOW home (a real project dir, git or not) stays
  // ALLOWED — a forged roots:[home] then escapes it and the gate refuses as
  // before, blast bounded to the project + snapshot-backed; non-git users keep
  // working (no-external-assumption).
  if (!trustedAnchor) {
    const anchorPhys = physicalOrNull(projectRoot);
    const homePhys = physicalOrNull(home);
    if (!anchorPhys || !homePhys || containedIn(homePhys, [anchorPhys])) {
      // THE REMEDY NAMES ONLY WHAT IS TRUE FOR EVERY CALLER. This message used to
      // end "or pass a trusted opts.projectRoot" — accurate for applyPlan, and a
      // dead end for recoverDangling, which has no such channel and can never set
      // trustedAnchor. A refusal that offers a remedy the reader cannot perform is
      // worse than one that offers none: it sends them looking for an option that
      // does not exist on the door they are standing at. "Run from the actual
      // project dir" is the remedy for BOTH. The developer-facing half lives in
      // the comment above, where a developer is already reading.
      return { ok: false, error: `containment: the derived project anchor (${anchorPhys || projectRoot}) is the home directory or an ancestor of it — refusing fail-closed (a home-level anchor would authorize writes anywhere under ~, e.g. ~/.ssh or ~/.claude/settings.json); run from the actual project dir` };
    }
  }
  // SECURITY — CONFIG-TERRITORY ANCHOR GUARD (the trust boundary; blind wave R2).
  // The Claude base dir holds settings.json (a `SessionStart` command hook there =
  // code execution next session) and the plugin cache (a rewritten conductor.js =
  // the same). NOTHING in there is ever a project to wash, so no legitimate anchor
  // touches it — the global class-B store CoalWash DOES wash enters the trusted
  // set below as ccMemoryDir, derived FROM the project anchor, never as the
  // anchor itself.
  //
  // ONE question, asked ONCE, at the consumer: does the anchor touch config
  // territory in EITHER direction (inside it, or containing it)? That is
  // deliberately the OPPOSITE nature to findProjectRoot's marker walk — two earlier
  // attempts hardened the WALK and were walked past. It binds a TRUSTED anchor
  // too: no caller has a legitimate config-dir anchor, so binding it deletes the
  // "which callers are trusted" question from a security path.
  //
  // WHAT THIS ACTUALLY GUARANTEES, and its LIMIT. The comparison is only as good as
  // the canonical form underneath it, so the strength lives in config-load's
  // `canonicalOrNull`: `realpathSync.native` (expands win32 8.3 short names, which
  // plain realpathSync does NOT) plus case-folding, across EVERY CLAUDE_CONFIG_DIR
  // entry.
  // THE LIMIT — stated plainly, and corrected a THIRD time, because each
  // previous wording was complete-sounding on exactly the axis that was still open:
  //   v1 "the base dir is never a project root"  -> false: the walk's fallbacks.
  //   v2 "unconditional, every entry, both directions" -> false: 8.3 / UNC spellings.
  //   v3 "either canonicalized and compared, or refused by shape" -> STILL false:
  //      it described only the ANCHOR. An unresolvable BASE on the other side of the
  //      comparison silently answered "does not touch" for every anchor and turned
  //      this guard into a no-op.
  // WHAT HOLDS NOW: BOTH SIDES refuse rather than pass. The anchor is canonicalized
  // or refused; a configured base dir that EXISTS but cannot be canonicalized also
  // refuses; only a genuinely ABSENT base is treated as no-constraint (nothing to
  // contain, and a fresh install must still work). That is a statement about both
  // inputs of a two-sided compare — which is the shape of claim this guard's history
  // says to make. A new path form joins the refuse list in `canonicalOrNull`; it is
  // never waved through here.
  if (touchesClaudeBase(projectRoot, home)) {
    return { ok: false, error: `containment: the project anchor (${projectRoot}) is inside the Claude configuration directory (or contains it) — refusing fail-closed (that tree holds settings.json and the plugin cache; a write there is next-session code execution). Run from the actual project directory.` };
  }
  // THE TRUSTED OUTER GATE. Both doors take untrusted root lists — applyPlan its
  // plan.roots, recoverDangling its journal.roots — and anchoring containment on
  // EITHER alone is CIRCULAR: the same artifact supplies both the target AND the
  // roots that "contain" it, so the check always passes. Anchor on the roots a
  // plan/journal cannot widen. The PRECISE legit set (NOT the whole ~/.claude —
  // that would still let a poisoned artifact target ~/.claude/settings.json =
  // hook/permission injection):
  //   - projectRoot      — every project-scope store (project MEMORY.md,
  //                        .claude/agent-memory/<role>/, CW's own tx dir);
  //   - ccMemoryDir(...) — the ONLY global-physical store CoalWash washes today:
  //                        ~/.claude/projects/<slug>/memory (the 'main' store in
  //                        runRetier's collectStores).
  // The untrusted list stays a SECONDARY narrowing: it may restrict to a SUBSET,
  // never widen past these. ponytail: when the PENDING global-GOVERNANCE wash
  // driver ships (MEMORY "Global lock/keeps DRIVER"), add those SPECIFIC roots
  // here — never claudeBaseDir wholesale.
  const roots = [physicalOrNull(projectRoot), physicalOrNull(ccMemoryDir(projectRoot, home))].filter(Boolean);
  if (!roots.length) return { ok: false, error: 'containment: no trusted root resolves (fail-closed)' };
  return { ok: true, roots };
}

export function applyPlan(plan, opts = {}) {
  const now = opts.now || Date.now();
  const home = opts.home || os.homedir();
  try {
    // ---- validate shape (fail loud, nothing touched) ----
    if (!plan || typeof plan !== 'object') return { ok: false, error: 'plan must be an object' };
    const { roots, actions } = plan;
    // THE TRUST ANCHOR is the CALLER's projectRoot, NEVER plan.projectRoot. The
    // plan is untrusted (method.md §4 runs `applyPlan(JSON.parse(PLAN.json))`),
    // so a forged plan's projectRoot is attacker-chosen — anchoring containment on
    // it is circular ONE LEVEL UP: the plan supplies BOTH the victim path AND the
    // "projectRoot" that would contain it, so the check always passes (the live
    // A1/A2 escape). Source it exactly as recoverDangling/cli.mjs do — the trusted
    // caller root via opts.projectRoot, or, absent that, findProjectRoot(cwd): the
    // agent's REAL working dir, which a forged PLAN.json cannot move. plan.projectRoot
    // is IGNORED; a forged one is then caught below because its declared roots will
    // not sit inside the real trusted set (the fail-closed the containment gate gives).
    const projectRoot = opts.projectRoot || findProjectRoot(opts.cwd || process.cwd(), home);
    // THE ANCHOR GATE (see trustedRootsForAnchor above): the home-swallow guard,
    // the config-territory guard, and the trusted-root derivation — the SAME three
    // recoverDangling runs, from the same primitive, so they cannot drift apart.
    // A trusted opts.projectRoot skips only the home-swallow leg.
    const anchorGate = trustedRootsForAnchor(projectRoot, home, { trustedAnchor: Boolean(opts.projectRoot) });
    if (!anchorGate.ok) return { ok: false, error: anchorGate.error };
    if (!Array.isArray(roots) || !roots.length) return { ok: false, error: 'plan needs non-empty roots[]' };
    if (!Array.isArray(actions) || !actions.length) return { ok: false, error: 'plan needs non-empty actions[]' };
    for (const a of actions) {
      if (!a || !['rewrite', 'create', 'delete'].includes(a.type)) return { ok: false, error: `unknown action type: ${a && a.type}` };
      if (!a.path || !path.isAbsolute(a.path)) return { ok: false, error: `action path must be absolute: ${a && a.path}` };
      if ((a.type === 'rewrite' || a.type === 'create') && typeof a.content !== 'string') return { ok: false, error: `${a.type} needs string content: ${a.path}` };
      if (a.expectedOrig !== undefined && typeof a.expectedOrig !== 'string') return { ok: false, error: `expectedOrig must be a string when provided: ${a.path}` };
    }

    // ---- containment: realpath-and-contain BOTH sides, fail-closed ----
    const physRoots = roots.map((r) => physicalOrNull(r)).filter(Boolean);
    if (physRoots.length !== roots.length) return { ok: false, error: 'containment: a declared root does not resolve (fail-closed)' };
    // The trusted outer gate, resolved once by the anchor gate above (its comment
    // carries the full rationale). plan.roots is the SECONDARY narrowing validated
    // against it here, element by element — the whole plan is refused if any
    // declared root escapes, which is what makes physRoots safe to gate actions on
    // later (root-provenance.test.mjs keys on this exact loop).
    const trustedRoots = anchorGate.roots;
    for (const r of physRoots) {
      if (!containedIn(r, trustedRoots)) return { ok: false, error: `containment: declared root ${r} escapes the caller-trusted roots (projectRoot + global class-B) — fail-closed refuse` };
    }
    const resolved = [];
    for (const a of actions) {
      let phys;
      if (a.type === 'create') {
        if (fs.existsSync(a.path)) return { ok: false, error: `create target already exists: ${a.path}` };
        const parent = physicalOrNull(path.dirname(a.path));
        if (!parent || !containedIn(parent, physRoots)) return { ok: false, error: `containment: ${a.path} escapes declared roots (fail-closed)` };
        phys = path.join(parent, path.basename(a.path));
      } else {
        phys = physicalOrNull(a.path);
        if (!phys || !containedIn(phys, physRoots)) return { ok: false, error: `containment: ${a.path} escapes declared roots (fail-closed)` };
      }
      resolved.push({ ...a, phys });
    }

    // ---- staging read + content sniff ----
    // Each rewrite/delete target is read ONCE as raw bytes here — the shared
    // baseline for the fidelity gate and the external-writer compare below. A
    // rewrite target that sniffs binary/unparseable is FLAGGED and excluded
    // (never rewritten — the e2defrag lesson); the run continues on the rest.
    const flagged = [];
    const isPlaceholder = opts.isPlaceholder || isCloudPlaceholder; // injectable for tests
    let actionable = []; // let: the KEEPS-GATE below may exclude entries (per-file failure, the sniff pattern)
    for (const a of resolved) {
      if (a.type === 'create') { actionable.push(a); continue; }
      // #57(d) cloud-placeholder read poison: sniff the dehydrated stub from
      // METADATA BEFORE the staging read trusts its bytes. A rewrite over a
      // placeholder writes a truncated body that clobbers the real content when
      // the file hydrates + syncs up — fail-closed (flag + skip, file untouched),
      // the estate WARM path's sibling guard (never a content read).
      if (a.type === 'rewrite' && isPlaceholder(a.phys)) {
        flagged.push({ path: a.phys, reason: 'cloud placeholder (dehydrated — 0 blocks, size>0): a plain read returns a stub, rewriting would clobber the real content on hydration — flagged, not rewritten (#57d)' });
        continue;
      }
      let origBuf;
      try { origBuf = fs.readFileSync(a.phys); } catch { return { ok: false, error: `cannot read ${a.phys} to stage it (fail-closed)` }; }
      if (a.type === 'rewrite') {
        const why = sniffUnrewritable(origBuf);
        if (why) { flagged.push({ path: a.phys, reason: why }); continue; }
      }
      // External-writer baseline: the caller's scan-time content when provided
      // (covers any wait before the mutation), else the bytes staged just now.
      actionable.push({ ...a, origBuf, baseBuf: typeof a.expectedOrig === 'string' ? Buffer.from(a.expectedOrig, 'utf8') : origBuf });
    }
    if (!actionable.length) {
      return { ok: false, flagged, error: `every action was flagged as un-rewritable — nothing applied: ${flagged.map((f) => f.path).join(', ')}` };
    }

    // ---- code-enforced outer gates ----
    // Delete/merge authorization is PLAN-SOURCED: a delete action reaching
    // here already passed shape-validation + containment above (and, for the
    // rewrite/create side of a merge, the fidelity gate below) — it is in
    // actions[] because the adjudicated plan put it there, and that IS the
    // authorization (no separate approval flag to check). UNDO — the
    // snapshot + whole-run rollback below — is where safety lives instead.
    // TWO TIERS (see pinVerdict's header). A MARKER pin in the plan = the plan
    // violated an explicit user marker -> malformed, abort it WHOLE (including
    // any unprovables — a distrusted plan gets nothing). Incapacity (marker:
    // false — unverifiable/unreadable/read-error) = ours, not the plan's ->
    // per-file refusal on the flag channel, the rest proceeds. Before rc.10 a
    // single ordinary `---`-rule document in a DELETE plan aborted the whole
    // plan with a message claiming `pinned: true` about a file carrying no pin.
    const markerPinned = [];
    const unprovable = new Set();
    for (const a of actionable) {
      if (a.type === 'create') continue;
      const v = pinVerdict(a.phys);
      if (!v.pinned) continue;
      if (v.marker) { markerPinned.push(a); continue; }
      unprovable.add(a);
      flagged.push({
        path: a.phys,
        reason: `${v.why}: CoalWash cannot prove this file is safe to touch — ${a.type} refused, file left untouched (fix the frontmatter and CoalWash will handle it normally)`,
      });
    }
    if (markerPinned.length) {
      return { ok: false, error: `PIN-protected (pinned: true) — refuse to touch: ${markerPinned.map((p) => p.phys).join(', ')}` };
    }
    if (unprovable.size) actionable = actionable.filter((a) => !unprovable.has(a));
    // grad6 §1b (round-6 CoalBoard verdict): a MERGE is delete(src) +
    // rewrite(dst, dst+src) as two INDEPENDENT actions in one plan — nothing
    // in the schema links them. When the delete half above is excluded for
    // INCAPACITY (per-file, not a whole-plan marker abort) while its paired
    // rewrite is untouched, the rewrite still lands: dst gains src's content,
    // but src itself survives (refused, not deleted) — two copies of the same
    // text, reported ok:true, on a tool whose product is de-duplication.
    // Detect the pairing the only way available without a schema change,
    // reusing the KEEPS-GATE's shared `textSurvives` helper (module scope,
    // above): a rewrite whose CONTENT still contains an excluded delete's
    // ORIGINAL bytes — exact, or whitespace-normalized (survives CRLF
    // normalization and re-indentation; see textSurvives's own header for
    // what it does NOT survive) — is presumed to be that delete's merge
    // target, and is excluded in the SAME pass — scoped to just the matched
    // pair, never the whole plan (every other per-file gate in this function
    // already fails this way; a merge is not special-cased to fail harder).
    if (unprovable.size) {
      const excludedDeleteTexts = [...unprovable]
        .filter((a) => a.type === 'delete' && a.origBuf)
        .map((a) => a.origBuf.toString('utf8'))
        .filter((t) => t.trim().length > 0); // an empty/whitespace body would match every rewrite — unsafe to pair on
      if (excludedDeleteTexts.length) {
        const pairedOut = new Set();
        for (const a of actionable) {
          if (a.type === 'delete' || typeof a.content !== 'string') continue;
          // WAVE-6 HIGH: strict=false -- this check asks "was the deleted
          // text absorbed at all" (data-loss prevention), never "does its
          // exact structural meaning survive" (the keeps-gate's own,
          // stricter question). See flattenSurvives's header for why the
          // two must not share a default.
          if (excludedDeleteTexts.some((t) => textSurvives(t, [a.content], undefined, undefined, false))) {
            pairedOut.add(a);
            flagged.push({
              path: a.phys,
              reason: 'merge-pair exclusion: this rewrite absorbs a file the plan could not safely delete (frontmatter-unprovable) — both halves of the merge are excluded together so the source is never left duplicated',
            });
          }
        }
        if (pairedOut.size) actionable = actionable.filter((a) => !pairedOut.has(a));
      }
    }
    if (!actionable.length) {
      return { ok: false, flagged, error: `every action was refused (un-rewritable or frontmatter-unprovable) — nothing applied: ${flagged.map((f) => f.path).join(', ')}` };
    }

    // ---- KEEPS-GATE (beta.12 — closes the r3 "laundering channel": an
    // adjudication-level keep did not bind the executor's cuts). Every keep
    // carrying an enforcement handle (anchor + anchorFile; project AND global
    // stores) whose file this plan rewrites or deletes must still be present
    // — exact substring, or whitespace-normalized — in the transaction's
    // post-edit content (any rewrite/create content counts, so an anchor a
    // merge legitimately MOVES to its target file passes). A violating action
    // is EXCLUDED pre-mutation with a named reason: the file's on-disk state
    // IS the restored state (same end-state as write-then-restore-from-
    // snapshot, minus the mutation window), and the rest of the plan proceeds
    // (per-file failure, the sniffUnrewritable pattern). Keeps without the
    // handle (the pre-beta.12 {target, reason, date} shape) stay advisory —
    // zero behavior change for existing stores.
    const txDir = opts.txDir || txDirFor(projectRoot);
    {
      // #36 demand 10: this compare decides whether a pinned keep BINDS the action
      // about to delete or rewrite the file it names, and it used to fold case on
      // `process.platform === 'win32'` — the exact defect the #36 pair retires
      // (node/runtime.md §4: case-insensitivity is a property of the VOLUME).
      //
      // POLARITY, because the direction is what makes the `true` passed below
      // correct here: a MATCH makes the keep bind, which EXCLUDES the action — protective.
      // A MISS makes the keep silently fail to bind and the delete/rewrite proceeds.
      // So folding MORE refuses more (safe) and folding LESS is the bypass, which is
      // REFUSE-polarity — passed EXPLICITLY below (`foldOnMiss` is a required
      // argument of `volumeCaseFolds`, no default; CoalBoard ruling 2026-08-01
      // replaced the text-scanning reach guard that used to police this). The live
      // bug being closed: on macOS APFS (case-INSENSITIVE and not win32) a keep
      // recorded as `Memory.md` did not bind an action on `memory.md`, so a user's
      // pinned keep quietly protected nothing.
      //
      // PAIRWISE, not a unary fold, and deliberately so: Windows sets case
      // sensitivity PER DIRECTORY, so the two sides can legitimately disagree. A
      // unary `foldPath` applied to each side independently would fold one and not
      // the other and turn a genuine match into a miss — the bypass again, by a
      // different route. Folding when EITHER side's directory folds is the
      // over-folding (safe) resolution of that disagreement.
      const physOf = (p) => physicalOrNull(p) || path.resolve(String(p));
      const samePathForKeep = (a, b) => {
        const pa = physOf(a), pb = physOf(b);
        if (pa === pb) return true;
        return (volumeCaseFolds(pa, true) || volumeCaseFolds(pb, true)) && pa.toLowerCase() === pb.toLowerCase();
      };
      let keeps = [];
      try {
        keeps = [...loadKeepsAt(path.join(txDir, KEEPS_NAME)), ...loadKeepsAt(globalKeepsPath(home))]
          .filter((k) => typeof k.anchor === 'string' && k.anchor && typeof k.anchorFile === 'string' && k.anchorFile);
      } catch { keeps = []; } // an unreadable keeps ledger must never block an apply (it is the shield, not the gate's subject)
      // Fixpoint: excluding one violating action can remove the very text that
      // satisfied ANOTHER keep (an anchor "migrated" into a now-excluded
      // rewrite) — re-check until stable. Each pass strictly shrinks
      // `actionable`, so this terminates in <= actions.length passes.
      while (keeps.length) {
        // grad11 STEP 2: kept PARALLEL to postTexts (same filter, same order)
        // so the fallback sweep below can exclude ONE action's own entry by
        // reference -- rather than by string equality, which would wrongly
        // exclude every action sharing byte-identical content.
        const postActionable = actionable.filter((a) => a.type !== 'delete');
        const postTexts = postActionable.map((a) => a.content);
        // grad7 ruling Root B/twin-drift: the module-level `textSurvives` above
        // is the SAME helper the merge-pair check now calls — one function, not
        // a belief that two hand-copies matched.
        // round-9 perf fix: postTexts is constant for the rest of this while-
        // iteration (it only changes across iterations, after an exclusion
        // shrinks `actionable`) — normalize it ONCE here and hand the memo to
        // every textSurvives() call below, instead of paying normWhitespace()
        // per haystack on every one of the (keeps x actions) calls.
        // grad10 F9: same memoization, same reason, for the multi-line path's
        // own per-haystack parse — round 9 memoized normWhitespace() but the
        // multi-line branch (added the same round) never touched it, so a
        // multi-line keep re-parsed every haystack with lineParts() on every
        // call while the single-line path reused its precompute.
        //
        // grad10-round-2 LOW-7: the memo above was built UNCONDITIONALLY,
        // every while-iteration, even when every keep this iteration is
        // single-line and `getLinePostTexts()` would never be read at all —
        // measured cost on the common (single-line-only) path: ~898-1055ms
        // depending on run, up ~16% for work that produces nothing. Made
        // lazy: `postTexts.map(lineParts)` runs at most once per iteration,
        // on the FIRST anchor that is actually multi-line, and never at all
        // when none are. The multi-line-heavy case is unaffected (same one
        // build, amortized across every multi-line anchor this iteration);
        // only the single-line-only case stops paying for a memo it never
        // consumes. `__testHooks.linePartsMapCalls` counts real builds —
        // wall-clock could not isolate this signal (two independent
        // attempts confirmed `applyPlan`'s own I/O dominates total time at
        // any fixture scale large enough to also show `lineParts()`'s cost;
        // see the regression test's own header for the measurements), so
        // the regression protection is a call count, not a clock.
        const normPostTexts = postTexts.map(normWhitespace);
        let linePostTextsMemo = null;
        const getLinePostTexts = () => (linePostTextsMemo ||= (__testHooks.linePartsMapCalls++, postTexts.map(lineParts)));
        // grad11 STEP 2: `excludeAction`, when it names an entry actually IN
        // postTexts (a rewrite that already tried and failed the strict
        // own-file check, above), is left OUT of this sweep's own haystack
        // set. Without this, the fallback re-scans that SAME file's content
        // through the looser rank-only logic and can "rescue" a genuinely
        // structural loss the strict check just correctly refused -- the
        // exact bug this exclusion closes (found red-first while proving
        // this fix: a body-dedented-out-of-its-loop case matched again via
        // this path alone). A delete (never in postTexts to begin with) or
        // any action not found here degrades to the FULL, unexcluded sweep,
        // unchanged from before this round.
        const survives = (anchor, excludeAction) => {
          const idx = excludeAction ? postActionable.indexOf(excludeAction) : -1;
          if (idx === -1) {
            return textSurvives(anchor, postTexts, normPostTexts,
              /\r|\n/.test(String(anchor)) ? getLinePostTexts() : undefined);
          }
          const texts = postTexts.filter((_, i) => i !== idx);
          const norms = normPostTexts.filter((_, i) => i !== idx);
          return textSurvives(anchor, texts, norms); // rarer path (fallback only) -- no lazy multi-line memo here, not the hot loop
        };
        const excluded = new Set();
        for (const k of keeps) {
          const kf = k.anchorFile;
          for (const a of actionable) {
            if (a.type === 'create' || excluded.has(a)) continue; // a create is never "the keep's file"
            if (!samePathForKeep(a.phys, kf)) continue;
            // grad11 STEP 2: try the STRICT, ancestor-chain-aware check
            // against this action's OWN original bytes first (a.origBuf,
            // staged well above this gate and unread by it until now) --
            // this is where F3/F4/F9 all live, and it is the only place the
            // check can mean anything (a "where did this sit originally"
            // question needs an original to ask it about). A delete has no
            // new `.content` to check structurally, so it skips straight to
            // the fallback below, unchanged.
            //
            // grad11 CI-RED FOLLOW-UP: gated on `/\r|\n/.test(k.anchor)` --
            // a SINGLE-LINE anchor has no ancestor chain of its own to
            // defend (nothing is "inside" one line; survivesOwnFile's own
            // single-line branch already says this), so routing it through
            // this strict check bought it nothing and cost it a FRESH
            // `normWhitespace(a.content)` on every (keep x action) pair --
            // duplicate work the fallback below's `normPostTexts` memo
            // already paid for once per file at the top of this iteration.
            // Windows CI measured the regression directly: 4 consecutive
            // green commits at ~1800ms threshold, then 2117ms on the commit
            // that added this call unconditionally (25 files/~768KB each,
            // 20 single-line keeps -- 20 redundant O(768KB) normalizations).
            // Skipping straight to the fallback for a single-line anchor
            // loses nothing -- but the reason is PREDICATE IDENTITY, not
            // scope alone (WAVE-8, cw-class-b-reviewer: a wider haystack
            // under a LOOSER predicate would be a weakening, the direction
            // that matters on a gate whose job is to refuse; naming scope
            // as the reason licenses exactly that in a future edit). What
            // actually carries the claim: `survivesOwnFile`'s deleted
            // single-line branch and `textSurvives`'s single-line branch
            // (used below) ran the IDENTICAL two checks (`includes`, then
            // `normWhitespace(...).includes`), in the same order, over
            // haystack sets that partition the exact same total: {own file}
            // union {every other file} either way. Same predicate, same
            // union -- provably the same accept/reject verdict, by
            // exhausting both branches (see `survivesOwnFile`'s own header,
            // above this file's KEEPS-GATE, for the deleted branch and the
            // test that now backstops this claim). It also, as a
            // consequence and not the reason, tolerates the SAME cross-file
            // migration a multi-line anchor gets via the fallback path
            // below, which single-line anchors are safe to inherit for
            // free (they never had a structural "original position" to
            // defend in the first place).
            const triedOwnFile = a.type === 'rewrite' && a.origBuf && /\r|\n/.test(String(k.anchor));
            if (triedOwnFile && survivesOwnFile(k.anchor, a.content, a.origBuf.toString('utf8'))) continue;
            // Fallback: the EXISTING, unchanged, whole-plan sweep -- an
            // anchor legitimately MIGRATED to a different file in this same
            // plan is still found here (rail #2's own migration case; this
            // path carries zero of the new structural guard by design, since
            // no "original position in file X" question is answerable for
            // content that never lived in file X). NAMED RESIDUAL: this is
            // also the reachable surface of LAB-RECORD's F6 (a floor-
            // clearing generic anchor coincidentally present elsewhere in
            // the same plan).
            //
            // WAVE-6 MED-1 (cw-class-b-reviewer, re-judged, not merely
            // re-stated): the CHANNEL is unchanged from before this round --
            // true. But the POPULATION reaching it is NOT: pre-round-11, an
            // F3/F4/F9-shaped anchor (a reparent, a blank-line-defeated
            // dedent) PASSED the old, weaker own-file check and never
            // reached this sweep at all. Post-round-11, that same anchor now
            // FAILS the new strict check above and falls INTO this sweep --
            // where F6's coincidence (a sibling file in the same plan
            // happening to carry the same text) can rescue it silently. So
            // round 11's headline CRITICAL fixes hold unconditionally only
            // while no other file in the plan coincidentally carries the
            // anchor's text; when one does, the loss this round exists to
            // catch is again silent. "Unchanged from before this round" was
            // true of the mechanism and incomplete about its exposure.
            //
            // RE-JUDGED: still the right trade, stated with the reason
            // rather than assumed. Closing it here would mean giving the
            // fallback the SAME ancestor-chain check the strict path uses --
            // which is exactly what rail #2 (the legitimate cross-file
            // migration case F9's own fixtures rely on) forbids: a migrated
            // anchor has no "original position" in a file it never lived in,
            // so a structural check there is not stricter, it is
            // MEANINGLESS, and would false-refuse real merges. F6 itself
            // predates this round and needs a design answer at the ANCHOR
            // layer (a more distinctive anchor, or a real per-anchor
            // provenance field) that this call site cannot supply. Declared,
            // with the grown population named, not silently fixed.
            //
            // WAVE-7 (cw-class-b-reviewer, offered not demanded): a NARROWER
            // option exists and was named, not built -- disqualify a specific
            // ACTION from the F6 fallback rescue when its own strict own-file
            // check FAILED (rather than never having been attempted). The
            // real trade, stated plainly: this breaks the legitimate case of
            // restructuring AND migrating in the same plan (an action that
            // fails its own reparent check while a sibling file elsewhere in
            // the SAME edit genuinely absorbs its content). F6's coincidence
            // is rare (needs an unrelated sibling to happen to carry matching
            // text); a restructure-and-migrate plan is not. Trading a rare
            // false-negative for a more common false-positive is the wrong
            // direction for a fail-closed tool whose own bias throughout is
            // "flag and let a human decide," not "silently refuse more."
            // Not built.
            //
            // grad11 CI-RED FOLLOW-UP: `excludeAction` is passed ONLY when
            // `triedOwnFile` is true -- i.e. only when survivesOwnFile was
            // ACTUALLY ATTEMPTED (and failed) above. Passing it unconditionally
            // was a SECOND correctness bug the single-line perf fix almost
            // shipped: a single-line anchor that legitimately survives ONLY
            // in its own file (never routed through survivesOwnFile at all
            // now) was having that very file excluded from this sweep's
            // haystack, so it found nothing and was wrongly refused -- caught
            // by re-running the round-11 suite, not by the perf fixture
            // (which uses anchors absent everywhere by design and could not
            // see this). Exclusion is only sound relative to a check that
            // actually ran against that file; with no such check, the fallback
            // must see every file, exactly as it did before this round.
            if (survives(k.anchor, triedOwnFile ? a : undefined)) continue;
            excluded.add(a);
            // 80 chars = display truncation only (keeps the flag line one-line
            // readable); the full anchor stays in keeps.json, nothing decided on it.
            const snip = k.anchor.length > 80 ? `${k.anchor.slice(0, 77)}...` : k.anchor;
            flagged.push({
              path: a.phys,
              reason: `keep enforcement: adjudicated keep "${snip}" (${k.date || 'undated'}${k.reason ? ` — ${k.reason}` : ''}) is missing from the plan's post-edit content — ${a.type} excluded, file left untouched; fix the rewrite or re-adjudicate the keep`,
            });
          }
        }
        if (!excluded.size) break;
        actionable = actionable.filter((a) => !excluded.has(a));
      }
      if (!actionable.length) {
        return { ok: false, flagged, error: `every action was excluded (unrewritable or keep-protected) — nothing applied: ${flagged.map((f) => f.path).join(', ')}` };
      }
    }

    // ---- FIDELITY INTERLOCK (the flagship gate, code-enforced at the mutation
    // boundary — not merely a pipeline step a caller could skip). Every rewrite
    // is diffed original-vs-new; a structured-token drop (link/date/version/
    // frontmatter key) or introduced encoding corruption ABORTS before anything
    // mutates, UNLESS the human approved that exact drop (plan.approvedDrops, a
    // list of "type:value"). No approvedDrops => strict: any drop aborts.
    // The gate baseline = expectedOrig when provided (the content the rewrite
    // was DERIVED from), else the staged bytes — the same baseline the
    // external-writer compare enforces at mutation time.
    const approvedDrops = new Set(Array.isArray(plan.approvedDrops) ? plan.approvedDrops : []);
    const unapproved = [];
    for (const a of actionable) {
      if (a.type !== 'rewrite') continue;
      const orig = typeof a.expectedOrig === 'string' ? a.expectedOrig : a.origBuf.toString('utf8');
      for (const d of checkFidelity(orig, a.content).drops) {
        if (!approvedDrops.has(`${d.type}:${d.value}`)) unapproved.push(`${a.phys} — ${d.type}: ${d.value}${d.survivor ? ` (survives only as ${d.survivor})` : ''}${d.occurrences ? ` (${d.occurrences.orig} mention(s) -> ${d.occurrences.kept}; the value itself survives)` : ''}`);
      }
    }
    // H3: a DELETE (or a merge = delete-src + rewrite-dst) also drops the removed
    // file's structured tokens — the rewrite loop above never sees them, so a
    // merge could silently drop a link/number a rewrite would block. Account for
    // them at the SAME boundary: a deleted token is OK iff it SURVIVES in the
    // transaction's post-edit content (a same-tx merge kept it) OR is named in
    // approvedDrops (the caller declared the drop — its own external safety, e.g.
    // RE-TIER's archive+probe or a fold-merge's untouched twin, owns recovery).
    // Otherwise it is exactly the silent structured-token loss the gate claims to
    // block. (Snapshot/bins still back recovery; this closes the GATE hole.)
    const postEditKeys = inventoryDropKeys(actionable.filter((a) => a.type !== 'delete').map((a) => a.content).join('\n'));
    for (const a of actionable) {
      if (a.type !== 'delete') continue;
      const del = typeof a.expectedOrig === 'string' ? a.expectedOrig : a.origBuf.toString('utf8');
      for (const key of inventoryDropKeys(del)) {
        if (postEditKeys.has(key) || approvedDrops.has(key)) continue;
        unapproved.push(`${a.phys} (delete) — ${key.replace(':', ': ')}`);
      }
    }
    if (unapproved.length) {
      return { ok: false, error: `fidelity: unapproved fact drop(s) — apply blocked (approve them explicitly or fix the rewrite): ${unapproved.join(' | ')}` };
    }

    // ---- lock(s) — GLOBAL first, only when a declared action touches
    // global-scope class-B (see the plan-shape comment above) ----
    const touchesGlobal = actions.some((a) => a && a.scope === 'global');
    let globalLock = null;
    if (touchesGlobal) {
      globalLock = acquireLock(globalLockPath(home), { sessionId: plan.sessionId, now });
      if (!globalLock.acquired) return { ok: false, deferred: true, error: `global scope: ${globalLock.reason}` };
    }
    fs.mkdirSync(txDir, { recursive: true }); // txDir resolved once, above the KEEPS-GATE
    ensureSelfIgnore(txDir);
    const lock = acquireLock(path.join(txDir, LOCK_NAME), { sessionId: plan.sessionId, now });
    if (!lock.acquired) {
      if (globalLock) globalLock.release();
      return { ok: false, deferred: true, error: lock.reason };
    }

    const journalPath = path.join(txDir, JOURNAL_NAME);
    const snapDir = path.join(txDir, `snap-${now}`);
    const writeJournal = (j) => { writeDurable(journalPath, JSON.stringify(j, null, 2)); };

    try {
      // ---- own-artifact retention at preflight (ports the ReFS thin-pool
      // leak: maintenance that allocates but never releases). Aborted/deferred
      // runs leave snapshot dirs the commit-time sweep never reaches; reap
      // them here, inside the lock. Fail-silent housekeeping; sweepSnapshots
      // itself protects a dangling txn's snapshot (recovery owns it).
      sweepSnapshots(txDir, opts.keepSnapshots == null ? KEEP_SNAPSHOTS : opts.keepSnapshots);
      // ---- bin retention (beta.12 item 4; 0i adds the size cap; P5/P8 fix
      // rebases the budget) — the SAME piggyback touchpoint: every real wash
      // run is a natural, already-existing place to age out bin items past
      // their horizon AND to bind the store-proportional size budget
      // (0h-GUARD: this preflight is the ONLY sweep site — run-gated, never
      // a clock). storeBytes = the session gauge's cached storeTotalBytes —
      // the WHOLE measured class-B store, matching retention.mjs's own "the
      // MEASURED STORE" prose (the old alwaysLoadedBytes base under-sized
      // the budget by the recall tier the bins actually shadow: the lab's
      // P5/P8, a 25h-old pre-surgery image destroyed under a ~62x-too-small
      // cap). Deliberately NO fallback to alwaysLoadedBytes: a state written
      // before this field existed sweeps horizon-only (keep-on-doubt) and
      // self-heals at the next SessionStart gauge. Both sweeps are already
      // internally fail-silent (never throw) — no extra guard needed here.
      let storeBytes = 0;
      try { storeBytes = Number(loadState(projectRoot, home)?.lastVerdict?.storeTotalBytes) || 0; } catch { /* horizon-only */ }
      const binSweeps = [
        [FAT_BIN_NAME, sweepFatBin(projectRoot, { storeBytes })],
        [STORE_OLD_NAME, sweepStoreOld(projectRoot, { storeBytes })],
      ];
      // Unsatisfiable-cap advisory lines for the receipt (the deadLinkLine
      // shape: program-built, caller-surfaced, never a block) — the one thing
      // no senior retention system says out loud: "your cap and your keep-all
      // window contradict; the bin is over budget and nothing young died."
      const binConflicts = binSweeps
        .filter(([, r]) => r && r.capConflict)
        .map(([name, r]) => `retention: ${name} over budget (${r.capConflict.keptBytes}B kept > ${r.capConflict.budgetBytes}B budget) — the ${Math.round(TIER1_KEEP_ALL_MS / 3600000)}h keep-all floor holds and byte pressure may not break it; the bin exceeds its cap until items age past the floor`);

      // ---- snapshot BEFORE the first mutation, then the completion marker ----
      fs.mkdirSync(snapDir, { recursive: true });
      const manifest = [];
      let n = 0;
      for (const a of actionable) {
        if (a.type === 'create') continue; // nothing to snapshot
        const snapName = `f${n++}`;
        fs.copyFileSync(a.phys, path.join(snapDir, snapName));
        const fd = fs.openSync(path.join(snapDir, snapName), 'r+');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        manifest.push({ snap: snapName, original: a.phys });
      }
      writeDurable(path.join(snapDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
      // ---- snapshot restorability verify (ports the GitLab all-backups-dead
      // incident): prove every copy restores what is on disk RIGHT NOW, before
      // the completion marker lands and before any destructive step. The
      // marker therefore means "complete AND verified" — recovery never trusts
      // an unverified snapshot. Verify failure aborts while "nothing has
      // happened yet" is still true.
      const badSnaps = verifySnapshot(snapDir, manifest);
      if (badSnaps.length) {
        try { fs.rmSync(snapDir, { recursive: true, force: true }); } catch {}
        return { ok: false, flagged, error: `snapshot verify failed — refusing to proceed before any change: ${badSnaps.join('; ')}` };
      }
      writeDurable(path.join(snapDir, SNAP_MARKER), String(now));
      fsyncDirBestEffort(snapDir);

      // ---- WAL: the ordered plan; creates+rewrites first, deletes LAST ----
      const ordered = [
        ...actionable.filter((a) => a.type !== 'delete'),
        ...actionable.filter((a) => a.type === 'delete'),
      ];
      const journal = {
        version: 1,
        sessionId: plan.sessionId || null,
        startedAt: now,
        snapDir,
        // The RESOLVED physical roots this transaction was allowed to touch —
        // recorded so a cold-start recoverDangling can RE-VALIDATE containment
        // (a poisoned journal must not aim a restore/delete outside these).
        roots: physRoots,
        status: 'applying',
        steps: ordered.map((a, i) => ({ i, type: a.type, path: a.phys, status: 'pending' })),
      };
      writeJournal(journal);

      // ---- execute ----
      const createdPaths = [];
      // Returns the count of snapshot restores that FAILED — a non-zero count
      // means the rollback was PARTIAL (some originals could not be restored),
      // which the caller must surface honestly instead of claiming "wholesale".
      const rollback = () => {
        let failed = 0;
        for (const m of manifest) {
          try { fs.copyFileSync(path.join(snapDir, m.snap), m.original); } catch { failed++; /* keep restoring the rest */ }
        }
        // A created file (or a stranded .coalwash-tmp sibling) the rollback CANNOT
        // remove LINGERS in the store = a mixed state, exactly like a failed
        // snapshot restore — count it (EPERM/EBUSY: AV or cloud-sync holding a
        // no-FILE_SHARE_DELETE handle, the win32 hazard) so the status below is
        // honestly rollback-failed, never a clean rolledBack:true over a lingering
        // file. force:true never throws on a missing target, so a throw here means
        // a real removal failure; the existsSync belt counts it ONLY if it lingers.
        for (const p of createdPaths) { try { fs.rmSync(p, { force: true }); } catch { if (fs.existsSync(p)) failed++; } }
        for (const a of actionable) { const tmp = a.phys + '.coalwash-tmp'; try { fs.rmSync(tmp, { force: true }); } catch { if (fs.existsSync(tmp)) failed++; } }
        // A PARTIAL rollback must NOT be marked terminal-clean, or a cold-start
        // recoverDangling would clear the journal over a mixed on-disk state.
        journal.status = failed ? 'rollback-failed' : 'rolled-back';
        try { writeJournal(journal); } catch {}
        return failed;
      };

      try {
        for (const step of journal.steps) {
          const a = ordered[step.i];
          // ---- external-writer guard (ports the WHS KB946676 stale-commit /
          // dedup-co-writer class + the owner's live cloud-sync hazard):
          // re-read the target immediately before mutating it; bytes no longer
          // matching the plan's recorded baseline = a foreign writer
          // interleaved -> abort the whole txn (the rollback below restores
          // the snapshot, so nothing of this plan is left half-applied). A
          // target that can no longer be read counts as foreign interference.
          if (a.type === 'rewrite' || a.type === 'delete') {
            let cur = null;
            try { cur = fs.readFileSync(a.phys); } catch { /* handled below */ }
            if (!cur || Buffer.compare(cur, a.baseBuf) !== 0) {
              throw new Error(`external writer detected: ${a.phys} changed after the plan was gated — aborting the transaction`);
            }
          } else if (fs.existsSync(a.phys)) {
            // create target appeared mid-txn: same foreign-writer class.
            throw new Error(`external writer detected: create target ${a.phys} appeared mid-transaction`);
          }
          if (a.type === 'rewrite' || a.type === 'create') {
            atomicWrite(a.phys, a.content);
            if (a.type === 'create') createdPaths.push(a.phys);
            // verify: what landed is byte-for-byte what the plan said (blueprint step 3 "verify")
            const back = fs.readFileSync(a.phys);
            if (Buffer.compare(back, Buffer.from(a.content, 'utf8')) !== 0) {
              throw new Error(`post-write verify mismatch: ${a.phys}`);
            }
          } else {
            fs.rmSync(a.phys); // deletes run LAST by construction (ordering above)
            fsyncDirBestEffort(path.dirname(a.phys));
          }
          step.status = 'done';
          writeJournal(journal);
        }
      } catch (e) {
        const failed = rollback();
        if (failed) return { ok: false, rolledBack: 'partial', restoreFailures: failed, error: `apply failed AND rollback left ${failed} item(s) in a mixed state (an original that could not be restored, a created file that could not be removed, or a stranded tmp) — memory may be mixed; snapshot kept at ${snapDir}: ${e.message}` };
        return { ok: false, rolledBack: true, error: `apply failed at a step — snapshot restored: ${e.message}` };
      }

      // ---- commit: mark, clear the WAL, sweep old snapshots (keep the newest N) ----
      journal.status = 'committed';
      writeJournal(journal);
      try { fs.rmSync(journalPath, { force: true }); } catch {}
      sweepSnapshots(txDir, opts.keepSnapshots == null ? KEEP_SNAPSHOTS : opts.keepSnapshots);

      // ---- bin population (0h "BIN POPULATION WIRING") — AFTER the commit,
      // so only cuts that actually LANDED are recorded (a rolled-back run cut
      // nothing; the catch above returns before reaching here). Routing per
      // plan.origin: program cuts (Quick/Force, the default) -> FAT bin;
      // wizard cuts (deletes + shrink wording) -> the wizard bin (store.old).
      // Content = the gated baseline (baseBuf — what the plan was derived
      // from AND byte-verified on disk at mutation time by the external-
      // writer guard): a delete banks the whole file, a rewrite banks its
      // removed lines (nothing removed = nothing banked). A bin-stash failure
      // never un-commits the run (the mutation above already landed) — but it
      // must never be SILENT either (F1, inspect findings-back on 7d57d4c):
      // recordBinItem's own retry can still exhaust (heavy contention, or a
      // lock genuinely still held) and return null, and this loop used to
      // discard that return outright — the cut would land on disk with NO
      // recovery copy and NO report line, indistinguishable from a clean run.
      const binName = plan.origin === 'wizard-cut' ? STORE_OLD_NAME : FAT_BIN_NAME;
      const binOrigin = plan.origin === 'wizard-cut' ? 'wizard-cut' : 'program-cut';
      for (const a of actionable) {
        if (a.type === 'create') continue; // an addition cut nothing
        // A DELETE banks the BUFFER, never a decode of it (G3-3). `baseBuf` is
        // byte-equal to the file on disk BY CONSTRUCTION — the external-writer
        // guard above aborts the whole transaction unless Buffer.compare(cur,
        // baseBuf) === 0 — so this is the original bytes, and a .toString('utf8')
        // here silently replaced every non-UTF-8 byte with U+FFFD in the only
        // copy the user can recover. A REWRITE banks its removed LINES, which
        // are text this codebase derived by diffing text; a string is the honest
        // type there and recordBinItem encodes it once, at the boundary.
        const cut = a.type === 'delete' ? a.baseBuf : removedLines(a.baseBuf.toString('utf8'), a.content).join('\n');
        if (!cut.length) continue;
        const binId = recordBinItem(projectRoot, binName, { content: cut, original: a.phys, origin: binOrigin, now });
        if (binId === null) {
          flagged.push({
            path: a.phys,
            reason: 'bin-stash failed (the file mutation already succeeded — only the RECOVERY COPY is missing): recordBinItem could not acquire its per-bin lock in time, so this cut has no entry in the bin and cannot be pulled back via cli.mjs restore',
          });
        }
      }

      // ---- wikilink-orphan advisory (post-commit, advisory ONLY — see the
      // helper block above). Fail-silent: an advisory failure never
      // un-commits the run; the fields just stay empty.
      let deadLinks = [];
      try { deadLinks = deadLinkScan(actionable, physRoots, txDir); } catch { /* advisory only */ }

      return { ok: true, applied: actionable.length, snapshotDir: snapDir, flagged, deadLinks, deadLinkLine: deadLinkLine(deadLinks), binConflicts };
    } finally {
      lock.release();
      if (globalLock) globalLock.release();
    }
  } catch (e) {
    return { ok: false, error: `apply: ${e.message}` };
  }
}

// Snapshot restorability verify (the GitLab all-backups-dead port): read each
// copy back and byte-compare it against a FRESH read of its source. Compares
// against disk-now (not the staged baseline) so this isolates COPY corruption;
// a foreign write is the external-writer guard's job and gets ITS label.
// Returns [] when every copy restores faithfully, else the failures.
export function verifySnapshot(snapDir, manifest) {
  const bad = [];
  for (const m of manifest) {
    try {
      const snapBuf = fs.readFileSync(path.join(snapDir, m.snap));
      const srcBuf = fs.readFileSync(m.original);
      if (Buffer.compare(snapBuf, srcBuf) !== 0) bad.push(`${m.original} (copy does not match source)`);
    } catch (e) {
      bad.push(`${m.original} (unverifiable: ${e.message})`);
    }
  }
  return bad;
}

// Keep the newest `keep` snapshot dirs, remove older ones (zero-garbage without
// discarding the recent backup). Retention NEVER reaps the snapshot a
// dangling/incomplete txn still references — recovery owns it (the ReFS
// thin-pool port's one hard rule). Fail direction: an unreadable or
// newer-schema journal freezes the whole sweep — keeping too much is safe,
// deleting a needed restore source is not.
export function sweepSnapshots(txDir, keep = KEEP_SNAPSHOTS) {
  try {
    let protect = null;
    const jp = path.join(txDir, JOURNAL_NAME);
    if (fs.existsSync(jp)) {
      let j = null;
      try { j = JSON.parse(fs.readFileSync(jp, 'utf8')); } catch { /* unreadable -> freeze below */ }
      if (!j || typeof j !== 'object' || Number(j.version) > 1) return; // cannot know what it references -> sweep nothing
      if (j.status !== 'committed' && j.status !== 'rolled-back') protect = path.basename(String(j.snapDir || ''));
    }
    const snaps = fs.readdirSync(txDir)
      .filter((n) => /^snap-\d+$/.test(n) && n !== protect)
      .sort((a, b) => Number(b.slice(5)) - Number(a.slice(5)));
    for (const old of snaps.slice(Math.max(0, keep))) {
      fs.rmSync(path.join(txDir, old), { recursive: true, force: true });
    }
  } catch { /* sweep is housekeeping — never fatal */ }
}

// Cold-start recovery (CoalHearth's SessionStart — or the next CW run — calls
// this): a dangling 'applying' journal with a complete snapshot rolls back
// wholesale; without the snap marker nothing was ever mutated (first mutation
// happens only after the marker exists) so the journal is just cleared.
// Returns { recovered, ... } with FIVE values, not four. 'partial' was missing
// from this list while the body returned it, and it is the one a caller must
// branch on — it is the only outcome that leaves the store in a MIXED state:
//   'rolled-back'  — the snapshot was replayed in full; nothing left to do.
//   'partial'      — some restore FAILED or some target was REFUSED (out-of-root
//                    OR pinned — the pin promise binds this door too, N3). The
//                    journal and snapshot are KEPT for a human; the run is NOT
//                    clean. Carries { restored, restoreFailures, refusedOutOfRoot,
//                    refusedPinned, error }.
//   'no-mutation'  — no completion marker, so the first mutation never happened.
//   'cleaned'      — a terminal journal (committed/rolled-back) was just removed.
//   'none'         — nothing done. WITH an `error` field this is a REFUSAL (the
//                    anchor gate, an unreadable/schema-newer journal, an out-of-tx
//                    snapDir, no verifiable roots); WITHOUT one it means there was
//                    no journal at all. A caller that treats those two alike is
//                    the gaugeLine defect (see cli.mjs).
// `restored` accompanies 'rolled-back' and 'partial'.
export function recoverDangling(projectRoot, opts = {}) {
  try {
    const home = opts.home || os.homedir();
    // ONE clock reading for the whole recovery, exactly as applyPlan takes one
    // for the whole transaction. `at` is the EVENT IDENTITY the retention
    // thinner groups on (201dae9), so a recovery that undoes N creates must
    // bank them under ONE stamp or it manufactures N single-item events out of
    // one transaction — and past the 48h floor last-per-day then keeps one and
    // destroys the other N-1 pieces of the same undo material. Measured before
    // the fix: 8 creates banked 8 stamps spread over 32 ms.
    const now = opts.now || Date.now();
    // THE ANCHOR GATE, ABOVE THE FIRST FILESYSTEM TOUCH. This function restores
    // and deletes; the anchor decides what it is allowed to reach, exactly as it
    // does in applyPlan, and until this call existed it decided NOTHING here. The
    // gate is the same primitive both doors run (trustedRootsForAnchor), never a
    // copy — see its comment for why a paste was the wrong fix. No trustedAnchor:
    // the caller derived this root from cwd (cli.mjs gauge), so it takes the
    // fail-closed reading of both legs.
    const anchorGate = trustedRootsForAnchor(projectRoot, home);
    if (!anchorGate.ok) return { recovered: 'none', error: anchorGate.error };
    const txDir = opts.txDir || txDirFor(projectRoot);
    const journalPath = path.join(txDir, JOURNAL_NAME);
    if (!fs.existsSync(journalPath)) return { recovered: 'none' };
    let journal;
    try { journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')); } catch {
      // an unreadable journal with NO readable snapDir cannot be replayed —
      // fail-closed: leave it for a human (never guess at memory state).
      return { recovered: 'none', error: 'journal unreadable — left in place for inspection' };
    }
    // Artifact schema-version (ports XP-deletes-Vista-restore-points): a
    // journal from a NEWER CoalWash schema is untouchable to this older code —
    // refuse recovery AND refuse cleanup (we cannot know what either would
    // destroy). Checked BEFORE the terminal-status branch on purpose: an older
    // tool must not even delete a newer tool's "terminal-looking" journal.
    if (journal && typeof journal === 'object' && Number(journal.version) > 1) {
      return { recovered: 'none', error: `journal schema version ${journal.version} is newer than this CoalWash understands — left untouched (for a newer version, or a human)` };
    }
    if (journal.status === 'committed' || journal.status === 'rolled-back') {
      fs.rmSync(journalPath, { force: true });
      return { recovered: 'cleaned' };
    }
    const snapDir = journal.snapDir;
    // PROVENANCE GATE (F1). THE RULE: a containment root must be PROVENANCE-TRUSTED
    // — caller-derived, or a fixed home/project anchor — NEVER data-derived.
    // Canonicalizing a data-derived root does not launder it.
    // `journal.snapDir` comes out of the same attacker-writable file as
    // `journal.roots`, and the source-side check below anchored containment on
    // `physicalOrNull(snapDir)` — the candidate's OWN canonical self, which passes
    // for ANY absolute path the journal names. That is the precise circularity the
    // long comment below warns about for `jroots`, committed a few lines later on
    // the SOURCE axis. Bind snapDir to the CALLER-DERIVED tx dir here.
    // BEFORE the probes, deliberately: `existsSync` on the marker and the manifest
    // read are filesystem probes at an attacker-named absolute path, so leaving
    // them ahead of the binding is an existence oracle even though nothing is
    // written. physicalForCreate (not physicalOrNull) so a snapshot dir that was
    // never created still resolves through its existing ancestor and reaches the
    // no-mutation path below, instead of being refused as merely unresolvable.
    const txPhys = physicalOrNull(txDir);
    const snapPhys = snapDir ? physicalForCreate(snapDir) : null;
    if (snapDir && (!txPhys || !snapPhys || !containedIn(snapPhys, [txPhys]))) {
      return { recovered: 'none', error: 'journal snapDir is outside the transaction directory — refusing to replay (left for inspection)' };
    }
    const marker = snapPhys && fs.existsSync(path.join(snapPhys, SNAP_MARKER));
    if (!marker) {
      // no complete snapshot => the first mutation never happened
      fs.rmSync(journalPath, { force: true });
      return { recovered: 'no-mutation' };
    }
    // CONTAINMENT (the journal is UNTRUSTED — a poisoned .claude/coalwash/journal.json
    // shipped inside a repo must not aim a restore/delete at an arbitrary absolute
    // path). A journal without recorded roots (pre-v-this or tampered) can't be
    // validated -> refuse, leave for a human.
    const jroots = Array.isArray(journal.roots) ? journal.roots.map((r) => physicalOrNull(r)).filter(Boolean) : [];
    if (!jroots.length) {
      return { recovered: 'none', error: 'journal has no verifiable roots — refusing to replay (left for inspection)' };
    }
    // The trusted outer gate, resolved by the anchor gate at the top of this
    // function (its comment carries the full rationale). jroots below is the
    // SECONDARY narrowing — ANDed with these on every use, never standing alone,
    // which is the circularity a poisoned journal would otherwise exploit.
    const trustedRoots = anchorGate.roots;
    // snapPhys is the tx-dir-BOUND canonical form resolved above — not a fresh
    // canonicalization of the raw journal string. Every read below goes through it,
    // so the manifest is loaded from the bound location, never the raw one.
    const inSnap = (p) => { const q = physicalOrNull(p); return q && snapPhys && containedIn(q, [snapPhys]); };
    const manifest = JSON.parse(fs.readFileSync(path.join(snapPhys, 'manifest.json'), 'utf8'));
    let restored = 0, failed = 0, refused = 0, refusedPinned = 0;
    for (const m of manifest) {
      const src = path.join(snapPhys, m.snap);
      // A DELETED FILE IS THE ONLY DAMAGE A DELETE-PHASE CRASH LEAVES — deletes run
      // LAST by construction — and physicalOrNull could not resolve one, because it
      // is GONE: ENOENT -> null -> the target was refused and mis-reported as
      // "out-of-root" while sitting squarely inside the trusted roots. So recovery
      // silently could not undo the one thing it most needed to. Use the DESTINATION
      // twin, which resolves the deepest existing ancestor and reattaches the tail —
      // safe to rely on only now that it fails closed instead of reattaching across
      // an existing-but-unresolvable segment (the TP-2 hole, fixed in this commit).
      // Containment is unchanged: the resolved path must still sit inside BOTH the
      // caller-trusted roots and the journal's own declared roots.
      const origPhys = physicalForCreate(m.original);
      // src must sit inside the snapshot dir; target must sit inside a
      // CALLER-TRUSTED root (the outer gate a poisoned journal can't widen) AND
      // the journal's own declared roots (secondary narrowing).
      if (!inSnap(src) || !origPhys || !containedIn(origPhys, trustedRoots) || !containedIn(origPhys, jroots)) { refused++; continue; }
      // THE PIN PROMISE RIDES THE RECOVERY DOOR TOO (lab-grad2 N3 — the
      // recovery-paths class, 4th instance in this room). This replay had 7
      // fs-mutation lines and ZERO isPinned sites while the module header
      // promises "refuses delete AND rewrite" unconditionally. A LEGITIMATE
      // journal never names a pinned target (applyPlan refuses them at plan
      // time), so a pin found here is either the user's NEWEST instruction
      // (pinned after the crash — honor it) or a poisoned journal (refuse it);
      // both directions agree. EXISTING targets only: isPinned fail-closes
      // (true) on a read error, so probing a nonexistent path would kill the
      // R4/TP-3 deleted-file restore — the one damage a delete-phase crash
      // leaves. The rare legitimate loss: a crashed transaction whose OWN
      // rewrite added `pinned: true` cannot be rolled back automatically —
      // partial + journal kept, a human resolves; over-refusal is the safe
      // direction on a destroying door.
      if (fs.existsSync(origPhys) && isPinned(origPhys)) { refusedPinned++; continue; }
      // Write to origPhys, the form that was VALIDATED — not the raw `m.original`
      // string. Checking one spelling and acting on another lets the OS re-resolve
      // the path a second time, so any divergence between them (a symlink, a case
      // or short-name alias, a race between the check and the write) lands the
      // write somewhere containment never approved.
      try { fs.copyFileSync(src, origPhys); restored++; } catch { failed++; /* restore the rest */ }
    }
    // creates the interrupted run added are removed — REGARDLESS of the journal's
    // step.status. A crash BETWEEN atomicWrite and the writeJournal that would
    // stamp the step 'done' leaves the durable step 'pending' while the file
    // exists (HIGH #3); rmSync(force) is a safe no-op if it was never written, so
    // removing every create in a dangling txn cannot orphan one.
    for (const step of journal.steps || []) {
      if (step.type === 'create') {
        if (!fs.existsSync(step.path)) continue; // never written (or already gone) = nothing to undo
        const p = physicalOrNull(step.path);
        if (!p || !containedIn(p, trustedRoots) || !containedIn(p, jroots)) { refused++; continue; } // exists but out-of-(trusted∩journal)-root = refuse
        // N3, the delete side: the file at this create path EXISTS (checked
        // above) and carries `pinned: true` — an applyPlan create cannot have
        // produced a pinned file the plan gate would then refuse to touch, so
        // this is a post-crash pin or a poisoned journal naming a pre-existing
        // file as its own create. Either way the pin wins: no bank, no rm.
        // isPinned's fail-closed reading (unreadable = pinned) is correct
        // here — an unreadable file is not one to destroy.
        if (isPinned(p)) { refusedPinned++; continue; }
        // BANK THE BYTES BEFORE REMOVING THEM — this is the one delete in the
        // engine that had NO recovery handle. Every other destructive path is
        // backed: a rewrite/delete is snapshotted before the first mutation and
        // banked in the bin after the commit. A create has nothing to snapshot,
        // because on a LEGITIMATE journal the pre-transaction state of that path
        // is "absent" (applyPlan refuses a create whose target exists, and aborts
        // if one appears mid-run) — so removing it is the correct undo and there
        // is genuinely nothing to lose.
        //
        // The unbacked delete is wrong for the case the loop's own comment above
        // describes without noticing: it removes every create in a dangling txn
        // REGARDLESS of step.status, precisely because a crash can leave the step
        // 'pending' while the file exists. That reasoning cannot distinguish "our
        // file, stamp lost" from "somebody ELSE's file, written at that path after
        // our crash" — a non-adversarial data-loss path with no attacker in it.
        // A poisoned journal is the same shape with intent: it names pre-existing
        // files as its own creates. Containment bounds WHERE that reaches; it
        // gives those bytes no handle, and the journal is deleted on the success
        // path, so nothing survives to tell the user what went.
        //
        // Cannot bank => do NOT destroy: count it refused, which keeps the journal
        // and the snapshot and reports 'partial'. An un-undone create is a mixed
        // state a human can still fix; an unrecoverable delete is not. (A
        // directory at a create path also lands here — readFileSync throws EISDIR
        // — where it used to be a silently-swallowed rmSync failure reported as a
        // clean rolled-back.)
        // BYTES, not a decode (G3-3): this is the create-undo's only backup of
        // a file it is about to remove, so it goes into the bin exactly as it
        // sits on disk. A directory here still throws EISDIR -> null -> refuse.
        let body = null;
        try { body = fs.readFileSync(p); } catch { body = null; }
        // `now` is the run's single reading, never recordBinItem's per-call
        // Date.now() default — see the const at the top of this function.
        if (body === null || !recordBinItem(projectRoot, FAT_BIN_NAME, { content: body, original: p, origin: 'program-cut', now })) { refused++; continue; }
        // Remove p, the spelling that was VALIDATED — not the raw `step.path`.
        // Checking one spelling and acting on another lets the OS re-resolve the
        // path a second time (THE PROVENANCE RULE's fourth clause); the restore
        // loop above was fixed for this and this line was written after the rule.
        try { fs.rmSync(p, { force: true }); } catch {}
      }
    }
    // Only clear the WAL when the recovery was CLEAN. A partial/refused replay keeps
    // the journal + snapshot for a human (never report a mixed state as done).
    if (failed || refused || refusedPinned) {
      return { recovered: 'partial', restored, restoreFailures: failed, refusedOutOfRoot: refused, refusedPinned, error: `recovery incomplete — ${failed} restore failure(s), ${refused} target(s) refused as out-of-root, ${refusedPinned} refused as pinned; journal + snapshot kept at ${snapDir}` };
    }
    fs.rmSync(journalPath, { force: true });
    return { recovered: 'rolled-back', restored };
  } catch (e) {
    return { recovered: 'none', error: e.message };
  }
}
