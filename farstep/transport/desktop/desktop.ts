import * as v from "valibot";
import {
  authorizeRequestSchema,
  authorizeResponseSchema,
  captureRequestSchema,
  captureResponseSchema,
  desktopInputSchema,
  inputResponseSchema,
  inspectRequestSchema,
  inspectResponseSchema,
  openRequestSchema,
  openResponseSchema,
  releaseRequestSchema,
  simpleResponseSchema,
  validatePng,
  workspaceReleaseRequestSchema,
} from "../../protocol/desktop/desktop";
import type { HelperIdentity } from "../../protocol/identity";
import { structuredResult } from "../../protocol/identity";

const DESKTOP_CAPABILITIES = [
  "desktop",
  "bounded-png",
  "frame-bound-input",
  "text-receipts",
];

type ToolResult = {
  structuredContent?: unknown;
  isError?: boolean | undefined;
  content: Array<{ type: string; data?: unknown; mimeType?: unknown }>;
};

const METHODS = {
  "desktop.inspect": [inspectRequestSchema, inspectResponseSchema],
  "desktop.open": [openRequestSchema, openResponseSchema],
  "desktop.authorize": [authorizeRequestSchema, authorizeResponseSchema],
  "desktop.release": [releaseRequestSchema, simpleResponseSchema],
  "desktop.workspace.release": [workspaceReleaseRequestSchema, simpleResponseSchema],
  "desktop.input": [desktopInputSchema, inputResponseSchema],
} as const;

export function createDesktopClient(client: {
  identity: HelperIdentity;
  call(
    method: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<ToolResult>;
}) {
  assertDesktopHelper(client.identity);
  return {
    async request<Method extends keyof typeof METHODS>(
      method: Method,
      input: v.InferInput<(typeof METHODS)[Method][0]>,
      signal?: AbortSignal,
      timeoutMs?: number,
    ): Promise<v.InferOutput<(typeof METHODS)[Method][1]>> {
      const [request, response] = METHODS[method];
      const result = await client.call(
        method,
        v.parse(request, input),
        signal,
        timeoutMs,
      );
      return v.parse(response, structuredResult(result));
    },
    async capture(
      input: v.InferInput<typeof captureRequestSchema>,
      signal?: AbortSignal,
      timeoutMs?: number,
    ) {
      return parseCapture(
        await client.call(
          "desktop.capture",
          v.parse(captureRequestSchema, input),
          signal,
          timeoutMs,
        ),
      );
    },
  };
}
export type DesktopClient = ReturnType<typeof createDesktopClient>;

export function assertDesktopHelper(identity: HelperIdentity): void {
  const missing = DESKTOP_CAPABILITIES.filter(
    (capability) => !identity.capabilities.includes(capability),
  );
  if (missing.length)
    throw new Error(
      `Desktop helper lacks required protocol capabilities: ${missing.join(", ")}`,
    );
}

function parseCapture(result: ToolResult) {
  const metadata = v.parse(captureResponseSchema, structuredResult(result));
  const images = result.content.filter((item) => item.type === "image");
  if (metadata.status === "error") {
    if (images.length !== 0)
      throw new Error("Failed capture unexpectedly contained image data");
    return { metadata };
  }
  const image = images[0];
  if (
    result.isError ||
    images.length !== 1 ||
    image?.mimeType !== "image/png" ||
    typeof image.data !== "string"
  ) {
    throw new Error("Desktop capture must return exactly one PNG image block");
  }
  validatePng(image.data, metadata.frame);
  return {
    metadata,
    image: { type: "image" as const, data: image.data, mimeType: "image/png" },
  };
}
