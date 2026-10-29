import '../../just.just'
set working-directory := '../../../..'
set default-list

# Regenerate npm patches from their maintained sources
sync:
    bun tools/scripts/omp/patches/patches.ts

# Verify independent source hunks, both profiles, and generated npm patches
check:
    bun tools/scripts/omp/patches/patches.ts --check
