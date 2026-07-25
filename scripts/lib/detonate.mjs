// detonate.mjs — the SUPPORT engine (STEP 2) that GATES the main reducer (explode.mjs).
//
// WHY IT EXISTS: explode.mjs is INCOMPLETE-by-design — it TRUSTS its input and only benign-no-ops on
// forged input (a forged offset/outLen → ok:true no-op, source intact; it does NOT reject bad input).
// detonate COMPLETES it as the MECHANICAL floor: it proves the input is CORRECT + safe (the file, the
// structure, the write paths, the params), then EXECUTES the caller's cut and snapshots it. The abusive
// caller is REFUSED, not corrupted. Safety lives in this CODE (the mechanical gates), never in a manual.
//
// WHAT IT DELIBERATELY DOES NOT DO — the mechanical floor is not the semantic ceiling: it does NOT judge
// the question "is this unit waste (rock) or content (ore)?". That question is UNDECIDABLE for a
// deterministic engine (Rice's theorem) — an earlier version tried it (a 3-field content denylist +
// a 512KB front sample) and an adversarial break found TWO silent data-loss holes (content-bearing
// past the sample, or under a field name the denylist missed). So the rock-vs-ore call belongs to the
// calling AGENT, made WITH understanding: the agent supplies `request.cutTypes`, the engine executes it.
// What the engine offers instead is an ADVISORY REPORT (below): a mechanical, non-blocking "possible ore"
// SIGNAL the agent reads before deciding — the floor SUPPORTING the ceiling, never replacing it.
//
// THE ADVISORY'S LIMIT — NAMED HONESTLY (it is a SIGNAL, never a verdict): the report's `freeFormCount` is
// a BEST-EFFORT mechanical signal, NOT a complete or sound detector. It CAN MISS ore (content nested past
// the depth cap — now SURFACED per-type as `depthCappedCount` so a capped 0 is never a silent lie (L6) — or
// obfuscated: "is this content?" is undecidable for a deterministic engine by Rice's theorem, so no
// cap/heuristic ever makes it total, and the obfuscated miss stays unsignalled) AND it CAN FALSE-FLAG (a long
// non-prose id / hash / base64 blob trips the byte-length signal though it is not prose). It therefore INFORMS the agent's rock-vs-ore
// decision; it NEVER decides or guarantees. The AGENT is the adjudicator — the cut is agent-signed judgment,
// not a gate-proven fact — and the snapshot is the undo net for a wrong call. (This record names its own
// signature: a support signal, not a proof.)
//
// RAILS: deterministic · zero-dep (Node built-ins only) · fail-closed on the MECHANICAL gates (unprovable
// input → refuse, never cut) · NEVER throws (any internal error → refuse('internal')) · the advisory
// report NEVER blocks the cut. It does NOT re-implement the reducer's internals — it is the INPUT GATE;
// the main engine already holds the safety floor (source-sacred / no-torn / byte-exact).
import fs from 'node:fs';
import path from 'node:path';
import { discoverStructure, reduceToCompletion, collidesWithSource, scanWave, physicalForCreate, isContainedIn, lineText, CLAUDE_DEFAULT_CUT_TYPES, SNAPSHOT_MANIFEST, CHUNK, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES } from './explode.mjs';

// The long-string boundary for the advisory free-form flag (config key `freeStringMaxChars`, default 80).
// A string whose UTF-8 BYTE length exceeds this, anywhere in a unit, is a mechanical "possible ore" signal
// — NOT a decision. The config key keeps the historical name `freeStringMaxChars` for compat, but the
// comparison is BYTES (FIX 4-R2: a char-length check under-counted non-ASCII — a 74-char/194-byte Thai/CJK
// string evaded it though it is clearly content; the aggregate signal (b) was already byte-aware).
const FREE_STRING_MAX_CHARS = 80;
const FREE_FORM_AGG_BYTES = 1024;           // aggregate free-form signal: a unit whose strings SUM past ~1KB is
                                            // content-bearing even when NO single string is long (catches 20000×short).
                                            // INTENTIONALLY NOT moved when the depth cap rises: raising this bound trades
                                            // a fake-0 for false-flags (a long id/hash pile), so it stays the documented
                                            // honest-ceiling edge (floor-not-ceiling — a signal, never a verdict).
const WALK_DEPTH = 18;                      // depth cap for the field-agnostic unit walk (raised 6→12→18: covers common
                                            // nested tool-JSON). A cap is floor-not-ceiling: raising it MOVES the miss
                                            // boundary (Rice), it NEVER removes the miss — the header's "CAN MISS" holds.
const WALK_BREADTH = 256;                   // BREADTH budget for the redacted SAMPLE walk (redactUnit) — a TOTAL count of
                                            // array-elements/object-entries the redaction may MATERIALIZE, shared across
                                            // the WHOLE walk (NOT per-node). redactUnit builds a redacted COPY that
                                            // JSON.stringify then renders WHOLE before the SAMPLE_STR_CAP slice, so an
                                            // un-capped walk of a fat unit (a tool_result with ~1e6 short strings — a real
                                            // dir-listing/grep/token-id shape — or a whole-file json-single unit) materializes
                                            // an O(unit) structure = O(filesize) sample-build PEAK + retain (measured: a 120MB
                                            // file secretly RETAINED ~240MB in the returned census, self-OOM). A TOTAL budget
                                            // bounds the built structure to O(WALK_BREADTH) regardless of SHAPE; a per-node cap
                                            // alone would let a deep-but-moderately-wide tree (fan-out < cap, WALK_DEPTH deep)
                                            // still visit O(unit) nodes. 256 comfortably overfills the 200-char preview yet
                                            // holds one in-flight redaction to ~KB. Past the budget: one honest "…(N more)"
                                            // marker. Sibling of WALK_DEPTH / SAMPLE_MAX: a named cap, floor-not-ceiling.
const SAMPLE_MAX = 2;                       // up to N redacted examples per free-form-bearing type
const SAMPLE_STR_CAP = 200;                 // cap each redacted sample's length (the report stays small)
const SAMPLE_AGG_BYTES = 128;               // FIX 3-R2: redaction budget — once a sample's cumulative raw-string
                                            // bytes pass this, every FURTHER string collapses to «free-form N chars»
                                            // (kept < SAMPLE_STR_CAP so the marker is visible within the capped sample:
                                            // an aggregate-flagged unit shows STRUCTURE + the first little bit, never a
                                            // WALL of raw prose). Mirrors isFreeFormBearing's aggregate discipline.
// TYPE-CARDINALITY ceiling for the SURVEY census (wantSet=null / accept-all). perType allocates one entry per
// DISTINCT type token; without a cap an adversarial ndjson where EVERY line carries a unique `type` drives it
// O(distinct-types) = O(N) memory (measured: a 42MB unique-type flood → 1.6M entries → ~449MB peak, self-OOM
// on the engine's own 50MB+ target — the one census axis SAMPLE_MAX / WALK_DEPTH / REPORT_MAX_BYTES / oversized
// step-over had left uncapped). Real transcripts hold <100 distinct unit types (Claude ~5:
// user/assistant/system/tool_use/tool_result; other platforms measured similarly low), so a low-thousands cap
// leaves ~40× headroom over even a pathologically-rich real file while bounding perType to O(cap) entries,
// filesize-INDEPENDENT. Sibling of SAMPLE_MAX / WALK_DEPTH: a named cap, floor-not-ceiling. Past the cap a unit
// is still COUNTED in aggregate (otherTypesUnits → totalUnits stays complete) and typesTruncated:true NAMES the
// bounding — NEVER a silent tail-drop (the census-fidelity rail: no unit vanishes). detonate's report path
// (wantSet a Set) is already bounded by |cutTypes| → the cap never fires there (byte-identical). EXPORTED for
// the gate test (one-flock with MAX_WAVE_LINES).
export const TYPE_CENSUS_MAX = 4096;
const REPORT_MAX_BYTES = 16 * 1024 * 1024;  // per-wave carry bound for the report scan (constant memory; mirrors explode's default)
const REPORT_MAX_LINES = Number.MAX_SAFE_INTEGER; // bytes is the real per-wave bound; lines effectively unbounded
const NL = 0x0a;                            // newline byte — for the bounded forward-scan that steps over an oversized unit
const SKIP_SCAN_CHUNK = 1 << 20;            // 1 MiB forward-scan granularity when stepping over an oversized unit (memory-bounded)
const OVERSIZED_FRONT_BYTES = 4096;         // FIX 7-R2: bounded front-read to recover an oversized unit's type token
                                            // (the type sits at the object front; the giant unit is NEVER buffered whole)

