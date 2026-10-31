/* ============================================================================
 * مصدر القراءة والتسوية الموحد لسلف الموظفين.
 * الطلب والمراجعة صفرَا الأثر؛ الصرف وحده ينشئ سند DRAWER وسلفة SALARY_ADVANCE لشهر بغداد
 * الجاري. السلفة الراتبية تُخصم كاملةً في شهرها، أما الديون التاريخية غير المصنفة فتبقى
 * منفصلة بلا افتراض رجعي حتى تُطابق بدليل مصدر.
 * ========================================================================== */
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { fullEmployeeName } from "@shared/hr";
import { appErrorMessage } from "@shared/errors";
import { levelSatisfies } from "@shared/permissions";
import { voucherApprovalTrigger } from "@shared/approvalTriggers";
import {
  advanceSettlements,
  branches,
  employeeAdvanceRepaymentAllocations,
  employeeAdvances,
  employeeLoanRequests,
  employees,
  idempotencyKeys,
  receipts,
  terminationAdvanceAllocations,
  voucherCategories,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { money, round2, toDbMoney } from "../money";
import { requireDb, withTx, type Actor } from "../tx";
import { getApprovalThreshold } from "../voucher/thresholds";
import {
  createVoucherTx,
  employeeAdvanceReference,
  employeeAdvanceSourceHash,
  parseSystemPaymentRequest,
  type SystemPaymentRequest,
} from "../voucher/create";
import { autoSyncEmployeeAdvanceToDraftPayrollTx } from "../payroll/syncAdvances";
import { baghdadToday } from "../businessDay";
import {
  assertAdvanceWithinCapacity,
  getEmployeeAdvanceCapacityTx,
} from "../employeeAdvanceCapacityService";
import { canCrossBranches } from "../../lib/branchAuthority";
import {
  assertOperationAuthorityTx,
  type StoredOperationSnapshot,
} from "../authorization/operationAuthority";
import { planApproval, resolveApprovalActor } from "../approval/ownerGate";
import { requireOpenShiftIdTx } from "../shiftService";
import { lockCashSourceForUpdate } from "../cash/cashAvailability";

function currentHrWriteAllowed(current: StoredOperationSnapshot): boolean {
  return (
    current.isOwner === true ||
    levelSatisfies(current.resolvedPermissions?.hr, "FULL")
  );
}

export * from "../payroll/advanceRepayment";

/** عَتبة السندات (اعتماد ثنائي) — تُعرَض للواجهة عبر بوّابة hr (بوّابة الخزينة لا تلزم هنا).
 *  لا عَتبة مُرفق: المُرفق اختياريّ دائماً (٣١/٧). */
export function advanceThresholds() {
  return { approval: getApprovalThreshold() };
}

/* ─────────────────────────── قراءة ─────────────────────────── */

export interface ListAdvancesFilters {
  employeeId?: number;
  branchId?: number;
  period?: string;
  status?:
    | "ACTIVE"
    | "SETTLED"
    | "CANCELLED"
    | "PENDING_APPROVAL"
    | "APPROVED"
    | "REJECTED"
    | "EXPIRED"
    | "LEGACY_UNCLASSIFIED";
}

export interface AdvanceProjection {
  id: number;
  requestId: number | null;
  employeeId: number;
  branchId: number;
  amount: string;
  remaining: string;
  monthlyDeduction: string | null;
  sourceType: "SALARY_ADVANCE" | "OTHER_DEDUCTION" | "LEGACY_UNCLASSIFIED";
  payrollPeriod: string | null;
  status:
    | "ACTIVE"
    | "SETTLED"
    | "CANCELLED"
    | "PENDING_APPROVAL"
    | "APPROVED"
    | "REJECTED"
    | "EXPIRED"
    | "LEGACY_UNCLASSIFIED";
  workflowStatus: string;
  financiallyDisbursed: boolean;
  receiptId: number | null;
  note: string | null;
  createdBy: number | null;
  grantedAt: Date;
  firstName: string | null;
  fatherName: string | null;
  grandfatherName: string | null;
  lastName: string | null;
  position: string | null;
  employmentStatus: string | null;
  branchName: string | null;
  voucherNumber: string | null;
  employeeName?: string;
}

export async function listAdvances(filters?: ListAdvancesFilters) {
  const db = requireDb();
  const currentPeriod = baghdadToday().slice(0, 7);
  if (
    filters?.branchId != null &&
    (!Number.isInteger(filters.branchId) || filters.branchId <= 0)
  ) {
    throw new TRPCError({ code: "FORBIDDEN", message: "نطاق الفرع مطلوب." });
  }
  const conds = [];
  if (filters?.employeeId)
    conds.push(eq(employeeAdvances.employeeId, filters.employeeId));
  if (filters?.branchId != null)
    conds.push(eq(employeeAdvances.branchId, filters.branchId));
  const materializedStatuses = ["ACTIVE", "SETTLED", "CANCELLED"] as const;
  const wantsMaterialized =
    !filters?.status ||
    (materializedStatuses as readonly string[]).includes(filters.status);
  if (
    filters?.status &&
    (materializedStatuses as readonly string[]).includes(filters.status)
  ) {
    conds.push(
      eq(
        employeeAdvances.status,
        filters.status as (typeof materializedStatuses)[number],
      ),
    );
  }
  if (filters?.period)
    conds.push(
      filters.period === currentPeriod
        ? or(
            eq(employeeAdvances.payrollPeriod, filters.period),
            isNull(employeeAdvances.payrollPeriod),
          )
        : eq(employeeAdvances.payrollPeriod, filters.period),
    );

  // 1. السلف المثبتة في جدول employeeAdvances
  const rows = !wantsMaterialized
    ? []
    : await db
        .select({
          id: employeeAdvances.id,
          employeeId: employeeAdvances.employeeId,
          branchId: employeeAdvances.branchId,
          amount: employeeAdvances.amount,
          remaining: employeeAdvances.remaining,
          monthlyDeduction: employeeAdvances.monthlyDeduction,
          sourceType: employeeAdvances.sourceType,
          payrollPeriod: employeeAdvances.payrollPeriod,
          status: employeeAdvances.status,
          receiptId: employeeAdvances.receiptId,
          note: employeeAdvances.note,
          createdBy: employeeAdvances.createdBy,
          grantedAt: employeeAdvances.grantedAt,
          firstName: employees.firstName,
          fatherName: employees.fatherName,
          grandfatherName: employees.grandfatherName,
          lastName: employees.lastName,
          position: employees.position,
          employmentStatus: employees.employmentStatus,
          branchName: branches.name,
          voucherNumber: receipts.voucherNumber,
        })
        .from(employeeAdvances)
        .leftJoin(employees, eq(employeeAdvances.employeeId, employees.id))
        .leftJoin(branches, eq(employeeAdvances.branchId, branches.id))
        .leftJoin(receipts, eq(employeeAdvances.receiptId, receipts.id))
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(employeeAdvances.id));

  // 2. طلبات السلف المعلّقة في receipts بانتظار الاعتماد — تظهر حتى لا تضيع السلف صمتاً
  const pendingRows: AdvanceProjection[] = [];
  if (
    (!filters?.period || filters.period === currentPeriod) &&
    (!filters?.status ||
      filters.status === "PENDING_APPROVAL" ||
      filters.status === "LEGACY_UNCLASSIFIED")
  ) {
    const pendingReceipts = await db
      .select({
        id: receipts.id,
        branchId: receipts.branchId,
        amount: receipts.amount,
        voucherNumber: receipts.voucherNumber,
        createdBy: receipts.createdBy,
        createdAt: receipts.createdAt,
        internalNote: receipts.internalNote,
        referenceNumber: receipts.referenceNumber,
        branchName: branches.name,
      })
      .from(receipts)
      .leftJoin(branches, eq(receipts.branchId, branches.id))
      .where(
        and(
          sql`${receipts.referenceNumber} LIKE 'EMP-ADV-%'`,
          eq(receipts.approvalStatus, "PENDING_APPROVAL"),
          sql`${receipts.status} NOT IN ('REVERSED', 'REJECTED')`,
          filters?.branchId != null ? eq(receipts.branchId, filters.branchId) : undefined,
        ),
      );

    for (const pr of pendingReceipts) {
      let reqEmployeeId: number | null = null;
      let reqMonthly: string | null = null;
      let reqNote: string | null = null;
      const parsed = parseSystemPaymentRequest(pr.internalNote);
      if (parsed?.kind === "EMPLOYEE_ADVANCE") {
        reqEmployeeId = Number(parsed.employeeId);
        reqMonthly = parsed.monthlyDeduction;
        reqNote = parsed.note;
      } else {
        const match = pr.referenceNumber?.match(/^EMP-ADV-(\d+)-/);
        if (match) reqEmployeeId = Number(match[1]);
      }

      if (!reqEmployeeId) continue;
      if (filters?.employeeId && reqEmployeeId !== filters.employeeId) continue;
      if (pr.branchId == null) continue;

      const [emp] = await db
        .select({
          firstName: employees.firstName,
          fatherName: employees.fatherName,
          grandfatherName: employees.grandfatherName,
          lastName: employees.lastName,
          position: employees.position,
          employmentStatus: employees.employmentStatus,
        })
        .from(employees)
        .where(eq(employees.id, reqEmployeeId))
        .limit(1);

      pendingRows.push({
        id: Number(pr.id),
        employeeId: reqEmployeeId,
        branchId: Number(pr.branchId ?? 1),
        amount: String(pr.amount),
        remaining: "0.00",
        monthlyDeduction: reqMonthly,
        sourceType: "SALARY_ADVANCE",
        payrollPeriod: null,
        status: "LEGACY_UNCLASSIFIED",
        workflowStatus: "LEGACY_VOUCHER_PENDING",
        financiallyDisbursed: false,
        requestId: null,
        receiptId: Number(pr.id),
        note: reqNote,
        createdBy: pr.createdBy,
        grantedAt: pr.createdAt,
        firstName: emp?.firstName ?? null,
        fatherName: emp?.fatherName ?? null,
        grandfatherName: emp?.grandfatherName ?? null,
        lastName: emp?.lastName ?? null,
        position: emp?.position ?? null,
        employmentStatus: emp?.employmentStatus ?? null,
        branchName: pr.branchName,
        voucherNumber: pr.voucherNumber,
      });
    }
  }

  // 3. مسار الطلب الموحد: كل الحالات غير المصروفة تبقى في التاريخ؛ القديمة تُعرض
  // EXPIRED/LEGACY_UNCLASSIFIED بدلاً من الاختفاء أو إمكان صرفها في شهر لاحق.
  const requestRows: AdvanceProjection[] = [];
  const requestStatuses = [
    "PENDING_APPROVAL",
    "APPROVED",
    "REJECTED",
    "CANCELLED",
    "EXPIRED",
    "LEGACY_UNCLASSIFIED",
  ] as const;
  if (
    !filters?.status ||
    (requestStatuses as readonly string[]).includes(filters.status)
  ) {
    const loanConditions = [
      inArray(employeeLoanRequests.status, [
        "PENDING",
        "APPROVED",
        "REJECTED",
        "CANCELLED",
      ]),
      filters?.employeeId
        ? eq(employeeLoanRequests.employeeId, filters.employeeId)
        : undefined,
      filters?.branchId != null
        ? eq(employeeLoanRequests.branchId, filters.branchId)
        : undefined,
      filters?.period
        ? filters.period === currentPeriod
          ? or(
              eq(employeeLoanRequests.payrollPeriod, filters.period),
              isNull(employeeLoanRequests.payrollPeriod),
            )
          : eq(employeeLoanRequests.payrollPeriod, filters.period)
        : undefined,
    ];
    const requests = await db
      .select({
        id: employeeLoanRequests.id,
        employeeId: employeeLoanRequests.employeeId,
        branchId: employeeLoanRequests.branchId,
        amount: employeeLoanRequests.amount,
        monthlyDeduction: employeeLoanRequests.monthlyDeduction,
        payrollPeriod: employeeLoanRequests.payrollPeriod,
        reason: employeeLoanRequests.reason,
        rejectionReason: employeeLoanRequests.rejectionReason,
        status: employeeLoanRequests.status,
        createdById: employeeLoanRequests.createdById,
        createdAt: employeeLoanRequests.createdAt,
        firstName: employees.firstName,
        fatherName: employees.fatherName,
        grandfatherName: employees.grandfatherName,
        lastName: employees.lastName,
        position: employees.position,
        employmentStatus: employees.employmentStatus,
        branchName: branches.name,
      })
      .from(employeeLoanRequests)
      .leftJoin(employees, eq(employeeLoanRequests.employeeId, employees.id))
      .leftJoin(branches, eq(employeeLoanRequests.branchId, branches.id))
      .where(and(...loanConditions))
      .orderBy(desc(employeeLoanRequests.id));
    for (const request of requests) {
      const legacyUnclassified =
        request.payrollPeriod == null &&
        (request.status === "PENDING" || request.status === "APPROVED");
      const expired =
        request.payrollPeriod != null &&
        request.payrollPeriod < currentPeriod &&
        (request.status === "PENDING" || request.status === "APPROVED");
      const projectedStatus: AdvanceProjection["status"] = legacyUnclassified
        ? "LEGACY_UNCLASSIFIED"
        : expired
          ? "EXPIRED"
          : request.status === "PENDING"
            ? "PENDING_APPROVAL"
            : request.status === "APPROVED"
              ? "APPROVED"
              : request.status === "REJECTED"
                ? "REJECTED"
                : "CANCELLED";
      const workflowStatus = legacyUnclassified
        ? "LEGACY_UNCLASSIFIED"
        : expired
          ? "EXPIRED"
          : request.status;
      requestRows.push({
        id: Number(request.id),
        requestId: Number(request.id),
        employeeId: Number(request.employeeId),
        branchId: Number(request.branchId),
        amount: String(request.amount),
        remaining: "0.00",
        monthlyDeduction: String(request.amount),
        sourceType: "SALARY_ADVANCE",
        payrollPeriod: request.payrollPeriod,
        status: projectedStatus,
        workflowStatus,
        financiallyDisbursed: false,
        receiptId: null,
        note:
          request.rejectionReason == null
            ? request.reason
            : [request.reason, request.rejectionReason]
                .filter(Boolean)
                .join(" — "),
        createdBy: request.createdById,
        grantedAt: request.createdAt,
        firstName: request.firstName,
        fatherName: request.fatherName,
        grandfatherName: request.grandfatherName,
        lastName: request.lastName,
        position: request.position,
        employmentStatus: request.employmentStatus,
        branchName: request.branchName,
        voucherNumber: null,
      });
    }
  }

  const materializedRows: AdvanceProjection[] = rows.map((row) => ({
    ...row,
    id: Number(row.id),
    employeeId: Number(row.employeeId),
    branchId: Number(row.branchId),
    amount: String(row.amount),
    remaining: String(row.remaining),
    monthlyDeduction:
      row.monthlyDeduction == null ? null : String(row.monthlyDeduction),
    receiptId: row.receiptId == null ? null : Number(row.receiptId),
    createdBy: row.createdBy == null ? null : Number(row.createdBy),
    requestId: null,
    workflowStatus: row.status,
    financiallyDisbursed: true,
  }));
  const allRows = [...requestRows, ...pendingRows, ...materializedRows].filter(
    (row) => !filters?.status || row.status === filters.status,
  );
  return allRows.map((r) => ({
    ...r,
    employeeName: fullEmployeeName(r),
  }));
}

