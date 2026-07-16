// estate-archive.mjs — class-A ESTATE layer, PHASE 2 PARTIAL: the ULTRA
// wizard tier (compress + index + search + restore). COALWASH_BLUEPRINT.md
// §19 is the authority; estate.mjs stays the pure-read P1 report — every
// MUTATING estate op lives HERE so P1's "every export is a pure read"
// invariant survives intact.
//
// WHAT ULTRA IS (USER-commissioned 2026-07-16): transcripts never load into
// context, so they are safe to move OFF the live tree — but they are NOT
// class-B (they fail the 4 washability tests: vendor-owned machine-parsed
// format), so ULTRA never semantic-edits a byte. It only MOVES BYTES
// recoverably: gzip is byte-exact and reversible; deletion is either
// delegated to the first-party `claude project purge` (COLD default) or
// undo-backed by the verified archive (WARM, and COLD under an explicit
// `estate.deleteCold: true`).
//
// VERIFIED vs ASSUMED (build-right-once — the load-bearing assumption behind
// the delete step, checked 2026-07-16 BEFORE this file existed):
//   VERIFIED (read-only): `claude project purge [options] [path]` exists on
//     this machine's CC ("Delete all Claude Code state for a project
//     (transcripts, tasks, file history, config entry)" — `claude project
//     --help`), and the platform docs sanction hand-deleting transcript
//     files ("You can also delete any of the application-data paths above by
//     hand. New sessions are unaffected"; consequence table: deleting
//     projects/ costs resume/continue/rewind for PAST sessions only —
//     blueprint §19 U2, code.claude.com/docs/en/claude-directory).
//   ASSUMED (documented, not live-mutated): that an individual old session's
//     absent .jsonl behaves exactly like a purged session (session gone from
//     the picker, everything else unaffected). The docs + the first-party
//     purge command make this the sanctioned shape, but no real
//     ~/.claude/projects file was deleted to prove it — the compress path is
//     safe regardless (copy-verify-then-delete + a full restore path).
//
// THE THREE AGE BANDS (config `estate`, per session unit = the flat
// <sid>.jsonl + any flat <sid>.* sibling + the <sid>/ overflow dir):
//   ACTIVE — the current session, anything whose NEWEST file mtime is younger
//     than `compressAfterDays`, or the session a CoalHearth in-progress
//     journal names. SKIPPED absolutely (never archived, never deleted).
//   WARM — older than compressAfterDays (and not COLD): gzip every file into
//     `<archiveDir>/<slug>/<rel>.gz` with COPY-VERIFY-THEN-DELETE — write the
//     .gz, decompress it back, byte-compare against the original; ONLY when
//     every file of the session verifies are the originals deleted. Any
//     mismatch/failure = the session's originals stay, its partial archive is
//     removed, the failure is reported. A mid-run interrupt therefore leaves
//     originals intact by construction (deletes are the LAST step per session).
//   COLD — older than `purgeAfterDays` (0 = never): NOT auto-deleted. The
//     report lists them and names the first-party `claude project purge`
//     command. Only an explicit `estate.deleteCold: true` archives-then-
//     deletes them, appending a death-certificate line (bins.mjs's pattern).
//
// RUN-GATE (0h-GUARD's sibling): every mutating export here is called ONLY
// from a wizard-consented ULTRA run (the SKILL's third wizard choice) via the
// CLI — NEVER from a hook, the SessionStart gauge, or any BMI band (estate is
// DISK, not context; the gauge/bands stay class-B only). The estate-archive
// test suite greps hooks/ to keep it that way.
//
// localOnly does NOT block ULTRA by design: no content-bearing sub is ever
// spawned — the dig-index extraction below is local deterministic CODE. This
// module deliberately never reads the localOnly key.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { claudeBaseDir } from './config-load.mjs';
import { ccProjectSlug, physicalOrNull, containedIn, physicalForCreate } from './class-b.mjs';
import { acquireLock, globalLockPath } from './apply.mjs';

export const ESTATE_ARCHIVE_DIRNAME = 'estate-archive';
export const ESTATE_INDEX_NAME = 'index.jsonl';
const DEATH_LOG_NAME = 'death.log'; // one-flock with bins.mjs's certificate log
const DAY_MS = 86400000;
// ~est display ratio for "MB after" on the bill — jsonl compresses ~10:1
// (blueprint §19's own figure). A display heuristic, never a promise.
export const EST_COMPRESS_RATIO = 10;
const FIRST_USER_LINE_MAX = 200;
const TOP_ENTITIES_MAX = 10;
const SESSION_FILE_CAP = 20000; // same defensive walk cap as estate.mjs

