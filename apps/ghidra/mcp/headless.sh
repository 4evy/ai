export GHIDRA_MCP_STATE="${GHIDRA_MCP_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/ghidra-mcp-headless}"
export GHIDRA_MCP_URL="${GHIDRA_MCP_URL:-http://${GHIDRA_MCP_CONNECT_HOST:-127.0.0.1}:${GHIDRA_MCP_PORT:-8089}}"
umask 077
mkdir -p "$GHIDRA_MCP_STATE"

start_httpd="${GHIDRA_MCP_START_HTTPD:-1}"
for argument in "$@"; do
  case "$argument" in --help | -h) exec "$GHIDRA_MCP_BRIDGE" "$@" ;; esac
done
httpd_pid=""
bridge_pid=""
cleanup() {
  local pid
  for pid in "$bridge_pid" "$httpd_pid"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

ready() {
  local auth=()
  [[ -z "${GHIDRA_MCP_AUTH_TOKEN:-}" ]] || auth=(-H "Authorization: Bearer $GHIDRA_MCP_AUTH_TOKEN")
  curl --fail --silent --max-time 1 --noproxy '*' "${auth[@]}" \
    "${GHIDRA_MCP_URL%/}/check_connection" >/dev/null 2>&1
}

startup_timeout="${GHIDRA_MCP_STARTUP_TIMEOUT:-120}"
if [[ ! "$startup_timeout" =~ ^[1-9][0-9]*$ ]]; then
  echo "GHIDRA_MCP_STARTUP_TIMEOUT must be a positive integer" >&2
  exit 2
fi
log="${GHIDRA_MCP_HTTPD_LOG:-$GHIDRA_MCP_STATE/httpd.log}"
if [[ "$start_httpd" != 0 ]] && ! ready; then
  mkdir -p "$(dirname "$log")"
  "$GHIDRA_MCP_HTTPD" >>"$log" 2>&1 &
  httpd_pid=$!
fi
if [[ "${GHIDRA_MCP_SKIP_WAIT:-0}" != 1 ]]; then
  deadline=$((SECONDS + startup_timeout))
  until ready; do
    if [[ -n "$httpd_pid" ]] && ! kill -0 "$httpd_pid" 2>/dev/null; then
      status=0
      wait "$httpd_pid" || status=$?
      echo "ghidra-mcp-httpd exited with status $status; see $log" >&2
      ((status != 0)) || status=1
      exit "$status"
    fi
    if ((SECONDS >= deadline)); then
      echo "timed out after ${startup_timeout}s waiting for $GHIDRA_MCP_URL; see $log" >&2
      exit 1
    fi
    sleep 1
  done
fi

# An explicit stdin redirect preserves JSON-RPC input for the background child
"$GHIDRA_MCP_BRIDGE" "$@" <&0 &
bridge_pid=$!
status=0
wait "$bridge_pid" || status=$?
cleanup
trap - EXIT
exit "$status"