/** رصيد السلف المتبقّي على موظف = مجموع remaining لسلفه النشطة. */
export async function employeeBalance(employeeId: number, branchId?: number): Promise<{ employeeId: number; balance: string; activeCount: number }> {
  const db = requireDb();
  if (branchId != null && (!Number.isInteger(branchId) || branchId <= 0)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "نطاق الفرع مطلوب." });
  }
  const rows = await db
    .select({ remaining: employeeAdvances.remaining })
    .from(employeeAdvances)
    .where(and(
      eq(employeeAdvances.employeeId, employeeId),
      eq(employeeAdvances.status, "ACTIVE"),
      branchId != null ? eq(employeeAdvances.branchId, branchId) : undefined,
    ));
  let sum = new Decimal(0);
  for (const r of rows) sum = sum.plus(money(r.remaining));
  return { employeeId, balance: toDbMoney(round2(sum)), activeCount: rows.length };
}

/* ─────────────────────────── منح سلفة ─────────────────────────── */

export interface GrantAdvanceInput {
  employeeId: number;
  branchId: number;
  amount: string;
  monthlyDeduction?: string | null;
  note?: string | null;
  /** مُرفق سند الصرف (صورة data URL أو رابط) — اختياريّ دائماً (لا إلزام مُرفق في النظام). */
  attachmentUrl?: string | null;
  /** idempotency (تدقيق ١٧/٧): إعادة إرسال بنفس المفتاح ⇒ لا سند/صرف ثانٍ (منع الصرف النقدي المزدوج). */
  clientRequestId: string;
}

