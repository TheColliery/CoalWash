// caliper.mjs — footprint measurement + the ceiling verdict + the economic
// break-even math (beta.12 "THE BAND COLLAPSE" — supersedes the beta.7/beta.8
// 4-band PLUMP/OBESE/FULL(fat-budget) ladder).
//
// BAND COLLAPSE (MEMORY.md "THE BAND COLLAPSE" + "THE ONE-CEILING NUMBER" +
// the INFECTION AUDIT's "BMI goes FRACTAL" ruling — the LATEST, superseding
// statement): LEAN/PLUMP/OBESE die as SEPARATE behavior drivers. The state
// machine is BINARY — below-ceiling = silence, past-ceiling = guaranteed
// action — driven by ONE metric (Memory-BMI = footprint / leanFloor,
// floor-relative so legitimate MEAT growth never false-fires) and ONE
// ceiling, HYSTERESIS-gated (a Schmitt trigger, replacing the old time-based
// snooze as the anti-flapping guard — BMI-only, never a clock):
//   armed OFF -> ON  requires bmi >= CEILING_BMI   (the high-water mark)
//   armed ON  -> OFF requires bmi <= CEILING_REARM_BMI (the low-water mark)
//   the dead zone between the two marks holds whatever state it already had.
// Bands returned: LEAN (silent) · OBESE (ceiling armed — a wash is due) ·
// FULL (the SEPARATE, person-independent machine-capacity line: fullPercent x
// CAPACITY_TOKENS, or the CC index-byte/line caps). FULL's reason is
// 'absolute-cap' (BMI is also over the ceiling — real fat to reclaim, wash
// first) or 'externalize' (BMI is under the ceiling — ~all muscle; washing
// cannot help, advise externalizing/splitting). Pre-floor (bootstrap, no
// clean yet) or a floor too small to trust (< FLOOR_MIN_TOKENS) both collapse
// bmi to null — only the absolute-cap can fire, matching the original
// bootstrap heuristic.
//
// FULL's economic force fires ONLY on the deterministic break-even proof (the
// series' one named consent exception, "economic-dominance" — AGENTS.md): the
// numbers are computed in CODE and SHOWN every time. No FULL flag is
// persisted (MEMORY.md "NO FULL FLAG AT ALL"): the capacity line is a
// STATELESS check recomputed fresh at every gauge call from the current
// footprint alone; only the ceiling's hysteresis bit (`over`) is cached
// (as `overCeiling`, alongside the rest of the verdict cache) so the NEXT
// gauge call can apply the Schmitt trigger — that single boolean is a fact
// about the ceiling's own state, not an "armed forever" residue.
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
// THE ONE-CEILING NUMBER (MEMORY.md, recommended for beta.12): the GC-anchor
// derivation — V8/Java major-GC fire at 1.5-2x heap growth; we take the LOW
// edge because the sweep is code-only-cheap AND class-B fat charges rent in
// THROUGHPUT every prompt (unlike RAM fat, which only charges capacity),
// justifying an earlier trigger. Hysteresis re-arm at 1.2 vs natural
// accretion ~1-3%/session = months-per-fire on a healthy store.
export const CEILING_BMI = 1.5;
export const CEILING_REARM_BMI = 1.2;
// Floor-sanity lower bound ("<~10KB no-measure", the beta.6 floor-guard
// family's other half — sanitizeLeanFloor below already guards the UPPER
// bound): a floor this small can't support a trustworthy RATIO — a trivial
// absolute difference reads as a huge BMI swing on a near-empty project.
// ~10KB of ASCII text -> ~2500 tok (the tokensEstFromBytes heuristic, /4).
export const FLOOR_MIN_TOKENS = 2500;
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
export const STAMP_RING_MAX = 60; // per-project session-stamp ring buffer cap
// WARP-HOLE (beta.13 item 3, MEMORY.md "WARP-HOLE + WARM COST"): the Stop
// hook's cheap gate re-stats the always-loaded paths cached at the last gauge
// and only pays for a full re-gauge once the byte delta implies a REAL
// content change. PLACEHOLDER, reasoned not measured (same convention as
// CAPACITY_TOKENS/FLOOR_MIN_TOKENS): ~500 tok (~2KB ASCII) is small enough to
// catch a genuine MEMORY.md crystallize append (the scenario this feature
// exists for) but large enough to ignore incidental noise (a timestamp edit,
// a few words). Recalibrate at the benchmark once real Stop-tick data exists.
export const REGAUGE_DELTA_TOKENS = 500;
// Defensive cap on the always-loaded PATH LIST cached for the re-stat gate —
// state-size hygiene, the same discipline as STAMP_RING_MAX/RULES_FILE_CAP. A
// truncated list only narrows the delta gate's visibility (a missed file
// among the excess never widens past the existing next-SessionStart catch),
// never breaks anything.
export const ALWAYS_LOADED_PATHS_CAP = 200;
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

