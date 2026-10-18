#!/bin/sh
set -eu

script=$0
while [ -L "$script" ]; do
  link=$(readlink "$script")
  case "$link" in
  /*) script=$link ;;
  *) script=$(dirname "$script")/$link ;;
  esac
done
root=${AI_TOOLS_REPO:-$(CDPATH='' cd -- "$(dirname -- "$script")/../../.." && pwd)}
exec nix run "path:$root#ai-tools" -- "$@"
