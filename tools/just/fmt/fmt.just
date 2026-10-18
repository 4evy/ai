import '../just.just'
set working-directory := '../../..'

# Format every maintained source type with the flake's canonical formatter
[default]
all *args:
    nix fmt -- "$@"

# Format only Just sources; accepts file paths and treefmt flags
just *args:
    nix fmt -- --formatters just "$@"

# Format PowerShell with the flake's bundled engine and analyzer
powershell *args:
    nix fmt -- --formatters powershell "$@"
