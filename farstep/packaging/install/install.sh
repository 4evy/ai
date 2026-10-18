runHook preInstall
root="$out/lib/farstep"
target="$root/farstep"
mkdir -p "$out/lib" "$out/bin" "$out/share/farstep"
ln -s @JAVASCRIPT@ "$root"
