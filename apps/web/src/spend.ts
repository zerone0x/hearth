/**
 * Spend text for the session header and Settings (decision 0047). Kept out of
 * SessionPage, which App.tsx loads lazily.
 */

import type { SessionSpend } from "./api";

/** Dollars with cents, or more digits below one cent. */
export function formatUsd(usd: number): string {
  return usd !== 0 && Math.abs(usd) < 0.01 ? `$${usd.toPrecision(2)}` : `$${usd.toFixed(2)}`;
}

/** The text of the spend badge, or null when there is nothing to show. */
export function spendText(view: SessionSpend | undefined): string | null {
  if (view === undefined || view.gateway === "direct") return null;
  const budget = formatUsd(view.budgetUsd);
  if (view.gateway === "none") return `$0.00 of ${budget}`;
  if (view.spend === null) return `spend unavailable (budget ${budget})`;
  const tokens = view.spend.totalTokens.toLocaleString("en-US");
  const reached = view.spend.costUsd >= view.budgetUsd ? " - budget reached" : "";
  return `${formatUsd(view.spend.costUsd)} of ${budget}, ${tokens} tokens${reached}`;
}
