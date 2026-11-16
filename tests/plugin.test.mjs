// Plugin wiring: Claude Code finds the plugin and runs core/heads-up.mjs on the two hook events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import {
  hookScript,
  inheritedEnv,
  injectedContext,
  repoRoot,
  runHook,
  storeWithView,
  tempDir,
  writeStore,
} from './helpers.mjs';

const readJson = (rel) => JSON.parse(readFileSync(join(repoRoot, rel), 'utf8'));

// Starts node only when there is a store to read: HEADS_UP_STORE, or a built-in store file under HOME.
const EXPECTED_COMMAND =
  'for f in "${HEADS_UP_STORE:-}" "$HOME"/.claude/plugins/store/cc-plugin-you-should-know_builtin-*.json; ' +
  'do [ -n "$f" ] && [ -e "$f" ] && exec node "${CLAUDE_PLUGIN_ROOT}/core/heads-up.mjs"; done; exit 0';

/** The single command hook registered for `event` in hooks/hooks.json. */
function registeredHook(event) {
  const groups = readJson('hooks/hooks.json').hooks[event];
  assert.ok(Array.isArray(groups) && groups.length === 1, `${event} has one hook group`);
  assert.equal(groups[0].hooks.length, 1, `${event} has one hook`);
  return { group: groups[0], hook: groups[0].hooks[0] };
}

test('should register core/heads-up.mjs for UserPromptSubmit and PostToolUse via ${CLAUDE_PLUGIN_ROOT}', () => {
  // User behaviour: installing the plugin is enough; Claude Code runs the hook on prompts and after every tool.
  // Business rule: both events run the core script from the plugin root, with a 5 s timeout.
  for (const event of ['UserPromptSubmit', 'PostToolUse']) {
    const { hook } = registeredHook(event);
    assert.equal(hook.type, 'command');
    assert.equal(hook.command, EXPECTED_COMMAND);
    assert.equal(hook.timeout, 5);
  }
  assert.equal(registeredHook('PostToolUse').group.matcher, '*', 'PostToolUse fires after every tool');
});

