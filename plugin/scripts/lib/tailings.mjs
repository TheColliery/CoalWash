// tailings.mjs — the two bins (fat bin + store.old), WIRING retention.mjs's pure
// policy into actual filesystem effects (beta.12 item 4). retention.mjs
// already IS the destruction law (birth=event-only, life=dual-axis thinning,
// horizon=burst-gap-derived) — this module only writes items, runs that
// policy, destroys what it says to (verify + a one-line death certificate),
// and exposes the PULL-ONLY read/restore surface. Nothing here is auto-loaded
// or discoverable: both bins live inside the SAME self-ignored tx dir
// class-b.mjs's G4 test already proves never surfaces as class-B.
//
// TWO-BIN SPLIT (MEMORY.md "TWO-BIN SPLIT"; cut ROUTING per 0h "BIN
// POPULATION WIRING", which supersedes the earlier wizard-fat-tag-in-fat-bin
// reasoning — Windows keeps these mechanisms separate, so this copies the
// separation, not a merged bin):
//   FAT BIN   (30d horizon) — per-cut records from the PROGRAM tier
//             (Quick/Force structural cuts; the free, high-churn producer;
//             Recycle-Bin economics). origin 'program-cut'.
//   STORE.OLD (60d horizon) — the WIZARD bin: wizard deletes, the wizard
//             shrink's dropped wording, and whole-store pre-surgery images
//             (judgment-tier material, surgery-grade caution; Windows.old
//             economics). origin 'wizard-cut'. Still two bins, not three —
//             the origin tag distinguishes per-cut records from whole-store
//             images WITHIN the wizard bin.
// SIZE-CAP ∧ TIME-HORIZON, floor-ordered (0i + the P5/P8 fix): every sweep
// below applies BOTH limits — the horizon (per-bin, above) plus a size budget
// of BIN_BUDGET_STORE_MULTIPLE x the MEASURED STORE's bytes (never the disk —
// 0i V2; callers pass `storeBytes` = the session gauge's storeTotalBytes,
// the WHOLE measured class-B store: the bin shadows what washes actually cut,
// which is recall-tier-dominated — the always-loaded slice is the wrong base
// by the lab's measured ~62x; absent/zero = the cap layer inert, horizon-only,
// the keep-on-doubt direction). The 48h keep-all floor is untouchable by byte
// pressure (snapper 2-pass); a bin whose young items alone exceed the cap
// grows past it and the conflict is REPORTED — in the sweep's return
// (capConflict, only present when live) and as a cap-conflict line in the
// death log, never resolved by silently breaking the floor.
//
// PULL-ONLY CONTAINMENT: `listBin`/`restoreFromBin` are the ONLY discovery
// surface, and nothing calls them automatically — a snapshot re-entering the
// washable set would undo the very wash that created it. Un-searched within
// the horizon = silent self-expiry via `sweepFatBin`/`sweepStoreOld` (no ask
// needed: CW's own artifact in its own sandbox is program jurisdiction, the
// Windows.old day-10 silent-cleanup analog).
//
// DESTRUCTION STANDARD (NIST SP 800-88 / IEEE 2883, ported): expiry is
// Clear-level (plain delete, level-matching the plaintext store it mirrors —
// destroying the copy harder than the surviving original protects nothing);
// destruction never trusts rm blindly — delete, then VERIFY gone, then
// journal a death-certificate line (name/age/rule); an unverifiable delete
// is NOT reported dead — the item stays in the index (the broom asymmetry:
// leftover dust waits for the next pass, never a false "destroyed").
import fs from 'node:fs';
import path from 'node:path';
import { txDirFor, ensureSelfIgnore, acquireLock } from './apply.mjs';
import { HORIZON_MS, retentionPlan, BIN_BUDGET_STORE_MULTIPLE, TIER1_KEEP_ALL_MS } from './retention.mjs';