// gate-5 per-wave budget CEILINGS (the MEMORY axis — the upper twin of the CHUNK / DEFAULT_MAX_LINES FLOORS).
// A wave buffers its kept lines and flushes once via Buffer.concat (explode.mjs reduceFile), so a per-wave budget
// large enough to span the WHOLE file makes ONE wave hold every kept line in RAM at once — peak RAM O(filesize),
// the exact OOM gate 5 ALREADY refuses for Infinity. A FINITE-but-huge budget (e.g. 1e15) reaches the IDENTICAL
// whole-file buffer yet sailed through the bare `Number.isFinite && >= floor` check — its premise "finite ⇒
// bounded" is wrong: a per-wave budget ≥ the filesize gives no memory bound BELOW the filesize. The ceiling closes
// that. Ceiling = 16 × the FLOOR for BOTH budgets: the BYTE ceiling is the engine's own DEFAULT_MAX_BYTES factory
// budget (= 16 × CHUNK — the largest per-wave DATA memory the engine self-selects; a gated caller may LOWER toward
// CHUNK but never RAISE above the factory budget), and the LINE ceiling mirrors that same 16× headroom over
// DEFAULT_MAX_LINES so the kept[] array's per-line-Buffer SLOT count is bounded too (the concat blob is bounded by
// the byte ceiling; the view objects by this). Together they hold one wave's peak RAM to a filesize-INDEPENDENT
// constant (the streaming rail: memory ≤ ceiling on ANY filesize) while a large file still reduces in N>1 bounded
// waves. REFUSE above the ceiling (fail-closed, mirroring gate 5's floor refusal + the Infinity precedent), never
// clamp. The RAW reduceFile stays permissive — its budget is a documented manual/test tool on SMALL files where
// the wave count is bounded — the same gated-vs-raw split as the floor. EXPORTED for the gate test.
export const MAX_WAVE_LINES = 16 * DEFAULT_MAX_LINES; // 320000 — the gated maxLines ceiling (16 × the DEFAULT_MAX_LINES floor); the byte ceiling is DEFAULT_MAX_BYTES itself

function refuse(failedCheck, reason, extra = {}) {
  return { ok: false, refused: true, triggered: false, verified: false, failedCheck, reason, cut: [], ...extra };
}

// A unit's type token (a plain object's string-valued typeField), else null. Trivial 3-line accessor —
// re-stated here rather than exporting the reducer's private one (it is not an engine "internal").
function typeToken(obj, typeField) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const t = obj[typeField];
  return typeof t === 'string' ? t : null;
}

// FIELD-AGNOSTIC free-form detector (the advisory signal). Flags the unit if EITHER (a) any single string
// exceeds maxChars, OR (b) the AGGREGATE byte-volume of ALL its strings exceeds FREE_FORM_AGG_BYTES — (b)
// catches a pile of individually-short strings (20000×short = ~200KB of ore that no single-string check
// sees). Deliberately NOT keyed on field names (that name-denylist was the unsound gate-3 — an ore field
// under an unlisted name escaped it). BEST-EFFORT + bounded: it flags a POSSIBILITY for the agent, never
// decides or blocks, and it CAN still MISS (nested past WALK_DEPTH / obfuscated — Rice) or FALSE-FLAG (a
// long id/hash). See the header's "ADVISORY'S LIMIT" note.
function isFreeFormBearing(v, maxChars) {
  let aggBytes = 0;
  let depthCapped = false; // L6 (WAVE-5): true when the walk stops at WALK_DEPTH with a COMPOSITE node still
                           // unvisited — real structure exists DEEPER than the cap inspected. A CAP MUST EMIT A
                           // COMPENSATING SIGNAL: without it a resulting freeFormCount:0 reads as "content-free"
                           // when it really means "content-free WITHIN depth N, walk truncated" — the census
                           // silently lies and the agent deletes real content (the L6 leg of the WAVE-5 class).
  const walk = (x, depth) => {
    if (typeof x === 'string') {
      const b = Buffer.byteLength(x, 'utf8');
      if (b > maxChars) return true;                         // (a) FIX 4-R2: a single long string — a BYTE budget
      aggBytes += b;                                         //     (String.length counts UTF-16 units; a 74-char/194-byte
      return aggBytes > FREE_FORM_AGG_BYTES;                 //     Thai/CJK string evaded a char-length (a) though it is
    }                                                        // (b) clearly content. (b) was already byte-aware — now (a) matches.
    if (depth >= WALK_DEPTH) {
      // The cap is reached with real structure below → the walk did NOT see everything (Rice: raising the cap
      // only MOVES this boundary). Mark it so a false (content-free) verdict carries the signal; a primitive
      // (number/bool/null) at the cap has nothing deeper → no signal needed.
      if (Array.isArray(x) || (x && typeof x === 'object')) depthCapped = true;
      return false;
    }
    if (Array.isArray(x)) { for (const e of x) if (walk(e, depth + 1)) return true; return false; }
    if (x && typeof x === 'object') { for (const e of Object.values(x)) if (walk(e, depth + 1)) return true; return false; }
    return false;
  };
  const bearing = walk(v, 0); // short-circuits true on the first free-form finding (the depth cap is then moot)
  return { bearing, depthCapped }; // was a bare boolean; the census reads .bearing (flag) + .depthCapped (the cap's signal)
}

