/**
 * مصادرُ التوصيل والموارد البشرية والعمولات والإقفال والهدايا — كلٌّ ببوّابة راوتره وخدمته.
 */
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { decisionSubkindLabel, type DecisionSummaryItem } from "@shared/decisionRegistry";
import { appErrorMessage } from "@shared/errors";
import {
  commissionRunApprovalRequests,
  commissionRuns,
  deliveryCodWriteOffRequests,
  employeeAdvanceRepaymentRequests,
  employees,
  giftVoucherLines,
  giftVouchers,
  leaveRequests,
  monthCloseRequests,
  payrollRemittanceRequests,
  users,
  yearEndReopenRequests,
} from "../../../../drizzle/schema";
import { retryOnDeadlock } from "../../../lib/retryDeadlock";
import { approveCommissionRunRequest, listCommissionRunApprovalRequests, rejectCommissionRunRequest } from "../../commissions/runApprovals";
import { commissionReadScope } from "../../commissions/scope";
import { approveDeliveryCodWriteOff, listDeliveryCodWriteOffRequests, rejectDeliveryCodWriteOff } from "../../delivery/writeoffRequests";
import { approveGift } from "../../gifts/outbound";
import { decideLeaveAndNotify } from "../../leaveService";
import { approveAdvanceRepaymentRequest, listAdvanceRepaymentRequests, rejectAdvanceRepaymentRequest } from "../../payroll/advanceRepayment";
import { approveRemittanceRequest, listRemittanceRequests, rejectRemittanceRequest } from "../../payroll/remittance";
import { approveMonthClose, listMonthCloseRequests, rejectMonthClose } from "../../reports/monthCloseRequest";
import { requireDb, withGovernanceTx, withTx } from "../../tx";
import { approveYearEndReopen, listYearEndReopenRequests, rejectYearEndReopen } from "../../yearEndService";
import { scopedBranchIdFor, serviceActor } from "../gate";
import { buildRow, decided, decisionKeyFor, defaultMessage, itemLabel, outcomeFor, statusOf } from "../rows";
import type { DecisionSource } from "../types";
import { branchNames, customerNames, freshnessFrom, ids, scopeBranch, sodHidden, unitNames, userNames, variantLabels } from "./common";

// ───────────────────────────── التوصيل: شطب عهدة COD ─────────────────────────────

/**
 * [`deliveryRouter.ts:873`](../../../routers/deliveryRouter.ts) ⇐ `approveDeliveryCodWriteOff`
 * (deliveryManagerProcedure = `moduleProcedure(["manager"], "store", "FULL")`). القفلُ التفاؤليّ
 * `expectedVersion` = `basePartyVersion`.
 */
