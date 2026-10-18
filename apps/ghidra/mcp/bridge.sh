export GHIDRA_MCP_STATE="${GHIDRA_MCP_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/ghidra-mcp-headless}"
umask 077
mkdir -p "$GHIDRA_MCP_STATE"/{tmp,runtime}
chmod 700 "$GHIDRA_MCP_STATE/runtime"
export TMPDIR="${TMPDIR:-$GHIDRA_MCP_STATE/tmp}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-$GHIDRA_MCP_STATE/runtime}"
export PYTHONDONTWRITEBYTECODE=1 PYTHONNOUSERSITE=1
export GHIDRA_MCP_URL="${GHIDRA_MCP_URL:-http://${GHIDRA_MCP_CONNECT_HOST:-127.0.0.1}:${GHIDRA_MCP_PORT:-8089}}"
exec "$GHIDRA_MCP_BRIDGE" \
  --transport "${GHIDRA_MCP_BRIDGE_TRANSPORT:-stdio}" \
  --mcp-host "${GHIDRA_MCP_BRIDGE_HOST:-127.0.0.1}" \
  --mcp-port "${GHIDRA_MCP_BRIDGE_PORT:-8090}" --no-lazy "$@"
