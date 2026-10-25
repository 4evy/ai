# Setup and development

Run commands from the repository root. Read the relevant implementation before
changing behavior, and take versions from manifests and pins. Keep
implementation details in nearby comments or docstrings, not in this guide.

## Set up and find commands

Use the versions declared by the
[Nix development shell](../tools/nix/dev/dev.nix) and
[package.json](../package.json):

```sh
just dev
just install
```

The [Nix shell](../tools/nix/dev/dev.nix) supplies the development tools. Run a
single command with `just dev just check types`. Without Nix, install the
declared Bun version, Just, and the task's native dependencies, then run
`just install`. Prefer Linux for Linux builds and Nix work, and macOS for Darwin
work.

`just install` uses frozen lockfiles without lifecycle scripts. Root workspaces
share `bun.lock`. Distribution manifests under `tools/runtime/`,
`farstep/dependencies/`, and `apps/omp/runtime/upstream/` have separate
lockfiles.

| Command                                      | Purpose                               |
| -------------------------------------------- | ------------------------------------- |
| `just`                                       | List the recipe tree                  |
| `just help omp patches check`                | Show a recipe's implementation        |
| `just --dry-run nix build farstep --no-link` | Preview a command                     |
| `ai --help` or `ai GROUP --help`             | Discover installed utilities          |
| `bun tools/scripts/cli/cli.ts --help`        | Discover CLI routes from the checkout |

## Choose where a change belongs

Keep machine behavior in Farstep, harness policy and presentation in the app
adapter, and reusable utilities in core. Runtime imports flow from apps to
Farstep to core. Apps can also import core directly.

| Path                                    | Owns                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------- |
| `packages/core/`                        | Generic contracts, Effect lifetimes, processes, observability          |
| `apps/omp/extensions/`, `apps/omp/lib/` | OMP tools, session policy, UI, adapters                                |
| `apps/omp/runtime/`                     | Upstream pin, maintained patches, overlays, generated npm patches      |
| `apps/chatgpt/`                         | App integration, plugins, REPL, computer-use policy                    |
| Other `apps/` directories               | CLI launchers, browser utilities, Ghidra integration                   |
| `config/settings/`                      | Declared settings, host discovery, exports                             |
| `tools/`                                | Recipes, maintenance scripts, Nix builds, distribution dependencies    |
| `farstep/protocol/`                     | Shared wire contracts, schemas, limits, receipts                       |
| `farstep/transport/`                    | Framing, connections, desktop RPC, relay                               |
| `farstep/client/`                       | Discovery, jobs, terminals, files, desktop and Sky clients             |
| `farstep/remote/`, `farstep/skylight/`  | Harness-independent tools and agent guides                             |
| `farstep/runtime/`                      | Machine entry points, jobs, coordination, activation, Sky provisioning |
| `farstep/native/`                       | Rust protocol, desktop backends, privileged service                    |
| `farstep/packaging/`, `farstep/sky/`    | Platform payloads and generated Sky declarations                       |

Protocol code imports neither clients nor implementations. Clients and runtime
may use transport but do not import each other. Use workspace package exports
across workspaces, and relative imports or workspace aliases within them. Check
[Farstep exports](../farstep/package.json) before adding an entry point.
Register new subprocess entry points in
[vite.config.ts](../farstep/vite.config.ts).

For execution changes, preserve these ownership and recovery rules:

- The job broker owns processes and output. Gateways connect clients to it.
  Persistent jobs can outlive a connection or RPC wait.
- Presence leases do not establish whether an OS process stopped.
- A timeout does not prove an action failed. Query job state or receipts before
  retrying, and never replay commands or desktop input automatically.
- Completion delivery requires acknowledgement of its stable completion ID.
- Desktop input uses frame IDs to reject stale captures. Input acknowledgement
  does not prove the application finished its action.
- Negotiate identity, protocol major, and capabilities before issuing
  operations. Update both Rust and TypeScript wire contracts when changing
  shared fields.

## Compose Effect at runtime boundaries

