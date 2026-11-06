// Hermetic test: a snapshot the writer puts in a `-N` slot (because a foreign file already holds the base slot) is listed
// and restored like any other snapshot. The slot suffix is part of the shape SNAP_NAME_SHAPE must accept.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshotOnFirstWrite, listWriteguard, readWriteguardSnapshot } from './writeguard.mjs';

delete process.env.CLAUDE_CONFIG_DIR; // hermetic: sandbox home only

function sandbox() {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwwgslot-home-')));
  const proj = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwwgslot-proj-')));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  return { home, proj };
}
function clean(...dirs) { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); }

test('653 bounce: a snapshot the writer puts in a -1 slot is listed, and restores its true original byte for byte', () => {
  const { home, proj } = sandbox();
  try {
    const gov = path.join(proj, 'MEMORY.md');
    const trueOrig = '# Memory\n\nTHE TRUE ORIGINAL, which the -1 slot must hold byte for byte.\n';
    fs.writeFileSync(gov, trueOrig, 'utf8');
    // The writer derives the base slot for gov. A foreign file holds that slot, with no sidecar that names gov, so the
    // writer must skip it and take the -1 slot for gov's own snapshot.
    const base = snapshotOnFirstWrite(proj, 'sess-S', gov, { home });
    assert.ok(base, 'setup: the writer derived a base slot');
    fs.rmSync(base, { force: true });
    fs.rmSync(`${base}.origpath`, { force: true });
    fs.writeFileSync(base, 'FOREIGN CONTENT of another file', { encoding: 'utf8', flag: 'wx' });

    const slot = snapshotOnFirstWrite(proj, 'sess-S', gov, { home });
    assert.ok(slot, 'the writer took a slot');
    assert.strictEqual(path.basename(slot), `${path.basename(base)}-1`, 'the writer took the -1 slot, not the foreign base');
    assert.strictEqual(fs.readFileSync(slot, 'utf8'), trueOrig, 'the -1 slot holds the true original');

    const name = path.basename(slot);
    const listed = listWriteguard(proj, { home }).map((r) => r.name);
    assert.ok(listed.includes(name), `the -1 snapshot is listed: ${JSON.stringify(listed)}`);
    const got = readWriteguardSnapshot(proj, name, { home });
    assert.ok(got, 'the -1 snapshot restores (verified against its own sidecar)');
    assert.strictEqual(got.content.toString('utf8'), trueOrig, 'the restored bytes are the true original');
  } finally { clean(home, proj); }
});
