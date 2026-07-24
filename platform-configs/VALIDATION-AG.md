# CoalWash — LIVE-AG VALIDATION CONTRACT (human-run runbook)

> Repo-only ops doc (not shipped in `plugin/`). Validates the AG 2.0 adapter (`hooks/coalwash-ag.js`, wired tier) on a live Antigravity session. Authored against the AG 2.0 v2.3.1 hook spec (antigravity.google/docs/hooks, 2026-07-23). Every check names a MECHANICAL artifact (file/DB/transcript) — never an agent's self-report (the probes-not-questions kit law).
>
> WHY step 4 gates everything: on 2026-07-16 an older AG build left both documented wire locations present-but-inert (0 executions). The current build documents an automatic loader, so liveness is OPEN — the canary decides it before CoalWash is judged.

`<tmp>` below = the OS temp dir (`echo %TEMP%` on Windows · `echo ${TMPDIR:-/tmp}` on POSIX). `<ws>` = the test workspace.

## Phase 0 — Setup

1. **Record the AG version** (menu About / title bar). Must be Antigravity 2.0 **v2.3.x or newer** (the spec this adapter targets). Older → stop, do not judge the adapter.
2. **Make a throwaway test workspace** `<ws>` containing: a `MEMORY.md` with ~10 lines including at least one markdown link `[t](https://example.com)` and one number; keep a pristine copy `MEMORY.orig.md` OUTSIDE `<ws>` for byte-compare.
3. **Install CoalWash globally for AG:** copy the WHOLE repo `plugin/` tree to `~/.gemini/config/skills/coalwash` (the adapter imports `../scripts/lib`, so hooks/ + scripts/lib must both exist).
   Pre-wire smoke check (no AG involved): `echo {} | node ~/.gemini/config/skills/coalwash/hooks/coalwash-ag.js PreInvocation` → must print exactly `{}` and exit 0.
4. **Wire hooks + the engine-liveness canary in ONE file:** create `<ws>/.agents/hooks.json` from `platform-configs/hooks.json` (replace every `__COALWASH_DIR__` with the absolute install dir from step 3, forward slashes), then ADD this sibling named hook inside the same top-level object:

   ```json
   "cw-canary": {
     "PreInvocation": [
       { "type": "command", "command": "node -e \"const o=require('os'),f=require('fs'),p=require('path');f.appendFileSync(p.join(o.tmpdir(),'cw-ag-canary.txt'), Date.now()+'\\n')\"", "timeout": 30 }
     ]
   }
   ```

   (Global alternative wire: `~/.gemini/config/hooks.json` — test the project wire first; it is the one a repo ships.)

## Phase 1 — Engine liveness (gates everything)

5. Open a **FRESH AG conversation** with `<ws>` as the workspace. Send: `say ok`. Let the turn finish.
6. **CHECK A — canary artifact:** `<tmp>/cw-ag-canary.txt` exists with a timestamp from this minute.
   - PASS → the hook engine executes from `.agents/hooks.json`. Continue.
   - FAIL → the engine did not run hooks (the row-22 scenario). STOP — the adapter cannot be judged. Record AG version + wire location tried; retry the global wire once; both dead → CoalWash's AG tier stays **wired (built + hermetically tested), engine-blocked** and the manual tier below is the live ceiling.

## Phase 2 — Gauge (the wired-tier heartbeat)

7. **CHECK B — adapter ran:** a `coalwash-ag-gauge-*.marker` file in `<tmp>` with a fresh mtime (the once-per-conversation gauge marker).
8. **CHECK C — gauge effect (machine-class dependent):**
   - CC-coexisting machine (`~/.claude` exists — this reference machine): `~/.claude/projects/<slug>/coalwash/state.json` (slug = the `<ws>` absolute path with every non-alphanumeric → `-`) gains a fresh `lastVerdict`.
   - Pure-AG machine (no `~/.claude`): NOTHING is created — `~/.claude` still absent = PASS for the inert-by-construction claim (platform-ag.md limitation 1). Record which case ran.
