import { readFileSync, mkdirSync, openSync } from 'node:fs';
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

/**
 * Claim a one-time marker under <state>/<key>/ (key is an already-validated id).
 * 'wx' throws EEXIST when it was claimed before; the top-level catch turns that into a silent exit.
 */
function claim(key, name) {
  const dir = join(process.env.HEADS_UP_STATE_DIR, key);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  openSync(join(dir, name), 'wx', 0o600);
}

/** The text to give the agent for this hook run, or undefined for nothing. */
function contextFor(input) {
  if (!ANSWERED_EVENTS.includes(input.hook_event_name)) return undefined;
  if (!PLAIN_ID.test(input.session_id)) return undefined;

  const store = JSON.parse(readFileSync(process.env.HEADS_UP_STORE, 'utf8'));
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
