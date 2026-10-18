import * as v from "valibot";

export function createConnectionParameters() {
  const connectParameters = v.object({
    target: v.pipe(
      v.string(),
      v.minLength(1),
      v.description("Configured host name, OpenSSH alias, or user@host"),
    ),
    id: v.pipe(
      v.optional(v.pipe(v.string(), v.minLength(1))),
      v.description("Readable connection id"),
    ),
    username: v.optional(v.string()),
    port: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535))),
    keyPath: v.pipe(
      v.optional(v.string()),
      v.description("Local SSH identity file override"),
    ),
    cwd: v.pipe(
      v.optional(v.string()),
      v.description("Remote cwd; defaults to remote home"),
    ),
  });
  return { connectParameters };
}
