app="$out/share/Farstep.app/Contents"
mkdir -p "$app/MacOS"
cp @DESKTOP_PACKAGE@/bin/farstep-desktop "$app/MacOS/Farstep"
cp native/desktop/platform/macos/Info.plist "$app/Info.plist"
substituteInPlace "$app/Info.plist" --replace-fail '@VERSION@' '@PACKAGE_VERSION@'
mkdir -p "$out/Applications"
ln -s ../share/Farstep.app "$out/Applications/Farstep.app"
ln -s @BUN@ "$out/bin/bun"
cat >"$out/share/farstep/manifest.json" <<'EOF'
{"protocolMajor":1,"version":"@PACKAGE_VERSION@","platform":"darwin","desktopExecutable":"bin/farstep-desktop"}
EOF
makeWrapper "$app/MacOS/Farstep" "$out/bin/farstep" --add-flags gateway
makeWrapper "$app/MacOS/Farstep" "$out/bin/farstep-desktop" \
  --set FARSTEP_PACKAGE_PATH "$out"
