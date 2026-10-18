# Run a TypeScript script

Call {{runTool}} without target locally or with a saved {{connectTool}} ID for
SSH. Set cwd when switching projects and confirm the target's shell and
toolchain. Observe with {{jobTool}} and the returned handle. Read the schema for
supported options and defaults.

`waitSeconds` limits observation; `timeout` limits execution. Choose `pty:true`
for interactive terminals or `pty:false` for separate stdout/stderr and machine
output. Read "interactive" before terminal input.

## Choose the environment

Prefer the project's task runner and development environment.
`environment:"shared"` loads the target's shared shell setup and stops if it is
unavailable or fails. `environment:"inherit"` preserves permitted caller
variables locally, including activated toolchains; over SSH it uses the remote
gateway environment.

`login:true` loads startup files first. `envFiles` scripts then load in order
with auto-export, followed by explicit `env`. `envFiles` paths use the target's
saved `cwd`; files must be shell scripts. `env` values are literal strings;
`null` unsets a variable. Launch arguments retain `env`, so load secrets through
target `envFiles`. Check executable paths and versions after host or environment
changes.

Changing the job `cwd` does not change the base for `envFiles`. Hypothetical
scripts under a `trials` directory in the saved workspace:

{{environmentPaths}}

Replace those paths with your scripts, or use absolute paths.

## Write TypeScript with zx

Pass TypeScript source in `script` and JSON values in `params`. The entire
script executes once on the target in Farstep's bundled Bun with pinned zx; each
`$` command executes there without another SSH round trip. Shell-string
`command` inputs and structured command trees have been replaced by this
interface.

`$`, `zx` and `params` are available without imports. `zx` exposes helpers such
as `zx.sleep`, `zx.fs`, `zx.cd` and `zx.glob`; `import { $ } from "zx"` also
uses the bundled version. Use top-level await, ordinary TS functions, conditions
and loops. Bun transpiles TypeScript without typechecking it. Built-in imports
and absolute target module paths work. Relative imports resolve from a private
temporary script directory, not job cwd; other packages must already be present
on the target and use absolute paths. No dependencies install during execution.

Use template interpolation for external data; zx quotes scalar values and
splices arrays into separate arguments. Do not pre-quote values. Shell operators
belong in template text. Hypothetical search:

{{literalSearch}}

Replace the search text and path. rg returns 1 for no matches and 2 for errors;
handle expected nonzero exits with `nothrow` and check `exitCode`. Otherwise a
failed command throws, and an uncaught exception fails the job. Await every
command, including concurrent work with `Promise.all`; returning with running
zx commands fails the script and stops those commands. Use `try/finally` for
normal cleanup; hard cancellation cannot guarantee JS cleanup runs.

For paths that may begin with a dash, use the program's `--` convention or a
`./` prefix. Interpolated strings do not expand `~`; build paths with
`process.env.HOME` or use the target's absolute paths.

The launch shell loads the chosen environment once. Each zx command uses the
verified Bash/Zsh path with `--noprofile --norc` for Bash or `-f` for Zsh,
and `set -euo pipefail`.
Exported variables carry over; shell-local aliases, functions and options do
not. Use `process.env` for runtime environment changes, `zx.cd` to change the
script cwd, or `$({ cwd: directory })` for one command's directory.

Hypothetical packages with a check script:

{{packageLoop}}

Replace the package paths. Loops run serially here and stop on an uncaught
failure. Use {{batchTool}} for independent jobs managed by Farstep.

For output parsing and control flow, a hypothetical numeric example:

{{parsedScript}}

### Command capture and progress

zx captures command stdout for `.stdout`, `.json()` and `.lines()` without
printing it by default. Use `console.log` for result stdout and `console.error`
for progress. `$({ verbose: true })` streams command stdout to job stdout and
command diagnostics to stderr; piping suppresses the source's stdout echo.
`quiet:true` suppresses zx diagnostics. Keep verbose command output out of
parsed JSON/JSONL stdout.

`captureBytes` bounds combined stdout/stderr captured by each zx command,
defaulting to 1 MiB (maximum 16 MiB). Exceeding it stops the command and fails
the job, even with `nothrow` or a caught command error. Redirect large output to
a target file, or use inherited stdio to stream without zx capture. Retaining
many command results still consumes script memory.

Farstep's `output.maxBytes` and `output.maxCaptureBytes` separately bound result
previews and retained artifacts; they do not limit script memory. Script source
is limited to 48 KiB; params to 16 KiB and 32 nesting levels. Source and params
travel as data (maximum 96 KiB after JSON encoding) and are retained in launch
arguments; use `envFiles` for secrets.

For a TUI, await `$({ stdio: "inherit" })` with `pty:true`. Inherited stdio
routes input and output directly through the Farstep terminal; zx cannot capture
that output. Deadline, cancellation and session/persist lifetime cover the whole
script and its child processes. Hard termination may leave the private temporary
script directory behind.

## Run dependent steps

Use {{batchTool}} with named steps and `dependsOn`. Here, hypothetical fetch
prepares inputs for independent check and build steps:

{{dependentBatch}}

Use actual recipes and a new requestId per intended workflow; save the ID and
arguments for recovery. Step IDs must be unique; dependencies must reference
existing steps without cycles. Add dependencies for shared outputs or mutable
resources: concurrency does not prevent conflicting writes.

Dependencies wait for completion or a successful guard skip; server readiness
does not satisfy them. Failed dependencies block descendants. Choose onFailure
for whether independent or already-running work should continue. Batch env is
merged with step overrides; batch envFiles load before step envFiles. Set
per-step timeouts explicitly where needed. The batch timeout bounds the whole
workflow. Batches require non-PTY steps; choose lifetime for how work should
behave after client loss.

Batch-level `envFiles` paths use the saved target `cwd`; step-level paths use
the batch `cwd`, before any per-step `cwd` change. Use absolute paths when that
distinction would be unclear.

## Readiness and output

Use `ready` to probe the server's actual readiness condition, for example
{{httpReady}}. Replace the URL and status with the service's readiness check.
Set a deadline that fits the service. Command probes are TypeScript scripts too,
for example {{scriptReady}}. They repeat, so keep them read-only. After
readiness failure, inspect the step and cleanup status. Readiness does not mean
completion.

creates skips if a filesystem entry exists; removes skips if absent. Paths use
command cwd. Guards neither check freshness nor lock resources.

Use `output:"json"` or `"jsonl"` with `pty:false` for parsed stdout. Check
returned errors, truncation and artifact paths before using the result. Read
batch details with {{jobTool}} status/logs and `step:"ID"`.

For parsed output, inspect the step's `output.state` and reported parse errors.
`output.value` contains parsed JSON; `output.records` contains JSONL records. A
hypothetical step's `output`:

{{parsedOutput}}

`output.stdoutText` contains text output. Use returned artifact paths when
output was retained in a file. Completion alone does not prove parsing
succeeded.

Set requestId before launches that may need recovery. After transport loss,
inspect the handle or reconnect and repeat the same ID and arguments in the same
saved job scope and helper installation. Changed arguments fail; a new ID starts
new work. Read "jobs" for lifetime and input recovery.
