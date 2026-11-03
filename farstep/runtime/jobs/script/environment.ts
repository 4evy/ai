import { readFile } from "node:fs/promises";
import { delimiter, resolve as resolvePath } from "node:path";
import { inspect, parseEnv } from "node:util";
import { attempt } from "@ai/runtime/effect/effect";
import { ConfigProvider, Data, Effect } from "effect";

export type EnvironmentValues = Readonly<Record<string, string | null>>;

export interface ResolvedEnvironment {
  readonly values: NodeJS.ProcessEnv;
  readonly provider: ConfigProvider.ConfigProvider;
}

type OperationName =
  | "inherit"
  | "only"
  | "set"
  | "unset"
  | "path"
  | "dotenv"
  | "resolve";

export class EnvironmentError extends Data.TaggedError("EnvironmentError")<{
  readonly message: string;
  readonly operation: OperationName;
}> {}

type Operation =
  | { readonly kind: "set"; readonly values: EnvironmentValues }
  | {
      readonly kind: "path";
      readonly prepend: boolean;
      readonly paths: readonly string[];
    }
  | { readonly kind: "dotenv"; readonly paths: readonly string[] };

interface Plan {
  readonly operation: Operation;
  readonly previous: Plan | undefined;
}

function invalid(operation: OperationName, message: string): never {
  throw new EnvironmentError({ operation, message });
}

function checkName(name: string, operation: OperationName): void {
  if (typeof name !== "string" || !name || name.includes("=") || name.includes("\0"))
    invalid(
      operation,
      "Environment names must be nonempty strings without equals or NUL",
    );
}

function checkValue(value: string, operation: OperationName): void {
  if (typeof value !== "string" || value.includes("\0"))
    invalid(operation, "Environment values must be NUL-free strings");
}

function snapshot(
  values: NodeJS.ProcessEnv | EnvironmentValues,
  operation: OperationName,
  allowUnset: boolean,
): EnvironmentValues {
  try {
    if (typeof values !== "object" || values === null || Array.isArray(values))
      invalid(operation, "Environment values must be a record");
    const copy: Record<string, string | null> = Object.create(null);
    for (const [name, value] of Object.entries(values)) {
      checkName(name, operation);
      if (value === undefined && !allowUnset) continue;
      if (value === null && allowUnset) copy[name] = null;
      else {
        checkValue(value as string, operation);
        copy[name] = value as string;
      }
    }
    return Object.freeze(copy);
  } catch (error) {
    if (error instanceof EnvironmentError) throw error;
    return invalid(operation, "Unable to snapshot environment values");
  }
}

function snapshotPaths(paths: readonly string[], operation: "path" | "dotenv") {
  const copy = [...paths];
  for (const path of copy) {
    checkValue(path, operation);
    if (operation === "dotenv" && !path)
      invalid(operation, "Dotenv file paths must not be empty");
  }
  return Object.freeze(copy);
}

/** Immutable target-side environment plan with literal, ordered overrides */
export class Environment {
  readonly #base: EnvironmentValues;
  readonly #plan: Plan | undefined;

  private constructor(base: EnvironmentValues, plan?: Plan) {
    this.#base = base;
    this.#plan = plan;
  }

  static inherit(values: NodeJS.ProcessEnv = process.env): Environment {
    return new Environment(snapshot(values, "inherit", false));
  }

  static clean(): Environment {
    return new Environment(Object.freeze(Object.create(null)));
  }

  static only(
    names: readonly string[],
    values: NodeJS.ProcessEnv = process.env,
  ): Environment {
    const selected: NodeJS.ProcessEnv = Object.create(null);
    try {
      for (const name of names) {
        checkName(name, "only");
        if (Object.hasOwn(values, name)) selected[name] = values[name];
      }
    } catch (error) {
      if (error instanceof EnvironmentError) throw error;
      return invalid("only", "Unable to snapshot allowlisted environment values");
    }
    return new Environment(snapshot(selected, "only", false));
  }

  set(values: EnvironmentValues): Environment {
    return this.#append({ kind: "set", values: snapshot(values, "set", true) });
  }

  unset(...names: readonly string[]): Environment {
    const values: Record<string, null> = Object.create(null);
    for (const name of names) {
      checkName(name, "unset");
      values[name] = null;
    }
    return this.#append({ kind: "set", values: Object.freeze(values) });
  }

  prependPath(...paths: readonly string[]): Environment {
    return this.#append({
      kind: "path",
      prepend: true,
      paths: snapshotPaths(paths, "path"),
    });
  }

  appendPath(...paths: readonly string[]): Environment {
    return this.#append({
      kind: "path",
      prepend: false,
      paths: snapshotPaths(paths, "path"),
    });
  }

  dotenv(...paths: readonly string[]): Environment {
    return this.#append({ kind: "dotenv", paths: snapshotPaths(paths, "dotenv") });
  }

  resolve(cwd: string): Effect.Effect<ResolvedEnvironment, EnvironmentError> {
    const base = this.#base;
    const plan = this.#plan;
    return Effect.gen(function* () {
      yield* Effect.try({
        try: () => {
          checkValue(cwd, "resolve");
          if (!cwd)
            invalid("resolve", "Environment working directory must not be empty");
        },
        catch: () =>
          new EnvironmentError({
            operation: "resolve",
            message: "Environment working directory must be a nonempty NUL-free string",
          }),
      });
      const values: NodeJS.ProcessEnv = Object.assign(Object.create(null), base);
      const operations: Operation[] = [];
      for (let current = plan; current; current = current.previous)
        operations.push(current.operation);
      for (let index = operations.length - 1; index >= 0; index--) {
        const operation = operations[index]!;
        switch (operation.kind) {
          case "set":
            for (const [name, value] of Object.entries(operation.values)) {
              if (value === null) delete values[name];
              else values[name] = value;
            }
            break;
          case "path": {
            // Empty additions must not introduce a current-directory search entry
            const paths = operation.paths.filter((path) => path !== "");
            if (!paths.length) break;
            const current = values.PATH;
            if (current !== undefined && current !== "") {
              if (operation.prepend) paths.push(current);
              else paths.unshift(current);
            }
            values.PATH = paths.join(delimiter);
            break;
          }
          case "dotenv":
            for (const path of operation.paths) {
              const text = yield* attempt(
                (signal) =>
                  readFile(resolvePath(cwd, path), { encoding: "utf8", signal }),
                { awaitOnInterrupt: true },
              ).pipe(
                Effect.mapError(
                  () =>
                    new EnvironmentError({
                      operation: "dotenv",
                      message: "Unable to read dotenv file",
                    }),
                ),
              );
              const parsed = yield* Effect.try({
                try: () => snapshot(parseEnv(text), "dotenv", false),
                catch: () =>
                  new EnvironmentError({
                    operation: "dotenv",
                    message: "Unable to parse valid dotenv environment values",
                  }),
              });
              Object.assign(values, parsed);
            }
            break;
        }
      }
      return {
        values,
        provider: ConfigProvider.fromEnvRecord(values, { preserveEmptyStrings: true }),
      };
    });
  }

  #append(operation: Operation): Environment {
    return new Environment(
      this.#base,
      Object.freeze({
        operation: Object.freeze(operation),
        previous: this.#plan,
      }),
    );
  }

  [inspect.custom](): string {
    return "Environment { <redacted> }";
  }

  toJSON(): { readonly _tag: "Environment" } {
    return { _tag: "Environment" };
  }
}