export const codWriteOffSource: DecisionSource = {
  key: "delivery.codWriteOff",
  kinds: ["delivery.codWriteOff.approve", "delivery.codWriteOff.reject"],
  gate: { type: "MODULE", moduleKey: "store", roles: ["manager"] },
  supportedActions: ["APPROVE", "REJECT"],
  async list(actor, scope) {
    const branchId = scopeBranch(actor, scope);
    if (branchId === "NONE") return [];
    const rows = await listDeliveryCodWriteOffRequests({ ...serviceActor(actor), reviewAuthorized: true }, { status: "PENDING", branchId, order: "ASC" });
    const branches = await branchNames(requireDb(), ids(rows.map((r) => r.branchId)));
    return rows
      .filter((r) => !sodHidden({ blocked: [r.requestedBy], actor, trigger: "MONEY_OUT" }))
      .map((r) =>
        buildRow(
          {
            kind: "delivery.codWriteOff.approve",
            id: Number(r.id),
            title: `شطب عهدة COD · ${r.partyName}${r.consignmentNumber ? ` · ارسالية ${r.consignmentNumber}` : ""}`,
            party: r.partyName,
            amount: r.amount,
            branchId: Number(r.branchId),
            branchName: branches.get(Number(r.branchId)) ?? null,
            requestedBy: Number(r.requestedBy),
            requestedByName: r.requesterName ?? null,
            requestedAt: r.createdAt,
            summaryItems: [
              { label: "المبلغ المشطوب", unitPrice: r.amount },
              ...(r.evidenceNote ? [{ label: `الدليل: ${r.evidenceNote}` }] : []),
              ...(r.attachmentUrl ? [{ label: "مرفق موجود" }] : []),
            ],
            reason: r.reason,
            expectedVersion: Number(r.basePartyVersion),
            trigger: "MONEY_OUT",
          },
          scope.now,
        ),
      );
  },
  freshness: (id) =>
    freshnessFrom(
      async () => (await requireDb().select({ status: deliveryCodWriteOffRequests.status }).from(deliveryCodWriteOffRequests).where(eq(deliveryCodWriteOffRequests.id, id)).limit(1))[0]?.status,
      ["PENDING"],
    ),
  async decide(input, actor) {
    const subject = `طلب شطب عهدة COD رقم ${input.id}`;
    const base = { id: input.id, expectedVersion: input.expectedVersion ?? 0, decisionKey: decisionKeyFor(input.clientRequestId) };
    const a = { ...serviceActor(actor), reviewAuthorized: true as const };
    if (input.action === "REJECT") {
      await rejectDeliveryCodWriteOff({ ...base, reason: input.reason ?? "" }, a);
      return decided(input, "REJECTED", defaultMessage("REJECTED", subject));
    }
    const res = await approveDeliveryCodWriteOff({ ...base, reviewNote: input.reason ?? null }, a);
    const outcome = outcomeFor("APPROVE", statusOf(res));
    return decided(input, outcome, defaultMessage(outcome, subject));
  },
};

// ───────────────────────────── الموارد البشرية: الإجازات ─────────────────────────────

/**
 * [`leaveRouter.ts:180`](../../../routers/leaveRouter.ts) ⇐ `decideLeaveAndNotify` (hr:FULL على
 * `branchScopedProcedure` ⇒ البوّابة `branchScoped`: غيرُ العابر بلا فرعٍ مُسنَد يُرفَض كما في
 * الأصل). فصلُ المهام في الخدمة: لا يبتّ المرءُ في إجازة حسابه. الرفضُ مدعومٌ (الخدمة تقبل
 * `rejected`) وسببُه اختياريّ — الطلبُ لا يحمل عمودَ سببٍ. الأقدمُ أوّلاً قبل القصّ (200).
 */
