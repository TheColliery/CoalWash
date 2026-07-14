# CoalWash on Antigravity (AG 2.0) — adapter facts

> Status: **designed-for, UNVALIDATED on AG.** The hook events + hooks.json shape + the `{additionalContext}` injection key are empirically pilot-confirmed (2026-07-12) and doc-corroborated (2026-07-13); whether AG **delivers** the injected context into the agent, and AG's exact tool-name/arg schema, are NOT — the adapter is built defensively around that gap. CC (`platform-cc.md`) stays the only validated platform.

## Wiring

- **Adapter:** `hooks/coalwash-ag.js` — a thin transport shim over the SAME `hooks/coalwash-conductor.js` handlers (one implementation; only the payload normalize + emit channel differ). Phoenix-13 identical: fail-silent, zero-dep, no network, no spawn.
- **Template:** `platform-configs/hooks.json` → copy to `<workspace>/.agents/hooks.json` (project) or `~/.gemini/config/hooks.json` (global), replace `__COALWASH_DIR__` with the install dir (a global file-copy install: `~/.gemini/config/skills/coalwash` — copy the whole plugin tree; the adapter imports `../scripts/lib`).
- **Emit:** the only stdout is one `{"additionalContext": "..."}` JSON line (camelCase key) — AG's sanctioned injection channel.

## Event mapping (AG has 5 events; SessionStart never fires there)

| CC event | AG transport | Semantics kept |
|---|---|---|
| SessionStart gauge | **first `PreInvocation`** of a session, guarded by a per-session tmp marker (`coalwash-ag-gauge-<hash(session_id)>.marker`) — PreInvocation fires per MODEL CALL, the marker makes the gauge once-per-session; later calls exit at one `existsSync` | measurement-only, silent; crossings armed identically |
| Stop delivery | `Stop` (per-response — same cadence as CC) | once-per-crossing + consume-at-emission unchanged; **channel degrades** (below) |
| PreToolUse airbag | `PreToolUse`, matcher `.*`, tool names normalized | snapshot-on-first-write, write-only |
| PostToolUse seatbelt | `PostToolUse`, matcher `.*`, tool names normalized | FYI advisory via `additionalContext` |

Tool-name normalize: AG core stdin fields are already snake_case (CC-compatible); `toolCall.name`/`toolCall.args.*` map to `tool_name`/`tool_input.file_path`. Only `write_to_file` is pilot-named; the other candidates are unverified guesses whose fail direction is a no-op (an unmapped tool is simply not guarded — never a wrong mutation).

## Named limitations (honest scope — what this port does NOT do)

1. **No AG-native class-B discovery.** The gauge rides the existing Claude-Code discovery (`class-b.mjs`). On a machine **without** `~/.claude`, the platform detects as `unknown` → the gauge is INERT by construction (no entries, no state written, nothing created). On a CC-coexisting machine, an AG session gauges the **CC-load parcel** (CLAUDE.md walk + imports + CC memory dir) — honest overlap only where that walk imports the shared `AGENTS.md`/`MEMORY.md`; AG's own surfaces (`AGENTS.md` direct-load, `.agents/`, `~/.gemini/config`) are NOT discovered. A real AG class-B adapter must land with the in-flight nested-scope 3-tier fix (same scope enum) and verified AG load semantics — deferred, not half-shipped.
2. **Stop is advisory, not enforcement.** AG has no `{decision:'block'}` Stop semantics — the FULL force directive / wizard ask / externalize advisory arrive as context injection an agent MAY ignore (the known last-hop ceiling; on CC the Stop-block closes it, on AG it stays open). The user-press path (`/coalwash` — on AG: invoke the coalwash skill by name) remains the reliability floor.
3. **Spawn meter unwired.** AG's subagent-spawn tool name is unverified; a wrong guess would inflate the true-bill numbers that justify the FULL force (numbers-shown must be TRUE) — so the 0o meter does not run on AG; the bill covers the main session only.
4. **Self-update nudge not ported.** Its payload (`claude plugin update`) is CC-plugin-specific; AG installs by file-copy. Update manually by re-copying the plugin tree.
5. **Delivery unvalidated.** `additionalContext` is emitted per spec; no claim that AG surfaces it. The write-path airbag/seatbelt file effects (snapshots under `<project>/.claude/coalwash/writeguard/`) are real regardless — they are filesystem effects, not injection-dependent.

The writeguard (airbag/seatbelt) needs NO discovery: it is basename-gated (`AGENTS.md`/`CLAUDE.md`/`MEMORY.md` anywhere in the home/project trees, plus `.md` under a `.claude` tree) — so AG edits to the shared governance files are guarded today.
