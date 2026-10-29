import { isAbsolute } from "node:path";
import { object } from "@optique/core/constructs";
import { formatMessage } from "@optique/core/message";
import { parseSync } from "@optique/core/parser";
import { argument } from "@optique/core/primitives";
import { valibot } from "@optique/valibot";
import * as v from "valibot";
import { runJobBroker } from "./broker";

const absolutePath = valibot(v.pipe(v.string(), v.nonEmpty(), v.check(isAbsolute)), {
  placeholder: "/",
});
const parsed = parseSync(
  object({
    project: argument(absolutePath),
    directory: argument(absolutePath),
    idleGraceMs: argument(
      valibot(
        v.pipe(
          v.string(),
          v.toNumber(),
          v.safeInteger(),
          v.minValue(0),
          v.maxValue(60000),
        ),
        { placeholder: 0 },
      ),
    ),
  }),
  process.argv.slice(2),
);
if (!parsed.success) throw new Error(formatMessage(parsed.error));
const { project, directory, idleGraceMs } = parsed.value;
await runJobBroker(project, directory, idleGraceMs);