// ---------------------------------------------------------------------------
// config + paths
// ---------------------------------------------------------------------------

// Ordering guard on the (already clampedRead-clamped) estate block: bands must
// not cross. purgeAfterDays 0 = never-COLD; otherwise it is clamped UP to at
// least compressAfterDays (an inverted pair then yields an empty WARM band =
// LESS mutation — the safe fail direction, mirroring the 0r ordering-clamp).
export function resolveEstateCfg(estate) {
  const e = estate && typeof estate === 'object' ? estate : {};
  const compressAfterDays = Number.isFinite(e.compressAfterDays) ? e.compressAfterDays : 14;
  let purgeAfterDays = Number.isFinite(e.purgeAfterDays) ? e.purgeAfterDays : 180;
  if (purgeAfterDays !== 0 && purgeAfterDays < compressAfterDays) purgeAfterDays = compressAfterDays;
  return {
    compressAfterDays,
    purgeAfterDays,
    deleteCold: e.deleteCold === true,
    archiveDir: typeof e.archiveDir === 'string' ? e.archiveDir : '',
    indexEnabled: e.indexEnabled !== false,
  };
}

// Archive home. Default = ~/.claude/coal/coalwash/estate-archive (the
// OS-citizen namespace — CoalWash leaves no foreign files inside CC's own
// projects/ tree). A non-empty `estate.archiveDir` must be ABSOLUTE (relative
// -> fall back to the default); it may point at another drive — reclaiming
// SSD capacity is goal 2 — and the ULTRA bill names the resolved dir before
// consent, so the destination is always shown, never silent.
export function resolveArchiveDir(estate, home = os.homedir()) {
  const cfg = resolveEstateCfg(estate);
  if (cfg.archiveDir && path.isAbsolute(cfg.archiveDir)) return path.resolve(cfg.archiveDir);
  return path.join(claudeBaseDir(home), 'coal', 'coalwash', ESTATE_ARCHIVE_DIRNAME);
}

// CoalHearth in-progress journal signals for THIS project (MED-1 root-cause
// fix). CH's production writer (CoalHearth lib/state-snapshot.js
// buildStateSnapshot) persists { status:'in_progress', checklist,
// modifiedFiles, inFlightAgents, activePlan } — NO sessionId field, ever
// (CH's own resume-engine reads `data.sessionId || 'unknown'`:
// expected-absent). The old guard here required `typeof j.sessionId ===
// 'string'`, so it returned null on every real CH journal = dead in the
// field. Read only what CH ACTUALLY writes:
//   - status === 'in_progress' (rewritten on every PostToolUse)
//   - the journal file's OWN mtime — an independent liveness signal in the
//     PROJECT tree (the ~/.claude transcript tree's mtimes can lie after a
//     sync/restore; this file lives beside the work itself)
//   - sessionId IF a future CH version ever adds it (an ADDITIONAL match,
//     never the requirement)
// Fail-silent on absent/corrupt (no CoalHearth installed = no guard needed);
// classifySessions applies the banding policy on these signals.
export function chJournalGuard(projectRoot) {
  const none = { inProgress: false, mtimeMs: null, sessionId: null };
  try {
    const p = path.join(projectRoot, '.claude', 'coalhearth', 'session_handoff.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!j || j.status !== 'in_progress') return none;
    let mtimeMs = null;
    try { mtimeMs = fs.statSync(p).mtimeMs; } catch { /* unreadable stat = uncertain -> caller protects */ }
    return {
      inProgress: true,
      mtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : null,
      sessionId: typeof j.sessionId === 'string' && j.sessionId ? j.sessionId : null,
    };
  } catch { return none; }
}

// ---------------------------------------------------------------------------
// session listing + band classification
// ---------------------------------------------------------------------------

function statFileOrNull(p, claudeRoots) {
  const phys = physicalOrNull(p);
  if (!phys || !containedIn(phys, claudeRoots)) return null; // fail-closed, same as estate.mjs
  try {
    const st = fs.statSync(phys);
    return st.isFile() ? { path: phys, bytes: st.size, mtimeMs: st.mtimeMs } : null;
  } catch { return null; }
}

function walkFiles(dir, baseDir, claudeRoots, out) {
  if (out.length >= SESSION_FILE_CAP) return;
  let names;
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const d of names) {
    if (out.length >= SESSION_FILE_CAP) return;
    const p = path.join(dir, d.name);
    if (d.isDirectory()) { walkFiles(p, baseDir, claudeRoots, out); continue; }
    if (!d.isFile()) continue; // symlink Dirent reports its own type — never traversed
    const f = statFileOrNull(p, claudeRoots);
    if (f) out.push({ ...f, rel: path.relative(baseDir, f.path) });
  }
}

