// ponytail: 821 lines at declaration — already the mutation half of a deliberate split (estate.mjs stays pure-read BECAUSE every mutating estate op is corralled here); archive/index/search/restore share one on-disk layout whose writer and readers must move together for byte-exact restore.
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
//     deletes them, appending a death-certificate line (tailings.mjs's pattern).
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
import crypto from 'node:crypto';
import { claudeBaseDir, repoReadOutcome, MAX_DOC_BYTES } from './config-load.mjs';
import { appendOwnLog } from './repo-fs.mjs';
import { ccProjectSlug, physicalOrNull, containedIn, physicalForCreate, detectPlatform, UNKNOWN_PLATFORM_FLAG, isCloudPlaceholder, heldPath } from './class-b.mjs';
import { acquireLock, globalLockPath, writeDurable, fsyncDirBestEffort, lockLostHead, lockLeftNote, withLockLeft, LOCK_STALE_MS } from './apply.mjs';
import { ownSandboxDir, fileModeOr600 } from './repo-fs.mjs';
import { buildPrefixIndex, hasNeedle, PREFIX_K, INDEX_MIN_NEEDLES } from './text-index.mjs';
// #58 tombstone registry: keeps.json anchors (the adjudicated spans) + the bin
// death-log (destroyed cuts). Function-declaration imports used only at CALL
// time (collectTombstones), so the existing apply<->retier<->estate cycle stays
// safe. Advisory-only — this NEVER blocks a dig/restore.
import { loadKeeps, loadGlobalKeeps } from './keeps.mjs';
import { readDeathLog, FAT_BIN_NAME, STORE_OLD_NAME } from './tailings.mjs';
import { escapeRawControls } from './receipt.mjs'; // 29n F470-a: the room's printed-line escape, Cc/Cf/Zl/Zp, for every keep- or index-derived field

export const ESTATE_ARCHIVE_DIRNAME = 'estate-archive';
export const ESTATE_INDEX_NAME = 'index.jsonl';
const DEATH_LOG_NAME = 'death.log'; // one-flock with tailings.mjs's certificate log
// 29gt fire 750 (main's ruling: no replace may drop a byte the user once had). A re-archive replaces `<rel>.gz` only when the old
// copy's bytes are an exact prefix of the new source; otherwise the old copy is kept beside it as `<rel>.gz.gen<N>`, one N per
// re-archive of the session. The name ends in `.gen<N>`, not `.gz`, so an install older than this layout never collects it as a
// current copy (its restore matches `*.gz` only) and never writes over it (it writes `<rel>.gz` only).
const GEN_RE = /\.gz\.gen([1-9][0-9]{0,5})$/;
// 29gx fire 756. The generation bound's default and its schema maximum (config-schema.mjs estate.maxGenerations); a refusal past it is
// recorded, one JSON line each, in this file in the archive root, for /coalwash:stats. No restore, search or run reads it as an archive.
const DEFAULT_MAX_GENERATIONS = 10;
const MAX_GENERATIONS_CAP = 1000;
const GENERATION_REFUSALS_NAME = 'generation-refusals.jsonl';
// A staged copy is written beside its final name as `<final>.<24 hex>.coalwash-new` (STAGE_SUFFIX), verified, then renamed over it.
// A killed run can leave one, or writeDurable's own `<final>.<24 hex>.coalwash-tmp`; STAGED_RE names both, for an archive copy or a
// generation, and the collector removes only files that match it.
const STAGE_SUFFIX = 'coalwash-new';
const STAGED_RE = /\.gz(\.gen[1-9][0-9]{0,5})?\.[0-9a-f]{24}\.coalwash-(new|tmp)$/;
// Index rows carry rowSchema 2 from this layout on; a row without it is an older row and reads as before. A re-archive that kept
// a generation writes `replacedGeneration: N` on its new row, so search can name the row before it as generation N.
export const ESTATE_ROW_SCHEMA = 2;
// 29he fire 772 (CodeRabbit t335 F4): a row also carries the sha256 of the transcript's archive copy it describes
// (`transcriptGzSha256`), and a re-archive that replaced a copy names the replaced copy's sha256 (`replacedTranscriptGzSha256`)
// beside `replacedGeneration`. Search labels an earlier row as a generation only when those two match, never by its position.
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
// The suffix a refused commit gives a kept generation whose bytes it can no longer vouch for (fire 772, lab F-2). It is not `.gz`,
// not `.gz.gen<N>` and not a staged name, so no restore, generation count or collector ever takes it for an archive copy or removes it.
const ASIDE_SUFFIX = 'coalwash-aside';
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
  // runBudget: the per-run work-limit on the ULTRA session loop (the UNBOUNDED
  // axis — CC accretes hundreds of old sessions). clampedRead already bounds
  // these; this re-derives defensively (a raw estate handed straight in) with
  // the same defaults, floor >= 1 (a zero/negative would defer everything).
  const rb = e.runBudget && typeof e.runBudget === 'object' ? e.runBudget : {};
  const maxSessionsPerRun = Number.isFinite(rb.maxSessionsPerRun) && rb.maxSessionsPerRun >= 1 ? Math.floor(rb.maxSessionsPerRun) : 25;
  const maxBytesPerRun = Number.isFinite(rb.maxBytesPerRun) && rb.maxBytesPerRun >= 1 ? Math.floor(rb.maxBytesPerRun) : 524288000;
  return {
    compressAfterDays,
    purgeAfterDays,
    deleteCold: e.deleteCold === true,
    archiveDir: typeof e.archiveDir === 'string' ? e.archiveDir : '',
    indexEnabled: e.indexEnabled !== false,
    // 29gx fire 756: the generation bound; a value outside the schema's integer 0-1000 reads as the default 10, as clampedRead does.
    maxGenerations: Number.isInteger(e.maxGenerations) && e.maxGenerations >= 0 && e.maxGenerations <= MAX_GENERATIONS_CAP ? e.maxGenerations : DEFAULT_MAX_GENERATIONS,
    runBudget: { maxSessionsPerRun, maxBytesPerRun },
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
  if (cfg.archiveDir && path.isAbsolute(cfg.archiveDir)) {
    // grad9 R8-F7: was a bare path.resolve() -- lexical only, never follows
    // a symlink. The ULTRA consent bill shows THIS value before the human
    // presses "run"; archiveSession's own write-containment below resolves
    // the same string PHYSICALLY (fs.realpathSync-based). A symlinked
    // archiveDir (or a symlinked ancestor of it) let the two diverge -- the
    // human approves one location, the engine's later checks reason about
    // another. `physicalForCreate` (already imported, used a few lines below
    // for the per-file destination check) resolves the deepest EXISTING
    // ancestor and reattaches the not-yet-created tail, so the bill and the
    // eventual write target are the SAME real path -- "check one spelling,
    // act on that same spelling", the room's own recurring rule. `null` (no
    // existing ancestor at all -- an unresolvable root) fails CLOSED to the
    // safe OS-citizen default rather than trusting a raw string.
    const real = physicalForCreate(cfg.archiveDir);
    if (real) return real;
  }
  return path.join(claudeBaseDir(home), 'coal', 'coalwash', ESTATE_ARCHIVE_DIRNAME);
}

// board #55 AMENDMENT, ladder rung 6 — the ONLY thing persisted across runs for the estate
// horizon ladder is whether cleanupPeriodDays RESOLVED last time, machine-wide (not
// per-project — the key's own resolution has nothing to do with which project is asking).
// Never the horizon itself (a cached horizon is the exact staleness defect the amendment
// bans). Lives here, not in estate.mjs, because this file — not estate.mjs — is the one
// chartered for mutation (this module's own header); estate.mjs's ladder function stays a
// pure read that takes/returns this state as plain parameters, never touching disk itself.
// Global (OS-citizen namespace, ~/.claude/coal/coalwash/) — fail-silent both ways: a missing
// or corrupt marker degrades to "no prior state" (transition detection simply does not fire
// this run), never a thrown error over a one-boolean side-channel.
function estateKeyResolvedStatePath(home = os.homedir()) {
  return path.join(claudeBaseDir(home), 'coal', 'coalwash', 'estate-cleanup-key.json');
}
export function readEstateKeyResolvedState(home = os.homedir()) {
  try {
    const raw = JSON.parse(fs.readFileSync(estateKeyResolvedStatePath(home), 'utf8'));
    return typeof raw.resolved === 'boolean' ? raw.resolved : null;
  } catch { return null; }
}
export function writeEstateKeyResolvedState(resolved, home = os.homedir()) {
  // Direct write, no tmp-then-atomic-move — this file's own EXDEV discipline
  // (#57, the archive destination may sit on a different drive by design)
  // bans that rename call ANYWHERE in this module, enforced by
  // apply.test.mjs's own literal-string scan. A torn write, and the reader's
  // own fail-silent catch on a corrupt read, both degrade to `null` (no
  // history) rather than a wrong boolean. INSPECT F3 (2026-08-06): stated
  // by DIRECTION, not just "costs nothing" — `null` means rung 4 (the
  // small-constant fallback) never fires, so the horizon falls back to
  // rung 2's larger documented-default-derived value instead of the
  // smaller rung-4 constant. That is the SAFE side of the amendment's own
  // asymmetry (never smaller than the honest read would have chosen — see
  // resolveEstateHorizon's own worked proof that the floor path can never
  // beat rung 4's constant), so this needs two coincident, rare events
  // (a transition AND a torn/corrupt read on the very next run) and
  // self-heals the run after — never worth the atomicity a tmp+rename
  // would buy back at the cost of reintroducing a same-device assumption
  // into a file whose whole point is not needing one.
  try {
    const p = estateKeyResolvedStatePath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ resolved }), 'utf8');
  } catch { /* fail-silent — informational side-channel, never blocks a report */ }
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
// Absent = no guard (no CoalHearth installed); a journal that exists but cannot be read or parsed counts as in progress (917);
// classifySessions applies the banding policy on these signals.
export function chJournalGuard(projectRoot) {
  const none = { inProgress: false, mtimeMs: null, sessionId: null };
  try {
    const p = path.join(projectRoot, '.claude', 'coalhearth', 'session_handoff.json');
    // CWK-137: the journal lives inside the project, so a cloned repo can plant a link or a huge file at this name.
    // Read bounded + contained in the project. ABSENT is still "no session" (no CoalHearth installed); anything else
    // we refuse to read is UNCERTAIN -- the module's own rule for a journal it cannot judge: protect.
    const o = repoReadOutcome(p, projectRoot, MAX_DOC_BYTES);
    if (o.why === 'absent') return none;
    if (!o.buf) return { inProgress: true, mtimeMs: null, sessionId: null };
    // T76-1: the age comes from the handle the content was read through (repoReadOutcome's fstat), never a second stat of the name,
    // which a file renamed over it in between would answer with ITS mtime. A missing mtime reads as uncertain: the caller protects.
    const mtimeMs = o.mtimeMs;
    // 917 sweep: a journal that EXISTS but does not parse (a torn write, a hand edit, not a JSON object) is one this guard cannot
    // judge, so it counts as in progress, dated by its own mtime: fresh protects the newest unit, stale freezes nothing. It read
    // as "no session" before, and the archive (copy, then DELETE) could take a live transcript.
    let j;
    try { j = JSON.parse(o.buf.toString('utf8')); } catch { j = undefined; }
    if (!j || typeof j !== 'object' || Array.isArray(j)) return { inProgress: true, mtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : null, sessionId: null };
    if (j.status !== 'in_progress') return none;
    return {
      inProgress: true,
      mtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : null,
      sessionId: typeof j.sessionId === 'string' && j.sessionId ? j.sessionId : null,
    };
  } catch { return none; }
}

// board #55 (owner-ordered) — a room following the department-head-contract
// convention (TheColliery/.claude/DEPARTMENT-HEAD-CONTRACT.md) records live
// resident sessions in a project-root `.claude/agent-roster.md`; WARM
// archiving is copy-verify-then-DELETE, destructive to a resident's own
// transcript — the 2026-08-05 NO-HANDOFF LAW treats a warm transcript AS the
// seat's accumulated experience, so archiving one out from under a live seat
// is the exact damage this guard exists to prevent, regardless of age.
//
// Deliberately PROJECT-RELATIVE, never a hardcoded absolute path — the
// owner's dispatch named `TheColliery/.claude/agent-roster.md` as today's
// concrete instance, but CoalWash ships to arbitrary projects with no such
// convention at all. Reading `<projectRoot>/.claude/agent-roster.md`
// degrades correctly either way: a project that never adopted the
// convention has no such file, this guard is a silent no-op, and every
// existing WARM/COLD/ACTIVE behavior is unchanged.
//
// EVERY UUID-shaped token found ANYWHERE in the file's text counts as
// protected — not scoped to rows the file's own markdown marks "live" (a
// `~~coder~~ RETIRED` row still names its old sid in prose).
// ponytail: a markdown-aware live/retired classifier would be strictly more
// precise, but over-protecting a retired sid costs nothing (its transcript
// just isn't archived this run either) — the failure this guard exists to
// prevent is destroying a LIVE seat's experience, and a coarser regex that
// never under-protects closes that with far less surface to get wrong.
//
// "Fail toward SKIPPING if the roster is unreachable" (the owner's own
// words): a MISSING roster file is the NORMAL case (no convention adopted)
// and protects nothing — but a roster file that EXISTS and cannot be
// read/is empty is a genuine "cannot confirm any sid's status" state, and
// per this whole module's law ("uncertainty fails toward ACTIVE — never
// compress on doubt"), that state protects EVERY session this run, not
// zero. `unreachable: true` tells the caller exactly that.
export function readRosterSids(projectRoot) {
  const p = path.join(projectRoot, '.claude', 'agent-roster.md');
  // CWK-137: bounded + contained in the project (a link out, a special file, or an over-bound file is "present but
  // unreadable"). ABSENT is unchanged: no roster convention in this project, so nothing to protect.
  const o = repoReadOutcome(p, projectRoot, MAX_DOC_BYTES);
  if (o.why === 'absent') return { sids: new Set(), unreachable: false };
  if (!o.buf) return { sids: null, unreachable: true }; // present but unreadable -- protect everything
  const text = o.buf.toString('utf8');
  if (!text) return { sids: null, unreachable: true }; // present but empty -- same fail-closed treatment
  const sids = new Set();
  for (const m of text.matchAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi)) {
    sids.add(m[0].toLowerCase());
  }
  return { sids, unreachable: false };
}

