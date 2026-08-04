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
function recordKeepAt(file, ensureDir, { target, reason = '', date, anchor, anchorFile } = {}) {
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
    // grad7 ruling Root E / grad8 F4: the ORIGINAL grad6 fix checked truthiness
    // (`anchor` alone), which a whitespace-only string satisfies ('' is falsy,
    // ' ' is not) — a re-affirm call passing anchor:' ' silently OVERWROTE a
    // real 15+ char protected span with a single space, while the KEEPS-GATE
    // downstream (apply.mjs) still reads the entry as "enforced" (anchor is a
    // non-empty string) and its own survival check (`content.includes(' ')`)
    // is trivially true for nearly any rewrite — the keep stops protecting
    // anything without ever LOOKING broken. A real new value must carry real
    // content, not just pass `typeof === 'string' && truthy`.
    // grad9 F3: `trim().length>0` still wasn't enough — the SAME defect, wearing
    // different bytes. Two failures, opposite polarity, one root cause (a check
    // asking "is this non-empty" instead of "does this identify a real span"):
    // (1) a degenerate 1-3 char anchor ("e", "#", "the") passes `trim().length>0`
    //     and silently OVERWRITES a real, much longer, adjudicated anchor on
    //     re-affirm — and then, through applyPlan's real KEEPS-GATE, a rewrite
    //     dropping EVERY byte of the true protected content goes ok:true,
    //     applied:1, unflagged, while the entry still reads as "enforced".
    // (2) U+200B (ZERO WIDTH SPACE) is Cf, not in JS `\s` — `'​'.trim()`
    //     does NOT strip it, so a ZWSP-only value ALSO passes as "real content"
    //     and then never matches anything in real text, permanently
    //     false-refusing every future edit to that file.
    // Fix the CLASS: strip ordinary whitespace AND Unicode invisible/format
    // characters before measuring, for BOTH fields (closes polarity 2
    // everywhere) — and additionally require a real MINIMUM length for an
    // ANCHOR specifically (closes polarity 1): an adjudicated keep names a
    // specific clause, never a single character or a common short word.
    // anchorFile is a PATH, which is legitimately short, so it keeps the
    // non-empty-after-stripping bar only, no length floor.
    //
    // grad10 F5 [MEDIUM, both polarities]: `\p{Cf}` alone missed FOUR more
    // classes that reproduce the identical bug — combining marks (Mn, e.g.
    // U+0300), controls beyond `\s` (Cc, e.g. U+0001), and two SPECIFIC
    // codepoints outside any strippable-whole-category (Hangul filler
    // U+3164 is `Lo` — letters, which legitimately holds CJK/Thai/etc. real
    // text and must NOT be blanket-stripped; Braille blank U+2800 is `So` —
    // symbols, which legitimately holds real math/currency/etc. content for
    // the identical reason). `\p{Default_Ignorable_Code_Point}` (a real
    // ECMAScript Unicode property, verified supported and verified to leave
    // ordinary CJK/Latin/Thai letters untouched) catches U+3164 without
    // touching Lo generally; U+2800 has no such property to lean on, so it
    // is named explicitly rather than folded into a category that would
    // over-strip. `\p{Mn}`/`\p{Cc}` ARE safe to strip wholesale for THIS
    // purpose specifically: they only affect the LENGTH MEASUREMENT here,
    // never the stored anchor text (`mergedAnchor = anchor`, verbatim,
    // below) — a combining-mark-heavy script (Thai, Vietnamese, Arabic
    // diacritics) undercounts its true visible length, which is the SAFE
    // direction (more likely to correctly ask for a longer anchor, never
    // less). NAMED RESIDUAL: this is not a complete Default_Ignorable
    // enumeration — a future invisible-rendering codepoint outside these
    // categories is not guaranteed caught; the five reported here are.
    const stripInvisible = (v) => String(v).replace(/[\s\p{Cf}\p{Cc}\p{Mn}\p{Default_Ignorable_Code_Point}⠀]+/gu, '');
    // grad10 F4 [HIGH, content-loss]: length alone is a LENGTH proxy, not a
    // DISTINCTIVENESS one — "whatever" and "!!!!!!!!" both cleared the old
    // 8-char floor, and both are common/repeated enough to coincidentally
    // survive somewhere in unrelated boilerplate even after the protected
    // clause they were meant to name is gone, so the KEEPS-GATE's survival
    // check finds them and never flags the loss.
    //
    // CORRECTED grad10-round-2 HIGH-2: the first fix (raise the floor +
    // require >=2 WHITESPACE-delimited words) closed the reported shape by
    // assuming every script marks word boundaries with whitespace. Thai,
    // Japanese and Chinese do not — a real, adjudicated 24-50 character CJK/
    // Thai clause splits into exactly ONE "word" and was refused outright,
    // SILENTLY: `recordKeep` still returns true, the anchor is dropped, and
    // apply.mjs's KEEPS-GATE filters an anchor-less keep out of enforcement
    // entirely — the keep protects nothing and the user is told it worked.
    // Same silent-total-failure shape for any space-FREE technical token at
    // any length (a URL, a bare function call like `verifyBlobIntegrity()`),
    // and the word-count floor ALSO over-refused a genuinely short, real,
    // space-delimited phrase ("git rev-parse HEAD", 16 stripped chars) for
    // no reason connected to distinctiveness at all.
    //
    // The replacement measure is SCRIPT-AGNOSTIC by construction: distinct
    // CODEPOINT COUNT, never word count. "!!!!!!!!!!!!!!!!!!!!" (any length)
    // has exactly 1 distinct codepoint; "whatever"/"the the the" collapse to
    // a handful. A real adjudicated clause — in ANY script, with or without
    // word delimiters — draws from a far wider set: Thai/CJK/Latin prose all
    // carry many distinct codepoints even at short lengths, because a real
    // sentence is not a repeated token. Deliberately an ABSOLUTE floor, not
    // a RATIO: a ratio decays with length for any bounded alphabet (English
    // prose naturally drops toward ~26 distinct letters as length grows,
    // which a fixed ratio would eventually misread as non-distinctive) —
    // an absolute floor has no such decay and stays correct at any length.
    // MIN_MEANINGFUL_ANCHOR_LEN lowered from 20 to 12 (still above both
    // 8-char junk examples, comfortably below "git rev-parse HEAD"'s 16).
    // NAMED RESIDUAL: neither measure proves true uniqueness (this is
    // "plumbing only" per this file's own header — no read of the target
    // file's real content, an architecture change out of scope here) — a
    // short repeated PHRASE built from >=6 distinct characters
    // ("whatever whatever", 7 distinct chars) can still clear both floors.
    // Narrows the risk; does not close it fully, same standing as before.
    const MIN_MEANINGFUL_ANCHOR_LEN = 12;
    const MIN_DISTINCT_CHARS = 6;
    const hasRealAnchor = (v) => {
      if (typeof v !== 'string') return false;
      const stripped = stripInvisible(v);
      if (stripped.length < MIN_MEANINGFUL_ANCHOR_LEN) return false;
      return new Set([...stripped]).size >= MIN_DISTINCT_CHARS;
    };
    const hasRealPath = (v) => typeof v === 'string' && stripInvisible(v).length > 0;
    const mergedAnchor = hasRealAnchor(anchor) ? anchor : (prior && typeof prior.anchor === 'string' ? prior.anchor : undefined);
    const mergedAnchorFile = hasRealPath(anchorFile) ? anchorFile : (prior && typeof prior.anchorFile === 'string' ? prior.anchorFile : undefined);
    keeps.push({
      target,
      reason: String(reason || ''),
      date: date || new Date().toISOString().slice(0, 10),
      ...(mergedAnchor ? { anchor: mergedAnchor } : {}),
      ...(mergedAnchorFile ? { anchorFile: mergedAnchorFile } : {}),
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

// Global-scope variants — identical shape/schema/upsert-by-target semantics,
// filed beside the global state file rather than a single project's tx dir.
export function loadGlobalKeeps(home = os.homedir()) {
  return loadKeepsFrom(globalKeepsPath(home));
}
export function recordGlobalKeep(home = os.homedir(), opts = {}) {
  const dir = claudeBaseDir(home);
  return recordKeepAt(globalKeepsPath(home), () => { fs.mkdirSync(dir, { recursive: true }); }, opts);
}
