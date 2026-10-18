{ lib, host }:
let
  ghidra = import ./ghidra/ghidra.nix { inherit host; };
  rule = action: resource: effect: { inherit action resource effect; };
in
{
  config = {
    "$schema" = "https://opencode.ai/config.json";
    share = "disabled";
    update = "auto";
    snapshots = true;
    plugins = [
      "@slkiser/opencode-quota@5.0.3"
    ];
    references = {
      opencode = {
        repository = "anomalyco/opencode";
        description = "Use for current OpenCode implementation, configuration, SDK, and documentation details; compare behavior with the installed release.";
      };
    };
    watcher = {
      ignore = [
        "**/.git/**"
        "**/.jj/**"
        "**/.cache/**"
        "**/.ansible/**"
        "**/.venv/**"
        "**/.ruby-lsp/**"
        "**/.gradle/**"
        "**/node_modules/**"
        "**/__pycache__/**"
        "**/*.egg-info/**"
        "**/.zig-cache/**"
        "**/zig-cache/**"
        "**/zig-pkg/**"
        "**/zig-out/**"
        "**/target/**"
        "**/build/**"
        "**/build-*/**"
        "**/builddir/**"
        "**/.build/**"
        "**/dist/**"
        "**/result/**"
        "**/tmp/**"
      ];
    };
    tool_output = {
      max_lines = 600;
      max_bytes = 32768;
    };
    mcp = {
      servers = {
        ghidra = {
          type = "local";
          command = [ ghidra.command ] ++ ghidra.args;
          environment = ghidra.env;
          disabled = !ghidra.enabled;
          timeout = {
            catalog = 60000;
            execution = 1800000;
          };
        };
        lldb = {
          type = "local";
          command = [
            "lldb-mcp-launcher"
          ];
          disabled = true;
          timeout = {
            catalog = 30000;
            execution = 30000;
          };
        };
      }
      // lib.attrsets.optionalAttrs ((host.farstep or "") != "") (
        lib.attrsets.mapAttrs (_: server: {
          type = "local";
          command = [
            host.farstep
            server.subcommand
            "connect"
          ];
          disabled = false;
          timeout = {
            catalog = server.timeout * 1000;
            execution = server.timeout * 1000;
          };
        }) (import ./farstep/farstep.nix)
      );
    };
    permissions = [
      (rule "*" "*" "allow")
      (rule "read" "*" "allow")
      (rule "read" "*.env" "deny")
      (rule "read" "*.env.*" "deny")
      (rule "read" "~/.ssh/**" "deny")
      (rule "read" "~/.config/gh/**" "deny")
      (rule "read" "~/.local/share/opencode/auth.json" "deny")
      (rule "read" "~/.config/opencode/auth.json" "deny")
      (rule "read" "~/.local/share/opencode/opencode.db*" "deny")
      (rule "external_directory" "*" "allow")
      (rule "shell" "*" "allow")
      (rule "shell" "sudo" "ask")
      (rule "shell" "sudo *" "ask")
      (rule "shell" "rm" "ask")
      (rule "shell" "rm *" "ask")
      (rule "shell" "rmdir" "ask")
      (rule "shell" "rmdir *" "ask")
      (rule "shell" "unlink" "ask")
      (rule "shell" "unlink *" "ask")
      (rule "shell" "git commit*" "ask")
      (rule "shell" "git push*" "ask")
      (rule "shell" "git send-pack*" "ask")
      (rule "shell" "git-push*" "ask")
      (rule "shell" "git-send-pack*" "ask")
      (rule "shell" "git lfs push*" "ask")
      (rule "shell" "jj git push*" "ask")
      (rule "shell" "jj gerrit upload*" "ask")
      (rule "shell" "git reset*" "ask")
      (rule "shell" "git restore*" "ask")
      (rule "shell" "git clean*" "ask")
      (rule "shell" "git checkout*" "ask")
      (rule "shell" "git switch*" "ask")
      (rule "shell" "git rebase*" "ask")
      (rule "shell" "git merge*" "ask")
      (rule "shell" "git cherry-pick*" "ask")
      (rule "shell" "git stash*" "ask")
      (rule "shell" "gh" "ask")
      (rule "shell" "gh *" "ask")
      (rule "shell" "gh pr view*" "allow")
      (rule "shell" "gh pr list*" "allow")
      (rule "shell" "gh issue view*" "allow")
      (rule "shell" "gh issue list*" "allow")
      (rule "shell" "gh run view*" "allow")
      (rule "shell" "gh run list*" "allow")
      (rule "shell" "gh repo view*" "allow")
      (rule "shell" "gh repo list*" "allow")
      (rule "shell" "gh release view*" "allow")
      (rule "shell" "gh release list*" "allow")
      (rule "shell" "gh pr diff*" "allow")
      (rule "shell" "gh pr checks*" "allow")
      (rule "shell" "gh pr status*" "allow")
      (rule "shell" "gh issue status*" "allow")
      (rule "shell" "gh run watch*" "allow")
      (rule "shell" "gh workflow view*" "allow")
      (rule "shell" "gh workflow list*" "allow")
      (rule "shell" "gh release download*" "allow")
      (rule "shell" "gh search*" "allow")
      (rule "shell" "gh status*" "allow")
      (rule "shell" "gh api *" "allow")
      (rule "shell" "gh api *-X*" "ask")
      (rule "shell" "gh api *--method*" "ask")
      (rule "shell" "gh api *-f*" "ask")
      (rule "shell" "gh api *-F*" "ask")
      (rule "shell" "gh api *--field*" "ask")
      (rule "shell" "gh api *--raw-field*" "ask")
      (rule "shell" "gh api *--input*" "ask")
      (rule "shell" "gh api *graphql*" "ask")
      (rule "ghidra_import_file" "*" "deny")
    ];
  };
  cli = {
    "$schema" = "https://opencode.ai/v2/cli.json";
    theme.name = "catppuccin-custom";
    plugins = [
      "@slkiser/opencode-quota@5.0.3"
    ];
    keybinds = {
      leader = "ctrl+space";
      "command.palette.show" = "ctrl+shift+p";
      "prompt.editor" = "ctrl+x";
      "session.export" = "ctrl+t";
      "session.copy" = "<leader>y";
      "agent.list" = "alt+a";
      "variant.cycle" = "alt+.,ctrl+shift+t";
      "messages.copy" = "ctrl+o";
      "input.move.up" = "up,ctrl+p";
      "input.move.down" = "down,ctrl+n";
      "input.line.home" = "home,ctrl+a";
      "input.line.end" = "end,ctrl+e";
      "input.buffer.home" = "ctrl+home";
      "input.buffer.end" = "ctrl+end";
      "input.backspace" = "backspace,shift+backspace,ctrl+h";
      "input.delete.word.backward" =
        "ctrl+w,ctrl+backspace,ctrl+shift+backspace,alt+backspace,ctrl+alt+h";
      "input.delete.word.forward" = "alt+d,alt+delete,ctrl+delete,ctrl+shift+delete";
      "prompt.history.previous" = "up,ctrl+p";
      "prompt.history.next" = "down,ctrl+n";
    };
    attention = {
      notifications = true;
      sound = true;
      volume = 0.4;
      sound_pack = "opencode.default";
    };
  };
  quota = {
    enableToast = false;
    tuiCommandDisplay = "dialog";
    showSessionTokens = false;
    sessionTokenScope = "current";
    formatStyle = "allWindows";
    percentDisplayMode = "remaining";
    tuiSidebarPanel = {
      enabled = true;
    };
    maintainerAnnouncements = {
      enabled = false;
    };
  };
}
