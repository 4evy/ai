export const currentHelper = `"\${XDG_DATA_HOME:-$HOME/.local/share}/farstep/current/bin/farstep"`;

import { quotePosixArgument } from "@ai/core/shell/shell";

export function helperCommand(connection: { info: { os: string } }, args: string[]) {
  if (connection.info.os === "windows") {
    const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;
    return `$ErrorActionPreference='Stop'; $record=Get-Content -LiteralPath (Join-Path $env:LOCALAPPDATA 'Farstep/state/installer.json') -Raw | ConvertFrom-Json; & (Join-Path $record.packagePath 'bin/farstep.cmd') ${args.map(quote).join(" ")}; exit $LASTEXITCODE`;
  }
  return `exec "\${XDG_DATA_HOME:-$HOME/.local/share}/farstep/current/bin/farstep" ${args.map(quotePosixArgument).join(" ")}`;
}
