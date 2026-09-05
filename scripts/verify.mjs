#!/usr/bin/env node
// CoalWash verify gate — fail LOUD if the factory config drifts from the
// schema, required files are missing/malformed, a lib fails to import, or the
// plugin/ dist is stale. Wrapped per-check so one bad input yields a clean
// FAIL line, not a stack trace (scripts-quality.md: CLI = fail loud).

// NODE BUILTINS ONLY at the top level — every scripts/lib/ import in this file
// is DYNAMIC, inside the check that uses it. A static `from './lib/x.mjs'`
// resolves during module-graph load, BEFORE the first try/catch exists, so an
// absent lib kills the gate with a raw ERR_MODULE_NOT_FOUND and zero FAIL
// lines — and a gate that dies is indistinguishable from a gate never run.
// Real: a sparse caretaker bench (scripts/lib/ minus config-schema.mjs)
// reported nothing at all. Pinned by scripts/verify.test.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { console.log(`  FAIL ${m}`); fails++; };

const LIBS = [
  'class-b.mjs', 'caliper.mjs', 'fidelity-gate.mjs', 'apply.mjs', 'keeps.mjs', 'receipt.mjs',
  'retention.mjs', 'cli.mjs', 'ask.mjs', 'tailings.mjs', 'broom.mjs', 'wizard.mjs', 'parcel.mjs', 'writeguard.mjs',
  'anchor-diff.mjs', 'estate.mjs', 'estate-archive.mjs', 'retier.mjs', 'dig-gauge.mjs',
  'config-schema.mjs', 'config-load.mjs', 'jsonc.mjs',
];

// LIBS is hand-listed, so it silently rots: a new lib nobody adds here is never
// import-checked. Same BOTH-DIRECTION drift check test.mjs runs on its suite
// roster — listed-but-missing is caught by the file loop below, this catches
// on-disk-but-unlisted. Tests + the deliberately-unshipped class-A engine are
// gated by the suite and build-plugin respectively, not here.
const UNLISTED_OK = new Set(['explode.mjs', 'detonate.mjs']);
console.log('lib roster drift:');
try {
  const onDisk = fs.readdirSync(path.join(repo, 'scripts', 'lib'))
    // A dot-prefixed name is this repo's own established convention for a
    // non-product per-pid temp fixture (`.cw-reqfold-probe-*`,
    // `.cw-reexport-hop-*`) — root-provenance.test.mjs excludes the same class
    // from its own walk for the same reason. Without this, a run of
    // config-load.test.mjs (which creates and finally-removes such a fixture
    // beside its target) races a concurrent verify.mjs and reddens the gate on
    // a file the codebase treats as transient. Measured: intermittent
    // `FAIL 1 lib(s) on disk but NOT in verify.mjs LIBS — .cw-reexport-hop-<pid>.mjs`.
    .filter((f) => f.endsWith('.mjs') && !f.startsWith('.') && !f.endsWith('.test.mjs') && !UNLISTED_OK.has(f));
  const unlisted = onDisk.filter((f) => !LIBS.includes(f));
  if (unlisted.length) fail(`${unlisted.length} lib(s) on disk but NOT in verify.mjs LIBS — ${unlisted.join(', ')}`);
  else ok(`every scripts/lib/*.mjs is on the LIBS roster (${onDisk.length} checked)`);
} catch (e) { fail(`lib roster drift: ${e.message}`); }

