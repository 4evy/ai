import { mkdir, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { ensureRuntime } from "farstep/runtime/sky/runtime/install";
import { MODULES, WINDOWS } from "farstep/runtime/sky/runtime/paths";
import pins from "farstep/runtime/sky/runtime/pins.json";
import * as v from "valibot";
import { root } from "../renovate/process";

export const destination = join(root, "farstep/sky");

export async function readPackage(source: string, pin: typeof pins) {
  const parsed = v.safeParse(
    v.object({
      name: v.literal("@oai/sky"),
      version: v.string(),
      types: v.string(),
    }),
    await Bun.file(join(source, "package.json")).json(),
  );
  if (!parsed.success) {
    throw new Error("The runtime does not contain a valid Sky package");
  }
  const upstream = parsed.output;
  const declarations = join(source, dirname(upstream.types));
  const pending = [
    "index.d.ts",
    "sky.d.ts",
    "service.d.ts",
    ...new Bun.Glob("types/**/*.d.ts").scanSync(declarations),
  ];
  const sources = new Map<string, string>();
  while (pending.length) {
    const file = pending.pop();
    if (!file || sources.has(file)) continue;
    const content = await Bun.file(join(declarations, file)).text();
    sources.set(file, content);
    for (const match of content.matchAll(
      /(?:from\s+|import\s*\(\s*|reference\s+path=)["']([^"']+)["']/g,
    )) {
      const specifier = match[1];
      if (!specifier?.startsWith(".")) continue;
      const dependency = await resolveDeclaration(declarations, file, specifier);
      pending.push(dependency);
    }
  }
  const contents = new Map<string, string>();
  const hash = new Bun.CryptoHasher("sha256");
  for (const [file, content] of [...sources].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    contents.set(`upstream/${file}`, content);
    hash.update(file).update("\0").update(content).update("\0");
  }
  contents.set(
    "package.json",
    `${JSON.stringify(
      {
        name: "@oai/sky",
        version: upstream.version,
        private: true,
        type: "module",
        exports: {
          ".": { types: "./upstream/index.d.ts" },
          "./service": { types: "./upstream/service.d.ts" },
        },
        types: "./upstream/index.d.ts",
        skylight: {
          chatgptVersion: pin.version,
          archives: pin.artifacts.map(({ platform, arch, sha256, skyVersion }) => ({
            platform,
            arch,
            sha256,
            skyVersion,
          })),
          declarationsSha256: hash.digest("hex"),
        },
      },
      null,
      2,
    )}\n`,
  );
  return { version: upstream.version, contents };
}

async function resolveDeclaration(
  declarations: string,
  file: string,
  specifier: string,
): Promise<string> {
  const base = resolve(declarations, dirname(file), specifier);
  const candidates = [
    base.replace(/\.(?:m|c)?js$/, ".d.ts"),
    `${base}.d.ts`,
    join(base, "index.d.ts"),
  ];
  let dependency: string | undefined;
  for (const candidate of candidates) {
    if (candidate.endsWith(".d.ts") && (await Bun.file(candidate).exists())) {
      dependency = relative(declarations, candidate).split(sep).join("/");
      break;
    }
  }
  if (!dependency || dependency.startsWith("../")) {
    throw new Error(`Unsupported Sky declaration import: ${file}: ${specifier}`);
  }
  return dependency;
}

export function checkDeclarations(
  shared: Awaited<ReturnType<typeof readPackage>>,
  current: Awaited<ReturnType<typeof readPackage>>,
  platform: string,
) {
  const files = new Set(shared.contents.keys()).union(new Set(current.contents.keys()));
  for (const file of files) {
    if (file === "package.json") continue;
    // Windows releases independently; only macOS-specific types may differ
    if (platform === "win32" && file.startsWith("upstream/types/window/")) continue;
    if (shared.contents.get(file) !== current.contents.get(file)) {
      throw new Error(`ChatGPT ${platform} ships different Sky declarations: ${file}`);
    }
  }
  if (platform !== "win32" && shared.version !== current.version) {
    throw new Error(`ChatGPT ${platform} ships a different Sky version`);
  }
}

export async function writePackage(
  contents: Map<string, string>,
  directory = destination,
  check = false,
) {
  if (check) {
    const actual = new Set(
      new Bun.Glob("**/*").scanSync({ cwd: directory, onlyFiles: true }),
    );
    const differences: string[] = [];
    for (const [file, content] of contents) {
      actual.delete(file);
      const installed = Bun.file(join(directory, file));
      if (!(await installed.exists()) || (await installed.text()) !== content) {
        differences.push(file);
      }
    }
    differences.push(...actual);
    if (differences.length) {
      throw new Error(
        `Sky declarations differ from the pin: ${differences.join(", ")}`,
      );
    }
  } else {
    await rm(join(directory, "upstream"), { recursive: true, force: true });
    for (const [file, content] of contents) {
      const path = join(directory, file);
      await mkdir(dirname(path), { recursive: true });
      await Bun.write(path, content);
    }
  }
}

if (import.meta.main) {
  const local = Bun.argv.includes("--check-local");
  const check = local || Bun.argv.includes("--check");
  if (!local) await ensureRuntime();
  let generated = await readPackage(
    local ? destination : join(MODULES, "@oai/sky"),
    pins,
  );
  if (!local && WINDOWS) {
    const shared = await readPackage(destination, pins);
    checkDeclarations(shared, generated, "win32");
    generated = shared;
  }
  if (generated.version !== pins.skyVersion) {
    throw new Error(`Sky must match the pinned version ${pins.skyVersion}`);
  }
  await writePackage(generated.contents, destination, check);
  console.log(
    `${check ? "Checked" : "Synced"} @oai/sky ${generated.version}: ${generated.contents.size - 1} declarations from ChatGPT ${pins.version}`,
  );
}
