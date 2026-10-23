import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { getRotatingFileSink } from "@logtape/file";
import { jsonLinesFormatter, type Sink } from "@logtape/logtape";
import { redactByField } from "@logtape/redaction";
import * as Otel from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import {
  Array as Arr,
  Cause,
  Context,
  Effect,
  Exit,
  Inspectable,
  Layer,
  Logger,
  LogLevel,
  Option,
  Record as Rec,
  References,
  Tracer,
  Version,
} from "effect";
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
    const sink = yield* Effect.acquireDisposable(
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

const spanKinds = {
  internal: Otel.SpanKind.INTERNAL,
  client: Otel.SpanKind.CLIENT,
  server: Otel.SpanKind.SERVER,
  producer: Otel.SpanKind.PRODUCER,
  consumer: Otel.SpanKind.CONSUMER,
} satisfies Record<Tracer.SpanKind, Otel.SpanKind>;

const spanContext = (span: Tracer.AnySpan): Otel.SpanContext => ({
  traceId: span.traceId,
  spanId: span.spanId,
  traceFlags: span.sampled ? Otel.TraceFlags.SAMPLED : Otel.TraceFlags.NONE,
  isRemote: span._tag === "ExternalSpan",
});

// Preserve Effect's attribute representation for values OTel cannot export
function attributeValue(value: unknown): Otel.AnyValue {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) {
    const type = typeof value[0];
    if (
      (value.length === 0 ||
        type === "string" ||
        type === "number" ||
        type === "boolean") &&
      value.every((item: unknown) => typeof item === type)
    ) {
      return value;
    }
  }
  return Inspectable.toStringUnknown(value);
}

function spanAttributes(values: Record<string, unknown>): Otel.Attributes {
  const attributes: Otel.Attributes = {};
  for (const [key, value] of Object.entries(values)) {
    Rec.assignProperty(attributes, key, attributeValue(value));
  }
  return attributes;
}

const spanTime = (nanos: bigint): Otel.HrTime => [
  Number(nanos / 1_000_000_000n),
  Number(nanos % 1_000_000_000n),
];

const effectSpanKey = Otel.createContextKey("ai/effect-span");

