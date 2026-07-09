# Changelog

All notable changes to CoalWash are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning: [SemVer](https://semver.org/) (the version lives in `.claude-plugin/plugin.json`).

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
