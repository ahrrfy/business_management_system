/**
 * رؤى أسعار سطور فاتورة البيع — **حقائق فقط** (آخر المبيعات الفعليّة لعميلٍ لكل وحدة).
 * التقييم (أقل/أعلى/نفس السعر) في `@shared/priceAlerts` ليُعاد محلّياً مع كل تعديلِ سعرٍ بلا شبكة.
 *
 * قراراتٌ مقصودة (خطّة «تنبيهات الأسعار الذكية»، السؤال ١):
 *  • النطاق **على مستوى العميل عبر الشركة** للمستخدم غير المحصور: «بِعتَ هذا العميل بكذا» حقيقةُ علاقةٍ لا
 *    سرٌّ فرعيّ؛ لكنّ المحصور بفرعٍ/بموظّفٍ (`scope`) لا يرى إلا ضمن حدوده — لا نُلغي العزل (CLAUDE.md).
 *    تُعاد السعر والتاريخ ورقم الفاتورة
 *    وخصم السطر فقط — لا تكلفة ولا ذمّة ولا مبلغ فاتورة.
 *  • الاستبعاد: الفواتير الملغاة/المستبدَلة (`VOIDED_INVOICE_STATUSES` — بيعٌ لم يقع قطّ؛ ⛔ لا
 *    `DEAD` لأنّ المُرتجَع ما زال سعراً حقيقيّاً دفعه العميل)، وسطور الهدايا، وأسعار الصفر.
 *  • المقارنة بنفس وحدة الصفّ (productUnitId) فقط؛ التحويل بين الوحدات مرحلةٌ تالية.
 *
 * قراءةٌ فقط: لا كتابة ولا قفل ولا أثر على الدفتر/المخزون. الخدمة لا تقرأ `ctx` (قاعدة الطبقات) —
 * تستقبل مقبض القاعدة والمدخلات صريحةً.
 */
import Decimal from "decimal.js";
import { and, desc, eq, lte, ne, notInArray, or, sql } from "drizzle-orm";
import { VOIDED_INVOICE_STATUSES } from "@shared/invoiceStatus";
import type { SaleLineInsight, SaleRef } from "@shared/priceAlerts";
import { invoiceItems, invoices } from "../../../drizzle/schema";
import type { DB } from "../../db";

/** أقصى مراجعَ لكل (صنف × وحدة): يكفي لتجاوز مرجعٍ شاذّ واحد ولعرض آخر بيعتين للتحليل لاحقاً. */
export const MAX_SALE_REFS_PER_LINE = 3;


/**
 * خصم السطر الفعليّ كنسبة: السطر المخصوم بمبلغٍ يحمل `discountPercent = 0` و`discountAmount` = إجمالي
 * خصم السطر (كمّيّته × خصم الوحدة) — فيُشتقّ منه كنسبةٍ من إجمالي السطر الإجماليّ. بلا هذا يبدو بيعٌ مخصومٌ
 * «بلا خصم» فتُقارَن به أسعارٌ مختلفة جوهريّاً.
 */
