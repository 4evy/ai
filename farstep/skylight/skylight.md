# skylight

## sync

Copy a file (up to {{LIMIT_MIB}} MiB) between local and remote Sky targets with
SHA-256 verification. Set `expectedSha256: null` for a new destination, or
supply the destination's current hash to replace it. The destination's parent
directory must already exist. Kernels and app handles remain on their own
machines.
