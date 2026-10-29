{
  lib,
  stdenvNoCC,
  bun,
  ai-javascript-dependencies,
}:
{
  pname,
  version,
  projects,
  paths,
}:
let
  source = import ../source/source.nix { inherit lib; };
in
stdenvNoCC.mkDerivation {
  inherit pname version;
  src = source (
    paths
    ++ [
      ../../../tsconfig.json
      ../../scripts/vite/projects.ts
      ../../scripts/vite/vite.ts
      ../../scripts/vite/options.ts
      ../../scripts/vite/install.ts
      # These are build tools, not the compiled shared packages
      ../../../packages/values/package.json
      ../../../packages/values/schema/package.ts
      ../../../packages/values/schema/input.ts
      ../../../packages/values/value/value.ts
    ]
  );
  nativeBuildInputs = [ bun ];
  strictDeps = true;
  dontConfigure = true;
  dontStrip = true;
  env.AI_BUILD_PROJECTS = lib.strings.concatStringsSep "," projects;
  buildPhase = ''
    runHook preBuild
    bash ${./link-dependencies.sh} ${ai-javascript-dependencies} node_modules
    mkdir -p node_modules/@ai
    ln -s "$PWD/packages/values" node_modules/@ai/values
    ${lib.strings.concatMapStringsSep "\n" (project: ''
      bun ${ai-javascript-dependencies}/node_modules/vite/bin/vite.js build \
        --config ${
          lib.strings.escapeShellArg (
            if project == "." then "vite.config.ts" else "${project}/vite.config.ts"
          )
        }
    '') projects}
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    bun tools/scripts/vite/install.ts "$out" --modules-only
    runHook postInstall
  '';
  meta = {
    description = "Independently compiled ${pname} JavaScript modules";
    license = lib.licenses.mit;
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
      "aarch64-darwin"
    ];
  };
}
