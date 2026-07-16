// class-b.mjs — per-platform class-B discovery (READ-ONLY).
//
// Class B = every FILE the platform auto-loads into context each session
// (memory index + governance) plus the recall-loaded memory store. Layout is
// platform-SPECIFIC -> DISCOVER, never hardcode paths. Claude Code adapter
// first; an unknown platform gets the conservative path (no discovery + flag).
//
// Safety: this module only READS + stats. Every candidate path is still
// realpath-resolved and CONTAINED (home tree or project tree, physical compare
// both sides); an unresolvable or escaping path is SKIPPED + flagged
// (fail-closed — a symlink pointing outside the trees is never followed).
// Content is never transformed here, so encoding (UTF-8, Thai U+0E33, curly
// quotes) can never be corrupted by discovery.
//
// MANAGED-ARTIFACT AUTO-DECLARATION (beta.12 item 6, arm-3 finding: 8/12
// "danger-direction" flags in the run-in-background lab turned out to be
// sync-owned rule packs, not accreted prose — "update-tools syncs them;
// local trim = drift the sync manager fights", the same washability class as
// skills). Every entry gains a `managed: boolean` tag (measured, never
// hidden from BMI — measurement jurisdiction is the WHOLE parcel; wash
// jurisdiction is the washable subset only) via TWO independent, additive
// signals, both computed from what this SINGLE discovery pass already read
// (no network, no second project, no new privacy surface):
//   (1) byte-identical-across-roots: a PROJECT rules-tree file
//       (.claude/rules/**) that is byte-for-byte identical to a GLOBAL
//       rules-tree file (<claudeBase>/rules/**) at the SAME relative tail —
//       almost certainly a synced mirror, generalizable to any pack name
//       (never hardcodes "ecc" or any project-specific directory name).
//   (2) managedPaths (config, `stringList`): an explicit path-PREFIX
//       declaration (relative to the entry's own scope root, forward-slash
//       form) for a managed tree the heuristic above cannot see (e.g. no
//       global counterpart exists locally to compare against).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { claudeBaseDir } from './config-load.mjs';

const IMPORT_DEPTH_MAX = 5; // CC @import recursion cap (docs: max 5 hops)
const RULES_FILE_CAP = 500; // defensive cap on a runaway rules tree

// The conservative fallback flag for a non-Claude-Code platform. ONE source of
// truth so the estate/retier entry gates (estate-archive.mjs · retier.mjs)
// mirror discoverClassB's OWN fallback line VERBATIM — one-flock: the discovery
// gate and the estate/retier gates can never drift apart on the wording.
export const UNKNOWN_PLATFORM_FLAG = 'unknown platform: conservative — no auto-discovery; verify class-B scope manually; never auto-delete';

// ---------------------------------------------------------------------------
// path helpers
// ---------------------------------------------------------------------------

