// Test helpers: run the real hook script as a separate process, the way Claude Code does.
// Every run gets fresh temp dirs under os.tmpdir(); the real ~/.claude is never touched.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
/** The real hook script; runHook's `script` option can point at another copy. */
export const hookScript = join(repoRoot, 'core', 'heads-up.mjs');

/** A fresh, unique temp directory. */
export function tempDir(prefix = 'heads-up-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Write a notice store file into `dir` and return its path. */
export function writeStore(dir, obj) {
  const path = join(dir, 'store.json');
  writeFileSync(path, JSON.stringify(obj));
  return path;
}

/** A store with one session entry carrying a view. */
export function storeWithView(id, view, { tag = 'Heads up', seen = [] } = {}) {
  return { sessions: [{ id, tag, view }], seen };
}

/**
 * Run the hook once.
 * - `store`: object written to a fresh store file (omit and pass `storePath` to point at a file directly).
 * - `stateDir`: pass the same value across runs to share handled markers; fresh temp dir otherwise.
 * - `script`: path of the hook script to run; defaults to the real core/heads-up.mjs.
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
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: tempDir('heads-up-home-'),
      HEADS_UP_STORE: resolvedStorePath,
      HEADS_UP_STATE_DIR: stateDir,
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
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
