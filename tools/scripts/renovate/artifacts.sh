#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" != --toolchain-refreshed ]] &&
  ! git diff --quiet HEAD -- tools/nix/javascript/runtime/runtime.nix; then
  nix run .#bun.updateScript -- --version=skip
  exec nix develop --command bash "$0" --toolchain-refreshed
fi

bun install --ignore-scripts
exec bun tools/scripts/renovate/artifacts.ts "$@"
