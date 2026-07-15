// anchor-diff.mjs — cumulative cross-generation loss detector (loss class #54,
// MASTER-LOSS-TAXONOMY.md: generational-compounding / iterative-compression
// drift). ADVISORY ONLY — a report, never a gate: it never blocks, never
// auto-restores, never emits {decision:'block'}.
//
// The gap this closes: gateFiles (fidelity-gate.mjs) diffs ONE pass against
// the pass immediately before it. Repeated rewrite passes (a multi-sitting
// wizard/muscle-reorg, or any hand-edit/LLM pass that never went through
// applyPlan) each look locally clean against their own immediate predecessor
// while drifting further from the ORIGINAL with no ground-truth anchor after
// pass 1 — "a photocopy of a photocopy" (MASTER-LOSS-TAXONOMY.md). CW already
// keeps ground-truth anchors on disk as a side effect of its OWN safety net:
// apply.mjs's verified snapshots (`snap.complete`) and bins.mjs's per-cut
// records. This module is pure composition over those EXISTING artifacts —
// no new storage, no new write path.
//
// Method: pick the OLDEST verified snapshot that still names the target file
// in its manifest — the farthest-back ground-truth CW has on disk for it.
// Diff the anchor's structured-token inventory (fidelity-gate.mjs inventory())
// against (a) the CURRENT file and (b) every bin record (fat-bin + store.old)
// naming this file, recorded AT OR AFTER the anchor snapshot — CW's own
// approved cuts since then. A token in neither is a CUMULATIVE-loss
// CANDIDATE: invisible on the live file today, and not accounted for by
// anything CW's own pipeline recorded as an intentional drop — the signature
// of drift that happened OUTSIDE applyPlan across several generations.
//
// Rails: (a) advisory only; (b) NEVER worded "lost" — a candidate absent
// because content legitimately evolved is mechanically indistinguishable from
// drift, so the report says "candidate" + points at the anchor snapshot for
// restore-BY-REFERENCE (the human/insider judges, same law as bins.mjs
// restore — code never re-authors a guess); (c) fail-silent — no verified
// snapshot for this file => null, never invented; (d) read-only, always —
// this module writes nothing.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { inventory } from './fidelity-gate.mjs';
import { txDirFor } from './apply.mjs';
import { physicalOrNull, containedIn } from './class-b.mjs';
import { FAT_BIN_NAME, STORE_OLD_NAME, listBin, restoreFromBin } from './bins.mjs';

const CLASSES = ['wikilinks', 'dates', 'versions', 'links', 'frontmatter', 'codespans', 'quotes', 'numbers'];
const SNAP_DIR_RE = /^snap-(\d+)$/;
// Mirrors apply.mjs's module-private SNAP_MARKER (not exported — the same
// named-divergence choice writeguard.mjs already made for txDir/self-ignore,
// to avoid pulling this module onto apply.mjs's export surface for one string).
const SNAP_MARKER = 'snap.complete';

function samePath(a, b) {
  const pa = physicalOrNull(a) || (typeof a === 'string' && a ? path.resolve(a) : null);
  const pb = physicalOrNull(b) || (typeof b === 'string' && b ? path.resolve(b) : null);
  if (!pa || !pb) return false;
  return process.platform === 'win32' ? pa.toLowerCase() === pb.toLowerCase() : pa === pb;
}

// The pure computation — no filesystem. Which of anchorText's structured
// tokens are present in NEITHER currentText NOR any approvedTexts entry.
// Exported standalone so a caller (or a lab script) can drive it directly
// from in-memory strings, without CW's on-disk snapshot/bin shape.
export function computeCandidates({ anchorText, currentText, approvedTexts = [] } = {}) {
  const anchor = inventory(String(anchorText || ''));
  const current = inventory(String(currentText || ''));
  const approved = (approvedTexts || []).map((t) => inventory(String(t || '')));
  const candidates = [];
  const counts = {};
  for (const c of CLASSES) {
    let n = 0;
    for (const v of anchor[c]) {
      if (current[c].has(v)) continue;
      if (approved.some((a) => a[c].has(v))) continue;
      candidates.push({ type: c, value: v });
      n++;
    }
    counts[c] = { anchor: anchor[c].size, candidates: n };
  }
  return { candidates, counts };
}

