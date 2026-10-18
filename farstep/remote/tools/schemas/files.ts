import * as v from "valibot";
import { MAX_FILE_BYTES } from "#farstep/protocol/files/files";
import { REMOTE_TOOLS } from "../names";

export { MAX_FILE_BYTES };

export function createFileParameters() {
  const target = {
    connection: v.pipe(v.string(), v.minLength(1)),
    path: v.pipe(
      v.string(),
      v.minLength(1),
      v.description("Remote absolute, ~/ or connection-relative literal path"),
    ),
  };
  const expectedHash = v.pipe(
    v.optional(v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u))),
    v.description(`SHA-256 from ${REMOTE_TOOLS.read}; reject stale content`),
  );
  const readParameters = v.object({
    ...target,
    selector: v.pipe(
      v.optional(v.pipe(v.string(), v.minLength(1))),
      v.description(
        "Native read selector, e.g. 1-100 or raw; separate from the literal path",
      ),
    ),
    offset: v.pipe(
      v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
      v.description("Directory entry offset; default 0"),
    ),
    limit: v.pipe(
      v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1000))),
      v.description("Directory entry limit; default 200"),
    ),
  });
  const writeParameters = v.object({
    ...target,
    content: v.pipe(v.string(), v.maxLength(MAX_FILE_BYTES)),
  });
  const editParameters = v.object({
    ...target,
    old_string: v.pipe(v.string(), v.minLength(1)),
    new_string: v.string(),
    replace_all: v.optional(v.boolean()),
    expectedHash,
  });
  const deleteParameters = v.object(target);
  return { readParameters, writeParameters, editParameters, deleteParameters };
}
