// Settings: HEADS_UP=off turns the hook into a no-op.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runHook, storeWithView, tempDir } from './helpers.mjs';

const view = { line: 'The build cache is stale', explanation: 'Rebuild before testing.' };

function assertOffEffect(result, stateDir) {
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.ok(!existsSync(stateDir) || readdirSync(stateDir).length === 0, 'no state written');
}

// User behaviour: a user who turns heads-ups off gets no injected notices and no state on disk.
// Business rule: HEADS_UP=off (any case, surrounding spaces ignored) disables the hook before it reads anything.
for (const value of ['off', 'OFF', ' Off ']) {
  test(`should print nothing and write no marker when HEADS_UP=${JSON.stringify(value)}`, async () => {
    const sessionId = randomUUID();
    const stateDir = join(tempDir(), 'state');

    const result = await runHook({ sessionId, store: storeWithView(sessionId, view), stateDir, env: { HEADS_UP: value } });

    assertOffEffect(result, stateDir);
  });
}

test('should not warn about a changed store shape when HEADS_UP=off', async () => {
  // Business rule: "off" silences everything, including the changed-shape warning.
  const sessionId = randomUUID();
  const stateDir = join(tempDir(), 'state');

  const result = await runHook({ sessionId, store: { seen: [] }, stateDir, env: { HEADS_UP: 'off' } });

  assertOffEffect(result, stateDir);
});

// User behaviour: any value other than "off" (including typos and empty) leaves heads-ups working,
// so a mistyped setting never silently hides notices.
// Business rule: only "off" is a switch; there is no "on" value to remember.
for (const value of ['on', '', '0', 'false', 'offline', 'OFF?']) {
  test(`should behave normally for any other HEADS_UP value (${JSON.stringify(value)})`, async () => {
    const sessionId = randomUUID();

    const result = await runHook({ sessionId, store: storeWithView(sessionId, view), env: { HEADS_UP: value } });

    assert.ok(result.json, `expected hook JSON on stdout, got: ${JSON.stringify(result.stdout)}`);
    assert.ok(result.json.hookSpecificOutput.additionalContext.includes(view.line));
  });
}
