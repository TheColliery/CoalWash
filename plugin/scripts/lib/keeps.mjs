// keeps.mjs — the keep-verdict store: a per-project ledger of ALREADY-
// ADJUDICATED "keep" decisions (an outsider/insider/human review confirmed a
// flagged memory IS load-bearing — keep it). Plumbing only: this guards
// against the decision-fatigue hazard of a future review pass re-flagging the
// same already-settled target without new evidence. The SKILL contract (docs
// sub) instructs the outsider to consult this store and not re-flag on no new
// evidence; this module only stores/reads the record.
//
// File shape: { v: 1, keeps: [{ target, reason, date }] }. The schema-version
// field ports XP-deletes-Vista-restore-points: an OLDER CoalWash meeting a
// NEWER keeps.json (v > 1) treats it as READ-ONLY — loadKeeps returns [] (we
// cannot parse what we do not know) and recordKeep refuses to rewrite it
// (never clobber a newer tool's artifact).
//
// Lives inside the SAME sandbox dir apply.mjs already self-ignores + contains
// (<project>/.claude/coalwash/) — no new privacy surface, no new config key.
// Fail-silent throughout (Phoenix-13): a missing/corrupt file reads as [], a
// write failure is swallowed. The ledger is a nice-to-have optimization, never
// load-bearing for correctness — losing it just re-exposes a target to review.
//
// GLOBAL variant (design-pass item, MEMORY.md "THE SHARED GLOBAL SLICE"): a
// keep recorded per-project does not shield a GLOBAL class-B file (the home
// CLAUDE.md closure) from a DIFFERENT project's outsider re-flagging it —
// loadGlobalKeeps/recordGlobalKeep file the SAME shape at the ~/.claude root
// (.coalwash-global-keeps.json) instead, so an adjudicated keep on a global
// target shields it machine-wide. ~/.claude/ is a home dotfile dir, not
// a project repo, so it carries no ensureSelfIgnore (that guard exists only to
// stop a PROJECT from accidentally version-controlling its own tx dir).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto'; // U7: CSPRNG suffix for the write temp below (zero-dep builtin)
import { txDirFor, ensureSelfIgnore, trackedInOwnFolder, acquireLock, lockLeftNote } from './apply.mjs';
import { claudeBaseDir, readRepoFileBounded, MAX_DOC_BYTES } from './config-load.mjs';
import { ownSandboxDir } from './repo-fs.mjs';

export const KEEPS_NAME = 'keeps.json'; // exported for apply.mjs's KEEPS-GATE (opts.txDir-aware path build)
const KEEPS_SCHEMA_V = 1;
const GLOBAL_KEEPS_NAME = '.coalwash-global-keeps.json';