// Group THIS project's CC estate into SESSION UNITS: a flat `<sid>.jsonl`
// defines the session; the unit = that file + any flat `<sid>.*` sibling
// (e.g. a meta.json) + everything under the `<sid>/` overflow dir. A dir with
// no sibling .jsonl (an orphaned subagents/ leftover, GH #59248) is NOT a
// session unit and is never touched here — P1's orphan report covers it.
export function listSessions({ projectRoot = process.cwd(), home = os.homedir() } = {}) {
  const base = claudeBaseDir(home);
  const claudeRoot = physicalOrNull(base);
  if (!claudeRoot) return { slug: null, projDir: null, sessions: [] };
  const claudeRoots = [claudeRoot];
  const slug = ccProjectSlug(projectRoot);
  const projDir = path.join(base, 'projects', slug);
  let names;
  try { names = fs.readdirSync(projDir, { withFileTypes: true }); } catch { return { slug, projDir, sessions: [] }; }

  const flatFiles = names.filter((d) => d.isFile());
  const dirs = new Set(names.filter((d) => d.isDirectory()).map((d) => d.name));
  // Session ids = flat *.jsonl basenames. Assign every flat file to at most
  // ONE session — the LONGEST sid whose `<sid>.` prefixes it (a sid that is a
  // dot-prefix of another sid must not double-claim the longer one's files;
  // real CC ids are UUIDs, this is the defensive shape).
  const sids = flatFiles.filter((d) => d.name.endsWith('.jsonl')).map((d) => d.name.slice(0, -'.jsonl'.length))
    .sort((a, b) => b.length - a.length);
  const filesBySid = new Map(sids.map((id) => [id, []]));
  for (const d of flatFiles) {
    const owner = sids.find((id) => d.name.startsWith(`${id}.`)); // longest-first order
    if (!owner) continue;
    const f = statFileOrNull(path.join(projDir, d.name), claudeRoots);
    if (f) filesBySid.get(owner).push({ ...f, rel: d.name });
  }
  const sessions = [];
  for (const id of sids) {
    const files = filesBySid.get(id);
    if (dirs.has(id)) walkFiles(path.join(projDir, id), projDir, claudeRoots, files);
    if (!files.length) continue;
    sessions.push({
      id,
      files,
      bytes: files.reduce((s, f) => s + f.bytes, 0),
      newestMtimeMs: Math.max(...files.map((f) => f.mtimeMs)),
    });
  }
  return { slug, projDir, sessions };
}

// ACTIVE / WARM / COLD per the band law in the header. Uncertainty fails
// toward ACTIVE (skip) — never compress on doubt.
export function classifySessions({ projectRoot = process.cwd(), home = os.homedir(), now = Date.now(), estate, currentSessionId = null } = {}) {
  const cfg = resolveEstateCfg(estate);
  const listed = listSessions({ projectRoot, home });
  const compressMs = cfg.compressAfterDays * DAY_MS;
  const purgeMs = cfg.purgeAfterDays * DAY_MS;
  // CH binding without an id: session_handoff.json is ONE file per project,
  // rewritten by the CURRENT session's every tool call — so a FRESH
  // in-progress journal was written by the most recently ACTIVE session = the
  // unit(s) carrying the newest transcript mtime. Protect those (fail toward
  // protecting; mtime ties protect every tied unit). A journal older than the
  // compress window makes no live claim and blocks nothing (a crashed
  // months-old handoff must not freeze estate archiving forever); a journal
  // whose own mtime cannot be read counts as fresh (uncertain = protect).
  // NOT protect-everything: the whole-project block would make ULTRA a
  // permanent no-op on any CH-installed project (the current session is
  // always writing a fresh journal while the run happens).
  const ch = chJournalGuard(projectRoot);
  const chFresh = ch.inProgress && (ch.mtimeMs === null || now - ch.mtimeMs < compressMs);
  const newestMtimeMs = listed.sessions.length ? Math.max(...listed.sessions.map((s) => s.newestMtimeMs)) : -Infinity;
  for (const s of listed.sessions) {
    const age = now - s.newestMtimeMs;
    const chProtected = (ch.sessionId !== null && s.id === ch.sessionId)
      || (chFresh && s.newestMtimeMs === newestMtimeMs);
    if (s.id === currentSessionId || chProtected || !Number.isFinite(age) || age < compressMs) s.band = 'active';
    else if (cfg.purgeAfterDays !== 0 && age >= purgeMs) s.band = 'cold';
    else s.band = 'warm';
  }
  return { ...listed, cfg };
}

