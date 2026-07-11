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

// The ceiling ask — ทำ/later — for an OBESE crossing, or a FULL crossing
// whose auto-run authorization is suppressed/disarmed (forceMode
// 'ask'/'off', or break-even not in favor). Names the crossing band, the fat
// estimate, the configured exercise, and (when available) the payback line.
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

// The FULL(externalize) advisory — pure information, never an ask (a wash
// cannot help ~all-muscle over capacity; the growable-full invariant forbids
// steering the user into washing legitimate muscle). Fixed-template for the
// same program-side-text reason as the asks above.
export function externalizeAdvisory(opts) {
  const { hardCeilingTokens } = opts || {};
  const cap = Number.isFinite(hardCeilingTokens) ? hardCeilingTokens : '?';
  return `[CoalWash] memory gauge: FULL (externalize) — this store has ~no reclaimable fat (muscle, not bloat) but exceeds the machine's working-capacity ceiling (~${cap} tok, a rough placeholder). SURFACE this line to the user verbatim, mentioned only AFTER you've answered their actual message, never before it. CoalWash cannot help further by washing — externalize/split older content out of the always-loaded set, or consciously raise fullPercent (the "bigger SSD" choice).`;
}
