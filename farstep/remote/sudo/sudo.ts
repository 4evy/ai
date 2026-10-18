import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { attempt, Lifetime, run } from "@ai/core/effect/effect";
import { Effect, Fiber } from "effect";
import {
  type ExecutionTarget,
  resolveRemoteCwd,
} from "../../client/execution/execution";
import type { Gateway } from "../../client/jobs/gateway";
import type { JobSnapshot } from "../../protocol/jobs/protocol";
import { parseJobSpec } from "../../protocol/jobs/protocol";
import { isJobTerminal } from "../../protocol/jobs/states";
import { SudoFrames } from "./frames";
import { type SudoDetails, sudoState, sudoStatus } from "./result";
import { AUTH_SECONDS, type SudoInput, sudoShell } from "./script";

export interface SudoHost {
  owner: string;
  client: Gateway;
  assertCurrent(): void;
  reconnect(installationId: string): Promise<Gateway>;
  requestPassword?: ((signal: AbortSignal) => Promise<string | undefined>) | undefined;
  output(text: string): void;
}

const PROMPT_SECONDS = 120;
const DEFAULT_COMMAND_SECONDS = 60;
const MAX_COMMAND_SECONDS = 3600;
const DEADLINE_GRACE_SECONDS = 5;
const OUTPUT_POLL_MS = 1000;

class SudoExecution {
  readonly state = sudoState();
  #bound: JobSnapshot | undefined;
  #credentialTask: Promise<void> | undefined;
  #deadline: Fiber.Fiber<void> | undefined;
  readonly #lifetime = new Lifetime();
  #stopping: Promise<void> | undefined;
  readonly #cancellation = new AbortController();
  readonly #installationId: string;
  readonly #frames: SudoFrames;

  constructor(
    private readonly host: SudoHost,
    private client: Gateway,
    private readonly spec: ReturnType<typeof parseJobSpec>,
    private readonly input: SudoInput,
    private readonly seconds: number,
    marker: string,
    output: (text: string) => void,
  ) {
    this.#installationId = client.installationId;
    this.#frames = new SudoFrames(marker, output, this.#control);
  }

