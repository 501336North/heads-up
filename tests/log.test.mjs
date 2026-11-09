// Saved log: every heads-up relayed to the agent is also appended to heads-up.log in the state root, so the user
// can still read it (explanation included) after it has been cleared from Claude Code's screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { aged, injectedContext, markStateDir, runHook, tempDir, writeBuiltinStore } from './helpers.mjs';

const LOG = 'heads-up.log';

/** An unopened ("offer") notice. */
function offerView(line, explanation) {
  return { kind: 'offer', line, explanation, shownAt: Date.now() };
}

/** A store file with one session entry holding `view`; returns its path. */
function storeFor(sessionId, view) {
  return writeBuiltinStore(tempDir(), { sessions: [{ id: sessionId, tag: 'Heads up', view }], seen: [] });
}

/** Relay a fresh notice for a new session against `stateDir`; returns { sessionId, line, storePath, result }. */
async function relay(stateDir, { line = `Notice ${randomUUID()}`, explanation = 'Why it matters.' } = {}) {
  const sessionId = randomUUID();
  const storePath = storeFor(sessionId, offerView(line, explanation));
  const result = await runHook({ sessionId, storePath, stateDir });
  return { sessionId, line, storePath, result };
}

/** Whether the session's view is still in the store (the notice was not cleared). */
function stillInStore(storePath, sessionId) {
  return 'view' in JSON.parse(readFileSync(storePath, 'utf8')).sessions.find((e) => e.id === sessionId);
}

test('should append each relayed notice to heads-up.log in the state root', async () => {
  // User behaviour: after a heads-up is cleared from the screen, the user can still read it, "Learn more" text
  // included, in a plain log.
  // Business rule: each relayed notice adds one entry (time, session id, tag, line, explanation), in order.
  const stateDir = markStateDir(tempDir());

  const a = await relay(stateDir, { explanation: 'First reason.\nSecond line.' });
  const b = await relay(stateDir, { explanation: 'Other reason.' });

  injectedContext(a.result);
  injectedContext(b.result);
  const log = readFileSync(join(stateDir, LOG), 'utf8');
  const time = '\\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z';
  const entry = (s, explanation) =>
    new RegExp(`--- ${time} · session ${s.sessionId} · Heads up\\n  ${s.line}\\n${explanation}\\n\\n`);
  assert.match(log, entry(a, '  First reason.\\n  Second line.'), "A's entry, explanation newlines kept");
  assert.match(log, entry(b, '  Other reason.'), "B's entry");
  assert.ok(log.indexOf(a.line) < log.indexOf(b.line), 'entries are in relay order');
});

test('should create the log with mode 0600', async (t) => {
  // User behaviour: other local users cannot read the user's heads-ups.
  // Business rule: the log is created private to the user (0600).
  if (process.platform === 'win32') {
    t.skip('POSIX modes only');
    return;
  }
  const stateDir = markStateDir(tempDir());

  injectedContext((await relay(stateDir)).result);

  assert.equal(statSync(join(stateDir, LOG)).mode & 0o777, 0o600);
});

test('should not write through a symlinked log', async (t) => {
  // User behaviour: a planted link can never make the hook write the user's heads-ups into another file.
  // Business rule: the log is never opened through a symlink; when it cannot be written, the notice is still
  // relayed but not cleared, so its explanation is not lost.
  if (process.platform === 'win32') {
    t.skip('POSIX symlinks only');
    return;
  }
  const stateDir = markStateDir(tempDir());
  const victim = join(tempDir(), 'victim.txt');
  writeFileSync(victim, 'precious\n');
  symlinkSync(victim, join(stateDir, LOG));

  const { sessionId, line, storePath, result } = await relay(stateDir);

  assert.ok(injectedContext(result).includes(line), 'the notice still reaches the agent');
  assert.equal(readFileSync(victim, 'utf8'), 'precious\n', 'the file behind the link is unchanged');
  assert.ok(stillInStore(storePath, sessionId), 'the notice is not cleared');
});

