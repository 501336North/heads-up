# Feature: Proactive Heads-up

## Overview
A Claude Code hook that puts each "Heads up" notice shown in a session into that session's agent context, so the agent
checks it, acts on it if in scope and safe, and reports. Ships as a standalone plugin and as a hash-pinned copy in OSS.
Design: `.oss/dev/active/heads-up/DESIGN.md`.

## Actors
| Actor | Description |
|-------|-------------|
| Developer | Person using Claude Code who sees Heads up notices (Boss, OSS customers, standalone users) |
| Agent | The Claude Code session the notice is about |
| Maintainer | Whoever releases `heads-up` and updates the OSS copy |

## User Stories

### US-001: Agent receives its own heads-ups
**As a** developer **I want** each heads-up shown in my session to reach that session's agent **so that** I don't
have to relay it by hand. **Priority:** Must · **Estimate:** Medium

**AC-001.1: Injected on the next hook run**
- Given the store's entry for session S has a `view` with a line and explanation
- When a `UserPromptSubmit` or `PostToolUse` hook runs in S
- Then the output is hook JSON whose `additionalContext` contains the line, the explanation and the check-act-report instruction

**AC-001.2: Once per session**
- Given that notice was already injected in S
- When the hook runs again in S
- Then nothing is output

**AC-001.3: Both hook events**
- Given the same store
- When the input is `UserPromptSubmit` or `PostToolUse`
- Then each produces the correct `hookSpecificOutput.hookEventName` for that event

### US-002: Sessions don't see each other's heads-ups
**As a** developer with several sessions open **I want** each notice only in the session it is about **so that**
other sessions aren't distracted. **Priority:** Must · **Estimate:** Small

**AC-002.1:** Given S2's entry has a `view` and S1's has none, when the hook runs in S1, then nothing is output.
**AC-002.2:** Given a `seen` line that matches no session's `view`, when the hook runs in any session, then it is not injected.
**AC-002.3:** Given a new session starts while `seen` holds older notices, when the hook runs, then none of them is replayed.
**AC-002.4:** Given a resumed session whose hook `session_id` differs from its `transcript_path` basename, when the
store entry for either id has a `view`, then it is injected.
**AC-002.5:** Given a `view` on an entry tagged "You should know", when the hook runs in that session, then it is
injected the same way, naming the tag.

### US-003: Never breaks a session
**As a** developer **I want** the hook to fail silently **so that** an undocumented file changing never blocks my work.
**Priority:** Must · **Estimate:** Small

**AC-003.1:** Missing store, unreadable store, invalid JSON, or invalid hook input → exit 0, no output.
**AC-003.2:** Store whose shape is unexpected (e.g. `sessions` not an array) → one warning in this session naming the
plugin version, then silence on later runs.
**AC-003.3:** Store file found by glob `cc-plugin-you-should-know_builtin-*.json`; when several match, the newest mtime wins.

### US-004: Exactly once with both copies installed
**As an** OSS customer who also installed the standalone plugin **I want** each notice once **so that** I'm not
told twice. **Priority:** Must · **Estimate:** Small

**AC-004.1:** Given two runs start at the same moment for the same session and notice, then exactly one outputs it.

### US-005: Turn it off
**As an** OSS customer **I want** to turn heads-ups off without uninstalling OSS. **Priority:** Must · **Estimate:** Small

**AC-005.1:** Given `HEADS_UP=off`, when the hook runs with an un-injected notice, then nothing is output.

### US-006: State doesn't grow forever
**As a** developer **I want** old handled files cleaned up. **Priority:** Should · **Estimate:** Small

**AC-006.1:** Given handled files older than 30 days in the state dir, when the hook runs, then they are deleted and
newer ones remain.

### US-007: OSS copy can't drift
**As a** maintainer **I want** OSS CI to fail when the bundled copy differs from the pinned release. **Priority:** Must
· **Estimate:** Small

**AC-007.1:** Given `hooks/heads-up/heads-up.mjs` whose sha256 differs from `VENDORED.json`, when OSS tests run, then they fail.
**AC-007.2:** Given `scripts/vendor-heads-up.sh <tag>`, when run, then the copy and `VENDORED.json` match that tag.

### US-008: Catch format changes early
**As a** maintainer **I want** a contract check against the real store. **Priority:** Should · **Estimate:** Small

**AC-008.1:** Given a real store on the machine, when the local pre-ship check runs, then it fails if the shape
differs from the expected one; where no store exists, it is skipped with a message.

## Edge Cases
| Scenario | Expected Behavior |
|----------|-------------------|
| Session entry without `view` | No output |
| `view` without `explanation` | Inject line only |
| Two notices before a hook run (first overwritten) | Only the latest is injected (accepted loss) |
| Notice text containing quotes/newlines/control chars | Valid JSON output; text framed as a claim to verify |
| Continued session (new id) | Routed by the current hook `session_id` only |
| State dir missing or not writable | Created if missing; if not writable, exit 0 silently (no repeat-spam risk accepted) |
| Node absent | Hook command fails to start; Claude Code continues (non-blocking) |

## Non-Functional Requirements
- **Performance:** hook run < 100 ms on a normal store.
- **Security:** read-only toward Claude Code files; no network; no dependencies; state files 0600 in a 0700 dir; never
  `eval` or execute notice text.
- **Portability:** Node built-ins only; macOS and Linux tested; Windows best effort.

## Out of Scope
Idle wake, catch-all for unattributed notices, report-only mode, UI, writing to Claude Code's store, use of `seen`.

## Dependencies
- Claude Code's built-in "you should know" notice store (undocumented).
- Claude Code hooks: `UserPromptSubmit`, `PostToolUse` with `additionalContext`.

## Open Questions
- None blocking. Repo name/owner and marketplace entry are decided at ship.

## Traceability Matrix
| Requirement | Test (planned) | Code |
|-------------|----------------|------|
| US-001 | tests/inject.test.mjs | core/heads-up.mjs |
| US-002 | tests/routing.test.mjs | core/heads-up.mjs |
| US-003 | tests/failsafe.test.mjs | core/heads-up.mjs |
| US-004 | tests/concurrency.test.mjs | core/heads-up.mjs |
| US-005, US-006 | tests/settings.test.mjs | core/heads-up.mjs |
| US-007 | OSS `__tests__/heads-up-vendored.test` | OSS scripts/vendor-heads-up.sh |
| US-008 | tests/contract.test.mjs | — |
