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
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { claudeBaseDir } from './config-load.mjs';

const IMPORT_DEPTH_MAX = 5; // CC @import recursion cap (docs: max 5 hops)
const RULES_FILE_CAP = 500; // defensive cap on a runaway rules tree

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
//     kind: 'governance'|'memory-index'|'memory', alwaysLoaded: bool }
// alwaysLoaded on CC = the CLAUDE.md walk + its @imports + the memory index;
// individual memory files + non-imported rules load on demand (recall cost).
export function discoverClassB({ projectRoot = process.cwd(), home = os.homedir(), platform } = {}) {
  const plat = platform || detectPlatform(home);
  const flags = [];
  if (plat !== 'claude-code') {
    return {
      platform: plat,
      entries: [],
      flags: ['unknown platform: conservative — no auto-discovery; verify class-B scope manually; never auto-delete'],
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
    entries.push({ path: phys, bytes, scope, kind, alwaysLoaded });
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

  // 3. Project rules tree (.claude/rules/**/*.md): class-B governance store;
  //    loads on demand for the subtree -> alwaysLoaded false unless a file was
  //    already pulled in via an @import above (dedupe keeps the stronger entry).
  if (projPhys) {
    const rulesRoot = path.join(projPhys, '.claude', 'rules');
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
        else if (d.isFile() && d.name.endsWith('.md')) { add(p, { scope: 'project', kind: 'governance', alwaysLoaded: false }); count++; }
      }
    }
    if (count >= RULES_FILE_CAP || dirs >= RULES_FILE_CAP) flags.push(`rules tree capped (${count} files / ${dirs} dirs at cap ${RULES_FILE_CAP})`);
  }

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

  return { platform: plat, entries, flags };
}
