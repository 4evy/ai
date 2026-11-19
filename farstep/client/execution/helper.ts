export const currentHelper = `"\${XDG_DATA_HOME:-$HOME/.local/share}/farstep/current/bin/farstep"`;

import { quotePosixArgument } from "@ai/values/shell/shell";
import { systemHelper } from "../../installation";

export function unixHelperSelection(os: string): string {
  const fallback = `helper=${currentHelper}`;
  return os === "macos"
    ? `${fallback}\nif [ -x '${systemHelper}' ]; then helper='${systemHelper}'; fi`
    : fallback;
}

export function helperCommand(connection: { info: { os: string } }, args: string[]) {
  if (connection.info.os === "windows") {
    const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;
    return `$ErrorActionPreference='Stop'; $record=Get-Content -LiteralPath (Join-Path $env:LOCALAPPDATA 'Farstep/state/installer.json') -Raw | ConvertFrom-Json; & (Join-Path $record.packagePath 'bin/farstep.cmd') ${args.map(quote).join(" ")}; exit $LASTEXITCODE`;
  }
  return `exec ${currentHelper} ${args.map(quotePosixArgument).join(" ")}`;
}
