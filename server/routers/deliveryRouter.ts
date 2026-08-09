import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { cashierProcedure, deliveryReadProcedure, managerProcedure, router, storeFulfillProcedure, storeManagerProcedure, workordersCashierProcedure } from "../trpc";
import { retryOnDup } from "../lib/retryDup";
import { retryOnDeadlock } from "../lib/retryDeadlock";
import {
  createDeliveryParty,
  dispatchInvoiceToDelivery,
  dispatchToDelivery,
  getDeliveryParty,
  getDeliveryPartyStatement,
  listConsignmentsForParty,
  listCourierAccounts,
  listDeliveryParties,
  listOpenConsignments,
  listPartyRemittances,
  listReadyForDispatch,
  recordDeliveryRemittance,
  recoverDeliveryWriteOff,
  returnConsignment,
  setDeliveryPartyActive,
  settleDeliveryBalance,
  updateDeliveryParty,
  writeOffDeliveryShortfall,
} from "../services/deliveryService";
import { logAudit } from "../services/auditService";

const partyKind = z.enum(["INDIVIDUAL", "COMPANY"]);
const moneyStr = z.string().regex(/^\d+(\.\d{1,2})?$/, "مبلغ غير صالح");

function actorOf(ctx: { user: { id: number; branchId?: number | null; role?: string } }) {
  return {
    userId: ctx.user.id,
    branchId: ctx.user.branchId != null ? Number(ctx.user.branchId) : undefined,
    role: ctx.user.role,
  };
}
function effectiveBranch(ctx: { user: { role?: string; branchId?: number | null } }, requested?: number | null) {
  const elevated = ctx.user.role === "admin" || ctx.user.role === "manager";
  return elevated ? (requested ?? (ctx.user.branchId != null ? Number(ctx.user.branchId) : 0)) : Number(ctx.user.branchId);
}
// نطاق فرع الفاعل لفحص الملكية (مثيل ctx.scopedBranchId لكن على cashierProcedure الذي لا يوفّره):
// المرتفعون (admin/manager) عابرو الفروع ⇒ null؛ غيرهم مقيَّدون بفرعهم (requireOwnBranch يضمن branchId).
function scopedBranchOf(ctx: { user: { role?: string; branchId?: number | null } }): number | null {
  const elevated = ctx.user.role === "admin" || ctx.user.role === "manager";
  return elevated ? null : (ctx.user.branchId != null ? Number(ctx.user.branchId) : null);
}

// IDOR (تدقيق ٢/٧): قراءات جهة التوصيل بالمعرّف (getParty/consignments/partyStatement) كانت تمرّر
// partyId بلا التحقّق أن الجهة تخصّ فرع القارئ ⇒ تسريب بيانات جهات فروع أخرى. نتحقّق من الملكية:
// غير المرتفعين (scopedBranchId != null) لا يقرؤون جهة فرعٍ آخر (الجهات ذات الفرع null مشتركة ⇒ مسموحة).
async function assertPartyInScope(partyId: number, scopedBranchId: number | null) {
  if (scopedBranchId == null) return; // admin/manager عابرو الفروع
  const party = await getDeliveryParty(partyId);
  if (party && party.branchId != null && Number(party.branchId) !== scopedBranchId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "جهة التوصيل تخصّ فرعاً آخر" });
  }
}

