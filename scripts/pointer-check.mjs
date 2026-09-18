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
// DETECTION RULE — every step MEASURED on THIS room's own 10 ship-text surfaces before
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
//   MEASURED on this room, 10 ship-text surfaces: 695 backticked tokens with fenced
//   code stripped -> 59 survive the shape funnel -> 37 IN SCOPE -> 37 tracked, 0
//   non-resolving. Re-derive with the walk in verify.mjs; never quote these forward.
//   (The 10th surface, INPUT-CONTRACT.md, was added at findings-back: it had been
//   dropped from this walk while the config-key gate in the same file already read it,
//   an unnamed divergence between two gates over one tracked ship-text file. Its cost
//   was one citation and zero findings, which is exactly what made it worth naming —
//   the pass line read as ship-text coverage while a ship-text surface went unread.)
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
// MEASURED before choosing: exactly ONE backslash-bearing backticked token across the
// walked surfaces — `/\r|\n/.test(...)` in references/method.md, a regex literal, and
// it never reaches this rule because GLOB drops it first on the `|`. (An earlier
// revision of this comment said zero; the token was always there, hidden behind the
// filter that runs before this one — a population counted at the wrong point in the
// funnel.) So the rejection removes nothing that reaches the scope tests today.
// NAMED BLIND SPOT, not a denial: a legitimate Windows-style citation would be dropped
// unchecked. Population of THOSE today: zero.
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
//      backticked path broken across two lines is never a candidate. MEASURED on the 10
//      surfaces with an odd-backtick-count proxy: 1 line, and inspection says the proxy
//      over-counted — it is INPUT-CONTRACT.md's double-backtick span quoting literal
//      backtick and YAML-indicator characters on ONE line, not a span crossing a
//      newline. Genuine newline-crossing spans in ship-text: 0. Stated this way because
//      the proxy and the thing it proxies are not the same population, and reporting
//      the proxy's 1 as a real blind-spot hit would be the false number.
//      It is NOT zero in source comments (3 of explode.mjs's 5 citation sites), which
//      is one reason those are out of scope below.
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
//
//     TWO THINGS THAT UNIT NEEDS, stated here because it is where it will look.
//     (a) THE EVIDENCE, PRECISELY, replacing an earlier over-claim of mine that read
//     "all three cited dirs are GONE": scratchpad/cw-lab-rung2-r2 is GONE (with its
//     cited w1/attack3-manifest-path.mjs) and scratchpad/cw-lab-rung2-r7 is PRESENT
//     while its cited coord-verify/ is GONE; a third citation is a literal ellipsis
//     rather than a path at all. The finding stands — every cited ARTEFACT is
//     unreachable — but "the dirs are gone" was not the true sentence.
//     (b) A GATE POINTED AT SOURCE COMMENTS CANNOT BUILD THAT UNIT'S OWN WORKLIST.
//     Of the 5 citation sites, 3 are backticked spans broken across a newline, which
//     blind spot 2 below makes invisible: a single-line extractor enumerates 2 of 5.
//     Anyone trusting a gate-derived count there would act on 40% of the problem.
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

