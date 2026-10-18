import { constants } from "node:os";
import type { JobRpcResult } from "farstep/protocol/jobs/protocol";
import { styledScreen } from "../terminal/terminal";

import { ended, type ManagedJob, type Operation } from "./model";
import { until } from "./wait";

export async function send(
  job: ManagedJob,
  operation: Operation<"send">,
  persist: (job: ManagedJob) => Promise<void>,
): Promise<JobRpcResult<"send">> {
  if (ended(job) || !job.process)
    throw new Error("Job process is no longer supervised");
  if (operation.resize) {
    if (!job.terminal) throw new Error("Only PTY jobs can resize");
    job.terminal.resize(operation.resize.columns, operation.resize.rows);
    job.snapshot.terminalSize = operation.resize;
    job.events.push({ offset: job.log.end, terminalSize: operation.resize });
    await persist(job);
  }
  if (operation.data) {
    if (job.terminal) job.terminal.write(operation.data);
    else if (job.input) {
      job.input.write(operation.data);
      await job.input.flush();
    } else throw new Error("Job input is unavailable");
  }
  if (operation.signal) job.process.killTree(constants.signals[operation.signal]);
  return { op: "send", snapshot: { ...job.snapshot } };
}

export async function readOutput(
  job: ManagedJob,
  operation: Operation<"output">,
): Promise<JobRpcResult<"output">> {
  if (operation.cursor > job.log.end)
    throw new Error("Output cursor is ahead of this job");
  const timedOut =
    operation.follow && operation.cursor === job.log.end && !ended(job)
      ? !(await until(
          () => job.log.end > operation.cursor || ended(job),
          operation.timeoutMs,
        ))
      : false;
  return {
    op: "output",
    name: operation.name,
    ...(await job.log.output(operation.cursor)),
    timedOut,
    state: job.snapshot.state,
  };
}

export async function logs(
  job: ManagedJob,
  operation: Operation<"logs">,
): Promise<JobRpcResult<"logs">> {
  const timedOut =
    operation.follow &&
    job.snapshot.outputBytes <= (operation.cursor ?? 0) &&
    !ended(job)
      ? !(await until(
          () => job.snapshot.outputBytes > (operation.cursor ?? 0) || ended(job),
          operation.timeoutMs,
        ))
      : false;
  const logs: JobRpcResult<"logs"> = {
    op: "logs",
    name: operation.name,
    ...(await job.log.logs(
      operation.head,
      Math.max(1, operation.lines),
      operation.grep,
      job.spec.pty ? job.events : undefined,
    )),
    terminalSize: job.snapshot.terminalSize,
    timedOut,
    state: job.snapshot.state,
  };
  if (operation.renderTerminalRows) await styledScreen(logs);
  return logs;
}

export async function wait(
  job: ManagedJob,
  operation: Operation<"wait">,
): Promise<JobRpcResult<"wait">> {
  const pattern = operation.pattern ? new RegExp(operation.pattern, "u") : undefined;
  let matched: string | undefined;
  const success = () => {
    if (pattern) {
      matched = pattern.exec(job.buffer)?.[0]?.slice(0, 500);
      return matched !== undefined;
    }
    return operation.for === "exit" ? ended(job) : job.snapshot.readyAt !== undefined;
  };
  await until(() => success() || ended(job), operation.timeoutMs);
  return { op: "wait", snapshot: { ...job.snapshot }, matched, timedOut: !success() };
}
