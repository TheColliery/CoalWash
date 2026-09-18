// JSONC comment stripper — ported verbatim from the flock-canonical shape
// (CoalTipple/CoalHearth scripts/lib/jsonc.mjs; the CM #12 string-vs-comment fix:
// a value ending in a literal backslash, e.g. "C:\\", must terminate its string
// correctly instead of leaking escape state into the next token).

export function stripJsonc(content) {
  return content.replace(/"(?:\\.|[^"\\])*"|\/\/.*|\/\*[\s\S]*?\*\//g, (m) => (m[0] === '"' ? m : ''));
}

// Prototype-pollution guard (OWASP Node.js): a poisoned project .coalwash.json
// (e.g. shipped by an untrusted cloned repo) with a `__proto__` / `constructor` /
// `prototype` key would flow into the config merge — a [[Set]] with a `__proto__`
// key pollutes Object.prototype. Drop those keys at parse (the reviver runs over
// the tree before anything uses it). stripJsonc stays exported for verify.mjs.
const PROTO_GUARD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
export function parseJsonc(content) {
  return JSON.parse(stripJsonc(content), (k, v) => (PROTO_GUARD_KEYS.has(k) ? undefined : v));
}
