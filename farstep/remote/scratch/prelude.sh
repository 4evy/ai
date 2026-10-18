set -eu
umask 077
uid=$(id -u)
root=/tmp/omp-scratch-$uid
fail() {
  printf '%s\n' "$1" >&2
  exit 1
}
private_directory() {
  [ ! -L "$1" ] && [ -d "$1" ] || fail "Not a managed directory: $1"
  [ "$(@STAT@)" = "$uid:700" ] || fail "Directory must be owned by this user with mode 700: $1"
}
@ROOT@
private_directory "$root"
printf '%s\n' "$root"
