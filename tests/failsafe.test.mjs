// Fail-safe: whatever goes wrong, the hook never breaks or clutters the user's session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runHook, tempDir } from './helpers.mjs';

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

test('should exit 0 with no output when transcript_path is missing', async () => {
  // User behaviour: hook input without a transcript path does not crash the hook.
  // Business rule: missing optional input fields never surface as an error.
  const stdin = JSON.stringify({ session_id: randomUUID(), hook_event_name: 'PostToolUse' });

  assertSilentSuccess(await runHook({ stdin }));
});

// User behaviour: if Claude Code changes its store format, the session keeps working.
// Business rule: a store without a sessions array is never a crash (Task 7 adds a one-time warning).
for (const [label, store] of [
  ['missing', { seen: [] }],
  ['not an array', { sessions: { id: 'x' }, seen: [] }],
]) {
  test(`should exit 0 with no output when sessions is ${label}`, async () => {
    assertSilentSuccess(await runHook({ sessionId: randomUUID(), store }));
  });
}