// THE KEEPS LOCK (fire 126, 18a item 3). recordKeepAt reads the store, upserts one entry and renames a temp over it; two
// recorders at once (two sessions, or a wizard and a second agent) each read the old store and the later rename dropped the
// other's entry while both answered ok. So the read-modify-write runs under a lock of its own beside the store
// (`<store>.lock`), the bin catalogue's shape (tailings.mjs acquireBinLock, P95-1), never the transaction lock: a keep
// recorded while a wash holds that one must not wait 30 minutes for it.
// KEEPS_LOCK_STALE_MS: the section reads at most MAX_DOC_BYTES, writes one temp and renames it, milliseconds even for a large
// store, so 5 s is far past any live hold and a crashed recorder's lock blocks keeps for 5 s at most (the transaction
// default, 30 minutes, would block them for half an hour). KEEPS_LOCK_TRIES retries 2-5 ms apart (jittered, about 0.1-0.2 s
// in all) ride out another recorder's hold; past them the call refuses and writes nothing.
export const KEEPS_LOCK_STALE_MS = 5000;
const KEEPS_LOCK_TRIES = 40;
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// THE RENAME RETRY (fire 129, INSPECT 128 M128-1). The lock serialises writers, never readers: on Windows a rename over a store
// another handle holds open (loadKeeps, the KEEPS-GATE, another recorder's own read before it takes the lock, an indexer) fails
// EPERM, EACCES or EBUSY for as long as that read lasts, milliseconds for a store this size. So the rename is retried
// KEEPS_RENAME_RETRIES times KEEPS_RENAME_WAIT_MS apart, 0.45 s of waiting in all, about a tenth of the 5 s stale window (a
// margin of ~4.5 s, so a live holder is never robbed while it waits), re-checking the lock before each retry.
export const KEEPS_RENAME_RETRIES = 9;
export const KEEPS_RENAME_WAIT_MS = 50;
const RENAME_TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);
// N128-1: what a lock path that is not a plain file actually is (null for a plain single-link file or nothing at all). Such a
// lock is permanent, CoalWash never takes one over, so the recorder refuses at once instead of spending its retries on it.
function nonPlainLock(lockFile) {
  let st;
  try { st = fs.lstatSync(lockFile); } catch { return null; }
  if (st.isSymbolicLink()) return 'a link (a symlink or a junction)';
  if (st.isDirectory()) return 'a directory';
  if (!st.isFile()) return 'a special file';
  return st.nlink > 1 ? 'a file with more than one hard link' : null;
}
function acquireKeepsLock(file, selfIgnore) {
  let lock;
  for (let attempt = 0; attempt < KEEPS_LOCK_TRIES && !(lock && lock.acquired); attempt++) {
    if (attempt > 0) pause(2 + Math.floor(Math.random() * 4));
    // `now` is a live clock reading: acquireLock judges staleness as now - lockFile.mtimeMs (tailings.mjs row 18)
    lock = acquireLock(`${file}.lock`, { now: Date.now(), staleMs: KEEPS_LOCK_STALE_MS, selfIgnore });
    const kind = lock.acquired ? null : nonPlainLock(`${file}.lock`);
    if (kind) return { acquired: false, nonPlain: kind };
  }
  return lock;
}

export function keepsPath(projectRoot) {
  return path.join(txDirFor(projectRoot), KEEPS_NAME);
}
export function globalKeepsPath(home = os.homedir()) {
  return path.join(claudeBaseDir(home), GLOBAL_KEEPS_NAME);
}

// `root`: the project tx dir its caller derived through ownSandboxDir, or null for the user's own global store.
function rawKeepsOrNull(file, root) {
  // CWK-137: bounded and kind-gated -- a project keeps.json sits in the repo-plantable
  // .claude/coalwash/ (a link to /dev/zero there hung the reader). E2-4: contained to that
  // folder ITSELF; a keeps.json that resolves anywhere else is refused and protects nothing.
  try { return JSON.parse(readRepoFileBounded(file, root, MAX_DOC_BYTES)); } catch { return null; }
}

// Every prior keep-adjudication at `file`: [{ target, reason, date, anchor?,
// file? }]. [] on a missing file, corrupt JSON, a wrong/newer schema, or
// malformed elements (never throws). Exported (as loadKeepsAt) so apply.mjs's
// KEEPS-GATE can read a keeps store at the exact tx-dir path a transaction is
// actually using (opts.txDir in hermetic tests) — one loader, one schema.
// `root` = null: a caller-trusted path (the global store, a test fixture); a project store goes through loadProjectKeepsAt.
export function loadKeepsAt(file, root = null) {
  const parsed = rawKeepsOrNull(file, root);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  if (Number(parsed.v) > KEEPS_SCHEMA_V) return []; // newer schema: unreadable to us
  return Array.isArray(parsed.keeps) ? parsed.keeps.filter((k) => k && typeof k.target === 'string') : [];
}
const loadKeepsFrom = loadKeepsAt;

