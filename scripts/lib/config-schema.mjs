// Single source of truth for every .coalwash.json key (SKILL-REPO-PATTERN Layer 3).
// Flat key list like CoalMine/CoalTipple. verify.mjs validates the factory template
// against it; every runtime read goes through clampedRead so an out-of-range or
// wrong-typed value silently degrades to the factory default, never misbehaves.
//
// Spec fields:
//   key     canonical .coalwash.json key
//   type    'bool' | 'int' | 'number' | 'enum'
//   min/max bounds for 'int'/'number' (inclusive)
//   values  allowed values for 'enum' (compared case-insensitively)
//   def     factory default — the clamp target for any invalid value
//   help    one-line description
//
// Standard-system keys (language / updateMode / updateCheckDays) keep CoalMine's
// schema shapes byte-for-byte (values + bounds + help) — one flock, one color.
// Band thresholds (PLUMP/OBESE/FULL BMI) are deliberately NOT config keys yet:
// they are placeholder code constants in caliper.mjs, to be calibrated at the
// fidelity benchmark before they earn a user-facing knob (no consumer-less keys).

export const CONFIG_SCHEMA = [
  { key: 'coalwashMode', type: 'enum', values: ['auto', 'manual', 'off'], def: 'auto', help: 'Master switch: auto = session-start gauge + band nudges; manual = /coalwash only (gauge silent); off = fully silent' },
  { key: 'language', type: 'enum', values: ['auto', 'th', 'en', 'ja', 'zh', 'es'], def: 'auto', help: 'Language override for prompts and nudges (auto, th, en, ja, zh, es)' },
  { key: 'fullPercent', type: 'number', min: 1, max: 50, def: 6, help: 'Hard ceiling as % of platform context capacity — the FULL band absolute clamp; raising it = consciously carrying more overhead (default: 6)' },
  // targetPercent has NO band-math consumer post-band-collapse: the anti-flap job
  // moved to caliper.mjs's BMI Schmitt trigger (CEILING_BMI/CEILING_REARM_BMI). It
  // survives as AGENT guidance for the wash clean-to depth (references/method.md §3);
  // kept, not removed (removing a shipped config key would be a breaking change).
  { key: 'targetPercent', type: 'number', min: 0.5, max: 49, def: 3, help: 'Clean-to depth target as % of capacity, below fullPercent — agent guidance for the wash (references/method.md §3); the anti-flap job now lives in caliper.mjs\'s BMI hysteresis, so no band-math reads this key today (default: 3)' },
  { key: 'fileMaxSizeKb', type: 'int', min: 1, max: 1024, def: 25, help: 'Per-file size cap in KB before a class-B file is flagged oversize (default: 25 — the CC memory-index cap class)' },
  { key: 'quickVsFull', type: 'enum', values: ['quick', 'full'], def: 'quick', help: 'Default run tier: quick = free mechanical pass; full = paid semantic pass (always a separate consent; default: quick)' },
  { key: 'localOnly', type: 'bool', def: false, help: "Trade-secret mode: the SKILL contract runs Quick-only and skips the semantic tier — agent-honored, not a code-enforced transmission block; the flag itself can't be weakened by a project config (default: false)" },
  { key: 'updateMode', type: 'enum', values: ['ask', 'auto', 'remind', 'off'], def: 'ask', help: 'Self-update behavior at session start (ask, auto, remind, off; default: ask)' },
  { key: 'updateCheckDays', type: 'int', min: 1, max: 365, def: 14, help: 'Days between self-update checks/reminders (default: 14)' },
  // exercisePerBand values are PER-BAND (F3, main-adjudicated per the 0f
  // ruling "OBESE never asks, no matter what"): obese admits ONLY 'quick' —
  // the old 'full' option routed an OBESE crossing to an ask, contradicting
  // the ruling; the key survives (documents the standing behavior, future-
  // proof) and a legacy obese:'full' config reads as 'quick' silently
  // (clampedRead's per-band safer-value-wins clamp, the CM v3.9.3 pattern).
  { key: 'exercisePerBand', type: 'bandmap', values: { obese: ['quick'], full: ['quick', 'full'] }, def: { obese: 'quick', full: 'full' }, help: 'Per-ceiling exercise (obese: quick only — OBESE is auto-Quick-silent by ruling, never an ask; full: quick|full); the fat-only scoping refinement is a later release (default: {obese:quick, full:full})' },
  { key: 'managedPaths', type: 'stringList', def: [], help: 'Extra path PREFIXES (relative to their own project/global root, forward-slash form) to auto-declare MANAGED — sync-owned packs never proposed for a local wash, same class as skills (default: [], the byte-identical-across-roots heuristic already covers the common case)' },
  // RE-TIER envelope (the wizard's FOURTH choice, consumed by retier.mjs ONLY
  // inside a wizard-consented run — never a hook/band/BMI). A +/- BAND, never
  // a locked value (the SSD watermark-pair law): targetTokens 4125 = the
  // cross-AI Tier-1 memory-index cap median (CC 6250 hard · Letta 10000 hard ·
  // Zep 625 default · LangChain-legacy 2000 default; WHATSNEW-LEDGER row 27,
  // 2026-07-16) and independently ~2% of the 200k binding envelope. Max 6250 =
  // the CC hard cap. The envelope decides TIER PLACEMENT ONLY — it may never
  // choose or escalate a treatment (retier.mjs's core rail).
  { key: 'retier', type: 'object', fields: {
    targetTokens: { type: 'int', min: 500, max: 6250, def: 4125 },
    armPct: { type: 'int', min: 5, max: 50, def: 20 },
    disarmPct: { type: 'int', min: 5, max: 50, def: 10 },
    headroomPct: { type: 'int', min: 5, max: 50, def: 10 },
  }, def: { targetTokens: 4125, armPct: 20, disarmPct: 10, headroomPct: 10 }, help: 'RE-TIER envelope (wizard-only): targetTokens = the per-store hot-index target (500-6250, def 4125 = the cross-AI Tier-1 median); armPct/disarmPct/headroomPct (5-50) derive arm ~ target*(1+arm%), disarm ~ target*(1-disarm%), fill ceiling ~ target*(1-headroom%) — a band, never a locked value; overflow demotes losslessly, nothing deleted (default: {4125, 20, 10, 10})' },
  // 0p WRITE-PATH SEATBELT + AIRBAG: on = both nets (PreToolUse snapshot-on-
  // first-write to a class-B governance/memory file + the PostToolUse advisory
  // when a structured token drops); snapshot-only = keep the airbag undo net
  // but SILENCE the advisory (for a user who finds the FYI line noisy); off =
  // both off. Advisory-only always (never blocks an edit). coalwashMode:off is
  // the master kill for this too.
  { key: 'writeGuard', type: 'enum', values: ['on', 'snapshot-only', 'off'], def: 'on', help: 'Write-path guard for class-B governance/memory files: on = snapshot-on-first-write + drop advisory; snapshot-only = airbag undo net, no advisory; off = disabled (advisory never blocks; default: on)' },
  // ULTRA estate tier (class-A at-rest transcripts — blueprint §19 P2 partial,
  // consumed by estate-archive.mjs ONLY inside a wizard-consented ULTRA run,
  // never a hook/band). Sub-keys clamp independently (object type below); the
  // compress<->purge ordering guard lives at the consumer (resolveEstateCfg).
  // digCrush = ULTRA trigger #2 (dig-gauge.mjs) — the PRE-READ tollgate's
  // thresholds, NESTED in estate (same estate/ULTRA family; clampedRead's
  // object path recurses so each sub-key clamps INDEPENDENTLY + a partial
  // config fills the absent sub-keys — the trust-boundary fill). All three are
  // config-clamped PRIORS from the minimax frame on the 200k binding envelope
  // (the frame that set RE-TIER's N): singleFileTok ~100k = >=50% of a 200k
  // worker window (unreadable in one pass) · pileTok ~150k = >=75% of one clean
  // worker load after overhead · fileCount 8 = 2x the default bandwidth wave
  // width. Shares are priors → calibrate from real dig telemetry (the a/b
  // pattern; note it, don't block on it).
  { key: 'estate', type: 'object', fields: {
    compressAfterDays: { type: 'int', min: 1, max: 3650, def: 14 },
    purgeAfterDays: { type: 'int', min: 0, max: 36500, def: 180 },
    deleteCold: { type: 'bool', def: false },
    archiveDir: { type: 'string', def: '' },
    indexEnabled: { type: 'bool', def: true },
    digCrush: { type: 'object', fields: {
      singleFileTok: { type: 'int', min: 20000, max: 200000, def: 100000 },
      pileTok: { type: 'int', min: 40000, max: 200000, def: 150000 },
      fileCount: { type: 'int', min: 3, max: 50, def: 8 },
    }, def: { singleFileTok: 100000, pileTok: 150000, fileCount: 8 } },
  }, def: { compressAfterDays: 14, purgeAfterDays: 180, deleteCold: false, archiveDir: '', indexEnabled: true, digCrush: { singleFileTok: 100000, pileTok: 150000, fileCount: 8 } }, help: 'ULTRA estate tier (wizard-only): compressAfterDays = WARM age before a transcript is gzip-archived (copy-verify-then-delete); purgeAfterDays = COLD age (0 = never; cold is report-only unless deleteCold is explicitly true = archive-then-delete, death-certified); archiveDir = absolute path, "" = the default under ~/.claude/coal/coalwash/; indexEnabled = write dig-index rows; digCrush = the dig-gauge PRE-READ crush thresholds (singleFileTok 20000-200000 / pileTok 40000-200000 / fileCount 3-50 — CRUSHING if any one holds) (default: {14, 180, false, "", true, {100000, 150000, 8}})' },
];

