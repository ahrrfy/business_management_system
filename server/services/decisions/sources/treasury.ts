/**
 * مصادرُ الخزينة: السندات، المصاريف، تصحيح الاستحقاق، فرق النقد.
 *
 * ⭐ **البوّابة الفعليّة لا بوّابة الراوتر وحدها:** `vouchers.approve` على `treasuryManagerProcedure`
 * لكنّ `approveVoucher` نفسها ترفض غيرَ المالك («اعتماد السندات محصور بحساب مالك نشط»)؛
 * فالمصدر يعلن `OWNER` — إظهارُ صفٍّ يرفضه الخادم حتماً أسوأ من إخفائه.
 */
import { and, eq, isNotNull, isNull, notExists, sql } from "drizzle-orm";
import { cashVarianceApprovalTrigger, voucherApprovalTrigger } from "@shared/approvalTriggers";
import { CASH_VARIANCE_REASON_LABELS } from "@shared/cashVariance";
import { decisionSubkindLabel } from "@shared/decisionRegistry";
import { expenseBucketLabel } from "@shared/expenseCategories";
import {
  accrualCorrectionRequests,
  accrualObligations,
  cashVarianceCases,
  expenses,
  receipts,
  users,
} from "../../../../drizzle/schema";
import { approveAccrualCorrection, rejectAccrualCorrection } from "../../accounting/accrualCorrection";
import { approveCashVarianceCase, listCashVarianceCases, rejectCashVarianceCase } from "../../cashVarianceService";
import { approveExpense, rejectExpense } from "../../expenseService";
import { requireDb } from "../../tx";
import { approveVoucher, rejectVoucher } from "../../voucher/approval";
import { serviceActor } from "../gate";
import { buildRow, decided, defaultMessage } from "../rows";
import type { DecisionSource } from "../types";
import { branchIdsFor, branchNames, freshnessFrom, ids, scopeBranch, serviceBranchScopedIds, sodHidden, userNames } from "./common";

const TREASURY_GATE = { type: "MODULE", moduleKey: "treasury", roles: ["manager", "accountant"] } as const;

// ───────────────────────────── ١) السندات ─────────────────────────────

/**
 * [`voucherRouter.ts:153`](../../../routers/voucherRouter.ts) ⇐ `approveVoucher`/`rejectVoucher`.
 * الشروط مرآةُ `superApp.approvalInbox`: معلَّقٌ، ليس مصروفاً، ليس مربوطاً بفاتورة، وله رقمُ سند
 * (بلا رقمٍ ترفضه الخدمة بـ«السند غير موجود»).
 */
export const voucherSource: DecisionSource = {
  key: "treasury.voucher",
  kinds: ["treasury.voucher.approve", "treasury.voucher.reject"],
  gate: { type: "OWNER", moduleKey: "treasury" },
  supportedActions: ["APPROVE", "REJECT"],
  async list(actor, scope) {
    const branchId = scopeBranch(actor, scope);
    if (branchId === "NONE") return [];
    const db = requireDb();
    const rows = await db
      .select({
        id: receipts.id,
        voucherNumber: receipts.voucherNumber,
        amount: receipts.amount,
        direction: receipts.direction,
        paymentMethod: receipts.paymentMethod,
        description: receipts.description,
        counterpartyName: receipts.counterpartyName,
        branchId: receipts.branchId,
        createdBy: receipts.createdBy,
        createdByName: users.name,
        createdAt: receipts.createdAt,
        internalNote: receipts.internalNote,
      })
      .from(receipts)
      .leftJoin(users, eq(users.id, receipts.createdBy))
      .where(
        and(
          eq(receipts.status, "PENDING"),
          eq(receipts.approvalStatus, "PENDING_APPROVAL"),
          isNotNull(receipts.voucherNumber),
          isNull(receipts.invoiceId),
          notExists(db.select({ id: expenses.id }).from(expenses).where(eq(expenses.receiptId, receipts.id))),
          branchId == null ? undefined : eq(receipts.branchId, branchId),
        ),
      )
      .orderBy(sql`${receipts.createdAt} ASC`)
      .limit(200);
    const names = await branchNames(db, ids(rows.map((r) => r.branchId)));
    // قرار المالك (٣/٩/٢٦): المالك يعتمد سنده — لا إخفاء لصانع الطلب هنا.
    return rows.map((r) =>
      buildRow(
        {
          kind: "treasury.voucher.approve",
          id: Number(r.id),
          title: `${decisionSubkindLabel(r.direction)} ${r.voucherNumber ?? ""} · ${r.paymentMethod}`,
          subkind: decisionSubkindLabel(r.direction),
          party: r.counterpartyName,
          amount: r.amount,
          branchId: r.branchId == null ? null : Number(r.branchId),
          branchName: r.branchId == null ? null : (names.get(Number(r.branchId)) ?? null),
          requestedBy: r.createdBy == null ? null : Number(r.createdBy),
          requestedByName: r.createdByName ?? null,
          requestedAt: r.createdAt,
          summaryItems: [{ label: r.description ?? "بلا وصف", unitPrice: r.amount }],
          reason: r.description,
          trigger: voucherApprovalTrigger(r.direction, r.internalNote?.startsWith("VOUCHER_CANCELLATION") ? "VOUCHER_CANCELLATION" : null),
        },
        scope.now,
      ),
    );
  },
  freshness: (id) =>
    freshnessFrom(
      async () => {
        const [row] = await requireDb()
          .select({ status: receipts.status, approvalStatus: receipts.approvalStatus })
          .from(receipts)
          .where(eq(receipts.id, id))
          .limit(1);
        return row?.status === "PENDING" ? row.approvalStatus : undefined;
      },
      ["PENDING_APPROVAL"],
    ),
  async decide(input, actor) {
    const subject = `السند رقم ${input.id}`;
    if (input.action === "REJECT") {
      const res = await rejectVoucher(input.id, serviceActor(actor), input.reason ?? "");
      return decided(input, "REJECTED", `السند ${res.voucherNumber}: رُفض وسُجّل السبب.`);
    }
    const res = await approveVoucher(input.id, serviceActor(actor));
    return decided(input, "EXECUTED", res.replayed ? `${subject}: كان معتمداً من قبل — لا أثر ثانٍ.` : `السند ${res.voucherNumber}: اعتُمد وسُجّل أثره الماليّ.`);
  },
};

