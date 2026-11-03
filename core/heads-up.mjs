import { readFileSync, mkdirSync, openSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

// Frames the notice as a claim to verify, keeps normal approval rules, and asks for a report to the user.
const INSTRUCTION =
  'Check whether it is true. If it needs action, act while keeping your normal approval rules, ' +
  'then tell the user what you found and did, and say what they still need to do.';

// Ids become path segments, so only plain ids are accepted.
const PLAIN_ID = /^[A-Za-z0-9_-]{1,128}$/;

// The only events whose additionalContext reaches the agent; others must not claim a notice.
const ANSWERED_EVENTS = ['UserPromptSubmit', 'PostToolUse'];

const input = JSON.parse(readFileSync(0, 'utf8'));
if (!ANSWERED_EVENTS.includes(input.hook_event_name)) process.exit(0);
if (!PLAIN_ID.test(input.session_id)) process.exit(0);

const store = JSON.parse(readFileSync(process.env.HEADS_UP_STORE, 'utf8'));
const view = store.sessions.find((s) => s.id === input.session_id)?.view;

if (view) {
  const sessionDir = join(process.env.HEADS_UP_STATE_DIR, input.session_id);
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const marker = createHash('sha256').update(view.line).digest('hex').slice(0, 16);
  // Creating the marker is the claim: 'wx' fails with EEXIST if this notice was already handled.
  try {
    openSync(join(sessionDir, marker), 'wx', 0o600);
  } catch (err) {
    if (err.code === 'EEXIST') process.exit(0);
    throw err;
  }
  const additionalContext = `${view.line}\n${view.explanation}\n${INSTRUCTION}`;
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext } }),
  );
}
