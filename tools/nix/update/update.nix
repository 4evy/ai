{
  lib,
  nix-update-script,
  writeShellApplication,
  coreutils,
  diffutils,
  git,
  gnutar,
}:
{
  attrPath,
  extraArgs ? [ ],
  runtimeInputs ? [ ],
  beforeUpdate ? "",
  afterUpdate ? "",
  checkFiles ? [ ],
}:
writeShellApplication {
  name = "update-${attrPath}";
  runtimeInputs = [
    coreutils
    diffutils
    git
    gnutar
  ]
  ++ runtimeInputs;
  text = ''
    check_mode=false
    arguments=()
    for argument in "$@"; do
      if [[ "$argument" == --help || "$argument" == -h ]]; then
        ${lib.strings.escapeShellArgs (nix-update-script { })} --help
        exit 0
      fi
      if [[ "$argument" == --check ]]; then
        check_mode=true
      else
        arguments+=("$argument")
      fi
    done
    set -- "''${arguments[@]}"
    if [[ "$check_mode" == true ]]; then
      ${
        if checkFiles == [ ] then
          ''
            echo "--check is not available for ${attrPath}" >&2
            exit 2
          ''
        else
          ''
            original_root="$PWD"
            staging=$(mktemp -d)
            trap 'rm -rf -- "$staging"' EXIT
            git ls-files -z --cached --others --exclude-standard |
              while IFS= read -r -d "" file; do
                if [[ -e "$file" || -L "$file" ]]; then
                  printf '%s\0' "$file"
                fi
              done |
              tar --null -T - -cf - | tar -xf - -C "$staging"
            # nix-update consults Git even when the pinned version is current
            git init --quiet "$staging"
            cd "$staging"
          ''
      }
    fi
    ${beforeUpdate}
    ${
      lib.strings.escapeShellArgs (nix-update-script {
        inherit attrPath;
        extraArgs = [ "--flake" ] ++ extraArgs;
      })
    } "$@"
    ${lib.strings.optionalString (afterUpdate != "") ''
      (
        ${afterUpdate}
      )
    ''}
    ${lib.strings.optionalString (checkFiles != [ ]) ''
      if [[ "$check_mode" == true ]]; then
        result=0
        check_files=(${lib.strings.escapeShellArgs checkFiles})
        for file in "''${check_files[@]}"; do
          diff -u "$original_root/$file" "$file" || result=$?
        done
        exit "$result"
      fi
    ''}
  '';
}
