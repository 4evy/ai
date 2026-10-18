{
  approval_policy = "never";
  default_permissions = ":read-only";
  web_search = "cached";
  apps = {
    _default = {
      enabled = false;
    };
  };
  features = {
    apps = false;
  };
  plugins = {
    "unified-computer-use@openai-bundled" = {
      mcp_servers = {
        cua_repl = {
          enabled = false;
        };
      };
    };
  };
  mcp_servers = {
    ghidra = {
      enabled = false;
    };
  };
}
