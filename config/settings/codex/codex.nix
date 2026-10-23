{ lib, host }:
let
  ghidra = {
    ghidra = import ../ghidra/ghidra.nix { inherit host; };
  };
  darwin = (host.os or "") == "darwin";
  resources = host.chatgptResources or "";
  nodeRepl = host.nodeRepl or "";
  automation = nodeRepl != "" && (host.homeDirectory or "") != "";
  home = host.homeDirectory or "";
  codexHome = host.codexHome or "${home}/.codex";
  modules = "${resources}/cua_node/lib/node_modules";
  cli = host.codexCli or "";
  marketplace = "ai-chatgpt-bundled";
  farstep = lib.attrsets.optionalAttrs ((host.farstep or "") != "") (
    lib.attrsets.mapAttrs (_: server: {
      command = host.farstep;
      args = [
        server.subcommand
        "connect"
      ];
      startup_timeout_sec = 30;
      tool_timeout_sec = server.timeout;
      default_tools_approval_mode = "approve";
    }) (import ../farstep/farstep.nix)
  );
  lldb = lib.attrsets.optionalAttrs (host.lldb or false) {
    lldb = {
      command = "lldb-mcp-launcher";
      enabled = false;
      startup_timeout_sec = 30;
      tool_timeout_sec = 1800;
      default_tools_approval_mode = "approve";
      enabled_tools = [
        "command"
        "debugger_list"
      ];
    };
  };
  node = lib.attrsets.optionalAttrs automation {
    node_repl = {
      args = [ ];
      command =
        host.nodeReplWrapper or (if darwin then "${home}/.local/libexec/ai-node-repl" else nodeRepl);
      startup_timeout_sec = 120;
      tool_timeout_sec = 1800;
      default_tools_approval_mode = "approve";
      env = {
        NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS = "1000";
        NODE_REPL_NODE_MODULE_DIRS = modules;
        NODE_REPL_NODE_PATH = "${resources}/cua_node/bin/node";
        NODE_REPL_TRUSTED_CODE_PATHS = "${codexHome}:${modules}";
        CODEX_HOME = codexHome;
        BROWSER_USE_AVAILABLE_BACKENDS = "chrome,iab,mcpapps";
        BROWSER_USE_TINYSKY_ENABLED = "1";
        BROWSER_USE_CODEX_APP_BUILD_FLAVOR = "prod";
        NODE_REPL_TRUSTED_SERVICES = builtins.toJSON (
          {
            browser = "${resources}/plugins/openai-bundled/plugins/browser/scripts/browser-service.mjs";
          }
          // lib.attrsets.optionalAttrs darwin { sky = "@oai/sky/service"; }
        );
        CODEX_CLI_PATH =
          if cli != "" then
            cli
          else if darwin then
            "${resources}/codex-cli/bin/codex"
          else
            "${resources}/codex";
      }
      // lib.attrsets.optionalAttrs darwin {
        SKY_CUA_SERVICE_PATH = "${codexHome}/computer-use/Codex Computer Use.app";
      };
    };
  };
  pluginNames = [
    "codex-app-tools"
    "browser"
    "chrome"
    "computer-use"
    "deep-research"
    "visualize"
    "latex"
  ];
  profile =
    name: rule:
    lib.attrsets.recursiveUpdate (import (./. + "/${name}.nix")) {
      mcp_servers = lib.attrsets.mapAttrs (_: _: rule) (ghidra // lldb // node // farstep);
    };
in
{
  config = lib.attrsets.recursiveUpdate (import ./base.nix) (
    {
      mcp_servers = ghidra // lldb // node // farstep;
    }
    // lib.attrsets.optionalAttrs darwin {
      computer_use.default_app_access = "allow";
      tui.keymap.global.open_transcript = "ctrl-t";
    }
    // lib.attrsets.optionalAttrs ((host.notifyClient or "") != "") {
      notify = [
        host.notifyClient
        "turn-ended"
      ];
    }
    // lib.attrsets.optionalAttrs automation {
      hooks = import ./hooks.nix { inherit lib marketplace; };
      marketplaces.${marketplace} = {
        source_type = "local";
        source = "${codexHome}/.tmp/compatibility-marketplaces/${marketplace}";
      };
      plugins =
        lib.attrsets.genAttrs (map (name: "${name}@${marketplace}") pluginNames) (_: {
          enabled = true;
        })
        //
          lib.attrsets.genAttrs
            (map (name: "${name}@${marketplace}") [
              "sites"
              "user-writing"
            ])
            (_: {
              enabled = false;
            })
        // {
          "unified-computer-use@openai-bundled".mcp_servers.cua_repl = {
            default_tools_approval_mode = "approve";
          };
        };
    }
  );
  safe = profile "safe" { default_tools_approval_mode = "prompt"; };
  review = profile "review" { enabled = false; };
}
