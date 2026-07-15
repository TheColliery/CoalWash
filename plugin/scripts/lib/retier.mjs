// retier.mjs — RE-TIER: the wizard's FOURTH choice (blueprint §19.3).
//
// RE-TIER = merge-all class-B memory stores -> redistribute by an ENVELOPE ->
// overflow cascades DOWN the tier ladder (hot index -> topic file -> estate
// archive). TWO mechanisms meet at one point, and the combination is its own
// damage surface (the quota-driven-loss class), so the powers are SEPARATED:
//
//   Mechanism 1 — the ENVELOPE (config `retier`): a +/- BAND around
//   `targetTokens`, never a locked value (the SSD watermark-pair law). It
//   decides TIER PLACEMENT ONLY; it may NEVER choose or escalate a treatment.
//
//   Mechanism 2 — the PER-TYPE TREATMENT TABLE (RETIER_TREATMENTS): a CODE
//   table, deterministic. Agent adjudication exists only INSIDE allowed
//   cells; anything stronger than a type's ceiling is code-REFUSED
//   (assertTreatmentAllowed throws loud).
//
// THE CORE RAIL (separation of powers): envelope pressure (store over target)
// resolves ONLY by DEMOTION down the ladder — every demotion is a LOSSLESS
// move (content byte-identical), reachable back via estate-search / normal
// recall. Pressure NEVER escalates a treatment: a skip must never become a
// condense because "it wouldn't fit". RE-TIER moves and demotes; it NEVER
// deletes content — 'discard' (ทิ้ง) appears in NO table cell (deletion stays
// ULTRA-COLD's gated path + the wash's adjudicated plan).
//
// ENVELOPE PROVENANCE (the numbers): targetTokens 4,125 = the cross-AI Tier-1
// (hot memory-index) cap MEDIAN — CC 6,250 hard (the 25 KB index cap / 4) ·
// Letta 10,000 hard · Zep 625 default · LangChain-legacy 2,000 default
// (WHATSNEW-LEDGER row 27, 2026-07-16) — AND independently ~2% of the 200k
// binding envelope (the user's minimax derivation: the min-of-max context the
// always-loaded slice rides in; CC's own revealed constants bracket 1-3%).
// Derived: armAt = target x (1 + armPct/100) ~ 4,950 · disarmAt = target x
// (1 - disarmPct/100) ~ 3,712 · fill ceiling on redistribute = target x
// (1 - headroomPct/100) — the over-provisioning analog: never fill TO target.
// Token measure = the existing char-heuristic (caliper tokensEst), ~est.
//
// RUN-GATE: RE-TIER fires ONLY through the wizard's fourth choice — never a
// hook/band/BMI (same law as ULTRA; the test suite greps hooks/ to hold it).
// Wizard-ONLY + the LEAN-stop law: retier-run REFUSES when no store is over
// armAt ("dead zone, no action").
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { ccProjectSlug, ccMemoryDir, physicalOrNull, containedIn } from './class-b.mjs';
import { tokensEst } from './caliper.mjs';
import { gateFiles, checkFidelity } from './fidelity-gate.mjs';
import { applyPlan, acquireLock, globalLockPath, isPinned } from './apply.mjs';
import { resolveArchiveDir, appendIndexRow } from './estate-archive.mjs';
import { anchorDiff, anchorDiffLine } from './anchor-diff.mjs';

export const OVERFLOW_BASENAME = 'retier-overflow.md';
const OVERFLOW_POINTER = `- [RE-TIER overflow](${OVERFLOW_BASENAME}) — index lines demoted by the envelope (lossless; move a line back to re-promote it)`;
const OVERFLOW_HEADER = `# RE-TIER overflow — index lines demoted by the envelope\n\n> Byte-identical lines moved down from MEMORY.md by RE-TIER. Move a line back to re-promote it; nothing here was summarized or deleted.\n\n`;
const TOP_ANCHOR_N = 20; // the closing-check sample size (the locked spec's N)
const CLAIM_FLAG_CAP = 20; // report readability cap on #55 flags, never a data cap

// ---------------------------------------------------------------------------
// Mechanism 1 — the envelope
// ---------------------------------------------------------------------------

// `retier` arrives via clampedRead (per-sub-key degrade-to-default); this is
// defense in depth for direct callers, same pattern as resolveEstateCfg.
export function resolveRetierCfg(retier) {
  const r = retier && typeof retier === 'object' ? retier : {};
  const num = (v, def, min, max) => (Number.isFinite(v) && v >= min && v <= max ? v : def);
  return {
    targetTokens: num(r.targetTokens, 4125, 500, 6250), // 6250 = the CC hard cap (25 KB index / 4)
    armPct: num(r.armPct, 20, 5, 50),
    disarmPct: num(r.disarmPct, 10, 5, 50),
    headroomPct: num(r.headroomPct, 10, 5, 50),
  };
}

export function envelopeFor(retier) {
  const c = resolveRetierCfg(retier);
  return {
    targetTokens: c.targetTokens,
    armAt: Math.round(c.targetTokens * (1 + c.armPct / 100)),
    disarmAt: Math.round(c.targetTokens * (1 - c.disarmPct / 100)),
    fillCeiling: Math.round(c.targetTokens * (1 - c.headroomPct / 100)),
  };
}

