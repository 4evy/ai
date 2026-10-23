import { isUtf8 } from "node:buffer";
import { randomUUID } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { run } from "@ai/core/effect/effect";
import { executeCommand } from "@ai/core/effect/process/process";
import { errorMessage } from "@ai/core/error/error";
import { readText } from "@ai/core/text/text";
import * as v from "valibot";

const kindSchema = v.picklist(["shell", "xml", "text"]);
type Kind = v.InferOutput<typeof kindSchema>;
type Token = { start: number; end: number; raw: string };
type Mask = { token: Token; replacement: string };

function tokens(source: string): Token[] {
  return [...source.matchAll(/@[A-Z][A-Z0-9_]*@/g)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    raw: match[0],
  }));
}

// Nix replacement tokens must not affect the containing shell string
function quoteAt(source: string, end: number, allTokens: Token[], kind: Kind): string {
  const context = new QuoteContext();
  let tokenIndex = 0;
  for (let index = 0; index < end; index++) {
    const token = allTokens[tokenIndex];
    if (token && index === token.start) {
      index = token.end - 1;
      tokenIndex++;
      continue;
    }
    index = context.consume(source, index, kind);
  }
  return context.quote;
}

class QuoteContext {
  quote = "";
  private lineComment = false;
  private blockComment = false;

  private quoted(source: string, index: number): number {
    if (source[index] === "\\" && this.quote !== "'" && this.quote !== "'".repeat(3))
      return index + 1;
    if (source.startsWith(this.quote, index)) {
      const end = index + this.quote.length - 1;
      this.quote = "";
      return end;
    }
    return index;
  }

  consume(source: string, index: number, kind: Kind): number {
    const char = source[index];
    if (this.lineComment) {
      if (char === "\n") this.lineComment = false;
      return index;
    }
    if (this.blockComment) {
      if (source.startsWith("*/", index)) {
        this.blockComment = false;
        return index + 1;
      }
      return index;
    }
    if (this.quote) return this.quoted(source, index);
    return this.unquoted(source, index, kind);
  }
  private unquoted(source: string, index: number, kind: Kind): number {
    const char = source[index];
    const comment = commentAt(source, index, kind);
    if (comment) {
      this.lineComment = comment === "line";
      this.blockComment = comment === "block";
      return source[index] === "#" ? index : index + 1;
    }
    if (char === '"' || char === "'" || char === "`") {
      this.quote = char;
    }
    return index;
  }
}

function commentAt(
  source: string,
  index: number,
  _kind: Kind,
): "line" | "block" | undefined {
  return source[index] === "#" && (index === 0 || /\s/.test(source[index - 1] ?? ""))
    ? "line"
    : undefined;
}

function maskSource(source: string, kind: Kind, allTokens: Token[]) {
  let prefix: string;
  do prefix = `TREEFMTMASK${randomUUID().replaceAll("-", "")}`;
  while (source.includes(prefix));
  const masks: Mask[] = [];
  let output = "";
  let cursor = 0;
  for (const token of allTokens) {
    const marker = `${prefix}X${masks.length}Z`;
    const replacement = tokenReplacement(source, kind, allTokens, token, marker);
    // XML markers contain no markup or entity characters, including when an
    // original template action contains quotes or comparison operators
    masks.push({ token, replacement });
    output += source.slice(cursor, token.start) + replacement;
    cursor = token.end;
  }
  output += source.slice(cursor);
  return {
    source: output,
    restore(formatted: string): string {
      for (const { token, replacement } of masks) {
        const index = formatted.indexOf(replacement);
        if (
          index < 0 ||
          formatted.indexOf(replacement, index + replacement.length) >= 0
        ) {
          throw new Error(`Formatter lost or duplicated template action ${token.raw}`);
        }
        formatted =
          formatted.slice(0, index) +
          token.raw +
          formatted.slice(index + replacement.length);
      }
      if (formatted.includes(prefix)) throw new Error("Unrestored template sentinel");
      return formatted;
    },
  };
}

