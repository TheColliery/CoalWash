# CoalWash plugin

CoalWash is a memory washer for agent memory. It works on two lanes. Class-B is the memory and governance files your agent reads every session. A free mechanical Quick pass cleans their fat, and a fidelity gate blocks any structured token, such as a link, a date, a version or a frontmatter field, from being dropped. Class-A is the transcript estate. Old transcripts are archived byte for byte and never edited. Every change is backed by an undo snapshot, and a whole run can be rolled back.

CoalWash slows how fast memory overhead grows. It does not eliminate memory cost.

The plugin ships one skill, `coalwash`, and two commands. `/coalwash:stats` reports the current band, the fat reading, the break-even numbers and any pending ask. It is read-only, except that it finishes the recovery of a dangling run when that run's journal is there. `/coalwash:update` checks for a newer version and offers to apply it, with your consent. A manual run starts with `/coalwash`.

## Install

```bash
claude plugin marketplace add TheColliery/CoalWash
claude plugin install coalwash@coalwash
```

## What the hooks run, and when

Four hook events run one `node` script, `hooks/coalwash-conductor.js`, started from `hooks/hooks.json`. The file sets no timeout. The script branches on the event name.

| Event | Matcher | What it does |
|---|---|---|
| SessionStart | none | Runs the gauge (`handleSessionStart`): measures the governance and memory files, works out the band and records the verdict in the state file. It prints its notices only when there are any: the config and scan-scope lines, a line for each config file it ignores, the update-due nudge, and the language line. It also removes prior sessions' airbag snapshots (`sweepWriteguard`), unless `writeGuard` is `off`. |
| Stop | none | Delivers a pending ask or forced run when the turn ends (`handleStop`), as a `decision: block` that holds the turn open. It also writes the state file, recording the crossing and the last quick run. |
| PreToolUse | `Edit`, `Write`, `MultiEdit` | The airbag (`handleAirbag`): on the first write to a guarded file in a session, it copies the file into the project's snapshot folder before the edit lands. It never blocks. |
| PostToolUse | `Edit`, `Write`, `MultiEdit` | The seatbelt (`handleSeatbelt`): if that edit dropped a structured token, it prints one line naming the token and pointing at the snapshot. It never blocks, and a clean edit prints nothing. |
| PostToolUse | `Agent`, `Task`, `Workflow` | The spawn meter (`handleSpawnMeter`): adds one subagent spawn, with the cached footprint it carried, to a running total in the state file. It prints nothing per spawn. |

## What is fetched or sent

Nothing. The hooks make no network call and send nothing anywhere. CoalWash collects no telemetry. The files it writes stay on your disk. The project's `.claude/coalwash/` folder holds the snapshots, the journal, the recovery bins and the keep decisions. The state file under `~/.claude/projects/` holds numbers and the paths of the always-loaded files; it holds no file content.

The hook starts no child process. The engine starts one: `git ls-files`, from `apply.mjs`, which checks whether a folder holds tracked files before a write. It has a five-second limit and runs with a stripped environment and no shell.

The `/coalwash:update` check is the agent's own procedure, not the hook's. The hook's SessionStart may print a nudge that a check is due; the check looks up the latest published tag of this repository, by whatever means the agent has, and offers the update. It applies nothing by itself. `commands/update.md` lists the steps.

Memory content is read only by your own session's model, the same as any memory file your agent loads. Setting `localOnly: true` makes the agent run the mechanical Quick pass alone, so no subagent sees memory content. The agent honors that setting; no code blocks a tool call. The full policy is in the repository's [PRIVACY.md](https://github.com/TheColliery/CoalWash/blob/main/PRIVACY.md).

## Example uses

1. **A quick wash.** Type `/coalwash` and choose the first option, fat only. The pass is mechanical and snapshot-backed. It returns one line of numbers, even when it cut nothing, so you can tell a working run from no run.
2. **The Full wizard.** Type `/coalwash` and choose fat plus muscle reorganisation. A zero-context reviewer judges the content. The wizard states its estimated time and token cost as a process notice, and then you start or cancel the run.
3. **Find and restore an archived transcript.** From the plugin's `scripts/lib/` folder, `node cli.mjs estate-search <query>` searches the archive's index without unpacking anything. `node cli.mjs estate-restore <sessionId>` writes the transcript back byte for byte into a scratch folder, never into the live tree.
4. **Check a project.** Run `/coalwash:stats`. It shows the band, the certain fat, the break-even numbers when the band is OBESE or FULL, the Memory-BMI ratio, and the count of kept and cut items.

Every cut lands in a recovery bin. To pull one item back by its id, write the id from the listing into a one-line file with your own file tool, then run `node <plugin>/scripts/lib/cli.mjs restore --from [FILE]` from your project's folder. The command looks in that project's bins and writes the content to stdout, so redirect it to a file.

## Report a problem

Open an issue at <https://github.com/TheColliery/CoalWash/issues>. For a security problem, use GitHub's private vulnerability reporting, linked from the repository's [SECURITY.md](https://github.com/TheColliery/CoalWash/blob/main/SECURITY.md), not a public issue.

## Licence

CoalWash is licensed under Apache-2.0.
