{
  env = import ./environment.nix;
  autoUpdatesChannel = "latest";
  attribution = {
    commit = "";
    pr = "";
    sessionUrl = false;
  };
  includeGitInstructions = false;
}
