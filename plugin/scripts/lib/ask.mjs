// ask.mjs — program-side FIXED ask/directive templates (beta.12 item 3): the
// CODE builds the exact text; the agent renders whatever question-tool call
// the template specifies and fills NO prose of its own. Two things this
// closes:
//   (1) RESIDENT-ASK CONTAMINATION (MEMORY.md, a live incident): an
//       agent-COMPOSED ask once quoted the store's OWN design backlog as its
//       rationale — a closed loop (the loaded memory advising on washing
//       itself). A fixed template built from numbers alone can never do that.
//   (2) ANSWER-FIRST ordering (beta.11 queue item 0, "ไม่ว่าจะกดตัวเลือกไหน
//       กลับไปตอบ prompt ด้วย" — fixes the สวัสดี-flow hole where an ask fired
//       at session start and the user's actual message went unanswered):
//       every ask/directive embeds a fixed REMINDER clause so the tool
//       result (the freshest context item once the ask resolves) carries the
//       agent back to the turn's real prompt even if sequencing breaks. The
//       hook has no access to the prompt TEXT (neither SessionStart's nor
//       Stop's stdin carries one) — the clause instructs the agent to recall
//       its OWN context, never a literal string substitution.
//
// Every builder returns a single string — the Stop hook's `reason` field
// (the `{decision:'block', reason}` channel) or SessionStart's plain
// context-injection line. This module only moves STRING-BUILDING out of the
// hook into tested, reusable, agent-composition-free code.

export const ANSWER_FIRST_REMINDER =
  "Answer the user's ORIGINAL message for this turn FIRST if you have not already — this ask/directive rides at the END of your response, never before it. Once it resolves, return to (or continue) answering that original message; never treat this as the whole turn.";

// Break-even payback line (queue 0c: "the OBESE strong-ask gains the
// break-even line, today FULL-only"): shared by the ceiling ask and the force
// directive so both surfaces show the SAME numbers in the SAME shape.
// `breakEven` = the object caliper.breakEven() returns (or the cached subset
// recordVerdict cache round-trip); absent/zero-fat degrades to ''.
function paybackLine(breakEven, exercise) {
  if (!breakEven || !Number.isFinite(breakEven.perDay) || breakEven.perDay <= 0) return '';
  const be = Number.isFinite(breakEven.breakEvenDays) ? `~${Math.ceil(breakEven.breakEvenDays)} session(s)` : 'n/a';
  const upperBound = breakEven.floorUnmeasured ? ' (floor unmeasured — an upper bound)' : '';
  return ` Carrying this fat costs ~${breakEven.perDay} tok/session${upperBound}; one ${exercise} run pays back in ${be}.`;
}

// 0o true-bill clause — the accumulated sub-spawn parcel bill, rendered ONLY
// when spawns actually happened this session (zero/absent = the clause is
// ABSENT, no "0 spawns" noise — the NOISE RULE's surfacing half: the spawn
// meter itself never speaks; its figure rides as ONE clause on the voices
// that already exist). `spawns` = { subSpawns, subParcelTokens } read off
// the project state entry.
function spawnBillLine(spawns) {
  const n = Number(spawns && spawns.subSpawns);
  if (!Number.isFinite(n) || n <= 0) return '';
  const tok = Number(spawns && spawns.subParcelTokens);
  const cost = Number.isFinite(tok) && tok > 0 ? ` ≈ ${Math.round(tok)} tok of parcel (~est)` : '';
  return ` This fat also rode ${Math.round(n)} sub spawn(s)${cost} this session.`;
}

// (0m note: the old `ceilingAsk` ทำ/later template died with the forceMode
// knob — force at FULL is unconditional now, so no "suppressed/disarmed
// FULL" state exists to ask about, and OBESE never asks by ruling. The
// wizard-escalation template below is the ONE surviving ask.)

// The FULL force directive — UNCONDITIONAL (0m "FORCE = THE FREE TIER, NO
// PROOF NEEDED" + "FORCE IS A DICTATOR, NO OFF SWITCH"): every FULL
// crossing — economic AND absolute-cap — force-runs the FREE mechanical
// Quick pass under the same standing consent as OBESE's auto-Quick. No
// economic proof gates the free tier (the break-even proof governs the PAID
// wizard); no forceMode knob exists (the Windows critical-space-maintenance
// model — safety is UNDO, the receipt is the surfacing). The headline names
// the numbers that actually triggered THIS crossing: the economic band
// quotes its break-even proof; the wall case quotes footprint-vs-wall (a
// day-one provisional store has fat ~0 by definition — quoting fat there
// would read as "nothing to do" on the exact store most over budget); wall
// numbers missing (a pre-beta.13 cache with no byte baseline) degrade to a
// plain fat figure — never null/undefined artifacts.
export function forceAuto(opts) {
  const { fatTokens, breakEven, reason, footprintTokens, hardCeilingTokens, spawns } = opts || {};
  const fat = Number.isFinite(fatTokens) ? Math.round(fatTokens) : 0;
  const payback = paybackLine(breakEven, 'quick');
  const spawnBill = spawnBillLine(spawns); // 0o: absent when zero spawns
  let headline;
  if (reason === 'absolute-cap') {
    const fp = Number(footprintTokens);
    const wall = Number(hardCeilingTokens);
    headline = (Number.isFinite(fp) && fp > 0 && Number.isFinite(wall) && wall > 0)
      ? `FULL band — over the capacity wall (store ~${Math.round(fp)} tok vs the ~${Math.round(wall)} tok wall)`
      : `FULL band crossed (fat ~${fat} tok)`;
  } else {
    headline = `FULL band + break-even proven (numbers: fat ~${fat} tok)`;
  }
  return `[CoalWash] ${headline}.${payback}${spawnBill} force is non-optional at FULL (the OS-maintenance model) — run the free mechanical Quick pass NOW (stage-only; every cut is snapshot-backed — one command rolls the whole run back), then note the receipt path to the user in one line. This fires once per crossing, not per session. ${ANSWER_FIRST_REMINDER}`;
}

