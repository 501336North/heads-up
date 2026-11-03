// Contract check against the REAL Claude Code notice store (US-008). Read-only toward ~/.claude:
// the real store is only read; all state goes to temp dirs. Skipped at runtime where no real store exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hookScript, tempDir } from './helpers.mjs';

const STORE_PREFIX = 'cc-plugin-you-should-know_builtin-';

/** The newest real store file under the real home, or undefined. Read-only. */
function realStorePath() {
  const dir = join(homedir(), '.claude', 'plugins', 'store');
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  return names
    .filter((name) => name.startsWith(STORE_PREFIX) && name.endsWith('.json'))
    .map((name) => ({ path: join(dir, name), mtimeMs: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.path;
}

/** Spawn `node args` with `stdin` (or keep stdin open when null); resolve { code, stdout, ms }. Kills after 5 s. */
function run(args, { env = process.env, stdin = '' } = {}) {
  const started = process.hrtime.bigint();
  const child = spawn(process.execPath, args, { env, cwd: tempDir(), stdio: ['pipe', 'pipe', 'pipe'] });
  const killer = setTimeout(() => child.kill('SIGKILL'), 5000);
  let stdout = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stdin.on('error', () => {});
  if (stdin !== null) child.stdin.end(stdin);
  return new Promise((resolve) => {
    child.on('close', (code, signal) => {
      clearTimeout(killer);
      if (stdin === null) child.stdin.destroy();
      resolve({ code, signal, stdout, ms: Number(process.hrtime.bigint() - started) / 1e6 });
    });
  });
}

test('importing the core module does not run the hook', async () => {
  // Business rule: the shape check can be imported by tools (this contract check) without the module
  // reading stdin or printing anything. stdin is left open: if main ran on import, it would block and be killed.
  const code =
    `const m = await import(${JSON.stringify(pathToFileURL(hookScript).href)});` +
    `process.stdout.write(typeof m.isExpectedShape);`;

  const result = await run(['--input-type=module', '-e', code], { stdin: null });

  assert.equal(result.signal, null, 'import finished without waiting on stdin');
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'function');
});

test('should pass the shape check on the real store when one exists', async (t) => {
  // User behaviour: before shipping, the developer learns whether Claude Code's real store still has the shape
  // the plugin expects, instead of users discovering it as a "heads-ups are off" warning.
  // Business rule: the real store must satisfy isExpectedShape.
  const storePath = realStorePath();
  if (!storePath) {
    t.skip('no real notice store on this machine');
    return;
  }
  // Imported in a child process (stdin left open, killed after 5 s), so a broken import guard fails, not hangs.
  const code =
    `const { isExpectedShape } = await import(${JSON.stringify(pathToFileURL(hookScript).href)});` +
    `const { readFileSync } = await import('node:fs');` +
    `process.stdout.write(String(isExpectedShape(JSON.parse(readFileSync(${JSON.stringify(storePath)}, 'utf8')))));`;

  const result = await run(['--input-type=module', '-e', code], { stdin: null });

  assert.equal(result.signal, null, 'import finished without waiting on stdin');
  assert.equal(result.stdout, 'true', `shape of ${storePath}`);
});

test('should finish a run in under 100 ms (median of 10) on the real store', async (t) => {
  // User behaviour: the hook runs after every tool call, so it must not slow the session down noticeably.
  // Business rule: a run against the real store takes under 100 ms (median of 10; generous to avoid flakiness).
  // Timing is only meaningful without other test files spawning processes in parallel, so it runs only under
  // `npm run contract` (one file, --test-concurrency=1).
  if (process.env.HEADS_UP_CONTRACT !== '1') {
    t.skip('speed check runs only under npm run contract');
    return;
  }
  const storePath = realStorePath();
  if (!storePath) {
    t.skip('no real notice store on this machine');
    return;
  }
  const env = {
    ...process.env,
    HOME: tempDir('heads-up-home-'),
    HEADS_UP_STORE: storePath,
    HEADS_UP_STATE_DIR: tempDir(),
  };
  delete env.HEADS_UP;

  const times = [];
  for (let i = 0; i < 10; i++) {
    // A random session id has no view in the real store, so nothing is claimed.
    const stdin = JSON.stringify({
      session_id: randomUUID(),
      transcript_path: `/x/${randomUUID()}.jsonl`,
      hook_event_name: 'PostToolUse',
    });
    const result = await run([hookScript], { env, stdin });
    assert.equal(result.code, 0);
    times.push(result.ms);
  }
  times.sort((a, b) => a - b);
  const median = (times[4] + times[5]) / 2;
  t.diagnostic(`median ${median.toFixed(1)} ms; runs ${times.map((ms) => ms.toFixed(0)).join(', ')} ms`);

  assert.ok(median < 100, `median ${median.toFixed(1)} ms is under 100 ms`);
});
