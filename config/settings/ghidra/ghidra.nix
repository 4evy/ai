{ host }:
{
  command = host.ghidraBridge or "ai";
  args =
    host.ghidraArgs or (
      if host ? ghidraBridge then
        [ ]
      else
        [
          "ghidra"
          "mcp"
          "bridge"
        ]
    );
  env = {
    GHIDRA_MCP_URL = host.ghidraUrl or "http://127.0.0.1:8089";
  }
  // (host.ghidraEnvironment or { });
  enabled = host.ghidraEnabled or true;
}
