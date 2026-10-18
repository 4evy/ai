# ChatGPT's appcast is not a release source supported by nix-update
# A fixed version selects the macOS archive; the default refreshes its hash
arguments=()
version=skip
while (($# > 0)); do
  case "$1" in
  --version=*) version="${1#--version=}" ;;
  --version)
    if (($# < 2)); then
      echo "--version requires a ChatGPT macOS version or skip" >&2
      exit 2
    fi
    shift
    version="$1"
    ;;
  *) arguments+=("$1") ;;
  esac
  shift
done
if [[ "$version" != skip ]]; then
  if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Use --version=MAJOR.MINOR.BUILD or --version=skip for ChatGPT" >&2
    exit 2
  fi
  pin=farstep/runtime/sky/runtime/pins.json
  temporary=$(mktemp "$pin.XXXXXX")
  trap 'rm -f -- "$temporary"' EXIT
  jq --arg version "$version" '
    (.artifacts[] | select(.platform == "darwin" and .arch == "arm64")).url =
      ("https://persistent.oaistatic.com/codex-app-prod/ChatGPT-darwin-arm64-" + $version + ".zip")
  ' "$pin" >"$temporary"
  mv "$temporary" "$pin"
  trap - EXIT
fi
set -- --version=skip "${arguments[@]}"