// The OBESE auto-directive (queue 0d "OBESE AUTO-QUICK, NO ASK"; F3 made it
// UNCONDITIONAL — the old exercisePerBand.obese:'full' escape hatch to an
// ask is REMOVED, main-adjudicated per the thrice-reconfirmed 0f ruling
// "OBESE never asks, no matter what"): standing config IS the consent (the
// same "config is a valid consent form" shape as rot-canary's
// autoFixMode), so no ask fires on this band, ever. Unlike FULL's force,
// this needs no break-even proof: Quick is free/mechanical, so there is no
// "is it worth paying for" question to prove. Safety claim (honest form,
// never "cuts nothing wrong"): reversible-by-construction (snapshot +
// whole-run rollback) + gate-interlocked (the fidelity gate blocks any drop
// even from a buggy rule) + structure-scoped (every Quick rule is
// diff-provable) — the SSD formula: not "no bit flips", "no flip escapes
// ECC".
export function obeseAutoQuick(opts) {
  const { fatTokens, breakEven } = opts || {};
  const fat = Number.isFinite(fatTokens) ? Math.round(fatTokens) : 0;
  const payback = paybackLine(breakEven, 'quick');
  return `[CoalWash] memory crossed the OBESE ceiling (fat ~${fat} tok) — the configured exercise is quick.${payback} standing config authorizes the free mechanical Quick pass NOW, no ask — run it (stage-only; every cut is snapshot-backed and revertible), then push ONLY the one-line result (receipt.mjs's oneLineResult — no full receipt block, no narration; cutting nothing stays silent). This fires once per crossing, not per session. ${ANSWER_FIRST_REMINDER}`;
}

// The wizard-escalation ask (queue 0f, "AUTHORITATIVE 3-FLOW" — SUPERSEDES
// 0e "THE OBESE LOOP": same mechanism, trigger band relocated OBESE->FULL):
// fires when a FULL force-run has already tried Quick this episode
// (quickTried) and the store is STILL over the FULL capacity ceiling.
// Mechanical cutting is exhausted; only the wizard's semantic tier (the
// zero-context outsider) can judge what remains, so this IS a real
// two-button ask — the ONE site the ask survives for (0d: OBESE is
// auto-Quick-silent, it never asks). Frequency is gated by fat GROWTH, never
// a clock (caliper.recordCrossing's own lastEscalationFat check) — every
// firing rides a genuinely NEW fat lump, never a re-nag of the same
// unchanged plateau.
export function wizardEscalation(opts) {
  const { fatTokens, breakEven, spawns } = opts || {};
  const fat = Number.isFinite(fatTokens) ? Math.round(fatTokens) : 0;
  const payback = paybackLine(breakEven, 'wizard');
  const spawnBill = spawnBillLine(spawns); // 0o: absent when zero spawns
  return `[CoalWash] memory is STILL over the FULL capacity ceiling (fat ~${fat} tok) after the automatic mechanical Quick pass already ran this episode — the remaining fat needs semantic judgment a script cannot make.${payback}${spawnBill} Offer the user via your question tool, exactly two options: ทำ (open the /coalwash wizard now, "Fat + reorganize muscle" tier — the zero-context outsider reviews what mechanical cutting could not) / later (dismiss; carries forward — this same ask returns only once the fat GROWS further, never on a timer). If the user picks ทำ: run the wizard per the coalwash skill. This crossing is marked consumed the moment this ask fires. ${ANSWER_FIRST_REMINDER}`;
}

