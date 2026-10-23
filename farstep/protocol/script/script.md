# script

## script

Execute TypeScript once in the target's bundled Bun with zx. Use top-level
await, loops, functions, and imports. `$`, `zx`, and `params` are available
without imports. Pass external values through `params` and interpolate them
into zx tagged templates. `$` quotes each scalar and splices arrays into
separate arguments.

Use `console.log` for result stdout and `console.error` for progress. zx
captures command stdout by default. Await every command. An uncaught failure
fails the job.

Use `script`, not shell-string commands or command trees. Maximum source size:
{{SOURCE_KIB}} KiB