// ---------------------------------------------------------------------------
// the dig-index (goal 1: help agents deliberately dig old history)
// ---------------------------------------------------------------------------

// Plain text of a transcript line's message content, or null. Handles the two
// trivially-extractable CC shapes (string content · array of text parts);
// anything else is skipped, never guessed.
function messageText(obj) {
  const c = obj && obj.message && obj.message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    const parts = c.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text);
    return parts.length ? parts.join(' ') : null;
  }
  return null;
}

// ponytail: naive proper-noun-ish heuristic — uppercase-start tokens >=4
// chars minus a small stopword set; deterministic (freq desc, then lexical).
// Upgrade path if dig-search recall falls short: real tokenization per locale.
const ENTITY_STOPWORDS = new Set([
  'This', 'That', 'These', 'Those', 'Then', 'There', 'They', 'Them', 'Their',
  'When', 'What', 'Where', 'Which', 'While', 'With', 'Will', 'Would', 'Could',
  'Should', 'Shall', 'Have', 'Here', 'From', 'Your', 'Yours', 'Also', 'After',
  'Before', 'Into', 'About', 'Only', 'Never', 'Always', 'Please', 'Once',
  'Over', 'Just', 'Like', 'Make', 'Want', 'Need', 'Does', 'Were', 'Been',
  'Both', 'Each', 'Every', 'More', 'Most', 'Much', 'Many', 'Some', 'Such',
  'Than', 'Very', 'Used', 'Using', 'Same', 'Other', 'Another', 'Next', 'Last',
  'First', 'Second', 'Note', 'Notes', 'Okay', 'Thanks', 'Thank', 'Sure',
  'Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Task', 'Agent', 'TodoWrite',
]);
const ENTITY_RE = /\b[A-Z][A-Za-z0-9_-]{3,}\b/g;

function countEntities(text, freq) {
  for (const m of text.matchAll(ENTITY_RE)) {
    const tok = m[0];
    if (ENTITY_STOPWORDS.has(tok)) continue;
    freq.set(tok, (freq.get(tok) || 0) + 1);
  }
}

// One index.jsonl row per archived session, computed from the transcript
// buffer ALREADY in memory for the gzip (no second read). Every field is
// code-derived — deterministic extraction, never a model summary.
// NOTE: firstUserLine + topEntities are REAL memory-of-the-conversation
// fragments — the index is a LOCAL dig aid under CoalWash's own namespace and
// is never folded into any pushed report (receipt.mjs's metrics-only law).
export function buildIndexRow({ sessionId, projectSlug, transcriptBuf, totalBytes, now = Date.now(), cold = false }) {
  let msgCount = 0;
  let startISO = null;
  let endISO = null;
  let firstUserLine = null;
  const freq = new Map();
  if (transcriptBuf && transcriptBuf.length) {
    for (const line of transcriptBuf.toString('utf8').split('\n')) {
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; } // partial/foreign line — skip, never guess
      if (obj && typeof obj.timestamp === 'string') {
        if (!startISO) startISO = obj.timestamp;
        endISO = obj.timestamp;
      }
      const t = obj && obj.type;
      if (t !== 'user' && t !== 'assistant') continue;
      msgCount++;
      const txt = messageText(obj);
      if (!txt) continue;
      if (firstUserLine === null && t === 'user' && txt.trim()) firstUserLine = txt.trim().slice(0, FIRST_USER_LINE_MAX);
      countEntities(txt, freq);
    }
  }
  const topEntities = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, TOP_ENTITIES_MAX)
    .map(([tok]) => tok);
  const row = { sessionId, projectSlug, startISO, endISO, bytes: totalBytes, msgCount, firstUserLine, topEntities, archivedAt: new Date(now).toISOString() };
  if (cold) row.cold = true;
  return row;
}

// Exported for retier.mjs (RE-TIER's demoted-topic dig rows ride the SAME
// index file + the same append — one implementation, one dig door).
export function appendIndexRow(archiveDir, row) {
  try {
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.appendFileSync(path.join(archiveDir, ESTATE_INDEX_NAME), JSON.stringify(row) + '\n', 'utf8');
    return true;
  } catch { return false; }
}

