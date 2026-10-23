# Interact with a terminal

Start {{runTool}} with `pty:true` and `waitSeconds:0`, then inspect the prompt.
For example, start an interactive shell:

{{terminalLaunch}}

Replace the script with the intended terminal program. If the screen is blank
or `settled:false`, observe again. Neither proves readiness.

Use {{jobTool}} with the returned handle:

- `reply` sends `data` plus Enter, as in {{reply}}
- `password` sends a password plus Enter, or opens the host's password dialog
  when you omit `data`
- `input` sends literal bytes without Enter
- `keys` sends named presses. Use a checked sequence for dependent keys

Supported keys: {{terminalKeys}}.

Use `input` for literal Unicode and `keys` for documented key names. Modifier
support depends on the app's keyboard protocol. Do not approximate rejected
chords. Keys are presses, not held keys.

## Reject input when the screen has changed

`screen` and input return styled rows, `screenVersion` and `settled`. Pass the
observed version as `expectedScreenVersion` to reject stale input. Set `columns`
and `rows` at launch or use `resize`.

`settleMs` sets the quiet window and `maxWaitMs` bounds observation.
`settled:false` means no quiet window was observed. Inspect responses even when
settled because a quiet screen does not prove app readiness.

Use the handle and `screenVersion` from {{jobTool}} `screen`. Replace the
placeholders and save a new `actionId` per intended input for recovery:

{{checkedKey}}

## Check each dependent keypress

For dependent keys, declare each expected screen as a regex. For example, a menu
might use:

{{checkedSequence}}

Replace the handle, version and regexes with observed values. Patterns must
distinguish the result from the previous screen. Already-visible text is a weak
check. Escape regex metacharacters, including JSON's extra backslashes.

Sequences stop on mismatch, uncertainty or unstable intermediate screens. After
uncertainty, query step receipts `ID:0`, `ID:1`, and so on. Check
`completedSteps`, `error` and the current screen. Read "jobs" before resuming.
Never retry the whole sequence with a new `actionId`. `screenChanged` confirms
rendering, not app acceptance.

Reusing an `actionId` returns its original receipt without sending input again,
even if the payload changed. Read the receipt's state and timestamps. A
recovered `processed` receipt does not report a new delivery.
