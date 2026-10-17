import { TRPCError } from "@trpc/server";
import { drizzle } from "drizzle-orm/mysql-proxy";
import { computeInvoiceTotals, computeLineTotal } from "../../../server/services/billing";
import { money } from "../../../server/services/money";
import { getUnitPrice, type PriceTier } from "../../../server/services/pricing";
import { createStorefrontCartShare } from "../../../server/services/storefrontCartShareService";
import { withActualDb } from "./db-shim";

export interface ActualBinding {
  prepare(sql: string): {
    bind(...params: unknown[]): { raw(): Promise<unknown[][]> };
  };
}

export interface CartSharePlan {
  token: string;
  linesJson: string;
  expiresAt: string;
}

type CartLine = { productId: number; productUnitId: number; quantity: number };
const bindingKey = Symbol("actual-service-binding");
const PRICE_SELECT = "select `price` from `productPrices` where (`productPrices`.`productUnitId` = ? and `productPrices`.`priceTier` = ?) limit ?";
const tiers = new Set(["RETAIL", "WHOLESALE", "GOVERNMENT"]);

function unsupported(detail: string): never {
  throw new Error(`Unsupported actual-service operation: ${detail}`);
}

/** Parse only the original service's fixed single-row INSERT; no SQL rewriting. */
function cartPlan(sql: string, params: unknown[]): CartSharePlan {
  const match = /^insert into `storefrontCartShares` \(([^)]+)\) values \(([^)]+)\)$/.exec(sql);
  if (!match) return unsupported("only the known cart-share INSERT may be staged");
  const columns = match[1].split(", ");
  const values = match[2].split(", ");
  if (columns.join(",") !== "`id`,`token`,`lines`,`expiresAt`,`createdAt`" ||
      values.join(",") !== "default,?,?,?,default" || params.length !== 3) {
    return unsupported("cart-share INSERT columns or placeholders changed");
  }
  // DEFAULT columns are omitted; the retained values remain the original bound values.
  const retained = columns.flatMap((column, index) => values[index] === "?" ? [column] : []);
  if (retained.join(",") !== "`token`,`lines`,`expiresAt`" || params.some(value => typeof value !== "string")) {
    return unsupported("cart-share INSERT bound values changed");
  }
  const [token, linesJson, expiresAt] = params as string[];
  if (!/^[A-Za-z0-9_-]{24}$/.test(token) || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/.test(expiresAt)) {
    return unsupported("cart-share token or timestamp changed");
  }
  return { token, linesJson, expiresAt };
}

export function createActualDb(binding: ActualBinding, onInsert?: (plan: CartSharePlan) => void | Promise<void>) {
  const db = drizzle(async (sql, params, method) => {
    if (method === "all" && sql === PRICE_SELECT) {
      if (params.length !== 3 || !Number.isSafeInteger(params[0]) || params[0] <= 0 ||
          !tiers.has(params[1]) || params[2] !== 1) return unsupported("invalid price SELECT parameters");
      return { rows: await binding.prepare(sql).bind(...params).raw() };
    }
    if (method === "execute" && onInsert) {
      await onInsert(cartPlan(sql, params));
      // Staging acknowledgement only: no row or auto-increment ID was written.
      return { rows: [{ insertId: 0, affectedRows: 0 }] };
    }
    return unsupported("SQL is outside the price-read / staged-cart allowlist");
  });
  return Object.assign(db, { [bindingKey]: binding });
}

export type ActualDb = ReturnType<typeof createActualDb>;

export interface ActualQuoteInput {
  productUnitId: number;
  tier: PriceTier;
  quantity: number;
  discount?: string;
  taxRate?: string;
  fee?: string;
}

function invalid(message: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message });
}

function amount(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,12})(?:\.\d{1,2})?$/.test(value)) {
    return invalid(`${field} must be a nonnegative decimal string with at most two decimal places`);
  }
  return value;
}

/** A quote only: it neither reserves stock nor commits a sale, receipt, or order. */
export async function quoteActual(db: ActualDb, input: ActualQuoteInput) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid("quote input must be an object");
  const allowed = new Set(["productUnitId", "tier", "quantity", "discount", "taxRate", "fee"]);
  if (Object.keys(input).some(key => !allowed.has(key))) return invalid("unsupported quote input field");
  if (!Number.isSafeInteger(input.productUnitId) || input.productUnitId <= 0) return invalid("productUnitId must be a positive safe integer");
  if (!tiers.has(input.tier)) return invalid("unsupported price tier");
  if (!Number.isInteger(input.quantity) || input.quantity <= 0 || input.quantity > 999) return invalid("quantity must be an integer from 1 to 999");
  const discount = amount(input.discount ?? "0", "discount");
  const taxRate = amount(input.taxRate ?? "0", "taxRate");
  const fee = amount(input.fee ?? "0", "fee");
  if (money(taxRate).gt(100)) return invalid("taxRate must be from 0 to 100");
  // Original production functions execute here, unchanged, including missing-tier rejection.
  // The source accepts a MySQL Tx type; this adapter implements only its audited SELECT path.
  const priceDb = db as unknown as Parameters<typeof getUnitPrice>[0];
  const unitPrice = await getUnitPrice(priceDb, input.productUnitId, input.tier);
  const line = computeLineTotal({ unitPrice, quantity: money(input.quantity) });
  const totals = computeInvoiceTotals({ lineTotals: [line.total], invoiceDiscount: discount, taxRatePercent: taxRate, deliveryFee: fee });
  return { productUnitId: input.productUnitId, tier: input.tier, line, totals };
}

export async function prepareActualCartShare(db: ActualDb, lines: CartLine[]) {
  if (!Array.isArray(lines) || lines.length > 1000 || lines.some(line => !line || typeof line !== "object" || Array.isArray(line))) {
    return invalid("cart lines must be an array of at most 1000 line objects");
  }
  const binding = db[bindingKey];
  if (!binding) return unsupported("database was not created by createActualDb");
  let plan: CartSharePlan | undefined;
  const stagingDb = createActualDb(binding, staged => {
    if (plan) return unsupported("cart create attempted more than one INSERT");
    plan = staged;
  });
  const result = await withActualDb(stagingDb, () => createStorefrontCartShare(lines));
  if (!plan || result.token !== plan.token) return unsupported("cart create did not stage its known INSERT");
  return { result: { ...result, expiresAt: result.expiresAt.toISOString() }, plan };
}