// ───────────────────────────── ٢) المصاريف ─────────────────────────────

/**
 * [`expenseRouter.ts:383`](../../../routers/expenseRouter.ts) ⇐ `approveExpense` (ownerProcedure).
 * الشروط مرآةُ `actionableExpenseApprovalWhere` في `superAppRouter.ts` (مصروفٌ نقديّ معلَّق
 * إيصالُه معلَّق بلا درجٍ ولا وردية ولا مستندٍ آخر).
 */
export const expenseSource: DecisionSource = {
  key: "expense",
  kinds: ["expense.approve", "expense.reject"],
  gate: { type: "OWNER" },
  supportedActions: ["APPROVE", "REJECT"],
  async list(actor, scope) {
    const branchId = scopeBranch(actor, scope);
    if (branchId === "NONE") return [];
    const db = requireDb();
    const rows = await db
      .select({
        id: expenses.id,
        category: expenses.category,
        amount: expenses.amount,
        paymentMethod: expenses.paymentMethod,
        description: expenses.description,
        payee: expenses.payee,
        branchId: expenses.branchId,
        createdBy: expenses.createdBy,
        createdByName: users.name,
        createdAt: expenses.createdAt,
        expenseDate: expenses.expenseDate,
        referenceNumber: expenses.referenceNumber,
      })
      .from(expenses)
      .innerJoin(receipts, eq(expenses.receiptId, receipts.id))
      .leftJoin(users, eq(users.id, expenses.createdBy))
      .where(
        and(
          eq(expenses.status, "PENDING_APPROVAL"),
          eq(expenses.source, "CASH"),
          eq(receipts.direction, "OUT"),
          eq(receipts.status, "PENDING"),
          eq(receipts.approvalStatus, "PENDING_APPROVAL"),
          isNull(expenses.shiftId),
          isNull(expenses.cashBucket),
          isNull(receipts.shiftId),
          isNull(receipts.cashBucket),
          isNull(receipts.invoiceId),
          isNull(receipts.workOrderId),
          isNull(receipts.reservationId),
          isNull(receipts.voucherNumber),
          sql`${expenses.createdBy} IS NOT NULL`,
          branchId == null ? undefined : eq(expenses.branchId, branchId),
        ),
      )
      .orderBy(sql`${expenses.createdAt} ASC`)
      .limit(200);
    const names = await branchNames(db, ids(rows.map((r) => r.branchId)));
    return rows.map((r) =>
      buildRow(
        {
          kind: "expense.approve",
          id: Number(r.id),
          title: `مصروف ${expenseBucketLabel(r.category)} · ${r.paymentMethod}`,
          subkind: expenseBucketLabel(r.category),
          party: r.payee,
          amount: r.amount,
          branchId: Number(r.branchId),
          branchName: names.get(Number(r.branchId)) ?? null,
          requestedBy: r.createdBy == null ? null : Number(r.createdBy),
          requestedByName: r.createdByName ?? null,
          requestedAt: r.createdAt,
          summaryItems: [
            { label: r.description ?? "بلا وصف", unitPrice: r.amount },
            ...(r.referenceNumber ? [{ label: `المرجع: ${r.referenceNumber}` }] : []),
          ],
          reason: r.description,
          trigger: "MONEY_OUT",
        },
        scope.now,
      ),
    );
  },
  freshness: (id) =>
    freshnessFrom(
      async () => (await requireDb().select({ status: expenses.status }).from(expenses).where(eq(expenses.id, id)).limit(1))[0]?.status,
      ["PENDING_APPROVAL"],
    ),
  async decide(input, actor) {
    const subject = `المصروف رقم ${input.id}`;
    if (input.action === "REJECT") {
      await rejectExpense(input.id, serviceActor(actor), input.reason ?? "");
      return decided(input, "REJECTED", defaultMessage("REJECTED", subject));
    }
    await approveExpense(input.id, serviceActor(actor));
    return decided(input, "EXECUTED", `${subject}: اعتُمد وصُرف من الخزينة وسُجّل قيده.`);
  },
};

