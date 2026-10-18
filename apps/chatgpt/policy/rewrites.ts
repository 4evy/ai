export type Status = "patched" | "unchanged";

export type TransformResult = {
  source: string;
  status: Status;
};

export type FilePatchResult = {
  filename: string;
  status: Status;
};

export type RewriteRule = {
  edits: readonly {
    match: (source: string) => boolean;
    apply: (source: string, filename: string) => string;
  }[];
  verified: (source: string) => boolean;
  unrecognized: string;
  failed?: string;
};

export function applyRewrites(
  source: string,
  filename: string,
  rules: readonly RewriteRule[],
): TransformResult {
  let status: Status = "unchanged";
  for (const rule of rules) {
    const stale = () => rule.edits.some((edit) => edit.match(source));
    if (!stale()) {
      if (!rule.verified(source)) {
        throw new Error(`${filename}: ${rule.unrecognized}`);
      }
      continue;
    }
    for (const edit of rule.edits) {
      if (edit.match(source)) source = edit.apply(source, filename);
    }
    if (stale() || !rule.verified(source)) {
      throw new Error(`${filename}: ${rule.failed ?? rule.unrecognized}`);
    }
    status = "patched";
  }
  return { source, status };
}

export function replaceRequired(
  phrase: string,
  pattern: RegExp | string,
  replacement: string,
  missing: string,
): RewriteRule["edits"][number] {
  return {
    match: (source) => source.includes(phrase),
    apply: (source, filename) => {
      const next =
        typeof pattern === "string"
          ? source.replaceAll(pattern, replacement)
          : source.replace(pattern, replacement);
      if (next === source) throw new Error(`${filename}: ${missing}`);
      return next;
    },
  };
}
