import { readFileSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { walkSync } from "@nodelib/fs.walk";
import { Graph, Option } from "effect";
import { type Node, parseSync, Visitor } from "oxc-parser";
import { type ResolveResult, ResolverFactory } from "oxc-resolver";
import policy from "./rules.json";

interface PathFilter {
  path?: string;
  pathNot?: string;
}

interface Rule {
  name: string;
  from: PathFilter;
  to: PathFilter & {
    dependencyTypes?: string[];
    dependencyTypesNot?: string[];
    couldNotResolve?: boolean;
    circular?: boolean;
  };
}

interface Dependency {
  specifier: string;
  typeOnly: boolean;
  target: string;
  dependencyTypes: string[];
  couldNotResolve: boolean;
  follow: boolean;
}

const root = process.cwd();
const sourceExtension = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const nodeModules = /(^|\/)node_modules\//;
const excluded = new RegExp(policy.exclude);
const resolveOptions = {
  conditionNames: ["import", "bun", "node", "default"],
  exportsFields: ["exports"],
  extensions: [
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".d.ts",
    ".mjs",
    ".mts",
    ".d.mts",
    ".cjs",
    ".cts",
    ".d.cts",
    ".json",
    ".node",
  ],
  extensionAlias: {
    ".js": [".js", ".ts", ".tsx", ".d.ts"],
    ".jsx": [".jsx", ".ts", ".tsx", ".d.ts"],
    ".mjs": [".mjs", ".mts", ".d.mts"],
    ".cjs": [".cjs", ".cts", ".d.cts"],
  },
};
const resolver = new ResolverFactory(resolveOptions);
const typeResolver = resolver.cloneWithOptions({
  ...resolveOptions,
  conditionNames: ["types", "import", "bun", "node", "default"],
});

function resolveDependency(
  source: string,
  specifier: string,
  typeOnly: boolean,
): Dependency {
  const core =
    isBuiltin(specifier) || specifier === "bun" || specifier.startsWith("bun:");
  const platform = /^(?:gi:\/\/|resource:\/\/\/)/.test(specifier);
  let result: ResolveResult | undefined;
  if (!core && !platform) {
    const file = resolve(root, source);
    const directory = dirname(file);
    // Declaration resolution includes DefinitelyTyped packages and typed subpaths
    if (typeOnly) {
      result = typeResolver.resolveDtsSync(file, specifier);
      // Wildcard declaration exports can resolve to files that do not exist
      if (result.path && !statSync(result.path, { throwIfNoEntry: false })?.isFile())
        result = undefined;
    }
    if (!result?.path)
      result = (typeOnly ? typeResolver : resolver).sync(directory, specifier);
    // A types export can be absent or point to a missing declaration, while
    // the runtime export still resolves, and some packages export only types
    if (!result.path)
      result = (typeOnly ? resolver : typeResolver).sync(directory, specifier);
  }
  const target = result?.path
    ? relative(root, result.path).replaceAll("\\", "/")
    : specifier;
  const npm =
    nodeModules.test(target) ||
    (!result?.path &&
      !core &&
      !platform &&
      !specifier.startsWith(".") &&
      !specifier.startsWith("/") &&
      !specifier.startsWith("#"));
  return {
    specifier,
    typeOnly,
    target,
    dependencyTypes: [
      ...(core ? ["core"] : npm ? ["npm"] : []),
      ...(typeOnly ? ["type-only"] : []),
    ],
    couldNotResolve: !core && !platform && !result?.path,
    follow: !!result?.path && !nodeModules.test(target) && sourceExtension.test(target),
  };
}

function literal(node: Node | null | undefined): string | undefined {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked ?? undefined;
  return undefined;
}

function dependencies(source: string): Dependency[] {
  const text = readFileSync(resolve(root, source), "utf8");
  // Keep erased imports in boundaries and resolution, not runtime cycles
  const parsed = parseSync(source, text, { astType: "ts", sourceType: "unambiguous" });
  if (parsed.errors.some((error) => error.severity === "Error"))
    throw new Error(
      `Cannot analyze ${source}:\n${parsed.errors.map((error) => error.message).join("\n")}`,
    );

  const found = new Map<string, Dependency>();
  const add = (specifier: string | undefined, typeOnly: boolean) => {
    if (specifier === undefined) return;
    const key = `${typeOnly}:${specifier}`;
    if (!found.has(key)) found.set(key, resolveDependency(source, specifier, typeOnly));
  };
  new Visitor({
    ImportDeclaration(node) {
      add(
        node.source.value,
        node.importKind === "type" ||
          (node.specifiers.length > 0 &&
            node.specifiers.every(
              (specifier) =>
                specifier.type === "ImportSpecifier" && specifier.importKind === "type",
            )),
      );
    },
    ExportNamedDeclaration(node) {
      if (node.source)
        add(
          node.source.value,
          node.exportKind === "type" ||
            (node.specifiers.length > 0 &&
              node.specifiers.every((specifier) => specifier.exportKind === "type")),
        );
    },
    ExportAllDeclaration(node) {
      add(node.source.value, node.exportKind === "type");
    },
    ImportExpression(node) {
      add(literal(node.source), false);
    },
    CallExpression(node) {
      if (node.callee.type === "Identifier" && node.callee.name === "require")
        add(literal(node.arguments[0]), false);
    },
    TSImportEqualsDeclaration(node) {
      if (node.moduleReference.type === "TSExternalModuleReference")
        add(node.moduleReference.expression.value, node.importKind === "type");
    },
    TSImportType(node) {
      add(node.source.value, true);
    },
  }).visit(parsed.program);
  return [...found.values()].filter((dependency) => !excluded.test(dependency.target));
}

const pending = new Set<string>();
const included = (source: string) =>
  !excluded.test(`${source}/`) && !nodeModules.test(`${source}/`);
function gather(path: string): void {
  const source = relative(root, path).replaceAll("\\", "/");
  if (!included(source)) return;
  if (statSync(path).isDirectory()) {
    for (const entry of walkSync(path, {
      basePath: source,
      pathSegmentSeparator: "/",
      followSymbolicLinks: false,
      deepFilter: (entry) => included(entry.path),
      entryFilter: (entry) =>
        entry.dirent.isFile() &&
        included(entry.path) &&
        sourceExtension.test(entry.path),
    }))
      pending.add(entry.path);
  } else if (sourceExtension.test(source)) {
    pending.add(source);
  }
}

const roots = Bun.argv.slice(2);
if (roots.length === 0)
  throw new Error("Architecture checks require source files or directories");
for (const path of roots) gather(resolve(root, path));
const graph = new Map<string, Dependency[]>();
for (const source of pending) {
  const imports = dependencies(source);
  graph.set(source, imports);
  for (const dependency of imports) {
    if (dependency.follow) pending.add(dependency.target);
  }
}

// Strongly connected components consider only runtime edges, so a type-only
// return path cannot turn a runtime import into a runtime cycle
function runtimeComponents(): Map<string, number> {
  const indices = new Map<string, Graph.NodeIndex>();
  const runtime = Graph.directed<string, undefined>((mutable) => {
    for (const source of graph.keys())
      indices.set(source, Graph.addNode(mutable, source));
    for (const [source, dependencies] of graph) {
      const from = indices.get(source);
      if (from === undefined) continue;
      for (const dependency of dependencies) {
        const to = indices.get(dependency.target);
        if (!dependency.typeOnly && to !== undefined)
          Graph.addEdge(mutable, from, to, undefined);
      }
    }
  });
  const components = new Map<string, number>();
  for (const [id, members] of Graph.stronglyConnectedComponents(runtime).entries())
    for (const member of members)
      components.set(Option.getOrThrow(Graph.getNode(runtime, member)), id);
  return components;
}

const rules = (policy.forbidden as Rule[]).map((rule) => ({
  name: rule.name,
  from: {
    path: rule.from.path === undefined ? undefined : new RegExp(rule.from.path),
    pathNot:
      rule.from.pathNot === undefined ? undefined : new RegExp(rule.from.pathNot),
  },
  to: {
    ...rule.to,
    path: rule.to.path === undefined ? undefined : new RegExp(rule.to.path),
    pathNot: rule.to.pathNot === undefined ? undefined : new RegExp(rule.to.pathNot),
  },
}));
const components = runtimeComponents();
let violations = 0;
for (const [source, imports] of graph) {
  for (const dependency of imports) {
    for (const rule of rules) {
      if (
        (rule.from.path && !rule.from.path.test(source)) ||
        rule.from.pathNot?.test(source) ||
        (rule.to.path && !rule.to.path.test(dependency.target)) ||
        rule.to.pathNot?.test(dependency.target)
      )
        continue;
      if (
        rule.to.couldNotResolve !== undefined &&
        rule.to.couldNotResolve !== dependency.couldNotResolve
      )
        continue;
      if (
        rule.to.dependencyTypes &&
        !rule.to.dependencyTypes.some((type) =>
          dependency.dependencyTypes.includes(type),
        )
      )
        continue;
      if (
        rule.to.dependencyTypesNot?.some((type) =>
          dependency.dependencyTypes.includes(type),
        )
      )
        continue;
      if (
        rule.to.circular &&
        (dependency.typeOnly ||
          !graph.has(dependency.target) ||
          components.get(source) !== components.get(dependency.target))
      )
        continue;
      violations++;
      console.error(
        `error ${rule.name}: ${source} → ${dependency.target} (${dependency.specifier})`,
      );
    }
  }
}
console.log(`Architecture: ${graph.size} source modules, ${violations} violations`);
process.exitCode = violations > 0 ? 1 : 0;