// Physical form of a path; null when it cannot be resolved (absent/looping) —
// callers treat null as fail-closed (skip the candidate).
export function physicalOrNull(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

// Is `p` (PHYSICAL) inside one of `roots` (PHYSICAL)? Equal counts as inside.
export function containedIn(p, roots) {
  if (!p) return false;
  for (const root of roots) {
    if (!root) continue;
    const rel = path.relative(root, p);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return true;
  }
  return false;
}

// Physical form of a path ABOUT TO BE CREATED (it may not exist yet, so
// realpathSync alone fails): realpath the deepest EXISTING ancestor, then
// reattach the missing tail. path.resolve collapses any `..` LEXICALLY before
// the walk, and the existing part resolves PHYSICALLY — so both a
// `..`-carrying derivation and a symlinked intermediate dir surface at their
// REAL location for a containedIn check. Write-side realpath-and-contain, the
// destination twin of physicalOrNull (loss class #57 / the git
// GHSA-2hvf-7c8p-28fx side-artifact-path mechanism). null = no existing
// ancestor at all -> fail-closed.
export function physicalForCreate(p) {
  let cur = path.resolve(p);
  const tail = []; // ponytail: local mutation, never escapes
  for (;;) {
    const phys = physicalOrNull(cur);
    if (phys) return tail.length ? path.join(phys, ...tail.reverse()) : phys;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    tail.push(path.basename(cur));
    cur = parent;
  }
}

// ---------------------------------------------------------------------------
// Claude Code adapter
// ---------------------------------------------------------------------------

// CC's per-project memory dir slug: the absolute project path with every
// non-alphanumeric char replaced by '-'. ⚠️ version-sensitive CC internal
// (verified against live ~/.claude/projects entries 2026-07-09); if the derived
// dir does not exist, discovery just contributes no memory entries — safe.
export function ccProjectSlug(projectRoot) {
  return path.resolve(projectRoot).replace(/[^A-Za-z0-9]/g, '-');
}
export function ccMemoryDir(projectRoot, home = os.homedir()) {
  return path.join(claudeBaseDir(home), 'projects', ccProjectSlug(projectRoot), 'memory');
}

export function detectPlatform(home = os.homedir()) {
  try {
    if (process.env.CLAUDE_CONFIG_DIR || fs.existsSync(claudeBaseDir(home))) return 'claude-code';
  } catch {}
  return 'unknown';
}

// Parse `@path` import lines from a CLAUDE.md-style file (CC memory imports).
// Line-start tokens only; `~/` resolves to home; relative paths resolve against
// the importing file's directory.
export function parseImports(text, fileDir, home = os.homedir()) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*@(\S+)\s*$/.exec(line);
    if (!m) continue;
    const raw = m[1];
    if (raw.startsWith('~/') || raw === '~') out.push(path.join(home, raw.slice(1)));
    else if (path.isAbsolute(raw)) out.push(raw);
    else out.push(path.resolve(fileDir, raw));
  }
  return out;
}

function statBytes(p) {
  try { const st = fs.statSync(p); return st.isFile() ? st.size : null; } catch { return null; }
}

