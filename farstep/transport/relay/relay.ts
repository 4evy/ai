import { spawn } from "node:child_process";
import { pipeline } from "node:stream";
import { Lifetime, run } from "@ai/runtime/effect/effect";
import { seq } from "@optique/core/constructs";
import { formatMessage } from "@optique/core/message";
import { optional, withDefault } from "@optique/core/modifiers";
import { parseSync } from "@optique/core/parser";
import { constant, passThrough, command as subcommand } from "@optique/core/primitives";
import { Deferred, Effect } from "effect";
import {
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
} from "farstep/protocol/desktop/desktop";
import { BoundedFrames } from "farstep/transport/bounds";
import { unzstdFrames, zstdFrames } from "farstep/transport/zstd";

const parsed = parseSync(
  seq(
    optional(subcommand("--wire-codec=zstd", constant(true))),
    withDefault(passThrough({ format: "greedy" }), []),
  ),
  process.argv.slice(2),
);
if (!parsed.success) throw new Error(formatMessage(parsed.error));
const [compressed, argv] = parsed.value;
const [command, ...args] = argv;
if (!command) throw new Error("Missing helper relay command");
await using lifetime = new Lifetime();
const exited = Deferred.makeUnsafe<void>();
const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
let stopping = false;
function stop(error?: Error | null) {
  if (stopping) return;
  stopping = true;
  if (error) {
    process.exitCode = 1;
    process.stderr.write(`${error.message}\n`);
  }
  child.stdin.destroy();
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null)
    return;
  child.kill("SIGTERM");
  lifetime.fork(
    Effect.sleep(1000).pipe(
      Effect.tap(() => Effect.sync(() => child.kill("SIGKILL"))),
      Effect.raceFirst(Deferred.await(exited)),
    ),
  );
}
const inputFinished = (error?: Error | null) => {
  // EOF closes the child's input, but its final response and exit are pending
  if (error) stop(error);
};
child.on("error", (error) => {
  stop(error);
  if (child.pid === undefined) Deferred.doneUnsafe(exited, Effect.void);
});
child.once("spawn", () => {
  // Failed spawns have no usable pipes, so wait until startup succeeds
  if (compressed) {
    pipeline(
      process.stdin,
      new BoundedFrames(MAX_REQUEST_BYTES),
      zstdFrames(MAX_REQUEST_BYTES),
      child.stdin,
      inputFinished,
    );
    pipeline(
      child.stdout,
      unzstdFrames(MAX_RESPONSE_BYTES),
      new BoundedFrames(MAX_RESPONSE_BYTES),
      process.stdout,
      stop,
    );
  } else {
    pipeline(
      process.stdin,
      new BoundedFrames(MAX_REQUEST_BYTES),
      child.stdin,
      inputFinished,
    );
    pipeline(child.stdout, new BoundedFrames(MAX_RESPONSE_BYTES), process.stdout, stop);
  }
});
child.on("exit", (code) => {
  process.exitCode = process.exitCode || code || (code === 0 ? 0 : 1);
  process.stdin.destroy();
  Deferred.doneUnsafe(exited, Effect.void);
});
const interrupt = () => stop();
process.on("SIGTERM", interrupt);
process.on("SIGINT", interrupt);
try {
  await run(Deferred.await(exited));
} finally {
  process.removeListener("SIGTERM", interrupt);
  process.removeListener("SIGINT", interrupt);
}
