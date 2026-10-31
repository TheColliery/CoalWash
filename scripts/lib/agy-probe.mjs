// Provenance: a copy of CoalLedger scripts/lib/agy-probe.mjs (git blob bea9df17542668e1dd9c5ee4c97461e2f0387072), taken for the 29e AG transport. The body is CoalLedger's, unchanged.
// Probe whether the agy CLI can run, for the AG plugin test. Three answers, never two:
//   'absent'  -- the spawn reports ENOENT: agy is not on PATH (on Windows agy.exe, spawned without a shell).
//   'failed'  -- agy is there but did not answer: a timeout, another spawn error, or a non-zero exit. The caller FAILS.
//   'present' -- agy ran and exited 0.
// A timeout is a hang, not an absence: a skip that names the wrong cause hides a broken install.
// Provenance: a copy of CoalHearth's scripts/lib/agy-probe.mjs (84226de), itself a copy of CoalMine's (f75e52a); the same three answers.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_PROBE_TIMEOUT_MS = 30000;

// A shell-less spawn runs an .exe, never a .cmd or .bat shim: find one on PATH so the skip reason can name it.
function findShim(command) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = (process.env.PATHEXT || '').split(';').map((e) => e.toLowerCase()).filter((e) => e === '.cmd' || e === '.bat');
  for (const dir of dirs) for (const ext of exts) {
    const p = path.join(dir, command + ext);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// A wrapper, not `spawnSync` passed as a value: the git-env census cannot follow a spawner passed on, and this probe spawns agy, not git.
const runChild = (command, args, opts) => spawnSync(command, args, opts);

// The environment an agy run gets: every profile and temp variable points inside `home`, so agy never writes under the owner's profile.
// The caller creates the AppData folders under `home` (agy writes its config there, and the folders must exist).
export function agyEnv(home, base = process.env) {
  return {
    ...base,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    TEMP: home,
    TMP: home,
    TMPDIR: home,
  };
}

// Runs `agy plugin validate <pluginDir> --json` and returns the raw spawn result (the caller reads stdout).
export function validateAgyPlugin({ pluginDir, env, timeoutMs, spawn = runChild }) {
  return spawn('agy', ['plugin', 'validate', pluginDir, '--json'], { encoding: 'utf8', timeout: timeoutMs, env });
}

export function probeAgy({ command = 'agy', args = ['--version'], timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, env, spawn = runChild }) {
  const r = spawn(command, args, { encoding: 'utf8', timeout: timeoutMs, env });
  const shown = [command, ...args].join(' ');
  if (r.error && r.error.code === 'ENOENT') {
    const shim = findShim(command);
    return {
      state: 'absent',
      reason: shim ? `only a .cmd/.bat shim for ${command} is on PATH (${shim}); a shell-less spawn cannot run it` : `${command} is not on PATH`,
    };
  }
  if (r.error) return { state: 'failed', reason: `${shown} did not run: ${r.error.code}` };
  if (r.status !== 0) return { state: 'failed', reason: `${shown} exited ${r.status}: ${(r.stderr || '').trim()}` };
  return { state: 'present', reason: '' };
}
