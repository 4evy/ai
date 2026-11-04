# Run a TypeScript script

Call {{runTool}} without `target` locally or with a saved {{connectTool}} ID for
SSH. Set `cwd` when switching projects and confirm the target's shell and
toolchain. Observe with {{jobTool}} and the returned handle. Read the schema for
supported options, limits and defaults.

`waitSeconds` limits observation, while `timeout` limits execution. Choose
`pty:true` for interactive terminals or `pty:false` for separate stdout and
stderr and machine-readable output. Read "interactive" before terminal input.

## Choose the environment

Prefer the project's task runner and development environment.
`environment:"shared"` loads the target's shared shell setup and stops if it is
unavailable or fails. `environment:"inherit"` preserves permitted caller
variables locally, including activated toolchains. Over SSH, it uses the remote
gateway environment.

`login:true` loads startup files first. `envFiles` scripts then load in order
with auto-export, followed by explicit `env`. `envFiles` paths use the target's
saved `cwd` and must name shell scripts. `env` values are literal strings.
`null` unsets a variable. Launch arguments retain `env`, so load secrets through
target `envFiles`. Check executable paths and versions after host or environment
changes.

Changing the job `cwd` does not change the base for `envFiles`. For example,
with scripts under a `trials` directory in the saved workspace:

{{environmentPaths}}

Replace those paths with your scripts, or use absolute paths.

## Compose commands with cmd

Pass TypeScript source in `script` and JSON values in `params`. The entire
script executes once on the target in Farstep's bundled Bun. `cmd`, `Env`,
`Config`, `ConfigProvider`, `Redacted`, `Query`, `Effect`, `Stream`, `Schema`,
`CommandError`, `$`, `zx` and `params` are available without imports. Commands
run there without another SSH round trip.

Prefer `cmd` for commands expressed as an executable and literal arguments.
Its async functions use Effect internally for failure and cancellation
handling, and zx for the existing shell, quoting and process tracking. Use
top-level await, ordinary TypeScript functions, conditions and loops. Bun
transpiles TypeScript without typechecking it.

Built-in imports and absolute target module paths work. Bare `effect` and
`effect/*` imports resolve to the pinned Effect package, just as `zx` resolves
to pinned zx. Relative imports resolve from a private temporary script
directory, not the job `cwd`. Other packages must already be present on the
target and use absolute paths. Farstep installs no dependencies during
execution.

### Scoped environments and typed configuration

`cmd` starts with a snapshot of the target's inherited environment and cwd.
`cmd.with({ cwd, env, ... })` returns an independent context without mutating
`process.env` or the script's cwd. Relative context and per-call `cwd` paths
resolve against the current context's cwd. Readonly `cmd.cwd` and `cmd.env`
expose that context's absolute cwd and immutable environment plan.

An `env` record patches the current plan, with `null` unsetting a name. An
`Env` plan replaces it. Start from `Env.inherit()`, `Env.clean()` or
`Env.only(['PATH', 'HOME'])`. Chain `set({ NAME: 'value' })`, `unset('NAME')`,
`prependPath(directory)`, `appendPath(directory)` and `dotenv(path)` in the
order they should apply. Plans snapshot supplied values, and methods return
new plans. A clean environment is not a sandbox, and the command shell may
synthesize variables of its own.

`dotenv` reads target files fresh for each command or configuration resolution.
Relative paths use the effective context or command cwd. It parses literal
dotenv data with no shell evaluation, command substitution or variable
expansion. This differs from top-level `envFiles`, which sources shell startup
scripts and retains the saved-cwd base described above.

Use native Effect Config to validate values from the same scoped environment:

{{environmentConfig}}

Replace `./service` with a target directory containing `.env` entries for
`SERVICE_NAME`, numeric `PORT`, boolean `DEBUG` and `API_TOKEN`. The token
remains a native `Redacted` value and is deliberately not printed.
`Config.String`, `Config.Number`, `Config.Boolean` and `Config.Redacted` are
the native constructors. `cmd.config(Config.all(...))` returns a Promise,
while `cmd.effect.config(...)` returns an Effect. `cmd.execute(effect)`
provides the context's ConfigProvider for native Config composition too.

Plan inspection and JSON serialization do not reveal environment values.
This does not hide values placed in source or `params`, which remain launch
arguments. Keep secrets in target files instead of source, params or explicit
launch `env` values. Use literal `dotenv` for data or top-level `envFiles`
only when shell execution is intended.

### Typed data queries

