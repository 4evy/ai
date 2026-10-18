set -euo pipefail
umask 077

state="$HOME/.local/state/ai-tools"
previous="$state/links.json"
declare -A oldLinks=() newLinks=()
forcedPaths=(@forcedPaths@)

loadLinks() {
  local manifest="$1" name="$2" path source
  local -n links="$name"
  while IFS= read -r -d '' path && IFS= read -r -d '' source; do
    # Populate the caller's associative array through the nameref
    # shellcheck disable=SC2034
    links["$path"]="$source"
  done < <(jaq -j 'to_entries[] | (.key + "\u0000" + .value + "\u0000")' "$manifest")
}

if [[ -f "$previous" ]]; then
  jaq -e 'type == "object" and all(to_entries[];
    (.value | type == "string") and
    (.key | length > 0 and (startswith("/") | not) and
      (split("/") | all(. != ".." and . != "" and . != "."))))' \
    "$previous" >/dev/null
  loadLinks "$previous" oldLinks
fi
loadLinks @manifest@ newLinks

isForced() {
  local path="$1" forced
  for forced in "${forcedPaths[@]}"; do
    if [[ "$path" == "$forced" || "$path" == "$forced/"* ]]; then
      return 0
    fi
  done
  return 1
}

isOwned() {
  local path="$1"
  [[ -v oldLinks["$path"] && -L "$HOME/$path" &&
    $(readlink -- "$HOME/$path") == "${oldLinks[$path]}" ]]
}

checkTargets() {
  local path source destination parent replacingParent blockedParent failed=0
  for path in "${!newLinks[@]}"; do
    source="${newLinks[$path]}"
    destination="$HOME/$path"
    replacingParent=0
    blockedParent=
    parent="$path"
    while [[ "$parent" == */* ]]; do
      parent="${parent%/*}"
      if [[ ! -v newLinks["$parent"] ]] && isOwned "$parent"; then
        # Cleanup removes this old directory link before placing children
        replacingParent=1
        break
      fi
      if [[ (-e "$HOME/$parent" || -L "$HOME/$parent") && ! -d "$HOME/$parent" ]]; then
        blockedParent="$parent"
      fi
    done
    if ((replacingParent)); then
      continue
    fi
    if [[ -n "$blockedParent" ]]; then
      echo "AI file parent is not a directory: $HOME/$blockedParent" >&2
      failed=1
      continue
    fi
    if isForced "$path"; then
      continue
    fi
    if [[ -e "$destination" || -L "$destination" ]]; then
      if [[ -L "$destination" && $(readlink -- "$destination") == "$source" ]] ||
        isOwned "$path" ||
        { [[ -f "$destination" && -f "$source" ]] && cmp -s -- "$destination" "$source"; }; then
        continue
      fi
      echo "Refusing to replace unmanaged AI file at $destination" >&2
      failed=1
    fi
  done
  return "$failed"
}

# Check every target before cleanup, linking, or writing ownership state
checkTargets
if [[ "$1" == check ]]; then
  exit 0
fi
if [[ "$1" != apply ]]; then
  echo "Unknown AI file activation mode: $1" >&2
  exit 1
fi

# Remove obsolete links only while their recorded source still matches
for path in "${!oldLinks[@]}"; do
  if [[ ! -v newLinks["$path"] ]] && isOwned "$path"; then
    rm -- "$HOME/$path"
  fi
done
for path in "${!newLinks[@]}"; do
  source="${newLinks[$path]}"
  destination="$HOME/$path"
  if [[ -L "$destination" && $(readlink -- "$destination") == "$source" ]]; then
    continue
  fi
  if ! isForced "$path" && [[ -f "$destination" && -f "$source" ]] &&
    cmp -s -- "$destination" "$source"; then
    continue
  fi
  if isForced "$path" && [[ -e "$destination" || -L "$destination" ]]; then
    rm -rf -- "$destination"
  fi
  mkdir -p -- "${destination%/*}"
  ln -sfnT -- "$source" "$destination"
done

mkdir -p -- "$state"
temporary=$(mktemp "$state/links.XXXXXX")
trap 'rm -f -- "$temporary"' EXIT
install -m 600 @manifest@ "$temporary"
mv -f -- "$temporary" "$previous"
