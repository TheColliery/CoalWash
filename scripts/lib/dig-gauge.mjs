// dig-gauge.mjs — ULTRA trigger #2 (USER-commissioned 2026-07-16): the
// PRE-READ tollgate. An agent deliberately digging old history (a raw
// transcript grep/dig) gets BURIED by the document pile — so the gauge fires
// BEFORE any content is read. It sits BETWEEN the search and the first Read:
// a search returns a hit-list of PATHS, dig-gauge measures those candidates by
// fs.stat BYTES alone (tok ~est at 4 chars/tok, tokensEstFromBytes) → a
// CLEAR/CRUSHING verdict. ZERO file content ever enters context — stat is
// metadata only (the zero-read invariant is pinned by dig-gauge.test.mjs,
// instrumented readFileSync = 0, the caliper WARP-HOLE structural-gate shape).
//
// The economics: the READ is the only expensive step (~X tok pulled in, then
// RE-CARRIED every turn + re-paid on every sub-spawn's prefix — the
// multiplicative burn a one-time read hides); the gauge is ~free insurance
// (~0.3k tok of output vs the >=58k crush it can prevent = ~1:200).
//
// DETERMINISTIC, agent-triggers-not-improvises (the 0s law): the three
// thresholds are CODE, not judgment — all config-clamped priors under
// `digCrush` (config-schema.mjs), KNEE-GROUNDED (not %-of-window): the byte/4
// ~est UNDER-counts a real Read ~1.7x (CC #20223 line-number overhead) and
// long-context degradation has an ABSOLUTE knee ~32-100k tok (NoLiMa/Chroma) a
// 1M-window model does NOT move — and CT can delegate a dig to a 200k worker,
// so gate for the SMALLEST fleet window, not a %-of-this-window. Shares are
// PRIORS → a/b-calibrate from real dig telemetry later (the a/b pattern).
//
// This module is a PURE read of METADATA: fs.statSync only, no content read,
// no state, no config load (thresholds are injected). The CLI (cli.mjs) is the
// ONLY caller that resolves config + wires the once-per-session offer arm
// (caliper.armDigGauge) + the offer text (ask.digGaugeOffer). Keeping the
// measurement pure is what makes the zero-read proof trivial.
import fs from 'node:fs';
import { tokensEstFromBytes } from './caliper.mjs'; // the ONE /4 estimator (no duplication)

// #7: re-enforce the schema's own min/max at this trust boundary. The CLI
// resolves thresholds through clampObject (already in-range), but a DIRECT
// caller (a test, a future internal caller) may hand an out-of-range int; a
// negative/zero threshold would false-CRUSH every dig. Bounds mirror the
// digCrush spec (config-schema.mjs) — the SAME defaults are already duplicated
// here by design ("defaults match the schema so a direct caller may pass a
// partial object"); this extends that to the bounds. Any invalid value -> def.
function intOr(v, def, min, max) {
  return Number.isFinite(v) && Number.isInteger(v) && v >= min && v <= max ? v : def;
}

// Measure candidate paths and return a verdict. CRUSHING if ANY one holds:
//   1. single — a single candidate's ~est tok >= singleFileTok (~35k bytes/4 =
//      ~60k real tok after the ~1.7x undercount = into the ABSOLUTE ~32-100k
//      degradation knee, unreadable in one clean pass);
//   2. pile   — Σ(bytes of all candidates) as ~est tok >= pileTok (a dig pile
//      at/over the knee band);
//   3. count  — candidate COUNT >= fileCount (dispersion).
// `paths` = the concrete hit-list a search already found; a path that cannot be
// stat'd or is not a regular file is SKIPPED (recorded, never fatal) — a dir or
// an unexpanded glob is not a candidate. `thresholds` = the clamped `digCrush`
// config (singleFileTok/pileTok/fileCount); defaults match the schema so a
// direct caller (a test) may pass a partial object.
export function digGauge(paths, thresholds) {
  const th = thresholds || {};
  const singleFileTok = intOr(th.singleFileTok, 35000, 20000, 200000);
  const pileTok = intOr(th.pileTok, 58000, 40000, 200000);
  const fileCount = intOr(th.fileCount, 6, 3, 50);

  const files = [];
  const skipped = [];
  // ponytail: each arg is a CONCRETE path (a search already found them); no
  // glob expansion here — Node 18 has no fs.glob, and a shell already expands
  // unquoted globs. A literal unexpanded glob just stats as "not a file" →
  // skipped (surfaced in the count), never a silent zero. Upgrade path if
  // callers ever pass raw patterns: fs.glob (Node 22+).
  for (const p of Array.isArray(paths) ? paths : []) {
    if (typeof p !== 'string' || !p) continue;
    let st;
    try { st = fs.statSync(p); } catch { skipped.push(p); continue; } // metadata only — the file is never OPENED
    if (!st.isFile()) { skipped.push(p); continue; } // dir / special / missing — a search returns files
    // ponytail: tok = bytes/4 (tokensEstFromBytes) assumes ~ASCII; Thai text is
    // multi-byte UTF-8 AND ~1.0-1.5 char/tok, so this byte-gauge can UNDER-count
    // a Thai-heavy dig (unverified — a/b-calibrate against a real Thai transcript
    // later, same telemetry pass as the threshold priors).
    files.push({ path: p, bytes: st.size, tok: tokensEstFromBytes(st.size) });
  }

  let totalBytes = 0;
  let largestTok = 0;
  let largestFile = null;
  for (const f of files) {
    totalBytes += f.bytes;
    if (f.tok >= largestTok) { largestTok = f.tok; largestFile = f.path; }
  }
  const totalTok = tokensEstFromBytes(totalBytes);
  const n = files.length;

  const tripped = [];
  if (largestTok >= singleFileTok) tripped.push('single'); // >= not > (boundary = CRUSHING)
  if (totalTok >= pileTok) tripped.push('pile');
  if (n >= fileCount) tripped.push('count');

  return {
    band: tripped.length ? 'CRUSHING' : 'CLEAR',
    files: n,
    totalBytes,
    totalTok,
    largestTok,
    largestFile,
    tripped,
    skipped,
    thresholds: { singleFileTok, pileTok, fileCount },
  };
}

function tripLabel(rule, th) {
  const k = (n) => `${Math.round(n / 1000)}k`;
  if (rule === 'single') return `single>=${k(th.singleFileTok)} tok`;
  if (rule === 'pile') return `pile>=${k(th.pileTok)} tok`;
  return `count>=${th.fileCount} files`;
}

// The terse one-line verdict (the gaugeLine shape) — always safe to print, the
// ~free-insurance reading. The CLI appends the CRUSHING offer separately (once
// per session), so this line never carries the ask.
export function digGaugeLine(v) {
  const trip = v.tripped && v.tripped.length
    ? ` (tripped: ${v.tripped.map((r) => tripLabel(r, v.thresholds)).join(', ')})`
    : '';
  const skip = v.skipped && v.skipped.length ? ` · ${v.skipped.length} skipped (not a readable file)` : '';
  const base = `[CoalWash] dig-gauge: ${v.band} — ${v.files} candidate file(s), ~${v.totalTok} tok total, largest ~${v.largestTok} tok${trip}${skip}`;
  return v.band === 'CLEAR' ? `${base} — safe to read.` : base;
}
