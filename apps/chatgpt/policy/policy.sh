#!/bin/sh
set -eu

repo=${AI_TOOLS_REPO:-}
if [ -z "$repo" ]; then
  script=$0
  while [ -L "$script" ]; do
    link=$(readlink "$script")
    case "$link" in
    /*) script=$link ;;
    *) script=$(dirname "$script")/$link ;;
    esac
  done
  repo=$(CDPATH='' cd -- "$(dirname -- "$script")/../../.." && pwd)
fi

exec nix run "path:$repo#ai-tools" -- chatgpt policy patch "$@"
