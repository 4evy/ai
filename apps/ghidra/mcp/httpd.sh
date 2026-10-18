export GHIDRA_MCP_STATE="${GHIDRA_MCP_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/ghidra-mcp-headless}"
umask 077
mkdir -p "$GHIDRA_MCP_STATE"/{home,tmp,runtime}
chmod 700 "$GHIDRA_MCP_STATE/runtime"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-$GHIDRA_MCP_STATE/runtime}"
export TMPDIR="$GHIDRA_MCP_STATE/tmp"
export HOME="$GHIDRA_MCP_STATE/home"

classpath="$GHIDRA_MCP_JAR"
while IFS= read -r -d "" jar; do
  classpath="$classpath:$jar"
done < <(find "$GHIDRA_HOME/Ghidra" -type f -path '*/lib/*.jar' -print0)

# Environment option lists split on whitespace, without executing shell code
java_options=()
extra_args=()
read -r -a java_options <<<"${JAVA_OPTS:-}"
read -r -a extra_args <<<"${GHIDRA_MCP_EXTRA_ARGS:-}"
args=(--bind "${GHIDRA_MCP_BIND:-127.0.0.1}"
  --port "${GHIDRA_MCP_PORT:-8089}")
[[ -z "${PROGRAM_FILE:-}" ]] || args+=(--file "$PROGRAM_FILE")
[[ -z "${PROJECT_PATH:-}" ]] || args+=(--project "$PROJECT_PATH")
[[ -z "${PROGRAM_NAME:-}" ]] || args+=(--program "$PROGRAM_NAME")
[[ -z "${GHIDRA_USER:-}" ]] || java_options+=("-Duser.name=$GHIDRA_USER")

exec "$GHIDRA_MCP_JAVA" "${java_options[@]}" \
  -Dghidra.external.modules="$(<"$GHIDRA_MCP_MODULE_PATH_FILE")" \
  -Duser.home="$HOME" -Djava.io.tmpdir="$TMPDIR" \
  -Dghidra.home="$GHIDRA_HOME" -Djava.awt.headless=true \
  -Dapplication.name=GhidraMCP -cp "$classpath" \
  com.xebyte.headless.GhidraMCPHeadlessServer \
  "${args[@]}" "${extra_args[@]}" "$@"
