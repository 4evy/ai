directory="$root"/@ID@
private_directory "$directory"
[ ! -L "$directory/record.json" ] && [ -f "$directory/record.json" ] || fail "Missing managed workspace record"
