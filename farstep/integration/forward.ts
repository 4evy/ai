import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import type { ToolClient } from "./client";

export async function forwardService(
  client: ToolClient,
  name: string,
  localPort: number,
  signal: AbortSignal,
  onReady: (result: unknown) => void,
) {
  const connection = client.connection;
  const sshArgs = connection.sshArgs;
  if (!sshArgs) throw new Error("Forwarding requires an SSH target");
  const described = await client.inspect(name);
  const remotePort = described.spec.ready?.port;
  if (
    !remotePort ||
    described.spec.ready?.host !== "127.0.0.1" ||
    described.snapshot.readyAt === undefined ||
    !["ready", "running"].includes(described.snapshot.state)
  )
    throw new Error(
      "Forwarding requires a live job with completed 127.0.0.1 TCP readiness",
    );
  signal.throwIfAborted();
  const channels = new Map<ChildProcessWithoutNullStreams, Socket>();
  // This process owns the listener, so even abrupt death cannot leave a preview
  // listening in an orphaned SSH process or shared OpenSSH control master
  const server = createServer((socket) => {
    if (signal.aborted) {
      socket.destroy();
      return;
    }
    const channel = spawn(
      "ssh",
      [
        ...sshArgs,
        "-o",
        "ControlMaster=no",
        "-o",
        "ControlPath=none",
        "-o",
        "ControlPersist=no",
        "-o",
        "ClearAllForwardings=yes",
        "-W",
        `127.0.0.1:${remotePort}`,
        connection.input.target,
      ],
      { stdio: "pipe" },
    );
    channels.set(channel, socket);
    socket.pipe(channel.stdin);
    channel.stdout.pipe(socket);
    channel.stderr.pipe(process.stderr, { end: false });
    const close = () => {
      socket.destroy();
      channel.kill("SIGTERM");
    };
    channel.once("error", close);
    channel.once("close", () => {
      channels.delete(channel);
      socket.destroy();
    });
    channel.stdin.on("error", close);
    channel.stdout.on("error", close);
    socket.on("error", close);
    socket.once("close", () => channel.kill("SIGTERM"));
  });
  const bound = Promise.withResolvers<void>();
  server.once("error", bound.reject);
  server.listen(localPort, "127.0.0.1", bound.resolve);
  try {
    await bound.promise;
    signal.throwIfAborted();
    onReady({
      ...client.identity(),
      name,
      nativeId: described.snapshot.id,
      localUrl: `http://127.0.0.1:${localPort}`,
      localPort,
      remotePort,
      lifetime: "forward-process-and-job",
    });
    while (!signal.aborted) {
      const current = await client.inspect(name);
      if (
        current.snapshot.id !== described.snapshot.id ||
        !["ready", "running"].includes(current.snapshot.state)
      )
        return;
      try {
        await delay(500, undefined, { signal });
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    }
  } finally {
    const closed = Promise.withResolvers<void>();
    if (server.listening) server.close(() => closed.resolve());
    else closed.resolve();
    const processes = [...channels].map(async ([child, socket]) => {
      const exited = Promise.withResolvers<void>();
      child.once("close", exited.resolve);
      socket.destroy();
      child.kill("SIGTERM");
      using _timer = setTimeout(() => child.kill("SIGKILL"), 2000);
      await exited.promise;
    });
    await Promise.all([closed.promise, ...processes]);
  }
}