export const FAT_BIN_NAME = 'fat-bin';
export const STORE_OLD_NAME = 'store.old';
const INDEX_NAME = 'index.json'; // per-bin manifest: [{id, at, bytes, original, origin}]
const DEATH_LOG_NAME = 'death.log'; // append-only death certificates, one line per destroyed item
const BIN_LOCK_NAME = '.bin.lock'; // per-bin (not per-tx) exclusive lock — see recordBinItem
// F1 (inspect findings-back on 7d57d4c): acquireLock's DEFAULT staleMs
// (apply.mjs's LOCK_STALE_MS, 30 minutes) is sized for the tx-dir lock — a
// big, deliberate transaction that may legitimately run for a while. This
// lock's own critical section is a single index read + one blob write,
// normally sub-millisecond; inheriting the 30-minute default meant a lock
// ORPHANED by a crashed holder stayed unreclaimable for up to 30 minutes,
// during which every recordBinItem call burned its whole retry budget
// (measured ~606ms) and returned null. A much shorter, honestly-sized
// staleness window lets a genuinely orphaned lock be reclaimed almost
// immediately instead.
//
// THE NUMBER'S OWN TRADE (WAVE-16 finding, main's ruling: 5000 stands, the
// comment gains the honest basis): a stale window has two customers pulling
// opposite ways — shortening it buys AVAILABILITY (an orphan reclaims
// sooner) and SPENDS SAFETY (a merely-STALLED live holder gets robbed
// sooner, reopening the exact read-modify-write race this lock exists to
// close). This 5000ms is sized from the HAPPY path: the critical section's
// measured hold time is 12-25ms even for a 20 MiB blob — a ~200x margin on
// local NTFS. The UNHAPPY path is where the number could still bite and is
// NOT quantified here: apply.mjs's own #57 FILESYSTEM-SEMANTICS header
// already admits network/cloud-synced mounts, where a write+fsync taking
// past 5s is not exotic. Before raising or lowering this constant, re-derive
// the happy-path hold time on the target filesystem, and treat an
// unquantified network/cloud mount as the open question, not a solved one.
const BIN_LOCK_STALE_MS = 5000;

function binDir(projectRoot, name) {
  return path.join(txDirFor(projectRoot), name);
}

// Bare-filename allowlist (F1 — the umbrella path-traversal lesson: allowlist
// the shape, never segment-scan): every legitimate bin id is a program-
// generated FLAT name (`${now}-${rand}`, recordBinItem below), so anything
// not a bare name (separators, `.`/`..`, absolute paths, drive prefixes) is
// rejected before it ever reaches a path.join. Guards BOTH trust boundaries
// at once: the USER-supplied id (restoreFromBin — `restore '..\\x'` would
// otherwise read arbitrary files to stdout) and a POISONED index.json
// shipped inside a cloned repo (loadIndex filters below — sweepBinAt rm's
// through index ids, the recoverDangling-class recovery-path hole).
// EXPORTED as the canonical copy (anchor-diff.mjs imports it — that module already
// depends on this one, so reusing it costs no new coupling and avoids a FOURTH
// hand-rolled copy of a security predicate). estate-archive.mjs and writeguard.mjs
// still keep byte-identical local copies on purpose: both sit on hot/isolated paths
// where an extra module load is not worth paying. They are verified identical today;
// if this body ever changes, change all three IN THE SAME COMMIT (the twin-drift law
// — one concept with N implementations is what shipped two HIGHs in R2/R3).
export function isBareId(id) {
  return typeof id === 'string' && !!id && id !== '.' && id !== '..' && path.basename(id) === id;
}

function loadIndex(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, INDEX_NAME), 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((i) => i && isBareId(i.id)) : [];
  } catch {
    return [];
  }
}
function saveIndex(dir, index) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    ensureSelfIgnore(dir);
    const tmp = path.join(dir, INDEX_NAME + '.tmp');
    fs.writeFileSync(tmp, JSON.stringify(index), 'utf8');
    fs.renameSync(tmp, path.join(dir, INDEX_NAME));
    return true;
  } catch {
    return false;
  }
}

