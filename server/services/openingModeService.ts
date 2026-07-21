// خدمة «وضع الافتتاح» المؤقّت (الافتتاح التدريجي، ١٨/٧) — صفّ singleton واحد (id=1) بنمط taxSettings.
//
// الغاية: أثناء إدخال النظام للخدمة (كتالوج كامل برصيد صفر) يُسمح ببيع الصنف **غير المُفتتَح**
// (branchStock.openedAt IS NULL) بالسالب نقدياً حتى يُجرَد جرداً افتتاحياً يثبّت رصيده الحقيقي.
//
// حوكمة صلبة (مراجعة عدائية ١٨/٧):
//   - التفعيل يشترط endsAt إلزامياً (نافذة بلا سقف = باب دائم)، بحدّ أقصى ٦٠ يوماً من لحظة التفعيل.
//   - النافذة «فعّالة» = enabled && endsAt موجود && الآن < endsAt — انقضاء endsAt يطفئها حكماً بلا تدخل.
//   - القراءة get-or-default (لا تكتب شيئاً): تُستدعى من مسار البيع الحرج، ومسار قراءة لا يُفاجئ بكتابة.
//   - حدود اليوم وفق إطار businessDay (اليوم التجاري = يوم UTC): endsAtYmd يُفسَّر نهاية يومه UTC
//     (حدّ حصري عبر Date.UTC) — لا تفسير YMD بالمنطقة المحلية (علّة انزياح بغداد الموثَّقة).
import { TRPCError } from "@trpc/server";
import { and, count, eq, isNotNull, sql } from "drizzle-orm";
import { branchStock, branches, openingModeSettings, products, productVariants } from "../../drizzle/schema";
import { requireDb, withTx } from "./tx";

const DAY_MS = 86_400_000;
const MAX_WINDOW_DAYS = 60;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface OpeningModeView {
  enabled: boolean;
  /** ISO — الحدّ الحصري لنهاية النافذة (نهاية اليوم المُدخل بتوقيت UTC). null = لم يُضبط. */
  endsAt: string | null;
  /** آخر يوم **مشمول** بالنافذة (YYYY-MM-DD) — للعرض/التحرير في الواجهة بلا انزياح يوم عند إعادة الحفظ. */
  endsAtYmd: string | null;
  maxNegativeQtyPerLine: number;
  /** محسوبة لحظة القراءة: النافذة فعّالة الآن فعلاً (enabled && الآن < endsAt). */
  active: boolean;
  updatedBy: number | null;
  updatedAt: string | null;
}

const DEFAULTS: Omit<OpeningModeView, "active"> = {
  enabled: false,
  endsAt: null,
  endsAtYmd: null,
  maxNegativeQtyPerLine: 100,
  updatedBy: null,
  updatedAt: null,
};

function computeActive(enabled: boolean, endsAt: Date | null, now: Date): boolean {
  return enabled && endsAt != null && now.getTime() < endsAt.getTime();
}