/** فئة السند الافتراضية للسلف: «رواتب» (OUT، من بذرة 0036). غيابها لا يمنع المنح (فئة اختيارية). */
async function payrollCategoryIdTx(tx: Tx): Promise<number | null> {
  const [cat] = await tx
    .select({ id: voucherCategories.id })
    .from(voucherCategories)
    .where(and(eq(voucherCategories.name, "رواتب"), eq(voucherCategories.isActive, true), eq(voucherCategories.direction, "OUT")))
    .limit(1);
  return cat ? Number(cat.id) : null;
}

/**
 * منح سلفة = إنشاء طلب سند صرف معلّق فقط. لا ينشأ صف employeeAdvances ولا يبدأ الخصم
 * قبل اعتماد مالكٍ ثانٍ للسند. الاعتماد يستدعي activateAdvanceForApprovedVoucherTx داخل
 * المعاملة نفسها التي تُخرج النقد، فيصبح (الصرف + السلفة ACTIVE) أثراً ذرياً واحداً.
 */
type EmployeeAdvanceRequest = Extract<
  SystemPaymentRequest,
  { kind: "EMPLOYEE_ADVANCE" }
>;

type EmployeeAdvanceReceipt = {
  id: number;
  branchId: number | null;
  direction: string;
  amount: string;
  paymentMethod: string;
  partyType?: string | null;
  referenceNumber?: string | null;
  createdBy: number | null;
};

