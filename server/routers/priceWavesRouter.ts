// price-waves router (٧/٧/٢٦، وُسّع ٢٠/٨/٢٦): موجات تحديث الأسعار — عدّ نطاق + معاينة + تطبيق + تاريخ + تراجع.
// RBAC: managerProcedure حصراً (يكشف التكلفة + يعدّل أسعاراً جماعياً).
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { priceChangeLog } from "../../drizzle/schema";
import {
  MAX_PERCENT_VALUE,
  PRICE_ROUND_DENOMS,
} from "../../shared/priceWaveRule";
import { logAudit } from "../services/auditService";
import {
  applyPriceWave,
  countPriceWaveScope,
  enrichPriceHistoryMetadata,
  enrichLogRows,
  findRevertedWaveIds,
  getPriceUnitHistory,
  listPriceWaves,
  previewPriceWave,
  revertPriceWave,
} from "../services/priceWaveService";
import { withTx } from "../services/tx";
import { productsManagerProcedure, router } from "../trpc";

const tierSchema = z.enum(["RETAIL", "WHOLESALE", "GOVERNMENT"]);

/**
 * النطاق جزءٌ من العقد لا اشتقاقٌ من فراغ الفلاتر — الخدمة تفرض تماسكه (W6).
 *
 * ⚠️ **`scope` اختياريٌّ في العقد وإلزاميٌّ في الخدمة، عمداً.** تطبيق أندرويد «سوبر العربية»
 * المنشور على Internal testing يبني `filters` بـ`productSearch`/`priceTier` فقط
 * (`ProductsRepository.kt`)، فجعلُ الحقل إلزامياً هنا كان **يُسقط مسار موجات الأسعار كلّه**
 * في نسخةٍ لا نملك تحديثها فوراً (يلزمها رفع versionCode وبناء AAB ورفعٌ يدويّ إلى Play).
 * ⇒ الطلب الذي يصل بلا `scope` يُشتقّ له واحدٌ **صريح** أدناه، ثمّ تسري عليه حرّاس الخدمة نفسها.
 * الاشتقاق آمنٌ الآن لأنّ جذر الخطر زال: لم يعد أيّ فلترٍ يسقط بصمت (ع١)، فغيابُ الفلاتر
 * صار يعني «الكل» **حقيقةً** لا نتيجةَ مصطلحٍ ابتلعه الخادم.
 */
const filtersSchema = z
  .object({
    scope: z.enum(["FILTERED", "SELECTED", "ALL"]).optional(),
    categoryId: z.number().int().positive().nullish(),
    productSearch: z.string().max(120).nullish(),
    priceTier: tierSchema.nullish(),
    productIds: z.array(z.number().int().positive()).max(500).nullish(),
  })
  .transform((f) => {
    if (f.scope) return { ...f, scope: f.scope };
    const hasIds = !!f.productIds?.length;
    const hasFilter =
      !!f.productSearch?.trim() ||
      (f.categoryId != null && f.categoryId > 0) ||
      !!f.priceTier;
    const derived = hasIds ? "SELECTED" : hasFilter ? "FILTERED" : "ALL";
    return { ...f, scope: derived as "FILTERED" | "SELECTED" | "ALL" };
  });

const changeTypeSchema = z.enum([
  "INCREASE_PERCENT",
  "DECREASE_PERCENT",
  "INCREASE_AMOUNT",
  "DECREASE_AMOUNT",
  "SET_MARGIN",
]);
const changeValueSchema = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, "قيمة تغيير غير صالحة");
const roundToDenomSchema = z
  .number()
  .int()
  .refine(
    (v) => (PRICE_ROUND_DENOMS as readonly number[]).includes(v),
    "وحدة تقريب غير مدعومة",
  )
  .nullish();

const ruleSchema = {
  filters: filtersSchema,
  changeType: changeTypeSchema,
  changeValue: changeValueSchema,
  roundToDenom: roundToDenomSchema,
};