// A short REDACTED echo of a unit for the report's `sample`: a long string collapses to «free-form N chars»
// (the ore itself is NEVER dumped into the report), structure + short values kept so the agent can SEE which
// field carries the free-form content and judge it. FIX 3-R2: ALSO aggregate-aware — once this unit's emitted
// raw-string bytes pass SAMPLE_AGG_BYTES, every FURTHER string collapses too (mirrors isFreeFormBearing's
// aggregate signal), so an AGGREGATE-flagged unit (many short strings, none individually long — the criterion
// the single-string check alone misses) shows STRUCTURE + the first little bit, never a WALL of raw prose.
// JSON.parse output is acyclic → stringify-safe.
function redactUnit(v, maxChars) {
  let aggBytes = 0; // cumulative raw-string bytes KEPT (not collapsed) so far — shared across the whole unit's walk
  let budget = WALK_BREADTH; // TOTAL array-elements/object-entries the redaction may materialize — shared across the
                             // WHOLE walk (see WALK_BREADTH). Without it a fat unit's full-breadth redacted copy is
                             // O(unit), and JSON.stringify renders it WHOLE before the SAMPLE_STR_CAP slice → the
                             // sample-build PEAK and the retained SlicedString were BOTH O(filesize) (the confirmed OOM).
  const walk = (x, depth) => {
    if (typeof x === 'string') {
      // FIX 4-R3 (byte-PARITY with isFreeFormBearing's flag): the single-string collapse is BYTE-aware (was
      // `x.length`, UTF-16 chars) so it MATCHES the byte-aware FLAG. Pre-fix the two DISAGREED for non-ASCII
      // — a 30-char/90-byte Thai/CJK string was FLAGGED via signal (a) (byte 90>80) yet NOT collapsed here
      // (char 30≤80), dumping the raw prose verbatim into the census `sample`. Now flagged-via-(a) ⇒
      // collapsed-via-(a), always. The aggregate arm (>SAMPLE_AGG_BYTES) was already byte-based (FIX 3-R2).
      // N in the marker stays a char count — display only.
      if (Buffer.byteLength(x, 'utf8') > maxChars || aggBytes > SAMPLE_AGG_BYTES) return `«free-form ${x.length} chars»`;
      aggBytes += Buffer.byteLength(x, 'utf8');
      return x;
    }
    if (depth >= WALK_DEPTH) return '«…»';
    // BREADTH cap (WALK_BREADTH): materialize at most `budget` MORE entries across the WHOLE structure, then emit an
    // honest "…(N more)" marker. Bounds the built copy — and thus JSON.stringify + the slice — to O(WALK_BREADTH),
    // filesize-INDEPENDENT. The sample is a redacted PREVIEW, so a truncated tail is expected, NEVER a census lie:
    // redactUnit only runs for a unit ALREADY flagged free-form-bearing, so a breadth-truncated preview hides no
    // ore-detection (unlike the depthCapped signal, which guards a freeFormCount:0 → nothing to compensate here).
    if (Array.isArray(x)) {
      const out = [];
      let i = 0;
      for (; i < x.length && budget > 0; i++) { budget--; out.push(walk(x[i], depth + 1)); }
      if (i < x.length) out.push(`«…(${x.length - i} more)»`);
      return out;
    }
    if (x && typeof x === 'object') {
      const out = {};
      const keys = Object.keys(x);
      let i = 0;
      for (; i < keys.length && budget > 0; i++) { budget--; out[keys[i]] = walk(x[keys[i]], depth + 1); }
      if (i < keys.length) out['«…»'] = `«${keys.length - i} more keys»`;
      return out;
    }
    return x;
  };
  return walk(v, 0);
}

// SAMPLE_STR_CAP the stringified redacted sample for the report — but a bare `.slice(0, cap)` on a long string
// yields a V8 SlicedString that RETAINS the whole parent (redactUnit's stringify output). The WALK_BREADTH cap
// already bounds that parent to ~KB, yet a bounded-but-nonzero retain × up to TYPE_CENSUS_MAX types still accretes
// into the RETURNED census — so force a FLAT copy (no parent ref) via a zero-dep Buffer round-trip. A string
// already ≤ cap is the fresh stringify output (retains nothing external) → returned as-is. UTF-8 round-trips
// losslessly; a surrogate pair split exactly at the cap → one trailing U+FFFD in a redacted PREVIEW (cosmetic —
// the sample is already a lossy preview).
function sampleSlice(s) {
  return s.length <= SAMPLE_STR_CAP ? s : Buffer.from(s.slice(0, SAMPLE_STR_CAP), 'utf8').toString('utf8');
}

function readWhole(fd, start, len) {
  const n = Math.max(0, len);
  const buf = Buffer.allocUnsafe(n);
  let got = 0;
  while (got < n) { const r = fs.readSync(fd, buf, got, n - got, start + got); if (r <= 0) break; got += r; }
  return got === n ? buf : buf.subarray(0, got);
}

// Bounded forward scan: the source offset JUST PAST the first newline at or after `start`, or null if none
// exists before EOF. Reads CHUNK-by-CHUNK and DISCARDS each chunk after scanning — it never accumulates the
// giant line into memory. Used ONLY to STEP OVER a single unit larger than the per-wave budget in the
// advisory census (FIX 3) so the types AFTER it stay counted; the oversized unit itself is never classified.
function nextNewlineAfter(fd, size, start) {
  let pos = Math.max(0, start);
  const buf = Buffer.allocUnsafe(SKIP_SCAN_CHUNK);
  while (pos < size) {
    const n = fs.readSync(fd, buf, 0, Math.min(SKIP_SCAN_CHUNK, size - pos), pos);
    if (n <= 0) break;
    const idx = buf.subarray(0, n).indexOf(NL);
    if (idx !== -1) return pos + idx + 1;
    pos += n;
  }
  return null;
}

// FIX 7-R2: recover just the typeField TOKEN from the FRONT of an oversized unit (a >per-wave-budget line the
// census NEVER buffers/classifies) via a BOUNDED front-read, so a type living ONLY in oversized units still
// APPEARS in the census (named), not silently absent. The type token sits at the object front for real
// transcripts; a token whose value extends PAST the front-read bound, or an object that places typeField later
// than the bound, is UNRECOVERABLE → null (caller keeps oversizedSkipped++). READ-ONLY, memory-bounded (one
// OVERSIZED_FRONT_BYTES buffer — never the giant unit), NEVER throws. The regex is an unrolled alternation
// (each branch consumes ≥1 char, no overlap) over a ≤4KB input → linear, no ReDoS.
function oversizedTypeToken(fd, size, start, typeField) {
  try {
    const text = readWhole(fd, start, Math.min(OVERSIZED_FRONT_BYTES, size - start)).toString('utf8');
    const key = String(typeField).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // escape regex-special chars in a caller typeField
    const m = new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"').exec(text); // "<typeField>":"<escape-tolerant value>"
    return m ? JSON.parse('"' + m[1] + '"') : null; // JSON.parse safely un-escapes the captured value; an invalid escape → throws → null
  } catch { return null; }
}

