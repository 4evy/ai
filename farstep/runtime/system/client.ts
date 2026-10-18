import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@ai/core/error/error";
import {
  parseSystemReply,
  type SystemExec,
  systemExecResultSchema,
  systemExecSchema,
  systemStatusSchema,
} from "farstep/protocol/system";
import * as v from "valibot";
import { systemLocations } from "./locations";
import { run } from "./process";
import { systemRequest } from "./transport/transport";

// One bounded request per connection; closing the socket cancels the service's
// command tree, including on client abort or response timeout
async function request(operation: object, timeout: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const { endpoint, owner } = await systemLocations();
  if (process.platform === "win32") {
    const packagePath = process.env.FARSTEP_PACKAGE_PATH;
    if (!packagePath) throw new Error("Invoke the installed package's bin/farstep");
    const budget = AbortSignal.timeout(timeout);
    const result = await run(
      [join(packagePath, "bin/farstep-service.exe"), "request", owner],
      `${JSON.stringify(operation)}\n`,
      signal ? AbortSignal.any([signal, budget]) : budget,
      4 * 1024 * 1024,
    );
    if (result.exitCode !== 0)
      throw new Error(result.stderr || "System service request failed");
    return parseSystemReply(result.stdout);
  }
  return systemRequest(endpoint, operation, timeout, signal);
}

export async function systemStatus() {
  const p = await systemLocations();
  try {
    const status = v.parse(
      systemStatusSchema,
      await request({ operation: "status" }, 5000),
    );
    if (
      status.uid !== p.uid ||
      status.platform !== process.platform ||
      (process.platform === "win32"
        ? status.executable.toLowerCase() !== p.executable.toLowerCase()
        : status.executable !== (await realpath(p.executable))) ||
      !status.root
    )
      throw new Error("System service identity mismatch");
    return status;
  } catch (error) {
    return v.parse(systemStatusSchema, {
      platform: process.platform,
      uid: p.uid,
      enabled: false,
      root: false,
      executable: p.executable,
      reason: `Run farstep system enable to install or repair the system service: ${errorMessage(error)}`,
    });
  }
}

export async function systemExec(input: SystemExec, signal?: AbortSignal) {
  const parsed = v.parse(systemExecSchema, input);
  return v.parse(
    systemExecResultSchema,
    await request(
      { operation: "exec", ...parsed },
      (parsed.timeout + 15) * 1000,
      signal,
    ),
  );
}
