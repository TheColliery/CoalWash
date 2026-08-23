// keeps.mjs — the keep-verdict store: a per-project ledger of ALREADY-
// ADJUDICATED "keep" decisions (an outsider/insider/human review confirmed a
// flagged memory IS load-bearing — keep it). Plumbing only: this guards
// against the decision-fatigue hazard of a future review pass re-flagging the
// same already-settled target without new evidence. The SKILL contract (docs
// sub) instructs the outsider to consult this store and not re-flag on no new
// evidence; this module only stores/reads the record.
//
// PENDING-USER (board #129, THE USER-OWNED CLASS): a keep whose own `reason`
// text names the USER as the decision-holder is NOT settled by an agent
// recording it — AGENTS.md's rule is that such a call STOPS and RETURNS to
// the human. `pendingUser: true` (+ `pendingSince`, an ISO date — when the
// remediation flagged it, never overwriting the original `date`) marks a
// keep that still protects its target (unchanged enforcement) but has not
// yet had its underlying decision actually put in front of the user. It is
// cleared (both fields removed) the moment the user answers, per §3's own
// upsert path — see `pendingUserKeeps` below.
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
// loadGlobalKeeps/recordGlobalKeep file the SAME shape at the ~/.claude root
// (.coalwash-global-keeps.json) instead, so an adjudicated keep on a global
// target shields it machine-wide. ~/.claude/ is a home dotfile dir, not
// a project repo, so it carries no ensureSelfIgnore (that guard exists only to
// stop a PROJECT from accidentally version-controlling its own tx dir).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { txDirFor, ensureSelfIgnore } from './apply.mjs';
import { claudeBaseDir } from './config-load.mjs';

export const KEEPS_NAME = 'keeps.json'; // exported for apply.mjs's KEEPS-GATE (opts.txDir-aware path build)
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

// Every prior keep-adjudication at `file`: [{ target, reason, date, anchor?,
// file? }]. [] on a missing file, corrupt JSON, a wrong/newer schema, or
// malformed elements (never throws). Exported (as loadKeepsAt) so apply.mjs's
// KEEPS-GATE can read a keeps store at the exact tx-dir path a transaction is
// actually using (opts.txDir in hermetic tests) — one loader, one schema.
export function loadKeepsAt(file) {
  const parsed = rawKeepsOrNull(file);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  if (Number(parsed.v) > KEEPS_SCHEMA_V) return []; // newer schema: unreadable to us
  return Array.isArray(parsed.keeps) ? parsed.keeps.filter((k) => k && typeof k.target === 'string') : [];
}
const loadKeepsFrom = loadKeepsAt;

// Record (or refresh) an adjudicated keep at `file`. Upserts by `target` — a
// re-review of the same target REPLACES the prior entry rather than piling up
// duplicates (the ledger tracks the LATEST verdict, not a full history).
// Returns true on a successful write, false on any failure (never throws) —
// including a keeps.json from a NEWER schema, which is never rewritten.
// Optional beta.12 fields (the KEEPS-GATE's enforcement handle): `anchor` =
// the VERBATIM protected text span, `anchorFile` = the absolute path of the
// store file it lives in. A keep carrying both is mechanically enforced at
// applyPlan; a keep without them stays advisory (the pre-beta.12 shape,
// unchanged behavior).
//
// Optional `pendingUser` (board #129): same preserve-unless-explicit rule as
// anchor/anchorFile, ONE DIRECTION DIFFERENT ON PURPOSE. `undefined` (not
// passed) preserves the prior value — an ordinary re-affirm that knows
// nothing about this mechanism must not silently clear a standing return-to-
// user. `true` sets it (+ `pendingSince`, defaulting like `date` does).
// `false` — passed EXPLICITLY, never inferred — is the ONLY way to clear it:
// the deliberate signal that the user's decision was actually recorded, not
// merely that this call happened to omit the field.
function recordKeepAt(file, ensureDir, { target, reason = '', date, anchor, anchorFile, pendingUser, pendingSince } = {}) {
  if (typeof target !== 'string' || !target) return false;
  try {
    const raw = rawKeepsOrNull(file);
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && Number(raw.v) > KEEPS_SCHEMA_V) return false; // read-only to us
    ensureDir();
    const existing = loadKeepsFrom(file);
    const prior = existing.find((k) => k.target === target);
    const keeps = existing.filter((k) => k.target !== target);
    // grad6 W3-K2 (CoalBoard verdict): this used to REBUILD the entry from
    // only THIS call's arguments -- a human re-affirming an already-enforced
    // keep (e.g. just bumping `reason`/`date`, the common re-review case)
    // without re-typing `anchor`/`anchorFile` silently dropped them, downgrading
    // the keep from mechanically ENFORCED (applyPlan's KEEPS-GATE) to merely
    // advisory, with no flag raised — the exact opposite of what a re-review
    // is supposed to do. Fix: preserve the PRIOR entry's anchor/anchorFile
    // whenever this call doesn't supply its own (a real, non-empty new value
    // still overrides — an intentional update, not a downgrade). There is no
    // way to distinguish "didn't pass one" from "wants it cleared" at this
    // call shape, so the safe direction is to never let re-affirming silently
    // weaken protection; explicitly clearing an anchor is a different, not-yet-
    // built feature, not this fix's job.
    const mergedAnchor = (typeof anchor === 'string' && anchor) ? anchor : (prior && typeof prior.anchor === 'string' ? prior.anchor : undefined);
    const mergedAnchorFile = (typeof anchorFile === 'string' && anchorFile) ? anchorFile : (prior && typeof prior.anchorFile === 'string' ? prior.anchorFile : undefined);
    // pendingUser DOES have a "wants it cleared" signal, unlike anchor above
    // — pendingUser === false, checked before falling back to the prior
    // value. undefined (never mentioned) preserves; true sets fresh.
    const mergedPendingUser = pendingUser === false
      ? undefined
      : pendingUser === true
        ? true
        : (prior && prior.pendingUser === true ? true : undefined);
    const mergedPendingSince = mergedPendingUser
      ? (typeof pendingSince === 'string' && pendingSince ? pendingSince : (prior && typeof prior.pendingSince === 'string' ? prior.pendingSince : new Date().toISOString().slice(0, 10)))
      : undefined;
    keeps.push({
      target,
      reason: String(reason || ''),
      date: date || new Date().toISOString().slice(0, 10),
      ...(mergedAnchor ? { anchor: mergedAnchor } : {}),
      ...(mergedAnchorFile ? { anchorFile: mergedAnchorFile } : {}),
      ...(mergedPendingUser ? { pendingUser: true, pendingSince: mergedPendingSince } : {}),
    });
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

// board #129: the keeps still awaiting an actual user decision — never a
// wash-time filter (a pending keep protects its target exactly like any
// other), only a REPORTING view for the receipt/wizard to surface.
export function pendingUserKeeps(keeps) {
  return Array.isArray(keeps) ? keeps.filter((k) => k && k.pendingUser === true) : [];
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
