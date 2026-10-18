import '../just.just'
set working-directory := '../../..'
set default-list

# Install through Nix on Unix or prepare the Windows runtime
install *args:
    bun apps/ghidra/native/install.ts "$@"

# Refresh the upstream commit and fetchFromGitHub hash; defaults to main
update *args:
    {{ self }} nix update ghidra-mcp "$@"