// Record a bin item — `content` (a Buffer of the ORIGINAL BYTES, or a string
// for content this codebase derived as text) is written into the bin verbatim
// (no ceremony, no ask: "born silent" per the ledger). `original` = the
// source path it was cut from (advisory metadata only, never dereferenced by
// this module); `origin` = 'program-cut' (the certain-garbage broom,
// default) or 'wizard-cut' (a judgment-tier muscle-reorg pre-surgery image).
// Returns the item id (also the on-disk filename), or null on any failure —
// a failed stash must never block the wash it was backing up (fail-silent,
// the safety net's own failure is not the caller's problem to crash over).
//
// ── THE BIN IS A BYTE CHANNEL (2026-07-28, G3-3) ─────────────────────────────
// It used to be a STRING channel end to end: applyPlan banked
// `baseBuf.toString('utf8')` and this function wrote it back with
// writeFileSync(..., 'utf8'). Any byte sequence that is not valid UTF-8 — a
// CP1252 MEMORY.md, a Notepad "ANSI" save — decoded to U+FFFD on the way in and
// re-encoded as the replacement character on the way out, so THE RECOVERY NET
// CORRUPTED THE ONLY COPY IT HELD. Measured: one U+FFFD, byte-identical false,
// while an ASCII sibling deleted in the SAME applyPlan call round-tripped
// exactly — which is why nobody saw it. A net that alters what it catches is
// worse than no net, because the restore LOOKS successful.
// THE RULE THIS SETTLES, and it is the one to apply at the next such site: a
// RECOVERY path moves BYTES; an ANALYSIS path may decode to text and must say
// so at the call. Buffer in, Buffer out, no string hop in between.
// grad6 (relayed W1-F4, verified here with real concurrent child processes
// before fixing — 4 workers x 10 items each: catalogue had 16 entries against
// 31 actual blob files, expected 40 of each): this was a classic read-modify-
// write race — loadIndex/saveIndex re-read the WHOLE index, append one item,
// and write it back with a FIXED tmp filename. Two concurrent callers (a
// CoalFace-fanned-out wash, or two hooks firing near-simultaneously) can both
// read the SAME stale index, and whichever renames last silently discards
// the other's entry — the blob still lands on disk (its id is unique), so
// the catalogue UNDERCOUNTS real files rather than losing them outright.
// Fix: an exclusive per-bin lock (acquireLock, already used the identical way
// at applyPlan's tx-dir lock) around the whole read-modify-write section —
// including the blob write, so a deferred acquire leaves NOTHING behind
// rather than an uncatalogued orphan blob (consistency restored: measured
// catalogue === actual blob count on every re-run after this fix). A single
// attempt with NO retry (this codebase's existing lock convention, e.g.
// applyPlan) was tried first and measured TOO LOSSY here — recordBinItem is
// called far more densely than an applyPlan transaction (many stashes in one
// wash), and one attempt alone dropped 34 of 40 items to contention, which is
// a functional regression, not the occasional acceptable null the fail-silent
// contract describes. A short BOUNDED retry (a few ms of spin-wait, capped
// attempts so it can never hang) brings real concurrent bursts back to
// lossless while keeping the same fail-closed shape: still bounded, still
// returns null (never throws) if truly exhausted.
//
// THE MEASURED CEILING (F2, inspect findings-back): the invariant is
// `successful attempts === blobs === catalogued` at EVERY load, never a
// silent undercount — a refusal (null) leaves nothing behind. That invariant
// is what the test pins. The exact lossless threshold is a MACHINE-DEPENDENT
// property, not a fact about this code: on the box this comment was written,
// 4x10/8x10 concurrent workers came back lossless and 16x10=160 landed
// 146 with 14 clean refusals; on a different box under different load
// (WAVE-16, inspect findings-back) 8x10 already lost one to a single
// refusal. Do not read a specific count here as a spec — the room's own
// "never pin a machine-dependent count in a test" rule applies to a comment
// too, and a number this unstable is not safe to state without saying where
// it came from. Past whatever the local ceiling is, the honest degrade is a
// VISIBLE null the caller must handle (apply.mjs flags it — see the
// bin-stash note there), not a race to make the retry budget cover
// arbitrary concurrency. Raising the attempt cap trades latency for a
// higher ceiling; it does not change the shape.
function sleepMs(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // F3/WAVE-16 finding 4: no SharedArrayBuffer/Atomics.wait on this runtime
    // (dead on any supported Node version today, but the fallback must still
    // BACK OFF — silently retrying immediately turns a bounded, jittered
    // wait into a busy-spin loop, the opposite of what this function exists
    // to do). process.hrtime.bigint() is the MONOTONIC clock (apply.mjs's
    // own ownerToken already uses and documents it as such, two lines away
    // from this module's only other clock read) — Date.now() is wall-clock
    // and can step backward (NTP correction, a manual clock change), which
    // would silently extend a "bounded" wait by the size of the step. A
    // bounded spin on the monotonic clock still costs CPU but genuinely
    // waits, and now actually has the property this comment claims.
    const untilNs = process.hrtime.bigint() + BigInt(ms) * 1000000n;
    while (process.hrtime.bigint() < untilNs) { /* bounded busy-wait — no sync sleep primitive available */ }
  }
}
export function recordBinItem(projectRoot, name, { content, original, origin = 'program-cut', now = Date.now() } = {}) {
  const dir = binDir(projectRoot, name);
  let lock;
  try {
    fs.mkdirSync(dir, { recursive: true });
    ensureSelfIgnore(dir);
    for (let attempt = 0; attempt < 40 && !(lock && lock.acquired); attempt++) {
      if (attempt > 0) sleepMs(2 + Math.floor(Math.random() * 4)); // 2-5ms jitter, short and bounded
      lock = acquireLock(path.join(dir, BIN_LOCK_NAME), { now, staleMs: BIN_LOCK_STALE_MS });
    }
    if (!lock.acquired) return null;
    const id = `${now}-${Math.random().toString(36).slice(2, 8)}`;
    const body = Buffer.isBuffer(content) ? content : Buffer.from(typeof content === 'string' ? content : '', 'utf8');
    fs.writeFileSync(path.join(dir, id), body); // NO encoding argument: raw bytes
    const index = loadIndex(dir);
    // bytes (0i): the size-cap layer's weight — recorded at birth so the
    // sweep never has to re-stat the common case.
    index.push({ id, at: now, bytes: body.length, original: typeof original === 'string' ? original : null, origin: origin === 'wizard-cut' ? 'wizard-cut' : 'program-cut' });
    if (!saveIndex(dir, index)) { try { fs.rmSync(path.join(dir, id), { force: true }); } catch {} return null; }
    return id;
  } catch {
    return null;
  } finally {
    if (lock && lock.acquired) lock.release();
  }
}

