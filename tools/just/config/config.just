import '../just.just'
set working-directory := '../../..'
set default-list

# Generate writable configs; accepts --from, --host-file, and --overrides
generate *args:
    bun config/settings/generate/generate.ts "$@"

# Print detected host context as JSON without generating configs
host:
    bun config/settings/generate/generate.ts --print-host

# Build a portable config export at .generated/portable
export:
    mkdir -p .generated
    nix build .#ai-configs --out-link .generated/portable
