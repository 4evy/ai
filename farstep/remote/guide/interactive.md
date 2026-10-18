# Interact with a terminal

Start {{runTool}} with `pty:true` and `waitSeconds:0`, then inspect the prompt.
Observe again if blank or `settled:false`; neither proves readiness.

Use {{jobTool}} with the returned handle:

- `reply`: `data` plus Enter, as in {{reply}}; use the returned job handle
- `password`: password plus Enter; omit `data` for the host's password dialog
- `input`: literal bytes without Enter
- `keys`: named presses; use a checked sequence for dependent keys

Supported keys: {{terminalKeys}}.

Use `input` for literal Unicode and `keys` for documented key names. Modifier
support depends on the app's keyboard protocol; do not approximate rejected
chords. Keys are presses, not held keys.

`screen` and input return styled rows, `screenVersion` and `settled`. Pass the
observed version as `expectedScreenVersion` to reject stale input. Set
`columns`/`rows` at launch or use `resize`. `settleMs` sets the quiet window;
`maxWaitMs` bounds observation. `settled:false` means no quiet window was
observed. Inspect responses even when settled; a quiet screen does not prove app
readiness.

Use the handle and `screenVersion` from {{jobTool}} `screen`. Replace the
placeholders and save a new `actionId` per intended input for recovery:

{{checkedKey}}

For dependent keys, declare each expected screen as a regex. Hypothetical menu:

{{checkedSequence}}

Replace the handle, version and regexes with observed values. Patterns must
distinguish the result from the previous screen; already-visible text is a weak
check. Escape regex metacharacters, including JSON's extra backslashes.

Sequences stop on mismatch, uncertainty or unstable intermediate screens. After
uncertainty, query step receipts `ID:0`, `ID:1`, etc. Check `completedSteps`,
`error` and the current screen; read "jobs" before resuming. Never retry the
whole sequence with a new `actionId`. `screenChanged` confirms rendering, not
app acceptance.

An identical `actionId` and payload can return the original receipt without
sending input again. Read the receipt's state and timestamps; a recovered
`processed` receipt does not report a new delivery.
