import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Queue } from "@ai/runtime/effect/queue/queue";
import type { SkyClient } from "@oai/sky";
import type {
  SkyServiceConfiguration,
  SkyServiceRequest,
  WireMedia,
} from "@oai/sky/service";
import {
  type DesktopFrame,
  desktopActionSchema,
} from "farstep/protocol/desktop/desktop";
import {
  connectNodeHelper,
  type NodeHelperConnection,
} from "farstep/transport/connection/node";
import { createDesktopClient } from "farstep/transport/desktop/desktop";
import * as v from "valibot";
import {
  DESKTOP_METHODS,
  INPUT_METHODS,
  screenshotOptionsSchema,
  textResultSchema,
} from "./protocol";

type LinuxSky = Extract<SkyClient, { target: "linux" }>;

type InputMethod = (typeof INPUT_METHODS)[number];
type SchemaInput<Input> = {
  [Key in keyof Input]: Record<never, never> extends Pick<Input, Key>
    ? Input[Key] | undefined
    : Input[Key];
};
type NativeAction = {
  [Method in InputMethod]: {
    method: Method;
    input: SchemaInput<Parameters<LinuxSky[Method]>[0]>;
  };
}[InputMethod];
type DragRequest = Extract<
  SkyServiceRequest,
  { type: "drag_start" | "drag_move" | "drag_end" }
>;
type NativeDragAction = {
  [Request in DragRequest as Request["type"]]: {
    method: Request["type"];
    input: Omit<Request, "type">;
  };
}[DragRequest["type"]];

const config = v.parse(
  v.object({
    FARSTEP_SKY_HELPER_PATH: v.pipe(v.string(), v.minLength(1)),
    FARSTEP_SKY_SESSION_DIR: v.pipe(v.string(), v.minLength(1)),
  }),
  process.env,
);
const point = v.strictObject({
  x: v.pipe(v.number(), v.finite()),
  y: v.pipe(v.number(), v.finite()),
});
const requestSchema = v.variant("type", [
  v.strictObject({ type: v.literal("setup") }),
  v.strictObject({ type: v.literal("release_input") }),
  v.strictObject({
    type: v.literal("execute"),
    method: v.picklist(["get_screenshot", ...INPUT_METHODS]),
    args: v.pipe(v.array(v.unknown()), v.maxLength(1)),
  }),
  ...(["drag_start", "drag_move"] as const).map((type) =>
    v.strictObject({
      type: v.literal(type),
      handle_id: v.pipe(v.string(), v.minLength(1)),
      point,
    }),
  ),
  v.strictObject({
    type: v.literal("drag_end"),
    handle_id: v.pipe(v.string(), v.minLength(1)),
  }),
]);
let connection: Promise<NodeHelperConnection> | undefined;
let sessionId: string | undefined;
let outputName: string | undefined;
let frame: DesktopFrame | undefined;
const serial = new Queue();

async function close() {
  const pending = connection;
  connection = undefined;
  sessionId = undefined;
  outputName = undefined;
  frame = undefined;
  const client = await pending?.catch(() => undefined);
  if (!client) return;
  try {
    await createDesktopClient(client).request("desktop.release", {});
  } finally {
    await client.close();
  }
}

type DesktopClient = ReturnType<typeof createDesktopClient>;
type Request = v.InferOutput<typeof requestSchema>;

async function screenshot(
  client: DesktopClient,
  args: unknown[],
): Promise<WireMedia[]> {
  const options = v.parse(screenshotOptionsSchema, args[0] ?? {});
  if (
    sessionId &&
    options.outputName !== undefined &&
    options.outputName !== outputName
  ) {
    throw new Error(
      "mapping-unavailable: reset Skylight before selecting a different outputName",
    );
  }
  if (!sessionId) {
    // Only exec-approved screenshot calls may request a combined control session
    const authorization = await client.request("desktop.authorize", {
      source: "monitor",
      ...options,
    });
    if (authorization.status === "error")
      throw new Error(`${authorization.code}: ${authorization.message}`);
    sessionId = authorization.sessionId;
    outputName = options.outputName;
  }
  const capture = await client.capture({ sessionId });
  if (capture.metadata.status === "error" || !capture.image) {
    const error = capture.metadata;
    throw new Error(
      error.status === "error"
        ? `${error.code}: ${error.message}`
        : "Desktop omitted image",
    );
  }
  frame = capture.metadata.frame;
  const filepath = join(config.FARSTEP_SKY_SESSION_DIR, `${randomUUID()}.png`);
  await writeFile(filepath, Buffer.from(capture.image.data, "base64"), {
    mode: 0o600,
    flag: "wx",
  });
  return [
    {
      filepath,
      data_url: `data:image/png;base64,${capture.image.data}`,
    } satisfies WireMedia,
  ];
}

async function inputAction(
  client: DesktopClient,
  request: Exclude<Request, { type: "setup" | "release_input" }>,
): Promise<unknown> {
  if (!sessionId)
    throw new Error("authorization-required: capture and authorize before input");
  const action = v.parse(
    desktopActionSchema,
    request.type === "execute"
      ? { method: request.method, input: request.args[0] }
      : {
          method: request.type,
          input: {
            handle_id: request.handle_id,
            ...("point" in request ? { point: request.point } : {}),
          },
        },
  ) satisfies NativeAction | NativeDragAction;
  const result = await client.request("desktop.input", {
    sessionId,
    ...(frame ? { frame: { streamId: frame.streamId, frameId: frame.frameId } } : {}),
    action,
  });
  if (action.method === "type_text" && result.receipt) {
    return v.parse(textResultSchema, {
      ...result.receipt,
      status: result.status,
      ...(result.status === "error"
        ? { code: result.code, message: result.message }
        : {}),
    });
  }
  if (result.status === "error") throw new Error(`${result.code}: ${result.message}`);
  if (action.method === "type_text")
    throw new Error("Desktop omitted the text input receipt");
  return result;
}

async function dispatch(input: unknown): Promise<unknown> {
  const request = v.parse(requestSchema, input) satisfies
    | SkyServiceRequest
    | { type: "release_input" };
  if (request.type === "release_input") return close();
  connection ??= connectNodeHelper(config.FARSTEP_SKY_HELPER_PATH);
  try {
    const client = createDesktopClient(await connection);
    switch (request.type) {
      case "setup": {
        const inspection = await client.request("desktop.inspect", {});
        return {
          target: "linux",
          methods: DESKTOP_METHODS,
          inspection,
        } satisfies SkyServiceConfiguration & { inspection: typeof inspection };
      }
      case "execute":
        if (request.method === "get_screenshot")
          return await screenshot(client, request.args);
        break;
    }
    return await inputAction(client, request);
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}

export function handleRpc(input: unknown): Promise<unknown> {
  return serial.run(() => dispatch(input));
}
