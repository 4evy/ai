import type { StatusFacts } from "@oh-my-pi/pi-coding-agent/ui/status/facts";
import type { Billing } from "@oh-my-pi/pi-coding-agent/ui/status/format";
import type { SegView } from "@oh-my-pi/pi-coding-agent/ui/status/segments";
import type { SymbolSet } from "@oh-my-pi/pi-tui/theme/contract";

export type BillingSummaryPresentation = Billing;

/** Optional presentation policy, leaving accounting and layout with the host */
export interface StatusLinePresentation {
  thinkingLevelLabel?: (level: string) => string;
  billingSummary?: (
    options: BillingSummaryPresentation,
    symbols: SymbolSet,
    availableWidth?: number,
  ) => string | undefined;
  usage?: (facts: StatusFacts, symbols: SymbolSet) => SegView | null;
  context?: (facts: StatusFacts, symbols: SymbolSet, accent?: string) => SegView;
  subagents?: (count: number) => SegView | null;
}

let presentation: StatusLinePresentation | undefined;

export function setStatusLinePresentation(
  policy: StatusLinePresentation | undefined,
): void {
  presentation = policy;
}

export function getStatusLinePresentation(): StatusLinePresentation | undefined {
  return presentation;
}
