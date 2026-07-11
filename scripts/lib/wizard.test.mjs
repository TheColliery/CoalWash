import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { neutralScan, estimateBill, billLine, PARTITION_FILES, PARTITION_KB, MINUTES_PER_PARTITION, TOKEN_RATE_PER_KB } from './wizard.mjs';

delete process.env.CLAUDE_CONFIG_DIR;

function sandbox() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cww-home-')));
  const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cww-proj-')));
  return { home, proj };
}
function clean(...dirs) {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// neutralScan — "WIZARD ENTRY != BMI": measurement only, no band anywhere in
// the returned shape.
// ---------------------------------------------------------------------------

test('neutralScan: measures files/bytes/tokens but returns NO band/BMI/verdict field anywhere — even on a store that would gauge FULL', () => {
  const { home, proj } = sandbox();
  try {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true }); // claude-code platform marker
    fs.writeFileSync(path.join(proj, 'CLAUDE.md'), 'a'.repeat(200000), 'utf8'); // would be FULL if gauged
    const s = neutralScan({ projectRoot: proj, home });
    assert.strictEqual(s.platform, 'claude-code');
    assert.ok(s.measure.alwaysLoaded.tokensEst > 0, 'real measurement happened');
    assert.strictEqual(JSON.stringify(s).toLowerCase().includes('bmi'), false, 'no bmi anywhere in the neutral-entry shape');
    assert.strictEqual(Object.keys(s).includes('verdict'), false);
    assert.strictEqual(Object.keys(s).includes('band'), false);
  } finally { clean(home, proj); }
});

test('neutralScan: an empty project is a harmless zero-measurement, never throws', () => {
  const { home, proj } = sandbox();
  try {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const s = neutralScan({ projectRoot: proj, home });
    assert.strictEqual(s.measure.files, 0);
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// estimateBill — a BAND, never a fake point estimate; heavy (หนัก) costs
// more than เบา on the SAME scan.
// ---------------------------------------------------------------------------

test('estimateBill: returns a low/high BAND for both time and token cost, never a single number', () => {
  const b = estimateBill({ files: 10, totalBytes: 100 * 1024 });
  assert.ok(b.timeMinutes.low < b.timeMinutes.high, 'a real band, not a point estimate');
  assert.ok(b.tokensEst.low < b.tokensEst.high);
  assert.ok(b.timeMinutes.low >= 0 && b.tokensEst.low >= 0);
});

test('estimateBill: heavy (หนัก) costs strictly more time AND tokens than เบา on the identical scan', () => {
  const light = estimateBill({ files: 50, totalBytes: 200 * 1024, heavy: false });
  const heavy = estimateBill({ files: 50, totalBytes: 200 * 1024, heavy: true });
  assert.ok(heavy.timeMinutes.high > light.timeMinutes.high);
  assert.ok(heavy.tokensEst.high > light.tokensEst.high);
});

test('estimateBill: partition count follows method.md\'s own ~150 files / ~500KB threshold', () => {
  assert.strictEqual(estimateBill({ files: 1, totalBytes: 1 }).partitions, 1, 'a tiny store is one partition, never zero');
  assert.strictEqual(estimateBill({ files: PARTITION_FILES + 1, totalBytes: 1 }).partitions, 2, 'crossing the file threshold adds a partition');
  assert.strictEqual(estimateBill({ files: 1, totalBytes: (PARTITION_KB + 1) * 1024 }).partitions, 2, 'crossing the KB threshold adds a partition too');
});

test('estimateBill: scales with the measured size — a bigger store gets a bigger band, monotonically', () => {
  const small = estimateBill({ files: 5, totalBytes: 10 * 1024 });
  const big = estimateBill({ files: 500, totalBytes: 5 * 1024 * 1024 });
  assert.ok(big.timeMinutes.low > small.timeMinutes.low);
  assert.ok(big.tokensEst.low > small.tokensEst.low);
});

test('estimateBill: malformed/missing input degrades to a zero-ish band, never throws or produces NaN/negative', () => {
  for (const input of [undefined, {}, { files: 'nope', totalBytes: 'nope' }, { files: -5, totalBytes: -100 }, null]) {
    const b = estimateBill(input);
    assert.ok(Number.isFinite(b.timeMinutes.low) && Number.isFinite(b.timeMinutes.high));
    assert.ok(Number.isFinite(b.tokensEst.low) && Number.isFinite(b.tokensEst.high));
    assert.ok(b.timeMinutes.low >= 0 && b.tokensEst.low >= 0);
  }
});

test('estimateBill: the exported rate constants are positive numbers (sanity — a zero/negative rate would make every bill degenerate)', () => {
  assert.ok(MINUTES_PER_PARTITION > 0);
  assert.ok(TOKEN_RATE_PER_KB > 0);
  assert.ok(PARTITION_FILES > 0);
  assert.ok(PARTITION_KB > 0);
});

// ---------------------------------------------------------------------------
// billLine — the program-side fixed template (agent never composes it).
// ---------------------------------------------------------------------------

test('billLine: one line, shows files/fat/time-band/cost-band, labels the estimate as a band not a quote', () => {
  const bill = estimateBill({ files: 12, totalBytes: 50 * 1024 });
  const line = billLine({ files: 12, fatTokens: 3456, bill });
  assert.strictEqual(line.split('\n').length, 1);
  assert.ok(line.includes('scanned 12 file(s)'), line);
  assert.ok(line.includes('fat found ~3456 tok'), line);
  assert.ok(line.includes(`${bill.timeMinutes.low}-${bill.timeMinutes.high} min`), line);
  assert.ok(line.includes(`${bill.tokensEst.low}-${bill.tokensEst.high} tok`), line);
  assert.ok(line.includes('rough band'), 'never claims fake precision');
});

test('billLine: a missing fatTokens omits the fat clause cleanly (no "~undefined tok")', () => {
  const line = billLine({ files: 5, bill: estimateBill({ files: 5, totalBytes: 1024 }) });
  assert.ok(!line.includes('undefined'));
  assert.ok(!line.includes('fat found'));
});

test('billLine: malformed input never throws', () => {
  assert.doesNotThrow(() => billLine());
  assert.doesNotThrow(() => billLine({}));
  assert.doesNotThrow(() => billLine(null));
});
