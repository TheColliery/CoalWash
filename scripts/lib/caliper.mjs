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
// Bands returned (0g "FULL = THE ECONOMIC CUT-POINT" + its 0g-RESOLUTION,
// MEMORY.md — the bands are PURELY ECONOMIC now, nested LEAN < OBESE < FULL):
//   LEAN  — ceiling un-armed: no meaningful fat. Silent.
//   OBESE — ceiling armed (fat exists) but carry < wash: the chronic-chubby-
//           is-CORRECT zone (0c). Auto-Quick-silent only, never asks.
//   FULL  — the economic cut-point (reason 'economic'): ceiling armed AND
//           breakEven.economical. Q1: FULL ⊂ OBESE — the economic test alone
//           can never fire un-armed, so a tiny-fat-heavy-use store never
//           jumps LEAN→FULL. Q2: LATCHED per episode — once economical arms
//           FULL it holds (`econLatched`, cached like `overCeiling`) until
//           the episode ends (the LEAN reset; wizard completion lands there
//           via the post-clean floor stamp collapsing BMI to ~1.0). No
//           second Schmitt threshold: the latch IS the anti-flap.
// The WALL (fullPercent x CAPACITY_TOKENS, or the CC index-byte/line caps) is
// demoted from "what FULL means" to the OUTER capacity line with three
// surviving roles (Q3): pre-floor bootstrap FULL/'absolute-cap' (cold-start
// entry, bmi null); capHit while armed = FULL/'absolute-cap' (real fat to
// reclaim — wash first); capHit while un-armed = FULL/'externalize' (~all
// muscle; washing cannot help, advise externalizing/splitting). Pre-floor
// (bootstrap, no clean yet) or a floor too small to trust
// (< FLOOR_MIN_TOKENS) both collapse bmi to null — only the wall can fire,
// matching the original bootstrap heuristic.
//
// FORCE AT FULL IS UNCONDITIONAL (0m "FORCE = THE FREE TIER, NO PROOF
// NEEDED" + "FORCE IS A DICTATOR, NO OFF SWITCH"): every FULL crossing —
// economic AND absolute-cap, never externalize — force-runs the FREE
// mechanical Quick pass under the same standing consent as OBESE's
// auto-Quick; the deterministic break-even proof is NOT a gate on that free
// tier (it governs the PAID wizard — it still DEFINES the economic band
// above and backs the wizard ask's shown numbers). No FULL flag is
// persisted beyond the two episode bits (MEMORY.md "NO FULL FLAG AT ALL"):
// the wall is a STATELESS check recomputed fresh at every gauge call from
// the current footprint alone; only the ceiling's hysteresis bit (`over`,
// cached as `overCeiling`) and the economic latch (`econLatched`, 0g Q2) are
// carried between gauges — each a fact about its own trigger's state, not an
// "armed forever" residue (both fall with the band: LEAN writes them false).
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
//
// economical / wasEconLatched (0g + 0g-RESOLUTION): the fresh
// breakEven().economical for THIS gauge (Q4 — the caller computes economics
// BEFORE the band now, because the band depends on it) and the latch as of
// the LAST recorded verdict (cached `econLatched`). Both default false, so
// every pre-0g caller/test gets the pre-0g band behavior unchanged. The
// latch (Q2) sets whenever the band lands FULL with the ceiling armed and
// the economic proof fresh-true, holds through armed sessions where the
// fresh proof dips (boundary drift must not flap the band — no second
// Schmitt threshold), and falls the moment the ceiling itself disarms
// (LEAN — the episode reset; FULL ⊂ OBESE means an un-armed store can never
// stay FULL on a stale latch).
// floorProvisional (0j): the floor on file is the install-time PROVISIONAL
// baseline, not a gate-passed lean proof. One behavioral consequence, in the
// capHit branch below: a provisional baseline cannot certify "~all muscle"
// (pre-existing fat is baked into it), so an over-the-wall store keeps the
// wash-first 'absolute-cap' diagnosis instead of 'externalize' until a real
// clean has proven what the muscle actually is.
export function bandVerdict({
  footprintTokens,
  leanFloorTokens = 0,
  capacityTokens = CAPACITY_TOKENS,
  fullPercent = 6,
  indexBytes = 0,
  indexLines = 0,
  wasOver = false,
  economical = false,
  wasEconLatched = false,
  floorProvisional = false,
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
  // 0g Q1+Q2: the economic FULL condition — armed AND (fresh proof OR the
  // per-episode latch). over=false zeroes it by construction (FULL ⊂ OBESE),
  // which is also what clears the latch at the LEAN reset: LEAN writes
  // econLatched:false back to the cache.
  const econFull = over && (economical || wasEconLatched);

  if (bmi === null) {
    // Bootstrap (pre-floor) or a floor too small to trust: unchanged
    // wall-only heuristic — it correctly drove the first real clean
    // (beta.6). The ceiling (and with it the economic FULL, Q1) wakes up
    // only once a full clean stamps a measurable floor.
    if (capHit) return { band: 'FULL', reason: 'absolute-cap', bmi, over: false, econLatched: false, hardCeilingTokens };
    return { band: 'LEAN', reason: leanFloorTokens > 0 ? 'floor-too-small' : 'no-floor-yet', bmi, over: false, econLatched: false, hardCeilingTokens };
  }

  // Post-floor: the machine's WALL is the one PERSON-independent capacity
  // line — hitting it while BMI is still under the wash ceiling (~all-muscle,
  // over is false) gets DIFFERENT advice: externalize, never "wash harder"
  // (a wash cannot shrink muscle). Over the wash ceiling too (real fat
  // exists) -> absolute-cap, wash first (Q3 — the wall's real-fat case
  // stands; it may not be enough, but it helps). The reason label keeps the
  // wall's precedence over 'economic' (a capHit FULL still latches when the
  // economic condition holds, so shrinking back under the wall mid-episode
  // cannot drop the band out of FULL — same no-flap rule, Q2).
  if (capHit) {
    return over || floorProvisional
      ? { band: 'FULL', reason: 'absolute-cap', bmi, over, econLatched: econFull, hardCeilingTokens }
      : { band: 'FULL', reason: 'externalize', bmi, over, econLatched: false, hardCeilingTokens };
  }
  if (econFull) return { band: 'FULL', reason: 'economic', bmi, over, econLatched: true, hardCeilingTokens };
  return over
    ? { band: 'OBESE', reason: 'bmi', bmi, over, econLatched: false, hardCeilingTokens }
    : { band: 'LEAN', reason: 'bmi', bmi, over, econLatched: false, hardCeilingTokens };
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

// gaugeVerdict — the pure "measurement -> economics -> verdict" composition
// shared by SessionStart (the primary chokepoint) and the Stop hook's gated
// re-gauge (beta.13 item 3, "WARP-HOLE"): both callers already have a fresh
// `measure` (measureEntries' output) and only need this one shot of glue
// instead of re-deriving it by hand at a second call site — the hook's own
// header names exactly this class of bug as the reason to share code: "a
// hook that reimplements X silently diverged once in a sibling; never
// again." ORDER (0g Q4, approved internal refactor): breakEven runs BEFORE
// bandVerdict now, because the band DEPENDS on the economic proof (0g: the
// proof IS the band); the outward return shape is unchanged — payback
// numbers still surface only where a wash could actually help (never LEAN —
// nothing to pay back; never externalize — a wash cannot shrink muscle),
// and `economical` still arms only on FULL. No fs access of its own (pure
// over its inputs) — discovery (class-b.mjs) and state persistence
// (recordVerdict/recordCrossing) stay the CALLER's job, the same module
// boundaries as before.
export function gaugeVerdict({ measure, rawLeanFloorTokens, fullPercent = 6, wasOver = false, wasEconLatched = false, floorProvisional = false, stamps } = {}) {
  const leanFloorTokens = sanitizeLeanFloor(rawLeanFloorTokens, measure.alwaysLoaded.tokensEst);
  // Q4: economics FIRST — pure arithmetic, ~free, and the band needs it.
  const econ = breakEven({
    footprintTokens: measure.alwaysLoaded.tokensEst,
    leanFloorTokens,
    totalStoreTokens: measure.totalTokensEst,
    sessionsPerDay: sessionsPerDay(stamps),
  });
  const verdict = bandVerdict({
    footprintTokens: measure.alwaysLoaded.tokensEst,
    leanFloorTokens,
    fullPercent,
    indexBytes: measure.index.bytes,
    indexLines: measure.index.lines,
    wasOver,
    economical: econ.economical,
    wasEconLatched,
    floorProvisional, // 0j: a provisional baseline never certifies externalize
  });
  const fatTokens = econ.fatTokens; // same formula as before the Q4 inversion — max(0, round(footprint - floor))
  let economical = false;
  let perDay = 0, breakEvenDays = null, floorUnmeasured = false;
  if (verdict.band !== 'LEAN' && verdict.reason !== 'externalize') {
    perDay = econ.perDay;
    breakEvenDays = econ.breakEvenDays;
    floorUnmeasured = econ.floorUnmeasured;
    // FRESH proof only, deliberately NOT `|| latched` (economic-dominance
    // clause: the forced spend needs the deterministic numbers to hold AND
    // be shown at every fire) — a latched-FULL session whose fresh proof
    // dipped keeps the BAND (Q2, no flap) but disarms the FORCE for that
    // session; a pending crossing then degrades to the plain ask (never
    // silent, never a forced run on numbers that don't hold today).
    if (verdict.band === 'FULL') economical = econ.economical;
  }
  return { verdict, leanFloorTokens, fatTokens, economical, perDay, breakEvenDays, floorUnmeasured };
}

// ---------------------------------------------------------------------------
// state (lean floor + stamp history + verdict/crossing cache) — one file
// under ~/.claude (sandbox-sanctioned config area), keyed by project root.
// Atomic writes, fail-silent: state loss degrades to bootstrap behavior,
// never misbehaves. (The old time-based snooze this section once held died
// at the beta.12 band collapse — nothing here is a clock.)
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
// Clears the provisional flag (0j): a gate-passed clean's floor is the TRUE
// lean baseline, superseding any install-time provisional stamp.
export function setLeanFloor(home, projectRoot, tokens, now = Date.now()) {
  const state = pruneOrphans(loadState(home));
  state.projects = state.projects || {};
  const key = projKey(projectRoot);
  const proj = state.projects[key] || {};
  proj.leanFloorTokens = Math.round(tokens);
  proj.leanFloorAt = now;
  delete proj.leanFloorProvisional;
  state.projects[key] = proj;
  return saveState(state, home);
}

// 0j "BMI ON AT INSTALL — provisional floor" (MEMORY.md): the first gauge of
// a never-seen store stamps a PROVISIONAL floor = the current footprint, so
// BMI runs from day one (1.00 at install) and every flow (growth -> OBESE ->
// economic FULL -> force -> wizard) measures GROWTH-SINCE-INSTALL instead of
// sleeping until the first clean. Pre-existing fat is baked into the
// baseline (accepted per the ruling — the WALL still catches already-over-
// cap stores, and bandVerdict's floorProvisional input keeps their day-one
// diagnosis 'absolute-cap', never a false 'externalize'). Rules enforced
// here, the ONE stamping site the conductor's gauge flows share: an EXISTING
// floor (real or provisional — even a poisoned raw value; read-time
// sanitizing stays sanitizeLeanFloor's job) is NEVER touched (no ratchet;
// only a gate-passed clean's setLeanFloor overwrites it); a footprint under
// FLOOR_MIN_TOKENS stamps nothing (a tiny store's ratio is noise — that
// guard unchanged). Returns { floorTokens, provisional } — the effective RAW
// floor for THIS gauge, ready for gaugeVerdict. The CLI gauge deliberately
// does NOT call this (read-only by contract, pinned by test); it CONSUMES
// whatever floor the conductor's gauges have stamped.
export function ensureProvisionalFloor(home, projectRoot, footprintTokens, now = Date.now()) {
  const state = pruneOrphans(loadState(home));
  state.projects = state.projects || {};
  const key = projKey(projectRoot);
  const proj = state.projects[key] || {};
  const existing = Number(proj.leanFloorTokens);
  if (Number.isFinite(existing) && existing > 0) {
    return { floorTokens: existing, provisional: proj.leanFloorProvisional === true };
  }
  const fp = Number(footprintTokens);
  if (!Number.isFinite(fp) || fp < FLOOR_MIN_TOKENS) return { floorTokens: 0, provisional: false };
  proj.leanFloorTokens = Math.round(fp);
  proj.leanFloorAt = now;
  proj.leanFloorProvisional = true;
  state.projects[key] = proj;
  saveState(state, home);
  return { floorTokens: Math.round(fp), provisional: true };
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
// hot path; beta.10 REPOINTS it at the Stop hook instead). beta.12
// band-collapse: the snooze mechanism this cache used to sit beside is GONE
// (MEMORY.md — a time-based throttle is banned; the ceiling's own hysteresis,
// `overCeiling` below, is the anti-flapping guard now) and the payload grows
// two payback fields (`perDay`/`breakEvenDays`/`floorUnmeasured`) so the Stop
// hook can show break-even numbers without re-measuring the store (Phoenix
// #3). SessionStart already computes the ceiling verdict; recordVerdict
// stores just enough of it so the Stop conductor branch (no discovery/
// measureEntries there) can dispatch on the cached band/reason from a single
// state read. (0m note: the old `sanitizeVerdict` FULL+economical force gate
// that lived here is GONE with the forceMode knob — force at FULL is
// unconditional now, keyed on the sanitized CROSSING + the cached reason;
// the crossing sanitizer below carries the doubt-collapses-to-silence duty.)
// ---------------------------------------------------------------------------

// Record the SessionStart-computed verdict. Called every time a verdict is
// computed (whatever the band), so a store that goes LEAN this session
// overwrites a stale FULL left by a prior one immediately, not just eventually.
// `verdict.over` (bandVerdict's hysteresis output) is cached as `overCeiling`
// — read back as the NEXT gauge call's `wasOver` input (the Schmitt-trigger
// memory); `econLatched` (0g Q2, bandVerdict's per-episode economic latch) is
// cached the same way — read back as `wasEconLatched` — and, like
// `overCeiling`, is simply OVERWRITTEN fresh each gauge (LEAN computes it
// false, so the LEAN reset clears it with no special code);
// `perDay`/`breakEvenDays`/`floorUnmeasured` (breakEven()'s output,
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
    econLatched: !!(verdict && verdict.econLatched),
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

// 0d/0f (MEMORY.md "AUTHORITATIVE 3-FLOW" — supersedes 0e "THE OBESE LOOP"):
// mark that a mechanical Quick pass was auto-triggered this episode — from
// EITHER the OBESE auto-Quick directive (queue 0d) or a FULL force-run
// (which also always runs Quick). Read back at the next SessionStart (or a
// Stop-triggered re-gauge, beta.13 item 3) as the gate for arming a
// same-band FULL "escalation" crossing (the wizard ask) once mechanical
// cutting proves insufficient — see recordCrossing below. OBESE itself never
// escalates any more (0f moved the trigger band to FULL; OBESE stays
// auto-Quick-silent, full stop — 0d). Cleared automatically the moment the
// band returns to LEAN (recordCrossing's own reset), never by a clock.
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
// opts.quickTried / opts.fatTokens (beta.13 item 2, "0e THE OBESE LOOP";
// SUPERSEDED beta.14 by MEMORY.md 0f "AUTHORITATIVE 3-FLOW" — the trigger
// band moved from OBESE to FULL, the growth-gated mechanism did not): a
// plain RISE always arms exactly as before (untouched — the shape stays
// `{band, at, consumed:false}`, no new key, so every existing rise-arm
// assertion keeps holding byte-for-byte). The ADDITIVE case: FULL PERSISTING
// (a plateau, or reached again some other non-rise way) after a force-run
// already tried Quick this episode is a DIFFERENT situation — mechanical
// cutting is exhausted, only semantic judgment (the wizard) can help further
// — so it arms an "escalation" crossing (`escalation:true`) even on a
// non-rise plateau. Gated on fat having GENUINELY GROWN past the fat level
// at the last time this was flagged (`lastEscalationFat`) — never every
// session on an unchanged plateau (that would be the class-17 re-nag fatigue
// the user explicitly rejected; "ask frequency tracks fat-growth rate, never
// a clock/throttle"). OBESE is UNTOUCHED by this branch (0f): it is
// auto-Quick-silent only (0d) and never asks, no matter how it is reached or
// how much fat has grown.
export function recordCrossing(home, projectRoot, newBand, prevBand, now = Date.now(), opts = {}) {
  const { quickTried = false, fatTokens = 0 } = opts || {};
  const state = pruneOrphans(loadState(home));
  state.projects = state.projects || {};
  const key = projKey(projectRoot);
  const proj = state.projects[key] || {};
  if (newBand === 'LEAN') {
    delete proj.lastCrossing;
    // 0f: LEAN is the episode's clean reset — a FUTURE FULL plateau gets a
    // fresh, unconditional escalation gate, never treated as "already
    // tried" leftover from a store that has since been cleaned.
    delete proj.quickTried;
    delete proj.quickTriedAt;
    delete proj.lastEscalationFat;
  } else if ((BAND_RANK[newBand] ?? 0) > (BAND_RANK[prevBand] ?? 0)) {
    proj.lastCrossing = { band: newBand, at: now, consumed: false };
  } else if (
    newBand === 'FULL' &&
    quickTried &&
    !(proj.lastCrossing && proj.lastCrossing.consumed === false) &&
    // Growth gate with a FIRST-ASK exemption (0m closes the day-one corner):
    // the very first escalation of an episode arms on quickTried alone —
    // a day-one over-wall store has fat ≈ 0 by definition (provisional floor
    // = install footprint), and the ledger's sequence is unconditional
    // ("force → re-gauge still over → the ONE wizard ask"); requiring
    // fat > 0 there would strand the user silent at over-wall forever. The
    // no-nag rule guards RE-asks exactly as before: once flagged
    // (lastEscalationFat recorded, 0 included), the next escalation needs
    // fat GENUINELY GROWN past that level — never a plateau re-nag.
    fatTokens > (proj.lastEscalationFat ?? -1)
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
// sanitizeLeanFloor's "any doubt -> the safe default" rule (0m: this is now
// the ONE hot-path sanitizer — the force leg keys on the crossing it
// returns, plus the cached reason). No age-based staleness cutoff: a
// crossing records a fact ("a rise happened at time T"), which does not go
// stale the way a cached footprint measurement does — see the ponytail note
// on consumeCrossing for why nothing here can go unconsumed forever
// regardless. `escalation` (0f) passes through ONLY when explicitly true, so
// a plain rise-crossing keeps the EXACT pre-existing 2-key shape.
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