// The PULL-ONLY discovery surface: every item currently in the bin (id/at/
// original/origin). Never called automatically by anything in this codebase.
export function listBin(projectRoot, name) {
  return loadIndex(binDir(projectRoot, name));
}

// The deliberate walk-in restore door — read one item's BYTES by id. Returns a
// Buffer, or null (not an empty Buffer) on a miss, so a caller can tell "empty
// file" from "not found" — a restore of a genuinely-empty stash is legitimate.
// F1: `id` is USER-supplied (the cli restore subcommand) — the bare-name
// allowlist rejects any traversal shape (`../x`, absolute, `.`/`..`) as a
// plain not-found before the path is ever built.
//
// A BUFFER, NOT A STRING, and deliberately not both (G3-3): the door that
// exists to hand back the real bytes cannot be the door that transcodes them.
// Shipping a string view ALONGSIDE this would recreate the exact defect class
// being fixed one file over — two readers of one artifact, and the next caller
// picks the wrong one. A caller that wants text decodes at its own call site
// and thereby declares that choice (anchor-diff does; the CLI pipes bytes).
export function restoreFromBin(projectRoot, name, id) {
  if (!isBareId(id)) return null;
  try { return fs.readFileSync(path.join(binDir(projectRoot, name), id)); }
  catch { return null; }
}

// Apply retention.mjs's pure policy to one bin: partition (keep/destroy),
// then DESTROY what it says to — verify each delete actually happened before
// counting it, append a death-certificate line, and only THEN drop it from
// the index. An item retentionPlan says to KEEP is never touched. A delete
// that cannot be verified gone is NOT reported destroyed and stays in the
// index (never a false "destroyed" — the broom asymmetry: leftover dust
// waits for the next pass, that is the safe direction).
function sweepBinAt(dir, horizonMs, now, budgetBytes = Infinity) {
  const index = loadIndex(dir);
  if (!index.length) return { destroyed: 0, kept: 0 };
  // Legacy index entries (pre-0i) carry no bytes — weigh them by a one-time
  // stat so they participate in the size cap instead of escaping it forever;
  // an unstattable item stays weightless (keep-on-doubt, retention.mjs's own
  // rule for weightless items).
  for (const item of index) {
    if (!Number.isFinite(Number(item.bytes))) {
      try { item.bytes = fs.statSync(path.join(dir, item.id)).size; } catch { /* weightless -> never size-evicted */ }
    }
  }
  const { keep, destroy, reasons, capConflict } = retentionPlan(index, now, { horizonMs, budgetBytes });
  const survivors = [...keep];
  const cert = [];
  for (const item of destroy) {
    const p = path.join(dir, item.id);
    try { fs.rmSync(p, { force: true }); } catch { /* leftover dust waits for the next pass */ }
    if (!fs.existsSync(p)) {
      const ageDays = Math.round((now - item.at) / 86400000);
      // name/age/rule — the full certificate this module's header always
      // promised (the P8 audit finding: the old line carried only id+age
      // while the id->file mapping died in the SAME operation, leaving a
      // human unable to say WHAT was destroyed or WHY). The source filename
      // and the axis that fired now live in the certificate itself, so they
      // survive the index entry's deletion.
      const rule = reasons.get(item) || 'horizon';
      const orig = (typeof item.original === 'string' && item.original) ? item.original : '-';
      cert.push(`${new Date(now).toISOString()} destroyed ${item.id} (age ${ageDays}d, rule ${rule}) original ${orig}`);
    } else {
      survivors.push(item); // unverifiable death -> never claimed, kept for the next pass
    }
  }
  // The unsatisfiable-cap audit line (retention.mjs capConflict): the floor +
  // retrievability/doubt protections outweigh the byte budget, so the bin is
  // deliberately over cap this run. Logged here (the bin's own audit trail)
  // AND surfaced on the sweep's return for the caller's receipt — a config
  // conflict resolved by silence is the senior-domain failure not to port.
  if (capConflict) {
    cert.push(`${new Date(now).toISOString()} cap-conflict kept ${capConflict.keptBytes}B > budget ${capConflict.budgetBytes}B — the ${Math.round(TIER1_KEEP_ALL_MS / 3600000)}h keep-all floor (+ newest/doubt protections) exceeds the cap; bin over budget this run, nothing young destroyed`);
  }
  if (cert.length) {
    try { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(path.join(dir, DEATH_LOG_NAME), cert.join('\n') + '\n', 'utf8'); } catch { /* the certificate is a record, not a gate */ }
  }
  saveIndex(dir, survivors);
  // capConflict only present when live: existing callers/tests deepStrictEqual
  // the two-field shape, and an always-null third field would churn every one
  // for no information (ponytail: additive-when-present).
  const out = { destroyed: index.length - survivors.length, kept: survivors.length };
  if (capConflict) out.capConflict = capConflict;
  return out;
}