// 0m tombstone — "FORCE IS A DICTATOR, NO OFF SWITCH" (USER 2026-07-11:
// "วินโดว์ไม่เคยมีให้ปิด force ได้นะ และ force นี้ต้องเผด็จการเท่ากัน"): the
// `forceMode` knob (auto/ask/off) is REMOVED — force at FULL is non-optional
// by design (the Windows critical-space-maintenance model; the knife lives in
// UNDO, not pre-approval; the receipt is the surfacing, so no-silent-branch
// holds). The only full stop is `coalwashMode: off` — the skill's own power
// switch, a whole-skill choice, never a force veto. A LEGACY config still
// carrying a retired key is read-TOLERATED and ignored: never a validation
// error, never warning noise (clampedRead has no spec for it, so no consumer
// can ever read it). Do NOT re-add an off switch.
export const RETIRED_KEYS = Object.freeze(['forceMode']);

// Validate an already-parsed JSON value against a spec.
// Returns an error message fragment ("must be ...") or null when valid.
export function validateValue(spec, v) {
  switch (spec.type) {
    case 'bool':
      return typeof v === 'boolean' ? null : 'must be a boolean';
    case 'int':
      if (typeof v !== 'number' || !Number.isFinite(v)) return 'must be a finite number';
      if (!Number.isInteger(v)) return 'must be an integer';
      if (spec.min != null && v < spec.min) return `must be >= ${spec.min}`;
      if (spec.max != null && v > spec.max) return `must be <= ${spec.max}`;
      return null;
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) return 'must be a finite number';
      if (spec.min != null && v < spec.min) return `must be >= ${spec.min}`;
      if (spec.max != null && v > spec.max) return `must be <= ${spec.max}`;
      return null;
    case 'enum':
      return typeof v === 'string' && spec.values.includes(v.toLowerCase())
        ? null
        : `must be one of: ${spec.values.join(', ')}`;
    case 'string':
      return typeof v === 'string' ? null : 'must be a string';
    case 'stringList':
      return Array.isArray(v) && v.every((s) => typeof s === 'string') ? null : 'must be an array of strings';
    case 'object': {
      // fields = per-sub-key primitive specs; a PARTIAL object is valid (the
      // clamp fills absent sub-keys with their own defaults), an unknown
      // sub-key is an error (schema is the allowlist).
      if (!v || typeof v !== 'object' || Array.isArray(v)) return 'must be an object';
      for (const [k, sub] of Object.entries(v)) {
        const fieldSpec = spec.fields[k];
        if (!fieldSpec) return `has an unknown sub-key '${k}'`;
        const err = validateValue(fieldSpec, sub);
        if (err) return `'${k}' ${err}`;
      }
      return null;
    }
    case 'bandmap': {
      // values = a per-sub-key allowlist map (F3: each band declares its own
      // options — obese admits only 'quick').
      if (!v || typeof v !== 'object' || Array.isArray(v)) return 'must be an object';
      for (const k of Object.keys(spec.def)) {
        if (!(k in v)) return `must include '${k}'`;
        const allowed = spec.values[k] || [];
        if (typeof v[k] !== 'string' || !allowed.includes(v[k].toLowerCase())) return `'${k}' must be one of: ${allowed.join(', ')}`;
      }
      return null;
    }
    default:
      return `has an unknown spec type '${spec.type}'`;
  }
}

