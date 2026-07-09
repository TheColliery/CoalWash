# Changelog

All notable changes to CoalWash are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning: [SemVer](https://semver.org/) (the version lives in `.claude-plugin/plugin.json`).

## [0.1.0-beta.10] - 2026-07-10

Moves CoalWash off the advisory request channel entirely and onto the Stop hook's blocking enforcement channel — the same mechanism `rot-canary` already proves daily on this machine. Engine tests 171 → 193.

### Changed
- **ROUND 4 POSTMORTEM: the advisory channel itself was the last-hop failure.** A live transcript showed the SessionStart directive AND the beta.9 per-turn bar BOTH delivered to a sonnet-tier main session — delivery proven twice — yet the agent served a greeting and ignored both. Root cause: `UserPromptSubmit` context is a REQUEST channel — advisory, and an agent (especially a weaker tier on a no-tool turn) is free to ignore it. `rot-canary`'s `Stop` hook lands every time on this same machine because Stop has BLOCKING semantics (the harness holds the stop until the reason is addressed) plus question-box form (a human presses a button — no model-discipline dependence). CoalWash now rides that exact mechanism: SessionStart stays the silent measurement chokepoint; Stop is the one and only place anything gets surfaced or authorized.

### Removed
- **The beta.8/9 per-turn `UserPromptSubmit` bar** — the `hooks.json` registration and its conductor branch. Superseded same-day by the round-4 live-test evidence above; retired outright, not throttled further.

### Added
- **`Stop` hook — the enforcement branch** in `hooks/coalwash-conductor.js`: a structured `{decision: 'block', reason}` JSON write (the CoalMine `rot-canary` exemplar), not plain `console.log` — that structure is what makes Claude Code hold the stop and hand `reason` back to the agent as something it must address, instead of a passive context line it was always free to ignore. `stop_hook_active` is checked first, same as `rot-canary`, so CC re-invoking Stop after the agent responds can never loop.
- **Once-per-crossing edge semantics** (`caliper.mjs`: `recordCrossing` / `sanitizeCrossing` / `consumeCrossing`, `BAND_RANK`). A band RISE (new rank above the previous one) arms exactly one pending crossing at SessionStart; a fall to LEAN clears it outright; a same-or-falling band leaves an existing pending crossing untouched (two SessionStarts at the same band are one crossing, not two). The Stop hook consumes a crossing the instant it surfaces it — ask or force — never on a later "the user picked X" signal, since no CLI exists for the agent to report that back. An ask fires once per crossing; picking "later" dismisses it until the next rise. There is no snooze in the Stop path — SessionStart's existing `setSnooze` remains its own separate self-throttle for the PLUMP/OBESE gauge nudges, unchanged by this release.
- **`ทำ`/`later` two-button Stop-hook ask** for a PLUMP/OBESE crossing, or a FULL crossing whose auto-run authorization is suppressed: names the crossing band, the fat estimate, and the `exercisePerBand`-configured exercise for that ceiling; "later" defers to the next crossing — never silently forever.
- **`forceMode` config key** (`auto` \| `ask` \| `off`, default `auto`) — governs only a FULL+economical crossing at Stop. `auto` = standing-consent auto-run of the free mechanical Quick pass (the `rot-canary` `autoFixMode` model): numbers still shown every fire, every DELETE/MERGE still waits at the human gate. `ask`/`off` both degrade to the same ทำ/later ask as any other ceiling — FULL awareness is never suppressed, only the auto-run authorization.
- **`exercisePerBand` config key** (`{plump, obese, full}`, each `quick` \| `full`, default `{plump: quick, obese: full, full: full}`) — the exercise the Stop-hook ask offers per ceiling.
- Tests 171 → 193: `caliper.test.mjs` gains the edge-crossing coverage; `conductor.test.mjs` gains hermetic spawn tests for the new Stop branch (asserting the structured block-decision output, the `stop_hook_active` loop guard, and the once-per-crossing consume behavior).

## [0.1.0-beta.9] - 2026-07-10

Hotfix to beta.8's per-turn FULL bar — one directive string in `hooks/coalwash-conductor.js`, no engine changes.

### Fixed
- **The bar's blanket sibling-yield clause was a structural mute, not a graceful defer.** A live round-3 test proved delivery in-transcript (the SessionStart directive and the per-turn bar both fired as designed), but CoalTipple fires every turn by design and CoalBoard fires on every Thai-script prompt — so the clause's "yield when a sibling advisory fires" condition was true on every turn for a Thai-typing user, permanently muting the bar even though the agent obeyed the shipped contract exactly. Fixed: maintenance now yields to the user's actual ACTIVITY, never to a sibling advisory's mere presence — the background spawn IS the complete yield; the one carve is CoalBoard actually **convening** this turn (its consent question-box going up), which defers the spawn one turn at zero cost (the bar repeats next turn regardless).

## [0.1.0-beta.8] - 2026-07-10

Reverses beta.7's `Notification`-event OS announce on its own lab measurement (a 142-transcript sweep of this machine found the event never fires here), replacing it with the blueprint's original answer: a persistent per-turn FULL directive that re-injects on `UserPromptSubmit` until the store is cleaned. Engine tests 164 → 171.

### Removed
- **The beta.7 `Notification`-event OS announce.** Lab-measured dead on this machine: a fresh dogfood session confirmed the FULL branch's session-scoped marker was written, but a 142-transcript sweep found **zero `Notification` hookEvents ever fired here** — the CC mechanism is real per its docs, it simply has no surface on the desktop app this machine runs (docs-true, fires-never — the platform-churns lesson in a new coat, not a bug in the mechanism itself). Removed: the `hooks.json` `Notification` registration, the marker write/consume path, the `handleNotification` handler, and the OSC-777 `terminalSequence` emission.

### Added
- **Persistent per-turn FULL bar on `UserPromptSubmit`.** SessionStart now unconditionally caches its computed verdict (`recordVerdict` — runs on every band, so a LEAN result immediately overwrites a stale cached FULL) instead of relying on the removed one-shot side-channel. A new `UserPromptSubmit` branch reads that cache (`sanitizeVerdict` — hot path: no discovery, no `measureEntries`, a single state read) and re-injects the FULL standing directive every turn while the store is FULL + economical + the cached verdict is fresher than 24h (`VERDICT_MAX_AGE_MS`). Same plain-stdout context-injection channel the shipped CoalBoard/CoalTipple conductors already use on this event — CoalWash joins it, not a new delivery mechanism. The directive tells the agent to SPAWN the free mechanical Quick pass as a background subagent (never inline-before-the-task) and to yield silently — no surfaced "conflict" — whenever a CoalBoard or CoalTipple conductor directive also fires the same turn (CB > CT > CW, the bottom rung of the shipped arbitration frame); yielding costs nothing because the bar repeats next turn for free. Honest ceiling: flipping `coalwashMode` off/manual mid-session can leave one stale nag firing for up to 24h until the next SessionStart re-stamps and corrects it — silence is the fail-safe side of the guard, never a stuck-on nag (`sanitizeVerdict` collapses a malformed, stale, or future-clock cached verdict to null).
- **`caliper.mjs`: `recordVerdict` / `sanitizeVerdict` / `VERDICT_MAX_AGE_MS`** — the cache-write and cache-read halves of the per-turn bar above, plus its 24h staleness bound. Tests 164 → 171.

### Changed
- **Doc sweep: every README/reference claim naming the removed `Notification`/OS-announce channel realigned** to the per-turn bar (README's Compatibility section, `platform-cc.md`'s conductor wiring line, and the SECURITY.md/CONTRIBUTING.md hook descriptions — `hooks/coalwash-conductor.js` now branches on two registered events, SessionStart and UserPromptSubmit, not one).

## [0.1.0-beta.7] - 2026-07-09

Fifth same-day hardening pass: the growable-full band fix the beta.6 live dogfood run surfaced within the hour (a freshly-cleaned, all-muscle store landed FULL on the old flat absolute-cap instead of LEAN), a user-visible channel for the FULL force-run announce (closing the last-hop visibility gap the same live test exposed — the conductor injected the announce correctly, but the receiving agent never surfaced it), the engine primitives for a global-scope lock/keeps pair on shared governance files (contract wiring follows), and the outer-only human-gate + headroom-quiet reconcile from the same-day design pass. Engine tests 148 → 164.

### Added
- **Growable-full band verdict.** Once a lean floor is stamped, FULL's soft trigger is `leanFloor + fatBudget` (a fixed allowance above the measured floor) instead of a flat capacity percentage — the ceiling now rises WITH legitimate muscle growth, so a gate-passed clean never leaves an all-muscle store stuck FULL. Before any floor is stamped (bootstrap — a store's first run), FULL keeps the absolute-cap heuristic as an upper-bound guess. The true, floor-independent **hard machine-capacity ceiling** stays as a separate, rarer trigger — firing on it now means muscle outgrew the machine, not fat to wash, and the advice is externalize/split, never wash-harder.
- **User-visible FULL announce**, where the platform exposes a notification channel the agent doesn't have to relay itself (Claude Code: the `Notification` hook event → a terminal OS-notification sequence) — additive to the existing agent-context injection, never a replacement. Platforms without such a channel keep agent-context-only delivery (documented degrade, not parity).
- **Global-scope lock + global keeps store — engine primitives** for shared governance files (e.g. `~/.claude/CLAUDE.md`) that every project's class-B discovery pulls in: a global lock beside the per-project one and a machine-wide keeps store, both landed and hermetically tested. HONEST STAGING: the contract wiring that marks global-scope actions and consults/records the global keeps is a FOLLOWING pass — until it ships, cross-project safety on shared global files rests on the external-writer guard (which already aborts + rolls back any concurrent foreign write).
- **Receipt "unknown" degrade:** a gate-FAIL receipt with no drop count now reads `unknown` instead of a bare `?`.

