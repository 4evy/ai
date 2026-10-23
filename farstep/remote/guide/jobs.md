# Observe and control a job

Call {{jobTool}} with the exact returned handle. Supported actions:
{{jobActions}}.

Use `status` for state, `logs` for output, `wait` for completion or a regex
match, and `screen` for an active terminal frame. Completion notifications
arrive at agent step boundaries.

Logs, waits, input replies and notifications share an unread cursor. Omit
`cursor` for new output. `cursor:0` replays output without rewinding
consumption. `lines` limits display, so inspect reported gaps. For batch
`status`, `logs` or `cancel`, `step:"ID"` selects one step.

## Stop work and check cleanup

`interrupt` requests SIGINT, `stop` escalates termination, and `force` requests
SIGKILL. `cancel` stops the workflow. With `step`, it cancels that step and
blocks dependants. Check cleanup because leader exit or unknown cleanup does
not prove all descendants stopped.

Use `mode` to select `lifetime:"session"` or `"persist"`. Persistence covers
client loss. Inspect job state after broker or host restarts. Session and branch
changes can change which handles you may control. Recover locally without SSH
or remotely with the saved connection.

## Recover the original launch

After an interrupted start or transport loss, call {{jobStatus}} with the saved
handle, or recover the original `requestId`. If the job is still running, wait
on that handle. Observation timeout does not stop it. If the job is unknown,
recover its identity before launching replacement work. Connection loss proves
neither completion nor cancellation.

If a launch reports that the helper is busy, inspect its returned handle first.
After the competing operation ends, retry the same saved `requestId` and
arguments serially. Use {{batchTool}} for supported concurrent steps. Separate
launches may be rejected while another launch or installation is in progress.

## Recover input without sending it again

Set `actionId` before sending input. After an uncertain outcome, query
{{inputReceipt}} with the saved handle and input ID. Reusing the ID returns a
receipt without resending, even if you changed the input. Keep the original
arguments for recovery. Use a new ID for a new intended action only after
checking the previous outcome. Launch `requestId` recovery separately rejects
changed arguments.

`processed` confirms broker acceptance, not app acknowledgement. Recovered
screens are historical. Inspect the current screen or final output. Read
"interactive" for examples.

After a PTY exits, use `logs` with `cursor:0` for retained output or a saved
input receipt for its historical frame. `screen` may report only completion and
new output. Neither a historical frame nor an empty log proves current app
state.
