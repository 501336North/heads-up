// Routing for resumed sessions: the notice may be stored under the original (transcript) id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runHook, storeWithView, tempDir } from './helpers.mjs';

const view = { line: 'The build cache is stale', explanation: 'Rebuild before testing.' };

function assertNothingShown(result) {
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');
}

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

  assert.equal(result.code, 0);
  assert.ok(result.json, `expected hook JSON on stdout, got: ${JSON.stringify(result.stdout)}`);
  assert.ok(result.json.hookSpecificOutput.additionalContext.includes(view.line));
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

  assert.equal(result.code, 0);
  assert.ok(result.json, `expected hook JSON on stdout, got: ${JSON.stringify(result.stdout)}`);
  assert.ok(result.json.hookSpecificOutput.additionalContext.includes(view.line));
});