// The watermark pair. The DEAD ZONE [disarmAt..armAt) is the hysteresis
// itself: a store washed down into it does NOT re-trigger (no-flap) — only
// crossing armAt again arms; redistribute fills to fillCeiling (< disarmAt at
// factory), so a completed pass always lands disarmed.
export function envelopeBand(tokens, env) {
  const t = Number.isFinite(tokens) ? tokens : 0;
  if (t >= env.armAt) return 'over-arm';
  if (t <= env.disarmAt) return 'under-disarm';
  return 'dead-zone';
}

// ---------------------------------------------------------------------------
// Mechanism 2 — the per-type treatment table
// ---------------------------------------------------------------------------

// Treatments (bridge-language law: English identifiers ship; the user's
// design words map as): 'skip' = ข้าม · 'demote' = บีบ (a LOSSLESS move down
// one tier) · 'condense-via-gate' = ย่อ (the EXISTING wash tiers only — gate +
// adjudication; RE-TIER itself never executes a condense) · 'ultra-bands' =
// delegate to ULTRA's own estate bands (estate-archive.mjs — reused, never
// duplicated). 'discard' (ทิ้ง) exists NOWHERE in this table by design.
// 'skip' is present in EVERY row — the universal fail-closed floor (refusing
// to skip would force an action, the fail-open direction).
export const RETIER_TREATMENTS = Object.freeze({
  'class-b-index': Object.freeze(['skip', 'condense-via-gate']),
  'class-b-topic': Object.freeze(['skip', 'demote', 'condense-via-gate']),
  governance: Object.freeze(['skip']), // wash owns governance's semantic work — RE-TIER only skips
  'machine-parsed': Object.freeze(['skip']), // the 4-test excludees: configs/state/locks/journals/skills
  'vendor-artifact': Object.freeze(['skip', 'ultra-bands']), // transcripts/tool-results: ULTRA's own bands only
  unknown: Object.freeze(['skip']), // fail-closed
});