// The ADVISORY report / CENSUS. Stream the WHOLE file once (NO 512KB ceiling — the front-sample blind spot
// the old gate had is gone: content past the prefix IS counted) and accumulate { unitCount, freeFormCount,
// sample } per type. `wantSet` a Set → only the REQUESTED cut-types (detonate's report, typeless skipped);
// `wantSet` null → EVERY distinct type, typeless units bucketed under '(untyped)' (survey's census). Reuses
// explode's byte-exact splitter (scanWave) for constant memory. Non-blocking + informational — it never
// authorizes or blocks a cut; the agent reads and decides. `freeFormCount` is BEST-EFFORT (per the header's
// ADVISORY'S LIMIT: it can MISS deep/obfuscated ore and can FALSE-FLAG a long id/hash) — a signal that INFORMS
// the agent, never a verdict; the redacted `sample` collapses long strings and is length-capped, so the ore
// bytes are NEVER dumped into the report.
// Returns { perType, oversizedSkipped, unitsUnparsed, typesTruncated, otherTypesUnits } (the last two: the
// survey-path type-cardinality cap — see TYPE_CENSUS_MAX; always false/0 on detonate's wantSet path).
// A >per-wave-budget unit the scan STEPPED OVER (FIX 3)
// is never content-classified (never buffered). FIX META (WAVE-9): oversizedSkipped counts EVERY over-budget
// unit (typed-recovered AND unrecoverable/non-requested) — the COMPLETE oversized total, so a consumer always
// reconciles: totalUnits (content-classified) + unitsUnparsed + oversizedSkipped = every physical unit. FIX
// 7-R2 additionally recovers the type TOKEN from a bounded front-read and NAMES a recovered type in perType
// via `oversizedCount` (unitCount stays 0 — content unclassified) as the FINER per-type breakdown (a subset of
// oversizedSkipped). Between them the census gap is NAMED honestly (by type where possible, always by count),
// never a silent tail-truncation.
function buildReport(fd, size, struct, typeField, wantSet = null, maxChars) {
  // FIX 2 (prototype pollution): null-proto map so a type token equal to a JS builtin name
  // (__proto__ / constructor / toString / hasOwnProperty) becomes a real OWN-key — not a walk down
  // Object.prototype (which would VANISH the type, undercount totalUnits, throw on `.sample.push`
  // against Object.prototype → collapse the whole census, AND mutate Object.prototype process-wide).
  const perType = Object.create(null);
  let oversizedSkipped = 0;
  // BREAK 4 (WAVE-7 META): unparseable BODY lines were silently DROPPED here — a census that reports "N
  // units" while a clean FRONT sample hid unparseable content AFTER it (the sniff accepts ndjson, then the
  // body pass omits every unparseable line with no signal) is the fake-0 class. reduceFile already computes
  // this exact count (unitsUnparsed); carry it to the census surfaces so an omission is NAMED, never silent.
  let unitsUnparsed = 0;
  // TYPE-CARDINALITY CAP state (see TYPE_CENSUS_MAX): bound perType to O(cap) distinct slots on the survey path.
  let namedTypeCount = 0;   // distinct keys allocated in perType (≤ TYPE_CENSUS_MAX in survey mode)
  let typesTruncated = false;
  let otherTypesUnits = 0;  // aggregate unitCount for types PAST the cap — accounted, just not per-type named
  // getOrAllocType: the SINGLE allocation gate BOTH census sites route through (the per-line observe below AND
  // the oversized-token pass) so the cardinality cap holds for every perType key. Returns the record, or null
  // when a NEW type would exceed the cap — but ONLY on the survey path (wantSet === null). detonate (wantSet a
  // Set) is already bounded by |cutTypes|, so it NEVER caps here → byte-identical behavior for detonate's report.
  const getOrAllocType = (key) => {
    const existing = perType[key];
    if (existing !== undefined) return existing;
    if (wantSet === null && namedTypeCount >= TYPE_CENSUS_MAX) { typesTruncated = true; return null; }
    namedTypeCount++;
    return (perType[key] = { unitCount: 0, freeFormCount: 0, sample: [] });
  };
  const observe = (obj) => {
    const t = typeToken(obj, typeField);
    // wantSet a Set → detonate: only requested types (typeless skipped). wantSet null → survey: EVERY
    // distinct type, a typeless unit bucketed under '(untyped)' — the census is type-complete.
    if (wantSet !== null && (t === null || !wantSet.has(t))) return;
    const key = t === null ? '(untyped)' : t;
    const rec = getOrAllocType(key);
    if (rec === null) { otherTypesUnits++; return; } // past the cap: unit COUNTED in aggregate, no per-type slot (memory O(cap), never O(N))
    rec.unitCount++;
    const ff = isFreeFormBearing(obj, maxChars);
    if (ff.bearing) {
      rec.freeFormCount++;
      if (rec.sample.length < SAMPLE_MAX) rec.sample.push(sampleSlice(JSON.stringify(redactUnit(obj, maxChars))));
    } else if (ff.depthCapped) {
      // L6 (WAVE-5): content-free WITHIN the depth cap, but the walk was TRUNCATED (real structure past
      // WALK_DEPTH went uninspected) → this unit's freeFormCount 0 is UNCERTAIN. Surface it per-type (mirrors
      // oversizedCount) so a capped 0 is never read as proof-of-content-free; the agent keeps such a unit.
      rec.depthCappedCount = (rec.depthCappedCount || 0) + 1;
    }
  };
  if (struct.structure === 'json-single') {
    try { observe(JSON.parse(readWhole(fd, struct.bomLen, size - struct.bomLen).toString('utf8'))); } catch { unitsUnparsed++; /* discovery verified parseable; defensive — but if it somehow won't parse, SURFACE it, never drop it silently */ }
    return { perType, oversizedSkipped, unitsUnparsed, typesTruncated, otherTypesUnits };
  }
  // ndjson: chunked wave loop — carry bounded to REPORT_MAX_BYTES (constant memory). A SINGLE unit past
  // that budget (e.g. a >16MB embedded blob) is pathological: scanWave returns overlong with nextOffset
  // at the START of the oversized line (continuing to scan the same offset would re-read it forever). FIX
  // 3: STEP OVER that one unit (forward-scan to its terminating newline via nextNewlineAfter) instead of
  // BREAKING — else every type AFTER the giant unit VANISHES from the census, ok:true, no signal. The
  // giant unit is NOT classified (never buffered — memory stays bounded); `oversizedSkipped` NAMES the gap
  // so the incompleteness is honest, never silent. A non-overlong budget stop just advances and continues.
  let offset = struct.bomLen;
  for (;;) {
    const r = scanWave(fd, size, offset, REPORT_MAX_LINES, REPORT_MAX_BYTES, (lineBuf) => {
      // PARSE THROUGH THE REDUCER'S OWN lineText — never a second, looser reading of a line.
      // This used to be `.toString('utf8').trim()` under a comment claiming it "matches the
      // reducer". It did not. `.trim()` strips U+FEFF (JS treats a BOM as whitespace) while the
      // reducer's lineText strips ONLY the line terminator — so a BOM-prefixed unit PARSED for the
      // census and FAILED for the reducer. The census then typed it as a cut candidate while
      // reporting `unitsUnparsed: 0`, i.e. it advertised a cuttable unit the reducer would silently
      // refuse to cut, and simultaneously asserted nothing was unparseable (rung-5 A2). Measured:
      // survey said 1 cuttable `mode` + unitsUnparsed 0; the reduce cut 0 and returned skipped.
      // Two parsers on one substrate is the defect — sharing lineText removes the divergence class,
      // not just the BOM instance.
      const text = lineText(lineBuf);
      if (!text.trim()) return; // blank line — structural, not a unit (blank-check may trim; the PARSE must not)
      let obj; try { obj = JSON.parse(text); } catch { unitsUnparsed++; return; } // unparseable BODY unit → counted (BREAK 4), never a silent drop; still not a cut candidate (now genuinely matching the reducer)
      observe(obj);
    });
    if (r.done) break;
    let next;
    if (r.overlong) {
      // FIX META (WAVE-9): oversizedSkipped counts EVERY over-budget unit so a consumer can ALWAYS reconcile
      // the census — totalUnits (parsed, content-classified) + unitsUnparsed + oversizedSkipped = every
      // physical unit. Pre-fix a TYPED-recovered oversized went to the per-type oversizedCount ONLY, so the
      // top-level oversizedSkipped read 0 and that unit VANISHED from any (totalUnits + unitsUnparsed +
      // oversizedSkipped) reconcile — the very unit the REDUCE path fail-closed-skips-and-reports (the budget-
      // cap hardening had reached reduce but not this census primitive). The per-type oversizedCount stays as
      // the FINER breakdown (a subset of oversizedSkipped, naming WHICH type when the front-read recovers the
      // token). FIX 7-R2: the giant unit is never content-classified (unitCount untouched — never buffered);
      // its type token is front-read-recovered so a type living ONLY in oversized units still APPEARS by name.
      oversizedSkipped++; // every over-budget unit — the complete oversized total (reconcile-safe)
      const t = oversizedTypeToken(fd, size, r.nextOffset, typeField);
      if (t !== null && (wantSet === null || wantSet.has(t))) {
        // Route through the SAME cardinality gate. Past the cap → no named slot, but oversizedSkipped (above)
        // ALREADY counted this unit, so the aggregate + the reconcile hold and typesTruncated is set — no vanish.
        const rec = getOrAllocType(t);
        if (rec !== null) rec.oversizedCount = (rec.oversizedCount || 0) + 1; // finer per-type breakdown (subset of oversizedSkipped)
      }
      const skip = nextNewlineAfter(fd, size, r.nextOffset);
      if (skip === null) break; // the oversized unit is the file's tail — nothing after it to count
      next = skip;
    } else {
      next = r.nextOffset;
    }
    // COMPLETENESS (wave-drive non-advance fail-fast, one-flock with reduceToCompletion's guard): a wave-drive
    // loop must BREAK rather than spin if the offset fails to advance. Unreachable in practice (the fixed
    // REPORT_MAX_BYTES budget always advances, or hits overlong/done) → pure class-completeness defense: this
    // census is best-effort + read-only, so a (theoretical) stuck offset ends the scan with what was counted
    // so far, never a silent CPU spin. Both wave-drive branches (overlong-skip, normal) route through here.
    if (next <= offset) break;
    offset = next;
  }
  return { perType, oversizedSkipped, unitsUnparsed, typesTruncated, otherTypesUnits };
}

