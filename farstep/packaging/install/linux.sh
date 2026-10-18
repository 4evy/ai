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
cp -R "$target/extensions/." "$out/share/farstep/"
chmod -R u+w "$out/share/farstep"
substituteInPlace "$out/share/farstep/native/workspaces.conf" \
  --replace-fail 'exec_always --no-startup-id gjs' 'exec_always --no-startup-id @GJS_BINARY@'
cmake -S native/desktop/platform/linux/extensions/kde/bridge -B kde-bridge \
  -DCMAKE_INSTALL_PREFIX="$out"
cmake --build kde-bridge --parallel "$NIX_BUILD_CORES"
cmake --install kde-bridge
substituteInPlace "$out/share/farstep/kde/farstep-workspaces.service.in" \
  --replace-fail '@GJS@' '@GJS_BINARY@'
