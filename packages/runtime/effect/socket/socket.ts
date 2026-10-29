import { createConnection, type NetConnectOpts, type Socket } from "node:net";
import { errorMessage } from "@ai/values/error/error";
import { Effect } from "effect";

// Ownership transfers to the caller only after connection succeeds
export function connectSocket(options: NetConnectOpts): Effect.Effect<Socket, Error> {
  return Effect.callback((resume) => {
    let socket: Socket;
    try {
      socket = createConnection(options);
    } catch (error) {
      resume(
        Effect.fail(error instanceof Error ? error : new Error(errorMessage(error))),
      );
      return;
    }
    const detach = () => {
      socket.off("connect", connected);
      socket.off("error", failed);
      socket.off("close", closed);
    };
    const connected = () => {
      detach();
      resume(Effect.succeed(socket));
    };
    const failed = (error: Error) => {
      detach();
      socket.destroy();
      resume(Effect.fail(error));
    };
    const closed = () => failed(new Error("Connection closed before connecting"));
    socket.once("connect", connected);
    socket.once("error", failed);
    socket.once("close", closed);
    // Register allocation and cancellation together so interruption cannot leak a
    // socket
    return Effect.sync(() => {
      detach();
      // Native connect can report an error after cancellation destroys the socket
      socket.on("error", () => {});
      socket.destroy();
    });
  });
}

export function scopedSocket(options: NetConnectOpts) {
  return Effect.acquireRelease(
    connectSocket(options),
    (socket) => Effect.sync(() => socket.destroy()),
    { interruptible: true },
  );
}