// Is snapshotDir creatable — does its nearest EXISTING ancestor exist and is it a directory? (mkdirSync
// recursive succeeds iff so.) Non-destructive: statSync walks up, creates nothing.
function ancestorIsDir(p) {
  let cur = path.resolve(p);
  for (;;) {
    try { return fs.statSync(cur).isDirectory(); } catch { /* absent — walk up */ }
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

// `.native` IS THE SECURITY-RELEVANT VARIANT, not a style choice — the plain
// realpathSync does NOT expand a win32 8.3 short name (the R3 finding), and this
// helper feeds CONTAINMENT comparisons. It was plain, and the damage was not
// theoretical: at the gate-4 belt below it is compared against
// `physicalForCreate(snapshotDir)`, which DOES expand — so with a short-name
// tmpdir the two sides spelled the same directory differently, `isContainedIn`
// returned false, and the source-sacred "src inside the snapshot store" refusal
// SILENTLY DID NOT FIRE. The source survived only because a narrower downstream
// check (manifest-path alias) happened to catch that one shape; a src inside the
// store under any other name had no belt left. Reproduced by running the suite
// with TEMP pointed at an 8.3 alias.
// MIXED VARIANTS ON TWO SIDES OF ONE COMPARE IS THE BUG CLASS — keep every
// canonicalizer in this engine on `.native` so both sides always agree.
function realOrNull(p) { try { return fs.realpathSync.native(p); } catch { return null; } }
function isUnder(childReal, baseReal) {
  if (!childReal || !baseReal) return false;
  const norm = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
  const c = norm(childReal), b = norm(baseReal);
  return c === b || c.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

// The detonator. `src` = the class-A file. `request` = the caller's INTENT (what they want cut + where):
//   { cutTypes?, typeField?='type', outPath, snapshotDir, maxLines?, maxBytes?, freeStringMaxChars? }.
// `opts` = verify context: { storeRoot? } (an expected root the src must resolve inside).
//   • outPath present → EXECUTE: mechanical gates (file · structure · path · params) must pass, then the
//     reduction TRIGGERS with the AGENT's cutTypes unchanged (the report only INFORMS, never filters).
//   • outPath omitted → DRY-RUN: the advisory report is returned WITHOUT cutting (the agent reviews it,
//     then re-calls with an outPath) — the main engine is NEVER touched.
// Returns on execute:  { ok, verified:true, triggered:true, cut:[…present requested types], report, droppedCutTypes, …mainResult }.
// Returns on dry-run:  { ok:true, verified:true, triggered:false, cut, report, droppedCutTypes }.
// Returns on gate fail:{ ok:false, refused:true, triggered:false, reason, failedCheck } — main NEVER called.
// The engine NEVER decides waste-vs-content and NEVER throws.
export function detonate(src, request = {}, opts = {}) {
  // FIX 4: the OUTER try wraps the WHOLE body — the request/opts destructuring below (a throwing getter or
  // a Proxy) and gate 1 run BEFORE the inner fd try, so without this outer catch a hostile getter throws
  // straight out, breaking the "NEVER throws → refuse('internal')" contract. The inner fd try/finally is
  // KEPT (nested) for handle cleanup.
  try {
    const { storeRoot = null } = opts || {};
    const {
      cutTypes: requestedRaw, typeField = 'type',
      outPath = null, snapshotDir = null,
      maxLines, maxBytes, offset, resume,
      freeStringMaxChars = FREE_STRING_MAX_CHARS,
    } = request || {};

    // #5: freeStringMaxChars is a NON-BLOCKING advisory param — a bad value must never refuse the whole run,
    // but it must never BLIND the signal either. `len > NaN` is ALWAYS false → freeFormCount 0 even for a
    // 200-char ore string; a value ≤ 0 over-flags every short string. Fall back to the default (80) when it
    // is not a finite number ≥ 1 (DEFAULT, never refuse — the advisory has no authority to fail a run).
    const maxChars = (Number.isFinite(freeStringMaxChars) && freeStringMaxChars >= 1) ? freeStringMaxChars : FREE_STRING_MAX_CHARS;

    // --- gate 1: FILE (exists · regular file · inside storeRoot if given) ---
    // OPEN FIRST, THEN fstat THE FD — never statSync(path) then openSync(path). A path-stat
    // followed by a path-open is check-then-act: the two calls can land on DIFFERENT inodes, so
    // `stat.size` and `isFile()` would describe a file the fd is not looking at. The fd-based form
    // is the idiom this engine already uses (sha256File, collidesWithSource) and it closes the
    // window by construction rather than narrowing it.
    let fd;
    try { fd = fs.openSync(src, 'r'); } catch (e) { return refuse('file', `cannot open src for read: ${e.message}`); }
    let stat;
    try { stat = fs.fstatSync(fd); } catch (e) { try { fs.closeSync(fd); } catch { /* best effort */ } return refuse('file', `cannot stat src: ${e.message}`); }
    if (!stat.isFile()) { try { fs.closeSync(fd); } catch { /* best effort */ } return refuse('file', 'src is not a regular file (directory / device / socket refused)'); }
    // storeRoot (OPTIONAL, null default) = best-effort defense-in-depth containment: src's realpath must sit inside
    // the expected store. HONEST LIMIT (floor-not-ceiling, same discipline as FIX 6-R2 / WALK_DEPTH): this is a
    // check-then-reopen TOCTOU — reduceToCompletion reopens src by PATH, so a symlink flipped between here and that
    // reopen could point the READ outside storeRoot. Accepted, NOT a corruption risk: src is READ-ONLY (source-
    // sacred); the load-bearing anti-truncation guarantee is the fd-based gate 4 + reduceFile's temp→rename, never
    // this containment check; and the ULTRA caller passes no storeRoot (the real path never exercises it). A TOCTOU-
    // tight version would thread the open fd through the reducer — deferred as over-engineering for an optional,
    // read-only, unused-in-the-real-path defense.
    // RESIDUAL, UNCHANGED AND STILL PATH-BASED: this containment check realpaths a PATH, so it keeps
    // its own check-then-reopen window (a realpath cannot be taken through an fd portably). The fd
    // above removed the size/isFile half of the race; this half stays, with the honest limit above.
    if (storeRoot != null && !isUnder(realOrNull(src), realOrNull(storeRoot))) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
      return refuse('file', `src does not resolve inside the expected store root (${storeRoot})`);
    }

    try {
      const size = stat.size; // from fstat(fd) — describes the SAME inode the reads below use

      // --- gate 2: STRUCTURE (ndjson | json-single only; opaque/unparseable → never explode) ---
      const struct = discoverStructure(fd, size);
      if (struct.structure !== 'ndjson' && struct.structure !== 'json-single') {
        return refuse('structure', `unverifiable structure (${struct.structure}: ${struct.reason}) — never explode what we cannot parse`);
      }

      // The AGENT's rock-vs-ore call. The engine EXECUTES cutTypes; it does NOT judge them (gate 3 REMOVED).
      // Non-string entries are SURFACED (droppedCutTypes), never silently dropped.
      // L4#1 (WAVE-5 fail-OPEN destructive): a NON-ARRAY cutTypes that is not undefined (null / {} / a bare
      // string / a number) is a MALFORMED request, NOT "no preference" — REFUSE it, never let it fall through
      // to the factory default (which would cut 2 bookkeeping categories the caller never asked for, then
      // EXECUTE). ONLY an OMITTED key (undefined) means "no preference → convenience default". This is the
      // sibling fix-round-4 (`[]` → refuse) missed: `Array.isArray(x) ? x : DEFAULT` routes null/{}/'mode' to
      // the SAME destructive default as undefined. A validation branch that sends malformed input to a
      // destructive default fails OPEN — reject-closed instead (the L4 leg of the WAVE-5 class).
      if (requestedRaw !== undefined && !Array.isArray(requestedRaw)) {
        return refuse('cutlist', `cutTypes must be an array or omitted (got ${requestedRaw === null ? 'null' : 'a ' + typeof requestedRaw}) — a non-array request is refused, never silently defaulted`);
      }
      // FIX 2-R2: an explicit empty array means "cut NOTHING", distinct from an OMITTED key ("no preference →
      // apply the convenience default"). The real ULTRA caller is PROGRAMMATIC (the agent computes cutTypes
      // from the survey) → a computed [] (agent decided nothing is cuttable) must NEVER fall through to the
      // factory default and cut 2 categories the caller never asked for. `Array.isArray` alone (no `&& .length`):
      // [] → requested=[] → the cutlist gate below cleanly refuses ("nothing to cut"); undefined → the default.
      const requestedList = Array.isArray(requestedRaw) ? requestedRaw : CLAUDE_DEFAULT_CUT_TYPES;
      const requested = [...new Set(requestedList.filter((t) => typeof t === 'string'))];
      const droppedCutTypes = requestedList.filter((t) => typeof t !== 'string');
      if (!requested.length) return refuse('cutlist', 'no string cut-types requested and no factory default applied', { droppedCutTypes });

      const dryRun = !outPath;

      // --- gate 4 (PATH) + gate 5 (PARAMS): the EXECUTE-only mechanical floor (a dry-run has no outPath to
      //     alias and no params in use) — fail-closed BEFORE the whole-file report read wastes work. ---
      if (!dryRun) {
        // gate 4: PATH (outPath not aliasing src · snapshotDir present + creatable)
        const alias = collidesWithSource(outPath, src, fd) || collidesWithSource(`${outPath}.${process.pid}.tmp`, src, fd);
        if (alias) return refuse('path', `outPath aliases the source (${alias}) — would truncate the source`);
        // #1 belt (DEFENSE-IN-DEPTH, not data-loss): on an inode-less volume (exFAT/FAT/SMB → stat.ino===0)
        // collidesWithSource's dev/ino hardlink backstop self-disables AND realpath does not normalize an 8.3
        // short-name, so an 8.3 / hardlink alias can slip gate 4. reduceFile's temp→rename discipline is the
        // LOAD-BEARING anti-truncation protection (the break proved 0 data loss); this belt conservatively
        // fail-closes a SAME-DIRECTORY outPath when the inode signal is unavailable — over-refusing a same-dir
        // outPath only on inode-less volumes (rare, a safe cost). (isUnder both ways ⇒ dirs are equal.)
        if (stat.ino === 0) {
          const srcDir = realOrNull(path.dirname(src));
          const outDir = realOrNull(path.dirname(outPath));
          if (srcDir && outDir && isUnder(outDir, srcDir) && isUnder(srcDir, outDir)) {
            return refuse('path', 'cannot verify non-alias on an inode-less volume — refusing a same-directory outPath (fail-closed)');
          }
        }
        if (!snapshotDir) return refuse('path', 'snapshotDir is required (rail 5: no snapshot, no destroy)');
        if (!ancestorIsDir(snapshotDir)) return refuse('path', `snapshotDir is not creatable — no existing directory ancestor: ${snapshotDir}`);
        // FIX 1 belt (source-sacred, one-flock with reduceFile's floor guard): src must NOT resolve INSIDE
        // snapshotDir — snapshotSource writes manifest.jsonl + content blobs there, so a src that IS the
        // manifest (or a blob) path would be CORRUPTED by that recovery write. reduceFile fail-closes this at
        // the floor; this belt refuses BEFORE triggering (triggered:false), same realpath-and-contain shape.
        // (Checked BEFORE the LOW outPath-symmetry belt below so a source-corruption refusal reason wins when
        // both apply — the source-sacred message is the one that matters.)
        if (isContainedIn(realOrNull(src), physicalForCreate(snapshotDir))) {
          return refuse('path', `src must not resolve inside the snapshot store (${snapshotDir}) — snapshotSource writes the manifest/blobs there and would corrupt the source`);
        }
        // FIX 1-R2 belt (source-sacred, the ALIAS the path-guard above misses — mirrors reduceFile's floor):
        // a <snapshotDir>/manifest.jsonl HARDLINKED to a src living OUTSIDE snapshotDir defeats the path-
        // containment check (src's realpath is outside; the manifest hardlink points in) — snapshotSource's
        // appendFileSync follows it and writes the manifest row INTO the source. Guard the manifest WRITE
        // TARGET against aliasing src via collidesWithSource (realpath both sides + the dev/ino hardlink check),
        // fail-closed BEFORE triggering. A normal manifest.jsonl is a fresh distinct inode → never false-refused.
        if (collidesWithSource(path.join(snapshotDir, SNAPSHOT_MANIFEST), src, fd)) {
          return refuse('path', 'the snapshot manifest path aliases the source (hardlink / dev+ino) — the manifest append would corrupt the source');
        }
        // FIX 5-R2 belt (symmetry, LOW): reduceFile's FLOOR already refuses an outPath resolving INSIDE the
        // snapshot store (it would overwrite a recovery blob/manifest) — but detonate's gate-4 lacked the
        // pre-check, so such an outPath fell through to the floor (caught there, ok:false, zero mutation — safe,
        // never exploitable). Mirror the floor here so the belt refuses BEFORE triggering (triggered:false); the
        // floor stays the load-bearing guard. (Same-dir temp is covered transitively — if outPath is not inside,
        // its sibling temp isn't either.)
        if (isContainedIn(physicalForCreate(outPath), physicalForCreate(snapshotDir))) {
          return refuse('path', 'outPath must not resolve inside the snapshot store — it would overwrite a recovery blob or manifest');
        }
        // gate 5: PARAMS (finite budgets at/above the memory floor; a fresh detonation carries NO mid-stream
        // offset/resume — the forged offset/outLen the main engine only benign-no-ops on is REJECTED here)
        // Number.isFinite (NOT typeof==='number'): Infinity is a number that satisfies the floor, yet an Infinity
        // per-wave byte budget makes a wave buffer the whole file unbounded (OOM). Reject non-finite — one-flock
        // with the freeStringMaxChars guards (299/459), which already use Number.isFinite. UPPER CEILING (the twin
        // OOM): a FINITE-but-huge budget (e.g. 1e15 ≥ the filesize) reaches the SAME whole-file kept-line buffer as
        // Infinity, so each budget is ALSO capped at its ceiling — maxBytes ≤ DEFAULT_MAX_BYTES (the factory budget)
        // · maxLines ≤ MAX_WAVE_LINES (16 × the floor) — see the MAX_WAVE_LINES block. Above the ceiling = the same
        // fail-closed refuse as below the floor; the legal window is [floor, ceiling]. Omit a budget → the default.
        // L4 (WAVE-6 re-read explosion): the FLOOR is one CHUNK for maxBytes / the factory line budget for
        // maxLines, NOT `>= 1`. A wave READS up to CHUNK per iteration; a per-wave budget that stops the wave
        // after consuming FAR LESS than a chunk (maxBytes=1.5/1000, maxLines=2/10) discards the rest of the
        // chunk it just read, the next wave re-reads it, and the O(waves × CHUNK) re-reads turn a large-file
        // detonate into a multi-minute "hang" (a REAL user passing a small cap, not just an attacker). Below one
        // chunk the budget bounds NO memory (a chunk is already buffered) — so the floor costs nothing legit.
        // Raw reduceFile stays permissive (a tiny budget is its documented manual/test tool, exercised on SMALL
        // files where the wave count is bounded) — this gate protects the GATED whole-file entry, same split as
        // the Infinity precedent. Omit a budget → the safe factory defaults (16MB / 20000 lines).
        if (maxLines !== undefined && !(Number.isFinite(maxLines) && maxLines >= DEFAULT_MAX_LINES && maxLines <= MAX_WAVE_LINES)) return refuse('params', `maxLines must be a finite number in [${DEFAULT_MAX_LINES}, ${MAX_WAVE_LINES}] (the factory line budget .. 16× it; BELOW the floor forces a re-read explosion, ABOVE the ceiling lets one wave buffer the whole file's kept lines = O(filesize) RAM [the OOM the Infinity guard rejects] — omit it for the default)`);
        if (maxBytes !== undefined && !(Number.isFinite(maxBytes) && maxBytes >= CHUNK && maxBytes <= DEFAULT_MAX_BYTES)) return refuse('params', `maxBytes must be a finite number in [${CHUNK}, ${DEFAULT_MAX_BYTES}] (one read chunk .. the factory per-wave budget; BELOW the floor bounds no memory + re-read-explodes, ABOVE the ceiling lets one wave buffer the whole file = O(filesize) RAM [the OOM the Infinity guard rejects] — omit it for the default)`);
        if ((offset !== undefined && offset !== 0) || resume != null) {
          return refuse('params', 'detonate performs a FRESH full-file reduction — a mid-stream offset/resume (incl. a forged offset or non-finite outLen) is refused; drive reduceFile directly for manual resumption');
        }
      }

      // --- ADVISORY REPORT (non-blocking): whole-file scan, per requested cut-type. Rides dry-run AND execute. ---
      const report = buildReport(fd, size, struct, typeField, new Set(requested), maxChars);
      const cut = requested.filter((t) => report.perType[t]); // requested types actually PRESENT (a factual signal, not a decision)

      if (dryRun) {
        // Report-only: the agent reviews the advisory, then re-calls with an outPath to execute. Main NEVER called.
        return { ok: true, verified: true, triggered: false, cut, report, droppedCutTypes };
      }

      // L4-secondary (WAVE-6, wasted-work refuse): none of the requested cut-types is PRESENT in the file → an
      // execute would snapshot + full-rewrite the whole file to cut ZERO units (a byte-identical no-op copy —
      // ~2× the file's bytes of pointless I/O on the engine's 50MB+ target), then report triggered:true, cut:[].
      // Refuse it before the destructive path (same shape as the empty-cutlist gate above): a FACTUAL "nothing
      // to cut" (mechanical, NOT a rock-vs-ore judgment — the engine still never decides waste-vs-content). The
      // real ULTRA caller picks cutTypes FROM the survey census, so cut is never empty in the correct flow; this
      // fires only on a misuse (requesting absent types), exactly where the honest refusal helps. The report is
      // returned so the caller sees the census proving the absence. (A type present only in >budget oversized
      // units keeps perType[t] truthy → cut non-empty → not refused → executes correctly.)
      if (!cut.length) return refuse('cutlist', 'none of the requested cut-types are present in the file — nothing to cut (a no-op reduction is refused; source untouched)', { report, droppedCutTypes });

      // --- EXECUTE: the mechanical gates passed → TRIGGER with the AGENT's cutTypes UNCHANGED. The report's
      //     freeFormCount does NOT filter the cut — the agent already decided; the report only INFORMED. ---
      const main = reduceToCompletion(src, {
        cutTypes: requested, typeField, outPath, snapshotDir,
        ...(maxLines !== undefined ? { maxLines } : {}),
        ...(maxBytes !== undefined ? { maxBytes } : {}),
      });
      // We verified + triggered. If the main engine still fail-closed (a race / disk-full / torn-write it
      // caught), surface it honestly — triggered:true, not a detonate refusal.
      // FIX (cut-vouch honesty, one-flock with the skipped branch below): `cut` vouches for a COMPLETED cut. On
      // failure NO requested type was completely cut → cut:[]. Any partial on disk is a RECOVERY artifact under
      // ...main + the snapshot, never a vouched cut; the caller still reads the present-types census via `report`.
      if (!main.ok) return { ...main, ok: false, refused: false, triggered: true, verified: true, cut: [], report, droppedCutTypes };
      // FIX 3-R3 (census↔cutter honesty): the reducer SKIPPED (opaque structure, or a >budget mid-file unit
      // bailed the whole file — ok:true but nothing written, unitsCut 0). `cut` lists the requested types the
      // REPORT found present, yet NONE were cut → it must not vouch for an un-executed cut. Empty it; the
      // caller sees skipped:true (from ...main) + cut:[] and knows the reduction did not run (…main also
      // carries the now-honest outPath:null + the real snapshotPath). Distinct from !main.ok above (a partial
      // remains there); a skip wrote nothing.
      if (main.skipped) return { ...main, ok: true, verified: true, triggered: true, cut: [], report, droppedCutTypes };
      return { ...main, ok: true, verified: true, triggered: true, cut, report, droppedCutTypes };
    } catch (e) {
      // MED: the detonator NEVER throws. A number/object outPath (path.resolve throws), an injected fs error,
      // or any other throw inside the gated body → a clean refuse('internal'); the finally still closes fd.
      return refuse('internal', `detonate internal error: ${e && e.message ? e.message : String(e)}`);
    } finally { try { fs.closeSync(fd); } catch { /* one-flock with explode's reduceFile: never throw out of finally */ } }
  } catch (e) {
    // FIX 4 outer catch: a throw in the request/opts destructuring (a throwing getter / Proxy) or gate 1 —
    // BEFORE the inner fd try — must still keep the never-throws contract → refuse('internal').
    return refuse('internal', `detonate internal error: ${e && e.message ? e.message : String(e)}`);
  }
}

// survey(src, opts) — the STATELESS CENSUS / "ore-detector" (STEP 2's read-only pre-ladder). An agent about
// to reduce a transcript does NOT know what unit TYPES it holds — Claude uses user/assistant/mode/…, other
// platforms use wholly different, per-platform-unpredictable tokens (measured). Guessing a cut-list blind is
// dangerous/wasteful. survey scans the file and returns the FULL type census — EVERY distinct type + a
// per-type free-form SIGNAL — WITHOUT executing a cut or pulling content into the agent's context, so the
// agent LEARNS the real types, then decides its cut-list informed.
//   opts = { storeRoot?, typeField?='type', freeStringMaxChars?=80 }.
//   Runs gate 1 (FILE) + gate 2 (STRUCTURE) ONLY — missing/dir/opaque/unparseable → the SAME refuse(...) shape
//   detonate uses ({ok:false, refused:true, triggered:false, failedCheck, reason}); can't survey what we can't
//   parse (fail-closed, identical posture to detonate).
//   Returns { ok:true, structure, totalUnits, unitsUnparsed, oversizedSkipped, types:{ [type]:{ unitCount, freeFormCount, sample:[…≤2 redacted], oversizedCount?, depthCappedCount? } }, typesTruncated?, otherTypesUnits? };
//   typesTruncated (only present when set) = the file held MORE than TYPE_CENSUS_MAX distinct types → the census
//   named TYPE_CENSUS_MAX and BOUNDED the rest (O(cap) memory, not O(N)); otherTypesUnits = the aggregate unit
//   mass of that unnamed remainder (folded into totalUnits, so the reconcile stays complete — never a silent drop).
//   unitsUnparsed (BREAK 4) = real BODY lines that would not parse (past a clean front sample) — surfaced so
//   the census can never report totalUnits while silently omitting live content (the fake-0 class).
//   depthCappedCount (L6) = units whose free-form walk was TRUNCATED at the depth cap (structure existed
//   deeper than inspected) → their freeFormCount 0 is UNCERTAIN, not proof of content-free (a capped signal).
//   a typeless unit (no string `type`) buckets under '(untyped)'; a >per-wave-budget unit the census stepped
//   over is counted in oversizedSkipped (the COMPLETE oversized total) AND, when its token is front-read-
//   recoverable, additionally NAMED by type (types[t].oversizedCount, unitCount 0 — content unclassified).
//   FIX META (WAVE-9): oversizedSkipped is the FULL oversized count (typed + untyped) in BOTH survey and
//   detonate modes, so totalUnits + unitsUnparsed + oversizedSkipped = every physical unit — a consumer
//   reading oversizedSkipped alone gets the whole oversized total, no undercount; the per-type oversizedCount
//   is the finer subset (which type). STATELESS + READ-ONLY: writes
//   NOTHING (no output, no snapshot, no persisted state — Phoenix), NEVER calls reduceToCompletion, NEVER
//   throws (any internal error → refuse('internal')). fd closed in the finally (one-flock with detonate/explode).
// ADVISORY'S LIMIT — carried from detonate's report: `freeFormCount` is the SAME best-effort, name-agnostic
// content signal — it CAN MISS deep/obfuscated ore and CAN FALSE-FLAG a long id/hash (Rice: no cap/heuristic
// makes it total). It INFORMS the agent's rock-vs-ore call, it NEVER decides — the agent maps the platform's
// ACTUAL types to keep/cut via the manual's concept-rule (has content → keep · content-free → cut-candidate ·
// unsure → keep). The census's accuracy bar is TYPE-COMPLETENESS (list every distinct type), NOT a per-unit
// content verdict; the sample stays redacted (long strings → «free-form N chars»; ore bytes never dumped).
export function survey(src, opts = {}) {
  // FIX 4: the OUTER try wraps the WHOLE body so the opts destructuring below (a throwing getter / Proxy)
  // keeps survey's "NEVER throws → refuse('internal')" contract. The inner fd try/finally is KEPT (nested).
  try {
    const { storeRoot = null, typeField = 'type', freeStringMaxChars = FREE_STRING_MAX_CHARS } = opts || {};
    // Same non-blocking advisory clamp as detonate: a bad freeStringMaxChars falls back to the default (never
    // blinds the signal with `len > NaN`, never over-flags with ≤0) — the census has no authority to fail.
    const maxChars = (Number.isFinite(freeStringMaxChars) && freeStringMaxChars >= 1) ? freeStringMaxChars : FREE_STRING_MAX_CHARS;

    // --- gate 1: FILE (exists · regular file · inside storeRoot if given) — identical to detonate's gate 1 ---
    // OPEN FIRST, THEN fstat THE FD (same reason as detonate's gate 1: a path-stat followed by a
    // path-open can land on two different inodes; the fd form closes that window by construction).
    let fd;
    try { fd = fs.openSync(src, 'r'); } catch (e) { return refuse('file', `cannot open src for read: ${e.message}`); }
    let stat;
    try { stat = fs.fstatSync(fd); } catch (e) { try { fs.closeSync(fd); } catch { /* best effort */ } return refuse('file', `cannot stat src: ${e.message}`); }
    if (!stat.isFile()) { try { fs.closeSync(fd); } catch { /* best effort */ } return refuse('file', 'src is not a regular file (directory / device / socket refused)'); }
    // Residual (unchanged, path-based — see detonate's gate 1): realpath needs a path, so this half
    // keeps its window.
    if (storeRoot != null && !isUnder(realOrNull(src), realOrNull(storeRoot))) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
      return refuse('file', `src does not resolve inside the expected store root (${storeRoot})`);
    }

    try {
      const size = stat.size; // from fstat(fd) — same inode as the reads below
      // --- gate 2: STRUCTURE (ndjson | json-single only; opaque/unparseable → never survey) ---
      const struct = discoverStructure(fd, size);
      if (struct.structure !== 'ndjson' && struct.structure !== 'json-single') {
        return refuse('structure', `unverifiable structure (${struct.structure}: ${struct.reason}) — never survey what we cannot parse`);
      }
      // --- CENSUS: whole-file scan, ALL types (wantSet=null). No cut, no snapshot — read-only. ---
      const { perType, oversizedSkipped, unitsUnparsed, typesTruncated, otherTypesUnits } = buildReport(fd, size, struct, typeField, null, maxChars);
      // Overflow units (parsed real units whose type fell past TYPE_CENSUS_MAX and got no named slot) are still
      // counted here, so totalUnits stays COMPLETE and the reconcile (totalUnits + unitsUnparsed + oversizedSkipped
      // = every physical unit) holds. On a normal file otherTypesUnits is 0 → identical to the pre-cap totalUnits.
      let totalUnits = otherTypesUnits;
      for (const t of Object.keys(perType)) totalUnits += perType[t].unitCount;
      // BREAK 4 (WAVE-7 META): unitsUnparsed = real BODY content the census could not type (unparseable
      // lines past a clean front sample). Surfaced so a census can NEVER report "totalUnits N" while
      // silently omitting live content — the caller sees the accounted (totalUnits) AND the unaccounted.
      // typesTruncated / otherTypesUnits: added ONLY when the type-cardinality cap actually fired (a normal
      // few-type file omits both → byte-identical shape). typesTruncated:true tells a reader the census named
      // TYPE_CENSUS_MAX types and bounded the rest; otherTypesUnits is the aggregate unit mass of that remainder
      // (the honest signal: overflow types are counted in aggregate, never each named — a distinct-overflow-type
      // count would need an O(N) set, defeating the cap; the flag + the mass are what a bounded census can honestly report).
      return { ok: true, structure: struct.structure, totalUnits, unitsUnparsed, oversizedSkipped, types: perType,
        ...(typesTruncated ? { typesTruncated: true, otherTypesUnits } : {}) };
    } catch (e) {
      // The census NEVER throws: an injected fs error or any other throw inside the gated body → refuse('internal');
      // the finally still closes fd.
      return refuse('internal', `survey internal error: ${e && e.message ? e.message : String(e)}`);
    } finally { try { fs.closeSync(fd); } catch { /* one-flock with explode's reduceFile: never throw out of finally */ } }
  } catch (e) {
    // FIX 4 outer catch: a throw in the opts destructuring (a throwing getter / Proxy) — before the inner fd
    // try — must still keep survey's never-throws contract → refuse('internal').
    return refuse('internal', `survey internal error: ${e && e.message ? e.message : String(e)}`);
  }
}
