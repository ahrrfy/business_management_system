// راوتر العمل دون اتصال — الشريحة ٢ من خطة الأوفلاين: نقاط جلب النموذج المحلي (لقطات
// الكتالوج/المخزون/العملاء + النسخ). القراءة فقط هنا؛ إعادة تشغيل المبيعات (replaySale)
// تأتي في الشريحة ٣.
//
// البوّابات مرآة catalogRouter/customerRouter: الكتالوج والأسعار خلف products READ،
// والعملاء خلف crm READ — نفس ما يصل إليه الكاشير أونلاين، لا أوسع (اللقطة ليست تصديراً
// أوسع من الشاشة). المخزون مقيَّد بفرع المستخدم غير المرتفع (نفس حارس IDOR في posList).

import { TRPCError } from "@trpc/server";
import { isDupEntry } from "@shared/errorMap.ar";
import { z } from "zod";
import { logger } from "../logger";
import { nonNegMoneyString, positiveMoneyString } from "../lib/schemas";
import { logAudit } from "../services/auditService";
import {
  buildCatalogSnapshot,
  buildCustomersSnapshot,
  buildOfflineVersions,
  buildStockSnapshot,
} from "../services/offline/catalogSnapshot";
import { replayOfflineSale } from "../services/offline/replaySale";
import { replayOfflinePrintSale } from "../services/offline/replayPrintSale";
import { replayOfflineReception } from "../services/offline/replayReception";
import { buildOfflineSalesReport } from "../services/offline/salesReport";
import { verifyManagerApproval } from "./saleRouter";
import {
  customersReadProcedure,
  posCashierProcedure,
  productsReadProcedure,
  reportViewerProcedure,
  router,
  salesCashierProcedure,
  workordersCashierProcedure,
} from "../trpc";

/** نفس حارس IDOR في catalogRouter: غير المرتفعين محصورون بفرعهم المُسنَد. */
function scopeBranch(ctx: { user: { role: string; branchId?: number | null } }, requested: number): number {
  const elevated = ctx.user.role === "admin"; // عزل مدير الفرع (قرار المالك ١٢/٨): المالك/الأدمن فقط يعبُران
  if (elevated) return requested;
  return ctx.user.branchId != null ? Number(ctx.user.branchId) : requested;
}

/** عزل الفرع + بناء الفاعل — مرآة `saleRouter.create` حرفياً (منع IDOR): غير المرتفع يُجبَر
 *  على فرعه المُسنَد ولا يُصدَّق `branchId` القادم من العميل. مشتركٌ بين مسارات الترحيل الثلاثة
 *  كي لا ينجرف حارسُ أحدها عن الآخرين. */
function scopeActor(
  ctx: { user: { id: number; role: string; branchId?: number | null } },
  requestedBranchId: number,
) {
  // عزل مدير الفرع (قرار المالك ١٢/٨): عبور الفروع للمالك/الأدمن فقط. **فصلٌ عن السلطة** (P2 Codex):
  // canApprove (سلطة اعتماد التسعير تحت التكلفة) تبقى للمدير — لا الفرع.
  const crossBranch = ctx.user.role === "admin";
  let effectiveBranchId = requestedBranchId;
  if (!crossBranch) {
    if (ctx.user.branchId == null) {
      throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
    }
    effectiveBranchId = Number(ctx.user.branchId);
  }
  const canApprove = ctx.user.role === "admin" || ctx.user.role === "manager";
  return {
    canApprove,
    effectiveBranchId,
    actor: { userId: ctx.user.id, branchId: effectiveBranchId, role: ctx.user.role },
  };
}

/** غلاف تنفيذ الترحيل: إعادة محاولة تصادم ترقيم الفاتورة + أثر تدقيقيّ + تحويل الأخطاء غير
 *  المتوقّعة إلى رسالةٍ عربية بلا تسريب SQL. مشتركٌ بين الأنواع الثلاثة (كان محصوراً بـreplaySale). */
