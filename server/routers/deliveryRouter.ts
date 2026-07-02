import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { branchScopedProcedure, cashierProcedure, managerProcedure, router } from "../trpc";
import {
  createDeliveryParty,
  dispatchToDelivery,
  getDeliveryParty,
  getDeliveryPartyStatement,
  listConsignmentsForParty,
  listDeliveryParties,
  listOpenConsignments,
  listReadyForDispatch,
  recordDeliveryRemittance,
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
  listParties: branchScopedProcedure
    .input(z.object({ activeOnly: z.boolean().optional(), search: z.string().optional() }).optional())
    .query(({ input, ctx }) =>
      listDeliveryParties({ branchId: ctx.scopedBranchId, activeOnly: input?.activeOnly, search: input?.search }),
    ),

  getParty: branchScopedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      await assertPartyInScope(input.id, ctx.scopedBranchId);
      return getDeliveryParty(input.id);
    }),

  createParty: managerProcedure
    .input(
      z.object({
        partyType: partyKind,
        name: z.string().min(1).max(255),
        phone: z.string().max(20).nullish(),
        phone2: z.string().max(20).nullish(),
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
  readyForDispatch: branchScopedProcedure.query(({ ctx }) => listReadyForDispatch(ctx.scopedBranchId)),

  openConsignments: branchScopedProcedure
    .input(z.object({ partyId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      await assertPartyInScope(input.partyId, ctx.scopedBranchId);
      return listOpenConsignments(input.partyId);
    }),

  consignments: branchScopedProcedure
    .input(z.object({ partyId: z.number().int().positive(), openOnly: z.boolean().optional() }))
    .query(async ({ input, ctx }) => {
      await assertPartyInScope(input.partyId, ctx.scopedBranchId);
      return listConsignmentsForParty(input.partyId, input.openOnly ?? false);
    }),

  partyStatement: branchScopedProcedure
    .input(z.object({ partyId: z.number().int().positive(), from: z.string().optional(), to: z.string().optional() }))
    .query(async ({ input, ctx }) => {
      await assertPartyInScope(input.partyId, ctx.scopedBranchId);
      return getDeliveryPartyStatement(input.partyId, input.from, input.to);
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
      const res = await dispatchToDelivery(input, actorOf(ctx));
      await logAudit(ctx, { action: "delivery.dispatch", entityType: "deliveryConsignment", entityId: res.consignmentId, newValue: { workOrderId: input.workOrderId, partyId: input.partyId, codAmount: res.codAmount } });
      return res;
    }),

  // تسجيل توريد (قبض الصافي) — يتطلّب وردية مفتوحة (النقد يدخل الدرج) ⇒ cashierProcedure.
  recordRemittance: cashierProcedure
    .input(
      z.object({
        partyId: z.number().int().positive(),
        branchId: z.number().int().positive().nullish(),
        shiftType: z.enum(["RECEPTION", "RETAIL"]).optional(),
        lines: z.array(z.object({ consignmentId: z.number().int().positive(), collectedAmount: moneyStr })).min(1),
        clientRequestId: z.string().max(64).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const branchId = effectiveBranch(ctx, input.branchId);
      const res = await recordDeliveryRemittance({ branchId, partyId: input.partyId, lines: input.lines, shiftType: input.shiftType, clientRequestId: input.clientRequestId }, actorOf(ctx));
      await logAudit(ctx, { action: "delivery.remit", entityType: "deliveryRemittance", entityId: res.remittanceId, newValue: { partyId: input.partyId, collectedTotal: res.collectedTotal, feesTotal: res.feesTotal, netRemitted: res.netRemitted, shortfallTotal: res.shortfallTotal } });
      return res;
    }),

  // إرجاع إرسالية (عكس بيع + مخزون + عهدة) — مديرٌ فقط (إجراء تصحيحيّ).
  returnConsignment: managerProcedure
    .input(z.object({ consignmentId: z.number().int().positive(), clientRequestId: z.string().max(64).nullish() }))
    .mutation(async ({ input, ctx }) => {
      const res = await returnConsignment(input.consignmentId, { ...actorOf(ctx), clientRequestId: input.clientRequestId });
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
      const branchId = effectiveBranch(ctx, input.branchId);
      const res = await settleDeliveryBalance({ branchId, partyId: input.partyId, amount: input.amount, shiftType: input.shiftType, notes: input.notes, clientRequestId: input.clientRequestId }, actorOf(ctx));
      await logAudit(ctx, { action: "delivery.settle", entityType: "deliveryParty", entityId: input.partyId, newValue: { amount: input.amount } });
      return res;
    }),

  // شطب عجز عهدة (إبراء دَين) — مديرٌ فقط (SOD: القابض لا يُبرئ عجزه).
  writeOff: managerProcedure
    .input(
      z.object({
        partyId: z.number().int().positive(),
        branchId: z.number().int().positive().nullish(),
        amount: moneyStr,
        reason: z.string().min(3).max(500),
        clientRequestId: z.string().max(64).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const branchId = effectiveBranch(ctx, input.branchId);
      const res = await writeOffDeliveryShortfall({ branchId, partyId: input.partyId, amount: input.amount, reason: input.reason, clientRequestId: input.clientRequestId }, actorOf(ctx));
      await logAudit(ctx, { action: "delivery.writeOff", entityType: "deliveryParty", entityId: input.partyId, newValue: { amount: input.amount, reason: input.reason } });
      return res;
    }),
});
