import { run } from "@ai/runtime/effect/effect";
import { Effect, Schema, Stream } from "effect";

// Bun 1.4.4 provides this API, but TypeScript 7.0.2 has no declaration yet
const sumPrecise = (Math as Math & { sumPrecise(values: Iterable<number>): number })
  .sumPrecise;

export interface QueryRunOptions {
  signal?: AbortSignal;
}

/** Lazy queries retain native Stream access and never execute until consumed */
export class Query<A, E = never, R = never> {
  constructor(readonly stream: Stream.Stream<A, E, R>) {}

  static from<A>(values: Iterable<A>): Query<A> {
    return new Query(Stream.fromIterable(values));
  }

  static fromStream<A, E, R>(stream: Stream.Stream<A, E, R>): Query<A, E, R> {
    return new Query(stream);
  }

  static fromEffect<A, E, R>(rows: Effect.Effect<Iterable<A>, E, R>): Query<A, E, R> {
    return new Query(Stream.fromIterableEffect(rows));
  }

  where<B extends A>(predicate: (row: A) => row is B): Query<B, E, R>;
  where(predicate: (row: A) => boolean): Query<A, E, R>;
  where(predicate: (row: A) => boolean): Query<A, E, R> {
    return new Query(Stream.filter(this.stream, predicate));
  }

  select<B>(project: (row: A) => B): Query<B, E, R> {
    return new Query(Stream.map(this.stream, project));
  }

  pick<const Keys extends readonly (keyof A)[]>(
    ...keys: Keys
  ): Query<Pick<A, Keys[number]>, E, R> {
    return this.select((row) => {
      // Define own properties even for selected keys such as "__proto__"
      const selected = {} as Pick<A, Keys[number]>;
      for (const key of keys)
        Object.defineProperty(selected, key, {
          value: row[key],
          enumerable: true,
          writable: true,
          configurable: true,
        });
      return selected;
    });
  }

  decode<S extends Schema.Constraint>(
    schema: S,
  ): Query<S["Type"], E | Schema.SchemaError, R | S["DecodingServices"]> {
    return this.mapEffect(Schema.decodeUnknownEffect(schema));
  }

  mapEffect<B, E2, R2>(
    project: (row: A) => Effect.Effect<B, E2, R2>,
    options: { concurrency?: number; unordered?: boolean } = {},
  ): Query<B, E | E2, R | R2> {
    if (
      options.concurrency !== undefined &&
      (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1)
    )
      throw new Error("Query concurrency must be a positive safe integer");
    return new Query(Stream.mapEffect(this.stream, project, options));
  }

  flatMap<B, E2, R2>(project: (row: A) => Query<B, E2, R2>): Query<B, E | E2, R | R2> {
    return new Query(Stream.flatMap(this.stream, (row) => project(row).stream));
  }

  take(count: number): Query<A, E, R> {
    if (!Number.isSafeInteger(count) || count < 0)
      throw new Error("Query take count must be a nonnegative safe integer");
    return new Query(Stream.take(this.stream, count));
  }

  distinctBy<K>(key: (row: A) => K): Query<A, E, R> {
    return new Query(
      Stream.suspend(() => {
        const seen = new Set<K>();
        return Stream.filter(this.stream, (row) => {
          const value = key(row);
          if (seen.has(value)) return false;
          seen.add(value);
          return true;
        });
      }),
    );
  }

  /** Buffer rows in first-key order, using SameValueZero key equality */
  groupBy<K>(key: (row: A) => K): Query<{ key: K; rows: A[] }, E, R> {
    return Query.fromEffect(
      Stream.runFold(
        this.stream,
        () => new Map<K, A[]>(),
        (groups, row) => {
          groups.getOrInsertComputed(key(row), () => []).push(row);
          return groups;
        },
      ).pipe(
        Effect.map((groups) => Array.from(groups, ([key, rows]) => ({ key, rows }))),
      ),
    );
  }

  /** Buffer and sort all rows; take before this operation to bound the input */
  orderBy(compare: (left: A, right: A) => number): Query<A, E, R> {
    return Query.fromEffect(this.effect.pipe(Effect.map((rows) => rows.sort(compare))));
  }

  join<B, K, C, E2, R2>(
    right: Query<B, E2, R2>,
    keys: { left: (row: A) => K; right: (row: B) => NoInfer<K> },
    select: (left: A, right: B) => C,
  ): Query<C, E | E2, R | R2> {
    return this.joinRows(right, keys, (left, rows) =>
      rows.map((row) => select(left, row)),
    );
  }

  leftJoin<B, K, C, E2, R2>(
    right: Query<B, E2, R2>,
    keys: { left: (row: A) => K; right: (row: B) => NoInfer<K> },
    select: (left: A, right: B | undefined) => C,
  ): Query<C, E | E2, R | R2> {
    return this.joinRows(right, keys, (left, rows) =>
      rows.length ? rows.map((row) => select(left, row)) : [select(left, undefined)],
    );
  }

  private joinRows<B, K, C, E2, R2>(
    right: Query<B, E2, R2>,
    keys: { left: (row: A) => K; right: (row: B) => K },
    select: (left: A, rows: readonly B[]) => Iterable<C>,
  ): Query<C, E | E2, R | R2> {
    const index = Stream.runFold(
      right.stream,
      () => new Map<K, B[]>(),
      (index, row) => {
        index.getOrInsertComputed(keys.right(row), () => []).push(row);
        return index;
      },
    );
    return new Query(
      Stream.unwrap(
        index.pipe(
          Effect.map((lookup) =>
            Stream.flatMap(this.stream, (row) =>
              Stream.fromIterable(select(row, lookup.get(keys.left(row)) ?? [])),
            ),
          ),
        ),
      ),
    );
  }

  /** Native Effect terminal for Effect.all, gen, timeouts and service provision */
  get effect(): Effect.Effect<A[], E, R> {
    return Stream.runCollect(this.stream);
  }

  collect(this: Query<A, E>, options: QueryRunOptions = {}): Promise<A[]> {
    return run(this.effect, options.signal);
  }

  reduce<B>(
    this: Query<A, E>,
    seed: () => B,
    fold: (state: B, row: A) => B,
    options: QueryRunOptions = {},
  ): Promise<B> {
    return run(Stream.runFold(this.stream, seed, fold), options.signal);
  }

  /** Accurate numeric aggregation buffers numbers for Math.sumPrecise */
  sum(
    this: Query<A, E>,
    value: (row: A) => number,
    options: QueryRunOptions = {},
  ): Promise<number> {
    return run(
      Stream.runCollect(Stream.map(this.stream, value)).pipe(Effect.map(sumPrecise)),
      options.signal,
    );
  }
}
