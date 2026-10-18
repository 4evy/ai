os=$(uname -s) || exit
arch=$(uname -m) || exit
distribution=unknown
if [ -r /etc/os-release ]; then
  while IFS= read -r line; do
    case "$line" in ID=*)
      distribution=${line#ID=}
      distribution=${distribution#\"}
      distribution=${distribution%\"}
      ;;
    esac
  done </etc/os-release
fi
if [ "$os" = Darwin ]; then distribution=macos; fi
immutable=no
if [ -e /run/ostree-booted ] || [ -d /usr/lib/bootc ] || [ -e /etc/NIXOS ] || [ -x /usr/sbin/transactional-update ] || command -v transactional-update >/dev/null 2>&1; then immutable=yes; fi
available=
for manager in @MANAGERS@; do
  executable=$manager
  if command -v "$executable" >/dev/null 2>&1; then available="$available $manager"; fi
done
systemd=no
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then systemd=yes; fi
printf '\0@MARKER@\0%s\0%s\0%s\0%s\0%s\0%s\0@MARKER@\0' "$os" "$arch" "$distribution" "$immutable" "$available" "$systemd"
