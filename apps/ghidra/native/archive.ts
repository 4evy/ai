import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { run } from "@ai/core/effect/effect";
import { downloadFile } from "@ai/core/effect/http/http";

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

export async function replaceFile(path: string, before: string, after: string) {
  const contents = await readFile(path, "utf8");
  if (!contents.includes(before))
    throw new Error(`Expected patch context is missing in ${path}`);
  await writeFile(path, contents.replace(before, after));
}