export const leaveSource: DecisionSource = {
  key: "hr.leave",
  kinds: ["hr.leave.decide"],
  gate: { type: "MODULE_MAP", moduleKey: "hr", branchScoped: true },
  supportedActions: ["APPROVE", "REJECT"],
  async list(actor, scope) {
    const branchId = scopeBranch(actor, scope);
    if (branchId === "NONE") return [];
    const db = requireDb();
    const rows = await db
      .select({
        id: leaveRequests.id,
        leaveType: leaveRequests.leaveType,
        paid: leaveRequests.paid,
        fromDate: leaveRequests.fromDate,
        toDate: leaveRequests.toDate,
        days: leaveRequests.days,
        reason: leaveRequests.reason,
        requestedAt: leaveRequests.requestedAt,
        employeeUserId: employees.userId,
        employeeBranchId: employees.branchId,
        firstName: employees.firstName,
        lastName: employees.lastName,
      })
      .from(leaveRequests)
      .innerJoin(employees, eq(leaveRequests.employeeId, employees.id))
      .where(and(eq(leaveRequests.status, "pending"), branchId == null ? undefined : eq(employees.branchId, branchId)))
      // الأقدمُ أوّلاً: القصّ بالأحدث كان يُسقط أكثر الطلبات تأخّراً بالضبط حين يكثر المعلَّق.
      .orderBy(asc(leaveRequests.requestedAt), asc(leaveRequests.id))
      .limit(200);
    const branches = await branchNames(db, ids(rows.map((r) => r.employeeBranchId)));
    return rows
      .filter((r) => !sodHidden({ blocked: [r.employeeUserId], actor, trigger: "ERASE_EFFECT" }))
      .map((r) =>
        buildRow(
          {
            kind: "hr.leave.decide",
            id: Number(r.id),
            title: `اجازة ${r.leaveType}${r.paid ? " مدفوعة" : " بلا راتب"} · ${r.days} يوم`,
            subkind: r.leaveType,
            party: `${r.firstName} ${r.lastName}`.trim(),
            branchId: r.employeeBranchId == null ? null : Number(r.employeeBranchId),
            branchName: r.employeeBranchId == null ? null : (branches.get(Number(r.employeeBranchId)) ?? null),
            requestedBy: r.employeeUserId == null ? null : Number(r.employeeUserId),
            requestedByName: `${r.firstName} ${r.lastName}`.trim(),
            requestedAt: r.requestedAt,
            summaryItems: [{ label: `من ${r.fromDate} الى ${r.toDate}`, qty: r.days, unit: "يوم" }],
            reason: r.reason,
            rejectReason: "OPTIONAL",
            trigger: null,
          },
          scope.now,
        ),
      );
  },
  freshness: (id) =>
    freshnessFrom(async () => (await requireDb().select({ status: leaveRequests.status }).from(leaveRequests).where(eq(leaveRequests.id, id)).limit(1))[0]?.status, ["pending"]),
  async decide(input, actor) {
    const subject = `طلب الاجازة رقم ${input.id}`;
    const decision = input.action === "REJECT" ? "rejected" : "approved";
    // `scopedBranchIdFor` مرآةُ `branchScopedProcedure`: لا `null` لغير العابر أبداً.
    await decideLeaveAndNotify(input.id, decision, { userId: actor.userId, scopedBranchId: scopedBranchIdFor(actor) });
    const outcome = decision === "approved" ? "EXECUTED" : "REJECTED";
    return decided(input, outcome, decision === "approved" ? `${subject}: اعتُمد وأُشعر الموظف.` : `${subject}: رُفض وأُشعر الموظف.`);
  },
};

// ───────────────────────────── الموارد البشرية: تحويل الاستقطاعات ─────────────────────────────

/**
 * [`payrollRouter.ts:309`](../../../routers/payrollRouter.ts) ⇐ `approveRemittanceRequest`. بوّابةُ
 * الراوتر hr:FULL لكنّ الخدمة تشترط مالكاً نشطاً (`assertOwner`) ⇒ البوّابةُ الفعلية `OWNER`.
 */
export const payrollRemittanceSource: DecisionSource = {
  key: "payroll.remittance",
  kinds: ["payroll.remittance.approve", "payroll.remittance.reject"],
  gate: { type: "OWNER", moduleKey: "hr" },
  supportedActions: ["APPROVE", "REJECT"],
  async list(actor, scope) {
    const branchId = scopeBranch(actor, scope);
    if (branchId === "NONE") return [];
    const rows = await listRemittanceRequests({ status: "PENDING", branchId: branchId ?? undefined });
    const db = requireDb();
    const [branches, people] = await Promise.all([branchNames(db, ids(rows.map((r) => r.payingBranchId))), userNames(db, ids(rows.map((r) => r.createdBy)))]);
    return rows.map((r) =>
      buildRow(
        {
          kind: "payroll.remittance.approve",
          id: Number(r.id),
          title: `تحويل ${decisionSubkindLabel(r.kind)} · ${r.authorityName}`,
          subkind: decisionSubkindLabel(r.kind),
          party: r.authorityName,
          amount: r.requestedAmount,
          branchId: Number(r.payingBranchId),
          branchName: branches.get(Number(r.payingBranchId)) ?? null,
          requestedBy: Number(r.createdBy),
          requestedByName: people.get(Number(r.createdBy)) ?? null,
          requestedAt: r.createdAt,
          summaryItems: [{ label: `المرجع: ${r.referenceNumber}`, unitPrice: r.requestedAmount }],
          reason: null,
          reasonMinLength: 5,
          trigger: "MONEY_OUT",
        },
        scope.now,
      ),
    );
  },
  freshness: (id) =>
    freshnessFrom(
      async () => (await requireDb().select({ status: payrollRemittanceRequests.status }).from(payrollRemittanceRequests).where(eq(payrollRemittanceRequests.id, id)).limit(1))[0]?.status,
      ["PENDING"],
    ),
  async decide(input, actor) {
    const subject = `طلب التحويل رقم ${input.id}`;
    if (input.action === "REJECT") {
      await rejectRemittanceRequest(input.id, input.reason ?? "", serviceActor(actor));
      return decided(input, "REJECTED", defaultMessage("REJECTED", subject));
    }
    const res = await approveRemittanceRequest(input.id, serviceActor(actor));
    return decided(input, "EXECUTED", res.replayed ? `${subject}: كان معتمداً من قبل.` : `${subject}: اعتُمد — الدفعُ خطوةٌ لاحقة من شاشة الرواتب.`);
  },
};

