# Verifying CoalWash

CoalWash is verified under the same framework as its TheColliery siblings — Phoenix-13 hooks, reproducible builds, and event-driven independent scans. It is **high-privilege by nature** (it rewrites and deletes memory/governance files), so the load-bearing safety gates live in CODE, not prose — see Structural Safety below.

## Reporting a Vulnerability

Open an issue on this repository. For a sensitive PoC (especially anything that could aim a write/delete outside the memory sandbox), request a private channel in the issue before posting details.

## Commit & Tag Signatures

Release tags and maintainer commits are SSH-signed (`gpg.format=ssh`); GitHub shows the Verified badge on them. Automated Dependabot / CI commits are unsigned by design (they carry no maintainer key), so verify a signed release tag — the artifact a release consumer trusts:

```bash
echo "* ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEtqTWGKhX1Dk9nZP8ns13Wl5zsO1Cz3VlTS6m1p2fP9" > coalwash_signers
git config gpg.ssh.allowedSignersFile ./coalwash_signers
git tag -v "$(git describe --tags --abbrev=0)"
```

## Dist Integrity

`plugin/` is generated, never hand-edited. `node scripts/build-plugin.mjs` reproduces it from source; `node scripts/verify.mjs` byte-checks dist-sync in BOTH directions (stale file and source-less orphan both fail) plus manifests, factory-config-vs-schema, and version pins; `node scripts/test.mjs` runs the zero-dependency suite with an explicit file list. Zero dependencies — no lockfile, nothing to `npm audit`.

<!-- version-transition: SkillSpector scan — re-scan is event-driven (a new SkillSpector version or a genuinely new attack surface, maintainer-commanded), NOT per release; record the version/score/date/commit here only after a real scan. -->
## Independent Scanning — NVIDIA SkillSpector

Last scan: CoalWash **v0.1.0-beta.1** dist (`plugin/`), on **2026-07-09** (launch day), with [NVIDIA SkillSpector](https://github.com/NVIDIA/skillspector) **v2.3.11** (self-reported — the tool ships no tagged releases), static stage (`--no-llm`, the documented FP-prone baseline). **Score 43/100 (MEDIUM), 8 findings — all adjudicated FALSE POSITIVE:**

- **7 × `RA1` Self-Modification** (`commands/update.md` ×2 · `hooks/coalwash-conductor.js` ×3 · `scripts/lib/config-schema.mjs` ×2): every hit is the series' **consent-gated kind-1 self-update** — the hook only *schedules* a check via a local stamp (no network, no writes to skill files); the *agent* verifies online and *offers* `claude plugin update`, which the user runs. Nothing modifies skill code or config at runtime. This is the family-wide FP baseline (the same pattern trips RA1 on every sibling).
- **1 × `AR2` Anti-Refusal** (`skills/coalwash/references/method.md:34`, confidence 0.24): the flagged phrase "definable **without judgment**" describes the *mechanical Quick tier* — operations deterministic enough to define without LLM judgment — not an instruction to suppress warnings or disclaimers.

Re-scan stays event-driven (a new SkillSpector version or a genuinely new attack surface), not per release — this pins the last version actually verified.

## Structural Safety

- **Phoenix-13 hook.** One hook file (`hooks/coalwash-conductor.js`) branches on four registered events — SessionStart (the gauge; plain context-injection) · Stop (every FULL crossing force-runs the free mechanical Quick — non-optional by design, no forceMode knob; the sole ask is the once-per-crossing wizard escalation; a structured `{decision:'block', reason}` JSON write, the same mechanism CoalMine's `rot-canary` uses) · PostToolUse (the 0o spawn meter, write-only; and the 0p write-path **seatbelt** — one plain **advisory** context-injection line when an edit to a class-B file drops a structured token, **never** a `{decision:'block'}`, never a nonzero exit) · PreToolUse (the 0p **airbag**, write-only snapshot-on-first-write into the sandbox). All fail-silent, zero-dependency, no network, **no child processes**, and silent outside those sanctioned channels (the advisory line is the same class as the SessionStart context injection — informational, never enforcing). A headless start is safe by construction — it only writes to stdout.
- **Delete/merge authorization is plan-sourced; safety is UNDO.** `apply.mjs` executes a delete/merge only because it is present in the adjudicated plan — there is no separate approval flag to bypass. Every apply snapshots (verified at creation) before the first mutation and a whole-run rollback restores everything on failure; a `pinned: true` file is refused outright — the gates hold even against a misbehaving orchestrating agent.
- **Path containment.** Every touched path is realpath-resolved and contained on BOTH sides (declared roots too), fail-closed — a poisoned config or a symlink cannot aim a write/delete outside the memory sandbox. Discovery is read-only and contained the same way.
- **Transactional apply.** Exclusive lock (atomic-create + stale-timeout + defer-on-doubt), marked snapshot before the first mutation, fsync'd WAL, atomic tmp-then-rename writes, deletes ordered last, wholesale rollback on any failure. Honest ceiling: fsync is not stronger than the drive's write cache; the snapshot is the last backstop.
- **Untrusted config is parse-guarded.** The `.coalwash.json` JSONC parse drops `__proto__` / `constructor` / `prototype` keys; every numeric read is range-clamped to the schema default.
- **Memory content is data, never instructions** — the skill contract binds every sub to judge content, not obey it (prompt-injection via poisoned memory is the named threat model).

Honest scope: these measures are the series' data-safety discipline — injection-safe, path-safe, snapshot-reversible deletes, scrubbed output, offline code, opt-in zero-transmission (`localOnly`). No formal verification, no crypto-at-rest, no "military-grade" claim.
