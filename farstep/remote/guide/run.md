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

## Write TypeScript with zx

Pass TypeScript source in `script` and JSON values in `params`. The entire
script executes once on the target in Farstep's bundled Bun with pinned zx. Each
`$` command executes there without another SSH round trip.

`$`, `zx` and `params` are available without imports. `zx` exposes helpers such
as `zx.sleep`, `zx.fs`, `zx.cd` and `zx.glob`. `import { $ } from "zx"` also
uses the bundled version. Use top-level await, ordinary TypeScript functions,
conditions and loops. Bun transpiles TypeScript without typechecking it.

Built-in imports and absolute target module paths work. Relative imports resolve
from a private temporary script directory, not the job `cwd`. Other packages
must already be present on the target and use absolute paths. Farstep installs
no dependencies during execution.

Use template interpolation for external data. zx quotes scalar values and
splices arrays into separate arguments. Do not pre-quote values. Put shell
operators in template text. For example, search for literal text with:

{{literalSearch}}

Replace the search text and path. `rg` returns 1 for no matches and 2 for
errors. Handle expected nonzero exits with `nothrow` and check `exitCode`.
Otherwise, a failed command throws and an uncaught exception fails the job.

Await every command, including concurrent work with `Promise.all`. Returning
with running zx commands fails the script and stops those commands. Use
`try/finally` for normal cleanup, but do not rely on JavaScript cleanup during
hard cancellation.

For paths that may begin with a dash, use the program's `--` convention or a
`./` prefix. Interpolated strings do not expand `~`. Build paths with
`process.env.HOME` or use the target's absolute paths.

The launch shell loads the chosen environment once. Each zx command uses the
verified Bash or Zsh path with `--noprofile --norc` for Bash or `-f` for Zsh,
and `set -euo pipefail`. Exported variables carry over, but shell-local aliases,
functions and options do not. Use `process.env` for runtime environment changes,
`zx.cd` to change the script `cwd`, or `$({ cwd: directory })` for one command's
directory.

For example, check packages that each have a `check` script:

{{packageLoop}}

Replace the package paths. This loop runs serially and stops on an uncaught
failure. Use {{batchTool}} for independent jobs managed by Farstep.

For output parsing and control flow, this example collects positive counts:

{{parsedScript}}

### Capture command output without mixing it with progress

zx captures command stdout for `.stdout`, `.json()` and `.lines()` without
printing it by default. Use `console.log` for result stdout and `console.error`
for progress. `$({ verbose: true })` streams command stdout to job stdout and
command diagnostics to stderr. Piping suppresses the source's stdout echo.
`quiet:true` suppresses zx diagnostics. Keep verbose command output out of
parsed JSON or JSONL stdout.

`captureBytes` bounds combined stdout and stderr captured by each zx command.
It defaults to {{captureMiB}} MiB. Exceeding it stops the command and fails the
job, even with `nothrow` or a caught command error. Redirect large output to a
target file, or use inherited stdio to stream without zx capture. Retaining
many command results still consumes script memory.

Farstep's `output.maxBytes` and `output.maxCaptureBytes` separately bound result
previews and retained artifacts. They do not limit script memory. The schema
defines source and parameter limits. Source and params travel as data and are
retained in launch arguments, so use `envFiles` for secrets.

For a terminal program, await `$({ stdio: "inherit" })` with `pty:true`.
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
