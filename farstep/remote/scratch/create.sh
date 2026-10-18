directory="$root"/.create-@ID@
mkdir "$directory"
trap 'rm -rf -- "$directory"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
mkdir "$directory/work"
printf '%s\n' @RECORD@ >"$directory/record.json"
mv "$directory" "$root"/@ID@
directory="$root"/@ID@
cat "$directory/record.json"
trap - EXIT INT TERM HUP