test('should strip terminal control and format characters from the log but keep explanation newlines', async () => {
  // User behaviour: `cat heads-up.log` shows the text as written, and a notice cannot change the user's terminal.
  // Business rule: control characters (ESC, BEL, CR...) and invisible format characters are removed; the
  // explanation keeps its line breaks, with CRLF and CR turned into LF.
  const stateDir = markStateDir(tempDir());
  const id = randomUUID();
  const line = `Red \u001b[31malert\u0007 ‮evil\r\n${id}`;
  const explanation = 'One\u001b[0m\r\nTwo\u0007\rThree‮';

  injectedContext((await relay(stateDir, { line, explanation })).result);

  const log = readFileSync(join(stateDir, LOG), 'utf8');
  for (const bad of ['\u001b', '\u0007', '‮', '\r']) assert.ok(!log.includes(bad), `no ${JSON.stringify(bad)}`);
  assert.ok(log.includes(`  Red [31malert evil ${id}\n`), 'the line is kept on one line, readable');
  assert.ok(log.includes('  One[0m\n  Two\n  Three\n'), 'the explanation keeps its newlines');
});

test('should not clear the notice when the log cannot be written', async () => {
  // User behaviour: a heads-up's explanation is never lost from both the screen and the log.
  // Business rule: when the log write fails, the notice is relayed but the store is left as it was.
  const stateDir = markStateDir(tempDir());
  mkdirSync(join(stateDir, LOG));
  const sessionId = randomUUID();
  const line = `Unloggable ${randomUUID()}`;
  const storePath = storeFor(sessionId, offerView(line, 'Why.'));
  const before = readFileSync(storePath);

  const result = await runHook({ sessionId, storePath, stateDir });

  assert.ok(injectedContext(result).includes(line), 'the notice still reaches the agent');
  assert.equal(result.stderr, '', 'nothing on stderr');
  assert.deepEqual(readFileSync(storePath), before, 'the store is unchanged');
});

test('should rotate the log to heads-up.log.1 once it is over 1 MB', async () => {
  // User behaviour: the log never grows without bound, and the previous part is still there to read.
  // Business rule: a log over 1 MB is renamed to heads-up.log.1 (replacing an older one) before the next entry.
  const stateDir = markStateDir(tempDir());
  const old = 'x'.repeat(1024 * 1024) + '\n';
  writeFileSync(join(stateDir, LOG), old, { mode: 0o600 });
  writeFileSync(join(stateDir, LOG + '.1'), 'oldest\n', { mode: 0o600 });

  const { line, result } = await relay(stateDir);

  injectedContext(result);
  assert.equal(readFileSync(join(stateDir, LOG + '.1'), 'utf8'), old, 'the full log moved to heads-up.log.1');
  const log = readFileSync(join(stateDir, LOG), 'utf8');
  assert.ok(log.startsWith('--- ') && log.includes(line), 'the new log starts with the new entry');
  assert.equal(log.split('\n--- ').length, 1, 'and holds only that entry');
});

test('should keep the log when old state is pruned', async () => {
  // User behaviour: housekeeping never deletes the user's saved heads-ups.
  // Business rule: the prune touches only session dirs and markers; heads-up.log and heads-up.log.1 are kept
  // however old they are.
  const stateDir = markStateDir(tempDir());
  const log = aged(join(stateDir, LOG), 400);
  const rotated = aged(join(stateDir, LOG + '.1'), 400);
  const oldDir = join(stateDir, 'old-session');
  mkdirSync(oldDir);
  const oldMarker = aged(join(oldDir, 'aaaaaaaaaaaaaaaa'), 31);
  aged(oldDir, 31, { dir: true });

  injectedContext((await relay(stateDir)).result);

  assert.equal(existsSync(oldMarker), false, 'the prune ran');
  assert.ok(existsSync(log), 'heads-up.log is kept');
  assert.ok(existsSync(rotated), 'heads-up.log.1 is kept');
});

