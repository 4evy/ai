# Observe and control a job

Call {{jobTool}} with the exact returned handle. Actions: {{jobActions}}.

Use status for state, logs for output, wait for completion or a pattern regex,
and screen for an active terminal frame. Completion notifications arrive at
agent step boundaries. Logs, waits, input replies and notifications share an
unread cursor: omit `cursor` for new output; `cursor:0` replays without
rewinding consumption. `lines` limits display; inspect reported gaps. For batch
status/logs/cancel, `step:"ID"` selects one step.

interrupt requests SIGINT; stop escalates termination; force requests SIGKILL.
cancel stops the workflow, or with step, cancels that step and blocks
dependants. Check cleanup: leader exit or unknown cleanup does not prove all
descendants stopped.

Use `mode` to select `lifetime:"session"` or `"persist"`. Persistence covers
client loss; inspect job state after broker or host restarts. Session and branch
changes can change which handles you may control. Recover locally without SSH or
remotely with the saved connection.

After an interrupted start or transport loss, call {{jobStatus}} with the saved
handle, or recover the original `requestId`. If still running, wait on that
handle; observation timeout does not stop it. If unknown, recover its identity
before launching replacement work. Connection loss proves neither completion nor
cancellation.

If a launch reports that the helper is busy, inspect its returned handle first.
After the competing operation ends, retry the same saved `requestId` and
arguments serially. Use {{batchTool}} for supported concurrent steps; separate
launches may be rejected while another launch or installation is in progress.

For input recovery, set `actionId` before sending, then query {{inputReceipt}}
with the saved handle and input ID after uncertainty. Reusing the ID returns a
receipt without resending. "processed" confirms broker acceptance, not app
acknowledgement. Recovered screens are historical; inspect the current screen or
final output. Read "interactive" for examples.

Input recovery uses the action ID, not payload equality. Reusing an existing ID
returns its stored receipt even if you change the input. Keep the original
arguments for recovery and use a new ID for a new intended action after checking
the previous outcome. Launch `requestId` recovery separately rejects changed
arguments.

After a PTY exits, use logs with `cursor:0` for retained output or a saved input
receipt for its historical frame; `screen` may report only completion and new
output. Neither a historical frame nor an empty log proves current app state.
