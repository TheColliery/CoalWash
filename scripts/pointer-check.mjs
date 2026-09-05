// CWK-075 — POINTER gate. Ship-text naming something that cannot be REACHED.
//
// WHY THIS IS NOT CWK-060's GATE (scripts/config-keys.mjs). That one resolves config
// KEYS against config-schema.mjs. These are POINTERS — to a file or a directory — and
// nothing resolved them. Same family, different resolver: the key gate asks "is this
// name in the schema", this one asks "is the thing this name points at REACHABLE FROM
// A CLONE".
//
// THE RULING THIS ENFORCES (settled upstream; this module does not re-decide it): a
// probe cited as proof is not a throwaway. Cite the DURABLE artefact — a commit SHA, a
// shipped doc — and recycle the probe. A GITIGNORED PATH IS NOT A DURABLE CITATION.
// The gate enforces that distinction; it does not ban citations.
//
// THREE STATES, NOT TWO — "exists" is not "reachable":
//   tracked   -> silent
//   gitignored -> FAIL   (indistinguishable from "absent" on any other machine)
//   existing-but-UNTRACKED -> FAIL (a clone does not have it)
// The gitignored verdict is derived from `git check-ignore`, never from a parsed
// .gitignore — a re-implementation of gitignore matching would be a second source of
// truth, which is the defect class this gate exists to catch. It is also evaluated
// BEFORE the pending list, deliberately: a declaration can excuse a path that does not
// exist YET, never one that exists and is unreachable from a clone.
//
// ============================================================================
// DETECTION RULE — every step MEASURED on THIS room's own 9 ship-text surfaces before
// it was chosen, because cry-wolf is the failure mode this room has already paid for
// once (tripwireMaxLines firing on compliant code).
//
//   SHAPE (pointerCandidates — text only, no tree knowledge)      drops
//     - whitespace              a command or a Markdown table row, not a pointer
//     - <placeholder>           the author already said "not a literal path"
//     - glob metacharacter      a glob names a SET, not a file
//     - no `/`                  a bare filename is the SCANNED user's repo's
//     - absolute / `~` / URL    not this repo's to resolve
//     - a `.` or `..` SEGMENT   navigates, does not NAME; and escapes the repo
//     - a BACKSLASH             not a separator this gate reads (see below)
//
//   SCOPE (checkPointers — needs the tree)                        decides
//     - a gitignored root       FAIL, and decided before anything can launder it
//     - an agent install home   the SCANNED project's tree, never ours
//     - first segment in ourRoots           resolve from the repo root
//     - first segment beside the citer      resolve from the citing file's own dir
//       (or its parent)                     (structural, so never circular)
//
//   MEASURED on this room, 9 ship-text surfaces: 674 backticked tokens with fenced
//   code stripped -> 58 survive the shape funnel -> 36 IN SCOPE -> 36 tracked, 0
//   non-resolving. Re-derive with the walk in verify.mjs; never quote these forward.
//
// TWO FILTERS THE ADOPTION BRIEF PROPOSED AS ROOM-SPECIFIC ARE NOT SHIPPED, because
// both measured ZERO once the inherited funnel ran:
//   - a square-bracket `[project]/…` placeholder rule. The brief called this a
//     room-specific filter gap. It is not: `[` and `]` are already in the GLOB
//     metacharacter class, which drops all 14 slash-bearing bracket tokens we ship
//     (`[project]/.claude/coalwash/`, `snap-[timestamp]/`, and the rest).
//   - a `:` slash-command-form rule. Every such token we ship either has no `/` at all
//     or carries a leading `/`, so no-slash or OUTSIDE already owns it.
//   Measured: 0 tokens that a bracket rule would catch and the inherited funnel would
//   not; 0 for the colon rule. Shipping a filter that measures zero is padding, and it
//   would make the funnel look room-tuned when it is not.
//
// A BACKSLASH IS REJECTED RATHER THAN TREATED AS A SEPARATOR, and the reason is this
// room's own recorded lesson (resolve-and-contain, never segment-scan, because a scan
// misses `\` on Windows). Widening the dot-segment test to a `[\\/]` class keeps the
// segment-scan SHAPE and leaves the invariant platform-conditional; rejecting the
// character makes it unconditional — A CITATION IN OUR SURFACES IS `/`-DELIMITED ON
// EVERY PLATFORM. This module therefore contains no platform branch at all, which is
// what its POSIX test asserts through path.win32 and path.posix explicitly rather than
// assuming the property carried across the port.
// MEASURED before choosing: 0 backslash-bearing backticked tokens across the 9
// surfaces. NAMED BLIND SPOT, not a denial: a legitimate Windows-style citation would
// be dropped unchecked. Population today: zero.
//
// NAMED BLIND SPOTS — what is UNCOVERED, each with its measured cost, never a denial.
//
//   1. AN UNBACKTICKED PATH IS INVISIBLE. Extraction keys on backticks. MEASURED with
//      fenced blocks stripped FIRST and backticked spans masked SECOND (the order is
//      part of the measurement — a sibling room's count moved 6 -> 7 -> 2 the moment
//      fences were stripped): 4 path-shaped unbackticked tokens rooted in our tree, and
//      ZERO are uncovered citations. Two are English prose that greps as a path —
//      skills/commands/hooks means "skills, commands and hooks" — and two are the URL
//      half of a Markdown link whose backticked LABEL the gate already checks, so the
//      same path is covered via the label. Those four are written here WITHOUT
//      backticks on purpose: backticking them would make them real citations, and the
//      documentation of a blind spot must not manufacture one.
//
//   2. A SPAN CROSSING A NEWLINE IS INVISIBLE. The span pattern is [^`\n]+, so a
//      backticked path broken across two lines is never a candidate. MEASURED on the 9
//      surfaces: 0 lines carry an odd backtick count, so the uncovered population is
//      empty in ship-text. It is NOT empty in source comments, which is one reason
//      those are out of scope below.
//
//   3. SECTIONS AND SYMBOLS ARE NOT RESOLVED AT ALL. Ruled un-mechanised upstream on
//      two all-false measurements; not re-litigated and not built. The pass line says
//      so, so nobody reads this gate's green as covering them.
//
// SURFACES NOT WALKED, named rather than left implicit:
//   - SOURCE COMMENTS (scripts/**, hooks/**). MEASURED: 11 in-scope findings, of which
//     5 are REAL (explode.mjs cites gitignored lab-probe paths as measurement evidence
//     — exactly the class this gate is about) and 6 are FALSE, ~55% noise. Both false
//     classes are unseparable from a real citation by token shape: a hypothetical USER
//     project path under our own generically-named gitignored root (caliper.mjs's
//     slug-collision example), and a deliberately-nonexistent example path proving a
//     walk was blind (build-plugin.mjs's planted-orphan examples). Reported as a
//     finding, not silenced by a filter — the 5 real ones are their own unit.
//   - CHANGELOG.md. The exemplar walks it as history-only for the gitignored case.
//     MEASURED here: 2 gitignored-root citations, 2 of them FALSE — both the same
//     slug-collision example quoted from a comment, where our generic `work/` root
//     collides with prose about a user's tree. 0 of 2 true, so it is out.
//   - the plugin/ mirror (generated from source, so a finding there duplicates its
//     source), .github/workflows, and the gitignored trees themselves.