console.log('files:');
for (const [label, p] of [
  ['hooks/coalwash-conductor.js', path.join(repo, 'hooks', 'coalwash-conductor.js')],
  ['hooks/hooks.json', path.join(repo, 'hooks', 'hooks.json')],
  ['.claude-plugin/plugin.json', path.join(repo, '.claude-plugin', 'plugin.json')],
  ['.claude-plugin/marketplace.json', path.join(repo, '.claude-plugin', 'marketplace.json')],
  ['platform-configs/.coalwash.json', path.join(repo, 'platform-configs', '.coalwash.json')],
  ['skills/coalwash/SKILL.md', path.join(repo, 'skills', 'coalwash', 'SKILL.md')],
  ['skills/coalwash/references/method.md', path.join(repo, 'skills', 'coalwash', 'references', 'method.md')],
  ['skills/coalwash/references/platform-cc.md', path.join(repo, 'skills', 'coalwash', 'references', 'platform-cc.md')],
  ['commands/stats.md', path.join(repo, 'commands', 'stats.md')],
  ['commands/update.md', path.join(repo, 'commands', 'update.md')],
  ['LICENSE', path.join(repo, 'LICENSE')],
  ['NOTICE', path.join(repo, 'NOTICE')],
  ...LIBS.map((l) => [`scripts/lib/${l}`, path.join(repo, 'scripts', 'lib', l)]),
]) { try { fs.existsSync(p) ? ok(label) : fail(`${label} missing`); } catch (e) { fail(`${label}: ${e.message}`); } }

console.log('skill frontmatter:');
try {
  const skill = fs.readFileSync(path.join(repo, 'skills', 'coalwash', 'SKILL.md'), 'utf8');
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skill);
  if (!fm) fail('SKILL.md has no frontmatter block');
  else if (/^name:\s*coalwash\s*$/m.test(fm[1])) ok("SKILL.md frontmatter name = 'coalwash'");
  else fail('SKILL.md frontmatter name is not coalwash');
} catch (e) { fail(`skill frontmatter: ${e.message}`); }

console.log('description length cap (skills + commands):');
// Skill-listing description cap: gate at 1024 = cross-platform-safe (agentskills.io / agnix);
// CC's own listing truncation is 1536 chars combined description+when_to_use
// (code.claude.com/docs/en/skills, verified 2026-07-16). USER standard 2026-07-16: never exceed.
const DESC_CAP = 1024;
function frontmatterField(text, key) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const lines = m[1].split(/\r?\n/);
  const i = lines.findIndex((l) => l.startsWith(key + ':'));
  if (i === -1) return null;
  let v = lines[i].slice(key.length + 1).trim();
  if (/^[>|][-+]?$/.test(v)) {
    const parts = [];
    for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) parts.push(lines[j].trim());
    return parts.join(' ');
  }
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  return v;
}
// Dynamic scan (skills/*/SKILL.md for any dir that has one, commands/*.md) so a
// new skill/command is covered without editing this gate.
const descTargets = [];
try {
  const skillsDir = path.join(repo, 'skills');
  if (fs.existsSync(skillsDir)) {
    for (const d of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const smd = path.join(skillsDir, d.name, 'SKILL.md');
      if (fs.existsSync(smd)) descTargets.push([`skills/${d.name}/SKILL.md`, smd, true]);
    }
  }
  const commandsDir = path.join(repo, 'commands');
  if (fs.existsSync(commandsDir)) {
    for (const f of fs.readdirSync(commandsDir)) {
      if (f.endsWith('.md')) descTargets.push([`commands/${f}`, path.join(commandsDir, f), false]);
    }
  }
} catch (e) { fail(`description target scan: ${e.message}`); }
for (const [label, p, isSkill] of descTargets) {
  try {
    const text = fs.readFileSync(p, 'utf8');
    const len = (frontmatterField(text, 'description') || '').length + (frontmatterField(text, 'when_to_use') || '').length;
    if (isSkill && len === 0) fail(`${label}: frontmatter description missing/unparsed`);
    else if (len > DESC_CAP) fail(`${label}: description+when_to_use ${len} chars exceeds the ${DESC_CAP}-char cap`);
    else ok(`${label}: ${len} chars (cap ${DESC_CAP})`);
  } catch (e) { fail(`${label} description check: ${e.message}`); }
}

