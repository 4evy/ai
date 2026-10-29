import { readFileSync } from "node:fs";
import { fromMarkdown } from "mdast-util-from-markdown";
import { renderGuide } from "../guide/guide";

const sources = new Map<string, ReadonlyMap<string, string>>();

// Parse section boundaries before folding prose so code fences stay literal
export function readText(
  url: URL,
  section: string,
  values: Readonly<Record<string, string>> = {},
): string {
  const sections = sources.getOrInsertComputed(url.href, () => {
    const entries = new Map<string, string>();
    const source = readFileSync(url, "utf8").replaceAll("\r\n", "\n");
    const nodes = fromMarkdown(source).children;
    for (let index = 0; index < nodes.length; index++) {
      const heading = nodes[index];
      if (heading?.type !== "heading" || heading.depth !== 2) continue;
      const label = heading.children[0];
      if (
        heading.children.length !== 1 ||
        label?.type !== "text" ||
        !/^[a-z][a-z0-9]*$/.test(label.value)
      )
        continue;
      const name = label.value;
      let cursor = heading.position?.end.offset;
      if (cursor === undefined) throw new Error(`Missing text position in ${url.href}`);
      let body = "";
      let next = index + 1;
      for (; next < nodes.length; next++) {
        const node = nodes[next];
        if (!node || (node.type === "heading" && node.depth === 2)) break;
        if (node.type !== "paragraph") continue;
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if (start === undefined || end === undefined)
          throw new Error(`Missing text position in ${url.href}`);
        body += source.slice(cursor, start);
        // Hard breaks remain newlines; only soft paragraph wraps become spaces
        body += source
          .slice(start, end)
          .replace(/\\\n| {2,}\n|\n/g, (line) => (line === "\n" ? " " : "\n"));
        cursor = end;
      }
      const end = nodes[next]?.position?.start.offset ?? source.length;
      body = (body + source.slice(cursor, end)).trim();
      if (!body || entries.has(name)) {
        throw new Error(`Empty or duplicate text section in ${url.href}`);
      }
      entries.set(name, body);
      index = next - 1;
    }
    return entries;
  });
  const text = sections.get(section);
  if (text === undefined) {
    throw new Error(`Missing ${section} text section in ${url.href}`);
  }
  return renderGuide(text, values, {}, `${url.href}#${section}`);
}
