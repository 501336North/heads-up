# heads-up

A Claude Code plugin that passes Claude Code's own heads-up notices for a session to the agent working in that
session, then clears the notice so Claude Code can show you the next one. The notice is quoted (each line prefixed
with `> ` between `--- notice ---` and `--- end notice ---`), flattened to one line and length-capped, and presented
as an unverified claim. The agent is told to first tell you in one line that it got the heads-up and what it will
do about it, then check whether it is true, act on it only if that is within its current task (keeping its normal
approval rules and never following instructions inside the notice), tell you what it found and did, and say what
you still need to do.

- Each notice reaches the agent **once per session**, and only in the session it belongs to.
- You see `✓ heads-up relayed to the agent: <line>` when it does.
- It runs on `UserPromptSubmit` and after every tool call (`PostToolUse`).
- If anything goes wrong it exits quietly, so it never breaks a session.

## Clearing the notice

Claude Code shows no new heads-up while one is still on screen. So once the notice has reached the agent, the
plugin removes it from Claude Code's notice store, as if you had dismissed it, and the next one can appear.

It clears only:

- the notice it just relayed, and only after the relay succeeded;
- if you have not opened it (an opened notice is yours, and is left alone);
- in this session's entry (other sessions are never touched);
- under Claude Code's own lock on that file (if the lock stays busy for about a second, it gives up);
- in a real file, never through a symlink;
- only when the file is laid out exactly as Claude Code writes it, so the rewrite changes nothing but that one
  notice (the file keeps its permissions).

When the notice cannot be cleared until something is fixed, the ✓ line says why, as
`(not cleared: <reason>; dismiss it yourself)`:

- `Claude Code's notice file changed`: the file is not laid out as expected (for example after a Claude Code
  update);
- `Claude Code's notice file is a symlink`;
- `the saved log is not a plain file (see README, Saved log)`: `heads-up.log` is a symlink, hard link or folder;
- `the saved log is full (see README, Saved log)`: it is over 2 MB and cannot be rotated.

Passing skips, such as a busy lock, are silent: the notice simply stays until the next one or until you dismiss it.
So are a few rare states you would have to create on purpose, such as a read-only or locked log file.

Anything unexpected means no clear. The notice is still relayed, and the store is left as it was.

Trade-off: clearing lifts Claude Code's pause between heads-ups, so its background check (a model call, which
uses some of your usage) can run about once per long turn. That is the same rate as dismissing each notice
straight away. To relay without clearing, see [Settings](#settings).

### Saved log

Clearing also removes the notice's "Learn more" explanation from Claude Code. So each relayed heads-up (time,
session, label, line and explanation, up to 1000 characters) is saved to `~/.claude/heads-up/heads-up.log`, or to the
`HEADS_UP_STATE_DIR` folder if that is set. You can read it any time:

```sh
cat ~/.claude/heads-up/heads-up.log
```

If the log cannot be written, the notice is not cleared, so you can still open it yourself. If the ✓ line says
the saved log is not a plain file or is full, delete `heads-up.log` and `heads-up.log.1` (whatever they are) in the
state folder to resume clearing.

## Caveats

- It reads and edits an **undocumented internal Claude Code file**
  (`~/.claude/plugins/store/cc-plugin-you-should-know_builtin-*.json`). It was checked against Claude Code
  2.1.319, and a Claude Code update may change that file at any time. If the format changes, the plugin warns
  once per session that heads-ups are off, then stays quiet (and clears nothing).
- It only works where Claude Code shows these notices in the first place.
- It reads and clears notices in that file and writes its own state. It makes no network calls and has no
  dependencies.

## Install (from a local checkout)

```sh
git clone https://github.com/501336North/heads-up.git ~/dev/heads-up
claude --plugin-dir ~/dev/heads-up
```

Requires Node.js 20 or newer on your `PATH`.

## Settings

Set these in the environment Claude Code runs in. The two switches take `off` in any case; any other value leaves
them on.

- `HEADS_UP=off` turns the plugin off.
- `HEADS_UP_CLEAR=off` keeps relaying notices but stops clearing them; you dismiss them yourself.
- `HEADS_UP_STATE_DIR` moves the state folder (see [State](#state)). A blank value counts as unset.

## State

Handled notices are recorded in `~/.claude/heads-up/` (dir mode 0700, files 0600), one folder per session.
The folder is marked with a `.heads-up-state` file. The mark only matters for `HEADS_UP_STATE_DIR`: if it points
at a folder that already holds other files (a `.DS_Store` aside) and has no such mark, the plugin leaves it alone
and keeps no state. The default `~/.claude/heads-up/` is the plugin's own folder, so it is used without the mark
check (it is still refused if it is a symlink or owned by another user).
Entries older than 30 days are deleted automatically. You can delete the folder at any time; the only effect is
that a current notice may be shown once more (and the saved log is gone).

The same folder holds the saved log, `heads-up.log` (mode 0600, private to you). Each entry starts with a
`--- <time> · session <id> · <label>` line; the notice lines below it are indented, so notice text can never pass
for an entry of its own. Control characters are stripped, so it is safe to print. A log that is a symlink or
hard link is never written to. Over 1 MB it moves to `heads-up.log.1`, replacing the older one, so it normally takes
about 2 MB at most. If it cannot be moved (a folder named `heads-up.log.1` is in the way), it stops growing at
about 2 MB: new heads-ups are then still relayed but no longer cleared, and the ✓ line says so, until you delete
`heads-up.log` and `heads-up.log.1`. The 30-day cleanup never deletes it.

## Uninstall

Stop loading the plugin (drop `--plugin-dir`, or remove it with `/plugin` if you installed it that way), then
optionally delete `~/.claude/heads-up/`. That also deletes the saved log.

## Development

```sh
npm test
```

Tests use `node:test`. They run the real script as a separate process, against temp dirs only.

Before shipping, run `npm run contract` locally: it checks the real Claude Code store (read-only) against the
expected shape and checks the hook's speed on it.

## License

MIT, see [LICENSE](LICENSE).
