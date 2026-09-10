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
  const be = Number.isFinite(breakEven.breakEvenDays) ? `~${Math.ceil(breakEven.breakEvenDays)} day(s)` : 'n/a';
  // task #4: the floorUnmeasured upper-bound clause died with the stamped
  // floor — fat is MEASURED certain fat now, a lower bound by construction,
  // so the honest qualifier points the other way and lives in the templates.
  const upperBound = '';
  // UNIT FIX (2026-07-26): caliper.mjs breakEven() computes perDay = fatTokens *
  // sessionsPerDay (tok PER DAY) and breakEvenDays = runCostTokens / perDay
  // (DAYS) -- this line rendered them as "tok/session" / "session(s)" for every
  // release through rc.6, silently contradicting commands/stats.md's own
  // correct "fat/day" + "break-even days" labels on the SAME numbers. Caught
  // twice independently at sessionsPerDay=5 (5x too high one way, 5x too low
  // the other) -- QA's find, not a derivation.
  return ` Carrying this fat costs ~${breakEven.perDay} tok/day${upperBound}; one ${exercise} run pays back in ${be}.`;
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
  return `[CoalWash] ${headline}.${payback}${spawnBill} force is non-optional at FULL (the OS-maintenance model) — run the free mechanical Quick pass NOW (stage-only; every cut is snapshot-backed — one command rolls the whole run back), then push the one-line result (receipt.mjs's oneLineResult) — ALWAYS, even when the pass cut nothing, so the user can tell a working autopilot from a dead one. Render its prose in the user's language; keep the numbers and the unit \`tok\` verbatim. This fires once per crossing, not per session. ${ANSWER_FIRST_REMINDER}`;
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
  return `[CoalWash] memory crossed the OBESE ceiling (fat ~${fat} tok) — the configured exercise is quick.${payback} standing config authorizes the free mechanical Quick pass NOW, no ask — run it (stage-only; every cut is snapshot-backed and revertible), then push ONLY the one-line result (receipt.mjs's oneLineResult — no full receipt block, no narration). ALWAYS push that line, even when the pass cut nothing: a silent run is indistinguishable from no run at all. Render its prose in the user's language; keep the numbers and the unit \`tok\` verbatim. This fires once per crossing, not per session — and a NEW crossing arms on each new lump of fat, never on a timer and never on an unchanged plateau. ${ANSWER_FIRST_REMINDER}`;
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
// task #4 condition 2: this ask opens the "Fat + reorganize muscle" tier, so
// it fires only when BOTH halves paid their own break-even (the gauge ANDs
// them before the band can arm) — and it SHOWS both proofs: the certain-fat
// numbers and the reorganize half's demotable-muscle numbers. `reorg` =
// { demotableTokens, perDay, breakEvenDays }, the envelope-overflow proof
// cached beside the fat proof by recordVerdict.
// CWK-081 (1) — THE SECOND CAUSE. A FULL crossing whose fat sits UNDER the arm
// mark used to route straight to the capacity advisory, which told the user to
// go relocate content on the strength of a measurement that never looked at it.
// It now routes HERE instead, until a Full-tier pass has actually REMOVED
// something this episode. Same ask, same two options, same tier — a DIFFERENT headline,
// because the reason is different and the old one would be false here: no
// mechanical fat remains to name, no force preceded this ask, and the honest
// statement is that the muscle is UNMEASURED, not that it is muscle.
// `cause: 'capacity-unmeasured'` selects it; absent/anything else keeps the
// pre-CWK-081 text byte-for-byte, so every existing caller and pin is unmoved.
export function wizardEscalation(opts) {
  const { fatTokens, breakEven, reorg, spawns, cause, hardCeilingTokens, capacitySource } = opts || {};
  const fat = Number.isFinite(fatTokens) ? Math.round(fatTokens) : 0;
  const payback = paybackLine(breakEven, 'wizard');
  const spawnBill = spawnBillLine(spawns); // 0o: absent when zero spawns
  const demotable = Number.isFinite(reorg && reorg.demotableTokens) ? Math.round(reorg.demotableTokens) : 0;
  const reorgBe = (reorg && Number.isFinite(reorg.breakEvenDays)) ? `~${Math.ceil(reorg.breakEvenDays)} day(s)` : 'n/a';
  const reorgLine = demotable > 0
    ? ` The reorganize half pays too: ~${demotable} tok of always-loaded index is demotable to the recall tier (the retier envelope's own overflow), paying back in ${reorgBe}.`
    : '';
  if (cause === 'capacity-unmeasured') {
    const cap = Number.isFinite(hardCeilingTokens) ? hardCeilingTokens : '?';
    const capProv = capacitySource === 'conservative-default'
      ? ', a CONSERVATIVE DEFAULT — this platform exposes no context-window figure, so the ceiling is the smallest supported window minus the auto-compact reserve'
      : (typeof capacitySource === 'string' && capacitySource ? `, discovered from ${capacitySource}` : '');
    return `[CoalWash] memory gauge: FULL (capacity — muscle not yet measured) — this store exceeds the machine's working-capacity ceiling (~${cap} tok${capProv}). WHAT WAS ACTUALLY MEASURED: the mechanical tier proves exact duplicates and excess spacing only, and found ~${fat} tok of them — a LOWER BOUND, never a clean bill. NO semantic pass has run this episode, so nothing has yet measured whether the rest is muscle or bloat, and CoalWash will not tell you to go relocate content on a measurement that never read it.${payback}${reorgLine}${spawnBill} Offer the user via your question tool, exactly two options: ทำ (open the /coalwash wizard now, "Fat + reorganize muscle" tier — the zero-context outsider judges what the mechanical tier structurally cannot) / later (dismiss; carries forward — this ask returns at most once per session, never on a timer). If the user picks ทำ: run the wizard per the coalwash skill. Once a Full pass lands and actually removes something, THEN the capacity advisory (externalize) becomes eligible — and even then it reports only what that pass did, never a verdict that the rest of the store is muscle. This crossing is marked consumed the moment this ask fires. ${ANSWER_FIRST_REMINDER}`;
  }
  return `[CoalWash] certain fat (~${fat} tok, measured — exact duplicates and spacing the mechanical tier can prove) remains this episode: a free mechanical Quick pass was forced this episode (the FULL-band force that precedes every ask here), but the mechanical tier has no cutter for this class of fat — it can only PROVE the measurement, not remove it. Clearing it needs a human or the wizard's semantic tier, not another automatic pass.${payback}${reorgLine}${spawnBill} Offer the user via your question tool, exactly two options: ทำ (open the /coalwash wizard now, "Fat + reorganize muscle" tier — the zero-context outsider reviews what no automatic pass can touch) / later (dismiss; carries forward — this same ask returns only once the measured fat GROWS further, never on a timer). If the user picks ทำ: run the wizard per the coalwash skill. This crossing is marked consumed the moment this ask fires. ${ANSWER_FIRST_REMINDER}`;
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
// steering the user into washing legitimate muscle). REACHABILITY, CWK-081:
// the conductor routes here only after a Full-tier pass REMOVED something this
// episode; before one, the same crossing goes to wizardEscalation's
// 'capacity-unmeasured' cause instead.
//
// WHAT THAT ENTITLES THIS TEMPLATE TO SAY — INSPECT round-2 F1, and the first
// version of this paragraph claimed more than the fact carries. It read: "This
// template may therefore SAY a Full pass adjudicated the content — at every site
// that can reach it, one did." The eligibility fact is per-TRANSACTION, not
// per-STORE: applyPlan is handed a PLAN, so a wizard-cut plan that rewrites ONE
// file of three and removes one line stamps the record while the other two are
// judged by nothing (cell C1, measured on both engines). So the template says a
// pass RAN and REMOVED under the gate, and disclaims the rest outright.
// NARROWING THE SENTENCE IS THE FIX, not widening the predicate: coverage is a
// property of the PASS, applyPlan has no input that carries it, and inventing an
// adjudication receipt to carry it is a bigger unit with a wider blast. The
// direction settles it — under-claiming costs a user one re-run they did not
// need; over-claiming on a surface that steers real content costs the content.
// Fixed-template for the
// same program-side-text reason as the asks above. #21 EXTERNALIZE-TEMPLATE:
// externalize is pure INFORMATION (a wash cannot shrink muscle), so CoalWash
// never auto-moves it — the template names the hand-move steps (cluster ->
// destination -> pointer) and the USER/agent relocates by hand. Precedent = the
// CoalPortal record (memory -> a durable file, a pointer left behind).
//
// THE AIRBAG CLAIM IS CONDITIONED, AND THIS PARAGRAPH USED TO CARRY IT
// UNCONDITIONALLY (CWK-082 L3). It read: "the write-path AIRBAG (0p) snapshots
// that hand-move" — true for Edit/Write/MultiEdit, FALSE for a shell-mediated
// one. Two independent gates exclude Bash (hooks.json's PreToolUse matcher and
// the conductor's own WRITE_TOOLS belt), and INSPECT §3b measured the
// consequence through the real hook: Write/Edit/MultiEdit produce 3 snapshot
// files each, Bash produces 0 and the writeguard/ dir is never created.
// So the template now STATES the condition and STEERS — an honest limit is
// worth more when it is actionable, and the covered channel is one the agent
// can simply choose. NOT closed by extending the airbag to Bash, and the reason
// is COST rather than parsing (INSPECT F-B2: this paragraph led with the parser
// argument, which is answerable — an airbag on Bash could snapshot the whole
// guarded set unconditionally and parse nothing, and would still pay the cost).
// A PreToolUse(Bash) matcher puts one conductor PROCESS SPAWN on EVERY shell
// call: a median of 82-89 ms across two independent instruments (n=25 each),
// with an Edit-payload control proving the floor is the spawn. The SPAN is
// quoted deliberately — a single rounded figure here would be a number neither
// instrument produced, attached to an n that makes it read as a measurement.
// Phoenix #3, the hottest path in a session, for a narrow case.
// SAID ONCE: the figures, the control and the instrument live where the
// mechanism lives — the conductor's touchedPath note — and are deliberately not
// restated here, so one of the two cannot go stale against the other.
// writeguard.mjs's own header carries the channel limit for a reader who
// arrives at the net rather than at the template.
// CWK-082 findings-back F3 — a residue rendered by BASENAME cannot tell two
// files apart, and the collision is not exotic: this room's own CLAUDE.md
// @imports MEMORY.md while the CC store carries its own memory/MEMORY.md, so
// CoalWash dogfooding itself printed "MEMORY.md ~41373 tok · MEMORY.md ~20798
// tok" and named NEITHER — on the one surface whose whole job is telling a
// hand which file to move.
//
// Render the SHORTEST path suffix that is unique WITHIN THE SET BEING SHOWN:
// one segment wherever nothing collides (the common case, unchanged output),
// more only where a hand needs it. The set is the shown slice, never the whole
// store — the reader disambiguates against what is printed in front of them.
//
// RESIDUE, named not closed: two entries with the IDENTICAL full path fall
// through to the full path for both, and a genuinely deep unique suffix
// renders long. No truncation is added — an elided label re-introduces exactly
// the ambiguity this fixes, which is worse than a long one.
function shortestUniqueLabels(paths) {
  const parts = paths.map((p) => String(p).split(/[\\/]/).filter(Boolean));
  return parts.map((seg, i) => {
    for (let take = 1; take <= seg.length; take++) {
      const label = seg.slice(seg.length - take).join('/');
      if (!parts.some((o, j) => j !== i && o.slice(Math.max(0, o.length - take)).join('/') === label)) return label;
    }
    return seg.join('/');
  });
}
export function externalizeAdvisory(opts) {
  const { hardCeilingTokens, capacitySource, residue, judgedFiles } = opts || {};
  const cap = Number.isFinite(hardCeilingTokens) ? hardCeilingTokens : '?';
  // CWK-082 L2 — the ACCOUNTING half. Prohibition #31 stands and is untouched:
  // this template still never moves anything, and still names no destination
  // that would dodge the gauge. What it adds is what nothing said before — WHERE
  // the weight actually is, and the bound this gauge cannot see past. Rendered
  // ONLY when a residue was cached: an absent list omits the section rather than
  // fabricating one.
  const weight = Array.isArray(residue)
    ? residue.filter((e) => e && typeof e.path === 'string' && Number.isFinite(Number(e.tokensEst)))
    : [];
  // CWK-081 (b): the advisory used to say only what it CANNOT vouch for. It now
  // also names what it CAN — the files the pass actually removed content from —
  // so an un-covered file is visibly outside the claim rather than silently
  // inside it. Rendered ONLY when a scope was recorded; an absent list omits the
  // section rather than implying the pass covered everything.
  const judged = Array.isArray(judgedFiles)
    ? judgedFiles.filter((f) => typeof f === 'string' && f)
    : [];
  // Hoisted out of the template literal on purpose: an interpolation carrying
  // a call (let alone a nested literal) is what broke the config-key gate's own
  // locator once already.
  const judgedRendered = shortestUniqueLabels(judged.slice(0, 5)).join(' · ');
  const judgedLine = judged.length
    ? ` THAT PASS TOUCHED, exactly: ${judgedRendered}${judged.length > 5 ? ` (and ${judged.length - 5} more)` : ''} — anything not in that list it did not read.`
    : '';
  const weightLabels = shortestUniqueLabels(weight.map((e) => e.path));
  const weightRendered = weight.map((e, i) => `${weightLabels[i]} ~${Math.round(Number(e.tokensEst))} tok`).join(' · ');
  const weightLine = weight.length
    ? ` WHERE THE WEIGHT IS (the always-loaded entries a hand-move would have to come out of, largest first): ${weightRendered}.`
    : '';
  // CWK-081 (2): the old headline asserted "~no reclaimable fat (muscle, not
  // bloat)". The instrument behind that sentence is the MECHANICAL estimator,
  // which proves exact duplicates and excess spacing and nothing else — a lower
  // bound. "Muscle" was a claim it never measured. It now says what WAS
  // measured on BOTH halves: the mechanical bound, and — per the eligibility
  // check above — that a Full-tier pass ran and removed something this episode.
  // It stops there. It does not say that pass judged the rest, because nothing
  // this line can read knows how much of the store it covered (round-2 F1).
  // CWK-081 (1)/adapter: the ceiling's PROVENANCE rides the line too — a
  // conservative default and a discovered window are different claims, and a
  // reader deciding whether to move real content deserves to know which.
  const capProv = capacitySource === 'conservative-default'
    ? ', a CONSERVATIVE DEFAULT — this platform exposes no context-window figure, so the ceiling is the smallest supported window minus the auto-compact reserve, not a discovered one'
    : (typeof capacitySource === 'string' && capacitySource ? `, discovered from ${capacitySource}` : ', a rough placeholder');
  return `[CoalWash] memory gauge: FULL (externalize) — this store exceeds the machine's working-capacity ceiling (~${cap} tok${capProv}). WHAT THIS EPISODE ESTABLISHED, and nothing beyond it: a Full-tier (semantic) pass ran and REMOVED content under the fidelity gate, which refuses any drop the plan did not name. The mechanical tier proves exact duplicates and excess spacing only — a LOWER BOUND on fat, never a verdict that the rest is muscle — and this record cannot see how much of the store that pass covered, so it establishes NOTHING about files the pass never touched.${judgedLine} SURFACE this line to the user verbatim, mentioned only AFTER you've answered their actual message, never before it. A wash cannot shrink muscle — the only move is to EXTERNALIZE (relocate muscle OUT of the always-loaded set). CoalWash NEVER auto-moves it (externalize is pure information). MAKE THE MOVE WITH THE FILE-EDIT TOOLS (Edit/Write/MultiEdit): the write-path airbag snapshots a hand-move made through those, and only those. A move made through the SHELL instead (mv, sed, a heredoc, a script) is NOT covered — no snapshot is taken and there is no undo net if the rewrite loses content. The template: (1) CLUSTER the muscle by topic (largest cohesive block first); (2) pick a DESTINATION per cluster — a project doc / blueprint / design file that loads on demand, not every session; (3) MOVE it there by hand, leaving a one-line POINTER behind in the always-loaded file (title + where it went) so recall still reaches it. Precedent: the CoalPortal record moved from memory to a durable file with a pointer left behind.${weightLine} ACCOUNTING, so the number stays honest either way: a file moved WITHIN the store still counts here — it left the always-loaded set, not the store — while a file moved OUT of the store leaves this gauge's sight entirely and no line anywhere will report it; CoalWash cannot see past that boundary and does not claim to. (task #4: the old "raise fatMultiple" escape is gone with the floor-multiple wall itself — the capacity line is real, and the only honest lever against it is moving muscle out.)`;
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
