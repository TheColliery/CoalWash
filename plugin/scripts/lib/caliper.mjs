// ponytail: 1147 lines at declaration — one hysteresis state machine: the verdict logic (Schmitt trigger, econ latch, crossings) defines the SEMANTICS of the persisted fields it reads back, and the STATE_SCHEMA reset discipline audits field meaning against rulings; splitting verdict from state separates each field's writer from the logic that gives it meaning.
// caliper.mjs — footprint measurement + the ceiling verdict + the economic
// break-even math.
//
// TASK #4 (USER ruling, 2026-08-03) — THE FULL DEFINITION TRACKS MUSCLE 1:1,
// CONTINUOUSLY, and it SUPERSEDES both prior wall models (beta.12's
// BMI-vs-stamped-floor Schmitt AND 0r's fatMultiple x floor growable wall).
// Verbatim: "กล้ามโต 10 หน่วย นิยาม FULL โต 10 หน่วย" — muscle grows 10 units,
// the FULL definition grows 10 units. Not a multiplier, not a re-stamp, not
// event-driven: the threshold is a FUNCTION of current muscle mass recomputed
// at every gauge, so no "waiting for a successful clean" state can exist to
// get stuck in. The stamped lean floor is RETIRED as a band driver — the live
// defect this fixes: BMI = footprint / install-floor with the floor written
// once and `setLeanFloor` carrying ZERO production callers meant every token
// of legitimate muscle growth was silently attributed to FAT, latching an
// all-muscle store into FULL forever (measured on the umbrella store:
// footprint 28,833 -> 58,836 tok of real campaign history, band FULL every
// session, force firing and cutting nothing — the cry-wolf failure).
//
// THE NEW AXIS — CERTAIN FAT, measured from CONTENT at every gauge:
//   mechFatTokens — what the mechanical tier can PROVE is fat right now
//                   (see mechFatFromText: exact-duplicate substance lines +
//                   blank-run excess). A LOWER BOUND by construction: code
//                   counts only what it can prove; semantic fat is invisible
//                   to it (it always was — the old definition merely
//                   PRETENDED to see it by attributing all growth to fat).
//   muscleTokens  — footprint − mechFat: everything not provably fat is
//                   muscle until a human/semantic tier says otherwise. The
//                   fail direction of an estimator miss is toward MUSCLE =
//                   toward silence, the direction this fix exists to force.
//   the 1:1 line  — a store enters OBESE exactly when footprint exceeds
//                   muscleTokens + FAT_ARM_TOKENS. d(line)/d(muscle) = 1:
//                   muscle +10 => threshold +10, continuously, no stamp.
// Hysteresis stays a Schmitt trigger, re-axed onto mechFat (never a clock):
//   armed OFF -> ON  requires mechFat >= FAT_ARM_TOKENS
//   armed ON  -> OFF requires mechFat <= FAT_REARM_TOKENS
//   the dead zone between the marks holds whatever state it already had.
// Bands (nesting unchanged, LEAN < OBESE < FULL):
//   LEAN  — no provable fat worth acting on. Silent.
//   OBESE — certain fat armed but carry < wash: auto-Quick-silent, never asks.
//   FULL/economic — certain fat armed AND **BOTH** break-evens hold (task #4
//           condition 2): (a) cutting the CERTAIN FAT pays (breakEven over
//           mechFat) AND (b) reorganising NON-COMPACT MUSCLE pays (breakEven
//           over the retier envelope's demotable mass — the wizard tier this
//           ask opens is "Fat + reorganize muscle", and the reorganize half
//           was never costed before; a fat-only payoff must not open a
//           two-part paid run). Both proofs fresh, both shown.
//           Q2's per-episode latch survives (econLatched) — and its escape is
//           now CONTINUOUS: Quick removing the certain fat drops mechFat
//           under FAT_REARM_TOKENS and the band falls to LEAN by measurement,
//           not by any post-clean stamp (the old comment here documented "the
//           post-clean floor stamp collapsing BMI" as the escape — that stamp
//           was an uncalled function; the escape it described did not exist).
// The WALL is the REAL capacity line only — footprint >= capacityTokens, or
// the CC index caps: capHit while armed = FULL/'absolute-cap' (certain fat
// exists — wash first); capHit while un-armed = FULL/'externalize' (~all
// muscle; washing cannot help, advise externalizing/splitting). The
// fullPercent x capacity heuristic and the fatMultiple x floor wall are both
// RETIRED (each was a stamp/percent proxy that false-FULLed on muscle);
// their config keys are read-tolerated and ignored, the forceMode precedent.
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
import crypto from 'node:crypto'; // U7: CSPRNG suffix for the write temp below (zero-dep builtin)
// findProjectRoot/physicalDir: the room's ONE root resolver — the stray-state
// detector re-uses it rather than hand-rolling a second walk.
import { claudeBaseDir, findProjectRoot, physicalDir } from './config-load.mjs';
import { parseJsonc } from './jsonc.mjs';
// task #13 (OS-citizen state): the per-project state path RIDES the CC memory
// dir, so we reuse the SAME adapter discovery computes (ccMemoryDir/ccProjectSlug)
// + the SAME realpath containment primitives (physicalOrNull/containedIn) the
// write path uses — never a re-hardcoded path or a hand-rolled containment.
import { ccMemoryDir, ccProjectSlug, physicalOrNull, containedIn } from './class-b.mjs';

// ---------------------------------------------------------------------------
// constants — PLACEHOLDERS, calibrate at the fidelity benchmark (2026-07-08
// amendment: "Numbers = placeholder constants in code, calibrate at benchmark")
// ---------------------------------------------------------------------------
// LEGACY (task #4): CEILING_BMI / CEILING_REARM_BMI drove the retired
// BMI-vs-stamped-floor Schmitt. Exported still (state migration comments +
// history cite them by name — config-schema.mjs's own ordering-clamp note
// among others); no band logic reads them any more.
// FAT_MULTIPLE_DEFAULT (the sibling that drove the 0r floor-multiple wall)
// was cut here (board #72 ponytail-audit finding #1, 2026-08-08): unlike
// these two, nothing anywhere — code, test, or comment — cited it by name;
// the "history cites it" reason this comment used to claim for all three
// never actually applied to this one.
export const CEILING_BMI = 1.5;
export const CEILING_REARM_BMI = 1.2;
// TASK #4 — the certain-fat Schmitt marks (tokens, not a ratio). PLACEHOLDERS
// like every constant in this block, calibrate at the benchmark. The arm mark
// deliberately reuses REGAUGE_DELTA_TOKENS' own "a REAL content change" scale
// (~500 tok ~ a genuine MEMORY.md crystallize append): certain fat below the
// scale of one real append is noise the sweep should not churn on. Re-arm at
// 200 keeps the Schmitt's dead zone (a 40% margin below the 500-tok arm
// mark — standard hysteresis sizing, not a claim that any pass reaches it
// automatically: the mechanical tier has no cutter for this fat class, see
// method.md §1; the dead zone only clears when someone — agent, human, or
// the wizard — actually edits the file down).
export const FAT_ARM_TOKENS = 500;
export const FAT_REARM_TOKENS = 200;
// mechFatFromText's substance threshold: a trimmed line must carry at least
// this many chars before an exact repeat of it counts as duplicate FAT —
// shorter repeats are markdown STRUCTURE (table separators, fence markers,
// list bullets, `---` rules) that legitimately recurs. Placeholder, same
// convention.
export const MECH_DUP_MIN_CHARS = 24;
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

// CWK-057 -- the two SCAN-scope cuts this room actually has, and the ONE place
// the "ON = no cut" rule lives. Kept as a pure function of a BOOLEAN (never of
// the config object) so caliper stays free of a config-schema import, and so a
// caller is forced to have already read the key through the clamped cascade.
// Strict `=== true`: only a real boolean arms it, never truthy junk.
export const READ_BUDGET_DEFAULT = 262144;
export function readBudgetFor(scanEverything, fallback = READ_BUDGET_DEFAULT) {
  return scanEverything === true ? Infinity : fallback;
}
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