// Record (or refresh) an adjudicated keep at `file`. Upserts by `target` — a
// re-review of the same target REPLACES the prior entry rather than piling up
// duplicates (the ledger tracks the LATEST verdict, not a full history).
// Optional beta.12 fields (the KEEPS-GATE's enforcement handle): `anchor` =
// the VERBATIM protected text span, `anchorFile` = the absolute path of the
// store file it lives in. A keep carrying both is mechanically enforced at
// applyPlan; a keep without them stays advisory (the pre-beta.12 shape,
// unchanged behavior).
//
// grad11 F5 return-contract (main's ruling): a bare `true`/`false` cannot
// distinguish "the write failed" from "the write succeeded but the anchor
// you asked for did not survive the floor" — the same three-valued-outcome-
// forced-into-two shape as `deadLinks` firing while `applyPlan` still
// returns `ok:true`, and as `frontmatterCensus`'s old hardcoded
// `incomplete:false`. Returns `{ ok, anchorDropped, anchorStored }`:
// `ok` = the write itself succeeded (the old boolean's exact meaning, and
// the ONLY thing an early-return failure — bad target, newer schema, a
// thrown I/O error — can report, so those paths still resolve to `ok:false`
// with nothing to say about an anchor that was never reached);
// `anchorStored` = the entry that landed on disk carries A real anchor
// (from this call or a preserved prior one); `anchorDropped` = TRUE exactly
// when this call supplied a real, non-empty anchor string and the ENTRY
// THAT LANDED does not carry that string — the floor rejected it and no
// prior anchor happened to survive in its place. A caller that never
// intended to set an anchor this call (the pre-beta.12 advisory shape)
// gets `anchorDropped:false` — nothing was requested, so nothing was lost.
// Optional `pendingUser` (board #129): same preserve-unless-explicit rule as
// anchor/anchorFile, ONE DIRECTION DIFFERENT ON PURPOSE. `undefined` (not
// passed) preserves the prior value — an ordinary re-affirm that knows
// nothing about this mechanism must not silently clear a standing return-to-
// user. `true` sets it (+ `pendingSince`, defaulting like `date` does).
// `false` — passed EXPLICITLY, never inferred — is the ONLY way to clear it:
// the deliberate signal that the user's decision was actually recorded, not
// merely that this call happened to omit the field.
// `selfIgnore`: the keeps lock's acquireLock option (true for a project store, whose folder carries the catch-all; false for the
// global one in the user's own ~/.claude, as the global transaction lock does).
function recordKeepAt(file, root, ensureDir, selfIgnore, { target, reason = '', date, anchor, anchorFile, pendingUser, pendingSince } = {}) {
  if (typeof target !== 'string' || !target) return { ok: false, anchorDropped: false, anchorStored: false };
  const lockFile = `${file}.lock`;
  let lock = null;
  let tmp = null; // fire 129: set once the temp is written; removed after the body unless the rename landed it
  let renamed = false;
  const newer = (raw) => raw && typeof raw === 'object' && !Array.isArray(raw) && Number(raw.v) > KEEPS_SCHEMA_V;
  // fire 126: the body's returns land in `out`, so the lock's release below is reported on every result
  const out = (() => { try {
    const raw = rawKeepsOrNull(file, root);
    if (newer(raw)) return { ok: false, anchorDropped: false, anchorStored: false }; // read-only to us
    ensureDir();
    lock = acquireKeepsLock(file, selfIgnore);
    if (lock.nonPlain) return { ok: false, anchorDropped: false, anchorStored: false, error: `keeps lock: ${lockFile} is not a plain file (it is ${lock.nonPlain}); CoalWash never takes over a lock it did not make, so nothing was written and no retry was spent — remove it by hand once no CoalWash run is active` };
    if (!lock.acquired) return { ok: false, anchorDropped: false, anchorStored: false, error: `keeps lock: another recorder holds ${lockFile} (${lock.reason}); nothing was written — record the keep again` };
    // re-read INSIDE the lock: the read above may be stale by now, and the upsert must start from what is on disk
    if (newer(rawKeepsOrNull(file, root))) return { ok: false, anchorDropped: false, anchorStored: false };
    const existing = loadKeepsFrom(file, root);
    const prior = existing.find((k) => k.target === target);
    const keeps = existing.filter((k) => k.target !== target);
    // grad6 W3-K2 (CoalBoard verdict): this used to REBUILD the entry from
    // only THIS call's arguments -- a human re-affirming an already-enforced
    // keep (e.g. just bumping `reason`/`date`, the common re-review case)
    // without re-typing `anchor`/`anchorFile` silently dropped them, downgrading
    // the keep from mechanically ENFORCED (applyPlan's KEEPS-GATE) to merely
    // advisory, with no flag raised — the exact opposite of what a re-review
    // is supposed to do. Fix: preserve the PRIOR entry's anchor/anchorFile
    // whenever this call doesn't supply its own (a real, non-empty new value
    // still overrides — an intentional update, not a downgrade). There is no
    // way to distinguish "didn't pass one" from "wants it cleared" at this
    // call shape, so the safe direction is to never let re-affirming silently
    // weaken protection; explicitly clearing an anchor is a different, not-yet-
    // built feature, not this fix's job.
    // grad7 ruling Root E / grad8 F4: the ORIGINAL grad6 fix checked truthiness
    // (`anchor` alone), which a whitespace-only string satisfies ('' is falsy,
    // ' ' is not) — a re-affirm call passing anchor:' ' silently OVERWROTE a
    // real 15+ char protected span with a single space, while the KEEPS-GATE
    // downstream (apply.mjs) still reads the entry as "enforced" (anchor is a
    // non-empty string) and its own survival check (`content.includes(' ')`)
    // is trivially true for nearly any rewrite — the keep stops protecting
    // anything without ever LOOKING broken. A real new value must carry real
    // content, not just pass `typeof === 'string' && truthy`.
    // grad9 F3: `trim().length>0` still wasn't enough — the SAME defect, wearing
    // different bytes. Two failures, opposite polarity, one root cause (a check
    // asking "is this non-empty" instead of "does this identify a real span"):
    // (1) a degenerate 1-3 char anchor ("e", "#", "the") passes `trim().length>0`
    //     and silently OVERWRITES a real, much longer, adjudicated anchor on
    //     re-affirm — and then, through applyPlan's real KEEPS-GATE, a rewrite
    //     dropping EVERY byte of the true protected content goes ok:true,
    //     applied:1, unflagged, while the entry still reads as "enforced".
    // (2) U+200B (ZERO WIDTH SPACE) is Cf, not in JS `\s` — `'​'.trim()`
    //     does NOT strip it, so a ZWSP-only value ALSO passes as "real content"
    //     and then never matches anything in real text, permanently
    //     false-refusing every future edit to that file.
    // Fix the CLASS: strip ordinary whitespace AND Unicode invisible/format
    // characters before measuring, for BOTH fields (closes polarity 2
    // everywhere) — and additionally require a real MINIMUM length for an
    // ANCHOR specifically (closes polarity 1): an adjudicated keep names a
    // specific clause, never a single character or a common short word.
    // anchorFile is a PATH, which is legitimately short, so it keeps the
    // non-empty-after-stripping bar only, no length floor.
    //
    // grad10 F5 [MEDIUM, both polarities]: `\p{Cf}` alone missed FOUR more
    // classes that reproduce the identical bug — combining marks (Mn, e.g.
    // U+0300), controls beyond `\s` (Cc, e.g. U+0001), and two SPECIFIC
    // codepoints outside any strippable-whole-category (Hangul filler
    // U+3164 is `Lo` — letters, which legitimately holds CJK/Thai/etc. real
    // text and must NOT be blanket-stripped; Braille blank U+2800 is `So` —
    // symbols, which legitimately holds real math/currency/etc. content for
    // the identical reason). `\p{Default_Ignorable_Code_Point}` (a real
    // ECMAScript Unicode property, verified supported and verified to leave
    // ordinary CJK/Latin/Thai letters untouched) catches U+3164 without
    // touching Lo generally; U+2800 has no such property to lean on, so it
    // is named explicitly rather than folded into a category that would
    // over-strip.
    //
    // grad11 F5 [HIGH, silent, both halves the SAME bug this whole comment
    // block is fighting]. The line above used to ALSO strip `\p{Mn}` and
    // ALL of `\s` (not just runs of it), on the theory below that
    // undercounting a script's visible length is always the SAFE direction.
    // It is not, and the falsified claim ("SCRIPT-AGNOSTIC by construction",
    // a few lines below) is the tell: `\p{Mn}` marks are VISIBLE, load-
    // bearing parts of the rendered glyph in Thai, Vietnamese, and Arabic —
    // not invisible padding, the opposite of what this function exists to
    // strip. `ห้ามลบไฟล์นี้` (13 codepoints, a real adjudicated Thai clause)
    // lost 4 of them to Mn-stripping and fell to 9 — under the 12-char floor
    // below — silently dropped with `recordKeepAt` still returning success.
    // `\p{Mn}` is REMOVED from the strip set; the four still-genuinely-
    // invisible classes above (Cf/Cc/the two named exceptions) stay.
    //
    // The second half is the SAME shape on a different axis: `\s` used to be
    // DELETED outright rather than collapsed, so a real multi-line or multi-
    // word anchor's own STRUCTURAL whitespace (a 3-key flush-left YAML block
    // joined by newlines, an ordinary space-delimited phrase) was punished
    // exactly as hard as deliberate whitespace padding meant to inflate an
    // otherwise-junk anchor's apparent length. `"a: 1\nb: 2\nc: 3"` — a real,
    // ordinary, three-key anchor — stripped to `"a:1b:2c:3"` (9 chars, under
    // the floor) under the old rule. Collapsing every whitespace RUN to one
    // representative space, instead of deleting it, keeps a real anchor's
    // true ~14-char length intact while still refusing pure padding ("x" +
    // 20 spaces collapses to "x", still 1 char). `\p{Cc}` (which already
    // includes LF/CR/TAB) still strips anything the `\s+` collapse did not
    // already reduce to one ordinary space.
    //
    // NAMED RESIDUAL, restated with the corrected reasoning: this is not a
    // complete Default_Ignorable enumeration — a future invisible-rendering
    // codepoint outside these categories is not guaranteed caught; the four
    // reported here are.
    const stripInvisible = (v) => String(v).replace(/\s+/g, ' ').trim().replace(/[\p{Cf}\p{Cc}\p{Default_Ignorable_Code_Point}⠀]+/gu, '');
    // grad10 F4 [HIGH, content-loss]: length alone is a LENGTH proxy, not a
    // DISTINCTIVENESS one — "whatever" and "!!!!!!!!" both cleared the old
    // 8-char floor, and both are common/repeated enough to coincidentally
    // survive somewhere in unrelated boilerplate even after the protected
    // clause they were meant to name is gone, so the KEEPS-GATE's survival
    // check finds them and never flags the loss.
    //
    // CORRECTED grad10-round-2 HIGH-2: the first fix (raise the floor +
    // require >=2 WHITESPACE-delimited words) closed the reported shape by
    // assuming every script marks word boundaries with whitespace. Thai,
    // Japanese and Chinese do not — a real, adjudicated 24-50 character CJK/
    // Thai clause splits into exactly ONE "word" and was refused outright,
    // SILENTLY: `recordKeep` still returns true, the anchor is dropped, and
    // apply.mjs's KEEPS-GATE filters an anchor-less keep out of enforcement
    // entirely — the keep protects nothing and the user is told it worked.
    // Same silent-total-failure shape for any space-FREE technical token at
    // any length (a URL, a bare function call like `verifyBlobIntegrity()`),
    // and the word-count floor ALSO over-refused a genuinely short, real,
    // space-delimited phrase ("git rev-parse HEAD", 16 stripped chars) for
    // no reason connected to distinctiveness at all.
    //
    // The replacement measure is SCRIPT-AGNOSTIC by construction: distinct
    // CODEPOINT COUNT, never word count. grad11 F5 note: this claim was
    // FALSE at this file's own HEAD — see `stripInvisible` immediately
    // above, which was silently discarding Mn/whitespace content the
    // measure below then never got a chance to count. The claim is true of
    // what this function computes NOW; it was never true of what shipped.
    // "!!!!!!!!!!!!!!!!!!!!" (any length)
    // has exactly 1 distinct codepoint; "whatever"/"the the the" collapse to
    // a handful. A real adjudicated clause — in ANY script, with or without
    // word delimiters — draws from a far wider set: Thai/CJK/Latin prose all
    // carry many distinct codepoints even at short lengths, because a real
    // sentence is not a repeated token. Deliberately an ABSOLUTE floor, not
    // a RATIO: a ratio decays with length for any bounded alphabet (English
    // prose naturally drops toward ~26 distinct letters as length grows,
    // which a fixed ratio would eventually misread as non-distinctive) —
    // an absolute floor has no such decay and stays correct at any length.
    // MIN_MEANINGFUL_ANCHOR_LEN lowered from 20 to 12 (still above both
    // 8-char junk examples, comfortably below "git rev-parse HEAD"'s 16).
    // NAMED RESIDUAL: neither measure proves true uniqueness (this is
    // "plumbing only" per this file's own header — no read of the target
    // file's real content, an architecture change out of scope here) — a
    // short repeated PHRASE built from >=6 distinct characters
    // ("whatever whatever", 7 distinct chars) can still clear both floors.
    // Narrows the risk; does not close it fully, same standing as before.
    const MIN_MEANINGFUL_ANCHOR_LEN = 12;
    const MIN_DISTINCT_CHARS = 6;
    const hasRealAnchor = (v) => {
      if (typeof v !== 'string') return false;
      const stripped = stripInvisible(v);
      if (stripped.length < MIN_MEANINGFUL_ANCHOR_LEN) return false;
      return new Set([...stripped]).size >= MIN_DISTINCT_CHARS;
    };
    const hasRealPath = (v) => typeof v === 'string' && stripInvisible(v).length > 0;
    const mergedAnchor = hasRealAnchor(anchor) ? anchor : (prior && typeof prior.anchor === 'string' ? prior.anchor : undefined);
    const mergedAnchorFile = hasRealPath(anchorFile) ? anchorFile : (prior && typeof prior.anchorFile === 'string' ? prior.anchorFile : undefined);
    // grad11 F5 return-contract: see the header comment above recordKeepAt.
    // `anchorRequested` is deliberately the RAW `typeof anchor==='string' &&
    // anchor.length>0` test, not `hasRealAnchor` — a caller who typed ANY
    // non-empty string was asking for an anchor; whether it cleared the
    // floor is exactly the outcome being reported, not a precondition for
    // reporting it.
    const mergedPendingUser = pendingUser === false
      ? undefined
      : pendingUser === true
        ? true
        : (prior && prior.pendingUser === true ? true : undefined);
    const mergedPendingSince = mergedPendingUser
      ? (typeof pendingSince === 'string' && pendingSince ? pendingSince : (prior && typeof prior.pendingSince === 'string' ? prior.pendingSince : new Date().toISOString().slice(0, 10)))
      : undefined;
    const anchorRequested = typeof anchor === 'string' && anchor.length > 0;
    const anchorDropped = anchorRequested && mergedAnchor !== anchor;
    keeps.push({
      target,
      reason: String(reason || ''),
      date: date || new Date().toISOString().slice(0, 10),
      ...(mergedAnchor ? { anchor: mergedAnchor } : {}),
      ...(mergedAnchorFile ? { anchorFile: mergedAnchorFile } : {}),
      ...(mergedPendingUser ? { pendingUser: true, pendingSince: mergedPendingSince } : {}),
    });
    const name = `${file}.${crypto.randomBytes(12).toString('hex')}.tmp`;
    fs.writeFileSync(name, JSON.stringify({ v: KEEPS_SCHEMA_V, keeps }), { encoding: 'utf8', flag: 'wx' });
    tmp = name;
    // fire 126: a recorder that stalled past KEEPS_LOCK_STALE_MS may have been robbed, and its new holder may have renamed its
    // own store since. This one REFUSES rather than re-merging: unlike a bin item (whose blob is already on disk and needs its
    // row), nothing else of this record exists, so dropping it loses nothing a caller is not told about, while a re-merge and
    // rename made without the lock could still overwrite the new holder's write.
    // fire 129: the same check runs again before every rename retry, so a lock lost while a reader held the store still refuses
    let code = null;
    for (let attempt = 0; attempt <= KEEPS_RENAME_RETRIES; attempt++) {
      if (attempt > 0) pause(KEEPS_RENAME_WAIT_MS);
      const s = lock.state();
      if (s.state !== 'own') {
        const why = s.state === 'unreadable'
          ? `keeps lock unreadable: ${lockFile} could not be read for about one second (${s.code}; another program may be holding it open), so this recorder can no longer prove it holds the store`
          : `keeps lock stolen: another recorder took over ${lockFile} after it went stale (${KEEPS_LOCK_STALE_MS / 1000} s)`;
        return { ok: false, anchorDropped: false, anchorStored: false, error: `${why}; this keep was not written and the store on disk stands — record the keep again` };
      }
      try {
        fs.renameSync(tmp, file);
        renamed = true;
        return { ok: true, anchorDropped, anchorStored: !!mergedAnchor };
      } catch (e) {
        if (!RENAME_TRANSIENT.has(e && e.code)) throw e;
        code = e.code;
      }
    }
    return { ok: false, anchorDropped: false, anchorStored: false, error: `keeps write: the store ${file} could not be replaced (${code}, ${KEEPS_RENAME_RETRIES + 1} attempts ${KEEPS_RENAME_WAIT_MS} ms apart; another program may be holding it open); this keep was not written and the store on disk stands — record the keep again` };
  } catch (e) {
    // fire 63 (CodeRabbit t114): the reason rides beside the status fields, so a refusal (tracked:, self-ignore:) reaches the caller
    return { ok: false, anchorDropped: false, anchorStored: false, error: String((e && e.message) || e) };
  } })();
  // fire 129 (M128-1): a temp the rename did not land is removed on every path, a refusal, a throw or a failed rename alike
  if (tmp && !renamed) { try { fs.rmSync(tmp, { force: true }); } catch { /* this call's own temp; a later sweep is not ours to promise */ } }
  const lockLeft = lock && lock.acquired ? lockLeftNote(lockFile, lock.release()) : null;
  return lockLeft ? { ...out, lockLeft } : out;
}