test('should have a plugin.json with name heads-up and a semver version', () => {
  // User behaviour: the plugin shows up in Claude Code under a clear name and version.
  // Business rule: the manifest names the plugin "heads-up" with a semver version and its author.
  const manifest = readJson('.claude-plugin/plugin.json');
  assert.equal(manifest.name, 'heads-up');
  assert.match(manifest.version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  assert.equal(typeof manifest.description, 'string');
  assert.ok(manifest.description.length > 0, 'has a description');
  assert.deepEqual(manifest.author, { name: 'Yanick Lavoie' });
});

test('should inject when the registered command is run the way Claude Code runs it', async () => {
  // User behaviour: the wiring really runs the script, so a heads-up reaches the agent in an installed plugin.
  // Business rule: the hooks.json command, with ${CLAUDE_PLUGIN_ROOT} set to the plugin dir, injects the notice.
  const { hook } = registeredHook('PostToolUse');
  const command = hook.command.replaceAll('${CLAUDE_PLUGIN_ROOT}', repoRoot);
  const sessionId = randomUUID();
  const view = { line: 'The build cache is stale', explanation: 'Rebuild before testing.' };
  const input = JSON.stringify({
    session_id: sessionId,
    transcript_path: `/x/${sessionId}.jsonl`,
    hook_event_name: 'PostToolUse',
  });

  const child = spawn(command, {
    shell: true,
    cwd: tempDir(),
    env: {
      ...inheritedEnv(),
      PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
      HOME: tempDir('heads-up-home-'),
      HEADS_UP_STORE: writeStore(tempDir(), storeWithView(sessionId, view)),
      HEADS_UP_STATE_DIR: tempDir(),
    },
  });
  let stdout = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stdin.end(input);
  const code = await new Promise((resolve) => child.on('close', resolve));

  assert.equal(code, 0);
  const json = JSON.parse(stdout);
  assert.equal(json.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.ok(json.hookSpecificOutput.additionalContext.includes(view.line));
});

test('should still run the hook when the script is reached through a symlink', async () => {
  // User behaviour: a plugin dir that is symlinked into place (common for local installs) still works.
  // Business rule: the "run only as the main script" guard resolves symlinks before comparing paths.
  const link = join(tempDir(), 'linked-heads-up.mjs');
  symlinkSync(hookScript, link);
  const sessionId = randomUUID();
  const view = { line: 'Port 3000 is in use', explanation: 'Another server is running.' };

  const result = await runHook({ sessionId, store: storeWithView(sessionId, view), script: link });

  assert.ok(injectedContext(result).includes(view.line));
});

test('should be installable from this repo as a marketplace listing the heads-up plugin', () => {
  // User behaviour: anyone can install the plugin with `/plugin marketplace add 501336North/heads-up` and then
  // `/plugin install heads-up@heads-up`, and gets the same version the manifest names.
  // Business rule: the repo's marketplace lists exactly one plugin, "heads-up", served from the repo root, with the
  // same version and description as .claude-plugin/plugin.json.
  const marketplace = readJson('.claude-plugin/marketplace.json');
  const manifest = readJson('.claude-plugin/plugin.json');
  assert.equal(marketplace.name, 'heads-up');
  assert.deepEqual(marketplace.owner, { name: 'Yanick Lavoie' });
  assert.equal(marketplace.plugins.length, 1);
  const [listed] = marketplace.plugins;
  assert.equal(listed.name, 'heads-up');
  assert.equal(listed.source, './');
  assert.equal(listed.version, manifest.version, 'the listed version matches the manifest');
  assert.equal(listed.description, manifest.description, 'the listed description matches the manifest');
});

/**
 * Run the registered PostToolUse command through a shell the way Claude Code does, with a stand-in `node` first on
 * PATH that records each start and then runs the real node. Resolves to { code, stdout, started }.
 */
async function runRegistered({ home, env = {}, sessionId = randomUUID() }) {
  const bin = tempDir('fake-node-');
  const starts = join(bin, 'starts.log');
  writeFileSync(join(bin, 'node'), `#!/bin/sh\necho started >> "${starts}"\nexec "${process.execPath}" "$@"\n`, {
    mode: 0o755,
  });
  const { hook } = registeredHook('PostToolUse');
  const child = spawn(hook.command, {
    shell: true,
    cwd: tempDir(),
    env: {
      ...inheritedEnv(),
      HEADS_UP_STORE: '',
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      CLAUDE_PLUGIN_ROOT: repoRoot,
      HOME: home,
      HEADS_UP_STATE_DIR: tempDir(),
      ...env,
    },
  });
  let stdout = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stdin.end(
    JSON.stringify({ session_id: sessionId, transcript_path: `/x/${sessionId}.jsonl`, hook_event_name: 'PostToolUse' }),
  );
  const code = await new Promise((resolve) => child.on('close', resolve));
  return { code, stdout, started: existsSync(starts) };
}

test("should not even start node when Claude Code's built-in heads-up has no store", async (t) => {
  // User behaviour: users who never turned on Claude Code's built-in heads-ups pay nothing on each prompt and tool
  // call, not even the cost of starting Node.
  // Business rule: without a built-in store file (and no HEADS_UP_STORE), the hook command exits 0 at once.
  if (process.platform === 'win32') {
    t.skip('POSIX shell stand-in for node');
    return;
  }
  const result = await runRegistered({ home: tempDir('heads-up-home-') });

  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.started, false, 'node was never started');
});

test("should run when Claude Code's built-in heads-up store exists", async (t) => {
  // User behaviour: with the built-in turned on, its heads-ups reach the agent as before.
  // Business rule: a cc-plugin-you-should-know_builtin-*.json store under ~/.claude/plugins/store starts the hook.
  if (process.platform === 'win32') {
    t.skip('POSIX shell stand-in for node');
    return;
  }
  const home = tempDir('heads-up-home-');
  const storeDir = join(home, '.claude', 'plugins', 'store');
  mkdirSync(storeDir, { recursive: true });
  const sessionId = randomUUID();
  const line = `Built-in on ${randomUUID()}`;
  writeFileSync(
    join(storeDir, 'cc-plugin-you-should-know_builtin-abc.json'),
    JSON.stringify(storeWithView(sessionId, { line })),
  );

  const result = await runRegistered({ home, sessionId });

  assert.equal(result.started, true, 'node was started');
  assert.ok(JSON.parse(result.stdout).hookSpecificOutput.additionalContext.includes(line), 'the notice is relayed');
});

test('should run when HEADS_UP_STORE points at a store, whatever is under HOME', async (t) => {
  // User behaviour: a user (or a test) who points the plugin at a store file gets it read.
  // Business rule: a non-empty HEADS_UP_STORE always starts the hook.
  if (process.platform === 'win32') {
    t.skip('POSIX shell stand-in for node');
    return;
  }
  const sessionId = randomUUID();
  const line = `Override ${randomUUID()}`;
  const store = writeStore(tempDir(), storeWithView(sessionId, { line }));

  const result = await runRegistered({ home: tempDir('heads-up-home-'), env: { HEADS_UP_STORE: store }, sessionId });

  assert.equal(result.started, true, 'node was started');
  assert.ok(JSON.parse(result.stdout).hookSpecificOutput.additionalContext.includes(line), 'the notice is relayed');
});
