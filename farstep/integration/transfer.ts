import { hash as digest } from "node:crypto";
import { link, lstat, readFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { run } from "@ai/core/effect/effect";
import { stageFile } from "@ai/core/effect/fs/fs";
import { quotePosixArgument as quote } from "@ai/core/shell/shell";
import * as v from "valibot";
import { scriptCommandEffect } from "../client/execution/execution";
import { MAX_FILE_BYTES } from "../protocol/files/files";
import type { ToolConnection } from "./connection";

const resultSchema = v.strictObject({
  sha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
  base64: v.string(),
});

export async function retrieveFile(
  connection: ToolConnection,
  bun: string,
  source: string,
  destination: string,
  expectedSha256: string | null,
) {
  const program = `import { lstat, readFile } from 'node:fs/promises';
const path = process.argv[1];
const stat = await lstat(path);
if (!stat.isFile() || stat.size > ${MAX_FILE_BYTES}) throw new Error('Transfer requires a regular file at most 16 MiB');
const bytes = await readFile(path);
if (bytes.length > ${MAX_FILE_BYTES}) throw new Error('File grew beyond transfer limit');
console.log(JSON.stringify({sha256: new Bun.CryptoHasher('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64')}));`;
  const response = await run(
    scriptCommandEffect(
      async (script) => connection.command(script),
      `${quote(bun)} -e ${quote(program)} -- ${quote(source)}`,
      30_000,
      "Verified file retrieval",
    ),
  );
  const remote = v.parse(resultSchema, JSON.parse(response));
  const bytes = Buffer.from(remote.base64, "base64");
  const sha256 = digest("sha256", bytes);
  if (
    bytes.length > MAX_FILE_BYTES ||
    sha256 !== remote.sha256 ||
    bytes.toString("base64") !== remote.base64
  )
    throw new Error("Transferred file did not match its source SHA-256");
  const path = resolve(destination);
  const checkDestination = async () => {
    try {
      const stat = await lstat(path);
      if (
        expectedSha256 === null ||
        !stat.isFile() ||
        digest("sha256", await readFile(path)) !== expectedSha256
      )
        throw new Error("Destination exists or does not match expectedSha256");
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT" &&
          expectedSha256 === null
        )
      )
        throw error;
    }
  };
  await checkDestination();
  await using staged = await stageFile(path);
  await staged.write(bytes);
  if (digest("sha256", await readFile(staged.path)) !== sha256)
    throw new Error("Staged destination failed SHA-256 verification");
  await checkDestination();
  if (expectedSha256 === null) {
    // Exclusive creation must not replace a destination created concurrently
    await link(staged.path, path);
  } else await rename(staged.path, path);
  return { source, destination: path, sha256, bytes: bytes.length, verified: true };
}
