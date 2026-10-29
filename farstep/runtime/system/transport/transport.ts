import { run } from "@ai/runtime/effect/effect";
import { scopedSocket } from "@ai/runtime/effect/socket/socket";
import { ConcatSink } from "@oh-my-pi/pi-utils/stream";
import { toError } from "@oh-my-pi/pi-utils/type-guards";
import { Effect } from "effect";
import { parseSystemReply } from "farstep/protocol/system";

// This service uses one bounded JSON reply per connection, without JSON-RPC IDs
export function systemRequest(
  endpoint: string,
  operation: object,
  timeout: number,
  signal?: AbortSignal,
): Promise<unknown> {
  return run(
    Effect.scoped(
      Effect.gen(function* () {
        let detach = () => {};
        const socket = yield* scopedSocket({ path: endpoint });
        yield* Effect.addFinalizer(() => Effect.sync(() => detach()));
        return yield* Effect.callback<unknown, Error>((resume) => {
          const buffer = new ConcatSink();
          let size = 0;
          const fail = (error: Error) => resume(Effect.fail(error));
          const end = () =>
            fail(new Error("System service disconnected before replying"));
          const data = (chunk: Buffer) => {
            size += chunk.length;
            if (size > 4 * 1024 * 1024) {
              fail(new Error("System response exceeds 4 MiB"));
              return;
            }
            try {
              for (const line of buffer.appendAndFlushLines(chunk)) {
                resume(
                  Effect.succeed(parseSystemReply(Buffer.from(line).toString("utf8"))),
                );
                return;
              }
            } catch (error) {
              fail(toError(error));
            }
          };
          detach = () => {
            socket.removeListener("error", fail);
            socket.removeListener("end", end);
            socket.removeListener("data", data);
          };
          socket.on("error", fail);
          socket.on("end", end);
          socket.on("data", data);
          socket.write(`${JSON.stringify(operation)}\n`);
        });
      }),
    ).pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () => Effect.fail(new Error("System service response timed out")),
      }),
    ),
    signal,
  );
}
