# Job control gives the watchdog a separate group, so its sleep is also reaped
# The privileged watchdog runs as root and can terminate its command group
bounded() {
  local seconds=$1 command_pid watchdog_pid command_status budget_expired=0
  shift
  trap 'budget_expired=1' USR1
  set -m
  "$@" <&0 &
  command_pid=$!
  (
    sleep "$seconds"
    kill -USR1 "$$"
    @ANNOUNCE@
    kill -TERM -- "-$command_pid" 2>/dev/null
    sleep 2
    kill -KILL -- "-$command_pid" 2>/dev/null
  ) </dev/null @REDIRECT@ &
  watchdog_pid=$!
  set +m
  wait "$command_pid" 2>/dev/null
  command_status=$?
  if [ "$budget_expired" -ne 0 ]; then
    wait "$command_pid" 2>/dev/null
    wait "$watchdog_pid" 2>/dev/null
    command_status=124
  else
    kill -TERM -- "-$watchdog_pid" 2>/dev/null
    wait "$watchdog_pid" 2>/dev/null
  fi
  trap - USR1
  return "$command_status"
}