const rowKeySchema = z.object({
  productUnitId: z.number().int().positive(),
  priceTier: tierSchema,
});

export const priceWavesRouter = router({
  /** عدّاد النطاق الحيّ — يُغذّي شارة «كم منتجاً/سعراً سيتأثّر» أثناء الكتابة في خطوة النطاق.
   *  query (لا mutation): نتيجةٌ قابلة للتخزين المؤقّت ولا أثر لها، وتُستدعى مع كل حرف. */
  scopeCount: productsManagerProcedure
    .input(z.object({ filters: filtersSchema }))
    .query(async ({ input }) =>
      withTx((tx) => countPriceWaveScope(tx, input.filters)),
    ),

  /** معاينة الموجة قبل الالتزام — الصفوف المتأثّرة + **الساقطة بأسبابها** + بصمة المجموعة.
   *  mutation لا query: لا تخزين مؤقّت (كل معاينة حسابٌ لحظيّ، والفلاتر متغيّرة كثيراً). */
  preview: productsManagerProcedure
    .input(z.object(ruleSchema))
    .mutation(async ({ input }) => {
      const { rows, skipped, fingerprint } = await withTx((tx) =>
        previewPriceWave(tx, input),
      );
      return {
        rows,
        skipped,
        fingerprint,
        totalRows: rows.length,
        belowCostCount: rows.filter((r) => r.belowCost).length,
        roundedCount: rows.filter((r) => r.rounded).length,
        productCount: new Set(rows.map((r) => r.productId)).size,
      };
    }),

  /** تطبيق الموجة ذرّياً — يُنشئ رأس + سجلّ + يحدّث productPrices.
   *  NOTE: التسمية `applyWave` بدل `apply` لأنّ الأخيرة كلمة محجوزة في tRPC (تعارض مع Function.prototype.apply). */
  applyWave: productsManagerProcedure
    .input(
      z.object({
        ...ruleSchema,
        name: z.string().min(1).max(255),
        description: z.string().max(2000).nullish(),
        reason: z.string().max(255).nullish(),
        allowBelowCost: z.boolean().optional(),
        /** W7 — بصمة المعاينة التي أقرّها المدير؛ الشاشة تُرسلها دائماً. */
        expectedFingerprint: z.string().max(64).nullish(),
        excluded: z.array(rowKeySchema).max(5000).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const res = await withTx((tx) => applyPriceWave(tx, input, ctx.user.id));
      await logAudit(ctx, {
        action: "priceWave.apply",
        entityType: "priceWave",
        entityId: res.waveId,
        newValue: {
          name: input.name,
          scope: input.filters.scope,
          changeType: input.changeType,
          changeValue: input.changeValue,
          roundToDenom: input.roundToDenom ?? 0,
          totalRows: res.totalRows,
          excludedRows: res.excludedRows,
          skippedRows: res.skippedRows,
        },
      });
      return res;
    }),

  /** التراجع عن موجة — استعادة `oldPrice` المسجَّل صفّاً صفّاً (لا «موجة عكسية» بنسبة مقلوبة). */
  revert: productsManagerProcedure
    .input(
      z.object({
        waveId: z.number().int().positive(),
        /** يستعيد الصفوف غير المتعارضة ويترك ما تغيّر بعد الموجة — بعد إقرار المدير بالتعارض. */
        force: z.boolean().optional(),
        /** إقرارٌ صريح بأنّ سعراً مُستعاداً صار تحت تكلفة وحدته الحاليّة (ارتفعت التكلفة بعد الموجة). */
        allowBelowCost: z.boolean().optional(),
        reason: z.string().max(255).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const res = await withTx((tx) =>
        revertPriceWave(tx, input.waveId, ctx.user.id, {
          force: input.force,
          allowBelowCost: input.allowBelowCost,
          reason: input.reason,
        }),
      );
      await logAudit(ctx, {
        action: "priceWave.revert",
        entityType: "priceWave",
        entityId: res.waveId,
        newValue: {
          revertsWaveId: input.waveId,
          restoredRows: res.restoredRows,
          conflicts: res.conflicts.length,
          forced: !!input.force,
        },
      });
      return res;
    }),

  /** قائمة الموجات المطبَّقة (الأحدث أولاً) + وسم «مُتراجَعٌ عنها» بضمّةٍ واحدة. */
  list: productsManagerProcedure
    .input(
      z
        .object({ limit: z.number().int().positive().max(200).default(50) })
        .optional(),
    )
    .query(async ({ input }) => {
      return withTx(async (tx) => {
        const rows = await listPriceWaves(tx, input?.limit ?? 50);
        const reverted = await findRevertedWaveIds(
          tx,
          rows.map((r) => Number(r.id)),
        );
        return rows.map((r) => ({
          ...r,
          id: Number(r.id),
          appliedBy: Number(r.appliedBy),
          revertsWaveId:
            r.revertsWaveId == null ? null : Number(r.revertsWaveId),
          isReverted: reverted.has(Number(r.id)),
        }));
      });
    }),

  /** تاريخ تغييرات سعر وحدة معيّنة (لعرضه في شاشة تعديل المنتج للمدير). */
  unitHistory: productsManagerProcedure
    .input(
      z.object({
        productUnitId: z.number().int().positive(),
        limit: z.number().int().positive().max(200).default(50),
      }),
    )
    .query(async ({ input }) => {
      const rows = await withTx((tx) =>
        getPriceUnitHistory(tx, input.productUnitId, input.limit),
      );
      const [enrichment, metadata] = await withTx(async (tx) => {
        const unitMetadata = await enrichLogRows(
          tx,
          rows.map((r) => ({ productUnitId: Number(r.productUnitId) })),
        );
        const historyMetadata = await enrichPriceHistoryMetadata(
          tx,
          rows.map((r) => ({
            actorUserId: Number(r.actorUserId),
            waveId: r.waveId == null ? null : Number(r.waveId),
          })),
        );
        return [unitMetadata, historyMetadata] as const;
      });
      return rows.map((r) => ({
        ...r,
        id: Number(r.id),
        productUnitId: Number(r.productUnitId),
        waveId: r.waveId == null ? null : Number(r.waveId),
        actorUserId: Number(r.actorUserId),
        productName:
          enrichment.get(Number(r.productUnitId))?.productName ?? null,
        unitName: enrichment.get(Number(r.productUnitId))?.unitName ?? null,
        actorName: metadata.actors.get(Number(r.actorUserId)) ?? null,
        waveName:
          r.waveId == null
            ? null
            : (metadata.waves.get(Number(r.waveId)) ?? null),
      }));
    }),

  /** تفاصيل صفوف موجة مطبَّقة — كل priceChangeLog بهذا waveId مُثرًى بأسماء المنتج/الوحدة/SKU
   *  (البيانات مخزَّنة أصلاً منذ التطبيق عبر `priceChangeLog.waveId`). */
  waveDetails: productsManagerProcedure
    .input(z.object({ waveId: z.number().int().positive() }))
    .query(async ({ input }) => {
      return withTx(async (tx) => {
        const rows = await tx
          .select()
          .from(priceChangeLog)
          .where(eq(priceChangeLog.waveId, input.waveId))
          .orderBy(
            asc(priceChangeLog.productUnitId),
            asc(priceChangeLog.priceTier),
          );
        const enrichment = await enrichLogRows(
          tx,
          rows.map((r) => ({ productUnitId: Number(r.productUnitId) })),
        );
        return rows.map((r) => ({
          ...r,
          id: Number(r.id),
          productUnitId: Number(r.productUnitId),
          waveId: r.waveId == null ? null : Number(r.waveId),
          actorUserId: Number(r.actorUserId),
          productName:
            enrichment.get(Number(r.productUnitId))?.productName ?? null,
          unitName: enrichment.get(Number(r.productUnitId))?.unitName ?? null,
          sku: enrichment.get(Number(r.productUnitId))?.sku ?? null,
        }));
      });
    }),
});
