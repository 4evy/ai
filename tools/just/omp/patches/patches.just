import '../../just.just'
set working-directory := '../../../..'
set default-list

# Regenerate npm patches from their maintained sources
sync:
    bun tools/scripts/omp/patches/patches.ts

# Verify runtime patches against the pinned upstream source
check:
    bun tools/scripts/omp/runtime/runtime.ts --check-patches