async function runReplay<T extends { invoiceId?: number; idempotentReplay?: boolean }>(
  run: () => Promise<T>,
  meta: {
    ctx: Parameters<typeof logAudit>[0];
    action: string;
    offlineReceiptNumber: string;
    capturedAt: string;
    deviceId: string | null;
    lines: number;
  },
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await run();
      if (!res.idempotentReplay) {
        await logAudit(meta.ctx, {
          action: meta.action,
          entityType: "invoice",
          entityId: res.invoiceId ?? 0,
          newValue: {
            offlineReceiptNumber: meta.offlineReceiptNumber,
            capturedAt: meta.capturedAt,
            deviceId: meta.deviceId,
            lines: meta.lines,
          },
        });
      }
      return res;
    } catch (e: unknown) {
      if (isDupEntry(e) && attempt < 2) continue;
      if (e instanceof TRPCError) throw e;
      const err = e as { message?: string; code?: string; sqlMessage?: string; sql?: string };
      logger.error(
        {
          err: { message: err?.message, code: err?.code, sqlMessage: err?.sqlMessage, sql: err?.sql },
          offlineReceiptNumber: meta.offlineReceiptNumber,
          action: meta.action,
        },
        "ترحيل أوفلايني فشل بخطأ غير متوقّع",
      );
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر ترحيل العملية الأوفلاينية" });
    }
  }
  throw new TRPCError({ code: "CONFLICT", message: "تعذّر توليد رقم فاتورة فريد" });
}