function appendDeathCert(archiveDir, slug, line) {
  try {
    const dir = path.join(archiveDir, slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, DEATH_LOG_NAME), line + '\n', 'utf8');
  } catch { /* the certificate is a record, not a gate (bins.mjs's own rule) */ }
}

// ---------------------------------------------------------------------------
// copy-verify-then-delete — the per-session archive protocol
// ---------------------------------------------------------------------------

// Archive ONE session. Protocol (order is the safety property):
//   1. per file: read -> gzip -> write `<archiveDir>/<slug>/<rel>.gz` ->
//      read the .gz back -> gunzip -> byte-compare vs the original buffer.
//      ANY mismatch/error => remove this session's partial archive, keep
//      every original, return { ok:false } — never delete on a failed verify.
//   2. external-writer guard: re-stat every original; a size/mtime change
//      since listing (a live writer we mis-banded) aborts the same way.
//   3. only now delete originals (verify each gone; an unverifiable delete is
//      reported, never claimed — the bins asymmetry) + drop the emptied dir.
// The index row is built from the transcript buffer and returned; the CALLER
// appends it AFTER this returns ok (row-follows-bytes, so a crash between
// delete and append can only under-index — estate-restore scans the archive
// dir itself, not the index, so recovery never depends on the row).
// opts.gzip is injectable for tests (default zlib.gzipSync).
export function archiveSession(sess, { slug, archiveDir, now = Date.now(), cold = false, gzip = zlib.gzipSync } = {}) {
  const destBase = path.join(archiveDir, slug);
  // Write-side containment (loss class #57's git sibling, GHSA-2hvf-7c8p-28fx:
  // the SOURCE enumeration is realpath-contained, but the DESTINATION
  // derivation was not). Resolve the archive ROOT physically ONCE (creating it
  // if absent — the root itself is resolved config, named on the bill before
  // consent); every derived dest below must land INSIDE it or the session is
  // refused BEFORE any mkdir/write. Fail-closed: skip + report, never write
  // outside — a `..`-carrying rel and a symlinked archive subdir both surface
  // at their real location via physicalForCreate.
  let rootPhys = null;
  try { fs.mkdirSync(archiveDir, { recursive: true }); rootPhys = physicalOrNull(archiveDir); } catch { /* rootPhys stays null */ }
  if (!rootPhys) return { ok: false, reason: 'archive root unresolvable — session skipped (fail-closed)' };
  const written = [];
  const cleanupPartial = () => { for (const w of written) { try { fs.rmSync(w, { force: true }); } catch {} } };
  let transcriptBuf = null;
  const originals = [];

  for (const f of sess.files) {
    let buf;
    try {
      buf = fs.readFileSync(f.path);
    } catch (e) { cleanupPartial(); return { ok: false, reason: `read failed: ${f.rel}: ${e.message}` }; }
    if (f.rel === `${sess.id}.jsonl`) transcriptBuf = buf;
    const dest = path.join(destBase, `${f.rel}.gz`);
    if (!containedIn(physicalForCreate(dest), [rootPhys])) {
      cleanupPartial();
      return { ok: false, reason: `archive destination escapes the archive root: ${f.rel} — session skipped (fail-closed), originals kept` };
    }
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, gzip(buf));
      written.push(dest);
      const back = zlib.gunzipSync(fs.readFileSync(dest));
      if (!back.equals(buf)) { cleanupPartial(); return { ok: false, reason: `verify mismatch: ${f.rel} — original kept` }; }
    } catch (e) { cleanupPartial(); return { ok: false, reason: `archive failed: ${f.rel}: ${e.message} — original kept` }; }
    originals.push({ path: f.path, rel: f.rel });
  }

  // External-writer guard over the WHOLE listing->delete window (applyPlan's
  // expectedOrig shape): the baseline is the LISTING's own recorded size +
  // mtime — a writer landing any time after the band was computed (a live
  // session mis-banded, a cloud-sync clobber) aborts the session untouched.
  // (#6 considered + SKIPPED: a content Buffer.equals would only add coverage
  // for a content-only, same-size+same-mtime change in the SYNCHRONOUS window
  // between the gzip-read and the delete — no yield point, so unreachable by any
  // real co-writer; the wide listing->delete window is already stat-bracketed
  // here. Not analogous to applyPlan, which compares against the SCAN-time
  // expectedOrig across a wide user-wait window.)
  for (const f of sess.files) {
    let st;
    try { st = fs.statSync(f.path); } catch { st = null; }
    if (!st || st.size !== f.bytes || st.mtimeMs !== f.mtimeMs) {
      cleanupPartial();
      return { ok: false, reason: `changed during run: ${f.rel} — session skipped, originals kept` };
    }
  }

  // Deletes LAST. Every byte is now verified recoverable from the archive.
  let deleted = 0;
  const deleteFailed = [];
  for (const o of originals) {
    try { fs.rmSync(o.path, { force: true }); } catch {}
    if (fs.existsSync(o.path)) deleteFailed.push(o.rel); else deleted++;
  }
  // Drop the <sid>/ overflow container — delete_scope == verified_set (loss
  // class #56). Only now-EMPTY directories are swept (bottom-up); any FILE still
  // under <sid>/ was NEVER enumerated/verified (the walk hit SESSION_FILE_CAP,
  // it appeared after the listing, or it is a skipped symlink) and is LEFT
  // intact + surfaced in `unpruned`. Fail toward keeping unknown bytes — never
  // the whole-tree rm -rf this used to do.
  const unpruned = [];
  if (!deleteFailed.length && originals.length) {
    const projDir = path.dirname(originals[0].path);
    pruneEmptyDirs(path.join(projDir, sess.id), projDir, unpruned);
  }

  const row = buildIndexRow({ sessionId: sess.id, projectSlug: slug, transcriptBuf, totalBytes: sess.bytes, now, cold });
  if (cold) {
    const ageDays = Math.round((now - sess.newestMtimeMs) / DAY_MS);
    appendDeathCert(archiveDir, slug, `${new Date(now).toISOString()} destroyed-cold ${sess.id} (age ${ageDays}d, ${sess.files.length} file(s), ${sess.bytes} bytes — archived+verified first)`);
  }
  return { ok: true, deleted, deleteFailed, unpruned, files: originals.length, bytes: sess.bytes, row };
}

