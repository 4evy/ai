import * as v from "valibot";
import {
  desktopInputCheck,
  desktopInputSchema,
} from "#farstep/protocol/desktop/desktop";

export function createDesktopParameters() {
  const desktopFields = {
    connection: v.pipe(v.string(), v.minLength(1)),
    timeout: v.optional(v.pipe(v.number(), v.minValue(1), v.maxValue(120))),
  };
  const desktopParameters = v.object({
    ...desktopFields,
    action: v.picklist([
      "inspect",
      "open",
      "authorize",
      "release",
      "release-workspace",
    ]),
    uri: v.optional(v.string()),
    source: v.optional(v.picklist(["monitor", "window"])),
    outputName: v.optional(v.pipe(v.string(), v.minLength(1))),
    sessionId: v.optional(v.pipe(v.string(), v.minLength(1))),
    workspaceId: v.optional(v.pipe(v.string(), v.minLength(1))),
  });
  const screenshotParameters = v.strictObject({
    ...desktopFields,
    target: v.optional(v.picklist(["screen", "window"])),
    sessionId: v.optional(v.pipe(v.string(), v.minLength(1))),
  });
  const inputParameters = v.pipe(
    v.strictObject({
      ...desktopInputSchema.entries,
      connection: v.pipe(v.string(), v.minLength(1)),
    }),
    v.check((input) => desktopInputCheck.requirement(input), desktopInputCheck.message),
  );
  return { desktopParameters, screenshotParameters, inputParameters };
}
