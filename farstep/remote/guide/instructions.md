Use {{runTool}} for commands and native file tools for local files. Omit target
locally; for SSH, read {{guideTool}} topic "connect" and use its saved
connection ID. Observe or control commands with {{jobTool}} and the returned
handle. Jobs need farstep on Linux and macOS; remote desktop supports Linux,
macOS and Windows.

Read the topic needed next: "run" for environments and workflows, "jobs" for
recovery, "interactive" for TUIs, "files" for remote files, "sudo" for
privileged commands, "desktop" for GUI access, or "scratch" for temporary work.
Before shared work, read "coordination" and inspect existing work.

Prefer the project's task runner and development environment. Write TypeScript
in `script`, use zx for shell commands, and pass external text through `params`
and template interpolation. {{runTool}} reloads the shared shell environment;
environment:"inherit" preserves an activated local toolchain. Check paths and
versions after environment changes. Report unavailable targets; changes to SSH
setup or security checks need approval.