// ---------------------------------------------------------------------------
// session listing + band classification
// ---------------------------------------------------------------------------

// 29pt fire 963, rows 9 and 10: a file is taken only when it resolves inside its HELD folder (`h`, hand-joined); the record carries `h` so
// archiveSession holds the same file to the same folder again before its delete.
function statFileOrNull(p, h) {
  const phys = inHeld(h, p) ? physicalOrNull(p) : null;
  if (!phys) return null; // fail-closed, same as estate.mjs
  try {
    const st = fs.statSync(phys);
    return st.isFile() ? { path: phys, bytes: st.size, mtimeMs: st.mtimeMs, held: h } : null;
  } catch { return null; }
}

// A recursive walk: `h` holds its TOP (<base>/projects/<slug>/<sid>/), and every entry, folder or file, is held to that top.
function walkFiles(dir, baseDir, h, out) {
  if (out.length >= SESSION_FILE_CAP) return;
  let names;
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const d of names) {
    if (out.length >= SESSION_FILE_CAP) return;
    const p = path.join(dir, d.name);
    if (d.isDirectory()) { if (inHeld(h, p)) walkFiles(p, baseDir, h, out); continue; }
    if (!d.isFile()) continue; // symlink Dirent reports its own type — never traversed
    const f = statFileOrNull(p, h);
    if (f) out.push({ ...f, rel: path.relative(baseDir, f.path) });
  }
}

