import '../just.just'
set working-directory := '../../..'
set default-list

# Synchronize Sky declarations from the pinned runtime
sync:
    bun run sky:sync

# Compare Sky declarations with the pinned runtime
check:
    bun run sky:check

# Update bundled Sky packages from upstream
update:
    bun run sky:update

# Verify bundled Sky packages against upstream
verify:
    bun run sky:verify
