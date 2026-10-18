import { spawn } from "node:child_process";
import { pipeline } from "node:stream";
import { Lifetime, run } from "@ai/core/effect/effect";
import { Deferred, Effect } from "effect";
import {
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
} from "farstep/protocol/desktop/desktop";
import { BoundedFrames } from "farstep/transport/bounds";
import { unzstdFrames, zstdFrames } from "farstep/transport/zstd";

const argv = process.argv.slice(2);
const compressed = argv[0] === "--wire-codec=zstd";
if (compressed) argv.shift();
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
if (compressed) {
  pipeline(
    process.stdin,
    new BoundedFrames(MAX_REQUEST_BYTES),
    zstdFrames(MAX_REQUEST_BYTES),
    child.stdin,
    stop,
  );
  pipeline(
    child.stdout,
    unzstdFrames(MAX_RESPONSE_BYTES),
    new BoundedFrames(MAX_RESPONSE_BYTES),
    process.stdout,
    stop,
  );
} else {
  pipeline(process.stdin, new BoundedFrames(MAX_REQUEST_BYTES), child.stdin, stop);
  pipeline(child.stdout, new BoundedFrames(MAX_RESPONSE_BYTES), process.stdout, stop);
}
child.on("error", (error) => {
  stop(error);
  if (child.pid === undefined) Effect.runSync(Deferred.succeed(exited, undefined));
});
child.on("exit", (code) => {
  process.exitCode = process.exitCode || code || (code === 0 ? 0 : 1);
  process.stdin.destroy();
  Effect.runSync(Deferred.succeed(exited, undefined));
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
