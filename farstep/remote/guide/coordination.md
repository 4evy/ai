# Coordinate shared work

Before shared work, call {{coordinationTool}} with {{snapshot}}. Omit `target`
locally or pass a saved SSH connection ID. The registry stores records per user
and host. Project records use the canonical workspace directory. Follow
`pagination.nextCursor` while `pagination.hasMore` is true. Use
`allProjects:true` to read across projects. Shared job metadata grants no log
access or process control.

The project is the agent session's workspace on that target. A command's `cwd`
changes its execution directory, not the coordination project. Scratch work does
not move the session's project scope.

## Claim work before changing shared resources

Create work with {{createWork}} and save `work.id`. Claim it with {{claimWork}}.
Use your title and agreed resource names. Replace `WORK_ID` with the returned ID
and each request placeholder with a new ID. Claims are atomic, so a conflict
grants nothing. Directories and globs do not imply broader ownership.

Choose `ttlSeconds` for the expected work duration. The example's duration is
illustrative. Renew before the returned expiry by repeating `claim` with a new
`requestId`. Presence heartbeats do not renew claims.

Update owned work with `action:"work"`, `work` and `status` or `blockers`. Set
`status:"done"`, then {{releaseWork}}. Reopen completed work before claiming it
again. Disconnection leaves claims and persistent jobs intact.

Jobs attach automatically when you have exactly one live claim. Otherwise use
{{linkJob}} with the exact native helper job name.

## Share notes and hand off ownership

Write notes with `action:"note"`, `work` and `body`. Continue a thread with the
returned note's thread ID. `recipient` uses the registry's session ID. Addressed
notes remain shared. Read `inbox` and acknowledge addressed notes.

Use `action:"handoff"` with `work`, `recipient` and `body` to write a note and
release claims atomically. The recipient must then claim the work.

## Recover mutations without repeating them

Put fields beside `action`. Set `requestId` before mutations. After an uncertain
outcome, repeat identical fields and ID to recover the result. A new ID starts a
new mutation. Keep secrets out of durable records, including purpose, titles,
resource names and notes.
