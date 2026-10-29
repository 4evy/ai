import { formatMessage } from "@optique/core/message";
import { optional } from "@optique/core/modifiers";
import { parseSync } from "@optique/core/parser";
import { command, constant } from "@optique/core/primitives";
import { choice, run } from "../run/run.ts";

const parsed = parseSync(
  optional(command("install", constant("install"))),
  Bun.argv.slice(2),
);
if (!parsed.success) throw new Error(formatMessage(parsed.error));
const shell = choice("POWERSHELL", ["pwsh", "powershell"]);
switch (parsed.value) {
  case "install":
    await run([
      shell,
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `
      $ErrorActionPreference = 'Stop'
      if ($PSVersionTable.PSVersion.Major -lt 6) {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Scope CurrentUser -Force
      }
      Install-Module -Name PSScriptAnalyzer -RequiredVersion 1.25.0 -Scope CurrentUser -Force -Repository PSGallery
    `,
    ]);
    break;
  case undefined:
    await run([
      shell,
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `
      $ErrorActionPreference = 'Stop'
      $paths = @(git ls-files -- '*.ps1' '*.psm1' '*.psd1')
      if ($LASTEXITCODE -ne 0 -or $paths.Count -eq 0) { throw 'Cannot discover PowerShell sources' }
      & ./tools/scripts/powershell/powershell.ps1 -Check -Paths $paths
      if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    `,
    ]);
    break;
}