// board #64: DESC_CAP above only walked skill/command FRONTMATTER — the
// plugin's OWN description field in .claude-plugin/plugin.json (plain JSON,
// not YAML frontmatter) was never checked against the same cap at all.
// Non-string-but-truthy (123, {}, ['a']) must FAIL LOUD, not silently read as
// 0 chars and pass — that's the exact hole the exemplar's first draft had.
console.log('plugin.json description cap:');
try {
  let pjText = fs.readFileSync(path.join(repo, '.claude-plugin', 'plugin.json'), 'utf8');
  if (pjText.charCodeAt(0) === 0xFEFF) pjText = pjText.slice(1);
  const pj = JSON.parse(pjText);
  if (typeof pj.description !== 'string') fail(`.claude-plugin/plugin.json: description is not a string (${pj.description === undefined ? 'missing' : typeof pj.description})`);
  else if (pj.description.length === 0) fail('.claude-plugin/plugin.json: description missing');
  else if (pj.description.length > DESC_CAP) fail(`.claude-plugin/plugin.json: description ${pj.description.length} chars exceeds the ${DESC_CAP}-char cap`);
  else ok(`.claude-plugin/plugin.json: ${pj.description.length} chars (cap ${DESC_CAP})`);
} catch (e) { fail(`.claude-plugin/plugin.json description check: ${e.message}`); }

console.log('version pins (.github issue templates):');
try {
  const pj = JSON.parse(fs.readFileSync(path.join(repo, '.claude-plugin', 'plugin.json'), 'utf8'));
  const tplDir = path.join(repo, '.github', 'ISSUE_TEMPLATE');
  let pins = 0;
  for (const name of fs.readdirSync(tplDir)) {
    const text = fs.readFileSync(path.join(tplDir, name), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes('version-pin:')) continue;
      pins++;
      if (line.includes(`v${pj.version}`)) ok(`${name} version-pin quotes v${pj.version}`);
      else fail(`${name} version-pin line does not quote current v${pj.version}`);
    }
  }
  if (!pins) fail('no version-pin marker found in .github/ISSUE_TEMPLATE (expected in bug-report.yml)');
} catch (e) { fail(`version pins: ${e.message}`); }

console.log('plugin manifest:');
try {
  const pj = JSON.parse(fs.readFileSync(path.join(repo, '.claude-plugin', 'plugin.json'), 'utf8'));
  if (pj.name === 'coalwash') ok("plugin.json name = 'coalwash'"); else fail(`plugin.json name = '${pj.name}' (want 'coalwash')`);
  if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(pj.version || '')) ok(`plugin.json version '${pj.version}' is semver (pre-release accepted)`);
  else fail(`plugin.json version '${pj.version}' not semver`);
  if (pj.license === 'Apache-2.0') ok('plugin.json license = Apache-2.0'); else fail(`plugin.json license = '${pj.license}' (series license is Apache-2.0)`);
  const hj = fs.readFileSync(path.join(repo, 'hooks', 'hooks.json'), 'utf8');
  if (hj.includes('${CLAUDE_PLUGIN_ROOT}/hooks/coalwash-conductor.js')) ok('hooks.json wires SessionStart via ${CLAUDE_PLUGIN_ROOT}/hooks');
  else fail('hooks.json does not wire SessionStart under ${CLAUDE_PLUGIN_ROOT}/bin');
} catch (e) { fail(`plugin manifest: ${e.message}`); }

console.log('marketplace.json:');
try {
  const mj = JSON.parse(fs.readFileSync(path.join(repo, '.claude-plugin', 'marketplace.json'), 'utf8'));
  if (mj.plugins?.[0]?.source === './plugin') ok('marketplace.json points at ./plugin');
  else fail(`marketplace.json plugins[0].source = '${mj.plugins?.[0]?.source}' (want './plugin')`);
  if (mj.plugins?.[0]?.version === undefined) ok('marketplace entry carries no version (plugin.json is the SSoT)');
  else fail('marketplace entry sets a version — remove it (plugin.json is the only version home)');
} catch (e) { fail(`marketplace.json: ${e.message}`); }

