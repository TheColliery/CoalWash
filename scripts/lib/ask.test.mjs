import { test } from 'node:test';
import assert from 'node:assert';
import { ANSWER_FIRST_REMINDER, ceilingAsk, forceAuto, obeseAutoQuick, wizardEscalation, externalizeAdvisory } from './ask.mjs';

test('every template embeds the answer-first reminder verbatim (queue item 0)', () => {
  assert.ok(ceilingAsk({ band: 'OBESE', fatTokens: 100 }).includes(ANSWER_FIRST_REMINDER));
  assert.ok(forceAuto({ fatTokens: 100 }).includes(ANSWER_FIRST_REMINDER));
  assert.ok(obeseAutoQuick({ fatTokens: 100 }).includes(ANSWER_FIRST_REMINDER));
  assert.ok(wizardEscalation({ fatTokens: 100 }).includes(ANSWER_FIRST_REMINDER));
});

test('ceilingAsk: names the band, the fat estimate, exactly two options, and the consume-at-emission truth', () => {
  const r = ceilingAsk({ band: 'OBESE', fatTokens: 1234.6, exercise: 'quick' });
  assert.ok(r.includes('memory crossed the OBESE ceiling'), r);
  assert.ok(r.includes('fat ~1235 tok'), r);
  assert.ok(r.includes('question tool'));
  assert.ok(r.includes('ทำ'));
  assert.ok(r.includes('run the quick wash now'));
  assert.ok(r.includes('later (dismiss; the offer returns at the next ceiling crossing)'));
  assert.ok(!r.includes('snooze'), 'no time-based snooze wording — hysteresis replaced it');
  assert.ok(r.includes('snapshot-backed and revertible'));
});

test('ceilingAsk: FULL band names FULL and the full exercise when configured', () => {
  const r = ceilingAsk({ band: 'FULL', fatTokens: 4004, exercise: 'full' });
  assert.ok(r.includes('memory crossed the FULL ceiling'), r);
  assert.ok(r.includes('run the full wash now'), r);
});

test('ceilingAsk: no breakEven -> no payback clause; a real breakEven -> the payback numbers appear (queue 0c)', () => {
  const bare = ceilingAsk({ band: 'OBESE', fatTokens: 500 });
  assert.ok(!bare.includes('pays back'), bare);

  const withBE = ceilingAsk({ band: 'OBESE', fatTokens: 500, exercise: 'quick', breakEven: { perDay: 200, breakEvenDays: 3.2, floorUnmeasured: false } });
  assert.ok(withBE.includes('~200 tok/session'), withBE);
  assert.ok(withBE.includes('pays back in ~4 session(s)'), withBE);
  assert.ok(!withBE.includes('upper bound'));
});

test('ceilingAsk: floorUnmeasured payback is labeled an upper bound; zero/absent perDay suppresses the clause', () => {
  const unmeasured = ceilingAsk({ band: 'FULL', fatTokens: 500, breakEven: { perDay: 50, breakEvenDays: 10, floorUnmeasured: true } });
  assert.ok(unmeasured.includes('upper bound'), unmeasured);

  const zeroFat = ceilingAsk({ band: 'OBESE', fatTokens: 0, breakEven: { perDay: 0, breakEvenDays: Infinity, floorUnmeasured: false } });
  assert.ok(!zeroFat.includes('pays back'), zeroFat);

  const malformed = ceilingAsk({ band: 'OBESE', fatTokens: 10, breakEven: { perDay: 'nope' } });
  assert.ok(!malformed.includes('pays back'), malformed);
});

test('forceAuto: numbers shown, no question-tool wording (force never asks), the named exception and once-per-crossing truth', () => {
  const r = forceAuto({ fatTokens: 4004 });
  assert.ok(r.includes('FULL band + break-even proven'), r);
  assert.ok(r.includes('fat ~4004 tok'));
  assert.ok(r.includes('standing config authorizes'));
  assert.ok(r.includes('Quick pass NOW'));
  assert.ok(r.includes('stage-only'));
  assert.ok(r.includes('snapshot-backed'));
  assert.ok(r.includes('once per crossing, not per session'));
  assert.ok(!r.includes('question tool'), 'force never asks');
});

test('forceAuto: carries the payback line too when breakEven is supplied', () => {
  const r = forceAuto({ fatTokens: 4004, breakEven: { perDay: 300, breakEvenDays: 2, floorUnmeasured: false } });
  assert.ok(r.includes('~300 tok/session'), r);
  assert.ok(r.includes('pays back in ~2 session(s)'), r);
});