// ───────────────────────────── الموارد البشرية: سداد السلف ─────────────────────────────

/** [`payrollRouter.ts:520`](../../../routers/payrollRouter.ts) ⇐ `approveAdvanceRepaymentRequest` (ownerHrWrite). */
export const advanceRepaymentSource: DecisionSource = {
  key: "payroll.advanceRepayment",
  kinds: ["payroll.advanceRepayment.approve", "payroll.advanceRepayment.reject"],
  gate: { type: "OWNER", moduleKey: "hr" },
  supportedActions: ["APPROVE", "REJECT"],
  async list(actor, scope) {
    const branchId = scopeBranch(actor, scope);
    if (branchId === "NONE") return [];
    const rows = await listAdvanceRepaymentRequests({ status: "PENDING", branchId: branchId ?? undefined });
    const db = requireDb();
    const [branches, people] = await Promise.all([branchNames(db, ids(rows.map((r) => r.branchId))), userNames(db, ids(rows.map((r) => r.createdBy)))]);
    return rows.map((r) =>
      buildRow(
        {
          kind: "payroll.advanceRepayment.approve",
          id: Number(r.id),
          title: `${decisionSubkindLabel(r.requestKind)} · ${r.employeeName}`,
          subkind: decisionSubkindLabel(r.requestKind),
          party: r.employeeName,
          amount: r.amount,
          branchId: Number(r.branchId),
          branchName: branches.get(Number(r.branchId)) ?? null,
          requestedBy: Number(r.createdBy),
          requestedByName: people.get(Number(r.createdBy)) ?? null,
          requestedAt: r.createdAt,
          summaryItems: [
            { label: `${r.paymentMethod}${r.referenceNumber ? ` · ${r.referenceNumber}` : ""} · ${r.transactionDate}`, unitPrice: r.amount },
            ...(r.evidenceNote ? [{ label: `الدليل: ${r.evidenceNote}` }] : []),
          ],
          reason: r.evidenceNote,
          reasonMinLength: 5,
          trigger: r.requestKind === "RETURN" ? "MONEY_OUT" : null,
        },
        scope.now,
      ),
    );
  },
  freshness: (id) =>
    freshnessFrom(
      async () => (await requireDb().select({ status: employeeAdvanceRepaymentRequests.status }).from(employeeAdvanceRepaymentRequests).where(eq(employeeAdvanceRepaymentRequests.id, id)).limit(1))[0]?.status,
      ["PENDING"],
    ),
  async decide(input, actor) {
    const subject = `طلب سداد السلفة رقم ${input.id}`;
    if (input.action === "REJECT") {
      await rejectAdvanceRepaymentRequest(input.id, input.reason ?? "", serviceActor(actor));
      return decided(input, "REJECTED", defaultMessage("REJECTED", subject));
    }
    const res = await approveAdvanceRepaymentRequest(input.id, serviceActor(actor));
    return decided(input, "EXECUTED", res.replayed ? `${subject}: كان معتمداً من قبل.` : defaultMessage("EXECUTED", subject));
  },
};

// ───────────────────────────── العمولات: دورة عمولات ─────────────────────────────

/**
 * [`commissionsRouter.ts:238`](../../../routers/commissionsRouter.ts) ⇐ `approveCommissionRunRequest`
 * (commissions:FULL + سلطةُ الشركة: المالك/الأدمن أو المالية المركزية بلا فرع). القفلُ التفاؤليّ
 * `expectedVersion` = `baseRunVersion`.
 */