### Changed
- **Human gate is outer-only.** The Full-tier consent ask (step 2 — already naming the target store) IS the delete/merge gate; `deletesApproved` is set on the strength of that one consent, never a second mid-run y/n. The terse flagged list is now a programmer-opt-in surface — available on request, never a mandatory blocking gate. `apply.mjs`'s code-enforced refusal of ungated deletes is unchanged; what moves earlier is only WHEN the flag gets set.
- **Receipt-only reporting.** The receipt is now stated as the only pushed post-run output; the itemized record (WAL journal, `keeps.json`, snapshot) is a disk pull-surface a programmer can inspect, never narrated into the run — pushing item-level detail was inviting the same keep-fat meddling the outer gates exist to avoid.
- **method.md: spawn contracts are template-only.** Every sub contract this skill spawns (the outsider flag-pass, the post-merge claim-strength diff, any future reconcile pass) must be lifted verbatim from its template with only the placeholders filled — composing a fresh prompt is now named a contract violation, closing the gap that let both benchmark-day outsider prompts get hand-composed despite the template already existing. Plus: the outsider deliverable is now an incremental file (appended per file-group, final message = path + totals) instead of one long emission; a stalled outsider is resumed for a compact re-emit rather than re-spawned; stores above ~150 files/~500KB now partition across multiple outsiders by directory.
- **SKILL.md/README band-semantics text** rewritten to the growable-full model + the two-pillar trigger doctrine (Memory-BMI and the machine-capacity ceiling are the only triggers; time/age is never one).

