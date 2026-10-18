import { runBroker } from "../shared/broker";
import { WorkspaceLeases } from "./leases";

await runBroker((manager) => new WorkspaceLeases(manager), "org.kde.KWin");
