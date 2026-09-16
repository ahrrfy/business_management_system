/**
 * الحالةُ المشتركة بين منفّذي فاتورة البيع داخل تشغيلة عكسٍ واحدة.
 *
 * منفّذُ المخزون يقرّر ما يعود للرفّ بنداً بند (والكلفةَ التحليليّة لكلّ بند)، ومنفّذُ القيد
 * يحتاجها ليعكس COGS المملوكة فقط (لا الخدمة ولا الأمانة) — كما كان `cancelSaleInTx` يفعله في
 * دالّةٍ واحدةٍ متّصلة. الفصلُ إلى منفّذين يستلزم ذاكرةً مشتركة صريحةً لا متغيّراتِ إغلاق.
 */
import type Decimal from "decimal.js";
import { eq, inArray } from "drizzle-orm";

import { invoiceItems, invoices, productVariants, products } from "../../../../drizzle/schema";
import type { Tx } from "../../../db";
import { classifyVariants } from "../../bundleService";
import type { ReversalRun } from "../types";

export type InvoiceRow = typeof invoices.$inferSelect;
export type InvoiceItemRow = typeof invoiceItems.$inferSelect;
export type VariantKind = "STOCKED" | "BUNDLE" | "SERVICE";

export interface InvoiceContext {
  invoice: InvoiceRow;
  items: InvoiceItemRow[];
  kindByVariant: Map<number, VariantKind>;
  /** المودِعُ لكلّ متغيّرِ أمانة. */
  consignByVariant: Map<number, number>;
  digitalVariants: Set<number>;
}

/** بندٌ تقرّر مصيرُه في منفّذ المخزون. */
export interface ReversedLine {
  itemId: number;
  variantId: number;
  kind: VariantKind;
  isGift: boolean;
  unitCost: Decimal;
  /** الكمّية المعكوسة الآن (وحدة الأساس). */
  quantity: number;
  /** عادت للرفّ فعلاً؟ (تالفٌ أو خدمةٌ ⇒ لا). */
  restocked: boolean;
}

export interface InventoryRunState {
  lines: ReversedLine[];
  restock: boolean;
}

export interface LedgerRunState {
  remainingAmount: Decimal;
  remainingRevenue: Decimal;
  remainingTax: Decimal;
}

const CONTEXT_KEY = "invoice";
const INVENTORY_KEY = "inventory";
const LEDGER_KEY = "ledger";

/** يحمّل الفاتورة وبنودها وتصنيفَ متغيّراتها مرّةً واحدة للتشغيلة. */
export async function invoiceContext(tx: Tx, run: ReversalRun): Promise<InvoiceContext> {
  const cached = run.state.get(CONTEXT_KEY) as InvoiceContext | undefined;
  if (cached) return cached;
  const invoice = (
    await tx.select().from(invoices).where(eq(invoices.id, run.documentId)).limit(1)
  )[0];
  if (!invoice) {
    throw new Error(`reversal: الفاتورة ${run.documentId} غير موجودة داخل تشغيلة العكس`);
  }
  const items = await tx.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, run.documentId));
  const variantIds = Array.from(new Set(items.map((i) => Number(i.variantId))));
  const kindByVariant = variantIds.length
    ? await classifyVariants(tx, variantIds)
    : new Map<number, VariantKind>();
  const consignByVariant = new Map<number, number>();
  const digitalVariants = new Set<number>();
  if (variantIds.length) {
    const rows = await tx
      .select({
        vid: productVariants.id,
        isConsign: products.isConsignment,
        cId: products.consignorId,
        productType: products.productType,
      })
      .from(productVariants)
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(inArray(productVariants.id, variantIds));
    for (const r of rows) {
      if (r.isConsign && r.cId != null) consignByVariant.set(Number(r.vid), Number(r.cId));
      if (r.productType === "DIGITAL_CARD") digitalVariants.add(Number(r.vid));
    }
  }
  const ctx: InvoiceContext = { invoice, items, kindByVariant, consignByVariant, digitalVariants };
  run.state.set(CONTEXT_KEY, ctx);
  return ctx;
}

export function writeInventoryState(run: ReversalRun, state: InventoryRunState): void {
  run.state.set(INVENTORY_KEY, state);
}

export function readInventoryState(run: ReversalRun): InventoryRunState {
  return (run.state.get(INVENTORY_KEY) as InventoryRunState | undefined) ?? { lines: [], restock: run.decisions.restock !== false };
}

export function writeLedgerState(run: ReversalRun, state: LedgerRunState): void {
  run.state.set(LEDGER_KEY, state);
}

export function readLedgerState(run: ReversalRun): LedgerRunState | null {
  return (run.state.get(LEDGER_KEY) as LedgerRunState | undefined) ?? null;
}
