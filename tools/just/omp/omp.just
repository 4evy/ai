import '../just.just'
set working-directory := '../../..'
set default-list

# Runtime patch verification and npm patch regeneration
mod patches 'patches/patches.just'

# Refresh the pinned release, or select a version explicitly
update version='':
    bun tools/scripts/omp/update.ts {{ if version == "" { "" } else { quote(version) } }}