Use `cmd.query.json(argv, { schema })` for a JSON array, or
`cmd.query.jsonl(argv, { schema })` for live JSONL rows. `schema` describes one
row and infers its TypeScript type. No schema means `unknown`, not a caller
assertion. JSONL ignores blank lines. Schema failures identify invalid fields.
`cmd.query.lines(argv)` reads live LF/CRLF stdout lines for custom parsing.

Queries are lazy. Constructing and composing a query launches no command.
`collect()` executes it, and returns an array. Each consumption is a new
execution, not a cache or an automatic retry. Collect once and use `Query.from`
to analyze the same captured data repeatedly without rerunning its producer.

This example validates rows, filters them, groups and aggregates, left-joins
owner data, sorts, and projects an exact set of columns:

{{typedQuery}}

Use `where` with a type guard to narrow a union, `select` to transform a row,
and `pick(...keys)` for compile-time-checked column selection. `distinctBy`
deduplicates by a key, `flatMap` expands a row into another Query, and `decode`
applies an Effect Schema to existing rows. `Query.from(iterable)`,
`Query.fromEffect(effectOfIterable)` and `Query.fromStream(stream)` also work.

`groupBy` yields `{ key, rows }` in first-key order. `join` is an inner hash
join, and `leftJoin` passes `undefined` for an unmatched right row. Both
preserve left order and expand duplicate right keys. Keys use native Map
equality without string coercion. `orderBy` accepts a comparator.

`reduce(() => initialState, fold)` aggregates incrementally. `sum(selector)`
uses `Math.sumPrecise`. Grouping, sorting and accurate sums buffer their
inputs, joins buffer the right input, and `distinctBy` retains distinct keys.
Use `take` before a materializing operator when its input must be bounded.

For a live producer, `take` closes the owned process when enough rows arrive:

{{liveQuery}}

Early termination deliberately does not establish the producer's eventual exit
status. Fully consumed command queries check the exit status after stdout EOF.
Streaming still respects the per-command `captureBytes` limit, including rows
filtered out by the query.

### Native Effect and Stream composition

`cmd.effect.run`, `text`, `bytes`, `json`, `lines`, `pipe` and `config` return
lazy native Effects, not Promises. Use `Effect.gen`, named or tuple
`Effect.all`, timeouts, service provision and error recovery directly.
`cmd.execute(effect, { signal })` runs an Effect with the scoped ConfigProvider
while preserving native failures:

{{effectQueries}}

`query.stream` is a native `Stream<A, E, R>`, and `query.effect` is its native
`Effect<A[], E, R>` collection terminal. `query.mapEffect(row => effect,
{ concurrency: 4 })` enriches rows with bounded parallel effects, preserving
order unless `unordered: true`. Native Stream operators remain available
through `.stream`, including operators not wrapped by Query.

Command failures are tagged `CommandError`, with `phase`, `argv`, `exitCode`,
`signal`, `stdout`, `stderr` and `cause`. Use `Effect.catchTag('CommandError',
handler)` to recover a specific command outcome. Schema failures remain
`SchemaError`, not command failures. Service-requiring schemas retain their
requirements in Effects and Queries and need explicit service provision before
execution. Promise `cmd.json` accepts schemas with no required services.

Types preserve schema inference, type-guard narrowing, const-key projections,
join-key constraints, and Effect error/service requirements. The query
implementation uses the ES2026 `Map.getOrInsertComputed` and
`Math.sumPrecise` APIs supported by bundled Bun. New TypeScript library
declarations alone do not make a proposed runtime API available.

### Literal arguments, stdin and stdout

Pass an argv array to `cmd.run`, never a joined shell string. It returns a
`CommandResult` with separate `stdout` and `stderr` text, exact `stdoutBytes`
and `stderrBytes`, `exitCode`, `signal` and `duration`, not zx parser methods.
Exit 0 is accepted by default. List expected statuses in `okExitCodes`:

{{literalSearch}}

Replace the search text and path. `rg` returns 1 for no matches and 2 for
errors. Only the expected no-match status is accepted here. Signals, launch
failures and capture overflows still fail.

Use `cmd.text` to return stdout exactly, without trimming:

{{argumentVector}}

Every array element is a literal argument, including spaces, quotes, dollar
signs and shell operators. An element containing `|` is not a pipeline.

Feed text with `{ stdin: { text: params.text } }` or exact binary data with
`{ stdin: { bytes: uint8Array } }`. `cmd.lines` reads stdout only, handles LF
and CRLF, preserves interior blank lines, and removes one final record
terminator. Empty stdout returns `[]`. Use `{ delimiter: "\0" }` for
NUL-delimited paths:

