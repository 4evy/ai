import { cp, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type profiles from "../extensions/profiles.json";
import source from "./source.json";

const resources = fileURLToPath(new URL("../", import.meta.url));
export async function headers(
  sourceDirectory: string,
  installedDirectory: string,
  finalDirectory: string,
  spec: typeof profiles.apple | typeof profiles.windows,
) {
  const module = join(installedDirectory, "Ghidra/Extensions", spec.extensionName);
  const finalModule = join(finalDirectory, "Ghidra/Extensions", spec.extensionName);
  const destination = join(module, "data/headers");
  await cp(join(sourceDirectory, spec.headersRoot), destination, {
    recursive: true,
    filter: async (path) => (await lstat(path)).isDirectory() || path.endsWith(".h"),
  });
  await cp(join(sourceDirectory, spec.licenseFile), join(module, "LICENSE"));
  await mkdir(join(module, "data/parserprofiles"), { recursive: true });
  await mkdir(join(module, "ghidra_scripts"));
  await writeFile(join(module, "Module.manifest"), "");
  await writeFile(
    join(module, "extension.properties"),
    `name=${spec.extensionName}\ndescription=${spec.description}\nauthor=Upstream contributors\ncreatedOn=\nversion=${source.ghidra.version}\n`,
  );
  const forward = (path: string) => path.replaceAll("\\", "/");
  for (const [name, profile] of Object.entries(spec.profiles)) {
    const contents = [
      spec.entryHeaders
        .map((path) => forward(join(finalModule, "data/headers", path)))
        .join("\n"),
      profile.flags.join("\n"),
      spec.includePaths
        .map((path) => forward(join(finalModule, "data/headers", path)))
        .join("\n"),
      profile.language,
      profile.compiler,
    ].join("\n\n");
    await writeFile(
      join(module, "data/parserprofiles", `${name}.prf`),
      `${contents}\n`,
    );
  }
  const script = (
    await readFile(join(resources, "extensions/InstallHeaderProfiles.java"), "utf8")
  )
    .replaceAll("InstallHeaderProfiles", `Install${spec.extensionName}Profiles`)
    .replaceAll(
      "@profilesDirectory@",
      forward(join(finalModule, "data/parserprofiles")),
    );
  await writeFile(
    join(module, "ghidra_scripts", `Install${spec.extensionName}Profiles.java`),
    script,
  );
}
