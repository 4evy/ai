import type { LocalTarget } from "farstep/client/execution/local";

export type { LocalTarget } from "farstep/client/execution/local";

import type {
  SSHConnectionTarget,
  SSHHostInfo,
} from "@oh-my-pi/pi-coding-agent/ssh/connection-manager";
import type { remoteDefinitions } from "farstep/remote/remote";
import type * as v from "valibot";
import type { HelperStatus } from "../helper/helper";

export interface Connection {
  backend?: "ssh" | undefined;
  id: string;
  target: SSHConnectionTarget;
  info: SSHHostInfo;
  home: string;
  cwd: string;
  bash: string;
  zsh?: string | undefined;
  timeout?: string | undefined;
  arch: string;
  // Empty when native ssh:// cannot represent these connection settings
  fileRoot: string;
  helper?: HelperStatus | undefined;
}

export type ExecutionTarget = Connection | LocalTarget;

export type ConnectInput = v.InferOutput<typeof remoteDefinitions.connect.parameters>;

export interface ConnectionState {
  controlPath?: string | undefined;
  active: boolean;
  masterPid?: number | undefined;
}
