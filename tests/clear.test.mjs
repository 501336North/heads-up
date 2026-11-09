// Clearing: once the hook has relayed this session's heads-up to the agent, it removes that notice from the store
// (so Claude Code can show the next one) and tells the user the notice was relayed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  assertNothingShown,
  injectedContext,
  markStateDir,
  runHook,
  runWithClosedStdout,
  tempDir,
  writeBuiltinStore,
} from './helpers.mjs';

/** An unopened ("offer") notice with a line unique to this test. */
function offerView(line) {
  return { kind: 'offer', line, explanation: 'Explanation for: ' + line, shownAt: Date.now() };
}

/** A session entry as the built-in notice plugin writes it. */
function entry(id, view) {
  return { id, tag: 'Heads up', askedTurn: 3, offeredTurn: 4, view };
}

/** A full store file in a fresh temp dir; returns its path. */
function storeFile(sessions) {
  return writeBuiltinStore(tempDir(), {
    sessions,
    seen: ['An older notice'],
    known: ['A known fact'],
    typedPastInARow: 1,
    looksToSkip: 2,
  });
}

/** Parse the store file as it is on disk now (throws if it is not valid JSON). */
function readStoreFile(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** The entry with `id` in a parsed store. */
function entryOf(store, id) {
  return store.sessions.find((s) => s.id === id);
}

test("should remove this session's notice from the store after relaying it", async () => {
  // User behaviour: once the agent has the heads-up, the user does not have to dismiss it, and the next one can appear.
  // Business rule: only the delivered view leaves the store; every other field and top-level key is kept as it was.
  const sessionId = randomUUID();
  const line = `Clear me ${randomUUID()}`;
  const storePath = storeFile([entry(sessionId, offerView(line))]);
  const before = readStoreFile(storePath);

  const result = await runHook({ sessionId, storePath });

  assert.ok(injectedContext(result).includes(line), 'the notice still reaches the agent');
  const after = readStoreFile(storePath);
  const { view: _delivered, ...entryWithoutView } = entryOf(before, sessionId);
  assert.equal('view' in entryOf(after, sessionId), false, 'the delivered notice is gone from the store');
  assert.deepEqual(entryOf(after, sessionId), entryWithoutView, 'the rest of the session entry is unchanged');
  const { sessions: _sb, ...restBefore } = before;
  const { sessions: _sa, ...restAfter } = after;
  assert.deepEqual(restAfter, restBefore, 'other top-level keys are unchanged');
  if (process.platform !== 'win32') {
    assert.equal(statSync(storePath).mode & 0o777, 0o600, 'the store stays private to the user');
  }
});

test("should leave other sessions' notices in the store untouched", async () => {
  // User behaviour: relaying a heads-up in one session never makes another session's heads-up disappear.
  // Business rule: clearing changes only the entry of the session that received the notice.
  const sessionA = randomUUID();
  const sessionB = randomUUID();
  const storePath = storeFile([
    entry(sessionA, offerView(`For A ${randomUUID()}`)),
    entry(sessionB, offerView(`For B ${randomUUID()}`)),
  ]);
  const before = readStoreFile(storePath);

  const result = await runHook({ sessionId: sessionA, storePath });

  injectedContext(result);
  const after = readStoreFile(storePath);
  assert.equal('view' in entryOf(after, sessionA), false, "session A's relayed notice is cleared");
  assert.deepEqual(entryOf(after, sessionB), entryOf(before, sessionB), "session B's notice is untouched");
});

test('should tell the user the notice was relayed', async () => {
  // User behaviour: the user sees a short confirmation that the agent now has the heads-up, and which one.
  // Business rule: the message is exactly the check mark prefix followed by the notice line.
  const sessionId = randomUUID();
  const line = `Relay me ${randomUUID()}`;
  const storePath = storeFile([entry(sessionId, offerView(line))]);

  const result = await runHook({ sessionId, storePath });

  injectedContext(result);
  assert.equal(result.json.systemMessage, '✓ heads-up relayed to the agent: ' + line);
});

test('should clear the entry it delivered for a resumed session', async () => {
  // User behaviour: after resuming a session, the heads-up shown for it is relayed and then cleared like any other.
  // Business rule: the entry cleared is the one the notice was found under (here the transcript id), never another.
  const hookSessionId = randomUUID();
  const transcriptId = randomUUID();
  const line = `Resumed ${randomUUID()}`;
  const storePath = storeFile([entry(transcriptId, offerView(line))]);

  const result = await runHook({ sessionId: hookSessionId, transcriptPath: `/x/${transcriptId}.jsonl`, storePath });

  assert.ok(injectedContext(result).includes(line), 'the notice reaches the resumed session');
  assert.equal('view' in entryOf(readStoreFile(storePath), transcriptId), false, 'the delivered entry is cleared');
});

test('should not clear a notice the user has opened', async () => {
  // User behaviour: a heads-up the user has opened stays on screen for them; the agent still gets it.
  // Business rule: only an unopened ("offer") notice is cleared; any other kind leaves the store byte for byte.
  for (const kind of ['explained', 'asking']) {
    const sessionId = randomUUID();
    const line = `Opened ${kind} ${randomUUID()}`;
    const storePath = storeFile([entry(sessionId, { ...offerView(line), kind })]);
    const before = readFileSync(storePath);

    const result = await runHook({ sessionId, storePath });

    assert.ok(injectedContext(result).includes(line), `the ${kind} notice still reaches the agent`);
    assert.equal(result.json.systemMessage, '✓ heads-up relayed to the agent: ' + line, 'the user is told');
    assert.deepEqual(readFileSync(storePath), before, `the ${kind} notice is left in the store unchanged`);
  }
});

test('should not clear a notice it did not deliver this run', async () => {
  // User behaviour: a heads-up already relayed earlier is not relayed again, and this run does not touch the store.
  // Business rule: clearing follows only a delivery made in the same run.
  const sessionId = randomUUID();
  const stateDir = tempDir();
  const view = offerView(`Already relayed ${randomUUID()}`);
  const firstStore = storeFile([entry(sessionId, view)]);
  injectedContext(await runHook({ sessionId, storePath: firstStore, stateDir }));
  // The same notice again (e.g. the store restored), in a store this plugin has not written.
  const storePath = storeFile([entry(sessionId, view)]);
  const before = readFileSync(storePath);

  const result = await runHook({ sessionId, storePath, stateDir });

  assertNothingShown(result);
  assert.deepEqual(readFileSync(storePath), before, 'the store is left unchanged');
});

test('should not touch the store while the built-in holds its lock', async () => {
  // User behaviour: the hook never fights Claude Code over its notice store; the agent still gets the heads-up.
  // Business rule: the store is changed only under the built-in's own lock; a held lock is waited on briefly, then
  // left alone (never removed), and the store is not written.
  const sessionId = randomUUID();
  const line = `Locked ${randomUUID()}`;
  const storePath = storeFile([entry(sessionId, offerView(line))]);
  const lock = storePath + '.lock';
  mkdirSync(lock);
  const before = readFileSync(storePath);

  const started = Date.now();
  const result = await runHook({ sessionId, storePath });
  const elapsed = Date.now() - started;

  assert.ok(injectedContext(result).includes(line), 'the notice still reaches the agent');
  assert.equal(result.json.systemMessage, '✓ heads-up relayed to the agent: ' + line, 'the user is told');
  assert.deepEqual(readFileSync(storePath), before, 'the store is left unchanged');
  assert.ok(existsSync(lock), "the built-in's lock is never removed");
  assert.ok(elapsed < 3000, `the run gives up within 3 s (took ${elapsed} ms)`);
});

test('should release its lock after clearing', async () => {
  // User behaviour: after the hook clears a heads-up, Claude Code can keep updating its notices without waiting.
  // Business rule: the lock the hook takes is always released.
  const sessionId = randomUUID();
  const storePath = storeFile([entry(sessionId, offerView(`Unlock ${randomUUID()}`))]);

  const result = await runHook({ sessionId, storePath });

  injectedContext(result);
  assert.equal('view' in entryOf(readStoreFile(storePath), sessionId), false, 'the notice was cleared');
  assert.equal(existsSync(storePath + '.lock'), false, 'no lock is left behind');
});

/**
 * Run the hook while holding the store's lock, as the built-in would. Once the hook has written its log (the step
 * just before it goes for the lock) and a further LOCK_SETTLE_MS has passed, the hook is waiting on the lock
 * (it retries for about a second); `whileLocked()` then changes the store and the lock is released.
 */
async function runWhileLocked({ sessionId, storePath }, whileLocked) {
  const stateDir = tempDir();
  const lock = storePath + '.lock';
  mkdirSync(lock);
  const run = runHook({ sessionId, storePath, stateDir });
  const deadline = Date.now() + 5000;
  while (!existsSync(join(stateDir, 'heads-up.log')) && Date.now() < deadline) await sleep(10);
  await sleep(LOCK_SETTLE_MS);
  whileLocked();
  rmdirSync(lock);
  return run;
}

// Long enough for the hook to go from its log write to its first lock attempt; well inside its ~1 s of retries.
const LOCK_SETTLE_MS = 100;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Replace the store as the built-in does: write a temp file in its dir, then rename it over the store. */
function replaceStore(storePath, obj) {
  const temp = writeBuiltinStore(tempDir(), obj);
  renameSync(temp, storePath);
}

test('should clear once the built-in releases its lock', async () => {
  // User behaviour: a heads-up is still cleared when Claude Code happens to be writing its store at that moment.
  // Business rule: a briefly held lock is waited for (about a second), not given up on at once.
  const sessionId = randomUUID();
  const storePath = storeFile([entry(sessionId, offerView(`Wait for lock ${randomUUID()}`))]);

  const result = await runWhileLocked({ sessionId, storePath }, () => {});

  injectedContext(result);
  assert.equal('view' in entryOf(readStoreFile(storePath), sessionId), false, 'the notice is cleared after the wait');
  assert.equal(existsSync(storePath + '.lock'), false, 'no lock is left behind');
});

test('should clear once the built-in replaced its store by rename while the hook waited', async () => {
  // User behaviour: a heads-up is still cleared when Claude Code rewrote its store (e.g. a counter) during the wait.
  // Business rule: the built-in writes by temp file and rename, so the store's identity is checked under the lock,
  // not before it; the unchanged view is cleared and the built-in's other changes are kept.
  const sessionId = randomUUID();
  const storePath = storeFile([entry(sessionId, offerView(`Renamed ${randomUUID()}`))]);
  const bumped = { ...readStoreFile(storePath), typedPastInARow: 42 };

  const result = await runWhileLocked({ sessionId, storePath }, () => replaceStore(storePath, bumped));

  injectedContext(result);
  const after = readStoreFile(storePath);
  assert.equal('view' in entryOf(after, sessionId), false, 'the notice is cleared');
  assert.equal(after.typedPastInARow, 42, "the built-in's own change is kept");
});

for (const [change, edit] of [
  ['line', (view) => ({ ...view, line: `A newer notice ${randomUUID()}` })],
  ['shownAt', (view) => ({ ...view, shownAt: view.shownAt + 1 })],
]) {
  for (const [how, write] of [
    ['by rename', replaceStore],
    ['in place', (storePath, obj) => writeBuiltinStore(dirname(storePath), obj)],
  ]) {
    test(`should not clear a notice whose ${change} changed (${how}) while the hook waited for the lock`, async () => {
      // User behaviour: a newer heads-up Claude Code shows while the hook waits is never wiped by the hook.
      // Business rule: under the lock, the view is removed only if it is still the one delivered (same line and
      // shownAt); otherwise it is left as it is.
      const sessionId = randomUUID();
      const delivered = offerView(`Delivered ${randomUUID()}`);
      const storePath = storeFile([entry(sessionId, delivered)]);
      const newer = edit(delivered);

      const result = await runWhileLocked({ sessionId, storePath }, () =>
        write(storePath, { ...readStoreFile(storePath), sessions: [entry(sessionId, newer)] }),
      );

      injectedContext(result);
      assert.deepEqual(entryOf(readStoreFile(storePath), sessionId).view, newer, 'the newer view is still there');
    });
  }
}

test('should not clear a store swapped for a symlink while the hook waited for the lock', async (t) => {
  // User behaviour: a store path turned into a link under the hook is never rewritten.
  // Business rule: under the lock, the store is checked again (a regular file, opened without following a symlink,
  // the same file as checked); otherwise nothing is written.
  if (process.platform === 'win32') {
    t.skip('POSIX symlinks only');
    return;
  }
  const sessionId = randomUUID();
  const line = `Swapped ${randomUUID()}`;
  const storePath = storeFile([entry(sessionId, offerView(line))]);
  const other = join(tempDir(), 'store.json');
  writeFileSync(other, readFileSync(storePath), { mode: 0o600 });
  const otherBefore = readFileSync(other);

  const result = await runWhileLocked({ sessionId, storePath }, () => {
    unlinkSync(storePath);
    symlinkSync(other, storePath);
  });

  assert.ok(injectedContext(result).includes(line), 'the notice still reaches the agent');
  assert.ok(lstatSync(storePath).isSymbolicLink(), 'the store path is still a symlink');
  assert.deepEqual(readFileSync(other), otherBefore, 'the file behind the link is unchanged');
});

test('should not clear through a symlinked store', async (t) => {
  // User behaviour: a store path that is a link (to the real store or anything else) is never rewritten; the
  // agent still gets the heads-up.
  // Business rule: clearing only ever rewrites a regular file; a symlink is refused, left a symlink, and its
  // target is left byte for byte.
  if (process.platform === 'win32') {
    t.skip('POSIX symlinks only');
    return;
  }
  const sessionId = randomUUID();
  const line = `Linked ${randomUUID()}`;
  const target = storeFile([entry(sessionId, offerView(line))]);
  const link = join(tempDir(), 'store.json');
  symlinkSync(target, link);
  const before = readFileSync(target);
  const listings = () => [readdirSync(dirname(target)), readdirSync(dirname(link))];
  const listedBefore = listings();

  const result = await runHook({ sessionId, storePath: link });

  assert.ok(injectedContext(result).includes(line), 'the notice still reaches the agent');
  assert.ok(lstatSync(link).isSymbolicLink(), 'the store path is still a symlink');
  assert.deepEqual(readFileSync(target), before, 'the file behind the link is unchanged');
  assert.deepEqual(listings(), listedBefore, 'no lock or temp file is left in either dir');
});

test('should still relay when the store cannot be rewritten', async (t) => {
  // User behaviour: when the hook cannot clear a heads-up, the agent still gets it and the user sees no error.
  // Business rule: a failed clear changes nothing (store, its dir) and never affects the relay or the exit code.
  if (process.platform === 'win32') {
    t.skip('POSIX modes only');
    return;
  }
  if (process.getuid?.() === 0) {
    t.skip('running as root: a read-only dir does not stop writes');
    return;
  }
  const sessionId = randomUUID();
  const line = `Read-only ${randomUUID()}`;
  const storePath = storeFile([entry(sessionId, offerView(line))]);
  const dir = dirname(storePath);
  const before = readFileSync(storePath);
  const listedBefore = readdirSync(dir);
  chmodSync(dir, 0o555);
  t.after(() => chmodSync(dir, 0o700));

  const result = await runHook({ sessionId, storePath });

  assert.ok(injectedContext(result).includes(line), 'the notice still reaches the agent');
  assert.equal(result.json.systemMessage, '✓ heads-up relayed to the agent: ' + line, 'the user is told');
  assert.equal(result.stderr, '', 'nothing on stderr');
  assert.deepEqual(readFileSync(storePath), before, 'the store is unchanged');
  assert.deepEqual(readdirSync(dir), listedBefore, 'no lock or temp file is left');
});

test('should not clear the notice when the relay write fails', async () => {
  // User behaviour: a heads-up the agent never received stays on screen for the user (and for a later relay).
  // Business rule: the notice is cleared only after its relay was written; a failed write leaves the store as is.
  const sessionId = randomUUID();
  const storePath = storeFile([entry(sessionId, offerView(`Undelivered ${randomUUID()}`))]);
  const before = readFileSync(storePath);

  const result = await runWithClosedStdout({ sessionId, storePath, stateDir: tempDir() });

  assert.equal(result.code, 0, 'the failed relay still exits 0');
  assert.deepEqual(readFileSync(storePath), before, 'the notice is not cleared');
  assert.equal(existsSync(storePath + '.lock'), false, 'no lock is left behind');
});

/** Write `text` as the store file in a fresh temp dir (mode 0600); returns its path. */
function rawStoreFile(text) {
  const path = join(tempDir(), 'store.json');
  writeFileSync(path, text, { mode: 0o600 });
  return path;
}

/** The store `storeFile` would write, as an object, with an unopened notice for `sessionId`. */
function storeObject(sessionId, line) {
  return { sessions: [entry(sessionId, offerView(line))], seen: ['An older notice'], typedPastInARow: 1 };
}

test('should not clear a store that is not in the built-in format', async () => {
  // User behaviour: a store the hook cannot rewrite exactly as Claude Code would is never reformatted or grown;
  // the agent still gets the heads-up.
  // Business rule: the store is rewritten only when it is byte for byte Claude Code's own 2-space JSON form;
  // anything else (e.g. minified) is left byte for byte.
  const sessionId = randomUUID();
  const line = `Compact ${randomUUID()}`;
  const storePath = rawStoreFile(JSON.stringify(storeObject(sessionId, line)));
  const before = readFileSync(storePath);

  const result = await runHook({ sessionId, storePath });

  assert.ok(injectedContext(result).includes(line), 'the notice still reaches the agent');
  assert.deepEqual(readFileSync(storePath), before, 'the store is unchanged');
});

test('should not clear a store holding a number it cannot rewrite exactly', async () => {
  // User behaviour: clearing never silently changes data Claude Code keeps in its store.
  // Business rule: an integer above 2^53 (which JSON parsing rounds) makes the store not rewritable; it is left
  // byte for byte.
  const sessionId = randomUUID();
  const line = `Big number ${randomUUID()}`;
  const text = (JSON.stringify({ ...storeObject(sessionId, line), counter: '__BIG__' }, null, 2) + '\n').replace(
    '"__BIG__"',
    '12345678901234567890',
  );
  const storePath = rawStoreFile(text);
  const before = readFileSync(storePath);

  const result = await runHook({ sessionId, storePath });

  assert.ok(injectedContext(result).includes(line), 'the notice still reaches the agent');
  assert.deepEqual(readFileSync(storePath), before, 'the store is unchanged');
});

test('should not clear a store that is not valid UTF-8', async () => {
  // User behaviour: clearing never silently changes bytes Claude Code keeps in its store.
  // Business rule: a store whose bytes do not decode exactly cannot be rewritten losslessly; it is left byte for
  // byte.
  const sessionId = randomUUID();
  const line = `Bad bytes ${randomUUID()}`;
  const text = JSON.stringify({ ...storeObject(sessionId, line), note: '__BAD__' }, null, 2) + '\n';
  const [head, tail] = text.split('__BAD__');
  const storePath = join(tempDir(), 'store.json');
  writeFileSync(storePath, Buffer.concat([Buffer.from(head), Buffer.from([0xff]), Buffer.from(tail)]), { mode: 0o600 });
  const before = readFileSync(storePath);

  const result = await runHook({ sessionId, storePath });

  assert.ok(injectedContext(result).includes(line), 'the notice still reaches the agent');
  assert.deepEqual(readFileSync(storePath), before, 'the store is unchanged');
});

test("should keep the store's file mode when clearing", async (t) => {
  // User behaviour: clearing a heads-up never changes who can read Claude Code's store.
  // Business rule: the rewritten store keeps the original file's permission bits (here 0644).
  if (process.platform === 'win32') {
    t.skip('POSIX modes only');
    return;
  }
  const sessionId = randomUUID();
  const storePath = storeFile([entry(sessionId, offerView(`Mode ${randomUUID()}`))]);
  chmodSync(storePath, 0o644);

  const result = await runHook({ sessionId, storePath });

  injectedContext(result);
  assert.equal('view' in entryOf(readStoreFile(storePath), sessionId), false, 'the notice is cleared');
  assert.equal(statSync(storePath).mode & 0o777, 0o644, 'the store keeps mode 0644');
});

test('should clear despite a leftover temp file and leave no temp file behind', async () => {
  // User behaviour: a crash during an earlier clear never stops later heads-ups from being cleared, and never
  // litters the store's folder.
  // Business rule: the hook uses one fixed temp name next to the store, replaces a leftover one, and leaves no
  // temp file after the clear.
  const sessionId = randomUUID();
  const storePath = storeFile([entry(sessionId, offerView(`Leftover ${randomUUID()}`))]);
  const leftover = storePath + '.heads-up.tmp';
  writeFileSync(leftover, 'half-written', { mode: 0o600 });

  const result = await runHook({ sessionId, storePath });

  injectedContext(result);
  assert.equal('view' in entryOf(readStoreFile(storePath), sessionId), false, 'the notice is cleared');
  assert.equal(existsSync(leftover), false, 'the leftover temp file is gone');
  assert.deepEqual(
    readdirSync(dirname(storePath)).filter((name) => name.endsWith('.tmp')),
    [],
    'no temp file is left',
  );
});


test('should clear a store whose text holds a real U+FFFD character', async () => {
  // User behaviour: a heads-up is cleared even when Claude Code's store happens to hold the "�" character.
  // Business rule: the store is rewritten when its bytes are exactly the built-in's format, whatever valid
  // characters it holds.
  const sessionId = randomUUID();
  const storePath = writeBuiltinStore(tempDir(), {
    ...storeObject(sessionId, `Replacement ${randomUUID()}`),
    note: 'broken � text',
  });

  const result = await runHook({ sessionId, storePath });

  injectedContext(result);
  const after = readStoreFile(storePath);
  assert.equal('view' in entryOf(after, sessionId), false, 'the notice is cleared');
  assert.equal(after.note, 'broken � text', 'the other text is kept');
});

test('should still clear when a directory sits at the temp file name', async () => {
  // User behaviour: a stray folder next to the store can never stop heads-ups from being cleared.
  // Business rule: when the fixed temp name cannot be used, a per-run temp name is used instead, and no temp file
  // is left behind.
  const sessionId = randomUUID();
  const storePath = storeFile([entry(sessionId, offerView(`Temp dir ${randomUUID()}`))]);
  mkdirSync(storePath + '.heads-up.tmp');

  const result = await runHook({ sessionId, storePath });

  injectedContext(result);
  assert.equal('view' in entryOf(readStoreFile(storePath), sessionId), false, 'the notice is cleared');
  const left = readdirSync(dirname(storePath)).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(left, ['store.json.heads-up.tmp'], 'only the stray directory is left');
});

const NOT_CLEARED =
  "✓ heads-up relayed to the agent (not cleared: Claude Code's notice file changed; dismiss it yourself): ";

test("should tell the user when the notice file's layout prevents clearing", async () => {
  // User behaviour: if Claude Code changes how it writes its notice file, the user learns that heads-ups are no
  // longer cleared for them, instead of the "relayed" line hiding it.
  // Business rule: with clearing on, a store not in the built-in's exact layout gives the "not cleared" message
  // (and is left byte for byte); the agent still gets the notice.
  const sessionId = randomUUID();
  const line = `Layout ${randomUUID()}`;
  const storePath = rawStoreFile(JSON.stringify(storeObject(sessionId, line)));
  const before = readFileSync(storePath);

  const result = await runHook({ sessionId, storePath });

  assert.ok(injectedContext(result).includes(line), 'the notice still reaches the agent');
  assert.equal(result.json.systemMessage, NOT_CLEARED + line);
  assert.deepEqual(readFileSync(storePath), before, 'the store is unchanged');
});

test('should give the normal relayed message for a store in the built-in layout', async () => {
  // User behaviour: when clearing works, the user sees only the usual short confirmation.
  // Business rule: a store in the built-in's exact layout gives the normal message.
  const sessionId = randomUUID();
  const line = `Canonical ${randomUUID()}`;
  const storePath = writeBuiltinStore(tempDir(), storeObject(sessionId, line));

  const result = await runHook({ sessionId, storePath });

  injectedContext(result);
  assert.equal(result.json.systemMessage, '✓ heads-up relayed to the agent: ' + line);
});

test('should give the normal relayed message with HEADS_UP_CLEAR=off whatever the layout', async () => {
  // User behaviour: a user who turned clearing off is not told that clearing failed.
  // Business rule: with HEADS_UP_CLEAR=off, the layout is not reported; the normal message is shown.
  const sessionId = randomUUID();
  const line = `Clear off ${randomUUID()}`;
  const storePath = rawStoreFile(JSON.stringify(storeObject(sessionId, line)));

  const result = await runHook({ sessionId, storePath, env: { HEADS_UP_CLEAR: 'off' } });

  injectedContext(result);
  assert.equal(result.json.systemMessage, '✓ heads-up relayed to the agent: ' + line);
});

/** The relayed message with a "not cleared" note giving `reason`. */
const notCleared = (reason, line) =>
  `✓ heads-up relayed to the agent (not cleared: ${reason}; dismiss it yourself): ${line}`;

test('should tell the user when the notice file is a symlink, which is never cleared', async (t) => {
  // User behaviour: a user whose notice file is a link learns that heads-ups are not cleared for them.
  // Business rule: a symlinked store is never rewritten, so the message says why; the file behind it is unchanged.
  if (process.platform === 'win32') {
    t.skip('POSIX symlinks only');
    return;
  }
  const sessionId = randomUUID();
  const line = `Symlink note ${randomUUID()}`;
  const target = storeFile([entry(sessionId, offerView(line))]);
  const link = join(tempDir(), 'store.json');
  symlinkSync(target, link);
  const before = readFileSync(target);

  const result = await runHook({ sessionId, storePath: link });

  assert.ok(injectedContext(result).includes(line), 'the notice still reaches the agent');
  assert.equal(result.json.systemMessage, notCleared("Claude Code's notice file is a symlink", line));
  assert.deepEqual(readFileSync(target), before, 'the file behind the link is unchanged');
});

/** A marked state dir whose saved log is over 2 MB and cannot be rotated (heads-up.log.1 is a dir). */
function fullLogStateDir() {
  const stateDir = markStateDir(tempDir());
  writeFileSync(join(stateDir, 'heads-up.log'), 'x'.repeat(2 * 1024 * 1024) + '\n', { mode: 0o600 });
  mkdirSync(join(stateDir, 'heads-up.log.1'));
  return stateDir;
}

test('should tell the user when the saved log is full, which stops clearing', async () => {
  // User behaviour: a user whose saved log can no longer grow learns that heads-ups are not cleared, and where to
  // read why.
  // Business rule: with a saved log already over 2 MB (one that could not be rotated), the message says the log is
  // full; the notice is relayed but not cleared.
  const stateDir = fullLogStateDir();
  const log = join(stateDir, 'heads-up.log');
  const logSize = statSync(log).size;
  const sessionId = randomUUID();
  const line = `Log full ${randomUUID()}`;
  const storePath = storeFile([entry(sessionId, offerView(line))]);
  const before = readFileSync(storePath);

  const result = await runHook({ sessionId, storePath, stateDir });

  assert.ok(injectedContext(result).includes(line), 'the notice still reaches the agent');
  assert.equal(result.json.systemMessage, notCleared('the saved log is full (see README, Saved log)', line));
  assert.deepEqual(readFileSync(storePath), before, 'the notice is not cleared');
  assert.equal(statSync(log).size, logSize, 'nothing is appended to the full log');
});

test('should not call a large log full when it can still be rotated', async () => {
  // User behaviour: the user is only told the saved log is full when it really stops heads-ups being cleared.
  // Business rule: a log over 2 MB that can be rotated (nothing blocks heads-up.log.1) gives the normal message;
  // it is rotated, the new entry saved, and the notice cleared.
  const stateDir = markStateDir(tempDir());
  const old = 'x'.repeat(2 * 1024 * 1024 + 10) + '\n';
  writeFileSync(join(stateDir, 'heads-up.log'), old, { mode: 0o600 });
  const sessionId = randomUUID();
  const line = `Rotatable ${randomUUID()}`;
  const storePath = storeFile([entry(sessionId, offerView(line))]);

  const result = await runHook({ sessionId, storePath, stateDir });

  injectedContext(result);
  assert.equal(result.json.systemMessage, '✓ heads-up relayed to the agent: ' + line);
  assert.equal('view' in entryOf(readStoreFile(storePath), sessionId), false, 'the notice is cleared');
  assert.equal(readFileSync(join(stateDir, 'heads-up.log.1'), 'utf8'), old, 'the old log is rotated');
  assert.ok(readFileSync(join(stateDir, 'heads-up.log'), 'utf8').includes(line), 'the new entry is saved');
});

for (const [kind, plant] of [
  ['a symlink', (log) => symlinkSync(writeVictim(), log)],
  ['a hard link', (log) => linkSync(writeVictim(), log)],
  ['a directory', (log) => mkdirSync(log)],
]) {
  test(`should tell the user when the saved log is ${kind}, which stops clearing`, async (t) => {
    // User behaviour: a user whose saved log can never be written learns that heads-ups are not cleared, and where
    // to read why.
    // Business rule: a heads-up.log that is not a plain file (a symlink, a hard link, a dir) gives the "not a plain
    // file" reason; the notice is relayed but not cleared.
    if (process.platform === 'win32' && kind !== 'a directory') {
      t.skip('POSIX links only');
      return;
    }
    const stateDir = markStateDir(tempDir());
    plant(join(stateDir, 'heads-up.log'));
    const sessionId = randomUUID();
    const line = `Not plain ${randomUUID()}`;
    const storePath = storeFile([entry(sessionId, offerView(line))]);
    const before = readFileSync(storePath);

    const result = await runHook({ sessionId, storePath, stateDir });

    assert.ok(injectedContext(result).includes(line), 'the notice still reaches the agent');
    const reason = 'the saved log is not a plain file (see README, Saved log)';
    assert.equal(result.json.systemMessage, notCleared(reason, line));
    assert.deepEqual(readFileSync(storePath), before, 'the notice is not cleared');
  });
}

/** A file outside the state dir that a planted link points at; returns its path. */
function writeVictim() {
  const path = join(tempDir(), 'victim.txt');
  writeFileSync(path, 'precious\n');
  return path;
}

test('should give the layout reason first when several reasons apply', async (t) => {
  // User behaviour: the user is told the most fundamental reason the heads-up was not cleared.
  // Business rule: layout wins over symlink, which wins over a full log.
  if (process.platform === 'win32') {
    t.skip('POSIX symlinks only');
    return;
  }
  const sessionId = randomUUID();
  const line = `Several ${randomUUID()}`;
  const compactTarget = rawStoreFile(JSON.stringify(storeObject(sessionId, line)));
  const compactLink = join(tempDir(), 'store.json');
  symlinkSync(compactTarget, compactLink);
  const canonicalLink = join(tempDir(), 'store.json');
  symlinkSync(writeBuiltinStore(tempDir(), storeObject(sessionId, line)), canonicalLink);

  // Each run has its own full log, so all three reasons (or the last two) apply at once.
  const layout = await runHook({ sessionId, storePath: compactLink, stateDir: fullLogStateDir() });
  const symlink = await runHook({ sessionId, storePath: canonicalLink, stateDir: fullLogStateDir() });

  assert.equal(layout.json.systemMessage, notCleared("Claude Code's notice file changed", line), 'layout first');
  assert.equal(symlink.json.systemMessage, notCleared("Claude Code's notice file is a symlink", line), 'then symlink');
});
