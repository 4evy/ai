set +x
set +v
exec 2>&1
unset BASH_ENV ENV
unset sudo_password
@BOUNDED@
auth_status=1
if [ "$auth_status" -ne 0 ]; then
  bounded @AUTH_SECONDS@ sudo -n -v </dev/null >/dev/null 2>&1
  auth_status=$?
fi
if [ "$auth_status" -ne 0 ]; then
  printf '%s' @CREDENTIALS@
  if ! IFS= read -r -t 120 sudo_password; then
    printf '%s' @REQUIRED@
    exit 1
  fi
  bounded @AUTH_SECONDS@ sudo -S -p '' -v <<<"$sudo_password" >/dev/null 2>&1
  auth_status=$?
  unset sudo_password
  if [ "$auth_status" -ne 0 ]; then
    printf '%s' @REJECTED@
    exit 1
  fi
fi
printf '%s' @STARTED@
sudo -n -- @BASH@ --noprofile --norc -c @PRIVILEGED@ </dev/null
command_status=$?
printf '%s%s%s' @DONE@ "$command_status" @END@
exit "$command_status"
