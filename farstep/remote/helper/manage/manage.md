# manage

## artifact

Build or copy the trusted Farstep Nix output into the target store and provide
its absolute /nix/store path. Use plan before activation

## activationgated

Maintenance remains gated. Inspect activation state and resume upgrade with this
token. Action upgrade with subcommand cancel is safe only after the original
Nix output is restored.
