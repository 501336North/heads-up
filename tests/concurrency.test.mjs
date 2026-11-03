// Concurrency: when two installs (standalone + OSS copy) both run the hook, the notice is still injected once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hookScript, runHook, storeWithView, tempDir, writeStore } from './helpers.mjs';

const view = { line: 'The build cache is stale', explanation: 'Rebuild before testing.' };

/** Start `copies` hook runs at the same moment against one store and one state dir; return how many injected. */
async function injectedCount(copies, script) {
  const sessionId = randomUUID();
  const storePath = writeStore(tempDir(), storeWithView(sessionId, view));
  const stateDir = tempDir();
  const results = await Promise.all(
    Array.from({ length: copies }, () => runHook({ sessionId, storePath, stateDir, script })),
  );
  for (const r of results) assert.equal(r.code, 0, `every copy exits 0 (stderr: ${r.stderr})`);
  return results.filter((r) => r.stdout !== '').length;
}

test('should inject exactly once when two copies run at the same moment for the same notice', async () => {
  // User behaviour: with the plugin installed twice, the agent still sees each heads-up only once.
  // Business rule: claiming a notice is atomic, so concurrent runs inject exactly once (ADR-005).
  assert.equal(await injectedCount(2), 1, '2 copies inject once');
  assert.equal(await injectedCount(10), 1, '10 copies inject once');
});

// Pause between check and write in the broken copy (see nonAtomicCopy).
const RACE_WINDOW_MS = 1500;

/**
 * A copy of the real script, in a temp dir, whose claim is a non-atomic exists-then-write.
 * A pause between the check and the write (in this copy only) makes the race certain: every copy
 * started together passes the check before any of them writes. 1500 ms is far above process start-up
 * skew even on a loaded CI runner, so the detection never depends on timing luck.
 */
function nonAtomicCopy() {
  // The claim opens the marker by a name relative to the verified session dir (the process cwd).
  const atomicClaim = "closeSync(openSync(name, 'wx', 0o600));";
  const source = readFileSync(hookScript, 'utf8');
  assert.ok(source.includes(atomicClaim), 'the real script still claims with an atomic wx open');
  const broken = source.replace(
    atomicClaim,
    "if (existsSync(name)) throw new Error('claimed');" +
      ` Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${RACE_WINDOW_MS});` +
      " writeFileSync(name, '', { mode: 0o600 });",
  );
  const path = join(tempDir(), 'heads-up-nonatomic.mjs');
  writeFileSync(path, "import { existsSync, writeFileSync } from 'node:fs';\n" + broken);
  return path;
}

test('the test detects a non-atomic claim', async () => {
  // Proves the exactly-once test above can fail: a check-then-write claim injects more than once.
  assert.ok((await injectedCount(2, nonAtomicCopy())) > 1, 'non-atomic claim with 2 copies injects twice');
  assert.ok((await injectedCount(10, nonAtomicCopy())) > 1, 'non-atomic claim with 10 copies injects more than once');
});
