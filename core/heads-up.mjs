import { readFileSync, mkdirSync, openSync, readdirSync, statSync, lstatSync, unlinkSync, rmdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Frames the notice as a claim to verify, keeps normal approval rules, and asks for a report to the user.
const INSTRUCTION =
  'Check whether it is true. If it needs action, act while keeping your normal approval rules, ' +
  'then tell the user what you found and did, and say what they still need to do.';

// Label used when Claude Code's entry carries no tag (DESIGN A3).
const DEFAULT_TAG = 'Heads up';

// Ids become path segments, so only plain ids are accepted.
const PLAIN_ID = /^[A-Za-z0-9_-]{1,128}$/;

// The only events whose additionalContext reaches the agent; others must not claim a notice.
const ANSWERED_EVENTS = ['UserPromptSubmit', 'PostToolUse'];

const isString = (v) => typeof v === 'string';
const isOptionalString = (v) => v === undefined || isString(v);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function isExpectedShape(store) {
  return (
    isObject(store) &&
    Array.isArray(store.sessions) &&
    store.sessions.every(
      (e) =>
        isObject(e) &&
        isString(e.id) &&
        isOptionalString(e.tag) &&
        (e.view === undefined ||
          (isObject(e.view) && isString(e.view.line) && isOptionalString(e.view.explanation))),
    )
  );
}

function pluginVersion() {
  try {
    const path = join(dirname(fileURLToPath(import.meta.url)), '..', '.claude-plugin', 'plugin.json');
    return JSON.parse(readFileSync(path, 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

// Claude Code's notice store: ~/.claude/plugins/store/cc-plugin-you-should-know_builtin-*.json (AC-003.3).
const STORE_PREFIX = 'cc-plugin-you-should-know_builtin-';

/** HEADS_UP_STORE when set and non-empty; else the newest matching store file; undefined when none match. */
function storePath() {
  if (process.env.HEADS_UP_STORE) return process.env.HEADS_UP_STORE;
  const dir = join(homedir(), '.claude', 'plugins', 'store');
  return readdirSync(dir)
    .filter((name) => name.startsWith(STORE_PREFIX) && name.endsWith('.json'))
    .map((name) => ({ path: join(dir, name), mtimeMs: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.path;
}

/** HEADS_UP_STATE_DIR when set and non-empty; else ~/.claude/heads-up. Always absolute, never cwd-relative. */
function stateDir() {
  return process.env.HEADS_UP_STATE_DIR || join(homedir(), '.claude', 'heads-up');
}

/**
 * Claim a one-time marker under <state>/<key>/ (key is an already-validated id).
 * 'wx' throws EEXIST when it was claimed before; the top-level catch turns that into a silent exit.
 */
function claim(key, name) {
  const dir = join(stateDir(), key);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  openSync(join(dir, name), 'wx', 0o600);
  try {
    prune();
  } catch {
    // A failed prune never costs the user a heads-up.
  }
}

// Handled state older than this is deleted (AC-006.1).
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Delete marker files older than PRUNE_AFTER_MS in <state>/<session>/, then delete a session dir this pass
 * emptied. Only real files and dirs inside the state dir are touched: lstat (never follow symlinks), unlink
 * (files only), rmdir (empty dirs only, never recursive). A session dir that was already empty is kept, since
 * another run may be about to claim in it. Every error is ignored.
 */
function prune() {
  const cutoff = Date.now() - PRUNE_AFTER_MS;
  const root = stateDir();
  for (const session of readdirSync(root)) {
    try {
      const sessionDir = join(root, session);
      if (!lstatSync(sessionDir).isDirectory()) continue;
      let removed = false;
      for (const name of readdirSync(sessionDir)) {
        const path = join(sessionDir, name);
        const stat = lstatSync(path);
        if (stat.isFile() && stat.mtimeMs < cutoff) {
          unlinkSync(path);
          removed = true;
        }
      }
      if (removed && readdirSync(sessionDir).length === 0) rmdirSync(sessionDir);
    } catch {
      // Skip this entry; keep pruning the others.
    }
  }
}

/** The text to give the agent for this hook run, or undefined for nothing. */
function contextFor(input) {
  if (!ANSWERED_EVENTS.includes(input.hook_event_name)) return undefined;
  if (!PLAIN_ID.test(input.session_id)) return undefined;

  const path = storePath();
  if (!path) return undefined;
  const store = JSON.parse(readFileSync(path, 'utf8'));
  if (!isExpectedShape(store)) {
    // Warn once per session that Claude Code changed the store and heads-ups are off (AC-003.2).
    claim(input.session_id, '.shape-warned');
    return (
      `${DEFAULT_TAG}: the heads-up store format changed, so heads-ups are off for now ` +
      `(heads-up plugin version ${pluginVersion()}). Tell the user.`
    );
  }

  // A resumed session keeps its original id in the transcript file name (DESIGN A1).
  // A missing or non-string transcript_path simply adds no candidate.
  const transcriptIds = typeof input.transcript_path === 'string' ? [basename(input.transcript_path, '.jsonl')] : [];
  const ids = [input.session_id, ...transcriptIds].filter((id) => PLAIN_ID.test(id));
  const entry = store.sessions.find((s) => ids.includes(s.id) && s.view);
  if (!entry) return undefined;

  const { view } = entry;
  // Keyed on the matched entry's id, so the notice is handled once whichever id the run arrives under.
  claim(entry.id, createHash('sha256').update(view.line).digest('hex').slice(0, 16));
  // Label first, then the optional explanation, then the check-act-report instruction.
  return [`${entry.tag ?? DEFAULT_TAG}: ${view.line}`, view.explanation, INSTRUCTION].filter(Boolean).join('\n');
}

try {
  // Off switch (AC-005.1), checked before reading stdin or any file. Exactly "off", any case; nothing else.
  if (process.env.HEADS_UP?.trim().toLowerCase() === 'off') process.exit(0);
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const additionalContext = contextFor(input);
  if (additionalContext) {
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext } }),
    );
  }
} catch {
  // Never break a session: any failure means "no notice", exit 0, nothing on stdout or stderr.
  process.exitCode = 0;
}
