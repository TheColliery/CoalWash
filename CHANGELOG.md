# Changelog

All notable changes to CoalWash are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning: [SemVer](https://semver.org/) (the version lives in `.claude-plugin/plugin.json`).

## [0.1.0-beta.5] - 2026-07-09

Third **CoalBoard dogfood** (nasa), same day — two honesty findings on top of beta.3's own fix: beta.3 corrected the claims at their PRIMARY location (SKILL.md + the README frame) but left the identical phrasing stale everywhere it was repeated — a "say it once" miss, not a new bug class.

### Changed
- **[MED honesty] "zero fact-loss proven by code" — remaining unscoped copies matched to the SKILL.md/README-established wording.** The mechanical gate proves zero **structured-token** loss only (wikilinks, dates, versions, link/URL destinations, frontmatter); a load-bearing **prose** fact is out of its scope and rests on the paid semantic reviewers + the human gate. Corrected wherever the bare "proven by diff, not hoped" phrasing — no structured-token scope named — still stood.
- **[MED honesty] `localOnly`'s "no spawned sub EVER receives memory content" absolute reworded to its real enforcement level.** SKILL.md's Hard Rules already carry the honest version (beta.3): a MODE the run contract honors, not an OS/code guarantee — the flag's own integrity is code-enforced (the merge-protection in `config-load.mjs`: a project cannot weaken a global `localOnly:true`), but the no-spawn *behavior* is contract-enforced by the agent honoring SKILL.md, not by a sandbox or hook. The same unhedged "ever" absolute stood wherever it was repeated outside SKILL.md; reworded to the same honest framing.

Removes overclaim, adds no new guarantee: the fidelity gate, the human delete-gate, and `localOnly`'s merge-protection are unchanged — only the wording now matches what the code actually proves, everywhere the claim is repeated, not just at its first mention. Credit: the user's CoalBoard nasa audit, 2026-07-09.

### Fixed
- **[LOW process] beta.4 shipped with no CHANGELOG entry** — backfilled below, reconstructed from git (the same class CoalLedger backfilled today).

## [0.1.0-beta.4] - 2026-07-09

*(Backfilled 2026-07-09 — shipped with no CHANGELOG entry; reconstructed from git, `v0.1.0-beta.3..v0.1.0-beta.4`.)*

### Fixed
- **[HIGH CodeQL] `js/file-system-race` (TOCTOU) in `ensureSelfIgnore`** (`scripts/lib/apply.mjs`): the self-ignore `.gitignore` write was exists-then-write; now an exclusive create (`{ flag: 'wx' }`, `EEXIST` swallowed — two racing writers produce identical content, both harmless). The idempotent write made the race harmless in practice; the fix closes the check-then-use window and silences the HIGH. Config-only safety fix, no behavior change.

### Changed
- **CI:** `github/codeql-action` init/analyze/upload-sarif 4.36.3 → 4.37.0 · `DavidAnson/markdownlint-cli2-action` 23.2.0 → 24.0.0 (Dependabot, SHA-pinned).
- **Dependabot config:** `github/codeql-action*` grouped into ONE PR (no init/analyze version skew — the skew that reds CodeQL, seen live) + `assignees: [HetCreep]` so bot PRs notify the maintainer at any watch level. Human still reviews + merges (no auto-merge).

## [0.1.0-beta.3] - 2026-07-09

Second **CoalBoard dogfood** (full-mirror, nasa) — the config trust-boundary + two honesty over-claims.

### Fixed
- **[MED] an untrusted project config could weaken a global safety/privacy choice.** The two-level cascade merged `{...global, ...project}` (project wins every key), so a cloned repo's `.coalwash.json` could flip a user's global `localOnly: true` → `false` (defeating the privacy opt-out) or a global `coalwashMode/updateMode: off` back on. Safety-shaping keys now merge **monotonically — safer-value-wins**: `localOnly` is OR'd (a project may make it more private, never less), and `coalwashMode`/`updateMode` let a project move only toward the *safer* end (off/quiet). This **preserves "shut off per project"** (off is the safe end, always allowed) while closing the hole. Every other key still project-wins. +4 regression tests (98 → 102).
- **[MED honesty] "zero fact-loss proven by code" over-claimed.** The mechanical gate proves zero **structured-token** loss (wikilinks, dates, versions, link/URL destinations, frontmatter) — a load-bearing **prose** fact is out of its scope and rests on the paid semantic reviewers + the human (exactly what the module comment already says). README / SKILL / honest-frame wording corrected to match the code.
- **[MED honesty] `localOnly` was advertised as an absolute code guarantee** ("no spawned sub EVER receives memory content") with no executable enforcing it. Reworded to what it is: a **mode the skill contract runs** (Quick-only, no content-bearing sub) — with the FLAG now merge-protected (a project cannot disable a global `localOnly:true`), and the no-sub behavior honestly attributed to the contract, not an OS sandbox.

## [0.1.0-beta.2] - 2026-07-09

Launch-day **CoalBoard dogfood** (nasa rigor, 3 opus blind lenses + judge) found real defects a green suite missed — the three lenses returned DISJOINT sets (the sampler + correlated-blind-spot doctrine working). All fixed here; +6 regression tests (92 → 98).

### Fixed
- **[HIGH] `recoverDangling` bypassed containment + the delete gate.** Cold-start recovery replayed `manifest.json` / journal `steps` verbatim — a poisoned `.claude/coalwash/journal.json` shipped inside a repo could overwrite/delete arbitrary absolute paths outside the memory sandbox, unattended. The journal now records the transaction's resolved `roots`; recovery realpath-and-contains every restore/delete target against them (fail-closed) and refuses + keeps the journal for a human on any out-of-root or unverifiable target.
- **[HIGH] the lock's stale-takeover could admit two holders, and `release` deleted any lock.** Takeover was `rm`-then-`create` (a missing-file window) and `release` was an unconditional `rmSync` with no owner check — a slow/suspended holder whose lock was stolen deleted the new holder's lock. Now: a per-acquire owner token, steal-in-place (no rm window; a race collapses to one-holder-or-both-defer), and `release`/takeover verify the token.
- **[HIGH] a create orphaned on a crash between write and journal.** Recovery only removed creates stamped `done`; a power-loss after the file landed but before the step persisted left an orphan that then entered class-B. Recovery now removes every create in a dangling transaction (a no-op if it was never written).
- **[MED] the fidelity gate was not interlocked at the mutation boundary.** `applyPlan` enforced the delete/pin/containment gates in code but ran the flagship fidelity check only as a pipeline step a caller could skip — contradicting "proven by code, not promised by a prompt". `applyPlan` now diffs every rewrite original-vs-new and ABORTS on an unapproved structured-token drop (`plan.approvedDrops` carries the human's explicit approvals).
- **[MED] the fidelity floor missed link destinations and false-blocked reformats.** It never inventoried markdown-link / autolink / bare-URL destinations (a dropped `[t](url)` passed); it keyed wikilinks by the whole `Target|Display` span (a display-text edit failed the gate); and it treated `2026-07-09` and `9-Jul-2026` as distinct (an endorsed reformat failed). Now: URL destinations are inventoried, wikilinks key on the TARGET, and dates canonicalize to `YYYY-MM-DD`.
- **[MED] `isPinned` was fail-OPEN.** A read error, or `pinned: true` beyond the 4 KB read window, returned not-pinned → an "untouchable" file became rewritable/deletable. Now fail-CLOSED (65 KB window; a read error or an unclosable frontmatter counts as pinned).
- **[MED] the rules-tree walk was unbounded by directory count.** `RULES_FILE_CAP` counted only `.md` files, so a deep/wide tree with few `.md` files traversed uncapped every SessionStart (Phoenix #3). The directory traversal is now capped too.
- **[LOW] a partial rollback reported as clean.** A restore failure inside `rollback()` was swallowed and the transaction still marked `rolled-back`; a cold-start recovery then cleared the journal over a mixed on-disk state. A partial rollback now reports `rolledBack: 'partial'` and marks the journal `rollback-failed` (not auto-cleared).
- **[LOW] discovery was fail-OPEN on an unresolvable root** (parity with the write path's fail-closed containment): an unresolvable home/project root now drops out instead of falling back to a lexical path.
- **[LOW] doc:** the README `coalwashMode` row noted `manual` as fully silent; clarified that the self-update nudge is orthogonal (its own `updateMode: off`).

## [0.1.0-beta.1] - 2026-07-09

First public beta — the code-core engine plus the orchestration skill.

### Added

- **Engine (code-core, zero-dependency ESM):** `class-b.mjs` per-platform class-B discovery (Claude Code adapter; read-only, realpath-and-contained) · `caliper.mjs` footprint measurement, 4-band Memory-BMI verdict (LEAN/PLUMP/OBESE/FULL), deterministic economic break-even, lean-floor/stamp/snooze state · `fidelity-gate.mjs` mechanical zero-fact-loss gate (wikilinks/dates/versions/frontmatter inventory diff + encoding-corruption tripwires) · `apply.mjs` transactional apply (exclusive lock, marked snapshot, fsync'd WAL, atomic writes, deletes last, wholesale rollback, code-enforced human gate on deletes, `pinned: true` refusal) · `receipt.mjs` plain terse numbers block.
- **SessionStart conductor** (`hooks/coalwash-conductor.js`, Phoenix-13): the chokepoint gauge — silent on LEAN, band nudges with snooze, FULL force-run armed only by the shown break-even numbers; kind-1 self-update scheduling.
- **Skill** `skills/coalwash/SKILL.md` — the lean orchestration contract over the engine (Quick mechanical → consent-gated semantic Full with a zero-context outsider → fidelity gate → human gate → apply → receipt), with `references/method.md` (snippets, rubric, garbage taxonomy) and `references/platform-cc.md`.
- **Commands:** `/coalwash:stats` (measurement standard-system, read-only) · `/coalwash:update` (consent-gated self-update procedure).
- **Config system:** `.coalwash.json` global + per-project cascade, schema SSoT with clamped reads, commented factory template.
- **Docs:** README, SECURITY, PRIVACY (localOnly zero-transmission mode; receipts = metrics never content), CONTRIBUTING, Apache-2.0 LICENSE + NOTICE.
- **CI:** the flock's four SHA-pinned workflows (ci · codeql · markdownlint · scorecard), dependabot, issue templates.
- **Benchmark scaffold** (org `.github/benchmarks/CoalWash/`): protocol + planted fat/muscle fixtures + mechanical `score.mjs` for the sawtooth-vs-bloat and infinity-loop fact-loss measurements.
