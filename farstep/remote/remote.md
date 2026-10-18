# remote

## guide

Guidance for native local and managed SSH execution, shared agent coordination,
scratch workspaces, environments, jobs, remote files, sudo and desktop access.
Choose a topic; this guide does not connect.

## coordination

Coordinate independent agents through the target user's durable farstep
registry. Target defaults to local; use a saved SSH target ID for remote
coordination. Project scope is the target's canonical workspace directory. Read
snapshot (sessions, work, claims and safe job metadata), inbox, thread or events
without consuming messages; paginate using returned pagination.nextCursor.
Snapshot allProjects is explicit. Writes: session sets purpose; work creates or
updates durable work; claim atomically claims work and exact resource names with
an explicit renewable TTL; release drops your claims; link associates one of
your jobs with claimed work; note appends shared or addressed text; acknowledge
marks your addressed note; handoff offers claimed work to a recipient session
ID, sends a durable note and releases your claims. The recipient must explicitly
claim it. Send only deliberately shared text; commands, environment values, logs
and job controls are not shared. Claims do not transfer job control. Mutations
receive a UUID requestId when omitted; provide the same requestId and payload
explicitly to recover a lost response. No writes are automatically replayed

## run

Run locally without SSH or on a saved SSH target. Both backends share explicit
host environments, TypeScript scripts with bundled zx and Bash/Zsh, readiness,
deadlines, interactive job handles and completion delivery.

## batch

Run named dependency steps locally or over SSH with bounded concurrency,
per-step results, semantic readiness, output artifacts and guards. Batches
persist by default; failure policies never retry work.

## job

Inspect local or SSH jobs, wait for output, answer prompts, recover input
receipts, send keys, resize terminal screens, interrupt, stop or change
lifetime.

## desktop

Inspect native desktop capabilities on Linux, macOS or Windows,
authorize/release control, or open/release an isolated workspace where
supported. Only inspect is read-approved.

## screenshot

Capture a user-selected remote monitor or window as an image with actionable
frame metadata. Capture alone never grants input.

## input

Submit input to an explicitly authorized desktop session. Pointer actions
require the latest captured frame; text receipts report clipboard effects and
partial submission.

## helper

Inspect, plan, install, upgrade or remove the helper over SSH using Nix on
Linux and macOS. Build or copy a trusted Farstep output into the target Nix
store before activation. Nix must already be installed.

## scratch

Create, list, inspect or remove private temporary workspaces locally or on a
saved SSH target. Returns a stable workspace ID, run target/cwd and file-tool
paths. Workspaces survive sessions until explicit removal or OS temporary-file
cleanup; remove never stops jobs.

## system

Inspect unattended system access or execute a bounded root Bash command on
Linux/macOS. Target defaults to local; saved SSH target IDs select another
machine. Requires farstep system enable once on that machine; privileged
commands have full system authority. No automatic command retries

## read

Read remote files using the adapter’s formatting and selectors, or list a
directory. Uses the saved SSH credentials without requiring farstep. Files up to
{{LIMIT_MIB}} MiB; returns a full-file SHA-256 for edits.

## write

Create or overwrite a remote file using adapter write handling and SSH staging.
Creates parent directories; existing regular-file permissions are preserved.
Symlinks to files are replaced.

## edit

Update remote text with adapter replace editing and diff output. Rejects
ambiguous matches unless replace_all is true. Rechecks content before transfer;
expectedHash additionally checks against an earlier read. Symlinks to files are
replaced.

## delete

Delete one remote file or symlink using the saved SSH connection. Refuses
directories; a symlink's target is retained. Missing files are errors.
