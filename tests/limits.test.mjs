// Limits: a hostile or runaway store or state dir can never make a hook run slow enough to stall the session
// (Claude Code kills a hook after 5 s).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  aged,
  assertNothingShown,
  injectedContext,
  markStateDir,
  runHook,
  storeWithView,
  tempDir,
  writeStore,
} from './helpers.mjs';

// Matches MAX_CLAIM_TRIES and MAX_PRUNE_ENTRIES in core/heads-up.mjs.
const MAX_CLAIM_TRIES = 8;
const MAX_PRUNE_ENTRIES = 2000;
// Matches MAX_STORE_BYTES in core/heads-up.mjs.
const MAX_STORE_BYTES = 5 * 1024 * 1024;

/** The on-disk marker name for a handled notice line (the first 16 hex chars of its sha256). */
const markerFor = (line) => createHash('sha256').update(line).digest('hex').slice(0, 16);

/** A marked state dir in which each of `lines` is already handled for `sessionId`. */
function stateWithHandled(sessionId, lines) {
  const stateDir = markStateDir(tempDir());
  mkdirSync(join(stateDir, sessionId));
  for (const line of lines) writeFileSync(join(stateDir, sessionId, markerFor(line)), '');
  return stateDir;
}

/** A store for `sessionId` with one entry per line, in order. */
const storeOf = (sessionId, lines) => ({
  sessions: lines.map((line) => ({ id: sessionId, tag: 'Heads up', view: { line } })),
  seen: [],
});

// User behaviour: a store flooded with already-handled notices never slows the session down.
// Business rule: each run tries at most MAX_CLAIM_TRIES distinct notices, in store order; a notice past that
// cap is not delivered by this run.
test(`should not deliver a new notice that comes after ${MAX_CLAIM_TRIES} handled ones`, async () => {
  const sessionId = randomUUID();
  const handled = Array.from({ length: 20 }, (_, i) => `Handled notice ${i}`);
  const fresh = 'A new notice past the cap';
  const lines = [...handled.slice(0, 14), fresh, ...handled.slice(14)];
  const stateDir = stateWithHandled(sessionId, handled);

  const result = await runHook({ sessionId, store: storeOf(sessionId, lines), stateDir });

  assertNothingShown(result);
});

// Business rule: entries with the same line count once toward the cap (the first in store order is tried).
test('should count repeated lines once toward the cap', async () => {
  const sessionId = randomUUID();
  const handled = 'The same handled notice';
  const fresh = 'A new notice among repeats';
  const lines = [...Array(14).fill(handled), fresh, ...Array(6).fill(handled)];
  const stateDir = stateWithHandled(sessionId, [handled]);

  const result = await runHook({ sessionId, store: storeOf(sessionId, lines), stateDir });

  assert.ok(injectedContext(result).includes(fresh), 'the new notice is delivered');
});

test('should finish in under 1 s on a 5 MB store of ~130k handled entries for this session', async () => {
  // Short ids and lines, and no tag, pack ~130k entries into the 5 MB store limit; 8 distinct lines, all handled.
  const sessionId = `s${Date.now().toString(36)}`;
  const handled = Array.from({ length: MAX_CLAIM_TRIES }, (_, i) => `h${i}`);
  const sessions = Array.from({ length: 130_000 }, (_, i) => ({ id: sessionId, view: { line: handled[i % 8] } }));
  const storePath = writeStore(tempDir(), { sessions, seen: [] });
  assert.ok(statSync(storePath).size <= MAX_STORE_BYTES, 'precondition: the store is within the size limit');
  const stateDir = stateWithHandled(sessionId, handled);
  const started = Date.now();

  const result = await runHook({ sessionId, storePath, stateDir, timeout: 5000 });

  const ms = Date.now() - started;
  assertNothingShown(result);
  assert.ok(ms < 1000, `finished in ${ms} ms`);
});

// User behaviour: a state dir holding a huge pile of old markers never makes one run slow; it is cleaned up
// over several runs instead.
// Business rule: one prune examines at most MAX_PRUNE_ENTRIES directory entries, then stops; the next
// delivering run continues where the pile is left.
test(`should prune at most ${MAX_PRUNE_ENTRIES} entries per run and continue on the next run`, async () => {
  const stateDir = markStateDir(tempDir());
  const pile = aged(join(stateDir, 'old-session'), 400, { dir: true });
  for (let i = 0; i < 3000; i++) aged(join(pile, i.toString(16).padStart(16, '0')), 400);
  const remaining = () => (existsSync(pile) ? readdirSync(pile).length : 0);
  const runUnrelated = () => {
    const sessionId = randomUUID();
    return runHook({ sessionId, store: storeWithView(sessionId, { line: 'Unrelated notice' }), stateDir });
  };

  assert.ok((await runUnrelated()).json, 'run 1 delivers');
  const afterFirst = remaining();
  assert.ok((await runUnrelated()).json, 'run 2 delivers');
  const afterSecond = remaining();

  assert.ok(afterFirst >= 3000 - MAX_PRUNE_ENTRIES, `run 1 deletes at most ${MAX_PRUNE_ENTRIES}, ${afterFirst} left`);
  assert.ok(afterFirst < 3000, 'run 1 deletes some');
  assert.equal(afterSecond, 0, 'run 2 deletes the rest');
});