test('externalizeAdvisory: pure info, no question-tool/ask wording, names WHY washing cannot help', () => {
  const r = externalizeAdvisory({ hardCeilingTokens: 36000 });
  assert.ok(r.includes('FULL (externalize)'), r);
  assert.ok(r.includes('~36000 tok'));
  assert.ok(r.includes('no reclaimable fat'));
  assert.ok(r.includes('EXTERNALIZE') || r.includes('externalize'));
  assert.ok(!r.includes('question tool'), 'externalize is information, never an ask');
  assert.ok(r.includes('AFTER'), 'still tells the agent to sequence after the actual reply');
});

test('externalizeAdvisory: a missing hardCeilingTokens degrades to a "?" placeholder, never throws', () => {
  assert.doesNotThrow(() => externalizeAdvisory({}));
  assert.ok(externalizeAdvisory({}).includes('~? tok'));
});

// ---------------------------------------------------------------------------
// obeseAutoQuick (queue 0d, "OBESE AUTO-QUICK, NO ASK")
// ---------------------------------------------------------------------------

test('obeseAutoQuick: names the band + fat, no question-tool/ทำ wording (never asks), authorizes Quick NOW, names the oneLineResult-only push and the escalation-out route', () => {
  const r = obeseAutoQuick({ fatTokens: 800.4 });
  assert.ok(r.includes('memory crossed the OBESE ceiling'), r);
  assert.ok(r.includes('fat ~800 tok'), r);
  assert.ok(!r.includes('question tool'), 'never asks — the exercise config is the standing consent');
  assert.ok(!r.includes('ทำ'), r);
  assert.ok(r.includes('standing config authorizes'), r);
  assert.ok(r.includes('Quick pass NOW'), r);
  assert.ok(r.includes('snapshot-backed and revertible'), r);
  assert.ok(r.includes('oneLineResult'), 'names pushing ONLY the one-line result, no full receipt/narration');
  assert.ok(r.includes('once per crossing, not per session'), r);
  assert.ok(r.includes('exercisePerBand.obese') && r.includes('"full"'), 'names the escalate-out route (queue 0d: the ask survives only for the semantic tier)');
});

test('obeseAutoQuick: carries the payback line when breakEven is supplied; malformed/missing input never throws', () => {
  const bare = obeseAutoQuick({ fatTokens: 800 });
  assert.ok(!bare.includes('pays back'), bare);
  const withBE = obeseAutoQuick({ fatTokens: 800, breakEven: { perDay: 150, breakEvenDays: 4, floorUnmeasured: false } });
  assert.ok(withBE.includes('~150 tok/session'), withBE);
  assert.ok(withBE.includes('pays back in ~4 session(s)'), withBE);
  assert.doesNotThrow(() => obeseAutoQuick());
  assert.doesNotThrow(() => obeseAutoQuick({}));
  assert.doesNotThrow(() => obeseAutoQuick(null));
});

// ---------------------------------------------------------------------------
// wizardEscalation (queue 0e, "THE OBESE LOOP")
// ---------------------------------------------------------------------------

test('wizardEscalation: a REAL two-button ask (question tool present) — names the mechanical pass already ran, the wizard heavy tier, and never auto-runs', () => {
  const r = wizardEscalation({ fatTokens: 900 });
  assert.ok(r.includes('STILL OBESE'), r);
  assert.ok(r.includes('fat ~900 tok'), r);
  assert.ok(r.includes('mechanical Quick pass already ran'), r);
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
  const withBE = wizardEscalation({ fatTokens: 900, breakEven: { perDay: 300, breakEvenDays: 5, floorUnmeasured: false } });
  assert.ok(withBE.includes('~300 tok/session'), withBE);
  assert.ok(withBE.includes('pays back in ~5 session(s)'), withBE);
  assert.doesNotThrow(() => wizardEscalation());
  assert.doesNotThrow(() => wizardEscalation({}));
  assert.doesNotThrow(() => wizardEscalation(null));
});

test('every builder tolerates missing/malformed input without throwing', () => {
  for (const fn of [ceilingAsk, forceAuto, obeseAutoQuick, wizardEscalation, externalizeAdvisory]) {
    assert.doesNotThrow(() => fn());
    assert.doesNotThrow(() => fn({}));
    assert.doesNotThrow(() => fn(null));
  }
});
