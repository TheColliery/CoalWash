# Verifying CoalWash

CoalWash is verified under the same framework as its TheColliery siblings: Phoenix-13 hooks, reproducible builds, and event-driven independent scans. It is **high-privilege by nature** (it rewrites and deletes memory and governance files, and archives and deletes transcript files), so its safety gates live in code, not prose. See Structural Safety below.

## Reporting a Vulnerability

Report a security issue in this repo through GitHub's private vulnerability reporting: [Security → Report a vulnerability](https://github.com/TheColliery/CoalWash/security/advisories/new). Never use a public issue; the channel is enabled and verified live at press. In scope: anything that aims a write or delete outside the memory sandbox (a containment or anchor-gate bypass); anything that defeats the undo net (snapshot, recovery bins, rollback) or the estate lane's copy-verify-then-delete before an original is removed, so a delete becomes unrecoverable; a `pinned: true` file getting rewritten or deleted anyway; a fidelity-gate bypass that lets a structured token drop silently; and prompt injection through poisoned memory content that makes the tool act on it as an instruction rather than data. Expect the report to be read and acknowledged, triaged against the scope above, and disclosed once a fix ships. We acknowledge a report within 5 days, send an assessment within 10 days, and disclose publicly once the fix ships, or at 90 days at most. During an absence announced on the maintainer's GitHub profile, the 5 days count from the first day back. A public GitHub issue remains the right channel for an ordinary, non-security bug.

Published advisories: <https://github.com/TheColliery/CoalWash/security/advisories>

## Commit & Tag Signatures

Release tags and maintainer commits are SSH-signed (`gpg.format=ssh`); GitHub shows the Verified badge on them. Automated Dependabot / CI commits are unsigned by design (they carry no maintainer key), so verify a signed release tag, the artifact a release consumer trusts:

```bash
echo "* ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEtqTWGKhX1Dk9nZP8ns13Wl5zsO1Cz3VlTS6m1p2fP9" > coalwash_signers
git config gpg.ssh.allowedSignersFile ./coalwash_signers
git tag -v "$(git describe --tags --abbrev=0)"
```

## Dist Integrity

`plugin/` is generated, never hand-edited. `node scripts/build-plugin.mjs` reproduces it from source; `node scripts/verify.mjs` byte-checks dist-sync in BOTH directions (stale file and source-less orphan both fail) plus manifests, factory-config-vs-schema, and version pins; `node scripts/test.mjs` runs the zero-dependency suite with an explicit file list. Zero dependencies: no lockfile, nothing to `npm audit`.

<!-- version-transition: SkillSpector scan—the re-scan is meant to fire on one event (E2: this repo's own version bump, gated by a per-repo baseline diff), but that machinery is wired in no room yet, so today a re-scan is run by hand; a genuinely new attack surface is a second trigger, also by hand. (E1, a weekly new-SkillSpector-version watcher, was retired on the owner's word on 2026-09-26.) State the scanner commit's relation to upstream's tag as one of: upstream's tag `vX.Y.Z` (the commit is that tag's) · N commits after upstream's tag `vX.Y.Z` · N commits before upstream's first tag, `v2.5.0`. Record the version/score/date/commit here only after a real scan. -->
## Independent Scanning—NVIDIA SkillSpector