// SHAPE TEST FOR THE IGNORE PROBE ONLY (CWK-079). It decides which first segments a
// CALLER may DISCOVER and feed to `git check-ignore`. It is NEVER consulted by
// `checkPointers`' own `ignoredRoots.has(first)` branch, which judges every token
// reaching it regardless of shape.
//
// THE PROPERTY IS NON-LOCAL, and reading past that is the mistake this comment exists
// to prevent: a token this test REJECTS is not exempt from the check — it is exempt
// only from CONTRIBUTING ITS OWN ROOT to the set the check runs against. So a rejected
// citation is checked IF AND ONLY IF some OTHER, unrelated, shape-qualified citation
// anywhere in the surface set shares its first segment. Pinned by a two-plant pair in
// pointer-check.test.mjs. Do NOT "fix" the asymmetry by applying this test inside
// `checkPointers` too: that would silently stop FAILing a real gitignored citation that
// happens to be extensionless. Keep the wider catch; state the residue instead.
//
// WHY A SHAPE TEST AT ALL — MEASURED HERE, not inherited. Deriving the probe set from
// CITED first segments (the CWK-079 fix) removes the old existence dependence and, in
// exchange, lets a token that is not a path at all reach `git check-ignore`. On this
// room's own 10 ship-text surfaces that population is REAL and is 11 tokens / 7 distinct
// first segments: EVIDENCE=n over a, n over a, beforeBytes over afterBytes,
// alwaysBeforeTokens over alwaysAfterTokens, and two WIZARD step ratios — arithmetic and
// identifier pairs — PLUS ONE THAT IS NOT (INSPECT F2, and the earlier "6 distinct / none
// of them a directory" read as measured while covering only 10 of the 11): CONTRIBUTING's
// own TheColliery/.github/benchmarks/CoalWash/fixtures, a REAL directory that is
// shape-rejected because its last segment is extensionless and it carries no trailing
// slash. Ten of the eleven are ordinary
// name a `.gitignore` could plausibly carry, so leaving them in the probe set means one
// ordinary ignore line can FAIL a citation whose remedy ("commit the file") is
// incoherent for a ratio. (Written WITHOUT backticks on purpose: this file is not a
// walked surface today, and keeping the exhibits inert costs nothing if it ever becomes
// one — the same convention the blind-spot notes above already use.)
//
// THE RESIDUE, both directions, named rather than hidden:
//   - STILL LETS THROUGH: a token ending `/` is accepted with no check on what precedes
//     it, so a function-call-shaped token would reach the probe. Measured population
//     here today: ZERO. And the last-segment test accepts an all-digit "extension",
//     so a version-shaped token could pass as filename-shaped. Also ZERO here today.
//   - DISCOVERY-EXCLUDED: an extensionless real path with no trailing slash no longer
//     contributes its own root. Measured here: ZERO real citations lost on this tree
//     today — but state WHY, because the reason is a COINCIDENCE and not the enumeration
//     (INSPECT F2: the old wording rested this ZERO on "the 11 rejected tokens are all
//     non-paths", which is false — one of them is a real directory). The ZERO holds on
//     two independent facts, EITHER of which moving ends it: (a) that citation's first
//     segment TheColliery is not one of our roots, so the scope test drops it before the
//     ignore branch is even reached; and (b) the same segment is armed non-locally anyway
//     by README's own TheColliery/... citations, so its exclusion from DISCOVERY costs
//     nothing while (a) holds. A residue whose stated basis is wrong reads as MEASURED
//     when it is coincidental — hence both facts named, and the non-locality above pinned
//     by a test rather than described.
export function looksPathShaped(tok) {
  const t = String(tok).replace(/:\d+(-\d+)?$/, '');
  if (t.endsWith('/')) return true;
  return /\.[A-Za-z0-9]{1,10}$/.test(t.split('/').pop());
}

