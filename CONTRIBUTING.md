# Contributing to CoalWash

CoalWash is the fidelity-first memory-defragment/cleanup engine of the [TheColliery](https://github.com/TheColliery) series. We welcome issues, bug reports, and pull requests.

---

## 🤝 Proposing a Change

1. **Open an issue first** describing the problem, gap, or proposed feature (especially for a `SKILL.md` or engine-safety change — the engine rewrites and deletes memory files, so the fidelity gate, human gate, and containment logic are the load-bearing surfaces).
2. Make your code changes and keep the verification gates green.
3. Validate behavior against a real fixture: the org benchmark fixtures ([`TheColliery/.github/benchmarks/CoalWash/fixtures`](https://github.com/TheColliery/.github/tree/main/benchmarks/CoalWash/fixtures)) are planted-ground-truth memory stores made for exactly this — or dogfood on a copy of a real store, never the live one.

---

## 💻 Developing & Testing

CoalWash is **zero-dependency** (Node.js built-ins only, Node 18+). No `npm install` and no `package.json` — the gates run directly:

```bash
node scripts/build-plugin.mjs   # regenerate plugin/ from source
node scripts/verify.mjs         # gate: manifests, factory config vs schema, dist-sync, version pins
node scripts/test.mjs           # zero-dependency test suite (node --test, explicit file list)
```

### Development Rules

- **Rebuild the dist after a source change:** edit `bin/`, `hooks/`, `scripts/lib/`, `skills/`, `commands/`, or the manifest, then `node scripts/build-plugin.mjs` to re-sync `plugin/` (verify fails on a stale dist).
- **`scripts/lib/config-schema.mjs` is the single source of truth** for every `.coalwash.json` key — `verify.mjs` validates the factory template against it; the README key table mirrors it.
- **Safety gates live in code, keep them there:** deletes require `deletesApproved`, `pinned: true` is refused, every path is realpath-and-contained fail-closed, the apply is snapshot + WAL + rollback. Never move one of these into prompt text.
- **Keep the hook Phoenix-pure:** zero dependencies, fail-silent (try/catch, exit 0, never `process.exit()`), no network, no child processes, silent except the sanctioned channel.
- **Add tests:** every lib change gets a unit test; every hook-behavior change gets a **hermetic spawn test** (spawn the real hook, sandbox TEMP + HOME). Register a new test *file* in `scripts/test.mjs` (the runner fails on an unlisted orphan).
- **Language & tone:** shipped source and docs stay in English.

---

## 🖥️ Supported Platforms

Cross-agent by design — the engine is plain Node scripts and class-B discovery is per-platform — but **validated end-to-end on Claude Code only**; everything else is designed-degrade-safe (unknown platform → no auto-discovery, conservative flags, never auto-delete). The session-start gauge hook is Claude-Code-only. A field report from another platform is a welcome contribution.

---

## 🗂️ Project Layout

| Path | Purpose |
|---|---|
| `hooks/coalwash-conductor.js` | SessionStart + UserPromptSubmit hook: the 4-band gauge, the FULL-band per-turn repeat, and self-update scheduling (Phoenix-13). |
| `scripts/lib/` | The engine (ESM, shipped): `class-b` discovery · `caliper` measurement/bands/break-even · `fidelity-gate` · `apply` transaction · `receipt` · config modules. |
| `skills/coalwash/` | `SKILL.md` (the lean orchestration contract) + `references/` (method + platform adapter facts). |
| `commands/` | `/coalwash:stats` (measurement) · `/coalwash:update` (self-update procedure). |
| `hooks/hooks.json` | Hook wiring via `${CLAUDE_PLUGIN_ROOT}/bin/…`. |
| `scripts/` | Tool scripts: `build-plugin.mjs`, `verify.mjs`, `test.mjs`, plus the unit/hermetic tests. |
| `plugin/` | Generated Claude Code plugin distribution — never hand-edit. |
| `platform-configs/.coalwash.json` | Commented factory default configuration. |

---

## 🚀 Releasing (Maintainers)

Bump version in `.claude-plugin/plugin.json` ➡️ add a `CHANGELOG.md` entry ➡️ ensure `verify.mjs` and `test.mjs` pass ➡️ commit ➡️ create a signed git tag (`vX.Y.Z`) ➡️ push ➡️ create a GitHub Release (stable tags only — with ONE named exception: the repo's FIRST public beta tag ships as a prerelease so the Releases panel is never empty at launch; later beta tags are history-only).

---

## 📄 License & Conduct

Contributions are licensed under the [Apache License 2.0](LICENSE). Please assume good faith and be respectful. Report security issues per [SECURITY.md](SECURITY.md).
