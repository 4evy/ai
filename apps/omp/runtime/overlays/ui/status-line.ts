import type { BillingSummaryOptions } from "@oh-my-pi/pi-tui/status-line/metrics";
import type { Theme } from "@oh-my-pi/pi-tui/theme";

export interface BillingSummaryPresentation extends BillingSummaryOptions {
  readonly availableWidth?: number;
}

/** Optional presentation policy, leaving accounting and layout with the host */
export interface StatusLinePresentation {
  thinkingLevelLabel?: (level: string) => string;
  billingSummary?: (
    options: BillingSummaryPresentation,
    theme: Theme,
  ) => string | undefined;
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
