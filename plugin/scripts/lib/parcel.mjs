// parcel.mjs — L2 PARCEL AUDIT (ruling 0l: "class-B defined BEHAVIORALLY, the
// immortal-bird layer"). THE INVARIANT (user's canonical phrasing, the
// ship-text seed): CW keeps NO list of its own — its list is a MIRROR of the
// real load list, whoever writes to it ("load ไหนเข้าบริษัท load นั้นเข้า CW
// ด้วย"). A hand-kept list rots; a mirror cannot rot because it does not
// remember — it reflects.
//
// Two-layer architecture (0l): L1 = the adapter fast path (class-b.mjs's
// discoverClassB — known platforms, 0-token, the every-session path, kept
// untouched). L2 = THIS module: the AGENT enumerates the files it can SEE
// auto-loaded in its own context (on CC the parcel self-labels with full
// paths), then CODE certifies every candidate. Jurisdiction stays
// deterministic — the agent points at falsifiable EVIDENCE per item, the
// code verifies it:
//   - an HALLUCINATED candidate dies at the content-match (the agent cannot
//     quote the head of a file it never saw);
//   - a SPOOF file claiming class-B was never actually loaded, so the agent
//     has no in-context sample for it — same death;
//   - a genuinely-loaded attacker file is already legitimately class-B (being
//     delivered IS the membership test — the user-side completeness rule).
// Fail direction = UNDERCOUNT (unseen = unmeasured = uncut — safe).
//
// L2 roles: (a) REAL discovery on unknown/future platforms (upgrades the old
// "no discovery + flag" conservative path to propose → code-verify → human
// confirms); (b) DRIFT CANARY on known platforms (compareParcelToAdapter
// below) at cheap cadence — wizard entry / on-demand, NEVER an every-session
// layer on CC (L2 costs agent tokens; L1 stays the every-session path).
//
// CAPTURE-ALL → FILTER, the order LAW (0l): L2 feeds MEASUREMENT jurisdiction
// only — the whole parcel is counted first; the untouchables are filtered out
// of KNIFE jurisdiction downstream (managed tag · keeps · user-default ·
// bins self-exclusion). This module NEVER feeds the knife directly, and it is
// strictly READ-ONLY (reads + stats, zero writes of any kind).
import fs from 'node:fs';
import { physicalOrNull, containedIn } from './class-b.mjs';
import { tokensEstFromBytes } from './caliper.mjs';

// Head-compare window: the agent quotes roughly the first ~200 chars of the
// block AS SEEN in context; we compare whitespace-normalized (see norm below)
// so quoting artifacts (wrapped lines, CRLF vs LF, collapsed runs) never
// false-reject a genuine sighting.
export const SAMPLE_COMPARE_CHARS = 200;
// Anti-spoof substance floor: a trivially short sample ("#", "a") would match
// half the filesystem — a candidate must quote enough head to be falsifiable.
// A genuinely TINY file passes by quoting its ENTIRE content instead.
export const SAMPLE_MIN_CHARS = 24;
// How much raw disk head to normalize for the compare — generous slack over
// SAMPLE_COMPARE_CHARS so heavy whitespace in the raw file can never starve
// the normalized window.
const DISK_HEAD_RAW_CHARS = 4096;

