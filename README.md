<div align="center">

# 🧼 CoalWash

> *Coal washing is the real mining process that cleans raw coal — separating the waste without damaging the coal.* This one is a memory washer/defragmenter for your agent: **it cleans the fat, never the meat.**

**A fidelity-first memory-defragment/cleanup engine** for agent class-B memory — the memory and governance files your platform loads into context every session. A free mechanical Quick pass plus a code-enforced fidelity gate prove zero fact-loss by diff (not hope); the paid semantic Full pass is a separate consent; every delete is human-gated in code.

![version](https://img.shields.io/github/v/tag/TheColliery/CoalWash?label=version&color=blue)
![license](https://img.shields.io/badge/license-Apache_2.0-blue)
![status](https://img.shields.io/badge/status-beta-orange)

[Changelog](CHANGELOG.md) · [Security](SECURITY.md) · [Privacy](PRIVACY.md) · [Releases](https://github.com/TheColliery/CoalWash/releases)

**Part of [TheColliery](https://github.com/TheColliery)** — siblings: **[CoalMine](https://github.com/HetCreep/CoalMine)** (quality canaries) · **[CoalTipple](https://github.com/TheColliery/CoalTipple)** (model/effort routing) · **[CoalBoard](https://github.com/TheColliery/CoalBoard)** (consensus board) · **[CoalHearth](https://github.com/TheColliery/CoalHearth)** (warm-resume) · **[CoalFace](https://github.com/TheColliery/CoalFace)** (fan-out discipline) · **[CoalLedger](https://github.com/TheColliery/CoalLedger)** (docs health).

</div>

---

## 🧼 What it is

Agent memory grows additively and unmanaged. The always-loaded set (memory index + governance files) is paid **every session, forever** — and the market's cleanup tools are lossy summarize-and-hope. Cutting the wrong line from a memory your agent trusts is silent breakage that never surfaces.

CoalWash is the SSD cleanup + defragment discipline ported to that store, **fidelity-first**:

- **The meat is inviolable.** A mechanical fidelity gate diffs every rewrite's structured-token inventory — `[[wikilinks]]`, dates, versions, frontmatter keys — and ANY drop blocks the apply. Zero fact-loss is proven by code, not promised by a prompt.
- **Deletes are human-gated in code.** The apply engine refuses deletes without explicit approval, and a `pinned: true` file is untouchable — the gates do not depend on agent diligence.
- **The apply is transactional.** Exclusive lock, marked snapshot before the first mutation, fsync'd WAL, atomic writes, deletes last, wholesale rollback on any failure. The worst realistic outcome of any crash is *"the run did not happen"* — never *"memory is corrupted."*

**Honest frame:** CoalWash **slows how fast your memory-overhead grows** — a rate intervention, not a level reset. It does not eliminate memory cost, reach zero, or stop legitimate growth (the floor of real facts rises with your project; that is meat, not fat).

## ⚙️ How it works

One standing gauge at the chokepoint (memory is loaded every session, so a session-start caliper sees past, present, and future by construction), then a disciplined pipeline per run:

| Stage | Who | What |
|---|---|---|
| Gauge | code | Discover class-B per platform → measure footprint → band verdict → break-even math |
| Quick | code-gated mechanics | Exact-dedup, dead-link fix, whitespace, index rebuild — free, deterministic; oversize/stale files are flagged, never rewritten here |
| Full | one outsider sub + the insider | Semantic garbage judgment (superseded / duplicate / point-in-time / over-verbose) by a zero-context outsider; the session agent adjudicates every flag — always a separate consent |
| Fidelity gate | code | Inventory diff, original vs new; any dropped link/date/version/frontmatter key blocks the apply |
| Human gate | you | Every delete/merge listed tersely, approved y/n; `pinned` files refused outright |
| Apply | code | Lock → snapshot → WAL → atomic writes → deletes last → commit, or wholesale rollback |
| Receipt | code | `class B: X KB -> X' KB · saves ~N tok/session (~est) · removed/trimmed/kept · fidelity gate: PASS` — deterministic bytes, token figures labeled `~est` |

The gauge rides **Memory-BMI** = always-loaded footprint / lean floor (floor-relative, so real growth never false-fires):

| Band | Behavior |
|---|---|
| LEAN | Silent — a run would be a no-op, and none is offered |
| PLUMP | One ask; declining snoozes it for days |
| OBESE | Strong ask, shorter snooze |
| FULL | Force-runs the *process* — armed only by a deterministic break-even proof (one run costs less than carrying the fat), with the numbers shown every time. Deletes still stop at the human gate |

**`localOnly` (trade-secret mode):** mechanical Quick only — no spawned sub ever receives memory content, the semantic tier is disabled, nothing beyond what your platform already loads reaches a model. Memory is private data; see [PRIVACY.md](PRIVACY.md).

## ⚠️ Read before you run it

> [!CAUTION]
> **1 — Never loop CoalWash, and never put it on a calendar.** Fat grows at a different rate in every project — a schedule cleans lean memory for nothing and re-pays the semantic cost every round. The safe **consecutive-run ceiling is benchmark-derived, never guessed**; the current ceiling lives in the [benchmark records](https://github.com/TheColliery/.github/tree/main/benchmarks/CoalWash/results). If no ceiling is published for your setup, the conservative default is **one Full run per sitting**.
>
> **2 — Past fat-exhaustion, a model can throw away something load-bearing — like a person can.** While real fat remains, cleaning is safe work; once none remains and the loop continues, every further semantic pass is pressure on the meat. That risk **varies by model**; the per-model fact-loss measurements live in the [benchmark records](https://github.com/TheColliery/.github/tree/main/benchmarks/CoalWash/results). The LEAN band exists to make post-exhaustion runs a no-op — trust its silence.

## 🧭 Compatibility

Cross-agent by design (the engine is zero-dependency Node scripts any agent can run; class-B layout is *discovered* per platform, never hardcoded) — **validated end-to-end on Claude Code only**. Every other platform is designed-degrade-safe, not yet validated: unknown platform → no auto-discovery, conservative flags, manual scope, never auto-delete. The activation ladder is capability-keyed: has lifecycle hooks → the shipped session-start gauge runs automatically (Claude Code today); no hooks → best-effort agent-driven offer (probabilistic, not hook parity); always → manual `/coalwash`.

## 🚀 Install

**Claude Code** — one command pair (also wires the session-start gauge):

```bash
claude plugin marketplace add TheColliery/CoalWash
claude plugin install coalwash@coalwash
```

**Other agents** — file-copy: copy `skills/coalwash/` (the skill + references) and `scripts/lib/` (the engine) into your platform's skill directory, keeping the relative layout (`skills/coalwash/SKILL.md` resolves the engine at `../../scripts/lib`). The gauge hook is Claude-Code-only; elsewhere run `/coalwash` manually. No API keys, no network, no `npm install`.

> [!TIP]
> Install **globally** — CoalWash is a maintenance utility you want available everywhere, and it still operates per-project, per-session. A project config can tune or shut it off locally.

## 🔧 Configure

Every tool in the series supports two config levels — a global `~/.claude/.coalwash.json` and a per-project `.coalwash.json` override (project wins) — so a globally-installed skill can be tuned or **shut off per project** (`coalwashMode: "off"` is the off-switch; a memory-heavy project can also just raise its own thresholds). The keys:

| Key | Default | What it does |
|---|---|---|
| `coalwashMode` | `auto` | Master switch: `auto` = session-start gauge + band nudges · `manual` = gauge silent, `/coalwash` only · `off` = fully silent |
| `language` | `auto` | Language for prompts and nudges (`auto` \| `th` \| `en` \| `ja` \| `zh` \| `es`) |
| `fullPercent` | `6` | Hard ceiling as % of platform context capacity — the FULL band's absolute clamp; raising it = consciously carrying more overhead ("buying a bigger SSD") |
| `targetPercent` | `3` | Low-water clean-to target (% of capacity, below `fullPercent`) — anti-thrash hysteresis |
| `fileMaxSizeKb` | `25` | Per-file cap in KB before a class-B file is flagged oversize |
| `quickVsFull` | `quick` | Default run tier: `quick` = free mechanical pass · `full` = paid semantic pass (always a separate consent) |
| `localOnly` | `false` | Trade-secret mode: mechanical Quick only — no **spawned sub** ever receives memory content; nothing beyond what your platform already loads reaches any model |
| `updateMode` | `ask` | Self-update behavior at session start (`ask` \| `auto` \| `remind` \| `off`) |
| `updateCheckDays` | `14` | Days between self-update checks/reminders |

Full key reference: every key + default lives in [`scripts/lib/config-schema.mjs`](scripts/lib/config-schema.mjs) and the commented template [`platform-configs/.coalwash.json`](platform-configs/.coalwash.json).

## 📊 Benchmark

CoalWash's claims are measured, not asserted, by fixture-based benchmarks with a runnable mechanical scorer: **sawtooth-vs-bloat** (clean-at-threshold vs let-it-bloat over N sessions — the cumulative always-loaded saving Δ%, the headline) plus the **infinity-loop fact-loss** and **consecutive-run ceiling** measurements behind the warning above. Headline digest: [`benchmarks/CoalWash/RESULTS.md`](https://github.com/TheColliery/.github/blob/main/benchmarks/CoalWash/RESULTS.md).

## 🧭 Part of TheColliery

CoalWash is the **memory-maintenance** member of the mining series, alongside [CoalMine](https://github.com/HetCreep/CoalMine) (quality canaries), [CoalTipple](https://github.com/TheColliery/CoalTipple) (model/effort routing), [CoalBoard](https://github.com/TheColliery/CoalBoard) (consensus & debate), [CoalHearth](https://github.com/TheColliery/CoalHearth) (session warm-resume), [CoalFace](https://github.com/TheColliery/CoalFace) (fan-out discipline), and [CoalLedger](https://github.com/TheColliery/CoalLedger) (docs health). Install one and it stands alone; install all and they compose without conflict (CoalWash defrags CoalHearth's memory; an interrupted CoalWash apply self-recovers from its own write-ahead journal — CoalHearth-side recognition of that journal is planned, not yet shipped). Shared doctrine: Phoenix-13 hooks (zero-dependency, no network, fail-silent), single-source-of-truth config schemas, consent-gated spend, and a strict no-overkill discipline. Series doctrine: [`TheColliery/.github`](https://github.com/TheColliery).

Zero-dependency, offline, no API keys.

---

## 📄 License

Apache License 2.0. See [LICENSE](LICENSE).