console.log('config (factory vs schema):');
try {
  // NOT the conductor's `lib()` — that one returns a URL STRING consumed by a
  // textual `import(lib(...))`, which classa-no-auto's literal harvest can see.
  // This helper PERFORMS the import, so `await lib('x')` has no textual
  // `import(` and is INVISIBLE to that scanner — tolerable only because
  // verify.mjs is outside the scan's auto closure. Never copy it into hooks/.
  const lib = (l) => import(pathToFileURL(path.join(repo, 'scripts', 'lib', l)).href);
  const { CONFIG_SCHEMA, validateConfig } = await lib('config-schema.mjs');
  const { stripJsonc } = await lib('jsonc.mjs');
  let c = fs.readFileSync(path.join(repo, 'platform-configs', '.coalwash.json'), 'utf8');
  if (c.charCodeAt(0) === 0xFEFF) c = c.slice(1);
  const cfg = JSON.parse(stripJsonc(c));
  const errors = validateConfig(cfg);
  if (!errors.length) ok('factory .coalwash.json valid against schema');
  else errors.forEach(fail);
  // Layer 3: the factory template carries EVERY key at its default.
  for (const spec of CONFIG_SCHEMA) {
    if (!(spec.key in cfg)) fail(`factory template missing key '${spec.key}'`);
    else if (JSON.stringify(cfg[spec.key]) !== JSON.stringify(spec.def)) fail(`factory '${spec.key}' = ${JSON.stringify(cfg[spec.key])} but schema default is ${JSON.stringify(spec.def)}`);
  }
  if (CONFIG_SCHEMA.every((s) => s.key in cfg && JSON.stringify(cfg[s.key]) === JSON.stringify(s.def))) ok('factory template carries every schema key at its default');
} catch (e) { fail(`factory config: ${e.message}`); }

console.log('config keys (ship-text vs schema):');
try {
  const lib = (l) => import(pathToFileURL(path.join(repo, 'scripts', 'lib', l)).href);
  const { CONFIG_SCHEMA, RETIRED_KEYS } = await lib('config-schema.mjs');
  const { checkConfigKeys } = await import(pathToFileURL(path.join(repo, 'scripts', 'config-keys.mjs')).href);
  // Surfaces are NAMED, never existsSync-filtered: a file that vanished must be
  // REPORTED as unreadable, not silently dropped into a smaller clean scan.
  const refsDir = path.join(repo, 'skills', 'coalwash', 'references');
  const cmdDir = path.join(repo, 'commands');
  const mdFiles = [
    'README.md', 'SECURITY.md', 'PRIVACY.md', 'CONTRIBUTING.md', 'INPUT-CONTRACT.md',
    path.join('skills', 'coalwash', 'SKILL.md'),
    ...fs.readdirSync(refsDir).filter((n) => n.endsWith('.md')).map((n) => path.join('skills', 'coalwash', 'references', n)),
    ...fs.readdirSync(cmdDir).filter((n) => n.endsWith('.md')).map((n) => path.join('commands', n)),
  ];
  const hookFiles = [path.join('hooks', 'coalwash-conductor.js')];
  // The Stop channel's `reason` text is built here, not in the conductor.
  const builderFiles = [path.join('scripts', 'lib', 'ask.mjs')];
  const r = checkConfigKeys({
    schema: CONFIG_SCHEMA,
    retiredKeys: RETIRED_KEYS,
    mdFiles, hookFiles, builderFiles,
    read: (p) => fs.readFileSync(path.join(repo, p), 'utf8'),
  });
  for (const x of r.findings) { if (x.level === 'FAIL') fail(x.msg); }
  const skips = r.findings.filter((x) => x.level === 'SKIP');
  const hard = r.findings.filter((x) => x.level !== 'SKIP');
  const n = r.coverage.notice;
  // PRINT what the scan covered. A locator that matches nothing reports clean.
  const b = r.coverage.builder;
  ok(`L4 notice locator: ${n.lines} out.push( site(s) / ${n.total} lines, ${n.chars} chars across ${hookFiles.length} hook file(s)`);
  ok(`L5 builder locator: ${b.literals} string literal(s) across ${b.files} notice-builder file(s)`);
  if (!hard.length) {
    const q = r.coverage.blind ? 'every DETECTABLE config key' : 'every config key';
    ok(`${q} named in ${r.scanned} ship-text surface(s) resolves (${r.coverage.resolved} of ${r.coverage.candidates} candidates real, ${r.coverage.retiredSeen.length} retired-by-name: ${r.coverage.retiredSeen.join(', ') || 'none'}, ${skips.length} declared blind)`);
  }
} catch (e) { fail(`config keys: ${e.message}`); }