export const commissionRunSource: DecisionSource = {
  key: "commissions.run",
  kinds: ["commissions.run.approve", "commissions.run.reject"],
  gate: { type: "MODULE_MAP", moduleKey: "commissions" },
  supportedActions: ["APPROVE", "REJECT"],
  async list(actor, scope) {
    let companyScope: number | null;
    try {
      companyScope = commissionReadScope({ role: actor.role, branchId: actor.branchId, isOwner: actor.isOwner });
    } catch {
      return [];
    }
    if (companyScope != null) return []; // مراجعةُ الاعتماد سلطةُ شركة — مدير الفرع لا يراها هنا.
    const rows = await listCommissionRunApprovalRequests(serviceActor(actor), null, { status: "PENDING", order: "ASC" });
    const db = requireDb();
    const runs = rows.length ? await db.select({ id: commissionRuns.id, totalCommission: commissionRuns.totalCommission, employeeCount: commissionRuns.employeeCount }).from(commissionRuns).where(inArray(commissionRuns.id, ids(rows.map((r) => r.runId)))) : [];
    const runById = new Map(runs.map((x) => [Number(x.id), x]));
    const branches = await branchNames(db, ids(rows.map((r) => r.scopeBranchId)));
    return rows
      .filter((r) => (scope.branchIds ? r.scopeBranchId != null && scope.branchIds.includes(Number(r.scopeBranchId)) : true))
      .filter((r) => !sodHidden({ blocked: [r.requestedBy], actor, trigger: "MONEY_OUT" }))
      .map((r) => {
        const run = runById.get(Number(r.runId));
        return buildRow(
          {
            kind: "commissions.run.approve",
            id: Number(r.id),
            title: `اعتماد دورة عمولات ${r.period}`,
            subkind: r.scopeBranchId == null ? "نطاق الشركة" : "نطاق فرع",
            amount: run?.totalCommission ?? null,
            branchId: r.scopeBranchId == null ? null : Number(r.scopeBranchId),
            branchName: r.scopeBranchId == null ? null : (branches.get(Number(r.scopeBranchId)) ?? null),
            requestedBy: Number(r.requestedBy),
            requestedByName: r.requesterName ?? null,
            requestedAt: r.createdAt,
            summaryItems: [{ label: `المندوبون: ${run?.employeeCount ?? 0}`, unitPrice: run?.totalCommission ?? null }],
            reason: r.reason,
            expectedVersion: Number(r.baseRunVersion),
            trigger: "MONEY_OUT",
          },
          scope.now,
        );
      });
  },
  freshness: (id) =>
    freshnessFrom(
      async () => (await requireDb().select({ status: commissionRunApprovalRequests.status }).from(commissionRunApprovalRequests).where(eq(commissionRunApprovalRequests.id, id)).limit(1))[0]?.status,
      ["PENDING"],
    ),
  async decide(input, actor) {
    const subject = `طلب اعتماد دورة العمولات رقم ${input.id}`;
    const base = { id: input.id, expectedVersion: input.expectedVersion ?? 0, decisionKey: decisionKeyFor(input.clientRequestId) };
    if (input.action === "REJECT") {
      await rejectCommissionRunRequest({ ...base, reason: input.reason ?? "" }, serviceActor(actor), null);
      return decided(input, "REJECTED", defaultMessage("REJECTED", subject));
    }
    const res = await approveCommissionRunRequest({ ...base, reviewNote: input.reason ?? null }, serviceActor(actor), null);
    const outcome = outcomeFor("APPROVE", statusOf(res));
    return decided(input, outcome, defaultMessage(outcome, subject));
  },
};

// ───────────────────────────── الإقفال: الشهر ─────────────────────────────

