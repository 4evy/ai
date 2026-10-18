import { pathValue } from "farstep/client/execution/execution";

export {
  pathValue,
  resolveExecutionCwd,
  resolveRemoteCwd,
} from "farstep/client/execution/execution";

import "@oh-my-pi/pi-coding-agent/discovery/ssh";

import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { attempt, run } from "@ai/core/effect/effect";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/capability";
import { type SSHHost, sshCapability } from "@oh-my-pi/pi-coding-agent/capability/ssh";
import type { SSHConnectionTarget } from "@oh-my-pi/pi-coding-agent/ssh/connection-manager";
import { Effect } from "effect";
import type { ConnectInput } from "./types";

export const configuredHostsEffect = (cwd: string) =>
  attempt(() => loadCapability<SSHHost>(sshCapability.id, { cwd }), {
    awaitOnInterrupt: true,
  }).pipe(Effect.map((result) => ({ hosts: result.items, warnings: result.warnings })));

export function configuredHosts(
  cwd: string,
): Promise<{ hosts: SSHHost[]; warnings: string[] }> {
  return run(configuredHostsEffect(cwd));
}

export function identifier(value: string, label: string): string {
  if (!value || value.startsWith("-") || /[\s\p{Cc}]/u.test(value)) {
    throw new Error(
      `${label} must be nonempty, contain no whitespace/control characters, and not start with '-'`,
    );
  }
  return value;
}

function hostName(value: string): string {
  const host =
    value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  identifier(host, "SSH host");
  if (!isIP(host) && !/^[A-Za-z0-9._-]+$/u.test(host)) {
    throw new Error(
      "SSH host must be a hostname, OpenSSH alias, or IP address; specify ports with the port option",
    );
  }
  return host;
}

function userName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  identifier(value, "SSH username");
  if (/[/@:]/u.test(value))
    throw new Error("SSH username cannot contain '/', '@', or ':'");
  return value;
}

function identity(target: Omit<SSHConnectionTarget, "name">): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        target.host,
        target.username ?? null,
        target.port ?? null,
        target.keyPath ?? null,
        target.compat ?? false,
      ]),
    )
    .digest("hex");
}

export function fileRoot(
  target: SSHConnectionTarget,
  configured: SSHHost | undefined,
  hosts: SSHHost[],
): string {
  if (configured && identity(configured) === identity(target)) {
    return `ssh://${encodeURIComponent(configured.name)}/`;
  }
  // Native URIs have no key option and reject overrides of configured aliases
  if (target.keyPath || hosts.some((host) => host.name === target.host)) return "";
  const host = isIP(target.host) === 6 ? `[${target.host}]` : target.host;
  return `ssh://${target.username ? `${encodeURIComponent(target.username)}@` : ""}${
    host
  }${target.port === undefined ? "" : `:${target.port}`}/`;
}

export function resolveTarget(input: ConnectInput, cwd: string, hosts: SSHHost[]) {
  const configured = hosts.find((host) => host.name === input.target);
  const destination = configured?.host ?? input.target;
  const { destinationHost, embeddedUser } = splitDestination(destination);
  const host = hostName(destinationHost);
  const username = targetUser(input.username, configured?.username, embeddedUser);
  const port = input.port ?? configured?.port;
  validatePort(port);
  const keyPath = targetKey(input.keyPath ?? configured?.keyPath, cwd);
  const facts = targetFacts(host, username, port, keyPath, configured?.compat);
  const digest = identity(facts);
  const target: SSHConnectionTarget = { name: `omp-remote-${digest}`, ...facts };
  const id =
    input.id === undefined ? target.name : identifier(input.id, "Connection id");
  if (id === "local")
    throw new Error("Connection id 'local' is reserved for local execution");
  return { target, id, configured };
}

function splitDestination(destination: string) {
  const parts = destination.split("@");
  const destinationHost = parts.at(-1);
  if (!destinationHost || parts.length > 2 || parts.some((part) => !part)) {
    throw new Error("SSH destination must be host or user@host");
  }
  const embeddedUser = parts.length === 2 ? userName(parts[0]) : undefined;
  return { destinationHost, embeddedUser };
}

function targetUser(
  explicit: string | undefined,
  configured: string | undefined,
  embeddedUser: string | undefined,
): string | undefined {
  const explicitUser = userName(explicit);
  const configuredUser = userName(configured);
  if (embeddedUser && explicitUser && embeddedUser !== explicitUser) {
    throw new Error(
      "SSH username override conflicts with the destination's user@host username",
    );
  }
  if (
    embeddedUser &&
    configuredUser &&
    embeddedUser !== configuredUser &&
    explicitUser === undefined
  ) {
    throw new Error("Configured SSH username conflicts with its user@host destination");
  }
  const username = explicitUser ?? embeddedUser ?? configuredUser;
  return username;
}

function validatePort(port: number | undefined): void {
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error("SSH port must be an integer between 1 and 65535");
  }
}

function targetKey(key: string | undefined, cwd: string): string | undefined {
  let keyPath: string | undefined;
  if (key !== undefined) {
    pathValue(key, "SSH key path");
    if (/\p{Cc}/u.test(key))
      throw new Error("SSH key path cannot contain control characters");
    if (key.startsWith("~") && key !== "~" && !key.startsWith("~/")) {
      throw new Error("SSH key path supports '~/' but not '~name'");
    }
    keyPath = resolve(
      cwd,
      key === "~"
        ? homedir()
        : key.startsWith("~/")
          ? resolve(homedir(), key.slice(2))
          : key,
    );
  }
  return keyPath;
}

function targetFacts(
  host: string,
  username: string | undefined,
  port: number | undefined,
  keyPath: string | undefined,
  compat: boolean | undefined,
) {
  const facts = {
    host,
    ...(username === undefined ? {} : { username }),
    ...(port === undefined ? {} : { port }),
    ...(keyPath === undefined ? {} : { keyPath }),
    ...(compat === undefined ? {} : { compat: compat }),
  };
  return facts;
}
