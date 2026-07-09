// caliper.mjs — footprint measurement + the 4-band verdict + the economic
// break-even math (session amendment 2026-07-08, supersedes the blueprint §4
// info-only full-signal).
//
// Bands ride Memory-BMI = footprint / leanFloor (floor-relative, so legitimate
// MEAT growth never false-fires — only FAT above the floor moves the band):
//   LEAN  (< PLUMP_BMI)          -> silent
//   PLUMP (PLUMP_BMI..OBESE_BMI) -> ask via question-box; decline = snooze
//   OBESE (>= OBESE_BMI, below FULL) -> strong-ask, shorter snooze
//   FULL  -> economic force-run of the PROCESS (deletes stay human-gated at
//         the outer gate, always)
// GROWABLE-FULL (beta.7, the USER's three-layer invariant — MEMORY.md "THE
// CALIBRATION FINDING"): post-floor, FULL is judged on ABSOLUTE fat above the
// MEASURED floor (footprint > leanFloor + FAT_BUDGET_TOKENS), never on the raw
// BMI ratio — a legitimately large, all-muscle floor must never false-fire no
// matter how big it grows (LEAN/PLUMP/OBESE stay ratio-based, unchanged). Only
// the machine's hard capacity gate (fullPercent x CAPACITY_TOKENS) is
// person-independent and applies regardless of floor state; firing it with
// ~no fat to reclaim (all-muscle over capacity) gets the DIFFERENT
// 'externalize' verdict — washing cannot shrink muscle, only splitting/
// archiving can. Pre-floor (bootstrap, no clean yet) keeps the original
// absolute-cap-only heuristic — it correctly drove the first real clean.
// FULL's economic force fires ONLY on the deterministic break-even proof (the
// series' one named consent exception, "economic-dominance" — AGENTS.md): the
// numbers are computed in CODE and SHOWN every time.
//
// Token counts are ESTIMATES (chars heuristic: ~4 chars/token ASCII, ~1.5
// chars/token non-ASCII) — always label them "~est"; bytes/chars are the
// deterministic, reproducible measures.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { claudeBaseDir } from './config-load.mjs';
import { parseJsonc } from './jsonc.mjs';

// ---------------------------------------------------------------------------
// constants — PLACEHOLDERS, calibrate at the fidelity benchmark (2026-07-08
// amendment: "Numbers = placeholder constants in code, calibrate at benchmark")
// ---------------------------------------------------------------------------
export const PLUMP_BMI = 1.3;
export const OBESE_BMI = 1.6;
// Growable-full (beta.7 #1): the absolute fat allowed above a MEASURED floor
// before FULL fires, replacing the old ratio-based FULL_BMI(2.0) rung — a
// benchmark-calibrated placeholder from the first real dogfood clean (a
// healthy store carried ~1-2k tok of fat on a ~29k floor); budgeted a little
// above that observed range.
export const FAT_BUDGET_TOKENS = 4000;
// Rough placeholder for the session's usable per-turn window — NOT a verified
// per-model capacity claim (Claude sessions run anywhere from a 200k standard
// to a 1M-token beta ceiling depending on tier/org; never silently assert
// either as given). Recalibrated 2026-07-09 off the first real dogfood run (a
// healthy ~29k-tok floor and a ~44k-tok bootstrap footprint both needed
// headroom the stale 200k-era guess didn't give, which would otherwise false-
// FULL on plain muscle forever). Still a fuzzy placeholder by design
// (blueprint §5 — capacity is inherently approximate); refine later via a
// per-platform capacity probe, never by guessing higher again.
export const CAPACITY_TOKENS = 600000;
export const CC_INDEX_CAP_BYTES = 25 * 1024; // CC memory-index platform cap class (25KB)
export const CC_INDEX_CAP_LINES = 200; // CC memory-index platform cap class (200 lines)
export const RUN_COST_MULTIPLIER = 3; // one Full run ~ store read x2 (outsider+insider) + rewrite
export const ECON_HORIZON_DAYS = 14; // carry-cost horizon the break-even is judged against
export const PLUMP_SNOOZE_DAYS = 7;
export const OBESE_SNOOZE_DAYS = 2;
export const STAMP_RING_MAX = 60; // per-project session-stamp ring buffer cap
const DAY_MS = 86400000;

