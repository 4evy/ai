@PRELUDE@@WORKSPACE@
printf '%s\n' @RECORD@ | cmp -s - "$directory/record.json" || fail "Workspace record changed; inspect before removing"
rm -rf -- "$directory"
