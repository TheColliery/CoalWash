// classa-no-auto.test.mjs — pins the standing property: THE CLASS-A ENGINE IS
// NEVER AUTO-INVOKED.
//
// WHY A TEST AND NOT A CLAIM (USER 2026-07-25): class-A operates on the at-rest
// transcript estate — the accumulated past — and is a destructive reducer. Being
// un-wired today is not the same as being PINNED un-wired. A future conductor
// edit could reach it in one line (`await import(lib('explode.mjs'))`) and
// nothing in the suite would notice. This file is the something that notices.
//
// THE PROPERTY IS INVERTED, NOT AN ENUMERATION. It deliberately does NOT keep a
// denylist of "places that must not mention explode" — such a list is stale the
// moment a new surface exists. Instead:
//   * the AUTO surface is DERIVED from hooks/hooks.json — the only surface that
//     fires with NO human in the loop (SessionStart / Stop / PreToolUse /
//     PostToolUse). Add a new hook script tomorrow and it becomes a root here
//     automatically, because the roots are read from the manifest, not typed in.
//   * everything that surface can REACH is computed transitively.
//   * class-A is declared HUMAN_ONLY and asserted ABSENT from that reachable set.
// So the default posture is "an entry point is human-required"; being reachable
// from a hook is the thing that must never silently happen.
//
// THE EXPLICIT UPGRADE is the human-invoked surface (`commands/`, `skills/`) — a
// user typing the command or invoking the SKILL. That is NOT asserted against,
// on purpose: wiring class-A into the SKILL is the PLANNED graduation step (the
// same moment the `UNWIRED_ENGINE` dist exclusion in build-plugin.mjs is
// deleted). Wiring it into a HOOK is never planned. This test draws the line
// exactly there, so the planned step stays possible and the silent one goes red.
//
// ponytail: the reachability walk is a STATIC text scan (import/require
// specifiers + every `*.mjs`/`*.js` string literal), not a real module graph.
// The literal sweep is what catches this codebase's actual dynamic idiom —
// hooks/coalwash-conductor.js:93 builds `lib('writeguard.mjs')` and dynamically
// imports it, so a static-import-only walk would see nothing. Ceiling: a
// genuinely computed specifier (`lib('explo' + 'de.mjs')`) evades it. That is
// accepted — this pins against ACCIDENT and silent drift, which is the stated
// threat; it is not an adversarial sandbox, and a developer determined to route
// around a named safety test is out of scope. UPGRADE PATH if that ever matters:
// walk the real graph by importing each root under a loader hook and recording
// resolved specifiers.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// The class-A engine — declared human-only. Not upgraded, so it must not be
// reachable from any auto root. (detonate is the gate, explode the reducer;
// detonate imports explode, so either one appearing is the violation.)
const HUMAN_ONLY = ['explode.mjs', 'detonate.mjs'];

// AUTO ROOTS, derived: every script named by a command in hooks/hooks.json.
// Read from the manifest so a NEW hook script is covered without editing this test.
function autoRoots() {
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'hooks', 'hooks.json'), 'utf8'));
  const commands = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') {
      if (typeof node.command === 'string') commands.push(node.command);
      return Object.values(node).forEach(walk);
    }
  };
  walk(manifest.hooks);
  const roots = new Set();
  for (const cmd of commands) {
    // a command looks like: node "${CLAUDE_PLUGIN_ROOT}/hooks/coalwash-conductor.js"
    for (const m of cmd.matchAll(/[\w./-]+\.(?:mjs|js|cjs)/g)) {
      const rel = m[0].replace(/^.*?(hooks|scripts)\//, '$1/');
      const abs = path.join(repo, rel);
      if (fs.existsSync(abs)) roots.add(abs);
    }
  }
  return [...roots];
}

// Every repo-local module `file` can reach: static import/require specifiers PLUS
// any bare `*.mjs`/`*.js` string literal (the `lib('x.mjs')` dynamic idiom).
function refsOf(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  // strip line comments so a MENTION in prose is not mistaken for a wiring
  const code = text.replace(/^\s*\/\/.*$/gm, '');
  const out = new Set();
  for (const m of code.matchAll(/['"`]([^'"`\n]+?\.(?:mjs|js|cjs))['"`]/g)) out.add(m[1]);
  const here = path.dirname(file);
  const resolved = [];
  for (const spec of out) {
    if (spec.startsWith('node:')) continue;
    for (const cand of [path.resolve(here, spec), path.join(repo, 'scripts', 'lib', spec), path.join(repo, spec)]) {
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) { resolved.push(cand); break; }
    }
  }
  return resolved;
}

function autoClosure() {
  const seen = new Set();
  const queue = autoRoots();
  assert.ok(queue.length > 0, 'derived at least one auto root from hooks/hooks.json (a zero-root walk would pass vacuously)');
  while (queue.length) {
    const f = queue.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const r of refsOf(f)) if (!seen.has(r)) queue.push(r);
  }
  return seen;
}

test('class-A is NEVER auto-invoked: the engine is unreachable from every hook-declared entry point', () => {
  const closure = autoClosure();
  const reached = [...closure].map((f) => path.basename(f));
  const violations = HUMAN_ONLY.filter((n) => reached.includes(n));
  assert.deepStrictEqual(
    violations, [],
    `the class-A engine became reachable from an AUTO (hook) entry point: ${violations.join(', ')}.\n` +
    'class-A is a destructive reducer over the at-rest transcript estate and must never fire without a human.\n' +
    'If this is a DELIBERATE graduation, it belongs on the human-invoked surface (commands/ or skills/), not a hook.\n' +
    `auto-reachable set was: ${reached.sort().join(', ')}`,
  );
});

test('the walk is LIVE, not vacuous: it really does reach the conductor and the libs the conductor imports', () => {
  const reached = [...autoClosure()].map((f) => path.basename(f));
  // Sentinel: if the closure ever stops reaching these, the test above would pass
  // for the wrong reason (an empty/blind walk), so pin the walk's own liveness.
  assert.ok(reached.includes('coalwash-conductor.js'), `the hook root itself must be in the closure; got: ${reached.sort().join(', ')}`);
  assert.ok(reached.includes('writeguard.mjs'), `the conductor's dynamic lib() import must be followed; got: ${reached.sort().join(', ')}`);
});
