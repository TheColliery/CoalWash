// keeps.mjs — the keep-verdict store: a per-project ledger of ALREADY-
// ADJUDICATED "keep" decisions (an outsider/insider/human review confirmed a
// flagged memory IS load-bearing — keep it). Plumbing only: this guards
// against the decision-fatigue hazard of a future review pass re-flagging the
// same already-settled target without new evidence. The SKILL contract (docs
// sub) instructs the outsider to consult this store and not re-flag on no new
// evidence; this module only stores/reads the record.
//
// File shape: { v: 1, keeps: [{ target, reason, date }] }. The schema-version
// field ports XP-deletes-Vista-restore-points: an OLDER CoalWash meeting a
// NEWER keeps.json (v > 1) treats it as READ-ONLY — loadKeeps returns [] (we
// cannot parse what we do not know) and recordKeep refuses to rewrite it
// (never clobber a newer tool's artifact).
//
// Lives inside the SAME sandbox dir apply.mjs already self-ignores + contains
// (<project>/.claude/coalwash/) — no new privacy surface, no new config key.
// Fail-silent throughout (Phoenix-13): a missing/corrupt file reads as [], a
// write failure is swallowed. The ledger is a nice-to-have optimization, never
// load-bearing for correctness — losing it just re-exposes a target to review.
//
// GLOBAL variant (design-pass item, MEMORY.md "THE SHARED GLOBAL SLICE"): a
// keep recorded per-project does not shield a GLOBAL class-B file (the home
// CLAUDE.md closure) from a DIFFERENT project's outsider re-flagging it —
// loadGlobalKeeps/recordGlobalKeep file the SAME shape beside the global state
// file (~/.claude/.coalwash-state.json) instead, so an adjudicated keep on a
// global target shields it machine-wide. ~/.claude/ is a home dotfile dir, not
// a project repo, so it carries no ensureSelfIgnore (that guard exists only to
// stop a PROJECT from accidentally version-controlling its own tx dir).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { txDirFor, ensureSelfIgnore } from './apply.mjs';
import { claudeBaseDir } from './config-load.mjs';

const KEEPS_NAME = 'keeps.json';
const KEEPS_SCHEMA_V = 1;
const GLOBAL_KEEPS_NAME = '.coalwash-global-keeps.json';

export function keepsPath(projectRoot) {
  return path.join(txDirFor(projectRoot), KEEPS_NAME);
}
export function globalKeepsPath(home = os.homedir()) {
  return path.join(claudeBaseDir(home), GLOBAL_KEEPS_NAME);
}

function rawKeepsOrNull(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Every prior keep-adjudication at `file`: [{ target, reason, date }]. []  on
// a missing file, corrupt JSON, a wrong/newer schema, or malformed elements
// (never throws).
function loadKeepsFrom(file) {
  const parsed = rawKeepsOrNull(file);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  if (Number(parsed.v) > KEEPS_SCHEMA_V) return []; // newer schema: unreadable to us
  return Array.isArray(parsed.keeps) ? parsed.keeps.filter((k) => k && typeof k.target === 'string') : [];
}

// Record (or refresh) an adjudicated keep at `file`. Upserts by `target` — a
// re-review of the same target REPLACES the prior entry rather than piling up
// duplicates (the ledger tracks the LATEST verdict, not a full history).
// Returns true on a successful write, false on any failure (never throws) —
// including a keeps.json from a NEWER schema, which is never rewritten.
function recordKeepAt(file, ensureDir, { target, reason = '', date } = {}) {
  if (typeof target !== 'string' || !target) return false;
  try {
    const raw = rawKeepsOrNull(file);
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && Number(raw.v) > KEEPS_SCHEMA_V) return false; // read-only to us
    ensureDir();
    const keeps = loadKeepsFrom(file).filter((k) => k.target !== target);
    keeps.push({ target, reason: String(reason || ''), date: date || new Date().toISOString().slice(0, 10) });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ v: KEEPS_SCHEMA_V, keeps }), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

export function loadKeeps(projectRoot) {
  return loadKeepsFrom(keepsPath(projectRoot));
}
export function recordKeep(projectRoot, opts = {}) {
  const dir = txDirFor(projectRoot);
  return recordKeepAt(keepsPath(projectRoot), () => { fs.mkdirSync(dir, { recursive: true }); ensureSelfIgnore(dir); }, opts);
}

// Global-scope variants — identical shape/schema/upsert-by-target semantics,
// filed beside the global state file rather than a single project's tx dir.
export function loadGlobalKeeps(home = os.homedir()) {
  return loadKeepsFrom(globalKeepsPath(home));
}
export function recordGlobalKeep(home = os.homedir(), opts = {}) {
  const dir = claudeBaseDir(home);
  return recordKeepAt(globalKeepsPath(home), () => { fs.mkdirSync(dir, { recursive: true }); }, opts);
}