// DERIVE THE IGNORE SET FROM THE CITED PATHS, NEVER FROM THE CALLER'S DISK (CWK-079).
//
// THE DEFECT THIS REPLACES, measured on this room before the change: the caller built
// its probe list from `fs.readdirSync(repo)`, so the set was a listing of what the
// machine running the gate happened to have. A clean clone carries no gitignored entry
// BY DEFINITION, so on a clone — and on every CI leg — the set ran at ZERO and a
// citation into a gitignored tree fell out of scope SILENTLY rather than FAILing. Both
// halves measured here: 15 ignored roots on this maintainer box, 0 of which any
// ship-text surface actually cites, against 0 on a clean checkout.
//
// `.gitignore` is TRACKED, so `git check-ignore` answers for an ABSENT path exactly as
// it does for a present one — the PATTERN is what matters, never the directory listing.
//
// TRAILING SLASH: a `dir/`-anchored pattern does not match the bare name of a path git
// cannot see on disk (git will not infer that an absent path is a directory), so each
// candidate is fed as `name + '/'`.
//
// DEVIATION FROM THE EXEMPLAR, and it is REQUIRED here rather than a preference: the
// exemplar reads plain `check-ignore --stdin` output, where every returned line means
// IGNORED. That is unsound on any checkout whose `.gitignore` has CRLF line endings —
// git parses a blank `\r\n` line as a pattern of a lone CR, and that pattern matches
// EVERY trailing-slash path. Reproduced minimally (git 2.55.0.windows.5): a fresh repo
// whose `.gitignore` is `docs/`, a blank line and one more entry, all CRLF, reports an
// arbitrary `zzz/` as ignored at the blank line with an EMPTY pattern. This is not
// hypothetical here — this repo commits `.gitignore` as LF and `.gitattributes` asks
// for `eol=lf`, yet the working copy on this box is CRLF (board #56 checkout class),
// so the exemplar's shape measured 7 ignored roots and 10 FALSE FAILs on a clean tree.
// So the probe runs `-v` and DROPS any row whose matched pattern is EMPTY: an empty
// pattern cannot legitimately ignore anything, so such a row is a parse artefact, never
// a rule. Artefacts are RETURNED, never swallowed, so a caller can print the count.
//
// THE DROP IS FAIL-OPEN, AND HERE IS THE BOUND ON THE PROOF THAT IT IS SAFE. Dropping a
// row REMOVES a name from the ignored set, so if git ever reported the CR artefact as the
// DECIDING pattern for a path a real rule also ignores, this would discard a TRUE ignore
// and that citation would fall silently out of scope — the exact failure this gate
// exists to catch, re-introduced by its own fix. gitignore is last-match-wins, so pattern
// ORDER is the variable. ATTACKED at INSPECT across four CRLF orderings — real rule
// first, real rule after the blank, blank LAST, and interleaved blanks — and the real
// match beat the artefact in all four: the empty-pattern row appears only for paths no
// real rule matches. BOUND, stated so the next reader inherits the LIMIT and not the
// comfort: n=4 orderings, ONE git version (2.55.0.windows.5), CRLF-vs-LF only. Negated
// (!) patterns, .git/info/exclude and a global core.excludesFile were NOT exercised.
// Safe in the measured space; not proven safe universally. Widening that proof is its own
// unit, deliberately not folded into a comment-hygiene round.
//
// An unparseable `-v` row is treated as IGNORED (loud), not skipped: this gate's own
// doctrine is that a wrong FAIL names its file and token and gets investigated, while a
// dead citation falling silently out of scope is the failure it exists to catch.
export function deriveIgnoredRoots({
  surfaces = [],
  agentHomes = new Set(),
  runCheckIgnore,           // (names[]) => stdout string of `git check-ignore -v --stdin`
} = {}) {
  const cited = new Set();
  for (const s of surfaces) {
    if (typeof s?.text !== 'string') continue;
    for (const tok of pointerCandidates(s.text)) {
      if (!looksPathShaped(tok)) continue;
      cited.add(tok.split('/')[0]);
    }
  }
  // Agent homes are held out BEFORE the question is asked: `.claude/` and `.agents/`
  // are gitignored here AND are the user-tree paths our shipped prose names, so probing
  // them would FAIL a correct citation.
  let homesPresent = 0;
  const probed = [];
  for (const name of cited) {
    if (agentHomes.has(name)) { homesPresent++; continue; }
    probed.push(name);
  }
  const ignored = new Set();
  const artefacts = [];
  if (probed.length && typeof runCheckIgnore === 'function') {
    const out = runCheckIgnore(probed);
    for (const line of String(out == null ? '' : out).split('\n')) {
      if (!line.trim()) continue;
      const tab = line.lastIndexOf('\t');
      if (tab < 0) continue;
      const p = line.slice(tab + 1).trim().replace(/[/]+$/, '');
      if (!p) continue;
      const m = /^(.*):(\d+):(.*)$/.exec(line.slice(0, tab));
      if (m && m[3] === '') { artefacts.push(`${p} <- ${m[1]}:${m[2]} matched an EMPTY pattern`); continue; }
      ignored.add(p);
    }
  }
  return { cited, probed, ignored, artefacts, homesPresent };
}

// `docs/x.md:12` and `scripts/` both name a real thing; the line suffix and the
// trailing slash are punctuation, not part of the path.
function normalise(tok) {
  return tok.replace(/:\d+(-\d+)?$/, '').replace(/\/+$/, '');
}

export function checkPointers({
  surfaces = [],            // [{ label, text, historyOnly? }]
  ourRoots = new Set(),     // top-level names that belong to THIS repo
  // FIRST SEGMENTS OF CITED PATHS that .gitignore matches — never a listing of what the
  // caller has on disk (CWK-079). Build it with `deriveIgnoredRoots` above; a set derived
  // from a directory listing reads ZERO on every clean clone and every CI leg.
  ignoredRoots = new Set(),
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
