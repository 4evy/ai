import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import * as OtelTracer from "@effect/opentelemetry/OtelTracer";
import { getRotatingFileSink } from "@logtape/file";
import { jsonLinesFormatter, type Sink } from "@logtape/logtape";
import { redactByField } from "@logtape/redaction";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Array as Arr, Effect, Layer, Logger, LogLevel, References } from "effect";
import * as v from "valibot";

const levels = {
  All: "trace",
  Trace: "trace",
  Debug: "debug",
  Info: "info",
  Warn: "warning",
  Error: "error",
  Fatal: "fatal",
  None: "fatal",
} as const;

const logger = Effect.gen(function* () {
  const sinks: Sink[] = [
    redactByField((record) => {
      process.stderr.write(jsonLinesFormatter(record));
    }),
  ];
  // Each process needs its own rotation target when a launcher shares this setting
  const file = process.env.AI_LOG_FILE?.replaceAll("{pid}", String(process.pid));
  if (file) {
    const sink = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          await mkdir(dirname(file), { recursive: true, mode: 0o700 });
          const handle = await open(file, "a", 0o600);
          await handle.close();
          return getRotatingFileSink(file, {
            maxSize: 5 * 1024 * 1024,
            maxFiles: 3,
            bufferSize: 0,
            formatter: jsonLinesFormatter,
          });
        },
        catch: (error) => error,
      }),
      (sink) => Effect.sync(() => sink[Symbol.dispose]()),
    ).pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          try {
            sinks[0]?.({
              category: ["ai"],
              level: "warning",
              timestamp: Date.now(),
              message: ["File logging unavailable; continuing on stderr"],
              rawMessage: "File logging unavailable; continuing on stderr",
              properties: {},
            });
          } catch {
            // An unavailable diagnostic sink cannot block the protocol
          }
          return undefined;
        }),
      ),
    );
    if (sink) sinks.push(redactByField(sink));
  }
  return Logger.make((options) => {
    const formatted = Logger.formatStructured.log(options);
    const message = Arr.ensure(options.message);
    const record = {
      category: ["ai"],
      level: levels[options.logLevel],
      message,
      rawMessage: message.filter((part) => typeof part === "string").join(" "),
      timestamp: options.date.getTime(),
      properties: { ...formatted.annotations, fiberId: formatted.fiberId },
    };
    // Diagnostics must never turn a successful protocol operation into a failure
    for (const sink of sinks) {
      try {
        sink(record);
      } catch {
        // A full or disconnected log destination cannot revoke a native lease
      }
    }
  });
});

export const observability = Layer.mergeAll(
  Logger.layer([logger]),
  Layer.succeed(
    References.MinimumLogLevel,
    v.parse(
      v.fallback(
        v.picklist(LogLevel.values.filter((level) => level !== "All")),
        "Info",
      ),
      process.env.AI_LOG_LEVEL,
    ),
  ),
  // Export only when explicitly configured; tracing never discovers a collector
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    ? OtelTracer.layer.pipe(
        Layer.provide(
          Layer.effect(
            OtelTracer.OtelTracerProvider,
            Effect.acquireRelease(
              Effect.sync(
                () =>
                  new BasicTracerProvider({
                    resource: resourceFromAttributes({
                      "service.name": process.env.OTEL_SERVICE_NAME ?? "ai-tools",
                    }),
                    spanProcessors: [
                      new BatchSpanProcessor(
                        new OTLPTraceExporter({ timeoutMillis: 3000 }),
                      ),
                    ],
                  }),
              ),
              (provider) =>
                Effect.tryPromise(() =>
                  provider.forceFlush().finally(() => provider.shutdown()),
                ).pipe(Effect.ignore, Effect.interruptible, Effect.timeoutOption(3000)),
            ),
          ),
        ),
      )
    : Layer.empty,
);