// The OLDEST verified snapshot (snap.complete present) whose manifest names
// `physTarget` — ascending scan, first hit wins. An unverified snapshot
// (marker missing — a dangling/rolled-back txn) is skipped: never treated as
// ground truth. Returns { snapDir, snapFile, at } or null.
function oldestAnchor(txDir, physTarget) {
  let dirs;
  try { dirs = fs.readdirSync(txDir); } catch { return null; }
  const snaps = dirs
    .map((d) => { const m = SNAP_DIR_RE.exec(d); return m ? { d, at: Number(m[1]) } : null; })
    .filter(Boolean)
    .sort((a, b) => a.at - b.at); // OLDEST first
  for (const { d, at } of snaps) {
    const dir = path.join(txDir, d);
    if (!fs.existsSync(path.join(dir, SNAP_MARKER))) continue;
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { continue; }
    if (!Array.isArray(manifest)) continue;
    const hit = manifest.find((m) => m && samePath(m.original, physTarget));
    if (!hit) continue;
    const snapFile = path.join(dir, hit.snap);
    if (!fs.existsSync(snapFile)) continue; // manifest says so but the copy is gone — keep looking
    return { snapDir: dir, snapFile, at };
  }
  return null;
}

// Every bin record (fat-bin + store.old) naming `physTarget`, recorded AT OR
// AFTER `sinceAt` — CW's own approved drops for this file since the anchor.
// Content via bins.mjs's own pull-only restoreFromBin (never a fresh read).
function approvedSince(projectRoot, physTarget, sinceAt) {
  const texts = [];
  for (const name of [FAT_BIN_NAME, STORE_OLD_NAME]) {
    for (const item of listBin(projectRoot, name)) {
      if (!item || item.at < sinceAt || !samePath(item.original, physTarget)) continue;
      const content = restoreFromBin(projectRoot, name, item.id);
      if (content !== null) texts.push(content);
    }
  }
  return texts;
}

// The filesystem-driven report. Returns null (fail-silent, rail c) when the
// target cannot be resolved/contained in projectRoot, or no verified snapshot
// names it yet (a brand-new file, or one applyPlan has never touched — no
// ground truth to diff against). Otherwise: { file, snapshotPath, snapshotAt,
// approvedCount, candidates: [{type, value}], counts }. NEVER writes.
export function anchorDiff(filePath, { projectRoot, home = os.homedir() } = {}) {
  try {
    if (!projectRoot || typeof filePath !== 'string' || !filePath) return null;
    const physRoot = physicalOrNull(projectRoot);
    const phys = physicalOrNull(filePath);
    if (!physRoot || !phys || !containedIn(phys, [physRoot])) return null; // fail-closed, out of tree
    const anchor = oldestAnchor(txDirFor(projectRoot), phys);
    if (!anchor) return null; // no ground truth on disk for this file — nothing to compare
    let anchorText, currentText;
    try {
      anchorText = fs.readFileSync(anchor.snapFile, 'utf8');
      currentText = fs.readFileSync(phys, 'utf8');
    } catch { return null; } // unreadable — fail-silent, never guess
    const approvedTexts = approvedSince(projectRoot, phys, anchor.at);
    const { candidates, counts } = computeCandidates({ anchorText, currentText, approvedTexts });
    return { file: phys, snapshotPath: anchor.snapDir, snapshotAt: anchor.at, approvedCount: approvedTexts.length, candidates, counts };
  } catch {
    return null; // never throw — a read-only advisory must never surface as an error mid-wash
  }
}

// One-line advisory rendering (for a receipt / /coalwash:stats splice) —
// "candidate(s)", never "lost" (rail b). '' on nothing to say (no report or a
// clean lineage) so a caller can splice unconditionally, no empty-state check.
export function anchorDiffLine(report) {
  if (!report || !report.candidates.length) return '';
  const rel = path.basename(report.file);
  return `[CoalWash] ${rel}: ${report.candidates.length} structured-token candidate(s) missing since an older generation (snapshot ${path.basename(report.snapshotPath)}) — not in the current file or in ${report.approvedCount} recorded drop(s) since; check the snapshot before re-deriving, never assume lost.`;
}
