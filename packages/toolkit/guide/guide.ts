import { readFileSync } from "node:fs";
import * as v from "valibot";

const sources = new Map<string, string>();

export function guideExample<TSchema extends v.GenericSchema>(
  schema: TSchema,
  input: NoInfer<v.InferInput<TSchema>>,
  options: {
    multiline?: boolean;
    replacements?: ReadonlyMap<unknown, string>;
  } = {},
): string {
  // Validate concrete samples before displaying task-specific placeholders
  v.parse(schema, input);
  const json = JSON.stringify(
    input,
    (_key, value: unknown) => options.replacements?.get(value) ?? value,
    options.multiline ? 2 : undefined,
  );
  if (options.multiline) return `\`\`\`json\n${json}\n\`\`\``;
  const delimiter = "`".repeat(
    Math.max(0, ...(json.match(/`+/gu) ?? []).map((run) => run.length)) + 1,
  );
  return `${delimiter}${json}${delimiter}`;
}

export function readGuide(
  url: URL,
  values: Readonly<Record<string, string>> = {},
  tools: Readonly<Record<string, string>> = {},
): string {
  const text = sources.getOrInsertComputed(url.href, () => {
    const text = readFileSync(url, "utf8").trim();
    if (!text) throw new Error(`Empty guide: ${url.href}`);
    return text;
  });

  return renderGuide(text, values, tools, url.href);
}

// Replace once so inserted API documentation is never interpreted as a template
export function renderGuide(
  source: string,
  values: Readonly<Record<string, string>> = {},
  tools: Readonly<Record<string, string>> = {},
  context?: string,
): string {
  return source.replace(/\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g, (_match, key: string) => {
    const toolKey = key.endsWith("Tool") ? key.slice(0, -4) : undefined;
    const value = Object.hasOwn(values, key)
      ? values[key]
      : toolKey !== undefined && Object.hasOwn(tools, toolKey)
        ? `\`${tools[toolKey]}\``
        : undefined;
    if (value === undefined) {
      throw new Error(`Missing ${key} value for guide${context ? `: ${context}` : ""}`);
    }
    return value;
  });
}
