import { test } from 'node:test';
import assert from 'node:assert';
import { ANSWER_FIRST_REMINDER, forceAuto, obeseAutoQuick, wizardEscalation, externalizeAdvisory, seatbeltAdvisory } from './ask.mjs';

// (0m: the old `ceilingAsk` template and its tests died with the forceMode
// knob — force at FULL is unconditional, so no suppressed/disarmed-FULL ask
// state exists; wizardEscalation is the ONE surviving ask.)

test('every template embeds the answer-first reminder verbatim (queue item 0)', () => {
  assert.ok(forceAuto({ fatTokens: 100 }).includes(ANSWER_FIRST_REMINDER));
  assert.ok(obeseAutoQuick({ fatTokens: 100 }).includes(ANSWER_FIRST_REMINDER));
  assert.ok(wizardEscalation({ fatTokens: 100 }).includes(ANSWER_FIRST_REMINDER));
});

test('forceAuto (economic): break-even headline, no question-tool wording (force never asks), non-optional named, once-per-crossing truth', () => {
  const r = forceAuto({ fatTokens: 4004, reason: 'economic' });
  assert.ok(r.includes('FULL band + break-even proven'), r);
  assert.ok(r.includes('fat ~4004 tok'));
  assert.ok(r.includes('non-optional at FULL'), 'names the 0m intent — the OS-maintenance model, no off switch');
  assert.ok(r.includes('Quick pass NOW'));
  assert.ok(r.includes('stage-only'));
  assert.ok(r.includes('snapshot-backed'));
  assert.ok(r.includes('once per crossing, not per session'));
  assert.ok(!r.includes('question tool'), 'force never asks');
});

test('forceAuto (absolute-cap, 0m): the wall headline quotes footprint-vs-wall — never a misleading "fat ~0" on the day-one store, no null/undefined artifacts', () => {
  const r = forceAuto({ fatTokens: 0, reason: 'absolute-cap', footprintTokens: 76900, hardCeilingTokens: 36000 });
  assert.ok(r.includes('over the capacity wall'), r);
  assert.ok(r.includes('store ~76900 tok'), r);
  assert.ok(r.includes('~36000 tok wall'), r);
  assert.ok(!r.includes('break-even proven'), 'the wall case never claims a proof it did not run');
  assert.ok(!r.includes('fat ~0'), 'a day-one provisional store must not read as "nothing to do"');
  assert.ok(!r.includes('undefined') && !r.includes('null') && !r.includes('NaN'), r);
});

test('forceAuto (absolute-cap without wall numbers): degrades to a plain fat figure — a pre-beta.13 cache with no byte baseline never renders artifacts', () => {
  const r = forceAuto({ fatTokens: 2500, reason: 'absolute-cap' });
  assert.ok(r.includes('FULL band crossed (fat ~2500 tok)'), r);
  assert.ok(!r.includes('undefined') && !r.includes('null') && !r.includes('NaN'), r);
  assert.ok(!r.includes('capacity wall'), 'no wall claim without the numbers to show');
});

test('forceAuto: carries the payback line too when breakEven is supplied; no reason at all defaults to the economic headline', () => {
  const r = forceAuto({ fatTokens: 4004, breakEven: { perDay: 300, breakEvenDays: 2, floorUnmeasured: false } });
  assert.ok(r.includes('FULL band + break-even proven'), r);
  assert.ok(r.includes('~300 tok/day'), r);
  assert.ok(r.includes('pays back in ~2 day(s)'), r);
});