  async #inspect() {
    this.host.assertCurrent();
    const described = await this.client.request({
      op: "describe",
      name: this.spec.name,
    });
    if (
      described.snapshot.owner !== this.host.owner ||
      !isDeepStrictEqual(described.spec, this.spec) ||
      (this.#bound &&
        (described.snapshot.id !== this.#bound.id ||
          described.snapshot.startedAt !== this.#bound.startedAt ||
          described.snapshot.createdAt !== this.#bound.createdAt))
    )
      throw new Error("Internal sudo native identity changed");
    this.#bound ??= described.snapshot;
    return described.snapshot;
  }

  #stop() {
    this.#stopping ??= (async () => {
      this.client = await this.host.reconnect(this.#installationId);
      const snapshot = await this.#inspect();
      if (isJobTerminal(snapshot.state)) this.state.stopConfirmed = true;
      else {
        const stopped = await this.client.request({
          op: "stop",
          name: this.spec.name,
          timeoutMs: OUTPUT_POLL_MS,
        });
        this.state.stopConfirmed = isJobTerminal(stopped.snapshot.state);
      }
    })().catch(() => {});
    return this.#stopping;
  }

  readonly #cancel = () => {
    this.#cancellation.abort();
    if (this.#bound) void this.#stop();
  };

  #armDeadline(milliseconds: number) {
    this.#deadline?.interruptUnsafe();
    this.#deadline = this.#lifetime.fork(
      Effect.sleep(milliseconds).pipe(
        Effect.andThen(
          Effect.sync(() => {
            this.state.localDeadline = true;
            this.#cancel();
          }),
        ),
      ),
    );
  }

  async #credentials() {
    this.#armDeadline((PROMPT_SECONDS + AUTH_SECONDS + DEADLINE_GRACE_SECONDS) * 1000);
    let password = this.input.password;
    if (password === undefined && this.host.requestPassword) {
      password = await this.host.requestPassword(
        AbortSignal.any([
          AbortSignal.timeout(PROMPT_SECONDS * 1000),
          this.#cancellation.signal,
        ]),
      );
      if (password === undefined) this.state.promptCancelled = true;
    }
    if (this.#cancellation.signal.aborted) return;
    if (password === undefined) {
      this.state.authRequired = !this.state.promptCancelled;
      await this.#stop();
      return;
    }
    if (/[\r\n\0]/u.test(password)) {
      this.state.invalidPrompt = true;
      await this.#stop();
      return;
    }
    this.#armDeadline((AUTH_SECONDS + DEADLINE_GRACE_SECONDS) * 1000);
    await this.#inspect();
    // Credential bytes are sent only to pipe stdin and never copied into metadata
    await this.client.request({
      op: "send",
      name: this.spec.name,
      data: `${password}\n`,
    });
  }

  readonly #controls: Readonly<Record<string, () => void>> = {
    credentials: () => {
      this.#credentialTask ??= run(
        Fiber.join(
          this.#lifetime.fork(
            Effect.uninterruptible(attempt(() => this.#credentials())).pipe(
              Effect.catch(() =>
                attempt(async () => {
                  this.state.promptCancelled = true;
                  await this.#stop();
                }),
              ),
            ),
          ),
        ),
      );
    },
    started: () => {
      this.state.commandStarted = true;
      this.#armDeadline((this.seconds + DEADLINE_GRACE_SECONDS) * 1000);
    },
    timeout: () => {
      this.state.timedOut = true;
    },
    required: () => {
      this.state.authRequired = true;
    },
    rejected: () => {
      this.state.authRejected = true;
    },
  };

  readonly #control = (record: string) => {
    if (Object.hasOwn(this.#controls, record)) this.#controls[record]?.();
    else if (/^done:\d+$/u.test(record)) {
      const value = Number(record.slice(5));
      if (value <= 255) this.state.exitCode = value;
    }
  };

  async run(signal?: AbortSignal): Promise<void> {
    try {
      signal?.throwIfAborted();
      signal?.addEventListener("abort", this.#cancel, { once: true });
      this.#armDeadline((AUTH_SECONDS * 2 + 10) * 1000);
      try {
        await this.client.request(
          { op: "start", spec: this.spec, owner: this.host.owner },
          signal,
        );
      } catch {
        // A lost start reply is inspected, never replayed
        this.client = await this.host.reconnect(this.#installationId);
      }
      let snapshot = await this.#inspect();
      if (signal?.aborted) await this.#stop();
      let cursor = 0;
      for (;;) {
        const finishedBeforeRead = isJobTerminal(snapshot.state);
        const output = await this.client.request({
          op: "output",
          name: this.spec.name,
          follow: !finishedBeforeRead,
          timeoutMs: OUTPUT_POLL_MS,
          cursor,
        });
        if (output.startCursor !== cursor) {
          this.state.outputLost = true;
          throw new Error("Sudo output is no longer retained");
        }
        cursor = output.cursor;
        this.#frames.consume(Buffer.from(output.data, "base64"));
        snapshot = await this.#inspect();
        if (finishedBeforeRead && cursor >= output.availableEnd) break;
        if (this.#cancellation.signal.aborted) {
          await this.#stop();
          break;
        }
      }
    } catch {
      // Channel loss does not establish cancellation or command completion
      this.#cancellation.abort();
    } finally {
      this.#deadline?.interruptUnsafe();
      signal?.removeEventListener("abort", this.#cancel);
      this.#cancellation.abort();
      await this.#credentialTask;
      await this.#stopping;
      await this.#lifetime.close();
      this.#frames.consume(Buffer.alloc(0), true);
    }
  }
}

// Authenticate privately, then run one bounded command with closed stdin
export async function executeSudo(
  connection: Pick<ExecutionTarget, "home" | "cwd" | "bash">,
  input: SudoInput,
  host: SudoHost,
  signal?: AbortSignal,
) {
  const startedAt = Date.now();
  const seconds = input.timeout ?? DEFAULT_COMMAND_SECONDS;
  const details: SudoDetails = { timeoutSeconds: seconds };
  const invalid = validateSudoInput(input, signal);
  if (invalid) return { details, status: invalid, failed: true };
  host.assertCurrent();
  const client = host.client;
  const marker = `\x1eFARSTEP_SUDO_${randomUUID().replaceAll("-", "")}:`;
  const name = `remote-sudo-internal-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const spec = parseJobSpec({
    name,
    application: connection.bash,
    args: [
      "--noprofile",
      "--norc",
      "-c",
      sudoShell(connection, input, seconds, marker),
    ],
    env: client.env,
    cwd: resolveRemoteCwd(connection, input.cwd),
    pty: false,
    persist: false,
  });
  const execution = new SudoExecution(
    host,
    client,
    spec,
    input,
    seconds,
    marker,
    host.output,
  );
  await execution.run(signal);
  details.wallTimeMs = Date.now() - startedAt;
  return {
    details,
    ...sudoStatus(execution.state, details, seconds, signal?.aborted ?? false),
  };
}

export function validateSudoInput(
  input: SudoInput,
  signal?: AbortSignal,
): string | undefined {
  const seconds = input.timeout ?? DEFAULT_COMMAND_SECONDS;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_COMMAND_SECONDS)
    return `Sudo timeout must be greater than zero and at most ${MAX_COMMAND_SECONDS} seconds`;
  if (!input.command?.trim() || input.command.includes("\0"))
    return "Sudo requires a nonempty Bash command without NUL characters";
  if (input.password !== undefined && /[\r\n\0]/u.test(input.password))
    return "Sudo passwords must be single-line values without NUL characters";
  if (signal?.aborted)
    return "Sudo request cancelled before execution; no command was run";
  return undefined;
}
