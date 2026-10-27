import { hash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { errorMessage } from "@ai/core/error/error";
import { CoordinationStore } from "../coordination/store/store";
import { brokerRoot } from "../platform/processes";
import { PROTOCOL_MAJOR, paths, privateRead, VERSION } from "../state";

async function inspectEntry(
  path: string,
  kind: "directory" | "file" | "socket",
  privateEntry = true,
) {
  try {
    const info = await (privateEntry ? lstat(path) : stat(path));
    const matches =
      kind === "directory"
        ? info.isDirectory()
        : kind === "socket"
          ? info.isSocket()
          : info.isFile();
    if (
      !matches ||
      info.isSymbolicLink() ||
      (privateEntry && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))
    )
      throw new Error("Unexpected entry type, owner or private permissions");
    if (!privateEntry && kind === "file") await access(path, constants.R_OK);
    return { state: "available" as const, path };
  } catch (error) {
    return { state: "unavailable" as const, path, error: errorMessage(error) };
  }
}

export async function doctor(options: {
  command?: string | undefined;
  scope?: string | undefined;
}) {
  const observedAt = Date.now();
  const location = paths();
  const registry = await (async () => {
    try {
      using _store = await CoordinationStore.openReadOnly();
      return {
        state: "available" as const,
        path: join(location.state, "coordination", "registry.sqlite"),
        detail: "Existing registry is readable without initialization or migration",
      };
    } catch (error) {
      return {
        state: "unavailable" as const,
        error: errorMessage(error),
        remedy:
          "Select the owning user's XDG_STATE_HOME and an existing compatible registry. Open coordination through an activated helper if no registry exists.",
      };
    }
  })();
  const broker = await (async () => {
    const unknown = {
      process: { state: "unknown", detail: "No broker process was probed" },
      readiness: {
        state: "unknown",
        detail: "Socket presence does not establish broker responsiveness",
      },
    };
    if (!options.scope)
      return {
        ...unknown,
        endpoint: { state: "unknown", detail: "No scope selected" },
        remedy: "Use work list to find scopeId, then doctor --scope SCOPE_ID",
      };
    try {
      const directory = join(await realpath(location.state), "scopes", options.scope);
      if ((await realpath(directory)) !== directory)
        throw new Error("Broker scope must be a canonical private directory");
      const scopeDirectory = await inspectEntry(directory, "directory");
      if (scopeDirectory.state !== "available") throw new Error(scopeDirectory.error);
      const metadata: unknown = JSON.parse(
        await privateRead(join(directory, "scope.json")),
      );
      const identity: unknown = JSON.parse(
        await privateRead(join(location.state, "installation.json")),
      );
      if (
        typeof metadata !== "object" ||
        metadata === null ||
        !("scopeId" in metadata) ||
        metadata.scopeId !== options.scope ||
        !("owner" in metadata) ||
        typeof metadata.owner !== "string" ||
        !/^remote:[A-Za-z0-9._:-]{1,128}:[A-Za-z0-9._:-]{1,128}$/u.test(
          metadata.owner,
        ) ||
        typeof identity !== "object" ||
        identity === null ||
        !("installationId" in identity) ||
        typeof identity.installationId !== "string" ||
        !("installationId" in metadata) ||
        metadata.installationId !== identity.installationId
      )
        throw new Error("Broker scope ownership or installation identity mismatch");
      const runtime = join(brokerRoot(), hash("sha256", directory));
      const runtimeDirectory = await inspectEntry(runtime, "directory");
      const endpoint =
        runtimeDirectory.state === "available"
          ? await inspectEntry(join(runtime, "broker.sock"), "socket")
          : runtimeDirectory;
      return {
        ...unknown,
        scopeId: options.scope,
        owner: metadata.owner,
        installationId: metadata.installationId,
        endpoint,
        remedy:
          "A missing endpoint may mean an idle broker exited. Recover the owned job handle to inspect recorded work. Start a broker only as part of an intended operation.",
      };
    } catch (error) {
      return {
        ...unknown,
        scopeId: options.scope,
        endpoint: { state: "unavailable", error: errorMessage(error) },
        remedy: "Select an existing scope owned by this installation and user",
      };
    }
  })();
  const runtimeDirectory = await inspectEntry(location.runtime, "directory");
  const desktopEndpoint =
    runtimeDirectory.state === "available"
      ? await inspectEntry(join(location.runtime, "desktop.sock"), "socket")
      : runtimeDirectory;
  const commandPath = options.command ? Bun.which(options.command) : null;
  return {
    observedAt,
    protocolMajor: PROTOCOL_MAJOR,
    version: VERSION,
    inspection: "read-only",
    host: {
      state: "available",
      platform: process.platform,
      architecture: process.arch,
      detail: "This CLI ran on the host. Broker and desktop usability are separate.",
    },
    process: { state: "running", pid: process.pid, resource: "doctor-cli" },
    environment: {
      inherited: { state: "available", detail: "Current CLI process environment" },
      loaded: {
        state: "unknown",
        detail:
          "The CLI cannot observe whether its caller loaded the shared environment. A source file or an available command does not prove it was loaded.",
      },
      sharedSource: await inspectEntry(
        join(homedir(), ".config", "shell", "environment.sh"),
        "file",
        false,
      ),
      command: options.command
        ? {
            name: options.command,
            state: commandPath ? "available" : "unavailable",
            path: commandPath,
            detail: "Lookup in this CLI's PATH only. The command was not executed.",
            ...(!commandPath
              ? {
                  remedy:
                    "Select or load the intended execution environment before running the command",
                }
              : {}),
          }
        : {
            state: "unknown",
            remedy: "Use doctor --command NAME to inspect this CLI's PATH",
          },
    },
    installation: {
      activationRecord: await inspectEntry(
        join(location.state, "installer.json"),
        "file",
      ),
      packageOwnership: {
        state: "unknown",
        detail: "Activation record presence does not verify the installed payload",
      },
    },
    registry,
    broker,
    desktop: {
      endpoint: desktopEndpoint,
      readiness: {
        state: "unknown",
        detail:
          "The desktop backend was not contacted. Socket presence is not readiness.",
      },
      authorization: {
        state: "unknown",
        detail: "No desktop inspection or authorization request was made",
      },
      capture: {
        state: "unknown",
        detail: "No capture was attempted. Authorization does not prove capturability.",
      },
      remedy:
        "Call desktop.inspect on the activated helper to discover permissions and backends. Request authorization separately and capture only when intended.",
    },
  };
}