// ───────────────────────────── ٣) تصحيح الاستحقاق ─────────────────────────────

/**
 * [`expenseRouter.ts:255`](../../../routers/expenseRouter.ts) ⇐ `approveAccrualCorrection` (ownerProcedure).
 * الاعتماد يعكس اعترافاً قائماً (وربّما يُنشئ استرداداً) ⇒ محوُ أثر.
 */
export const accrualCorrectionSource: DecisionSource = {
  key: "expense.accrualCorrection",
  kinds: ["expense.accrualCorrection.approve", "expense.accrualCorrection.reject"],
  gate: { type: "OWNER" },
  supportedActions: ["APPROVE", "REJECT"],
  async list(actor, scope) {
    const branchId = scopeBranch(actor, scope);
    if (branchId === "NONE") return [];
    const db = requireDb();
    const rows = await db
      .select({
        id: accrualCorrectionRequests.id,
        reason: accrualCorrectionRequests.reason,
        evidence: accrualCorrectionRequests.externalEvidenceReference,
        refundPaymentMethod: accrualCorrectionRequests.refundPaymentMethod,
        requestedBy: accrualCorrectionRequests.requestedBy,
        requestedAt: accrualCorrectionRequests.requestedAt,
        previousStatus: accrualCorrectionRequests.previousObligationStatus,
        obligationKind: accrualObligations.kind,
        branchId: accrualObligations.branchId,
        amount: accrualObligations.recognizedAmount,
        beneficiaryName: accrualObligations.beneficiaryName,
      })
      .from(accrualCorrectionRequests)
      .innerJoin(accrualObligations, eq(accrualObligations.id, accrualCorrectionRequests.obligationId))
      .where(and(eq(accrualCorrectionRequests.status, "PENDING"), branchId == null ? undefined : eq(accrualObligations.branchId, branchId)))
      .orderBy(sql`${accrualCorrectionRequests.requestedAt} ASC`)
      .limit(200);
    const [names, people] = await Promise.all([branchNames(db, ids(rows.map((r) => r.branchId))), userNames(db, ids(rows.map((r) => r.requestedBy)))]);
    return rows.map((r) =>
      buildRow(
        {
          kind: "expense.accrualCorrection.approve",
          id: Number(r.id),
          title: `تصحيح استحقاق ${r.obligationKind} · كان ${r.previousStatus}`,
          subkind: r.refundPaymentMethod ? `استرداد ${r.refundPaymentMethod}` : "عكس اعتراف",
          party: r.beneficiaryName,
          amount: r.amount,
          branchId: Number(r.branchId),
          branchName: names.get(Number(r.branchId)) ?? null,
          requestedBy: Number(r.requestedBy),
          requestedByName: people.get(Number(r.requestedBy)) ?? null,
          requestedAt: r.requestedAt,
          summaryItems: [{ label: `الدليل الخارجي: ${r.evidence}`, unitPrice: r.amount }],
          reason: r.reason,
          trigger: "ERASE_EFFECT",
        },
        scope.now,
      ),
    );
  },
  freshness: (id) =>
    freshnessFrom(
      async () => (await requireDb().select({ status: accrualCorrectionRequests.status }).from(accrualCorrectionRequests).where(eq(accrualCorrectionRequests.id, id)).limit(1))[0]?.status,
      ["PENDING"],
    ),
  async decide(input, actor) {
    const subject = `طلب تصحيح الاستحقاق رقم ${input.id}`;
    if (input.action === "REJECT") {
      await rejectAccrualCorrection(input.id, input.reason ?? "", serviceActor(actor));
      return decided(input, "REJECTED", defaultMessage("REJECTED", subject));
    }
    await approveAccrualCorrection(input.id, serviceActor(actor));
    return decided(input, "EXECUTED", defaultMessage("EXECUTED", subject));
  },
};

