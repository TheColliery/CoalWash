// caliper.mjs — footprint measurement + the 4-band verdict + the economic
// break-even math (session amendment 2026-07-08, supersedes the blueprint §4
// info-only full-signal).
//
// Bands ride Memory-BMI = footprint / leanFloor (floor-relative, so legitimate
// MEAT growth never false-fires — only FAT above the floor moves the band):
//   LEAN  (< PLUMP_BMI)          -> silent
//   PLUMP (PLUMP_BMI..OBESE_BMI) -> ask via question-box; decline = snooze
//   OBESE (OBESE_BMI..FULL_BMI)  -> strong-ask, shorter snooze
//   FULL  (>= FULL_BMI OR the absolute platform cap) -> economic force-run of
//         the PROCESS (deletes stay human-gated at the outer gate, always)
// FULL's force fires ONLY on the deterministic break-even proof (the series'
// one named consent exception, "economic-dominance" — AGENTS.md): the numbers
// are computed in CODE and SHOWN every time.
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
export const FULL_BMI = 2.0;
export const CAPACITY_TOKENS = 200000; // conservative usable-per-turn window (~est; per-platform adapter refines later)
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
  if (capHit) return { band: 'FULL', reason: 'absolute-cap', bmi, hardCeilingTokens };
  if (bmi === null) {
    // Bootstrap: no lean floor measured yet (never cleaned) — only the absolute
    // cap can fire; BMI bands wake up after the first full clean stamps a floor.
    return { band: 'LEAN', reason: 'no-floor-yet', bmi, hardCeilingTokens };
  }
  if (bmi >= FULL_BMI) return { band: 'FULL', reason: 'bmi', bmi, hardCeilingTokens };
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

// Append a session stamp {t, fp} (ring-capped) and return the updated project
// state. Fail-silent: on any write failure the in-memory view is still returned.
export function recordStamp(home, projectRoot, footprintTokens, now = Date.now()) {
  const state = loadState(home);
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
  const state = loadState(home);
  state.projects = state.projects || {};
  const key = projKey(projectRoot);
  const proj = state.projects[key] || {};
  proj.leanFloorTokens = Math.round(tokens);
  proj.leanFloorAt = now;
  state.projects[key] = proj;
  return saveState(state, home);
}

// Snooze the band nudge until `untilMs` (a declined/emitted PLUMP or OBESE ask
// self-throttles — the nudge fires at most once per snooze window).
export function setSnooze(home, projectRoot, untilMs) {
  const state = loadState(home);
  state.projects = state.projects || {};
  const key = projKey(projectRoot);
  const proj = state.projects[key] || {};
  proj.snoozeUntil = untilMs;
  state.projects[key] = proj;
  return saveState(state, home);
}
