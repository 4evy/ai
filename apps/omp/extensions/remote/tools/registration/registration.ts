import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Connection } from "../../connections/types";
import type { RemoteJobs } from "../../jobs/jobs";
import { noticeError, sendJobNotice } from "../../jobs/notices/notices";

export async function touchCoordination(
  api: ExtensionAPI,
  connection: Connection,
  jobs: RemoteJobs,
  ctx: ExtensionContext,
  notice: (reason: string) => string,
): Promise<void> {
  if (connection.helper?.jobsReady !== true) return;
  try {
    await jobs.touch(connection, ctx);
  } catch (error) {
    sendJobNotice(api, notice(noticeError(error)));
  }
}