// ───────────────────────────── ٤) فرق النقد ─────────────────────────────

/**
 * [`cashVarianceRouter.ts:116`](../../../routers/cashVarianceRouter.ts) ⇐ `approveCashVarianceCase`.
 * فصلُ المهام في الخدمة: مقترحُ التسوية لا يعتمدها. القفلُ التفاؤليّ `expectedVersion` = نسخةُ
 * آخر حدث. سببُ الرفض عشرةُ محارف فأكثر.
 *
 * **الفروع:** الخدمة تسرد فرعاً واحداً وتقصر غيرَ الأدمن على فرعه (`assertBranchScope`)، فالأدمن
 * على «كلّ الفروع» يُعدِّد الفروعَ النشطة كلَّها ويسرد لكلٍّ (كما مصادر المشتريات) — كان المصدر
 * يستبدل `actor.branchId` فتختفي قضايا الفروع الأخرى من صندوق الأدمن (Codex على #1004).
 */
export const cashVarianceSource: DecisionSource = {
  key: "cash.variance",
  kinds: ["cash.variance.approve", "cash.variance.reject"],
  gate: TREASURY_GATE,
  supportedActions: ["APPROVE", "REJECT"],
  async list(actor, scope) {
    const db = requireDb();
    const a = serviceActor(actor);
    const all = actor.role === "admin" ? await branchIdsFor(db, actor, scope) : [];
    const branchIds = serviceBranchScopedIds(actor, scope.branchIds, all);
    if (!branchIds.length) return [];
    const pages = await Promise.all(branchIds.map((b) => listCashVarianceCases({ branchId: b, status: "PROPOSED", limit: 100 }, a)));
    const rows = pages.flatMap((p) => p.rows);
    const [names, people] = await Promise.all([
      branchNames(db, ids(rows.map((r) => r.branchId))),
      userNames(db, ids(rows.map((r) => r.proposedByUserId))),
    ]);
    return rows
      .filter((r) => !sodHidden({ blocked: [r.proposedByUserId], actor, trigger: "ERASE_EFFECT" }))
      .map((r) => {
        const shortage = Number(r.variance) < 0;
        return buildRow(
          {
            kind: "cash.variance.approve",
            id: Number(r.id),
            title: `${shortage ? "عجز" : "زيادة"} نقد · ${r.sourceReference}`,
            subkind: CASH_VARIANCE_REASON_LABELS[r.reasonCode as keyof typeof CASH_VARIANCE_REASON_LABELS] ?? r.reasonCode,
            party: r.responsibleNameSnapshot,
            amount: String(Math.abs(Number(r.variance)).toFixed(2)),
            branchId: Number(r.branchId),
            branchName: names.get(Number(r.branchId)) ?? null,
            requestedBy: Number(r.proposedByUserId),
            requestedByName: people.get(Number(r.proposedByUserId)) ?? null,
            requestedAt: r.createdAt,
            summaryItems: [
              { label: "المتوقع", unitPrice: r.expectedAmount },
              { label: "المعدود فعلا", unitPrice: r.actualAmount },
              { label: `الدليل: ${r.evidenceReference}` },
            ],
            reason: r.reason,
            expectedVersion: r.version,
            rejectReason: "REQUIRED",
            reasonMinLength: 10,
            trigger: cashVarianceApprovalTrigger(shortage ? "SHORTAGE" : "SURPLUS", "APPROVE"),
          },
          scope.now,
        );
      });
  },
  async freshness(id) {
    const [row] = await requireDb().select({ id: cashVarianceCases.id }).from(cashVarianceCases).where(eq(cashVarianceCases.id, id)).limit(1);
    if (!row) return "GONE";
    // الحالةُ هي آخرُ حدث؛ الخدمة تقرؤها بالقفل التفاؤليّ — الطزاجةُ هنا وجودُ الحالة وحسب.
    return "PENDING";
  },
  async decide(input, actor) {
    const subject = `فرق النقد رقم ${input.id}`;
    const expectedVersion = input.expectedVersion ?? 0;
    if (input.action === "REJECT") {
      await rejectCashVarianceCase({ caseId: input.id, expectedVersion, clientRequestId: input.clientRequestId, reason: input.reason ?? "" }, serviceActor(actor));
      return decided(input, "REJECTED", defaultMessage("REJECTED", subject));
    }
    await approveCashVarianceCase({ caseId: input.id, expectedVersion, clientRequestId: input.clientRequestId, note: input.reason ?? null }, serviceActor(actor));
    return decided(input, "EXECUTED", defaultMessage("EXECUTED", subject));
  },
};

export const TREASURY_SOURCES: readonly DecisionSource[] = [voucherSource, expenseSource, accrualCorrectionSource, cashVarianceSource];
