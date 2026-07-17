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

// #57(d) CLOUD-PLACEHOLDER READ POISON (MASTER-LOSS-TAXONOMY.md #57 4th member):
// a OneDrive Files-On-Demand / iCloud-optimized placeholder returns SHORT/stub
// bytes on a plain read() with NO throw and the SAME wrong bytes on every
// re-read — so the R1 external-writer guard (which proves a file did not CHANGE
// between two reads) is structurally BLIND (zero drift = self-consistent
// nonsense), and a copy-verify-then-delete or a prose rewrite trusts the stub:
// the WARM gzip round-trip matches (both sides the same stub) and deletes the
// real original, or a rewrite writes a truncated body that clobbers the
// not-yet-hydrated content when it syncs UP. Sniff the dehydrated signal from
// METADATA ONLY (never a content read — the read is exactly what a placeholder
// poisons): a REGULAR file whose logical size > 0 but which has ZERO
// physically-allocated blocks (`blocks === 0`) is not hydrated (macOS iCloud /
// Linux network-mount placeholders).
//
// ⚠ PLATFORM CALIBRATION — win32 is a NAMED RESIDUAL, detected via the reparse
// attribute, NOT via blocks (rationale corrected 2026-07-16 from field data, #8).
// The earlier note claimed Node reports `blocks === 0` for EVERY win32 file — that
// premise is DISPROVEN: on current libuv `blocks` is LIVE on win32, allocation-
// proportional (8192 B -> 16, 1 MiB -> 2048), `blocks === 0` only for the sub-512 B
// MFT-resident class (measured on two NTFS boxes, Node v24.11/24.17, #8; the old
// "always 0" was version drift from old libuv docs). The blocks sniff STILL stays a
// NO-OP on win32, now for the correct FIDELITY-FIRST reason: a legitimate NTFS
// SPARSE file shares the exact `size>0 / blocks===0` fingerprint of a dehydrated
// stub, and the signal that actually distinguishes them — the reparse attribute
// FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS — is NOT exposed by Node's `fs`. #8's live-
// fire proved the predicate only against a SYNTHETIC `fsutil sparse` file, never a
// REAL OneDrive/iCloud reparse stub (that cell stays unmeasured) — so a blocks-only
// sniff here would over-refuse real sparse files while being unproven against real
// stubs. The real fix is a native/PowerShell reparse-attribute read swapped in at
// the two injectable call sites (estate archiveSession `isPlaceholder`, applyPlan
// `opts.isPlaceholder`); until then win32 returns false and the R1 external-writer
// guard + copy-verify byte-compare remain the nets. The signal is CORRECT on POSIX
// where blocks is real.
//
// POSITIVE-SIGNAL ONLY (fail toward NORMAL, never flag-everything): an
// unreadable stat, an absent/NaN `blocks`, a non-file, or win32 = NOT flagged —
// the guard fires ONLY on a PROVEN stub, so a caller skips+reports rather than
// archives/rewrites it. `statSync`/`platform` are injectable — a real
// placeholder cannot be created inside a hermetic sandbox, so tests feed a
// synthetic stat + the platform they want to exercise.
export function isCloudPlaceholder(p, { statSync = fs.lstatSync, platform = process.platform } = {}) {
  if (platform === 'win32') return false; // win32 NAMED residual — reparse-attribute upgrade path, not blocks (see calibration note, #8)
  try {
    const st = statSync(p);
    if (!st || typeof st.isFile !== 'function' || !st.isFile()) return false;
    const size = Number(st.size);
    const blocks = Number(st.blocks);
    return Number.isFinite(size) && size > 0 && Number.isFinite(blocks) && blocks === 0;
  } catch { return false; }
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
      roleMemories: [],
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

  return { platform: plat, entries, flags, roleMemories: discoverRoleMemories({ projectRoot, home }) };
}

// #22 ROLE-MEMORY DISCOVERY (promoted from retier.mjs's collectStores into the
// central discovery layer so gauge/wash/stats SEE per-role stores too): native
// subagent role-memories at <project>/.claude/agent-memory/<role>/ — a MEMORY.md
// index + sibling *.md topic files. Returned as a SEPARATE `roleMemories` field
// on discoverClassB (per-store), NEVER folded into `entries`.
//
// NESTED-HABITAT (the reason for the separate field, series law): a role store
// loads into a SUB when that role spawns — NOT into the MAIN every session. So
// it must be its OWN tier, never blended into the main's always-loaded
// footprint. Keeping it out of `entries` makes the main gauge (measureEntries ->
// BMI/floor/force/break-even, all off `entries`) BYTE-IDENTICAL with or without
// role dirs — a cap/verdict the ROOM acts on is computed on room-owned only,
// never on a habitat the room cannot act on (the CoalTipple-false-FULL lesson).
// This also unlocks the docketed #55 cross-store detector (per-store measures
// are its input) — but that detector is NOT built here; this is discovery+report
// only. The roster is stable (a new role dir is found by construction — a
// mirror, never a hardcoded list; the 0l capture-all discipline).
//
// Each store: { store: 'agent:<role>', dir, index: {path,bytes}|null,
// memories: [{path,bytes}], bytes, files }. Every path realpath-and-contained
// (fail-closed), symlink dirs never followed (Dirent own-type). CC-only (an
// unknown platform gets [] — the agent-memory layout is a native-subagent
// feature, conservative elsewhere, mirroring discoverClassB's own gate).
export function discoverRoleMemories({ projectRoot = process.cwd(), home = os.homedir() } = {}) {
  const projPhys = physicalOrNull(projectRoot);
  if (!projPhys) return [];
  const roots = [physicalOrNull(home), projPhys].filter(Boolean);
  const agentBase = path.join(projPhys, '.claude', 'agent-memory');
  let roles = [];
  try { roles = fs.readdirSync(agentBase, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { return []; } // no agent-memory dir = no role stores
  const out = [];
  for (const role of roles) {
    const dirPhys = physicalOrNull(path.join(agentBase, role));
    if (!dirPhys || !containedIn(dirPhys, roots)) continue; // fail-closed (a role dir symlinked outside is skipped)
    let names = [];
    try { names = fs.readdirSync(dirPhys, { withFileTypes: true }); } catch { continue; }
    let index = null;
    const memories = [];
    let bytes = 0;
    for (const d of names) {
      if (!d.isFile() || !d.name.endsWith('.md')) continue; // a symlink Dirent reports its own type — never followed
      const phys = physicalOrNull(path.join(dirPhys, d.name));
      if (!phys || !containedIn(phys, roots)) continue;
      const b = statBytes(phys);
      if (b == null) continue;
      bytes += b;
      if (d.name === 'MEMORY.md') index = { path: phys, bytes: b };
      else memories.push({ path: phys, bytes: b });
    }
    if (!index && !memories.length) continue; // an empty dir is not a store
    out.push({ store: `agent:${role}`, dir: dirPhys, index, memories, bytes, files: (index ? 1 : 0) + memories.length });
  }
  return out;
}
