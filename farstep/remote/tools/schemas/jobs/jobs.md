# jobs

## environment

Choose how to load the command environment. shared (default) reloads the target
home's .config/shell/environment.sh. inherit preserves the local caller's
PATH, locale, and XDG variables or the remote gateway baseline. envFiles and
env apply afterward

## files

Source these target shell files with auto-export before the command. Run and
batch-level paths use the saved target cwd. Step-level paths use the batch cwd.
Per-command cwd changes do not change either base

## variables

Export literal environment variables after startup and envFiles. null unsets a
variable. Supports up to {{VARIABLES}} shell identifiers, excluding the reserved
__ai_ prefix, with NUL-free values of at most {{LENGTH}} characters. Values are
stored in launch arguments. Load secrets through target envFiles instead
