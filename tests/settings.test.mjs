// Settings and housekeeping: the HEADS_UP=off and HEADS_UP_CLEAR=off switches, and pruning of old handled state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { aged, injectedContext, markStateDir, runHook, storeWithView, tempDir, writeBuiltinStore } from './helpers.mjs';

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

    const store = storeWithView(sessionId, view);

    const result = await runHook({ sessionId, store, stateDir, env: { HEADS_UP: value } });

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

    assert.ok(injectedContext(result).includes(view.line));
  });
}

// --- Clearing switch (v1.1, DESIGN §Behaviour 7) ---

/** A store file holding an unopened ("offer") notice for `sessionId`; returns its path. */
function offerStore(sessionId) {
  return writeBuiltinStore(tempDir(), storeWithView(sessionId, { ...view, kind: 'offer', shownAt: Date.now() }));
}

// User behaviour: a user who wants to dismiss heads-ups themselves can stop the hook clearing them; the agent still
// gets each one and the user is still told.
// Business rule: HEADS_UP_CLEAR=off (any case, surrounding spaces ignored) skips only the clear; the store is
// untouched.
for (const value of ['off', 'OFF', ' Off ']) {
  test(`should relay but not clear when HEADS_UP_CLEAR=${JSON.stringify(value)}`, async () => {
    const sessionId = randomUUID();
    const storePath = offerStore(sessionId);
    const before = readFileSync(storePath);

    const result = await runHook({ sessionId, storePath, env: { HEADS_UP_CLEAR: value } });

    assert.ok(injectedContext(result).includes(view.line), 'the notice still reaches the agent');
    assert.equal(result.json.systemMessage, '✓ heads-up relayed to the agent: ' + view.line, 'the user is told');
    assert.deepEqual(readFileSync(storePath), before, 'the store is unchanged');
    assert.equal(existsSync(storePath + '.lock'), false, 'no lock is left');
  });
}

// User behaviour: any value other than "off" (including typos and empty) keeps clearing on, so a mistyped
// setting never leaves relayed heads-ups stuck on screen.
// Business rule: only "off" is a switch; clearing is on by default.
for (const value of ['on', '0', '']) {
  test(`should clear for any other HEADS_UP_CLEAR value (${JSON.stringify(value)})`, async () => {
    const sessionId = randomUUID();
    const storePath = offerStore(sessionId);

    const result = await runHook({ sessionId, storePath, env: { HEADS_UP_CLEAR: value } });

    injectedContext(result);
    const entry = JSON.parse(readFileSync(storePath, 'utf8')).sessions.find((e) => e.id === sessionId);
    assert.equal('view' in entry, false, 'the relayed notice is cleared');
  });
}

// --- Pruning (AC-006.1) ---

const DAY_S = 24 * 60 * 60;
const nowS = () => Math.floor(Date.now() / 1000);

/** Run the hook once for a fresh, unrelated session that has a view, against `stateDir`. */
function runUnrelated(stateDir) {
  const sessionId = randomUUID();
  return runHook({ sessionId, store: storeWithView(sessionId, view), stateDir });
}

test('should delete markers and session dirs older than 30 days and keep newer ones', async () => {
  // User behaviour: the plugin does not pile up state forever on the user's disk.
  // Business rule: markers older than 30 days are deleted; a session dir is deleted once pruning leaves it
  // empty; newer markers, and a freshly created empty session dir, are kept.
  const stateDir = markStateDir(tempDir());
  const oldDir = join(stateDir, 'old-session');
  const newDir = join(stateDir, 'new-session');
  const mixedDir = join(stateDir, 'mixed-session');
  const freshEmptyDir = join(stateDir, 'fresh-empty-session');
  mkdirSync(oldDir);
  mkdirSync(newDir);
  mkdirSync(mixedDir);
  const oldMarker = aged(join(oldDir, 'aaaaaaaaaaaaaaaa'), 31);
  const newMarker = aged(join(newDir, 'bbbbbbbbbbbbbbbb'), 1);
  const mixedOld = aged(join(mixedDir, 'cccccccccccccccc'), 31);
  const mixedNew = aged(join(mixedDir, 'dddddddddddddddd'), 29);
  aged(oldDir, 31, { dir: true });
  aged(newDir, 1, { dir: true });
  aged(mixedDir, 31, { dir: true });
  aged(freshEmptyDir, 0, { dir: true });

  const result = await runUnrelated(stateDir);

  assert.ok(result.json, 'the unrelated notice is still injected');
  assert.equal(existsSync(oldMarker), false, 'old marker deleted');
  assert.equal(existsSync(oldDir), false, 'session dir left empty by pruning is deleted');
  assert.ok(existsSync(newMarker), 'new marker kept');
  assert.equal(existsSync(mixedOld), false, 'old marker in mixed dir deleted');
  assert.ok(existsSync(mixedNew), 'new marker in mixed dir kept');
  assert.ok(existsSync(freshEmptyDir), 'a fresh empty session dir is kept (another run may be about to claim in it)');
});

