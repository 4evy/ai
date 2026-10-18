import type Gio from "gi://Gio";

export interface ProcessLease {
  id: string;
  owner: string | null;
  process: Gio.Subprocess;
  pid: number;
  unit: string;
  ready: boolean;
  exited: boolean;
  status: number;
  released: boolean;
  cgroup: string | null;
}

export interface WorkspaceLeases {
  leases: Map<string, ProcessLease>;
  ready(lease: ProcessLease): void;
  inspect(): string;
  busy(): number;
  launch(
    id: string,
    argv: string[],
    environment: Record<string, string>,
    cwd: string,
    invocation: Gio.DBusMethodInvocation,
    fds?: number[],
  ): void;
  owned(id: string, invocation: Gio.DBusMethodInvocation): ProcessLease;
  remove(id: string, lease: ProcessLease): boolean;
  stop(lease: ProcessLease): void;
}