/** [`periodLockRouter.ts:306`](../../../routers/periodLockRouter.ts) ⇐ `approveMonthClose` (reportsAdminProcedure). الطالب لا يعتمد. */
export const monthCloseSource: DecisionSource = {
  key: "closing.monthClose",
  kinds: ["closing.monthClose.approve", "closing.monthClose.reject"],
  gate: { type: "REPORTS_ADMIN" },
  supportedActions: ["APPROVE", "REJECT"],
  async list(actor, scope) {
    if (scope.branchIds) return []; // قرارٌ شركيّ — لا فرعَ له، فمرشَّحُ الفرع يستبعده بصدق.
    const rows = await withTx((tx) => listMonthCloseRequests(tx, { pendingOnly: true, order: "ASC" }), { gate: "NONE" });
    return rows
      .filter((r) => !sodHidden({ blocked: [r.requestedBy], actor, trigger: "ERASE_EFFECT" }))
      .map((r) =>
        buildRow(
          {
            kind: "closing.monthClose.approve",
            id: r.id,
            title: `اقفال شهر ${r.month}`,
            requestedBy: r.requestedBy,
            requestedByName: r.requestedByName,
            requestedAt: r.requestedAt,
            summaryItems: [{ label: `الشهر ${r.month} — الاقفال يمنع أي كتابة مالية عليه بعد الاعتماد` }],
            reason: null,
            reasonMinLength: 5,
            trigger: "ERASE_EFFECT",
          },
          scope.now,
        ),
      );
  },
  freshness: (id) =>
    freshnessFrom(async () => (await requireDb().select({ status: monthCloseRequests.status }).from(monthCloseRequests).where(eq(monthCloseRequests.id, id)).limit(1))[0]?.status, ["PENDING_APPROVAL"]),
  async decide(input, actor) {
    const subject = `طلب اقفال الشهر رقم ${input.id}`;
    if (input.action === "REJECT") {
      await retryOnDeadlock(() => withGovernanceTx((tx) => rejectMonthClose(tx, { requestId: input.id, decidedBy: actor.userId, reason: input.reason ?? "" })));
      return decided(input, "REJECTED", defaultMessage("REJECTED", subject));
    }
    const res = await retryOnDeadlock(() => withGovernanceTx((tx) => approveMonthClose(tx, { requestId: input.id, decidedBy: actor.userId, notes: input.reason ?? null })));
    return decided(input, "EXECUTED", `اقفال شهر ${res.month}: اعتُمد — شهادة رقم ${res.certificateNumber}.`);
  },
};

// ───────────────────────────── الإقفال: فتح نهاية السنة ─────────────────────────────

/** [`yearEndRouter.ts:130`](../../../routers/yearEndRouter.ts) ⇐ `approveYearEndReopen` (reportsAdminProcedure). سببُ القرار إلزاميّ (5+). */
export const yearEndReopenSource: DecisionSource = {
  key: "closing.yearEndReopen",
  kinds: ["closing.yearEndReopen.approve", "closing.yearEndReopen.reject"],
  gate: { type: "REPORTS_ADMIN" },
  supportedActions: ["APPROVE", "REJECT"],
  async list(actor, scope) {
    if (scope.branchIds) return [];
    const rows = await withTx((tx) => listYearEndReopenRequests(tx, { pendingOnly: true, order: "ASC" }), { gate: "NONE" });
    return rows
      .filter((r) => !sodHidden({ blocked: [r.requestedBy], actor, trigger: "ERASE_EFFECT" }))
      .map((r) =>
        buildRow(
          {
            kind: "closing.yearEndReopen.approve",
            id: Number(r.id),
            title: `اعادة فتح سنة ${r.year}`,
            requestedBy: Number(r.requestedBy),
            requestedByName: r.requestedByName,
            requestedAt: r.requestedAt,
            summaryItems: [{ label: `السنة ${r.year} — الاعتماد يعكس قيد الاقفال ويعيد الشهور من كانون الاول` }],
            reason: r.reason,
            approveReason: "REQUIRED",
            reasonMinLength: 5,
            trigger: "ERASE_EFFECT",
          },
          scope.now,
        ),
      );
  },
  freshness: (id) =>
    freshnessFrom(async () => (await requireDb().select({ status: yearEndReopenRequests.status }).from(yearEndReopenRequests).where(eq(yearEndReopenRequests.id, id)).limit(1))[0]?.status, ["PENDING_APPROVAL"]),
  async decide(input, actor) {
    const subject = `طلب اعادة فتح السنة رقم ${input.id}`;
    const args = { requestId: input.id, decidedBy: actor.userId, decisionReason: input.reason ?? "" };
    if (input.action === "REJECT") {
      await retryOnDeadlock(() => withGovernanceTx((tx) => rejectYearEndReopen(tx, args)));
      return decided(input, "REJECTED", defaultMessage("REJECTED", subject));
    }
    const res = await retryOnDeadlock(() => withGovernanceTx((tx) => approveYearEndReopen(tx, args)));
    return decided(input, "EXECUTED", `اعادة فتح سنة ${res.year}: اعتُمدت — الشهر المطلوب التالي ${res.nextRequiredMonth}.`);
  },
};

