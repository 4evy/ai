import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { attempt, run } from "@ai/runtime/effect/effect";
import { object } from "@optique/core/constructs";
import { formatMessage } from "@optique/core/message";
import { withDefault } from "@optique/core/modifiers";
import { parseSync } from "@optique/core/parser";
import { option } from "@optique/core/primitives";
import { choice, string } from "@optique/core/valueparser";
import { DepGraph } from "dependency-graph";
import { Effect } from "effect";
import { type Bundle, bundles, desktops, resources } from "./bundles";
import { filename, rules } from "./native/rules";

const source = dirname(fileURLToPath(import.meta.url));
const parsed = parseSync(
  object({
    out: withDefault(option("--out", string()), "dist/extensions"),
    bundler: withDefault(option("--bundler", choice(["bun", "vite"] as const)), "bun"),
    desktop: withDefault(
      option("--desktop", choice(["both", ...desktops] as const)),
      "both",
    ),
  }),
  process.argv.slice(2),
);
if (!parsed.success) throw new Error(formatMessage(parsed.error));
const destination = resolve(parsed.value.out);
const desktop = parsed.value.desktop;
const bundler = parsed.value.bundler;
const bundle = Effect.fnUntraced(function* (
  spec: Bundle,
  target: string,
  extraHash = "",
) {
  let code =
    bundler === "bun"
      ? yield* bunBundle(spec.entry, spec.qml ?? false)
      : yield* viteBundle(spec);
  if (spec.qml) {
    // Qt's QML engine rejects class fields in otherwise valid modern JavaScript
    const { transformWithOxc } = yield* attempt(() => import("vite"));
    const compatible = yield* attempt(() =>
      transformWithOxc(code, spec.entry, {
        target: "es2017",
        assumptions: { setPublicClassFields: true },
      }),
    );
    code = compatible.code;
  }
  yield* attempt(() => mkdir(dirname(target), { recursive: true }), {
    awaitOnInterrupt: true,
  });
  let hash = "";
  if (spec.hash) {
    if (!code.includes("@SOURCE_HASH@"))
      return yield* Effect.fail(
        new Error(`Missing source hash placeholder in ${spec.entry}`),
      );
    hash = createHash("sha256").update(code).update(extraHash).digest("hex");
    code = code.replaceAll("@SOURCE_HASH@", hash);
  }
  yield* attempt(() => Bun.write(target, code), { awaitOnInterrupt: true });
  return hash;
});
const bunBundle = Effect.fnUntraced(function* (entry: string, qml: boolean) {
  let code: string;
  const result = yield* attempt(
    () =>
      Bun.build({
        entrypoints: [join(source, entry)],
        target: "browser",
        format: "esm",
        minify: true,
        external: ["gi://*", "resource:///*"],
      }),
    { awaitOnInterrupt: true },
  );
  const output = result.outputs[0];
  if (!result.success || !output)
    return yield* Effect.fail(new AggregateError(result.logs, `Cannot build ${entry}`));
  code = yield* attempt(() => output.text());
  if (qml) {
    const exports = /export\s*\{\s*(?:([$\w]+)\s+as\s+)?createRouter\s*\};?\s*$/;
    const match = exports.exec(code);
    if (!match) return yield* Effect.fail(new Error("Unexpected KWin bundle exports"));
    code = `var FarstepKWin = (() => {\n${code.replace(exports, "")}\nreturn { createRouter: ${match[1] ?? "createRouter"} };\n})();\n`;
  }
  return code;
});

const viteBundle = Effect.fnUntraced(function* (spec: Bundle) {
  const { build } = yield* attempt(() => import("vite"));
  const { bundleConfig } = yield* attempt(
    () => import("../../../../../../tools/scripts/vite/desktop.ts"),
  );
  const result = yield* attempt(() => build(bundleConfig(spec)), {
    awaitOnInterrupt: true,
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!output || "on" in output)
    return yield* Effect.fail(new Error(`Unexpected build result for ${spec.entry}`));
  const chunks = output.output.filter((output) => output.type === "chunk");
  if (chunks.length !== 1 || !chunks[0])
    return yield* Effect.fail(new Error(`Expected one bundle for ${spec.entry}`));
  return chunks[0].code;
});

const graph = new DepGraph<Bundle>();
for (const spec of bundles) {
  if (graph.hasNode(spec.output)) throw new Error("Duplicate desktop bundle outputs");
  graph.addNode(spec.output, spec);
}
for (const spec of bundles) {
  for (const input of spec.hash?.inputs ?? []) {
    if (!graph.hasNode(input))
      throw new Error(`Unknown desktop bundle dependency: ${input}`);
    graph.addDependency(spec.output, input);
  }
}
const order = graph.overallOrder();
const selected = new Set<string>();
for (const spec of bundles) {
  if (desktop !== "both" && desktop !== spec.desktop) continue;
  selected.add(spec.output);
  for (const input of graph.dependenciesOf(spec.output)) selected.add(input);
}
const buildBundle = Effect.fnUntraced(function* (spec: Bundle) {
  const { inputs = [], desktops: hashDesktops = [] } = spec.hash ?? {};
  const extraHash =
    (yield* Effect.forEach(
      inputs,
      (file) =>
        attempt(
          (signal) => readFile(join(destination, file), { encoding: "utf8", signal }),
          { awaitOnInterrupt: true },
        ),
      { concurrency: 4 },
    )).join("") + hashDesktops.map((desktop) => rules(desktop, "")).join("");
  const hash = yield* bundle(spec, join(destination, spec.output), extraHash);
  for (const desktop of hashDesktops)
    yield* attempt(
      () =>
        Bun.write(
          join(destination, spec.desktop, filename(desktop)),
          rules(desktop, hash),
        ),
      { awaitOnInterrupt: true },
    );
});

await run(
  Effect.gen(function* () {
    for (const output of order)
      if (selected.has(output)) yield* buildBundle(graph.getNodeData(output));
    for (const [group, files] of Object.entries(resources)) {
      if (desktop !== "both" && desktop !== group) continue;
      for (const file of files) {
        const target = join(destination, group, file);
        yield* attempt(() => mkdir(dirname(target), { recursive: true }), {
          awaitOnInterrupt: true,
        });
        yield* attempt(() => copyFile(join(source, group, file), target), {
          awaitOnInterrupt: true,
        });
      }
    }
  }),
);
