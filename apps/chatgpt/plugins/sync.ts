import { mkdir, readFile, readlink, rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { attempt, run } from "@ai/runtime/effect/effect";
import { executeCommand } from "@ai/runtime/effect/process/process";
import { directoryExists } from "@oh-my-pi/pi-utils/dirs";
import { writeFile } from "atomically";
import { Effect } from "effect";
import * as v from "valibot";

const entry = v.looseObject({ name: v.string() });
const manifest = v.looseObject({ plugins: v.array(entry) });
type Entry = v.InferOutput<typeof entry>;
type Manifest = v.InferOutput<typeof manifest>;

type Options = {
  source: string;
  home: string;
  marketplace: string;
  plugins: readonly string[];
  label: string;
  cli: () => string;
  requireMaterialized?: boolean;
};

export const directory = (path: string) =>
  attempt(() => directoryExists(path)).pipe(Effect.catch(() => Effect.succeed(false)));

const loadManifest = Effect.fnUntraced(function* (root: string) {
  const path = join(root, ".agents/plugins/marketplace.json");
  const contents = yield* attempt((signal) =>
    readFile(path, { encoding: "utf8", signal }),
  );
  const value = yield* Effect.try({
    try: () => JSON.parse(contents),
    catch: (error) => error,
  });
  const parsed = v.safeParse(manifest, value);
  if (!parsed.success)
    return yield* Effect.fail(
      new Error(`invalid ChatGPT marketplace manifest: ${path}`),
    );
  return parsed.output;
});

const writeManifest = (path: string, data: Manifest) =>
  attempt(
    () => writeFile(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 }),
    { awaitOnInterrupt: true },
  );

// The launchers supply discovery and selection policies; synchronization owns
// materialization, atomic manifest replacement and ordered plugin installation
export class Synchronizer {
  private readonly options: Options;
  private readonly materialized: string;
  private readonly destination: string;

  constructor(options: Options) {
    this.options = options;
    this.materialized = join(options.home, ".tmp/bundled-marketplaces/openai-bundled");
    this.destination = join(
      options.home,
      ".tmp/compatibility-marketplaces",
      options.marketplace,
    );
  }

  sync(): Promise<boolean> {
    return run(this.syncEffect());
  }

  syncEffect() {
    const self = this;
    return Effect.gen(function* () {
      const { source, requireMaterialized, plugins, marketplace, label } = self.options;
      if (!(yield* directory(source))) {
        console.error(`${label}: ChatGPT is absent; skipping Codex plugins`);
        return false;
      }
      const hasMaterialized = yield* directory(self.materialized);
      if (requireMaterialized && !hasMaterialized) {
        console.error(`${label}: bundled Codex marketplace is absent; skipping`);
        return false;
      }
      const original = yield* loadManifest(source);
      const materialized = hasMaterialized
        ? yield* loadManifest(self.materialized)
        : { plugins: [] };
      const entries = new Map(
        [...original.plugins, ...materialized.plugins].map((entry) => [
          entry.name,
          entry,
        ]),
      );
      const selected = yield* Effect.filter(
        plugins.map((name) => entries.get(name)).filter((entry) => entry !== undefined),
        ({ name }) => self.materialize(name),
        { concurrency: 1 },
      );
      const path = join(self.destination, ".agents/plugins/marketplace.json");
      yield* attempt(() => mkdir(dirname(path), { recursive: true }), {
        awaitOnInterrupt: true,
      });
      yield* writeManifest(path, { ...original, name: marketplace, plugins: selected });
      yield* self.install(selected);
      console.error(`${label}: bundled Codex plugins are current`);
      return true;
    });
  }

  private materialize(name: string) {
    const self = this;
    return Effect.gen(function* () {
      const materialized = join(self.materialized, "plugins", name);
      const source = (yield* directory(materialized))
        ? materialized
        : join(self.options.source, "plugins", name);
      if (!(yield* directory(source))) return false;
      const destination = join(self.destination, "plugins", name);
      // A missing path or a regular file must be replaced with the plugin link
      const current = yield* attempt(() => readlink(destination)).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      );
      if (current !== source) {
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* attempt(() => rm(destination, { recursive: true, force: true }));
            yield* attempt(() => mkdir(dirname(destination), { recursive: true }));
            yield* attempt(() => symlink(source, destination));
          }),
        );
      }
      return true;
    });
  }

  private install(entries: readonly Entry[]) {
    return Effect.try({ try: () => this.options.cli(), catch: (error) => error }).pipe(
      Effect.flatMap((codex) =>
        Effect.forEach(
          entries,
          ({ name }) =>
            executeCommand(
              [codex, "plugin", "add", `${name}@${this.options.marketplace}`],
              {
                stdin: "inherit",
                stdout: "inherit",
                stderr: "inherit",
              },
            ).pipe(
              Effect.flatMap(({ code }) =>
                code === 0
                  ? Effect.void
                  : Effect.fail(
                      new Error(`Codex plugin installation failed (${code})`),
                    ),
              ),
            ),
          { discard: true },
        ),
      ),
    );
  }
}
