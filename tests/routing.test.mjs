// Routing for resumed sessions: the notice may be stored under the original (transcript) id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { assertNothingShown, injectedContext, runHook, storeWithView, tempDir } from './helpers.mjs';

const view = { line: 'The build cache is stale', explanation: 'Rebuild before testing.' };

test('should inject a view stored under the transcript id when the hook session_id is the continued id', async () => {
  // User behaviour: after resuming a session, the agent still gets the heads-up shown for that conversation.
  // Business rule: a session is matched by its hook session_id or by its transcript file's id.
  const originalId = randomUUID();
  const resumedId = randomUUID();

  const result = await runHook({
    sessionId: resumedId,
    transcriptPath: `/x/${originalId}.jsonl`,
    store: storeWithView(originalId, view),
  });

  assert.ok(injectedContext(result).includes(view.line));
});

test('should mark it handled so the next run under either id prints nothing', async () => {
  // User behaviour: a resumed session is told about a heads-up once, whichever id the hook arrives under.
  // Business rule: a notice is handled once per conversation, not once per runtime id.
  const originalId = randomUUID();
  const resumedId = randomUUID();
  const stateDir = tempDir();
  const store = storeWithView(originalId, view);
  const transcriptPath = `/x/${originalId}.jsonl`;

  const first = await runHook({ sessionId: resumedId, transcriptPath, store, stateDir });
  const again = await runHook({ sessionId: resumedId, transcriptPath, store, stateDir });
  const underOriginal = await runHook({ sessionId: originalId, transcriptPath, store, stateDir });

  assert.ok(first.json, 'first run injects the notice');
  assertNothingShown(again);
  assertNothingShown(underOriginal);
});

for (const badId of ['..', '.', 'a.b']) {
  test(`should ignore a transcript id that is not a plain id (${JSON.stringify(badId)})`, async () => {
    // User behaviour: a strange transcript file name can never make the hook write outside its state dir.
    // Business rule: transcript ids are validated like session ids before they are used in any path.
    const parent = tempDir();
    const stateDir = join(parent, 'state');

    const result = await runHook({
      sessionId: randomUUID(),
      transcriptPath: `/x/${badId}.jsonl`,
      store: storeWithView(badId, view),
      stateDir,
    });

    assertNothingShown(result);
    assert.deepEqual(readdirSync(parent), [], 'nothing written in or next to the state dir');
  });
}

test('should still inject by session_id when transcript_path is missing', async () => {
  // User behaviour: a session gets its heads-up even if Claude Code sends no transcript path.
  // Business rule: the transcript id is an extra candidate; its absence never blocks the session_id match.
  const sessionId = randomUUID();
  const stdin = JSON.stringify({ session_id: sessionId, hook_event_name: 'PostToolUse' });

  const result = await runHook({ stdin, store: storeWithView(sessionId, view) });

  assert.ok(injectedContext(result).includes(view.line));
});

test('should deliver the views stored under both ids of a resumed session, one per run', async () => {
  // User behaviour: when a resumed session has a heads-up under its original id and another under its new id,
  // the agent gets both, one after the other, instead of only ever the first.
  // Business rule: matching entries with a view are tried in store order; one already handled is skipped, the
  // first unhandled one is delivered (one notice per run), and nothing is printed once all are handled.
  const originalId = randomUUID();
  const runtimeId = randomUUID();
  const stateDir = tempDir();
  const a = { line: 'Notice A under the original id' };
  const b = { line: 'Notice B under the runtime id' };
  const store = {
    sessions: [
      { id: originalId, tag: 'Heads up', view: a },
      { id: runtimeId, tag: 'Heads up', view: b },
    ],
    seen: [],
  };
  const run = () => runHook({ sessionId: runtimeId, transcriptPath: `/x/${originalId}.jsonl`, store, stateDir });

  const first = await run();
  const second = await run();
  const third = await run();

  assert.ok(injectedContext(first).includes(a.line), 'run 1 delivers A');
  const secondContext = injectedContext(second);
  assert.ok(secondContext.includes(b.line), 'run 2 delivers B');
  assert.ok(!secondContext.includes(a.line), 'run 2 delivers only B');
  assertNothingShown(third);
});

test('should deliver a line mirrored under both ids of a resumed session only once', async () => {
  // User behaviour: when Claude Code stores the same heads-up under both ids of a resumed session, the agent
  // is told about it once, not twice.
  // Business rule: matching views are deduplicated by line; a mirrored line is tried only under its first entry.
  const originalId = randomUUID();
  const runtimeId = randomUUID();
  const stateDir = tempDir();
  const store = {
    sessions: [
      { id: originalId, tag: 'Heads up', view },
      { id: runtimeId, tag: 'Heads up', view },
    ],
    seen: [],
  };
  const run = () => runHook({ sessionId: runtimeId, transcriptPath: `/x/${originalId}.jsonl`, store, stateDir });

  const results = [await run(), await run(), await run()];

  assert.equal(results.filter((r) => r.stdout !== '').length, 1, 'delivered exactly once over 3 runs');
  assert.ok(injectedContext(results[0]).includes(view.line), 'the first run delivers it');
});