Use the installed Effect version's source and examples under
`node_modules/effect/src/` and `node_modules/effect/ai-docs/`. Keep pure
transformations, schemas, and host-specific callbacks in their native form.

Compose internal operations before crossing a Promise boundary. Use the shared
[`run`, `attempt`, and `Lifetime`](../packages/core/effect/effect.ts)
integration to preserve native errors, cancellation, and tracing. Use
`awaitOnInterrupt` when a native operation must settle before releasing its
resources or reporting cancellation. Keep operation spans sanitized through
`operationEffect`.

Let scopes own resources with `Effect.acquireRelease` or
`Effect.acquireDisposable`, and scoped fibers own background work. Prefer
Effect's existing stream operators and the shared
[process](../packages/core/effect/process/process.ts) and
[file](../packages/core/effect/fs/fs.ts) resources over hand-written cleanup.
Choose concurrency explicitly with `Effect.all` or `Effect.forEach`. Do not
add retries around commands, file writes, or desktop input whose outcome may
already have taken effect.

Acquire MCP clients with
[`McpSession.acquireEffect`](../packages/core/mcp/session/session.ts).
The caller supplies protocol negotiation, while the acquisition scope owns
startup, immediate rollback, and the negotiated session's lifetime.

Compile tool definitions with
[`compileSchemaTool` or `compileEffectTool`](../packages/core/tool/tool.ts).
Host adapters register compiled tools instead of projecting and parsing schemas
again. Name a handler's result type when its progress callback makes inference
circular. Core carries that result type through progress and completion, so
adapters must explicitly map content their host cannot represent.

## Check and format changes

Run checks covering the changed behavior on its target platform. Create or
modify tests only when Evy asks.

| Command                                | Scope                                                   |
| -------------------------------------- | ------------------------------------------------------- |
| `just check types`                     | Root and workspace typechecks                           |
| `just check biome`                     | TypeScript, JavaScript, JSON lint and formatting        |
| `just check architecture`              | Import boundaries, unresolved imports, cycles           |
| `just check dependencies`              | Knip dependency checks                                  |
| `just check patches`                   | OMP runtime and SDK patches, including generated output |
| `just check sky`                       | Sky declarations against local pins                     |
| `just check rust`                      | Rust formatting, minimal features, workspace Clippy     |
| `bun run test`                         | Existing core tests                                     |
| `just check build`                     | Root and workspace builds                               |
| `just check github`, `just check just` | Workflows and recipes                                   |
| `just check powershell`                | PowerShell analysis, run separately                     |
| `just nix eval`, `just nix check`      | Nix evaluation and current-platform checks              |

`just check` runs the root checks, excluding PowerShell and Nix. See
[package.json](../package.json) and [check.just](../tools/just/check/check.just)
for exact commands. For a focused build or typecheck, run `bun run build` or
`bun run typecheck` in the workspace directory.

Use `just fmt` (`nix fmt`) for formatting, or target this guide with:

```sh
just fmt all --no-cache docs/guide.md
```

Markdown uses rumdl with 80-column prose reflow and aligned tables. Run
`rumdl check` after formatting. Treefmt's `--fail-on-change` modifies the
working copy before reporting changes. The flake's `treefmt` check uses a
temporary copy instead.

Edit maintained sources and regenerate their output with the owning command.
Keep build output, credentials, sessions, databases, and personal records out of
the tracked repository.

Keep agent guides in Markdown and render changing facts from their owning
implementation with `{{name}}` placeholders. Use
[`readGuide`](../packages/core/guide/guide.ts) for full guides and
[`readText`](../packages/core/text/text.ts) for named text sections. Keep
`readText` section headings unchanged because callers use them as keys.
Generate request examples with `guideExample` so schemas validate them before
rendering. Derive limits, tool names, and action lists from their source
constants or schemas, not a second set of literals. Keep stable instructions
in prose and link to source files in documents, like this one, that have no
template-rendering step.

## Install and activate