// The WRITE-GUARD SEATBELT advisory (0p) — a fixed program-side template
// (the RESIDENT-ASK-CONTAMINATION lesson: the hook never composes prose).
// ADVISORY ONLY — FYI-framed, never a block, never an error. FP DECISION
// (option ii): it fires on ANY structured drop with no deliberate-vs-careless
// heuristic; a deliberate delete is legitimate, so the wording makes clear
// it's an FYI and points at the pre-edit snapshot so every fire is a usable
// undo hint (the byte-exact original is at snapshotPath — restore-by-reference,
// code copies the bytes, never the agent). `classes` = the fidelity-gate drop
// types present; `oversize` = the file exceeded the diff cap (snapshot stands,
// diff skipped).
export function seatbeltAdvisory(opts) {
  const { file, classes, snapshotPath, oversize } = opts || {};
  const f = typeof file === 'string' && file ? file : '(unknown file)';
  const snap = typeof snapshotPath === 'string' && snapshotPath ? snapshotPath : '';
  const recover = snap ? ` A byte-exact pre-edit snapshot is at ${snap} — copy it back (or \`node scripts/lib/cli.mjs writeguard-restore ${snap.split(/[\\/]/).pop()} > "${f}"\`) if the drop was a slip; never re-type the lost content, restore the real bytes.` : '';
  if (oversize) {
    return `[CoalWash] write-guard (FYI, not an error, not a block): ${f} is a class-B governance/memory file over the diff-size cap — a pre-edit snapshot was taken but the fidelity diff was skipped (file oversize).${recover}`;
  }
  const list = Array.isArray(classes) && classes.length ? classes.join(', ') : 'structured tokens';
  return `[CoalWash] write-guard (FYI, not an error, not a block): after this edit, ${f} no longer contains some ${list} it had at the start of the session — a deliberate cut is fine, this only flags it in case it was a slip.${recover}`;
}

// The FULL(externalize) advisory — pure information, never an ask (a wash
// cannot help ~all-muscle over capacity; the growable-full invariant forbids
// steering the user into washing legitimate muscle). Fixed-template for the
// same program-side-text reason as the asks above. #21 EXTERNALIZE-TEMPLATE:
// externalize is pure INFORMATION (a wash cannot shrink muscle), so CoalWash
// never auto-moves it — the template names the hand-move steps (cluster ->
// destination -> pointer), the USER/agent relocates by hand, and the write-path
// AIRBAG (0p) snapshots that hand-move. Precedent = the CoalPortal record
// (memory -> a durable file, a pointer left behind).
export function externalizeAdvisory(opts) {
  const { hardCeilingTokens } = opts || {};
  const cap = Number.isFinite(hardCeilingTokens) ? hardCeilingTokens : '?';
  return `[CoalWash] memory gauge: FULL (externalize) — this store has ~no reclaimable fat (muscle, not bloat) but exceeds the machine's working-capacity ceiling (~${cap} tok, a rough placeholder). SURFACE this line to the user verbatim, mentioned only AFTER you've answered their actual message, never before it. A wash cannot shrink muscle — the only move is to EXTERNALIZE (relocate muscle OUT of the always-loaded set). CoalWash NEVER auto-moves it (externalize is pure information; the write-path airbag snapshots your hand-move). The template: (1) CLUSTER the muscle by topic (largest cohesive block first); (2) pick a DESTINATION per cluster — a project doc / blueprint / design file that loads on demand, not every session; (3) MOVE it there by hand, leaving a one-line POINTER behind in the always-loaded file (title + where it went) so recall still reaches it. Precedent: the CoalPortal record moved from memory to a durable file with a pointer left behind. Or consciously raise fullPercent (the "bigger SSD" choice) to carry the muscle as-is.`;
}

// The dig-gauge ULTRA offer (ULTRA trigger #2, dig-gauge.mjs) — fired on a
// CRUSHING pre-read verdict, BEFORE the agent reads a single candidate.
// Program-built (the fixed-template discipline above), answer-first (the offer
// rides the END of the turn — the dig itself serves the user's request, so the
// offer never preempts it), REPORT-ONLY (declining proceeds with the raw dig;
// nothing is ever blocked). `verdict` = digGauge()'s output (files/totalTok/
// largestTok/tripped). The economics name the multiplicative burn (why the
// gate is pre-READ, not post-read): the pile is re-carried EVERY turn and
// re-paid on every sub-spawn's prefix, so a one-time read undercounts it.
export function digGaugeOffer(verdict) {
  const v = verdict || {};
  const n = Number(v.files) || 0;
  const total = Number(v.totalTok) || 0;
  const largest = Number(v.largestTok) || 0;
  const why = Array.isArray(v.tripped) && v.tripped.length ? v.tripped.join('+') : 'crush';
  return `[CoalWash] dig-gauge: CRUSHING (${why}) — reading these ${n} candidate(s) pulls ~${total} tok into context, RE-CARRIED every turn and re-paid on every sub spawn's prefix (the multiplicative burn a one-time read hides). ULTRA (/coalwash → "ULTRA — + estate") archives them + builds a dig-index: estate-search returns compact rows, estate-restore pulls back ONE targeted session (~${largest} tok) on demand — vs carrying the whole ~${total} tok pile. Offer the user ULTRA once; if they decline, proceed with the raw dig (never blocked). ${ANSWER_FIRST_REMINDER}`;
}