// A path this room deliberately points at BEFORE it exists. Ships EMPTY, and the empty
// list is a MEASUREMENT, not an omission: all 36 in-scope pointers resolve today.
//
// The mechanism exists anyway, and that is a decision with a reason rather than
// padding: without an escape hatch the first legitimate forward pointer hard-FAILs, and
// the cheapest way to make a FAIL go away is to delete the gate. Same EVENT-based
// expiry as CWK-060's PENDING_KEYS — a declaration is pruned by what BECOMES TRUE,
// never by a date nobody re-reads.
export const PENDING_POINTERS = [
  // { path: 'scripts/thing.mjs', reason: 'CWK-000 — landing next unit' },
];

// HISTORY-ONLY IS A PROPERTY OF THE SURFACE, NOT A LIST OF PATHS — stated here because
// the obvious second list is the wrong shape and was briefly shipped as one. A caller
// marks a whole surface `historyOnly: true` (a CHANGELOG, a dated record) and every
// citation in it is then checked for the gitignored case and nothing else: a renamed
// file was a correct citation once, a gitignored path never was. There is no
// per-PATH history allowlist, deliberately — "this one path is forgiven everywhere"
// is not a thing this gate can mean, and an exported constant implying otherwise
// would be a name pointing at a mechanism that does not exist, which is precisely
// the defect this gate exists to catch.

