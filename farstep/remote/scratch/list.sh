for directory in "$root"/*; do
  [ -e "$directory" ] || [ -L "$directory" ] || continue
  private_directory "$directory"
  [ ! -L "$directory/record.json" ] && [ -f "$directory/record.json" ] || fail "Missing managed workspace record: $directory"
  printf '%s\t' "${directory##*/}"
  cat "$directory/record.json"
done
