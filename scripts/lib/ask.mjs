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
// recordVerdict/sanitizeVerdict round-trip); absent/zero-fat degrades to ''.
function paybackLine(breakEven, exercise) {
  if (!breakEven || !Number.isFinite(breakEven.perDay) || breakEven.perDay <= 0) return '';
  const be = Number.isFinite(breakEven.breakEvenDays) ? `~${Math.ceil(breakEven.breakEvenDays)} session(s)` : 'n/a';
  const upperBound = breakEven.floorUnmeasured ? ' (floor unmeasured — an upper bound)' : '';
  return ` Carrying this fat costs ~${breakEven.perDay} tok/session${upperBound}; one ${exercise} run pays back in ${be}.`;
}

// The ceiling ask — ทำ/later — for a FULL crossing whose auto-run
// authorization is suppressed/disarmed (forceMode 'ask'/'off', or break-even
// not in favor). FULL-only since F3 (OBESE never asks — the 0f ruling; its
// crossings always take the silent auto-Quick directive below); the `band`
// param stays generic so the template needs no band knowledge. Names the
// crossing band, the fat estimate, the configured exercise, and (when
// available) the payback line.
export function ceilingAsk(opts) {
  const { band, fatTokens, exercise = 'quick', breakEven } = opts || {};
  const fat = Number.isFinite(fatTokens) ? Math.round(fatTokens) : 0;
  const payback = paybackLine(breakEven, exercise);
  return `[CoalWash] memory crossed the ${band} ceiling (fat ~${fat} tok).${payback} Offer the user via your question tool, exactly two options: ทำ (run the ${exercise} wash now — the configured exercise for this ceiling) / later (dismiss; the offer returns at the next ceiling crossing). If the user picks ทำ: run the pipeline per the coalwash skill (every cut is snapshot-backed and revertible). This crossing is marked consumed the moment this ask fires — it will not repeat until the next rise. ${ANSWER_FIRST_REMINDER}`;
}

// The FULL+economical force directive (forceMode=auto, the rot-canary
// autoFixMode model — standing consent, no ask; numbers still shown every
// fire, per the economic-dominance exception's own transparency clause).
export function forceAuto(opts) {
  const { fatTokens, breakEven } = opts || {};
  const fat = Number.isFinite(fatTokens) ? Math.round(fatTokens) : 0;
  const payback = paybackLine(breakEven, 'quick');
  return `[CoalWash] FULL band + break-even proven (numbers: fat ~${fat} tok).${payback} standing config authorizes the free mechanical Quick pass NOW — run it (stage-only; every cut is snapshot-backed — one command rolls the whole run back), then note the receipt path to the user in one line. This fires once per crossing, not per session. ${ANSWER_FIRST_REMINDER}`;
}

// The OBESE auto-directive (queue 0d "OBESE AUTO-QUICK, NO ASK"; F3 made it
// UNCONDITIONAL — the old exercisePerBand.obese:'full' escape hatch to an
// ask is REMOVED, main-adjudicated per the thrice-reconfirmed 0f ruling
// "OBESE never asks, no matter what"): standing config IS the consent (the
// same "config is a valid consent form" shape as forceMode/rot-canary's
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
  const { fatTokens, breakEven } = opts || {};
  const fat = Number.isFinite(fatTokens) ? Math.round(fatTokens) : 0;
  const payback = paybackLine(breakEven, 'wizard');
  return `[CoalWash] memory is STILL over the FULL capacity ceiling (fat ~${fat} tok) after the automatic mechanical Quick pass already ran this episode — the remaining fat needs semantic judgment a script cannot make.${payback} Offer the user via your question tool, exactly two options: ทำ (open the /coalwash wizard now, "Fat + reorganize muscle" tier — the zero-context outsider reviews what mechanical cutting could not) / later (dismiss; carries forward — this same ask returns only once the fat GROWS further, never on a timer). If the user picks ทำ: run the wizard per the coalwash skill. This crossing is marked consumed the moment this ask fires. ${ANSWER_FIRST_REMINDER}`;
}

// The FULL(externalize) advisory — pure information, never an ask (a wash
// cannot help ~all-muscle over capacity; the growable-full invariant forbids
// steering the user into washing legitimate muscle). Fixed-template for the
// same program-side-text reason as the asks above.
export function externalizeAdvisory(opts) {
  const { hardCeilingTokens } = opts || {};
  const cap = Number.isFinite(hardCeilingTokens) ? hardCeilingTokens : '?';
  return `[CoalWash] memory gauge: FULL (externalize) — this store has ~no reclaimable fat (muscle, not bloat) but exceeds the machine's working-capacity ceiling (~${cap} tok, a rough placeholder). SURFACE this line to the user verbatim, mentioned only AFTER you've answered their actual message, never before it. CoalWash cannot help further by washing — externalize/split older content out of the always-loaded set, or consciously raise fullPercent (the "bigger SSD" choice).`;
}