/** Validate the server-only capability against the locked source row and receipt facts. */
export async function assertEmployeeAdvanceVoucherRequestTx(
  tx: Tx,
  receipt: EmployeeAdvanceReceipt,
  request: EmployeeAdvanceRequest,
  options?: { requireMaterialized?: boolean },
) {
  const expectedReference = employeeAdvanceReference(request);
  if (
    expectedReference == null ||
    request.sourceHash !== employeeAdvanceSourceHash(request) ||
    receipt.referenceNumber !== expectedReference ||
    receipt.direction !== "OUT" ||
    receipt.paymentMethod !== "CASH" ||
    receipt.partyType !== "OTHER" ||
    receipt.branchId == null ||
    Number(receipt.branchId) !== request.branchId ||
    !money(receipt.amount).eq(request.expectedAmount) ||
    receipt.createdBy == null
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "بيانات سلفة الموظف أو قابليتها النظامية لا تطابق السند — أوقف العملية وراجع سجل المصدر",
    });
  }

  const provenanceKey = `ADVANCE:${request.sourceClientRequestId}`;
  const provenanceRows = await tx
    .select({ id: idempotencyKeys.id })
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.operation, "voucher.create"),
        eq(idempotencyKeys.clientRequestId, provenanceKey),
        eq(idempotencyKeys.refId, receipt.id),
      ),
    )
    .for("update")
    .limit(2);
  if (provenanceRows.length !== 1) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "مصدر إنشاء سلفة الموظف غير مثبت بمفتاح idempotency مرتبط بالسند — أوقف العملية وراجع التدقيق",
    });
  }

  let emp: typeof employees.$inferSelect | null = null;
  // الأهلية الحالية تخص إنشاء/تفعيل السلفة فقط. عند العكس نعتمد سلسلة المصدر
  // الموثقة والسلفة المادية؛ نقل الموظف أو إنهاء خدمته لاحقاً لا يجوز أن يحبس النقد.
  if (!options?.requireMaterialized) {
    [emp] = await tx
      .select()
      .from(employees)
      .where(eq(employees.id, request.employeeId))
      .for("update")
      .limit(1);
    if (!emp)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "موظف طلب السلفة غير موجود",
      });
    if (!emp.isActive || emp.employmentStatus === "terminated") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لا يمكن اعتماد سلفة لموظف معطّل أو منتهي الخدمة",
      });
    }
    if (emp.branchId != null && Number(emp.branchId) !== request.branchId) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "فرع موظف السلفة لا يطابق لقطة الطلب الموثقة",
      });
    }
    if (
      emp.userId != null &&
      Number(emp.userId) === Number(receipt.createdBy)
    ) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "لا يجوز للموظف إنشاء طلب سلفة لنفسه",
      });
    }
  }

  let materialized: typeof employeeAdvances.$inferSelect | null = null;
  if (options?.requireMaterialized) {
    [materialized] = await tx
      .select()
      .from(employeeAdvances)
      .where(eq(employeeAdvances.receiptId, receipt.id))
      .for("update")
      .limit(1);
    if (
      !materialized ||
      materialized.status !== "ACTIVE" ||
      Number(materialized.employeeId) !== request.employeeId ||
      Number(materialized.branchId) !== request.branchId ||
      !money(materialized.amount).eq(request.expectedAmount)
    ) {
      throw new TRPCError({ code: "CONFLICT", message: "سجل السلفة المادي لا يطابق السند الموثق" });
    }
  }
  return { employee: emp, materialized };
}

/**
 * سقف السلف غير المسدّدة يُحسم عند الاعتماد، لا عند إنشاء الطلب.
 *
 * قفل الموظف في المستدعي هو قفل التجميع الحاكم: كل تفعيل لسلفة الموظف نفسه يمرّ به،
 * لذلك لا يستطيع اعتمادان متزامنان قراءة الرصيد القديم معاً. نقفل صفوف ACTIVE أيضاً
 * كي يكون مجموع remaining لقطةً مستقرة أمام تسويات/إلغاءات الرواتب المتزامنة.
 * الطلبات المعلّقة ليست أصلاً ولا التزاماً على الموظف، فلا تدخل المجموع؛ لكنها تُعاد
 * محاكمتها هنا لحظة تحوّلها إلى ACTIVE وخروج النقد فعلياً.
 */
async function assertAdvanceOutstandingLimitTx(tx: Tx, employeeId: number, requested: Decimal): Promise<void> {
  const active = await tx
    .select({ id: employeeAdvances.id, remaining: employeeAdvances.remaining })
    .from(employeeAdvances)
    .where(and(eq(employeeAdvances.employeeId, employeeId), eq(employeeAdvances.status, "ACTIVE")))
    .orderBy(asc(employeeAdvances.id))
    .for("update");

  const outstanding = active.reduce((sum, row) => sum.plus(money(row.remaining)), new Decimal(0));
  const limit = money(getApprovalThreshold());
  if (outstanding.plus(requested).gt(limit)) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `اعتماد السلفة يتجاوز سقف السلف غير المسدَّدة (${toDbMoney(limit)} د.ع) — الرصيد القائم ${toDbMoney(outstanding)} د.ع. سدِّد القائم أو ارفض الطلب.`,
    });
  }
}

