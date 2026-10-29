import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { render } from "@ai/values/template/template";
import { escapeXmlAttribute } from "@oh-my-pi/pi-utils/sanitize-text";
import { tuple } from "@optique/core/constructs";
import { formatMessage } from "@optique/core/message";
import { parseSync } from "@optique/core/parser";
import { argument } from "@optique/core/primitives";
import { valibot } from "@optique/valibot";
import * as v from "valibot";
import { run } from "../../common";

const template = readFileSync(new URL("./msi.wxs", import.meta.url), "utf8");

function hash(value: string) {
  return createHash("sha256").update(`4evy.Farstep:${value}`).digest("hex");
}

function guid(value: string) {
  const hex = hash(value).slice(0, 32);
  return `{${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}}`.toUpperCase();
}

export function windowsProductCode(version: string, architecture: string) {
  return guid(`product:${version}:${architecture}`);
}

export async function packageMsi(
  payload: string,
  version: string,
  architecture: string,
  compiler: string,
) {
  const productCode = windowsProductCode(version, architecture);
  await writeFile(
    join(payload, "share/farstep/manifest.json"),
    JSON.stringify({
      protocolMajor: 1,
      version,
      platform: "win32",
      architecture,
      productCode,
    }),
  );
  const references: string[] = [];
  async function directory(relative: string, id: string): Promise<string> {
    const entries = (
      await readdir(join(payload, relative), { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name));
    const key = hash(`${version}:${architecture}:${relative}`).slice(0, 24);
    const component = `C_${key}`;
    references.push(`<ComponentRef Id="${component}" />`);
    const files = entries
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const path = join(payload, relative, entry.name);
        return `<File Id="F_${hash(`${relative}/${entry.name}`).slice(0, 24)}" Source="${escapeXmlAttribute(path)}" />`;
      })
      .join("\n");
    const children: string[] = [];
    for (const entry of entries.filter((entry) => entry.isDirectory())) {
      const child = `${relative}/${entry.name}`;
      children.push(await directory(child, `D_${hash(child).slice(0, 24)}`));
    }
    return `<Directory Id="${id}" Name="${escapeXmlAttribute(basename(relative))}">
      <Component Id="${component}" Guid="${guid(`directory:${version}:${architecture}:${relative}`)}">
        <RegistryValue Root="HKCU" Key="Software\\4evy\\Farstep\\packages\\${version}\\${key}" Name="Installed" Type="integer" Value="1" KeyPath="yes" />
        <RemoveFolder Id="R_${key}" On="uninstall" />
        ${files}
      </Component>
      ${children.join("\n")}
    </Directory>`;
  }
  const directories: string[] = [];
  for (const name of ["bin", "lib", "share"])
    directories.push(await directory(name, `D_${name}`));
  const command = (action: string) =>
    escapeXmlAttribute(
      `"[System64Folder]WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "[INSTALLFOLDER]share\\farstep\\install.ps1" -PackagePath "[INSTALLFOLDER]." -Action ${action} -Manager winget -Owner [UserSID]`,
    );
  // MSI compares three version fields, so check the full build before removal
  const versionCheck = Buffer.from(
    `
$ErrorActionPreference = 'Stop'
$path = Join-Path $env:LOCALAPPDATA 'Farstep/state/installer.json'
if (Test-Path -LiteralPath $path) {
  $record = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
  if ($record.packageVersion -and [version]$record.packageVersion -ge [version]'${version}') {
    throw 'Select a newer Farstep build for upgrade'
  }
}
`,
    "utf16le",
  ).toString("base64");
  const check = escapeXmlAttribute(
    String.raw`"[System64Folder]WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${versionCheck}`,
  );
  const source = render(template, {
    VERSION: version,
    PRODUCT_CODE: productCode,
    UPGRADE_CODE: guid(`upgrade:${architecture}`),
    ROOT_GUID: guid(`root:${version}:${architecture}`),
    DIRECTORIES: directories.join("\n"),
    COMPONENTS: references.join("\n"),
    ACTIVATE: command("activate"),
    DEACTIVATE: command("uninstall"),
    CHECK_VERSION: check,
  });
  const input = join(payload, "farstep.wxs");
  const artifact = join(payload, `farstep-${version}-windows-${architecture}.msi`);
  await writeFile(input, source);
  await run([compiler, "build", "-arch", architecture, "-o", artifact, input], payload);
  return artifact;
}

if (import.meta.main) {
  const text = valibot(v.pipe(v.string(), v.nonEmpty()), { placeholder: "" });
  const parsed = parseSync(
    tuple([argument(text), argument(text), argument(text)]),
    process.argv.slice(2),
  );
  if (!parsed.success) throw new Error(formatMessage(parsed.error));
  const [payload, version, compiler] = parsed.value;
  console.log(await packageMsi(payload, version, process.arch, compiler));
}