// Group THIS project's CC estate into SESSION UNITS: a flat `<sid>.jsonl`
// defines the session; the unit = that file + any flat `<sid>.*` sibling
// (e.g. a meta.json) + everything under the `<sid>/` overflow dir. A dir with
// no sibling .jsonl (an orphaned subagents/ leftover, GH #59248) is NOT a
// session unit and is never touched here — P1's orphan report covers it.
// 29pt fire 963, rows 9 and 10 (main's c209): the slug folder is HELD to <base>/projects/<slug>, hand-joined from the resolved Claude base, so
// a slug folder that is a link (out of the base, or to another slug folder inside it) lists nothing. Each flat file is held to the slug
// folder, every file under <sid>/ to that session folder itself, and each file record carries its held folder so archiveSession holds it
// there again before its delete.
export function listSessions({ projectRoot = process.cwd(), home = os.homedir() } = {}) {
  const base = claudeBaseDir(home);
  const claudeRoot = physicalOrNull(base);
  if (!claudeRoot) return { slug: null, projDir: null, sessions: [] };
  const slug = ccProjectSlug(projectRoot);
  const projDir = path.join(base, 'projects', slug);
  const slugHeld = { root: claudeRoot, names: ['projects', slug] };
  if (!inHeld(slugHeld, projDir)) return { slug, projDir, sessions: [] }; // a slug folder that is not <base>/projects/<slug> itself is never listed
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
    const f = statFileOrNull(path.join(projDir, d.name), slugHeld);
    if (f) filesBySid.get(owner).push({ ...f, rel: d.name });
  }
  const sessions = [];
  for (const id of sids) {
    const files = filesBySid.get(id);
    const sidHeld = heldUnder(slugHeld, id);
    if (dirs.has(id) && inHeld(sidHeld, path.join(projDir, id))) walkFiles(path.join(projDir, id), projDir, sidHeld, files);
    if (!files.length) continue;
    sessions.push({
      id,
      held: slugHeld, // rows 9, 10 and 15: archiveSession holds every file to its own held folder, and the prune to <slug>/<sid>/
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
  const roster = readRosterSids(projectRoot);
  const newestMtimeMs = listed.sessions.length ? Math.max(...listed.sessions.map((s) => s.newestMtimeMs)) : -Infinity;
  for (const s of listed.sessions) {
    const age = now - s.newestMtimeMs;
    const chProtected = (ch.sessionId !== null && s.id === ch.sessionId)
      || (chFresh && s.newestMtimeMs === newestMtimeMs);
    const rosterProtected = roster.unreachable || roster.sids.has(s.id.toLowerCase());
    if (s.id === currentSessionId || chProtected || rosterProtected || !Number.isFinite(age) || age < compressMs) s.band = 'active';
    else if (cfg.purgeAfterDays !== 0 && age >= purgeMs) s.band = 'cold';
    else s.band = 'warm';
  }
  return { ...listed, cfg, roster: { unreachable: roster.unreachable, protectedCount: roster.sids ? roster.sids.size : 0 } };
}

// ---------------------------------------------------------------------------
// the dig-index (goal 1: help agents deliberately dig old history)
// ---------------------------------------------------------------------------

// The searchable ANSWER text of a transcript line's message content, or null.
// DIG-INDEX RECORD-WEIGHTING (item 6 — search quality, NOT treatment): the
// index is built from `text`/answer content-parts ONLY. A `thinking` (or
// `redacted_thinking`) part is transient reasoning = SEARCH NOISE, so it is
// DE-WEIGHTED TO ZERO here (never contributes to firstUserLine or topEntities).
// The decision reads each part's OWN `type` STAMP — never a guess by shape:
// only a part stamped `type:'text'` with a string `text` is kept, so a thinking
// part (which carries `thinking`, not `text`) is excluded both by the type
// filter AND by construction. A plain-string content is a final answer (kept).
// This split is INDEX/SEARCH ONLY — treatment stays whole-file byte-identity
// (§10); a record is never cut, only under-weighted in the searchable index.
export function messageText(obj) {
  const c = obj && obj.message && obj.message.content;
  if (typeof c === 'string') return c; // a plain-string message = final answer text
  if (Array.isArray(c)) {
    const parts = c.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text);
    return parts.length ? parts.join(' ') : null; // thinking parts fall out here — zero weight
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
  const row = { sessionId, projectSlug, startISO, endISO, bytes: totalBytes, msgCount, firstUserLine, topEntities, archivedAt: new Date(now).toISOString(), rowSchema: ESTATE_ROW_SCHEMA };
  if (cold) row.cold = true;
  return row;
}

// Exported for retier.mjs (RE-TIER's demoted-topic dig rows ride the SAME
// index file + the same append — one implementation, one dig door).
export function appendIndexRow(archiveDir, row) {
  try {
    fs.mkdirSync(archiveDir, { recursive: true });
    appendOwnLog(path.join(archiveDir, ESTATE_INDEX_NAME), JSON.stringify(row) + '\n'); // through a handle proved to be the index entry; a new index is owner-only
    return true;
  } catch { return false; }
}

function appendDeathCert(archiveDir, slug, line) {
  try {
    const dir = path.join(archiveDir, slug);
    fs.mkdirSync(dir, { recursive: true });
    appendOwnLog(path.join(dir, DEATH_LOG_NAME), line + '\n'); // the same proved append; a new record is owner-only
  } catch { /* the certificate is a record, not a gate (tailings.mjs's own rule) */ }
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
// dir itself, not the index, so recovery never depends on the row; the next
// run's reconcileIndex adds the missing row, fire 772).
// opts.gzip is injectable for tests (default zlib.gzipSync). opts.lockState is the caller's lock state() (fires 119 and 122,
// the fence below); its `lockFile` names the lock in a refusal.
export function archiveSession(sess, { slug, archiveDir, now = Date.now(), cold = false, gzip = zlib.gzipSync, isPlaceholder = isCloudPlaceholder, lockState = () => ({ state: 'own' }), lockFile = 'the global lock', bounds = RESTORE_BOUNDS, maxGenerations = DEFAULT_MAX_GENERATIONS } = {}) {
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
  // 29gx fire 756, WRITE, VERIFY, THEN REPLACE: every archive copy and every kept generation is first written BESIDE its final name
  // (`<final>.<24 hex>.coalwash-new`, 'wx', fsync), read back through the handle check restore uses and compared, and renamed over the
  // final name only at the COMMIT below, after every check of the session has passed. Until then no archive name changes, so a run that
  // fails, or is killed, before the commit leaves every earlier copy as it was; a failure removes only the staged files it made, and a
  // killed run's are removed by the next run of the session (collectStagedLeftovers, below).
  const written = []; // staged files this run made (each removed on a failure; a renamed one is already gone)
  const created = []; // archive names the commit created from nothing
  // 29gw fire 753, kept for the window AFTER the commit only: a replaced copy's earlier bytes are held, so a failure after it (a rename
  // that fails, the re-verify before delete) puts them back and leaves the session's archive as it was (writeDurable: a temp beside it,
  // then a rename). A kill in that window loses no byte: a replaced copy was a prefix of the new one, or its bytes were committed to a
  // generation first.
  const held = new Map();
  const genDone = []; // 29he fire 772 (lab F-2): each generation this run renamed in, with the bytes it verified there
  let committed = false;
  // Returns what it did as plain words (empty before the commit, when it only removes this run's staged files), so the refusal says
  // exactly what was taken back and what was left.
  const cleanupPartial = () => {
    for (const w of written) { try { fs.rmSync(w, { force: true }); } catch {} }
    if (!committed) return '';
    const notes = [];
    for (const c of created) {
      try { fs.rmSync(c, { force: true }); notes.push(`removed this run's new archive copy ${c}`); } catch (e) { notes.push(`could not remove this run's new archive copy ${c} (${e && e.code})`); }
    }
    for (const [d, bytes] of held) {
      try { writeDurable(d, bytes); notes.push(`put the earlier archived copy back at ${d}`); } catch (e) { notes.push(`could not put the earlier archived copy back at ${d} (${e && e.code}); it is still held in this run's kept generation`); }
    }
    // A generation this run renamed in that still holds the bytes it verified is a good earlier copy and stays (the 756 commit rule).
    // One that no longer holds them is moved aside and never deleted: a hard link at the aside name in the same folder, then the
    // generation name is removed, so the bytes are never without a name (no rename: the commit's two are the only ones, the #57 pin).
    for (const g of genDone) {
      let same = false;
      try { same = readStaged(g.final).equals(g.want); } catch { same = false; }
      if (same) { notes.push(`left this run's kept generation ${g.final} in place: it holds the earlier copy's bytes as they were verified`); continue; }
      const aside = `${g.final}.${crypto.randomBytes(12).toString('hex')}.${ASIDE_SUFFIX}`;
      try { fs.linkSync(g.final, aside); } catch (e) {
        // fire 785 (lab 1.19.2 WD): ENOENT means another writer removed it after this run verified it; there is nothing to check there.
        if (e && e.code === 'ENOENT') { notes.push(`this run's kept generation ${g.final} was removed by another writer after this run verified it, so nothing stands at that name and there is nothing to check there`); continue; }
        notes.push(`this run's kept generation ${g.final} no longer holds the bytes this run verified and could not be moved aside (${e && e.code}), so it stays at that name: check it before restoring that generation`);
        continue;
      }
      try { fs.unlinkSync(g.final); notes.push(`moved this run's kept generation ${g.final} aside to ${aside} without deleting it: it no longer held the bytes this run verified`); } catch (e) {
        notes.push(`this run's kept generation ${g.final} no longer holds the bytes this run verified; it was linked aside to ${aside} but its own name could not be removed (${e && e.code}): check it before restoring that generation`);
      }
    }
    return notes.length ? `. Clean-up: ${notes.join('; ')}` : '';
  };
  // THE FENCE (fire 119, 18a): the caller's global lock can be taken over once it is LOCK_STALE_MS old. Before each write
  // this re-reads it (lockState); a robbed run stops there and removes nothing, since the new holder may be archiving this same
  // session to these same paths and removing a partial copy could remove its verified one. Fire 122: only a foreign token is a
  // theft; a lock file still unreadable after the retries stops the run with its own message, and removes nothing either.
  const stolen = (where, state) => {
    const s = lockState();
    if (s.state === 'own') return null;
    const head = lockLostHead(s, { run: 'ULTRA run', file: lockFile, where: `${where} of session ${sess.id}`, after: 'with no clean-up' });
    return { ok: false, robbed: 'global', lockLost: s.state === 'unreadable' ? 'unreadable' : 'stolen', reason: `${head} ${state}` };
  };
  const notDeleted = () => `${written.length} archive copy(ies) of this session already written stay in place (removing one could remove the new holder's copy of the same session); every original of this session is kept`;
  const fail = (reason) => stolen(`removing the partial archive (after: ${reason})`, notDeleted()) || { ok: false, reason: `${reason}${cleanupPartial()}` };
  // 29gx fire 756, THE GENERATION BOUND: a re-archive that would keep one more generation than estate.maxGenerations allows refuses the
  // session. It never deletes or merges a kept copy to make room; nothing of this session is written, and the live session stays.
  const boundRefusal = (rel, have) => {
    const r = fail(`refused: the earlier archived copy of ${rel} is not a prefix of the live session, so archiving it would keep one more generation, but this session already keeps ${have} generation${have === 1 ? '' : 's'}, the most estate.maxGenerations allows (${maxGenerations}), so nothing was archived or removed. The live session and every archived copy are unchanged; no kept copy is deleted or merged to make room. To archive it, raise estate.maxGenerations in your own config; until then the session stays live and is checked again on the next run`);
    if (!r.robbed) r.generationBound = { kept: have, bound: maxGenerations };
    return r;
  };
  const robbedCollect = stolen('collecting what an earlier run of this session left', 'nothing was written or removed, and every original of this session is kept');
  if (robbedCollect) return robbedCollect;
  // 29gz fire 762 (CodeRabbit t335 F5; the PROVENANCE RULE's "bind before probing"): the project folder and the session folder in the
  // archive must be real folders before anything sweeps or writes in them. A link there (a symlink or a junction, which this tool never
  // makes) refuses the session before the collector runs, so the collector never follows one.
  for (const d of [destBase, path.join(destBase, sess.id)]) {
    let st = null;
    try { st = fs.lstatSync(d); } catch (e) { if (!e || e.code !== 'ENOENT') return fail(`the archive folder ${d} could not be inspected (${e && e.code}) — session skipped, originals kept`); }
    if (st && (st.isSymbolicLink() || !st.isDirectory())) return fail(`the archive folder ${d} is a link or not a folder: a sweep or a write through it escapes the archive root's containment, so a run never sweeps or writes through a link in the archive — session skipped, originals kept`);
  }
  collectStagedLeftovers(destBase, sess.id, { root: rootPhys, names: [slug] }); // row 13
  let transcriptBuf = null;
  const originals = [];
  let gens = null; // the session's kept generations, read once, the first time a file must be kept
  let genN = null; // the generation number this re-archive gives every file it keeps (one N per session per run)
  const kept = [];
  let transcriptSha = null; // F4: the sha256 of the transcript's new archive copy, and of the copy it replaces
  let priorTranscriptSha = null;
  // What the listing already proves: at the largest compressed size a restore takes, these sizes still could not come back, so nothing is read
  // or gzipped. The check after the copies decides the rest.
  const listedWhy = restoreBoundReason(sess.files.map((f) => ({ gzBytes: bounds.maxGzBytes, inflatedBytes: f.bytes })), bounds);
  if (listedWhy) return fail(`restore could not return this session (${listedWhy}) — nothing copied, every original kept`);

  for (const f of sess.files) {
    // #57(d) cloud-placeholder read poison: sniff the dehydrated stub from
    // METADATA before the read below trusts it as ground truth. A placeholder
    // read returns a self-consistent stub, so the gzip round-trip would "verify"
    // and the delete-LAST step would destroy the real (cloud-side) original.
    // Fail-closed: skip the whole session, keep every original (never delete a
    // file we cannot truly read).
    if (isPlaceholder(f.path)) {
      return fail(`cloud placeholder (dehydrated — 0 blocks, size>0): ${f.rel} — a plain read returns a stub, archive+delete refused (fail-closed), originals kept (#57d)`);
    }
    let buf;
    try {
      buf = fs.readFileSync(f.path);
    } catch (e) { return fail(`read failed: ${f.rel}: ${e.message}`); }
    if (f.rel === `${sess.id}.jsonl`) transcriptBuf = buf;
    const dest = path.join(destBase, `${f.rel}.gz`);
    if (!containedIn(physicalForCreate(dest), [rootPhys])) {
      return fail(`archive destination escapes the archive root: ${f.rel} — session skipped (fail-closed), originals kept`);
    }
    try {
      const gz = gzip(buf);
      const robbedGz = stolen(`the archive copy of ${f.rel}`, notDeleted());
      if (robbedGz) return robbedGz;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      // 29gt fire 750: an earlier archive of this file is replaced only when its bytes are an exact prefix of the new source;
      // otherwise it is kept as a generation first, written with 'wx' and read back before the new copy goes over it.
      const prior = priorArchive(dest, buf, bounds);
      if (prior.refuse) return fail(`${prior.refuse}: ${f.rel} — session skipped, originals kept`);
      let gen = null;
      if (f.rel === `${sess.id}.jsonl`) {
        transcriptSha = sha256(gz);
        if (prior.prefix || prior.keep) priorTranscriptSha = sha256(prior.prefix || prior.gz);
      }
      // 29hn fire 796 (INSPECT 795 F795-1; the head's ruling, remedy (a), under main's "a fix is never weaker than the version before the
      // defect"): the earlier copy is ALWAYS kept in a fresh generation, whatever kept generations already hold it, as 1.19.1 did. The
      // 1.19.2 O-1 reuse is gone: a reused generation existed before the run, so a writer on it after the read-back left no copy.
      if (prior.keep) {
        if (gens === null) gens = sessionGenerations(destBase, sess.id, { root: rootPhys, names: [slug] }); // row 12
        if (gens.size >= maxGenerations) return boundRefusal(f.rel, gens.size);
        if (genN === null) genN = gens.size ? Math.max(...gens.keys()) + 1 : 1;
        const genPath = `${dest}.gen${genN}`;
        // genPath is dest's own name plus `.gen<N>`, in the folder the containment check above already resolved, so it needs no
        // second root check. Nothing may already stand at it: a planted link is refused, never followed, and so is an unreadable
        // entry. The name is looked at again just before the commit renames onto it.
        if (standingAt(genPath)) return fail(`something already stands at the generation name for ${f.rel} — session skipped, originals kept`);
        const genTmp = stageBeside(genPath, prior.gz, written);
        if (!readStaged(genTmp).equals(prior.gz)) return fail(`the kept generation of ${f.rel} does not read back — session skipped, originals kept`);
        gen = { tmp: genTmp, final: genPath };
        kept.push({ rel: f.rel, generation: genN, ...(prior.damaged ? { damaged: true, gzPath: genPath } : {}) });
      }
      const tmp = stageBeside(dest, gz, written); // H4: fsync'd at write (this tier keeps no snapshot)
      const back = zlib.gunzipSync(readStaged(tmp), { maxOutputLength: buf.length + 1 }); // bounded by the original's own length
      if (!back.equals(buf)) { return fail(`verify mismatch: ${f.rel} — original kept`); }
      originals.push({ path: f.path, held: f.held, rel: f.rel, gz: dest, tmp, staged: gz, gen, earlier: prior.prefix || (prior.keep ? prior.gz : null), inflated: buf.length });
    } catch (e) { return fail(`archive failed: ${f.rel}: ${e.message} — original kept`); }
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
      return fail(`changed during run: ${f.rel} — session skipped, originals kept`);
    }
  }

  // ARCHIVE RE-VERIFY AT THE DELETE BOUNDARY (loss class #57 sibling — the
  // archive-side TOCTOU the per-file write-verify above does NOT cover): the
  // .gz was verified when it was WRITTEN, but the wide write->delete window
  // (the rest of the file loop + the originals re-stat) is exactly where a
  // co-writer on a cross-volume / cloud-synced archiveDir (a config-supported
  // destination) can remove or re-sync-clobber a .gz. This is the ONE handle
  // for a WARM/COLD session (ULTRA keeps no snapshot), so a clobbered .gz +
  // the delete below = silent byte loss with no recovery door. Re-read + gunzip
  // + byte-compare each archive against a FRESH read of its still-present
  // original (step-2 proved the original is byte-unchanged) — the SAME
  // verify-the-recovery-copy-immediately-before-destroying discipline
  // applyPlan's verifySnapshot applies to its snapshot. Any miss = fail-closed:
  // drop the partial archive, keep every original.
  // THE RESTORE BOUNDS, read on the sizes just staged and verified (the numbers restoreSession refuses on). A session that restore
  // could not return is removed as a partial archive and every original stays; nothing is deleted that the tool could not bring back.
  let boundWhy = null;
  try {
    boundWhy = restoreBoundReason(originals.map((o) => ({ gzBytes: fs.statSync(o.tmp).size, inflatedBytes: o.inflated })), bounds);
  } catch (e) { return fail(`archive size unreadable: ${e.message} — session skipped, originals kept`); }
  if (boundWhy) return fail(`restore could not return this session (${boundWhy}) — its copy removed, every original kept`);

  // THE COMMIT (29gx fire 756): each kept generation is renamed onto its name first, then each verified copy over its archive name.
  // A rename replaces the directory entry, so a reader sees the earlier copy or the new one, never a part of either.
  // 29gz fire 762 (CodeRabbit t335 F2): the lock is re-read before EACH rename, as the fence above says ("before each write"); a run
  // robbed between two renames stops there with no clean-up, like every other robbed step.
  for (const o of originals) {
    if (o.gen) {
      const robbedGen = stolen(`the commit of the kept generation of ${o.rel}`, notDeleted());
      if (robbedGen) return robbedGen;
      committed = true;
      try {
        if (standingAt(o.gen.final)) return fail(`something already stands at the generation name for ${o.rel} — session skipped, originals kept`);
        fs.renameSync(o.gen.tmp, o.gen.final);
        genDone.push({ final: o.gen.final, want: o.earlier });
      } catch (e) { return fail(`archive commit failed: ${e.message} — originals kept`); }
    }
    const robbedCopy = stolen(`the commit of the archive copy of ${o.rel}`, notDeleted());
    if (robbedCopy) return robbedCopy;
    committed = true;
    try {
      fs.renameSync(o.tmp, o.gz);
    } catch (e) { return fail(`archive commit failed: ${e.message} — originals kept`); }
    if (o.earlier) held.set(o.gz, o.earlier); else created.push(o.gz);
  }

  // 29gz fire 762 (CodeRabbit t335 F3): every committed name is read back through restore's handle check and compared with the bytes
  // that were verified before the commit: each kept generation with the earlier copy, each new copy with the copy that was staged. A file
  // altered between its verify and its rename (an outside writer on the archive folder) stops the run before any live file is deleted;
  // the clean-up then puts the earlier copy back under its archive name.
  // 29hj fire 784 (t338 F4; the chief's ruling on CW-073: every kept copy a run relies on is read back before any live file is deleted):
  // the copies a delete relies on are the new copy and the generation this run kept (fire 796: never a generation an earlier run left),
  // so both are read here. An earlier copy that is a prefix of the new one lives inside
  // the new copy, which is read.
  for (const o of originals) {
    const checks = o.gen ? [[o.gen.final, o.earlier, `the kept generation of ${o.rel} (${o.gen.final})`], [o.gz, o.staged, `the archive copy of ${o.rel}`]] : [[o.gz, o.staged, `the archive copy of ${o.rel}`]];
    for (const [p, want, what] of checks) {
      let same = false;
      try { same = readStaged(p).equals(want); } catch { same = false; }
      if (!same) return fail(`archive no longer verifies before delete: ${what} changed after it was verified (something else wrote to the archive folder between the check and the commit), so no live file was deleted and the session stays live — session skipped, originals kept`);
    }
  }

  // The last check before the live delete: each new archive copy must still decompress to the live file. 29ju fire 864 (T-OUTWRITER
  // case 4): the copy is read through ONE handle, and after the read its NAME must still be a regular file (not a link) with the
  // handle's dev and ino, so a copy an outside program removed or replaced inside the read (a handle still reads a removed file) stops
  // the run with the live file kept. A change after that name check and before the delete is not caught here (a stated limit).
  for (const o of originals) {
    let ok = false;
    let named = false;
    try {
      let gzBuf;
      let held;
      const fd = fs.openSync(o.gz, 'r');
      try {
        held = fs.fstatSync(fd, { bigint: true });
        gzBuf = fs.readFileSync(fd);
      } finally { fs.closeSync(fd); }
      const now = fs.lstatSync(o.gz, { bigint: true });
      named = now.isFile() && !now.isSymbolicLink() && now.dev === held.dev && now.ino === held.ino;
      if (named) ok = zlib.gunzipSync(gzBuf, { maxOutputLength: o.inflated + 1 }).equals(fs.readFileSync(o.path));
    } catch { ok = false; }
    if (!named) {
      return fail(`archive no longer verifies before delete: the archive copy of ${o.rel} was changed or removed during the last check before the delete (an outside program in the archive folder?), so no live file was deleted — session skipped, originals kept`);
    }
    if (!ok) {
      return fail(`archive no longer verifies before delete: ${o.rel} (removed/corrupted since it was written — a co-writer on the archive volume?) — session skipped, originals kept`);
    }
  }

  // H4 DURABILITY: fsync every archived .gz's DIRECTORY ENTRY before deleting the
  // originals — a power-loss in the write->unlink window must not lose the SOLE
  // copy (this tier keeps no snapshot). The .gz content is already fsync'd by
  // writeDurable at write time; this makes its filename->inode mapping durable
  // too (best-effort — a Windows dir fd throws and is swallowed, honest ceiling).
  for (const d of new Set(originals.map((o) => path.dirname(o.gz)))) fsyncDirBestEffort(d);

  // F957-1 (29ps fire 958), 29pt fire 963 rows 9 and 10: a session from listSessions carries its held slug folder (`held`) and each file its
  // own held folder. Right before the deletes, every original is held to its own folder again (the slug folder for a flat file, the
  // session folder for a file under <sid>/), so a folder swapped for a link after the listing never has a file deleted through it; any one
  // outside stops the run before the first delete. (A session built by hand, with no `held`, keeps the paths it was handed.)
  if (sess.held) {
    for (const o of originals) {
      if (!inHeld(o.held, o.path)) return fail(`${o.rel} no longer resolves inside this project's session folder (a folder swapped for a link after the listing?), so no live file was deleted — session skipped, originals kept`);
    }
  }

  // Deletes LAST. Every byte is now verified recoverable from the durable archive.
  let deleted = 0;
  const deleteFailed = [];
  for (const [i, o] of originals.entries()) {
    const robbedRm = stolen(`deleting ${o.rel}`, `every file of this session was archived and verified; ${i} original(s) had been deleted (or tried) and the other ${originals.length - i} stay beside their archive copies`);
    if (robbedRm) return robbedRm;
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
  const afterDeletes = `every original of this session was deleted (${deleteFailed.length} could not be) after its archive copy was verified`;
  if (!deleteFailed.length && originals.length) {
    const robbedPrune = stolen('removing the emptied session folder', `${afterDeletes}; the emptied folder${cold ? ', the death-log record' : ''} and the index row were not written`);
    if (robbedPrune) return robbedPrune;
    // row 15: the prune is held to <base>/projects/<slug>/<sid>/, hand-joined; a hand-built session (no `held`) is held to the session
    // folder below the folder its first original is in.
    const projDir = sess.held ? path.join(sess.held.root, ...sess.held.names) : path.dirname(originals[0].path);
    const sidHeld = sess.held ? heldUnder(sess.held, sess.id) : { root: physicalOrNull(projDir), names: [sess.id] };
    pruneEmptyDirs(path.join(projDir, sess.id), projDir, unpruned, sidHeld);
  }

  const row = buildIndexRow({ sessionId: sess.id, projectSlug: slug, transcriptBuf, totalBytes: sess.bytes, now, cold });
  if (transcriptSha) row.transcriptGzSha256 = transcriptSha;
  // The generation that holds the replaced copy (fire 775, INSPECT F774-1; fire 778, labtest 1.19.2 G-1). `replacedTranscriptGzSha256`,
  // the identity search labels an earlier row by, is written ONLY when that generation holds the transcript's own earlier copy: the one
  // that this run kept for it (the prior copy, read back before the commit).
  // When the transcript's earlier copy is a prefix of the new one, equal bytes included (the copy a stopped run committed), no
  // generation holds it and the row names no replaced transcript, so no earlier row is labelled with a generation holding another file.
  // `replacedGeneration` alone still names the generation this run kept for another file.
  const tKept = kept.find((k) => k.rel === `${sess.id}.jsonl`);
  const tGen = tKept ? tKept.generation : null;
  const replaced = genN; // one generation number per run, so the transcript's own generation (tGen) is this one when set
  if (replaced !== null) {
    row.replacedGeneration = replaced;
    if (tGen !== null && priorTranscriptSha) row.replacedTranscriptGzSha256 = priorTranscriptSha;
  }
  if (cold) {
    const robbedCert = stolen('the death-log record', `${afterDeletes}; the death-log record and the index row were not written`);
    if (robbedCert) return robbedCert;
    const ageDays = Math.round((now - sess.newestMtimeMs) / DAY_MS);
    appendDeathCert(archiveDir, slug, `${new Date(now).toISOString()} destroyed-cold ${sess.id} (age ${ageDays}d, ${sess.files.length} file(s), ${sess.bytes} bytes — archived+verified first)`);
  }
  return { ok: true, deleted, deleteFailed, unpruned, files: originals.length, bytes: sess.bytes, row, generation: genN, kept };
}

// 29he fire 772 (lab O-2): a run killed after a session's originals are deleted and before its index row is written leaves an archive
// that search never lists. Each run that indexes first adds a row for every archived session of this project whose archive the index
// does not describe: no row for it, or a newest row that names a different transcript copy (a session still live too: its row describes
// the archived copy, and the run's own archive step adds the next row). Chosen over writing the row before the deletes, which would leave a row behind
// for a run robbed of its lock after the copies were committed; this also mends rows lost to a failed append or to indexEnabled false.
// A newest row from an older install (no transcriptGzSha256) is taken as describing the archive: it cannot be told apart.
// The words for an archived file the index repair cannot open (fire 784, t338 F1): which file, why, and what the person can do.
const unopenable = (file, e) => `its archived transcript ${file} could not be opened (${(e && e.code) || 'error'}), so the index repair skipped it and search will not list it; fix the file's permissions or close the program that holds it, then run again`;
// F956-1 (29ps fire 958): the slug folder is checked against the archive root (the global config's estate.archiveDir) before it is listed,
// each archived transcript is read only when it resolves inside that slug folder, and the generation walk is handed the same checked root.
// 29pt fire 963, row 11: the slug folder is HELD to <archive>/<slug>, hand-joined from the resolved archive root, so a slug folder linked to
// another slug folder inside the archive is not read as this project's.
function reconcileIndex(archiveDir, slug, { now, lockState, bounds }) {
  const out = { added: 0, failed: [], undecodable: [], robbedState: null };
  const slugDir = path.join(archiveDir, slug);
  const slugHeld = { root: physicalOrNull(archiveDir), names: [slug] };
  if (!inHeld(slugHeld, slugDir)) return out; // a slug folder that is not <archive>/<slug> itself is never read
  let names;
  try { names = fs.readdirSync(slugDir, { withFileTypes: true }); } catch { return out; }
  const latest = new Map(); // sessionId -> the newest row for (sessionId, slug), in file order
  try {
    for (const raw of fs.readFileSync(path.join(archiveDir, ESTATE_INDEX_NAME), 'utf8').split('\n')) {
      let row;
      try { row = JSON.parse(raw); } catch { continue; }
      if (row && typeof row === 'object' && row.retier !== true && typeof row.sessionId === 'string' && row.projectSlug === slug) latest.set(row.sessionId, row);
    }
  } catch { /* no index yet: every archived session here is rowless */ }
  const sids = names.filter((d) => d.isFile() && d.name.endsWith('.jsonl.gz') && inHeld(slugHeld, path.join(slugDir, d.name))).map((d) => d.name.slice(0, -'.jsonl.gz'.length)).filter((sid) => isBareId(sid) && !sid.includes('.')).sort();
  for (const sid of sids) {
    // fire 784 (t338 F1): an archive this repair cannot open (a permission, an ACL, a file another program holds) is named in words and
    // skipped; the run goes on with every other session and reports the failure, so the CLI exits non-zero.
    const gzPath = path.join(slugDir, `${sid}.jsonl.gz`);
    let got;
    try { got = readArchiveHandle(gzPath, bounds.maxGzBytes); } catch (e) {
      out.failed.push({ id: sid, reason: unopenable(gzPath, e) });
      continue;
    }
    if (got.shrank !== undefined) { // 29jo fire 849 (L818-2): named, no row, so the next run's repair reads it again
      out.failed.push({ id: sid, reason: `its archived transcript ${gzPath} changed while it was read, so no index row was added for it; the next run tries again` });
      continue;
    }
    if (!got.buf) continue;
    const sha = sha256(got.buf);
    const prev = latest.get(sid);
    if (prev && (typeof prev.transcriptGzSha256 !== 'string' || prev.transcriptGzSha256 === sha)) continue;
    let transcriptBuf;
    try { transcriptBuf = zlib.gunzipSync(got.buf, { maxOutputLength: restoreInflateBoundWith(got.buf.length, bounds) }); } catch (e) {
      const f = { id: sid, reason: `its archived transcript does not decompress (${e && e.code}), so no index row was added for it; restore it by id` };
      out.failed.push(f);
      out.undecodable.push(f);
      continue;
    }
    const row = buildIndexRow({ sessionId: sid, projectSlug: slug, transcriptBuf, totalBytes: transcriptBuf.length, now }); // bytes: the transcript's own (the session's other files are not read here)
    row.transcriptGzSha256 = sha;
    row.reconciled = true; // archivedAt is when this row was added, not when the copy was archived
    // 29hz fire 803 (CodeRabbit t340 F7): a generation this repair could not read leaves the session with NO new row, so the next run's
    // repair tries again and labels it once the read succeeds (a row here would carry the current sha and the shortcut above would skip it).
    let genUnread = false;
    if (prev && typeof prev.transcriptGzSha256 === 'string') {
      let n = null;
      for (const [g, list] of sessionGenerations(slugDir, sid, slugHeld)) {
        for (const e of list) {
          if (e.rel !== `${sid}.jsonl`) continue;
          let kg;
          try { kg = readArchiveHandle(e.gzPath, bounds.maxGzBytes); } catch (err) {
            out.failed.push({ id: sid, reason: `its kept generation ${e.gzPath} could not be opened (${(err && err.code) || 'error'}), so the index repair could not tell which copy it holds and gave the earlier row no generation label; fix the file's permissions or close the program that holds it, then run again` });
            genUnread = true;
            continue;
          }
          // 29ig fire 813 (CodeRabbit t343 F1): the reader also fails without a throw ({ notFile }, { over }, { grew }, no bytes).
          // Each is unread too: named, no row this run, so the next run's repair tries again.
          if (!kg.buf) {
            const why = kg.notFile ? 'it is not a regular file' : kg.over !== undefined ? `it is over the restore bound at ${kg.over} bytes` : 'it changed while it was read';
            out.failed.push({ id: sid, reason: `its kept generation ${e.gzPath} could not be read (${why}), so the index repair could not tell which copy it holds and added no row for this session; the next run tries again` });
            genUnread = true;
            continue;
          }
          if (sha256(kg.buf) === prev.transcriptGzSha256 && (n === null || g > n)) n = g;
        }
      }
      if (n !== null) { row.replacedGeneration = n; row.replacedTranscriptGzSha256 = prev.transcriptGzSha256; }
    }
    if (genUnread) continue;
    const s = lockState();
    if (s.state !== 'own') { out.robbedState = s; return out; }
    if (appendIndexRow(archiveDir, row)) out.added++;
    else out.failed.push({ id: sid, reason: 'its index row could not be appended (the archive itself still restores it by id)' });
  }
  return out;
}

// 29gt fire 750. The earlier archive at `dest`, judged against the new source `buf` by CONTENT: the old copy's decompressed bytes
// must equal the first bytes of the new source (never size, count, mtime or date alone). Returns {} when there is no earlier copy,
// { prefix: gz } when it is an exact prefix (the replace drops nothing; its bytes are held so a rollback can put them back), or
// it is an exact prefix (the replace drops nothing), { keep: true, gz } when it must be kept as a generation, { refuse } when it
// cannot be judged safely. A copy that will not decompress is KEPT (never judged a prefix): nothing unreadable is ever replaced.
const ZLIB_DAMAGE_CODES = new Set(['Z_DATA_ERROR', 'Z_BUF_ERROR', 'Z_NEED_DICT']); // what zlib reports for bytes that are not a whole gzip
function priorArchive(dest, buf, bounds) {
  let st;
  try { st = fs.lstatSync(dest); } catch (e) { if (e && e.code === 'ENOENT') return {}; return { refuse: `the earlier archive could not be read (${e && e.code})` }; }
  if (!st.isFile()) return { refuse: 'the earlier archive is not a regular file' };
  const got = readArchiveHandle(dest, bounds.maxGzBytes);
  if (got.notFile) return { refuse: 'the earlier archive is not a regular file' };
  if (got.over !== undefined || got.grew !== undefined || got.shrank !== undefined) return { refuse: 'the earlier archive is over the restore bound or changed while it was read' };
  let old;
  // 29hz fire 803 (CodeRabbit t340 F1): a damage code marks the copy damaged. 29ib fire 807 (INSPECT 806 F806-1, N806-3): the codes
  // are named (Z_MEM_ERROR is memory, not damage), and a copy longer than the new source throws ERR_BUFFER_TOO_LARGE before zlib
  // reaches any damage, so it is decoded once more under the restore bound (the bound the index repair and a restore use) and marked
  // on a damage code there.
  try { old = zlib.gunzipSync(got.buf, { maxOutputLength: Math.max(1, buf.length) }); } catch (e) {
    let code = e && e.code;
    if (code === 'ERR_BUFFER_TOO_LARGE') {
      try { zlib.gunzipSync(got.buf, { maxOutputLength: restoreInflateBoundWith(got.buf.length, bounds) }); code = null; } catch (e2) { code = e2 && e2.code; }
    }
    return { keep: true, gz: got.buf, ...(ZLIB_DAMAGE_CODES.has(code) ? { damaged: true } : {}) };
  }
  if (old.length <= buf.length && buf.subarray(0, old.length).equals(old)) return { prefix: got.buf }; // held for a rollback (W752-2)
  return { keep: true, gz: got.buf };
}
// The session's kept generations, from the names alone: Map N -> [{ gzPath, rel }] (rel = the archived file's original rel).
// Files directly in the slug folder named `<sid>.*.gz.gen<N>`, and files under `<sid>/` named `*.gz.gen<N>`.
// 29oy fire 947 (reader class, move (d), rows B5 to B8 and B11): a walk takes a child's kind from the listing, so a child folder swapped
// for a junction or link AFTER the listing would be followed. Before a walk acts on a path, or descends into one, the path's realpath
// must lie inside the walk's held folder (below); a path that does not resolve, or resolves
// outside, is skipped (fail closed). This is a check made at one moment: a swap between it and the act still follows (SECURITY.md
// Known limits; no Node call opens or lists a folder beneath a handle).
// 29pr fire 953, F950-1 (INSPECT 950): the root itself must come from the folder ABOVE the one a walk lists (the slug folder for the
// session level, the archive root for the slug level, `base` for the prune), never from the realpath of a name the walk just listed: one
// swap of THAT folder would relocate the root and every entry below it would read as inside.
// 29pt fire 963 (main's c209, the signed root table 962): F950-1 took a walk's root from the folder above the one it lists, but checked it
// against the realpath of that folder, which a link can still move to a sibling inside the same root. Now every walk takes a HELD folder,
// { root, names }: `root` a trusted root resolved once (the archive root from the global config, the Claude base), `names` the literal
// names below it down to the deepest folder the walk acts in. The folder is hand-joined and never resolved; an entry counts only when its
// real path lies inside it (heldPath, class-b.mjs). heldUnder names a folder one level down. A string (a folder the caller resolved) is
// held as itself, with no names.
function asHeld(h) { return typeof h === 'string' ? { root: h, names: [] } : h; }
function inHeld(h, p) { const x = asHeld(h); return !!(x && heldPath(x.root, x.names, p)); }
function heldUnder(h, ...more) { const x = asHeld(h); return x ? { root: x.root, names: [...x.names, ...more] } : null; }
// The held folder of `dir` as the child of its parent, the parent resolved once: the default for a walk handed only a folder.
function heldAsChild(dir) { return { root: physicalOrNull(path.dirname(dir)), names: [path.basename(dir)] }; }
// Row 12: `slugHeld` holds the slug folder (<archive>/<slug>); the session folder is held to <archive>/<slug>/<sid>/ itself.
function sessionGenerations(slugDir, sessionId, slugHeld = heldAsChild(slugDir)) {
  const gens = new Map();
  const add = (n, gzPath, rel) => { if (!gens.has(n)) gens.set(n, []); gens.get(n).push({ gzPath, rel }); };
  const sidHeld = heldUnder(slugHeld, sessionId);
  let names;
  try { names = fs.readdirSync(slugDir, { withFileTypes: true }); } catch { return gens; }
  for (const d of names) {
    const m = GEN_RE.exec(d.name);
    const top = path.join(slugDir, d.name);
    if (!inHeld(slugHeld, top)) continue; // F950-1: a file swapped for a link after the slug listing
    if (d.isFile() && m && d.name.startsWith(`${sessionId}.`)) add(Number(m[1]), top, d.name.slice(0, m.index));
    else if (d.isDirectory() && d.name === sessionId && inHeld(sidHeld, top)) { // row 12: the session folder is that session's own
      const sessDir = top;
      const walk = (dir, relBase) => {
        let subs;
        try { subs = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const s of subs) {
          const p = path.join(dir, s.name);
          if (!inHeld(sidHeld, p)) continue; // B5: a child swapped to a link after the listing is never followed
          if (s.isDirectory()) { walk(p, path.join(relBase, s.name)); continue; }
          const g = GEN_RE.exec(s.name);
          if (s.isFile() && g) add(Number(g[1]), p, path.join(relBase, s.name.slice(0, g.index)));
        }
      };
      walk(sessDir, sessionId);
    }
  }
  return gens;
}
// True when anything (a file, a folder, a link, an entry that cannot be read) stands at `p`; only ENOENT means nothing does.
function standingAt(p) {
  try { fs.lstatSync(p); } catch (e) { if (e && e.code === 'ENOENT') return false; }
  return true;
}
// 29gx fire 756: write `data` to a new file beside `finalPath` (`<final>.<24 hex>.coalwash-new`, created 'wx' 0600, fsync'd) and return its
// path. The path joins `staged` as soon as the file exists, so a write that fails partway is removed by the caller's clean-up.
function stageBeside(finalPath, data, staged) {
  const tmp = `${finalPath}.${crypto.randomBytes(12).toString('hex')}.${STAGE_SUFFIX}`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  staged.push(tmp);
  try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return tmp;
}
// Read a staged file back through restore's own handle check (readArchiveHandle: a plain file, read through one handle, not growing).
// No size bound here: the restore bounds are read on the staged sizes right after the loop, each with its own reason.
function readStaged(p) {
  const got = readArchiveHandle(p, Number.MAX_SAFE_INTEGER);
  if (!got.buf) throw new Error(`the staged copy ${path.basename(p)} is not a plain file or changed while it was read`);
  return got.buf;
}
// 29gx fire 756, THE COLLECTOR: before a run archives a session, remove what a killed run of that session left. Only plain files whose
// name matches STAGED_RE are removed, one by one and never recursively: in the slug folder those whose name starts `<sessionId>.`, and
// anything under the session's own `<sessionId>/` folder. A folder, a link or any other name is left alone. None of these names ends in
// `.gz` or `.gz.gen<N>`, so no restore, search or generation count ever took one for an archive copy.
// Row 13: `slugHeld` holds <archive>/<slug>; the flat sweep is held to it and the session sweep to <archive>/<slug>/<sid>/ itself, each
// entry checked right before its unlink.
function collectStagedLeftovers(slugDir, sessionId, slugHeld = heldAsChild(slugDir)) {
  const sweep = (dir, accept, h) => {
    let es;
    try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(dir, e.name);
      if (!inHeld(h, p)) continue; // B11: never unlink, or descend, through a child swapped to a link after the listing
      if (e.isDirectory()) { if (accept === null) sweep(p, null, h); continue; }
      if (!e.isFile() || !STAGED_RE.test(e.name) || (accept !== null && !accept(e.name))) continue;
      if (!inHeld(h, p)) continue; // the check and the unlink in one place, right before it
      try { fs.unlinkSync(p); } catch { /* left for the next run */ }
    }
  };
  sweep(slugDir, (n) => n.startsWith(`${sessionId}.`), slugHeld);
  const sidHeld = heldUnder(slugHeld, sessionId);
  if (inHeld(sidHeld, path.join(slugDir, sessionId))) sweep(path.join(slugDir, sessionId), null, sidHeld);
}
// fire 785 (lab 1.19.2): the files a refused run moved aside (`*.${ASIDE_SUFFIX}`) in this project's archive folder, so a later run's
// report can list them. Reading only: plain files, the folder walked without following a link, sorted.
// F950-1: `archPhys` is the archive root (the folder above the slug folder: the caller passes it from the global config, and the default
// is the parent of the folder it was handed, never a listed name); the slug folder is checked against it, then every entry against the
// slug folder's realpath found inside it.
// Row 14: the slug folder is held to <archive>/<slug>, hand-joined from `archPhys` and the slug folder's own name.
function listAsides(slugDir, archPhys = physicalOrNull(path.dirname(slugDir))) {
  const out = [];
  const slugHeld = { root: archPhys, names: [path.basename(slugDir)] };
  if (!inHeld(slugHeld, slugDir)) return out; // the slug folder is not <archive>/<slug> itself: nothing is listed
  const walk = (dir) => {
    let es;
    try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(dir, e.name);
      if (!inHeld(slugHeld, p)) continue; // B7: a name outside the archive folder is never printed
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(`.${ASIDE_SUFFIX}`)) out.push(p);
    }
  };
  walk(slugDir);
  return out.sort();
}