// Classify by path + shape, fail-closed to 'unknown'. Discovery `kind` wins
// when present (the class-b.mjs adapter already decided); the shape fallback
// covers files discovery never tagged (agent stores, store-dir strays).
export function classifyRetier(entry) {
  const p = entry && typeof entry.path === 'string' ? entry.path : '';
  if (!p) return 'unknown';
  if (entry.kind === 'memory-index') return 'class-b-index';
  if (entry.kind === 'memory' || entry.kind === 'role-memory') return 'class-b-topic';
  if (entry.kind === 'governance') return 'governance';
  const base = path.basename(p);
  const norm = p.split(path.sep).join('/').toLowerCase();
  const ext = path.extname(base).toLowerCase();
  if (ext !== '.md') {
    if (ext === '.jsonl' || /\/(tool-results|subagents)\//.test(norm)) return 'vendor-artifact';
    return 'machine-parsed';
  }
  // NAME/PATH IDENTITY WINS OVER DIRECTORY LOCATION (finding #2 root cause): a
  // governance or program file is what it IS wherever it sits — a CLAUDE.md /
  // AGENTS.md / SKILL.md that ends up INSIDE a memory-store dir must classify as
  // governance/machine-parsed (skip-only), NEVER as a demotable class-b-topic.
  // These checks therefore precede the memory-dir catch-all, which used to mask
  // them (empirically demoted CLAUDE.md/AGENTS.md/SKILL.md off the live tree).
  // CASE-INSENSITIVE (wear round-2 Finding A): the memory-dir catch-all below
  // lowercases, so these identity checks must too — else `claude.md`/`Skill.md`
  // on a case-preserving FS (Windows/macOS ship platforms) slip past to
  // class-b-topic = demotable. `gemini.md` covered as a cross-agent governance name.
  const lb = base.toLowerCase();
  if (/\/(skills|commands|hooks)\//.test(norm) || lb === 'skill.md') return 'machine-parsed'; // program markdown
  if (lb === 'claude.md' || lb === 'agents.md' || lb === 'gemini.md' || /\/rules\//.test(norm)) return 'governance';
  if (/\/(memory|agent-memory\/[^/]+)\/[^/]+$/.test(norm)) {
    return base.toLowerCase() === 'memory.md' ? 'class-b-index' : 'class-b-topic';
  }
  return 'unknown';
}

// The ceiling enforcement — anything stronger than a type's cell throws LOUD.
// An unknown type falls closed to skip-only.
export function assertTreatmentAllowed(type, treatment) {
  const allowed = RETIER_TREATMENTS[type] || RETIER_TREATMENTS.unknown;
  if (!allowed.includes(treatment)) {
    throw new Error(`re-tier refused: treatment '${treatment}' exceeds the ceiling for type '${type}' (allowed: ${allowed.join('|')})`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// store collection (main memory store + agent-memory stores)
// ---------------------------------------------------------------------------

function readOrNull(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

// A STORE = a directory holding a MEMORY.md index: the CC main memory dir
// (~/.claude/projects/<slug>/memory) + each <project>/.claude/agent-memory/
// <role>/. Every dir realpath-and-contained (home/project trees, fail-closed)
// — same containment law as discovery/apply.
export function collectStores({ projectRoot = process.cwd(), home = os.homedir() } = {}) {
  const homePhys = physicalOrNull(home);
  const projPhys = physicalOrNull(projectRoot);
  const roots = [homePhys, projPhys].filter(Boolean);
  const stores = [];

  const addStore = (label, dir) => {
    const phys = physicalOrNull(dir);
    if (!phys || !containedIn(phys, roots)) return; // fail-closed
    const indexPath = path.join(phys, 'MEMORY.md');
    const indexText = readOrNull(indexPath);
    if (indexText === null) return; // no index = not a store
    const topics = [];
    const others = [];
    let names = [];
    try { names = fs.readdirSync(phys, { withFileTypes: true }); } catch { return; }
    for (const d of names) {
      if (!d.isFile()) continue; // a symlink Dirent reports its own type — never followed
      const p = path.join(phys, d.name);
      if (d.name === 'MEMORY.md') continue;
      if (d.name.endsWith('.md')) {
        const text = readOrNull(p);
        if (text === null) continue;
        let st = null;
        try { st = fs.statSync(p); } catch { continue; }
        topics.push({ path: p, basename: d.name, text, bytes: st.size, mtimeMs: st.mtimeMs });
      } else {
        others.push({ path: p, basename: d.name });
      }
    }
    topics.sort((a, b) => (a.basename < b.basename ? -1 : 1)); // deterministic order
    stores.push({ label, dir: phys, indexPath, indexText, topics, others });
  };

  addStore('main', ccMemoryDir(projectRoot, home));
  const agentBase = path.join(projectRoot, '.claude', 'agent-memory');
  let roles = [];
  try { roles = fs.readdirSync(agentBase, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { /* none */ }
  for (const role of roles) addStore(`agent:${role}`, path.join(agentBase, role));
  return stores;
}

// ---------------------------------------------------------------------------
// demotion planning (the deterministic candidate rules)
// ---------------------------------------------------------------------------

function isPointerLine(line) {
  return line.includes(`](${OVERFLOW_BASENAME})`);
}
// Demotable index line: non-blank, not a heading, not the overflow pointer,
// not inside a leading frontmatter block.
function demotableLineMask(lines) {
  const mask = new Array(lines.length).fill(true);
  let i = 0;
  if (lines[0] !== undefined && lines[0].trim() === '---') {
    mask[0] = false;
    for (i = 1; i < lines.length; i++) { mask[i] = false; if (lines[i].trim() === '---') { i++; break; } }
  }
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim() || /^\s*#/.test(l) || isPointerLine(l)) mask[i] = false;
  }
  return mask;
}

// Hop-1: demote whole index LINES (verbatim, byte-identical — split/join on
// '\n' only, so CRLF line ends travel with their line) to the overflow topic
// file until the index measures <= fillCeiling.
// ponytail: candidate rule = LARGEST-LINE-FIRST — fewest lines moved for the
// needed relief, value-neutral (no age judgment — age is shield, never
// sword). Upgrade path: least-recently-REFERENCED ranking when a recall
// tracker exists (the spec's own e.g.).
export function planIndexDemotion(indexText, env) {
  const text = String(indexText);
  const tokensBefore = tokensEst(text);
  const lines = text.split('\n');
  const mask = demotableLineMask(lines);
  const hasPointer = lines.some(isPointerLine);
  const cand = [];
  for (let i = 0; i < lines.length; i++) if (mask[i]) cand.push({ i, tok: tokensEst(lines[i]) });
  cand.sort((a, b) => b.tok - a.tok || a.i - b.i); // largest first, stable

  const moved = new Set();
  const assemble = () => {
    const kept = lines.filter((_, i) => !moved.has(i));
    if (moved.size && !hasPointer) {
      // keep the demoted lines reachable by NORMAL RECALL: index -> overflow -> line
      if (kept.length && kept[kept.length - 1] === '') kept.splice(kept.length - 1, 0, OVERFLOW_POINTER);
      else kept.push(OVERFLOW_POINTER);
    }
    return kept.join('\n');
  };
  // Greedy fill: measure the REAL assembled text each step (stores are <=
  // ~25 KB — the O(n^2) re-measure is cheap and exact; ponytail: replace with
  // a running estimate if a giant store ever surfaces).
  for (const c of cand) {
    if (tokensEst(assemble()) <= env.fillCeiling) break;
    moved.add(c.i);
  }
  const indexNew = assemble();
  const movedLines = [...moved].sort((a, b) => a - b).map((i) => lines[i]);
  const tokensAfter = tokensEst(indexNew);
  return {
    movedLines,
    indexNew,
    tokensBefore,
    tokensAfter,
    pointerAdded: moved.size > 0 && !hasPointer,
    shortfall: tokensAfter > env.fillCeiling, // candidates exhausted; NEVER escalate — the gated wash (condense) is the human's next lever
  };
}

function countOccurrences(hay, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) { n++; i = hay.indexOf(needle, i + needle.length); }
  return n;
}

// Hop-2: topic files UNREFERENCED anywhere else in the merged tree (neither
// basename nor stem appears outside the topic's own text) demote to the
// estate archive, oldest mtime first. A false "referenced" (a common-word
// stem matching prose) keeps the file in place — the safe fail direction.
// ponytail: substring reference test; upgrade path = real link-graph
// resolution if FP-keeps ever matter.
export function unreferencedTopics(store, allTextConcat) {
  const out = [];
  for (const t of store.topics) {
    if (t.basename === OVERFLOW_BASENAME) continue; // the ladder's own tier-2 rung — never cascades itself
    const stem = t.basename.replace(/\.md$/i, '');
    const ownBase = countOccurrences(t.text, t.basename);
    const ownStem = countOccurrences(t.text, stem);
    const allBase = countOccurrences(allTextConcat, t.basename);
    const allStem = countOccurrences(allTextConcat, stem);
    if (allBase > ownBase || allStem > ownStem) continue; // referenced elsewhere -> stays
    out.push(t);
  }
  out.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.basename < b.basename ? -1 : 1));
  return out;
}

// ---------------------------------------------------------------------------
// #55 reconcile — report-only cross-store claim contradictions
// ---------------------------------------------------------------------------

const CLAIM_VERSION_RE = /([A-Za-z][A-Za-z0-9_.-]{1,40})\s+(?:is\s+|=\s*|at\s+)?(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/g;
const CLAIM_STATUS_RE = /\b(LIVE|wired|validated|regressed|closed)\b/gi;
// Common-word subjects are noise, not entities ("given the v1.2.1" must not
// key a claim on "the") — measured live on the real store, 2026-07-16.
const CLAIM_STOPWORDS = new Set(['the', 'a', 'an', 'at', 'of', 'in', 'to', 'is', 'was', 'than', 'from', 'since', 'and', 'or', 'vs', 'on', 'for', 'with', 'by', 'as', 'it', 'now', 'still', 'then', 'prev']);

// Versioned/status claims of one text. Subject derivation is deliberately
// simple + deterministic: version claims key on the word right before the
// version token (stopwords skipped); status claims key on the line's first
// wikilink target, else first codespan, else the first ENTITY-shaped word
// (carries an uppercase letter or a hyphen — a plain lowercase prose word is
// noise). ponytail: heuristic subjects — report-only output, a human reads
// the flags; upgrade path = entity linking if FP noise ever matters.
export function extractClaims(text, file, store) {
  const claims = [];
  const s = String(text);
  CLAIM_VERSION_RE.lastIndex = 0;
  let m;
  while ((m = CLAIM_VERSION_RE.exec(s)) !== null) {
    const subject = m[1].toLowerCase();
    if (CLAIM_STOPWORDS.has(subject)) continue;
    claims.push({ kind: 'version', subject, value: m[2].replace(/^v/, ''), file, store });
  }
  for (const rawLine of s.split(/\r?\n/)) {
    CLAIM_STATUS_RE.lastIndex = 0;
    const verbs = rawLine.match(CLAIM_STATUS_RE);
    if (!verbs) continue;
    const wl = /\[\[([^[\]|]+)/.exec(rawLine);
    const cs = /`([^`\n]+)`/.exec(rawLine);
    const word = /\b([A-Za-z0-9]*(?:[A-Z][a-z]|[A-Za-z0-9]-[A-Za-z0-9])[A-Za-z0-9_-]*)\b/.exec(rawLine);
    const subject = (wl ? wl[1] : cs ? cs[1] : word ? word[1] : '').trim().toLowerCase();
    if (!subject || CLAIM_STOPWORDS.has(subject)) continue;
    for (const v of verbs) claims.push({ kind: 'status', subject, value: v.toLowerCase(), file, store });
  }
  return claims;
}

// Same (kind, subject) claimed with DISTINCT values from >= 2 DIFFERENT
// stores => a cross-store contradiction flag. REPORT-ONLY — no auto-fix ever.
export function reconcileClaims(stores) {
  const byKey = new Map();
  for (const st of stores) {
    const files = [{ file: path.basename(st.indexPath), text: st.indexText }, ...st.topics.map((t) => ({ file: t.basename, text: t.text }))];
    for (const f of files) {
      for (const c of extractClaims(f.text, f.file, st.label)) {
        const key = `${c.kind}:${c.subject}`;
        const bucket = byKey.get(key) || [];
        bucket.push(c);
        byKey.set(key, bucket);
      }
    }
  }
  const flags = [];
  for (const [key, bucket] of byKey) {
    const values = new Set(bucket.map((c) => c.value));
    const storeSet = new Set(bucket.map((c) => c.store));
    if (values.size < 2 || storeSet.size < 2) continue;
    // contradiction only when different stores actually DISAGREE (a value
    // present in one store and absent from another store's claim set)
    const byStore = new Map();
    for (const c of bucket) {
      const set = byStore.get(c.store) || new Set();
      set.add(c.value);
      byStore.set(c.store, set);
    }
    const sets = [...byStore.values()];
    const crossDisagree = sets.some((a) => sets.some((b) => a !== b && [...a].some((v) => !b.has(v))));
    if (!crossDisagree) continue;
    flags.push({
      key,
      claims: bucket.map((c) => ({ value: c.value, file: c.file, store: c.store })),
    });
  }
  flags.sort((a, b) => (a.key < b.key ? -1 : 1));
  return flags;
}

// ---------------------------------------------------------------------------
// top-anchor survival probe (the closing check)
// ---------------------------------------------------------------------------

// Counting variants of fidelity-gate.mjs's wikilink/version/codespan shapes
// (the gate's inventory() is set-based; "most-referenced" needs counts).
const TA_WIKILINK_RE = /\[\[([^[\]|]+)/g;
const TA_VERSION_RE = /\bv?\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?\b/g;
const TA_CODESPAN_RE = /`([^`\n]+)`/g;

export function topAnchors(texts, n = TOP_ANCHOR_N) {
  const counts = new Map();
  const bump = (tok) => { const t = tok.trim(); if (t) counts.set(t, (counts.get(t) || 0) + 1); };
  for (const text of texts) {
    const s = String(text);
    for (const [re, group] of [[TA_WIKILINK_RE, 1], [TA_VERSION_RE, 0], [TA_CODESPAN_RE, 1]]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(s)) !== null) bump(m[group]);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, n)
    .map(([token, count]) => ({ token, count }));
}

// An anchor "resolves" when its token text still appears SOMEWHERE in the
// post-pass tree (hot index, topic files incl. overflow, or the archive
// dig-index rows). Returns the misses ([] = pass).
export function probeAnchors(anchors, postTexts) {
  return anchors.filter((a) => !postTexts.some((t) => String(t).includes(a.token)));
}

// ---------------------------------------------------------------------------
// scan (report-only) + run (transactional)
// ---------------------------------------------------------------------------

function planStore(store, env, allTextConcat) {
  const indexTokens = tokensEst(store.indexText);
  const band = envelopeBand(indexTokens, env);
  const overArm = band === 'over-arm';
  // #4 pin: hop-1 REWRITES the index (and its overflow topic). A pinned index or
  // pinned overflow is code-refused at applyPlan — but a pin must protect ITSELF
  // without vetoing the whole multi-store plan, so RE-TIER never OFFERS a pinned
  // target's demotion (the "pinned = not even offered" doctrine).
  const overflowTopic = store.topics.find((t) => t.basename === OVERFLOW_BASENAME);
  const hop1Pinned = isPinned(store.indexPath) || !!(overflowTopic && isPinned(overflowTopic.path));
  const hop1 = (overArm && !hop1Pinned) ? planIndexDemotion(store.indexText, env) : { movedLines: [], indexNew: store.indexText, tokensBefore: indexTokens, tokensAfter: indexTokens, pointerAdded: false, shortfall: false };
  // hop-2 demote candidates: ONLY a genuine class-b-topic (#2 — route through
  // the treatment table so a governance/program/vendor/unknown .md is skip-only,
  // never demoted; classifyRetier is the single classification authority) and
  // never a PINNED file (#4). Fail-closed, exactly as the `others` loop already
  // does. A genuine memory topic stays demotable as before.
  const hop2 = overArm
    ? unreferencedTopics(store, allTextConcat).filter((t) => classifyRetier({ path: t.path }) === 'class-b-topic' && !isPinned(t.path))
    : [];
  const items = [];
  items.push({ path: store.indexPath, type: 'class-b-index', treatment: 'skip', placement: 'hot', note: hop1.movedLines.length ? `${hop1.movedLines.length} line(s) demote to ${OVERFLOW_BASENAME}` : null });
  const hop2Set = new Set(hop2.map((t) => t.path));
  for (const t of store.topics) {
    const type = classifyRetier({ path: t.path }); // #2: report the REAL type, not a hardcoded class-b-topic
    const demote = hop2Set.has(t.path);
    items.push({ path: t.path, type, treatment: demote ? 'demote' : 'skip', placement: demote ? 'archive' : 'topic' });
  }
  for (const o of store.others) {
    const type = classifyRetier({ path: o.path });
    items.push({ path: o.path, type, treatment: type === 'vendor-artifact' ? 'ultra-bands' : 'skip', placement: 'stay' });
  }
  return { indexTokens, band, hop1, hop2, items };
}

// Report-only: envelope state + planned placement per item + #55 flags +
// the #54 anchor-diff advisory per over-arm index. No lock, no writes.
export function retierScan({ projectRoot = process.cwd(), home = os.homedir(), retier } = {}) {
  const env = envelopeFor(retier);
  const stores = collectStores({ projectRoot, home });
  const allTextConcat = stores.map((s) => [s.indexText, ...s.topics.map((t) => t.text)].join('\n')).join('\n');
  const out = [];
  for (const st of stores) {
    const p = planStore(st, env, allTextConcat);
    let anchorLine = null;
    if (p.band === 'over-arm') {
      // #54 generational anchor — ADVISORY report lines only, never a gate here
      try {
        const rep = anchorDiff(st.indexPath, { projectRoot, home });
        anchorLine = rep ? (anchorDiffLine(rep) || null) : null;
      } catch { anchorLine = null; }
    }
    out.push({
      label: st.label,
      dir: st.dir,
      indexPath: st.indexPath,
      indexTokens: p.indexTokens,
      band: p.band,
      items: p.items,
      plannedLineDemotions: p.hop1.movedLines.length,
      plannedTopicDemotions: p.hop2.length,
      shortfall: p.hop1.shortfall,
      anchorLine,
    });
  }
  const flags = reconcileClaims(stores);
  const overArm = out.filter((s) => s.band === 'over-arm').length;
  return {
    env,
    stores: out,
    flags,
    overArm,
    verdict: overArm ? `over-arm: ${overArm} store(s)` : 'no action (no store over the arm line)',
  };
}

export function retierScanLines(scan) {
  const e = scan.env;
  const lines = [];
  const totLines = scan.stores.reduce((n, s) => n + s.plannedLineDemotions, 0);
  const totTopics = scan.stores.reduce((n, s) => n + s.plannedTopicDemotions, 0);
  const itemsOver = scan.stores.reduce((n, s) => n + (s.band === 'over-arm' ? s.plannedLineDemotions + s.plannedTopicDemotions : 0), 0);
  lines.push(`[CoalWash] RE-TIER scan — ${scan.stores.length} store(s), ${scan.overArm} over-arm · envelope target ~${e.targetTokens} tok (arm ~${e.armAt} / disarm ~${e.disarmAt} / fill ~${e.fillCeiling}, ~est) · items over: ${itemsOver} · planned demotions: ${totLines} line(s) + ${totTopics} topic file(s) · verdict: ${scan.verdict}`);
  for (const s of scan.stores) {
    lines.push(`  ${s.label}: index ~${s.indexTokens} tok = ${s.band}${s.band === 'over-arm' ? ` -> demote ${s.plannedLineDemotions} line(s) + ${s.plannedTopicDemotions} unreferenced topic(s)${s.shortfall ? ' (still over after demotion — the gated wash is the next lever, never auto-condense)' : ''}` : ''}`);
    if (s.anchorLine) lines.push(`  ${s.anchorLine}`);
  }
  for (const f of scan.flags.slice(0, CLAIM_FLAG_CAP)) {
    const parts = f.claims.map((c) => `${c.store}/${c.file}: ${c.value}`).join(' vs ');
    lines.push(`  #55 cross-store contradiction [${f.key}]: ${parts} — report only, reconcile by hand`);
  }
  if (scan.flags.length > CLAIM_FLAG_CAP) lines.push(`  #55: +${scan.flags.length - CLAIM_FLAG_CAP} more (see --json)`);
  return lines.join('\n');
}

// MOVE-VERIFY — the lossless-move proof that authorizes the index rewrite's
// per-file fidelity drops: (a) every moved line is present VERBATIM in the
// overflow content; (b) the union gate (orig index vs indexNew + overflow —
// the documented merge/move convention) passes. Only then are the per-file
// drops machine-approved (they are moves, not losses); anything less aborts
// pre-mutation, fail-closed. This is NOT the human approvedDrops channel
// doing double duty: the human consent is the wizard's run press; the machine
// proof here is stronger than token-level approval (byte-level line survival
// inside the SAME transaction).
export function moveVerify({ origIndex, indexNew, overflowText, movedLines }) {
  const missing = movedLines.filter((l) => l.trim() && !String(overflowText).includes(l));
  const union = gateFiles([{ path: 'retier-move', orig: origIndex, next: `${indexNew}\n${overflowText}` }]);
  return { ok: missing.length === 0 && union.pass, missing, unionDrops: union.drops };
}

// Restore applyPlan's own verified snapshot after a post-commit probe miss:
// copy every manifest entry back, remove this run's created files. Returns
// the count of restore FAILURES (0 = clean), -1 when the manifest is unreadable.
export function rollbackFromSnapshot(snapshotDir, createdPaths = []) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(snapshotDir, 'manifest.json'), 'utf8')); } catch { return -1; }
  let failed = 0;
  for (const m of manifest) {
    try { fs.copyFileSync(path.join(snapshotDir, m.snap), m.original); } catch { failed++; }
  }
  for (const p of createdPaths) { try { fs.rmSync(p, { force: true }); } catch {} }
  return failed;
}

// The transactional RE-TIER pass. Wizard-consented ONLY (run-gate above).
// Refuses in the dead zone (LEAN-stop law); takes the GLOBAL CoalWash lock
// (the archive dig-index is a cross-project file — runEstate's own reason);
// lock held elsewhere -> { deferred: true }, nothing touched. applyPlan
// underneath adds the per-project lock + snapshot + whole-run rollback +
// external-writer guard + the fidelity interlock. `tamperForTests` = a test
// seam called at 'plan' / 'pre-apply' / 'post-apply' (hermetic fault
// injection; never wired outside tests).
export function runRetier({
  projectRoot = process.cwd(), home = os.homedir(), retier, estate,
  now = Date.now(), sessionId, gzip = zlib.gzipSync, tamperForTests = null,
} = {}) {
  const env = envelopeFor(retier);
  const stores = collectStores({ projectRoot, home });
  const allTextConcat = stores.map((s) => [s.indexText, ...s.topics.map((t) => t.text)].join('\n')).join('\n');
  const plans = stores.map((st) => ({ st, p: planStore(st, env, allTextConcat) }));
  const over = plans.filter(({ p }) => p.band === 'over-arm');
  if (!over.length) {
    return { ok: false, refused: true, reason: 'dead zone, no action — no store is over the arm line (LEAN-stop)', env };
  }

  const lock = acquireLock(globalLockPath(home), { sessionId: sessionId || String(process.pid), now });
  if (!lock.acquired) return { ok: false, deferred: true, error: lock.reason };
  const gzWritten = [];
  const rmGz = () => { for (const g of gzWritten) { try { fs.rmSync(g, { force: true }); } catch {} } };
  try {
    const archiveDir = resolveArchiveDir(estate, home);
    const slug = ccProjectSlug(projectRoot);
    const indexEnabled = !estate || typeof estate !== 'object' || estate.indexEnabled !== false;
    // pre-pass anchors over the WHOLE merged tree (all stores, index + topics)
    const preTexts = stores.flatMap((s) => [s.indexText, ...s.topics.map((t) => t.text)]);
    const anchors = topAnchors(preTexts, TOP_ANCHOR_N);

    if (typeof tamperForTests === 'function') tamperForTests('plan', { plans: over });

    const actions = [];
    const approvedDrops = [];
    const roots = [];
    const digRows = [];
    const createdPaths = [];
    const kept = [];
    let seq = 0;

    // #3 STRANDING GUARD: the archived-topic dig rows persist ONLY when
    // indexEnabled (the appendIndexRow below). With the index OFF, a top-anchor
    // whose sole LIVE home is a demoted topic would be search-UNREACHABLE after
    // the pass (gone from the tree, and no index row to restore it by id). So
    // under indexEnabled:false, KEEP such a topic in the live tree instead of
    // demoting it — fail toward reachability. (indexEnabled:true persists the
    // row, so the post-apply probe's dig-row survival is real.)
    const strandedKeep = new Set();
    if (!indexEnabled && anchors.length) {
      const demoteSet = new Set(over.flatMap(({ p }) => p.hop2.map((t) => t.path)));
      // text guaranteed to SURVIVE the pass: every store's index never leaves,
      // and any topic NOT being demoted stays. An anchor present here has a live
      // home regardless of the demotions.
      const survivingText = stores
        .flatMap((s) => [s.indexText, ...s.topics.filter((t) => !demoteSet.has(t.path)).map((t) => t.text)])
        .join('\n');
      const survives = new Set(anchors.map((a) => a.token).filter((tok) => survivingText.includes(tok)));
      for (const { p } of over) {
        for (const t of p.hop2) {
          if (strandedKeep.has(t.path)) continue;
          if (anchors.some((a) => t.text.includes(a.token) && !survives.has(a.token))) {
            strandedKeep.add(t.path);
            kept.push({ path: t.path, reason: 'kept in the live tree: sole home of a top-anchor with indexEnabled off (demoting would be search-unreachable)' });
          }
        }
      }
    }

    for (const { st, p } of over) {
      roots.push(st.dir);
      if (p.hop1.movedLines.length) {
        const overflowPath = path.join(st.dir, OVERFLOW_BASENAME);
        const existing = st.topics.find((t) => t.path === overflowPath);
        const overflowOrig = existing ? existing.text : null;
        const base = existing ? (overflowOrig.endsWith('\n') ? overflowOrig : `${overflowOrig}\n`) : OVERFLOW_HEADER;
        const overflowNext = base + p.hop1.movedLines.join('\n') + '\n';
        const mv = moveVerify({ origIndex: st.indexText, indexNew: p.hop1.indexNew, overflowText: overflowNext, movedLines: p.hop1.movedLines });
        if (!mv.ok) {
          rmGz();
          const why = mv.missing.length ? `moved line(s) missing from overflow: ${mv.missing.length}` : `union gate drops: ${mv.unionDrops.map((d) => `${d.type}:${d.value}`).slice(0, 5).join(', ')}`;
          return { ok: false, error: `move-verify failed for ${st.indexPath} — nothing applied (fail-closed): ${why}` };
        }
        for (const d of checkFidelity(st.indexText, p.hop1.indexNew).drops) approvedDrops.push(`${d.type}:${d.value}`);
        actions.push({ type: 'rewrite', path: st.indexPath, content: p.hop1.indexNew, expectedOrig: st.indexText });
        if (existing) actions.push({ type: 'rewrite', path: overflowPath, content: overflowNext, expectedOrig: overflowOrig });
        else { actions.push({ type: 'create', path: overflowPath, content: overflowNext }); createdPaths.push(overflowPath); }
      }
      for (const t of p.hop2) {
        if (strandedKeep.has(t.path)) continue; // #3: kept in the live tree (already recorded in `kept`)
        assertTreatmentAllowed('class-b-topic', 'demote'); // the table belt at the action site
        const pseudoId = `retier-${now}-${seq++}`;
        const dest = path.join(archiveDir, slug, `${pseudoId}.${t.basename}.gz`);
        const buf = Buffer.from(t.text, 'utf8');
        // copy-verify (the estate protocol): write .gz -> gunzip back -> byte-compare.
        // A failed verify keeps the original in place (that topic is skipped).
        try {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, gzip(buf));
          gzWritten.push(dest);
          const back = zlib.gunzipSync(fs.readFileSync(dest));
          if (!back.equals(buf)) throw new Error('verify mismatch');
        } catch (e) {
          try { fs.rmSync(dest, { force: true }); } catch {}
          const gi = gzWritten.indexOf(dest);
          if (gi !== -1) gzWritten.splice(gi, 1);
          kept.push({ path: t.path, reason: `archive verify failed (${e.message}) — original kept` });
          continue;
        }
        // topEntities carries the topic's OWN top anchors too: an anchor whose
        // occurrences are concentrated inside an archived topic must still
        // RESOLVE post-pass via this row (else the survival probe would fail
        // every legitimate demotion of such a topic — a self-inflicted DoS).
        digRows.push({
          sessionId: pseudoId, projectSlug: slug, startISO: null, endISO: null,
          bytes: buf.length, msgCount: null,
          firstUserLine: `RE-TIER demoted topic: ${st.label}/${t.basename}`,
          topEntities: [...new Set([t.basename, t.basename.replace(/\.md$/i, ''), st.label, ...topAnchors([t.text], 10).map((a) => a.token)])],
          archivedAt: new Date(now).toISOString(), retier: true,
        });
        actions.push({ type: 'delete', path: t.path, expectedOrig: t.text });
      }
    }
    if (!actions.length) {
      rmGz();
      return { ok: false, refused: true, reason: 'over-arm but nothing demotable — the gated wash (condense-via-gate, human-adjudicated) is the next lever; RE-TIER never auto-condenses', env, kept };
    }

    if (typeof tamperForTests === 'function') tamperForTests('pre-apply', { actions });

    // ONE transaction across every store: snapshot -> writes -> deletes LAST
    // -> whole-run rollback on any failure. Memory-store paths are project-
    // scope (never scope:'global'), so applyPlan's global-lock branch cannot
    // re-acquire the lock this function already holds.
    const r = applyPlan({ projectRoot, roots, actions, sessionId, origin: 'wizard-cut', approvedDrops }, { home, now });
    if (!r.ok) { rmGz(); return { ...r, env, kept }; }

    if (typeof tamperForTests === 'function') tamperForTests('post-apply', { actions });

    // THE CLOSING CHECK — top-anchor survival: the N most-referenced pre-pass
    // anchors must still resolve somewhere in the post-pass tree (hot index,
    // topic files incl. overflow, or the archive dig-index rows). Any miss =
    // FAIL + rollback (applyPlan's own verified snapshot restores byte-exact).
    const postStores = collectStores({ projectRoot, home });
    const postTexts = [
      ...postStores.flatMap((s) => [s.indexText, ...s.topics.map((t) => t.text)]),
      // rows joined RAW (not JSON.stringify — escaping would false-miss a
      // token containing a quote/backslash). #3: dig rows count as survival ONLY
      // when they actually PERSIST (indexEnabled) — else an archived-but-
      // unindexed anchor is search-unreachable, and the strand guard above has
      // already kept its topic live, so the anchor resolves in the tree instead.
      ...(indexEnabled ? digRows.map((row) => [row.firstUserLine, ...(row.topEntities || [])].join('\n')) : []),
    ];
    const misses = probeAnchors(anchors, postTexts);
    if (misses.length) {
      const failed = rollbackFromSnapshot(r.snapshotDir, createdPaths);
      rmGz();
      return {
        ok: false,
        rolledBack: failed === 0 ? true : 'partial',
        anchorMisses: misses,
        error: `top-anchor survival probe FAILED (${misses.length} of ${anchors.length} anchors unresolved) — run rolled back${failed ? ` (${failed} restore failure(s) — check snapshot ${r.snapshotDir})` : ''}`,
      };
    }

    // dig rows AFTER deletes + probe (row-follows-bytes: a crash here only
    // under-indexes; restore scans the archive itself, never the index).
    let rows = 0;
    if (indexEnabled) for (const row of digRows) { if (appendIndexRow(archiveDir, row)) rows++; }

    return {
      ok: true,
      env,
      snapshotDir: r.snapshotDir,
      archiveDir,
      indexRows: rows,
      kept,
      stores: over.map(({ st, p }) => ({
        label: st.label,
        movedLines: p.hop1.movedLines.length,
        indexTokensBefore: p.hop1.tokensBefore,
        indexTokensAfter: p.hop1.tokensAfter,
        topicsArchived: p.hop2.filter((t) => !kept.some((k) => k.path === t.path)).length,
        shortfall: p.hop1.shortfall,
      })),
    };
  } finally {
    lock.release();
  }
}

export function runRetierReport(res) {
  if (!res) return '[CoalWash] RE-TIER: no result';
  if (res.refused) return `[CoalWash] RE-TIER refused: ${res.reason}`;
  if (res.deferred) return `[CoalWash] RE-TIER deferred: ${res.error || 'lock held'} — nothing touched`;
  if (!res.ok) return `[CoalWash] RE-TIER failed: ${res.error}${res.rolledBack ? ` (rolled back: ${res.rolledBack})` : ''}`;
  const lines = [];
  const moved = res.stores.reduce((n, s) => n + s.movedLines, 0);
  const arch = res.stores.reduce((n, s) => n + s.topicsArchived, 0);
  lines.push(`[CoalWash] RE-TIER — ${res.stores.length} store(s) redistributed: ${moved} index line(s) demoted (lossless) + ${arch} unreferenced topic(s) archived byte-exact · nothing summarized, nothing deleted`);
  for (const s of res.stores) {
    lines.push(`  ${s.label}: index ~${s.indexTokensBefore} -> ~${s.indexTokensAfter} tok${s.shortfall ? ' (still over fill — the gated wash is the next lever)' : ''} · ${s.topicsArchived} topic(s) -> archive`);
  }
  lines.push(`  undo: snapshot ${res.snapshotDir} · archived topics restore via cli.mjs estate-restore <retier-id> (${res.indexRows} dig row(s) appended)`);
  for (const k of res.kept) lines.push(`  KEPT ${k.path}: ${k.reason}`);
  return lines.join('\n');
}
