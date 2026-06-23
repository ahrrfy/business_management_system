import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { logger } from "../logger";
import { logAudit } from "../services/auditService";
import { listPrintServices } from "../services/catalogService";
import { createPrintSale } from "../services/printSaleService";
import { verifyManagerApproval } from "./saleRouter";
import { cashierProcedure, router } from "../trpc";
import { nonNegMoneyString, positiveMoneyString } from "../lib/schemas";

const tier = z.enum(["RETAIL", "WHOLESALE", "GOVERNMENT"]);
const method = z.enum(["CASH", "CARD", "CHECK", "TRANSFER", "WALLET"]);
const lineSchema = z.object({
  variantId: z.number().int().positive(),
  productUnitId: z.number().int().positive(),
  // كمية الخدمة (صفحات/صور/خدمات) — عدد صحيح موجب.
  quantity: z.string().regex(/^\d+(\.\d{1,3})?$/, "كمية غير صالحة"),
  // السعر اليدوي (سعر الخدمة قابل للتعديل من الكاشير) — nonNegMoneyString المركزية.
  unitPriceOverride: nonNegMoneyString.optional(),
});

export const printPosRouter = router({
  /** بلاطات الخدمات (مبوّبة بالفئة) — للكاشير فأعلى، بلا كلفة/مواد. */
  services: cashierProcedure
    .input(z.object({ tier: tier.default("RETAIL") }).optional())
    .query(({ input }) => listPrintServices(input?.tier ?? "RETAIL")),

  /** بيع خدمات الطباعة: فاتورة + خصم مواد بصمت + قيد + ذمم — ذرّياً (createPrintSale). */
  createSale: cashierProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        shiftId: z.number().int().positive().optional(),
        customerId: z.number().int().positive().optional(),
        priceTier: tier.optional(),
        lines: z.array(lineSchema).min(1),
        payment: z.object({ amount: positiveMoneyString, method }).optional(),
        dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح (YYYY-MM-DD)").optional(),
        cashRoundIQD: z.boolean().optional(),
        clientRequestId: z.string().optional(),
        notes: z.string().optional(),
        // موافقة مدير لتجاوز حدّ الائتمان (بريد+كلمة مرور، تُتحقَّق خادمياً).
        managerApproval: z.object({ email: z.string().min(1), password: z.string().min(1) }).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // عزل الفرع: غير المدير يُجبَر على فرعه (لا يُصدَّق branchId القادم من العميل — منع IDOR).
      const elevated = ctx.user.role === "admin" || ctx.user.role === "manager";
      if (!elevated && ctx.user.branchId == null) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا الكاشير" });
      }
      const effectiveBranchId = elevated ? input.branchId : Number(ctx.user.branchId);
      const actor = { userId: ctx.user.id, branchId: effectiveBranchId };
      let approvedBy: number | null = null;
      const { managerApproval, ...saleInput } = input;
      // AUTHZ-1: مرّر effectiveBranchId لـverifyManagerApproval ⇒ مدير فرع آخر لا يَعتمد بيع هذا الفرع
      // (كان يُستدعى بلا branchId ⇒ IDOR اعتماد عبر الفروع على قناة الطباعة — كان مُصلَحاً في saleRouter فقط).
      if (managerApproval) approvedBy = await verifyManagerApproval(managerApproval, ctx, effectiveBranchId);
      // SALES-01/02: سلطة البيع تحت التكلفة (مدير/أدمن ذاتياً، الكاشير بموافقة مدير مُتحقَّقة).
      const priceOverrideApprovedBy: number | null = approvedBy ?? (elevated ? ctx.user.id : null);
      // B5: مرّر managerOverrideByUserId مع creditApproved ⇒ printSaleService ينشئ approval ذرّياً.
      const effectiveInput = {
        ...saleInput,
        branchId: effectiveBranchId,
        creditApproved: approvedBy != null,
        managerOverrideByUserId: approvedBy ?? undefined,
        priceOverrideApproved: priceOverrideApprovedBy != null,
      };
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await createPrintSale(effectiveInput, actor);
          await logAudit(ctx, { action: "printPos.sale", entityType: "invoice", entityId: (res as { invoiceId?: number })?.invoiceId, newValue: { lines: input.lines.length, creditApprovedBy: approvedBy } });
          if (approvedBy != null) await logAudit(ctx, { action: "printPos.creditOverride", entityType: "invoice", entityId: (res as { invoiceId?: number })?.invoiceId, newValue: { approvedByManagerId: approvedBy } });
          // SALES-01/02: أثر تدقيقي صريح للبيع تحت التكلفة على قناة الطباعة.
          if (res.priceOverride) await logAudit(ctx, { action: "printPos.priceOverride", entityType: "invoice", entityId: res.invoiceId, newValue: { approvedByUserId: priceOverrideApprovedBy, byRole: ctx.user.role } });
          return res;
        } catch (e: any) {
          if (e?.code === "ER_DUP_ENTRY" && attempt < 2) continue;
          if (e instanceof TRPCError) throw e;
          // لا نبتلع السبب الجذري — نُسجّله كاملاً قبل رسالة عامة (درس ١٢/٦).
          logger.error(
            { err: { message: e?.message, code: e?.code, sqlMessage: e?.sqlMessage, sql: e?.sql }, userId: actor.userId, branchId: actor.branchId, lines: input.lines.length },
            "printPos.createSale فشل بخطأ غير متوقّع (السبب الجذري أدناه)"
          );
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر إتمام البيع" });
        }
      }
      throw new TRPCError({ code: "CONFLICT", message: "تعذّر توليد رقم فاتورة فريد" });
    }),
});
