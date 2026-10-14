// CWK2-020 item (1): every hook entry is the EXEC form (`command: "node"` + one `args` path), never a shell string.
// A shell-form string carrying ${CLAUDE_PLUGIN_ROOT} runs through PowerShell on Windows without Git for Windows, where
// `${CLAUDE_PLUGIN_ROOT}` is a PowerShell variable that expands to nothing: node gets a missing script, the hook fails, and
// since Claude Code 2.1.299 a failing PreToolUse hook BLOCKS the call (every Edit/Write/MultiEdit). Exec form has no shell
// (hooks-safety.md section 3: `command` must be a real executable on Windows, so `node`, never a shim).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLACEHOLDER = '${CLAUDE_PLUGIN_ROOT}';
const CONDUCTOR_ARG = `${PLACEHOLDER}/hooks/coalwash-conductor.js`;

function entries(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'hooks', 'hooks.json'), 'utf8'));
  const out = [];
  for (const [event, groups] of Object.entries(manifest.hooks)) {
    for (const g of groups) for (const h of g.hooks) out.push({ event, matcher: g.matcher, h });
  }
  return out;
}

for (const [label, root] of [['source', REPO], ['dist', path.join(REPO, 'plugin')]]) {
  test(`hooks.json (${label}): every entry is exec form, node + one args path to the conductor, no shell or onFailure`, () => {
    const all = entries(root);
    assert.equal(all.length, 5, 'SessionStart, Stop, PreToolUse and the two PostToolUse entries');
    for (const { event, h } of all) {
      assert.equal(h.type, 'command', event);
      assert.equal(h.command, 'node', `${event}: command is the executable alone, never a shell string (got ${JSON.stringify(h.command)})`);
      assert.deepEqual(h.args, [CONDUCTOR_ARG], event);
      assert.ok(!('shell' in h), `${event}: no shell field`);
      assert.ok(!('onFailure' in h), `${event}: no onFailure (hooks-safety section 1: never block on a fail-silent hook)`);
      assert.ok(!String(h.command).includes(PLACEHOLDER), `${event}: no placeholder inside a command string`);
    }
  });
}

test('the PreToolUse entry runs the way exec form runs it: no shell, node + the resolved path, exit 0, sanctioned output only', (t) => {
  const tmp = fs.realpathSync.native(os.tmpdir());
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(tmp, 'cw-execform-')));
  t.after(() => {
    assert.ok(dir.startsWith(tmp + path.sep), `refusing to remove ${dir}`);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const home = path.join(dir, 'home');
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(home);
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, '.coalwash.json'), '{}');
  const pre = entries(REPO).find((e) => e.event === 'PreToolUse');
  assert.ok(pre && Array.isArray(pre.h.args), 'the PreToolUse entry carries args (exec form)');
  const args = pre.h.args.map((a) => a.split(PLACEHOLDER).join(REPO));
  const env = { ...process.env, HOME: home, USERPROFILE: home, TEMP: home, TMP: home, TMPDIR: home, CLAUDE_CONFIG_DIR: '', CLAUDE_PLUGIN_ROOT: REPO, CLAUDE_PLUGIN_DATA: '', CLAUDE_PROJECT_DIR: proj };
  delete env.NODE_TEST_CONTEXT;
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 't-exec', cwd: proj, tool_name: 'Edit', tool_input: { file_path: path.join(proj, 'notes.txt'), old_string: 'a', new_string: 'b' } });
  const r = spawnSync(pre.h.command === 'node' ? process.execPath : pre.h.command, args,
    { cwd: proj, env, input, encoding: 'utf8', timeout: 20000, killSignal: 'SIGKILL', windowsHide: true, shell: false });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.equal(r.stderr, '');
  if (r.stdout.trim()) JSON.parse(r.stdout); // sanctioned output is one JSON object or nothing
});
