# script

## script

TypeScript source executed once by the target's bundled Bun and zx. Top-level
await, loops, functions and imports are supported. `$`, `zx` and `params` are
available without imports. Interpolate external values into zx tagged templates;
`$` quotes each scalar and splices arrays into separate arguments. Shell strings
and command trees are no longer accepted. Use `console.log` for result stdout
and `console.error` for progress; zx captures command stdout by default. Await
commands; uncaught failures fail the job. Maximum source 48 KiB
