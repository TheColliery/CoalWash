<div align="center">

# 🧼 CoalWash

> *Coal washing is the real mining process that cleans raw coal — separating the waste without damaging the coal.* This one is a memory washer/defragmenter for your agent: **it cleans the fat, never the meat.**

**A fidelity-first memory-defragment/cleanup engine** for agent class-B memory — the memory and governance files your platform loads into context every session. A free mechanical Quick pass plus a code-enforced fidelity gate prove zero **structured-token** loss by diff (links, dates, versions, URLs, quotes, numbers, code-spans, frontmatter — not hope; prose fidelity is the paid semantic layer's job); the semantic Full pass is a separate consent; every cut is snapshot-backed and revertible.

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

- **Structured facts are inviolable.** A mechanical fidelity gate diffs every rewrite's structured-token inventory — `[[wikilinks]]`, dates, versions, link/URL destinations, quoted spans, numerals, code-spans, frontmatter keys — and ANY drop blocks the apply: that class of fact-loss is caught by CODE, not hoped. A load-bearing **prose** fact (a sentence like "the rate limit is 5000/hr") is out of the mechanical gate's scope — that fidelity rests on the paid semantic reviewers **and you**, not this gate. The gate's honest scope is stated in the module itself.
- **Deletes are UNDO-backed, not pre-approved.** A delete/merge action is authorized by its presence in the adjudicated plan — no separate approval flag to check. Safety lives in UNDO instead: every apply snapshots (verified at creation) before the first mutation, and any failure triggers a whole-run rollback; a `pinned: true` file is refused outright — the gates do not depend on agent diligence.
- **The apply is transactional.** Exclusive lock, marked snapshot before the first mutation, fsync'd WAL, atomic writes, deletes last, wholesale rollback on any failure. The worst realistic outcome of any crash is *"the run did not happen"* — never *"memory is corrupted."*
- **A foreign mid-run write aborts everything.** If anything else touches your files during a run — a cloud-sync client, an editor, another agent — CoalWash detects it at the moment of writing, stops, and rolls back rather than guessing; and every snapshot is read back and verified before the destructive phase begins.
- **Plain in, plain out.** CoalWash never transforms your files into a tool-specific format — plain markdown in, plain markdown out; every artifact it writes (snapshots, WAL journal, `keeps.json`) is a plain file you can read without CoalWash.

**Honest frame:** CoalWash **slows how fast your memory-overhead grows** — a rate intervention, not a level reset. It does not eliminate memory cost, reach zero, or stop legitimate growth (the floor of real facts rises with your project; that is meat, not fat).

## ⚙️ How it works

One standing gauge at the chokepoint (memory is loaded every session, so a session-start caliper sees past, present, and future by construction), then a disciplined pipeline per run:

| Stage | Who | What |
|---|---|---|
| Gauge | code | Discover class-B per platform → measure footprint → break-even math → band verdict |
| Quick | code-gated mechanics | Exact-dedup, dead-link fix, whitespace, index rebuild, empty-table removal, own-knife residue sweep — free, deterministic; oversize/stale files are flagged, never rewritten here |
| Full | one outsider sub + the insider | Semantic garbage judgment (superseded / duplicate / point-in-time / over-verbose) by a zero-context outsider; the session agent adjudicates every flag — always a separate consent |
| Fidelity gate | code | Inventory diff, original vs new; any dropped link/date/version/frontmatter key blocks the apply |
| Apply | code | Delete/merge authorization is plan-sourced (no separate approval step) — lock → verified snapshot → WAL → atomic writes → deletes last → commit, or whole-run rollback; `pinned` files refused outright |
| Receipt | code | Pushes **one line** after any run that cut something — `cut ~N tok fat (−P%), saved ~M tok` (silence if nothing was cut); the fuller `class B: X KB -> X' KB · removed/trimmed/kept · fidelity gate: PASS` block is an on-demand pull surface (`/coalwash:stats` or the wizard), never pushed automatically |

**Why an outsider judges, not you:** it is a stranger walking through a house it has never lived in — it cannot know which things you still use, so it never throws anything out. Its only power is to point and ask, *"what is this, can it go?"* — you, the resident, answer with a concrete reason, never a feeling, and a settled answer sticks (an adjudicated keep is not re-asked next run without new evidence).

The gauge rides **Memory-BMI** = always-loaded footprint / lean floor (floor-relative, so real growth never false-fires) against **one hysteresis-gated ceiling**, a Schmitt trigger doing the anti-flapping job a clock used to: BMI reaching 1.5× the floor arms the ceiling, and it stays armed until BMI falls back to 1.2× — never a calendar. That armed ceiling *is* OBESE. **FULL is the economic cut-point on top of the same ceiling, not a separate fixed line:** once armed, FULL fires the instant the deterministic break-even math proves a wash pays for itself (`cost(one run) < cost(carrying the fat)`, numbers shown every time) — so FULL is always a subset of OBESE, and once proven it latches for the rest of the episode (a later dip doesn't un-FULL it; only a clean reset does). Separately, a **hard machine-capacity wall** (`fullPercent` of the platform's context capacity) can also force FULL, always-fixed, no BMI needed: footprint alone closing in on what the platform can hold is muscle that outgrew the machine, not fat to wash. Hitting that wall while the ceiling is disarmed means externalize/split, never wash-harder; hitting it while armed means real fat remains, so a wash helps first. Before any floor is measured (a store's first run), only the wall can fire (an absolute-cap heuristic) — BMI itself stays unmeasurable until a clean stamps a floor. **Only two things ever trigger a state change — Memory-BMI and that capacity wall; never time or age.** A cheap stat-only recheck also rides every `Stop` turn — re-stating the same always-loaded paths already known from the last gauge, no directory walk or content read — to catch a within-session spike (e.g. a large memory write) before the next `SessionStart`; the full re-measure only re-runs when that recheck implies real drift, never unconditionally.

| Band | Behavior |
|---|---|
| LEAN | Silent — a run would be a no-op, and none is offered |
| OBESE | Ceiling armed, but washing doesn't pay for itself yet: the configured exercise (`exercisePerBand.obese`, `quick` by default) runs automatically under standing config — no ask, just a one-line result when something is actually cut, silent otherwise. **OBESE never asks, no matter how long it persists or how often it recurs** — the wizard door lives at FULL only |
| FULL | The economic cut-point (ceiling armed + break-even proven, latched for the episode) or the hard capacity wall: force-runs the SAME free mechanical pass under standing config, numbers shown every time — what auto-Quick can't reach rides here and gets swept anyway, no user needed. Every cut is snapshot-backed and revertible. Still over FULL after that pass already ran this episode → **one ทำ/later ask** opens the wizard for semantic judgment — the sole ask site in the system, re-asked only once fat grows past the level last flagged. Firing on the capacity wall with ~no fat found means externalize/split, not another wash |

**Recovery — two bins, not just the run snapshot.** Every cut also lands in an age-and-size-bounded bin: mechanical Quick/Force cuts go to the **fat bin** (30-day horizon); wizard-tier deletes and shrinks go to **`store.old`** (60-day horizon — both sized to the owner's own ~monthly working cadence, so damage noticed at the next visit is still recoverable). Retention follows a Time Machine-style ladder — everything survives 48 hours untouched, then thins to one-per-day, then one-per-week — bounded by **whichever limit binds first**: the horizon above, or a size cap (the journald/logrotate model) set as a multiple of the *store's own measured bytes* (never the disk — CoalWash is a guest and can't know your SSD's capacity). Destruction runs only *inside* a real wash — never a clock, never a background sweep — and only after a verified delete, logged as a one-line death certificate (NIST SP 800-88 Clear-level: a plain, verified delete, not a physical-erasure claim). Recovery is pull-only: bin content is never pushed to an agent or re-loaded into memory — nothing reaches back out until someone goes looking for it.

**`localOnly` (trade-secret mode):** the SKILL contract runs mechanical Quick only and skips the semantic tier — agent-honored, not a code-enforced transmission block (the flag itself can't be weakened by a project config once set globally). Memory is private data; see [PRIVACY.md](PRIVACY.md).

## ⚠️ Read before you run it

> [!CAUTION]
> **System-level scope.** The files CoalWash washes are the ones that shape your agent's behavior *every session* — its kernel, in OS terms. Kernel-grade reach is exactly why the safety stack exists: verified snapshot before any mutation, a mechanical zero-loss gate, deletes that exist only inside the adjudicated plan, whole-run rollback. High stakes, capped blast radius.
>
> **1 — No calendar cadence, ever.** CoalWash triggers on measured BMI, never a clock — a schedule would clean already-lean memory for nothing and re-pay the semantic cost every round. Want to run it back-to-back in one sitting? The recommended ceiling is **benchmark-derived, not guessed** — check the [benchmark records](https://github.com/TheColliery/.github/tree/main/benchmarks/CoalWash/results) for the current published number; without one yet, the conservative default is **one Full run per sitting**.
>
> **2 — Past fat-exhaustion, a model can throw away something load-bearing — like a person can.** While real fat remains, cleaning is safe work; once none remains and the loop continues, every further semantic pass is pressure on the meat. That risk **varies by model**; the per-model fact-loss measurements live in the [benchmark records](https://github.com/TheColliery/.github/tree/main/benchmarks/CoalWash/results). The LEAN band exists to make post-exhaustion runs a no-op — trust its silence.

## 🧭 Compatibility

Cross-agent by design (the engine is zero-dependency Node scripts any agent can run; class-B layout is *discovered* per platform, never hardcoded) — **validated end-to-end on Claude Code only**. Every other platform is designed-degrade-safe, not yet validated: unknown platform → no auto-discovery, conservative flags, manual scope, never auto-delete. The activation ladder is capability-keyed: has lifecycle hooks → the shipped session-start gauge runs automatically (Claude Code today); no hooks → best-effort agent-driven offer (probabilistic, not hook parity); always → manual `/coalwash`. Band crossings resolve on the `Stop` hook — the same blocking channel `rot-canary` uses, so whatever surfaces (an ask, or an auto-run directive) is enforced, not merely suggested — edge-triggered per crossing, never a repeating per-turn nag (see the band table above for what auto-runs vs. what asks). A hookless platform gets only a single best-effort offer, with no repeat mechanism.

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
| `coalwashMode` | `auto` | Gauge switch: `auto` = session-start gauge + band nudges · `manual` = the gauge is silent, `/coalwash` only · `off` = the gauge never runs. (Orthogonal: the self-update nudge has its own switch — `updateMode: "off"` — so `manual` silences the *gauge*, not the periodic update check.) |
| `language` | `auto` | Language for prompts and nudges (`auto` \| `th` \| `en` \| `ja` \| `zh` \| `es`) |
| `fullPercent` | `6` | Hard capacity-line ceiling as % of platform context capacity — the WALL, one of two ways into FULL (the other is the economic break-even proof); raising it = consciously carrying more overhead ("buying a bigger SSD") |
| `targetPercent` | `3` | Low-water clean-to target (% of capacity, below `fullPercent`) — anti-thrash hysteresis |
| `fileMaxSizeKb` | `25` | Per-file cap in KB before a class-B file is flagged oversize |
| `quickVsFull` | `quick` | Default run tier: `quick` = free mechanical pass · `full` = paid semantic pass (always a separate consent) |
| `localOnly` | `false` | Trade-secret mode: the SKILL contract runs Quick-only and skips the semantic tier — agent-honored, not a code-enforced transmission block; the flag itself can't be weakened by a project config |
| `updateMode` | `ask` | Self-update behavior at session start (`ask` \| `auto` \| `remind` \| `off`) |
| `updateCheckDays` | `14` | Days between self-update checks/reminders |
| `exercisePerBand` | `{obese: quick, full: full}` | Per-ceiling exercise (`quick` \| `full`, for obese/full — band-collapse retired the separate plump rung; a fat-only scoping refinement is a later release): `quick` auto-runs with no ask, `full` routes that ceiling through the Stop-hook ทำ/later ask instead |
| `forceMode` | `auto` | FULL+economical crossing behavior at Stop: `auto` = standing-consent auto-run (the rot-canary `autoFixMode` model) · `ask` = FULL asks like other ceilings · `off` = same as ask — never silent (suppresses only the auto-run authorization, never FULL awareness) |

Full key reference: every key + default lives in [`scripts/lib/config-schema.mjs`](scripts/lib/config-schema.mjs) and the commented template [`platform-configs/.coalwash.json`](platform-configs/.coalwash.json).

## 📊 Benchmark

CoalWash's claims are measured, not asserted, by fixture-based benchmarks with a runnable mechanical scorer: **sawtooth-vs-bloat** (clean-at-threshold vs let-it-bloat over N sessions — the cumulative always-loaded saving Δ%, the headline) plus the **infinity-loop fact-loss** and **consecutive-run ceiling** measurements behind the warning above. Headline digest: [`benchmarks/CoalWash/RESULTS.md`](https://github.com/TheColliery/.github/blob/main/benchmarks/CoalWash/RESULTS.md).

## 🧭 Part of TheColliery

CoalWash is the **memory-maintenance** member of the mining series, alongside [CoalMine](https://github.com/HetCreep/CoalMine) (quality canaries), [CoalTipple](https://github.com/TheColliery/CoalTipple) (model/effort routing), [CoalBoard](https://github.com/TheColliery/CoalBoard) (consensus & debate), [CoalHearth](https://github.com/TheColliery/CoalHearth) (session warm-resume), [CoalFace](https://github.com/TheColliery/CoalFace) (fan-out discipline), and [CoalLedger](https://github.com/TheColliery/CoalLedger) (docs health). Install one and it stands alone; install all and they compose without conflict (CoalWash defrags CoalHearth's memory; an interrupted CoalWash apply self-recovers from its own write-ahead journal — CoalHearth-side recognition of that journal is planned, not yet shipped). Shared doctrine: Phoenix-13 hooks (zero-dependency, no network, fail-silent), single-source-of-truth config schemas, consent-gated spend, and a strict no-overkill discipline. Series doctrine: [`TheColliery/.github`](https://github.com/TheColliery).

Zero-dependency, offline, no API keys.

---

## 📄 License

Apache License 2.0. See [LICENSE](LICENSE).