// WARP-HOLE (beta.13 item 3) — the CHEAP half of the Stop-hook re-gauge gate:
// sums CURRENT byte sizes for an already-discovered path list via fs.statSync
// ONLY (no directory walk, no content read). MEASURED ad-hoc during dev
// (reproduce by timing statOnlyFootprintBytes vs discoverClassB+measureEntries;
// the WARP-HOLE BEHAVIOR is pinned in conductor.test.mjs — the timing itself is
// deliberately NOT a flaky in-suite ms-assertion): ~0.15-0.3ms on the
// flock's heaviest room (CoalWash's own, 11 always-loaded files) vs ~7-18ms
// for a full discoverClassB+measureEntries re-gauge on the SAME/a bigger
// root — cheap enough to run on EVERY Stop call, unlike the full pass, which
// blows the Phoenix #3 <=5ms happy-path budget if paid unconditionally. A
// path that no longer exists contributes 0 (folds naturally into the delta —
// a legitimate shrink signal, never a special case).
export function statOnlyFootprintBytes(paths) {
  let bytes = 0;
  for (const p of Array.isArray(paths) ? paths : []) {
    try { bytes += fs.statSync(p).size; } catch { /* gone -> contributes 0 */ }
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// band verdict
// ---------------------------------------------------------------------------

// wasOver: the ceiling's hysteresis state as of the LAST recorded verdict
// (cached `overCeiling` — see recordVerdict below). Defaults false (a fresh
// project starts un-armed, the same as the old bootstrap LEAN default).
export function bandVerdict({
  footprintTokens,
  leanFloorTokens = 0,
  capacityTokens = CAPACITY_TOKENS,
  fullPercent = 6,
  indexBytes = 0,
  indexLines = 0,
  wasOver = false,
} = {}) {
  const hardCeilingTokens = Math.round(capacityTokens * (fullPercent / 100));
  const capHit =
    footprintTokens >= hardCeilingTokens ||
    indexBytes >= CC_INDEX_CAP_BYTES ||
    indexLines >= CC_INDEX_CAP_LINES;
  // Fractal BMI (the INFECTION AUDIT's superseding ruling): the floor must
  // itself be large enough to trust a ratio against (FLOOR_MIN_TOKENS) —
  // below that, or with no floor stamped yet, bmi collapses to null exactly
  // like the pre-floor bootstrap case always has.
  const measurable = leanFloorTokens >= FLOOR_MIN_TOKENS;
  const bmi = measurable ? footprintTokens / leanFloorTokens : null;
  // Schmitt-trigger hysteresis: once armed (over), BMI must fall to the LOW
  // mark to disarm; once disarmed, BMI must reach the HIGH mark to arm again.
  // This is the anti-flapping guard living in the metric, not a clock.
  const over = bmi === null ? false : (wasOver ? bmi > CEILING_REARM_BMI : bmi >= CEILING_BMI);

  if (bmi === null) {
    // Bootstrap (pre-floor) or a floor too small to trust: unchanged
    // absolute-cap-only heuristic — it correctly drove the first real clean
    // (beta.6). The ceiling wakes up only once a full clean stamps a
    // measurable floor.
    if (capHit) return { band: 'FULL', reason: 'absolute-cap', bmi, over: false, hardCeilingTokens };
    return { band: 'LEAN', reason: leanFloorTokens > 0 ? 'floor-too-small' : 'no-floor-yet', bmi, over: false, hardCeilingTokens };
  }

  // Post-floor: the machine's hard capacity gate is the one PERSON-independent
  // ceiling — but hitting it while BMI is still under the wash ceiling
  // (~all-muscle, over is false) gets DIFFERENT advice: externalize, never
  // "wash harder" (a wash cannot shrink muscle). Over the wash ceiling too
  // (real fat exists) -> absolute-cap (wash first, it may not be enough, but
  // it helps).
  if (capHit) {
    return over
      ? { band: 'FULL', reason: 'absolute-cap', bmi, over, hardCeilingTokens }
      : { band: 'FULL', reason: 'externalize', bmi, over, hardCeilingTokens };
  }
  return over
    ? { band: 'OBESE', reason: 'bmi', bmi, over, hardCeilingTokens }
    : { band: 'LEAN', reason: 'bmi', bmi, over, hardCeilingTokens };
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

// gaugeVerdict — the pure "measurement -> verdict + economics" composition
// shared by SessionStart (the primary chokepoint) and the Stop hook's gated
// re-gauge (beta.13 item 3, "WARP-HOLE"): both callers already have a fresh
// `measure` (measureEntries' output) and only need this one shot of glue
// (floor sanitize -> bandVerdict -> the band-gated breakEven read) instead of
// re-deriving it by hand at a second call site — the hook's own header
// names exactly this class of bug as the reason to share code: "a hook that
// reimplements X silently diverged once in a sibling; never again." No fs
// access of its own (pure over its inputs) — discovery (class-b.mjs) and
// state persistence (recordVerdict/recordCrossing) stay the CALLER's job,
// the same module boundaries as before.
export function gaugeVerdict({ measure, rawLeanFloorTokens, fullPercent = 6, wasOver = false, stamps } = {}) {
  const leanFloorTokens = sanitizeLeanFloor(rawLeanFloorTokens, measure.alwaysLoaded.tokensEst);
  const verdict = bandVerdict({
    footprintTokens: measure.alwaysLoaded.tokensEst,
    leanFloorTokens,
    fullPercent,
    indexBytes: measure.index.bytes,
    indexLines: measure.index.lines,
    wasOver,
  });
  const fatTokens = Math.max(0, Math.round(measure.alwaysLoaded.tokensEst - leanFloorTokens));
  let economical = false;
  let perDay = 0, breakEvenDays = null, floorUnmeasured = false;
  // Break-even is only meaningful where a wash could actually help (never for
  // externalize — a wash cannot shrink muscle — and never for LEAN — nothing
  // to pay back).
  if (verdict.band !== 'LEAN' && verdict.reason !== 'externalize') {
    const econ = breakEven({
      footprintTokens: measure.alwaysLoaded.tokensEst,
      leanFloorTokens,
      totalStoreTokens: measure.totalTokensEst,
      sessionsPerDay: sessionsPerDay(stamps),
    });
    perDay = econ.perDay;
    breakEvenDays = econ.breakEvenDays;
    floorUnmeasured = econ.floorUnmeasured;
    if (verdict.band === 'FULL') economical = econ.economical;
  }
  return { verdict, leanFloorTokens, fatTokens, economical, perDay, breakEvenDays, floorUnmeasured };
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
// (false-OBESE/FULL is acceptable), never hide real fat (false-LEAN is not).
export const LEAN_FLOOR_MAX_MULTIPLE = 10;
export function sanitizeLeanFloor(rawLeanFloorTokens, footprintTokens) {
  const floor = Number(rawLeanFloorTokens);
  if (!Number.isFinite(floor) || floor <= 0) return 0;
  const fp = Number(footprintTokens);
  if (Number.isFinite(fp) && fp > 0 && floor > fp * LEAN_FLOOR_MAX_MULTIPLE) return 0;
  return floor;
}

// ---------------------------------------------------------------------------
// cached verdict (built at beta.8 #2 for the since-retired UserPromptSubmit
// hot path; beta.10 REPOINTS it at the Stop hook instead — the storage and
// sanitization stay exactly as they were, only the reader changed). beta.12
// band-collapse: the snooze mechanism this cache used to sit beside is GONE
// (MEMORY.md — a time-based throttle is banned; the ceiling's own hysteresis,
// `overCeiling` below, is the anti-flapping guard now) and the payload grows
// two payback fields (`perDay`/`breakEvenDays`/`floorUnmeasured`) so the Stop
// hook's OBESE ask can show the same break-even numbers the FULL ask already
// did (queue 0c) without re-measuring the store (Phoenix #3).
// SessionStart already computes the ceiling verdict; recordVerdict stores
// just enough of it so the Stop conductor branch (no discovery/measureEntries
// there) can decide whether to fire the FULL force directive, or show payback
// numbers on an ask, from a single state read, never re-measuring the store.
// ---------------------------------------------------------------------------

// A cached verdict older than this is never trusted (silent) — the next
// SessionStart always refreshes it, so staleness can only ever WIDEN the
// silent side, never force a stale nag past one day.
export const VERDICT_MAX_AGE_MS = DAY_MS;

// Record the SessionStart-computed verdict. Called every time a verdict is
// computed (whatever the band), so a store that goes LEAN this session
// overwrites a stale FULL left by a prior one immediately, not just eventually.
// `verdict.over` (bandVerdict's hysteresis output) is cached as `overCeiling`
// — read back as the NEXT gauge call's `wasOver` input (the Schmitt-trigger
// memory); `perDay`/`breakEvenDays`/`floorUnmeasured` (breakEven()'s output,
// optional) back the Stop hook's payback line on ANY ask, not just FULL's.
export function recordVerdict(home, projectRoot, verdict, now = Date.now()) {
  const state = pruneOrphans(loadState(home));
  state.projects = state.projects || {};
  const key = projKey(projectRoot);
  const proj = state.projects[key] || {};
  const perDay = Number(verdict && verdict.perDay);
  const breakEvenDays = Number(verdict && verdict.breakEvenDays);
  const hardCeilingTokens = Number(verdict && verdict.hardCeilingTokens);
  const alwaysLoadedBytes = Number(verdict && verdict.alwaysLoadedBytes);
  const rawPaths = (verdict && Array.isArray(verdict.alwaysLoadedPaths)) ? verdict.alwaysLoadedPaths : [];
  proj.lastVerdict = {
    band: String((verdict && verdict.band) || ''),
    reason: String((verdict && verdict.reason) || ''),
    economical: !!(verdict && verdict.economical),
    fatTokens: Number.isFinite(verdict && verdict.fatTokens) ? Math.round(verdict.fatTokens) : 0,
    overCeiling: !!(verdict && verdict.overCeiling),
    perDay: Number.isFinite(perDay) ? Math.round(perDay) : 0,
    breakEvenDays: Number.isFinite(breakEvenDays) ? breakEvenDays : null,
    floorUnmeasured: !!(verdict && verdict.floorUnmeasured),
    hardCeilingTokens: Number.isFinite(hardCeilingTokens) ? Math.round(hardCeilingTokens) : 0,
    // WARP-HOLE (beta.13 item 3): the always-loaded path list + its byte total
    // AT this gauge — the Stop hook's cheap re-stat baseline
    // (statOnlyFootprintBytes above). Capped defensively (state-size hygiene);
    // a truncated list only narrows the delta gate's visibility, never breaks
    // anything (fail-safe: undercounting just delays a re-gauge to the next
    // SessionStart, the EXISTING behavior this feature is additive to).
    alwaysLoadedPaths: rawPaths.filter((p) => typeof p === 'string').slice(0, ALWAYS_LOADED_PATHS_CAP),
    alwaysLoadedBytes: Number.isFinite(alwaysLoadedBytes) ? Math.round(alwaysLoadedBytes) : 0,
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
  // Defense in depth (the growable-full invariant's "never wash-harder on
  // muscle"): externalize must never arm the force case even if some future
  // caller mis-set economical on it — SessionStart today never does, but this
  // gate should not depend on that discipline holding forever.
  if (rawVerdict.reason === 'externalize') return null;
  const fatTokens = Number(rawVerdict.fatTokens);
  return { band: 'FULL', reason: String(rawVerdict.reason || ''), fatTokens: Number.isFinite(fatTokens) ? fatTokens : 0, at };
}

// 0e "THE OBESE LOOP" (MEMORY.md): mark that a mechanical Quick pass was
// auto-triggered this episode — from EITHER the OBESE auto-Quick directive
// (queue 0d) or a FULL force-run (which also always runs Quick). Read back
// at the next SessionStart (or a Stop-triggered re-gauge, beta.13 item 3) as
// the gate for arming a same-band OBESE "escalation" crossing once
// mechanical cutting proves insufficient — see recordCrossing below. Cleared
// automatically the moment the band returns to LEAN (recordCrossing's own
// reset), never by a clock.
export function markQuickTried(home, projectRoot, now = Date.now()) {
  const state = pruneOrphans(loadState(home));
  state.projects = state.projects || {};
  const key = projKey(projectRoot);
  const proj = state.projects[key] || {};
  proj.quickTried = true;
  proj.quickTriedAt = now;
  state.projects[key] = proj;
  return saveState(state, home);
}

// ---------------------------------------------------------------------------
// edge-crossing state (beta.10 — MEMORY.md "NORMAL-MODE ASK REDESIGN: ONCE-
// TIME EDGES"). Retires the beta.8/9 per-turn UserPromptSubmit bar (a REQUEST
// channel a busy agent proved able to ignore, "ROUND 4 POSTMORTEM") in favor
// of the Stop hook's BLOCKING channel: instead of nagging every turn, the ask
// fires ONCE per RISE across a band ceiling, then stays silent until the next
// rise. Bands rank LEAN < OBESE < FULL (beta.12 band-collapse: PLUMP is gone,
// merged into the single OBESE ceiling); a rise (new rank > previous
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
export const BAND_RANK = { LEAN: 0, OBESE: 1, FULL: 2 };

// Called every SessionStart alongside recordVerdict, comparing the NEW band
// against the band on record from BEFORE this session's recordVerdict call
// (the caller reads it off the pre-overwrite proj.lastVerdict.band).
//
// opts.quickTried / opts.fatTokens (beta.13 item 2, "0e THE OBESE LOOP"): a
// plain RISE always arms exactly as before (untouched — the shape stays
// `{band, at, consumed:false}`, no new key, so every existing rise-arm
// assertion keeps holding byte-for-byte). The ADDITIVE case: OBESE
// PERSISTING (or reached again on a FALL, e.g. settling back from a FULL
// force-run) after a Quick pass was already tried this episode is a
// DIFFERENT situation — mechanical cutting is exhausted, only semantic
// judgment (the wizard) can help further — so it arms an "escalation"
// crossing (`escalation:true`) even on a non-rise plateau. Gated on fat
// having GENUINELY GROWN past the fat level at the last time this was
// flagged (`lastEscalationFat`) — never every session on an unchanged
// plateau (that would be the class-17 re-nag fatigue the user explicitly
// rejected; "ask frequency tracks fat-growth rate, never a clock/throttle").
// FULL is untouched by this branch — it always routes through its own
// force/ask logic regardless of quickTried.
export function recordCrossing(home, projectRoot, newBand, prevBand, now = Date.now(), opts = {}) {
  const { quickTried = false, fatTokens = 0 } = opts || {};
  const state = pruneOrphans(loadState(home));
  state.projects = state.projects || {};
  const key = projKey(projectRoot);
  const proj = state.projects[key] || {};
  if (newBand === 'LEAN') {
    delete proj.lastCrossing;
    // 0e: LEAN is the episode's clean reset — a FUTURE OBESE rise gets a
    // fresh, unconditional auto-Quick attempt, never treated as "already
    // tried" leftover from a store that has since been cleaned.
    delete proj.quickTried;
    delete proj.quickTriedAt;
    delete proj.lastEscalationFat;
  } else if ((BAND_RANK[newBand] ?? 0) > (BAND_RANK[prevBand] ?? 0)) {
    proj.lastCrossing = { band: newBand, at: now, consumed: false };
  } else if (
    newBand === 'OBESE' &&
    quickTried &&
    !(proj.lastCrossing && proj.lastCrossing.consumed === false) &&
    fatTokens > (proj.lastEscalationFat || 0)
  ) {
    proj.lastCrossing = { band: newBand, at: now, consumed: false, escalation: true };
    proj.lastEscalationFat = fatTokens;
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
// why nothing here can go unconsumed forever regardless. `escalation` (0e)
// passes through ONLY when explicitly true, so a plain rise-crossing keeps
// the EXACT pre-existing 2-key shape.
export function sanitizeCrossing(rawCrossing, now = Date.now()) {
  if (!rawCrossing || typeof rawCrossing !== 'object') return null;
  if (rawCrossing.consumed === true) return null;
  if (!(rawCrossing.band in BAND_RANK) || rawCrossing.band === 'LEAN') return null;
  const at = Number(rawCrossing.at);
  if (!Number.isFinite(at) || at > now) return null;
  return rawCrossing.escalation === true ? { band: rawCrossing.band, at, escalation: true } : { band: rawCrossing.band, at };
}

// ponytail: consumption happens at EMISSION time — the Stop hook calls this
// the instant it surfaces (ask/force) a pending crossing, not on a
// downstream "the user picked X" signal. There is no CLI surface today for
// the agent to report the
// user's choice back into state, so gating consumption on one would leave a
// crossing pending indefinitely whenever the user never invokes it. This
// mirrors the crossing's own once-per-rise design (nothing snoozes by clock
// any more, beta.12 band-collapse — the ceiling's hysteresis, not a timer, is
// the anti-flapping guard). Consequence: nothing can go unconsumed forever,
// so a TTL/re-arm-once fallback is unnecessary and not implemented here; add
// one only if emission-time consumption proves too eager in practice (e.g. a
// session killed before the Stop hook's feedback ever reached the user).
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
