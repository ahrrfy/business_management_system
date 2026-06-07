import { TRPCError } from "@trpc/server";
import { desc, eq, like } from "drizzle-orm";
import {
  customers,
  productUnits,
  productVariants,
  products,
  quotationItems,
  quotations,
} from "../../drizzle/schema";
import type { Tx } from "../db";
import { getDb } from "../db";
import { computeInvoiceTotals, computeLineTotal } from "./billing";
import { convertToBaseQuantity } from "./inventoryService";
import { money, toDateStr } from "./money";
import { getUnitPrice, resolveTier, type PriceTier } from "./pricing";
import { createSale } from "./saleService";
import { withTx, type Actor } from "./tx";

type PaymentMethod = "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET";

export interface QuotationLineInput {
  variantId: number;
  productUnitId: number;
  quantity: string;
  unitPriceOverride?: string | null;
  discountPercent?: string | null;
  discountAmount?: string | null;
}

export interface CreateQuotationInput {
  branchId: number;
  customerId?: number | null;
  priceTier?: PriceTier | null;
  validUntil?: string | null; // YYYY-MM-DD
  lines: QuotationLineInput[];
  invoiceDiscount?: string | null;
  taxRatePercent?: string | null;
  notes?: string | null;
}

async function nextQuoteNumber(tx: Tx, branchId: number): Promise<string> {
  const ymd = toDateStr().replace(/-/g, "");
  const prefix = `QUO-${branchId}-${ymd}-`;
  const rows = await tx
    .select({ n: quotations.quoteNumber })
    .from(quotations)
    .where(like(quotations.quoteNumber, `${prefix}%`))
    .orderBy(desc(quotations.id))
    .for("update")
    .limit(1);
  const last = rows[0]?.n;
  const seq = last ? parseInt(last.slice(prefix.length), 10) + 1 : 1;
  return prefix + String(seq).padStart(5, "0");
}

/** يُنشئ عرض سعر — مستند فقط، بلا أي أثر على المخزون أو الدفتر. */
export async function createQuotation(input: CreateQuotationInput, actor: Actor) {
  return withTx(async (tx) => {
    if (!input.lines.length) throw new TRPCError({ code: "BAD_REQUEST", message: "عرض السعر بلا أصناف" });

    // فئة السعر من العميل أو التجاوز اليدوي.
    let customerTier: PriceTier | null = null;
    if (input.customerId) {
      const c = await tx.select().from(customers).where(eq(customers.id, input.customerId)).limit(1);
      if (!c[0]) throw new TRPCError({ code: "NOT_FOUND", message: "العميل غير موجود" });
      customerTier = c[0].defaultPriceTier as PriceTier;
    }
    const tier = resolveTier({ override: input.priceTier ?? null, customerTier });

    const computed = [];
    for (const l of input.lines) {
      const { baseQuantity } = await convertToBaseQuantity(tx, l.productUnitId, l.quantity, l.variantId);
      const unitPrice =
        l.unitPriceOverride != null && l.unitPriceOverride !== ""
          ? money(l.unitPriceOverride)
          : await getUnitPrice(tx, l.productUnitId, tier);
      const lineRes = computeLineTotal({
        unitPrice,
        quantity: money(l.quantity),
        discountPercent: l.discountPercent,
        discountAmount: l.discountAmount,
      });
      computed.push({
        variantId: l.variantId,
        productUnitId: l.productUnitId,
        baseQuantity,
        unitPrice: lineRes.unitPrice,
        quantity: lineRes.quantity,
        discountAmount: lineRes.discountAmount,
        total: lineRes.total,
      });
    }

    const totals = computeInvoiceTotals({
      lineTotals: computed.map((c) => c.total),
      invoiceDiscount: input.invoiceDiscount,
      taxRatePercent: input.taxRatePercent,
    });

    const quoteNumber = await nextQuoteNumber(tx, input.branchId);
    const insRes = await tx.insert(quotations).values({
      quoteNumber,
      branchId: input.branchId,
      customerId: input.customerId ?? null,
      priceTier: tier,
      validUntil: input.validUntil ? new Date(input.validUntil) : null,
      subtotal: totals.subtotal,
      taxAmount: totals.taxAmount,
      discountAmount: totals.discountAmount,
      total: totals.total,
      status: "DRAFT",
      notes: input.notes ?? null,
      createdBy: actor.userId,
    });
    const quotationId = Number((insRes as any)[0]?.insertId ?? (insRes as any).insertId);

    for (const c of computed) {
      await tx.insert(quotationItems).values({
        quotationId,
        variantId: c.variantId,
        productUnitId: c.productUnitId,
        quantity: c.quantity,
        baseQuantity: c.baseQuantity,
        unitPrice: c.unitPrice,
        discountAmount: c.discountAmount,
        total: c.total,
      });
    }
    return { quotationId, quoteNumber, total: totals.total };
  });
}

