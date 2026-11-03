// Store discovery: with no override, the hook finds Claude Code's notice store under ~/.claude.
// HEADS_UP_STORE is set to '' (meaning "unset") and HOME points at a fresh temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, utimesSync, readdirSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { assertNothingShown, injectedContext, runHook, storeWithView, tempDir } from './helpers.mjs';

const view = { line: 'The build cache is stale', explanation: 'Rebuild before testing.' };

/** A temp HOME with ~/.claude/plugins/store/ and the given files (name -> store object), optional mtimes in seconds. */
function homeWithStores(files) {
  const home = tempDir('heads-up-home-');
  const storeDir = join(home, '.claude', 'plugins', 'store');
  mkdirSync(storeDir, { recursive: true });
  for (const [name, { store, mtime }] of Object.entries(files)) {
    const path = join(storeDir, name);
    writeFileSync(path, JSON.stringify(store));
    if (mtime !== undefined) utimesSync(path, mtime, mtime);
  }
  return home;
}

function runWithHome(home, sessionId, { timeout } = {}) {
  return runHook({ sessionId, env: { HOME: home, HEADS_UP_STORE: '' }, timeout });
}

test('should read the only cc-plugin-you-should-know_builtin-*.json in ~/.claude/plugins/store', async () => {
  // User behaviour: installing the plugin needs no configuration; it finds Claude Code's notices by itself.
  // Business rule: the default store is the you-should-know builtin store file under ~/.claude/plugins/store.
  const sessionId = randomUUID();
  const home = homeWithStores({
    'cc-plugin-you-should-know_builtin-abc123.json': { store: storeWithView(sessionId, view) },
  });

  const result = await runWithHome(home, sessionId);

  assert.ok(injectedContext(result).includes(view.line));
});

test('should read the newest by mtime when several match', async () => {
  // User behaviour: after Claude Code rotates its store file, the agent gets the current notice, not a stale one.
  // Business rule: when several store files match, the most recently modified one is used.
  const sessionId = randomUUID();
  const stale = { line: 'An old notice', explanation: 'From an older store file.' };
  const now = Math.floor(Date.now() / 1000);
  const home = homeWithStores({
    'cc-plugin-you-should-know_builtin-aaa.json': { store: storeWithView(sessionId, stale), mtime: now - 3600 },
    'cc-plugin-you-should-know_builtin-bbb.json': { store: storeWithView(sessionId, view), mtime: now },
    'cc-plugin-you-should-know_builtin-ccc.json': { store: storeWithView(sessionId, stale), mtime: now - 7200 },
  });

  const result = await runWithHome(home, sessionId);

  const context = injectedContext(result);
  assert.ok(context.includes(view.line), 'uses the newest store');
  assert.ok(!context.includes(stale.line), 'ignores older stores');
});

test('should print nothing when none match', async () => {
  // User behaviour: other plugins' store files never leak notices into the agent's context.
  // Business rule: only files named cc-plugin-you-should-know_builtin-*.json are read.
  const sessionId = randomUUID();
  const home = homeWithStores({
    'cc-plugin-agents-md_builtin-x.json': { store: storeWithView(sessionId, view) },
    'cc-plugin-you-should-know_builtin-x.json.bak': { store: storeWithView(sessionId, view) },
  });

  const result = await runWithHome(home, sessionId);

  assertNothingShown(result);
});

test('should keep handled state under ~/.claude/heads-up when HEADS_UP_STATE_DIR is unset', async () => {
  // User behaviour: with no configuration, a heads-up is remembered as handled across hook runs.
  // Business rule: the default state dir is ~/.claude/heads-up/, one subdir per session id.
  const sessionId = randomUUID();
  const home = homeWithStores({
    'cc-plugin-you-should-know_builtin-abc123.json': { store: storeWithView(sessionId, view) },
  });

  const result = await runHook({ sessionId, env: { HOME: home, HEADS_UP_STORE: '', HEADS_UP_STATE_DIR: '' } });

  assert.ok(injectedContext(result).includes(view.line));
  const sessionDir = join(home, '.claude', 'heads-up', sessionId);
  assert.ok(existsSync(sessionDir), 'session dir created under ~/.claude/heads-up');
  assert.equal(readdirSync(sessionDir).length, 1, 'one marker written');
});

// --- Unusable store candidates (D1) ---

// Matches the store size limit in core/heads-up.mjs.
const MAX_STORE_BYTES = 5 * 1024 * 1024;
// Far below Claude Code's 5 s hook timeout; a run that blocks on a store is killed here and fails.
const FAST_MS = 2000;
const STORE_DIR = ['.claude', 'plugins', 'store'];

/** Make a FIFO at `path`, or skip the test where mkfifo is unavailable. Returns false when skipped. */
function fifoOrSkip(t, path) {
  try {
    execFileSync('mkfifo', [path]);
    return true;
  } catch {
    t.skip('mkfifo is not available on this platform');
    return false;
  }
}

