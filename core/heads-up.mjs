import { readFileSync, mkdirSync, openSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, basename } from 'node:path';

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

try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  if (!ANSWERED_EVENTS.includes(input.hook_event_name)) process.exit(0);
  if (!PLAIN_ID.test(input.session_id)) process.exit(0);

  const store = JSON.parse(readFileSync(process.env.HEADS_UP_STORE, 'utf8'));
  // A resumed session keeps its original id in the transcript file name (DESIGN A1).
  const transcriptId = basename(input.transcript_path, '.jsonl');
  const ids = [input.session_id, transcriptId].filter((id) => PLAIN_ID.test(id));
  const entry = store.sessions.find((s) => ids.includes(s.id) && s.view);

  if (entry) {
    const { view } = entry;
    // Keyed on the matched entry's id, so the notice is handled once whichever id the run arrives under.
    const sessionDir = join(process.env.HEADS_UP_STATE_DIR, entry.id);
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    const marker = createHash('sha256').update(view.line).digest('hex').slice(0, 16);
    // Creating the marker is the claim: 'wx' throws EEXIST if this notice was already handled,
    // and the catch below turns that (like any failure) into a silent exit.
    openSync(join(sessionDir, marker), 'wx', 0o600);
    // Label first, then the optional explanation, then the check-act-report instruction.
    const additionalContext = [`${entry.tag ?? DEFAULT_TAG}: ${view.line}`, view.explanation, INSTRUCTION]
      .filter(Boolean)
      .join('\n');
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext } }),
    );
  }
} catch {
  // Never break a session: any failure means "no notice", exit 0, nothing on stdout or stderr.
  process.exit(0);
}
