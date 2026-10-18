import * as v from "valibot";
import { commandFields } from "../shell";

export function createSudoParameters() {
  const sudoParameters = v.object({
    ...commandFields(),
    timeout: v.pipe(
      v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(3600))),
      v.description("Positive privileged-command budget in seconds; default 60"),
    ),
    password: v.pipe(
      v.optional(v.string()),
      v.description(
        "Plaintext password; omitted uses cached sudo or a normal text prompt",
      ),
    ),
  });
  return { sudoParameters };
}
