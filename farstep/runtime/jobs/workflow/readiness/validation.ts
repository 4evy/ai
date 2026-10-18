import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { Match } from "effect";
import * as v from "valibot";
import {
  type WorkflowReady,
  workflowReadySchema,
} from "#farstep/protocol/workflow/workflow";

function validateHttpReadiness(ready: Extract<WorkflowReady, { kind: "http" }>): void {
  const url = new URL(ready.url);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("HTTP readiness requires an http or https URL");
  // URL normalizes empty userinfo away, so also inspect the input authority
  const authority = ready.url
    .trim()
    .replace(/^[^:]+:[/\\]*/u, "")
    .split(/[/\\?#]/u, 1)[0];
  if (url.username !== "" || url.password !== "" || authority?.includes("@"))
    throw new Error("HTTP readiness URLs must not contain userinfo");
}

function validateTcpReadiness(ready: Extract<WorkflowReady, { kind: "tcp" }>): void {
  if (/[\s/\\@?#:]/u.test(ready.host))
    throw new Error("TCP readiness requires a hostname or IP address");
  const hostname = domainToASCII(ready.host);
  if (
    hostname.length === 0 ||
    hostname.length > 254 ||
    !/^[A-Za-z0-9_-]{1,63}(?:\.[A-Za-z0-9_-]{1,63})*\.?$/u.test(hostname)
  )
    throw new Error("TCP readiness requires a hostname or IP address");
}

function validateCommandReadiness(
  ready: Extract<WorkflowReady, { kind: "command" }>,
): void {
  const spec = ready.spec;
  if (
    spec.pty ||
    spec.terminalSize !== undefined ||
    spec.ready !== undefined ||
    spec.persist
  )
    throw new Error(
      "Readiness commands must be non-PTY, non-persistent commands without native readiness",
    );
  for (const value of [spec.application, spec.cwd, ...spec.args]) {
    if (value.includes("\0"))
      throw new Error(
        "Readiness command application, cwd and args must not contain NUL",
      );
  }
  validateProbeEnvironment(spec.env);
}

function validateProbeEnvironment(env: Record<string, string>): void {
  for (const [key, value] of Object.entries(env)) {
    if (key === "" || key.includes("=") || key.includes("\0") || value.includes("\0"))
      throw new Error("Invalid readiness command environment entry");
  }
}

// Log patterns use JavaScript RegExp syntax without flags, including lookaround
// and backreferences; runtime matching is isolated in a terminable worker
export function validateReadiness(requested: WorkflowReady): WorkflowReady {
  const ready = v.parse(workflowReadySchema, requested);
  Match.value(ready).pipe(
    Match.withReturnType<void>(),
    Match.discriminatorsExhaustive("kind")({
      log: (request) => {
        new RegExp(request.pattern);
      },
      http: validateHttpReadiness,
      tcp: (request) => {
        if (isIP(request.host) === 0) validateTcpReadiness(request);
      },
      command: validateCommandReadiness,
      file: () => {},
    }),
  );
  return ready;
}
