// Dedupe and state safety: each notice reaches the agent once per session, and state is private.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { assertNothingShown, injectedContext, runHook, STATE_SENTINEL, storeWithView, tempDir } from './helpers.mjs';

const view = { line: 'The build cache is stale', explanation: 'Rebuild before testing.' };

test('should print nothing when the same notice was already injected in this session', async () => {
  // User behaviour: the agent is not nagged with the same heads-up on every tool call.
  // Business rule: a notice is injected at most once per session.
  const sessionId = randomUUID();
  const stateDir = tempDir();
  const store = storeWithView(sessionId, view);

  const first = await runHook({ sessionId, store, stateDir });
  const second = await runHook({ sessionId, store, stateDir });

  assert.ok(first.json, 'first run injects the notice');
  assertNothingShown(second);
});

test('should inject again when a different notice replaces the view', async () => {
  // User behaviour: a new heads-up in the same session still reaches the agent.
  // Business rule: dedupe is per notice line, not per session.
  const sessionId = randomUUID();
  const stateDir = tempDir();
  const newer = { line: 'Port 3000 is in use', explanation: 'Another server is running.' };

  await runHook({ sessionId, store: storeWithView(sessionId, view), stateDir });
  const second = await runHook({ sessionId, store: storeWithView(sessionId, newer), stateDir });

  assert.ok(injectedContext(second).includes(newer.line), 'the new notice is injected');
});

test('should create the state dir 0700 and markers 0600', async () => {
  // User behaviour: other local users cannot read which notices this user's sessions received.
  // Business rule: state lives in a private dir (0700) with private marker files (0600).
  const sessionId = randomUUID();
  const stateDir = join(tempDir(), 'state');

  await runHook({ sessionId, store: storeWithView(sessionId, view), stateDir });

  assert.equal(statSync(stateDir).mode & 0o777, 0o700, 'state dir is 0700');
  // v1.1: the state root also holds the saved log (heads-up.log), which is not a session dir.
  const sessionDirs = readdirSync(stateDir).filter((name) => name !== STATE_SENTINEL && name !== 'heads-up.log');
  assert.equal(sessionDirs.length, 1, 'one session subdir');
  assert.equal(statSync(join(stateDir, STATE_SENTINEL)).mode & 0o777, 0o600, 'state mark is 0600');
  const sessionDir = join(stateDir, sessionDirs[0]);
  const markers = readdirSync(sessionDir);
  assert.ok(markers.length > 0, 'at least one marker');
  for (const marker of markers) {
    assert.equal(statSync(join(sessionDir, marker)).mode & 0o777, 0o600, `marker ${marker} is 0600`);
  }
});

test('should exit 0 silently and write nothing when session_id is not a plain id (e.g. "../x")', async () => {
  // User behaviour: a malformed session id can never make the hook write outside its state dir.
  // Business rule: ids are validated before they are used in any path; invalid ids mean silent exit.
  const parent = tempDir();
  const stateDir = join(parent, 'state');

  const result = await runHook({ sessionId: '../x', store: storeWithView('../x', view), stateDir });

  assertNothingShown(result);
  assert.equal(existsSync(stateDir), false, 'state dir not created');
  assert.deepEqual(readdirSync(parent), [], 'nothing written next to the state dir');
});

// User behaviour: malformed hook input (a session_id that is not a string) never injects anything.
// Business rule: session_id must be a string before it is checked against the plain-id rule; a non-string id
// would otherwise be coerced (null -> "null", ["x"] -> "x") and match.
for (const [label, badId] of [
  ['null', () => null],
  ['an array', (id) => [id]],
]) {
  test(`should print nothing when session_id is ${label}`, async () => {
    const realId = randomUUID();
    const stdin = JSON.stringify({
      session_id: badId(realId),
      transcript_path: `/x/${realId}.jsonl`,
      hook_event_name: 'PostToolUse',
    });

    const result = await runHook({ stdin, store: storeWithView(realId, view) });

    assertNothingShown(result);
  });
}