## [0.1.0-beta.6] - 2026-07-09

Fourth same-day hardening pass: three new fidelity-gate classes, a keep-verdict store that ends repeat-adjudication fatigue, state-store self-maintenance, a merge/fold discipline for the one thing the mechanical gate cannot see — claim-strength drift — plus five transactional-apply guards, each porting a classic storage-tool disaster. Engine tests 102 → 148.

### Added
- **Fidelity gate: 3 new structured-token classes** — `quote-drop` (a quoted span dropped), `number-drop` (a numeral dropped), `codespan-drop` (an inline code span dropped) — joining the existing wikilink/date/version/link/frontmatter-key classes; ANY drop still blocks the apply until restored or explicitly human-approved.
- **Keep-verdict store** (`.claude/coalwash/keeps.json`, `[{target, reason, date}]`): an insider-adjudicated keep is recorded once and the outsider's contract is handed the list on every later run — a target already kept is not re-flagged without new evidence. The house metaphor: the outsider is a stranger who may challenge a hoarded item, never delete it; the resident answers with a reason, not a feeling, and a settled answer sticks.
- **State-file orphan prune**: the caliper state (`~/.claude/.coalwash-state.json`) drops a tracked project's entry once its path no longer exists, on the next state read — closes the item queued 2026-07-09 (beta.2 era); fail-silent, no new config key.
- **BMI floor read-sanity**: the stored lean-floor value is range/type-checked at state read, degrading to "no floor yet" on a corrupt or out-of-range stamp rather than feeding a bad number into the band verdict.
- **External-writer guard** (`applyPlan`): every rewrite/delete/create target is re-read immediately before its mutation and byte-compared against the plan's recorded baseline — pass the scan-time `expectedOrig` and the guard covers the whole scan→consent→apply window; ANY foreign change (cloud-sync client, external editor, another agent) aborts the transaction via rollback. Ports the WHS KB946676 / dedup co-writer class.
- **Snapshot verified at creation**: every snapshot copy is read back and byte-compared against a fresh source read BEFORE the destructive phase — a bad snapshot aborts while nothing has changed. Ports the GitLab all-backups-dead class.
- **Own-artifact retention**: apply-preflight sweeps completed-transaction snapshots beyond the newest 3; a dangling/incomplete transaction's snapshot is NEVER swept; an unreadable or newer-schema journal freezes the sweep entirely. Ports the ReFS thin-pool leak class.
- **Flag-not-rewrite for unparseable targets**: a NUL-bearing or unclosable-frontmatter file is FLAGGED and excluded from rewrites (the run continues on the rest); deletes keep the stricter pinned refusal. Ports the e2defrag rewrite-what-you-can't-parse class.
- **Artifact schema-version gates**: the WAL journal (field `version`) and `keeps.json` (field `v`) are version-stamped — an artifact written by a NEWER CoalWash is read-only to an older one, and recovery refuses fail-closed. Ports the XP-deletes-Vista-restore-points class.

