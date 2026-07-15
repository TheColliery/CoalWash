---
description: CoalWash stats — current band, Memory-BMI, fat reading, lean floor, pending-ask state, and the last run's trace for this project
---

Produce the CoalWash stats report for this project, in the user's language. Tables only, minimal prose. Read-only — do not modify any file, stamp, or state.

Run the read-only gauge — the one-shot CLI from the engine `scripts/lib/`: `node "[LIB]/cli.mjs" gauge --json` (recover + discover + measure + verdict + break-even in one call; never hand-compose the lib calls) — plus the state file `~/.claude/.coalwash-state.json` and the transaction dir `[project]/.claude/coalwash/`, and show:

- **Gauge:** current band (LEAN/OBESE/FULL) · always-loaded footprint ~tok/session (label `~est`) · Memory-BMI vs the lean floor, or "no floor yet — bands wake after the first full clean".
- **Fat reading:** footprint − lean floor (~est tokens) · the break-even payback numbers when the band is OBESE or FULL (fat/day at the stamped session rate · one-run cost · break-even days).
- **Lean floor:** value + when stamped (`leanFloorAt`), or N/A.
- **Pending ask:** an unconsumed band crossing awaiting the next `Stop` (which band, since when), or none — CoalWash asks once per crossing, never a repeating nag; there is no time-based snooze.
- **Sub-spawn bill (the 0o true-bill):** from the project's state entry, `subSpawns` + `subParcelTokensAccum` — "subs this session: N spawns ≈ X tok parcel (~est)" (every sub spawned from this room re-carried the room's always-loaded parcel; the meter counts silently at the spawn site — main — since hooks never fire inside subs). Zero/absent → OMIT the line entirely, never print "0 spawns".
- **Last run:** newest `snap-[timestamp]/` in the transaction dir (= the last apply's snapshot, with date) and whether a dangling `journal.json` exists (an interrupted run awaiting rollback — recommend running `/coalwash` to recover). No transaction dir → no run recorded.
- **Class-A estate (P1, report-only — COALWASH_BLUEPRINT.md §19):** run `node "[LIB]/cli.mjs" estate --json` and show total estate size (this project's CC session transcripts + tool-results/subagents/other overflow) · the per-type byte rollup · the heuristic `~est` reclaimable figure (entries older than the retention horizon) · machine-wide orphan-slug-dir count + bytes if any (a slug whose owning project path no longer exists — candidates, not confirmed). Byte figures are deterministic; the reclaimable figure is `~est`, always labeled. This is MEASUREMENT ONLY — nothing is deleted, archived, or edited; name the honest ceiling verbatim: "P1 = report-only; P2 (retention/archive) not built yet." No estate found → omit the section entirely, never print a zero-line.

Honest empty state: no state entry, no transaction dir, and nothing measured → say exactly that in one line.

This is the measurement standard-system command. Token numbers are char-heuristic estimates — always label them `~est`; byte figures are the deterministic ones.
