// wizard.mjs — beta.12 item 5: the CODE-side primitives the wizard's
// interactive flow calls (the step-by-step prose/UX — "เข้าหน้า wizard
// แล้ว", the ทำ/later-free เริ่ม/ยกเลิก buttons, the exact SKILL.md
// procedure — is agent-orchestrated content, not this module's job; this
// ships the DETERMINISTIC pieces underneath it — entry scan, bill, and the
// 2026-07-16 locked-spec glue: background-clone handshake, manual-tier
// counts, CoalFace hand-off predicate):
//   (1) neutral entry (MEMORY.md "WIZARD ENTRY != BMI"): the wizard does NOT
//       arrive via the gauge and knows NO numbers at entry — openable on any
//       store at any level (incl. LEAN, for muscle-only work). `neutralScan`
//       is measurement ONLY: discoverClassB + measureEntries, deliberately
//       NEVER bandVerdict — a caller literally cannot leak a band/BMI number
//       before the scan step runs, by construction.
//   (2) the BILL (MEMORY.md "WIZARD SPEC v-FINAL"): "the flow SCANS THE
//       TARGET FIRST (the time number is measured, never guessed) -> the
//       bill = a PROCESS NOTICE only". `estimateBill` turns the scan's own
//       file/byte counts into a time BAND and a token-cost BAND — banded on
//       purpose ("a banded honest estimate, never fake point precision"),
//       never a single fake-precise number.
//
// RATE CALIBRATION (honest ceiling — same convention as caliper.mjs's own
// placeholder constants, e.g. CAPACITY_TOKENS): the org benchmark record
// (.github/benchmarks/CoalWash/results/wear-campaign-claude-code-2026-07-10.md,
// read 2026-07-11) is the only real lab throughput data available at this
// writing, and it measured FACT-SURVIVAL, not wall-clock duration or a
// clean per-KB token rate — so MINUTES_PER_PARTITION and TOKEN_RATE_PER_KB
// below are REASONED PLACEHOLDERS, not measured rates. Both MUST be
// recalibrated against real receipts the moment they exist (this file's own
// "calibrate later" debt, named so nobody mistakes the number for measured
// fact). PARTITION_FILES/PARTITION_KB are NOT placeholders — they are
// method.md §2's own already-shipped partition threshold ("~150 files or
// ~500KB... one measured outsider pass"), reused here as the natural billing
// unit rather than inventing a second one.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { measureEntries, tokensEst } from './caliper.mjs';
import { ccProjectSlug, discoverClassB } from './class-b.mjs';
import { findProjectRoot, loadMergedConfig } from './config-load.mjs';
import { classifyRetier, collectStores } from './retier.mjs';

export const PARTITION_FILES = 150;
export const PARTITION_KB = 500;
// PLACEHOLDER (see file header): minutes for ONE partition's full
// outsider -> insider -> executor -> gate round-trip.
export const MINUTES_PER_PARTITION = 5;
// PLACEHOLDER (see file header): ~est tokens spent per KB of washable input
// during a Full-tier pass (outsider read + insider judgment + executor
// rewrite + gate).
export const TOKEN_RATE_PER_KB = 300;
// The หนัก (heavy — fat+muscle, the นอกมิติ diff rung) tier runs a second
// outsider pass on top of เบา's single pass; band multipliers, not exact.
const HEAVY_TIME_MULT = 2;
const HEAVY_TOKEN_MULT = 1.5;
// Band width around the point estimate (+/-40%) — "banded honest estimate,
// never fake point precision"; a placeholder width like the rates above.
const BAND_LOW = 0.6;
const BAND_HIGH = 1.4;

function partitionCount(files, kb) {
  // the `, 1` floor inside Math.max already guarantees >= 1 partition (an empty
  // store still bills as one pass), so no outer Math.max(1, ...) is needed.
  return Math.ceil(Math.max(files / PARTITION_FILES, kb / PARTITION_KB, 1));
}
function band(n) {
  return { low: Math.max(0, Math.round(n * BAND_LOW)), high: Math.round(n * BAND_HIGH) };
}

// Neutral scan (1): measurement only, no verdict — the wizard's entry point.
// Never calls bandVerdict; a caller has no band/BMI number available until
// it deliberately asks the gauge for one (a SEPARATE call, not this one).
export function neutralScan(opts) {
  const { projectRoot, home, managedPaths } = opts || {};
  const disc = discoverClassB({ projectRoot, home, managedPaths });
  const m = measureEntries(disc.entries, { withGzip: false });
  return { platform: disc.platform, flags: disc.flags, measure: m };
}

// The bill (2): a time band + a token-cost band from the scan's own counts.
// `heavy` = หนัก (fat+muscle, the wizard-only tier that also runs the
// นอกมิติ diff); false = เบา (fat-only, broom + main, no outsider).
export function estimateBill(opts) {
  const { files, totalBytes, heavy = false } = opts || {};
  const f = Math.max(0, Number(files) || 0);
  const kb = Math.max(0, Number(totalBytes) || 0) / 1024;
  const partitions = partitionCount(f, kb);
  const baseMinutes = partitions * MINUTES_PER_PARTITION * (heavy ? HEAVY_TIME_MULT : 1);
  const baseTokens = Math.round(kb * TOKEN_RATE_PER_KB * (heavy ? HEAVY_TOKEN_MULT : 1));
  return {
    files: f,
    partitions,
    timeMinutes: band(baseMinutes),
    tokensEst: band(baseTokens),
    heavy,
  };
}

