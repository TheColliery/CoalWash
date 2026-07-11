// bins.mjs — the two bins (fat bin + store.old), WIRING retention.mjs's pure
// policy into actual filesystem effects (beta.12 item 4). retention.mjs
// already IS the destruction law (birth=event-only, life=dual-axis thinning,
// horizon=burst-gap-derived) — this module only writes items, runs that
// policy, destroys what it says to (verify + a one-line death certificate),
// and exposes the PULL-ONLY read/restore surface. Nothing here is auto-loaded
// or discoverable: both bins live inside the SAME self-ignored tx dir
// class-b.mjs's G4 test already proves never surfaces as class-B.
//
// TWO-BIN SPLIT (MEMORY.md "TWO-BIN SPLIT" — Windows keeps these mechanisms
// separate, so this copies the separation, not a merged bin):
//   FAT BIN   (30d horizon) — per-cut records from the normal-mode ceiling
//             filter (the free, high-churn producer; Recycle-Bin economics).
//   STORE.OLD (60d horizon) — whole-store pre-surgery images from the
//             wizard's muscle-reorg tier (rare, surgery-grade caution;
//             Windows.old economics). Items may carry `origin:
//             'program-cut'|'wizard-cut'` for future eviction-priority use
//             (a tag, not a third bin — a new bin needs BOTH different
//             retention economics AND dangerous cross-class eviction
//             pressure; wizard-fat passes the first, fails the second
//             because muscle already escaped to store.old, so the tag alone
//             is sufficient per the ledger's own bin-split criterion).
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
import { txDirFor, ensureSelfIgnore } from './apply.mjs';
import { HORIZON_MS, retentionPlan } from './retention.mjs';

export const FAT_BIN_NAME = 'fat-bin';
export const STORE_OLD_NAME = 'store.old';
const INDEX_NAME = 'index.json'; // per-bin manifest: [{id, at, original, origin}]
const DEATH_LOG_NAME = 'death.log'; // append-only death certificates, one line per destroyed item

function binDir(projectRoot, name) {
  return path.join(txDirFor(projectRoot), name);
}

function loadIndex(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, INDEX_NAME), 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((i) => i && typeof i.id === 'string') : [];
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

// Record a bin item — `content` (string) is written into the bin verbatim
// (no ceremony, no ask: "born silent" per the ledger). `original` = the
// source path it was cut from (advisory metadata only, never dereferenced by
// this module); `origin` = 'program-cut' (the certain-garbage broom,
// default) or 'wizard-cut' (a judgment-tier muscle-reorg pre-surgery image).
// Returns the item id (also the on-disk filename), or null on any failure —
// a failed stash must never block the wash it was backing up (fail-silent,
// the safety net's own failure is not the caller's problem to crash over).
export function recordBinItem(projectRoot, name, { content, original, origin = 'program-cut', now = Date.now() } = {}) {
  const dir = binDir(projectRoot, name);
  try {
    fs.mkdirSync(dir, { recursive: true });
    ensureSelfIgnore(dir);
    const id = `${now}-${Math.random().toString(36).slice(2, 8)}`;
    fs.writeFileSync(path.join(dir, id), typeof content === 'string' ? content : '', 'utf8');
    const index = loadIndex(dir);
    index.push({ id, at: now, original: typeof original === 'string' ? original : null, origin: origin === 'wizard-cut' ? 'wizard-cut' : 'program-cut' });
    if (!saveIndex(dir, index)) { try { fs.rmSync(path.join(dir, id), { force: true }); } catch {} return null; }
    return id;
  } catch {
    return null;
  }
}

// The PULL-ONLY discovery surface: every item currently in the bin (id/at/
// original/origin). Never called automatically by anything in this codebase.
export function listBin(projectRoot, name) {
  return loadIndex(binDir(projectRoot, name));
}

// The deliberate walk-in restore door — read one item's content by id.
// Returns null (not '') on a miss, so a caller can tell "empty file" from
// "not found" — a restore of a genuinely-empty stash is legitimate.
export function restoreFromBin(projectRoot, name, id) {
  if (typeof id !== 'string' || !id) return null;
  try { return fs.readFileSync(path.join(binDir(projectRoot, name), id), 'utf8'); }
  catch { return null; }
}

// Apply retention.mjs's pure policy to one bin: partition (keep/destroy),
// then DESTROY what it says to — verify each delete actually happened before
// counting it, append a death-certificate line, and only THEN drop it from
// the index. An item retentionPlan says to KEEP is never touched. A delete
// that cannot be verified gone is NOT reported destroyed and stays in the
// index (never a false "destroyed" — the broom asymmetry: leftover dust
// waits for the next pass, that is the safe direction).
function sweepBinAt(dir, horizonMs, now) {
  const index = loadIndex(dir);
  if (!index.length) return { destroyed: 0, kept: 0 };
  const { keep, destroy } = retentionPlan(index, now, { horizonMs });
  const survivors = [...keep];
  const cert = [];
  for (const item of destroy) {
    const p = path.join(dir, item.id);
    try { fs.rmSync(p, { force: true }); } catch { /* leftover dust waits for the next pass */ }
    if (!fs.existsSync(p)) {
      const ageDays = Math.round((now - item.at) / 86400000);
      cert.push(`${new Date(now).toISOString()} destroyed ${item.id} (age ${ageDays}d)`);
    } else {
      survivors.push(item); // unverifiable death -> never claimed, kept for the next pass
    }
  }
  if (cert.length) {
    try { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(path.join(dir, DEATH_LOG_NAME), cert.join('\n') + '\n', 'utf8'); } catch { /* the certificate is a record, not a gate */ }
  }
  saveIndex(dir, survivors);
  return { destroyed: index.length - survivors.length, kept: survivors.length };
}

// Sweep the fat bin (30-day horizon — 1 burst-gap, per retention.mjs's own
// birth certificate) and store.old (60-day horizon — 2 burst-gaps,
// surgery-grade caution). Fail-silent housekeeping, never fatal to a caller
// (matches apply.mjs's sweepSnapshots — the sibling housekeeping call this
// piggybacks alongside).
export function sweepFatBin(projectRoot, { now = Date.now() } = {}) {
  try { return sweepBinAt(binDir(projectRoot, FAT_BIN_NAME), HORIZON_MS.fat, now); }
  catch { return { destroyed: 0, kept: 0 }; }
}
export function sweepStoreOld(projectRoot, { now = Date.now() } = {}) {
  try { return sweepBinAt(binDir(projectRoot, STORE_OLD_NAME), HORIZON_MS['store.old'], now); }
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