// ───────────────────────────── الهدايا الصادرة ─────────────────────────────

/** الهديةُ بلا أسطر لا تُعتمَد سطرياً — لا يُعرَف ما سيخرج من المخزون. */
const GIFT_NO_LINES_REASON = "الهدية بلا اسطر — لا يُعرَف ما سيخرج من المخزون؛ افتح شاشة الهدايا الصادرة";

/**
 * [`giftsRouter.ts:217`](../../../routers/giftsRouter.ts) ⇐ `approveGift` (`giftsWrite` =
 * `branchScopedProcedure.use(requireModule("gifts","FULL"))` ⇒ البوّابة `MODULE_MAP` + `branchScoped`؛
 * والخدمة تشترط مديراً أو أدمن ومعتمِداً غيرَ المنشئ). لا رفضَ في مكانه — الإلغاءُ مسارُ الطالب.
 *
 * **الأسطرُ جزءٌ من القرار** (`decidesOn` في السجلّ): الاعتمادُ يُخرج أصنافاً بكمّياتها من المخزون
 * فوراً، فالصفُّ يعرضها من `giftVoucherLines`؛ وهديةٌ بلا أسطر تُحجَب لا تُعتمَد (Codex على #1004).
 */
export const giftSource: DecisionSource = {
  key: "gifts.request",
  kinds: ["gifts.request.approve"],
  gate: { type: "MODULE_MAP", moduleKey: "gifts", branchScoped: true },
  supportedActions: ["APPROVE"],
  async list(actor, scope) {
    const branchId = scopeBranch(actor, scope);
    if (branchId === "NONE") return [];
    if (actor.role !== "admin" && actor.role !== "manager") return [];
    const db = requireDb();
    const rows = await db
      .select({
        id: giftVouchers.id,
        giftNumber: giftVouchers.giftNumber,
        totalCost: giftVouchers.totalCost,
        reason: giftVouchers.reason,
        giftType: giftVouchers.giftType,
        customerId: giftVouchers.customerId,
        branchId: giftVouchers.branchId,
        createdBy: giftVouchers.createdBy,
        createdByName: users.name,
        createdAt: giftVouchers.createdAt,
      })
      .from(giftVouchers)
      .leftJoin(users, eq(users.id, giftVouchers.createdBy))
      .where(and(eq(giftVouchers.status, "PENDING_APPROVAL"), eq(giftVouchers.direction, "OUT"), branchId == null ? undefined : eq(giftVouchers.branchId, branchId)))
      // الأقدمُ أوّلاً قبل القصّ — الأحدثُ أوّلاً كان يُسقط أكثر الطلبات تأخّراً.
      .orderBy(asc(giftVouchers.createdAt), asc(giftVouchers.id))
      .limit(200);
    if (!rows.length) return [];
    const lines = await db
      .select({
        giftVoucherId: giftVoucherLines.giftVoucherId,
        variantId: giftVoucherLines.variantId,
        productUnitId: giftVoucherLines.productUnitId,
        quantity: giftVoucherLines.quantity,
        baseQuantity: giftVoucherLines.baseQuantity,
        unitCostSnapshot: giftVoucherLines.unitCostSnapshot,
        lineCost: giftVoucherLines.lineCost,
      })
      .from(giftVoucherLines)
      .where(inArray(giftVoucherLines.giftVoucherId, ids(rows.map((r) => r.id))));
    const [branches, customers, variants, units] = await Promise.all([
      branchNames(db, ids(rows.map((r) => r.branchId))),
      customerNames(db, ids(rows.map((r) => r.customerId))),
      variantLabels(db, ids(lines.map((l) => l.variantId))),
      unitNames(db, ids(lines.map((l) => l.productUnitId))),
    ]);
    return rows
      .filter((r) => !sodHidden({ blocked: [r.createdBy], actor, adminExempt: true, trigger: "MONEY_OUT" }))
      .map((r) => {
        const mine = lines.filter((l) => Number(l.giftVoucherId) === Number(r.id));
        const lineItems: DecisionSummaryItem[] = mine.map((l) => {
          const v = variants.get(Number(l.variantId));
          return {
            label: itemLabel([v?.productName, v?.variantName]) || `صنف #${l.variantId}`,
            qty: String(l.quantity),
            unit: `${units.get(Number(l.productUnitId)) ?? ""} (${l.baseQuantity} بالوحدة الأساس)`.trim(),
            unitPrice: l.unitCostSnapshot,
          };
        });
        return buildRow(
          {
            kind: "gifts.request.approve",
            id: Number(r.id),
            title: `هدية صادرة ${r.giftNumber}${r.giftType ? ` · ${r.giftType}` : ""}`,
            subkind: r.giftType,
            party: r.customerId == null ? null : (customers.get(Number(r.customerId)) ?? null),
            amount: r.totalCost,
            branchId: Number(r.branchId),
            branchName: branches.get(Number(r.branchId)) ?? null,
            requestedBy: Number(r.createdBy),
            requestedByName: r.createdByName ?? null,
            requestedAt: r.createdAt,
            summaryItems: [...lineItems, { label: "تكلفة الاصناف المهداة", unitPrice: r.totalCost }],
            reason: r.reason,
            allowedActions: ["APPROVE"],
            rejectReason: "NOT_SUPPORTED",
            approveBlockedReason: mine.length ? null : GIFT_NO_LINES_REASON,
            trigger: "MONEY_OUT",
          },
          scope.now,
        );
      });
  },
  freshness: (id) =>
    freshnessFrom(async () => (await requireDb().select({ status: giftVouchers.status }).from(giftVouchers).where(eq(giftVouchers.id, id)).limit(1))[0]?.status, ["PENDING_APPROVAL"]),
  async decide(input, actor) {
    if (input.action !== "APPROVE") {
      // يحرسه `supportedActions` قبل الوصول؛ يبقى دفاعاً ثانياً: لا فعلَ هنا يعني اعتماداً.
      throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({ what: "تعذّر حسم طلب الهدية", why: "الهدية الصادرة تُعتمَد فقط من الصندوق، والرفض ليس مساراً لها", doThis: "اطلب من الطالب إلغاء طلبه من شاشة الهدايا الصادرة" }) });
    }
    const [{ lineCount }] = await requireDb().select({ lineCount: sql<number>`COUNT(*)` }).from(giftVoucherLines).where(eq(giftVoucherLines.giftVoucherId, input.id));
    if (!Number(lineCount)) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: appErrorMessage({ what: `تعذّر اعتماد الهدية رقم ${input.id} من الصندوق`, why: GIFT_NO_LINES_REASON, doThis: "افتح شاشة الهدايا الصادرة وراجع السند قبل اعتماده" }) });
    }
    const res = await approveGift(input.id, serviceActor(actor));
    return decided(input, "EXECUTED", `الهدية رقم ${res.giftVoucherId}: اعتُمدت وسُلّمت بتكلفة ${res.totalCost}.`);
  },
};

export const OTHER_SOURCES: readonly DecisionSource[] = [
  codWriteOffSource,
  leaveSource,
  payrollRemittanceSource,
  advanceRepaymentSource,
  commissionRunSource,
  monthCloseSource,
  yearEndReopenSource,
  giftSource,
];
