// Acceptance tests: the hook as Claude Code sees it (JSON in on stdin, JSON out on stdout).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { assertNothingShown, injectedContext, runHook, storeWithView, tempDir } from './helpers.mjs';

const view = {
  line: 'The build cache "dist/" is stale',
  explanation: 'Files in dist/ are older than src/.\nRebuild before testing.',
};

// US-001: Agent receives its own heads-ups

for (const event of ['PostToolUse', 'UserPromptSubmit']) {
  test(`a heads-up for this session reaches the agent after ${event}`, async () => {
    // Given this session's entry in the store has a heads-up
    const sessionId = randomUUID();

    // When the hook runs in this session
    const result = await runHook({ event, sessionId, store: storeWithView(sessionId, view) });

    // Then the agent is given the heads-up and told to check it and tell the user
    const context = injectedContext(result);
    assert.equal(result.json.hookSpecificOutput.hookEventName, event);
    assert.ok(context.includes(view.line), 'mentions the heads-up line');
    assert.ok(context.includes(view.explanation), 'mentions the explanation');
    assert.ok(context.includes('Check whether it is true'), 'asks the agent to check it');
    assert.ok(context.includes('tell the user'), 'asks the agent to tell the user');
  });
}

test('the same heads-up is given to the agent only once per session', async () => {
  // Given a heads-up for this session that the agent has already been given
  const sessionId = randomUUID();
  const store = storeWithView(sessionId, view);
  const stateDir = tempDir();
  const first = await runHook({ sessionId, store, stateDir });
  assert.ok(first.json, 'precondition: the first run gives the heads-up');

  // When the hook runs again in the same session
  const second = await runHook({ sessionId, store, stateDir });

  // Then nothing more is shown
  assertNothingShown(second);
});

// US-002: Sessions don't see each other's heads-ups

test("another session's heads-up is never shown in this session", async () => {
  // Given only another session's entry has a heads-up
  const thisSession = randomUUID();
  const otherSession = randomUUID();
  const store = {
    sessions: [{ id: thisSession, tag: 'Heads up' }, { id: otherSession, tag: 'Heads up', view }],
    seen: [],
  };

  // When the hook runs in this session
  const result = await runHook({ sessionId: thisSession, store });

  // Then nothing is shown
  assertNothingShown(result);
});

test('a resumed session still gets the heads-up stored under its original id', async () => {
  // Given a resumed session: new runtime id, transcript still named after the original id,
  // and the heads-up stored under the original id
  const originalId = randomUUID();
  const resumedId = randomUUID();

  // When the hook runs in the resumed session
  const result = await runHook({
    sessionId: resumedId,
    transcriptPath: join('/x', `${originalId}.jsonl`),
    store: storeWithView(originalId, view),
  });

  // Then the agent is given the heads-up
  assert.ok(injectedContext(result).includes(view.line));
});

// US-003: Never breaks a session

test('a missing notice store is ignored silently', async () => {
  // Given the notice store file does not exist
  const storePath = join(tempDir(), 'does-not-exist.json');

  // When the hook runs
  const result = await runHook({ sessionId: randomUUID(), storePath });

  // Then it succeeds and shows nothing
  assertNothingShown(result);
});

// US-004: Exactly once with both copies installed

test('five copies running at the same moment give the heads-up exactly once', async () => {
  // Given one heads-up for this session and a shared handled-state dir
  const sessionId = randomUUID();
  const store = storeWithView(sessionId, view);
  const stateDir = tempDir();

  // When five copies of the hook start together
  const results = await Promise.all(Array.from({ length: 5 }, () => runHook({ sessionId, store, stateDir })));

  // Then all succeed and exactly one gives the heads-up
  for (const r of results) assert.equal(r.code, 0);
  assert.equal(results.filter((r) => r.json).length, 1);
});

// US-005: Turn it off

test('heads-ups are not shown when turned off', async () => {
  // Given heads-ups are turned off and this session has a heads-up
  const sessionId = randomUUID();

  // When the hook runs
  const result = await runHook({ sessionId, store: storeWithView(sessionId, view), env: { HEADS_UP: 'off' } });

  // Then nothing is shown
  assertNothingShown(result);
});
