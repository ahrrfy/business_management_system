import Decimal from "decimal.js";
import { money, round2 } from "../money";

/** Remove a reviewed component credit over subsequent whole-unit returns, with exact final remainder. */
export function rightsAbsorbedAmount(
  rightsAmount: string,
  totalQuantity: number,
  baseline: number,
  previouslyReturned: number,
  quantity: number,
): Decimal {
  const span = totalQuantity - baseline;
  const cumulative = (q: number) =>
    round2(
      money(rightsAmount)
        .times(Math.max(0, Math.min(span, q - baseline)))
        .div(span),
    );
  return round2(
    cumulative(previouslyReturned + quantity).minus(
      cumulative(previouslyReturned),
    ),
  );
}

/** A component previously received (usable OR damaged) cannot be physically received twice. */
export function rightsAdjustedComponentQuantity(
  perUnit: number,
  totalUnits: number,
  returnedUnits: number,
  returningUnits: number,
  rightsQuantity: number,
): number {
  return Math.max(
    0,
    Math.min(
      perUnit * returningUnits,
      perUnit * (totalUnits - returnedUnits) - rightsQuantity,
    ),
  );
}