// TASK #4 — the CERTAIN-FAT estimator: what the mechanical tier can PROVE is
// fat in this text, right now, from content alone. Two classes only, both
// deterministic:
//   (a) exact-duplicate SUBSTANCE lines — a trimmed line of >=
//       MECH_DUP_MIN_CHARS chars repeating verbatim within the file; every
//       occurrence beyond the first counts (the broom's own flagship certain
//       cut: an exact dup is provable garbage, its first copy is the content).
//       WITHIN-file only, by design: a byte-identical copy ACROSS files is a
//       policy decision (the KoharuTH managed-pack lesson — deleting a local
//       copy of a global pack changes future load behavior), never certain.
//   (b) blank-run excess — blank lines beyond 2 consecutive (pure spacing;
//       the Quick tier's whitespace class).
// Everything else is MUSCLE to this estimator. That is the honest direction:
// this is a LOWER BOUND on fat, so a miss reads as muscle and the band stays
// SILENT — the task-#4 fail direction. Semantic fat (verbose wrapping,
// restatement in different words) is invisible here and stays the wizard's
// judgment; the old definition never saw it either, it only pretended to by
// billing all growth as fat.
export function mechFatFromText(text) {
  const lines = String(text).split(/\r?\n/);
  const seen = new Map();
  let dupTokens = 0;
  let blankTokens = 0;
  let blankRun = 0;
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) {
      blankRun++;
      if (blankRun > 2) blankTokens += 1; // ~1 tok per excess blank line (a newline's worth)
      continue;
    }
    blankRun = 0;
    if (t.length >= MECH_DUP_MIN_CHARS) {
      const n = seen.get(t) || 0;
      if (n >= 1) dupTokens += tokensEst(raw);
      seen.set(t, n + 1);
    }
  }
  return { tokensEst: dupTokens + blankTokens, dupTokens, blankTokens };
}

// Measure a discovered class-B entry set. Reads content ONLY for always-loaded
// entries (small by definition) up to `readBudgetBytes`; recall entries are
// sized from stat bytes (deterministic) with the ASCII token heuristic.
// TASK #4: the same read now also feeds the certain-fat estimator — m.mechFat
// accumulates mechFatFromText over every always-loaded text actually read.
// An entry NOT read (over the read budget, or a read error) contributes 0
// certain fat: can't see it -> can't prove it's fat -> counts as muscle ->
// the band stays quiet (the fail-toward-silence direction, deliberately).
export function measureEntries(entries, { readBudgetBytes = 262144, withGzip = false } = {}) {
  const m = {
    files: entries.length,
    totalBytes: 0,
    totalTokensEst: 0,
    alwaysLoaded: { files: 0, bytes: 0, tokensEst: 0 },
    index: { bytes: 0, lines: 0 },
    mechFat: { tokensEst: 0, dupTokens: 0, blankTokens: 0 }, // task #4 — certain fat, accumulated from the texts read below
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
          const mf = mechFatFromText(text);
          m.mechFat.tokensEst += mf.tokensEst;
          m.mechFat.dupTokens += mf.dupTokens;
          m.mechFat.blankTokens += mf.blankTokens;
          if (e.kind === 'memory-index') {
            m.index.bytes = e.bytes;
            m.index.lines = text.split('\n').length;
          }
        } catch {
          // stat-based estimate stands; unread => 0 certain fat (muscle).
          // The index CAP legs are a different question from fat, though: bytes
          // is a stat fact, knowable without reading. Setting it here keeps the
          // bytes leg alive on a read error instead of silently zeroing BOTH
          // index legs (a capacity wall that dies quietly is worse than one
          // that fires); lines stays 0, which is the safe direction for the
          // one leg we genuinely cannot compute.
          if (e.kind === 'memory-index') m.index.bytes = e.bytes;
        }
      } else if (e.kind === 'memory-index') {
        // THE CAP LEGS MUST NOT DEPEND ON DISCOVERY ORDER. `bytes` was always
        // set here; `lines` was not, so the `indexLines >= CC_INDEX_CAP_LINES`
        // leg of capHit silently read 0 and could never fire for an index
        // entry sitting past the read budget. That is exactly backwards: the
        // memory-index entry is LAST in discovery order, so it is the FIRST
        // pushed out as the corpus grows — the leg died precisely as the
        // corpus grew toward the wall it guards.
        //
        // The line count is recovered with a BOUNDED read, never by widening
        // the global budget: an index over CC_INDEX_CAP_BYTES already trips
        // the bytes leg unconditionally, so the lines leg only decides
        // anything BELOW that cap — which bounds this read at 25 KB, once,
        // for the single memory-index entry. `readSoFar` is deliberately not
        // charged: this is a cap check, not part of the fat scan, and the
        // overage is bounded by construction rather than by inspection.
        // The text is used for newlines ONLY and never reaches
        // mechFatFromText — the fat definition is untouched.
        m.index.bytes = e.bytes;
        if (e.bytes <= CC_INDEX_CAP_BYTES) {
          try {
            m.index.lines = fs.readFileSync(e.path, 'utf8').split('\n').length;
          } catch { /* unreadable: lines stays 0, same safe direction as the read-error path above */ }
        }
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
  mechFatTokens = 0,
  capacityTokens = CAPACITY_TOKENS,
  indexBytes = 0,
  indexLines = 0,
  wasOver = false,
  economical = false,
  wasEconLatched = false,
} = {}) {
  // TASK #4 — muscle is MEASURED at every gauge, never stamped: everything
  // the certain-fat estimator cannot prove is fat is muscle. The 1:1 line
  // (the file-top ruling, "กล้ามโต 10 หน่วย นิยาม FULL โต 10 หน่วย"): the
  // fat band arms exactly when footprint exceeds muscle + FAT_ARM_TOKENS,
  // so d(threshold)/d(muscle) = 1 — muscle +10 => threshold +10,
  // continuously, with no stamp to lag behind and no event to miss.
  const fat = Math.max(0, Math.round(mechFatTokens));
  const muscleTokens = Math.max(0, Math.round(footprintTokens - fat));
  // The WALL is the REAL capacity line only (the raw working-window
  // placeholder + the CC index caps, both person-independent machine
  // limits). The fullPercent%-of-capacity heuristic and the 0r
  // fatMultiple x floor wall are RETIRED — each was a proxy that read
  // muscle growth as capacity pressure (the task-#4 false positive).
  const capHit =
    footprintTokens >= capacityTokens ||
    indexBytes >= CC_INDEX_CAP_BYTES ||
    indexLines >= CC_INDEX_CAP_LINES;
  // bmi survives as an INFORMATIONAL ratio only — footprint over MEASURED
  // muscle, no longer footprint over a stamped floor and no longer a band
  // driver. Kept because stats/receipts render it.
  //
  // IT DOES NOT MEAN "provably-pure muscle", which is what this comment used
  // to claim. muscle = footprint - fat, so fat=0 forces bmi to exactly 1.00 by
  // arithmetic — 1.00 reports that the estimator PROVED NOTHING, never that the
  // corpus was proven clean. The distinction matters because the estimator's
  // floor is a lower bound: unread and unprovable content counts as muscle, so
  // a store full of semantic bloat also lands on 1.00. gaugeLine suppresses the
  // ratio at fat=0 for exactly this reason.
  const bmi = muscleTokens > 0 ? footprintTokens / muscleTokens : null;
  // Schmitt-trigger hysteresis, re-axed onto CERTAIN FAT (tokens, not a
  // ratio): once armed, fat must fall to the LOW mark to disarm; once
  // disarmed, fat must reach the HIGH mark to arm again. Anti-flap lives in
  // the metric, never a clock — unchanged discipline, new axis.
  const over = wasOver ? fat > FAT_REARM_TOKENS : fat >= FAT_ARM_TOKENS;
  // 0g Q1+Q2 survive on the new axis: FULL/economic = armed AND (fresh
  // proof OR the per-episode latch). `economical` here is the CALLER's
  // combined proof — task #4 condition 2: BOTH break-evens (certain fat AND
  // demotable muscle) must hold; gaugeVerdict ANDs them before this call.
  // The latch's escape is continuous now: whatever actually cuts the
  // certain fat (a hand edit, the wizard — Quick itself has no cutter for
  // this class, see method.md §1) drops the re-measured fat under
  // FAT_REARM_TOKENS, and the next LEAN gauge writes the latch false.
  const econFull = over && (economical || wasEconLatched);
  // hardCeilingTokens: the display "wall" — the real capacity line when that
  // is what fired, else the 1:1 fat line (muscle + arm mark), which moves
  // with muscle by construction.
  const fatLineTokens = muscleTokens + FAT_ARM_TOKENS;

  if (capHit) {
    // The one PERSON-INDEPENDENT line. Certain fat present -> wash first
    // ('absolute-cap' — it may not be enough, but it helps and it is free);
    // ~all muscle -> 'externalize' (a wash cannot shrink muscle; advise
    // moving muscle out / splitting, never "wash harder").
    return over
      ? { band: 'FULL', reason: 'absolute-cap', bmi, over, econLatched: econFull, muscleTokens, hardCeilingTokens: capacityTokens }
      : { band: 'FULL', reason: 'externalize', bmi, over, econLatched: false, muscleTokens, hardCeilingTokens: capacityTokens };
  }
  if (econFull) return { band: 'FULL', reason: 'economic', bmi, over, econLatched: true, muscleTokens, hardCeilingTokens: fatLineTokens };
  return over
    ? { band: 'OBESE', reason: 'fat', bmi, over, econLatched: false, muscleTokens, hardCeilingTokens: fatLineTokens }
    : { band: 'LEAN', reason: 'fat', bmi, over, econLatched: false, muscleTokens, hardCeilingTokens: fatLineTokens };
}

