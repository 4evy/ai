{
  packagesFor,
  mkSettings,
  homeManager,
}:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.ai;
  hmLib = import (homeManager + "/modules/lib/stdlib-extended.nix") lib;
  # Preserve conditions and priorities while translating the launchd namespace
  mapDefinitions =
    transform: definitions:
    if
      builtins.elem (definitions._type or "") [
        "if"
        "override"
        "order"
      ]
    then
      definitions // { content = mapDefinitions transform definitions.content; }
    else if (definitions._type or "") == "merge" then
      definitions // { contents = map (mapDefinitions transform) definitions.contents; }
    else
      transform definitions;
  routeConfig = mapDefinitions (
    definitions:
    lib.modules.mkMerge [
      (removeAttrs definitions [
        "systemd"
        "launchd"
      ])
      (lib.attrsets.optionalAttrs (definitions ? launchd) (
        mapDefinitions (launchd: {
          launchd = removeAttrs launchd [ "agents" ];
          borrowedAiAgents = launchd.agents or { };
        }) definitions.launchd
      ))
    ]
  );
  # Keep the upstream library local to borrowed modules, including their imports
  borrow =
    module:
    let
      fromPath = builtins.isPath module || builtins.isString module;
      loaded = if fromPath then import module else module;
      adapt =
        value:
        value
        // {
          _file = value._file or (if fromPath then toString module else "borrowed AI module");
          imports = map borrow (value.imports or [ ]);
          config = routeConfig (value.config or { });
        }
        # Preserve path identity for deduplication and disabledModules
        // lib.attrsets.optionalAttrs fromPath { key = value.key or (toString module); };
    in
    if lib.trivial.isFunction loaded then
      lib.trivial.setFunctionArgs (args: adapt (loaded (args // { lib = hmLib; }))) (
        lib.trivial.functionArgs loaded
      )
    else
      adapt loaded;
  user = config.system.primaryUser;
  homeDirectory = if user == null then "/var/empty" else config.users.users.${user}.home or null;
  activation = pkgs.callPackage ./activate.nix {
    lib = hmLib;
    inherit (config.home) homeDirectory file activation;
  };
in
{
  imports = [
    (lib.modules.importApply ./compat.nix { inherit homeManager; })
    (borrow (
      lib.modules.importApply ../home/home.nix {
        inherit packagesFor mkSettings;
      }
    ))
  ]
  ++ map (name: borrow (homeManager + "/modules/programs/${name}")) [
    "codex"
    "claude-code"
    "opencode.nix"
    "mcp.nix"
  ];
  options = {
    programs.ai = {
      packages = lib.options.mkOption {
        type = lib.types.listOf lib.types.package;
        default = config.home.packages;
        defaultText = lib.options.literalExpression "Packages from the borrowed AI program modules";
        description = "AI packages installed system-wide";
      };
      user = {
        enable = lib.options.mkEnableOption ''
          native activation of AI files and settings for system.primaryUser
        '';
        activationPackage = lib.options.mkOption {
          type = lib.types.package;
          readOnly = true;
          internal = true;
          description = "Native activation script for borrowed AI modules";
        };
      };
    };
    borrowedAiAgents = lib.options.mkOption {
      internal = true;
      default = { };
      type = lib.types.attrsOf (
        lib.types.submodule {
          options = {
            enable = lib.options.mkOption {
              type = lib.types.bool;
              default = true;
            };
            config = lib.options.mkOption { type = lib.types.attrsOf lib.types.anything; };
          };
        }
      );
    };
  };
  config = lib.modules.mkMerge [
    {
      home.homeDirectory = if homeDirectory == null then "/var/empty" else homeDirectory;
      environment.systemPackages = cfg.packages;
      programs.ai.user.activationPackage = activation;
    }
    (lib.modules.mkIf cfg.user.enable {
      system.requiresPrimaryUser = [ "programs.ai.user.enable" ];
      assertions = [
        {
          assertion = homeDirectory != null && homeDirectory != "/var/empty";
          message = "programs.ai.user.enable requires users.users.<primaryUser>.home";
        }
        {
          assertion = lib.lists.all (
            file:
            !file.enable
            || (
              !lib.strings.hasPrefix "/" file.target
              && lib.lists.all (
                component:
                !builtins.elem component [
                  ""
                  "."
                  ".."
                ]
              ) (lib.strings.splitString "/" file.target)
            )
          ) (builtins.attrValues config.home.file);
          message = "Borrowed AI modules must target files inside the primary user's home";
        }
      ];
      # Activate after account setup and before nix-darwin loads user agents
      system.activationScripts.users.text = lib.modules.mkAfter ''
        aiDryRunArgs=()
        aiParentArgs="$(ps -p "$PPID" -ww -o args= || true)"
        if [[ -v DRY_RUN || "$aiParentArgs" == *" --dry-run"* ]]; then
          aiDryRunArgs=(env DRY_RUN=1)
        fi
        launchctl asuser "$(id -u -- ${lib.strings.escapeShellArg user})" \
          sudo --user=${lib.strings.escapeShellArg user} --set-home -- \
          "''${aiDryRunArgs[@]}" ${lib.meta.getExe activation}
      '';
      launchd.user.envVariables = config.home.sessionVariables;
      launchd.user.agents = lib.attrsets.mapAttrs (_: agent: {
        serviceConfig = agent.config;
      }) (lib.attrsets.filterAttrs (_: agent: agent.enable) config.borrowedAiAgents);
      environment.extraInit = lib.modules.mkIf (config.home.sessionVariables != { }) ''
        if [ "$USER" = ${lib.strings.escapeShellArg user} ]; then
          ${lib.strings.concatMapAttrsStringSep "\n" (
            name: value: "export ${name}=${lib.strings.escapeShellArg value}"
          ) config.home.sessionVariables}
        fi
      '';
    })
  ];
}
