{
  approval_policy = "on-request";
  default_permissions = ":workspace";
  web_search = "cached";
  apps = {
    _default = {
      default_tools_approval_mode = "writes";
    };
  };
  plugins = {
    "unified-computer-use@openai-bundled" = {
      mcp_servers = {
        cua_repl = {
          default_tools_approval_mode = "prompt";
        };
      };
    };
  };
  mcp_servers = {
    ghidra = {
      default_tools_approval_mode = "prompt";
    };
  };
}
