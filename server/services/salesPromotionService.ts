// promotions v2 (٨/٧/٢٦، بعد gstack-review PR #163): إدارة العروض + حلّ العرض في pos.ts.
//
// فلسفة v2: «نقطة العرض = نقطة الفرض» — pos.ts (`applyPromotions`) يستدعي `resolvePromotionForLine`
// كي يعرض للـPOS السعر المخصوم مباشرةً. sale/create.ts يتحقّق فقط (idempotent) أن الخصم المُرسَل
// من العميل يطابق الحلّ الخادمي — لا يعيد الحساب من الصفر. هذا يمنع B2 (فائض Z-report من عدم تطابق
// السعر المعروض مع السعر المُسجَّل خادمياً).
//
// الفوارق عن الإصدار المسحوب:
//   - B8: مقارنة التاريخ بحبيبة اليوم المحلي (localDayStart) لا datetime — «آخر يوم» يعمل والتشغيل
//     ليومٍ واحد يعمل. نستعمل `Y-M-D` string comparison لأن effectiveFrom/To نوعُهما DATE.
//   - B11: `minLineAmount` NOT NULL على مستوى المخطّط + الخدمة تُعامل NULL كصفر دفاعاً.
//   - Contract-price wins: الاستدعاء من pos.ts يمرّر hasContractPrice ⇒ نعود null فوراً.
//   - manager scoping للراوتر (في promotionsRouter): يفرض branchId من ctx للـnon-admin.
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { products, promotionTargets, promotions } from "../../drizzle/schema";
import type { Tx } from "../db";
import { extractInsertId } from "../lib/insertId";
import { money, toDbMoney } from "./money";
import type { PriceTier } from "./pricing";

export type SalesPromotionType = "PERCENT" | "AMOUNT";
export type SalesPromotionScope = "ALL" | "CATEGORIES" | "PRODUCTS";

export interface PromotionTargetInput {
  categoryId?: number | null;
  productId?: number | null;
  variantId?: number | null;
}

export interface CreatePromotionInput {
  campaignId?: number | null;
  name: string;
  description?: string | null;
  type: SalesPromotionType;
  discountPercent?: string;
  discountAmount?: string;
  scope: SalesPromotionScope;
  effectiveFrom: string; // YYYY-MM-DD
  effectiveTo?: string | null;
  customerTier?: PriceTier | null;
  branchId?: number | null;
  minLineAmount?: string;
  priority?: number;
  targets?: PromotionTargetInput[];
  /** 0073: true = عرض متجر إلكترونيّ (أونلاين فقط — يُستثنى من تسعير الكاشير). افتراضي false. */
  isStoreManaged?: boolean;
  /** AUTO يُحلّ تلقائياً؛ COUPON لا يدخل التسعير إلا بعد تحقق الكوبون داخل معاملة البيع. */
  applicationMode?: "AUTO" | "COUPON";
}

function assertShape(input: CreatePromotionInput) {
  if (input.type === "PERCENT") {
    const p = money(input.discountPercent ?? "0");
    if (!p.gt(0) || p.gt(100)) throw new TRPCError({ code: "BAD_REQUEST", message: "نسبة الخصم بين 0 و100 (حصريّاً > 0)" });
    if (input.discountAmount && money(input.discountAmount).gt(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "نوع النسبة لا يقبل مبلغاً ثابتاً" });
  } else if (input.type === "AMOUNT") {
    const a = money(input.discountAmount ?? "0");
    if (!a.gt(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "المبلغ الثابت يجب أن يكون أكبر من صفر" });
    if (input.discountPercent && money(input.discountPercent).gt(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "نوع المبلغ الثابت لا يقبل نسبة" });
  } else {
    throw new TRPCError({ code: "BAD_REQUEST", message: "نوع عرض غير معروف" });
  }
}

function assertDates(input: CreatePromotionInput) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom)) throw new TRPCError({ code: "BAD_REQUEST", message: "تاريخ البدء صيغته YYYY-MM-DD" });
  if (input.effectiveTo) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveTo)) throw new TRPCError({ code: "BAD_REQUEST", message: "تاريخ الانتهاء صيغته YYYY-MM-DD" });
    if (input.effectiveTo < input.effectiveFrom) throw new TRPCError({ code: "BAD_REQUEST", message: "تاريخ الانتهاء أقدم من البدء" });
  }
}

