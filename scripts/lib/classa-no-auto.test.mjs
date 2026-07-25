// classa-no-auto.test.mjs — pins the standing property: THE CLASS-A ENGINE IS
// NEVER AUTO-INVOKED.
//
// WHY A TEST AND NOT A CLAIM (USER 2026-07-25): class-A is a destructive reducer
// over the at-rest transcript estate — the accumulated past. Being un-wired today
// is not the same as being PINNED un-wired. A future edit reaches it in one line
// (`await import(lib('explode.mjs'))`) and nothing in the suite would notice.
// This file is the something that notices.
//
// ── THE INVERSION, AND WHY IT HAD TO MOVE UP A LEVEL ────────────────────────
// v1 derived its roots from hooks/hooks.json alone. That inverted over PLACES
// (it never listed forbidden dirs) but silently assumed ONE CLASS of auto
// surface. A GitHub Action entry script is invoked by a WORKFLOW, not a hook
// manifest: v1 would have stayed green while the strictest auto surface the
// product can have — a runner executing an untrusted checkout with no human
// present — went completely uncovered.
//
// The fix is NOT "hooks.json + workflows". That is the same enumeration trap one
// rung up: the next surface class (a scheduled job, an MCP-style entry, a
// platform's new invocation channel) would be invisible in exactly the same way.
// So this test knows what an auto surface KIND is:
//   1. find every artifact in the repo that DECLARES AN INVOCATION — names
//      something to run without a human;
//   2. derive roots from each KIND it recognises;
//   3. FAIL LOUDLY on any invocation-declaring artifact whose kind it does NOT
//      recognise.
// (3) is the point. An unrecognised kind is not "nothing to see"; it is "someone
// must teach me this or the guarantee is void." The test reports that it has been
// OUTGROWN instead of quietly under-covering.
//
// ── WHAT IS DELIBERATELY *NOT* ASSERTED ─────────────────────────────────────
// The human-invoked surface (`commands/`, `skills/`) is the EXPLICIT UPGRADE — a
// user typing the command or invoking the SKILL. Wiring class-A there is the
// PLANNED graduation step (the same moment build-plugin's UNWIRED_ENGINE dist
// exclusion is deleted), so it must stay possible. Wiring it into a hook or a
// workflow never is. The line is drawn exactly there: the planned step stays
// green, the silent one goes red.
//
// ── CEILINGS, NAMED ─────────────────────────────────────────────────────────
// ponytail: reachability is a STATIC text walk, not a real module graph. A string
// literal counts ONLY in an IMPORT CONTEXT (`from '…'`, `require(…)`, `import(…)`),
// which is what makes it both sharp and safe here:
//   * it FOLLOWS this codebase's real dynamic idiom, `await import(lib('x.mjs'))`
//     (hooks/coalwash-conductor.js), which a static-import-only walk misses;
//   * it IGNORES a mere MENTION — and there are two live ones that would
//     otherwise turn this test red for the wrong reason: verify.mjs's
//     `UNLISTED_OK` set and build-plugin.mjs's `UNWIRED_ENGINE` list both name
//     the engine files as strings precisely in order to EXCLUDE them.
// Accepted blind spots: a fully computed specifier (`lib('explo'+'de.mjs')`), and
// a dynamic import whose specifier is a variable (verify.mjs imports its LIBS
// roster that way — those are class-B libs and the roster explicitly excludes
// class-A). Both accepted: this pins against ACCIDENT and silent drift, the
// stated threat; it is not an adversarial sandbox. UPGRADE PATH if that changes:
// walk the real graph under a loader hook and record resolved specifiers.
// Skipped dirs: `plugin/` is a byte-verified copy of source (verify.mjs
// checkDist) so scanning it only double-reports; `.claude/`+`.agents/` hold
// RUNTIME artifacts (CoalHearth's journal, CoalWash's own sandbox), not product
// declarations.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ANCHOR INVARIANT — SELF-REFERENTIAL, AND IT MUST STAY THAT WAY.
// `repo` is derived from THIS FILE's own location (import.meta.url + a fixed
// offset): the tree that contains me. Never from a project-root RESOLVER, never
// from cwd, never from home. A resolver can mis-answer "where is the project?";
// nothing can mis-answer "where am I?".
// This is load-bearing, not style. The whole guarantee is "class-A is not
// reachable from anything in THIS workspace" — so if the anchor ever pointed
// outside the workspace, the walk would scan a foreign tree, find no violations,
// and pass. A MIS-ANCHORED RUN FAILS GREEN, which is the worst possible failure
// for a safety test. Live proof this is not hypothetical: the vendor-churn lab
// returned FAIL on findProjectRoot's ROOT_MARKERS — a marker in any ancestor
// beats the directory passed in, the walk can return a strict ancestor of `home`,
// and a junction can anchor outside home, all silently. Swapping this line for
// that shared helper would look like a tidy-up and would silently couple this
// guarantee to a root that bug can move.
// The backstop, if someone does it anyway: the liveness test below asserts both
// kinds are discovered AND the conductor + writeguard are reached, so a
// mis-anchored run goes RED instead of vacuously green. Verified 2026-07-25 by
// running this file from an unrelated cwd — identical results, 3/3.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// The class-A engine — declared human-only, therefore must not be auto-reachable.
// (detonate is the gate, explode the reducer; detonate imports explode, so either
// one surfacing is the violation.)
const HUMAN_ONLY = ['explode.mjs', 'detonate.mjs'];

