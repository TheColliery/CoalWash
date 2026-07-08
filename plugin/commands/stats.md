---
description: CoalWash stats — current band, Memory-BMI, fat reading, lean floor, snooze state, and the last run's trace for this project
---

Produce the CoalWash stats report for this project, in the user's language. Tables only, minimal prose. Read-only — do not modify any file, stamp, or state.

Run the read-only gauge (the preflight snippet in the skill's `references/method.md`: `discoverClassB` → `measureEntries` → `bandVerdict` → `breakEven` from the engine `scripts/lib/`) plus the state file `~/.claude/.coalwash-state.json` and the transaction dir `[project]/.claude/coalwash/`, and show:

- **Gauge:** current band (LEAN/PLUMP/OBESE/FULL) · always-loaded footprint ~tok/session (label `~est`) · Memory-BMI vs the lean floor, or "no floor yet — bands wake after the first full clean".
- **Fat reading:** footprint − lean floor (~est tokens) · the break-even numbers when the band is FULL (fat/day at the stamped session rate · one-run cost · break-even days).
- **Lean floor:** value + when stamped (`leanFloorAt`), or N/A.
- **Snooze:** active nudge-snooze until [date], or none.
- **Last run:** newest `snap-[timestamp]/` in the transaction dir (= the last apply's snapshot, with date) and whether a dangling `journal.json` exists (an interrupted run awaiting rollback — recommend running `/coalwash` to recover). No transaction dir → no run recorded.

Honest empty state: no state entry, no transaction dir, and nothing measured → say exactly that in one line.

This is the measurement standard-system command. Token numbers are char-heuristic estimates — always label them `~est`; byte figures are the deterministic ones.
