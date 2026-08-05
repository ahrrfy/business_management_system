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
  collectOnReceptionInvoice,
  commitDraft,
  getDraft,
  listDrafts,
  listReceptionInvoices,
  promoteDraft,
  syncDraft,
} from "../services/reception";
import { verifyManagerApproval } from "./saleRouter";
import { router, workordersCashierProcedure, workordersExecProcedure } from "../trpc";
import { logAudit } from "../services/auditService";

/** عزل الفرع (نمط deliveryRouter.effectiveBranch): المرتفعون يعبرون بـbranchId صريح؛
 *  غيرهم يُجبَرون على فرعهم، وغيابه = FORBIDDEN. */
function effectiveBranch(ctx: { user: { role?: string | null; branchId?: number | null } }, requested?: number | null) {
  const elevated = ctx.user.role === "admin" || ctx.user.role === "manager";
  if (elevated) return requested ?? (ctx.user.branchId != null ? Number(ctx.user.branchId) : null);
  return ctx.user.branchId != null ? Number(ctx.user.branchId) : null;
}

const payMethodEnum = z.enum(["CASH", "CARD", "TRANSFER", "WALLET"]);

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
  /** طابور فواتير المحطة: keyset + فلاتر (§٨.٥ — الافتراض «ورديتي» يقرّره العميل بتمرير shiftIds). */
  invoiceQueue: workordersCashierProcedure
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
        method: payMethodEnum,
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
        method: payMethodEnum,
        reference: z.string().trim().max(100).nullish(),
      }).nullish(),
      cashRoundIQD: z.boolean().optional(),
      // ملاحظة ١.٨: الكوبون **مرفوض** على مسار التثبيت في v1 — يُطبَّق داخل createSaleInTx
      // فينسف expectedTotal وأرضية moneyLocked. الحقل موجود ليُرفض برسالةٍ صريحة لا صمتاً.
      couponCode: z.string().nullish(),
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
      const elevated = ctx.user.role === "admin" || ctx.user.role === "manager";
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
      const result = await commitDraft(
        {
          draftId: input.draftId,
          version: input.version,
          expectedTotal: input.expectedTotal,
          shiftId: input.shiftId,
          collectNow: input.collectNow ?? null,
          cashRoundIQD: input.cashRoundIQD,
          priceOverrideApproved: elevated || approvedBy != null,
        },
        actor as never,
      );
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
