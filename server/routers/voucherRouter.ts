// راوتر سندات القبض/الصرف المستقلّة. managerProcedure (تأثير مالي مباشر على الذمم + الصندوق).
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { logAudit } from "../services/auditService";
import { cancelVoucher, createVoucher, getVoucher, listVouchers } from "../services/voucherService";
import { managerProcedure, router } from "../trpc";

const partyType = z.enum(["CUSTOMER", "SUPPLIER", "OTHER"]);
const method = z.enum(["CASH", "CARD", "CHECK", "TRANSFER", "WALLET"]);
const voucherType = z.enum(["RECEIPT", "PAYMENT"]);
const moneyStr = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, "مبلغ غير صالح (موجب، منزلتان عشريتان كحدّ أقصى)");
// تاريخ فلترة YYYY-MM-DD (فلتر الفترة الخادمي على createdAt).
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح (YYYY-MM-DD)");

export const voucherRouter = router({
  create: managerProcedure
    .input(
      z.object({
        voucherType,
        branchId: z.number().int().positive(),
        amount: moneyStr,
        paymentMethod: method,
        partyType,
        partyId: z.number().int().positive().nullish(),
        description: z.string().min(1, "الوصف مطلوب").max(500),
        referenceNumber: z.string().max(100).nullish(),
        checkNumber: z.string().max(50).nullish(),
        cardLastFour: z.string().max(4).nullish(),
        // idempotency: نفس المفتاح ⇒ سند واحد (لا صرف/قبض مزدوج عند النقر المزدوج/إعادة الشبكة).
        clientRequestId: z.string().min(1).max(80).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // G2 (تدقيق ١٤/٦/٢٦): قبل الإصلاح كان `ctx.user.branchId ?? input.branchId` يسمح
      // لمدير بـbranchId=null أن يحقن أي input.branchId. الإجراء managerProcedure لكن
      // دفاع متعمّق: لا نسمح لمستخدم بلا فرع مُسنَد بإصدار سندات (يشمل admin أيضاً —
      // كل سند يحتاج فرعاً واضحاً للقيد والصندوق).
      if (ctx.user.branchId == null) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم — لا يمكن إصدار سند" });
      }
      const actorBranchId = Number(ctx.user.branchId);
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await createVoucher(input, { userId: ctx.user.id, branchId: actorBranchId, role: ctx.user.role });
          await logAudit(ctx, {
            action: input.voucherType === "RECEIPT" ? "voucher.receipt.create" : "voucher.payment.create",
            entityType: "receipt",
            entityId: res.receiptId,
            newValue: { voucherNumber: res.voucherNumber, amount: input.amount, partyType: input.partyType, partyId: input.partyId ?? null },
          });
          return res;
        } catch (e: any) {
          if (e?.code === "ER_DUP_ENTRY" && attempt < 2) continue;
          if (e instanceof TRPCError) throw e;
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر إنشاء السند" });
        }
      }
      throw new TRPCError({ code: "CONFLICT", message: "تعذّر إنشاء السند (تكرار)" });
    }),

  // إلغاء سند مستقلّ: الأصل REVERSED + إيصال تعويضي معاكس + قيد معاكس + عكس رصيد الطرف.
  cancel: managerProcedure
    .input(z.object({ receiptId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      // G2: استبدال fallback `?? 1` الصامت (كان يصرف على فرع 1 لمدير بلا فرع).
      if (ctx.user.branchId == null) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم — لا يمكن إلغاء سند" });
      }
      const res = await cancelVoucher(input.receiptId, {
        userId: ctx.user.id,
        branchId: Number(ctx.user.branchId),
        role: ctx.user.role, // SOD-05: لازم لاستثناء الأدمن من حارس «المُلغٍي ≠ المُنشئ».
      });
      await logAudit(ctx, {
        action: "voucher.cancel",
        entityType: "receipt",
        entityId: input.receiptId,
        newValue: { voucherNumber: res.voucherNumber, status: res.status },
      });
      return res;
    }),

  // قراءة السندات تكشف بيانات نقدية حسّاسة (مبالغ، أرقام شيكات، آخر ٤ من البطاقة).
  // managerProcedure تتّسق مع كتابة السندات (create/cancel managerProcedure) ومع كل القراءات
  // المالية الأخرى في reportsRouter (arAging/apAging/customerStatement/salesReport). أكثر صرامةً
  // من branchScopedProcedure (التي تسمح للكاشير برؤية سندات فرعه)، يطابق توصية التدقيق العدائي.
  // admin/manager غير مُقيَّدَين بفرع لذمم/سندات الشركة كاملة بطبيعة دورهما — branchId المُرسَل
  // فلتر اختياري لا قيد أمني.
  list: managerProcedure
    .input(
      z
        .object({
          branchId: z.number().int().positive().optional(),
          voucherType: voucherType.optional(),
          partyType: partyType.optional(),
          partyId: z.number().int().positive().optional(),
          status: z.enum(["COMPLETED", "REVERSED"]).optional(),
          from: ymd.optional(),
          to: ymd.optional(),
          limit: z.number().int().positive().max(500).default(100),
          offset: z.number().int().min(0).default(0),
        })
        .optional(),
    )
    .query(async ({ input }) => listVouchers(input ?? {})),

  get: managerProcedure
    .input(z.object({ receiptId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      const voucher = await getVoucher(input.receiptId);
      if (voucher && ctx.user.role !== "admin" && ctx.user.branchId != null && Number(voucher.branchId) !== Number(ctx.user.branchId)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "هذا السند لفرع آخر" });
      }
      return voucher;
    }),
});
