{
  lib,
  stdenvNoCC,
  bun,
  ai-javascript-dependencies,
}:
let
  source = import ../../tools/nix/source/source.nix { inherit lib; };
  metadata = lib.trivial.importJSON ../package.json;
in
stdenvNoCC.mkDerivation {
  pname = "farstep-extensions";
  inherit (metadata) version;
  src = source [
    ../../tsconfig.json
    (lib.fileset.difference ../native/desktop/platform/linux/extensions ../native/desktop/platform/linux/extensions/kde/bridge)
    ../../tools/scripts/vite/desktop.ts
    ../../tools/scripts/vite/options.ts
    # The builder's Effect runtime is independent of compiled workspace code
    ../../packages/runtime/package.json
    ../../packages/runtime/effect/effect.ts
    ../../packages/runtime/effect/observability/observability.ts
  ];
  nativeBuildInputs = [ bun ];
  strictDeps = true;
  dontConfigure = true;

  postPatch = ''
    bash ${../../tools/nix/javascript/link-dependencies.sh} \
      ${ai-javascript-dependencies} "$PWD/node_modules"
    mkdir -p node_modules/@ai
    ln -s ../../packages/runtime node_modules/@ai/runtime
  '';
  buildPhase = ''
    runHook preBuild
    export HOME="$TMPDIR"
    bun farstep/native/desktop/platform/linux/extensions/build.ts \
      --bundler vite --out dist/extensions
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    mv dist/extensions "$out"
    runHook postInstall
  '';

  meta = {
    description = "Farstep Linux desktop workspace extensions";
    homepage = "https://github.com/4evy/ai";
    license = lib.licenses.mit;
    maintainers = [ lib.maintainers._4evy ];
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
    ];
  };
}
