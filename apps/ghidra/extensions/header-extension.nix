{
  lib,
  stdenvNoCC,
  ghidra-bin,
}:
{
  pname,
  version,
  src,
  extensionName,
  description,
  homepage,
  license,
  headersRoot ? ".",
  licenseFile ? "LICENSE",
  patches ? [ ],
  entryHeaders,
  includePaths ? [ "." ],
  profiles,
}:
stdenvNoCC.mkDerivation {
  inherit
    pname
    version
    src
    patches
    ;
  dontBuild = true;
  installPhase = ''
    runHook preInstall
    module="$out/lib/ghidra/Ghidra/Extensions/${extensionName}"
    mkdir -p "$module/data/headers" "$module/data/parserprofiles" "$module/ghidra_scripts"
    cp -R ${headersRoot}/. "$module/data/headers/"
    find "$module/data/headers" -type f ! -name '*.h' -delete
    install -Dm644 ${licenseFile} "$module/LICENSE"
    touch "$module/Module.manifest" "$module/.dbDirLock"
    cat > "$module/extension.properties" <<'EOF'
    name=${extensionName}
    description=${description}
    author=Upstream contributors
    createdOn=
    version=${lib.getVersion ghidra-bin}
    EOF
    ${lib.strings.concatStringsSep "\n" (
      lib.attrsets.mapAttrsToList (name: profile: ''
        cat > "$module/data/parserprofiles/${name}.prf" <<EOF
        ${lib.strings.concatStringsSep "\n" (map (header: "$module/data/headers/${header}") entryHeaders)}

        ${lib.strings.concatStringsSep "\n" profile.flags}

        ${lib.strings.concatStringsSep "\n" (map (path: "$module/data/headers/${path}") includePaths)}

        ${profile.language}

        ${profile.compiler}
        EOF
      '') profiles
    )}
    cp ${./InstallHeaderProfiles.java} "$module/ghidra_scripts/Install${extensionName}Profiles.java"
    substituteInPlace "$module/ghidra_scripts/Install${extensionName}Profiles.java" \
      --replace-fail InstallHeaderProfiles Install${extensionName}Profiles \
      --replace-fail @profilesDirectory@ "$module/data/parserprofiles"
    runHook postInstall
  '';
  meta = {
    inherit description homepage license;
    platforms = ghidra-bin.meta.platforms;
    maintainers = [ lib.maintainers._4evy ];
    sourceProvenance = [ lib.sourceTypes.fromSource ];
  };
}