// A project store, read contained to the tx dir ITSELF (E2-4). `txDir` is ownSandboxDir's answer (or a caller-trusted
// override), so no link sits between the project root and it; the containment refuses one planted below it.
export function loadProjectKeepsAt(txDir) {
  return loadKeepsFrom(path.join(txDir, KEEPS_NAME), txDir);
}
export function loadKeeps(projectRoot) {
  let dir;
  try { dir = ownSandboxDir(projectRoot, '.claude', 'coalwash'); } catch { return []; } // CWK-137: a linked sandbox holds no keeps of ours
  return loadProjectKeepsAt(dir);
}
export function recordKeep(projectRoot, opts = {}) {
  // CWK-137: the directory is proven link-free (ownSandboxDir) BEFORE the first read, and both
  // reads of the existing store are contained to it (E2-4) -- a planted link returns { ok: false }.
  let dir;
  try { dir = ownSandboxDir(projectRoot, '.claude', 'coalwash'); } catch (e) { return { ok: false, anchorDropped: false, anchorStored: false, error: String((e && e.message) || e) }; }
  // fire 55: an anchor quotes memory content, so no catch-all means no record ({ ok: false })
  return recordKeepAt(path.join(dir, KEEPS_NAME), dir, () => { const tracked = trackedInOwnFolder(dir); if (tracked) throw new Error(`tracked: ${tracked}`); fs.mkdirSync(dir, { recursive: true }); const why = ensureSelfIgnore(dir); if (why) throw new Error(`self-ignore: ${why}`); }, true, opts); // fire 59: a tracked file in the folder, no write
}

// Global-scope variants — identical shape/schema/upsert-by-target semantics,
// filed beside the global state file rather than a single project's tx dir.
// board #129: the keeps still awaiting an actual user decision — never a
// wash-time filter (a pending keep protects its target exactly like any
// other), only a REPORTING view for the receipt/wizard to surface.
export function pendingUserKeeps(keeps) {
  return Array.isArray(keeps) ? keeps.filter((k) => k && k.pendingUser === true) : [];
}

export function loadGlobalKeeps(home = os.homedir()) {
  return loadKeepsFrom(globalKeepsPath(home));
}
export function recordGlobalKeep(home = os.homedir(), opts = {}) {
  const dir = claudeBaseDir(home);
  return recordKeepAt(globalKeepsPath(home), null, () => { fs.mkdirSync(dir, { recursive: true }); }, false, opts); // root null: the user's own store
}
