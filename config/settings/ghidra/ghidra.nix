{ lib, host }:
lib.attrsets.optionalAttrs ((host.ghidraBridge or "") != "") {
  ghidra = {
    command = host.ghidraBridge;
    args = host.ghidraArgs or [ ];
    env = host.ghidraEnvironment or { };
    enabled = host.ghidraEnabled or true;
  };
}