// Remove now-EMPTY directories bottom-up; push the rel path (from `base`) of any
// surviving FILE into `survivors`. rmdirSync (non-recursive) REFUSES a non-empty
// dir, so a file — enumerated or not — is never destroyed here; only empty
// scaffolding is swept. This is the loss-class-#56 guard on the <sid>/ container:
// delete_scope == verified_set (a file we did not archive must not die under a
// recursive rm just because it shared the container). A symlink Dirent reports
// its own type (isFile/isDirectory both false) -> it is treated as a survivor,
// never followed and never deleted.
// B8 (29oy fire 947): a child folder swapped for a link after the listing is never descended into, so no folder outside `base` is
// removed and no outside name is listed; the link itself stays where it is and is reported as a survivor by its name inside `base`.
// F950-1: `dir` itself is checked against `base` BEFORE it is listed, so a folder handed in (or reached) that is a link out of `base`
// prints no outside name; it is reported by its own name inside `base` when anything stands there, and nothing is removed.
// Row 15 (29pt fire 963): `h` holds the walk's TOP, <base>/projects/<slug>/<sid>/, hand-joined; every folder is held to it before it is
// listed, descended into or removed. The default (a caller handing only `dir` and `base`) holds `dir` as the folder below `base`, `base`
// resolved once.
function pruneEmptyDirs(dir, base, survivors, h = { root: physicalOrNull(base), names: path.relative(base, dir).split(path.sep) }) {
  if (!inHeld(h, dir)) { if (standingAt(dir)) survivors.push(path.relative(base, dir)); return; }
  let names;
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; } // absent (no overflow dir) or unreadable
  for (const d of names) {
    const p = path.join(dir, d.name);
    if (d.isDirectory() && inHeld(h, p)) pruneEmptyDirs(p, base, survivors, h);
    else survivors.push(path.relative(base, p)); // a FILE (or symlink/special, or a folder that no longer resolves inside) we did not enumerate — keep + surface
  }
  if (!inHeld(h, dir)) return; // never remove a folder that does not resolve inside the held top
  try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch { /* still non-empty or already gone */ }
}