// POINTERS (CWK-075). Ship-text naming something unreachable from a clone. Sibling of
// the config-key gate above: same family, different resolver -- that one resolves KEYS
// against the schema, this one asks whether the thing a path NAMES is reachable.
//
// SURFACES: the 9 shipped ship-text files (walked, never existsSync-filtered -- an
// unreadable surface is REPORTED, never silently dropped into a smaller clean scan).
// Source comments, CHANGELOG.md and the plugin/ mirror are deliberately NOT walked,
// each with its measured reason in scripts/pointer-check.mjs.
console.log('pointers (ship-text vs the tree):');
try {
  const lsAll = spawnSync('git', ['ls-files'], { cwd: repo, encoding: 'utf8' });
  if (lsAll.error || lsAll.status !== 0) {
    // A VISIBLE skip, never a silent carve-out: no git means no durability answer.
    console.log('  --   pointer check: git unavailable — cannot tell a tracked path from an untracked one; skipped');
  } else {
    const { checkPointers } = await import(pathToFileURL(path.join(repo, 'scripts', 'pointer-check.mjs')).href);
    const { projectConfigCandidates } = await import(pathToFileURL(path.join(repo, 'scripts', 'lib', 'config-load.mjs')).href);
    const tracked = new Set(lsAll.stdout.split('\n').filter(Boolean));
    const trackedDirs = new Set();
    for (const f of tracked) {
      const parts = f.split('/');
      for (let i = 1; i < parts.length; i++) trackedDirs.add(parts.slice(0, i).join('/'));
    }

    // AGENT INSTALL HOMES, DERIVED from the tool's own candidate map rather than
    // enumerated, so the set cannot rot the day that order changes.
    const agentHomes = new Set();
    for (const c of projectConfigCandidates(repo, os.homedir())) {
      const r = path.relative(repo, c).split(path.sep).join('/');
      if (!r || r.startsWith('..') || path.isAbsolute(r) || !r.includes('/')) continue;
      const first = r.split('/')[0];
      if (first.startsWith('.') && first.length > 1) agentHomes.add(first);
    }

    // THE FULL TOP-LEVEL ENUMERATION, INCLUDING FILES AND HIDDEN ENTRIES. This is the
    // hazard the adoption brief singled out for THIS room and it is not hypothetical:
    // a dirs-only, non-hidden enumeration (the exemplar's shape) misses every one of
    // our top-level gitignored FILES -- CLAUDE.md, MEMORY.md, AGENTS.md,
    // COALWASH_BLUEPRINT.md, ASSEMBLY-LINE.md, LAB-ARCHIVE.md, SENIOR-INCIDENT-AUDIT.md
    // -- and both gitignored dot-dirs. A citation into one would then fall out of scope
    // SILENTLY rather than FAILing, which is the quieter and worse symptom.
    const topAll = fs.readdirSync(repo, { withFileTypes: true }).map((e) => e.name).filter((n) => n !== '.git');
    const ourRoots = new Set();
    for (const f of tracked) ourRoots.add(f.split('/')[0]);
    for (const n of topAll) ourRoots.add(n);

    // IGNORED ROOTS: asked of git, never parsed out of .gitignore. Agent homes are
    // excluded BEFORE the question is asked -- .claude/ and .agents/ are gitignored
    // here AND are the user-tree paths our shipped prose names, so leaving them in
    // would FAIL a correct citation.
    const ignoredRoots = new Set();
    for (const name of topAll) {
      if (tracked.has(name) || trackedDirs.has(name) || agentHomes.has(name)) continue;
      const ci = spawnSync('git', ['check-ignore', '-q', '--', name], { cwd: repo, encoding: 'utf8' });
      if (!ci.error && ci.status === 0) ignoredRoots.add(name);
    }

    const rel = (p) => path.relative(repo, p).split(path.sep).join('/');
    const walkMd = (dir, out = []) => {
      if (!fs.existsSync(dir)) return out;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walkMd(p, out);
        else if (e.name.endsWith('.md')) out.push(p);
      }
      return out;
    };
    const readOrNull = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
    const surfaces = [];
    for (const f of [...walkMd(path.join(repo, 'skills')), ...walkMd(path.join(repo, 'commands'))]) {
      surfaces.push({ label: rel(f), text: readOrNull(f) });
    }
    for (const d of ['README.md', 'SECURITY.md', 'CONTRIBUTING.md', 'PRIVACY.md']) {
      surfaces.push({ label: d, text: readOrNull(path.join(repo, d)) });
    }

    const findings = checkPointers({
      surfaces,
      ourRoots,
      ignoredRoots,
      agentHomes,
      // Structural, never circular: does the token's FIRST SEGMENT exist beside the
      // citing file? That is what puts `references/method.md` in scope from its own
      // skill dir, where a repo-root-anchored rule skips it in silence.
      hasEntry: (relDir, name) => {
        try { return fs.existsSync(path.join(repo, relDir, name)); } catch { return false; }
      },
      resolve: (p) => (tracked.has(p) || trackedDirs.has(p) ? 'tracked'
        : fs.existsSync(path.join(repo, p)) ? 'untracked' : 'missing'),
    });
    // PRINT the derived enumeration. A set that comes back wrong (or empty) is the
    // failure mode this room was warned about, and it is invisible unless it is shown.
    ok(`top-level entries fed to git check-ignore: ${topAll.length} (files + hidden included) — ${ignoredRoots.size} gitignored, ${agentHomes.size} agent home(s): ${[...agentHomes].sort().join(' ')}`);
    const hard = findings.filter((f) => f.level !== 'SKIP');
    if (!hard.length) {
      ok(`every path this repo points at from ${surfaces.length} ship-text surface(s) (${findings.checked} in-scope citations) resolves to a TRACKED file — sections and symbols are NOT checked, see scripts/pointer-check.mjs`);
    }
    for (const f of findings) {
      if (f.level === 'SKIP') console.log('  --   ' + f.msg);
      else fail(f.msg);
    }
  }
} catch (e) { fail(`pointer check: ${e.message}`); }

console.log('libs (import check):');
for (const l of LIBS) {
  try { await import(pathToFileURL(path.join(repo, 'scripts', 'lib', l)).href); ok(`${l} imports`); }
  catch (e) { fail(`${l}: ${e.message}`); }
}

console.log('plugin/ dist (the clean CC plugin vs source SSoT):');
try {
  const { checkDist } = await import(pathToFileURL(path.join(repo, 'scripts', 'build-plugin.mjs')).href);
  const drift = checkDist();
  if (!drift.length) ok('plugin/ matches source (manifest + bin + commands + hooks + skills + scripts/lib); nothing else leaked');
  else for (const d of drift) fail(d);
} catch (e) { fail(`plugin/ dist check: ${e.message}`); }

console.log(fails ? `\nVERIFY: FAIL (${fails})` : '\nVERIFY: PASS');
process.exit(fails ? 1 : 0);