// Effect's public Tracer contract and OTel's public API avoid SDK-version peers
function makeTracer(tracer: Otel.Tracer): Tracer.Tracer {
  const contexts = new WeakMap<Tracer.AnySpan, Otel.SpanContext>();
  const spans = new WeakMap<Tracer.Span, Otel.Span>();
  const spanLink = (link: Tracer.SpanLink): Otel.Link => ({
    context: contexts.get(link.span) ?? spanContext(link.span),
    attributes: spanAttributes(link.attributes),
  });
  function activateSpan(span: Tracer.AnySpan, active: Otel.Context): Otel.Context {
    const underlying = span._tag === "Span" ? spans.get(span) : undefined;
    return underlying
      ? Otel.trace.setSpan(active, underlying)
      : Otel.trace.setSpanContext(active, contexts.get(span) ?? spanContext(span));
  }
  return Tracer.make({
    span(options) {
      const active = Otel.context.active();
      let parent = options.root ? Option.none() : options.parent;
      if (!options.root && Option.isNone(parent)) {
        const inherited = Otel.trace.getSpanContext(active);
        if (
          inherited &&
          Otel.isSpanContextValid(inherited) &&
          inherited !== active.getValue(effectSpanKey)
        ) {
          const external = Tracer.externalSpan({
            traceId: inherited.traceId,
            spanId: inherited.spanId,
            sampled: (inherited.traceFlags & Otel.TraceFlags.SAMPLED) !== 0,
          });
          contexts.set(external, inherited);
          parent = Option.some(external);
        }
      }
      const span = tracer.startSpan(
        options.name,
        {
          kind: spanKinds[options.kind],
          startTime: spanTime(options.startTime),
          links: options.links.map(spanLink),
        },
        Option.isSome(parent)
          ? activateSpan(parent.value, active)
          : Otel.trace.deleteSpan(active),
      );
      const context = span.spanContext();
      const attributes = new Map<string, unknown>();
      let status: Tracer.SpanStatus = {
        _tag: "Started",
        startTime: options.startTime,
      };
      const result: Tracer.Span = {
        _tag: "Span",
        name: options.name,
        spanId: context.spanId,
        traceId: context.traceId,
        parent,
        annotations: options.annotations,
        get status() {
          return status;
        },
        attributes,
        links: options.links,
        sampled: (context.traceFlags & Otel.TraceFlags.SAMPLED) !== 0,
        kind: options.kind,
        attribute(key, value) {
          attributes.set(key, value);
          span.setAttribute(key, attributeValue(value));
        },
        event(name, startTime, eventAttributes) {
          span.addEvent(
            name,
            eventAttributes ? spanAttributes(eventAttributes) : undefined,
            spanTime(startTime),
          );
        },
        addLinks(links) {
          options.links.push(...links);
          span.addLinks(links.map(spanLink));
        },
        end(endTime, exit) {
          if (status._tag === "Ended") return;
          status = {
            _tag: "Ended",
            startTime: options.startTime,
            endTime,
            exit,
          };
          const time = spanTime(endTime);
          if (Exit.isSuccess(exit)) {
            span.setStatus({ code: Otel.SpanStatusCode.OK });
          } else if (Cause.hasInterruptsOnly(exit.cause)) {
            span.setAttribute("effect.fiber.interrupted", true);
          } else {
            // Never serialize native causes, command output, credentials or stacks
            span.addEvent(
              "exception",
              {
                "exception.type": "Error",
                "exception.message": "Operation failed",
              },
              time,
            );
            span.setStatus({
              code: Otel.SpanStatusCode.ERROR,
              message: "Operation failed",
            });
          }
          span.end(time);
        },
      };
      contexts.set(result, context);
      spans.set(result, span);
      return result;
    },
    context(primitive, fiber) {
      let parent = Context.getOrUndefined(fiber.context, Tracer.ParentSpan);
      while (parent && Context.get(parent.annotations, Tracer.DisablePropagation)) {
        parent =
          parent._tag === "Span" ? Option.getOrUndefined(parent.parent) : undefined;
      }
      if (!parent) return primitive["~effect/Effect/evaluate"](fiber);
      const context = contexts.get(parent) ?? spanContext(parent);
      return Otel.context.with(
        activateSpan(parent, Otel.context.active()).setValue(effectSpanKey, context),
        () => primitive["~effect/Effect/evaluate"](fiber),
      );
    },
  });
}

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
    ? Layer.effect(
        Tracer.Tracer,
        Effect.acquireRelease(
          Effect.sync(
            () =>
              new TracerProvider({
                resource: resourceFromAttributes({
                  "service.name": process.env.OTEL_SERVICE_NAME ?? "ai-tools",
                }),
                spanProcessors: [
                  new BatchSpanProcessor({
                    exporter: new OTLPTraceExporter({ timeoutMillis: 1500 }),
                    exportTimeoutMillis: 1500,
                  }),
                ],
              }),
          ),
          // Reserve half the shutdown budget for cleanup even if flushing stalls
          (provider) =>
            Effect.tryPromise(() => provider.forceFlush({ timeoutMillis: 1500 })).pipe(
              Effect.ignore,
              Effect.interruptible,
              Effect.timeoutOption(1500),
              Effect.ensuring(
                Effect.tryPromise(() => provider.shutdown()).pipe(
                  Effect.ignore,
                  Effect.interruptible,
                  Effect.timeoutOption(1500),
                ),
              ),
            ),
        ).pipe(
          Effect.map((provider) =>
            makeTracer(provider.getTracer("effect", Version.getCurrentVersion())),
          ),
        ),
      )
    : Layer.empty,
);