export const deliveryRouter = router({
  // قائمة جهات التوصيل + عهدتها (branch-scoped: غير المرتفعين يَرون فرعهم فقط).
  listParties: deliveryReadProcedure
    .input(z.object({ activeOnly: z.boolean().optional(), search: z.string().optional() }).optional())
    .query(({ input, ctx }) =>
      listDeliveryParties({ branchId: ctx.scopedBranchId, activeOnly: input?.activeOnly, search: input?.search }),
    ),

  getParty: deliveryReadProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      await assertPartyInScope(input.id, ctx.scopedBranchId);
      return getDeliveryParty(input.id);
    }),

  // حسابات المناديب (دور courier) لربطها بجهة — لمنتقي الربط في نموذج الجهة (مدير).
  courierAccounts: managerProcedure.query(() => listCourierAccounts()),

  createParty: managerProcedure
    .input(
      z.object({
        partyType: partyKind,
        name: z.string().min(1).max(255),
        phone: z.string().max(20).nullish(),
        phone2: z.string().max(20).nullish(),
        userId: z.number().int().positive().nullish(),
        branchId: z.number().int().positive().nullish(),
        nationalId: z.string().max(40).nullish(),
        vehicleInfo: z.string().max(120).nullish(),
        defaultFee: moneyStr.nullish(),
        floatLimit: moneyStr.nullish(),
        notes: z.string().max(1000).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const res = await createDeliveryParty(input, actorOf(ctx));
      await logAudit(ctx, { action: "delivery.party.create", entityType: "deliveryParty", entityId: res.id, newValue: { name: input.name, partyType: input.partyType } });
      return res;
    }),

  updateParty: managerProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        partyType: partyKind.optional(),
        name: z.string().min(1).max(255).optional(),
        phone: z.string().max(20).nullish(),
        phone2: z.string().max(20).nullish(),
        userId: z.number().int().positive().nullish(),
        branchId: z.number().int().positive().nullish(),
        nationalId: z.string().max(40).nullish(),
        vehicleInfo: z.string().max(120).nullish(),
        defaultFee: moneyStr.nullish(),
        floatLimit: moneyStr.nullish(),
        notes: z.string().max(1000).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const res = await updateDeliveryParty(input, actorOf(ctx));
      await logAudit(ctx, { action: "delivery.party.update", entityType: "deliveryParty", entityId: input.id, newValue: { id: input.id } });
      return res;
    }),

  setPartyActive: managerProcedure
    .input(z.object({ id: z.number().int().positive(), isActive: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const res = await setDeliveryPartyActive(input.id, input.isActive, actorOf(ctx));
      await logAudit(ctx, { action: "delivery.party.setActive", entityType: "deliveryParty", entityId: input.id, newValue: { isActive: input.isActive } });
      return res;
    }),

  // ─── قراءات الشاشة ───
  readyForDispatch: deliveryReadProcedure.query(({ ctx }) => listReadyForDispatch(ctx.scopedBranchId)),

  openConsignments: deliveryReadProcedure
    .input(z.object({ partyId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      await assertPartyInScope(input.partyId, ctx.scopedBranchId);
      return listOpenConsignments(input.partyId);
    }),

  consignments: deliveryReadProcedure
    .input(z.object({ partyId: z.number().int().positive(), openOnly: z.boolean().optional() }))
    .query(async ({ input, ctx }) => {
      await assertPartyInScope(input.partyId, ctx.scopedBranchId);
      return listConsignmentsForParty(input.partyId, input.openOnly ?? false);
    }),

  partyStatement: deliveryReadProcedure
    .input(z.object({ partyId: z.number().int().positive(), from: z.string().optional(), to: z.string().optional() }))
    .query(async ({ input, ctx }) => {
      await assertPartyInScope(input.partyId, ctx.scopedBranchId);
      return getDeliveryPartyStatement(input.partyId, input.from, input.to);
    }),

  // سجل توريدات جهة (٩/٨): أثر التوريد كان إيصالاً حرارياً يُطبع مرة واحدة — الآن يُسرَد ويُتتبَّع.
  remittances: deliveryReadProcedure
    .input(z.object({
      partyId: z.number().int().positive(),
      // YYYY-MM-DD حصراً — نصٌّ حرّ كان يبني Date غير صالح فيتفجّر 500 بدل BAD_REQUEST.
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح").optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح").optional(),
      limit: z.number().int().positive().max(300).optional(),
    }))
    .query(async ({ input, ctx }) => {
      await assertPartyInScope(input.partyId, ctx.scopedBranchId);
      return listPartyRemittances(input.partyId, { from: input.from, to: input.to, limit: input.limit });
    }),

  // ─── التحوّلات ───
  // إرسال طلب جاهز عبر مندوب (يُصدر فاتورة COD + عهدة) — مالٌ/نقد ⇒ cashierProcedure.
  dispatch: cashierProcedure
    .input(
      z.object({
        workOrderId: z.number().int().positive(),
        partyId: z.number().int().positive(),
        deliveryFee: moneyStr.nullish(),
        recipientName: z.string().max(255).nullish(),
        recipientPhone: z.string().max(20).nullish(),
        deliveryAddress: z.string().max(1000).nullish(),
        clientRequestId: z.string().max(64).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // IDOR كتابة (F7 تدقيق ٢/٧): كاشير فرعٍ لا يُرسِل على جهة فرعٍ آخر (نظير حارس القراءات).
      await assertPartyInScope(input.partyId, scopedBranchOf(ctx));
      // NUMBERING-RACE (تدقيق ٢/٧): ترقيم الإرسالية يعتمد قيداً فريداً كحارس أخير — نعيد المحاولة على التصادم.
      const res = await retryOnDup(() => dispatchToDelivery(input, actorOf(ctx)));
      await logAudit(ctx, { action: "delivery.dispatch", entityType: "deliveryConsignment", entityId: res.consignmentId, newValue: { workOrderId: input.workOrderId, partyId: input.partyId, codAmount: res.codAmount } });
      return res;
    }),

  // ش١ (٥/٨): receptionQueue انتقل إلى reception.invoiceQueue (راوتر المحطة الجديد) بترقيمٍ
  // keyset وفلاتر — حُذف هنا في نفس الـPR (حارس check:orphans: نقلٌ = حذفُ القديم معاً).

  // 5/8: isnad fatura qa'ima lil-tawseel (bay' mubashir bila amr shughl).
  // Nafs bawwabat receptionQueue (workorders=FULL) — a'la min delivery.dispatch al-qadim
  // (cashierProcedure kham) wa-la tuda''if shay'an qa'iman.
  dispatchInvoice: workordersCashierProcedure
    .input(
      z.object({
        invoiceId: z.number().int().positive(),
        partyId: z.number().int().positive(),
        deliveryFee: moneyStr.nullish(),
        feeCollection: z.enum(["COURIER", "COUNTER", "SHOP"]).nullish(),
        recipientName: z.string().max(255).nullish(),
        recipientPhone: z.string().max(20).nullish(),
        deliveryAddress: z.string().max(1000).nullish(),
        clientRequestId: z.string().max(64).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await assertPartyInScope(input.partyId, scopedBranchOf(ctx));
      const res = await retryOnDup(() => dispatchInvoiceToDelivery(input, actorOf(ctx)));
      await logAudit(ctx, {
        action: "delivery.dispatchInvoice",
        entityType: "deliveryConsignment",
        entityId: res.consignmentId,
        newValue: { invoiceId: input.invoiceId, partyId: input.partyId, codAmount: res.codAmount, deliveryFee: res.deliveryFee },
      });
      return res;
    }),

  // تسجيل توريد (قبض الصافي) — يتطلّب وردية مفتوحة (النقد يدخل الدرج) ⇒ cashierProcedure.
  recordRemittance: cashierProcedure
    .input(
      z.object({
        partyId: z.number().int().positive(),
        branchId: z.number().int().positive().nullish(),
        shiftType: z.enum(["RECEPTION", "RETAIL"]).optional(),
        lines: z
          .array(z.object({ consignmentId: z.number().int().positive(), collectedAmount: moneyStr }))
          .min(1)
          .superRefine((lines, ctx) => {
            const seen = new Set<number>();
            lines.forEach((line, index) => {
              if (seen.has(line.consignmentId)) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  path: [index, "consignmentId"],
                  message: "الإرسالية مكررة داخل التوريد",
                });
              }
              seen.add(line.consignmentId);
            });
          }),
        countedCash: moneyStr,
        clientRequestId: z.string().max(64).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // IDOR كتابة (F7): كاشير فرعٍ لا يُوَرِّد على جهة فرعٍ آخر.
      await assertPartyInScope(input.partyId, scopedBranchOf(ctx));
      const branchId = effectiveBranch(ctx, input.branchId);
      const res = await retryOnDup(() =>
        recordDeliveryRemittance({ branchId, partyId: input.partyId, lines: input.lines, countedCash: input.countedCash, shiftType: input.shiftType, clientRequestId: input.clientRequestId }, actorOf(ctx)),
      );
      await logAudit(ctx, { action: "delivery.remit", entityType: "deliveryRemittance", entityId: res.remittanceId, newValue: { partyId: input.partyId, collectedTotal: res.collectedTotal, feesTotal: res.feesTotal, netRemitted: res.netRemitted, shortfallTotal: res.shortfallTotal } });
      return res;
    }),

  // إرجاع إرسالية (عكس بيع + مخزون + عهدة + ذمّة العميل).
  // قرار المالك (٦/٨/٢٦): **موظّف التسوية يُنفّذها** لا المدير وحده — هذه ليست «مرتجع زبون»
  // (م٧) بل بضاعةٌ لم تُسلَّم أصلاً وعادت مع المندوب، وحصرُها بالمدير كان يوقف التسوية حتى
  // يحضر. الضبط بالإفصاح: كل إرجاعٍ يُسجَّل في التدقيق باسم فاعله (logAudit أدناه)، والعملية
  // محصورةٌ بنيوياً بإرساليةٍ لم يُحصَّل منها شيء وفاتورةٍ لم يُرجَع منها سلفاً.
  //
  // القرار كان **مُعلَّقاً** (أُعيدت مؤقّتاً لـmanagerProcedure) لأنّ الفتح المباشر تركها بلا
  // عزل فرع: بخلاف remit/settle المجاورتين لا تستدعي assertPartyInScope ولا تقارن الخدمةُ
  // actor.branchId بفرع الإرسالية ⇒ كاشير فرعٍ يعكس فاتورة فرعٍ آخر ومخزونه ويسحب من درجه
  // (مراجعة Codex على PR #495). **وقد نُفِّذ الآن بالشكل الصحيح المطلوب حرفياً**:
  //   (١) بوّابة **وحدة** لا دورٍ خام: `storeFulfillProcedure` = مفتاح `store=FULL` (قالب
  //       الكاشير يملكه والمنح/التقييد الصريح يُطاع) + فرعٌ مُسنَد إلزاميّ ⇒ authz-guard أخضر.
  //   (٢) فحص ملكية الفرع **داخل** `returnConsignment` قبل الردّ الـidempotent وقبل المعاملة
  //       المدمِّرة (الجهة تُشتقّ من الإرسالية لا من المدخل، فلا يحميها حارسٌ راوتريّ).
  returnConsignment: storeFulfillProcedure
    .input(z.object({
      consignmentId: z.number().int().positive(),
      clientRequestId: z.string().max(64).nullish(),
      // اختياري: يُلزَم فقط حين يتعدّد الدرج المفتوح بالفرع (resolveBranchCashShiftTx يرمي طالباً
      // التحديد حينها) — يختار المستخدم أيّ درجٍ سيخرج منه ردّ العربون فعلياً.
      refundShiftId: z.number().int().positive().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      // ٩/٨: ترتيب أقفال الإرجاع (إرسالية←جهة) يعاكس التوريد/الشطب (جهة←إرسالية) — تنافسٌ
      // لحظي بينهما قد يُفصَل بـdeadlock من MySQL؛ إعادة المحاولة تمتصّه (نمط collect.ts).
      const res = await retryOnDeadlock(() => returnConsignment(input.consignmentId, {
        ...actorOf(ctx),
        clientRequestId: input.clientRequestId,
        refundShiftId: input.refundShiftId ?? null,
      }));
      await logAudit(ctx, { action: "delivery.return", entityType: "deliveryConsignment", entityId: input.consignmentId, newValue: { invoiceId: (res as { invoiceId?: number }).invoiceId } });
      return res;
    }),

  // الجهة تدفع عجزاً نقداً — يتطلّب وردية ⇒ cashierProcedure.
  settle: cashierProcedure
    .input(
      z.object({
        partyId: z.number().int().positive(),
        branchId: z.number().int().positive().nullish(),
        amount: moneyStr,
        shiftType: z.enum(["RECEPTION", "RETAIL"]).optional(),
        notes: z.string().max(500).nullish(),
        clientRequestId: z.string().max(64).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // IDOR كتابة (F7): كاشير فرعٍ لا يُسوّي عهدة جهة فرعٍ آخر (وإلا يُحوّل نقدها لدرجه ويصفّر عهدتها).
      await assertPartyInScope(input.partyId, scopedBranchOf(ctx));
      const branchId = effectiveBranch(ctx, input.branchId);
      const res = await settleDeliveryBalance({ branchId, partyId: input.partyId, amount: input.amount, shiftType: input.shiftType, notes: input.notes, clientRequestId: input.clientRequestId }, actorOf(ctx));
      await logAudit(ctx, { action: "delivery.settle", entityType: "deliveryParty", entityId: input.partyId, newValue: { amount: input.amount } });
      return res;
    }),

  // شطب عجز عهدة (إبراء دَين) — مديرٌ فقط (SOD: القابض لا يُبرئ عجزه).
  // ٩/٨: consignmentId يوجّه الشطب لإرسالية بعينها (يقفلها WRITTEN_OFF ويقيّد فاتورتها) —
  // الشطب المجمّع محصور بالعهدة السائبة (الحارس في الخدمة).
  writeOff: managerProcedure
    .input(
      z.object({
        partyId: z.number().int().positive(),
        branchId: z.number().int().positive().nullish(),
        amount: moneyStr,
        reason: z.string().min(3).max(500),
        consignmentId: z.number().int().positive().nullish(),
        clientRequestId: z.string().max(64).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const branchId = effectiveBranch(ctx, input.branchId);
      const res = await retryOnDeadlock(() => writeOffDeliveryShortfall({ branchId, partyId: input.partyId, amount: input.amount, reason: input.reason, consignmentId: input.consignmentId, clientRequestId: input.clientRequestId }, actorOf(ctx)));
      await logAudit(ctx, { action: "delivery.writeOff", entityType: "deliveryParty", entityId: input.partyId, newValue: { amount: input.amount, reason: input.reason, consignmentId: input.consignmentId ?? null } });
      return res;
    }),

  // استرداد عجز مشطوب (٩/٨) — نقدٌ عاد بعد شطبه (لم يكن له أي مسار: settle يرفض تجاوز العهدة
  // الصفرية والتوريد يرفض الإرسالية المغلقة). يعكس الخسارة ويُدخل النقد الدرج. بوّابة مُبوَّبة
  // بوحدة (store FULL + manager) لا دوراً خاماً — نمط authz-guard المعتمد للنقاط الجديدة.
  recoverWriteOff: storeManagerProcedure
    .input(
      z.object({
        partyId: z.number().int().positive(),
        branchId: z.number().int().positive().nullish(),
        amount: moneyStr,
        shiftType: z.enum(["RECEPTION", "RETAIL"]).optional(),
        notes: z.string().max(500).nullish(),
        clientRequestId: z.string().max(64).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const branchId = effectiveBranch(ctx, input.branchId);
      const res = await recoverDeliveryWriteOff({ branchId, partyId: input.partyId, amount: input.amount, shiftType: input.shiftType, notes: input.notes, clientRequestId: input.clientRequestId }, actorOf(ctx));
      await logAudit(ctx, { action: "delivery.recoverWriteOff", entityType: "deliveryParty", entityId: input.partyId, newValue: { amount: input.amount } });
      return res;
    }),
});
