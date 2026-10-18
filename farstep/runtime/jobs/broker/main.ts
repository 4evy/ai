import { isAbsolute } from "node:path";
import { runJobBroker } from "./broker";

const [project, directory, grace] = process.argv.slice(2);
const idleGraceMs = Number(grace);
if (
  !project ||
  !directory ||
  !isAbsolute(project) ||
  !isAbsolute(directory) ||
  !Number.isSafeInteger(idleGraceMs) ||
  idleGraceMs < 0 ||
  idleGraceMs > 60000
)
  throw new Error("Invalid Farstep job broker invocation");
await runJobBroker(project, directory, idleGraceMs);
