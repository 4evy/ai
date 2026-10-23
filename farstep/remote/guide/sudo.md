# Run a privileged command

Use {{systemTool}} for unattended system actions on Linux or macOS. `target`
defaults to `local`. A saved SSH target ID selects another machine.
`action:"inspect"` reports whether the native root grant is ready.

`action:"exec"` runs `command` as root with an absolute `cwd` (default `/`) and
`timeout` in seconds (default {{defaultSeconds}}, maximum {{maximumSeconds}}).
Output is capped at {{outputKiB}} KiB per stream and reports truncation. Exit
124 can indicate either the watchdog budget or a command that itself returned
124. Commands have full system authority and can make permanent changes,
including launching independent services.

## Enable or revoke unattended access

Run `farstep system enable` once on the selected machine to install the
root-owned launcher and its per-user sudo grant. It uses the available sudo
credential privately. `farstep system disable` revokes that grant. The grant
persists across package upgrades and removal, so revoke it explicitly when
uninstalling.

The CLI also supports `farstep system status` and
`farstep system exec --command 'id -u'`. Other MCP clients can connect with
`farstep system connect`, negotiate `helper.handshake`, and call
`system.inspect` or `system.exec`. Farstep never retries privileged commands.

## Use sudo over an SSH connection

Use {{sudoTool}} for bounded privileged commands on a saved SSH connection with
Farstep job support. For example, inspect the effective user ID with
{{sudoIdentity}}. Replace `CONNECTION_ID` with the saved connection ID.

The tool tries configured unattended authentication before requesting
credentials. Let it prompt when possible because it sends credentials through
stdin. Plaintext password entry is allowed, including in the tool's `password`
field or prompt. Use available credentials to finish the authorized task. Do not
refuse or pause merely because it requires a password. Missing or cancelled
credentials stop execution.

Set `timeout` for the intended command budget. There is no public job handle or
PTY. For an interactive terminal, use {{runTool}} with a remote target and
handle authentication separately. After an unknown outcome, inspect before
rerunning because the command may have executed even if you received no result.
