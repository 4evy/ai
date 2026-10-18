import '../just.just'
set working-directory := '../../..'
set default-list

# Build a Windows MSI payload for WinGet, or pass --help
package *args:
    bun run --cwd farstep package:native "$@"

# Bundle Linux desktop extensions; accepts --desktop and --out
extensions *args:
    bun run --cwd farstep build:extensions "$@"
