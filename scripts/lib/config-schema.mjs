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
  { key: 'targetPercent', type: 'number', min: 0.5, max: 49, def: 3, help: 'Low-water clean-to target as % of capacity (must sit below fullPercent; anti-thrash hysteresis; default: 3)' },
  { key: 'fileMaxSizeKb', type: 'int', min: 1, max: 1024, def: 25, help: 'Per-file size cap in KB before a class-B file is flagged oversize (default: 25 — the CC memory-index cap class)' },
  { key: 'quickVsFull', type: 'enum', values: ['quick', 'full'], def: 'quick', help: 'Default run tier: quick = free mechanical pass; full = paid semantic pass (always a separate consent; default: quick)' },
  { key: 'localOnly', type: 'bool', def: false, help: "Trade-secret mode: the SKILL contract runs Quick-only and skips the semantic tier — agent-honored, not a code-enforced transmission block; the flag itself can't be weakened by a project config (default: false)" },
  { key: 'updateMode', type: 'enum', values: ['ask', 'auto', 'remind', 'off'], def: 'ask', help: 'Self-update behavior at session start (ask, auto, remind, off; default: ask)' },
  { key: 'updateCheckDays', type: 'int', min: 1, max: 365, def: 14, help: 'Days between self-update checks/reminders (default: 14)' },
  { key: 'exercisePerBand', type: 'bandmap', values: ['quick', 'full'], def: { plump: 'quick', obese: 'full', full: 'full' }, help: 'Per-ceiling exercise the Stop-hook ask offers (quick|full each, for plump/obese/full); the fat-only scoping refinement is a later release (default: {plump:quick, obese:full, full:full})' },
  { key: 'forceMode', type: 'enum', values: ['auto', 'ask', 'off'], def: 'auto', help: 'FULL+economical crossing behavior at Stop: auto = standing-consent auto-run (the rot-canary autoFixMode model); ask = FULL asks like other ceilings; off = same as ask — never silent (they suppress only the auto-run authorization, never FULL awareness; default: auto)' },
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
    case 'bandmap': {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return 'must be an object';
      for (const k of Object.keys(spec.def)) {
        if (!(k in v)) return `must include '${k}'`;
        if (typeof v[k] !== 'string' || !spec.values.includes(v[k].toLowerCase())) return `'${k}' must be one of: ${spec.values.join(', ')}`;
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
  if (v === undefined || validateValue(spec, v) !== null) return spec.def;
  if (spec.type === 'enum') return v.toLowerCase();
  if (spec.type === 'bandmap') {
    // Rebuild from the spec's OWN sub-keys (never the raw value's own key set)
    // so a malformed/extra sub-key on an otherwise-valid object can't leak
    // through, and every expected sub-key is guaranteed present.
    const out = {};
    for (const k of Object.keys(spec.def)) out[k] = String(v[k]).toLowerCase();
    return out;
  }
  return v;
}
