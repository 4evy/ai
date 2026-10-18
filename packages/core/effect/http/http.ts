import { mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect, Stream } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { attempt } from "../effect";
import { openFile, temporaryDirectory } from "../fs/fs";

// The caller's scope owns the response, including bodies rejected by status checks
export const get = Effect.fnUntraced(
  function* (url: string, options: Pick<RequestInit, "redirect"> = {}) {
    const client = yield* HttpClient.HttpClient;
    return yield* HttpClient.withScope(client)
      .get(url)
      .pipe(Effect.provideService(FetchHttpClient.RequestInit, options));
  },
  Effect.provide(FetchHttpClient.layer),
  // URLs and response details may contain credentials; callers own sanitized spans
  Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
);

export interface DownloadOptions {
  sha256?: string | undefined;
  maxBytes?: number | undefined;
}

// Stage beside the destination so failures preserve it and publication is atomic
export const downloadFile = Effect.fnUntraced(function* (
  url: string,
  destination: string,
  label = "Download",
  options: DownloadOptions = {},
) {
  yield* Effect.try({
    try: () => {
      if (options.sha256 !== undefined && !/^[a-f0-9]{64}$/iu.test(options.sha256))
        throw new Error("Expected a SHA-256 checksum with 64 hexadecimal digits");
      if (
        options.maxBytes !== undefined &&
        (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0)
      )
        throw new RangeError("Download byte limit must be a nonnegative safe integer");
    },
    catch: (error) => error,
  });
  const response = yield* get(url);
  if (response.status < 200 || response.status >= 300)
    return yield* Effect.fail(new Error(`${label} failed: HTTP ${response.status}`));
  yield* attempt(() => mkdir(dirname(destination), { recursive: true }), {
    awaitOnInterrupt: true,
  });
  const staging = yield* temporaryDirectory(join(dirname(destination), ".download-"));
  const temporary = join(staging.path, "body");
  // Close the staged handle before rename, including on Windows
  const digest = yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* openFile(temporary, "wx", 0o600);
      const hash = new Bun.CryptoHasher("sha256");
      let bytes = 0;
      if (response.status !== 204 && response.status !== 205)
        yield* response.stream.pipe(
          Stream.runForEach((chunk) =>
            attempt(
              async () => {
                if (
                  options.maxBytes !== undefined &&
                  chunk.byteLength > options.maxBytes - bytes
                )
                  throw new Error(`${label} exceeds byte limit (${options.maxBytes})`);
                await file.writeFile(chunk);
                bytes += chunk.byteLength;
                hash.update(chunk);
              },
              { awaitOnInterrupt: true },
            ),
          ),
        );
      const digest = hash.digest("hex");
      if (options.sha256 !== undefined && digest !== options.sha256.toLowerCase())
        return yield* Effect.fail(new Error(`${label} checksum mismatch`));
      return digest;
    }),
  );
  yield* attempt(() => rename(temporary, destination), { awaitOnInterrupt: true });
  return digest;
}, Effect.scoped);
