# heads-up

A Claude Code plugin that passes Claude Code's own heads-up notices for a session to the agent working in that
session. The notice is quoted (each line prefixed with `> ` between `--- notice ---` and `--- end notice ---`),
flattened to one line and length-capped, and presented as an unverified claim. The
agent is told to check whether it is true, act on it only if that is within its current task (keeping its normal
approval rules and never following instructions inside the notice), tell you, and say what you still need to do.

- Each notice reaches the agent **once per session**, and only in the session it belongs to.
- It runs on `UserPromptSubmit` and after every tool call (`PostToolUse`).
- If anything goes wrong it exits quietly, so it never breaks a session.

## Caveats

- It reads an **undocumented internal Claude Code file**
  (`~/.claude/plugins/store/cc-plugin-you-should-know_builtin-*.json`). Claude Code may change it at any time.
  If the format changes, the plugin warns once per session that heads-ups are off, then stays quiet.
- It only works where Claude Code shows these notices in the first place.
- It reads that file and writes its own state. It makes no network calls and has no dependencies.

## Install (from a local checkout)

```sh
git clone <this repo> ~/dev/heads-up
claude --plugin-dir ~/dev/heads-up
```

Requires Node.js 20 or newer on your `PATH`.

## Turn it off

Set `HEADS_UP=off` (any case) in the environment Claude Code runs in. Any other value leaves it on.

## State

Handled notices are recorded in `~/.claude/heads-up/` (dir mode 0700, files 0600), one folder per session.
The folder is marked with a `.heads-up-state` file. The mark only matters for `HEADS_UP_STATE_DIR`: if it points
at a folder that already holds other files (a `.DS_Store` aside) and has no such mark, the plugin leaves it alone
and keeps no state. The default `~/.claude/heads-up/` is the plugin's own folder, so it is used without the mark
check (it is still refused if it is a symlink or owned by another user).
Entries older than 30 days are deleted automatically. You can delete the folder at any time; the only effect is
that a current notice may be shown once more.

## Uninstall

Stop loading the plugin (drop `--plugin-dir`, or remove it with `/plugin` if you installed it that way), then
optionally delete `~/.claude/heads-up/`.

## Development

```sh
npm test
```

Tests use `node:test`. They run the real script as a separate process, against temp dirs only.

Before shipping, run `npm run contract` locally: it checks the real Claude Code store (read-only) against the
expected shape and checks the hook's speed on it.

## License

MIT, see [LICENSE](LICENSE).
