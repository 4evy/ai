import {
  buildRemoteCommand,
  type SSHConnectionTarget,
} from "@oh-my-pi/pi-coding-agent/ssh/connection-manager";
import type { RemoteFileTransferAdapter } from "@oh-my-pi/pi-coding-agent/ssh/file-transfer";
import { wrapInPosixShell } from "@oh-my-pi/pi-coding-agent/ssh/utils";
import { $which, ptree } from "@oh-my-pi/pi-utils";
import { isSameMachineSSH } from "./endpoint";

// Static binding reaches native ssh:// and blob callers before extensions load
export const fileTransferAdapter: RemoteFileTransferAdapter | undefined =
  createFileTransfer;

function requireZstd(): void {
  if (!$which("zstd"))
    throw new Error(
      "Remote file transfers require zstd on the local and remote PATH; no gzip fallback is used",
    );
}

/** Keep compression and process lifetimes out of upstream's file operations */
async function createFileTransfer(
  target: SSHConnectionTarget,
  opts: { signal?: AbortSignal; timeoutMs?: number },
) {
  const signal = ptree.combineSignals(opts.signal, opts.timeoutMs ?? 30_000);
  const options = signal ? { signal } : {};
  const compressed = !(await isSameMachineSSH(target, { signal }));
  if (compressed) requireZstd();
  return {
    inputCommand: compressed ? "zstd -q -d -c -M64MB" : "cat",
    async read(
      shell: "sh" | "bash" | "zsh",
      command: string,
      limit: number,
    ): Promise<Uint8Array> {
      // Group the full producer list so every successful branch is compressed
      // Stage the bounded prefix so a producer failure cannot be hidden by a pipe
      const remote = compressed
        ? `command -v zstd >/dev/null 2>&1 || { echo 'ssh://: remote zstd is required' >&2; exit 1; }; ` +
          `t=$(mktemp) || exit 1; trap 'rm -f -- "$t"' 0; {\n${command}\n} > "$t" && zstd -q -c -- "$t"`
        : command;
      const args = await buildRemoteCommand(target, wrapInPosixShell(shell, remote));
      using child = ptree.spawn(["ssh", ...args], options);
      if (compressed) {
        using decoder = ptree.spawn(["zstd", "-q", "-d", "-c", "-M64MB"], {
          stdin: "pipe",
          ...options,
        });
        const [raw] = await Promise.all([
          boundedTransferBytes(decoder.stdout, limit),
          pipeTransferBytes(child.stdout, decoder.stdin),
          child.exitedCleanly,
        ]);
        // Preserve remote exit codes before an empty decoder stream can fail
        await decoder.exitedCleanly;
        return raw;
      }
      const [raw] = await Promise.all([
        boundedTransferBytes(child.stdout, limit),
        child.exitedCleanly,
      ]);
      return raw;
    },
    async write(
      shell: "sh" | "bash" | "zsh",
      command: string,
      content: Uint8Array,
    ): Promise<void> {
      const args = await buildRemoteCommand(target, wrapInPosixShell(shell, command), {
        allowStdin: true,
      });
      if (compressed) {
        using encoder = ptree.spawn(["zstd", "-q", "-c"], {
          stdin: content,
          ...options,
        });
        using child = ptree.spawn(["ssh", ...args], {
          stdin: "pipe",
          ...options,
        });
        await Promise.all([
          child.bytes(),
          pipeTransferBytes(encoder.stdout, child.stdin),
          child.exitedCleanly,
          encoder.exitedCleanly,
        ]);
      } else {
        using child = ptree.spawn(["ssh", ...args], { stdin: content, ...options });
        await Promise.all([child.bytes(), child.exitedCleanly]);
      }
    },
  };
}

/** Drain without allowing a remote decoder to exceed the requested byte bound */
async function boundedTransferBytes(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of stream) {
    length += chunk.length;
    if (length > limit) throw new Error("SSH transfer exceeded its byte bound");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

async function pipeTransferBytes(
  stream: ReadableStream<Uint8Array>,
  sink: Bun.FileSink,
): Promise<void> {
  try {
    for await (const chunk of stream) {
      sink.write(chunk);
      await sink.flush();
    }
  } finally {
    await sink.end();
  }
}
