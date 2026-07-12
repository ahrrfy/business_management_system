/**
 * storePromotionService — «العروض» في لوحة hPanel: عروض/خصومات المتجر الإلكتروني.
 *
 * يعيد استخدام محرّك العروض v2 (salesPromotionService) بلا ازدواج منطق: العرض المتجريّ = عرضٌ
 * على **فرع المتجر** بفئة **RETAIL** (زبائن المتجر مفرد) ⇒ يظهر تلقائياً في `storefrontOffers`
 * ويُطبَّق على أسعار الكتالوج عبر `applyStorefrontPromotions` (نفس نافذة اليوم المحلي ببغداد).
 *
 * أمان (منع IDOR عبر القنوات): المدير من لوحة المتجر يُنشئ عروضاً متجرية فقط، ولا يُعطّل إلا
 * العروض المملوكة للمتجر (branch=فرع المتجر ∧ tier=RETAIL) — لا يمسّ عروض الكاشير/الجملة/العامّة
 * وإن ظهرت في القائمة (تُعرض للسياق فقط، بعلامة «عامّ» وبلا زرّ تعطيل).
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { promotionTargets, promotions } from "../../../drizzle/schema";
import { getDb, type Tx } from "../../db";
import { createPromotion, deactivatePromotion, type CreatePromotionInput } from "../salesPromotionService";

const RETAIL = "RETAIL" as const;

/** يُطبّع عمود DATE (قد يعود Date أو نصّاً) إلى YYYY-MM-DD بمكوّنات UTC (DATE بلا زمن ⇒ لا انزلاق). */
function toYmd(v: unknown): string {
  if (v instanceof Date) {
    return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, "0")}-${String(v.getUTCDate()).padStart(2, "0")}`;
  }
  return String(v).slice(0, 10);
}

export interface StorePromotionRow {
  id: number;
  name: string;
  description: string | null;
  type: "PERCENT" | "AMOUNT";
  discountPercent: string;
  discountAmount: string;
  scope: "ALL" | "CATEGORIES" | "PRODUCTS";
  effectiveFrom: string; // YYYY-MM-DD
  effectiveTo: string | null;
  minLineAmount: string;
  priority: number;
  isActive: boolean;
  /** نشِطٌ وضمن نافذة التاريخ اليوم ⇒ ظاهرٌ فعلاً للزبائن الآن. */
  liveNow: boolean;
  /** مملوكٌ للمتجر (فرع المتجر ∧ RETAIL) ⇒ قابلٌ للتعطيل من هنا. غيرُه = «عامّ» للعرض فقط. */
  storeOwned: boolean;
  targetCount: number;
}

/** العروض ذات الصلة بالمتجر: فرع المتجر (أو عامّ NULL) وفئة RETAIL (أو كل الفئات NULL). */
export async function listStorePromotions(input: {
  branchId: number;
  includeInactive?: boolean;
  todayYmd: string;
}): Promise<StorePromotionRow[]> {
  const db = getDb();
  if (!db) return [];
  const conds = [
    or(isNull(promotions.branchId), eq(promotions.branchId, input.branchId))!,
    or(isNull(promotions.customerTier), eq(promotions.customerTier, RETAIL))!,
  ];
  if (!input.includeInactive) conds.push(eq(promotions.isActive, true));

  const rows = await db
    .select()
    .from(promotions)
    .where(and(...conds))
    .orderBy(desc(promotions.priority), desc(promotions.id));

  const ids = rows.map((r) => Number(r.id));
  const tgts = ids.length
    ? await db.select({ promotionId: promotionTargets.promotionId }).from(promotionTargets).where(inArray(promotionTargets.promotionId, ids))
    : [];
  const countByPromo = new Map<number, number>();
  for (const t of tgts) {
    const pid = Number(t.promotionId);
    countByPromo.set(pid, (countByPromo.get(pid) ?? 0) + 1);
  }

  return rows.map((r) => {
    const from = toYmd(r.effectiveFrom);
    const to = r.effectiveTo == null ? null : toYmd(r.effectiveTo);
    const isActive = !!r.isActive;
    return {
      id: Number(r.id),
      name: r.name,
      description: r.description ?? null,
      type: r.type as "PERCENT" | "AMOUNT",
      discountPercent: String(r.discountPercent ?? "0"),
      discountAmount: String(r.discountAmount ?? "0"),
      scope: r.scope as "ALL" | "CATEGORIES" | "PRODUCTS",
      effectiveFrom: from,
      effectiveTo: to,
      minLineAmount: String(r.minLineAmount ?? "0"),
      priority: Number(r.priority ?? 0),
      isActive,
      liveNow: isActive && from <= input.todayYmd && (to == null || to >= input.todayYmd),
      // 0073: الملكية بعلامة القناة الصريحة (isStoreManaged) لا بـbranch+tier — لأن عرض كاشير
      // RETAIL@فرع-المتجر يتطابق مع عرض المتجر في هذين، فيتعذّر التمييز بهما (مراجعة عدائية ١٣/٧).
      storeOwned: !!r.isStoreManaged,
      targetCount: countByPromo.get(Number(r.id)) ?? 0,
    };
  });
}

/** إنشاء عرض متجريّ: يفرض RETAIL + فرع المتجر + isStoreManaged (أونلاين فقط، يظهر في المتجر). */
export async function createStorePromotion(
  tx: Tx,
  input: Omit<CreatePromotionInput, "customerTier" | "branchId" | "isStoreManaged">,
  actorUserId: number,
  storeBranchId: number,
): Promise<number> {
  return createPromotion(tx, { ...input, customerTier: RETAIL, branchId: storeBranchId, isStoreManaged: true }, actorUserId);
}

/** تعطيل عرضٍ متجريّ — يرفض ما ليس عرضَ متجرٍ (isStoreManaged) منعاً لتعطيل عروض الكاشير/الإدارة عبر القناة. */
export async function deactivateStorePromotion(tx: Tx, promotionId: number): Promise<void> {
  const p = (
    await tx
      .select({ id: promotions.id, isStoreManaged: promotions.isStoreManaged })
      .from(promotions)
      .where(eq(promotions.id, promotionId))
      .limit(1)
  )[0];
  if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "العرض غير موجود" });
  if (!p.isStoreManaged) throw new TRPCError({ code: "FORBIDDEN", message: "هذا العرض ليس من عروض المتجر — يُدار من الإدارة" });
  await deactivatePromotion(tx, promotionId);
}
