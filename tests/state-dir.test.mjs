// State dir safety: handled state is only ever kept in a dir the plugin can trust, so a bad setting or a
// planted link can never make it write into, or delete from, a folder of the user's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  aged,
  assertNothingShown,
  injectedContext,
  markStateDir,
  runHook,
  STATE_SENTINEL,
  storeWithView,
  tempDir,
} from './helpers.mjs';

const view = { line: 'The build cache is stale', explanation: 'Rebuild before testing.' };
const OLD_MARKER = 'aaaaaaaaaaaaaaaa';

/** Every path under `dir`, relative to it, sorted; symlinks are listed, not followed. */
function tree(dir) {
  return readdirSync(dir, { recursive: true }).sort();
}

/**
 * A dir holding an old marker-named file in a plain-id subdir: what an unsafe prune would delete. It is marked
 * as a state root, so only the check under test (not the adoption rule) can keep a run out of it.
 */
function seededDir() {
  const dir = markStateDir(tempDir('heads-up-victim-'));
  aged(join(dir, 'old-session'), 400, { dir: true });
  const oldFile = aged(join(dir, 'old-session', OLD_MARKER), 400);
  aged(join(dir, 'old-session'), 400, { dir: true });
  return { dir, oldFile };
}

/** Run the hook for a fresh session that has a view, with `cwd` and extra env. */
function runWith({ cwd, env, stateDir }) {
  const sessionId = randomUUID();
  return runHook({ sessionId, store: storeWithView(sessionId, view), cwd, env, stateDir });
}

/** The run did nothing stateful: silent exit 0, and `dir` is exactly as it was, old file included. */
function assertUntouched(result, { dir, oldFile }, before) {
  assertNothingShown(result);
  assert.equal(result.stderr, '');
  assert.ok(existsSync(oldFile), 'old marker-named file survives');
  assert.deepEqual(tree(dir), before, 'nothing created or deleted');
}

// User behaviour: a relative state setting never scatters state into, or deletes from, whatever folder
// Claude Code happens to run in.
// Business rule: the state root must be an absolute path; otherwise the run does nothing stateful.
test('should do nothing stateful when HEADS_UP_STATE_DIR is relative', async () => {
  const seeded = seededDir();
  const before = tree(seeded.dir);

  const result = await runWith({ cwd: seeded.dir, stateDir: '.' });

  assertUntouched(result, seeded, before);
});

test('should do nothing stateful when HOME is relative and HEADS_UP_STATE_DIR is unset', async () => {
  const seeded = seededDir();
  const relRoot = join(seeded.dir, 'rel-home', '.claude', 'heads-up');
  aged(join(relRoot, 'old-session'), 400, { dir: true });
  const relOld = aged(join(relRoot, 'old-session', OLD_MARKER), 400);
  aged(join(relRoot, 'old-session'), 400, { dir: true });
  const before = tree(seeded.dir);

  const result = await runWith({ cwd: seeded.dir, stateDir: '', env: { HOME: 'rel-home' } });

  assertUntouched(result, seeded, before);
  assert.ok(existsSync(relOld), 'old marker under the relative HOME survives');
});

// User behaviour: a state dir or session dir that is a link to another folder never gets markers written into
// that folder, and the prune never deletes from it.
// Business rule: the state root and the session dir must be real dirs, not symlinks; otherwise the run does
// nothing stateful (no claim, no prune) and exits 0 silently.
test('should do nothing stateful when the state root is a symlink', async () => {
  const victim = seededDir();
  const before = tree(victim.dir);
  const link = join(tempDir(), 'state-link');
  symlinkSync(victim.dir, link);

  const result = await runWith({ stateDir: link });

  assertUntouched(result, victim, before);
});

test('should do nothing stateful when the session dir is a symlink', async () => {
  const victim = seededDir();
  const before = tree(victim.dir);
  const stateDir = tempDir();
  const sessionId = randomUUID();
  symlinkSync(victim.dir, join(stateDir, sessionId));

  const result = await runHook({ sessionId, store: storeWithView(sessionId, view), stateDir });

  assertUntouched(result, victim, before);
});

// User behaviour: other local users cannot read which heads-ups were handled, even when the state dir was
// created earlier with looser permissions.
// Business rule: the state root and the session dir are tightened to 0700 before use.
test('should tighten a 0755 state root and session dir to 0700', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX modes only');
    return;
  }
  const stateDir = markStateDir(tempDir());
  const sessionId = randomUUID();
  const sessionDir = join(stateDir, sessionId);
  mkdirSync(sessionDir);
  chmodSync(stateDir, 0o755);
  chmodSync(sessionDir, 0o755);

  const result = await runHook({ sessionId, store: storeWithView(sessionId, view), stateDir });

  assert.ok(injectedContext(result).includes(view.line), 'the notice is still injected');
  assert.equal(statSync(stateDir).mode & 0o777, 0o700, 'state root tightened');
  assert.equal(statSync(sessionDir).mode & 0o777, 0o700, 'session dir tightened');
});