// Discover the Claude Code class-B set for one project.
// Returns { platform, entries, flags } where each entry =
//   { path (physical), bytes, scope: 'global'|'project',
//     kind: 'governance'|'memory-index'|'memory', alwaysLoaded: bool,
//     managed: bool }
// alwaysLoaded on CC = the CLAUDE.md walk + its @imports + the memory index;
// individual memory files + non-imported rules load on demand (recall cost).
// `managed` (beta.12 item 6): true = a sync-owned artifact (byte-identical to
// a same-relative-path file under the OTHER scope's rules tree, or matching a
// configured `managedPaths` prefix) — MEASURED like anything else (BMI must
// never undercount the parcel) but never a wash candidate (same class as
// skills/commands/hooks; see SKILL.md's four washability tests).
export function discoverClassB({ projectRoot = process.cwd(), home = os.homedir(), platform, managedPaths = [] } = {}) {
  const plat = platform || detectPlatform(home);
  const flags = [];
  if (plat !== 'claude-code') {
    return {
      platform: plat,
      entries: [],
      flags: [UNKNOWN_PLATFORM_FLAG],
    };
  }

  // FAIL-CLOSED (parity with apply.mjs containment): an unresolvable root is
  // null rather than a non-physical lexical fallback — discovery is "contained
  // the same way" as the write path, as SECURITY.md claims. The project-anchored
  // walks below are skipped when projPhys is null (nothing to contain against).
  const homePhys = physicalOrNull(home);
  const projPhys = physicalOrNull(projectRoot);
  const roots = [homePhys, projPhys].filter(Boolean);
  const seen = new Set();
  const entries = [];
  // Windows paths are case-insensitive -> lowercase the dedupe key there ONLY
  // (lowercasing on POSIX would wrongly merge two case-distinct files).
  const dedupeKey = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  // rules-tree entries only, tracked separately for the byte-identical-
  // across-roots cross-check below (relTail = the path under its OWN
  // rules root, forward-slashed — the generalizable pairing key: never
  // hardcodes a pack name like "ecc", works for any synced directory).
  const rulesSeen = []; // [{ entry, relTail }]

  const add = (candidate, { scope, kind, alwaysLoaded }) => {
    const phys = physicalOrNull(candidate);
    if (!phys) return null; // fail-closed: unresolvable candidate is skipped
    if (!containedIn(phys, roots)) {
      flags.push(`skipped (outside home/project trees): ${candidate}`);
      return null;
    }
    if (seen.has(dedupeKey(phys))) return phys;
    const bytes = statBytes(phys);
    if (bytes == null) return null;
    seen.add(dedupeKey(phys));
    entries.push({ path: phys, bytes, scope, kind, alwaysLoaded, managed: false });
    return phys;
  };

  // A governance file + its @import closure (depth-capped, cycle-safe).
  const addWithImports = (file, scope) => {
    const queue = [{ file, depth: 0 }];
    while (queue.length) {
      const { file: f, depth } = queue.shift();
      const phys = add(f, { scope, kind: 'governance', alwaysLoaded: true });
      if (!phys || depth >= IMPORT_DEPTH_MAX) continue;
      let text;
      try { text = fs.readFileSync(phys, 'utf8'); } catch { continue; }
      for (const imp of parseImports(text, path.dirname(phys), home)) {
        queue.push({ file: imp, depth: depth + 1 });
      }
    }
  };

  // 1. Global governance: <claude-base>/CLAUDE.md + its import closure.
  addWithImports(path.join(claudeBaseDir(home), 'CLAUDE.md'), 'global');

  // 2. Project governance: the CLAUDE.md up-tree walk (projectRoot up to home,
  //    physical compare, never above home) + each file's import closure.
  //    Skipped when the project root did not resolve (fail-closed).
  if (projPhys) {
    let dir = projPhys;
    while (true) {
      const cl = path.join(dir, 'CLAUDE.md');
      if (fs.existsSync(cl)) addWithImports(cl, 'project');
      if (dir === homePhys) break;
      const parent = path.dirname(dir);
      if (parent === dir) break; // filesystem root
      dir = parent;
    }
  }

  // 3. Rules tree(s) (<root>/.claude/rules/**/*.md or, for the global root,
  //    <claudeBase>/rules/**/*.md): class-B governance store; loads on demand
  //    for the subtree -> alwaysLoaded false unless a file was already pulled
  //    in via an @import above (dedupe keeps the stronger entry). Walked for
  //    BOTH the project root and the global claude base — the SAME function,
  //    scope-parameterized — so the byte-identical-across-roots managed check
  //    below has a global side to compare a project file against (most
  //    installs have no global rules tree; the walk is then a harmless no-op,
  //    same as the existing "missing memory dir" pattern).
  //    Symlink/junction safety (verified empirically, G1): a Dirent from
  //    readdirSync(withFileTypes) reports a symlink/junction's OWN type
  //    (isSymbolicLink() true), never isDirectory()/isFile() — so a
  //    symlinked-outside entry here is silently SKIPPED by construction,
  //    never traversed. Anything that DOES reach add() below is still
  //    realpath-and-contained regardless (defense in depth, not the only gate).
  const walkRulesTree = (rulesRoot, scope) => {
    const stack = [rulesRoot];
    let count = 0, dirs = 0;
    // Cap BOTH the .md count AND the directory traversal (Phoenix #3): a deep/wide
    // tree with many dirs but few .md files would otherwise keep count < cap
    // forever and readdirSync the whole tree every SessionStart.
    while (stack.length && count < RULES_FILE_CAP && dirs < RULES_FILE_CAP) {
      const dir = stack.pop();
      dirs++;
      let names;
      try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const d of names) {
        const p = path.join(dir, d.name);
        if (d.isDirectory()) stack.push(p);
        else if (d.isFile() && d.name.endsWith('.md')) {
          const phys = add(p, { scope, kind: 'governance', alwaysLoaded: false });
          count++;
          if (phys) {
            const entry = entries.find((e) => e.path === phys);
            if (entry) rulesSeen.push({ entry, relTail: path.relative(rulesRoot, phys).split(path.sep).join('/') });
          }
        }
      }
    }
    if (count >= RULES_FILE_CAP || dirs >= RULES_FILE_CAP) flags.push(`rules tree capped (${count} files / ${dirs} dirs at cap ${RULES_FILE_CAP}, scope ${scope})`);
  };
  if (projPhys) walkRulesTree(path.join(projPhys, '.claude', 'rules'), 'project');
  if (homePhys) walkRulesTree(path.join(claudeBaseDir(home), 'rules'), 'global');

  // 4. Memory store: ~/.claude/projects/<slug>/memory/ — MEMORY.md is the
  //    always-loaded index; sibling *.md files load on recall.
  {
    const memDir = ccMemoryDir(projectRoot, home);
    let names = [];
    try { names = fs.readdirSync(memDir); } catch { /* no memory dir yet — fine */ }
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const isIndex = name === 'MEMORY.md';
      add(path.join(memDir, name), {
        scope: 'project',
        kind: isIndex ? 'memory-index' : 'memory',
        alwaysLoaded: isIndex,
      });
    }
  }

  // ---------------------------------------------------------------------
  // MANAGED-ARTIFACT AUTO-DECLARATION (beta.12 item 6) — runs once, after
  // every entry is known, over what THIS single pass already read (no extra
  // fs walk, no network, no second project).
  // ---------------------------------------------------------------------

  // Signal (1): byte-identical-across-roots. Group rules-tree entries by
  // relTail; wherever the SAME relative path exists under BOTH the project
  // and the global rules root, compare content (cheap byte-length check
  // first — a length mismatch can never be identical, avoids a wasted read).
  // Both sides of an identical pair are tagged: the pairing itself, not which
  // side is "the source", is what proves a sync relationship exists.
  {
    const byTail = new Map();
    for (const r of rulesSeen) {
      const bucket = byTail.get(r.relTail) || [];
      bucket.push(r);
      byTail.set(r.relTail, bucket);
    }
    for (const bucket of byTail.values()) {
      const proj = bucket.filter((r) => r.entry.scope === 'project');
      const glob = bucket.filter((r) => r.entry.scope === 'global');
      for (const p of proj) {
        for (const g of glob) {
          if (p.entry.bytes !== g.entry.bytes) continue; // cheap pre-check
          let same = false;
          try { same = Buffer.compare(fs.readFileSync(p.entry.path), fs.readFileSync(g.entry.path)) === 0; } catch { same = false; }
          if (same) { p.entry.managed = true; g.entry.managed = true; }
        }
      }
    }
  }

  // Signal (2): managedPaths (config) — an explicit prefix declaration,
  // relative to the entry's OWN scope root, forward-slash form. Silently
  // ignores a non-array/malformed input (config-schema.mjs already clamps
  // this at the read site; this is defense in depth, never a throw).
  if (Array.isArray(managedPaths) && managedPaths.length) {
    const prefixes = managedPaths.filter((s) => typeof s === 'string' && s).map((s) => s.split(path.sep).join('/'));
    if (prefixes.length) {
      for (const e of entries) {
        if (e.managed) continue; // already tagged by signal (1)
        const scopeRoot = e.scope === 'global' ? homePhys : projPhys;
        if (!scopeRoot) continue;
        const rel = path.relative(scopeRoot, e.path).split(path.sep).join('/');
        if (prefixes.some((pfx) => rel === pfx || rel.startsWith(pfx.endsWith('/') ? pfx : pfx + '/'))) e.managed = true;
      }
    }
  }

  return { platform: plat, entries, flags };
}
