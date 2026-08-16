// راوتر محطة خدمة الزبائن — ش١ من docs/reception-cashier-system-design-2026-08-05.md §٦.
//
// **صفر بوّابة جديدة**: كل النقاط خلف workordersCashierProcedure القائمة (cashier/manager +
// workorders=FULL) — نفس بوّابة الالتزام receptionCheckout والطابور القديم بالضبط، فلا مدخل
// جديد في authz-inventory. (workordersReadProcedure مرفوضة هنا عمداً — V9: بوّابة خريطةٍ بلا
// قائمة أدوار تفتح الطابور لـwarehouse/user/auditor.)
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { nonNegMoneyString, positiveMoneyString } from "../lib/schemas";
import { assertValidImageDataUrl } from "../lib/imageValidation";
import {
  cancelDraft,
  collectDeposit,
  collectOnReceptionInvoice,
  commitDraft,
  getDraft,
  listDraftPayments,
  listDrafts,
  listReceptionInvoices,
  promoteDraft,
  refundDeposit,
  syncDraft,
} from "../services/reception";
import { verifyManagerApproval } from "./saleRouter";
import { retryOnDeadlock } from "../lib/retryDeadlock";
import { router, workordersCashierProcedure, workordersExecProcedure } from "../trpc";
import { logAudit } from "../services/auditService";
import { POS_EXTERNAL_PAYMENT_DISABLED_MESSAGE, isPosPaymentMethodEnabled } from "@shared/posPaymentPolicy";

/** عزل الفرع (نمط deliveryRouter.effectiveBranch): المرتفعون يعبرون بـbranchId صريح؛
 *  غيرهم يُجبَرون على فرعهم، وغيابه = FORBIDDEN. */
function effectiveBranch(ctx: { user: { role?: string | null; branchId?: number | null } }, requested?: number | null) {
  const elevated = ctx.user.role === "admin"; // عزل مدير الفرع (قرار المالك ١٢/٨): المالك/الأدمن فقط يعبُران
  if (elevated) return requested ?? (ctx.user.branchId != null ? Number(ctx.user.branchId) : null);
  return ctx.user.branchId != null ? Number(ctx.user.branchId) : null;
}

// ش٥: TELECOM (رصيد زين) يبقى في **فلتر القراءة** فقط — قبضُه على الفاتورة مرفوض بنيوياً
// (مساره شاشة البطاقات الرقمية). أمّا البطاقة/التحويل/المحفظة فمقبوضة بمرجع العملية.
const payMethodEnum = z.enum(["CASH", "CARD", "TRANSFER", "WALLET", "TELECOM"]);
// المحطة لا تقبض بالصكوك (قرار المالك ٢٢/٧) فلا CHECK هنا؛ والـrefine يبقى حارساً على TELECOM.
const inboundPaymentMethod = payMethodEnum
  .refine(isPosPaymentMethodEnabled, { message: POS_EXTERNAL_PAYMENT_DISABLED_MESSAGE });

// ش٢ — عقود المسوّدة (§٦): بوّابة **exec** (كاشير/مدير/فنّي طباعة — المسوّدة بلا مالٍ فتُحرَّر
// بأوسع أدوار المحطة)؛ التثبيت والمال يبقيان خلف بوّابة الكاشير (ش٣/ش٤).
const quantityString = z.string().regex(/^\d+(\.\d{1,3})?$/, "كمية غير صالحة");
const draftLineSchema = z.object({
  lineKind: z.enum(["GOODS", "PRINT", "CUSTOM"]),
  sortOrder: z.number().int().min(0).optional(),
  variantId: z.number().int().positive().nullish(),
  productUnitId: z.number().int().positive().nullish(),
  quantity: quantityString,
  unitPrice: nonNegMoneyString,
  discountAmount: nonNegMoneyString.nullish(),
  title: z.string().trim().max(255).nullish(),
  customizationText: z.string().max(5000).nullish(),
  /** JSON نصّي [{url,caption,sortOrder}] — يُتحقَّق من كل صورة فيه أدناه. */
  designImages: z.string().max(8_000_000).nullish(),
  printSpec: z.string().max(20_000).nullish(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  assignedTo: z.number().int().positive().nullish(),
  priceOverride: z.boolean().optional(),
  lineRequestId: z.string().max(64).nullish(),
});
const draftHeaderSchema = z.object({
  customerId: z.number().int().positive().nullish(),
  contactName: z.string().trim().max(255).nullish(),
  contactPhone: z.string().trim().max(32).nullish(),
  priceTier: z.enum(["RETAIL", "WHOLESALE", "GOVERNMENT"]).nullish(),
  channel: z.string().trim().max(20).nullish(),
  notes: z.string().max(2000).nullish(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
});
function assertDraftImages(lines: Array<{ designImages?: string | null }>) {
  for (const line of lines) {
    if (!line.designImages) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.designImages);
    } catch {
      throw new TRPCError({ code: "BAD_REQUEST", message: "صور المسوّدة بصيغة غير صالحة" });
    }
    if (!Array.isArray(parsed) || parsed.length > 10) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "صور المسوّدة: ١٠ صور كحدّ أقصى" });
    }
    for (const img of parsed as Array<{ url?: string }>) {
      if (img?.url) assertValidImageDataUrl(img.url);
    }
  }
}