export const offlineRouter = router({
  /** نسخ رخيصة تُقارَن كل مزامنة — تغيّر نسخة ⇒ جلب اللقطة الموافقة كاملة. */
  versions: productsReadProcedure.query(() => buildOfflineVersions()),

  catalogSnapshot: productsReadProcedure.query(() => buildCatalogSnapshot()),

  stockSnapshot: productsReadProcedure
    .input(z.object({ branchId: z.number().int().positive() }))
    .query(({ input, ctx }) => buildStockSnapshot(scopeBranch(ctx, input.branchId))),

  customersSnapshot: customersReadProcedure.query(() => buildCustomersSnapshot()),

  /** ش٥ — تقرير «المبيعات الأوفلاين» للإدارة: ربط OFF↔INV + زمن الترحيل + وسم «مُزامنة
   *  لاحقاً». خلف بوّابة التقارير القياسية (القائمة + المنح الصريح + عزل فرع غير الأدمن). */
  salesReport: reportViewerProcedure
    .input(
      z.object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        branchId: z.number().int().positive().optional(),
      }),
    )
    .query(({ input }) => buildOfflineSalesReport(input)),

  /**
   * إعادة تشغيل بيعٍ التُقط دون اتصال (ش٣) — غلاف idempotent حول createSale (نفس sourceType
   * "POS" + نفس clientRequestId ⇒ لا ازدواج حتى مع بيعٍ نصف-ناجح قبل الانقطاع).
   * لا عروض/كوبونات/آجل هنا عمداً (قرار الخطة: الأوفلاين نقدي مبسَّط).
   */
  replaySale: salesCashierProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        shiftId: z.number().int().positive().optional(),
        customerId: z.number().int().positive().optional(),
        priceTier: z.enum(["RETAIL", "WHOLESALE", "GOVERNMENT"]).optional(),
        lines: z
          .array(
            z.object({
              variantId: z.number().int().positive(),
              productUnitId: z.number().int().positive(),
              quantity: z.string().regex(/^\d+(\.\d{1,3})?$/, "كمية غير صالحة (موجبة، ثلاث منازل)"),
              // السعر الملتقَط إلزامي: النقد قُبض بالسعر المطبوع — لا إعادة تسعير صامتة عند الترحيل.
              unitPriceOverride: nonNegMoneyString,
              discountPercent: z.string().regex(/^\d+(\.\d{1,2})?$/, "نسبة خصم غير صالحة").optional(),
              discountAmount: nonNegMoneyString.optional(),
            }),
          )
          .min(1),
        invoiceDiscount: nonNegMoneyString.optional(),
        payment: z.object({ amount: positiveMoneyString, method: z.literal("CASH") }),
        clientRequestId: z.string().min(8).max(50),
        notes: z.string().max(1000).optional(),
        cashRoundIQD: z.boolean().optional(),
        capturedAt: z.string().min(10).max(40),
        offlineReceiptNumber: z.string().min(4).max(40),
        deviceId: z.string().max(40).optional(),
        // ش٤: اعتماد مدير لترحيل عنصرٍ معلَّق تحت التكلفة (بريد + كلمة مرور، تُتحقَّق خادمياً
        // بنفس مسار saleRouter المحصَّن: rate-limit + توقيت ثابت + SOD + تدقيق).
        managerApproval: z.object({ email: z.string().min(1), password: z.string().min(1) }).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // عزل الفرع — مرآة saleRouter.create (منع IDOR): غير العابر يُجبَر على فرعه. **فصلٌ عن السلطة** (P2 Codex):
      // عبور الفروع للمالك/الأدمن فقط؛ سلطة اعتماد التسعير تحت التكلفة (canApprove) تبقى للمدير.
      const crossBranch = ctx.user.role === "admin";
      let effectiveBranchId = input.branchId;
      if (!crossBranch) {
        if (ctx.user.branchId == null) {
          throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
        }
        effectiveBranchId = Number(ctx.user.branchId);
      }
      const actor = { userId: ctx.user.id, branchId: effectiveBranchId, role: ctx.user.role };
      // سلطة تحت-التكلفة: المدير/الأدمن المرحِّل يملكها ذاتياً؛ الكاشير عبر managerApproval مُتحقَّق.
      const canApprove = ctx.user.role === "admin" || ctx.user.role === "manager";
      const { managerApproval, ...replayInput } = input;
      let approvedBy: number | null = null;
      if (managerApproval) approvedBy = await verifyManagerApproval(managerApproval, ctx, effectiveBranchId);
      const priceOverrideApprovedBy: number | null = approvedBy ?? (canApprove ? ctx.user.id : null);
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await replayOfflineSale(
            { ...replayInput, branchId: effectiveBranchId, priceOverrideApproved: priceOverrideApprovedBy != null },
            actor,
          );
          if (!res.idempotentReplay) {
            await logAudit(ctx, {
              action: "sale.offlineReplay",
              entityType: "invoice",
              entityId: res.invoiceId,
              newValue: {
                offlineReceiptNumber: input.offlineReceiptNumber,
                capturedAt: input.capturedAt,
                deviceId: input.deviceId ?? null,
                lines: input.lines.length,
              },
            });
            // SALES-01/02: أثر تدقيقي صريح للترحيل تحت التكلفة المعتمَد (مرآة saleRouter).
            if (res.priceOverride) {
              await logAudit(ctx, {
                action: "sale.priceOverride",
                entityType: "invoice",
                entityId: res.invoiceId,
                newValue: { approvedByUserId: priceOverrideApprovedBy, byRole: ctx.user.role, offlineReplay: true },
              });
            }
          }
          return res;
        } catch (e: unknown) {
          if (isDupEntry(e) && attempt < 2) continue;
          if (e instanceof TRPCError) throw e;
          const err = e as { message?: string; code?: string; sqlMessage?: string; sql?: string };
          logger.error(
            {
              err: { message: err?.message, code: err?.code, sqlMessage: err?.sqlMessage, sql: err?.sql },
              userId: actor.userId,
              branchId: actor.branchId,
              offlineReceiptNumber: input.offlineReceiptNumber,
            },
            "offline.replaySale فشل بخطأ غير متوقّع",
          );
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر ترحيل البيع الأوفلايني" });
        }
      }
      throw new TRPCError({ code: "CONFLICT", message: "تعذّر توليد رقم فاتورة فريد" });
    }),
  /**
   * ترحيل بيع خدمات طباعةٍ التُقط دون اتصال (كاشير الطباعة).
   * البوّابة `posCashierProcedure` مرآةُ `printPos.createSale` بالضبط — لا أوسع: مَن يبيع
   * أونلاين هو مَن يُرحّل ما التقطه أوفلاين، لا أحدَ سواه.
   */
  replayPrintSale: posCashierProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        shiftId: z.number().int().positive().optional(),
        customerId: z.number().int().positive().optional(),
        contactName: z.string().trim().max(255).optional(),
        contactPhone: z.string().trim().max(32).optional(),
        priceTier: z.enum(["RETAIL", "WHOLESALE", "GOVERNMENT"]).optional(),
        lines: z
          .array(
            z.object({
              variantId: z.number().int().positive(),
              productUnitId: z.number().int().positive(),
              quantity: z.string().regex(/^\d+(\.\d{1,3})?$/, "كمية غير صالحة"),
              unitPriceOverride: nonNegMoneyString,
            }),
          )
          .min(1),
        payment: z.object({ amount: positiveMoneyString, method: z.literal("CASH") }),
        clientRequestId: z.string().min(8).max(50),
        notes: z.string().max(1000).optional(),
        cashRoundIQD: z.boolean().optional(),
        capturedAt: z.string().min(10).max(40),
        offlineReceiptNumber: z.string().min(4).max(40),
        deviceId: z.string().max(40).optional(),
        managerApproval: z.object({ email: z.string().min(1), password: z.string().min(1) }).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { effectiveBranchId, actor, canApprove } = scopeActor(ctx, input.branchId);
      const { managerApproval, ...replayInput } = input;
      let approvedBy: number | null = null;
      if (managerApproval) approvedBy = await verifyManagerApproval(managerApproval, ctx, effectiveBranchId);
      const priceOverrideApproved = (approvedBy ?? (canApprove ? ctx.user.id : null)) != null;
      return runReplay(
        () =>
          replayOfflinePrintSale(
            { ...replayInput, branchId: effectiveBranchId, priceOverrideApproved },
            actor,
          ),
        {
          ctx,
          action: "printSale.offlineReplay",
          offlineReceiptNumber: input.offlineReceiptNumber,
          capturedAt: input.capturedAt,
          deviceId: input.deviceId ?? null,
          lines: input.lines.length,
        },
      );
    }),

  /**
   * ترحيل سلّة استقبالٍ التُقطت دون اتصال (كاشير خدمات الزبائن).
   * البوّابة `workordersCashierProcedure` مرآةُ `workOrders.receptionCheckout` — و**ليست**
   * `salesCashierProcedure`: دور «موظف استقبال» المبذور يملك `sales: READ` فقط، فلو وُضع هذا
   * المسار خلف بوّابة المبيعات لَرُفض كلُّ ترحيلٍ منه بـFORBIDDEN وبقي طابوره عالقاً للأبد.
   * أوامر الشغل مرفوضةٌ بنيوياً — العقد لا يحملها أصلاً (راجع replayReception.ts).
   */
  replayReception: workordersCashierProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        shiftId: z.number().int().positive(),
        customerId: z.number().int().positive().optional(),
        contactName: z.string().trim().max(255).optional(),
        contactPhone: z.string().trim().max(32).optional(),
        priceTier: z.enum(["RETAIL", "WHOLESALE", "GOVERNMENT"]).optional(),
        paymentMethod: z.literal("CASH"),
        paidAmount: positiveMoneyString,
        regularSale: z
          .object({
            lines: z
              .array(
                z.object({
                  variantId: z.number().int().positive(),
                  productUnitId: z.number().int().positive(),
                  quantity: z.string().regex(/^\d+(\.\d{1,3})?$/, "كمية غير صالحة"),
                  unitPriceOverride: nonNegMoneyString,
                  discountPercent: z.string().regex(/^\d+(\.\d{1,2})?$/, "نسبة خصم غير صالحة").optional(),
                  discountAmount: nonNegMoneyString.optional(),
                }),
              )
              .min(1),
            amount: positiveMoneyString,
          })
          .nullish(),
        printSale: z
          .object({
            lines: z
              .array(
                z.object({
                  variantId: z.number().int().positive(),
                  productUnitId: z.number().int().positive(),
                  quantity: z.string().regex(/^\d+(\.\d{1,3})?$/, "كمية غير صالحة"),
                  unitPriceOverride: nonNegMoneyString,
                }),
              )
              .min(1),
            amount: positiveMoneyString,
          })
          .nullish(),
        clientRequestId: z.string().min(8).max(50),
        capturedAt: z.string().min(10).max(40),
        offlineReceiptNumber: z.string().min(4).max(40),
        deviceId: z.string().max(40).optional(),
        managerApproval: z.object({ email: z.string().min(1), password: z.string().min(1) }).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { effectiveBranchId, actor, canApprove } = scopeActor(ctx, input.branchId);
      const { managerApproval, ...replayInput } = input;
      let approvedBy: number | null = null;
      if (managerApproval) approvedBy = await verifyManagerApproval(managerApproval, ctx, effectiveBranchId);
      const priceOverrideApproved = (approvedBy ?? (canApprove ? ctx.user.id : null)) != null;
      return runReplay(
        () =>
          replayOfflineReception(
            { ...replayInput, branchId: effectiveBranchId, priceOverrideApproved },
            actor,
          ),
        {
          ctx,
          action: "reception.offlineReplay",
          offlineReceiptNumber: input.offlineReceiptNumber,
          capturedAt: input.capturedAt,
          deviceId: input.deviceId ?? null,
          lines: (input.regularSale?.lines.length ?? 0) + (input.printSale?.lines.length ?? 0),
        },
      );
    }),
});