const SKIP_DIRS = new Set(['.git', 'node_modules', 'plugin', 'work', '.claude', '.agents']);

function walkFiles(dir = repo, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walkFiles(path.join(dir, e.name), acc);
    } else acc.push(path.join(dir, e.name));
  }
  return acc;
}
const relOf = (abs) => path.relative(repo, abs).split(path.sep).join('/');

// ── (1) Does this artifact DECLARE AN INVOCATION? ───────────────────────────
// Config/manifest-shaped files only: a .md or a .mjs is not a DECLARATION of an
// entry point — it IS one, or documents one. Deliberately broad on the signal
// side: over-flagging costs one registry line, under-flagging costs the guarantee.
const CONFIG_EXT = /\.(json|ya?ml|toml)$/i;
// A DECLARATION needs a key that MEANS "run this", or an interpreter actually
// running something. A bare filename is only a MENTION — the same mention-vs-
// wiring distinction the closure walk makes below. (Measured: a filename-alone
// signal false-flagged three files that merely NAME a script — the issue-template
// component dropdown, a config comment, and a SkillSpector scan report.)
const INVOCATION_SIGNALS = [
  /^\s*(?:-\s*)?(?:run|uses|entrypoint|exec|main)\s*:/m,                        // YAML step / action / entrypoint
  /"(?:command|entrypoint|main|scripts)"\s*:/,                                  // JSON manifest keys
  /\b(?:node|npx|bash|sh|pwsh|powershell|python3?)\s+["']?[\w./${}-]+\.(?:mjs|cjs|js|sh|ps1|py)\b/, // an interpreter running a script
];
function declaresInvocation(abs) {
  if (!CONFIG_EXT.test(abs)) return false;
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { return false; }
  return INVOCATION_SIGNALS.some((re) => re.test(text));
}

// ── (2) The KINDS this test understands, each with its own root extractor ───
// To teach it a new kind, add an entry here. That is the intended maintenance
// action when the first assertion below goes red.
const scriptsIn = (text, re) => [...text.matchAll(re)].map((m) => m[1]);
const KINDS = [
  {
    name: 'hook-manifest',
    matches: (rel) => /(^|\/)hooks\.json$/.test(rel),
    roots(text) { // every `command` string, e.g. node "${CLAUDE_PLUGIN_ROOT}/hooks/x.js"
      const out = [];
      const walk = (n) => {
        if (Array.isArray(n)) return n.forEach(walk);
        if (n && typeof n === 'object') {
          if (typeof n.command === 'string') out.push(...scriptsIn(n.command, /([\w./-]+\.(?:mjs|cjs|js))/g));
          return Object.values(n).forEach(walk);
        }
      };
      try { walk(JSON.parse(text)); } catch { /* unparseable manifest → no roots (verify.mjs owns JSON validity) */ }
      return out;
    },
  },
  {
    name: 'workflow',
    matches: (rel) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(rel),
    // a runner executes these with NO human present, against an untrusted
    // checkout — the strictest auto surface the product can have.
    roots: (text) => scriptsIn(text, /\b(?:node|npx|bash|sh|pwsh|powershell|python3?)\s+["']?([\w./-]+\.(?:mjs|cjs|js|sh|ps1|py))/g),
  },
];

function classify() {
  const known = [];
  const unknown = [];
  for (const rel of walkFiles().filter(declaresInvocation).map(relOf)) {
    const kind = KINDS.find((k) => k.matches(rel));
    if (kind) known.push({ rel, kind }); else unknown.push(rel);
  }
  return { known, unknown };
}

// ── (3) Reachability: import-context literals only, transitive ──────────────
function refsOf(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const code = text.replace(/^\s*\/\/.*$/gm, ''); // a commented mention is not a wiring
  const specs = new Set();
  for (const m of code.matchAll(/\bfrom\s*['"]([^'"\n]+)['"]/g)) specs.add(m[1]);
  for (const re of [/\brequire\s*\(([^)]*)\)/g, /\bimport\s*\(([^)]*)\)/g]) {
    for (const m of code.matchAll(re)) {
      for (const lit of String(m[1]).matchAll(/['"`]([^'"`\n]+)['"`]/g)) specs.add(lit[1]);
    }
  }
  const here = path.dirname(file);
  const out = [];
  for (const spec of specs) {
    if (!spec || spec.startsWith('node:')) continue;
    for (const cand of [path.resolve(here, spec), path.join(repo, 'scripts', 'lib', spec), path.join(repo, spec)]) {
      try { if (fs.statSync(cand).isFile()) { out.push(cand); break; } } catch { /* not this candidate */ }
    }
  }
  return out;
}

function autoClosure() {
  const queue = [];
  for (const { rel, kind } of classify().known) {
    for (const s of kind.roots(fs.readFileSync(path.join(repo, rel), 'utf8'))) {
      const stripped = s.replace(/^.*?\$\{[^}]*\}\/?/, ''); // drop ${CLAUDE_PLUGIN_ROOT}/ style prefixes
      for (const cand of [path.join(repo, stripped), path.join(repo, s)]) {
        try { if (fs.statSync(cand).isFile()) { queue.push(cand); break; } } catch { /* not this candidate */ }
      }
    }
  }
  const seen = new Set();
  while (queue.length) {
    const f = queue.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const r of refsOf(f)) if (!seen.has(r)) queue.push(r);
  }
  return seen;
}

// ── the assertions ──────────────────────────────────────────────────────────

test('every invocation-declaring artifact is of a RECOGNISED kind (an unknown kind voids the guarantee — teach the test, never silence it)', () => {
  const { unknown, known } = classify();
  assert.deepStrictEqual(
    unknown, [],
    'found artifact(s) that declare an invocation but whose KIND this test does not recognise:\n' +
    `  ${unknown.join('\n  ')}\n` +
    'Each can name a script that runs with NO human present, so the no-auto guarantee below does NOT cover it.\n' +
    'FIX: add a kind to the KINDS registry in this file (a matcher + a root extractor). Do not silence this.\n' +
    `recognised kinds: ${KINDS.map((k) => k.name).join(', ')} · currently matched: ${known.map((k) => k.rel).join(', ')}`,
  );
});

test('class-A is NEVER auto-invoked: the engine is unreachable from every auto entry point of every recognised kind', () => {
  const reached = [...autoClosure()].map((f) => path.basename(f));
  const violations = HUMAN_ONLY.filter((n) => reached.includes(n));
  assert.deepStrictEqual(
    violations, [],
    `the class-A engine became reachable from an AUTO entry point: ${violations.join(', ')}.\n` +
    'class-A is a destructive reducer over the at-rest transcript estate and must never fire without a human.\n' +
    'If this is a DELIBERATE graduation it belongs on the human-invoked surface (commands/ or skills/), never a hook or a workflow.\n' +
    `auto-reachable set was: ${reached.sort().join(', ')}`,
  );
});

test('the walk is LIVE, not vacuous: both kinds are really discovered and the conductor\'s dynamic lib() import is followed', () => {
  const kinds = new Set(classify().known.map((k) => k.kind.name));
  // Without these, the assertions above could pass for the wrong reason (an empty
  // root set or a blind walk) — the exact vacuous-green trap.
  assert.ok(kinds.has('hook-manifest'), `the hook manifest must be discovered; got: ${[...kinds].join(', ')}`);
  assert.ok(kinds.has('workflow'), `the workflows must be discovered; got: ${[...kinds].join(', ')}`);
  const reached = [...autoClosure()].map((f) => path.basename(f));
  assert.ok(reached.includes('coalwash-conductor.js'), `the hook root must be reached; got: ${reached.sort().join(', ')}`);
  assert.ok(reached.includes('writeguard.mjs'), `the conductor's dynamic lib() import must be followed; got: ${reached.sort().join(', ')}`);
});
