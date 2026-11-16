// The store lock the hook takes: a lock left behind by a hook that was killed while holding it must not block
// Claude Code's own notice updates for long.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { takeLock } from '../core/heads-up.mjs';
import { tempDir } from './helpers.mjs';

// Claude Code's store lock (proper-lockfile, default options) treats a lock whose mtime is older than this as stale
// and takes it over.
const BUILTIN_STALE_MS = 10_000;

test('should leave a lock that Claude Code treats as stale within about 3 s if the hook dies holding it', () => {
  // User behaviour: if the hook is killed mid-clear, Claude Code's own heads-up updates are blocked for a few
  // seconds at most, not ten.
  // Business rule: a lock taken by the hook becomes stale by Claude Code's rule at most 3.5 s after it was taken,
  // and not before 2 s, so a normal clear (milliseconds) is never taken over.
  const lock = join(tempDir(), 'store.json.lock');
  const before = Date.now();
  takeLock(lock);
  const after = Date.now();

  const staleAt = lstatSync(lock).mtimeMs + BUILTIN_STALE_MS;

  assert.ok(lstatSync(lock).isDirectory(), 'the lock is a directory, as the built-in expects');
  assert.ok(staleAt <= before + 3_500, `stale within 3.5 s (after ${Math.round(staleAt - before)} ms)`);
  assert.ok(staleAt >= after + 2_000, `not stale before 2 s (after ${Math.round(staleAt - after)} ms)`);
});