function tokenReplacement(
  source: string,
  kind: Kind,
  allTokens: Token[],
  token: Token,
  marker: string,
): string {
  switch (kind) {
    case "shell":
      if (
        token.raw === "@REDIRECT@" &&
        !quoteAt(source, token.start, allTokens, kind)
      ) {
        // A subshell may only be followed by redirections, not an argument
        return `2>${marker}`;
      }
      // Identifiers also serve as opaque words and adjacent word fragments:
      // @OPTIONS@@FILE@='' remains one valid assignment, ${@FILE@} and
      // ${#@VALUE@} remain parameter expansions, and @PRELUDE@@WORKSPACE@
      // stays adjacent without adding a separator to the rendered program
      return marker;
    default:
      return marker;
  }
}

function verifyTokens(original: Token[], formatted: string) {
  const restored = tokens(formatted);
  if (
    restored.length !== original.length ||
    restored.some((token, index) => token.raw !== original[index]?.raw)
  ) {
    throw new Error("Template tokens changed, disappeared, duplicated, or moved");
  }
}

async function engine(
  executable: string,
  args: string[],
  source: string,
): Promise<string> {
  const {
    stdout,
    stderr,
    code: status,
  } = await run(
    executeCommand([executable, ...args], {
      stdin: new TextEncoder().encode(source),
    }),
  );
  if (status !== 0)
    throw new Error(
      `${executable} exited ${status}${stderr ? `:\n${stderr.trimEnd()}` : ""}`,
    );
  if (stderr) process.stderr.write(stderr);
  return stdout;
}

function text(source: string): string {
  // This route is deliberately not a structural formatter. Keep aligned help,
  // INI commands, batch expansions, Zsh syntax, and quoted whitespace intact:
  // no reflow, indentation changes, line-ending conversion, or space stripping
  if (!source || source.endsWith("\n") || /[\\^][ \t]*\r?$/.test(source)) return source;
  return `${source}\n`;
}

async function format(
  kind: Kind,
  executable: string,
  filename: string,
  source: string,
): Promise<string> {
  const original = tokens(source);
  if (kind === "text") {
    const formatted = text(source);
    verifyTokens(original, formatted);
    return formatted;
  }
  const masked = maskSource(source, kind, original);
  const args = engineArguments(kind, filename, source);
  const formatted = masked.restore(await engine(executable, args, masked.source));
  verifyTokens(original, formatted);
  return formatted;
}

function engineArguments(kind: Kind, filename: string, body: string): string[] {
  switch (kind) {
    case "shell": {
      // Fragments are Bash, actual /bin/sh shebangs are
      // POSIX, preserve scaffold words without semantic rewriting
      const dialect = /^#!\s*(?:\/\S*\/sh|\/usr\/bin\/env\s+sh)(?:\s|$)/m.test(body)
        ? "posix"
        : "bash";
      return ["-i", "2", "-ln", dialect, "-filename", filename];
    }
    default:
      return ["--nonet", "--format", "-"];
  }
}

const [kindArgument, executable, ...filenames] = Bun.argv.slice(2);
if (
  !v.is(kindSchema, kindArgument) ||
  !executable ||
  !filenames.length ||
  (kindArgument === "text" ? executable !== "-" : executable === "-")
) {
  console.error(
    readText(new URL("./format.md", import.meta.url), "usage", {
      KINDS: kindSchema.options.join(", "),
    }),
  );
  process.exit(2);
}

for (const filename of filenames) {
  try {
    const metadata = await stat(filename);
    if (!metadata.isFile()) throw new Error("Not a regular file");
    const bytes = await readFile(filename);
    if (!isUtf8(bytes)) throw new Error("Source is not valid UTF-8");
    const source = bytes.toString("utf8");
    const formatted = await format(kindArgument, executable, filename, source);
    if (formatted !== source) {
      // In-place writes retain the existing file's permission bits; engines
      // only see stdin and cannot mutate the destination before restoration
      await writeFile(filename, formatted, "utf8");
    }
  } catch (error) {
    console.error(`${filename}: ${errorMessage(error)}`);
    process.exit(1);
  }
}
