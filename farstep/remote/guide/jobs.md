# Observe and control a job

Call {{jobTool}} with the exact returned handle. Supported actions:
{{jobActions}}.

Use `status` for state, `logs` for output, `wait` for completion or a regex
match, and `screen` for an active terminal frame. `waitSeconds` accepts
0–{{jobWaitMaximum}} seconds, not an execution deadline. Completion
notifications arrive at agent step boundaries.

Workflow `status` inspection is read-only. It creates no locks and writes no
state. `observation.source` identifies journal reads versus in-memory
reconciliation, and `observation.durableState` preserves the recorded state.

Logs, waits, input replies and notifications share an unread cursor. Omit
`cursor` for new output. `cursor:0` replays retained output without rewinding
consumption, for example {{jobLogs}}. `lines` accepts 1–{{jobLineMaximum}} and
limits display, not retention. For batch `status`, `logs` or `cancel`,
`step:"ID"` selects one step, for example {{stepStatus}}.

An explicit replay cursor reads a bounded prefix page, not a tail preview.
Follow the returned `output.recovery.logs` arguments or `output.nextCursor`
until no continuation remains. Each cursor advances only past bytes actually
displayed, including complete UTF-8 sequences. Replay does not rewind the
shared unread cursor or mark undisplayed suffixes delivered.

Check `output.responseTruncated` separately from `output.retentionGap`.
Response truncation omits part of this preview. A retention gap means bytes
before `availableStart` are no longer available in the broker log. Use the
returned `output.recovery.logs` action to read from the exact retained cursor
and `output.recovery.inspect` to inspect the same handle. A later cursor does
not recover lost bytes. Workflow stdout/stderr artifacts have independent
retention and may still be complete. Use their exact returned artifact reads,
not a rerun of the command.

`job.executionOutcome` reports execution only. Workflow `observation` reports
the source and durable state independently, and each step's `output` separates
preview, persistence and parsing. An exit code of 0 does not establish a
complete artifact, a valid parsed value or a known durable workflow outcome.

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
on that handle. An observation timeout or canceled tool call does not stop
already-started work. Use `stop` or `cancel` to stop it explicitly. Its
execution deadline and session or persist lifetime still apply. If the job is
unknown, recover its identity before launching replacement work. Connection loss
proves neither completion nor cancellation.

`outcome:"definitely-not-started"` proves this request did not cross the start
fence. `outcome:"unknown"` does not. Preserve the original request and inspect
its existing handle or recover the same launch reservation. Do not invent a
new handle or request ID to bypass an uncertain launch.

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