// User behaviour: a state setting that names a link to another folder with a trailing "/" or "/." still never
// gets markers written into, permissions changed on, or files deleted from that folder.
// Business rule: the state root is resolved (trailing "/" and "/." dropped) before the symlink check.
for (const suffix of ['/', '/.']) {
  test(`should do nothing stateful for a symlinked state root with a trailing ${JSON.stringify(suffix)}`, async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX symlinks and modes only');
      return;
    }
    const victim = seededDir();
    chmodSync(victim.dir, 0o755);
    const before = tree(victim.dir);
    const link = join(tempDir(), 'state-link');
    symlinkSync(victim.dir, link);

    const result = await runWith({ stateDir: link + suffix });

    assertUntouched(result, victim, before);
    assert.equal(statSync(victim.dir).mode & 0o777, 0o755, 'the folder behind the link keeps its mode');
  });
}

// User behaviour: pointing HEADS_UP_STATE_DIR at the wrong folder (HOME, a shared dir) never changes its
// permissions or deletes anything in it.
// Business rule: a HEADS_UP_STATE_DIR root is adopted only when this run creates it, when it is empty (a .DS_Store
// aside), or when it holds the
// plugin's ".heads-up-state" file; otherwise the run does nothing stateful (no chmod, no claim, no prune) and
// exits 0 silently.
test('should do nothing stateful in an existing non-empty dir that is not marked as heads-up state', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX modes only');
    return;
  }
  const dir = tempDir('heads-up-shared-');
  aged(join(dir, 'old-session'), 400, { dir: true });
  const oldFile = aged(join(dir, 'old-session', OLD_MARKER), 400);
  aged(join(dir, 'old-session'), 400, { dir: true });
  chmodSync(dir, 0o755);
  const before = tree(dir);

  const result = await runWith({ stateDir: dir });

  assertUntouched(result, { dir, oldFile }, before);
  assert.equal(statSync(dir).mode & 0o777, 0o755, 'mode unchanged');
});

test('should adopt an existing empty dir as the state root and mark it', async () => {
  const stateDir = tempDir();

  const result = await runWith({ stateDir });

  assert.ok(injectedContext(result).includes(view.line), 'the notice is delivered');
  const sentinel = lstatSync(join(stateDir, STATE_SENTINEL));
  assert.ok(sentinel.isFile(), 'the state root is marked with a regular file');
  if (process.platform !== 'win32') assert.equal(sentinel.mode & 0o777, 0o600, 'the mark is 0600');
});

// User behaviour: a Finder-opened state folder, which gains a ".DS_Store", still works as an empty one.
// Business rule: the emptiness check for a HEADS_UP_STATE_DIR ignores a ".DS_Store" file.
test('should adopt an existing dir holding only .DS_Store as the state root and mark it', async () => {
  const stateDir = tempDir();
  writeFileSync(join(stateDir, '.DS_Store'), 'finder');

  const result = await runWith({ stateDir });

  assert.ok(injectedContext(result).includes(view.line), 'the notice is delivered');
  assert.ok(lstatSync(join(stateDir, STATE_SENTINEL)).isFile(), 'the state root is marked');
});

// User behaviour: heads-ups keep working after an upgrade, even when an earlier build left state in the
// plugin's default folder without the mark; they never go silently off for good.
// Business rule: the default root ~/.claude/heads-up (no HEADS_UP_STATE_DIR) is the plugin's own namespace and
// is always adopted and marked; the symlink, owner and same-dir checks still apply.
test('should adopt an existing non-empty unmarked default state root and mark it', async () => {
  const home = tempDir('heads-up-home-');
  const root = join(home, '.claude', 'heads-up');
  mkdirSync(join(root, 's0'), { recursive: true });
  writeFileSync(join(root, 's0', '0123456789abcdef'), '');

  const result = await runWith({ stateDir: '', env: { HOME: home } });

  assert.ok(injectedContext(result).includes(view.line), 'the notice is delivered');
  assert.ok(lstatSync(join(root, STATE_SENTINEL)).isFile(), 'the default root is marked');
});

// User behaviour: another local user cannot get this user's runs to keep state in, or delete from, a folder
// that other user owns.
// Business rule: the state root must be owned by the user running the hook; otherwise the run does nothing
// stateful and exits 0 silently.
test("should do nothing stateful when the state root is owned by another user", async (t) => {
  if (process.getuid?.() !== 0) {
    t.skip('owner check needs root to create a dir owned by another user');
    return;
  }
  const victim = seededDir();
  chmodSync(victim.dir, 0o755);
  chownSync(victim.dir, 1, 1);
  const before = tree(victim.dir);

  const result = await runWith({ stateDir: victim.dir });

  assertUntouched(result, victim, before);
  const stat = statSync(victim.dir);
  assert.equal(stat.uid, 1, 'owner unchanged');
  assert.equal(stat.mode & 0o777, 0o755, 'mode unchanged');
});