### Changed
- **Merge/fold discipline.** An absorbed block must carry its source facts near-verbatim — compression must never change a claim's strength (an "all fixed except 2 deferred" folding into "all fixed" is a regression, not a tidy-up). Every accepted merge now gets a second, retasked before-vs-after outsider check for claim-strength drift before it applies (same zero-context pattern as the Full-tier outsider); `localOnly` or a no-spawn platform flags the merge for manual review instead of skipping the check.
- **Consent asks name their target.** The Full-tier consent and the human delete-gate now NAME the store being washed (path + measured size) — consent is always to a named target, never an ambient yes (the wrong-target incident class).
- **Plain-format invariant stated.** README now states what was true by construction: plain markdown in, plain markdown out — every artifact CoalWash writes (snapshots, WAL journal, `keeps.json`) is a plain file readable without the tool. PRIVACY.md's local-files inventory gains the `keeps.json` keep-verdicts entry.
- **Doc accuracy sweep:** the fidelity-gate class enumeration in SKILL.md/README extended to match the code (the 3 new classes, plus the previously-unlisted `link-drop` class); the SKILL.md Honest-frame callout now points to the canonical list (step 3) instead of repeating it, so the two never drift apart again.
- **Scope boundary made explicit — the four washability tests.** A wash target must be a local file · user-owned · PROSE · ACCRETED; failing any one = never-wash even though it rides the session payload (skills/commands/hooks/agent-definitions = programs · configs/state/locks/journals = machine-parsed · other tools' artifacts · vendor-installed products). Discovery already excludes all of these by construction; the SKILL.md Hard Rules now state the boundary so scope can never drift onto them (lint/health of the excluded classes belongs to CoalMine/CoalLedger).

Also verified this round — pinned by new tests, no code gaps found: symlink-skip discovery (G1) · corrupt-state conservative path (G2) · never-wash-own-artifacts (G4).

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