9. **CHECK D — turn integrity:** the AG reply was normal — no hook error surfaced, no stray JSON in the conversation, no hang. (Send one more prompt; confirm no re-gauge: the marker count for this conversation stays 1.)

## Phase 3 — Write-guard (airbag + seatbelt)

10. Prompt: `Append the line "probe-line" to MEMORY.md`. After the turn:
    **CHECK E — airbag snapshot:** `<ws>/.claude/coalwash/writeguard/<conversation-dir>/MEMORY.md--*` exists and is byte-identical to `MEMORY.orig.md` (`fc` / `diff`). The `.gitignore` self-ignore files exist beside it.
11. **CHECK F — permission neutrality (named risk, platform-ag.md limitation 5):** note whether step 10 raised MORE permission prompts than an identical edit in an unwired conversation. Extra prompts = a FINDING (not a fail): record it; the documented fallback is removing the `PreToolUse` block from hooks.json.
12. Prompt: `In MEMORY.md, delete the line containing the link`. Then send any next prompt (`ok?`) so a PreInvocation fires. 
    **CHECK G — seatbelt delivery:** grep the conversation transcript for the advisory — `~/.gemini/antigravity/brain/<conversationId>/.system_generated/logs/transcript.jsonl` contains `write-guard` (and `link-drop`). The UI showing it is a bonus; the transcript line is the artifact.

## Phase 4 — Stop enforcement (the upgraded channel)

13. Seed a pending FULL crossing for `<ws>` (CC-coexisting machine; one line, fill `<slug>`):

    ```
    node -e "const f=require('fs'),p=require('path'),o=require('os');const d=p.join(o.homedir(),'.claude','projects','<slug>','coalwash');f.mkdirSync(d,{recursive:true});f.writeFileSync(p.join(d,'state.json'),JSON.stringify({stateSchema:1,lastVerdict:{band:'FULL',reason:'economic',economical:true,fatTokens:9000,overCeiling:true,econLatched:true,perDay:300,breakEvenDays:2},lastCrossing:{band:'FULL',at:Date.now()-1000,consumed:false}}))"
    ```

14. In the SAME conversation send: `say done`. Let it end.
    **CHECK H — enforcement analogue:** the agent receives ONE extra turn whose system message carries the `[CoalWash]` FULL directive (transcript.jsonl contains `FULL band`), and the conversation then terminates normally — NO infinite continue loop (watch ≤2 extra turns).
    **CHECK I — once-only bookkeeping:** `state.json` now shows `lastCrossing.consumed: true`, and a `coalwash-ag-stop-*.txt` note exists in `<tmp>`. A further `say done` turn produces NO new directive.

## Verdict table

| Claim | Requires |
|---|---|
| **AG engine live** | A |
| **wired-VALIDATED (gauge)** | A + B + C + D |
| **wired-VALIDATED (write-guard)** | + E (G = delivery bonus; its failure is a finding, not a blocker — the snapshot undo net is the load-bearing half) |
| **wired-VALIDATED (enforcement)** | + H + I |
| Findings to record regardless | F, and any check's raw artifact paths |

Any FAIL: record the artifact state verbatim (paths + contents), do NOT edit the adapter mid-run — one run, one report (setter≠solver).

## Manual-tier fallback (if Phase 1 fails)

15. In an AG conversation, invoke the skill by name (AG skills dir: `~/.gemini/config/skills/coalwash/skills/coalwash/SKILL.md` — ask: `Run the coalwash skill on this workspace`).
16. PASS = the agent walks the SKILL contract: runs `node <install>/scripts/lib/cli.mjs` steps (gauge report prints with real numbers), a Quick pass on the fixture MEMORY.md either finds nothing or produces a receipt with **0 unapproved structured-token drops**, and the fidelity-gate/snapshot artifacts appear under `<ws>/.claude/coalwash/`. That validates the manual tier (`/coalwash` end-to-end + the gate holding on AG).

## Cleanup

17. Delete `<ws>/.agents/hooks.json`, `<tmp>/cw-ag-canary.txt`, the seeded `state.json` project dir, and the test workspace. The global skill copy may stay (inert without a wire).
