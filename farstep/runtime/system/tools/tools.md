# tools

## execute

Run a privileged Bash command on Linux/macOS or PowerShell command on Windows
through the Farstep system service with a 1–{{MAX_SECONDS}} second budget and
bounded output; commands have full system authority

## instructions

Call helper.handshake once, then system.inspect to check the service or
system.exec to run a privileged command. Farstep commands have full root or
LocalSystem authority on this machine and are never automatically retried. Set
timeout to the command's intended budget in seconds (1–{{MAX_SECONDS}}). Output
is bounded per stream and reports truncation
