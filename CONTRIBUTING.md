# Contributing to CoalWash

CoalWash is the fidelity-first memory-defragment/cleanup engine of the [TheColliery](https://github.com/TheColliery) series. We welcome issues, bug reports, and pull requests.

---

## 🤝 Proposing a Change

1. **Open an issue first** describing the problem, gap, or proposed feature (especially for a `SKILL.md` or engine-safety change — the engine rewrites and deletes memory files, so the fidelity gate, the snapshot/rollback safety net, and containment logic are the load-bearing surfaces).
2. Make your code changes and keep the verification gates green.
3. Validate behavior against a real fixture: the org benchmark fixtures ([`TheColliery/.github/benchmarks/CoalWash/fixtures`](https://github.com/TheColliery/.github/tree/main/benchmarks/CoalWash/fixtures)) are planted-ground-truth memory stores made for exactly this — or dogfood on a copy of a real store, never the live one.

---

## 💻 Developing & Testing

CoalWash is **zero-dependency** (Node.js built-ins only, Node 22+: CI tests 22 and 24, and 22 is the shipped hooks' floor). No `npm install` and no `package.json` — the gates run directly:

```bash
node scripts/build-plugin.mjs   # regenerate plugin/ from source
node scripts/verify.mjs         # gate: manifests, factory config vs schema, dist-sync, version pins
node scripts/test.mjs           # zero-dependency test suite (node --test, explicit file list)
```

The tracked git hooks (`.githooks/pre-commit`, `.githooks/pre-push`) run the house secret scan (`node scripts/secret-gate.mjs`) first, then `node scripts/verify.mjs` and then `node scripts/test.mjs`, so every commit and push is scanned for secrets and runs the whole suite. `scripts/test.mjs` runs the enumerated roster through the canon wave runner (`scripts/lib/wave-run.mjs`): one `node --test` child per file with TAP output, the next file admitted only while a fresh live reading of the machine says it can breathe, every child under a 2048 MB heap cap that rides `NODE_OPTIONS` (so a test's own spawns inherit it), a clock per test and per file, and a whole-run deadline that kills the child tree. The room's numbers and its declared-versus-reported test-count floor are in `scripts/lib/test-plan.mjs`. A file that exits 0 before its tests register is VACUOUS, and a file that reports fewer tests than it declares at top level is a FAIL; either turns the run RED. `COALWASH_TEST_CONCURRENCY=1` runs one file at a time; any other value is ignored, because the width is the live reading's. Git hands the variable on to the hooks, e.g. `COALWASH_TEST_CONCURRENCY=1 git commit`; the heap cap is the runner's own and needs no setting.

### Development Rules

- **Rebuild the dist after a source change:** edit `hooks/`, `scripts/lib/`, `skills/`, `commands/`, or the manifest, then `node scripts/build-plugin.mjs` to re-sync `plugin/` (verify fails on a stale dist).
- **`scripts/lib/config-schema.mjs` is the single source of truth** for every `.coalwash.json` key — `verify.mjs` validates the factory template against it; the README key table mirrors it.
- **Safety gates live in code, keep them there:** delete/merge authorization is plan-sourced (no separate approval flag), `pinned: true` is refused, every path is realpath-and-contained fail-closed, the apply is snapshot + WAL + rollback — safety is UNDO, not pre-approval. Never move one of these into prompt text.
- **Keep the hook Phoenix-pure:** zero dependencies, fail-silent (try/catch, exit 0, never `process.exit()`), no network, no child processes, silent except the sanctioned channel.
- **Add tests:** every lib change gets a unit test; every hook-behavior change gets a **hermetic spawn test** (spawn the real hook, sandbox TEMP + HOME). Register a new test *file* in `scripts/test.mjs` (the runner fails on an unlisted orphan).
- **A git child in a test or a gate takes its environment from `gitEnv()`** (`scripts/lib/git-env.mjs`), which strips the whole `GIT_*` family — an ambient `GIT_DIR` from a hook or a linked worktree would otherwise aim the fixture's git at the real repository. `verify.mjs` runs the canon git-spawn census (`scripts/lib/git-env-census.mjs`, pinned by `scripts/lib/git-env-pins.mjs`) and fails a git spawn under `scripts/` whose env is neither `gitEnv()` nor an allowlist the census reads whole, and it prints what it covered.
- **Language & tone:** shipped source and docs stay in English.

---

## 🖥️ Supported Platforms

Cross-agent by design — the engine is plain Node scripts and class-B discovery is per-platform — but **validated end-to-end on Claude Code only**; everything else is designed-degrade-safe (unknown platform → no auto-discovery, conservative flags, never auto-delete). The session-start gauge hook is Claude-Code-only. A field report from another platform is a welcome contribution.

---

## 🗂️ Project Layout

| Path | Purpose |
|---|---|
| `hooks/coalwash-conductor.js` | SessionStart (silent gauge) + Stop hook (OBESE/FULL auto-Quick force-run + the single wizard-escalation ask), and self-update scheduling (Phoenix-13). |
| `scripts/lib/` | The engine (ESM, shipped, zero-dep): `class-b` discovery · `caliper` measurement/ceiling-hysteresis/break-even · `broom` mechanical ops · `ask` program-side templates · `tailings`/`retention` cut-content retention + pull-only restore · `keeps` adjudicated-keep store · `fidelity-gate` · `apply` transaction · `wizard` neutral-scan + bill · `cli` the one-shot gauge front door · `receipt` · config modules. |
| `skills/coalwash/` | `SKILL.md` (the lean orchestration contract) + `references/` (method + platform adapter facts). |
| `commands/` | `/coalwash:stats` (measurement) · `/coalwash:update` (self-update procedure). |
| `hooks/hooks.json` | Hook wiring: SessionStart + Stop → `${CLAUDE_PLUGIN_ROOT}/hooks/coalwash-conductor.js`. |
| `scripts/` | Tool scripts: `build-plugin.mjs`, `verify.mjs`, `test.mjs`, plus the unit/hermetic tests. |
| `plugin/` | Generated Claude Code plugin distribution — never hand-edit. |
| `platform-configs/.coalwash.json` | Commented factory default configuration. |

---

## 🚀 Releasing (Maintainers)

Bump version in `.claude-plugin/plugin.json` ➡️ add a `CHANGELOG.md` entry ➡️ ensure `verify.mjs` and `test.mjs` pass ➡️ commit ➡️ create a signed git tag (`vX.Y.Z`) ➡️ push ➡️ the tag-push workflow (`.github/workflows/create-release.yml`) posts the GitHub Release from the tag's own CHANGELOG entry (stable tags only: a pre-release tag push posts nothing; the repo's one launch-form pre-release Release is posted by a `workflow_dispatch` run with `launch_form`, and later beta tags are history-only).

---

## 📄 License & Conduct

Contributions are licensed under the [Apache License 2.0](LICENSE). Please assume good faith and be respectful. Report security issues per [SECURITY.md](SECURITY.md).