// ---------------------------------------------------------------------------
// measurement
// ---------------------------------------------------------------------------

// ~est token count from text: ASCII ~4 chars/token, non-ASCII ~1.5 chars/token.
export function tokensEst(text) {
  const s = String(text);
  let ascii = 0;
  let non = 0;
  for (let i = 0; i < s.length; i++) (s.charCodeAt(i) < 128 ? ascii++ : non++);
  return Math.round(ascii / 4 + non / 1.5);
}

// ~est token count from a byte size alone (ASCII assumption — used when the
// content is deliberately not read, e.g. the recall store on the hook path).
export function tokensEstFromBytes(bytes) {
  return Math.round(bytes / 4);
}

// gzip ratio (compressed/raw, 0..1] — a cheap redundancy proxy: LOW = highly
// compressible = repetitive content (a fat signal). Purely informational.
export function gzipRatio(text) {
  const buf = Buffer.from(String(text), 'utf8');
  if (!buf.length) return 1;
  return zlib.gzipSync(buf).length / buf.length;
}

// Measure a discovered class-B entry set. Reads content ONLY for always-loaded
// entries (small by definition) up to `readBudgetBytes`; recall entries are
// sized from stat bytes (deterministic) with the ASCII token heuristic.
export function measureEntries(entries, { readBudgetBytes = 262144, withGzip = false } = {}) {
  const m = {
    files: entries.length,
    totalBytes: 0,
    totalTokensEst: 0,
    alwaysLoaded: { files: 0, bytes: 0, tokensEst: 0 },
    index: { bytes: 0, lines: 0 },
    gzipRatio: null,
    est: true, // token numbers are estimates — receipt must label "~est"
  };
  let readSoFar = 0;
  const gzParts = [];
  for (const e of entries) {
    m.totalBytes += e.bytes;
    let tok = tokensEstFromBytes(e.bytes);
    if (e.alwaysLoaded) {
      m.alwaysLoaded.files++;
      m.alwaysLoaded.bytes += e.bytes;
      if (readSoFar + e.bytes <= readBudgetBytes) {
        try {
          const text = fs.readFileSync(e.path, 'utf8');
          readSoFar += e.bytes;
          tok = tokensEst(text);
          if (withGzip) gzParts.push(text);
          if (e.kind === 'memory-index') {
            m.index.bytes = e.bytes;
            m.index.lines = text.split('\n').length;
          }
        } catch { /* stat-based estimate stands */ }
      } else if (e.kind === 'memory-index') {
        m.index.bytes = e.bytes;
      }
      m.alwaysLoaded.tokensEst += tok;
    }
    m.totalTokensEst += tok;
  }
  if (withGzip && gzParts.length) {
    try { m.gzipRatio = Number(gzipRatio(gzParts.join('\n')).toFixed(3)); } catch { /* informational only */ }
  }
  return m;
}

// ---------------------------------------------------------------------------
// band verdict
// ---------------------------------------------------------------------------

