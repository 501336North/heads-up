// Store discovery: with no override, the hook finds Claude Code's notice store under ~/.claude.
// HEADS_UP_STORE is set to '' (meaning "unset") and HOME points at a fresh temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, utimesSync, readdirSync, existsSync } from 'node:fs';
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

function runWithHome(home, sessionId) {
  return runHook({ sessionId, env: { HOME: home, HEADS_UP_STORE: '' } });
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