function assertTargets(input: CreatePromotionInput) {
  if (input.scope === "ALL") {
    if (input.targets && input.targets.length) throw new TRPCError({ code: "BAD_REQUEST", message: "نطاق ALL لا يقبل أهدافاً — احذف القائمة" });
    return;
  }
  const targets = input.targets ?? [];
  if (!targets.length) throw new TRPCError({ code: "BAD_REQUEST", message: "النطاق المحدّد يحتاج هدفاً واحداً على الأقلّ" });
  for (const t of targets) {
    const filled = [t.categoryId, t.productId, t.variantId].filter((v) => v != null && Number(v) > 0);
    if (filled.length !== 1) throw new TRPCError({ code: "BAD_REQUEST", message: "كل هدف يحتاج حبيبة واحدة صريحة: فئة أو منتج أو متغيّر" });
    if (input.scope === "CATEGORIES" && !t.categoryId) throw new TRPCError({ code: "BAD_REQUEST", message: "نطاق CATEGORIES يستقبل categoryId فقط" });
    if (input.scope === "PRODUCTS" && !(t.productId || t.variantId)) throw new TRPCError({ code: "BAD_REQUEST", message: "نطاق PRODUCTS يستقبل productId أو variantId" });
  }
}

export async function createPromotion(tx: Tx, input: CreatePromotionInput, actorUserId: number): Promise<number> {
  assertShape(input);
  assertDates(input);
  assertTargets(input);

  const res = await tx.insert(promotions).values({
    campaignId: input.campaignId ?? null,
    name: input.name.trim(),
    description: input.description?.trim() || null,
    type: input.type,
    discountPercent: toDbMoney(input.discountPercent ?? "0"),
    discountAmount: toDbMoney(input.discountAmount ?? "0"),
    scope: input.scope,
    effectiveFrom: new Date(input.effectiveFrom),
    effectiveTo: input.effectiveTo ? new Date(input.effectiveTo) : null,
    customerTier: input.customerTier ?? null,
    branchId: input.branchId ?? null,
    minLineAmount: toDbMoney(input.minLineAmount ?? "0"),
    priority: input.priority ?? 0,
    isActive: true,
    applicationMode: input.applicationMode ?? "AUTO",
    isStoreManaged: input.isStoreManaged ?? false,
    createdBy: actorUserId,
  });
  const promotionId = extractInsertId(res);

  const targets = input.targets ?? [];
  for (const t of targets) {
    await tx.insert(promotionTargets).values({
      promotionId,
      categoryId: t.categoryId ?? null,
      productId: t.productId ?? null,
      variantId: t.variantId ?? null,
    });
  }
  return promotionId;
}

export async function deactivatePromotion(tx: Tx, promotionId: number) {
  await tx.update(promotions).set({ isActive: false }).where(eq(promotions.id, promotionId));
}

export interface ResolvedPromotion {
  promotionId: number;
  promotionName: string;
  discountForUnit: string; // خصم لكل وحدة (بعد قصّه لسعر الوحدة عند الحاجة)
}

export interface ResolveLineInput {
  branchId: number;
  customerTier: PriceTier;
  productId: number;
  variantId: number;
  categoryId: number | null;
  unitPrice: string;
  lineAmount: string;
  hasContractPrice: boolean;
  /** تاريخ يوم البيع بصيغة YYYY-MM-DD (لا datetime) — يفرض حبيبة اليوم المحلي (B8). */
  todayYmd: string;
  /** 0073: هل تُدرَج عروض المتجر (isStoreManaged)؟ الكاشير=false (أونلاين فقط)، المتجر=true. افتراضي false. */
  includeStoreManaged?: boolean;
  /** داخلي: لحل عرض كوبون محدد من دون إدخاله في المنافسة التلقائية. */
  requiredApplicationMode?: "AUTO" | "COUPON";
  specificPromotionId?: number;
}

/**
 * حلّ العرض الأنسب على سطر بيع. يعود null لو لا عرض ينطبق.
 *
 * فلسفة v2 (B1+B8 من gstack):
 *  - `todayYmd` (YYYY-MM-DD) يمرَّر بدل `Date` object ⇒ مقارنة string-based مع DATE لا datetime.
 *    يفرض حبيبة اليوم المحلي: عرض «من ٢٠٢٦-٠٧-٠١ إلى ٢٠٢٦-٠٧-٠١» يعمل يومَه كاملاً (بلا 3h drift).
 *  - `hasContractPrice=true` ⇒ يعود null فوراً (السعر التعاقدي يفوز — قرار المالك).
 *  - أسبقية عند التعارض حتميّة: أعلى priority ⇒ أعلى discountForUnit ⇒ أصغر id.
 */