function effectiveDiscountPercent(row: {
  unitPrice: string | number;
  quantity: string | number;
  discountPercent: string | number | null;
  discountAmount: string | number | null;
}): string {
  const pct = new Decimal(String(row.discountPercent ?? "0"));
  if (pct.gt(0)) return String(row.discountPercent);
  const amount = new Decimal(String(row.discountAmount ?? "0"));
  const gross = new Decimal(String(row.unitPrice)).times(new Decimal(String(row.quantity)));
  if (amount.lte(0) || gross.lte(0)) return "0";
  return Decimal.min(amount.dividedBy(gross).times(100), 100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toString();
}

/** مفتاح الصفّ في الواجهة والخادم: `${variantId}:${productUnitId}` (نفس مفتاح `purchases.priceInsights`). */
export const lineInsightKey = (variantId: number, productUnitId: number) => `${variantId}:${productUnitId}`;

export async function getSaleLineInsights(
  db: DB,
  input: {
    customerId: number;
    items: ReadonlyArray<{ variantId: number; productUnitId: number }>;
    /** فاتورةٌ قيد التصحيح: تُستثنى كي لا يُقارَن سعرها بنفسها («نفس آخر سعر» كاذبة) — ما زالت CONFIRMED حتى الحفظ. */
    excludeInvoiceId?: number;
    /** عزل المستدعي: فرعٌ و/أو موظّفٌ مُنشئ (الفارغ = غير محصور). مصدره `ctx.scopedBranchId/scopedOwnerId`. */
    scope?: { branchId?: number | null; ownerId?: number | null };
  },
): Promise<Record<string, SaleLineInsight>> {
  const unique = Array.from(
    new Map(input.items.map((i) => [lineInsightKey(i.variantId, i.productUnitId), i])).values(),
  );
  if (unique.length === 0) return {};

  const pairs = unique.map((i) =>
    and(eq(invoiceItems.variantId, i.variantId), eq(invoiceItems.productUnitId, i.productUnitId)),
  );

  // ترتيبٌ نافذيّ لكل (صنف × وحدة): الأحدث أولاً. يضمن ≤ MAX لكل وحدة مهما تكرّر شراء وحدةٍ أخرى
  // (استعلامُ LIMIT واحد كان سيُجوِّع الوحدات الأقلّ تكراراً). MySQL 8 يدعم النوافذ.
  const ranked = db
    .select({
      itemId: invoiceItems.id,
      rn: sql<number>`row_number() over (partition by ${invoiceItems.variantId}, ${invoiceItems.productUnitId} order by ${invoices.invoiceDate} desc, ${invoices.id} desc, ${invoiceItems.id} desc)`.as(
        "rn",
      ),
    })
    .from(invoiceItems)
    .innerJoin(invoices, eq(invoiceItems.invoiceId, invoices.id))
    .where(
      and(
        eq(invoices.customerId, input.customerId),
        input.excludeInvoiceId != null ? ne(invoices.id, input.excludeInvoiceId) : undefined,
        input.scope?.branchId ? eq(invoices.branchId, input.scope.branchId) : undefined,
        input.scope?.ownerId != null ? eq(invoices.createdBy, input.scope.ownerId) : undefined,
        notInArray(invoices.status, [...VOIDED_INVOICE_STATUSES]),
        eq(invoiceItems.isGift, false),
        sql`${invoiceItems.unitPrice} > 0`,
        or(...pairs),
      ),
    )
    .as("ranked");

  const rows = await db
    .select({
      variantId: invoiceItems.variantId,
      productUnitId: invoiceItems.productUnitId,
      unitPrice: invoiceItems.unitPrice,
      discountPercent: invoiceItems.discountPercent,
      discountAmount: invoiceItems.discountAmount,
      quantity: invoiceItems.quantity,
      invoiceId: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      invoiceDate: invoices.invoiceDate,
    })
    .from(ranked)
    .innerJoin(invoiceItems, eq(invoiceItems.id, ranked.itemId))
    .innerJoin(invoices, eq(invoiceItems.invoiceId, invoices.id))
    .where(lte(ranked.rn, MAX_SALE_REFS_PER_LINE))
    .orderBy(desc(invoices.invoiceDate), desc(invoices.id), desc(invoiceItems.id));

  const result: Record<string, SaleLineInsight> = {};
  for (const row of rows) {
    if (row.productUnitId == null) continue;
    const key = lineInsightKey(Number(row.variantId), Number(row.productUnitId));
    (result[key] ??= { lastSales: [] }).lastSales.push({
      invoiceId: Number(row.invoiceId),
      invoiceNumber: row.invoiceNumber,
      price: String(row.unitPrice),
      discountPercent: effectiveDiscountPercent(row),
      at: row.invoiceDate.toISOString(),
    });
  }
  return result;
}
