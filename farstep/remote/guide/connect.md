# Connect to an SSH target

Call {{connectTool}} with {{connectTarget}}. Replace the placeholder with a
configured host name, OpenSSH alias or `user@host`. Use its returned ID as
{{runTool}}'s `target` or the remote file tools' `connection`.

Use the schema for connection options. Check the returned cwd and host facts
before running commands. Connect saves a profile without installing software;
local commands need no connection.

Discovery grants no SSH access. If it fails, use an explicit host or alias.
Changes to SSH setup, authentication or host-key checks require authorization.
