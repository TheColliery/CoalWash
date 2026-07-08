# CoalWash on Claude Code — adapter facts

> The validated platform. Facts below are what `class-b.mjs` / the conductor implement — verified 2026-07-09; ⚠️ CC internals are version-sensitive, re-verify on a discovery miss (a missing dir degrades safe: no entries, no harm).

## Class-B map (what discovery finds)

| Surface | Where | Load behavior |
|---|---|---|
| Global governance | `~/.claude/CLAUDE.md` + its `@import` closure (depth cap 5) | always-loaded, every session |
| Project governance | the `CLAUDE.md` up-tree walk (cwd → home, never above) + each file's imports | always-loaded |
| Rules tree | `[project]/.claude/rules/**/*.md` | on-demand (recall cost) unless pulled in via an `@import` |
| Memory index | `~/.claude/projects/[slug]/memory/MEMORY.md` — slug = the absolute project path, every non-alphanumeric char → `-` | always-loaded; platform cap class ~25KB / ~200 lines (the caliper's absolute-cap tripwires) |
| Memory files | sibling `*.md` in the same dir | on recall only — count toward total-store, not the per-session cost |

The per-session saving = the **always-loaded** subset delta; the receipt splits it from total-store. Discovery is read-only, realpath-and-contained to the home + project trees; an unresolvable/escaping candidate is skipped + flagged.

## Wiring + state files (all local, user-readable)

- **Conductor:** `hooks/hooks.json` → SessionStart → `hooks/coalwash-conductor.js` (Phoenix-13: fail-silent, no network, no spawn; silent when LEAN/off).
- **Caliper state:** `~/.claude/.coalwash-state.json` — per-project lean floor, session stamps (ring-capped), snooze. Loss degrades to bootstrap behavior (bands wake after the first full clean stamps a floor).
- **Transaction dir:** `[project]/.claude/coalwash/` — `.coalwash.lock` (atomic-create + stale-timeout 30min + defer-on-doubt), `journal.json` (the WAL; CoalHearth-visible location — CH-side recognition lands in a CoalHearth release), `snap-[timestamp]/` (last 3 kept).
- **Config:** global `~/.claude/.coalwash.json` overlaid by the nearest project `.coalwash.json` (walk stops at home, physical-path compare).
- **Update stamp:** `~/.claude/.coalwash-update-check` (a timestamp; the hook only schedules — the online check is `/coalwash:update`, consent-gated).

## Capacity + spawn

- **Capacity denominator:** conservative constant 200k tokens usable-per-turn (`caliper.mjs CAPACITY_TOKENS`) until a per-model adapter refines it — the gauge is a heuristic made safe by the early-gate margin, never precision-claimed.
- **Outsider spawn:** use the `Explore` agent type (no Agent/Task tool → structurally leaf, no zombie grandchildren) from a neutral cwd (e.g. the OS temp dir) so the up-tree walk loads no project governance into the sub. Reconcile the sub by id on return; a flattened sub only the user's UI can clear — say so rather than pretend a reap.
