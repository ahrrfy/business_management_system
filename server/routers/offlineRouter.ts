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
import { customersReadProcedure, productsReadProcedure, router, salesCashierProcedure } from "../trpc";

/** نفس حارس IDOR في catalogRouter: غير المرتفعين محصورون بفرعهم المُسنَد. */
function scopeBranch(ctx: { user: { role: string; branchId?: number | null } }, requested: number): number {
  const elevated = ctx.user.role === "admin" || ctx.user.role === "manager";
  if (elevated) return requested;
  return ctx.user.branchId != null ? Number(ctx.user.branchId) : requested;
}

export const offlineRouter = router({
  /** نسخ رخيصة تُقارَن كل مزامنة — تغيّر نسخة ⇒ جلب اللقطة الموافقة كاملة. */
  versions: productsReadProcedure.query(() => buildOfflineVersions()),

  catalogSnapshot: productsReadProcedure.query(() => buildCatalogSnapshot()),

  stockSnapshot: productsReadProcedure
    .input(z.object({ branchId: z.number().int().positive() }))
    .query(({ input, ctx }) => buildStockSnapshot(scopeBranch(ctx, input.branchId))),

  customersSnapshot: customersReadProcedure.query(() => buildCustomersSnapshot()),

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
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // عزل الفرع — مرآة saleRouter.create حرفياً (منع IDOR): غير المرتفع يُجبَر على فرعه.
      const elevated = ctx.user.role === "admin" || ctx.user.role === "manager";
      let effectiveBranchId = input.branchId;
      if (!elevated) {
        if (ctx.user.branchId == null) {
          throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
        }
        effectiveBranchId = Number(ctx.user.branchId);
      }
      const actor = { userId: ctx.user.id, branchId: effectiveBranchId, role: ctx.user.role };
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await replayOfflineSale({ ...input, branchId: effectiveBranchId }, actor);
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
});