export async function activateAdvanceForApprovedVoucherTx(
  tx: Tx,
  receipt: EmployeeAdvanceReceipt,
  request: EmployeeAdvanceRequest,
): Promise<number> {
  await assertEmployeeAdvanceVoucherRequestTx(tx, receipt, request);

  const [existing] = await tx.select({ id: employeeAdvances.id })
    .from(employeeAdvances).where(eq(employeeAdvances.receiptId, receipt.id)).limit(1);
  if (existing) return Number(existing.id);

  const amount = money(request.expectedAmount);
  const period = baghdadToday().slice(0, 7);
  await assertAdvanceOutstandingLimitTx(tx, request.employeeId, amount);
  const capacity = await getEmployeeAdvanceCapacityTx(tx, {
    employeeId: request.employeeId,
    scopedBranchId: request.branchId,
    period,
    lock: true,
  });
  assertAdvanceWithinCapacity(amount, capacity);
  const result = await tx.insert(employeeAdvances).values({
    employeeId: request.employeeId,
    branchId: request.branchId,
    amount: toDbMoney(amount),
    remaining: toDbMoney(amount),
    monthlyDeduction: toDbMoney(amount),
    sourceType: "SALARY_ADVANCE",
    payrollPeriod: period,
    status: "ACTIVE",
    receiptId: receipt.id,
    note: request.note,
    createdBy: receipt.createdBy!,
  });
  const advanceId = extractInsertId(result);
  await autoSyncEmployeeAdvanceToDraftPayrollTx(
    tx,
    request.employeeId,
    period,
  );
  return advanceId;
}

export async function grantAdvance(input: GrantAdvanceInput, actor: Actor) {
  if (!input.clientRequestId?.trim()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "معرّف الطلب إلزامي لمنع صرف السلفة مرتين" });
  }
  const amount = money(input.amount);
  if (amount.lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "مبلغ السلفة يجب أن يكون موجباً" });
  const monthly = input.monthlyDeduction != null && String(input.monthlyDeduction).trim() !== "" ? money(input.monthlyDeduction) : null;
  if (monthly != null) {
    if (monthly.lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "الخصم الشهري يجب أن يكون موجباً (أو اتركه فارغاً = خصم أقصى الممكن)" });
    if (monthly.gt(amount)) throw new TRPCError({ code: "BAD_REQUEST", message: "الخصم الشهري لا يتجاوز مبلغ السلفة" });
  }

  return withTx(async (tx) => {
    const resolvedActor = await resolveApprovalActor(tx, actor);
    const ownerAutoApproves =
      resolvedActor.isOwner &&
      planApproval({
        actor: resolvedActor,
        trigger: voucherApprovalTrigger("OUT", "EMPLOYEE_ADVANCE"),
      }).executeNow;
    if (ownerAutoApproves) {
      const [existingVoucherKey] = await tx
        .select({ refId: idempotencyKeys.refId })
        .from(idempotencyKeys)
        .where(
          and(
            eq(idempotencyKeys.operation, "voucher.create"),
            eq(
              idempotencyKeys.clientRequestId,
              `ADVANCE:${input.clientRequestId}`,
            ),
          ),
        )
        .limit(1);
      if (!existingVoucherKey) {
        // مسار المالك وحده سينفّذ الصرف الآن: درج المنفّذ يسبق أقفال الفرع/الموظف.
        // الطلب المعلّق وreplay الملتزم لا يحتاجان وردية جديدة ولا أثراً نقدياً جديداً.
        const shiftId = await requireOpenShiftIdTx(
          tx,
          resolvedActor.userId,
          input.branchId,
          "صرف سلفة موظف من درج المنفّذ",
        );
        await lockCashSourceForUpdate(tx, {
          branchId: input.branchId,
          cashBucket: "DRAWER",
          shiftId,
        });
      }
    }

    // لقطة أهلية واسم لطلبٍ صفر الأثر فقط؛ لا نقفل الموظف قبل درج الصرف.
    // عند اعتماد المالك يعيد activateAdvanceForApprovedVoucherTx التحقق ويقفل الموظف
    // بعد أن يكون مسار الاعتماد قد قفل مصدر النقد/الوردية بالترتيب الحاكم.
    const [emp] = await tx.select().from(employees).where(eq(employees.id, input.employeeId)).limit(1);
    if (!emp) throw new TRPCError({ code: "NOT_FOUND", message: "الموظف غير موجود" });
    if (!emp.isActive || emp.employmentStatus === "terminated") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا تُمنح سلفة لموظف معطَّل أو منتهي الخدمة" });
    }
    if (emp.userId != null && Number(emp.userId) === Number(actor.userId)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "لا تطلب سلفةً لنفسك — فصل المهام يوجب أن ينشئها مستخدمٌ آخر" });
    }
    if (emp.branchId != null && Number(emp.branchId) !== Number(input.branchId)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "فرع صرف السلفة يجب أن يطابق فرع الموظف" });
    }
    const empName = fullEmployeeName(emp);
    const source = {
      employeeId: input.employeeId,
      branchId: input.branchId,
      expectedAmount: toDbMoney(amount),
      monthlyDeduction: monthly == null ? null : toDbMoney(monthly),
      note: input.note?.trim() || null,
      sourceClientRequestId: input.clientRequestId.trim(),
    };
    const systemRequest: EmployeeAdvanceRequest = {
      kind: "EMPLOYEE_ADVANCE",
      ...source,
      sourceHash: employeeAdvanceSourceHash(source),
    };
    const referenceNumber = employeeAdvanceReference(systemRequest);
    if (!referenceNumber) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر اشتقاق مرجع سلفة الموظف" });
    }

    const voucher = await createVoucherTx(tx, {
      voucherType: "PAYMENT",
      branchId: input.branchId,
      amount: toDbMoney(amount),
      paymentMethod: "CASH",
      partyType: "OTHER",
      counterpartyName: empName,
      referenceNumber,
      description: `سلفة موظف — ${empName}${input.note?.trim() ? ` — ${input.note.trim()}` : ""}`,
      voucherCategoryId: await payrollCategoryIdTx(tx),
      // المُرفق اختياريّ (٣١/٧: أُلغيت عتبة إلزام المُرفق من النظام كله).
      attachmentUrl: input.attachmentUrl?.trim() || null,
      clientRequestId: `ADVANCE:${input.clientRequestId}`,
    }, actor, { systemRequest });
    const [storedReceipt] = await tx.select().from(receipts).where(eq(receipts.id, voucher.receiptId)).limit(1);
    if (
      storedReceipt?.referenceNumber !== referenceNumber ||
      storedReceipt.internalNote == null ||
      !storedReceipt.internalNote.includes(`\"sourceHash\":\"${systemRequest.sourceHash}\"`)
    ) {
      throw new TRPCError({ code: "CONFLICT", message: "تعارض idempotency: معرّف الطلب مستعمل لسلفة ببيانات مختلفة" });
    }
    const [active] = await tx.select().from(employeeAdvances)
      .where(eq(employeeAdvances.receiptId, voucher.receiptId)).limit(1);
    if (active) return { ...active, employeeName: empName, voucherNumber: voucher.voucherNumber };
    return {
      id: null,
      employeeId: input.employeeId,
      branchId: input.branchId,
      amount: toDbMoney(amount),
      remaining: toDbMoney(amount),
      monthlyDeduction: monthly == null ? null : toDbMoney(monthly),
      status: "PENDING_APPROVAL" as const,
      receiptId: voucher.receiptId,
      note: systemRequest.note,
      createdBy: actor.userId,
      employeeName: empName,
      voucherNumber: voucher.voucherNumber,
      approvalStatus: voucher.approvalStatus,
    };
  });
}