export function bandVerdict({
  footprintTokens,
  leanFloorTokens = 0,
  capacityTokens = CAPACITY_TOKENS,
  fullPercent = 6,
  indexBytes = 0,
  indexLines = 0,
} = {}) {
  const hardCeilingTokens = Math.round(capacityTokens * (fullPercent / 100));
  const capHit =
    footprintTokens >= hardCeilingTokens ||
    indexBytes >= CC_INDEX_CAP_BYTES ||
    indexLines >= CC_INDEX_CAP_LINES;
  const bmi = leanFloorTokens > 0 ? footprintTokens / leanFloorTokens : null;

  if (bmi === null) {
    // Bootstrap (pre-floor): unchanged absolute-cap-only heuristic — it
    // correctly drove the first real clean (beta.6). BMI/fat-budget bands
    // wake up only after a full clean stamps a floor.
    if (capHit) return { band: 'FULL', reason: 'absolute-cap', bmi, hardCeilingTokens };
    return { band: 'LEAN', reason: 'no-floor-yet', bmi, hardCeilingTokens };
  }

  // Post-floor (growable-full): FULL is judged on FAT above the MEASURED
  // floor, never the raw ratio, so a legitimately large floor never
  // false-fires no matter how big it grows. The machine's hard capacity gate
  // still applies — it is the one PERSON-independent ceiling — but hitting it
  // with ~no fat to reclaim (all-muscle over capacity) gets DIFFERENT advice:
  // externalize, never "wash harder" (a wash cannot shrink muscle).
  const fatTokens = Math.max(0, footprintTokens - leanFloorTokens);
  if (capHit) {
    return fatTokens <= FAT_BUDGET_TOKENS
      ? { band: 'FULL', reason: 'externalize', bmi, hardCeilingTokens }
      : { band: 'FULL', reason: 'absolute-cap', bmi, hardCeilingTokens };
  }
  if (fatTokens > FAT_BUDGET_TOKENS) return { band: 'FULL', reason: 'fat-budget', bmi, hardCeilingTokens };
  if (bmi >= OBESE_BMI) return { band: 'OBESE', reason: 'bmi', bmi, hardCeilingTokens };
  if (bmi >= PLUMP_BMI) return { band: 'PLUMP', reason: 'bmi', bmi, hardCeilingTokens };
  return { band: 'LEAN', reason: 'bmi', bmi, hardCeilingTokens };
}

// ---------------------------------------------------------------------------
// economic break-even (deterministic — CODE computes, numbers are SHOWN)
// ---------------------------------------------------------------------------

// cost(one CW run) vs cost(carrying the fat over the horizon).
// economical === true is the ONLY thing that may arm the FULL force-run.
export function breakEven({
  footprintTokens,
  leanFloorTokens = 0,
  totalStoreTokens = 0,
  sessionsPerDay = 1,
  horizonDays = ECON_HORIZON_DAYS,
} = {}) {
  const fatTokens = Math.max(0, Math.round(footprintTokens - leanFloorTokens));
  const perDay = Math.round(fatTokens * sessionsPerDay);
  const runCostTokens = Math.round(Math.max(totalStoreTokens, footprintTokens) * RUN_COST_MULTIPLIER);
  const horizonCarryTokens = perDay * horizonDays;
  const breakEvenDays = perDay > 0 ? runCostTokens / perDay : Infinity;
  return {
    fatTokens,
    perDay,
    runCostTokens,
    horizonCarryTokens,
    horizonDays,
    breakEvenDays,
    economical: horizonCarryTokens > runCostTokens,
    // leanFloor 0 = never-cleaned store: "fat" is then the WHOLE footprint,
    // an UPPER BOUND, not a measured excess — shown figures must say so.
    floorUnmeasured: leanFloorTokens <= 0,
  };
}

// Sessions/day from the stamp ring (deterministic given stamps). < 2 stamps ->
// 1/day (conservative bootstrap). Clamped to [0.1, 20] against degenerate spans.
export function sessionsPerDay(stamps, now = Date.now()) {
  if (!Array.isArray(stamps) || stamps.length < 2) return 1;
  const ts = stamps.map((s) => s.t).filter((t) => Number.isFinite(t));
  if (ts.length < 2) return 1;
  const spanDays = Math.max((now - Math.min(...ts)) / DAY_MS, 1);
  const rate = ts.length / spanDays;
  return Math.min(20, Math.max(0.1, rate));
}

// ---------------------------------------------------------------------------
// state (lean floor + stamp history + snooze) — one file under ~/.claude
// (sandbox-sanctioned config area), keyed by project root. Atomic writes,
// fail-silent: state loss degrades to bootstrap behavior, never misbehaves.
// ---------------------------------------------------------------------------