// Remove now-EMPTY directories bottom-up; push the rel path (from `base`) of any
// surviving FILE into `survivors`. rmdirSync (non-recursive) REFUSES a non-empty
// dir, so a file — enumerated or not — is never destroyed here; only empty
// scaffolding is swept. This is the loss-class-#56 guard on the <sid>/ container:
// delete_scope == verified_set (a file we did not archive must not die under a
// recursive rm just because it shared the container). A symlink Dirent reports
// its own type (isFile/isDirectory both false) -> it is treated as a survivor,
// never followed and never deleted.
function pruneEmptyDirs(dir, base, survivors) {
  let names;
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; } // absent (no overflow dir) or unreadable
  for (const d of names) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) pruneEmptyDirs(p, base, survivors);
    else survivors.push(path.relative(base, p)); // a FILE (or symlink/special) we did not enumerate — keep + surface
  }
  try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch { /* still non-empty or already gone */ }
}

// ---------------------------------------------------------------------------
// the ULTRA run (wizard-consented ONLY — see the run-gate note in the header)
// ---------------------------------------------------------------------------

// Non-mutating pre-consent scan for the wizard bill.
export function estateUltraScan({ projectRoot = process.cwd(), home = os.homedir(), now = Date.now(), estate, currentSessionId = null } = {}) {
  const c = classifySessions({ projectRoot, home, now, estate, currentSessionId });
  const by = { active: [], warm: [], cold: [] };
  for (const s of c.sessions) by[s.band].push(s);
  const sum = (arr) => arr.reduce((n, s) => n + s.bytes, 0);
  return {
    slug: c.slug,
    archiveDir: resolveArchiveDir(estate, home),
    cfg: c.cfg,
    sessions: c.sessions.length,
    active: by.active.length,
    warm: by.warm.length,
    cold: by.cold.length,
    warmBytes: sum(by.warm),
    coldBytes: sum(by.cold),
    totalBytes: sum(c.sessions),
    estAfterBytes: Math.round(sum(by.warm) / EST_COMPRESS_RATIO),
  };
}

function mb(n) { return `${((Number(n) || 0) / 1024 ** 2).toFixed(1)} MB`; }

