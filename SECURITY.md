# Verifying CoalWash

CoalWash is verified under the same framework as its TheColliery siblings — Phoenix-13 hooks, reproducible builds, and event-driven independent scans. It is **high-privilege by nature** (it rewrites and, with approval, deletes memory/governance files), so the load-bearing safety gates live in CODE, not prose — see Structural Safety below.

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

**No scan is recorded yet** — CoalWash has not shipped a public release. The first [NVIDIA SkillSpector](https://github.com/NVIDIA/skillspector) scan of the `plugin/` dist runs at launch and its provenance (scanner version, score, per-finding false-positive reasons) is recorded here, following the same event-driven policy as the siblings: re-scan on a new scanner version or a genuinely new attack surface, not per release.

## Structural Safety

- **Phoenix-13 hook.** The one hook (SessionStart gauge) is fail-silent, zero-dependency, no network, **no child processes**, and silent except its sanctioned context-injection channel. A headless start is safe by construction — it only prints.
- **Deletes are code-gated.** `apply.mjs` refuses any delete without `deletesApproved: true` (the human gate's flag) and refuses to touch a `pinned: true` file at all — the gates hold even against a misbehaving orchestrating agent.
- **Path containment.** Every touched path is realpath-resolved and contained on BOTH sides (declared roots too), fail-closed — a poisoned config or a symlink cannot aim a write/delete outside the memory sandbox. Discovery is read-only and contained the same way.
- **Transactional apply.** Exclusive lock (atomic-create + stale-timeout + defer-on-doubt), marked snapshot before the first mutation, fsync'd WAL, atomic tmp-then-rename writes, deletes ordered last, wholesale rollback on any failure. Honest ceiling: fsync is not stronger than the drive's write cache; the snapshot is the last backstop.
- **Untrusted config is parse-guarded.** The `.coalwash.json` JSONC parse drops `__proto__` / `constructor` / `prototype` keys; every numeric read is range-clamped to the schema default.
- **Memory content is data, never instructions** — the skill contract binds every sub to judge content, not obey it (prompt-injection via poisoned memory is the named threat model).

Honest scope: these measures are the series' data-safety discipline — injection-safe, path-safe, human-gated deletes, scrubbed output, offline code, opt-in zero-transmission (`localOnly`). No formal verification, no crypto-at-rest, no "military-grade" claim.