/** A store file padded with trailing whitespace (still valid JSON) to exactly `bytes` bytes. */
function paddedStore(path, store, bytes) {
  const json = JSON.stringify(store);
  writeFileSync(path, json + ' '.repeat(bytes - Buffer.byteLength(json)));
  return path;
}

// User behaviour: a store path that is not a regular file never stalls every prompt and tool call.
// Business rule: a store candidate is used only when it is a regular file; HEADS_UP_STORE pointing at
// anything else means no store (silent, exit 0).
test('should exit fast and print nothing when HEADS_UP_STORE is a FIFO', async (t) => {
  const fifo = join(tempDir(), 'store.fifo');
  if (!fifoOrSkip(t, fifo)) return;
  const started = Date.now();

  const result = await runHook({ sessionId: randomUUID(), storePath: fifo, timeout: FAST_MS });

  assertNothingShown(result);
  assert.ok(Date.now() - started < FAST_MS, 'finished well under the hook timeout');
});

// Business rule: in the glob, a candidate that is not a regular file is skipped; the newest valid one wins.
test('should skip a FIFO that is the newest glob match and use the older valid store', async (t) => {
  const sessionId = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const home = homeWithStores({
    'cc-plugin-you-should-know_builtin-old.json': { store: storeWithView(sessionId, view), mtime: now - 3600 },
  });
  if (!fifoOrSkip(t, join(home, ...STORE_DIR, 'cc-plugin-you-should-know_builtin-new.json'))) return;
  const started = Date.now();

  const result = await runWithHome(home, sessionId, { timeout: FAST_MS });

  assert.ok(injectedContext(result).includes(view.line), 'injects from the older valid store');
  assert.ok(Date.now() - started < FAST_MS, 'finished well under the hook timeout');
});

// User behaviour: a broken link left in Claude Code's store dir never silently turns heads-ups off.
// Business rule: a glob candidate whose stat throws is skipped.
test('should skip a dangling symlink that matches the glob and use the valid store', async () => {
  const sessionId = randomUUID();
  const home = homeWithStores({
    'cc-plugin-you-should-know_builtin-real.json': { store: storeWithView(sessionId, view) },
  });
  symlinkSync(join(home, 'nowhere.json'), join(home, ...STORE_DIR, 'cc-plugin-you-should-know_builtin-zzz.json'));

  const result = await runWithHome(home, sessionId);

  assert.ok(injectedContext(result).includes(view.line));
});

// User behaviour: a runaway store file never makes every hook run slow to read and parse.
// Business rule: a store larger than MAX_STORE_BYTES (5 MB) is not used; one of exactly 5 MB still is.
test('should print nothing when the store is larger than 5 MB', async () => {
  const sessionId = randomUUID();
  const storePath = paddedStore(join(tempDir(), 'big.json'), storeWithView(sessionId, view), MAX_STORE_BYTES + 1);

  const result = await runHook({ sessionId, storePath });

  assertNothingShown(result);
});

test('should still use a store of exactly 5 MB', async () => {
  const sessionId = randomUUID();
  const storePath = paddedStore(join(tempDir(), 'max.json'), storeWithView(sessionId, view), MAX_STORE_BYTES);

  const result = await runHook({ sessionId, storePath });

  assert.ok(injectedContext(result).includes(view.line));
});

// User behaviour: a relative store setting never makes the hook read notices from whatever folder Claude Code
// happens to run in, where any file named like the store could plant one.
// Business rule: the store path (HEADS_UP_STORE, or the store dir under HOME) must be absolute; otherwise there
// is no store (silent, exit 0).
test('should print nothing when HEADS_UP_STORE is relative, even with a store at that path in the cwd', async () => {
  const sessionId = randomUUID();
  const cwd = tempDir('heads-up-cwd-');
  writeFileSync(join(cwd, 'store.json'), JSON.stringify(storeWithView(sessionId, view)));

  const result = await runHook({ sessionId, cwd, env: { HEADS_UP_STORE: 'store.json' } });

  assertNothingShown(result);
});

test('should print nothing when HOME is relative, even with a store under it in the cwd', async () => {
  const sessionId = randomUUID();
  const cwd = tempDir('heads-up-cwd-');
  const storeDir = join(cwd, 'rel-home', ...STORE_DIR);
  mkdirSync(storeDir, { recursive: true });
  const store = JSON.stringify(storeWithView(sessionId, view));
  writeFileSync(join(storeDir, 'cc-plugin-you-should-know_builtin-x.json'), store);

  const result = await runHook({ sessionId, cwd, env: { HOME: 'rel-home', HEADS_UP_STORE: '' } });

  assertNothingShown(result);
});
