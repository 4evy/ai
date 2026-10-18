home=$HOME
case "$home" in /*) ;; *)
  printf "%s\n" "Remote HOME is missing or not absolute" >&2
  exit 71
  ;;
esac
cd -- @DIRECTORY@ || exit 72
directory=$(
  pwd -P
  printf x
)
directory=${directory%x}
directory=${directory%?}
bash=$(command -v bash) || exit 73
case "$bash" in /*) ;; *) exit 73 ;; esac
[ -x "$bash" ] || exit 73
"$bash" -c 'test -n "$BASH_VERSION"' || exit 73
zsh=$(command -v zsh 2>/dev/null) || zsh=
case "$zsh" in /*) [ -x "$zsh" ] && "$zsh" -f -c 'test -n "$ZSH_VERSION"' || zsh= ;; *) zsh= ;; esac
deadline=$(command -v timeout 2>/dev/null) || deadline=
case "$deadline" in /*) if [ -x "$deadline" ]; then
  version=$("$deadline" --version 2>/dev/null)
  case "$version" in *"GNU coreutils"*) ;; *) deadline= ;; esac
else deadline=; fi ;; *) deadline= ;; esac
arch=$(uname -m) || exit 74
printf '\0@MARKER@\0%s\0%s\0%s\0%s\0%s\0%s\0@MARKER@\0' "$home" "$directory" "$bash" "$deadline" "$arch" "$zsh"
