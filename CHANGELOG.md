# Changelog

All notable changes to CoalWash are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning: [SemVer](https://semver.org/) (the version lives in `.claude-plugin/plugin.json`).

## [0.2.0-rc.3] - 2026-07-16

Estate-hardening batch on the 0.2.0 line — the class-A ULTRA/RE-TIER machinery gains two incident-mined loss-class guards (#57d, #58), a bounded per-run work-limit, a knee-grounded dig-gauge recalibration, and role-memory discovery. Still `-rc` (internally hardened, field-unproven). Every item ships with hermetic tests (564 → 576).

### Added
- **runBudget — a per-run work-limit on the ULTRA session loop (the one unbounded axis)** (`estate.runBudget` = `maxSessionsPerRun` def 25 · `maxBytesPerRun` def 500 MB). The loop STOPS at a completed session-unit boundary once either limit is reached — never mid-unit (each unit is an independent copy-verify-delete tx, so a stop leaves ZERO partial); the report says "archived N/M — run again for the rest" and a second run continues. RE-TIER carries no runBudget by construction (ONE atomic tx, not an incremental loop; its work is bounded by the wizard-gated store roster — the named divergence lives in `retier.mjs`). Senior: SQLite `incremental_vacuum` / an SSD's bounded-burst GC.
- **#57(d) cloud-placeholder read-poison guard** (MASTER-LOSS-TAXONOMY #57, 4th member) — before trusting a source read as ground truth for a copy-verify-then-delete (estate WARM path) or a rewrite (`applyPlan`), a shared `isCloudPlaceholder` metadata sniff (never a content read) fail-closes on a dehydrated OneDrive/iCloud stub (a `size>0`, `blocks===0` file that returns self-consistent stub bytes, blinding the external-writer guard). **Platform-calibrated:** Node reports `Stats.blocks===0` for EVERY regular file on win32, so the blocks signal is DISABLED there (it would false-CRUSH every file) — a documented best-effort no-op on Windows (a native reparse-attribute read is the upgrade path, swappable at the two injectable call sites), CORRECT on POSIX where `blocks` is real.
- **#58 deletion-unaware time-travel-restore advisory** (MASTER-LOSS-TAXONOMY #58) — `estate-search`/`estate-restore` now cross-check recovered content against the tombstone registry (keeps.json anchors + the bins' death-log) and LABEL a result whose wording overlaps a gate-adjudicated cut ("⚠ later-removed? verify against the current live store"). Advisory only — recovery still works, the signal never blocks; opt-in (the CLI builds the registry, a direct caller passes it).
- **Role-memory discovery (#22)** — `discoverClassB` now also returns `roleMemories`: the native-subagent `agent-memory/<role>/` stores (index + siblings), reported PER-STORE so gauge/wash/stats SEE them. Nested-habitat: a role store loads into a SUB when the role spawns, not the main every session, so it is a SEPARATE tier — never folded into the main's always-loaded footprint (the main gauge/BMI/force/break-even stay byte-identical with or without role dirs). Promotes RE-TIER's store enumeration up to the central discovery layer; unlocks (does not build) the docketed #55 cross-store detector.

### Changed
- **dig-gauge recalibration — knee-grounded, not %-of-window** (`estate.digCrush` defaults: singleFileTok 100000 → **35000** · pileTok 150000 → **58000** · fileCount 8 → **6**; all within the existing clamps, no schema change). The byte/4 `~est` under-counts a real Read ~1.7× (CC #20223 line-number overhead), and long-context degradation has an ABSOLUTE knee ~32-100k tok (NoLiMa/Chroma) a 1M-window model does not move — and CT can delegate a dig to a 200k worker, so the gate targets the SMALLEST fleet window. method §10a gains the free relative layer (weigh the verdict against the platform's own `<system_warning>` remaining-budget signal) + a Thai under-count flag.
- **dig-index record-weighting (#6)** — the searchable index (topEntities + firstUserLine) is now explicitly built from `text`/answer content-parts ONLY; a `thinking` part is de-weighted to zero (search noise), read by the content-part `type` stamp. Index/search quality only — treatment stays whole-file byte-identity.
- **externalize advisory → a hand-move TEMPLATE (#21)** — the FULL(externalize) advisory (`ask.mjs`) now renders the cluster → destination → pointer steps (CoalWash NEVER auto-moves muscle; the write-path airbag snapshots the hand-move; the CoalPortal memory→durable-file precedent). SKILL body gains the estate type-map rail (classify by structural stamp, unknown → skip+REPORT); method §10 gains the full stamp table + cross-platform richness note.

Tests 564 → 576 (+12: #57d ×4, #58 ×2, runBudget ×2, role-memory ×2, dig-index-weighting ×1, externalize-template ×1; dig-gauge threshold tests re-pinned to the new priors). SKILL body 19,409 → 19,613 ch (+204, the type-map rail; the ratchet holds under ~19,600). verify PASS, `plugin/` dist rebuilt. AUTO-tier semantics (quick/caliper/conductor/ask asks) unchanged except the dig-gauge config defaults.

## [0.2.0-rc.2] - 2026-07-16

Continued internal wear-hardening on the 0.2.0 line (feature-frozen; still `-rc` = internally hardened, field-unproven). A standing mutation-test layer over every safety gate + a forward-looking platform gate on the estate/retier engine. No user-facing capability change.

### Added
- **Gate-liveness harness (`scripts/lib/gate-liveness.test.mjs`)** — mutation-tests all 8 safety gates. Per gate: the exact violation it guards is constructed and the REAL engine must BLOCK it (the DEAD-GATE SENTINEL — a gate whose disabling leaves the suite green is a finding, not papered over), THEN the gate's decisive check is neutralized test-side (a scoped `fs`/`Buffer`/`path`/`zlib` patch, or the gate's own sanctioned bypass) and the SAME violation must now land the loss (proves the gate — not something downstream — is load-bearing). Ports mehvetero/move-test-gen's L3 mutation idea back, and makes the GitLab-2017 / Pixar-1998 "the safety net was never exercised" lesson a STANDING test; automates the MED-1 dead-guard class by construction. Gates covered: fidelity · MOVE-VERIFY · verifySnapshot · copy-verify-then-delete · the delete-boundary TOCTOU re-verify (the `8b7fc71` fix) · containment · chJournalGuard · external-writer guard · #56 empty-only prune. **All 8 proved load-bearing — 0 dead gates.** Self-verified: sabotaging fidelity / the TOCTOU re-verify / chJournalGuard in the engine each flipped exactly its own harness test RED (the sentinels bite; no false-pass). Every neutralization is TEST-SIDE only — the production engine ships ZERO test-hooks; MOVE-VERIFY (pure in-function logic, no cleanly patchable primitive) is proven by a REAL-violation on the exported function (both arms), standing alone.
- **Platform-layout gate on the estate/retier engine (armor #2)** — `estateUltraScan` / `runEstate` / `retierScan` / `runRetier` now gate on `detectPlatform()` at entry (one-flock with `discoverClassB`, sharing a new `UNKNOWN_PLATFORM_FLAG` single-source-of-truth constant): a non-Claude-Code home is an explicit conservative no-op (nothing scanned, the verbatim conservative flag surfaced), never a CC-layout-assumed scan. Keyed on the real signal — creating `~/.claude` flips it back to scanning — not a hardcode.

### Fixed
- **Removed the `tamperForTests` fault-injection seam from production `retier.mjs`** (parameter + 3 call sites): a corruption-injection hook — even inert (null-default, CLI-unreachable) — must not ship in an engine that moves/deletes real bytes, and it was inconsistent with the other 7 gates (neutralized purely test-side). The seam's three tests were re-proven test-side: MOVE-VERIFY on the exported function (both arms), the external-writer rollback via the blessed `gzip` benign-injectable, and a `rollbackFromSnapshot` unit test; the two seam-ONLY integration paths (a corrupted `indexNew` / a post-apply anchor loss — un-producible with real data, since demotion moves whole lines verbatim and the strand-guard protects sole-home anchors) were dropped, their detection already unit-covered. Sweep confirmed: production `scripts/lib/*.mjs` now carry zero test-hooks.
- Two CodeQL alerts in `scripts/lib/retier.test.mjs` cleared: a `js/file-system-race` (a check-then-use TOCTOU — the wizard-only hooks grep now reads the file-type from one `readdirSync({ withFileTypes: true })`, no separate `statSync`) and an unused `collectStores` import.

Tests 544 → 554 (+9 gate-liveness, +2 platform-gate, +1 `rollbackFromSnapshot` unit; −2 seam-only integration tests retired with the `tamperForTests` seam). The **dry-run pre-apply armor was RECONSIDERED and SKIPPED**: the snapshot + whole-run rollback + the interleaved external-writer guard already guarantee no partial-survivor across all three destruction campaigns, and every validation gate (containment · sniff · pinned · keeps · fidelity) already fails BEFORE the snapshot (zero mutation, zero snapshot I/O). A dry-run would only make a doomed run — which the campaigns show essentially never happens — fail marginally cheaper, and cannot pre-check the external-writer RACE or an execute-time IO failure anyway. It buys efficiency, not safety (rollback already owns the safety outcome) → over-harden, deliberately not built (skill-authoring §2/§3). Wear round over the new code: DRY (the harness bites precisely, the platform gate keys on `detectPlatform` not a hardcode, no primitive patch leaks between tests). verify PASS, `plugin/` dist rebuilt.

## [0.2.0-rc.1] - 2026-07-16

**MINOR** — three new class-A / class-B memory systems. The version leaves the 0.1.0 rc cycle (new capability = MINOR); it stays `-rc` because the new code is internally wear-hardened but field-unproven — a forward move to the 0.2 line, never a beta regression.

### Added
- **RE-TIER (wizard 4th door)** — merge every class-B store → redistribute by a ± envelope; overflow DEMOTES down the ladder (index line → `retier-overflow.md` → estate archive), lossless byte-identical, and NEVER summarizes or deletes under pressure (ทิ้ง/discard exists in no treatment-table cell). Two mechanisms separated by construction: the envelope (config `retier`, target 4125 tok = the cross-AI Tier-1 always-loaded median AND ~2% of the 200k binding envelope; an arm/disarm/headroom band, no flap) decides TIER PLACEMENT only; a CODE treatment table (governance/machine-parsed/unknown = skip-only, case-insensitive name identity) owns TREATMENTS. Gates reused: `applyPlan` tx (snapshot/rollback) + MOVE-VERIFY + #54 anchor-diff + #55 report-only cross-store reconcile + an N=20 top-anchor survival probe. Wizard-only; `retier-run` refuses under the arm line ("dead zone, no action"). CLI `retier-scan`/`retier-run`.
- **dig-gauge (ULTRA trigger #2)** — a pre-READ tollgate (`cli.mjs dig-gauge <paths>`): pure `fs.stat`, zero content into context, fired between a search's hit-list and the first Read. CRUSHING when a single candidate is >= 100k tok, or the pile >= 150k tok, or >= 8 files (config `estate.digCrush`, clamped priors from the 200k-envelope minimax) -> offer ULTRA once, never blocks (declining proceeds to the raw dig). Pre-read because context-token burn is multiplicative: re-carry every turn, per-prefix fan-out, compaction spiral.
- **Class-A / class-B fidelity-note split** — SKILL note 1 (structured-token fidelity) is now scoped CLASS-B only; a new note 3 states the class-A byte-identity contract (never semantic-edit a transcript; copy-verify-then-delete; the one seam where the class-B gate re-enters = RE-TIER's hot-index rewrite).
- **Loss class #56 (VERIFY-SCOPE / DELETE-SCOPE MISMATCH)** added to the master taxonomy — found + closed by the wear campaign.

### Fixed (wear campaign, 2 rounds, loop-until-dry)
- estate over-delete (#56, HIGH): `estate-archive.mjs` used `rm -rf <sid>/` gated only on enumerated-deletes-succeeded; now `pruneEmptyDirs` rmdir-if-empty (delete_scope == verified_set), un-enumerated survivors kept + surfaced.
- `classifyRetier` check-ordering so a governance/program `.md` sitting in a memory dir is skip-only, never demoted off the live tree — case-insensitive (Windows/macOS ship platforms) incl. cross-agent `gemini.md`.
- survival-probe false-pass under `indexEnabled:false` (a sole-home top-anchor is kept in the live tree) · pin no longer vetoes the whole multi-store plan (filtered pre-plan) · `dig-gauge intOr` re-clamps the schema bounds. Suite 490 -> 530.

## [0.1.0-rc.3] - 2026-07-12

The well-behaved-OS-citizen relocation (series law: one namespace, no scatter). CoalWash's per-session state stops littering `~/.claude/`'s root as a scattered dotfile and moves into a namespaced, memory-anchored home — with a transparent one-time migration that deletes the old files. rc-line, PATCH-class: a defect fix (the OS-scatter mess), no new capability, migration is transparent (nothing a user relied on breaks). rc → stable resumes after this proves in the field with no further code change.

### Changed
- **State relocated to a memory-anchored, namespaced home.** Per-project session state moved from the scattered `~/.claude/.coalwash-state.json` to `~/.claude/projects/<slug>/coalwash/state.json` (riding CC's own project directory — a project dir cleaned by CC free-prunes the state with it), and the global update-check stamp to `~/.claude/coal/coalwash/`. The path DERIVES from the platform's real memory dir (class-b's `ccMemoryDir`/`ccProjectSlug`), never a fresh hardcode — an unknown platform leaves the gauge inert, writing no state. Every derived per-project path is realpath-contained to `~/.claude` and fails closed to `~/.claude/coal/coalwash/`.
- **Transparent one-time migration (the no-old-version-leftover standard, extended to the state layer).** On first read state loads from the new path, else the old-root file (LOCATION fallback); on first write the new file is written AND this project's old-root entry is deleted, the legacy file drained + removed once empty. Touches ONLY CoalWash's own prior state files, never a wildcard sweep. An rc.2-era store is preserved across the pure move (no spurious schema reset). The user config `~/.claude/.coalwash.json` is never touched (different class). A reinstall-then-reinstall no longer strands stale state.

### Fixed
- SECURITY.md path-containment wording no longer over-generalizes — the per-project path is realpath-contained + fail-closed; the fixed global stamp path is a construct-under-base with no untrusted input in it (two different, both-correct guarantees stated as one before). Corrected a `pruneDeadEntries` comment: keep-on-doubt is narrow (only a *throwing* stat keeps an entry; `existsSync` reads an offline/UNC path as absent, so its LEGACY entry can drain — safe, it is the old file's own recomputable bookkeeping, never memory content, and a wrongly-drained project re-stamps a provisional floor next session).

Tests 448 → 452 (+10 OS-citizen: memory-anchor derivation, containment escape → fail-closed fallback, migration read/write/delete, config-untouched, cross-version un-strand; −6 obsolete shared-map orphan-prune). Review lane: SHIP (0 CRITICAL/HIGH/MEDIUM — every delete is a fixed-path, own-file, lazy-on-write removal inside the sandbox; the schema reset preserves the lean-floor baseline; containment fails closed). verify PASS, `plugin/` dist byte-identical.

## [0.1.0-rc.2] - 2026-07-12

The first dogfood FIELD bugfix (rc = internal-proven; real use surfaced it). A chronically-FULL store that consumed its crossing — especially one carried across the pre-0m→0m upgrade — went permanently silent: the conductor could never re-arm, so the skill looked dead on a still-fat store. Fixed, plus the state layer joined the no-old-version-leftover guarantee. Bugfix only, no new capability.

### Fixed
- **The stranded-crossing un-strand (session-id + growth re-arm).** A consumed FULL crossing now re-arms when either (a) a NEW session opens on a still-FULL store, or (b) fat grows past the last-flagged level MID-session (the Stop-hook warp-gate already re-gauges every turn) — so a dragged single session re-offers on real growth, not only on a fresh session. The re-arm was gated to FULL only (an earlier cut over-reached to OBESE, which re-fired every session on a flat plateau — caught in review, fixed).
- **Force-then-ask on every growth (USER decision).** Each fat-growth past the flagged level runs the FREE mechanical Quick force FIRST (code, ~0 token — sweeps the certainty), THEN the wizard ask only if judgment-fat remains — never ask-only, never a throttle. Frequency mirrors the fat-growth rate: rapid growth → rapid force+ask, plateau → silent (the no-nag law: silence is "fat didn't move," never a timer).
- **State schema-version guard (no version-stale state).** The state file stamps a `stateSchema`; reading state written by an older schema migrates it — resetting only the version-SENSITIVE fields whose semantics a ruling changed (the crossing family), PRESERVING the version-STABLE baseline (the lean floor). This is the series' "self-update: no-old-version-leftover" standard extended to the state layer, so a reinstall/upgrade never carries stale crossing state (it un-strands the live pre-0m store on first read). The lean floor is the skill's "electricity" — never reset, or every upgrade would false-FULL until the next clean.

Tests 427 → 448 (session-id re-arm, schema migration, the FORCE→ASK→FORCE→ASK dictator alternation through the real hook, OBESE-plateau silence, force-never-starved / ask-never-starved). Review: SHIP (sequencer traced to a total, mutually-exclusive, non-starving state machine; one LOW = a recurring externalize reminder, safe-by-construction, comment corrected).

## [0.1.0-rc.1] - 2026-07-11

**Feature freeze.** The 0f–0p ruling wave is complete and internally proven — 53/53 lab loss-classes covered, 0/33 traps leaked, 427 hermetic tests, an adversarial review SHIP on every wave. That earns **rc**: the structure is durable (the safety floor is code-held, model-independent). It is NOT yet "live" — rc is internal-proven awaiting **field** proof (real global Claude Code use surfaces the operator-drift / last-hop-visibility class the lab can't simulate). rc → stable = a real dogfood stretch with no code change; a field bug → rc.2 (bugfix only, no features).

This release carries the two no-feature cleanups that close the beta line:

### Changed
- **SKILL.md leaned −46% (26.4K → 14.1K chars body)** per the new series law `skill-authoring.md §5` ("lean cuts TOKENS never the RAILS"): all 17 behavior-forcing rails stay in the always-resident body; the explanation (band-math derivation, analogies, worked examples, install onboarding) moved to `references/method.md` (on-demand) or the README. Verified rail-identical by an independent 5-step scenario trace, not by eye — the proof gate §5 mandates.

### Fixed
- Removed two CodeQL-flagged unused imports (`path` in `cli.mjs`, `readSnapshot` in `writeguard.test.mjs` — `js/unused-local-variable`, note-level); clears the repo's open code-scanning alerts.

## [0.1.0-beta.19] - 2026-07-11

The write-path guard (ruling 0p — the last feature before rc): the fidelity discipline stops being CoalWash-only. Every hand that writes a class-B file — the main, a subagent, any tool — is now watched, because "zero fact loss" enforced only on CoalWash's own knife is half a constraint (the store is edited by other knives daily; four header-clobbers this session were live proof).

### Added
- **Airbag — snapshot-on-first-write (`scripts/lib/writeguard.mjs`, PreToolUse on `Edit|Write|MultiEdit`):** the first write to a class-B file each session copies it once into the `.claude/coalwash/` sandbox (self-ignored, out of VCS) — the only possible undo net for gitignored governance (MEMORY.md/CLAUDE.md have none). Write-only, idempotent, fail-silent; session-event-gated cleanup (keep current, drop prior — never a clock, 0h-GUARD).
- **Seatbelt — advisory drop-detector (PostToolUse on `Edit|Write|MultiEdit`):** on a structured-token drop (link/number/quote/frontmatter — the fidelity-gate classes) it injects ONE plain advisory line naming the file + the dropped class + the snapshot path. **Advisory ONLY — never blocks, never a nonzero exit** (a deliberate deletion is legitimate; an ambient gate has no approved-drops channel, so blocking would sabotage real work). Reaches subagents natively (tool hooks fire in subs). FP scoping is honest option (ii): it fires on ANY drop with no deliberate-vs-careless classifier — an FP costs one ignorable FYI line, and the snapshot pointer turns every fire into a usable undo hint.
- **Recovery by reference (`cli.mjs writeguard-list` / `writeguard-restore`):** an agent points at which snapshot by metadata (name/session/bytes/path — never the content); CODE copies the byte-exact original to stdout (`isBareId`-contained). NO path where an AI re-authors lost content — an AI-retyped "recovery" is a hallucination-twin (lab-caught: ADD-01), a fake that looks like the original. Undo is trustworthy precisely because the bytes are the real bytes, code-moved, model-untouched.
- **Config `writeGuard`:** `on` (default) / `snapshot-only` (keep the airbag undo net, silence the advisory) / `off`.

### Changed
- Series law added — `skill-authoring.md §5` "lean cuts TOKENS never the RAILS": a SKILL.md line is a rail (forces behavior) or an explanation (moves to references); a lean pass proves rail-identical behavior by re-running the scenario, not by eye. (Our production standard for Coal\* skills, not a yardstick for others'.)

Tests 397 → 427 (writeguard unit 17 · conductor/cli/ask/config spawn tests 13 — incl. the FP-lab pins, the containment/traversal rejections, and the structural no-copy-on-non-guarded perf proof). Review: SHIP (3 INFO, all non-blocking: a named import divergence, the accepted 0o-class hook cost, the gitignored blueprint). CI-verified under a simulated tracked-files-only checkout.

## [0.1.0-beta.18] - 2026-07-11

The parcel-audit layer (ruling 0l — the immortal-bird definition): CoalWash keeps NO hand-maintained list of what counts as always-loaded memory; its list is a MIRROR of the real load list, whoever writes to it (the company auto-loads it, the user wires it, or a future platform update adds a surface — it enters by definition, no code change; a hand-kept list rots, a mirror can't).

### Added
- **L2 parcel audit (`scripts/lib/parcel.mjs`, read-only):** `verifyParcelCandidates` — an agent lists the files it can SEE auto-loaded in its own context (path + the head it observed); CODE certifies each one — realpath-resolves + contained in the home/project trees (fail-closed on symlink escape, both sides) + the on-disk head matches the observed sample (whitespace-normalized, a 24-char substance floor + a tiny-file whole-content carve). A hallucinated or never-loaded candidate can't quote a matching head, so it's rejected; fail direction is undercount (unseen = unmeasured = uncut). `compareParcelToAdapter` cross-checks the parcel against the L1 adapter's every-session set as a **drift canary** — a mismatch flags a new platform surface or adapter rot the day it happens.
- **L1 stays the every-session path (0-token); L2 is a wizard-entry / on-demand agent tool** — the module boundary is the two-layer architecture. On an unknown platform the conservative path upgrades from "verify scope manually" to propose → code-verify → human-confirm, still never auto-delete.
- **Capture-all → filter → wash order preserved:** L2 feeds MEASUREMENT only — it never feeds the knife (wash jurisdiction unchanged).

### Changed
- Durability-campaign benchmark records published (org `.github/benchmarks/CoalWash/`): the campaign-close summary (53/53 loss classes covered · 0/33 traps leaked · 33/33 Thai tripwires · 10/10 workability parity · the three standing cautions) and the model-independent framing. README Notes 1+2 reframed to the measured protocol (stop at two dry rounds + one varied-angle sweep) and the honest per-tier-matrix-pending scope; the safety-floor-is-code-held claim is the published takeaway. Trap corpus + per-trap identities withheld by design.

Tests 387 → 397 (parcel verifier: legit round-trip, head-mismatch/mid-quote/traversal/junction-escape rejected fail-closed, read-only full-tree proof, compare partitions, recall-excluded). Review: SHIP (one INFO = the already-recorded evidence-of-existence-not-proof-of-load limit; blast radius measurement-only, never the knife).

## [0.1.0-beta.17] - 2026-07-11

The true-bill spawn meter (ruling 0o-b — the user-found fleet-economics blind spot): every subagent spawned from a room re-pays that room's always-loaded parcel in full (per-prefix cache — a sub cannot share main's warm cache), so the real cost of fat is footprint × (main + every spawn). Measured live: one fat room × ~6 sub-rounds ≈ 460k tok of pure parcel in a single dev day, invisible to every meter before this.

### Added
- **`PostToolUse` spawn meter (`hooks/hooks.json` + the conductor):** matcher `Agent|Task|Workflow` (CC exact-list semantics — `Task` does not match `TaskCreate`; grounded against the live hooks docs + CoalMine's shipped matcher shape) with a pre-import first-line belt for matcher-less platforms. On each completed spawn: silently add the room's **cached** parcel figure (no re-gauge, no content I/O; missing cache = count at cost 0) to session-scoped counters in the existing state entry. **Write-only — no per-spawn output, ever** (the NOISE RULE: N spawns = N silent increments, one louder number in the same one voice). Auto mode only (manual/off = meter off — no session boundary exists there to keep the figure honest); counters reset at the once-per-session gauge heartbeat.
- **The bill surfaces through existing voices only:** `/coalwash:stats` gains "subs this session: N spawns ≈ X tok parcel" (omitted at zero) and the FULL force/escalation directives gain one clause — "This fat also rode N sub spawn(s) ≈ X tok of parcel (~est) this session" — only when N > 0.
- Nested spawns count by construction (tool-level hooks follow a sub's own tool calls; a flattened deep spawn becomes a fresh session where the gauge itself boots). Cross-room spawns bill the current room's cached parcel — a named conservative approximation.

Tests 377 → 387 (noise pins assert empty stdout AND stderr; non-spawn tools proven to create no state; manual-mode-off; the full gauge→2-spawns→directive-clause→session-reset round trip). Review: SHIP (matcher semantics grounded; contention analysis: the only losable write is one counter increment — cosmetic; class-B content untouched by construction).

## [0.1.0-beta.16] - 2026-07-11

Force restored as the free dictator tier (ruling 0m — user-caught live on the day-one store: the heavier band did LESS than the lighter one). The misapplied economic-proof gate is gone from the force leg; the proof requirement was always the PAID wizard's, never the free Quick's.

### Changed
- **Every FULL crossing (economic AND absolute-cap) force-runs the free mechanical Quick UNCONDITIONALLY** (`hooks/coalwash-conductor.js`): the day-one over-wall store now gets the ruled sequence — silent forced Quick (receipt numbers after) → shrunk below FULL/LEAN = silence → still over = the ONE wizard-escalation ask. `externalize` stays pure advisory (washing cannot shrink muscle). OBESE auto-Quick unchanged.
- **First-ask exemption (`caliper.mjs` recordCrossing):** the first wizard escalation of an episode arms on `quickTried` alone — required because a provisional-floor store has measured fat ≡ 0; the no-nag law still guards every RE-ask (re-arm only on fat growth past the last flagged level; a plateau never re-asks; a LEAN reset opens a new episode).
- **`forceAuto` directive headline** now renders the absolute-cap case honestly — "over the capacity wall (store ~X tok vs the ~Y tok wall)" — never a misleading "fat ~0" on a day-one store; the economic break-even headline is unchanged; force text states it is non-optional at FULL (the OS-maintenance model).

### Removed
- **The `forceMode` knob — force has NO off switch (user ruling: "วินโดว์ไม่เคยมีให้ปิด force ได้ และ force นี้ต้องเผด็จการเท่ากัน").** Key retired from the schema (`RETIRED_KEYS` tombstone: a legacy config carrying it validates clean and reads as nothing); factory template + all docs swept (README gained the "No force off switch — by design" callout). Consent lives in UNDO (verified snapshot · whole-run rollback · bins + `restore <id>`), and the receipt is FULL's surfacing — `coalwashMode: off` remains the skill's whole power switch.
- `ceilingAsk` (its last caller died with the knob) and `sanitizeVerdict`/`VERDICT_MAX_AGE_MS` (consumer-less; verdict numbers are re-recorded every SessionStart, so the force directive can never render stale figures) — deleted with their tests, no leftovers.

Tests 380 → 377 (14 deleted with dead code, 11 added — incl. the six-invocation day-one round-trip reproducing the live scenario end-to-end, the legacy `forceMode:"off"`-still-forces proof, and the plateau/no-re-nag pins). Review: FIX-FIRST (2 stale doc lines) → closed.

## [0.1.0-beta.15] - 2026-07-11

### Fixed
- **CI determinism — the warp-hole perf test rewritten structural (`caliper.test.mjs`):** the old "PERF GATE" gauged the LIVE repo as its fixture and asserted a wall-clock ≥3× ratio — green on the dev box (fat gitignored store), deterministically red on every CI checkout (those files don't exist there; failed all 12 matrix legs across beta.13/beta.14, unnoticed at beta.13). Now the **STRUCTURAL GATE**: a hermetic sandbox fixture + an instrumented `fs.readFileSync` proving `statOnlyFootprintBytes` opens ZERO file content (byte-correct from stats alone) while the full re-gauge on the same fixture does read content — the design claim, machine-independent, no clock. The measured dev-box numbers stay recorded as engineering data in the section comment. Verified green under a simulated CI checkout (tracked-files-only copy). No shipped-behavior change; test count 380 unchanged.

## [0.1.0-beta.14] - 2026-07-11

The authoritative 3-flow + the economics: the wizard ask moves to its ONE ruled site (FULL, after the forced Quick proves insufficient — OBESE never asks), FULL becomes the economic cut-point on top of the armed ceiling, the bins finally get fed and kept on a dual limit, and BMI is live from the moment of install. Reviewed FIX-FIRST → all findings closed. Engine tests 337 → 380.

### Added
- **Economic FULL (0g):** FULL = `breakEven.economical` on floor-relative fat, on top of the armed OBESE ceiling — `FULL ⊂ OBESE` (a tiny-fat store can never jump LEAN→FULL), latched per episode (LEAN reset clears), and the **force authorization always demands a FRESH economical proof** (numbers shown every fire — the economic-dominance clause is the band now). The fixed capacity line is demoted to the outer WALL: bootstrap `absolute-cap` (no floor yet) / `externalize` (~all muscle).
- **Bin population (0h):** every landed cut is recorded post-COMMIT into a bin, routed by the plan's `origin` (`program-cut` default → fat bin · `wizard-cut` → `store.old`). Bin sweeps run ONLY from inside `applyPlan` — never a hook, cron, or session-event age-sweep (0h-GUARD: idle days destroy nothing).
- **Dual-limit retention (0i):** SIZE-CAP (`BIN_BUDGET_STORE_MULTIPLE` 2× the store's own measured bytes — never the disk) ∧ TIME-HORIZON, whichever binds first (the journald model); era-preserving thinning first, hard cap second; the newest item always survives; doubt/weightless items are never size-evicted.
- **BMI on at install — provisional floor (0j):** the first gauge of a never-seen store stamps a provisional floor = the current footprint → BMI = 1.00 live from day one, no switch command (Single Power Button); the provisional floor never self-ratchets; the first gate-passed Full clean overwrites it (flag cleared); `capHit` + provisional → `absolute-cap`, never `externalize` (a provisional baseline cannot certify all-muscle).
- **`restore <id>` CLI subcommand (`scripts/lib/cli.mjs`):** the promised 0-token recovery door — stdout = the recovered content (redirect `> file` to keep the bytes out of any context window), stderr = ONE summary line; unknown id → exit 1 naming both bins searched; read-only, never writes to the store.

### Changed
- **Wizard escalation relocated OBESE → FULL-after-force (0f, the authoritative 3-flow):** the ONE wizard ask now lives at FULL after the forced Quick already ran this episode and the store is still over; it is checked BEFORE the force crossing (kills the silent force-loop). OBESE is auto-Quick-silent, full stop.
- **`exercisePerBand.obese` clamped to `quick`:** the schema is per-band now (`obese: ['quick']`); a legacy `obese: "full"` config reads as `quick` silently (safer-value-wins) without clobbering a valid `full:` customization. `ceilingAsk` remains solely the FULL forceMode-`ask`/`off` leg.
- Docs resynced: the stale "no dedicated restore CLI yet" claim removed from SKILL/method (the CLI is real now); blueprint §18 gains the 0j clause.

### Security
- **Bin id containment (`isBareId`, `bins.mjs`):** `restoreFromBin` rejects any non-bare id (`../x`, `..\x`, absolute, `.`, `..` → not-found) and `loadIndex` filters the same shape — so a traversal id can no longer read outside the bin dir, and a poisoned `index.json` can no longer surface or sweep files outside it (the recovery-path class: same family as beta.2's `recoverDangling` fix). Regression-tested with a planted outside-the-bin victim proven untouched.

## [0.1.0-beta.13] - 2026-07-11

The lifecycle autopilot: the code tier now sweeps structural fat on its own (Storage-Sense shape — act + one-line report, never a per-run ask), the wizard ask survives only for semantic judgment and re-arms only on fat GROWTH, and a within-session spike is caught at `Stop` through a measured perf gate. Engine tests 302 → 337.

### Added
- **OBESE auto-Quick, no ask (`ask.obeseAutoQuick`):** an OBESE crossing whose configured exercise is `quick` (the factory default) skips the blocking ask and fires a standing-consent auto-run directive — `oneLineResult`-only output, snapshot-backed, revertible. `exercisePerBand.obese: "full"` routes back through the real ask. Consent is standing via config (the `forceMode: auto` / rot-canary `autoFixMode` precedent).
- **The OBESE loop (`ask.wizardEscalation` + `caliper.markQuickTried`/`lastEscalationFat`):** once Quick can no longer reduce fat and OBESE persists, ONE wizard-escalation ask arms — and re-arms ONLY when fat grows past the level last flagged, never on a plateau, never on a timer (ask frequency tracks the fat-growth rate; the BMI edge is the sole gate). The FULL force-run backstop needs no user at all.
- **Warp-hole Stop gate (`caliper.statOnlyFootprintBytes` + `REGAUGE_DELTA_TOKENS`):** every `Stop` runs a stat-only footprint delta (measured ~0.2ms — no directory walk, no content read); only real drift past the threshold triggers the full re-gauge (measured ~7-18ms — over the ≤5ms happy-path budget, hence gated, decided by measurement). A within-session spike is now caught same-turn.
- **Shrink as a first-class wizard outcome (docs + tests):** the outsider runs ONE question — "how much of this is enough to keep?" — with three outcomes: delete / shrink / stand. A shrink (right-sizing an over-verbose muscle: wording down, fact verbatim) is mechanically a `rewrite` under the existing 0-fact-loss gate (proven by regression tests; no new gate class). The merge before/after claim-strength diff instruction now covers shrink.

### Changed
- README/SKILL/method resynced to the autopilot flow (band table, Stop-gate paragraph, wizard 3-outcome). SKILL description trimmed back under the 1024-char cross-platform cap (1019).

### Lab receipts (this release's ship conditions)
Auto-Quick trap-regression (unsupervised, code-only, seeded structural fat among 33 engineered traps): 5/5 seeds cut · pre-existing empty heading correctly survived (flag-only) · **33/33 traps intact · 9/9 semantic decoys untouched**. Stop-gate perf pinned by measurement (0.13-0.32ms stat-only vs 6.6-17.9ms full).

Tests 302 → 337.

## [0.1.0-beta.12] - 2026-07-11

The durability build (phases 1+2 of the 1e-16 ladder), verified by a full lab campaign: all 53 loss classes tested (26 measured in the wear campaign, 27 adversarial-verified through this pipeline) — 0/33 engineered traps flagged-or-cut, 10/10 washed-vs-pristine workability parity. The claim is a STRUCTURE that refuses load-bearing loss even against an adversarial corpus, not model-infallibility. Engine tests 195 → 302.

### Added
- **Band-collapse (`caliper.mjs`):** the 4-band PLUMP/OBESE/FULL ladder + time-snooze collapse to ONE hysteresis-gated ceiling — `CEILING_BMI` 1.5 arms, `CEILING_REARM_BMI` 1.2 re-arms (a Schmitt trigger replaces the clock) — plus a SEPARATE stateless machine-capacity FULL line (`absolute-cap`, person-independent, needs no floor). Growable-full invariant preserved (BMI = ratio; floor ratchets only on a gate-passed clean; capacity gate person-independent, remedy = externalize). `FLOOR_MIN_TOKENS` floor-sanity.
- **Template asks (`ask.mjs`, program-side, zero agent composition):** `ceilingAsk` / `forceAuto` / `externalizeAdvisory`. Answer-first — SessionStart is silent for band matters, Stop is the sole ask surface; every template embeds the answer-first reminder; break-even payback numbers on BOTH OBESE and FULL asks.
- **Bins (`bins.mjs` + `retention.mjs` policy):** two bins (fat / wizard-muscle) + `store.old` pull-only + breadcrumbs + Time-Machine density-thinning + death-certificate destruction, wired into the apply preflight. (Population at cut sites is not wired yet — the restore surface is complete; documented, not overclaimed.)
- **Quick-ceiling (`quick.mjs`):** `sweepResidue` (own-knife blast-zone only — kills the class-23 residue a prior cut leaves) + `stripEmptyTables` + `flagEmptyHeadings` (flag-only). Mechanical share measured 0% historically (Quick never shipped executable before).
- **Fidelity-gate classes 9 (number-precision) + 10 (evidence-anchor)** and the **keeps-gate** (pre-mutation exclusion) from phase 1.
- **Wizard primitives (`wizard.mjs`):** `neutralScan` (measurement-only, no BMI at entry) + `estimateBill` (banded, placeholder rates labeled). Managed-artifact tagging (`class-b.mjs`): byte-identical-across-roots + `managedPaths` config.

### Changed
- Docs (README/SKILL/stats) resynced to the collapsed band model. The kernel-scope note (README CAUTION + SKILL hard-rule) — high stakes, capped blast radius.

Tests 195 → 302.

## [0.1.0-beta.11] - 2026-07-10

The knife move: removes the last human pre-approval step from delete/merge authorization. Safety was never resting on that flag alone — it now rests entirely on UNDO. Engine tests 194 → 195.

### Changed
- **Delete/merge authorization is plan-sourced, not human-approved.** A delete or merge action reaching `apply.mjs` is authorized by its presence in the adjudicated plan (the insider-adjudication step already decided it) — there is no separate approval flag to set or check. Safety relocates to UNDO: every apply still snapshots (verified at creation) before the first mutation, and a whole-run rollback (kept 3 snapshots) restores everything on any failure — unchanged since beta.2, now the ONLY safety net for a cut instead of one of two. **The ruling behind the move:** per-name OK-pressing over a list of unread filenames is ceremony, not judgment — a human cannot meaningfully vet memory content by filename alone, so the old "approval" was really the human rubber-stamping the machine's own adjudication. The Windows maintenance model this series ports (Disk Cleanup, Storage Sense, defrag) never asks per-file either — it shows a number ("clean 4.2GB?") and the system is trusted; CoalWash now matches that shape exactly instead of a looser approximation of it.
- **`hooks/coalwash-conductor.js`'s Stop-hook strings and SessionStart advisories, `skills/coalwash/SKILL.md`'s Hard Rules, and `references/method.md`** reworded throughout from "human-gated"/"deletes require approval" to "every cut is snapshot-backed and revertible" — no gate behavior changed by this pass, only the language describing where the gate lives.

### Removed
- **The `deletesApproved` plan flag and its refusal check in `apply.mjs`.** There is no field left to set; a delete/merge present in `actions[]` is self-authorizing by construction, since it could only arrive there via the adjudicated plan.

### Still in force (unchanged by this release)
The fidelity gate's no-silent-drop interlock (any structured-token drop still blocks the apply unless the plan names that exact drop in `approvedDrops` — a different, still-live mechanism from the removed `deletesApproved`) · `pinned: true` refusal · realpath-and-contain containment on both sides · the external-writer (R1) abort-and-rollback · the snapshot + WAL journal + whole-run rollback. The human's job stays exactly 2 presses: run consent, and ทำ/later at a band-ceiling crossing — never a per-item review.

Tests 194 → 195.

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