// ---------------------------------------------------------------------------
// economic break-even (deterministic — CODE computes, numbers are SHOWN)
// ---------------------------------------------------------------------------

// cost(one CW run) vs cost(carrying `fatTokens` over the horizon).
// TASK #4: the reclaimable mass is now an INPUT — the caller passes what it
// MEASURED (certain fat, or the envelope's demotable muscle), never a
// footprint-minus-stamped-floor inference (the retired formula that billed
// all growth as fat). One arithmetic, two proofs: gaugeVerdict runs this
// once over mechFat (condition 2a — is the CERTAIN FAT worth a run?) and
// once over the retier envelope's demotable mass (condition 2b — is the
// NON-COMPACT MUSCLE worth a run?); the wizard ask needs BOTH to hold. Each
// half is charged the FULL run cost deliberately — conservative by design:
// the ask this proof arms opens a two-part paid run, and the fix's whole
// direction is fewer, better-grounded asks.
export function breakEven({
  fatTokens = 0,
  footprintTokens = 0,
  totalStoreTokens = 0,
  sessionsPerDay = 1,
  horizonDays = ECON_HORIZON_DAYS,
} = {}) {
  const fat = Math.max(0, Math.round(fatTokens));
  const perDay = Math.round(fat * sessionsPerDay);
  const runCostTokens = Math.round(Math.max(totalStoreTokens, footprintTokens) * RUN_COST_MULTIPLIER);
  const horizonCarryTokens = perDay * horizonDays;
  const breakEvenDays = perDay > 0 ? runCostTokens / perDay : Infinity;
  return {
    fatTokens: fat,
    perDay,
    runCostTokens,
    horizonCarryTokens,
    horizonDays,
    breakEvenDays,
    economical: horizonCarryTokens > runCostTokens,
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
// TASK #4 signature: the stamped floor and its knobs (rawLeanFloorTokens /
// floorProvisional / fullPercent / fatMultiple) are GONE from the flow — fat
// comes from the measure's own certain-fat scan, muscle is footprint minus
// that, and no state has to have HAPPENED for either number to be current.
// `envelope` = retier.mjs's envelopeFor() output ({armAt, fillCeiling}), the
// caller's to supply (conductor/cli resolve it from config; caliper does not
// import retier — retier imports caliper, and a cycle here would be the
// same-module-boundary bug the room's own import rules exist to stop).
// ABSENT envelope => demotable 0 => condition 2b FAILS => the wizard ask
// cannot arm. Fail-closed toward SILENCE, the task-#4 direction: a missing
// input must never manufacture an ask.
export function gaugeVerdict({ measure, wasOver = false, wasEconLatched = false, stamps, envelope = null } = {}) {
  const footprintTokens = measure.alwaysLoaded.tokensEst;
  const mechFatTokens = (measure.mechFat && Number.isFinite(measure.mechFat.tokensEst)) ? measure.mechFat.tokensEst : 0;
  const spd = sessionsPerDay(stamps);
  // Condition 2a — the CERTAIN FAT worth: carry-vs-run over what the
  // mechanical tier can prove is fat right now.
  const econFat = breakEven({
    fatTokens: mechFatTokens,
    footprintTokens,
    totalStoreTokens: measure.totalTokensEst,
    sessionsPerDay: spd,
  });
  // Condition 2b — the NON-COMPACT MUSCLE worth: what the retier envelope
  // would demote from the always-loaded index (the mechanically-computable
  // core of the wizard's "reorganize muscle" half — the envelope DECIDES
  // placement, so its overflow IS the demotable mass; the outsider's
  // semantic judgments beyond that are unquantifiable and deliberately not
  // counted). Under the envelope's arm mark = dead zone = nothing to demote.
  const indexTokens = tokensEstFromBytes(measure.index.bytes);
  const demotableTokens = (envelope && Number.isFinite(envelope.armAt) && Number.isFinite(envelope.fillCeiling) && indexTokens >= envelope.armAt)
    ? Math.max(0, indexTokens - envelope.fillCeiling)
    : 0;
  const econReorg = breakEven({
    fatTokens: demotableTokens,
    footprintTokens,
    totalStoreTokens: measure.totalTokensEst,
    sessionsPerDay: spd,
  });
  // BOTH must hold (task #4 condition 2) before the economic FULL — the band
  // the wizard ask rides — can arm. The band function receives the AND.
  const bothEconomical = econFat.economical && econReorg.economical;
  const verdict = bandVerdict({
    footprintTokens,
    mechFatTokens,
    indexBytes: measure.index.bytes,
    indexLines: measure.index.lines,
    wasOver,
    economical: bothEconomical,
    wasEconLatched,
  });
  const fatTokens = econFat.fatTokens;
  let economical = false;
  let perDay = 0, breakEvenDays = null;
  let reorgPerDay = 0, reorgBreakEvenDays = null;
  if (verdict.band !== 'LEAN' && verdict.reason !== 'externalize') {
    perDay = econFat.perDay;
    breakEvenDays = econFat.breakEvenDays;
    reorgPerDay = econReorg.perDay;
    reorgBreakEvenDays = econReorg.breakEvenDays;
    // FRESH proof only, deliberately NOT `|| latched` (economic-dominance
    // clause: the forced spend needs the deterministic numbers to hold AND
    // be shown at every fire) — a latched-FULL session whose fresh proof
    // dipped keeps the BAND (Q2, no flap) but disarms the FORCE for that
    // session; a pending crossing then degrades to the plain ask (never
    // silent, never a forced run on numbers that don't hold today).
    if (verdict.band === 'FULL') economical = bothEconomical;
  }
  return {
    verdict, fatTokens, mechFatTokens, muscleTokens: verdict.muscleTokens, demotableTokens,
    economical, perDay, breakEvenDays, reorgPerDay, reorgBreakEvenDays,
  };
}

// ---------------------------------------------------------------------------
// OS-CITIZEN STATE LAYOUT (task #13, "well-behaved OS citizen — one namespace").
// PER-PROJECT state RIDES the CC memory dir: it lives BESIDE the platform's own
// per-project memory folder — <claudeBase>/projects/<slug>/coalwash/state.json —
// anchored to the SAME dir discoverClassB already resolves (ccMemoryDir), never
// a re-hardcoded path. Two free wins fall out of riding CC's own directory: CC
// auto-deletes the slug dir when the project is removed (free orphan-prune — no
// shared-map to hand-prune any more), and if CC ever relocates projects/, our
// state rides inside the data CC migrates. CC-FIRST: ccMemoryDir is the Claude
// Code adapter (class-b.mjs); a future AG/Codex port swaps it for that platform's
// own memory-dir resolver — the per-platform recipe stays DATA in class-b's
// adapters, never re-hardcoded here.
//
// Atomic writes, fail-silent: state loss degrades to bootstrap behavior, never
// misbehaves. (The old time-based snooze this section once held died at the
// beta.12 band collapse — nothing here is a clock.)
// ---------------------------------------------------------------------------

// Contain a to-be-CREATED path under `base` (the write path does not exist yet,
// so realpath returns null FOR it). Two gates, both must pass:
//   (1) LEXICAL — `target` sits under `base` with no '..' escape. Both sides
//       pre-realpath, so a symlinked home (macOS /var→/private/var) stays
//       consistent (the walk-stops-at-home hazard).
//   (2) PHYSICAL — the nearest EXISTING ancestor of `target`, realpath-resolved,
//       sits inside realpath(base) (apply.mjs's parent-realpath pattern,
//       generalized because more than the leaf can be missing on a first write).
//       This is the real security check: it catches an already-existing sub-dir
//       (e.g. projects/<slug>) symlinked OUT of the sandbox. It only runs when
//       base itself physically exists — a base that does not exist yet (a fresh
//       install's ~/.claude) has no existing sub-tree to escape THROUGH, so the
//       lexical gate alone governs and the real dirs get created under it.
// Fail-closed: any doubt → false → the caller uses the sandbox fallback (Phoenix
// #10 — a derived path never writes outside ~/.claude).
export function containedNewPath(target, base) {
  const relLex = path.relative(base, target);
  if (relLex !== '' && (relLex.startsWith('..') || path.isAbsolute(relLex))) return false; // lexical escape
  const basePhys = physicalOrNull(base);
  if (!basePhys) return true; // base not created yet: no existing sub-tree to escape; lexical suffices
  let anc = path.resolve(target);
  while (!physicalOrNull(anc)) {
    const parent = path.dirname(anc);
    if (parent === anc) return false; // walked to the fs root with nothing existing
    anc = parent;
  }
  return containedIn(physicalOrNull(anc), [basePhys]);
}

// The per-project state path — beside the CC memory dir. Fail-closed to the
// global coal/coalwash/ namespace (still inside ~/.claude) if the derived path
// somehow escapes the sandbox (task #13 pt 2). Never throws: ccMemoryDir is a
// pure path.join (existence-independent), so a slug-rotted / absent memory dir
// yields a deterministic path here and simply an empty read downstream (pt 5).
// The fail-closed home: the global coal/ namespace, still inside ~/.claude.
export function stateFallbackPath(projectRoot, home = os.homedir()) {
  return path.join(claudeBaseDir(home), 'coal', 'coalwash', `state-${ccProjectSlug(projectRoot)}.json`);
}

// NEVER-CREATE GUARD (2026-07-25 field fix, layer 2 — independent of the layer-1
// derivation fix in config-load's ROOT_MARKERS). CW may write its `coalwash/`
// state ONLY INTO a slug dir that ALREADY EXISTS — CC creates that dir, and its
// existence is CC's own ground truth that this path is a real project. CW never
// mkdirs a slug dir itself, so even a FUTURE derivation bug cannot manufacture a
// phantom `~/.claude/projects/<slug>/`: prevention by construction, not by
// correctness. (Creating the `coalwash/` SUBDIR inside an existing slug dir is
// still fine — that one is ours.) Absent slug dir → the rc.3 coal/ fallback.
function isExistingDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}
export function statePath(projectRoot, home = os.homedir()) {
  const base = claudeBaseDir(home);
  const slugDir = path.dirname(ccMemoryDir(projectRoot, home)); // <base>/projects/<slug>
  const derived = path.join(slugDir, 'coalwash', 'state.json');
  if (isExistingDir(slugDir) && containedNewPath(derived, base)) return derived;
  return stateFallbackPath(projectRoot, home);
}

// The OLD single-file, project-keyed state (pre-relocation). Read as a migration
// fallback; drained + deleted on the first per-project write (dropOldRootEntry).
export function oldStatePath(home = os.homedir()) {
  return path.join(claudeBaseDir(home), '.coalwash-state.json');
}

function projKey(projectRoot) {
  return path.resolve(projectRoot);
}

// Parse a state JSON file → a plain object, or null on any doubt (missing,
// corrupt, wrong-shape, unreadable). Shared by the new-path + old-root reads.
function readStateFile(p) {
  try {
    let raw = fs.readFileSync(p, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const parsed = parseJsonc(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// rc.2 STATE SCHEMA VERSION — the "no-old-version-leftover" standard applied to
// the state layer: a reinstall/upgrade must never carry VERSION-STALE state (a
// consumed crossing from a pre-0m version is meaningless under force-dictator; a
// stale cached verdict band suppresses re-evaluation). Bump this integer whenever
// a state field's SEMANTICS change, and add that field to SCHEMA_RESET_FIELDS
// below. migrateProjSchema() applies the reset lazily on every read; saveState
// stamps the current schema on every write. (task #13's LOCATION relocation is
// NOT a schema change — no field's meaning changed — so STATE_SCHEMA stays 1; the
// location move is its own read-old/write-new mechanism, orthogonal to this reset.
// 0r's growable WALL is ALSO not a schema change: the only persisted field it
// touches is lastVerdict.hardCeilingTokens, a pure per-gauge DISPLAY number
// (ask.mjs's force/externalize headline text). Scoped claim, corrected by
// labtest G1 2026-07-30: hardCeilingTokens ITSELF never gates a decision —
// unlike its sibling lastVerdict.reason, which IS a live Stop-path branch
// input (the ask templates branch on it directly -- externalizeAdvisory's
// own crossing check -- and via forceAuto's `reason` param, which ask.mjs
// branches on for its absolute-cap headline) -- hardCeilingTokens itself
// only decorates whichever message the OTHER fields already selected. It is
// NOT guaranteed fresh on every Stop call, though: the Stop handler's
// re-gauge sits inside `if (!crossing)` (conductor.js:323), so a Stop call
// with an ALREADY-PENDING crossing skips re-gauging and renders the CACHED
// value verbatim — a number a pre-0r version wrote (or a poisoned one) can
// surface once more before self-healing. Worst cross-version case: ONE stale
// informational number in a force/externalize message (the wall figure
// shown may be wrong); which branch fires and whether force runs is
// unaffected (neither depends on hardCeilingTokens), and the next
// SessionStart re-gauges unconditionally and corrects it. No bump: a
// single-turn cosmetic line, never a decision made on stale data.)
export const STATE_SCHEMA = 1;
// VERSION-SENSITIVE — reset when the stored schema is stale. Their meaning
// changed across versions, so a value an older version wrote is not trustworthy
// now. The crossing/edge state changed at 0m (force-dictator); `lastVerdict` is a
// pure per-gauge CACHE whose stale cached band would otherwise suppress the
// re-evaluation rise that re-enrolls the store (dropping it costs nothing — the
// next SessionStart recomputes it, and prevBand→LEAN lets a still-FULL store
// re-arm via the tested "qualifying past" rise). Resetting these is the SAFE
// direction: a spurious reset just re-offers, never strands.
// `lastObeseFat` (the OBESE re-loop watermark) joins the reset for the same
// reason `lastEscalationFat` is here — it is crossing-family state, and a
// watermark written by a version with different re-arm semantics is not
// trustworthy. Resetting it is the SAFE direction (worst case: one extra FREE
// mechanical sweep). Its ADDITION is not itself a schema bump — no existing
// field's meaning changed, per this file's own rule above.
export const SCHEMA_RESET_FIELDS = Object.freeze(['lastCrossing', 'quickTried', 'quickTriedAt', 'lastEscalationFat', 'lastObeseFat', 'lastVerdict']);
// VERSION-STABLE — PRESERVED across a schema bump AND across the location move:
// the project's real footprint BASELINE + history. Must survive a reinstall/
// upgrade, or every version bump false-FULLs the store until the next clean. NOT
// reset: leanFloorTokens · leanFloorProvisional · leanFloorAt · stamps ·
// subSpawns · subParcelTokensAccum · lastSubSpawnAt. (A future ruling that
// changes another field's semantics bumps STATE_SCHEMA + adds it to the reset.)

// Pure schema migration: given a raw per-project state object, return the view
// the current code should act on — reset the version-SENSITIVE fields when the
// stored schema is MISSING/OLDER/CORRUPT (any doubt → older → reset, the safe
// direction), preserve the version-stable baseline. Returns a NEW object; never
// mutates the input, never writes (the stamp lands on the next saveState, so
// loadState stays a pure read for the CLI/every direct reader).
function migrateProjSchema(proj) {
  if (!proj || typeof proj !== 'object' || Array.isArray(proj)) return {};
  const stored = Number(proj.stateSchema);
  if (Number.isInteger(stored) && stored >= STATE_SCHEMA) return proj; // current/newer → untouched
  const out = { ...proj };
  for (const f of SCHEMA_RESET_FIELDS) delete out[f];
  return out;
}

// Read THIS project's entry out of the OLD single-file state (the migration
// fallback when the new per-project file does not exist yet). Inherits the OLD
// file's top-level schema stamp onto the entry (the old layout stamped the
// schema at the top level, not per-entry) so migrateProjSchema resets ONLY a
// genuinely pre-schema store — an rc.2-era crossing is PRESERVED across the pure
// LOCATION move (a move is not a version change).
function readOldRootEntry(projectRoot, home) {
  const all = readStateFile(oldStatePath(home));
  if (!all || !all.projects || typeof all.projects !== 'object') return null;
  const entry = all.projects[projKey(projectRoot)];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const rootSchema = Number(all.stateSchema);
  return Number.isInteger(rootSchema) ? { ...entry, stateSchema: rootSchema } : entry;
}

// Drop dead-project entries from an old-root projects map. keep-on-doubt is
// NARROW here: only a stat that THROWS keeps the entry. `existsSync` returns
// false (not throw) for an offline/UNC path, so a transiently-unreachable
// project's LEGACY entry CAN be dropped in this drain — safe because it drains
// only the old file's own recomputable bookkeeping (never memory content), and a
// wrongly-drained project simply re-stamps a provisional floor next session (0j).
// The old shared-map orphan-prune, now scoped to draining the LEGACY file only
// (the new per-project files ride CC's own dir lifecycle — free orphan-prune).
function pruneDeadEntries(projects) {
  for (const key of Object.keys(projects)) {
    let exists;
    try { exists = fs.existsSync(key); } catch { exists = true; }
    if (!exists) delete projects[key];
  }
  return projects;
}

// On the first per-project write, delete THIS project's entry from the old-root
// file (no-old-version-leftover). Also drains dead entries so the legacy file
// empties out and gets removed even when a since-deleted project still has a
// stale entry. Touches ONLY CoalWash's OWN old-root file — never a wildcard
// sweep (the recovery-paths lesson). Fail-silent (best-effort migration).
function dropOldRootEntry(projectRoot, home) {
  try {
    const p = oldStatePath(home);
    const all = readStateFile(p);
    if (!all || !all.projects || typeof all.projects !== 'object') return;
    delete all.projects[projKey(projectRoot)];
    pruneDeadEntries(all.projects);
    if (Object.keys(all.projects).length === 0) {
      fs.rmSync(p, { force: true }); // last entry gone → drop the legacy file
    } else {
      // U7: UNPREDICTABLE temp + O_EXCL, the same cure apply.mjs's writeDurable
      // carries (read its comment for the full reasoning; this module cannot import
      // it -- apply.mjs imports THIS one, so the dependency runs only one way). A
      // derivable `<dest>.tmp` can be pre-placed by anyone able to write that
      // directory, and a plain writeFileSync FOLLOWS an alias sitting there. Random
      // naming removes the precondition; 'wx' is the cross-nature second belt. No
      // fsync is added here on purpose: this closes a security hole, it does not
      // change this path's durability posture.
      const tmp = `${p}.${crypto.randomBytes(12).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(all), { encoding: 'utf8', flag: 'wx' });
      fs.renameSync(tmp, p);
    }
  } catch { /* fail-silent — migration is best-effort, never blocks a write */ }
}

// Load THIS project's flat state (the SCHEMA-migrated view): the new per-project
// file if present, else the old-root entry (LOCATION fallback), else {}. Always
// returns the migrated view so every reader — the read-only CLI + Stop paths
// included — acts on version-clean state without a write. The location move +
// the schema stamp persist on the next saveState.
export function loadState(projectRoot, home = os.homedir()) {
  // Read the ACTIVE path first, then the coal/ fallback: under the never-create
  // guard a project whose slug dir did not exist yet wrote to coal/, and the slug
  // dir can appear later (CC's first real session) — reading both keeps that
  // state (the lean-floor baseline) from stranding on the location flip.
  const fresh = readStateFile(statePath(projectRoot, home)) || readStateFile(stateFallbackPath(projectRoot, home));
  const proj = fresh || readOldRootEntry(projectRoot, home) || {};
  return migrateProjSchema(proj);
}

// Persist THIS project's flat state to the new per-project path (atomic
// tmp→rename), stamp the current schema, and drain the old-root entry. The dir
// (<claudeBase>/projects/<slug>/coalwash/) sits inside ~/.claude — a data area,
// not a git tree — so no self-ignore is needed (unlike the project bins).
function rmdirIfEmpty(dir) {
  try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch { /* not empty / gone */ }
}

// Test-only perf-regression counter (press 2: wall-clock -> count conversion,
// the fidelity-gate.mjs __testHooks precedent — parseNumTokenCalls et al.).
// R2/TP-6 (Phoenix #3): the O(dirs in projects/) sweep below must run AT MOST
// ONCE per project across its whole write history, not once per write. A
// wall-clock bound on ONE call is the wrong instrument (an environment
// property, not a code one, board #24) and a state-effect assert on the
// SWEEP'S OWN fixture proves nothing when that fixture is never a delete
// candidate in the first place (CWK-012 INSPECT F1, verified by mutation —
// the planted stray's `projectRoot` resolves to itself under
// `findProjectRoot`, so guard 4 in pruneStrayStateDirs skips it whether or
// not the sweep runs at all). Counting INVOCATIONS of the function is the
// one thing that is both load-independent and cannot pass vacuously.
export const __testHooks = {
  strayPruneCalls: 0,
  reset() { this.strayPruneCalls = 0; },
};

// Self-clean CW's OWN pre-fix scatter (no-old-version-leftover, rc.3 precedent):
// slug dirs minted for a NON-root cwd before the layer-1/layer-2 fix.
//
// THE DISCRIMINATOR IS THE RECORDED ROOT, NEVER THE DIR CONTENTS. Verified on the
// live tree 2026-07-25: `projects/<slug-of-a-REAL-project>/` can legitimately hold
// ONLY `coalwash/` with 0 transcripts (CC sweeps transcripts at
// `cleanupPeriodDays`) — so an "only coalwash/, no .jsonl" heuristic would delete a
// LIVE project's lean-floor baseline. Instead: a state file records the root it was
// written for; if the CURRENT resolver does not resolve that root TO ITSELF, the
// path is not a project root, so the file is ours and spurious.
// A file with NO recorded root (written before this fix) is KEPT — keep-on-doubt,
// the same stance pruneDeadEntries takes. That leftover class is bounded: the
// never-create guard means no new one can ever be minted.
//
// OWNERSHIP IS NEVER TESTED BY SLUG-STRING PREFIX. `ccProjectSlug` maps EVERY
// non-alphanumeric char to '-', so the slug of the SIBLING project `work/proj-notes`
// is byte-identical in shape to that of the SUBDIR `work/proj/notes` — a
// `startsWith(mine + '-')` test cannot tell them apart and deleted a sibling
// project's gate-passed lean floor (blind wave R1 / TP-2: its baseline reset to
// provisional → BMI 1.00 → CW goes silent on that project). Ownership is decided by
// the RECORDED ROOT alone, with the dir name required to be that root's own slug so
// a planted state file cannot nominate someone else's directory for deletion.
//
// Every rm is realpath-contained first (TP-3): a junction planted under
// `projects/` otherwise makes the delete land OUTSIDE ~/.claude, which is the one
// thing every other CoalWash write/delete already guards (realpath BOTH sides).
// Touches ONLY `coalwash/state.json` + the dirs it leaves empty — never a foreign
// file, never a non-empty dir (the recovery-paths lesson). Fail-silent.
function pruneStrayStateDirs(projectRoot, home) {
  __testHooks.strayPruneCalls++;
  try {
    const base = claudeBaseDir(home);
    const projectsDir = path.join(base, 'projects');
    const mineRoot = physicalDir(projectRoot);
    const mine = ccProjectSlug(projectRoot);
    for (const name of fs.readdirSync(projectsDir)) {
      if (name === mine) continue;
      const slugDir = path.join(projectsDir, name);
      const f = path.join(slugDir, 'coalwash', 'state.json');
      const rec = readStateFile(f)?.projectRoot;
      if (typeof rec !== 'string' || !rec) continue;            // legacy/unknown → keep-on-doubt
      if (name !== ccProjectSlug(rec)) continue;                // the dir must BE that root's slug (anti-plant)
      if (physicalDir(findProjectRoot(rec, home)) !== mineRoot) continue; // not a stray cwd of THIS project → not ours to touch
      if (physicalDir(rec) === mineRoot) continue;              // that IS this project's root, not a stray
      if (!containedNewPath(f, base)) continue;                 // realpath-and-contain before ANY rm (junction escape)
      fs.rmSync(f, { force: true });                            // ours, and spurious
      rmdirIfEmpty(path.join(slugDir, 'coalwash'));
      rmdirIfEmpty(slugDir);
    }
  } catch { /* fail-silent — cleanup is best-effort, never blocks a write */ }
}

function saveState(proj, projectRoot, home) {
  try {
    const p = statePath(projectRoot, home);
    fs.mkdirSync(path.dirname(p), { recursive: true }); // the coalwash/ subdir only — the slug dir must already exist (never-create guard)
    // `projectRoot` is the stray-detector's key (above). Version-STABLE metadata,
    // no field's SEMANTICS change → no STATE_SCHEMA bump (this file's own rule).
    const base = (proj && typeof proj === 'object' && !Array.isArray(proj)) ? proj : {};
    // ONE-SHOT, not per-write (Phoenix #3). The stray sweep is a ONE-TIME migration
    // for a condition the never-create guard makes unrepeatable, but it ran on EVERY
    // saveState at O(dirs in ~/.claude/projects), on a PostToolUse(Agent) path that
    // fires on every spawn (blind wave R2 / TP-6). The suite never saw it because
    // every fixture starts with an empty projects/.
    // HONEST NUMBERS, re-measured with a REAL state.json in each sibling dir (the
    // first figures were taken against EMPTY siblings, so the per-dir read never
    // happened — an under-measurement, corrected here): the ONE-SHOT migration write
    // costs 9.4 ms @ N=21 · 14.5 ms @ N=100 · 107.6 ms @ N=1000. Steady state is flat
    // at ~3.2-3.5 ms regardless of N, which is the property that matters: only the
    // single migration write pays, and only once per project. The flag is
    // version-STABLE bookkeeping — no field's semantics
    // change, so no STATE_SCHEMA bump (this file's own rule).
    const alreadySwept = base.strayPruneDone === true;
    const toWrite = { ...base, stateSchema: STATE_SCHEMA, projectRoot: path.resolve(projectRoot), strayPruneDone: true };
    // U7: UNPREDICTABLE temp + O_EXCL, the same cure apply.mjs's writeDurable
    // carries (read its comment for the full reasoning; this module cannot import
    // it -- apply.mjs imports THIS one, so the dependency runs only one way). A
    // derivable `<dest>.tmp` can be pre-placed by anyone able to write that
    // directory, and a plain writeFileSync FOLLOWS an alias sitting there. Random
    // naming removes the precondition; 'wx' is the cross-nature second belt. No
    // fsync is added here on purpose: this closes a security hole, it does not
    // change this path's durability posture.
    const tmp = `${p}.${crypto.randomBytes(12).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(toWrite), { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(tmp, p);
    dropOldRootEntry(projectRoot, home); // no-old-version-leftover (the rc.2-era legacy file)
    // EXACTLY ONE LIVE HOME. loadState reads the slug-dir path then the coal/
    // fallback, so a fallback copy left behind after the home flips is not merely
    // stale — when the slug dir later disappears (project removed /
    // cleanupPeriodDays) the read silently RESURRECTS it and the lean floor
    // reverts to a pre-flip value (blind wave R1 / TP-5). Reap our own old copy on
    // the write that moves home; same no-old-version-leftover mechanism as above.
    const fb = stateFallbackPath(projectRoot, home);
    if (path.resolve(p) !== path.resolve(fb)) { try { fs.rmSync(fb, { force: true }); } catch { /* best-effort */ } }
    if (!alreadySwept) pruneStrayStateDirs(projectRoot, home);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// GLOBAL (not project-bound) state → the coal/coalwash/ namespace (task #13
// pt 3). CW's state is otherwise per-project; the self-update scheduler's
// throttle stamp is the one global piece. Same read-new/fallback-old +
// write-new/delete-old migration as the per-project state above.
// ---------------------------------------------------------------------------
export function updateStampPath(home = os.homedir()) {
  return path.join(claudeBaseDir(home), 'coal', 'coalwash', 'update-check');
}
export function oldUpdateStampPath(home = os.homedir()) {
  return path.join(claudeBaseDir(home), '.coalwash-update-check');
}
// Read the update-check timestamp: the new location, else the old root stamp
// (migration read). 0 when neither exists / is unreadable.
export function readUpdateStamp(home = os.homedir()) {
  for (const p of [updateStampPath(home), oldUpdateStampPath(home)]) {
    try {
      const n = Number(String(fs.readFileSync(p, 'utf8')).trim());
      if (Number.isFinite(n) && n > 0) return n;
    } catch { /* try the next location */ }
  }
  return 0;
}
// Write the update-check timestamp to the new location + delete the old stamp
// (no-old-version-leftover). Fail-silent.
export function writeUpdateStamp(now, home = os.homedir()) {
  try {
    const p = updateStampPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, String(now));
    try { fs.rmSync(oldUpdateStampPath(home), { force: true }); } catch { /* best-effort */ }
    return true;
  } catch {
    return false;
  }
}

// Append a session stamp {t, fp} (ring-capped) and return the updated project
// state. Fail-silent: on any write failure the in-memory view is still returned.
// 0o session boundary: this is the once-per-session heartbeat (SessionStart's
// gauge calls it exactly once), so the sub-spawn true-bill counters reset
// HERE — the stats line is a session figure, not a lifetime ledger. The
// counters that then accumulate belong to THIS session's spawns.
export function recordStamp(home, projectRoot, footprintTokens, now = Date.now()) {
  const proj = loadState(projectRoot, home);
  proj.stamps = Array.isArray(proj.stamps) ? proj.stamps : [];
  proj.stamps.push({ t: now, fp: Math.round(footprintTokens) });
  if (proj.stamps.length > STAMP_RING_MAX) proj.stamps = proj.stamps.slice(-STAMP_RING_MAX);
  delete proj.subSpawns;
  delete proj.subParcelTokensAccum;
  saveState(proj, projectRoot, home);
  return proj;
}

// 0o "SUBAGENT BLIND SPOT" — the TRUE-BILL COUNTER: every sub spawned from
// this room carries the full parcel at spawn time, and the cost is incurred
// AT THE SPAWN SITE (main) — so the meter lives here, fed by the PostToolUse
// Agent-tool hook. Silent, write-only bookkeeping (the NOISE RULE, pinned):
// N spawns = N silent increments; the accumulated figure surfaces ONLY
// through the voices that already exist (/coalwash:stats · the FULL
// force/wizard directive numbers). The parcel cost = the CACHED verdict's
// alwaysLoadedBytes (stat-cheap, NO re-gauge, NO discovery walk); a project
// never gauged counts the spawn at cost 0 — never compute at spawn time.
// Cross-room honesty (named approximation, deliberately NOT "fixed"): a sub
// spawned with a different cwd still bills the CURRENT room's cached parcel
// — conservative, no cwd-detection machinery (no over-engineering per 0o).
export function recordSubSpawn(home, projectRoot, now = Date.now()) {
  const proj = loadState(projectRoot, home);
  const bytes = Number(proj.lastVerdict && proj.lastVerdict.alwaysLoadedBytes);
  const parcelTokens = Number.isFinite(bytes) && bytes > 0 ? tokensEstFromBytes(bytes) : 0;
  proj.subSpawns = (Number.isFinite(Number(proj.subSpawns)) ? Number(proj.subSpawns) : 0) + 1;
  proj.subParcelTokensAccum = (Number.isFinite(Number(proj.subParcelTokensAccum)) ? Number(proj.subParcelTokensAccum) : 0) + parcelTokens;
  proj.lastSubSpawnAt = now;
  return saveState(proj, projectRoot, home);
}

// LEGACY (task #4) — the stamped lean floor is RETIRED as a band driver: no
// gauge reads it any more (fat and muscle are measured from content at every
// gauge). This stamp, ensureProvisionalFloor, and sanitizeLeanFloor survive
// only as state-history writers/readers (the floor fields already persisted
// in real stores stay harmless bytes; SKILL.md's post-clean step may still
// invoke this for the receipt's history line). Task #4's own audit measured
// this function at ZERO production callers across scripts/ and hooks/ while
// the band's documented "post-clean floor stamp" escape depended on it — the
// uncalled release valve that let an all-muscle store latch FULL forever.
export function setLeanFloor(home, projectRoot, tokens, now = Date.now()) {
  const proj = loadState(projectRoot, home);
  proj.leanFloorTokens = Math.round(tokens);
  proj.leanFloorAt = now;
  delete proj.leanFloorProvisional;
  return saveState(proj, projectRoot, home);
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
  const proj = loadState(projectRoot, home);
  const existing = Number(proj.leanFloorTokens);
  if (Number.isFinite(existing) && existing > 0) {
    return { floorTokens: existing, provisional: proj.leanFloorProvisional === true };
  }
  const fp = Number(footprintTokens);
  if (!Number.isFinite(fp) || fp < FLOOR_MIN_TOKENS) return { floorTokens: 0, provisional: false };
  proj.leanFloorTokens = Math.round(fp);
  proj.leanFloorAt = now;
  proj.leanFloorProvisional = true;
  saveState(proj, projectRoot, home);
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
// two payback fields (`perDay`/`breakEvenDays`) so the Stop
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
// `perDay`/`breakEvenDays` (breakEven()'s output,
// optional) back the Stop hook's payback line on ANY ask, not just FULL's.
export function recordVerdict(home, projectRoot, verdict, now = Date.now(), { scanEverything = false } = {}) {
  const proj = loadState(projectRoot, home);
  const perDay = Number(verdict && verdict.perDay);
  const breakEvenDays = Number(verdict && verdict.breakEvenDays);
  const hardCeilingTokens = Number(verdict && verdict.hardCeilingTokens);
  const alwaysLoadedBytes = Number(verdict && verdict.alwaysLoadedBytes);
  const storeTotalBytes = Number(verdict && verdict.storeTotalBytes);
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
    // task #4 — the measured pair + condition 2b's own proof numbers, cached
    // for the Stop ask (additive fields on a per-gauge cache overwritten
    // fresh every gauge; no schema bump — absence on an old cache degrades to
    // zeros, which the ask template renders as "no reorg case").
    muscleTokens: Number.isFinite(verdict && verdict.muscleTokens) ? Math.round(verdict.muscleTokens) : 0,
    demotableTokens: Number.isFinite(verdict && verdict.demotableTokens) ? Math.round(verdict.demotableTokens) : 0,
    reorgPerDay: Number.isFinite(verdict && verdict.reorgPerDay) ? Math.round(verdict.reorgPerDay) : 0,
    reorgBreakEvenDays: Number.isFinite(verdict && verdict.reorgBreakEvenDays) ? verdict.reorgBreakEvenDays : null,
    hardCeilingTokens: Number.isFinite(hardCeilingTokens) ? Math.round(hardCeilingTokens) : 0,
    // WARP-HOLE (beta.13 item 3): the always-loaded path list + its byte total
    // AT this gauge — the Stop hook's cheap re-stat baseline
    // (statOnlyFootprintBytes above). Capped defensively (state-size hygiene);
    // a truncated list only narrows the delta gate's visibility, never breaks
    // anything (fail-safe: undercounting just delays a re-gauge to the next
    // SessionStart, the EXISTING behavior this feature is additive to).
    // CWK-057: ON lifts the truncation. Note precisely WHAT this cut hides, so
    // nobody re-reads it as a report cut: this list is the Stop hook's cheap
    // re-stat baseline (statOnlyFootprintBytes), so a path past #200 is never
    // re-stat'd and a size change there is invisible to the CHEAP gate -- the
    // next SessionStart's full gauge still catches it. Lifting it grows the
    // persisted array; that is the declared cost of the mode, and the field's
    // MEANING is unchanged, so no stateSchema bump (this file's own rule).
    alwaysLoadedPaths: rawPaths.filter((p) => typeof p === 'string').slice(0, scanEverything === true ? Infinity : ALWAYS_LOADED_PATHS_CAP),
    alwaysLoadedBytes: Number.isFinite(alwaysLoadedBytes) ? Math.round(alwaysLoadedBytes) : 0,
    // The WHOLE measured class-B store (measureEntries m.totalBytes: always-
    // loaded + recall tiers) — the bin-retention budget base (P5/P8 fix: the
    // bins shadow what washes cut, which is store-wide; the always-loaded
    // slice under-based the budget by the lab's measured ~62x). Absent on an
    // old-schema state -> apply's sweep reads 0 -> horizon-only until the
    // next gauge writes it (keep-on-doubt; no stateSchema bump needed — no
    // existing field changed meaning, and the absence self-heals in one
    // SessionStart).
    storeTotalBytes: Number.isFinite(storeTotalBytes) ? Math.round(storeTotalBytes) : 0,
    at: now,
  };
  return saveState(proj, projectRoot, home);
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
  const proj = loadState(projectRoot, home);
  proj.quickTried = true;
  proj.quickTriedAt = now;
  return saveState(proj, projectRoot, home);
}

// dig-gauge once-per-session arm (ULTRA trigger #2, dig-gauge.mjs): a CRUSHING
// pre-read dig surfaces the ULTRA offer ONCE per session, then stays silent
// until a NEW session — the same session-keyed shape as recordCrossing's
// `session` guard (a re-run inside one session is ONE surface, not two).
// Returns { surface } — true when THIS call should emit the offer. No session
// id → always surface (fail TOWARD surfacing: a missed crush warning is worse
// than a repeated one, and declining is free so a repeat never blocks — and
// with no session id there is nothing to dedup on, so no write happens either).
// This is the ONE state write the dig-gauge CLI path makes, and it touches ONLY
// its own dedup flag — never a stamp/verdict/crossing (those stay the
// SessionStart conductor's session/economics bookkeeping; a dig-gauge call is a
// measurement, not a session event). Called ONLY on a CRUSHING verdict, so a
// CLEAR dig writes nothing at all.
export function armDigGauge(home, projectRoot, session, now = Date.now()) {
  if (session == null) return { surface: true };
  const proj = loadState(projectRoot, home);
  if (proj.digGaugeSession === session) return { surface: false }; // already surfaced this session
  proj.digGaugeSession = session;
  proj.digGaugeAt = now;
  saveState(proj, projectRoot, home);
  return { surface: true };
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
// opts.quickTried / opts.fatTokens (beta.13 "0e THE OBESE LOOP"; SUPERSEDED
// beta.14 by 0f "AUTHORITATIVE 3-FLOW" [trigger band OBESE→FULL]; SHARPENED
// rc.2 by USER decision B [FORCE-THEN-ASK on every growth]): a plain RISE
// arms exactly as before (`{band, at, consumed:false}`, no new key — every
// rise-arm assertion holds byte-for-byte) → the case-b FREE Quick force runs.
// After that force is CONSUMED and the store is STILL over, two branches take
// over, sequenced ENTIRELY by the consumed crossing's shape (no extra state):
//   • ASK — the consumed crossing is PLAIN (`!escalation`): a force just ran →
//     arm the wizard escalation (`escalation:true`), the ONE ask site (0f).
//   • FORCE-on-growth — the consumed crossing is an ESCALATION (an ask already
//     fired) and fat GREW past `lastEscalationFat`: arm a fresh PLAIN crossing
//     so the FREE Quick force re-runs on the new lump FIRST; the ask follows
//     via ASK on the next tick. USER decision B: every fat lump may carry NEW
//     mechanical fat the free code sweeps at ~0 token — never ask the agent to
//     judge fat the sweep could have cut. Growth-gated (never a plateau
//     re-nag; "ask frequency tracks fat-growth rate, never a clock"). OBESE is
//     UNTOUCHED (0f/0d: auto-Quick-silent, never asks, at any fat).
export function recordCrossing(home, projectRoot, newBand, prevBand, now = Date.now(), opts = {}) {
  // `session` (rc.2): the CURRENT session id (opts.session; the conductor
  // passes input.session_id). Recorded ON the crossing so a re-arm can tell a
  // NEW session from a same-session re-run. Added to the crossing object ONLY
  // when provided — a caller that passes no session keeps the exact
  // pre-existing 2-key/3-key shape (the shape the unit pins assert).
  const { quickTried = false, fatTokens = 0, session } = opts || {};
  const withSession = (o) => (session !== undefined ? { ...o, session } : o);
  const proj = loadState(projectRoot, home);
  if (newBand === 'LEAN') {
    delete proj.lastCrossing;
    // 0f: LEAN is the episode's clean reset — a FUTURE FULL plateau gets a
    // fresh, unconditional escalation gate, never treated as "already
    // tried" leftover from a store that has since been cleaned.
    delete proj.quickTried;
    delete proj.quickTriedAt;
    delete proj.lastEscalationFat;
    delete proj.lastObeseFat;
  } else if ((BAND_RANK[newBand] ?? 0) > (BAND_RANK[prevBand] ?? 0)) {
    proj.lastCrossing = withSession({ band: newBand, at: now, consumed: false });
    // OBESE RE-LOOP watermark (see the branch at the end): stamp the fat level
    // this sweep was armed at, so the re-arm below needs GENUINE new inflow and
    // not merely a re-read of the same fat. Stamped on the CROSSING's own state,
    // never on the crossing OBJECT — the crossing shape is pinned by tests.
    if (newBand === 'OBESE') proj.lastObeseFat = fatTokens;
  } else if (
    // ASK (the wizard escalation, 0f's SOLE ask site): a PLAIN force was JUST
    // consumed (case-b Quick ran this episode → quickTried set) and the store is
    // STILL over → ask the wizard. Keyed on the consumed crossing being PLAIN
    // (`!escalation`): this fires EXACTLY ONCE after a force, because the
    // escalation crossing it arms carries `escalation:true`, which this same
    // guard then blocks on the next tick — no re-nag on a plateau. Growth-gated
    // with the day-one exemption: the FIRST ask of an episode arms at any fat
    // (?? -1 → fat≡0 over-wall store included, provisional floor = footprint);
    // a later ask needs fat GENUINELY GROWN past the last-flagged level. The
    // real flow always REACHES this after a rise→force or a FORCE-on-growth→force
    // (both arm a plain crossing that case-b consumes) — a bare quickTried with
    // no consumed crossing no longer short-circuits to an ask (that skipped the
    // free force; USER decision B).
    newBand === 'FULL' && quickTried &&
    proj.lastCrossing && proj.lastCrossing.consumed === true && !proj.lastCrossing.escalation &&
    fatTokens > (proj.lastEscalationFat ?? -1)
  ) {
    proj.lastCrossing = withSession({ band: newBand, at: now, consumed: false, escalation: true });
    proj.lastEscalationFat = fatTokens;
  } else if (
    // FORCE-on-growth (arms a PLAIN crossing → the case-b FREE Quick force
    // re-fires): fat GREW past the last-asked level on a CONSUMED crossing →
    // re-run the free mechanical sweep FIRST, and only if it leaves the store
    // over does the ASK branch above deliver the wizard ask on the next tick
    // (USER decision B — force-THEN-ask on every growth: each new fat lump may
    // carry NEW mechanical fat the free code sweeps at ~0 token; asking the
    // agent to judge fat the sweep could have cut is the waste we refuse. "The
    // program sweeps certainty, cannot judge" — certainty is swept before every
    // ask). This is the ONE re-arm branch; the consumed-crossing SHAPE sequences
    // force↔ask with no extra state:
    //   - a PLAIN-consumed crossing + quickTried = a force just ran, ask pending
    //     → taken by the ASK branch above, never here (so this never loops back
    //     into another force before the ask — the ask is never starved);
    //   - an ESCALATION-consumed crossing = an ask already fired at the old
    //     level → new growth reaches HERE → arm a fresh PLAIN force → (case b) →
    //     re-gauge still over → ASK arms the next escalation. Force→ask, once
    //     per growth lump.
    //   - the pre-0m STRAND (consumed, quickTried never set → the escalation
    //     path was historically unreachable) → also arms plain here → force,
    //     THEN ask (point e), across a NEW session.
    // FULL band ONLY (OBESE auto-Quick-fires on its own crossing and never asks,
    // 0d/0f; gating >= OBESE also breaks no-nag — lastEscalationFat is FULL-only,
    // so an OBESE plateau would read `fat > -1` = re-arm forever).
    // SAME-SESSION re-arm is allowed ONLY once a force ran (`quickTried` — the
    // long-session drag: a user riding ONE session past every growth still gets
    // force→ask per lump); a raw same-session consumed crossing with no force
    // history (the strand shape) keeps the no-nag session guard so it never
    // re-offers within the session that armed it. Growth-gated → a plateau at
    // the same fat stays silent; lastEscalationFat climbs monotonic (set by ASK).
    newBand === 'FULL' &&
    proj.lastCrossing && proj.lastCrossing.consumed === true &&
    fatTokens > (proj.lastEscalationFat ?? -1) &&
    (quickTried || proj.lastCrossing.session !== session)
  ) {
    proj.lastCrossing = withSession({ band: newBand, at: now, consumed: false });
  } else if (
    // OBESE RE-LOOP on new fat inflow (USER 2026-07-25). BEFORE: OBESE armed
    // exactly ONCE, on the RISE — branches 3 and 4 above are both FULL-only, so
    // a store sitting at OBESE while it kept accreting mechanical garbage was
    // swept once and then went silent until it either rose to FULL or fell back
    // to LEAN. Every new wave of free-to-cut fat just rode along. NOW: each new
    // inflow re-arms the FREE mechanical sweep, and the accumulated fat is what
    // eventually carries the store into FULL, where the wizard ask lives.
    //
    // OBESE STILL NEVER ASKS. This arms a PLAIN crossing only; `escalation:true`
    // remains FULL-only (0d/0f), so the auto-Quick loop can never turn into a
    // question. The consent is the same standing config that already authorizes
    // OBESE's auto-Quick — nothing costed became automatic here.
    //
    // THE PLATEAU GUARD is what makes this branch safe to add at all. rc.2 (g)
    // was right that a bare `>= OBESE` gate "re-armed every flat plateau
    // forever" — because OBESE had no watermark of its own and borrowed FULL's
    // absent `lastEscalationFat` (`fat > -1` = always true). The fix is a
    // watermark of its OWN, not a wider gate: `lastObeseFat` is stamped every
    // time an OBESE crossing is armed, so an unchanged plateau compares equal
    // and stays SILENT. Growth, never a clock — the 0e frequency law.
    //
    // NAMED DIVERGENCE from the FULL watermark above, which uses a strict `>`:
    // this one carries a REGAUGE_DELTA_TOKENS cushion. FULL's re-arm fires only
    // after a wizard ask (rare); this fires on ordinary accretion at every Stop
    // tick, so jitter — a timestamp edit, a few reworded words — must not buy a
    // whole sweep. Same constant and same meaning as the WARP-HOLE gate that
    // decides "did anything real change": below it, nothing meaningful did.
    newBand === 'OBESE' &&
    proj.lastCrossing && proj.lastCrossing.consumed === true &&
    fatTokens > (proj.lastObeseFat ?? 0) + REGAUGE_DELTA_TOKENS
  ) {
    proj.lastCrossing = withSession({ band: newBand, at: now, consumed: false });
    proj.lastObeseFat = fatTokens;
  }
  return saveState(proj, projectRoot, home);
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
  const proj = loadState(projectRoot, home);
  if (proj.lastCrossing && typeof proj.lastCrossing === 'object') {
    proj.lastCrossing = { ...proj.lastCrossing, consumed: true, consumedAt: now };
  }
  return saveState(proj, projectRoot, home);
}
