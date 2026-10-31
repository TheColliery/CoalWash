// CoalWash — the transport for a later Antigravity unit: the two conductor paths
// the AG hook contract can carry today. Built on the measured contract of agy 1.4.12
// (probe run 301, scratchpad/29e/probe/RECORD.md):
//   - PreToolUse fires for the tool calls the agent makes (read_file and
//     edit_file measured). The airbag runs here: a write to a guarded class-B
//     file snapshots it first, through the same handleAirbag the CC conductor uses.
//   - SessionStart fires once per conversation. The prior-conversation writeguard
//     sweep runs here, through the same sweepWriteguard the CC conductor uses.
//   - The gauge's SessionStart notices run on AG (unit D, 29g fire 412), with the AG state NAMESPACE
//     (setStateNamespace('ag')) and the AG class-B set (class-b.mjs discoverAntigravityClassB).
//   - Stop delivers NO directive on AG (29g fire 416): the Quick pass is agent-run and no cli.mjs command
//     reaches it with --platform, so the force, OBESE and wizard directives stay off. AG_DISCOVERY below
//     stays a switch: false returns to the prior-conversation sweep alone.
// NOT wired, and why:
//   - PostToolUse: AG allows only `{}` back, so the CC seatbelt's advisory line
//     has no channel. Not wired.
//   - PostInvocation / PreInvocation: no CoalWash path needs them yet.
//   - The write path itself (edit_file, write_file) is unmeasured headless: agy
//     1.4.12 auto-denies writes in `agy -p`, so the airbag's live snapshot on AG
//     is proven by the hermetic tests, not by an AG run.
// Zero-dep, fail-silent (Phoenix #4): every path returns, nothing is printed
// except the sanctioned JSON lines, and no process.exit() runs.
'use strict';

const path = require('path');
const os = require('os');

const conductor = require('./coalwash-conductor.js');

// Gate for the gauge and Stop on AG. On since unit D (29g fire 412): the AG discovery exists and the AG state is namespaced.
const AG_DISCOVERY = true;

// The AG project rule file the airbag guards on the AG route, beyond the basenames every route guards (AGENTS.md, MEMORY.md, CLAUDE.md).
// Only inside the project: a GEMINI.md under HOME is AG's global rule file, and the airbag never reaches it (writeguard.mjs).
const AG_PROJECT_RULE_BASENAMES = ['GEMINI.md'];

// Tool names AG reports for a file write. edit_file is measured on 1.4.12; the
// others are the names AG's own tool set uses for a write, unmeasured headless.
// multi_replace_file_content is a real AG tool (grep of agy.exe, 29e INSPECT 309 t233): its path is TargetFile (PATH_KEYS).
const AG_WRITE_TOOLS = new Set(['edit_file', 'write_file', 'write_to_file', 'create_file', 'replace_file_content', 'multi_replace_file_content', 'multi_edit']);

// The argument keys that can carry a file path. Path is measured on edit_file
// and read_file; the rest are the spellings AG's other write tools use.
const PATH_KEYS = ['Path', 'path', 'file_path', 'filePath', 'TargetFile', 'AbsolutePath'];

function targetPath(args, workspace) {
  if (!args || typeof args !== 'object') return '';
  for (const key of PATH_KEYS) {
    if (typeof args[key] === 'string' && args[key]) return path.resolve(workspace, args[key]);
  }
  return '';
}

// Prior-conversation sweep without the gauge. Mirrors the CC SessionStart order:
// coalwashMode off returns before the sweep, and writeGuard off skips it.
async function sweepPriorConversations(conversationId) {
  const [{ loadMergedConfig, projectRootFor }, { clampedRead }, writeguard] = await Promise.all([
    import(conductor.lib('config-load.mjs')),
    import(conductor.lib('config-schema.mjs')),
    import(conductor.lib('writeguard.mjs')),
  ]);
  const cfg = loadMergedConfig({ platform: 'antigravity' });
  if (clampedRead(cfg, 'coalwashMode') === 'off') return;
  if (clampedRead(cfg, 'writeGuard') === 'off') return;
  const home = os.homedir();
  const projectRoot = projectRootFor(process.cwd(), home, { platform: 'antigravity' }); // the AG repository root (29g fire 417)
  writeguard.sweepWriteguard(projectRoot, conversationId, { home });
}

// Pure routing: returns the JSON lines the hook prints, and performs the
// hook's side effects. Exported for the hermetic tests, which pin the outputs
// without a spawn. An input the hook cannot place (no workspace, no
// conversation) returns no lines.
// The AG state namespace (29g fire 412), set before any calibration state is read or written. Imported here, never on the PreToolUse
// hot path, which returns before any state module loads.
async function setAgNamespace() {
  const caliper = await import(conductor.lib('caliper.mjs'));
  caliper.setStateNamespace('ag');
}

async function route(payload, event, opts = {}) {
  const lines = [];
  const emitLine = (doc) => lines.push(JSON.stringify(doc));
  const workspace = payload && Array.isArray(payload.workspacePaths) ? payload.workspacePaths[0] : null;
  const conversationId = payload && payload.conversationId;
  if (typeof workspace !== 'string' || !workspace) return lines;
  if (typeof conversationId !== 'string' || !conversationId) return lines;
  try { process.chdir(workspace); } catch { return lines; }
  const hookInput = { session_id: conversationId };

  if (event === 'PreToolUse') {
    const call = payload.toolCall;
    if (!call || !AG_WRITE_TOOLS.has(call.name)) return lines;
    const file = targetPath(call.args, workspace);
    if (!file) return lines;
    // The CC airbag reads tool_input.file_path, so the AG path is handed in that shape.
    await conductor.handleAirbag({ session_id: conversationId, tool_name: 'Write', tool_input: { file_path: file } }, { extraBasenames: AG_PROJECT_RULE_BASENAMES, platform: 'antigravity' });
    return lines;
  }

  if (event === 'SessionStart') {
    if (opts.agDiscovery) {
      await setAgNamespace();
      await conductor.handleSessionStart(hookInput, {
        emit: (text) => emitLine({ injectSteps: [{ ephemeralMessage: text }] }),
        updateNudge: false,
        platform: 'antigravity',
      });
    } else {
      await sweepPriorConversations(conversationId);
    }
    return lines;
  }

  // 29g fire 416, branch 3: the AG Stop delivers NO directive. The force, the OBESE auto-Quick and the wizard ask all ask the agent to run
  // the Quick pass, which is agent-run (method §1) and not reachable through any cli.mjs command with --platform, so on AG it would
  // wash the wrong files or none. The Stop handler is not called, so nothing is consumed either. The SessionStart notices and the airbag stay on.
  if (event === 'Stop') return lines;

  return lines;
}

async function main() {
  const event = process.argv[2] || '';
  const payload = await conductor.readStdinJson();
  const lines = await route(payload, event, { agDiscovery: AG_DISCOVERY });
  for (const line of lines) process.stdout.write(line + '\n');
}

// Run only as the hook entry. A require() (a test) gets route() and nothing else.
if (require.main === module) {
  main().catch(() => {
    // Phoenix #4: fail-silent, never throw, never crash the parent agent.
  });
}
module.exports = { route, AG_DISCOVERY, AG_WRITE_TOOLS };