// The ULTRA bill line — program-built (ask.mjs discipline: code builds it,
// the agent prints it VERBATIM). Shown only AFTER the wizard choice (the
// neutral entry stays numberless — a SKILL rail, enforced by sequence).
export function ultraBillLine(scan) {
  const s = scan || {};
  const coldNote = s.cold
    ? ` · ${s.cold} cold session(s) (${mb(s.coldBytes)}) ${s.cfg && s.cfg.deleteCold ? 'archive-then-delete (deleteCold on)' : "report-only — first-party 'claude project purge' is the delete lever"}`
    : '';
  return `[CoalWash] ULTRA estate: ${s.sessions || 0} session(s) — ${s.warm || 0} warm to compress (${mb(s.warmBytes)} now → ~${mb(s.estAfterBytes)} after, ~est ${EST_COMPRESS_RATIO}:1) · ${s.active || 0} active skipped${coldNote} · archive: ${s.archiveDir || '?'}`;
}

// Execute ULTRA: WARM sessions compressed (copy-verify-then-delete), COLD
// listed (or archived-then-deleted under an explicit deleteCold), index rows
// appended per archived session. Takes the GLOBAL CoalWash lock (the archive
// index is a cross-project shared file); lock held elsewhere -> deferred,
// nothing touched (`deferred: true`, applyPlan's own contract).
export function runEstate({ projectRoot = process.cwd(), home = os.homedir(), now = Date.now(), estate, currentSessionId = null, gzip = zlib.gzipSync } = {}) {
  const lock = acquireLock(globalLockPath(home), { sessionId: currentSessionId || String(process.pid), now });
  if (!lock.acquired) return { ok: false, deferred: true, error: lock.reason };
  try {
    const c = classifySessions({ projectRoot, home, now, estate, currentSessionId });
    const archiveDir = resolveArchiveDir(estate, home);
    const res = {
      ok: true, slug: c.slug, archiveDir, cfg: c.cfg,
      archived: [], failed: [], coldListed: [], activeSkipped: 0,
      bytesFreed: 0, indexRows: 0,
    };
    for (const sess of c.sessions) {
      if (sess.band === 'active') { res.activeSkipped++; continue; }
      if (sess.band === 'cold' && !c.cfg.deleteCold) {
        res.coldListed.push({ id: sess.id, bytes: sess.bytes, ageDays: Math.round((now - sess.newestMtimeMs) / DAY_MS) });
        continue;
      }
      const cold = sess.band === 'cold';
      const r = archiveSession(sess, { slug: c.slug, archiveDir, now, cold, gzip });
      if (!r.ok) { res.failed.push({ id: sess.id, reason: r.reason }); continue; }
      if (c.cfg.indexEnabled && !appendIndexRow(archiveDir, r.row)) res.failed.push({ id: sess.id, reason: 'index append failed (bytes archived + originals deleted — restore unaffected)' });
      else if (c.cfg.indexEnabled) res.indexRows++;
      res.archived.push({ id: sess.id, bytes: r.bytes, files: r.files, cold, deleteFailed: r.deleteFailed, unpruned: r.unpruned });
      res.bytesFreed += r.bytes;
    }
    return res;
  } finally { lock.release(); }
}