test('0o spawn-bill clause: renders on forceAuto AND wizardEscalation only when subSpawns > 0, with real numbers; zero/absent/malformed = ABSENT', () => {
  const withSpawns = { subSpawns: 3, subParcelTokens: 57660 };
  const f = forceAuto({ fatTokens: 100, reason: 'economic', spawns: withSpawns });
  assert.ok(f.includes('This fat also rode 3 sub spawn(s) ≈ 57660 tok of parcel (~est) this session.'), f);
  const w = wizardEscalation({ fatTokens: 100, spawns: withSpawns });
  assert.ok(w.includes('This fat also rode 3 sub spawn(s)'), w);

  // Cost-0 accumulation (never-gauged room) still names the count, no tok figure.
  const noCost = forceAuto({ fatTokens: 100, spawns: { subSpawns: 2, subParcelTokens: 0 } });
  assert.ok(noCost.includes('rode 2 sub spawn(s) this session'), noCost);
  assert.ok(!noCost.includes('≈'), 'no fabricated cost figure when the parcel was never gauged');

  // Zero/absent/malformed -> ABSENT, never "0 spawns", never artifacts.
  for (const spawns of [undefined, {}, { subSpawns: 0 }, { subSpawns: 'x' }, null]) {
    const r = forceAuto({ fatTokens: 100, spawns });
    assert.ok(!r.includes('sub spawn'), `no clause for ${JSON.stringify(spawns)}`);
    assert.ok(!r.includes('undefined') && !r.includes('NaN'), r);
  }
});

test('0p seatbeltAdvisory: FYI-framed, NEVER a block, names the file + dropped classes + the byte-exact snapshot pointer (restore-by-reference, never re-type)', () => {
  const r = seatbeltAdvisory({ file: '/p/MEMORY.md', classes: ['link-drop', 'number-drop'], snapshotPath: '/p/.claude/coalwash/writeguard/s/MEMORY.md--abc' });
  assert.ok(r.includes('FYI') && r.includes('not a block'), 'advisory only, never a block');
  assert.ok(r.includes('/p/MEMORY.md'), 'names the file');
  assert.ok(r.includes('link-drop, number-drop'), 'names the dropped classes');
  assert.ok(r.includes('/p/.claude/coalwash/writeguard/s/MEMORY.md--abc'), 'points at the snapshot');
  assert.ok(r.includes('restore the real bytes') || r.includes('never re-type'), 'restore-by-reference law: the real bytes, never re-authored');
  assert.ok(!r.includes('undefined') && !r.includes('null'), r);
});

test('0p seatbeltAdvisory: the oversize note is distinct (diff skipped) and still points at the snapshot; malformed input never renders artifacts', () => {
  const over = seatbeltAdvisory({ file: '/p/CLAUDE.md', oversize: true, snapshotPath: '/p/.claude/coalwash/writeguard/s/CLAUDE.md--x' });
  assert.ok(over.includes('oversize'), over);
  assert.ok(over.includes('diff was skipped') || over.includes('diff skipped'), over);
  assert.ok(over.includes('CLAUDE.md--x'), 'snapshot pointer present even when the diff is skipped');
  for (const bad of [undefined, {}, null, { classes: [] }]) {
    const r = seatbeltAdvisory(bad);
    assert.ok(r.includes('FYI'), 'always FYI-framed');
    assert.ok(!r.includes('undefined') && !r.includes('null') && !r.includes('NaN'), r);
  }
});

test('externalizeAdvisory: pure info, no question-tool/ask wording, names WHY washing cannot help', () => {
  const r = externalizeAdvisory({ hardCeilingTokens: 36000 });
  assert.ok(r.includes('FULL (externalize)'), r);
  assert.ok(r.includes('~36000 tok'));
  // CWK-081 (2): the retired claim. "~no reclaimable fat (muscle, not bloat)"
  // asserted a semantic verdict the MECHANICAL estimator never produces — it
  // proves exact duplicates and spacing and calls everything else muscle by
  // construction. The line now states the instrument and its bound, and names
  // the Full-tier pass that DID adjudicate the rest (this template is only
  // reachable after one has landed this episode).
  assert.ok(!/muscle, not bloat/.test(r), 'the unmeasured "muscle, not bloat" claim is retired');
  assert.ok(r.includes('LOWER BOUND'), 'says what the mechanical tier actually proves');
  assert.match(r, /Full-tier pass/, 'and names the instrument that judged the rest');
  assert.ok(r.includes('EXTERNALIZE') || r.includes('externalize'));
  assert.ok(!r.includes('question tool'), 'externalize is information, never an ask');
  assert.ok(r.includes('AFTER'), 'still tells the agent to sequence after the actual reply');
});

test('externalizeAdvisory: a missing hardCeilingTokens degrades to a "?" placeholder, never throws', () => {
  assert.doesNotThrow(() => externalizeAdvisory({}));
  assert.ok(externalizeAdvisory({}).includes('~? tok'));
});

