import type {
  BillingSummaryPresentation,
  StatusLinePresentation,
} from "@oh-my-pi/pi-coding-agent/ui/status/presentation";
import type { SymbolSet } from "@oh-my-pi/pi-tui/theme/contract";
import { formatNumber, normalizePremiumRequests } from "@oh-my-pi/pi-utils";
import { compactFooterSegments } from "./footer";

function thinkingLevelLabel(level: string): string {
  switch (level) {
    case "minimal":
      return "min";
    case "low":
      return "lo";
    case "medium":
      return "med";
    case "high":
      return "hi";
    case "xhigh":
      return "xhi";
    default:
      return level;
  }
}

/** Keep billing facts intact while choosing units and secondary detail */
function billingSummary(
  options: BillingSummaryPresentation,
  symbols: SymbolSet,
  availableWidth = 0,
): string | undefined {
  const premium = normalizePremiumRequests(options.premiumRequests);
  const advisor = options.advisor?.cost ?? 0;
  const tree = options.subagentCost ?? 0;
  if (
    !options.cost &&
    !tree &&
    !advisor &&
    !options.usingSubscription &&
    !premium &&
    !options.pricingPeriod
  )
    return undefined;

  const parts: string[] = [];
  let shownSubscription: boolean | undefined;
  if (options.cost || options.pricingPeriod || tree || options.usingSubscription) {
    parts.push(`$${options.cost.toFixed(options.digits)}`);
    shownSubscription = options.usingSubscription;
  }
  if (tree && !(availableWidth > 0 && availableWidth < 100))
    parts.push(`(+${tree.toFixed(options.digits)})`);
  if (options.pricingPeriod) parts.push(options.pricingPeriod === "peak" ? "↑" : "↓");
  if (premium) parts.push(`★ ${formatNumber(premium)}`);
  if (advisor && options.advisor) {
    const amount = advisor.toFixed(options.digits);
    const spend =
      shownSubscription === options.advisor.usingSubscription ? amount : `$${amount}`;
    const icon = symbols.icon("advisor");
    parts.push(
      `${parts.length > 0 ? "+ " : ""}${icon && icon !== "(adv)" ? `${icon} ${spend}` : `${spend} (adv)`}`,
    );
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

export const compactStatusLine: StatusLinePresentation = {
  thinkingLevelLabel,
  billingSummary,
  ...compactFooterSegments,
};
