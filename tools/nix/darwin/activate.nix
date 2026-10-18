{
  pkgs,
  lib,
  homeDirectory,
  file,
  activation,
}:
let
  files = lib.lists.sortOn (entry: builtins.stringLength entry.target) (
    builtins.filter (entry: entry.enable) (builtins.attrValues file)
  );
  targets = map (entry: entry.target) files;
  sourceStorePath =
    entry:
    if builtins.hasContext (toString entry.source) then
      entry.source
    else
      builtins.path {
        path = entry.source;
        name = lib.hm.strings.storeFileName (baseNameOf entry.source);
      };
  tree = pkgs.runCommand "ai-user-files" { nativeBuildInputs = [ pkgs.lndir ]; } (
    ''
      mkdir -p "$out"
    ''
    + lib.strings.concatMapStringsSep "\n" (
      entry:
      let
        source = lib.strings.escapeShellArg (toString (sourceStorePath entry));
      in
      ''
        target="$out"/${lib.strings.escapeShellArg entry.target}
        # Reject overlaps that would write through a directory symlink
        resolved=$(realpath -m "$target")
        case "$resolved" in
          "$out"/*) ;;
          *) echo "AI file target escapes the file tree: $target" >&2; exit 1 ;;
        esac
        mkdir -p "$(dirname "$target")"
      ''
      + (
        if entry.recursive then
          ''
            if [[ -d ${source} ]]; then
              mkdir -p "$target"
              lndir -silent ${lib.strings.optionalString entry.ignorelinks "-ignorelinks"} ${source} "$target"
            else
              ln -s ${source} "$target"
            fi
          ''
        else
          ''
            ln -s ${source} "$target"
          ''
      )
      + lib.strings.optionalString (entry.executable != null) ''
        if [[ -f "$target" ]]; then
          copy=$(mktemp)
          cp --remove-destination "$target" "$copy"
          mv -fT "$copy" "$target"
          chmod ${if entry.executable then "+x" else "-x"} "$target"
        elif [[ -d "$target" && ! -L "$target" ]]; then
          while IFS= read -r -d "" leaf; do
            [[ -f "$leaf" ]] || continue
            copy=$(mktemp)
            cp --remove-destination "$leaf" "$copy"
            mv -fT "$copy" "$leaf"
            chmod ${if entry.executable then "+x" else "-x"} "$leaf"
          done < <(find "$target" \( -type f -o -type l \) -print0)
        fi
      ''
    ) files
  );
  manifest = pkgs.runCommand "ai-user-links.json" { nativeBuildInputs = [ pkgs.jaq ]; } ''
    while IFS= read -r -d "" target; do
      source=$(readlink -- "$target" || printf '%s' "$target")
      printf '%s\0%s\0' "''${target#${tree}/}" "$source"
    done < <(find ${tree} \( -type l -o -type f \) -print0) |
      jaq -Rs 'split("\u0000") | .[:-1] as $pairs |
        reduce range(0; ($pairs | length); 2) as $i
          ({}; . + {($pairs[$i]): $pairs[$i + 1]})' > "$out"
  '';
  fileRoot = pkgs.linkFarm "ai-user-file-root" { home-files = tree; };
  linker = pkgs.writeShellScript "link-ai-user-files" ''
    exec ${pkgs.bash}/bin/bash ${
      pkgs.replaceVars ./link-files.sh {
        inherit manifest;
        forcedPaths = lib.strings.escapeShellArgs (
          map (entry: entry.target) (builtins.filter (entry: entry.force) files)
        );
      }
    } "$@"
  '';
  changedFiles = builtins.filter (entry: entry.onChange != "") files;
  dag = lib.hm.dag.topoSort (
    lib.attrsets.mapAttrs (
      _: entry:
      entry
      // {
        after = lib.lists.unique (entry.after ++ [ "checkLinkTargets" ]);
      }
    ) activation
    // {
      checkLinkTargets = lib.hm.dag.entryBefore [ "writeBoundary" ] ''
        ${linker} check
      '';
      writeBoundary = lib.hm.dag.entryAnywhere "";
      checkFilesChanged = lib.hm.dag.entryBefore [ "linkGeneration" ] (
        ''
          declare -A changedAiFiles=()
          aiFilesEqual() {
            if [[ -d "$1" && -d "$2" ]]; then
              diff -rq -- "$1" "$2" >/dev/null 2>&1
            else
              cmp -s -- "$1" "$2"
            fi
          }
        ''
        + lib.strings.concatMapStringsSep "\n" (
          entry:
          let
            target = lib.strings.escapeShellArg entry.target;
          in
          ''
            if ${
              if entry.recursive then "true" else "! aiFilesEqual ${tree}/${target} \"$HOME\"/${target}"
            }; then
              changedAiFiles[${target}]=1
            fi
          ''
        ) changedFiles
        + ''
          unset -f aiFilesEqual
        ''
      );
      linkGeneration = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        ${linker} apply
      '';
      onFilesChange = lib.hm.dag.entryAfter [ "linkGeneration" ] (
        lib.strings.concatMapStringsSep "\n" (entry: ''
          if [[ -v changedAiFiles[${lib.strings.escapeShellArg entry.target}] ]]; then
            (
              ${entry.onChange}
            )
          fi
        '') changedFiles
      );
    }
  );
in
assert lib.assertMsg (lib.lists.allUnique targets) "Conflicting managed AI file targets";
assert lib.assertMsg (dag ? result) "Cycle in borrowed AI module activation";
pkgs.writeShellScriptBin "activate-ai-user" ''
  set -euo pipefail
  if [[ "$HOME" != ${lib.strings.escapeShellArg homeDirectory} ]]; then
    echo "AI activation must run with the configured primary user's home" >&2
    exit 1
  fi
  export newGenPath=${fileRoot}
  export PATH=${
    lib.strings.escapeShellArg (
      lib.makeBinPath [
        pkgs.coreutils
        pkgs.findutils
        pkgs.jaq
        pkgs.diffutils
      ]
    )
  }:"$PATH"
  errorEcho() { printf '%s\n' "$*" >&2; }
  verboseEcho() { if [[ -v VERBOSE ]]; then printf '%s\n' "$*"; fi; }
  run() { "$@"; }
  # Upstream fragments can contain direct writes, so skip the entire DAG
  if [[ -v DRY_RUN ]]; then
    ${linker} check
    echo "Dry run: AI file targets checked; activation skipped"
    exit 0
  fi
  ${lib.strings.concatMapStringsSep "\n" (entry: entry.data) dag.result}
''