test('#21 externalize-template: the muscle-only/wall-hit advisory renders the hand-move template shape (cluster -> destination -> pointer), states CoalWash NEVER auto-moves, and cites the CoalPortal precedent', () => {
  const r = externalizeAdvisory({ hardCeilingTokens: 190000 });
  assert.match(r, /NEVER auto-move/, 'CoalWash never auto-moves external content (externalize is pure information)');
  assert.match(r, /CLUSTER/, 'step 1: cluster the muscle by topic');
  assert.match(r, /DESTINATION/, 'step 2: propose a destination doc/blueprint/design file');
  assert.match(r, /POINTER/, 'step 3: leave a pointer behind so recall still reaches it');
  assert.match(r, /by hand/, 'the user/agent moves it by hand');
  assert.match(r, /CoalPortal/, 'cites the memory->durable-file precedent');
  assert.match(r, /airbag/, 'the write-path airbag snapshots the hand-move');
  assert.ok(!r.includes('question tool'), 'still pure information, never an ask');
});

// ---------------------------------------------------------------------------
// obeseAutoQuick (queue 0d, "OBESE AUTO-QUICK, NO ASK")
// ---------------------------------------------------------------------------

test('obeseAutoQuick: names the band + fat, no question-tool/ทำ wording (never asks), authorizes Quick NOW, names the oneLineResult-only push — and carries NO escape-hatch route (F3)', () => {
  const r = obeseAutoQuick({ fatTokens: 800.4 });
  assert.ok(r.includes('memory crossed the OBESE ceiling'), r);
  assert.ok(r.includes('fat ~800 tok'), r);
  assert.ok(!r.includes('question tool'), 'never asks — standing config is the consent');
  assert.ok(!r.includes('ทำ'), r);
  assert.ok(r.includes('standing config authorizes'), r);
  assert.ok(r.includes('Quick pass NOW'), r);
  assert.ok(r.includes('snapshot-backed and revertible'), r);
  assert.ok(r.includes('oneLineResult'), 'names pushing ONLY the one-line result, no full receipt/narration');
  assert.ok(r.includes('once per crossing, not per session'), r);
  assert.ok(!r.includes('exercisePerBand.obese'), 'F3: the old "set obese to full for the ask" escape-hatch sentence is GONE — OBESE never asks, so the directive must not advertise a dead route');
});

test('obeseAutoQuick: carries the payback line when breakEven is supplied; malformed/missing input never throws', () => {
  const bare = obeseAutoQuick({ fatTokens: 800 });
  assert.ok(!bare.includes('pays back'), bare);
  const withBE = obeseAutoQuick({ fatTokens: 800, breakEven: { perDay: 150, breakEvenDays: 4, floorUnmeasured: false } });
  assert.ok(withBE.includes('~150 tok/day'), withBE);
  assert.ok(withBE.includes('pays back in ~4 day(s)'), withBE);
  assert.doesNotThrow(() => obeseAutoQuick());
  assert.doesNotThrow(() => obeseAutoQuick({}));
  assert.doesNotThrow(() => obeseAutoQuick(null));
});

// ---------------------------------------------------------------------------
// wizardEscalation (queue 0f "AUTHORITATIVE 3-FLOW", supersedes 0e "THE
// OBESE LOOP" — same template shape, now fires on a FULL plateau instead of
// an OBESE one)
// ---------------------------------------------------------------------------

test('wizardEscalation: a REAL two-button ask (question tool present) — names the mechanical pass already ran, the wizard heavy tier, and never auto-runs', () => {
  const r = wizardEscalation({ fatTokens: 900 });
  assert.ok(r.includes('no cutter for this class of fat'), r); // task #4: the headline is the MEASURED residue, not a wall claim
  assert.ok(r.includes('certain fat (~900 tok, measured'), r);
  assert.ok(r.includes('a human or the wizard'), r);
  assert.ok(r.includes('question tool'), 'the semantic escalation is a real ask, unlike obeseAutoQuick/forceAuto');
  assert.ok(r.includes('ทำ'), r);
  assert.ok(r.includes('/coalwash'), r);
  assert.ok(r.includes('Fat + reorganize muscle'), r);
  assert.ok(r.includes('later'), r);
  assert.ok(r.includes('never on a timer'), 'names the growth-not-a-clock frequency rule');
  assert.ok(!r.includes('standing config authorizes'), 'never auto-runs — mechanical cutting already proved insufficient');
  assert.ok(r.includes('consumed the moment this ask fires'), r);
});