test('should not write through a hardlinked log', async (t) => {
  // User behaviour: a planted hard link can never make the hook write the user's heads-ups into another file.
  // Business rule: the log must be a file with a single link; otherwise it is not written (or rotated), and the
  // notice is relayed but not cleared, so its explanation is not lost.
  if (process.platform === 'win32') {
    t.skip('POSIX hard links only');
    return;
  }
  const stateDir = markStateDir(tempDir());
  const victim = join(tempDir(), 'victim.txt');
  writeFileSync(victim, 'precious\n');
  linkSync(victim, join(stateDir, LOG));

  const { sessionId, line, storePath, result } = await relay(stateDir);

  assert.ok(injectedContext(result).includes(line), 'the notice still reaches the agent');
  assert.equal(readFileSync(victim, 'utf8'), 'precious\n', 'the linked file is unchanged');
  assert.ok(stillInStore(storePath, sessionId), 'the notice is not cleared');
});

test('should never let notice text start a log line that looks like an entry header', async () => {
  // User behaviour: reading the log, the user can trust that every "--- <time> · session ..." line is a real entry.
  // Business rule: the notice line and every explanation line are indented in the log, so only the hook's own
  // header line starts with "--- "; explanation newlines are kept.
  const stateDir = markStateDir(tempDir());
  const fake = '--- 2020-01-01 · session X · fake';
  const line = `${fake} ${randomUUID()}`;
  const explanation = `Real reason.\n${fake}\nMore.`;

  const { sessionId, result } = await relay(stateDir, { line, explanation });

  injectedContext(result);
  const headers = readFileSync(join(stateDir, LOG), 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('--- '));
  assert.equal(headers.length, 1, `only the real header starts with "--- ": ${JSON.stringify(headers)}`);
  assert.match(headers[0], new RegExp(`^--- \\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z · session ${sessionId} · Heads up$`));
});

test('should still log and clear when the full log cannot be rotated', async () => {
  // User behaviour: a stuck rotation never stops heads-ups from being saved and cleared from the screen.
  // Business rule: rotation is best effort; when heads-up.log.1 cannot be replaced (here it is a dir), the new
  // entry is appended to the current log (here just over 1 MB, below the 2 MB hard cap) and the notice is cleared.
  const stateDir = markStateDir(tempDir());
  const old = 'x'.repeat(1024 * 1024) + '\n';
  writeFileSync(join(stateDir, LOG), old, { mode: 0o600 });
  mkdirSync(join(stateDir, LOG + '.1'));

  const { sessionId, line, storePath, result } = await relay(stateDir);

  injectedContext(result);
  const log = readFileSync(join(stateDir, LOG), 'utf8');
  assert.ok(log.startsWith(old), 'the old entries are kept');
  assert.ok(log.slice(old.length).includes(line), 'the new entry is appended');
  assert.equal(stillInStore(storePath, sessionId), false, 'the notice is cleared');
});

test('should cap a huge explanation in the log at 1000 characters', async () => {
  // User behaviour: a runaway explanation never floods the user's log; the start of it is still readable.
  // Business rule: the logged explanation is cut to 1000 code points (the last one "…"), never splitting a
  // character, however long the original is.
  for (const unit of ['a', '😀']) {
    const stateDir = markStateDir(tempDir());

    const { result } = await relay(stateDir, { explanation: unit.repeat(1_000_000) });

    injectedContext(result);
    const lines = readFileSync(join(stateDir, LOG), 'utf8').split('\n');
    assert.equal(lines[2], '  ' + unit.repeat(999) + '…', `the explanation is cut (${unit})`);
  }
});

test('should stop appending, and not clear, once a log that cannot be rotated is over 2 MB', async () => {
  // User behaviour: a log that can never be rotated never fills the user's disk; heads-ups still reach the agent
  // and stay on screen, so nothing is lost.
  // Business rule: past twice the rotation size, a log that was not rotated is not appended to; the log counts as
  // failed, so the notice is relayed but not cleared.
  const stateDir = markStateDir(tempDir());
  const old = 'x'.repeat(2 * 1024 * 1024) + '\n';
  writeFileSync(join(stateDir, LOG), old, { mode: 0o600 });
  mkdirSync(join(stateDir, LOG + '.1'));

  const { sessionId, line, storePath, result } = await relay(stateDir);

  assert.ok(injectedContext(result).includes(line), 'the notice still reaches the agent');
  assert.equal(readFileSync(join(stateDir, LOG), 'utf8'), old, 'nothing is appended');
  assert.ok(stillInStore(storePath, sessionId), 'the notice is not cleared');
});