/* ─────────────────────────── إلغاء سلفة ─────────────────────────── */

/**
 * A restored balance is not an untouched balance: APPLY/REVERSE rows are an
 * immutable recovery history. Lock every recovery ledger in the same order as
 * voucher cancellation before deciding that direct cancellation is safe.
 */
async function assertNoAdvanceRecoveryHistoryTx(
  tx: Tx,
  advanceId: number,
): Promise<void> {
  const settlement = (
    await tx
      .select({ id: advanceSettlements.id })
      .from(advanceSettlements)
      .where(eq(advanceSettlements.advanceId, advanceId))
      .for("update")
      .limit(1)
  )[0];
  const repaymentAllocation = (
    await tx
      .select({ id: employeeAdvanceRepaymentAllocations.id })
      .from(employeeAdvanceRepaymentAllocations)
      .where(eq(employeeAdvanceRepaymentAllocations.advanceId, advanceId))
      .for("update")
      .limit(1)
  )[0];
  const terminationAllocation = (
    await tx
      .select({ id: terminationAdvanceAllocations.id })
      .from(terminationAdvanceAllocations)
      .where(eq(terminationAdvanceAllocations.advanceId, advanceId))
      .for("update")
      .limit(1)
  )[0];
  if (settlement || repaymentAllocation || terminationAllocation) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: "لا يمكن إلغاء السلفة بعد استعمالها أو تسويتها كلياً أو جزئياً",
        why: "توجد قيود استيفاء مرتبطة بالسلفة، حتى إن أُعيد رصيدها بعد العكس",
        doThis: "راجع قيود الاستيفاء المرتبطة وصحّح الالتزام عبر مسار تسوية موثّق يحفظ تاريخ الاسترداد",
      }),
    });
  }
}

/**
 * إلغاء التزام موظف غير مستعمل، بحسب مصدره:
 * - SALARY_ADVANCE: بعد عكس/رفض سند الصرف وإثبات عودة النقد فقط.
 * - OTHER_DEDUCTION بلا سند: إسقاط الاستقطاع التشغيلي وحده؛ يبقى قيد المصدر
 *   (مثل خسارة العهدة) وحالة العهدة كما هما، ولا تُنشأ حركة نقد أو مخزون.
 * - كل سجل مرتبط بسند، بصرف النظر عن تصنيفه التاريخي: يمرّ بحارس عكس/رفض
 *   السند نفسه. التصنيف الخشن لا يلغي دليلاً نقدياً صالحاً ولا يستبدله.
 *
 * ⚠️ لماذا يُشترط عكس السند أولاً (ثغرة حرجة كانت مفتوحة): إلغاء السلفة يمحو التزام
 * السداد (لا تُخصم من الرواتب بعدها)، بينما النقد خرج فعلاً من الخزينة لحظة المنح.
 * وبما أن المنح تحت العتبة يُنشئ سنداً **معتمَداً فوراً** بفاعلٍ واحد، كان بوسع مستخدمٍ
 * واحد بصلاحية hr=FULL أن يمنح نفسه ٩٩٩٬٠٠٠ ثم يلغيها فيبقى النقد بلا دَينٍ ولا أثر.
 * كان التنبيه نصّياً فقط (voucherNotice) ولا شيء يفرضه.
 *
 * الآن: عكس السند يُنفَّذ من شاشة السندات (حيث فصل المهام مفروض)، ثم تُلغى السلفة.
 * الترتيب مقصود — النقد يعود أولاً، والالتزام يسقط بعده، فلا نافذة يسقط فيها الالتزام وحده.
 */