type QuoteStatus = "DRAFT" | "SENT" | "ACCEPTED" | "REJECTED" | "CONVERTED" | "EXPIRED";

const ALLOWED_TRANSITIONS: Record<QuoteStatus, QuoteStatus[]> = {
  DRAFT: ["SENT", "ACCEPTED", "REJECTED", "EXPIRED"],
  SENT: ["ACCEPTED", "REJECTED", "EXPIRED"],
  ACCEPTED: ["REJECTED", "EXPIRED"], // التحويل يتم عبر convertQuotation لا هنا
  REJECTED: [],
  CONVERTED: [],
  EXPIRED: [],
};

/** يحدّث حالة عرض السعر (عدا CONVERTED الذي يتم عبر convertQuotation). */
export async function setQuotationStatus(quotationId: number, status: QuoteStatus) {
  return withTx(async (tx) => {
    const q = (await tx.select().from(quotations).where(eq(quotations.id, quotationId)).for("update").limit(1))[0];
    if (!q) throw new TRPCError({ code: "NOT_FOUND", message: "عرض السعر غير موجود" });
    if (status === "CONVERTED") throw new TRPCError({ code: "BAD_REQUEST", message: "التحويل يتم عبر «تحويل لفاتورة»" });
    const allowed = ALLOWED_TRANSITIONS[q.status as QuoteStatus] ?? [];
    if (!allowed.includes(status)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `انتقال غير مسموح: ${q.status} → ${status}` });
    }
    await tx.update(quotations).set({ status }).where(eq(quotations.id, quotationId));
    return { quotationId, status };
  });
}

export interface ConvertQuotationInput {
  quotationId: number;
  payment?: { amount: string; method: PaymentMethod } | null;
}

