import {
  type HelperInput,
  manageHelper as manage,
} from "farstep/remote/helper/manage/manage";
import { scriptTransport } from "../connections/execution";
import type { Connections } from "../connections/state";
import type { RemoteJobs } from "../jobs/jobs";

export type { HelperInput } from "farstep/remote/helper/manage/manage";

export function manageHelper(
  args: HelperInput,
  { selected, save }: Connections,
  jobs: RemoteJobs,
  signal?: AbortSignal,
) {
  const connection = selected(args.connection);
  return manage(
    connection,
    args,
    {
      transport: scriptTransport(connection),
      saveStatus(status) {
        connection.helper = status;
        save(connection);
      },
      disconnect: () => jobs.disconnect(connection),
    },
    signal,
  );
}