export async function cancelAdvance(input: { advanceId: number; reason?: string | null }, actor: Actor) {
  return withTx(async (tx) => {
    await assertOperationAuthorityTx(
      tx,
      actor,
      "payroll.advanceCancel",
      currentHrWriteAllowed,
    );
    const scopedCondition = canCrossBranches(actor)
      ? eq(employeeAdvances.id, input.advanceId)
      : and(
          eq(employeeAdvances.id, input.advanceId),
          eq(employeeAdvances.branchId, actor.branchId),
        );
    const [adv] = await tx
      .select()
      .from(employeeAdvances)
      .where(scopedCondition)
      .for("update")
      .limit(1);
    if (!adv)
      throw new TRPCError({ code: "NOT_FOUND", message: "السلفة غير موجودة" });
    if (adv.status !== "ACTIVE")
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "تُلغى السلف النشطة فقط",
      });
    if (!money(adv.remaining).eq(money(adv.amount))) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "لا تُلغى سلفة خُصم منها فعلاً — بقيّتها تُخصم من الرواتب القادمة حتى التسوية",
      });
    }
    await assertNoAdvanceRecoveryHistoryTx(tx, Number(adv.id));

    const isNoncashWaiver =
      adv.sourceType === "OTHER_DEDUCTION" && adv.receiptId == null;
    let voucherNotice: string;
    if (isNoncashWaiver) {
      voucherNotice =
        "أُلغي الاستقطاع غير النقدي بلا حركة نقد أو مخزون؛ بقي أثر المصدر وقيده محفوظين.";
    } else {
      if (adv.receiptId == null) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "لا يمكن إلغاء السلفة",
            why: "رابط سند الصرف مفقود، لذلك لا يمكن إثبات عودة النقد",
            doThis: "نفّذ مطابقة مالية لسند الصرف قبل إعادة الإلغاء",
          }),
        });
      }
      const [rc] = await tx
        .select({ status: receipts.status, voucherNumber: receipts.voucherNumber, approvalStatus: receipts.approvalStatus })
        .from(receipts)
        .where(eq(receipts.id, Number(adv.receiptId)))
        .for("update")
        .limit(1);
      // REVERSED = عُكس السند وعاد النقد. REJECTED = لم يُصرف أصلاً. ما عداهما ⇒ النقد بالخارج.
      if (!rc) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "لا يمكن إلغاء السلفة",
            why: "سند الصرف المرتبط غير موجود",
            doThis: "نفّذ مطابقة مالية للسلفة وسندها قبل إعادة الإلغاء",
          }),
        });
      }
      const cashReturned =
        rc.status === "REVERSED" || rc.approvalStatus === "REJECTED";
      if (!cashReturned) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `لا تُلغى السلفة وسند صرفها ما زال سارياً — النقد خرج من الخزينة، وإلغاء السلفة وحده يمحو التزام السداد. ألغِ السند ${rc.voucherNumber ?? ""} من شاشة السندات أولاً (يمرّ بفصل المهام) ثم أعد الإلغاء.`.trim(),
        });
      }
      voucherNotice =
        "أُلغيت السلفة بعد عكس سند صرفها — لا نقد خارج الخزينة بلا التزام.";
    }
    const reason = input.reason?.trim();
    const cancellationNote =
      isNoncashWaiver
        ? reason
          ? `إلغاء استقطاع غير نقدي: ${reason}`
          : "أُلغي الاستقطاع غير النقدي"
        : reason
          ? `إلغاء: ${reason}`
          : "أُلغيت";
    const note = [adv.note, cancellationNote]
      .filter(Boolean)
      .join(" — ")
      .slice(0, 255);
    const [cancelled] = await tx
      .update(employeeAdvances)
      .set({ status: "CANCELLED", note })
      .where(
        and(
          scopedCondition,
          eq(employeeAdvances.status, "ACTIVE"),
          eq(employeeAdvances.remaining, adv.remaining),
        ),
      );
    if (cancelled.affectedRows !== 1) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "لم يكتمل إلغاء السلفة",
          why: "تغيّرت السلفة أثناء الإلغاء",
          doThis: "حدّث الصفحة وأعد مطابقة الرصيد وسند الصرف",
        }),
      });
    }
    return {
      id: input.advanceId,
      status: "CANCELLED" as const,
      receiptId: adv.receiptId != null ? Number(adv.receiptId) : null,
      voucherNotice,
    };
  });
}

/* ─────────────────────────── اقتراح استقطاعات الشهر ─────────────────────────── */

export interface SuggestedDeduction {
  advanceId: number;
  suggested: Decimal;
}

/**
 * اقتراح استقطاع الشهر لكل موظف من **جميع** سلفه النشطة:
 * suggested = مجموع min(monthlyDeduction ?? remaining، remaining) لجميع سلف الموظف النشطة.
 * يُستدعى داخل معاملة توليد المسيّر ومزامنة المسودة قبل الاعتماد.
 */
export async function suggestDeductionsTx(
  tx: Tx,
  employeeIds: number[],
  payrollPeriod?: string,
  options: { lockCurrent?: boolean } = {},
): Promise<Map<number, SuggestedDeduction>> {
  const out = new Map<number, SuggestedDeduction>();
  const scopedEmployeeIds = Array.from(new Set(employeeIds.map(Number))).sort(
    (left, right) => left - right,
  );
  if (scopedEmployeeIds.length === 0) return out;
  const query = tx
    .select()
    .from(employeeAdvances)
    .where(and(inArray(employeeAdvances.employeeId, scopedEmployeeIds), eq(employeeAdvances.status, "ACTIVE")))
    .orderBy(asc(employeeAdvances.id));
  const rows = options.lockCurrent ? await query.for("update") : await query;
  for (const adv of rows) {
    const empId = Number(adv.employeeId);
    const remaining = money(adv.remaining);
    if (remaining.lte(0)) continue;
    if (
      adv.sourceType === "SALARY_ADVANCE" &&
      payrollPeriod != null &&
      adv.payrollPeriod !== payrollPeriod
    ) {
      continue;
    }
    const monthly =
      adv.sourceType === "SALARY_ADVANCE"
        ? remaining
        : adv.monthlyDeduction != null
          ? money(adv.monthlyDeduction)
          : remaining;
    const dueForThisAdv = round2(Decimal.min(monthly, remaining));
    if (dueForThisAdv.lte(0)) continue;

    const existing = out.get(empId);
    if (existing) {
      existing.suggested = round2(existing.suggested.plus(dueForThisAdv));
    } else {
      out.set(empId, { advanceId: Number(adv.id), suggested: dueForThisAdv });
    }
  }
  return out;
}