export async function resolvePromotionForLine(tx: Tx, input: ResolveLineInput): Promise<ResolvedPromotion | null> {
  if (input.hasContractPrice) return null;

  const unitPrice = money(input.unitPrice);
  const lineAmount = money(input.lineAmount);
  if (unitPrice.lte(0)) return null;

  // B8: نستعمل SQL DATE() casting كي يقارن DATE بـDATE (لا DATETIME) — MySQL يقارن DATE `x` >= DATETIME
  // بتحويل x إلى `x 00:00:00` ⇒ آخر يوم يفشل. `DATE(?)` يحافظ على المقارنة بحبيبة اليوم.
  const todayYmd = input.todayYmd;

  const candidates = await tx
    .select({
      id: promotions.id,
      name: promotions.name,
      type: promotions.type,
      discountPercent: promotions.discountPercent,
      discountAmount: promotions.discountAmount,
      scope: promotions.scope,
      priority: promotions.priority,
      customerTier: promotions.customerTier,
      branchId: promotions.branchId,
      minLineAmount: promotions.minLineAmount,
    })
    .from(promotions)
    .where(
      and(
        eq(promotions.isActive, true),
        eq(promotions.applicationMode, input.requiredApplicationMode ?? "AUTO"),
        input.specificPromotionId != null ? eq(promotions.id, input.specificPromotionId) : undefined,
        sql`${promotions.effectiveFrom} <= DATE(${todayYmd})`,
        or(isNull(promotions.effectiveTo), sql`${promotions.effectiveTo} >= DATE(${todayYmd})`)!,
        or(isNull(promotions.branchId), eq(promotions.branchId, input.branchId))!,
        or(isNull(promotions.customerTier), eq(promotions.customerTier, input.customerTier))!,
        // B11: minLineAmount NOT NULL على المخطّط، لكن نُعامل NULL كصفر دفاعاً لبيانات قديمة.
        lte(promotions.minLineAmount, toDbMoney(lineAmount)),
        // 0073: عروض المتجر (isStoreManaged) أونلاين فقط ⇒ يستثنيها الكاشير افتراضياً (منع خصمها بيعَ
        // الكاشير للمفرد على نفس الفرع+الفئة). المتجر يمرّر includeStoreManaged=true فيدرِجها.
        input.includeStoreManaged ? undefined : eq(promotions.isStoreManaged, false),
      ),
    );
  if (!candidates.length) return null;

  const nonAllIds = candidates.filter((c) => c.scope !== "ALL").map((c) => Number(c.id));
  const matchedTargetPromoIds = new Set<number>();
  if (nonAllIds.length) {
    const rows = await tx
      .select({
        promotionId: promotionTargets.promotionId,
        categoryId: promotionTargets.categoryId,
        productId: promotionTargets.productId,
        variantId: promotionTargets.variantId,
      })
      .from(promotionTargets)
      .where(inArray(promotionTargets.promotionId, nonAllIds));
    for (const t of rows) {
      const pid = Number(t.promotionId);
      const match =
        (t.variantId != null && Number(t.variantId) === input.variantId) ||
        (t.productId != null && Number(t.productId) === input.productId) ||
        (t.categoryId != null && input.categoryId != null && Number(t.categoryId) === input.categoryId);
      if (match) matchedTargetPromoIds.add(pid);
    }
  }

  interface Scored {
    id: number;
    name: string;
    priority: number;
    discountForUnit: Decimal;
  }
  const scored: Scored[] = [];
  for (const c of candidates) {
    if (c.scope !== "ALL" && !matchedTargetPromoIds.has(Number(c.id))) continue;
    let discount: Decimal;
    if (c.type === "PERCENT") {
      discount = unitPrice.mul(money(c.discountPercent)).dividedBy(100);
    } else {
      discount = money(c.discountAmount);
    }
    if (discount.gt(unitPrice)) discount = unitPrice; // قصّ لسعر الوحدة
    if (discount.lte(0)) continue;
    scored.push({ id: Number(c.id), name: c.name, priority: Number(c.priority ?? 0), discountForUnit: discount });
  }
  if (!scored.length) return null;

  scored.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    const cmp = b.discountForUnit.comparedTo(a.discountForUnit);
    if (cmp !== 0) return cmp;
    return a.id - b.id;
  });
  const win = scored[0];
  return { promotionId: win.id, promotionName: win.name, discountForUnit: toDbMoney(win.discountForUnit) };
}

export function resolveCouponPromotionForLine(tx: Tx, promotionId: number, input: ResolveLineInput) {
  return resolvePromotionForLine(tx, { ...input, requiredApplicationMode: "COUPON", specificPromotionId: promotionId });
}

export async function listPromotions(tx: Tx, includeInactive = false) {
  if (includeInactive) return tx.select().from(promotions);
  return tx.select().from(promotions).where(eq(promotions.isActive, true));
}

export async function getPromotionWithTargets(tx: Tx, promotionId: number) {
  const p = (await tx.select().from(promotions).where(eq(promotions.id, promotionId)).limit(1))[0];
  if (!p) return null;
  const targets = await tx.select().from(promotionTargets).where(eq(promotionTargets.promotionId, promotionId));
  return { promotion: p, targets };
}

export async function getProductCategoryIds(tx: Tx, productIds: number[]): Promise<Map<number, number | null>> {
  const map = new Map<number, number | null>();
  if (!productIds.length) return map;
  const rows = await tx
    .select({ id: products.id, categoryId: products.categoryId })
    .from(products)
    .where(inArray(products.id, Array.from(new Set(productIds))));
  for (const r of rows) map.set(Number(r.id), r.categoryId == null ? null : Number(r.categoryId));
  return map;
}
