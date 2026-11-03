// Fail-safe: whatever goes wrong, the hook never breaks or clutters the user's session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { injectedContext, repoRoot, runHook, tempDir } from './helpers.mjs';

// Quiet is the design: success exit, nothing on stdout, nothing on stderr.
function assertSilentSuccess(result) {
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
}

/** Write raw text as a store file and return its path. */
function rawStore(text) {
  const path = join(tempDir(), 'store.json');
  writeFileSync(path, text);
  return path;
}

// User behaviour: a missing, locked or corrupted notice store never interrupts the user's session.
// Business rule: any failure to read the store means "no notice", exit 0, silently.
test('should exit 0 with no output when the store is missing', async () => {
  const storePath = join(tempDir(), 'does-not-exist.json');

  assertSilentSuccess(await runHook({ sessionId: randomUUID(), storePath }));
});

test('should exit 0 with no output when the store is unreadable (chmod 000)', async (t) => {
  if (process.getuid?.() === 0) {
    t.skip('running as root: chmod 000 does not stop reads');
    return;
  }
  const storePath = rawStore(JSON.stringify({ sessions: [], seen: [] }));
  chmodSync(storePath, 0o000);

  assertSilentSuccess(await runHook({ sessionId: randomUUID(), storePath }));
});

test('should exit 0 with no output when the store is not JSON', async () => {
  const storePath = rawStore('{ not json');

  assertSilentSuccess(await runHook({ sessionId: randomUUID(), storePath }));
});

// User behaviour: a hook call with garbled input from Claude Code does not surface an error to the user.
// Business rule: unreadable hook input means "do nothing", exit 0, silently.
for (const [label, stdin] of [
  ['empty', ''],
  ['not JSON', 'not json at all'],
]) {
  test(`should exit 0 with no output when stdin is ${label}`, async () => {
    assertSilentSuccess(await runHook({ stdin }));
  });
}

test('should exit 0 with no output when the state dir cannot be created', async () => {
  // User behaviour: a broken or blocked state location never interrupts the session.
  // Business rule: failing to record a notice as handled means not injecting it, silently.
  const blocker = join(tempDir(), 'a-file');
  writeFileSync(blocker, '');
  const sessionId = randomUUID();
  const store = { sessions: [{ id: sessionId, tag: 'Heads up', view: { line: 'Disk is almost full' } }], seen: [] };

  assertSilentSuccess(await runHook({ sessionId, store, stateDir: join(blocker, 'state') }));
});

test('should exit 0 with no output when transcript_path is missing and nothing matches', async () => {
  // User behaviour: hook input without a transcript path does not crash the hook.
  // Business rule: missing optional input fields never surface as an error.
  const stdin = JSON.stringify({ session_id: randomUUID(), hook_event_name: 'PostToolUse' });

  assertSilentSuccess(await runHook({ stdin, store: { sessions: [], seen: [] } }));
});

// User behaviour: if Claude Code changes its store format, the agent tells the user once that heads-ups are off,
// instead of the plugin failing silently forever or crashing the session.
// Business rule: an unexpected store shape gives one warning per session, naming the plugin version.
const changedShapes = [
  ['sessions is missing', { seen: [] }],
  ['sessions is not an array', { sessions: { id: 'x' }, seen: [] }],
  ['an entry id is not a string', { sessions: [{ id: 42 }], seen: [] }],
  ['view.line is a number', { sessions: [{ id: 'abc', view: { line: 7 } }], seen: [] }],
  ['the store is not an object', null],
  ['an entry is not an object', { sessions: ['abc'], seen: [] }],
  ['view is not an object', { sessions: [{ id: 'abc', view: 'text' }], seen: [] }],
  ['view.explanation is not a string', { sessions: [{ id: 'abc', view: { line: 'x', explanation: 1 } }], seen: [] }],
  ['tag is not a string', { sessions: [{ id: 'abc', tag: 1 }], seen: [] }],
];

// The version the warning must name, read from the plugin manifest so a version bump needs no test change.
const pluginVersion = JSON.parse(readFileSync(join(repoRoot, '.claude-plugin', 'plugin.json'), 'utf8')).version;

function assertShapeWarning(result, event = 'PostToolUse') {
  const context = injectedContext(result);
  assert.equal(result.json.hookSpecificOutput.hookEventName, event);
  assert.ok(context.includes('store format changed'), 'says the store format changed');
  assert.ok(context.includes('heads-ups are off'), 'says heads-ups are off for now');
  assert.ok(context.includes(`version ${pluginVersion}`), `names the plugin version (${pluginVersion})`);
}

for (const [label, store] of changedShapes) {
  test(`should inject one warning naming the plugin version when ${label}`, async () => {
    // Written raw so that a null store reaches the hook as-is.
    const storePath = rawStore(JSON.stringify(store));
    assertShapeWarning(await runHook({ sessionId: randomUUID(), storePath }));
  });
}

test('should stay silent on the next run in the same session', async () => {
  const sessionId = randomUUID();
  const stateDir = tempDir();
  const store = changedShapes[1][1];

  const first = await runHook({ sessionId, store, stateDir });
  const second = await runHook({ sessionId, store, stateDir });

  assertShapeWarning(first);
  assertSilentSuccess(second);
});

test('should warn again in a different session', async () => {
  const stateDir = tempDir();
  const store = changedShapes[1][1];

  await runHook({ sessionId: randomUUID(), store, stateDir });
  const other = await runHook({ sessionId: randomUUID(), store, stateDir });

  assertShapeWarning(other);
});
