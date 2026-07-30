import Decimal from "decimal.js";
import { money, round2, toDbMoney, type Money } from "../money";

export type PricingMode = "FIXED_MARGIN" | "PERCENT_MARGIN" | "FIXED_PLUS_PERCENT" | "FIXED_SELL_PRICE";

export interface PricingParams {
  pricingMode: PricingMode;
  providerShare: string;
  fixedMargin?: string | null;
  marginPercent?: string | null;
  roundingStep?: string | null;
  minimumMargin?: string | null;
  fixedSellPrice?: string | null;
}

export interface PricingResult {
  sellPrice: Money;
  marginAmount: Money;
  providerShare: Money;
}

function ceilToStep(raw: Decimal, step: Decimal): Decimal {
  if (step.lte(0)) return round2(raw);
  return round2(raw.div(step).ceil().mul(step));
}

export function computeSellPrice(params: PricingParams): PricingResult {
  const ps = money(params.providerShare);
  const fixedM = money(params.fixedMargin);
  const pctM = money(params.marginPercent);
  const step = money(params.roundingStep ?? "250");

  let rawSell: Decimal;

  switch (params.pricingMode) {
    case "FIXED_MARGIN":
      rawSell = ps.plus(fixedM);
      break;
    case "PERCENT_MARGIN":
      rawSell = ps.mul(new Decimal(1).plus(pctM.div(100)));
      break;
    case "FIXED_PLUS_PERCENT":
      rawSell = ps.plus(fixedM).plus(ps.mul(pctM.div(100)));
      break;
    case "FIXED_SELL_PRICE":
      rawSell = money(params.fixedSellPrice);
      break;
    default:
      throw new Error(`pricingMode غير معروف: ${params.pricingMode}`);
  }

  const sellPrice = ceilToStep(rawSell, step);
  const marginAmount = round2(sellPrice.minus(ps));

  return {
    sellPrice: toDbMoney(sellPrice),
    marginAmount: toDbMoney(marginAmount),
    providerShare: toDbMoney(ps),
  };
}

export function validateMinimumMargin(result: PricingResult, minimumMargin: string | null | undefined): boolean {
  if (!minimumMargin) return true;
  return money(result.marginAmount).gte(money(minimumMargin));
}
