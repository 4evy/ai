import 'tools/just/just.just'

# Focused checks and the complete repository check
mod check 'tools/just/check/check.just'

# Source formatting
mod fmt 'tools/just/fmt/fmt.just'

# Rust workspace builds and tests
mod rust 'tools/just/rust/rust.just'

# Nix evaluation, builds, apps, and dependency expressions
mod nix 'tools/just/nix/nix.just'

# Pinned OMP releases and patches
mod omp 'tools/just/omp/omp.just'

# Pinned Ghidra MCP source
mod ghidra 'tools/just/ghidra/ghidra.just'

# Bundled Sky synchronization and verification
mod sky 'tools/just/sky/sky.just'

# Native Farstep packages and desktop extensions
mod farstep 'tools/just/farstep/farstep.just'

# Generated configs and Nix exports
mod config 'tools/just/config/config.just'

# List the command tree, or show a recipe: just help omp patches check
[default]
help *path:
    @if (( $# )); then {{ self }} --show "$*"; else {{ self }} --list --list-submodules --unsorted; fi

# Install all development dependencies without lifecycle scripts
install:
    bun install --frozen-lockfile --ignore-scripts
    bun install --cwd tools/scripts/dependencies --frozen-lockfile --ignore-scripts

# Build root tools and all workspaces with Vite
build:
    bun run build

# Enter the Nix dev shell, or run a command inside it
dev *args:
    if (( $# )); then nix develop --command "$@"; else nix develop; fi