const GLOB = /[*?[\]{}|]/;
const OUTSIDE = /^([~/]|[A-Za-z]:|[a-z][a-z0-9+.-]*:\/\/)/;
// A `.` or `..` SEGMENT — never a dot-DIR like `.github`, which is a real name.
const DOTSEG = /(^|\/)\.\.?(\/|$)/;
const BACKSLASH = /\\/;

// Exported so an adopter — or this room's own test — measures the funnel with the SAME
// instrument rather than re-implementing it and getting different numbers.
export function pointerCandidates(text) {
  const out = [];
  // Fenced code blocks are EXAMPLES, not prose claims about this tree. Stripped FIRST.
  const prose = String(text).replace(/^```[\s\S]*?^```/gm, '');
  for (const m of prose.matchAll(/`([^`\n]+)`/g)) {
    const tok = m[1];
    if (/\s/.test(tok)) continue;      // a command or a table row, not a pointer
    if (/[<>]/.test(tok)) continue;    // <placeholder>
    if (GLOB.test(tok)) continue;      // a glob names a SET — and owns [project]/ too
    if (!tok.includes('/')) continue;  // a bare filename is the USER's repo's
    if (OUTSIDE.test(tok)) continue;   // absolute, home-relative, or a URL
    if (DOTSEG.test(tok)) continue;    // navigates rather than NAMES; escapes the repo
    if (BACKSLASH.test(tok)) continue; // not a separator this gate reads — see above
    out.push(tok);
  }
  return out;
}

// `docs/x.md:12` and `scripts/` both name a real thing; the line suffix and the
// trailing slash are punctuation, not part of the path.
function normalise(tok) {
  return tok.replace(/:\d+(-\d+)?$/, '').replace(/\/+$/, '');
}

export function checkPointers({
  surfaces = [],            // [{ label, text, historyOnly? }]
  ourRoots = new Set(),     // top-level names that belong to THIS repo
  ignoredRoots = new Set(), // top-level names git ignores (files AND hidden dirs)
  agentHomes = new Set(),   // first segments this tool writes INTO A USER's tree
  hasEntry = () => false,   // (relDir, name) => boolean
  resolve,                  // (relPath) => 'tracked' | 'untracked' | 'missing'
  pending = PENDING_POINTERS,
} = {}) {
  const findings = [];
  if (typeof resolve !== 'function') {
    findings.push({ level: 'FAIL', msg: 'pointer check: no resolve() supplied — the gate cannot answer its own question' });
    findings.checked = 0;
    return findings;
  }

  const cited = new Set();
  let checked = 0;

  for (const s of surfaces) {
    if (typeof s.text !== 'string') {
      // NAME what could not be read. A caller that filters unreadable surfaces out
      // first hides its own scope gap — the silent narrowing this family of gates
      // exists to catch, committed by the gate's own wiring.
      findings.push({ level: 'SKIP', msg: `pointer check could not read ${s.label}` });
      continue;
    }
    const seen = new Set();
    for (const tok of pointerCandidates(s.text)) {
      if (seen.has(tok)) continue;
      seen.add(tok);
      const first = tok.split('/')[0];
      const norm = normalise(tok);

      // AN AGENT INSTALL HOME NAMES THE SCANNED PROJECT'S TREE, NEVER OURS. Checked
      // FIRST: .claude/ and .agents/ are gitignored here AND are the paths our shipped
      // prose names in the USER's project, so the gitignored branch would otherwise
      // FAIL on a correct citation. Matched on the EXACT first segment (or a full
      // prefix), never a bare startsWith — `.claude-plugin/plugin.json` is OURS and a
      // loose prefix test would swallow it.
      if (agentHomes.has(first) || agentHomes.has(norm) || [...agentHomes].some((h) => norm.startsWith(h + '/'))) continue;

      // A GITIGNORED ROOT IS THE SHARP CASE, decided WITHOUT resolving: from any other
      // machine "gitignored" and "does not exist" are indistinguishable, so such a path
      // was never durable — not even on the day it was written. That is why this branch
      // also binds a history-only surface, where the ordinary resolution check does not.
      if (ignoredRoots.has(first)) {
        cited.add(norm);
        checked++;
        findings.push({
          level: 'FAIL',
          msg: `${s.label} cites \`${tok}\`, which lives under the gitignored \`${first}\` — not reachable from a clone. Cite the durable artefact (a commit SHA, a shipped doc) or commit the file.`,
        });
        continue;
      }

      // SCOPE, two independent tests, either sufficient, both structural so neither is
      // circular. A repo-root-only rule SILENTLY SKIPS any token whose first segment is
      // not a top-level entry — measured here: `references/method.md` cited from
      // skills/coalwash/SKILL.md has no `references` at the repo root, so a root-anchored
      // gate drops it from coverage without a word. That QUIET skip, not a loud false
      // positive, is this room's symptom.
      const citerDir = s.label.includes('/') ? s.label.slice(0, s.label.lastIndexOf('/')) : '';
      const parentDir = citerDir.includes('/') ? citerDir.slice(0, citerDir.lastIndexOf('/')) : '';
      let base = null;
      if (ourRoots.has(first)) base = '';
      else if (citerDir && hasEntry(citerDir, first)) base = citerDir;
      else if (parentDir && hasEntry(parentDir, first)) base = parentDir;
      if (base === null) continue; // a path into someone else's tree
      cited.add(norm);

      // Published history is never fixed forward: a path correct when written is not a
      // defect now. Such a surface is checked for the gitignored case above, nothing else.
      if (s.historyOnly) continue;

      checked++;
      const rel = base ? base + '/' + norm : norm;
      const state = resolve(rel);
      if (state === 'tracked') continue;
      if (pending.some((p) => p && p.path === rel)) continue;
      if (state === 'untracked') {
        findings.push({ level: 'FAIL', msg: `${s.label} cites \`${tok}\`, which exists here but is UNTRACKED — a clone does not have it. Commit it, or cite the durable artefact.` });
      } else {
        findings.push({ level: 'FAIL', msg: `${s.label} cites \`${tok}\`, which does not resolve in this repo` });
      }
    }
  }

  // EVENT-based expiry, both directions. A declaration list nobody prunes becomes a
  // permanent hole with an author's name on it.
  for (const p of pending) {
    if (!p || !p.path) { findings.push({ level: 'FAIL', msg: 'PENDING_POINTERS entry has no path' }); continue; }
    if (!p.reason) { findings.push({ level: 'FAIL', msg: `PENDING_POINTERS declares ${p.path} with no reason — an allowlist of bare strings is a bypass with no author` }); }
    if (resolve(p.path) === 'tracked') {
      findings.push({ level: 'FAIL', msg: `PENDING_POINTERS declares ${p.path} as not-yet-existing, but it now resolves — delete the entry` });
    } else if (!cited.has(p.path)) {
      findings.push({ level: 'FAIL', msg: `PENDING_POINTERS declares ${p.path}, but no in-scope surface cites it — delete the entry` });
    }
  }

  findings.checked = checked;
  return findings;
}
