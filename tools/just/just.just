set minimum-version := "1.55.0"
set shell := ["bash", "-euo", "pipefail", "-c"]
set positional-arguments

self := quote(just_executable()) + " --justfile " + quote(justfile())