// Plain-text run report (program-built; the receipt-style deliverable).
export function runEstateReport(res) {
  if (!res || res.deferred) return `[CoalWash] ULTRA estate deferred: ${res && res.error ? res.error : 'lock held'}`;
  const lines = [];
  lines.push(`[CoalWash] ULTRA estate — ${res.archived.length} session(s) archived (${mb(res.bytesFreed)} freed from the live tree), ${res.activeSkipped} active skipped`);
  lines.push(`  archive: ${res.archiveDir} (${res.indexRows} index row(s) appended · restore: cli.mjs estate-restore <sessionId>)`);
  for (const f of res.failed) lines.push(`  KEPT ${f.id}: ${f.reason}`);
  // #56: a session whose <sid>/ still held un-enumerated files was archived +
  // its container LEFT in place (never rm -rf'd) — surface the survivors.
  for (const a of res.archived) {
    if (a.unpruned && a.unpruned.length) lines.push(`  KEPT-IN-PLACE ${a.id}: ${a.unpruned.length} un-enumerated file(s) under <sid>/ left intact (not archived — appeared post-listing / walk-capped): ${a.unpruned.slice(0, 5).join(', ')}${a.unpruned.length > 5 ? ', …' : ''}`);
  }
  if (res.coldListed.length) {
    const coldBytes = res.coldListed.reduce((n, s) => n + s.bytes, 0);
    lines.push(`  cold (older than ${res.cfg.purgeAfterDays}d, NOT touched): ${res.coldListed.length} session(s), ${mb(coldBytes)} — the first-party delete lever is \`claude project purge\`; or set estate.deleteCold true for archive-then-delete`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// estate-search + estate-restore (the dig doors)
// ---------------------------------------------------------------------------

// Case-insensitive substring match over sessionId / projectSlug /
// firstUserLine / topEntities. Reads the index only — never a transcript.
export function searchIndex(query, { archiveDir } = {}) {
  const q = String(query || '').toLowerCase();
  if (!q) return [];
  let text;
  try { text = fs.readFileSync(path.join(archiveDir, ESTATE_INDEX_NAME), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const hay = [row.sessionId, row.projectSlug, row.firstUserLine, ...(Array.isArray(row.topEntities) ? row.topEntities : [])]
      .filter((v) => typeof v === 'string').join(' ').toLowerCase();
    if (hay.includes(q)) out.push(row);
  }
  return out;
}

export function searchLines(rows) {
  if (!rows.length) return '[CoalWash] estate-search: no match in the archive index.';
  return rows.map((r) =>
    `${r.sessionId}  ${r.projectSlug || '?'}  ${r.startISO || '?'}..${r.endISO || '?'}  ${mb(r.bytes)}  ${r.msgCount ?? '?'} msg${r.cold ? '  [cold-deleted]' : ''}\n    ${String(r.firstUserLine || '').slice(0, 160) || '(no first user line)'}`,
  ).join('\n');
}

// Bare-name allowlist — bins.mjs's F1 rule verbatim: a session id is a flat
// program-generated name; any traversal shape is a clean not-found.
function isBareId(id) {
  return typeof id === 'string' && !!id && id !== '.' && id !== '..' && path.basename(id) === id;
}

// Decompress ONE archived session's files to `to` (default: a fresh scratch
// dir under os.tmpdir(), printed to the caller) — RESTORE-BY-REFERENCE: code
// moves the byte-exact bytes; content is never re-authored. NEVER writes into
// CC's live tree unless an explicit --to points there (the default tmpdir
// guarantees it). Scans the archive dir itself (not the index), so a session
// archived without an index row still restores.
export function restoreSession(sessionId, { archiveDir, to = null } = {}) {
  if (!isBareId(sessionId)) return { ok: false, error: `not a bare session id: '${sessionId}'` };
  let slugs;
  try { slugs = fs.readdirSync(archiveDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch {
    return { ok: false, error: `archive dir not readable: ${archiveDir}` };
  }
  const sources = []; // { gzPath, rel } — rel is the ORIGINAL rel (`.gz` stripped)
  for (const slug of slugs) {
    const slugDir = path.join(archiveDir, slug);
    let names;
    try { names = fs.readdirSync(slugDir, { withFileTypes: true }); } catch { continue; }
    for (const d of names) {
      if (d.isFile() && (d.name === `${sessionId}.jsonl.gz` || (d.name.startsWith(`${sessionId}.`) && d.name.endsWith('.gz')))) {
        sources.push({ gzPath: path.join(slugDir, d.name), rel: d.name.slice(0, -3) });
      } else if (d.isDirectory() && d.name === sessionId) {
        const collect = (dir, relBase) => {
          let subs;
          try { subs = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const s of subs) {
            const p = path.join(dir, s.name);
            if (s.isDirectory()) collect(p, path.join(relBase, s.name));
            else if (s.isFile() && s.name.endsWith('.gz')) sources.push({ gzPath: p, rel: path.join(relBase, s.name.slice(0, -3)) });
          }
        };
        collect(path.join(slugDir, d.name), sessionId);
      }
    }
    if (sources.length) break; // a session id is unique — first slug that has it wins
  }
  if (!sources.length) return { ok: false, error: `session '${sessionId}' not found in the archive at ${archiveDir}` };

  let dir = to;
  try {
    if (dir) { dir = path.resolve(dir); fs.mkdirSync(dir, { recursive: true }); }
    else dir = fs.mkdtempSync(path.join(os.tmpdir(), `coalwash-estate-${sessionId.slice(0, 8)}-`));
  } catch (e) { return { ok: false, error: `cannot create restore target: ${e.message}` }; }

  const files = [];
  for (const s of sources) {
    try {
      const buf = zlib.gunzipSync(fs.readFileSync(s.gzPath));
      const dest = path.join(dir, s.rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      files.push({ rel: s.rel, bytes: buf.length });
    } catch (e) { return { ok: false, error: `restore failed on ${s.rel}: ${e.message}`, dir, files }; }
  }
  return { ok: true, dir, files };
}
