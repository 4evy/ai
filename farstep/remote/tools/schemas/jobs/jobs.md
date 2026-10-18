# jobs

## environment

Environment policy; shared (default) reloads the target home's
.config/shell/environment.sh; inherit preserves local caller PATH/locale/XDG or
the remote gateway baseline; envFiles/env apply afterward

## files

Target shell files to source with auto-export before the command; run and
batch-level paths are relative to saved target cwd, step-level paths to batch
cwd, before per-command cwd changes

## variables

Custom literal variables exported after startup and envFiles; null unsets. Up to
{{VARIABLES}} shell identifiers (except reserved __ai_) with NUL-free values of
at most {{LENGTH}} characters. Values are stored in launch arguments; load
secrets from target envFiles instead