/** يحوّل عرض السعر إلى فاتورة فعلية (بيع كامل: مخزون + دفتر) مرة واحدة فقط. */
export async function convertQuotation(input: ConvertQuotationInput, actor: Actor) {
  // اقرأ العرض وبنوده خارج معاملة البيع (createSale يفتح معاملته الخاصة).
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB غير متاحة" });
  const q = (await db.select().from(quotations).where(eq(quotations.id, input.quotationId)).limit(1))[0];
  if (!q) throw new TRPCError({ code: "NOT_FOUND", message: "عرض السعر غير موجود" });

  // idempotency: عرض مُحوَّل مسبقاً يُعيد الفاتورة نفسها.
  if (q.status === "CONVERTED" && q.convertedInvoiceId) {
    const inv = (await db.select().from(quotations).where(eq(quotations.id, input.quotationId)).limit(1))[0];
    return { quotationId: input.quotationId, invoiceId: Number(q.convertedInvoiceId), alreadyConverted: true, status: inv.status };
  }
  if (q.status === "REJECTED" || q.status === "EXPIRED") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن تحويل عرض مرفوض أو منتهٍ" });
  }
  if (q.validUntil && toDateStr(new Date(q.validUntil as any)) < toDateStr()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "عرض السعر منتهي الصلاحية" });
  }

  const items = await db.select().from(quotationItems).where(eq(quotationItems.quotationId, input.quotationId));
  if (!items.length) throw new TRPCError({ code: "BAD_REQUEST", message: "عرض السعر بلا بنود" });

  // أنشئ بيعاً يحفظ الأسعار المعروضة كما هي (unitPriceOverride). ORDER يسمح بالآجل مع عميل.
  const sale = await createSale(
    {
      branchId: Number(q.branchId),
      customerId: q.customerId ? Number(q.customerId) : null,
      priceTier: q.priceTier as PriceTier,
      sourceType: "ORDER",
      clientRequestId: `QUO-${q.id}`,
      lines: items.map((it) => ({
        variantId: Number(it.variantId),
        productUnitId: Number(it.productUnitId),
        quantity: it.quantity,
        unitPriceOverride: it.unitPrice,
      })),
      payment: input.payment ?? null,
      notes: `محوّل من عرض السعر ${q.quoteNumber}`,
    },
    actor
  );

  // اربط الفاتورة وعلّم الحالة CONVERTED (خارج معاملة البيع — قيد منفصل).
  await db
    .update(quotations)
    .set({ status: "CONVERTED", convertedInvoiceId: sale.invoiceId })
    .where(eq(quotations.id, input.quotationId));

  return { quotationId: input.quotationId, invoiceId: sale.invoiceId, invoiceNumber: sale.invoiceNumber, status: sale.status, alreadyConverted: false };
}

/* ============================ قراءة ============================ */

export async function listQuotations(limit = 100) {
  const db = getDb();
  if (!db) return [];
  return db
    .select({
      id: quotations.id,
      quoteNumber: quotations.quoteNumber,
      quoteDate: quotations.quoteDate,
      validUntil: quotations.validUntil,
      total: quotations.total,
      status: quotations.status,
      convertedInvoiceId: quotations.convertedInvoiceId,
      customerName: customers.name,
    })
    .from(quotations)
    .leftJoin(customers, eq(quotations.customerId, customers.id))
    .orderBy(desc(quotations.id))
    .limit(limit);
}

export async function getQuotation(quotationId: number) {
  const db = getDb();
  if (!db) return null;
  const q = (
    await db
      .select({
        id: quotations.id,
        quoteNumber: quotations.quoteNumber,
        branchId: quotations.branchId,
        customerId: quotations.customerId,
        customerName: customers.name,
        priceTier: quotations.priceTier,
        quoteDate: quotations.quoteDate,
        validUntil: quotations.validUntil,
        subtotal: quotations.subtotal,
        taxAmount: quotations.taxAmount,
        discountAmount: quotations.discountAmount,
        total: quotations.total,
        status: quotations.status,
        convertedInvoiceId: quotations.convertedInvoiceId,
        notes: quotations.notes,
      })
      .from(quotations)
      .leftJoin(customers, eq(quotations.customerId, customers.id))
      .where(eq(quotations.id, quotationId))
      .limit(1)
  )[0];
  if (!q) return null;
  const items = await db
    .select({
      id: quotationItems.id,
      variantId: quotationItems.variantId,
      productUnitId: quotationItems.productUnitId,
      quantity: quotationItems.quantity,
      baseQuantity: quotationItems.baseQuantity,
      unitPrice: quotationItems.unitPrice,
      discountAmount: quotationItems.discountAmount,
      total: quotationItems.total,
      productName: products.name,
      sku: productVariants.sku,
      variantName: productVariants.variantName,
      unitName: productUnits.unitName,
    })
    .from(quotationItems)
    .leftJoin(productVariants, eq(quotationItems.variantId, productVariants.id))
    .leftJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(productUnits, eq(quotationItems.productUnitId, productUnits.id))
    .where(eq(quotationItems.quotationId, quotationId));
  return { ...q, items };
}