export function statePath(home = os.homedir()) {
  return path.join(claudeBaseDir(home), '.coalwash-state.json');
}

export function loadState(home = os.homedir()) {
  try {
    let raw = fs.readFileSync(statePath(home), 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const parsed = parseJsonc(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveState(state, home) {
  try {
    const p = statePath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, p);
    return true;
  } catch {
    return false;
  }
}

function projKey(projectRoot) {
  return path.resolve(projectRoot);
}

export function projectState(state, projectRoot) {
  const projects = state.projects || {};
  return projects[projKey(projectRoot)] || {};
}

// State-file orphan prune (#21): a project whose path no longer exists on disk
// is dropped from the tracking map before the next write. Runs lazily inside
// every state WRITE below (fail-silent, no new config key — "a dead path is
// never 'this project'"). Deletes ONLY entries in the state file's OWN
// projects map — never anything on disk beyond the existsSync stat (the
// recovery-paths lesson: a mutating path must never do more than it says). A
// transiently-missing path (an offline drive) is dropped harmlessly; the
// project self-heals by re-stamping the next time it runs a session.
function pruneOrphans(state) {
  const projects = state && state.projects;
  if (!projects || typeof projects !== 'object') return state;
  for (const key of Object.keys(projects)) {
    let exists;
    try { exists = fs.existsSync(key); } catch { exists = true; } // stat doubt -> keep (never drop on doubt)
    if (!exists) delete projects[key];
  }
  return state;
}

// Append a session stamp {t, fp} (ring-capped) and return the updated project
// state. Fail-silent: on any write failure the in-memory view is still returned.
export function recordStamp(home, projectRoot, footprintTokens, now = Date.now()) {
  const state = pruneOrphans(loadState(home));
  state.projects = state.projects || {};
  const key = projKey(projectRoot);
  const proj = state.projects[key] || {};
  proj.stamps = Array.isArray(proj.stamps) ? proj.stamps : [];
  proj.stamps.push({ t: now, fp: Math.round(footprintTokens) });
  if (proj.stamps.length > STAMP_RING_MAX) proj.stamps = proj.stamps.slice(-STAMP_RING_MAX);
  state.projects[key] = proj;
  saveState(state, home);
  return proj;
}

// Stamp the lean floor (the post-clean footprint — call ONLY after a full clean
// whose fidelity gate passed, else uncleaned fat contaminates the floor).
export function setLeanFloor(home, projectRoot, tokens, now = Date.now()) {
  const state = pruneOrphans(loadState(home));
  state.projects = state.projects || {};
  const key = projKey(projectRoot);
  const proj = state.projects[key] || {};
  proj.leanFloorTokens = Math.round(tokens);
  proj.leanFloorAt = now;
  state.projects[key] = proj;
  return saveState(state, home);
}

// A stored leanFloorTokens that is non-finite/non-positive, OR that GROSSLY
// exceeds the CURRENTLY measured footprint, is discarded rather than trusted
// (the #1 poison point: this one persisted value distorts bmi/breakEven for
// every session downstream, silently, until a real clean overwrites it — which
// itself may never arm while the poisoned value keeps bmi looking artificially
// LEAN). Any doubt collapses to 0 (the existing "floor-unmeasured, whole
// footprint is an upper bound" path) — never throws, never trusts the raw
// value. Fail direction is conservative: this can only WIDEN the alert surface
// (false-PLUMP/OBESE/FULL is acceptable), never hide real fat (false-LEAN is not).
export const LEAN_FLOOR_MAX_MULTIPLE = 10;
export function sanitizeLeanFloor(rawLeanFloorTokens, footprintTokens) {
  const floor = Number(rawLeanFloorTokens);
  if (!Number.isFinite(floor) || floor <= 0) return 0;
  const fp = Number(footprintTokens);
  if (Number.isFinite(fp) && fp > 0 && floor > fp * LEAN_FLOOR_MAX_MULTIPLE) return 0;
  return floor;
}

// Snooze the band nudge until `untilMs` (a declined/emitted PLUMP or OBESE ask
// self-throttles — the nudge fires at most once per snooze window).
export function setSnooze(home, projectRoot, untilMs) {
  const state = pruneOrphans(loadState(home));
  state.projects = state.projects || {};
  const key = projKey(projectRoot);
  const proj = state.projects[key] || {};
  proj.snoozeUntil = untilMs;
  state.projects[key] = proj;
  return saveState(state, home);
}

// ---------------------------------------------------------------------------
// cached verdict (built at beta.8 #2 for the since-retired UserPromptSubmit
// hot path; beta.10 REPOINTS it at the Stop hook instead — the storage and
// sanitization stay exactly as they were, only the reader changed).
// SessionStart already computes the 4-band verdict; recordVerdict stores just
// enough of it so the Stop conductor branch (Phoenix #3: no discovery/
// measureEntries there) can decide whether to fire the FULL force directive
// from a single state read, never re-measuring the store itself.
// ---------------------------------------------------------------------------

// A cached verdict older than this is never trusted (silent) — the next
// SessionStart always refreshes it, so staleness can only ever WIDEN the
// silent side, never force a stale nag past one day.
export const VERDICT_MAX_AGE_MS = DAY_MS;

// Record the SessionStart-computed verdict. Called every time a verdict is
// computed (whatever the band), so a store that goes LEAN this session
// overwrites a stale FULL left by a prior one immediately, not just eventually.
export function recordVerdict(home, projectRoot, verdict, now = Date.now()) {
  const state = pruneOrphans(loadState(home));
  state.projects = state.projects || {};
  const key = projKey(projectRoot);
  const proj = state.projects[key] || {};
  proj.lastVerdict = {
    band: String((verdict && verdict.band) || ''),
    reason: String((verdict && verdict.reason) || ''),
    economical: !!(verdict && verdict.economical),
    fatTokens: Number.isFinite(verdict && verdict.fatTokens) ? Math.round(verdict.fatTokens) : 0,
    at: now,
  };
  state.projects[key] = proj;
  return saveState(state, home);
}

// Sanitize a project's cached lastVerdict for the Stop hot path: any doubt —
// a malformed shape, a non-finite/future/stale timestamp, or any
// band/economical combination other than the ONE case the force case exists
// for (FULL + economical, the armed force-run) — collapses to null (silent).
// Mirrors sanitizeLeanFloor's "any doubt -> the safe default" rule, but here
// silence IS the safe default: a missed nag self-corrects at the next
// SessionStart, while a false nag would otherwise repeat every turn on stale
// or corrupt data.
export function sanitizeVerdict(rawVerdict, now = Date.now(), maxAgeMs = VERDICT_MAX_AGE_MS) {
  if (!rawVerdict || typeof rawVerdict !== 'object') return null;
  const at = Number(rawVerdict.at);
  if (!Number.isFinite(at) || at > now || now - at > maxAgeMs) return null;
  if (rawVerdict.band !== 'FULL' || rawVerdict.economical !== true) return null;
  const fatTokens = Number(rawVerdict.fatTokens);
  return { band: 'FULL', reason: String(rawVerdict.reason || ''), fatTokens: Number.isFinite(fatTokens) ? fatTokens : 0, at };
}

// ---------------------------------------------------------------------------
// edge-crossing state (beta.10 — MEMORY.md "NORMAL-MODE ASK REDESIGN: ONCE-
// TIME EDGES"). Retires the beta.8/9 per-turn UserPromptSubmit bar (a REQUEST
// channel a busy agent proved able to ignore, "ROUND 4 POSTMORTEM") in favor
// of the Stop hook's BLOCKING channel: instead of nagging every turn, the ask
// fires ONCE per RISE across a band ceiling, then stays silent until the next
// rise. Bands rank LEAN < PLUMP < OBESE < FULL; a rise (new rank > previous
// rank) arms an unconsumed crossing at the new (highest) band reached. This
// also covers the "qualifying past" case: a project with no verdict on record
// yet defaults its previous rank to LEAN(0), so a first-ever scan that already
// lands above LEAN fires immediately, first opportunity, same as a live rise
// (the Modloader-shaped case). A same-or-falling band does nothing — an
// existing pending crossing, if any, is left exactly as it is (never
// re-armed; two SessionStarts at the same band are ONE crossing, not two).
// LEAN clears any pending crossing outright: the store is clean, nothing left
// to ask about.
// ---------------------------------------------------------------------------
export const BAND_RANK = { LEAN: 0, PLUMP: 1, OBESE: 2, FULL: 3 };

// Called every SessionStart alongside recordVerdict, comparing the NEW band
// against the band on record from BEFORE this session's recordVerdict call
// (the caller reads it off the pre-overwrite proj.lastVerdict.band).
export function recordCrossing(home, projectRoot, newBand, prevBand, now = Date.now()) {
  const state = pruneOrphans(loadState(home));
  state.projects = state.projects || {};
  const key = projKey(projectRoot);
  const proj = state.projects[key] || {};
  if (newBand === 'LEAN') {
    delete proj.lastCrossing;
  } else if ((BAND_RANK[newBand] ?? 0) > (BAND_RANK[prevBand] ?? 0)) {
    proj.lastCrossing = { band: newBand, at: now, consumed: false };
  }
  state.projects[key] = proj;
  return saveState(state, home);
}

// Sanitize a project's cached lastCrossing for the Stop hot path: any doubt —
// a malformed shape, an unknown/LEAN band, a future timestamp, or an
// already-consumed crossing — collapses to null (silent), mirroring
// sanitizeVerdict's "any doubt -> the safe default" rule. No age-based
// staleness cutoff (unlike sanitizeVerdict): a crossing records a fact ("a
// rise happened at time T"), which does not go stale the way a cached
// footprint measurement does — see the ponytail note on consumeCrossing for
// why nothing here can go unconsumed forever regardless.
export function sanitizeCrossing(rawCrossing, now = Date.now()) {
  if (!rawCrossing || typeof rawCrossing !== 'object') return null;
  if (rawCrossing.consumed === true) return null;
  if (!(rawCrossing.band in BAND_RANK) || rawCrossing.band === 'LEAN') return null;
  const at = Number(rawCrossing.at);
  if (!Number.isFinite(at) || at > now) return null;
  return { band: rawCrossing.band, at };
}

// ponytail: consumption happens at EMISSION time — the Stop hook calls this
// the instant it surfaces (ask/force) a pending crossing, not on a
// downstream "the user picked X" signal. There is no CLI surface today for
// the agent to report the
// user's choice back into state, so gating consumption on one would leave a
// crossing pending indefinitely whenever the user never invokes it. This
// mirrors the EXISTING SessionStart PLUMP/OBESE self-throttle (setSnooze
// already fires at ask-EMISSION time there too, not on the answer) — one
// flock, one color within this file. Consequence: nothing can go unconsumed
// forever, so the once-considered 7-day-TTL/re-arm-once fallback is
// unnecessary and not implemented here; add a real TTL only if emission-time
// consumption proves too eager in practice (e.g. a session killed before the
// Stop hook's feedback ever reached the user).
export function consumeCrossing(home, projectRoot, now = Date.now()) {
  const state = pruneOrphans(loadState(home));
  state.projects = state.projects || {};
  const key = projKey(projectRoot);
  const proj = state.projects[key] || {};
  if (proj.lastCrossing && typeof proj.lastCrossing === 'object') {
    proj.lastCrossing = { ...proj.lastCrossing, consumed: true, consumedAt: now };
  }
  state.projects[key] = proj;
  return saveState(state, home);
}