{{commandInput}}

`cmd.json` parses stdout only, so stderr warnings do not corrupt JSON:

{{stdoutJson}}

Keep multiline text, regular expressions, SQL and nested interpreter source in
`params`, not quoted inside `script`. For example,
`cmd.run(['python3', '-'], { stdin: { text: params.source } })` sends Python
source via stdin. Never put secrets in source or params.

`stdin` defaults to `"ignore"` and also accepts `"inherit"`, `{ file: path }`
or `{ stream: readable }`. `stdout` and `stderr` each default to `"capture"`.
They also accept `"ignore"`, `"inherit"`, `{ file: path, append?: boolean }`
or `{ stream: writable }`. Files resolve against the effective command cwd,
with output overwriting unless `append: true`. Streams may be Node streams or
Web byte streams. Caller streams are borrowed, not closed or destroyed, and
writes drain before completion or cancellation settles.
A caller writer that never settles can delay cancellation. Broker deadlines
remain the hard execution boundary.
Byte input views are borrowed until the command settles, not copied.

Only `"capture"` populates the corresponding result text and byte fields.
Redirected channels return empty text and bytes rather than pretending to be
captured. `cmd.bytes` returns exact captured stdout as a `Uint8Array`, without
text decoding. `text`, `bytes`, `json`, `lines` and query helpers require
captured stdout and reject redirection before opening files or spawning.

### Pipelines and scoped defaults

`cmd.pipe` connects stdout between stages, waits for every stage and returns
the last stage's `CommandResult`. It checks each stage's exit status, so a
successful consumer cannot hide a failed producer. A stage is an argv array
or `{ argv, options }` with independent cwd, environment, timeout and accepted
exit statuses:

{{pipeline}}

This example requires `cat`, `gzip` and a target `./input.bin`. It overwrites
`./input.bin.gz` and appends diagnostics to `./compression.log`. The pipeline
writes its archive directly to a file, then the byte helper reads it for a
binary stdin integrity check.

Context defaults, common pipeline options and stage options apply in that
order. Common `stdin` applies only to the first stage, common `stdout` only to
the last, and common `stderr` to every stage. Explicit downstream `stdin` and
redirected nonterminal `stdout` are rejected before spawning. Intermediate
pipeline output still counts toward each stage's capture limit.
An early consumer closes its upstream pipe, but a broken-pipe producer status
still needs explicit acceptance.

Per-call options override `cmd.with` defaults. Options are `cwd`, `env`,
`stdin`, `stdout`, `stderr`, `signal`, zx `timeout` (for example `"5s"`),
`verbose`, `quiet` and `okExitCodes`. Each command uses Farstep's selected
shell and its resolved scoped environment. Helper timeouts are per process,
not a pipeline-wide deadline. Use the run or batch timeout for an overall
deadline.
Helper signals also interrupt native Effects, including environment loading.
A common pipeline signal cancels every stage, even with stage-specific signals.

If the harness only exposes a JSON device, construct its arguments as an object
and serialize once with `JSON.stringify` in the harness's code tool. Do not
hand-escape JSON around TypeScript around shell. This avoids an extra manual
escaping layer, but does not change where the command executes.

Await every command and helper call. Returning with running zx commands fails
the script and stops those commands. Use `try/finally` for normal cleanup, but
do not rely on JavaScript cleanup during hard cancellation.

For paths that may begin with a dash, use the program's `--` convention or a
`./` prefix. Interpolated strings do not expand `~`. Build paths with
`process.env.HOME` or use the target's absolute paths.

The launch shell loads the chosen environment once. Each zx command uses the
verified Bash or Zsh path with `--noprofile --norc` for Bash or `-f` for Zsh,
and `set -euo pipefail`. Exported variables carry over, but shell-local aliases,
functions and options do not. Prefer `cmd.with` for command-scoped changes
rather than mutating global cwd or environment.

### Bounded parallel work

`cmd.map(items, callback, { concurrency })` uses Effect's concurrency control.
It preserves input order, stops scheduling after a failure, and waits for
started callbacks to settle before rejecting. The callback receives
`(item, index, signal)`. Pass that signal into helpers to cancel active commands
when a peer fails or the map is aborted:

{{packageLoop}}

Replace the package paths. Neither callbacks nor commands are retried.
`concurrency` must be a positive safe integer. A map also accepts `signal` and
inherits a scoped signal. Shared resources still need serialization. Use
{{batchTool}} for independent broker-owned jobs or dependency steps.

