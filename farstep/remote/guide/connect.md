# Connect to an SSH target

Call {{connectTool}} with {{connectTarget}}. Replace the placeholder with a
configured host name, OpenSSH alias or `user@host`. Use its returned ID as
{{runTool}}'s `target` or the remote file tools' `connection`.

Read the schema for connection options. Check the returned `cwd` and host facts
before running commands. {{connectTool}} saves a profile without installing
software. Local commands need no connection.

OMP sessions can share an SSH master. Connection cleanup drains that master
without closing other sessions' active helper channels. Job lifetimes still
belong to their owning session, not to the shared SSH master.

Discovery grants no SSH access. If it fails, use an explicit host or alias.
Changes to SSH setup, authentication or host-key checks require authorization.
