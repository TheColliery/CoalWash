// ROOT-PROVENANCE CONFORMANCE GATE (R5, USER 2026-07-25).
//
// THE RULE IT ENFORCES: a containment ROOT must be provenance-TRUSTED —
// caller-derived, or a fixed home/project anchor — NEVER data-derived.
// Canonicalizing a data-derived root does not launder it.
//
// WHY A TEST AND NOT A TYPE. The threat here is a DEVELOPER writing a new bad
// site, not an attacker supplying a bad value at runtime — F1 shipped because a
// human review missed it, and the next one would ship the same way. A developer
// mistake belongs to BUILD time. A runtime minted-root type was costed at ~21
// root-birth sites plus an exemption mechanism to catch two sites already known
// and accepted; this file buys the same "the next person cannot do it silently"
// property for one file and zero production change. Adding a name to the
// allowlist below is a visible diff IN A SECURITY TEST — that visibility is the
// actual control, not the string matching.
//
// HONEST LIMIT, stated so nobody mistakes this for a proof: it is a static
// source check. It is defeated by aliasing (`const r = jroots; containedIn(x, r)`)
// exactly as a minted type is defeated by laundering (`trustedRoot(journal.snapDir)`).
// Neither is a proof; both make the next mistake VISIBLE. That is the whole claim.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB = path.dirname(fileURLToPath(import.meta.url));

// Every root expression permitted as the OUTER GATE of a containment check.
// Each entry states WHY it is trusted. A new name here must be justified in the
// same diff — that review is the point of the gate.
const TRUSTED_ROOTS = new Map([
  ['roots', 'caller-derived: [home, projectRoot] (+ the Claude base dir in writeguard), built from function parameters'],
  ['[physRoot]', 'caller-derived: physicalOrNull(projectRoot) — anchor-diff'],
  ['[anchorPhys]', 'caller-derived: the resolved project anchor (opts.projectRoot or findProjectRoot(cwd))'],
  ['trustedRoots', 'caller-derived: resolved projectRoot + ccMemoryDir — never plan/journal-supplied'],
  ['[txPhys]', 'caller-derived: opts.txDir or txDirFor(projectRoot)'],
  ['[basePhys]', 'home-anchored: the Claude base dir'],
  ['claudeRoots', 'home-anchored: the Claude base dir'],
  ['[claudeRoot]', 'home-anchored: the Claude base dir'],
  ['[snapPhys]', 'caller-derived in retier (the snapshotDir parameter); in apply.mjs recoverDangling it is journal-derived but BOUND to the caller-derived tx dir before use — see the REVIEWED_EXEMPTIONS note'],
  ['[tx]', 'caller-derived: txDir(projectRoot)'],
  ['trees', 'caller-derived: the Claude base dir + projectRoot/.claude'],
]);

// Data-derived root sets that are LEGAL because they only ever NARROW a trusted
// gate — they are the SECOND term of `containedIn(x, trusted) && containedIn(x, N)`,
// never the outer gate. The rule is "the OUTER gate must be trusted", NOT "data may
// never appear in a root position"; refusing these would break a real control.
const LEGAL_NARROWINGS = new Map([
  ['jroots', 'journal.roots — only ever ANDed with trustedRoots on the same call (apply.mjs recoverDangling)'],
]);

// The THIRD legal pattern, which the first cut of this gate wrongly folded into
// the second: a data-derived set that is VALIDATED ELEMENT-BY-ELEMENT against a
// trusted gate BEFORE it is used, rather than ANDed at each use. `physRoots` is
// this — `apply.mjs` rejects the whole plan if any declared root escapes
// trustedRoots, so by the time it gates an action every element is already proven
// ⊆ trusted. Requiring a same-line AND here would be wrong, and deleting the
// validation loop would be catastrophic — so the guard is that the loop must still
// exist in the same file, keyed on the source line that performs it.
const VALIDATED_BEFORE_USE = new Map([
  ['physRoots', {
    why: 'plan.roots — every entry validated ⊆ trustedRoots up-front (apply.mjs), so the set is proven trusted before any use',
    validatorMustExist: 'containedIn(r, trustedRoots)',
  }],
]);

// REVIEWED EXEMPTIONS — data-derived outer gates that are ACCEPTED, each with the
// reason it is a different trust class. Adding to this list is the visible diff.
const REVIEWED_EXEMPTIONS = new Map([
  ['[rootPhys]', 'estate-archive.mjs: estate.archiveDir from project config — documented, wizard-only, named on the consent bill before the press'],
  ['[archiveRootPhys]', 'retier.mjs: the same estate.archiveDir config value, same trust class'],
]);

