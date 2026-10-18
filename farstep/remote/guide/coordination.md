# Coordinate shared work

Before shared work, call {{coordinationTool}} with {{snapshot}}. Omit `target`
locally or pass a saved SSH connection ID. The registry is per user and host;
project records use the canonical workspace directory. Follow
`pagination.nextCursor` while `pagination.hasMore`; `allProjects:true` reads
across projects. Shared job metadata grants no log access or process control.

The project is the agent session's workspace on that target. A command's `cwd`
changes its execution directory, not the coordination project; scratch work does
not move the session's project scope.

Create work with {{createWork}} and save `work.id`. Claim with {{claimWork}}.
Use your title and agreed resource names; replace `WORK_ID` with the returned ID
and each request placeholder with a new ID. Claims are atomic; conflicts grant
nothing. Directories and globs do not imply broader ownership.

Choose `ttlSeconds` for the expected work duration; the example's duration is
illustrative. Renew before expiry if the work takes longer.

Renew before the returned expiry by repeating `claim` with a new `requestId`;
presence heartbeats do not renew it. Update owned work with `action:"work"`,
`work` and `status` or `blockers`. Set `status:"done"`, then {{releaseWork}};
reopen completed work before claiming again. Disconnection leaves claims and
persistent jobs intact.

Jobs attach automatically with exactly one live claim. Otherwise use {{linkJob}}
with the exact native helper job name.

Write notes with `action:"note"`, `work` and `body`; continue with the returned
note's thread ID. `recipient` uses the registry's session ID; addressed notes
remain shared. Read `inbox` and acknowledge addressed notes. `action:"handoff"`
with `work`, `recipient` and `body` writes a note and releases claims
atomically. The recipient must claim the work.

Put fields beside `action`. Set `requestId` before mutations; after uncertainty,
repeat identical fields and ID to recover the result. A new ID starts a new
mutation. Durable records must not contain secrets in purpose, titles, resource
names or notes.
