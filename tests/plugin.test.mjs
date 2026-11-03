// Plugin wiring: Claude Code finds the plugin and runs core/heads-up.mjs on the two hook events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { storeWithView, tempDir, writeStore } from './helpers.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(readFileSync(join(repoRoot, rel), 'utf8'));

const EXPECTED_COMMAND = 'node "${CLAUDE_PLUGIN_ROOT}/core/heads-up.mjs"';

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
      ...process.env,
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