For serial control flow, ordinary loops still work:

{{parsedScript}}

### Capture command output without mixing it with progress

`cmd.text`, `cmd.bytes`, `cmd.json` and `cmd.lines` return captured stdout
without printing it. Use `console.log` for result stdout and `console.error`
for progress. `verbose:true` streams command stdout to job stdout and
diagnostics to stderr. Keep verbose output out of parsed JSON or JSONL stdout.

Raw `$` tagged templates remain available for shell syntax and advanced zx
streams. Interpolate external values instead of pre-quoting them. The pinned
zx `.json()` and `.lines()` parse combined stdout and stderr, unlike the
`cmd` helpers. Use `JSON.parse(result.stdout)` for raw zx results.
`quiet:true` suppresses diagnostics, but does not remove captured stderr.

`captureBytes` bounds combined stdout and stderr captured by each zx command.
It defaults to {{captureMiB}} MiB. Exceeding it stops the command and fails the
job, even with `nothrow` or a caught command error. Direct file descriptors and
inherited stdio bypass in-memory command capture. Generic piped streams still
count toward the driver's capture limit. Retaining many command results still
consumes script memory.

Farstep's `output.maxBytes` and `output.maxCaptureBytes` separately bound result
previews and retained artifacts. They do not limit script memory.
`output.maxBytes` cannot exceed 64 KiB and `output.maxCaptureBytes` cannot
exceed 16 MiB. These are not interchangeable with per-command `captureBytes`.
The schema defines source and parameter limits. Source and params travel as
data and are retained in launch arguments. Load secrets from target files,
using scoped literal `dotenv` or top-level shell-sourced `envFiles` as needed.

For a terminal program, use `cmd.run` with `stdin`, `stdout` and `stderr` set
to `"inherit"` and `pty:true`, or await `$({ stdio: "inherit" })`.
Inherited stdio routes input and output directly through the Farstep terminal,
so zx cannot capture that output. Deadline, cancellation and session or persist
lifetime cover the whole script and its child processes. Hard termination may
leave the private temporary script directory behind.

## Run dependent steps

Use {{batchTool}} with named steps and `dependsOn`. In this example, `fetch`
prepares inputs for independent `check` and `build` steps:

{{dependentBatch}}

Use actual recipes and a new `requestId` per intended workflow. Save the ID and
arguments for recovery. Step IDs must be unique and dependencies must reference
existing steps without cycles. Add dependencies for shared outputs or mutable
resources because concurrency does not prevent conflicting writes.

Dependencies wait for completion or a successful guard skip. Server readiness
does not satisfy them. Failed dependencies block descendants. Choose
`onFailure` to control whether independent or already-running work continues.

Batch `env` merges with step overrides. Batch `envFiles` load before step
`envFiles`. Set per-step timeouts explicitly where needed. The batch timeout
bounds the whole workflow. Batches require non-PTY steps. Choose `lifetime` for
how work should behave after client loss.

Batch-level `envFiles` paths use the saved target `cwd`. Step-level paths use
the batch `cwd`, before any per-step `cwd` change. Use absolute paths when that
distinction would be unclear.

## Check readiness and parsed output

Use `ready` to probe the server's actual readiness condition, for example
{{httpReady}}. Replace the URL and status with the service's readiness check and
set a deadline that fits the service. Command probes are TypeScript scripts
too, for example {{scriptReady}}. They repeat, so keep them read-only. After a
readiness failure, inspect the step and cleanup status. Readiness does not mean
completion.

`creates` skips a step if a filesystem entry exists. `removes` skips it if the
entry is absent. Paths use the command `cwd`. Guards neither check freshness nor
lock resources.

Use `output:"json"` or `"jsonl"` with `pty:false` for parsed stdout. Check
returned errors, truncation and artifact paths before using the result. Read
batch details with {{jobTool}} `status` or `logs` and `step:"ID"`.

For parsed output, inspect the step's `output.state` and reported parse errors.
`output.value` contains parsed JSON and `output.records` contains JSONL records.
For example, a step's `output` can contain:

{{parsedOutput}}

`output.stdoutText` contains text output. Use returned artifact paths when
output was retained in a file. Completion alone does not prove parsing
succeeded.

## Recover a launch after transport loss

Set `requestId` before launches that may need recovery. After transport loss,
inspect the handle or reconnect and repeat the same ID and arguments in the same
saved job scope and helper installation. Changed arguments fail. A new ID starts
new work. Read "jobs" for lifetime and input recovery.
