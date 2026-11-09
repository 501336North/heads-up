// Test helpers: run the real hook script as a separate process, the way Claude Code does.
// Every run gets fresh temp dirs under os.tmpdir(); the real ~/.claude is never touched.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root (the plugin dir). */
export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
/** The real hook script; runHook's `script` option can point at another copy. */
export const hookScript = join(repoRoot, 'core', 'heads-up.mjs');

/**
 * The test process's env minus HEADS_UP and HEADS_UP_CLEAR, so a developer's exported switch never changes what a
 * test sees.
 */
export function inheritedEnv() {
  const { HEADS_UP: _ignored, HEADS_UP_CLEAR: _ignoredClear, ...env } = process.env;
  return env;
}

/** A fresh, unique temp directory. */
export function tempDir(prefix = 'heads-up-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

const DAY_S = 24 * 60 * 60;

/** Create a file (or dir when `dir: true`) at `path` with an mtime `ageDays` days ago. */
export function aged(path, ageDays, { dir = false } = {}) {
  if (dir) mkdirSync(path, { recursive: true });
  else writeFileSync(path, '');
  const t = Math.floor(Date.now() / 1000) - ageDays * DAY_S;
  utimesSync(path, t, t);
  return path;
}

/** The file that marks a dir as the plugin's own state root (see core/heads-up.mjs). */
export const STATE_SENTINEL = '.heads-up-state';

/**
 * Mark `dir` as a heads-up state root, as a run that created or adopted it would, so a test can fill it with
 * state before the first run. Returns `dir`.
 */
export function markStateDir(dir) {
  writeFileSync(join(dir, STATE_SENTINEL), '', { mode: 0o600 });
  return dir;
}

/** Write a notice store file into `dir` and return its path. */
export function writeStore(dir, obj) {
  const path = join(dir, 'store.json');
  writeFileSync(path, JSON.stringify(obj));
  return path;
}

/**
 * Write a notice store file into `dir` exactly as the built-in writes it (2-space JSON, trailing newline, mode
 * 0600) and return its path. Only a store in this canonical form is ever cleared.
 */
export function writeBuiltinStore(dir, obj) {
  const path = join(dir, 'store.json');
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  return path;
}

/** A store with one session entry carrying a view. */
export function storeWithView(id, view, { tag = 'Heads up', seen = [] } = {}) {
  return { sessions: [{ id, tag, view }], seen };
}

/** Assert the run exited 0 and printed nothing. */
export function assertNothingShown(result) {
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');
}

/** Assert the run exited 0 with hook JSON on stdout, and return the context it gives the agent. */
export function injectedContext(result) {
  assert.equal(result.code, 0);
  assert.ok(result.json, `expected hook JSON on stdout, got: ${JSON.stringify(result.stdout)}`);
  return result.json.hookSpecificOutput.additionalContext;
}

/**
 * Run the hook once.
 * - `store`: object written to a fresh store file (omit and pass `storePath` to point at a file directly).
 * - `stateDir`: pass the same value across runs to share handled markers; fresh temp dir otherwise.
 * - `script`: path of the hook script to run; defaults to the real core/heads-up.mjs.
 * - `cwd`: working dir of the hook process; defaults to the repo root.
 * - `env`: extra env for the hook; the caller's HEADS_UP is never inherited, only set here.
 * - `timeout`: ms after which the hook process is killed (code is then null); none by default.
 * - `stdin`: raw stdin string; defaults to hook JSON built from event/sessionId/transcriptPath.
 * Resolves to { code, stdout, stderr, json } where json is the parsed stdout or null.
 */
export function runHook({
  event = 'PostToolUse',
  sessionId,
  transcriptPath,
  store,
  storePath,
  stateDir = tempDir(),
  env = {},
  stdin,
  script = hookScript,
  cwd = repoRoot,
  timeout,
} = {}) {
  const resolvedStorePath = storePath ?? writeStore(tempDir(), store ?? { sessions: [], seen: [] });
  const input =
    stdin ??
    JSON.stringify({
      session_id: sessionId,
      transcript_path: transcriptPath ?? `/x/${sessionId}.jsonl`,
      hook_event_name: event,
      cwd: repoRoot,
    });

  const child = spawn(process.execPath, [script], {
    cwd,
    env: {
      ...inheritedEnv(),
      HOME: tempDir('heads-up-home-'),
      HEADS_UP_STORE: resolvedStorePath,
      HEADS_UP_STATE_DIR: stateDir,
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout,
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  child.stdin.on('error', () => {}); // script may exit before reading stdin
  child.stdin.end(input);

  return new Promise((resolve) => {
    child.on('close', (code) => {
      let json = null;
      try {
        json = stdout.trim() ? JSON.parse(stdout) : null;
      } catch {
        json = null;
      }
      resolve({ code, stdout, stderr, json });
    });
  });
}

/**
 * Run the hook with its stdout pipe already closed by the reader, so its write fails with EPIPE.
 * Deterministic: the parent closes its read end and waits for that close before sending stdin, and the hook
 * does not write before it has read all of stdin. (A closed fd 1 would not do: Node reopens it on /dev/null.)
 */
export async function runWithClosedStdout({ sessionId, storePath, stateDir }) {
  const child = spawn(process.execPath, [hookScript], {
    cwd: repoRoot,
    env: {
      ...inheritedEnv(),
      HOME: tempDir('heads-up-home-'),
      HEADS_UP_STORE: storePath,
      HEADS_UP_STATE_DIR: stateDir,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  child.stdin.on('error', () => {});
  await new Promise((resolve) => {
    child.stdout.on('close', resolve);
    child.stdout.destroy();
  });
  child.stdin.end(
    JSON.stringify({ session_id: sessionId, transcript_path: `/x/${sessionId}.jsonl`, hook_event_name: 'PostToolUse' }),
  );
  const code = await new Promise((resolve) => child.on('close', resolve));
  return { code, stderr };
}