// storeBytes (0i) -> the bin's size budget: BIN_BUDGET_STORE_MULTIPLE x the
// measured store (never the disk — V2). No measured store (absent/zero/
// malformed) = Infinity = the cap layer inert, horizon-only: the pre-0i
// behavior and the keep-on-doubt fail direction.
function budgetFrom(storeBytes) {
  const s = Number(storeBytes);
  return Number.isFinite(s) && s > 0 ? s * BIN_BUDGET_STORE_MULTIPLE : Infinity;
}

// Sweep the fat bin (30-day horizon — 1 burst-gap, per retention.mjs's own
// birth certificate) and store.old (60-day horizon — 2 burst-gaps,
// surgery-grade caution); BOTH also size-capped against `opts.storeBytes`
// (0i, whichever limit binds first). Fail-silent housekeeping, never fatal
// to a caller (matches apply.mjs's sweepSnapshots — the sibling housekeeping
// call this piggybacks alongside). RUN-GATED (0h-GUARD): callable only from
// a real wash run's applyPlan preflight — never wire these to a hook/cron.
export function sweepFatBin(projectRoot, { now = Date.now(), storeBytes } = {}) {
  try { return sweepBinAt(binDir(projectRoot, FAT_BIN_NAME), HORIZON_MS.fat, now, budgetFrom(storeBytes)); }
  catch { return { destroyed: 0, kept: 0 }; }
}
export function sweepStoreOld(projectRoot, { now = Date.now(), storeBytes } = {}) {
  try { return sweepBinAt(binDir(projectRoot, STORE_OLD_NAME), HORIZON_MS['store.old'], now, budgetFrom(storeBytes)); }
  catch { return { destroyed: 0, kept: 0 }; }
}

// Read the death log (the pull-surface for "what got destroyed and when" —
// never pushed/narrated, per the headroom-quiet doctrine). Returns '' on a
// missing/unreadable log, never throws.
export function readDeathLog(projectRoot, name) {
  try { return fs.readFileSync(path.join(binDir(projectRoot, name), DEATH_LOG_NAME), 'utf8'); }
  catch { return ''; }
}

// THE UNUSED-DOOR FEAR, layer 1 (MEMORY.md): a JUDGMENT cut leaves this ONE
// breadcrumb line so a later reader notices recoverable content BEFORE
// inventing a replacement (the desktop Recycle-Bin icon — passive, present,
// nobody misses what a CERTAIN-garbage cut removes, but a judgment cut is
// different: it removed something a future turn might wrongly "helpfully"
// re-derive). Program-side fixed template — never agent-composed prose.
export function breadcrumb({ date, binPath } = {}) {
  const d = typeof date === 'string' && date ? date : new Date().toISOString().slice(0, 10);
  const p = typeof binPath === 'string' && binPath ? binPath : `.claude/coalwash/${FAT_BIN_NAME}`;
  return `<!-- washed ${d} · removed content recoverable at ${p} — check the bin/journal before re-deriving; never invent a missing memory -->`;
}
