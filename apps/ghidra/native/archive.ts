import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtempDisposable,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { run } from "@ai/core/effect/effect";
import { downloadFile } from "@ai/core/effect/http/http";
import { platform } from "./common.ts";

type Artifact = { url: string; sha256?: string };

export async function download(
  artifact: Artifact,
  cache: string,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const name = createHash("sha256").update(artifact.url).digest("hex");
  const target = join(cache, `${name}-${basename(new URL(artifact.url).pathname)}`);
  if (await Bun.file(target).exists()) {
    if (
      !artifact.sha256 ||
      createHash("sha256")
        .update(await Bun.file(target).bytes())
        .digest("hex") === artifact.sha256.toLowerCase()
    )
      return target;
    await rm(target);
  }
  console.error(`Downloading ${basename(new URL(artifact.url).pathname)}`);
  await run(
    downloadFile(artifact.url, target, "Ghidra installer download", {
      sha256: artifact.sha256,
    }),
    signal,
  );
  return target;
}

export async function extract(archive: string, destination: string, stripRoot = true) {
  await mkdir(destination, { recursive: true });
  await using staging = await mkdtempDisposable(
    join(dirname(destination), ".extract-"),
  );
  if (archive.endsWith(".zip")) await platform().extractZip(archive, staging.path);
  else await new Bun.Archive(await Bun.file(archive).bytes()).extract(staging.path);
  const entries = await readdir(staging.path, { withFileTypes: true });
  const first = entries[0];
  if (stripRoot && (entries.length !== 1 || !first?.isDirectory()))
    throw new Error(`Expected one archive root: ${archive}`);
  const directory = stripRoot && first ? join(staging.path, first.name) : staging.path;
  for (const name of await readdir(directory))
    await rename(join(directory, name), join(destination, name));
}

export async function replaceFile(path: string, before: string, after: string) {
  const contents = await readFile(path, "utf8");
  if (!contents.includes(before))
    throw new Error(`Expected patch context is missing in ${path}`);
  await writeFile(path, contents.replace(before, after));
}