function toView(row: typeof openingModeSettings.$inferSelect | undefined, now = new Date()): OpeningModeView {
  if (!row) return { ...DEFAULTS, active: false };
  return {
    enabled: row.enabled,
    endsAt: row.endsAt ? row.endsAt.toISOString() : null,
    // endsAt حدّ حصري (اليوم التالي 00:00 UTC) ⇒ آخر يوم مشمول = endsAt − يوم واحد.
    endsAtYmd: row.endsAt ? new Date(row.endsAt.getTime() - DAY_MS).toISOString().slice(0, 10) : null,
    maxNegativeQtyPerLine: row.maxNegativeQtyPerLine,
    active: computeActive(row.enabled, row.endsAt ?? null, now),
    updatedBy: row.updatedBy ?? null,
    updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

/** يقرأ إعدادات وضع الافتتاح (get-or-default — لا يكتب شيئاً في مسار القراءة). */
export async function getOpeningMode(): Promise<OpeningModeView> {
  const db = requireDb();
  const rows = await db.select().from(openingModeSettings).where(eq(openingModeSettings.id, 1)).limit(1);
  return toView(rows[0]);
}

/** فحص الفعالية للاستهلاك الخادمي (حارس البيع/الجرد الافتتاحي). يقبل tx اختيارياً ليُقرأ داخل معاملة. */
export async function isOpeningWindowActive(
  tx?: { select: typeof requireDb extends () => infer D ? D extends { select: infer S } ? S : never : never },
): Promise<{ active: boolean; settings: OpeningModeView }> {
  const runner = (tx ?? requireDb()) as ReturnType<typeof requireDb>;
  const rows = await runner.select().from(openingModeSettings).where(eq(openingModeSettings.id, 1)).limit(1);
  const view = toView(rows[0]);
  return { active: view.active, settings: view };
}

export interface UpdateOpeningModeInput {
  enabled: boolean;
  /** نهاية النافذة بصيغة YYYY-MM-DD — إلزامي عند التفعيل؛ يُفسَّر «حتى نهاية هذا اليوم UTC». */
  endsAtYmd?: string | null;
  maxNegativeQtyPerLine?: number;
}

/** يفسّر YMD نهايةَ يومه UTC (حدّاً حصرياً) وفق إطار businessDay — Date.UTC حصراً، لا مكوّنات محلية. */
function ymdToExclusiveEndUtc(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + DAY_MS);
}

export interface UpdateOpeningModeResult {
  before: OpeningModeView;
  after: OpeningModeView;
}

/** يحدّث وضع الافتتاح (admin فقط — تُفرَض في الراوتر). يعيد قبل/بعد لتسجيل حدث التدقيق كاملاً. */
export async function updateOpeningMode(
  input: UpdateOpeningModeInput,
  actor: { userId: number },
): Promise<UpdateOpeningModeResult> {
  const now = new Date();
  let endsAt: Date | null = null;

  if (input.enabled) {
    if (!input.endsAtYmd) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "تفعيل وضع الافتتاح يتطلّب تاريخ انتهاء صريحاً — نافذة بلا سقف زمني مرفوضة",
      });
    }
    if (!YMD_RE.test(input.endsAtYmd)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "صيغة تاريخ الانتهاء غير صالحة (YYYY-MM-DD)" });
    }
    endsAt = ymdToExclusiveEndUtc(input.endsAtYmd);
    if (endsAt.getTime() <= now.getTime()) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "تاريخ انتهاء النافذة يجب أن يكون اليوم أو مستقبلاً" });
    }
    if (endsAt.getTime() > now.getTime() + MAX_WINDOW_DAYS * DAY_MS) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `نافذة الافتتاح لا تتجاوز ${MAX_WINDOW_DAYS} يوماً — مدّدها لاحقاً عند الحاجة (فعل مُدقَّق)`,
      });
    }
  } else if (input.endsAtYmd) {
    // إطفاء مع تاريخ: نتجاهل التاريخ ونصفّره — الوضع المطفأ بلا نافذة.
    endsAt = null;
  }

  const maxQty = input.maxNegativeQtyPerLine ?? DEFAULTS.maxNegativeQtyPerLine;
  if (!Number.isInteger(maxQty) || maxQty < 1 || maxQty > 10_000) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "سقف كمية السطر السالب يجب أن يكون عدداً صحيحاً بين 1 و10000" });
  }

  return withTx(async (tx) => {
    const beforeRows = await tx.select().from(openingModeSettings).where(eq(openingModeSettings.id, 1)).limit(1);
    const before = toView(beforeRows[0], now);

    // ensure-row ثم تحديث (نمط taxSettings) — يعمل حتى لو لم تُقرأ الإعدادات من قبل.
    await tx
      .insert(openingModeSettings)
      .values({ id: 1, enabled: false, endsAt: null, maxNegativeQtyPerLine: DEFAULTS.maxNegativeQtyPerLine })
      .onDuplicateKeyUpdate({ set: { id: 1 } });

    await tx
      .update(openingModeSettings)
      .set({ enabled: input.enabled, endsAt, maxNegativeQtyPerLine: maxQty, updatedBy: actor.userId })
      .where(eq(openingModeSettings.id, 1));

    const rows = await tx.select().from(openingModeSettings).where(eq(openingModeSettings.id, 1)).limit(1);
    if (!rows[0]) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر تحديث إعدادات وضع الافتتاح" });
    }
    return { before, after: toView(rows[0], now) };
  });
}

export interface OpeningProgressBranch {
  branchId: number;
  branchName: string;
  /** إجمالي المتغيّرات الفعّالة الخاضعة للافتتاح (غير خدمية/غير بكج/منتج فعّال). */
  totalVariants: number;
  /** المُفتتَح منها في هذا الفرع (branchStock.openedAt IS NOT NULL). */
  openedVariants: number;
}

/** مؤشر تقدّم الافتتاح «X من Y مُفتتَح» لكل فرع.
 *  ⚠️ فخّ محسوب له (مراجعة ١٨/٧): الصنف الذي لم يُبَع قط لا يملك صفّ branchStock أصلاً —
 *  الإجمالي يُحسب من productVariants (LEFT JOIN) لا من branchStock وإلا أُقصي غير المُفتتَحين الحقيقيون. */
export async function getOpeningProgress(): Promise<OpeningProgressBranch[]> {
  const db = requireDb();

  const eligible = await db
    .select({ total: count() })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(
      and(
        eq(products.isService, false),
        eq(products.isBundle, false),
        // بضاعة الأمانة (ش٤): تُفتتَح بسند إيداع لا بجرد افتتاحيّ ⇒ خارج مؤشر «افتتاح الكتالوج المملوك»
        // (بسطاً ومقاماً) وإلا لن يبلغ ١٠٠٪ أبداً (صنف الأمانة بلا رصيد لا «يُفتتَح» بالجرد). §٥-د.
        eq(products.isConsignment, false),
        eq(products.isActive, true),
        sql`${productVariants.isActive} IS NOT FALSE`,
      ),
    );
  const totalVariants = Number(eligible[0]?.total ?? 0);

  const branchRows = await db
    .select({ id: branches.id, name: branches.name })
    .from(branches)
    .where(sql`${branches.isActive} IS NOT FALSE`);

  const openedRows = await db
    .select({ branchId: branchStock.branchId, opened: count() })
    .from(branchStock)
    .innerJoin(productVariants, eq(branchStock.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(
      and(
        isNotNull(branchStock.openedAt),
        eq(products.isService, false),
        eq(products.isBundle, false),
        eq(products.isConsignment, false), // مطابقة المقام: الأمانة خارج المؤشر بسطاً ومقاماً (§٥-د).
        eq(products.isActive, true),
        sql`${productVariants.isActive} IS NOT FALSE`,
      ),
    )
    .groupBy(branchStock.branchId);

  const openedBy = new Map(openedRows.map((r) => [Number(r.branchId), Number(r.opened)]));
  return branchRows.map((b) => ({
    branchId: Number(b.id),
    branchName: b.name,
    totalVariants,
    openedVariants: openedBy.get(Number(b.id)) ?? 0,
  }));
}
