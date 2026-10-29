makeWrapper @BUN@ "$out/bin/farstep" \
  --set FARSTEP_PACKAGE_PATH "$out" \
  --prefix PATH : "@GATEWAY_PATH@" \
  --add-flags "$target/runtime/main.js"
makeWrapper @DESKTOP@ "$out/bin/farstep-desktop" \
  --set FARSTEP_PACKAGE_PATH "$out" \
  --set FARSTEP_NESTED_SWAY '@SWAY@' \
  --set FARSTEP_NESTED_GRIM '@GRIM@' \
  --prefix PATH : '@DESKTOP_PATH@'
cp manifest.json native/desktop/platform/linux/*.in "$out/share/farstep/"
cp -R @EXTENSIONS@/. "$out/share/farstep/"
chmod -R u+w "$out/share/farstep"
substituteInPlace "$out/share/farstep/native/workspaces.conf" \
  --replace-fail 'exec_always --no-startup-id gjs' 'exec_always --no-startup-id @GJS_BINARY@'
# Keep the bridge's installed QML directory intact for its sibling-library RPATH
ln -s @KDE_BRIDGE@/share/farstep/kde/contents/ui/bridge \
  "$out/share/farstep/kde/contents/ui/bridge"
substituteInPlace "$out/share/farstep/kde/farstep-workspaces.service.in" \
  --replace-fail '@GJS@' '@GJS_BINARY@'