// Split a call's argument list at TOP-LEVEL commas only (so `[a, b]` stays one arg).
function splitArgs(s) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// Every `containedIn(...)` CALL in the engine, with its root argument.
function collectCallSites() {
  const sites = [];
  for (const f of fs.readdirSync(LIB).filter((n) => n.endsWith('.mjs') && !n.endsWith('.test.mjs'))) {
    const src = fs.readFileSync(path.join(LIB, f), 'utf8');
    const lines = src.split(/\r?\n/);
    lines.forEach((line, i) => {
      if (/function\s+(is)?[cC]ontainedIn\s*\(/.test(line)) return; // the definition itself
      let idx = 0;
      for (;;) {
        const m = /\bcontainedIn\s*\(/.exec(line.slice(idx));
        if (!m) break;
        const open = idx + m.index + m[0].length;
        let depth = 1, j = open;
        while (j < line.length && depth > 0) { const c = line[j]; if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) depth--; j++; }
        const args = splitArgs(line.slice(open, j - 1));
        if (args.length >= 2) sites.push({ file: f, line: i + 1, root: args[1], text: line.trim() });
        idx = open;
      }
    });
  }
  return sites;
}

test('CONFORMANCE: every containment root in the engine is provenance-trusted, a reviewed exemption, or a legal narrowing', () => {
  const sites = collectCallSites();
  assert.ok(sites.length >= 20, `the collector found only ${sites.length} call sites — it is broken, and a broken collector passes vacuously`);
  const bad = [];
  for (const s of sites) {
    if (TRUSTED_ROOTS.has(s.root) || REVIEWED_EXEMPTIONS.has(s.root)) continue;
    if (VALIDATED_BEFORE_USE.has(s.root)) {
      // Legal ONLY while the up-front validation it depends on is still there.
      const { validatorMustExist } = VALIDATED_BEFORE_USE.get(s.root);
      const src = fs.readFileSync(path.join(LIB, s.file), 'utf8');
      if (src.includes(validatorMustExist)) continue;
      bad.push(`${s.file}:${s.line} — '${s.root}' is only trusted because of an up-front validation that is GONE (expected \`${validatorMustExist}\` in this file)`);
      continue;
    }
    if (LEGAL_NARROWINGS.has(s.root)) {
      // A narrowing is legal ONLY as the second term beside a trusted gate on the
      // same line. Standing alone it IS the outer gate, which is the F1 defect.
      //
      // Compare PARSED SIBLING CALLS, never a substring of the source line: the
      // first cut of this check did `text.includes('roots')`, which is satisfied by
      // the substring inside `jroots` itself — so a narrowing promoted to sole gate
      // stayed GREEN. Caught only by running the mutation. Same substring-FP class
      // this whole campaign keeps producing.
      const alsoTrusted = sites.some((o) => o.file === s.file && o.line === s.line && TRUSTED_ROOTS.has(o.root));
      if (alsoTrusted) continue;
      bad.push(`${s.file}:${s.line} — narrowing '${s.root}' is the SOLE gate (must be ANDed with a trusted root): ${s.text.slice(0, 90)}`);
      continue;
    }
    bad.push(`${s.file}:${s.line} — root '${s.root}' is not a named trusted root: ${s.text.slice(0, 90)}`);
  }
  assert.deepStrictEqual(bad, [], `UNTRUSTED CONTAINMENT ROOT(S).\nA root must be caller-derived or a fixed home/project anchor. If this is genuinely trusted, add it to TRUSTED_ROOTS with its provenance — that diff is the review.\n  ${bad.join('\n  ')}`);
});

test('CONFORMANCE: the allowlist has no dead entries — a name nobody uses is stale review debt', () => {
  const used = new Set(collectCallSites().map((s) => s.root));
  const dead = [...TRUSTED_ROOTS.keys(), ...LEGAL_NARROWINGS.keys(), ...VALIDATED_BEFORE_USE.keys(), ...REVIEWED_EXEMPTIONS.keys()].filter((k) => !used.has(k));
  assert.deepStrictEqual(dead, [], `allowlist entries no longer used by any call site — remove them so the list keeps meaning something: ${dead.join(', ')}`);
});

test('CONFORMANCE: both archiveDir exemptions are still exactly two, and still where review accepted them', () => {
  const sites = collectCallSites().filter((s) => REVIEWED_EXEMPTIONS.has(s.root));
  assert.strictEqual(sites.length, 2, `expected exactly 2 reviewed data-derived gates, found ${sites.length} — a NEW one appeared and needs a ruling, not a quiet pass`);
  assert.deepStrictEqual(sites.map((s) => s.file).sort(), ['estate-archive.mjs', 'retier.mjs']);
});

test('CONFORMANCE: containedIn has ONE definition in the class-B engine (the apply.mjs duplicate stays deleted)', () => {
  const defs = [];
  for (const f of fs.readdirSync(LIB).filter((n) => n.endsWith('.mjs') && !n.endsWith('.test.mjs'))) {
    const src = fs.readFileSync(path.join(LIB, f), 'utf8');
    if (/^\s*(export\s+)?function\s+containedIn\s*\(/m.test(src)) defs.push(f);
  }
  // explode.mjs's `isContainedIn` is the class-A twin — a NAMED divergence (it may
  // not import this chain) pinned BEHAVIOURALLY by twin-pin.test.mjs, so it is
  // deliberately not counted here and needs no shared primitive.
  assert.deepStrictEqual(defs, ['class-b.mjs'], `containedIn must have exactly one definition; found in: ${defs.join(', ')}`);
});
