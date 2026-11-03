# script

## script

Execute TypeScript once on the target. `cmd`, `Env`, `Config`, `ConfigProvider`,
`Redacted`, `Query`, `Effect`, `Stream`, `Schema`, `CommandError`, `$`, `zx` and
`params` are available without imports. Pass external data in `params`, not
nested shell strings. Bare `effect` and `effect/*` imports also resolve to the
pinned library.

Prefer `cmd.run(argv, options)`, where argv is an array of literal strings.
`run` and `pipe` return `CommandResult`: separate `stdout`/`stderr` text,
exact `stdoutBytes`/`stderrBytes`, `exitCode`, `signal` and `duration`, without
zx parser methods. `cmd.text`, `cmd.bytes`, `cmd.json` and `cmd.lines` return
stdout only. `text` preserves whitespace, `bytes` returns a `Uint8Array`,
`json` ignores stderr, and `lines` supports `{ delimiter: "\0" }`.

Options include `cwd`, `env`, `stdin`, `stdout`, `stderr`, `signal`, zx
`timeout`, `verbose`, `quiet` and `okExitCodes` (default `[0]`).
`stdin` defaults to `"ignore"` and accepts `"inherit"`, `{ text: string }`,
`{ bytes: Uint8Array }`, `{ file: path }` or `{ stream: readable }`.
`stdout`/`stderr` default to `"capture"` and accept `"ignore"`, `"inherit"`,
`{ file: path, append?: boolean }` or `{ stream: writable }`. File paths use
the effective command cwd, and output files overwrite unless appended.
Streams may be Node or Web byte streams. Caller streams are borrowed, not
closed or destroyed, and writes drain before completion or cancellation
settles.

Only captured channels populate result text and byte fields. Other channels
return empty text and bytes. Text, byte, JSON, line and query helpers require
captured stdout and reject redirection before side effects. Direct file and
inherited stdio bypass command capture. Generic piped streams and intermediate
pipeline output remain bounded by the driver's `captureBytes`.

`cmd` starts with an inherited environment snapshot. `cmd.with(options)`
creates an independent context, never mutating `process.env` or global cwd.
Relative cwd paths resolve against the current context. Readonly `cmd.cwd`
and `cmd.env` expose its absolute cwd and immutable environment plan.
Literal `env` records patch the plan (`null` unsets), while an `Env` replaces
it. Build plans with `Env.inherit()`, `Env.clean()` or `Env.only(names)`, then
chain `set(record)`, `unset(...names)`, `prependPath(...paths)`,
`appendPath(...paths)` and `dotenv(...paths)`. Inputs are snapshotted and
operations apply in order. A clean shell can synthesize its own variables.

`dotenv` loads fresh target-side literal data on each resolution, relative
to effective cwd, without evaluation or expansion. Top-level `envFiles`
instead sources shell startup scripts using the saved-cwd base, unchanged by
job cwd. Plans hide values in inspection and JSON. Values in source, params
or launch `env` remain launch arguments, so load secrets from target files.

`cmd.config(Config.all({ port: Config.Number('PORT') }))` validates the scoped
environment. Native `Config.String`, `Config.Number`, `Config.Boolean` and
`Config.Redacted` preserve inferred types, including native Redacted values.
`cmd.effect.config` returns the corresponding Effect.

`cmd.query.json(argv, { schema })` queries a JSON array. `cmd.query.jsonl`
streams JSONL rows and `cmd.query.lines` streams text. Schemas infer row types.
Compose `where`, `select`, `pick`, `mapEffect`, `flatMap`, `groupBy`, `join`,
`leftJoin`, `distinctBy`, `orderBy` and `take`. `collect()`, `reduce()` or
`sum()` executes the lazy query. `take` releases its producer early. Grouping,
sorting and accurate sums buffer input, joins buffer their right side.

`cmd.effect.run/text/bytes/json/lines/pipe/config` return native Effects for
`Effect.gen`, typed named/tuple `Effect.all`, timeouts and service provision.
Run them with `cmd.execute(effect)`, which supplies the context's native
ConfigProvider. `query.stream` and `query.effect` expose native Stream and
Effect composition. `mapEffect(fn, { concurrency })` enriches rows. Failures
preserve `CommandError` and `SchemaError` tags. No schema means unknown, not an
unchecked generic cast. Every query consumption is a new execution, never an
implicit cache or retry.

`cmd.pipe([argv1, { argv: argv2, options }], commonOptions)` checks every stage
and returns the last result. Context defaults, common options and stage
options apply in order, with independent stage cwd, env, timeout and accepted
statuses. Common stdin goes only to the first stage, stdout only to the last,
and stderr to every stage. Downstream explicit stdin and nonterminal
redirected stdout are rejected before spawning.

`cmd.map(items, async (item, index, signal) => ..., { concurrency })` preserves
input order and drains started work on failure. Pass its signal to commands
for cooperative cancellation. Effect manages helper concurrency and
cancellation. Commands are never retried.

Use raw zx `$` tagged templates for shell syntax or advanced streams. Its
`.json()` mixes stderr into parsing, unlike `cmd.json`. Use `console.log` for
result stdout and `console.error` for progress. Await every helper and command.
An uncaught failure fails the job.

Use `script`, not shell-string commands or command trees. Maximum source size:
{{SOURCE_KIB}} KiB