export const receptionRouter = router({
  /** طابور فواتير المحطة: قراءة/إعادة طباعة فقط. بوابة exec تُدرج مشغّل الطباعة وتبقي
   *  القبض/الاسترداد والطفرات المالية أدناه خلف workordersCashierProcedure. */
  invoiceQueue: workordersExecProcedure
    .input(
      z.object({
        branchId: z.number().int().positive().nullish(),
        shiftIds: z.array(z.number().int().positive()).max(20).optional(),
        sinceDays: z.number().int().min(0).max(30).optional(),
        q: z.string().trim().max(80).optional(),
        deliveryState: z.enum(["ALL", "NOT_DISPATCHED", "DISPATCHED", "DELIVERED"]).optional(),
        paymentState: z.enum(["ALL", "UNSETTLED", "UNPAID", "PARTIAL", "PAID"]).optional(),
        method: payMethodEnum.optional(),
        cursor: z.number().int().positive().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const branchId = effectiveBranch(ctx, input.branchId);
      if (!branchId) throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
      return listReceptionInvoices({ ...input, branchId });
    }),

  /** تسديد دفعة على فاتورة المحطة — ح٥ (V8): تفويضٌ إلى processPayment نفسها بحصرٍ بنيويّ
   *  (وردية إنشاء الفاتورة RECEPTION)، والدفعة تدخل درج **القابض** الحاليّ. */
  collectOnInvoice: workordersCashierProcedure
    .input(
      z.object({
        invoiceId: z.number().int().positive(),
        amount: positiveMoneyString,
        method: inboundPaymentMethod,
        reference: z.string().trim().max(100).nullish(),
        clientRequestId: z.string().min(1).max(60),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const actor = {
        userId: ctx.user.id,
        branchId: ctx.user.branchId != null ? Number(ctx.user.branchId) : null,
        role: ctx.user.role,
      };
      const result = await collectOnReceptionInvoice(input, actor as never);
      // إفصاح «قَبَضَها» (§٩.٣): كل تسديدٍ يسمّي فاعله ووردية درجه — الرقابة اللاحقة أرخص من المنع.
      await logAudit(ctx, {
        action: "reception.collectOnInvoice",
        entityType: "invoice",
        entityId: input.invoiceId,
        newValue: {
          amount: input.amount,
          method: input.method,
          collectedIntoShiftId: result.collectedIntoShiftId,
        },
      });
      return result;
    }),

  // ── ش٤ — العرابين (المال): بوّابة **الكاشير** حصراً (print_operator محجوبٌ بنيوياً) ──
  /** قبض عربون على طلبٍ محفوظ — بوردية استقبالٍ مُلزَمة بنوعها (V12، حتى للمدير).
   *  بلا version عمداً: قبضُ مالٍ لا يفشل لأنّ زميلاً أضاف سطراً — حاميه clientRequestId. */
  collectDeposit: workordersCashierProcedure
    .input(
      z.object({
        draftId: z.number().int().positive(),
        amount: positiveMoneyString,
        method: inboundPaymentMethod,
        reference: z.string().trim().max(64).nullish(),
        /** ش٥ — هاتف مُرسِل رصيد زين (اختياريّ؛ يُطبَّع خادمياً E.164). */
        telecomSenderPhone: z.string().trim().max(32).nullish(),
        clientRequestId: z.string().min(8).max(80),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      if (input.method !== "CASH" && !input.reference?.trim()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "المرجع إلزاميّ لغير النقد (رقم القسيمة/التحويل)" });
      }
      const actor = {
        userId: ctx.user.id,
        branchId: ctx.user.branchId != null ? Number(ctx.user.branchId) : null,
        role: ctx.user.role,
      };
      const result = await retryOnDeadlock(() =>
        collectDeposit(
          { ...input, reference: input.reference ?? null, telecomSenderPhone: input.telecomSenderPhone ?? null },
          actor as never,
        ),
      );
      if (!result.idempotentReplay) {
        // تدقيقٌ إلحاقيّ best-effort خارج معاملة الخدمة (نمط المحطة كلّها — collectOnInvoice ش١):
        // الأثر الماليّ البنيويّ (receipts + orderPayments بshiftId وcreatedBy) داخل المعاملة أصلاً.
        await logAudit(ctx, {
          action: "reception.collectDeposit",
          entityType: "receptionDraft",
          entityId: input.draftId,
          oldValue: { heldBefore: result.heldBefore },
          newValue: {
            paymentId: result.paymentId,
            amount: input.amount,
            method: input.method,
            collectedIntoShiftId: result.shiftId,
            collectedTotal: result.collectedTotal,
          },
        });
      }
      return result;
    }),

  /** ردّ عربونٍ محتجز — بطريقة القبض حتماً، مربوطاً بأمّه، بمبلغٍ <= المتبقّي (I17).
   *  refundShiftId: عند تعدّد الدرج النقديّ المفتوح بالفرع يلزم تحديد أيّها يخرج منه النقد
   *  (مراجعة ش٤ — كان الردّ النقديّ ميتاً طوال ساعات العمل بورديتين، نمط workOrderRouter). */
  refundDeposit: workordersCashierProcedure
    .input(
      z.object({
        paymentId: z.number().int().positive(),
        amount: positiveMoneyString,
        reason: z.string().trim().min(5).max(300),
        refundShiftId: z.number().int().positive().optional(),
        clientRequestId: z.string().min(8).max(80),
        // قرار المالك (ب، ٨/٨): ردّ العربون النقديّ عبر ورديةٍ أخرى/بعد الإغلاق يلزمه اعتماد
        // مدير. الكاشير يُمرّر بيانات مديرٍ آخر فتُتحقَّق خادمياً بنفس مسار تجاوز الخصم/الائتمان.
        managerApproval: z.object({ email: z.string().min(1), password: z.string().min(1) }).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const actor = {
        userId: ctx.user.id,
        branchId: ctx.user.branchId != null ? Number(ctx.user.branchId) : null,
        role: ctx.user.role,
      };
      // اعتماد المدير (اختياريّ): يُتحقَّق بالمُتحقِّق القانونيّ الوحيد verifyManagerApproval
      // (حدّ معدّل + توقيت ثابت + SOD «لا اعتماد ذاتيّ» + عزل فرع). النجاح ⇒ authorizedByManager
      // فتتجاوز الخدمة بوّابة «نقد عبر وردية». (الفاعل المرتفع أصلاً يمرّ عبر elevated داخلها.)
      let authorizedByManager = false;
      if (input.managerApproval) {
        await verifyManagerApproval(
          input.managerApproval,
          ctx,
          ctx.user.branchId != null ? Number(ctx.user.branchId) : 0,
        );
        authorizedByManager = true;
      }
      const result = await retryOnDeadlock(() =>
        refundDeposit(input, actor as never, {
          refundShiftId: input.refundShiftId ?? null,
          authorizedByManager,
        }),
      );
      if (!result.idempotentReplay) {
        await logAudit(ctx, {
          action: "reception.refundDeposit",
          entityType: "orderPayment",
          entityId: input.paymentId,
          oldValue: { refundableBefore: result.refundableBefore },
          newValue: {
            amount: input.amount,
            reason: input.reason,
            refundReceiptId: result.refundReceiptId,
            refundShiftId: result.shiftId,
            ...(authorizedByManager ? { authorizedByManager: true } : {}),
          },
        });
      }
      return result;
    }),

  /** سجلّ عرابين طلبٍ محفوظ (القبض/التطبيق/الردّ) + الصافي المحتجز — بعزل الفرع (IDOR). */
  paymentsOf: workordersCashierProcedure
    .input(z.object({ draftId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      const actor = {
        userId: ctx.user.id,
        branchId: ctx.user.branchId != null ? Number(ctx.user.branchId) : null,
        role: ctx.user.role,
      };
      return listDraftPayments(input.draftId, actor as never);
    }),

  // ── ش٢ — المسوّدة المُرقّاة (§٨.٢: السلّة محليّةٌ بالافتراض؛ الترقية عند أوّل سببٍ حقيقيّ) ──
  draftPromote: workordersExecProcedure
    .input(z.object({
      branchId: z.number().int().positive().nullish(),
      shiftId: z.number().int().positive().nullish(),
      header: draftHeaderSchema,
      lines: z.array(draftLineSchema).max(100),
    }))
    .mutation(async ({ input, ctx }) => {
      const branchId = effectiveBranch(ctx, input.branchId);
      if (!branchId) throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
      assertDraftImages(input.lines);
      const actor = { userId: ctx.user.id, branchId, role: ctx.user.role };
      const res = await promoteDraft({ branchId, shiftId: input.shiftId, header: input.header, lines: input.lines }, actor as never);
      await logAudit(ctx, {
        action: "reception.draftPromote",
        entityType: "receptionDraft",
        entityId: res.draftId,
        newValue: { draftNumber: res.draftNumber, lines: input.lines.length, total: res.total },
      });
      return res;
    }),

  draftGet: workordersExecProcedure
    .input(z.object({ draftId: z.number().int().positive() }))
    .query(({ input, ctx }) => {
      const actor = { userId: ctx.user.id, branchId: ctx.user.branchId != null ? Number(ctx.user.branchId) : null, role: ctx.user.role };
      return getDraft(input.draftId, actor as never);
    }),

  draftList: workordersExecProcedure
    .input(z.object({
      branchId: z.number().int().positive().nullish(),
      mine: z.boolean().optional(),
      status: z.enum(["OPEN", "COMMITTED", "CANCELLED", "EXPIRED"]).optional(),
      q: z.string().trim().max(80).optional(),
      cursor: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }))
    .query(({ input, ctx }) => {
      const branchId = effectiveBranch(ctx, input.branchId);
      if (!branchId) throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
      const actor = { userId: ctx.user.id, branchId, role: ctx.user.role };
      return listDrafts({ ...input, branchId }, actor as never);
    }),

  draftSync: workordersExecProcedure
    .input(z.object({
      draftId: z.number().int().positive(),
      version: z.number().int().min(0),
      header: draftHeaderSchema,
      lines: z.array(draftLineSchema).max(100),
    }))
    .mutation(async ({ input, ctx }) => {
      assertDraftImages(input.lines);
      const actor = { userId: ctx.user.id, branchId: ctx.user.branchId != null ? Number(ctx.user.branchId) : null, role: ctx.user.role };
      const res = await syncDraft(input, actor as never);
      // I22: تدقيقٌ بقبل/بعد للمبالغ والعناوين فقط — لا designImages/printSpec في الحمولة أبداً.
      await logAudit(ctx, {
        action: "reception.draftSync",
        entityType: "receptionDraft",
        entityId: input.draftId,
        oldValue: res.auditBefore,
        newValue: { total: res.totals.total, lines: input.lines.length },
      });
      return { version: res.version, totals: res.totals };
    }),

  /** ش٣ — التثبيت: المسوّدة تصير مساراً إنتاجياً بذرّيةٍ كاملة (§٧.٣). خلف بوّابة **الكاشير**
   *  (المال) لا exec — فنّي الطباعة يحرّر ولا يثبّت (V7: treasury=NONE ⇒ لا وردية أصلاً). */
  draftCommit: workordersCashierProcedure
    .input(z.object({
      draftId: z.number().int().positive(),
      version: z.number().int().min(0),
      expectedTotal: positiveMoneyString,
      shiftId: z.number().int().positive(),
      collectNow: z.object({
        amount: positiveMoneyString,
        method: inboundPaymentMethod,
        reference: z.string().trim().max(100).nullish(),
      }).nullish(),
      cashRoundIQD: z.boolean().optional(),
      // ش٦ (V15): أجرة توصيل الطلب المقبوضة الآن أمانةً للمندوب — نقداً في الدرج حتماً.
      deliveryFeeHeld: positiveMoneyString.nullish(),
      // ش٧: إسناد الطلب لمندوبٍ داخل معاملة التثبيت — المتبقّي عهدةٌ عليه لا نقدٌ في الدرج.
      delivery: z.object({
        partyId: z.number().int().positive(),
        fee: nonNegMoneyString.nullish(),
        feeCollection: z.enum(["COURIER", "COUNTER", "SHOP"]).nullish(),
        recipientName: z.string().trim().max(255).nullish(),
        recipientPhone: z.string().trim().max(32).nullish(),
        address: z.string().trim().max(500).nullish(),
      }).nullish(),
      // ملاحظة ١.٨: الكوبون **مرفوض** على مسار التثبيت في v1 — يُطبَّق داخل createSaleInTx
      // فينسف expectedTotal وأرضية moneyLocked. الحقل موجود ليُرفض برسالةٍ صريحة لا صمتاً.
      couponCode: z.string().nullish(),
      // الاستقبال (٨/٨): تأكيد الموظّف توفّر الأصناف غير المجرودة فيزيائياً (بيع بالسالب لطلب COD في وضع الافتتاح).
      openingSellUnavailableConfirmed: z.boolean().optional(),
      managerApproval: z.object({ email: z.string().min(1), password: z.string().min(1) }).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      if (input.couponCode?.trim()) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "الكوبونات غير مدعومة على تثبيت الطلب المحفوظ — طبّق الكوبون في طلبٍ مباشرٍ من السلة",
        });
      }
      if (input.collectNow && input.collectNow.method !== "CASH" && !input.collectNow.reference?.trim()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "مرجع عملية البطاقة/التحويل مطلوب" });
      }
      const elevated = ctx.user.role === "admin"; // عزل مدير الفرع (قرار المالك ١٢/٨): المالك/الأدمن فقط يعبُران
      if (!elevated && ctx.user.branchId == null) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
      }
      let approvedBy: number | null = null;
      if (input.managerApproval) {
        approvedBy = await verifyManagerApproval(
          input.managerApproval,
          ctx,
          ctx.user.branchId != null ? Number(ctx.user.branchId) : 0,
        );
      }
      const actor = {
        userId: ctx.user.id,
        branchId: ctx.user.branchId != null ? Number(ctx.user.branchId) : null,
        role: ctx.user.role,
      };
      // ش٥ (مراجعة عدائية ٦/٨): سلّتا زين متزامنتان تتصادمان حتماً على قفل فجوة نطاق TELECOM
      // (فحص الكود الأحاديّ على نطاقٍ فارغ) — retryOnDeadlock يعيد الخاسرة نظيفةً (المفاتيح
      // تُكتب داخل المعاملة المُدحرَجة فلا أثر، والمحاولة التالية تمرّ أو تعود replay).
      const result = await retryOnDeadlock(() => commitDraft(
        {
          draftId: input.draftId,
          version: input.version,
          expectedTotal: input.expectedTotal,
          shiftId: input.shiftId,
          collectNow: input.collectNow ?? null,
          cashRoundIQD: input.cashRoundIQD,
          deliveryFeeHeld: input.deliveryFeeHeld ?? null,
          delivery: input.delivery ?? null,
          openingSellUnavailableConfirmed: input.openingSellUnavailableConfirmed === true,
          priceOverrideApproved: elevated || approvedBy != null,
          // ش٦ (§٩.٣): هويّة المُقِرّ — المدير المصادِق، أو الفاعل المرتفع نفسه (سلطة ذاتية).
          priceApprovedBy: approvedBy ?? (elevated ? ctx.user.id : null),
        },
        actor as never,
      ));
      if (!result.idempotentReplay) {
        await logAudit(ctx, {
          action: "reception.draftCommit",
          entityType: "receptionDraft",
          entityId: input.draftId,
          newValue: {
            draftNumber: result.draftNumber,
            invoiceId: result.regularSale?.invoiceId ?? null,
            printInvoiceId: result.printSale?.invoiceId ?? null,
            workOrderIds: result.workOrders.map((w) => w.workOrderId),
            collected: input.collectNow?.amount ?? null,
            method: input.collectNow?.method ?? null,
            ...(approvedBy != null ? { discountApprovedBy: approvedBy } : {}),
          },
        });
      }
      return result;
    }),

  draftCancel: workordersExecProcedure
    .input(z.object({
      draftId: z.number().int().positive(),
      version: z.number().int().min(0),
      reason: z.string().trim().min(3).max(500),
    }))
    .mutation(async ({ input, ctx }) => {
      const actor = { userId: ctx.user.id, branchId: ctx.user.branchId != null ? Number(ctx.user.branchId) : null, role: ctx.user.role };
      const res = await cancelDraft(input, actor as never);
      await logAudit(ctx, {
        action: "reception.draftCancel",
        entityType: "receptionDraft",
        entityId: input.draftId,
        newValue: { reason: input.reason },
      });
      return res;
    }),
});
