# nix-update owns the revision, snapshot date, and source hash
source_path=$(nix build .#ghidra-mcp.src --no-link --print-out-paths)
upstream_version=$(sed -nE 's/^version[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' "$source_path/pyproject.toml" | head -1)
if [[ -z "$upstream_version" ]]; then
  echo "Could not read the Ghidra MCP upstream version" >&2
  exit 1
fi
pin=apps/ghidra/mcp/source.json
temporary=$(mktemp "$pin.XXXXXX")
trap 'rm -- "$temporary"' EXIT
jq --arg upstreamVersion "$upstream_version" '
  .upstreamVersion = $upstreamVersion |
  .version = ($upstreamVersion + "-unstable-" + (.version | split("-unstable-")[1]))
' "$pin" >"$temporary"
mv "$temporary" "$pin"
trap - EXIT
bun apps/ghidra/mcp/update.ts "$source_path"