// Whitespace-normalization rule (the ONE rule, both sides): every whitespace
// RUN (spaces, tabs, newlines — CRLF included) collapses to a single space,
// ends trimmed. Content characters are never altered — Thai, emoji, curly
// quotes compare verbatim.
function norm(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

// Verify an agent's parcel-observation candidates. candidates =
// [{ path, sample }] — path is the label the parcel block carried; sample is
// the first ~200 chars of that block AS SEEN in context. Every check must
// hold or the candidate is REJECTED with a named reason:
//   (a) realpath-resolves + contained in the home OR project tree (physical
//       both sides — the umbrella realpath-and-contain lesson; unresolvable
//       or escaping = fail-closed);
//   (b) exists + readable;
//   (c) the DISK head matches the OBSERVED sample (whitespace-normalized) —
//       the anti-hallucination / anti-spoof certificate.
// Returns { verified: [{path, bytes, tokensEst}], rejected: [{path, reason}] }.
// READ-ONLY measurement helper; never throws (per-candidate failures reject,
// a top-level surprise returns everything-rejected).
export function verifyParcelCandidates(candidates, { home, projectRoot } = {}) {
  const verified = [];
  const rejected = [];
  const roots = [physicalOrNull(home), physicalOrNull(projectRoot)].filter(Boolean);
  for (const c of Array.isArray(candidates) ? candidates : []) {
    const label = c && typeof c.path === 'string' && c.path ? c.path : JSON.stringify(c && c.path);
    try {
      if (!c || typeof c.path !== 'string' || !c.path) {
        rejected.push({ path: label, reason: 'malformed candidate (no path string)' });
        continue;
      }
      if (!roots.length) {
        rejected.push({ path: c.path, reason: 'no resolvable containment root (home/projectRoot) — fail-closed' });
        continue;
      }
      const phys = physicalOrNull(c.path);
      if (!phys) {
        rejected.push({ path: c.path, reason: 'path does not resolve on disk (missing or unresolvable) — fail-closed' });
        continue;
      }
      if (!containedIn(phys, roots)) {
        rejected.push({ path: c.path, reason: 'escapes the home/project trees (realpath-and-contain, both sides physical) — fail-closed' });
        continue;
      }
      let stat;
      try { stat = fs.statSync(phys); } catch { stat = null; }
      if (!stat || !stat.isFile()) {
        rejected.push({ path: c.path, reason: 'not a readable file' });
        continue;
      }
      let raw;
      try { raw = fs.readFileSync(phys, 'utf8'); } catch {
        rejected.push({ path: c.path, reason: 'exists but unreadable' });
        continue;
      }
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // BOM never breaks the head compare
      const diskNorm = norm(raw.slice(0, DISK_HEAD_RAW_CHARS));
      const sampleNorm = norm(c.sample).slice(0, SAMPLE_COMPARE_CHARS);
      if (!sampleNorm) {
        rejected.push({ path: c.path, reason: 'no sample — a candidate must quote the head it saw in context' });
        continue;
      }
      // Substance floor: >= SAMPLE_MIN_CHARS, or the sample IS the whole
      // (tiny) file's normalized content.
      if (sampleNorm.length < SAMPLE_MIN_CHARS && sampleNorm !== norm(raw)) {
        rejected.push({ path: c.path, reason: `sample too short to verify (need >= ${SAMPLE_MIN_CHARS} normalized chars, or the whole content of a tiny file)` });
        continue;
      }
      if (!diskNorm.startsWith(sampleNorm)) {
        rejected.push({ path: c.path, reason: 'disk head does not match the observed sample — not what actually loaded (hallucinated, stale, or spoofed)' });
        continue;
      }
      verified.push({ path: phys, bytes: stat.size, tokensEst: tokensEstFromBytes(stat.size) });
    } catch (e) {
      rejected.push({ path: label, reason: `verifier error (rejected, fail-closed): ${e.message}` });
    }
  }
  return { verified, rejected };
}

// DRIFT CANARY (0l role b) — set-diff the L2-verified parcel against the L1
// adapter's entries, physical paths, case-folded on Windows. Pure function.
//   onlyInParcel  = the agent SAW it load, the adapter missed it → the
//                   platform added a surface / adapter rot — the flag.
//   onlyInAdapter = the adapter lists it, the agent did not see it —
//                   informational. Recall-store entries are EXPECTED here
//                   (they load on demand, not per-session), so only the
//                   adapter's alwaysLoaded entries join this side of the diff.
//   matched       = both agree.
export function compareParcelToAdapter(verified, adapterEntries) {
  const fold = (p) => (process.platform === 'win32' ? String(p).toLowerCase() : String(p));
  const parcel = new Map();
  for (const v of Array.isArray(verified) ? verified : []) {
    if (v && typeof v.path === 'string' && v.path) parcel.set(fold(v.path), v.path);
  }
  const adapter = new Map();
  for (const e of Array.isArray(adapterEntries) ? adapterEntries : []) {
    if (e && typeof e.path === 'string' && e.path && e.alwaysLoaded === true) adapter.set(fold(e.path), e.path);
  }
  const matched = [];
  const onlyInParcel = [];
  const onlyInAdapter = [];
  for (const [k, p] of parcel) (adapter.has(k) ? matched : onlyInParcel).push(p);
  for (const [k, p] of adapter) { if (!parcel.has(k)) onlyInAdapter.push(p); }
  return { matched, onlyInParcel, onlyInAdapter };
}
