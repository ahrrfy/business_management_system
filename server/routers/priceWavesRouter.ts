// price-waves router (٧/٧/٢٦): إدارة موجات تحديث الأسعار — معاينة + تطبيق + تاريخ.
// RBAC: managerProcedure حصراً (يكشف التكلفة + يعدّل أسعاراً جماعياً).
import { z } from "zod";
import { logAudit } from "../services/auditService";
import {
  applyPriceWave,
  enrichLogRows,
  getPriceUnitHistory,
  listPriceWaves,
  previewPriceWave,
} from "../services/priceWaveService";
import { withTx } from "../services/tx";
import { productsManagerProcedure, router } from "../trpc";

const filtersSchema = z.object({
  categoryId: z.number().int().positive().nullish(),
  productSearch: z.string().max(120).nullish(),
  priceTier: z.enum(["RETAIL", "WHOLESALE", "GOVERNMENT"]).nullish(),
});

const changeTypeSchema = z.enum([
  "INCREASE_PERCENT", "DECREASE_PERCENT",
  "INCREASE_AMOUNT", "DECREASE_AMOUNT",
  "SET_MARGIN",
]);
const changeValueSchema = z.string().regex(/^\d+(\.\d{1,2})?$/, "قيمة تغيير غير صالحة");

export const priceWavesRouter = router({
  /** معاينة الموجة قبل الالتزام — يُرجع الصفوف المتأثّرة (oldPrice, newPrice, belowCost).
   *  mutation لا query: لا تخزين مؤقّت (كل معاينة حسابٌ لحظيّ، والفلاتر متغيّرة كثيراً). */
  preview: productsManagerProcedure
    .input(
      z.object({
        filters: filtersSchema,
        changeType: changeTypeSchema,
        changeValue: changeValueSchema,
      }),
    )
    .mutation(async ({ input }) => {
      const rows = await withTx((tx) => previewPriceWave(tx, input));
      return {
        rows,
        totalRows: rows.length,
        belowCostCount: rows.filter((r) => r.belowCost).length,
      };
    }),

  /** تطبيق الموجة ذرّياً — يُنشئ رأس + سجلّ + يحدّث productPrices.
   *  NOTE: التسمية `applyWave` بدل `apply` لأنّ الأخيرة كلمة محجوزة في tRPC (تعارض مع Function.prototype.apply). */
  applyWave: productsManagerProcedure
    .input(
      z.object({
        name: z.string().min(1).max(255),
        description: z.string().max(2000).nullish(),
        reason: z.string().max(255).nullish(),
        filters: filtersSchema,
        changeType: changeTypeSchema,
        changeValue: changeValueSchema,
        allowBelowCost: z.boolean().optional(),
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
          changeType: input.changeType,
          changeValue: input.changeValue,
          totalRows: res.totalRows,
        },
      });
      return res;
    }),

  /** قائمة الموجات المطبَّقة (الأحدث أولاً). */
  list: productsManagerProcedure
    .input(z.object({ limit: z.number().int().positive().max(200).default(50) }).optional())
    .query(async ({ input }) => {
      const rows = await withTx((tx) => listPriceWaves(tx, input?.limit ?? 50));
      return rows.map((r) => ({
        ...r,
        id: Number(r.id),
        appliedBy: Number(r.appliedBy),
      }));
    }),

  /** تاريخ تغييرات سعر وحدة معيّنة (لعرض على شاشة تعديل المنتج مستقبلاً). */
  unitHistory: productsManagerProcedure
    .input(z.object({ productUnitId: z.number().int().positive(), limit: z.number().int().positive().max(200).default(50) }))
    .query(async ({ input }) => {
      const rows = await withTx((tx) => getPriceUnitHistory(tx, input.productUnitId, input.limit));
      const enrichment = await withTx((tx) => enrichLogRows(tx, rows.map((r) => ({ productUnitId: Number(r.productUnitId) }))));
      return rows.map((r) => ({
        ...r,
        id: Number(r.id),
        productUnitId: Number(r.productUnitId),
        waveId: r.waveId == null ? null : Number(r.waveId),
        actorUserId: Number(r.actorUserId),
        productName: enrichment.get(Number(r.productUnitId))?.productName ?? null,
        unitName: enrichment.get(Number(r.productUnitId))?.unitName ?? null,
      }));
    }),
});
