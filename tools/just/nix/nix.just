import '../just.just'
set working-directory := '../../..'
set default-list

# Evaluate the flake for all supported systems without building
eval:
    nix flake check --all-systems --no-build

# Evaluate all systems, then build checks for the current system
check: eval
    nix flake check

# Build a flake package, e.g. just nix build farstep --no-link
build package='default' *args:
    nix build ".#$1" "${@:2}"

# Run a flake app, e.g. just nix run ai-tools --help
run app='default' *args:
    nix run ".#$1" -- "${@:2}"

# Update a custom upstream package and synchronize its related artifacts
update package *args:
    nix run ".#$1.updateScript" -- "${@:2}"

# Format every maintained source type; accepts file paths and treefmt flags
fmt *args:
    nix fmt -- "$@"

# Regenerate Bun-to-Nix expressions from frozen lockfiles
deps:
    bun --eval 'import { run, syncNixDependencies } from "./tools/scripts/renovate/process.ts"; await syncNixDependencies(run);'
