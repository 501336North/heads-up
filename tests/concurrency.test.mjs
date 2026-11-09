// Concurrency: when two installs (standalone + OSS copy) both run the hook, the notice is still injected once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hookScript, markStateDir, runHook, storeWithView, tempDir, writeStore } from './helpers.mjs';

const view = { line: 'The build cache is stale', explanation: 'Rebuild before testing.' };

/** Start `copies` hook runs at the same moment against one store and one state dir; return how many injected. */
async function injectedCount(copies, script) {
  const sessionId = randomUUID();
  const storePath = writeStore(tempDir(), storeWithView(sessionId, view));
  // Already marked as heads-up state, so the copies race only on the claim, not on first adopting the dir
  // (an unmarked dir another copy has just written to is refused, which would silence a copy before its claim).
  const stateDir = markStateDir(tempDir());
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

// A broken copy that waits this long at the barrier (see nonAtomicCopy) gives up and writes anyway, so it can
// never hang the suite.
const BARRIER_CAP_MS = 10_000;

/**
 * A copy of the real script, in a temp dir, whose claim is a non-atomic exists-then-write.
 * A barrier between the check and the write (in this copy only) makes the race certain without any timing
 * assumption: each copy that passes the check drops its own file in a barrier dir shared by this call's copies,
 * then waits until at least 2 copies have arrived before it writes. So the first two copies to pass the check
 * both pass it before either writes, and both inject, however late either one starts. A copy that arrives after
 * a marker exists fails the check, which is fine: the test only needs more than one injection.
 * BARRIER_CAP_MS bounds the wait; it is never reached in a correct run, since no copy writes before a second
 * one has passed the check.
 */
function nonAtomicCopy() {
  // The claim opens the marker by a name relative to the verified session dir (the process cwd).
  const atomicClaim = "closeSync(openSync(name, 'wx', 0o600));";
  const source = readFileSync(hookScript, 'utf8');
  assert.ok(source.includes(atomicClaim), 'the real script still claims with an atomic wx open');
  const barrier = JSON.stringify(tempDir('heads-up-barrier-'));
  // closeSync, openSync, readdirSync and join are already imported by the real script; importing them again
  // would make the copy a SyntaxError.
  const broken = source.replace(
    atomicClaim,
    "if (existsSync(name)) throw new Error('claimed');" +
      ` closeSync(openSync(join(${barrier}, 'arrived-' + process.pid), 'w'));` +
      ` const until = Date.now() + ${BARRIER_CAP_MS};` +
      ` while (readdirSync(${barrier}).length < 2 && Date.now() < until)` +
      ' Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);' +
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
