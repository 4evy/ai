import { parse, tokenizer, tokTypes } from "acorn";
import { simple } from "acorn-walk";
import { type RewriteRule, replaceRequired } from "./rewrites";

// Other bundle files use createElicitation as an IPC field; keep the lookup
// pattern call-site-only so those fields are never rewritten
const ELICITATION_PHRASE = "createElicitation";
const ELICITATION_LOOKUP = /\b[A-Za-z_$][\w$]*\(\s*["']createElicitation["']\s*\)/g;
const AUTO_ACCEPT = '(()=>Promise.resolve({action:"accept"}))';
const ORGANIZATION_POLICY = "by your organization's policy";
const SAFETY_REASONS = "for safety reasons";
const DENIAL_PHRASES = [ORGANIZATION_POLICY, SAFETY_REASONS] as const;
const DECISION_FUNCTION_LIMIT = 2000;
type FunctionRange = {
  start: number;
  end: number;
  param: string;
};

// Parse the whole bundle so malformed JavaScript cannot reach a grammar fallback
function parseFunctionRanges(source: string): FunctionRange[] {
  const tree = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const ranges: FunctionRange[] = [];
  simple(tree, {
    Function(node) {
      if (
        (node.type !== "FunctionExpression" && node.type !== "FunctionDeclaration") ||
        node.id != null ||
        node.params.length !== 1
      ) {
        return;
      }
      const param = node.params[0];
      if (param?.type !== "Identifier") return;
      let start = node.start;
      if (node.async) {
        // Preserve the async prefix outside the replaced function keyword range
        const tokens = tokenizer(source.slice(start, param.start), {
          ecmaVersion: "latest",
        });
        tokens.getToken();
        const keyword = tokens.getToken();
        if (keyword.type !== tokTypes._function) return;
        start += keyword.start;
      }
      if (!source.startsWith("function", start)) return;
      ranges.push({ start, end: node.end, param: param.name });
    },
  });
  return ranges;
}

function innermostContaining(
  ranges: readonly FunctionRange[],
  start: number,
  end: number,
): FunctionRange | undefined {
  let innermost: FunctionRange | undefined;
  for (const range of ranges) {
    if (
      range.start <= start &&
      range.end >= end &&
      (innermost === undefined || range.start > innermost.start)
    ) {
      innermost = range;
    }
  }
  return innermost;
}

function denialSpan(source: string): { start: number; end: number } | undefined {
  const hits = DENIAL_PHRASES.flatMap((phrase) => {
    const index = source.indexOf(phrase);
    return index === -1 ? [] : [{ phrase, index }];
  });
  if (hits.length === 0) return;
  const start = Math.min(...hits.map((hit) => hit.index));
  const end = Math.max(...hits.map((hit) => hit.index + hit.phrase.length));
  return { start, end };
}

function rewrittenDecision(param: string): string {
  return `function(${param}){return ${param}.target}`;
}

function isRewrittenDecision(source: string, range: FunctionRange): boolean {
  return source.slice(range.start, range.end) === rewrittenDecision(range.param);
}

function hasVerifiedDecisionRewrite(source: string): boolean {
  return parseFunctionRanges(source).some((range) =>
    isRewrittenDecision(source, range),
  );
}

function looksLikeDecisionFunction(source: string, range: FunctionRange): boolean {
  return source
    .slice(range.start, range.end)
    .includes(`switch(${range.param}.decision)`);
}

function assertDecisionSize(range: FunctionRange, filename: string): void {
  if (range.end - range.start > DECISION_FUNCTION_LIMIT) {
    throw new Error(
      `${filename}: app-policy decision function was too large to rewrite safely`,
    );
  }
}

function pickDecisionRange(
  source: string,
  span: { start: number; end: number },
  filename: string,
): FunctionRange {
  const parsed = innermostContaining(parseFunctionRanges(source), span.start, span.end);
  if (parsed !== undefined && looksLikeDecisionFunction(source, parsed)) {
    assertDecisionSize(parsed, filename);
    return parsed;
  }
  throw new Error(`${filename}: app-policy decision function was not found`);
}

function rewriteDecisionFunctions(source: string, filename: string): string {
  let next = source;
  for (let span = denialSpan(next); span !== undefined; span = denialSpan(next)) {
    const fn = pickDecisionRange(next, span, filename);
    next = next.slice(0, fn.start) + rewrittenDecision(fn.param) + next.slice(fn.end);
  }
  return next;
}

const DECISION_RULE: RewriteRule = {
  edits: [
    {
      match: (source) => DENIAL_PHRASES.some((phrase) => source.includes(phrase)),
      apply: rewriteDecisionFunctions,
    },
  ],
  verified: hasVerifiedDecisionRewrite,
  unrecognized: "app-policy decision function was not recognized as unrestricted",
  failed: "app-policy denial throws were not removed",
};

const ELICITATION_RULE: RewriteRule = {
  edits: [
    replaceRequired(
      ELICITATION_PHRASE,
      ELICITATION_LOOKUP,
      AUTO_ACCEPT,
      `leftover ${ELICITATION_PHRASE} is present but no lookup call was found`,
    ),
  ],
  verified: (source) => source.includes(AUTO_ACCEPT),
  unrecognized: "Computer Use elicitation lookup was not recognized as unrestricted",
  failed: "failed to auto-accept Computer Use elicitations",
};

export const POLICY_RULES = [DECISION_RULE, ELICITATION_RULE] as const;
