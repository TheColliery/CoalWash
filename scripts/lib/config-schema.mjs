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
  { key: 'forceMode', type: 'enum', values: ['auto', 'ask', 'off'], def: 'auto', help: 'FULL+economical crossing behavior at Stop: auto = standing-consent auto-run (the rot-canary autoFixMode model); ask = FULL asks like other ceilings; off = same as ask — never silent (they suppress only the auto-run authorization, never FULL awareness; default: auto)' },
  { key: 'managedPaths', type: 'stringList', def: [], help: 'Extra path PREFIXES (relative to their own project/global root, forward-slash form) to auto-declare MANAGED — sync-owned packs never proposed for a local wash, same class as skills (default: [], the byte-identical-across-roots heuristic already covers the common case)' },
];

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
    case 'stringList':
      return Array.isArray(v) && v.every((s) => typeof s === 'string') ? null : 'must be an array of strings';
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

// Validate a full parsed config object (unknown keys are reported, never thrown).
export function validateConfig(cfg) {
  const errors = [];
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return ['config must be a JSON object'];
  const byKey = new Map(CONFIG_SCHEMA.map((s) => [s.key, s]));
  for (const [key, v] of Object.entries(cfg)) {
    const spec = byKey.get(key);
    if (!spec) { errors.push(`'${key}' not in schema`); continue; }
    const err = validateValue(spec, v);
    if (err) errors.push(`'${key}' ${err}`);
  }
  return errors;
}

// Clamped read: return the config value for `key` if valid, else the factory
// default (enums normalized to lowercase). An unknown key returns undefined —
// that is a programming error, surfaced loud in tests, silent at runtime.
export function clampedRead(cfg, key) {
  const spec = CONFIG_SCHEMA.find((s) => s.key === key);
  if (!spec) return undefined;
  const v = cfg ? cfg[key] : undefined;
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
