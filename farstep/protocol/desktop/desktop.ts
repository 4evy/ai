import { objectSchema } from "@ai/core/schema/input";
import * as v from "valibot";
import { urlSchema } from "../identity";

export const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 46 * 1024 * 1024;

const id = v.pipe(v.string(), v.minLength(1), v.maxLength(1024));
const coordinate = v.pipe(v.number(), v.finite());
const point = v.strictObject({ x: coordinate, y: coordinate });
const key = v.pipe(v.string(), v.minLength(1), v.maxLength(1024));
const duration = v.pipe(v.number(), v.finite(), v.minValue(0));
const sourceSchema = v.picklist(["monitor", "window"]);
export const textReceiptSchema = v.strictObject({
  mechanism: v.picklist([
    "ei-text",
    "portal-clipboard",
    "data-control",
    "native-unicode",
    "none",
  ]),
  clipboardChanged: v.boolean(),
  submittedBytes: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  partial: v.boolean(),
});
export const desktopActionSchema = v.variant("method", [
  v.strictObject({
    method: v.literal("click"),
    input: v.strictObject({
      x: coordinate,
      y: coordinate,
      click_count: v.optional(v.pipe(v.number(), v.safeInteger(), v.gtValue(0))),
      duration: v.optional(duration),
      key: v.optional(key),
      mouse_button: v.optional(v.picklist(["l", "r", "m", "left", "right", "middle"])),
    }),
  }),
  v.strictObject({
    method: v.literal("move"),
    input: v.strictObject({ x: coordinate, y: coordinate, key: v.optional(key) }),
  }),
  v.strictObject({
    method: v.literal("press_key"),
    input: v.strictObject({ key, duration: v.optional(duration) }),
  }),
  v.strictObject({
    method: v.literal("type_text"),
    input: v.strictObject({
      text: v.pipe(v.string(), v.excludes("\0", "Text cannot contain NUL")),
      paste_key: v.optional(key),
    }),
  }),
  v.strictObject({
    method: v.literal("scroll"),
    input: v.pipe(
      v.strictObject({
        direction: v.picklist(["u", "d", "l", "r", "up", "down", "left", "right"]),
        pixels: v.optional(v.pipe(v.number(), v.finite(), v.minValue(0))),
        x: v.optional(coordinate),
        y: v.optional(coordinate),
        key: v.optional(key),
      }),
      v.check(
        (input) => (input.x === undefined) === (input.y === undefined),
        "Scroll origin requires both x and y",
      ),
    ),
  }),
  v.strictObject({
    method: v.literal("drag"),
    input: v.strictObject({
      path: v.pipe(v.array(point), v.minLength(2)),
      key: v.optional(key),
    }),
  }),
  v.strictObject({
    method: v.literal("drag_start"),
    input: v.strictObject({ handle_id: id, point }),
  }),
  v.strictObject({
    method: v.literal("drag_move"),
    input: v.strictObject({ handle_id: id, point }),
  }),
  v.strictObject({
    method: v.literal("drag_end"),
    input: v.strictObject({ handle_id: id }),
  }),
]);
const frameReferenceSchema = v.strictObject({ streamId: id, frameId: id });
const desktopInputObjectSchema = v.strictObject({
  sessionId: id,
  frame: v.optional(frameReferenceSchema),
  action: desktopActionSchema,
});
export const desktopInputCheck = v.check(
  (input: v.InferOutput<typeof desktopInputObjectSchema>) =>
    ["press_key", "type_text"].includes(input.action.method) ||
    input.frame !== undefined,
  "Pointer input requires the latest frame identifiers",
);
export const desktopInputSchema = v.pipe(desktopInputObjectSchema, desktopInputCheck);
const inspectRequestObjectSchema = v.strictObject({});
export const inspectRequestSchema = objectSchema(inspectRequestObjectSchema);
export const openRequestSchema = v.strictObject({
  uri: v.pipe(urlSchema, v.maxLength(65536)),
});
export const authorizeRequestSchema = v.strictObject({
  source: sourceSchema,
  outputName: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(1024))),
});
const captureRequestObjectSchema = v.strictObject({
  sessionId: v.optional(id),
  source: v.optional(sourceSchema),
});
export const captureRequestSchema = objectSchema(captureRequestObjectSchema);
const releaseRequestObjectSchema = v.strictObject({ sessionId: v.optional(id) });
export const releaseRequestSchema = objectSchema(releaseRequestObjectSchema);
export const workspaceReleaseRequestSchema = v.strictObject({ workspaceId: id });
const frameSchema = v.pipe(
  v.strictObject({
    sessionId: id,
    streamId: id,
    frameId: id,
    source: sourceSchema,
    width: v.pipe(v.number(), v.safeInteger(), v.gtValue(0)),
    height: v.pipe(v.number(), v.safeInteger(), v.gtValue(0)),
    bytes: v.pipe(
      v.number(),
      v.safeInteger(),
      v.gtValue(0),
      v.maxValue(MAX_IMAGE_BYTES),
    ),
    logicalGeometry: v.nullable(
      v.strictObject({
        x: coordinate,
        y: coordinate,
        width: v.pipe(v.number(), v.finite(), v.gtValue(0)),
        height: v.pipe(v.number(), v.finite(), v.gtValue(0)),
      }),
    ),
    transform: v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(7)),
    mappingId: v.nullable(id),
  }),
  v.check(
    (frame) => frame.width * frame.height <= 100_000_000,
    "Capture exceeds pixel limit",
  ),
);
export const desktopErrorSchema = v.strictObject({
  status: v.literal("error"),
  code: v.picklist([
    "cancelled",
    "denied",
    "missing-protocol",
    "closed-session",
    "paused-device",
    "disconnected",
    "mapping-unavailable",
    "stale-frame",
    "partial-input",
    "authorization-required",
    "unsupported-text",
    "busy",
    "unsupported-platform",
    "invalid-request",
    "backend-error",
    "prerequisite",
  ]),
  message: v.string(),
  receipt: v.optional(textReceiptSchema),
});
const ok = v.strictObject({ status: v.literal("ok") });
export const inspectResponseSchema = v.union([
  v.strictObject({
    status: v.literal("ok"),
    operations: v.array(
      v.strictObject({
        operation: v.picklist(["capture", "keyboard", "pointer", "clipboard", "open"]),
        available: v.boolean(),
        requestable: v.boolean(),
        granted: v.boolean(),
        backend: v.nullable(v.string()),
        reason: v.nullable(v.string()),
      }),
    ),
    sources: v.array(sourceSchema),
    sessionId: v.nullable(id),
  }),
  desktopErrorSchema,
]);
export const authorizeResponseSchema = v.union([
  v.strictObject({
    status: v.literal("ok"),
    sessionId: id,
    source: sourceSchema,
    backend: v.string(),
  }),
  desktopErrorSchema,
]);
export const captureResponseSchema = v.union([
  v.strictObject({ status: v.literal("ok"), frame: frameSchema }),
  desktopErrorSchema,
]);
export const inputResponseSchema = v.union([
  v.strictObject({ status: v.literal("ok"), receipt: v.optional(textReceiptSchema) }),
  desktopErrorSchema,
]);
export const simpleResponseSchema = v.union([ok, desktopErrorSchema]);
export const openResponseSchema = v.union([
  v.strictObject({ status: v.literal("ok"), workspaceId: id }),
  desktopErrorSchema,
]);
export type DesktopAction = v.InferOutput<typeof desktopActionSchema>;
export type DesktopInputRequest = v.InferOutput<typeof desktopInputSchema>;
export type DesktopFrame = v.InferOutput<typeof frameSchema>;

export function validatePng(data: string, frame: DesktopFrame): void {
  const padding = pngPadding(data);
  const header = Buffer.from(data.slice(0, 44), "base64");
  if (
    (data.length / 4) * 3 - padding !== frame.bytes ||
    header.length < 33 ||
    !header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    header.readUInt32BE(8) !== 13 ||
    header.toString("ascii", 12, 16) !== "IHDR" ||
    header.readUInt32BE(16) !== frame.width ||
    header.readUInt32BE(20) !== frame.height
  ) {
    throw new Error("Desktop returned mismatched PNG metadata");
  }
}

function pngPadding(data: string): number {
  if (
    data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
    data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(data)
  ) {
    throw new Error("Desktop returned invalid PNG encoding");
  }
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return padding;
}
