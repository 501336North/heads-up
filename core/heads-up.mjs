import { readFileSync } from 'node:fs';

// Frames the notice as a claim to verify, keeps normal approval rules, and asks for a report to the user.
const INSTRUCTION =
  'Check whether it is true. If it needs action, act while keeping your normal approval rules, ' +
  'then tell the user what you found and did, and say what they still need to do.';

const input = JSON.parse(readFileSync(0, 'utf8'));
const store = JSON.parse(readFileSync(process.env.HEADS_UP_STORE, 'utf8'));
const view = store.sessions.find((s) => s.id === input.session_id)?.view;

if (view) {
  const additionalContext = `${view.line}\n${view.explanation}\n${INSTRUCTION}`;
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext } }),
  );
}
