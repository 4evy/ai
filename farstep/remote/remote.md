# remote

## guide

Read guidance for local and SSH commands, coordination, scratch workspaces,
environments, jobs, files, privileged commands, and desktop access. Choose a
topic. Reading a guide does not connect to a machine.

## coordination

Coordinate agents through the target user's durable Farstep registry. Omit
target locally or use a saved SSH target ID. Project scope is the target's
canonical workspace directory.

Read snapshot for sessions, work, claims, and safe job metadata. Read inbox,
thread, or events without consuming messages. Follow pagination.nextCursor
while pagination.hasMore is true. Set allProjects explicitly for a cross-project
snapshot.

Use session to set your purpose and work to create or update work. Claim work
and exact resource names atomically with an explicit renewable TTL. Use release
to drop your claims and link to associate one of your jobs with claimed work.
Claims do not transfer job control.

Use note to share text and acknowledge to mark addressed notes. Handoff offers
claimed work to a recipient session, sends a note, and releases your claims.
The recipient must claim the work explicitly. Commands, environment values,
logs, and job controls are not shared.

Mutations receive a UUID requestId when omitted. Save a requestId and its
payload before a mutation to recover a lost response. Writes are never
automatically replayed.

## run

Run locally without SSH or on a saved SSH target. Both backends share explicit
host environments, TypeScript scripts with bundled zx and Bash/Zsh, readiness,
deadlines, interactive job handles and completion delivery.

## batch

Run named dependency steps locally or over SSH with bounded concurrency,
per-step results, readiness checks, output artifacts, and guards. Batches
persist by default. Failure policies never retry work.

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
require the latest captured frame. Text receipts report clipboard effects and
partial submission.

## helper

Inspect, plan, install, upgrade or remove the helper over SSH using Nix on
Linux and macOS. Build or copy a trusted Farstep output into the target Nix
store before activation. Nix must already be installed.

## scratch

Create, list, inspect, or remove private temporary workspaces locally or on a
saved SSH target. Use the returned workspace ID, command cwd, target, and file
paths. Workspaces survive sessions until explicit removal or OS temporary-file
cleanup. Removal never stops jobs.

## system

Inspect unattended system access or execute a bounded root Bash command on
Linux or macOS. Omit target locally or use a saved SSH target ID. Run farstep
system enable once on that machine to grant access. Commands have full system
authority and are never automatically retried.

## read

Read remote files or list a directory using the saved SSH credentials, without
requiring Farstep. Supports files up to {{LIMIT_MIB}} MiB and returns a
full-file SHA-256 for edits.

## write

Create or overwrite a remote file using SSH staging. Creates parent directories
and preserves existing regular-file permissions. Replaces symlinks to files.

## edit

Update remote text with a diff of the changes. Rejects ambiguous matches unless
replace_all is true. Rechecks content before transfer. Use expectedHash to
check against an earlier read as well. Replaces symlinks to files.

## delete

Delete one remote file or symlink using the saved SSH connection. Refuses
directories and retains a symlink's target. Missing files are errors.