test('should never delete anything outside the state dir', async () => {
  // User behaviour: housekeeping can never remove the user's own files.
  // Business rule: pruning touches only real files and dirs inside the state dir and never follows symlinks.
  const parent = tempDir();
  const stateDir = join(parent, 'state');
  mkdirSync(stateDir);
  markStateDir(stateDir);
  const sibling = aged(join(parent, 'sibling-file'), 400);
  const outsideDir = aged(join(tempDir(), 'outside-dir'), 400, { dir: true });
  const outsideFile = aged(join(outsideDir, 'precious'), 400);
  utimesSync(outsideDir, nowS() - 400 * DAY_S, nowS() - 400 * DAY_S);
  const sessionDir = aged(join(stateDir, 'some-session'), 31, { dir: true });
  symlinkSync(outsideFile, join(sessionDir, 'link-to-file'));
  aged(sessionDir, 31, { dir: true });
  symlinkSync(outsideDir, join(stateDir, 'link-to-dir'));

  const result = await runUnrelated(stateDir);

  assert.ok(result.json, 'the unrelated notice is still injected');
  assert.ok(existsSync(sibling), 'file next to the state dir kept');
  assert.ok(existsSync(outsideDir), 'dir reached through a symlink kept');
  assert.ok(existsSync(outsideFile), 'file reached through a symlink kept');
});

test('should prune only marker-named files inside plain-id session dirs', async () => {
  // User behaviour: pointing HEADS_UP_STATE_DIR at a folder that also holds the user's files never deletes them.
  // Business rule: the prune only touches dirs named like a session id, and inside them only old files named
  // like a marker (16 lowercase hex chars, or .shape-warned). Anything else is kept, whatever its age.
  const stateDir = markStateDir(tempDir());
  const topFile = aged(join(stateDir, 'notes.txt'), 400);
  const plainDir = aged(join(stateDir, 'plain-session'), 400, { dir: true });
  const userFile = aged(join(plainDir, 'photo.jpg'), 400);
  const upperHex = aged(join(plainDir, 'CCCCCCCCCCCCCCCC'), 400);
  const hexMarker = aged(join(plainDir, 'aaaaaaaaaaaaaaaa'), 400);
  const warnDir = aged(join(stateDir, 'warn-session'), 400, { dir: true });
  const warnMarker = aged(join(warnDir, '.shape-warned'), 400);
  const otherDir = aged(join(stateDir, 'My Documents'), 400, { dir: true });
  const otherMarker = aged(join(otherDir, 'bbbbbbbbbbbbbbbb'), 400);
  for (const dir of [plainDir, warnDir, otherDir]) aged(dir, 400, { dir: true });

  const result = await runUnrelated(stateDir);

  assert.ok(result.json, 'the unrelated notice is still injected');
  assert.equal(existsSync(hexMarker), false, 'old hex marker in a plain-id dir deleted');
  assert.equal(existsSync(warnMarker), false, 'old .shape-warned marker in a plain-id dir deleted');
  assert.ok(existsSync(topFile), 'old non-marker file at the top of the state dir kept');
  assert.ok(existsSync(userFile), 'old non-marker file in a plain-id dir kept');
  assert.ok(existsSync(upperHex), 'old file that is not exactly a lowercase hex marker kept');
  assert.ok(existsSync(otherMarker), 'old marker-named file in a dir whose name is not a plain id kept');
});

test('should also prune on a run that delivers the changed-shape warning', async () => {
  // User behaviour: housekeeping keeps working even while heads-ups are off because the store format changed.
  // Business rule: every run that delivers something (a notice or the shape warning) prunes after delivering.
  const stateDir = markStateDir(tempDir());
  const oldDir = aged(join(stateDir, 'old-session'), 31, { dir: true });
  const oldMarker = aged(join(oldDir, 'aaaaaaaaaaaaaaaa'), 31);
  aged(oldDir, 31, { dir: true });

  const result = await runHook({ sessionId: randomUUID(), store: { seen: [] }, stateDir });

  assert.ok(injectedContext(result).includes('store format changed'), 'the shape warning is delivered');
  assert.equal(existsSync(oldMarker), false, 'old marker deleted');
});

test('should still inject when pruning fails', async (t) => {
  // User behaviour: a housekeeping problem never costs the user a heads-up.
  // Business rule: prune errors are ignored; the notice is still injected.
  if (process.getuid?.() === 0) {
    t.skip('running as root: chmod 000 does not stop reads');
    return;
  }
  const stateDir = markStateDir(tempDir());
  const locked = aged(join(stateDir, 'locked-session'), 31, { dir: true });
  aged(join(locked, 'eeeeeeeeeeeeeeee'), 31);
  chmodSync(locked, 0o000);
  t.after(() => chmodSync(locked, 0o700));

  const result = await runUnrelated(stateDir);

  assert.equal(result.stderr, '');
  assert.ok(injectedContext(result).includes(view.line));
});
