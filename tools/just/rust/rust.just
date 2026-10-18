import '../just.just'
set working-directory := '../../..'
set default-list

# Build the workspace; accepts Cargo flags such as --release
build *args:
    cargo build --locked --workspace --all-features "$@"

# Run workspace tests; accepts Cargo filters and flags
test *args:
    cargo test --locked --workspace --all-features "$@"
