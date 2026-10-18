import type Meta from "gi://Meta";
import type { ProcessLease } from "../shared/types";

export interface Lease extends ProcessLease {
  workspace: Meta.Workspace;
  client: Meta.WaylandClient;
  windows: Set<Meta.Window>;
  signals: Map<Meta.Window, number[]>;
}