`nix profile add .#ai-tools` installs the launcher bundle. `ai setup` and
`ai update` install upstream CLIs through Bun and prepare OMP's pinned patched
runtime in the user cache. Use `ai update TOOL` for one tool and `--dry-run` to
preview package changes. See [setup.ts](../tools/scripts/setup/setup.ts).

Build without installing with `just nix build OUTPUT --no-link`. Outputs include
`ai-tools`, `ai-javascript`, `farstep`, `farstep-native`, `farstep-sky`,
`ai-configs`, `chatgpt`, and `ghidra-mcp`.

For declarative settings, import `ai.homeManagerModules.default`,
`ai.nixosModules.default`, or `ai.darwinModules.default`. Set
`programs.ai.enable`, then override individual tools as needed. ChatGPT and
Farstep desktop are enabled separately. On nix-darwin, enable
`programs.ai.user.enable` and declare the primary user's home to activate
settings. See [options](../tools/nix/common/common.nix) and the
[Darwin adapter](../tools/nix/darwin/darwin.nix).

Activation preserves undeclared writable settings. `just config generate` and
`just config export` stage settings for inspection, not activation.

## Maintain integrations and pins

| Task                                        | Command or source                                                      |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| Check or regenerate OMP patches             | `just omp patches check`, `just omp patches sync`                      |
| Update OMP's pinned release                 | `just omp update VERSION`                                              |
| Bundle Linux desktop extensions             | `just farstep extensions --out .generated/extensions`                  |
| Build native Rust code                      | `just rust build --release`, `just rust test`                          |
| Package Farstep                             | `just farstep package --help`                                          |
| Configure ChatGPT plugins and policy        | `ai chatgpt configure`                                                 |
| Check or regenerate pinned Sky declarations | `just sky check`, `just sky sync`                                      |
| Verify downloads or update Sky pins         | `just sky verify`, `just sky update`                                   |
| Select a macOS ChatGPT archive              | `just nix update chatgpt --version=MAJOR.MINOR.BUILD`                  |
| Install Ghidra on Unix                      | `ai ghidra install`                                                    |
| Install Ghidra on Windows                   | `bun tools/scripts/cli/cli.ts ghidra install`                          |
| Connect a Ghidra backend                    | `ai ghidra mcp headless`                                               |
| Update Ghidra MCP                           | `just ghidra update`                                                   |
| Update API headers                          | `just nix update ghidra-apple-api-types` or `ghidra-windows-api-types` |
| Refresh Bun hashes or PowerShell analyzer   | `just nix update bun` or `powershell-analyzer`                         |
| Regenerate Bun-to-Nix dependencies          | `just nix deps`                                                        |
| Refresh flake inputs                        | `nix flake update`                                                     |

Keep OMP patches small, independently applicable, and zero-fuzz. Prefer
extensions for tools and presentation. Leave upstream branches intact when a
narrow hook suffices, and regenerate edited hunks against the pinned source
rather than retaining coordinates from earlier releases. After an upgrade,
check a fresh interactive launch and first message. Inspect launcher stderr
for fallback to an older cached runtime. See
[patch maintenance](../tools/scripts/omp/patches/patches.ts) and
[runtime launch](../tools/scripts/omp/runtime/launch.ts).

Build Farstep on its target platform. On Unix, build `.#farstep` with Nix and
run the output's `bin/farstep install --package-path /nix/store/...`. Remote
installs require a trusted store output on the target. Windows packaging
requires Bun, Rust, .NET, and WiX. Read [packaging](../farstep/packaging/)
before deployment.

`ai chatgpt configure` modifies plugins and app policy. Relaunch ChatGPT after
launcher environment changes. Sky archives and checksums live in
[pins.json](../farstep/runtime/sky/runtime/pins.json). Platforms release
independently, so a version string alone does not establish matching artifacts.