// Validate a full parsed config object (unknown keys are reported, never
// thrown; a RETIRED key is tolerated silently — legacy configs keep working).
export function validateConfig(cfg) {
  const errors = [];
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return ['config must be a JSON object'];
  const byKey = new Map(CONFIG_SCHEMA.map((s) => [s.key, s]));
  for (const [key, v] of Object.entries(cfg)) {
    if (RETIRED_KEYS.includes(key)) continue; // read-tolerated, ignored (0m tombstone)
    const spec = byKey.get(key);
    if (!spec) { errors.push(`'${key}' not in schema`); continue; }
    const err = validateValue(spec, v);
    if (err) errors.push(`'${key}' ${err}`);
  }
  return errors;
}

// Per-SUB-KEY clamp of an 'object' spec, rebuilt from the spec's OWN fields
// (never the raw value's key set — an extra/unknown sub-key can't leak, every
// declared sub-key is guaranteed present at its own default): each sub-key
// reads its value when valid, else ITS OWN factory default — a malformed
// sub-key degrades alone, never the block. An object-typed sub-field RECURSES
// (so a nested block like estate.digCrush also clamps per-sub-key + fills a
// partial config's absent sub-keys — the trust-boundary fill); everything else
// takes the primitive path. Byte-identical to the old inline object clamp for a
// primitive-only block (estate's existing fields, retier) — the recursion only
// activates for the object-typed field.
function clampObject(spec, v) {
  const raw = (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  const out = {};
  for (const [k, fieldSpec] of Object.entries(spec.fields)) {
    out[k] = fieldSpec.type === 'object'
      ? clampObject(fieldSpec, raw[k])
      : (raw[k] !== undefined && validateValue(fieldSpec, raw[k]) === null) ? raw[k] : fieldSpec.def;
  }
  return out;
}

// Clamped read: return the config value for `key` if valid, else the factory
// default (enums normalized to lowercase). An unknown key returns undefined —
// that is a programming error, surfaced loud in tests, silent at runtime.
export function clampedRead(cfg, key) {
  const spec = CONFIG_SCHEMA.find((s) => s.key === key);
  if (!spec) return undefined;
  const v = cfg ? cfg[key] : undefined;
  if (spec.type === 'object') return clampObject(spec, v);
  if (spec.type === 'bandmap') {
    // Per-SUB-KEY safer-value-wins clamp (F3, the CM v3.9.3 pattern),
    // rebuilt from the spec's OWN sub-keys (never the raw value's key set —
    // a malformed/extra sub-key can't leak through, every expected sub-key
    // is guaranteed present): each band reads its own value when allowed,
    // else ITS OWN factory default — so a legacy obese:'full' silently
    // reads 'quick' (no breakage) WITHOUT clobbering a still-valid
    // customization on the other band.
    const raw = (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
    const out = {};
    for (const k of Object.keys(spec.def)) {
      const val = typeof raw[k] === 'string' ? raw[k].toLowerCase() : null;
      out[k] = (spec.values[k] || []).includes(val) ? val : spec.def[k];
    }
    return out;
  }
  if (v === undefined || validateValue(spec, v) !== null) return spec.def;
  if (spec.type === 'enum') return v.toLowerCase();
  return v;
}
