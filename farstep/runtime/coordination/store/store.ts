import { Database } from "bun:sqlite";
import { constants, lstatSync, readFileSync as readResource } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { attempt, run } from "@ai/core/effect/effect";
import { isEexist, isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect } from "effect";
import { uuidSchema } from "farstep/protocol/identity";
import * as v from "valibot";
import {
  loadIdentityEffect,
  paths,
  privateDirectoryEffect,
  privateRead,
} from "../../state";
import * as tables from "./tables";

const schema = readResource(new URL("./schema.sql", import.meta.url), "utf8");

export class CoordinationStore implements Disposable {
  readonly queries;
  private constructor(
    private readonly db: Database,
    private readonly path: string,
  ) {
    this.queries = drizzle({ client: db, schema: tables });
  }

  static readonly createEffect = Effect.fnUntraced(function* (installationId: string) {
    if ((yield* loadIdentityEffect()).installationId !== installationId)
      return yield* Effect.fail(
        new Error("Coordination installation identity mismatch"),
      );
    yield* privateDirectoryEffect(paths().state);
    const directory = join(
      yield* attempt(() => realpath(paths().state)),
      "coordination",
    );
    yield* privateDirectoryEffect(directory);
    if ((yield* attempt(() => realpath(directory))) !== directory)
      return yield* Effect.fail(new Error("Coordination directory must be canonical"));
    const path = join(directory, "registry.sqlite");
    yield* Effect.acquireUseRelease(
      attempt(() =>
        open(
          path,
          constants.O_CREAT |
            constants.O_EXCL |
            constants.O_RDWR |
            constants.O_NOFOLLOW,
          0o600,
        ),
      ),
      () => Effect.void,
      (file) => attempt(() => file.close()),
    ).pipe(
      Effect.catch((error) => (isEexist(error) ? Effect.void : Effect.fail(error))),
    );
    // SQLite setup and its ownership transfer are synchronous, like transactions
    return yield* Effect.try({
      try: () => {
        CoordinationStore.assertFiles(path);
        const db = new Database(path, { strict: true });
        try {
          const store = new CoordinationStore(db, path);
          db.exec("PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON;");
          store.transaction(() => {
            const version =
              db.query<{ user_version: number }, []>("PRAGMA user_version").get()
                ?.user_version ?? 0;
            if (version > 1)
              throw new Error("Coordination database schema is newer than this helper");
            if (version === 0) {
              db.exec(schema);
            }
          });
          db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
          CoordinationStore.assertFiles(path);
          return store;
        } catch (error) {
          db.close();
          throw error;
        }
      },
      catch: (error) => error,
    });
  });

  static create(installationId: string): Promise<CoordinationStore> {
    return run(CoordinationStore.createEffect(installationId));
  }

  static acquireEffect(installationId: string) {
    return Effect.acquireDisposable(CoordinationStore.createEffect(installationId));
  }

  static async openReadOnly(): Promise<CoordinationStore> {
    const state = await realpath(paths().state);
    v.parse(
      v.strictObject({ installationId: uuidSchema }),
      JSON.parse(await privateRead(join(state, "installation.json"))),
    );
    const directory = join(state, "coordination");
    if ((await realpath(directory)) !== directory)
      throw new Error("Coordination directory must be canonical");
    const path = join(directory, "registry.sqlite");
    CoordinationStore.assertFiles(path);
    const db = new Database(path, { readonly: true, strict: true });
    try {
      db.exec("PRAGMA busy_timeout = 10000;");
      const version =
        db.query<{ user_version: number }, []>("PRAGMA user_version").get()
          ?.user_version ?? 0;
      if (version !== 1)
        throw new Error("Coordination database schema is unavailable or unsupported");
      return new CoordinationStore(db, path);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private static assertFiles(path: string): void {
    const directory = lstatSync(join(path, ".."));
    if (
      !directory.isDirectory() ||
      directory.uid !== process.getuid?.() ||
      (directory.mode & 0o077) !== 0
    )
      throw new Error("Unsafe coordination directory");
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      CoordinationStore.assertSidecar(path, suffix);
    }
  }

  private static assertSidecar(path: string, suffix: string): void {
    try {
      const info = lstatSync(`${path}${suffix}`);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.uid !== process.getuid?.() ||
        (info.mode & 0o077) !== 0 ||
        info.nlink !== 1
      )
        throw new Error("Unsafe coordination database or sidecar");
    } catch (error) {
      if (suffix && isEnoent(error)) return;
      throw error;
    }
  }

  transaction<T>(operation: () => T): T {
    CoordinationStore.assertFiles(this.path);
    return this.queries.transaction(() => operation(), { behavior: "immediate" });
  }

  close(): void {
    this.db.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }
}