Ghidra MCP is manually started in OMP with `mcp start`, selecting `ghidra`, and
closes when its owning session finishes. Save analysis to a Ghidra project
before backend shutdown. For bridge lifetimes and configuration, read
[headless.sh](../apps/ghidra/mcp/headless.sh). API-type profile definitions live
in
[profiles.json](../apps/ghidra/extensions/profiles.json).

Review pin, hash, lockfile, and generated-file changes together. Renovate's
[artifact workflow](../tools/scripts/renovate/artifacts.ts) synchronizes derived
inputs. Read the [runner](../.github/scripts/renovate/renovate.ts) before
changing automation.

The scheduled Renovate workflow requires the repository Actions secret
`RENOVATE_TOKEN`, containing a separate token with contents, pull requests,
issues, and workflows write access. Restrict fine-grained tokens to this
repository and renew them before expiry. The default `GITHUB_TOKEN` cannot
replace it because updates must trigger CI and may change workflow files.

## Commit changes by domain in OMP

Use `/commit` to have the current AI review `jj diff` and `jj st`, group the
working-copy changes by purpose, and create a separate `jj commit` for each
domain. Add scope with `/commit <instructions>`, such as
`/commit only the remote execution changes`.

The [file-based command](../apps/omp/commands/commit.md) keeps related code,
tests, documentation, and generated files together. It requires selective
commits when files span domains, stops rather than creating empty commits or
committing conflicts or suspected secrets, and reports commit IDs and remaining
changes. It does not push or move bookmarks.

This is a prompt workflow, not a plugin or a deterministic commit engine. The
AI uses the current session's tools and repository instructions. The shared
OMP settings module installs it at `~/.omp/agent/commands/commit.md`. For a
checkout-only setup, copy the command into the target repository's
`.omp/commands/commit.md`, then reload OMP.

## Start a quick chat in OMP

Use `/quick` to start a new, empty chat with `openai-codex/gpt-6-luna`.
The [quick extension](../apps/omp/extensions/quick/index.ts) keeps the
previous conversation intact and selects Luna only for the new chat. It
does not update the configured default or last-used model. Closing and
reopening OMP restores the normal model, including when resuming this chat.
Starting another chat with `/new` also leaves the quick model behind.

The extension ships with the default OMP extensions and requires the pinned
patched runtime. For a checkout-only run, load it with
`omp -e ./apps/omp/extensions/quick/index.ts`.

## Improve a prompt before sending

In OMP's interactive editor, write a draft and press **Alt+I**. The
[prompt-improvement extension](../apps/omp/extensions/improve/index.ts) uses
**GPT-6 Luna at low effort with Standard service**, independently of the main
chat's model, effort, and `/fast` setting. Review or edit the result, then
press **Ctrl+Shift+Enter** to put it back in the composer. It is not sent
until you submit it normally.
Press **Escape** during generation or review to keep your original draft.
Provider errors also leave the original intact. The rewrite must preserve file
and model mentions, skill and attachment chips, links, and leading slash
commands. If the model changes those references, the original draft is kept.
Backticks around file mentions and newly adjacent prose punctuation after
links do not count as changed references. Shell input (`!` and `$` prefixes)
is not rewritten.

Like [Super's enhancement action][super-enhance], improvement aims to clarify
the deliverable and make success concrete, not just paraphrase. Its isolated,
tool-free request uses the current branch's recorded conversation context,
without adding chat messages or changing the main agent's settings. It does
not run a separate repository-research pass or invent facts about unread
files. If Luna is unavailable or the request fails, the original draft is
kept rather than silently falling back to an expensive model.

You can also use `/improve <prompt>`, or `/improve` to open a draft editor.
The extension ships with the default OMP extensions. For a checkout-only run,
load it with `omp -e ./apps/omp/extensions/improve/index.ts`.

Override only the rewrite route with `--improve-model PROVIDER/MODEL` (or a
configured model-role alias). Add `--improve-fast` only when you deliberately
want premium Fast service for rewriting. Neither option changes the main
chat. The generation indicator shows the rewrite model and service tier.

[super-enhance]: https://super.engineering/docs/terminal-and-chat/#enhance-a-prompt
