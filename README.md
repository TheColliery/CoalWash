<div align="center">

# 🧼 CoalWash

> *Coal washing is the real mining process that cleans raw coal — separating the waste without damaging the coal.* This one is a memory washer/defragmenter for your agent: **it cleans the fat, never the meat.**

**A fidelity-first memory-defragment/cleanup engine** for agent class-B memory — the memory and governance files your platform loads into context every session. A free mechanical Quick pass plus a code-enforced fidelity gate prove zero **structured-token** loss by diff (links, dates, versions, URLs, quotes, numbers, code-spans, frontmatter — not hope; prose fidelity is the paid semantic layer's job); the semantic Full pass is a separate consent; every cut is snapshot-backed and revertible.

![version](https://img.shields.io/github/v/tag/TheColliery/CoalWash?label=version&color=blue)
![license](https://img.shields.io/badge/license-Apache_2.0-blue)
![status](https://img.shields.io/badge/status-rc-yellow)

**Compatibility** ·
![Claude Code](https://img.shields.io/badge/Claude_Code-validated-brightgreen)
![Antigravity](https://img.shields.io/badge/Antigravity-manual-blue)
![Cursor](https://img.shields.io/badge/Cursor-manual-blue)
![Codex](https://img.shields.io/badge/Codex-manual-blue)
![Gemini CLI](https://img.shields.io/badge/Gemini_CLI-manual-blue)
![Cline](https://img.shields.io/badge/Cline-manual-blue)
![Copilot](https://img.shields.io/badge/Copilot-manual-blue)

<sub>The auto layer — the session-start gauge and the enforce/airbag hooks — runs on **Claude Code** only today; every other platform sits at the **manual** rung of the capability-keyed activation ladder (hooks → best-effort agent-driven offer → manual): `/coalwash` by hand after a file-copy install. `validated` = ran end-to-end on that platform · `manual` = the documented file-copy install — designed-degrade-safe, not yet run there.</sub>

[Changelog](CHANGELOG.md) · [Security](SECURITY.md) · [Privacy](PRIVACY.md) · [Releases](https://github.com/TheColliery/CoalWash/releases)

**Part of [TheColliery](https://github.com/TheColliery)** — siblings: **[CoalMine](https://github.com/HetCreep/CoalMine)** (quality canaries) · **[CoalTipple](https://github.com/TheColliery/CoalTipple)** (model/effort routing) · **[CoalBoard](https://github.com/TheColliery/CoalBoard)** (consensus board) · **[CoalHearth](https://github.com/TheColliery/CoalHearth)** (warm-resume) · **[CoalFace](https://github.com/TheColliery/CoalFace)** (fan-out discipline) · **[CoalLedger](https://github.com/TheColliery/CoalLedger)** (docs health).

</div>

---

## 🧼 What it is

Agent memory grows additively, unmanaged — the always-loaded set (memory index + governance files) is paid **every session, forever**, and the market's cleanup tools are lossy summarize-and-hope. Cutting the wrong line from a memory your agent trusts is silent breakage that never surfaces.

CoalWash is the SSD cleanup + defragment discipline ported to that store, **fidelity-first**:

- **Structured facts are inviolable.** A mechanical fidelity gate diffs every rewrite's structured-token inventory — `[[wikilinks]]`, dates, versions, link/URL destinations, quoted spans, numerals, code-spans, frontmatter keys — any drop blocks the apply, code-caught, not hoped. A load-bearing **prose** fact (e.g. "the rate limit is 5000/hr") is outside the gate's scope — that fidelity rests on the paid semantic reviewers **and you**, stated honestly in the module itself.
- **Deletes are UNDO-backed, not pre-approved.** A delete/merge is authorized by its presence in the adjudicated plan — no separate approval flag. Safety lives in UNDO instead: every apply snapshots (verified at creation) before the first mutation, any failure triggers a whole-run rollback, a `pinned: true` file is refused outright — the gates don't depend on agent diligence.
- **The apply is transactional.** Exclusive lock, marked snapshot before the first mutation, fsync'd WAL, atomic writes, deletes last, wholesale rollback on any failure. Worst realistic crash outcome: *"the run did not happen"* — never *"memory is corrupted."*
- **A foreign mid-run write aborts everything.** Anything else touching your files mid-run — a cloud-sync client, an editor, another agent — CoalWash detects at the moment of writing, stops, rolls back rather than guessing; every snapshot is also read back and verified before the destructive phase begins.
- **Plain in, plain out.** CoalWash never transforms your files into a tool-specific format — plain markdown in, plain markdown out; every artifact it writes (snapshots, WAL journal, `keeps.json`) is a plain file you can read without CoalWash.

**Honest frame:** CoalWash **slows how fast your memory-overhead grows** — a rate intervention, not a level reset. It doesn't eliminate memory cost, reach zero, or stop legitimate growth (the floor of real facts rises with your project; that's meat, not fat).

## ⚙️ How it works

One standing gauge sits at the chokepoint — memory loads every session, so a session-start caliper sees past, present, and future by construction — then a disciplined pipeline runs per wash:

| Stage | Who | What |
|---|---|---|
| Gauge | code | Discover class-B per platform → measure footprint → break-even math → band verdict |
| Quick | code-gated mechanics | Exact-dedup, dead-link fix, whitespace, index rebuild, empty-table removal, own-knife residue sweep — free, deterministic; oversize/stale files flagged, never rewritten here |
| Full | one outsider sub + the insider | Semantic garbage judgment (superseded / duplicate / point-in-time / over-verbose) by a zero-context outsider; session agent adjudicates every flag — always a separate consent |
| Fidelity gate | code | Inventory diff, original vs new; any dropped link/date/version/frontmatter key blocks the apply |
| Apply | code | Delete/merge authorization is plan-sourced (no separate approval step) — lock → verified snapshot → WAL → atomic writes → deletes last → commit, or whole-run rollback; `pinned` files refused outright |
| Receipt | code | Pushes **one line** after any run that cuts something — `cut ~N tok fat (−P%), saved ~M tok` (silent if nothing cut); the fuller `class B: X KB -> X' KB · removed/trimmed/kept · fidelity gate: PASS` block is an on-demand pull (`/coalwash:stats` or the wizard), never automatic |

**Why an outsider judges, not you:** it's a stranger walking through a house it's never lived in — it can't know what you still use, so it never discards anything itself. Its only power: point and ask, *"what is this, can it go?"* You answer with a concrete reason, not a feeling — a settled answer sticks (an adjudicated keep isn't re-asked without new evidence).

**Memory-BMI** = footprint / lean floor (floor-relative — real growth never false-fires), checked against **one hysteresis-gated ceiling**: 1.5×floor arms it, 1.2×floor disarms it — never a calendar. Armed = OBESE.

**FULL is the economic cut-point on that same ceiling**, not a separate line: armed + break-even proven (`cost(one run) < cost(carrying the fat)`, numbers always shown) fires FULL instantly — always a subset of OBESE, latching for the episode (a dip won't un-FULL it, only a clean reset does). A **hard capacity wall** (`fullPercent` of the platform's context capacity) forces FULL separately, always-fixed, no BMI needed — capacity-nearing footprint is muscle, not fat: disarmed+wall → externalize/split, never wash-harder; armed+wall → real fat remains, wash first. Day one runs against a *provisional* floor (install footprint, BMI=1.00, tracks growth) until a gate-passed clean stamps the true floor — a day-one or too-small-to-trust-a-ratio store isn't over the ceiling, so only the wall forces its FULL. **Only Memory-BMI and the wall ever trigger a state change — never time or age.** A stat-only `Stop`-turn recheck (last gauge's known paths, no directory walk or content read) catches a within-session spike before the next `SessionStart`; full re-measure only re-runs on real drift, never unconditionally.

| Band | Behavior |
|---|---|
| LEAN | Silent — a run would be a no-op, so none is offered |
| OBESE | Ceiling armed but not yet economical: the Stop hook directs the configured exercise (`exercisePerBand.obese`, `quick` by default), the session agent runs it under standing config — no user ask, a one-line result when something's cut, silent otherwise. **Never asks, however long it persists or recurs** — the wizard door lives at FULL only |
| FULL | Economic cut-point or capacity wall: hook directs the same free mechanical pass, agent runs it, numbers always shown — no user ask; reaches what OBESE couldn't, sweeps it anyway. Every cut snapshot-backed, revertible. Still over after that pass ran this episode → **one run/later ask** opens the wizard for semantic judgment — the system's sole ask site, re-asked only once fat grows past the last-flagged level. Firing on the wall with ~no fat found means externalize/split, not another wash |

| Mechanism | Detail |
|---|---|
| **True bill (0o)** | Every subagent re-carries its room's parcel — fat cost = footprint × (main + every spawn). Session hooks fire on main only, never inside a sub (named platform constraint); tool-level hooks DO follow sub calls, so `PostToolUse` on the Agent tool silently counts each spawn there, adding the room's cached parcel figure — write-only, no per-spawn output. Surfaces as one clause where the tool already speaks (`/coalwash:stats`: "subs this session: N spawns ≈ X tok parcel"; the FULL directive numbers); zero spawns = no clause. A washed room cheapens every future spawn automatically — that, not the meter, is the fix |
| **Write guard (0p)** | Other hands edit the store daily too (a subagent, a stray edit, another tool), so the fidelity gate gets an **advisory** twin on the write path: an **airbag** snapshots a file on its first write each session (the only undo net for gitignored `MEMORY.md`/`CLAUDE.md`); a **seatbelt** flags a dropped link/number/quote with one FYI line pointing at the snapshot. **Never blocks** — a deliberate delete is legitimate, so it informs, not gates; a false alarm costs one ignorable line. Reaches inside subagents (tool hooks do), silent on clean edits; recovery copies the real bytes, never an AI re-typing what it thinks was there. Off: `writeGuard: "snapshot-only"` or `"off"` |
| **Recovery bins** | Every cut lands in an age-and-size-bounded bin: mechanical Quick/Force cuts → the **fat bin** (30-day horizon), wizard-tier deletes/shrinks → **`store.old`** (60-day horizon) — both sized to the owner's ~monthly cadence. Retention: a Time Machine-style ladder (48h untouched, then one-per-day, then one-per-week), bounded by whichever limit binds first — the horizon above, or a size cap (the journald/logrotate model, a multiple of the store's own bytes, never the disk: CoalWash can't know your SSD's capacity). Destruction only *inside* a real wash — never a clock, never a background sweep — only after a verified delete, logged as a one-line death certificate (NIST SP 800-88 Clear-level: a plain, verified delete, not physical-erasure). Pull-only: never pushed to an agent or reloaded into memory |
| **`localOnly`** (trade-secret mode) | Quick-only, the semantic tier skipped — agent-honored, not a code-enforced transmission block (can't be weakened by a project config once set globally; full key detail below). Memory is private data; see [PRIVACY.md](PRIVACY.md) |

## ⚠️ Read before you run it

> [!CAUTION]
> **System-level scope.** CoalWash washes the files that shape your agent's behavior *every session* — its kernel, in OS terms. Hence the safety stack (snapshot, zero-loss gate, plan-only deletes, whole-run rollback — see above). High stakes, capped blast radius.
>
> **1 — No calendar cadence, ever.** CoalWash triggers on measured BMI, never a clock — a schedule would clean already-lean memory for nothing and re-pay the semantic cost every round. Back-to-back in one sitting? The ceiling is **benchmark-derived**: the durability campaign ran **7 consecutive Full rounds** before retirement, and the published rule is a protocol — **stop at two consecutive damage-dry rounds, then one varied-angle sweep before closing** (a dry verdict is angle-relative; a fresh lens finds what one angle never will). See the [benchmark records](https://github.com/TheColliery/.github/tree/main/benchmarks/CoalWash/results); when in doubt, one Full run per sitting is always safe.
>
> **2 — Past fat-exhaustion, a model can throw away something load-bearing — like a person can.** While real fat remains, cleaning is safe; once none remains, every further semantic pass pressures the meat. Risk **varies by model** — the [benchmark records](https://github.com/TheColliery/.github/tree/main/benchmarks/CoalWash/results) hold what's measured so far (a per-tier loss matrix is still being built; numbers are bound to the models/versions each dated record names). Structurally, the campaign proved the safety floor is **code-held** — gates, snapshot, and keeps caught every engineered trap regardless of model; a stronger model found more fat, never lost more fact. The LEAN band makes post-exhaustion runs a no-op — trust its silence.

## 🧭 Compatibility

| Aspect | Detail |
|---|---|
| **Validation** | Cross-agent by design — zero-dependency Node scripts any agent can run, class-B layout *discovered* per platform, never hardcoded — but **validated end-to-end on Claude Code only**; every other platform is the **manual** tier — designed-degrade-safe, not yet validated. Unknown platform: the agent proposes files it can *see* auto-loaded in its context, code certifies each, a human confirms — still never auto-delete |
| **Activation ladder** | Capability-keyed: lifecycle hooks → the gauge runs automatically (Claude Code today); no hooks → best-effort agent-driven offer (probabilistic, not hook parity); always → manual `/coalwash`. Band crossings resolve on the `Stop` hook (the same blocking channel `rot-canary` uses), so whatever surfaces is enforced, not suggested — edge-triggered, never a repeating nag. Hookless platform: one best-effort offer, no repeat |
| **The list is a mirror, not a list** | CoalWash keeps no hand-maintained inventory of always-loaded memory — the list *mirrors* the real load list: whatever the platform delivers into the agent's context is class-B, whether company-wired, user-wired, or a future update adds a surface that doesn't exist today. A new auto-loaded file enters the measurement by definition, no code change. On known platforms this runs as a cheap drift-check at wizard entry (agent-seen vs adapter-listed, flagging adapter rot the day it happens); every candidate is code-certified — exists, contained in the home/project trees, on-disk head matches what the agent actually saw load — so a hallucinated or spoofed entry can never join the measurement. Fail direction: undercount — unseen is unmeasured is uncut |
| **A well-behaved guest on your disk** | CoalWash keeps its own per-project bookkeeping (the session gauge's state) *inside* the platform's own project directory — on Claude Code, beside the memory folder it measures — so the platform's lifecycle carries it: remove a project, its state goes too, for free. Every path CoalWash derives is realpath-contained to the config root (`~/.claude`) and fails closed — never a byte outside it. Validated on Claude Code's layout; other platforms get the same one-namespace discipline, designed-for, not yet validated |

## 🚀 Install

**Claude Code** — one command pair (also wires the session-start gauge):

```bash
claude plugin marketplace add TheColliery/CoalWash
claude plugin install coalwash@coalwash
```

**Other agents** (Antigravity · Cursor · Codex · Gemini CLI · Cline · Copilot) — file-copy: copy `skills/coalwash/` (skill + references) and `scripts/lib/` (the engine) into your platform's skill directory, keeping the relative layout (`skills/coalwash/SKILL.md` resolves the engine at `../../scripts/lib`). On **Antigravity** that directory is `~/.gemini/config/skills/` (global) or `<workspace>/.agents/skills/` (per-project). The gauge hook is Claude-Code-only; elsewhere run `/coalwash` manually. No API keys, no network, no `npm install`.

> [!TIP]
> Install **globally** — CoalWash is a maintenance utility you want available everywhere, and it still operates per-project, per-session. A project config can tune or shut it off locally.

## 🔧 Configure

Every tool in the series supports two config levels — a global `~/.claude/.coalwash.json` and a per-project `.coalwash.json` override (project wins) — so a globally-installed skill can be tuned or **shut off per project** (`coalwashMode: "off"` is the off-switch) — a skill you don't need in a given project stops loading (and burning tokens) there. The main keys:

| Key | Default | What it does |
|---|---|---|
| `coalwashMode` | `auto` | The power switch: `auto` = session-start gauge + band nudges · `manual` = gauge silent, `/coalwash` only · `off` = never runs. (The self-update nudge has its own switch, `updateMode`, so `manual` silences the *gauge*, not the update check.) |
| `quickVsFull` | `quick` | Default run tier: `quick` = free mechanical pass · `full` = paid semantic pass (always a separate consent) |
| `localOnly` | `false` | Trade-secret mode: the SKILL contract runs Quick-only and skips the semantic tier — agent-honored, not a code-enforced transmission block; the flag itself can't be weakened by a project config |
| `language` | `auto` | Language for prompts and nudges (`auto` \| `th` \| `en` \| `ja` \| `zh` \| `es`) |

> **No force off switch — by design.** Deliberately no `forceMode` key — FULL's free mechanical pass (above) runs unconditionally, the way an OS forces disk-cleanup: no user ask needed. Safety lives in **undo** (verified snapshot + whole-run rollback + the recovery bins); every run leaves its receipt numbers; the paid semantic tier still never runs without your press. A legacy config carrying `forceMode` is tolerated, ignored. The skill's whole power switch remains `coalwashMode: "off"`.

Full key reference: every key + default lives in [`scripts/lib/config-schema.mjs`](scripts/lib/config-schema.mjs) and the commented template [`platform-configs/.coalwash.json`](platform-configs/.coalwash.json).

## 📊 Benchmark

CoalWash's claims are measured, not asserted, by fixture-based benchmarks with a runnable mechanical scorer: **sawtooth-vs-bloat** (clean-at-threshold vs let-it-bloat over N sessions — the cumulative always-loaded saving Δ%, the headline) plus the **infinity-loop fact-loss** and **consecutive-run ceiling** measurements behind the warning above. Headline digest: [`benchmarks/CoalWash/RESULTS.md`](https://github.com/TheColliery/.github/blob/main/benchmarks/CoalWash/RESULTS.md).

## 🧭 Part of TheColliery

CoalWash is the **memory-maintenance** member of the mining series, alongside [CoalMine](https://github.com/HetCreep/CoalMine) (quality canaries), [CoalTipple](https://github.com/TheColliery/CoalTipple) (model/effort routing), [CoalBoard](https://github.com/TheColliery/CoalBoard) (consensus & debate), [CoalHearth](https://github.com/TheColliery/CoalHearth) (session warm-resume), [CoalFace](https://github.com/TheColliery/CoalFace) (fan-out discipline), and [CoalLedger](https://github.com/TheColliery/CoalLedger) (docs health). Install one, it stands alone; install all, they compose without conflict (CoalWash defrags CoalHearth's memory; an interrupted apply self-recovers from its own write-ahead journal — CoalHearth-side recognition is planned, not yet shipped). Shared doctrine: Phoenix-13 hooks (zero-dependency, no network, fail-silent), single-source-of-truth config schemas, consent-gated spend, and a strict no-overkill discipline. Series doctrine: [`TheColliery/.github`](https://github.com/TheColliery).

Zero-dependency, offline, no API keys.

---

## 📄 License

Apache License 2.0. See [LICENSE](LICENSE).