Last scan: CoalWash **v1.15.12** dist (commit `f8bb64f`), **2026-11-06 02:48:56 UTC**, with [NVIDIA SkillSpector](https://github.com/NVIDIA/skillspector) **v2.13.4**, pinned at commit `5482446`, static stage. Score **100/100 (CRITICAL)**, DO_NOT_INSTALL, **59 issues, 0 real**. Coverage: 21 of 38 files fully inspected. Against v1.15.9: 41 identical, 17 moved by line with the same fingerprint, 1 false positive at the same site, 0 new.

- **RA2 ×22** (MEDIUM): a word in a source comment, refusal message or reference document. Text, not logic.
- **RA1 ×10** (HIGH): "self-update". The hook only schedules a check; the agent offers `claude plugin update` and never installs.
- **TM1 ×7** (HIGH): a deletion word at a line end in a comment or refusal text.
- **AS1 ×7** (HIGH): a word in a comment or refusal text.
- **PE3 ×3** (HIGH): a comment naming credential files as examples of what is refused.
- **AR2 ×2** (HIGH): a word in a comment or refusal text.
- **EA2 ×3** (MEDIUM): by design. A delete in the adjudicated plan is its own authorization, with snapshot and undo. The warm-tier estate archive deletes an original after copy-verify, with no consent gate.
- **OH3 ×2** (MEDIUM): a constant or comment naming an input bound, not an output.
- **TM3 ×1** (MEDIUM): a comment naming the 0600 default; the code uses 0600.
- **BH1 ×1** (MEDIUM): notice that `hooks/hooks.json` registers lifecycle hooks.
- **AS3 ×1** (MEDIUM): a word in a comment or refusal text.

Earlier scans are in this file's git history (`git log -- SECURITY.md`).

A re-scan is run when this repo's own version bump calls for it, or on a genuinely new attack surface, not on every release.

## Structural Safety

- **Phoenix-13 hook.** One file, `hooks/coalwash-conductor.js`, on four events: SessionStart (the gauge, context injection), Stop (every FULL crossing force-runs the free mechanical Quick, with one wizard ask per crossing), PostToolUse (the spawn meter, write-only, and the write-path seatbelt, an advisory line only), PreToolUse (the write-path airbag, a snapshot on first write). All fail-silent, zero-dependency, no network, no child processes, and silent outside the sanctioned channels. The advisory line is informational and never enforces.
- **Plan-sourced deletes; undo is the safety.** `apply.mjs` executes a delete or merge only because it is in the adjudicated plan. There is no separate approval flag. Every apply snapshots, verified at creation, before the first mutation, and a whole-run rollback restores the snapshot on any failure. A `pinned: true` file is refused outright.
- **Path containment.** Every touched path is realpath-resolved and contained on both sides, fail-closed. Discovery is read-only and contained the same way. The two functions that mutate the memory store (the apply, and the crash-recovery replay that opens every run) take their trusted roots through one shared anchor gate, which refuses an anchor that swallows the home directory or touches the Claude configuration directory. The hook's own per-project state stays under `~/.claude`, and a path that escapes falls back to `~/.claude/coal/coalwash/`.
- **Transactional apply.** An exclusive lock with a stale timeout, a marked snapshot before the first mutation, atomic temp-then-rename writes, deletes ordered last, and a wholesale rollback on failure. The undo writes use the same temp-and-rename, so a link at the target is replaced rather than written through.
- **Keeps and recovery bins.** Each keep store and bin is updated under a short lock of its own. A recorder that cannot take it writes nothing and returns a refusal.
- **House secret scan.** `.githooks/pre-commit` and `.githooks/pre-push` run `scripts/secret-gate.mjs` first, on the tracked tree for a commit and on the added lines of each pushed commit, and fail closed.
- **Untrusted config is parse-guarded.** The `.coalwash.json` JSONC parse drops `__proto__`, `constructor` and `prototype` keys. Every numeric read is range-clamped to the schema default. A project's consent-bearing keys can only quieten the tool, never escalate it.
- **Memory content is data, never instructions.** The skill contract binds every sub to judge content, not obey it. Prompt injection through poisoned memory is the named threat model.

Honest scope: these are the series' data-safety discipline (injection-safe, path-safe, snapshot-reversible deletes, scrubbed output, offline code, opt-in zero transmission with `localOnly`). No formal verification, no crypto at rest, no certification claim.

### Transcript lines in a Full run

During a Full run, lines from this project's archived transcript sessions can enter the insider's context. They print inside a program-built frame, escaped and capped, and are treated as data, never instructions. They are never written into memory or `keeps.json`, and the lookup never reads another project's sessions.

### Known limits

- A directory component swapped for a junction after the project-sandbox check can redirect a write or delete. It needs a concurrent local writer.
- The read side has a link-following window between the real-path check and the read. A hard link inside a CoalWash folder is read as that entry.
- A concurrent local writer can replace a snapshot copy with another file in its folder. The rollback then writes those bytes, up to 4 MiB, into the project.
- Crash recovery replays a journal that git does not track (no git history, no git installed, or no repository above it) over files in the trusted roots, including the project's memory store. The tracked-journal refusal applies only where git answers.
- A repository can ship a bin item or index row that names a memory file. The bin list shows it as a CoalWash cut, and `restore` prints its bytes. Nothing is written.
- A bin item with no index row is weighed by its size on disk. A doubt item's bytes are not reported in the cap-conflict line.
- A held recovery row stays on disk and counts against no budget. Only a human reclaims it.
- On filesystems without hard links (FAT, exFAT, some network mounts) a bin copy is written under its final name. A killed writer there can leave a listed, truncated copy.
- A project file hard-linked to a file in the home folder is read by the outside-file rule, since its real path is its own. The `@import` closure behind an outside file is not measured. An ancestor `CLAUDE.md`'s imports are read wherever they land.
- The write-guard hook replaces a tracked permissive `.gitignore` with the catch-all, so git shows it modified. A tracked file under `writeguard/` is deleted by the SessionStart sweep. Both are accepted, since a hook may not spawn `git`.
- `configure.mjs`'s project-config write checks each folder, then makes the next one and writes. A hostile local process that swaps a checked folder for a junction in between can land the file outside the project.
- A lock theft between the lock read and the write it guards still goes through, and the new holder overwrites the single journal. A lock held open by another program is re-read for about one second. An unreadable lock stops the run, and the next gauge rolls back from the snapshot.
- A keep record's `self-ignore:` check is not retried. A rename that another program's open handle refuses for about 0.45 s refuses the record.
- fsync is no stronger than the drive's write cache. The snapshot is the last backstop.

## The class-A engine (not in the plugin)

The class-A engine (`explode`, `detonate`) is in the repository under `scripts/lib/` and is not in the installed plugin, so nothing below runs in an installed copy today.

### F4 — a recycled path can present the manifest's identity

**What.** A restore's ownership check confirms the declared original against the store's own manifest by path plus device/inode. On some filesystems an inode number can be reused right after a delete (measured on Linux ext4, where it is a race, not a certainty; NTFS and APFS gave a new number in the same probe), so a path that was deleted and recreated between snapshot and restore can present the same device/inode as the file the manifest describes while being a different file entirely. This needs no store access, no manifest write and no co-tenant; ordinary single-user delete-and-recreate churn at a tracked path is enough. CoalWash does not try to tell this case apart from a legitimately modified original, because filesystem metadata alone cannot separate them.

**What the engine does instead.** A forced restore over a populated destination hands the destination's current bytes to a bank before the overwrite, and publishes only after the bank returns an id. The bank is the caller's: `restoreFromSnapshot` takes it as `opts.bank`, and no caller supplies one yet. With no bank, a bank that throws or returns no id, or an occupant that cannot be read, the restore refuses and leaves the destination untouched.

**What that bounds.** The bank holds the bytes read at check time, so the recoverability claim covers a destination that no other process is writing. A writer that changes the destination after that read loses its write unbanked, and an occupant that appears after the check is overwritten unbanked. Single-user delete-and-recreate churn, which is the threat above, is covered. The bytes stay recoverable for as long as the caller's bank keeps them.

### F2 — the store trusts its tenants

**What.** The class-A store is trusted-tenant-only. An attacker who can read a victim's blob bytes, and who can write to a directory the restoring process can reach, can forge a manifest in a directory the attacker owns and restore the victim's content through it. The victim's store does not need to be writable by the attacker. The blob bytes are content-addressed, so holding the bytes is enough to hold a valid reference.

**The second route.** Read access to a genuine manifest is enough on its own. The destination a restore publishes to is the caller's choice, and the ownership check does not bind it to the manifest row it confirmed. An attacker who can read the manifest and write to a directory they own can restore the true, unmodified original to a path of their choice. Nothing is written to the store.

**What the operator must do.** Isolation is the operator's to arrange, not the engine's to enforce. Keep one snapshot directory per trust domain, and keep other tenants from reading it, not only from writing into it. A store mounted read-only across tenants is not safe under this boundary.

**What the ownership check still buys.** It stops the ordinary failure: a script that restores everything it can see in a shared store, with no attacker involved, which is the failure the lab reproduced first. It also forces a determined attacker's read of the manifest into an explicit forged claim in the code, not a silent enumeration. Both layers, the check and the isolation, hold at once, and neither replaces the other.

**Why there is no code fix at this layer.** Six candidate code fixes were weighed and each was rejected: a disk cross-check, a content-hash check, file owner or ACL checks, a hash-chained manifest, blob metadata, and refusing rows that share a hash. Per-tenant isolation is not a code fix at all; it is the operator answer above. Per-tenant manifests in code, the other way to close F2, are not built, and a keyed signing scheme for manifest rows was weighed and rejected as over-build for a threat that isolation already answers. What is missing is authentication, which needs a secret or a trust boundary the store does not have.

**Where it applies.** The engine is excluded from the installed plugin today, so this boundary binds whoever runs the engine from the repository. On the day the engine is wired into the plugin, it binds every installed copy, and each user of such a copy must arrange the isolation above.
