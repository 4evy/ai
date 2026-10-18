import '../just.just'
# Module recipes still run from the repository root
set working-directory := '../../..'

# Run all repository checks, including Just source formatting
[default]
all: just
    bun run check

# Check the root Justfile and every imported/module source
just:
    {{ self }} --fmt --check
    find tools/just -type f -name '*.just' -print0 | while IFS= read -r -d '' file; do {{ quote(just_executable()) }} --justfile "$file" --fmt --check; done

# Check TypeScript/JavaScript formatting and lint
biome:
    bun run check:biome

# Check GitHub Actions syntax and security
github:
    bun run check:github

# Build root tools, workspaces, and Linux desktop extension bundles
build:
    bun run build

# Check Rust formatting and the supported feature matrix with Clippy
rust:
    bun run check:rust

# Typecheck the root, workspaces, OMP, and Farstep
types:
    bun run typecheck

# Check unused, unlisted, and unresolved dependencies
dependencies:
    bun run check:dependencies

# Report dependency usage without failing on findings
report:
    bun run dependencies:report

# Check module boundaries with dependency-cruiser
architecture:
    bun run check:architecture

# Check bundled Sky files without querying upstream
sky:
    bun run check:sky

# Check all OMP runtime patches and generated npm patches
patches:
    bun run check:patches

# Check PowerShell scripts with PSScriptAnalyzer (requires pwsh)
powershell:
    bun run check:powershell
