import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attempt, run } from "@ai/runtime/effect/effect";
import { temporaryDirectory } from "@ai/runtime/effect/fs/fs";
import { executeCommand } from "@ai/runtime/effect/process/process";
import { Effect } from "effect";
import * as v from "valibot";
import { powershell, quote } from "../state/state";

const metadataSchema = v.object({
  version: v.pipe(v.string(), v.regex(/^\d+\.\d+\.\d+\.[1-9]\d*$/u)),
  platform: v.literal("win32"),
  architecture: v.picklist(["x64", "arm64"]),
  productCode: v.pipe(
    v.string(),
    v.regex(/^\{[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\}$/iu),
  ),
});

const winget = Effect.fnUntraced(function* (args: string[]) {
  const { code, stdout, stderr } = yield* executeCommand([
    "winget.exe",
    ...args,
    "--disable-interactivity",
  ]);
  if (code !== 0)
    return yield* Effect.fail(
      new Error(`WinGet failed (${code}): ${(stderr || stdout).trim()}`),
    );
  return stdout;
});

export const installPackageEffect = Effect.fnUntraced(function* (packagePath: string) {
  if (!Bun.which("winget.exe"))
    return yield* Effect.fail(
      new Error("Farstep requires WinGet from Windows App Installer"),
    );
  const metadata = yield* attempt(async () =>
    v.parse(
      metadataSchema,
      await Bun.file(join(packagePath, "share/farstep/manifest.json")).json(),
    ),
  );
  const artifact = Bun.file(
    join(
      packagePath,
      `farstep-${metadata.version}-windows-${metadata.architecture}.msi`,
    ),
  );
  if (!(yield* attempt(() => artifact.exists())))
    return yield* Effect.fail(
      new Error(
        "Use a newly built Windows payload with its matching installer for install or upgrade",
      ),
    );
  const sha256 = new Bun.CryptoHasher("sha256")
    .update(yield* attempt(() => artifact.arrayBuffer()))
    .digest("hex");
  const exported = yield* winget(["settings", "export"]);
  const settings = yield* Effect.try({
    try: () => JSON.parse(exported),
    catch: (error) => error,
  });
  if (settings.adminSettings?.LocalManifestFiles !== true) {
    yield* attempt(
      () =>
        powershell(`& ${quote(join(packagePath, "share/farstep/install/winget.ps1"))}`),
      { awaitOnInterrupt: true },
    );
    const reexported = yield* winget(["settings", "export"]);
    const enabled = yield* Effect.try({
      try: () => JSON.parse(reexported),
      catch: (error) => error,
    });
    if (enabled.adminSettings?.LocalManifestFiles !== true)
      return yield* Effect.fail(
        new Error("WinGet local manifests are disabled by policy"),
      );
  }
  const directory = yield* temporaryDirectory(join(tmpdir(), "farstep-winget-"));
  const route = `/${randomUUID()}/farstep.msi`;
  // WinGet manifests accept HTTP(S) installer URLs, including local builds
  const server = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch(request) {
            if (
              new URL(request.url).pathname !== route ||
              !["GET", "HEAD"].includes(request.method)
            )
              return new Response(null, { status: 404 });
            return new Response(request.method === "HEAD" ? null : artifact, {
              headers: {
                "Content-Type": "application/octet-stream",
                "Content-Length": String(artifact.size),
              },
            });
          },
        }),
      catch: (error) => error,
    }),
    (server) =>
      attempt(async () => {
        await server.stop(true);
      }).pipe(Effect.orDie),
  );
  const manifest = join(directory.path, "4evy.Farstep.yaml");
  const value = {
    PackageIdentifier: "4evy.Farstep",
    PackageVersion: metadata.version,
    PackageLocale: "en-US",
    Publisher: "4evy",
    PackageName: "Farstep",
    License: "MIT",
    ShortDescription: "Machine capabilities for AI agents",
    InstallerType: "wix",
    Scope: "user",
    UpgradeBehavior: "install",
    Installers: [
      {
        Architecture: metadata.architecture,
        InstallerUrl: `http://127.0.0.1:${server.port}${route}`,
        InstallerSha256: sha256,
        ProductCode: metadata.productCode,
        AppsAndFeaturesEntries: [
          {
            DisplayName: "Farstep",
            Publisher: "4evy",
            DisplayVersion: metadata.version,
            ProductCode: metadata.productCode,
          },
        ],
      },
    ],
    ManifestType: "singleton",
    ManifestVersion: "1.6.0",
  };
  yield* attempt(
    (signal) => writeFile(manifest, Bun.YAML.stringify(value), { signal }),
    { awaitOnInterrupt: true },
  );
  yield* winget(["validate", "--manifest", manifest]);
  yield* winget([
    "install",
    "--manifest",
    manifest,
    "--scope",
    "user",
    "--silent",
    "--accept-package-agreements",
    "--accept-source-agreements",
  ]);
  return metadata;
}, Effect.scoped);

export function installPackage(packagePath: string) {
  return run(installPackageEffect(packagePath));
}