// ---------------------------------------------------------------------------
// the ULTRA run (wizard-consented ONLY — see the run-gate note in the header)
// ---------------------------------------------------------------------------

// Non-mutating pre-consent scan for the wizard bill.
export function estateUltraScan({ projectRoot = process.cwd(), home = os.homedir(), now = Date.now(), estate, currentSessionId = null } = {}) {
  // Platform gate (armor #2, one-flock with discoverClassB): a non-Claude-Code
  // home has no CC projects/<slug>/ session layout — conservative no-op, NEVER
  // a CC-layout-assumed scan. Mirrors class-b.mjs's fallback flag verbatim.
  // AG reason (29g fire 412, head ruling 4): the estate engine reads Claude Code JSONL sessions, and an AG estate has none (b05a2e5:
  // the AG shape fixture holds no JSONL), so this refusal is the named answer, not a gap.
  if (detectPlatform(home) !== 'claude-code') {
    return {
      platform: 'unknown', flags: [UNKNOWN_PLATFORM_FLAG],
      slug: null, archiveDir: resolveArchiveDir(estate, home), cfg: resolveEstateCfg(estate),
      sessions: 0, active: 0, warm: 0, cold: 0,
      warmBytes: 0, coldBytes: 0, totalBytes: 0, estAfterBytes: 0,
    };
  }
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
export function runEstate({ projectRoot = process.cwd(), home = os.homedir(), now = Date.now(), estate, currentSessionId = null, gzip = zlib.gzipSync, bounds = RESTORE_BOUNDS } = {}) {
  // Platform gate (armor #2): a non-Claude-Code home has no CC session estate to
  // touch — conservative no-op BEFORE the lock, nothing mutated (mirrors
  // discoverClassB / estateUltraScan). ok:true = "correctly did nothing".
  // AG reason (29g fire 412, head ruling 4): the estate engine reads Claude Code JSONL sessions, and an AG estate has none (b05a2e5:
  // the AG shape fixture holds no JSONL), so this refusal is the named answer, not a gap.
  if (detectPlatform(home) !== 'claude-code') {
    return {
      ok: true, platform: 'unknown', flags: [UNKNOWN_PLATFORM_FLAG],
      slug: null, archiveDir: resolveArchiveDir(estate, home), cfg: resolveEstateCfg(estate),
      archived: [], failed: [], coldListed: [], activeSkipped: 0, bytesFreed: 0, indexRows: 0, budgetDeferred: 0, budgetReached: false,
    };
  }
  const lock = acquireLock(globalLockPath(home), { sessionId: currentSessionId || String(process.pid), now });
  if (!lock.acquired) return { ok: false, deferred: true, error: lock.reason };
  let res = null; // fire 122: the one result object; the finally adds lockLeft to it when the release had to leave the lock
  let thrown = null;
  let lockLeft = null;
  try {
    const c = classifySessions({ projectRoot, home, now, estate, currentSessionId });
    const archiveDir = resolveArchiveDir(estate, home);
    res = {
      ok: true, slug: c.slug, archiveDir, cfg: c.cfg,
      archived: [], failed: [], coldListed: [], activeSkipped: 0,
      bytesFreed: 0, indexRows: 0, budgetDeferred: 0, budgetReached: false,
    };
    const budget = c.cfg.runBudget;
    let undecodable = []; // fire 785 (lab 1.19.2 K-E): the repair's does-not-decompress entries, dropped below for a session this run re-archives
    const indexedNow = new Set();
    if (c.cfg.indexEnabled) {
      const rec = reconcileIndex(archiveDir, c.slug, { now, lockState: lock.state, bounds });
      res.indexRows += rec.added;
      if (rec.added) res.reconciledRows = rec.added;
      for (const f of rec.failed) res.failed.push(f);
      undecodable = rec.undecodable;
      if (rec.failed.length) res.indexRepairFailed = rec.failed.length; // fire 784 (t338 F1): the CLI exits non-zero on it
      if (rec.robbedState) {
        const s = rec.robbedState;
        res.ok = false; res.robbed = 'global'; res.lockLost = s.state === 'unreadable' ? 'unreadable' : 'stolen';
        res.error = `${lockLostHead(s, { run: 'ULTRA run', file: globalLockPath(home), where: 'adding the index rows a stopped run left out', after: 'with no clean-up' })} No session was archived by this run; the sessions without a row still restore by id`;
        return res;
      }
    }
    for (const sess of c.sessions) {
      if (sess.band === 'active') { res.activeSkipped++; continue; }
      if (sess.band === 'cold' && !c.cfg.deleteCold) {
        res.coldListed.push({ id: sess.id, bytes: sess.bytes, ageDays: Math.round((now - sess.newestMtimeMs) / DAY_MS) });
        continue;
      }
      // runBudget STOP (the unbounded-axis work-limit): this unit is archive-
      // eligible (warm, or cold+deleteCold). If EITHER limit is already reached,
      // STOP at this completed-unit boundary — never mid-unit (each
      // archiveSession is an independent copy-verify-delete tx, so stopping
      // between them leaves ZERO partial). Count the remainder as budget-deferred
      // + report N/M; a second run continues where this one stopped. (Cold-listed
      // + active are cheap report/skip — they still run, never budget-gated.)
      if (res.archived.length >= budget.maxSessionsPerRun || res.bytesFreed >= budget.maxBytesPerRun) {
        res.budgetDeferred++;
        continue;
      }
      const cold = sess.band === 'cold';
      const r = archiveSession(sess, { slug: c.slug, archiveDir, now, cold, gzip, lockState: lock.state, lockFile: globalLockPath(home), bounds, maxGenerations: c.cfg.maxGenerations });
      // fire 119: a robbed session stops the whole run, so no later session starts under a lock this run no longer holds.
      if (r.robbed) { res.ok = false; res.robbed = r.robbed; res.lockLost = r.lockLost; res.error = r.reason; break; }
      if (!r.ok) {
        res.failed.push({ id: sess.id, reason: r.reason });
        if (r.generationBound) {
          res.generationRefusals = (res.generationRefusals || 0) + 1;
          const why = recordGenerationRefusal(archiveDir, { now, sessionId: sess.id, projectSlug: c.slug, ...r.generationBound });
          if (why) res.failed.push({ id: sess.id, reason: `the refusal above was not recorded for /coalwash:stats (${why})` });
        }
        continue;
      }
      const s = c.cfg.indexEnabled ? lock.state() : { state: 'own' };
      if (s.state !== 'own') {
        res.ok = false; res.robbed = 'global'; res.lockLost = s.state === 'unreadable' ? 'unreadable' : 'stolen';
        res.error = `${lockLostHead(s, { run: 'ULTRA run', file: globalLockPath(home), where: `the index row of session ${sess.id}`, after: 'with no clean-up' })} The session was archived and verified and its originals deleted; its index row was not appended (estate-restore reads the archive itself, so it stays restorable)`;
        res.archived.push({ id: sess.id, bytes: r.bytes, files: r.files, cold, deleteFailed: r.deleteFailed, unpruned: r.unpruned, generation: r.generation, kept: r.kept });
        res.bytesFreed += r.bytes;
        break;
      }
      if (c.cfg.indexEnabled && !appendIndexRow(archiveDir, r.row)) res.failed.push({ id: sess.id, reason: 'index append failed (bytes archived + originals deleted — restore unaffected; the next run adds the row)' });
      else if (c.cfg.indexEnabled) { res.indexRows++; indexedNow.add(sess.id); }
      res.archived.push({ id: sess.id, bytes: r.bytes, files: r.files, cold, deleteFailed: r.deleteFailed, unpruned: r.unpruned, generation: r.generation, kept: r.kept });
      res.bytesFreed += r.bytes;
    }
    const asides = listAsides(path.join(archiveDir, c.slug), physicalOrNull(archiveDir)); // F950-1: the archive root, from the global config
    if (asides.length) res.asideFiles = asides;
    // fire 785 (lab 1.19.2 K-E): a session this same run archived cleanly with its index row appended no longer needs the repair's
    // "does not decompress ... restore it by id" hint, and the run no longer counts it as a repair it could not do.
    // 788 (INSPECT 787 C2): when this run kept a damaged copy as a generation, the session's report line says so (no restore advice).
    // 29hz fire 803 (CodeRabbit t340 F1): the mark comes from the archive read that decided the keep (priorArchive), so it holds with
    // the index off and is not carried over from the repair's earlier read of a copy that has since been replaced.
    for (const a of res.archived) {
      const tk = Array.isArray(a.kept) ? a.kept.find((k) => k.rel === `${a.id}.jsonl` && k.damaged) : null;
      if (tk) a.damagedGeneration = tk.generation;
      // 29ig fire 813 (CodeRabbit t343 F8; the head's ruling): a damaged kept copy of any other file of the session is named by its
      // archive path; the transcript keeps its own wording above.
      const dmg = Array.isArray(a.kept) ? a.kept.filter((k) => k.damaged && k.rel !== `${a.id}.jsonl`).map((k) => ({ rel: k.rel, generation: k.generation, gzPath: k.gzPath })) : [];
      if (dmg.length) a.damagedFiles = dmg;
    }
    const moot = new Set(undecodable.filter((f) => indexedNow.has(f.id)));
    if (moot.size) {
      res.failed = res.failed.filter((f) => !moot.has(f));
      const left = (res.indexRepairFailed || 0) - moot.size;
      if (left > 0) res.indexRepairFailed = left; else delete res.indexRepairFailed;
    }
    res.budgetReached = res.budgetDeferred > 0;
    return res;
  } catch (e) { thrown = e; } finally {
    lockLeft = lockLeftNote(globalLockPath(home), lock.release(), LOCK_STALE_MS);
    if (lockLeft && res) res.lockLeft = lockLeft; // the object the try already returned: the caller sees this field
  }
  throw withLockLeft(thrown, lockLeft); // reached only when the body threw (fire 123): the error still names a lock left behind
}

// 29gx fire 756: one JSON line per generation-bound refusal, appended to GENERATION_REFUSALS_NAME in the archive root through the same
// proved append the index uses. Returns null, or why the record could not be written (the run reports it; the refusal itself stands).
function recordGenerationRefusal(archiveDir, { now, sessionId, projectSlug, kept, bound }) {
  const rec = { timestamp: new Date(now).toISOString(), severity: 'WARN', event: 'generation-bound-refusal', sessionId, projectSlug, kept, bound };
  try { appendOwnLog(path.join(archiveDir, GENERATION_REFUSALS_NAME), JSON.stringify(rec) + '\n'); return null; } catch (e) { return (e && e.code) || (e && e.message) || 'unknown'; }
}
// For /coalwash:stats: how many generation-bound refusals the archive recorded (for one project slug when given) and the earliest.
// A missing file is { count: 0, since: null }, the state of every archive written before this record existed; a line that is not one
// of these records is skipped. The file is read only up to GENERATION_REFUSALS_READ_MAX bytes.
const GENERATION_REFUSALS_READ_MAX = 8 * 1024 * 1024;
export function readGenerationRefusals(archiveDir, projectSlug = null) {
  let text = '';
  try {
    const got = readArchiveHandle(path.join(archiveDir, GENERATION_REFUSALS_NAME), GENERATION_REFUSALS_READ_MAX);
    if (!got.buf) return { count: 0, since: null, unreadable: got.notFile ? 'not a plain file' : got.over !== undefined ? 'over the read bound' : 'changed while it was read' };
    text = got.buf.toString('utf8');
  } catch (e) { return e && e.code === 'ENOENT' ? { count: 0, since: null } : { count: 0, since: null, unreadable: (e && e.code) || 'unreadable' }; }
  let count = 0;
  let since = null;
  for (const raw of text.split(/\r?\n/)) {
    let rec;
    try { rec = JSON.parse(raw); } catch { continue; }
    if (!rec || rec.event !== 'generation-bound-refusal' || typeof rec.timestamp !== 'string') continue;
    if (projectSlug !== null && rec.projectSlug !== projectSlug) continue;
    count++;
    if (since === null || rec.timestamp < since) since = rec.timestamp;
  }
  return { count, since };
}

// Plain-text run report (program-built; the receipt-style deliverable).
export function runEstateReport(res) {
  if (!res || res.deferred) return `[CoalWash] ULTRA estate deferred: ${res && res.error ? res.error : 'lock held'}`;
  const lines = [];
  lines.push(`[CoalWash] ULTRA estate — ${res.archived.length} session(s) archived (${mb(res.bytesFreed)} freed from the live tree), ${res.activeSkipped} active skipped`);
  if (res.robbed) lines.push(`  STOPPED: ${res.error}`);
  if (res.lockLeft) lines.push(`  LOCK LEFT: ${res.lockLeft}`);
  lines.push(`  archive: ${res.archiveDir} (${res.indexRows} index row(s) appended · restore: cli.mjs estate-restore <sessionId>)`);
  if (res.asideFiles && res.asideFiles.length) lines.push(`  ASIDE: ${res.asideFiles.length} file(s) in this project's archive were moved aside by a refused run and kept, never deleted (they hold bytes that run could not verify; restore and search never read them): ${res.asideFiles.map((p) => escapeRawControls(String(p))).join('; ')}`); // 788 (INSPECT 787 C1): names from the archive folder, escaped as the KEPT lines
  if (res.reconciledRows) lines.push(`  INDEXED: ${res.reconciledRows} archived session(s) had no index row (an earlier run stopped before writing it, its append failed, or indexing was off), so this run added one for each`);
  if (res.budgetReached) {
    const total = res.archived.length + res.budgetDeferred;
    lines.push(`  BUDGET: archived ${res.archived.length}/${total} eligible session(s) this run — per-run work-limit reached; ${res.budgetDeferred} deferred, run ULTRA again for the rest (zero partial — each unit is its own copy-verify-delete tx)`);
  }
  for (const f of res.failed) lines.push(`  KEPT ${escapeRawControls(String(f.id))}: ${escapeRawControls(String(f.reason))}`);
  // #56: a session whose <sid>/ still held un-enumerated files was archived +
  // its container LEFT in place (never rm -rf'd) — surface the survivors.
  for (const a of res.archived) {
    // 29gt fire 750: a re-archive that found an earlier copy it could not replace without dropping bytes kept that copy.
    if (Number.isInteger(a.generation) && a.damagedGeneration === a.generation) lines.push(`  KEPT-EARLIER ${escapeRawControls(String(a.id))}: the earlier archived transcript does not decompress (it is damaged); it was kept as generation ${a.generation} so its bytes are not lost, and a restore of that generation names it as damaged and does not return it`);
    else if (Number.isInteger(a.generation)) lines.push(`  KEPT-EARLIER ${escapeRawControls(String(a.id))}: the earlier archived copy was not a prefix of this one, so it was kept as generation ${a.generation} (restore it with: cli.mjs estate-restore ${escapeRawControls(String(a.id))} --generation ${a.generation})`);
    for (const d of Array.isArray(a.damagedFiles) ? a.damagedFiles : []) lines.push(`  KEPT-EARLIER ${escapeRawControls(String(a.id))}: the earlier archived copy of ${escapeRawControls(String(d.rel))} does not decompress (it is damaged); it was kept as generation ${d.generation} at ${escapeRawControls(String(d.gzPath))} so its bytes are not lost, and a restore of that generation names it as damaged and does not return it`);
    if (a.unpruned && a.unpruned.length) lines.push(`  KEPT-IN-PLACE ${escapeRawControls(String(a.id))}: ${a.unpruned.length} un-enumerated file(s) under <sid>/ left intact (not archived — appeared post-listing / walk-capped): ${a.unpruned.slice(0, 5).map((n) => escapeRawControls(String(n))).join(', ')}${a.unpruned.length > 5 ? ', …' : ''}`);
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

// #58 DELETION-UNAWARE TIME-TRAVEL RESTORE (MASTER-LOSS-TAXONOMY.md #58): a
// dig/restore reads a FROZEN pre-deletion copy and could present it as current
// fact, silently un-deleting what a gate-approved wash deliberately removed.
// Cross-check recovered content against the TOMBSTONE REGISTRY of adjudicated/
// cut things: keeps.json ANCHORS (project + global — the verbatim spans a
// review pinned/adjudicated) plus the bins' DEATH-LOG (destroyed cuts — a
// pointer, no content to match). ADVISORY ONLY — the signal LABELS a result,
// never blocks it (recovery still works, it's just qualified). Fail-silent: an
// unreadable ledger just yields fewer anchors. NOTE the honest framing: a
// keeps.json anchor proves the span was ADJUDICATED, not necessarily deleted —
// the signal says "verify against the CURRENT store", the safe qualification.
export function collectTombstones({ projectRoot = process.cwd(), home = os.homedir() } = {}) {
  const anchors = [];
  const seenLc = new Set(); // 29n F470-c: one anchor text is one tombstone, however many keeps repeat it
  const addKeep = (k) => {
    // ONLY a verbatim `anchor` is content-matchable — a bare `target` is a
    // path/line reference, not prose that appears in a transcript (matching it
    // would false-fire on path fragments).
    const text = k && typeof k.anchor === 'string' && k.anchor.trim() ? k.anchor.trim() : null;
    if (!text) return;
    const textLc = text.toLowerCase();
    if (seenLc.has(textLc)) return;
    seenLc.add(textLc);
    anchors.push({ text, textLc, target: (k && k.target) || null, date: (k && k.date) || null });
  };
  try { for (const k of loadKeeps(projectRoot)) addKeep(k); } catch { /* no project keeps */ }
  try { for (const k of loadGlobalKeeps(home)) addKeep(k); } catch { /* no global keeps */ }
  let hasDeathLog = false;
  try { hasDeathLog = !!(String(readDeathLog(projectRoot, FAT_BIN_NAME) || '').trim() || String(readDeathLog(projectRoot, STORE_OLD_NAME) || '').trim()); } catch { /* no bins */ }
  return { anchors, hasDeathLog };
}

// Which tombstone anchors appear (case-insensitive substring) in `text`. Empty
// registry / text -> []. The caller attaches this as an advisory `laterRemoved`
// note, never a block. Long anchors are truncated for one-line display.
export function matchTombstones(text, tombstones, counter = null) {
  const anchors = tombstones && Array.isArray(tombstones.anchors) ? tombstones.anchors : [];
  const hay = String(text || '').toLowerCase();
  if (!anchors.length || !hay) return [];
  // The window is indexed once, and only when enough anchors read it to repay the build; an anchor shorter than the prefix length takes includes().
  const useIndex = anchors.length >= INDEX_MIN_NEEDLES;
  let index = null;
  const hits = [];
  for (const a of anchors) {
    if (useIndex && a.textLc && a.textLc.length >= PREFIX_K && !index) index = buildPrefixIndex(hay, PREFIX_K, counter);
    if (a.textLc && hasNeedle(index, hay, a.textLc, counter)) {
      // identity keys the maps that collect hits: two anchors can share their printed label, never their full text, target and date together
      hits.push({ anchor: a.text.length > 80 ? `${a.text.slice(0, 77)}...` : a.text, identity: JSON.stringify([a.textLc, a.target, a.date]), target: a.target, date: a.date });
    }
  }
  return hits;
}

// A file is scanned in windows of this many bytes, so no text is ever built from more than one window at a time.
export const TOMBSTONE_WINDOW_BYTES = 8 * 1024 * 1024;
// Scan a buffer for tombstone anchors window by window. Windows overlap by enough bytes that any anchor no longer than the overlap lies
// whole inside one window; the last window always reaches the end of the buffer, so every byte is covered. Returns { hits, windows }.
export function scanBufferForTombstones(buf, tombstones, windowBytes = TOMBSTONE_WINDOW_BYTES, counter = null) {
  const anchors = tombstones && Array.isArray(tombstones.anchors) ? tombstones.anchors : [];
  const longest = anchors.reduce((n, a) => Math.max(n, a.textLc ? a.textLc.length : 0), 0);
  const overlap = 3 * longest + 4; // a UTF-16 unit is at most three UTF-8 bytes; the +4 covers a surrogate pair's four bytes
  const size = Math.max(windowBytes, 2 * overlap + 1);
  const step = size - overlap;
  const found = new Map();
  let windows = 0;
  for (let start = 0; ; start += step) {
    const end = Math.min(buf.length, start + size);
    windows++;
    for (const h of matchTombstones(buf.toString('utf8', start, end), tombstones, counter)) found.set(h.identity, h);
    if (end >= buf.length) break;
  }
  return { hits: [...found.values()], windows };
}

// Case-insensitive substring match over sessionId / projectSlug /
// firstUserLine / topEntities. Reads the index only — never a transcript. When
// `tombstones` is provided (#58), a matching row is ANNOTATED with a
// `laterRemoved` advisory (the recovered wording overlaps an adjudicated/cut
// tombstone) — never dropped, never blocked.
export function searchIndex(query, { archiveDir, tombstones } = {}) {
  const q = String(query || '').toLowerCase();
  if (!q) return [];
  let text;
  try { text = fs.readFileSync(path.join(archiveDir, ESTATE_INDEX_NAME), 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const row = JSON.parse(line); if (row && typeof row === 'object') rows.push(row); } catch { continue; }
  }
  const out = [];
  for (const row of currentRows(rows)) {
    const hay = [row.sessionId, row.projectSlug, row.firstUserLine, ...(Array.isArray(row.topEntities) ? row.topEntities : [])]
      .filter((v) => typeof v === 'string').join(' ').toLowerCase();
    if (hay.includes(q)) {
      const laterRemoved = matchTombstones(hay, tombstones); // #58 advisory
      if (laterRemoved.length) row.laterRemoved = laterRemoved;
      out.push(row);
    }
  }
  return out;
}

// 29gt fire 750 (the LOW at the index append): an archived session gets one row per archive, so a session archived again had
// several rows, the earlier ones describing a copy since replaced. One row per session (keyed by sessionId and projectSlug, in file
// order): the last row is the current copy; an earlier row is kept only when a later row says it replaced that row's own copy as a
// generation (fire 772, below), and is then marked `generation: N`; any other earlier row described a copy that is a prefix of a later
// one (or is an older install's row) and is dropped. RE-TIER's dig rows (`retier: true`) and rows without a string sessionId pass through.
export function currentRows(rows) {
  const groups = new Map();
  const passthrough = [];
  rows.forEach((row, i) => {
    if (row.retier === true || typeof row.sessionId !== 'string') { passthrough.push([i, row]); return; }
    const key = `${row.sessionId}\u0000${typeof row.projectSlug === 'string' ? row.projectSlug : ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push([i, row]);
  });
  const keep = [...passthrough];
  // 29he fire 772 (CodeRabbit t335 F4): an earlier row is marked `generation: N` only when a later row that replaced generation N names
  // this row's own transcript copy (`replacedTranscriptGzSha256` equal to its `transcriptGzSha256`), never because it sits just before
  // that row: a missing row would otherwise shift the label onto a row that describes a different copy. When several earlier rows name
  // the same copy, the one closest before the replacing row is marked. A row without these fields (an older install's) is not marked.
  for (const g of groups.values()) {
    const label = new Map(); // k -> N
    for (let j = 1; j < g.length; j++) {
      const r = g[j][1];
      if (!(Number.isInteger(r.replacedGeneration) && r.replacedGeneration >= 1) || typeof r.replacedTranscriptGzSha256 !== 'string') continue;
      for (let k = j - 1; k >= 0; k--) {
        if (g[k][1].transcriptGzSha256 === r.replacedTranscriptGzSha256) { if (!label.has(k)) label.set(k, r.replacedGeneration); break; }
      }
    }
    for (let k = 0; k < g.length; k++) {
      const [i, row] = g[k];
      if (k === g.length - 1) keep.push([i, row]);
      else if (label.has(k)) keep.push([i, { ...row, generation: label.get(k) }]);
      // fire 775 (INSPECT F774-2): a row written before 1.19.2 carries no transcriptGzSha256, so it cannot be matched. When the row after
      // it says it replaced a generation, that row's copy may be the one the generation holds: it is listed, unlabelled, never dropped.
      else if (typeof row.transcriptGzSha256 !== 'string' && Number.isInteger(g[k + 1][1].replacedGeneration) && g[k + 1][1].replacedGeneration >= 1) keep.push([i, row]);
    }
  }
  return keep.sort((a, b) => a[0] - b[0]).map(([, row]) => row);
}

export function searchLines(rows, { hasDeathLog = false } = {}) {
  if (!rows.length) return '[CoalWash] estate-search: no match in the archive index.';
  return rows.map((r) => {
    // 29n F470-a: every index-derived field is escaped before it is printed (a cloned repo's index reaches this line).
    const show = (v) => escapeRawControls(String(v));
    let line = `${show(r.sessionId)}  ${r.projectSlug ? show(r.projectSlug) : '?'}  ${r.startISO ? show(r.startISO) : '?'}..${r.endISO ? show(r.endISO) : '?'}  ${mb(r.bytes)}  ${Number.isFinite(r.msgCount) ? r.msgCount : show(r.msgCount ?? '?')} msg${r.cold ? '  [cold-deleted]' : ''}${Number.isInteger(r.generation) ? `  [earlier copy: generation ${r.generation} — estate-restore ${show(r.sessionId)} --generation ${r.generation}]` : ''}\n    ${escapeRawControls(String(r.firstUserLine || '').slice(0, 160)) || '(no first user line)'}`;
    if (Array.isArray(r.laterRemoved) && r.laterRemoved.length) line += `\n    ${tombstoneSignal(r.laterRemoved, hasDeathLog)}`;
    return line;
  }).join('\n');
}

// The #58 per-result advisory line (program-built — the fixed-template
// discipline). Names the adjudicated anchor(s) + the registry to check; frames
// it as "verify against the CURRENT store", never a bare "was removed".
// 29n F472-1: the one renderer for the keep names a result cites (estate-search and estate-restore print the same line). A keep's
// anchor and date come from keeps.json (a cloned repo's file), so both are escaped before they are printed.
export function namedKeeps(hits) {
  return hits.slice(0, 2).map((h) => `"${escapeRawControls(String(h.anchor))}"${h.date ? ` (${escapeRawControls(String(h.date))})` : ''}`).join('; ');
}
function tombstoneSignal(hits, hasDeathLog) {
  const named = namedKeeps(hits);
  const more = hits.length > 2 ? ` +${hits.length - 2} more` : '';
  const deathNote = hasDeathLog ? ' + destroyed records in the bin death-log' : '';
  return `⚠ later-removed? this recovered wording matches a gate-adjudicated keep${hits.length > 1 ? 's' : ''}: ${named}${more} — the live store may have since removed/changed it; VERIFY against the current store before treating this archived copy as current fact (see keeps.json${deathNote}).`;
}

// Bare-name allowlist — tailings.mjs's F1 rule verbatim: a session id is a flat
// program-generated name; any traversal shape is a clean not-found.
export function isBareId(id) {
  return typeof id === 'string' && !!id && id !== '.' && id !== '..' && path.basename(id) === id;
}

// CWK-162 (AI Deep Scan B6): the restore inflated a gzip into ONE buffer with no output limit (a 130,478-byte file expanded to
// 134,217,728 bytes, 1029:1) and read the compressed file whole. The inflate is now bounded by max(FLOOR, ratio x compressed size),
// never above CEIL, and the compressed file itself is capped. Measured on this box's real archives (read-only probe, n=9,
// 2026-10-02): ratio min 2.1, median 2.3, max 3.1; the largest inflated file 49,544,480 bytes (~24 MB compressed). So the ratio
// bound of 64 leaves 20x headroom over the largest ratio seen; the floor of 64 MiB means a small archive is never refused for
// being highly redundant; the ceiling of 1 GiB is 20x the largest real session; and 256 MiB is ~10x the largest compressed
// file. A zip bomb (1000:1 and up) is refused by the ratio term, a huge-but-honest session by neither.
export const RESTORE_FLOOR_BYTES = 64 * 1024 * 1024;
export const RESTORE_MAX_RATIO = 64;
export const RESTORE_CEIL_BYTES = 1024 * 1024 * 1024;
// 29bs fire 590 §3: the whole session's inflated bytes, not only one file's. A session of many files each under RESTORE_CEIL_BYTES
// could otherwise inflate without end. The session bound is this constant; the per-file floor is not added to it, so a session of
// several compressible files is not refused for the sum of floors it never needed. A session of ordinary size never meets it.
export const RESTORE_SESSION_CEIL_BYTES = 4 * 1024 * 1024 * 1024;
export const RESTORE_MAX_GZ_BYTES = 256 * 1024 * 1024;
// The restore bounds in one object. restoreSession refuses on them, and archiveSession asks restoreBoundReason before it deletes, so the two
// sides read one set of numbers. The `bounds` option of both functions is the test seam; the default is this object.
export const RESTORE_BOUNDS = Object.freeze({
  maxGzBytes: RESTORE_MAX_GZ_BYTES,
  floorBytes: RESTORE_FLOOR_BYTES,
  maxRatio: RESTORE_MAX_RATIO,
  ceilBytes: RESTORE_CEIL_BYTES,
  sessionCeilBytes: RESTORE_SESSION_CEIL_BYTES,
});
export function restoreInflateBoundWith(gzBytes, b = RESTORE_BOUNDS) {
  return Math.min(b.ceilBytes, Math.max(b.floorBytes, gzBytes * b.maxRatio));
}
export function restoreInflateBound(gzBytes) {
  return restoreInflateBoundWith(gzBytes, RESTORE_BOUNDS);
}
// The one predicate. files: [{ gzBytes, inflatedBytes }] for the whole session. Returns null when a restore of these files is in bounds,
// otherwise the reason, naming the bound and the number that broke it. Restore's own refusals are the same three checks.
export function restoreBoundReason(files, b = RESTORE_BOUNDS) {
  let total = 0;
  for (const f of files) {
    if (f.gzBytes > b.maxGzBytes) return `a compressed file is ${f.gzBytes} bytes, over the ${b.maxGzBytes}-byte compressed bound`;
    const fileBound = restoreInflateBoundWith(f.gzBytes, b);
    if (f.inflatedBytes > fileBound) return `a file inflates to ${f.inflatedBytes} bytes, over its ${fileBound}-byte inflate bound`;
    total += f.inflatedBytes;
  }
  if (total > b.sessionCeilBytes) return `the session inflates to ${total} bytes in all, over the ${b.sessionCeilBytes}-byte session bound`;
  return null;
}

// One compressed archive file read through ONE handle (R15, CodeQL #47/#50): open, judge the handle, read what it reported and nothing more.
// Returns { buf } | { notFile: true } | { over: <bytes> } | { grew: <bytes the handle reported> } | { shrank: <bytes the handle reported> }.
// The open itself throws as statSync and readFileSync did (ENOENT, EACCES ...), and the caller's catch reports it. A file that GREW is
// caught by a probe read of the byte after the reported end; one that SHRANK (a read ended before the reported end) returns { shrank },
// never a shorter buffer (29jo fire 849, INSPECT 818 L818-2): both changed while they were read. The index repair's read of a kept
// generation names either one; the re-archive's read of the earlier copy (priorArchive), restore and readStaged refuse either one;
// readGenerationRefusals reports either one as "changed while it was read". The index repair's read of the CURRENT archived copy names
// a shrunk one, but still skips a grown one with no reason given (no row, so the next run reads it again).
const ARCHIVE_READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0); // O_NONBLOCK: a FIFO swapped in cannot hang the open
function readArchiveHandle(gzPath, bound) {
  const fd = fs.openSync(gzPath, ARCHIVE_READ_FLAGS);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { notFile: true };
    if (st.size > bound) return { over: st.size };
    const want = st.size;
    const buf = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const n = fs.readSync(fd, buf, got, want - got, got);
      if (n === 0) break;
      got += n;
    }
    if (got === want && fs.readSync(fd, Buffer.alloc(1), 0, 1, got) > 0) return { grew: want };
    return got === want ? { buf } : { shrank: want };
  } finally { try { fs.closeSync(fd); } catch { /* already closed */ } }
}

// Decompress ONE archived session's files to `to` (default: a fresh scratch
// dir under os.tmpdir(), printed to the caller) — RESTORE-BY-REFERENCE: code
// moves the byte-exact bytes; content is never re-authored. NEVER writes into
// CC's live tree unless an explicit --to points there (the default tmpdir
// guarantees it). Scans the archive dir itself (not the index), so a session
// archived without an index row still restores.
// 29gt fire 750: `generation` (an integer >= 1) restores that kept generation; absent, the newest copy. A refused restore that made
// its own default folder removes it again when nothing was written into it (a narrow, non-recursive delete of that one folder).
// B6 (29oy fire 947): the `.gz` copies under a session's archive folder, walked with the same per-path containment as the other estate
// walks: a child swapped for a link after the listing is never followed, so an outside `.gz` never becomes a restore source.
// Row 16 (29pt fire 963): `sidHeld` holds <archive>/<slug>/<sid>/ itself, hand-joined; a string is the slug folder's root and the
// session folder is held below it by its own name.
function restoreSourcesUnder(sessDir, relBase0, sidHeld = heldAsChild(sessDir)) {
  const out = [];
  const h = typeof sidHeld === 'string' ? heldUnder(sidHeld, path.basename(sessDir)) : sidHeld;
  if (!inHeld(h, sessDir)) return out;
  const collect = (dir, relBase) => {
    let subs;
    try { subs = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const s of subs) {
      const p = path.join(dir, s.name);
      if (!inHeld(h, p)) continue;
      if (s.isDirectory()) collect(p, path.join(relBase, s.name));
      else if (s.isFile() && s.name.endsWith('.gz')) out.push({ gzPath: p, rel: path.join(relBase, s.name.slice(0, -3)) });
    }
  };
  collect(sessDir, relBase0);
  return out;
}
// Test-only: the estate walks, reached directly by the reader-class tests (29oy fire 947). Not part of the module's contract.
export const __walkTestHooks = Object.freeze({ sessionGenerations, collectStagedLeftovers, listAsides, pruneEmptyDirs, restoreSourcesUnder });
export function restoreSession(sessionId, opts = {}) {
  const r = restoreSessionInner(sessionId, opts);
  if (!r.ok && !opts.to && r.dir && Array.isArray(r.files) && r.files.length === 0 && dropEmptyDefaultTarget(r.dir)) {
    const { dir: _dropped, ...rest } = r;
    return rest;
  }
  return r;
}
function dropEmptyDefaultTarget(dir) {
  try {
    const tmp = fs.realpathSync.native(os.tmpdir());
    const real = fs.realpathSync.native(dir);
    if (path.dirname(real) !== tmp || !path.basename(real).startsWith('coalwash-estate-')) return false; // only the folder this restore made
    fs.rmdirSync(real); // non-recursive: refuses a folder that holds anything
    return true;
  } catch { return false; }
}
function restoreSessionInner(sessionId, { archiveDir, to = null, generation = null, tombstones, sessionCeilBytes, bounds = RESTORE_BOUNDS, tombstoneWindowBytes = TOMBSTONE_WINDOW_BYTES } = {}) { // sessionCeilBytes and bounds: the test seams for the bounds
  const B = sessionCeilBytes === undefined ? bounds : { ...bounds, sessionCeilBytes };
  if (!isBareId(sessionId)) return { ok: false, error: `not a bare session id: '${sessionId}'` };
  if (generation !== null && generation !== undefined && !(Number.isInteger(generation) && generation >= 1)) return { ok: false, error: `--generation takes a whole number from 1 up, not '${generation}'` };
  const wantGen = generation === null || generation === undefined ? null : generation;
  let slugs;
  try { slugs = fs.readdirSync(archiveDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch {
    return { ok: false, error: `archive dir not readable: ${archiveDir}` };
  }
  let sources = []; // { gzPath, rel } — rel is the ORIGINAL rel (`.gz` stripped)
  let gens = new Map();
  // F950-1: the slug level's root is the archive root (the global config's estate.archiveDir), resolved before the listing; each slug
  // folder the listing names is checked against it, and its realpath found there is the session level's root for every entry below.
  const archPhys = physicalOrNull(archiveDir);
  for (const slug of slugs) {
    const slugDir = path.join(archiveDir, slug);
    const slugHeld = { root: archPhys, names: [slug] }; // row 17: <archive>/<slug>, hand-joined
    if (!inHeld(slugHeld, slugDir)) continue; // the slug folder was swapped for a link after the archive-root listing: never followed
    let names;
    try { names = fs.readdirSync(slugDir, { withFileTypes: true }); } catch { continue; }
    for (const d of names) {
      const p = path.join(slugDir, d.name);
      if (!inHeld(slugHeld, p)) continue; // a top-level copy or the session folder swapped for a link after the slug listing
      if (d.isFile() && (d.name === `${sessionId}.jsonl.gz` || (d.name.startsWith(`${sessionId}.`) && d.name.endsWith('.gz')))) {
        sources.push({ gzPath: p, rel: d.name.slice(0, -3) });
      } else if (d.isDirectory() && d.name === sessionId) {
        sources.push(...restoreSourcesUnder(p, sessionId, heldUnder(slugHeld, sessionId)));
      }
    }
    gens = sessionGenerations(slugDir, sessionId, slugHeld); // `*.gz.gen<N>` never matches the `.gz` collection above
    if (sources.length || gens.size) break; // a session id is unique — first slug that has it wins
  }
  const generations = [...gens.keys()].sort((a, b) => a - b);
  const genList = generations.length ? `earlier copies kept: generation ${generations.join(', ')} — restore one with --generation <N>` : 'no earlier copies are kept';
  let hasNewest = sources.length > 0;
  if (wantGen !== null) {
    if (!gens.has(wantGen)) return { ok: false, error: `generation ${wantGen} of session '${sessionId}' is not in the archive at ${archiveDir} (${genList})` };
    sources = gens.get(wantGen);
  } else if (!sources.length && generations.length) {
    return { ok: false, error: `session '${sessionId}' has no newest archived copy in ${archiveDir}; ${genList}` };
  }
  if (!sources.length) return { ok: false, error: `session '${sessionId}' not found in the archive at ${archiveDir}` };
  // 29gz fire 765 (L764-1; node/runtime.md section 9): the files are restored, written and named in code-unit order of their names, never
  // in the order the directory read returned them, which differs by volume.
  sources = [...sources].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  // 29gz fire 762 (lab F-1): a file of this copy that does not decompress is named and skipped, and every intact file is still written;
  // the restore then reports the copy as not whole. Nothing damaged is ever written out.
  const damaged = [];
  let dir = to;
  try {
    if (dir) { dir = path.resolve(dir); fs.mkdirSync(dir, { recursive: true }); }
    else dir = fs.mkdtempSync(path.join(os.tmpdir(), `coalwash-estate-${sessionId.slice(0, 8)}-`));
  } catch (e) { return { ok: false, error: `cannot create restore target: ${e.message}` }; }

  const files = [];
  // #58: scan the FULL recovered content against the tombstone registry (only
  // when a registry was passed — the CLI builds it; direct callers opt in). The
  // dig-index search is a compact-row best-effort; restore pulls real bytes, so
  // the anchor match here is thorough. One-shot recovery path, never a hot loop.
  const wantTombstoneScan = tombstones && Array.isArray(tombstones.anchors) && tombstones.anchors.length;
  // The session bound is sessionCeilBytes, fixed before the loop. Every file's inflate is capped at what the session has left, and every
  // inflated byte is taken from that remainder, so the bytes restored in one session are bounded by the same budget.
  const sessionBound = B.sessionCeilBytes;
  let remaining = sessionBound;
  // 29he fire 772 (CodeRabbit t336 F8): a refusal after the loop has started still returns and names every file it found damaged before
  // it, and says the restore stopped there, so the files after it were not restored.
  const refuse = (si, error) => {
    const after = sources.length - si - 1;
    const named = damaged.map((d) => `${d.rel}, archived at ${d.gzPath} [zlib: ${d.zlib}]`).join('; ');
    const tail = `${damaged.length ? `. Found damaged before it stopped (nothing restored from ${damaged.length === 1 ? 'it' : 'them'}): ${named}` : ''}${after ? `. The restore stopped at ${sources[si].rel}, so the ${after} file(s) after it were not restored` : ''}`;
    return { ok: false, error: `${error}${tail}`, dir, files, ...(damaged.length ? { damaged } : {}) };
  };
  const tombFound = new Map(); // anchor identity -> hit, collected across every window of every file; no concatenated text is ever built
  let tombBytes = 0;
  for (const [si, s] of sources.entries()) {
    try {
      // CWK-162 B3: every directory component BELOW the destination root must be a real directory. A link planted at <to>/<sid>
      // (or deeper) used to carry the restored bytes outside the destination with ok:true; an explicit `--to` is the exposed
      // door (the default is a fresh mkdtemp dir). The root itself may be a link (the user's own choice); only what sits under it
      // is checked. A refusal reads "... is a link" (ownSandboxDir) and stops the restore: files already written stay, as before.
      const relDir = path.dirname(s.rel);
      try { ownSandboxDir(dir, ...(relDir === '.' ? [] : relDir.split(path.sep))); } catch (e) {
        if (e && e.code === 'COALWASH_WRITE_REFUSED') return refuse(si, `restore refused on ${s.rel}: ${String(e.message).split(' -- ')[0]} (a restore never writes through a link under its destination)`);
        throw e;
      }
      // R15 (CodeQL #47/#50 js/file-system-race; supersedes R14 NIT 3's after-the-fact length check): the archive is OPENED first, its kind and size
      // are judged on the HANDLE, and only that many bytes (plus one probe byte) are read through it. The path is looked up once, so what is
      // bounded is what is read, with no window between a stat and a read.
      const got = readArchiveHandle(s.gzPath, B.maxGzBytes);
      if (got.notFile) return refuse(si, `restore refused on ${s.rel}: the archive entry is not a regular file`);
      if (got.over !== undefined) return refuse(si, `restore refused on ${s.rel}: the compressed file is ${got.over} bytes, over the ${B.maxGzBytes}-byte bound`);
      if (got.grew !== undefined) return refuse(si, `restore refused on ${s.rel}: the compressed file is longer than the ${got.grew} bytes its handle reported (it grew after its size was read)`);
      if (got.shrank !== undefined) return refuse(si, `restore refused on ${s.rel}: the compressed file is shorter than the ${got.shrank} bytes its handle reported (it shrank after its size was read)`);
      const gz = got.buf;
      const fileBound = restoreInflateBoundWith(gz.length, B);
      let buf;
      // zlib refuses a bound of 0, so a session already at its ceiling inflates at most one byte, and the size check below decides
      try { buf = zlib.gunzipSync(gz, { maxOutputLength: Math.max(1, Math.min(fileBound, remaining)) }); } catch (e) {
        if (e && e.code === 'ERR_BUFFER_TOO_LARGE') {
          return refuse(si, remaining < fileBound
            ? `restore refused on ${s.rel}: it would pass the ${sessionBound}-byte session bound (the whole session's inflated bytes; the files already written stay)`
            : `restore refused on ${s.rel}: it would inflate past ${fileBound} bytes for a ${gz.length}-byte archive`);
        }
        // 29gt fire 750: a damaged archive says so in plain words; zlib's own text follows in brackets, never alone.
        if (e && typeof e.code === 'string' && e.code.startsWith('Z_')) { damaged.push({ rel: s.rel, gzPath: s.gzPath, zlib: e.message }); continue; }
        throw e;
      }
      if (buf.length > remaining) return refuse(si, `restore refused on ${s.rel}: it would pass the ${sessionBound}-byte session bound (the whole session's inflated bytes; the files already written stay)`);
      remaining -= buf.length;
      const dest = path.join(dir, s.rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      // fire 67 (PR #18, r4231603560): the FINAL path is checked too. A link already there (a symlink, dangling or not, or a junction) or
      // a file with a second hard link is refused and left in place; nothing absent or an ordinary single-link file behaves as before.
      let st = null;
      try { st = fs.lstatSync(dest); } catch (e) { if (!e || e.code !== 'ENOENT') throw e; }
      if (st && st.isSymbolicLink()) return refuse(si, `restore refused on ${s.rel}: the destination file is a link (a restore never writes through a link under its destination)`);
      if (st && (!st.isFile() || st.nlink > 1)) return refuse(si, `restore refused on ${s.rel}: the destination entry is not a single-link regular file (a restore never writes through a link under its destination)`);
      writeDurable(dest, buf, fileModeOr600(dest)); // 29n F470-f: a restored file keeps its own mode, 0600 when it is new. MED: recovery write matches the forward path's durability (this tier keeps no snapshot)
      fsyncDirBestEffort(path.dirname(dest));
      files.push({ rel: s.rel, bytes: buf.length });
      if (wantTombstoneScan) {
        const scan = scanBufferForTombstones(buf, tombstones, tombstoneWindowBytes);
        tombBytes += buf.length;
        for (const h of scan.hits) tombFound.set(h.identity, h);
      }
    } catch (e) { return refuse(si, `restore failed on ${s.rel}: ${e.message}`); }
  }
  if (damaged.length) {
    const others = generations.filter((n) => n !== wantGen);
    const tries = [];
    if (wantGen !== null && hasNewest) tries.push('restore the newest copy without --generation');
    if (others.length) tries.push(`restore another kept copy with --generation <N> (kept: generation ${others.join(', ')})`);
    tries.push(`decompress the damaged archived file${damaged.length === 1 ? '' : 's'} named above with any gunzip tool, which may still recover part of ${damaged.length === 1 ? 'it' : 'them'}`);
    tries.push('use a backup of the archive folder');
    const what = wantGen !== null ? `generation ${wantGen} is damaged` : 'the archived copy is damaged';
    const named = damaged.map((d) => `${d.rel}, archived at ${d.gzPath} [zlib: ${d.zlib}]`).join('; ');
    const head = files.length
      ? `restore incomplete: ${what} in ${damaged.length} of ${damaged.length + files.length} file(s) (it does not decompress), so nothing was restored from ${damaged.length === 1 ? 'that file' : 'those files'}; the ${files.length} intact file(s) were written`
      : `restore refused on ${damaged[0].rel}: ${what} (it does not decompress), so nothing was restored from it`;
    return { ok: false, error: `${head}. Damaged: ${named}. To get the session back: ${tries.join('; or ')}.`, dir, files, damaged, generation: wantGen, generations };
  }
  const laterRemoved = wantTombstoneScan ? [...tombFound.values()] : [];
  // The scan result says what it covered: every byte of every restored file, in windows, with none skipped.
  return { ok: true, dir, files, generation: wantGen, generations, ...(laterRemoved.length ? { laterRemoved } : {}), ...(wantTombstoneScan ? { tombstoneScan: { bytes: tombBytes } } : {}) };
}
