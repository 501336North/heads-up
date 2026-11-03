// Injection: the hook hands this session's heads-up to the agent, and only this session's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runHook, storeWithView, tempDir } from './helpers.mjs';

// Text with quotes, newlines and a control character, so the JSON round-trip is exercised.
const view = {
  line: 'Port "3000" is already \'in use\'',
  explanation: 'Another dev server is running.\nStop it first.\u0007 Then retry.',
};

function assertNothingShown(result) {
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');
}

test("should inject the line, explanation and check-act-report instruction when this session's entry has a view", async () => {
  // User behaviour: the agent in this session learns about its heads-up, verifies it, acts, and reports to the user.
  // Business rule: the notice is a claim to verify, not an order; the user is told what they still need to do.
  const sessionId = randomUUID();

  const result = await runHook({ event: 'PostToolUse', sessionId, store: storeWithView(sessionId, view) });

  assert.equal(result.code, 0);
  assert.ok(result.json, `expected hook JSON on stdout, got: ${JSON.stringify(result.stdout)}`);
  assert.equal(result.json.hookSpecificOutput.hookEventName, 'PostToolUse');
  const context = result.json.hookSpecificOutput.additionalContext;
  assert.ok(context.includes(view.line), 'mentions the line exactly');
  assert.ok(context.includes(view.explanation), 'mentions the explanation exactly');
  assert.ok(context.includes('Check whether it is true'), 'asks the agent to verify the claim');
  assert.ok(context.includes('tell the user'), 'asks the agent to tell the user');
  assert.ok(context.includes('still need'), 'asks the agent to say what the user still needs to do');
});

test("should print nothing when only another session's entry has a view", async () => {
  // User behaviour: a heads-up meant for one session never shows up in another session.
  // Business rule: notices are routed by session id only.
  const otherSessionId = randomUUID();

  const result = await runHook({ sessionId: randomUUID(), store: storeWithView(otherSessionId, view) });

  assertNothingShown(result);
});

test('should print nothing when a seen line matches no view', async () => {
  // User behaviour: an agent is not told about a notice its session does not currently show.
  // Business rule: only the session entry's view counts; the global `seen` list is never a source of notices.
  const sessionId = randomUUID();
  const store = { sessions: [{ id: sessionId, tag: 'Heads up' }], seen: [view.line] };

  const result = await runHook({ sessionId, store });

  assertNothingShown(result);
});

test('should not replay seen lines in a new session', async () => {
  // User behaviour: starting a fresh session does not resurface old heads-ups from earlier sessions.
  // Business rule: lines in `seen` (and views of other sessions) are never injected into a new session.
  const oldSessionId = randomUUID();
  const newSessionId = randomUUID();
  const store = {
    sessions: [{ id: oldSessionId, tag: 'Heads up', view }, { id: newSessionId, tag: 'Heads up' }],
    seen: [view.line, 'An older notice'],
  };

  const result = await runHook({ sessionId: newSessionId, store });

  assertNothingShown(result);
});

test('should answer UserPromptSubmit with hookEventName UserPromptSubmit', async () => {
  // User behaviour: a heads-up also reaches the agent when the user sends a prompt, not only after tool calls.
  // Business rule: the hook output names the event it answers, as Claude Code requires.
  const sessionId = randomUUID();

  const result = await runHook({ event: 'UserPromptSubmit', sessionId, store: storeWithView(sessionId, view) });

  assert.equal(result.code, 0);
  assert.ok(result.json, `expected hook JSON on stdout, got: ${JSON.stringify(result.stdout)}`);
  assert.equal(result.json.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.ok(result.json.hookSpecificOutput.additionalContext.includes(view.line));
});

for (const event of ['Stop', 'PreToolUse']) {
  test(`should print nothing for any other hook event (${event})`, async () => {
    // User behaviour: a heads-up is not used up by an event that cannot show it to the agent.
    // Business rule: only UserPromptSubmit and PostToolUse are answered; other events claim nothing.
    const sessionId = randomUUID();
    const stateDir = tempDir();

    const result = await runHook({ event, sessionId, store: storeWithView(sessionId, view), stateDir });

    assertNothingShown(result);
    const sessionDir = join(stateDir, sessionId);
    assert.ok(!existsSync(sessionDir) || readdirSync(sessionDir).length === 0, 'no marker written');
  });
}

test('should name the tag in the context when the entry is tagged "You should know"', async () => {
  // User behaviour: the agent sees what kind of notice it is, as Claude Code labelled it.
  // Business rule: the context starts from the entry's own tag (DESIGN A3).
  const sessionId = randomUUID();

  const result = await runHook({ sessionId, store: storeWithView(sessionId, view, { tag: 'You should know' }) });

  assert.ok(result.json, `expected hook JSON on stdout, got: ${JSON.stringify(result.stdout)}`);
  assert.ok(result.json.hookSpecificOutput.additionalContext.includes('You should know'));
});

test('should say "Heads up" when the tag is missing', async () => {
  // User behaviour: an untagged notice is still clearly presented to the agent as a heads-up.
  // Business rule: "Heads up" is the default label when the entry has no tag.
  const sessionId = randomUUID();
  const store = { sessions: [{ id: sessionId, view }], seen: [] };

  const result = await runHook({ sessionId, store });

  assert.ok(result.json, `expected hook JSON on stdout, got: ${JSON.stringify(result.stdout)}`);
  assert.ok(result.json.hookSpecificOutput.additionalContext.includes('Heads up'));
});

test('should not print "undefined" when the view has no explanation', async () => {
  // User behaviour: a notice with only a line reads cleanly to the agent, with no junk text.
  // Business rule: the explanation is optional and simply left out when absent.
  const sessionId = randomUUID();
  const lineOnly = { line: 'Disk is almost full' };

  const result = await runHook({ sessionId, store: storeWithView(sessionId, lineOnly) });

  assert.ok(result.json, `expected hook JSON on stdout, got: ${JSON.stringify(result.stdout)}`);
  const context = result.json.hookSpecificOutput.additionalContext;
  assert.ok(context.includes(lineOnly.line), 'mentions the line');
  assert.ok(context.includes('Check whether it is true'), 'includes the instruction');
  assert.ok(!context.includes('undefined'), 'no "undefined" text');
});