test('wizardEscalation: carries the payback line when breakEven is supplied; malformed/missing input never throws', () => {
  const withBE = wizardEscalation({ fatTokens: 900, breakEven: { perDay: 300, breakEvenDays: 5 } });
  assert.ok(withBE.includes('~300 tok/day'), withBE);
  assert.ok(withBE.includes('pays back in ~5 day(s)'), withBE);
  // task #4 condition 2b: the reorganize half's own proof renders when supplied...
  const withReorg = wizardEscalation({ fatTokens: 900, reorg: { demotableTokens: 1500, perDay: 90, breakEvenDays: 6 } });
  assert.ok(withReorg.includes('The reorganize half pays too'), withReorg);
  assert.ok(withReorg.includes('~1500 tok of always-loaded index is demotable'), withReorg);
  assert.ok(withReorg.includes('~6 day(s)'), withReorg);
  // ...and is ABSENT (not zero-rendered) when there is no demotable mass.
  assert.ok(!wizardEscalation({ fatTokens: 900 }).includes('reorganize half pays'), 'no demotable mass -> no reorg clause');
  assert.doesNotThrow(() => wizardEscalation());
  assert.doesNotThrow(() => wizardEscalation({}));
  assert.doesNotThrow(() => wizardEscalation(null));
});

test('every builder tolerates missing/malformed input without throwing', () => {
  for (const fn of [forceAuto, obeseAutoQuick, wizardEscalation, externalizeAdvisory]) {
    assert.doesNotThrow(() => fn());
    assert.doesNotThrow(() => fn({}));
    assert.doesNotThrow(() => fn(null));
  }
});


// ---------------------------------------------------------------------------
// CWK-081 (1) — the SECOND cause of the Full-tier consent: a capacity crossing
// whose muscle nothing has measured yet.
// ---------------------------------------------------------------------------

test("CWK-081: wizardEscalation cause 'capacity-unmeasured' names the ceiling, states what was MEASURED, and refuses to recommend relocating first", () => {
  const r = wizardEscalation({ cause: 'capacity-unmeasured', fatTokens: 3, hardCeilingTokens: 167000, capacitySource: 'conservative-default' });
  assert.ok(r.includes('~167000 tok'), r);
  assert.ok(r.includes('CONSERVATIVE DEFAULT'), 'the adapter flag reaches the reader');
  assert.ok(r.includes('LOWER BOUND'), 'says what the mechanical tier proves');
  assert.ok(/NO semantic pass has run this episode/.test(r), 'and says plainly what has NOT been measured');
  assert.ok(!/muscle, not bloat/.test(r), 'never asserts the verdict the instrument did not produce');
  assert.ok(r.includes('question tool'), 'this cause IS an ask — the Full-tier consent');
  assert.ok(r.includes('once per session'), 'and states its own re-emission rule');
});

test('CWK-081: the DEFAULT wizardEscalation text is untouched by the new cause (no cause = the pre-CWK-081 template)', () => {
  const r = wizardEscalation({ fatTokens: 900, breakEven: { perDay: 100, breakEvenDays: 2 } });
  assert.ok(r.includes('certain fat (~900 tok, measured'), r);
  assert.ok(!r.includes('NO semantic pass has run this episode'));
  assert.ok(r.includes('GROWS further'), 'the fat-cause re-emission rule is growth, unchanged');
});

test('CWK-081: a DISCOVERED capacity is labelled as discovered on both capacity surfaces, never as the conservative default', () => {
  const ask = wizardEscalation({ cause: 'capacity-unmeasured', hardCeilingTokens: 967000, capacitySource: 'stats-cache' });
  assert.ok(ask.includes('discovered from stats-cache'), ask);
  assert.ok(!ask.includes('CONSERVATIVE DEFAULT'));
  const adv = externalizeAdvisory({ hardCeilingTokens: 967000, capacitySource: 'stats-cache' });
  assert.ok(adv.includes('discovered from stats-cache'), adv);
  assert.ok(!adv.includes('CONSERVATIVE DEFAULT'));
});
