{ lib, stdenv }:
platformsFile:
let
  platform = if stdenv.hostPlatform.isDarwin then "darwin" else "linux";
  arch = if stdenv.hostPlatform.isAarch64 then "arm64" else "x64";
  platforms = lib.importJSON platformsFile;
  matchesPlatform =
    target: values:
    let
      allowed = builtins.filter (value: !lib.hasPrefix "!" value) values;
    in
    !builtins.elem "!${target}" values
    && (allowed == [ ] || builtins.elem target allowed || builtins.elem "any" allowed);
in
name: _:
let
  constraints = platforms.${name} or { };
in
matchesPlatform platform (constraints.os or [ ]) && matchesPlatform arch (constraints.cpu or [ ])