/** نسخة عامة (خارج معاملة) — للاستعلام من الراوتر/الواجهة. */
export async function suggestDeductionsForPeriod(
  employeeIds: number[],
  payrollPeriod?: string,
): Promise<Record<number, { advanceId: number; suggested: string }>> {
  return withTx(async (tx) => {
    const map = await suggestDeductionsTx(tx, employeeIds, payrollPeriod);
    const out: Record<number, { advanceId: number; suggested: string }> = {};
    map.forEach((v, empId) => {
      out[empId] = { advanceId: v.advanceId, suggested: toDbMoney(v.suggested) };
    });
    return out;
  });
}

/* ─────────────────────────── تسوية عند صرف المسيّر ─────────────────────────── */

/**
 * تُستدعى من payRun داخل معاملة الدفع: لكل بند advanceDeduction > 0 تُنقص أرصدة سلف
 * الموظف النشطة بتوزيع عادل على الأقساط الشهرية ثم الأقدم أولاً؛ بلوغ الصفر ⇒ SETTLED.
 */
export async function settleAdvancesOnPayTx(
  tx: Tx,
  items: { employeeId: number; amount: Decimal }[],
  runId: number,
): Promise<void> {
  for (const item of items) {
    let left = round2(item.amount);
    if (left.lte(0)) continue;
    const advs = await tx
      .select()
      .from(employeeAdvances)
      .where(and(eq(employeeAdvances.employeeId, item.employeeId), eq(employeeAdvances.status, "ACTIVE")))
      .orderBy(asc(employeeAdvances.id))
      .for("update");

    const currentRem = new Map<number, Decimal>();
    for (const adv of advs) currentRem.set(Number(adv.id), money(adv.remaining));

    // مرحلة 1: استقطاع القسط المستحق لكل سلفة
    for (const adv of advs) {
      if (left.lte(0)) break;
      const rem = currentRem.get(Number(adv.id)) ?? money(0);
      if (rem.lte(0)) continue;
      const installment = adv.monthlyDeduction != null ? money(adv.monthlyDeduction) : rem;
      const due = round2(Decimal.min(installment, rem));
      const take = round2(Decimal.min(due, left));
      if (take.lte(0)) continue;

      const after = round2(rem.minus(take));
      currentRem.set(Number(adv.id), after);
      left = round2(left.minus(take));

      await tx
        .update(employeeAdvances)
        .set({ remaining: toDbMoney(after), status: after.lte(0) ? "SETTLED" : "ACTIVE" })
        .where(eq(employeeAdvances.id, Number(adv.id)));
      await tx.insert(advanceSettlements).values({
        runId,
        advanceId: Number(adv.id),
        employeeId: item.employeeId,
        amount: toDbMoney(take),
      });
    }

    // مرحلة 2: في حال وجود فائض، استيفاؤه من أقدم السلف المتبقية
    if (left.gt(0)) {
      for (const adv of advs) {
        if (left.lte(0)) break;
        const rem = currentRem.get(Number(adv.id)) ?? money(0);
        if (rem.lte(0)) continue;
        const take = round2(Decimal.min(rem, left));
        if (take.lte(0)) continue;

        const after = round2(rem.minus(take));
        currentRem.set(Number(adv.id), after);
        left = round2(left.minus(take));

        await tx
          .update(employeeAdvances)
          .set({ remaining: toDbMoney(after), status: after.lte(0) ? "SETTLED" : "ACTIVE" })
          .where(eq(employeeAdvances.id, Number(adv.id)));
        await tx.insert(advanceSettlements).values({
          runId,
          advanceId: Number(adv.id),
          employeeId: item.employeeId,
          amount: toDbMoney(take),
        });
      }
    }

    if (left.gt(0)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "استقطاع سلفة في المسيّر يفوق أرصدة السلف النشطة للموظف (أُلغيت سلفة بعد التوليد؟) — أعد المسيّر لمسودة وولّده من جديد",
      });
    }
  }
}

/**
 * استعادة تسويات سلف مسيّرٍ عند **حذفه** (تدقيق ١٧/٧): تُعيد remaining لكل سلفة سُوّيت بهذا المسيّر
 * وتُعيدها ACTIVE، ثم تحذف سجلّات التسوية. لا تُستدعى عند **عكس** الدفع (إعادة الدفع لا تُعيد التسوية
 * عبر isFirstPay) — فقط عند الحذف النهائيّ، وإلا أعاد توليدُ مسيّرٍ جديد خصماً مضاعفاً على السلفة.
 */
export async function restoreAdvanceSettlementsTx(tx: Tx, runId: number): Promise<void> {
  const settlements = await tx.select().from(advanceSettlements).where(eq(advanceSettlements.runId, runId));
  for (const st of settlements) {
    const [adv] = await tx
      .select()
      .from(employeeAdvances)
      .where(eq(employeeAdvances.id, Number(st.advanceId)))
      .for("update")
      .limit(1);
    if (!adv) continue;
    // القيمة الأصلية amount سقفٌ (لا تتجاوزه الاستعادة). remaining يعود موجباً ⇒ ACTIVE (السلفة لا
    // تُلغى بعد أيّ خصم، فحالة CANCELLED غير واردة هنا).
    const restored = Decimal.min(round2(money(adv.remaining).plus(money(st.amount))), money(adv.amount));
    await tx
      .update(employeeAdvances)
      .set({ remaining: toDbMoney(restored), status: restored.gt(0) ? "ACTIVE" : adv.status })
      .where(eq(employeeAdvances.id, Number(adv.id)));
  }
  await tx.delete(advanceSettlements).where(eq(advanceSettlements.runId, runId));
}
