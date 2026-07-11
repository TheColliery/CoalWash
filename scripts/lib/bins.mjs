// bins.mjs — the two bins (fat bin + store.old), WIRING retention.mjs's pure
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
// SIZE-CAP ∧ TIME-HORIZON (0i): every sweep below applies BOTH limits,
// whichever binds first — the horizon (per-bin, above) plus a size budget of
// BIN_BUDGET_STORE_MULTIPLE x the MEASURED STORE's bytes (never the disk —
// 0i V2; callers pass `storeBytes` from the session gauge; absent/zero =
// the cap layer inert, horizon-only, the keep-on-doubt direction).
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
import { HORIZON_MS, retentionPlan, BIN_BUDGET_STORE_MULTIPLE } from './retention.mjs';

export const FAT_BIN_NAME = 'fat-bin';
export const STORE_OLD_NAME = 'store.old';
const INDEX_NAME = 'index.json'; // per-bin manifest: [{id, at, bytes, original, origin}]
const DEATH_LOG_NAME = 'death.log'; // append-only death certificates, one line per destroyed item

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
function isBareId(id) {
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
    const body = typeof content === 'string' ? content : '';
    fs.writeFileSync(path.join(dir, id), body, 'utf8');
    const index = loadIndex(dir);
    // bytes (0i): the size-cap layer's weight — recorded at birth so the
    // sweep never has to re-stat the common case.
    index.push({ id, at: now, bytes: Buffer.byteLength(body, 'utf8'), original: typeof original === 'string' ? original : null, origin: origin === 'wizard-cut' ? 'wizard-cut' : 'program-cut' });
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
// F1: `id` is USER-supplied (the cli restore subcommand) — the bare-name
// allowlist rejects any traversal shape (`../x`, absolute, `.`/`..`) as a
// plain not-found before the path is ever built.
export function restoreFromBin(projectRoot, name, id) {
  if (!isBareId(id)) return null;
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
  const { keep, destroy } = retentionPlan(index, now, { horizonMs, budgetBytes });
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