// ---------------------------------------------------------------------------
// Background-clone handshake + choice-4 glue (the locked wizard spec,
// 2026-07-16). All read-only/pure — the step flow stays agent-orchestrated;
// nothing here mutates a store.
// ---------------------------------------------------------------------------

// Main-side: the spawn contract a background clone must re-derive and match.
// Fingerprint = sha-256 (16 hex) of the MERGED config cascade (global +
// project) — same machine + same store => same fingerprint; any config
// divergence (or a config edit between spawn and clone start) flips it.
export function wizardContract({ projectRoot, home = os.homedir() } = {}) {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const cfg = loadMergedConfig({ cwd: root, home });
  return {
    projectRoot: root,
    slug: ccProjectSlug(root),
    configFingerprint: createHash('sha256').update(JSON.stringify(cfg)).digest('hex').slice(0, 16),
  };
}

// Clone-side FIRST act (before ANY read of the store): re-derive its own
// {projectRoot, slug, config fingerprint} from the inherited cwd/home and
// compare field-by-field against the contract main passed. ANY mismatch,
// missing field, or unresolvable path => refuse (fail-closed) — the clone
// returns touching NOTHING. The engine lock (.coalwash.lock) and the
// external-writer guard stay the nets BEHIND this front-door check.
export function wizardHandshake({ contract, cwd = process.cwd(), home = os.homedir() } = {}) {
  try {
    if (!contract || typeof contract !== 'object') return { ok: false, refuse: true, mismatches: ['contract-missing'] };
    const own = wizardContract({ projectRoot: findProjectRoot(cwd, home), home });
    const mismatches = ['projectRoot', 'slug', 'configFingerprint'].filter((k) => !contract[k] || contract[k] !== own[k]);
    return mismatches.length ? { ok: false, refuse: true, mismatches } : { ok: true, refuse: false, mismatches: [] };
  } catch {
    return { ok: false, refuse: true, mismatches: ['unresolvable'] }; // fail-closed
  }
}

// Choice-4 (3) inputs: the MANUAL tier = genuine memory TOPIC files (incl.
// the retier-overflow file) across every store — main + each agent-memory
// role. The index slot ((2)'s jurisdiction) and class-A ((1)'s bytes) are not
// (3)'s scope so they are not counted; files classifyRetier refuses
// (governance/machine-parsed/vendor/unknown strays inside a store dir) are
// excluded exactly the way (3) itself must skip them.
export function manualTierCounts({ projectRoot = process.cwd(), home = os.homedir() } = {}) {
  const stores = collectStores({ projectRoot, home });
  let files = 0;
  let totalBytes = 0;
  let tok = 0;
  for (const st of stores) {
    for (const t of st.topics) {
      if (classifyRetier({ path: t.path }) !== 'class-b-topic') continue;
      files += 1;
      totalBytes += t.bytes;
      tok += tokensEst(t.text);
    }
  }
  return { files, totalBytes, tokensEst: tok };
}

// The CoalFace hand-off gate (a PROSE rail in SKILL.md — this is only its
// deterministic predicate): fan-out is offered ONLY when the (3) workload is
// BOTH past the single-worker degradation knee AND partitionable (enough
// distinct files — CoalFace's own autoFanoutFloor sense). A single file can
// never be partitioned => 1 worker at ANY size (advise demote-first instead).
// 'offer-coalface' = OFFER ONCE, declinable; never auto-convene, never spawn
// extra workers inside CoalWash (fan-out belongs to the sibling /coalface).
export const HANDOFF_KNEE_TOK = 50000; // low edge of the ~50-60k degradation band — a REASONED placeholder like the rates above; offer-early is the safe direction (the offer is declinable)
export const HANDOFF_FLOOR_FILES = 4; // CoalFace's autoFanoutFloor factory default — its fan-out sense, not a new knob
export function handoffVerdict(opts) {
  const { manualTierTok, fileCount, kneeTok = HANDOFF_KNEE_TOK, floorFiles = HANDOFF_FLOOR_FILES } = opts || {};
  const tok = Number.isFinite(manualTierTok) ? manualTierTok : 0;
  const n = Number.isFinite(fileCount) ? fileCount : 0;
  if (n <= 1) return 'single-worker'; // a file cannot be partitioned
  return tok > kneeTok && n >= floorFiles ? 'offer-coalface' : 'single-worker';
}

// The bill line — plain text, program-side template (matching ask.mjs's own
// "code builds it, agent never composes" discipline). `fatTokens` is a
// pass-through DISPLAY figure from the caller's own gauge/scan, never
// computed here (the bill estimates RUN COST, not fat — two different
// numbers the wizard shows side by side).
export function billLine(opts) {
  const { files, fatTokens, bill } = opts || {};
  const b = bill || {};
  const t = b.timeMinutes || { low: 0, high: 0 };
  const c = b.tokensEst || { low: 0, high: 0 };
  const fat = Number.isFinite(fatTokens) ? Math.round(fatTokens) : null;
  const fatPart = fat == null ? '' : ` · fat found ~${fat} tok`;
  return `[CoalWash] scanned ${Number(files) || 0} file(s)${fatPart} · est. time ${t.low}-${t.high} min · est. token cost ${c.low}-${c.high} tok (~est, a rough band, not a precise quote)`;
}
