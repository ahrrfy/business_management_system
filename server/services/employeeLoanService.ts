import { and, desc, eq, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { appErrorMessage } from "@shared/errors";
import { fullEmployeeName } from "@shared/hr";
import { levelSatisfies } from "@shared/permissions";
import {
  accountingEntries,
  employeeAdvances,
  employeeLoanRequests,
  employees,
  idempotencyKeys,
  receipts,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { withTx, type Actor, type MaybeScopedActor } from "./tx";
import { money, toDbMoney } from "./money";
import { extractInsertId } from "../lib/insertId";
import { openShiftIdTx, requireOpenShiftIdTx } from "./shiftService";
import { postEntry } from "./ledgerService";
import {
  createPostingIntent,
  signedPostingLines,
  type PostingSourceComponents,
} from "./accounting/postingEngine";
import {
  assertCashOutAvailable,
  computeDrawerCashBalance,
  lockCashSourceForUpdate,
} from "./cash/cashAvailability";
import { baghdadToday, todayUtcDate } from "./businessDay";
import {
  assertAdvanceWithinCapacity,
  getEmployeeAdvanceCapacityTx,
} from "./employeeAdvanceCapacityService";
import { canCrossBranches } from "../lib/branchAuthority";
import { computeSignature, nextVoucherNumber } from "./voucher/helpers";
import { autoSyncEmployeeAdvanceToDraftPayrollTx } from "./payroll/syncAdvances";
import {
  employeeAdvanceReference,
  employeeAdvanceSourceHash,
  encodeSystemPaymentRequest,
  isCanonicalSystemPaymentRequest,
  parseSystemPaymentRequest,
  type SystemPaymentRequest,
} from "./voucher/create";
import { recordIdempotencyKey } from "./idempotency";
import {
  assertOperationAuthorityTx,
  type StoredOperationSnapshot,
} from "./authorization/operationAuthority";

function currentHrWriteAllowed(current: StoredOperationSnapshot): boolean {
  return (
    current.isOwner === true ||
    levelSatisfies(current.resolvedPermissions?.hr, "FULL")
  );
}

function requireDb() {
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL not set");
  return db;
}

export type LoanRequestStatus =
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "CANCELLED"
  | "DISBURSED";

export interface RequestLoanInput {
  employeeId: number;
  /** حقل توافق قديم؛ المرجع الحاكم هو فرع الموظف ويجب أن يطابقه إن أُرسل. */
  branchId?: number | null;
  amount: string | number;
  /** حقول توافق قديمة مقبولة فقط إذا عبّرت صراحةً عن تسوية شهر واحد. */
  installmentsCount?: number | null;
  monthlyDeduction?: string | number | null;
  reason?: string | null;
  clientRequestId: string;
}

function assertSingleMonthAdvanceTerms(
  input: RequestLoanInput,
  amount: Decimal,
): void {
  if (input.installmentsCount != null && input.installmentsCount !== 1) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "شروط السلفة غير صالحة",
        why: "السلفة الجديدة تُسوّى كاملةً في شهر الطلب ولا تقبل أكثر من قسط واحد",
        doThis: "اجعل عدد الأقساط 1 أو احذف الحقل القديم",
      }),
    });
  }
  if (input.monthlyDeduction == null) return;

  let monthlyDeduction: Decimal;
  try {
    monthlyDeduction = money(input.monthlyDeduction);
  } catch {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "قيمة تسوية السلفة غير صالحة",
        why: "قيمة الخصم الشهري القديمة ليست مبلغاً مالياً صالحاً",
        doThis: "اجعل الخصم الشهري مساوياً لمبلغ السلفة أو احذف الحقل القديم",
      }),
    });
  }
  if (!monthlyDeduction.eq(amount)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "شروط السلفة غير صالحة",
        why: "الخصم الشهري يجب أن يساوي مبلغ السلفة لأن التسوية تتم كاملةً في شهر الطلب",
        doThis: "اجعل الخصم الشهري مساوياً لمبلغ السلفة أو احذف الحقل القديم",
      }),
    });
  }
}

function assertLegacyBranchMatchesEmployee(
  requestedBranchId: number | null | undefined,
  employeeBranchId: number,
): void {
  if (requestedBranchId == null) return;
  if (Number(requestedBranchId) === employeeBranchId) return;
  throw new TRPCError({
    code: "BAD_REQUEST",
    message: appErrorMessage({
      what: "فرع طلب السلفة غير صحيح",
      why: "الفرع المرسل في الحقل القديم لا يطابق الفرع الحالي للموظف",
      doThis: "حدّث بيانات الموظف أو أعد الطلب بفرع الموظف الصحيح",
    }),
  });
}

type EmployeeAdvanceSystemRequest = Extract<
  SystemPaymentRequest,
  { kind: "EMPLOYEE_ADVANCE" }
>;

function sameLoanRequestPayload(
  existing: typeof employeeLoanRequests.$inferSelect,
  input: RequestLoanInput,
  amount: Decimal,
): boolean {
  return (
    Number(existing.employeeId) === input.employeeId &&
    money(existing.amount).eq(amount) &&
    (existing.reason ?? "") === (input.reason?.trim() ?? "")
  );
}

function loanRequestReplay(
  actor: MaybeScopedActor,
  existing: typeof employeeLoanRequests.$inferSelect,
  input: RequestLoanInput,
  amount: Decimal,
) {
  if (!sameLoanRequestPayload(existing, input, amount)) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذّرت إعادة طلب السلفة",
        why: "مفتاح الإرسال استُعمل سابقاً ببيانات مختلفة",
        doThis: "حدّث الصفحة وأنشئ طلباً جديداً بمفتاح جديد",
      }),
    });
  }
  assertRequestBranch(actor, Number(existing.branchId));
  assertLegacyBranchMatchesEmployee(input.branchId, Number(existing.branchId));
  return {
    id: Number(existing.id),
    status: existing.status,
    payrollPeriod: existing.payrollPeriod,
    replayed: true,
  };
}

function scopedBranch(actor: MaybeScopedActor): number | null {
  if (canCrossBranches(actor)) return null;
  if (actor.branchId == null) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذّر تنفيذ عملية السلفة",
        why: "لا يوجد فرع مسند للمستخدم",
        doThis: "راجع مسؤول النظام لتعيين فرع للحساب",
      }),
    });
  }
  return Number(actor.branchId);
}

function assertRequestBranch(actor: MaybeScopedActor, branchId: number): void {
  const scoped = scopedBranch(actor);
  if (scoped != null && scoped !== Number(branchId)) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: "تعذّر تنفيذ عملية السلفة",
        why: "الطلب غير موجود ضمن نطاق فرعك",
        doThis: "أعد فتح قائمة السلف من الفرع الصحيح",
      }),
    });
  }
}

/** تقديم طلب سلفة / قرض (ذاتي عبر التطبيق أو من الموظف). */
export async function requestEmployeeLoan(
  actor: MaybeScopedActor,
  input: RequestLoanInput,
  authorityPath:
    | "payroll.advanceGrant"
    | "hrEnterprise.loans.request" = "payroll.advanceGrant",
) {
  return withTx(async (tx) => {
    await assertOperationAuthorityTx(
      tx,
      actor,
      authorityPath,
      currentHrWriteAllowed,
    );
    const amount = money(input.amount);
    if (amount.lte(0)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "مبلغ السلفة غير صحيح",
          why: "يجب أن يكون مبلغ السلفة المطلوب أكبر من صفر",
          doThis: "أدخل مبلغ سلفة صالحاً وموجباً",
        }),
      });
    }
    assertSingleMonthAdvanceTerms(input, amount);

    const clientRequestId = input.clientRequestId.trim();
    if (!clientRequestId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر تسجيل طلب السلفة",
          why: "مفتاح إعادة إرسال طلب السلفة مطلوب لمنع تكرار الطلب",
          doThis: "أعد فتح نموذج السلفة ثم أرسل الطلب من جديد",
        }),
      });
    }
    const [existingBeforeLock] = await tx
      .select()
      .from(employeeLoanRequests)
      .where(eq(employeeLoanRequests.clientRequestId, clientRequestId))
      .limit(1);
    if (existingBeforeLock) {
      return loanRequestReplay(actor, existingBeforeLock, input, amount);
    }

    const period = baghdadToday().slice(0, 7);
    const capacity = await getEmployeeAdvanceCapacityTx(tx, {
      employeeId: input.employeeId,
      scopedBranchId: scopedBranch(actor),
      period,
      lock: true,
    });
    // القراءة القافلة بعد قفل الموظف هي الحسم في سباق طلبين بالمفتاح نفسه:
    // الخاسر يرى صف الفائز الحالي تحت REPEATABLE READ ويعيده بدل رفض السعة أو duplicate-key.
    const [existingAfterLock] = await tx
      .select()
      .from(employeeLoanRequests)
      .where(eq(employeeLoanRequests.clientRequestId, clientRequestId))
      .for("share")
      .limit(1);
    if (existingAfterLock) {
      return loanRequestReplay(actor, existingAfterLock, input, amount);
    }
    assertAdvanceWithinCapacity(amount, capacity);
    const branchId = capacity.branchId;
    assertLegacyBranchMatchesEmployee(input.branchId, branchId);

    const [res] = await tx.insert(employeeLoanRequests).values({
      employeeId: input.employeeId,
      branchId,
      amount: toDbMoney(amount),
      installmentsCount: 1,
      monthlyDeduction: toDbMoney(amount),
      payrollPeriod: period,
      clientRequestId,
      reason: input.reason?.trim() || null,
      status: "PENDING",
      createdById: actor.userId,
    });

    return {
      id: res.insertId,
      status: "PENDING" as const,
      payrollPeriod: period,
      maxAvailable: capacity.maxAvailable,
      replayed: false,
    };
  });
}

/** مراجعة طلب السلفة (اعتماد أو رفض) من قبل الإدارة. */
export async function reviewEmployeeLoanRequest(
  actor: MaybeScopedActor,
  input: { id: number; action: "APPROVE" | "REJECT"; rejectionReason?: string },
) {
  return withTx(async (tx) => {
    await assertOperationAuthorityTx(
      tx,
      actor,
      "hrEnterprise.loans.review",
      currentHrWriteAllowed,
    );
    const [lr] = await tx
      .select()
      .from(employeeLoanRequests)
      .where(eq(employeeLoanRequests.id, input.id))
      .for("update")
      .limit(1);

    if (!lr) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر مراجعة طلب السلفة",
          why: "طلب السلفة المطلوب غير موجود في سجلات النظام",
          doThis: "تحقّق من رقم الطلب وأعد المحاولة من قائمة السلف",
        }),
      });
    }

    assertRequestBranch(actor, Number(lr.branchId));

    if (lr.status !== "PENDING") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "لا يمكن مراجعة طلب السلفة",
          why: `طلب السلفة ليس بحالة معلقة (${lr.status}) بل تم البت فيه مسبقاً`,
          doThis: "يمكن مراجعة واعتماد الطلبات المعلقة (PENDING) فقط",
        }),
      });
    }

    if (
      input.action === "APPROVE" &&
      lr.payrollPeriod !== baghdadToday().slice(0, 7)
    ) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "لا يمكن اعتماد طلب السلفة",
          why:
            lr.payrollPeriod == null
              ? "الطلب تاريخي وغير مصنف على شهر راتب موثوق"
              : `انتهى شهر الطلب (${lr.payrollPeriod}) دون صرفه`,
          doThis:
            "ألغِ الطلب القديم وأنشئ طلباً جديداً للشهر الجاري ليعاد احتساب الحد واعتماده",
        }),
      });
    }

    if (lr.createdById === actor.userId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "غير مصرّح باعتماد السلفة",
          why: "مبدأ فصل المهام (Maker-Checker): لا يجوز لمقدم طلب السلفة اعتماده بنفسه",
          doThis: "اطلب من مدير الفرع أو المسؤول المالي مراجعة واعتماد الطلب",
        }),
      });
    }

    const newStatus: LoanRequestStatus = input.action === "APPROVE" ? "APPROVED" : "REJECTED";

    const [updated] = await tx
      .update(employeeLoanRequests)
      .set({
        status: newStatus,
        reviewedById: actor.userId,
        reviewedAt: sql`NOW()`,
        rejectionReason: input.action === "REJECT" ? input.rejectionReason?.trim() || "مرفوض من الإدارة" : null,
      })
      .where(
        and(
          eq(employeeLoanRequests.id, input.id),
          eq(employeeLoanRequests.status, "PENDING"),
        ),
      );

    if (updated.affectedRows !== 1) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر تثبيت قرار السلفة",
          why: "تغيّرت حالة الطلب أثناء المراجعة",
          doThis: "حدّث القائمة وراجع الحالة الحالية قبل إعادة المحاولة",
        }),
      });
    }

    return { id: input.id, status: newStatus };
  });
}

/** إلغاء طلب لم يُصرف بعد. العملية صفرية الأثر ولا تمس إيصالاً أو سلفة فعالة. */
export async function cancelEmployeeLoanRequest(
  actor: MaybeScopedActor,
  input: { id: number; reason?: string | null },
) {
  return withTx(async (tx) => {
    await assertOperationAuthorityTx(
      tx,
      actor,
      "hrEnterprise.loans.cancel",
      currentHrWriteAllowed,
    );
    const [request] = await tx
      .select()
      .from(employeeLoanRequests)
      .where(eq(employeeLoanRequests.id, input.id))
      .for("update")
      .limit(1);
    if (!request) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر إلغاء طلب السلفة",
          why: "طلب السلفة غير موجود ضمن السجلات المتاحة",
          doThis: "حدّث قائمة السلف واختر الطلب من فرعه الصحيح",
        }),
      });
    }
    assertRequestBranch(actor, Number(request.branchId));
    if (request.status === "CANCELLED") {
      return { id: input.id, status: "CANCELLED" as const, replayed: true };
    }
    if (request.status !== "PENDING" && request.status !== "APPROVED") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "لا يمكن إلغاء طلب السلفة",
          why: "لا يُلغى إلا طلب سلفة معلّق أو معتمد لم يُصرف بعد",
          doThis: "إن صُرفت السلفة فاستخدم عكس سند الصرف أو تسوية السلفة المرتبطة بها",
        }),
      });
    }
    const [updated] = await tx
      .update(employeeLoanRequests)
      .set({
        status: "CANCELLED",
        rejectionReason:
          input.reason?.trim() || "أُلغي الطلب قبل الصرف دون أثر مالي",
      })
      .where(
        and(
          eq(employeeLoanRequests.id, input.id),
          eq(employeeLoanRequests.status, request.status),
        ),
      );
    if (updated.affectedRows !== 1) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "لم يكتمل إلغاء طلب السلفة",
          why: "تغيّرت حالة طلب السلفة أثناء الإلغاء",
          doThis: "حدّث القائمة وراجع حالة الطلب قبل إعادة الإلغاء",
        }),
      });
    }
    return { id: input.id, status: "CANCELLED" as const, replayed: false };
  });
}

/** معاينة درج المنفّذ قبل التأكيد؛ الصرف نفسه يعيد كل الحراس والأقفال داخل معاملته. */
export async function getEmployeeLoanDisbursementReadiness(
  actor: MaybeScopedActor,
  id: number,
) {
  return withTx(async (tx) => {
    await assertOperationAuthorityTx(
      tx,
      actor,
      "hrEnterprise.loans.disburse",
      currentHrWriteAllowed,
    );
    const [request] = await tx
      .select()
      .from(employeeLoanRequests)
      .where(eq(employeeLoanRequests.id, id))
      .limit(1);
    if (!request) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر فحص جاهزية صرف السلفة",
          why: "طلب السلفة غير موجود ضمن نطاقك",
          doThis: "حدّث قائمة السلف واختر طلباً متاحاً في فرعك",
        }),
      });
    }
    assertRequestBranch(actor, Number(request.branchId));

    const amount = money(request.amount);
    const blockers: string[] = [];
    if (request.status !== "APPROVED") {
      blockers.push(`حالة الطلب ${request.status} وليست APPROVED`);
    }
    if (
      request.payrollPeriod == null ||
      request.payrollPeriod !== baghdadToday().slice(0, 7)
    ) {
      blockers.push("الطلب لا يخص شهر بغداد الجاري");
    }

    const shiftId = await openShiftIdTx(
      tx,
      actor.userId,
      Number(request.branchId),
    );
    if (shiftId == null) {
      blockers.push("لا توجد وردية مفتوحة مرتبطة بدرج المنفّذ في هذا الفرع");
      return {
        requestId: id,
        amount: toDbMoney(amount),
        shiftId: null,
        availableBefore: null,
        availableAfter: null,
        ready: false,
        blockers,
      };
    }

    try {
      const source = await lockCashSourceForUpdate(tx, {
        branchId: Number(request.branchId),
        cashBucket: "DRAWER",
        shiftId,
      });
      const available = await computeDrawerCashBalance(
        tx,
        shiftId,
        source.openingBalance ?? "0",
      );
      if (amount.gt(available)) {
        blockers.push(
          `رصيد الدرج ${toDbMoney(available)} د.ع أقل من مبلغ السلفة ${toDbMoney(amount)} د.ع`,
        );
      }
      return {
        requestId: id,
        amount: toDbMoney(amount),
        shiftId,
        availableBefore: toDbMoney(available),
        availableAfter: toDbMoney(available.minus(amount)),
        ready: blockers.length === 0,
        blockers,
      };
    } catch (error) {
      if (error instanceof TRPCError) {
        blockers.push(error.message);
        return {
          requestId: id,
          amount: toDbMoney(amount),
          shiftId,
          availableBefore: null,
          availableAfter: null,
          ready: false,
          blockers,
        };
      }
      throw error;
    }
  });
}

/** صرف السلفة المعتمدة وإنشاء سجل السلفة الفعالة رسمياً وربطها بالإيصال والقيد المحاسبي والوردية. */
export async function disburseEmployeeLoan(
  actor: MaybeScopedActor,
  id: number,
) {
  return withTx(async (tx) => {
    const [preview] = await tx
      .select()
      .from(employeeLoanRequests)
      .where(eq(employeeLoanRequests.id, id))
      .limit(1);
    if (!preview) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر صرف السلفة",
          why: "طلب السلفة المطلوب غير موجود في النظام",
          doThis: "تحقّق من رقم الطلب وأعد فتح القائمة",
        }),
      });
    }
    assertRequestBranch(actor, Number(preview.branchId));
    await assertOperationAuthorityTx(
      tx,
      actor,
      "hrEnterprise.loans.disburse",
      currentHrWriteAllowed,
    );

    const replayResult = async (request: typeof preview) => {
      if (request.advanceId == null || request.receiptId == null) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر إثبات صرف السلفة السابق",
            why: "حالة الطلب مصروفة لكن روابط الإيصال أو السلفة ناقصة",
            doThis: "أوقف إعادة الصرف وراجع مسؤول النظام لمطابقة الأثر المالي",
          }),
        });
      }
      const [advance] = await tx
        .select({
          id: employeeAdvances.id,
          employeeId: employeeAdvances.employeeId,
          branchId: employeeAdvances.branchId,
          receiptId: employeeAdvances.receiptId,
          amount: employeeAdvances.amount,
          remaining: employeeAdvances.remaining,
          monthlyDeduction: employeeAdvances.monthlyDeduction,
          sourceType: employeeAdvances.sourceType,
          payrollPeriod: employeeAdvances.payrollPeriod,
          status: employeeAdvances.status,
        })
        .from(employeeAdvances)
        .where(eq(employeeAdvances.id, Number(request.advanceId)))
        .for("share")
        .limit(1);
      const [receipt] = await tx
        .select({
          id: receipts.id,
          branchId: receipts.branchId,
          shiftId: receipts.shiftId,
          cashBucket: receipts.cashBucket,
          direction: receipts.direction,
          paymentMethod: receipts.paymentMethod,
          status: receipts.status,
          approvalStatus: receipts.approvalStatus,
          createdBy: receipts.createdBy,
          approvedBy: receipts.approvedBy,
          executedBy: receipts.executedBy,
          referenceNumber: receipts.referenceNumber,
          internalNote: receipts.internalNote,
          amount: receipts.amount,
        })
        .from(receipts)
        .where(eq(receipts.id, Number(request.receiptId)))
        .for("share")
        .limit(1);
      const [entry] = await tx
        .select({
          id: accountingEntries.id,
          branchId: accountingEntries.branchId,
          receiptId: accountingEntries.receiptId,
          entryType: accountingEntries.entryType,
          postingProfile: accountingEntries.postingProfile,
          amount: accountingEntries.amount,
        })
        .from(accountingEntries)
        .where(
          eq(accountingEntries.dedupeKey, `EMPLOYEE_LOAN_DISBURSEMENT:${id}`),
        )
        .for("share")
        .limit(1);
      const systemRequest = parseSystemPaymentRequest(receipt?.internalNote);
      const expectedProvenanceKey =
        systemRequest?.kind === "EMPLOYEE_ADVANCE"
          ? `ADVANCE:${systemRequest.sourceClientRequestId}`
          : null;
      const provenance = expectedProvenanceKey
        ? await tx
            .select({ id: idempotencyKeys.id })
            .from(idempotencyKeys)
            .where(
              and(
                eq(idempotencyKeys.operation, "voucher.create"),
                eq(idempotencyKeys.clientRequestId, expectedProvenanceKey),
                eq(idempotencyKeys.refId, Number(request.receiptId)),
              ),
            )
            .for("share")
            .limit(2)
        : [];
      const remaining = advance ? money(advance.remaining) : null;
      const validAdvanceLifecycle =
        advance != null &&
        remaining != null &&
        ((advance.status === "ACTIVE" &&
          remaining.gt(0) &&
          remaining.lte(request.amount)) ||
          (advance.status === "SETTLED" && remaining.eq(0)));
      if (
        !advance ||
        !receipt ||
        !entry ||
        systemRequest?.kind !== "EMPLOYEE_ADVANCE" ||
        !isCanonicalSystemPaymentRequest(
          systemRequest,
          receipt.referenceNumber,
        ) ||
        systemRequest.sourceClientRequestId !== request.clientRequestId ||
        systemRequest.employeeId !== Number(request.employeeId) ||
        systemRequest.branchId !== Number(request.branchId) ||
        !money(systemRequest.expectedAmount).eq(request.amount) ||
        !money(systemRequest.monthlyDeduction ?? 0).eq(request.amount) ||
        provenance.length !== 1 ||
        Number(advance.employeeId) !== Number(request.employeeId) ||
        Number(advance.branchId) !== Number(request.branchId) ||
        Number(advance.receiptId) !== Number(request.receiptId) ||
        advance.sourceType !== "SALARY_ADVANCE" ||
        advance.payrollPeriod !== request.payrollPeriod ||
        !validAdvanceLifecycle ||
        !money(advance.amount).eq(request.amount) ||
        !money(advance.monthlyDeduction ?? 0).eq(request.amount) ||
        Number(receipt.branchId) !== Number(request.branchId) ||
        receipt.shiftId == null ||
        receipt.cashBucket !== "DRAWER" ||
        receipt.direction !== "OUT" ||
        receipt.paymentMethod !== "CASH" ||
        receipt.status !== "COMPLETED" ||
        receipt.approvalStatus !== "APPROVED" ||
        Number(receipt.createdBy) !== Number(request.createdById) ||
        Number(receipt.approvedBy) !== Number(request.reviewedById) ||
        Number(receipt.executedBy) !== Number(request.disbursedById) ||
        !money(receipt.amount).eq(request.amount) ||
        Number(entry.branchId) !== Number(request.branchId) ||
        Number(entry.receiptId) !== Number(request.receiptId) ||
        entry.entryType !== "PAYMENT_OUT" ||
        (entry.postingProfile != null &&
          entry.postingProfile !== "PAYMENT_OUT_EMPLOYEE_ADVANCE") ||
        !money(entry.amount).eq(request.amount)
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر إثبات صرف السلفة السابق",
            why: "سلسلة الطلب والإيصال والقيد والسلفة غير متطابقة",
            doThis: "لا تعاود الصرف؛ نفّذ مطابقة مالية للطلب أولاً",
          }),
        });
      }
      return {
        id,
        advanceId: Number(request.advanceId),
        receiptId: Number(request.receiptId),
        status: "DISBURSED" as const,
        replayed: true,
      };
    };

    if (preview.status === "DISBURSED") {
      const [locked] = await tx
        .select()
        .from(employeeLoanRequests)
        .where(eq(employeeLoanRequests.id, id))
        .for("update")
        .limit(1);
      if (!locked || locked.status !== "DISBURSED") {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّرت إعادة التحقق من السلفة المصروفة",
            why: "تغيّرت حالة الطلب أثناء العملية",
            doThis: "حدّث الصفحة وأعد المحاولة",
          }),
        });
      }
      return replayResult(locked);
    }

    const period = preview.payrollPeriod ?? baghdadToday().slice(0, 7);
    if (
      preview.payrollPeriod == null ||
      preview.payrollPeriod !== baghdadToday().slice(0, 7) ||
      preview.clientRequestId == null
    ) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "لا يمكن صرف طلب السلفة القديم",
          why:
            preview.payrollPeriod == null
              ? "الطلب تاريخي وغير مصنف على شهر راتب موثوق"
              : `انتهى شهر الطلب (${preview.payrollPeriod}) دون صرفه`,
          doThis:
            "ألغِ الطلب القديم وأنشئ طلباً جديداً للشهر الجاري ليعاد احتساب الحد واعتماده",
        }),
      });
    }

    // درج المنفّذ ثم الموظف (قفل تجميع السعة) ثم الطلب ثم إيصالات الرصيد.
    // نفس ترتيب employee → request في الإنشاء يمنع تعارض الصرف مع طلب جديد للموظف.
    let shiftId: number;
    try {
      shiftId = await requireOpenShiftIdTx(
        tx,
        actor.userId,
        Number(preview.branchId),
        "صرف سلفة موظف من درج الوردية",
      );
      await lockCashSourceForUpdate(tx, {
        branchId: Number(preview.branchId),
        cashBucket: "DRAWER",
        shiftId,
      });
    } catch (error) {
      if (error instanceof TRPCError && error.code === "PRECONDITION_FAILED") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: appErrorMessage({
            what: "لا يمكن صرف السلفة نقداً",
            why: "لا توجد وردية مفتوحة مرتبطة بدرج المنفّذ في هذا الفرع",
            doThis: "افتح ورديتك أولاً ثم أعد تنفيذ الصرف",
          }),
        });
      }
      throw error;
    }

    const capacity = await getEmployeeAdvanceCapacityTx(tx, {
      employeeId: Number(preview.employeeId),
      scopedBranchId: scopedBranch(actor),
      period,
      excludeRequestId: id,
      lock: true,
    });

    const [lr] = await tx
      .select()
      .from(employeeLoanRequests)
      .where(eq(employeeLoanRequests.id, id))
      .for("update")
      .limit(1);
    if (!lr) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر صرف السلفة",
          why: "طلب السلفة المطلوب غير موجود في النظام",
          doThis: "حدّث قائمة الطلبات وتحقق من رقم الطلب",
        }),
      });
    }
    assertRequestBranch(actor, Number(lr.branchId));

    if (lr.status === "DISBURSED") {
      return replayResult(lr);
    }

    if (lr.status !== "APPROVED") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "لا يمكن صرف السلفة",
          why: `حالة السلفة الحالية هي (${lr.status}) ولم تعتمدها الإدارة بعد`,
          doThis: "يجب اعتماد طلب السلفة أولاً قبل التمكن من صرفها",
        }),
      });
    }

    const loanAmount = money(lr.amount);
    if (loanAmount.lte(0)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر صرف السلفة",
          why: "مبلغ السلفة المطلوب صرفها غير صالح أو يساوي صفراً",
          doThis: "تحقّق من بيانات السلفة المعتمدة",
        }),
      });
    }
    assertAdvanceWithinCapacity(loanAmount, capacity);

    const [emp] = await tx
      .select({
        id: employees.id,
        firstName: employees.firstName,
        fatherName: employees.fatherName,
        grandfatherName: employees.grandfatherName,
        lastName: employees.lastName,
        branchId: employees.branchId,
        employmentStatus: employees.employmentStatus,
      })
      .from(employees)
      .where(eq(employees.id, lr.employeeId))
      .for("share")
      .limit(1);

    if (!emp || emp.employmentStatus !== "active") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "لا يمكن صرف السلفة",
          why: "الموظف لم يعد على رأس العمل بحالة نشطة",
          doThis: "ألغِ الطلب أو صحّح الحالة الوظيفية قبل الصرف",
        }),
      });
    }

    const empName = fullEmployeeName(emp);

    const branchId = lr.branchId ?? emp?.branchId ?? actor.branchId;
    if (!branchId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر صرف السلفة",
          why: "لم يتم تحديد الفرع المسؤول عن الصرف المالي",
          doThis: "تأكد من ارتباط الموظف بفرع عمل معتمد",
        }),
      });
    }

    const cashBucket = "DRAWER" as const;

    // حراسة توفر النقد المادي ومنع الصرف من رصيد سالب أو يوم نقد مغلق
    await assertCashOutAvailable(tx, {
      branchId,
      cashBucket,
      shiftId,
      amount: toDbMoney(loanAmount),
      operation: "صرف سلفة موظف",
    });

    const voucherNumber = await nextVoucherNumber(tx, "PAYMENT", branchId);
    const voucherDateYmd = todayUtcDate();
    const voucherDate = new Date(`${voucherDateYmd}T00:00:00.000Z`);
    const sourceClientRequestId = String(lr.clientRequestId);
    const advanceSource = {
      employeeId: Number(lr.employeeId),
      branchId: Number(branchId),
      expectedAmount: toDbMoney(loanAmount),
      monthlyDeduction: toDbMoney(loanAmount),
      note: lr.reason?.trim() || null,
      sourceClientRequestId,
    };
    const systemRequest: EmployeeAdvanceSystemRequest = {
      kind: "EMPLOYEE_ADVANCE",
      ...advanceSource,
      sourceHash: employeeAdvanceSourceHash(advanceSource),
    };
    const referenceNumber = employeeAdvanceReference(systemRequest);
    if (!referenceNumber) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "تعذّر بناء مرجع محاسبي موثوق لسلفة الموظف",
      });
    }

    // 1. إنشاء سند الصرف النقدي مع envelope ومصدر idempotency نظاميين كي تصنّفه
    // بوابة تفعيل الدفتر كسلفة موظف ولا تحوّله إلى OTHER غير مصنّف.
    const [receiptRes] = await tx.insert(receipts).values({
      branchId,
      shiftId,
      cashBucket,
      direction: "OUT",
      amount: toDbMoney(loanAmount),
      paymentMethod: "CASH",
      referenceNumber,
      voucherNumber,
      voucherDate,
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      approvedBy: lr.reviewedById,
      approvedAt: lr.reviewedAt,
      executedBy: actor.userId,
      executedAt: new Date(),
      createdBy: lr.createdById,
      partyType: "OTHER",
      counterpartyName: empName,
      description: `صرف سلفة موظف #${lr.id} — ${empName}`,
      internalNote: encodeSystemPaymentRequest(systemRequest),
    });
    const receiptId = extractInsertId(receiptRes);
    await recordIdempotencyKey(
      tx,
      "voucher.create",
      `ADVANCE:${sourceClientRequestId}`,
      receiptId,
    );
    const signatureHash = computeSignature({
      id: receiptId,
      amount: toDbMoney(loanAmount),
      partyType: "OTHER",
      partyId: null,
      paymentMethod: "CASH",
      voucherDate: voucherDateYmd,
      voucherNumber,
      createdBy: Number(lr.createdById),
      approvedBy: lr.reviewedById == null ? null : Number(lr.reviewedById),
      branchId,
    });
    await tx
      .update(receipts)
      .set({ signatureHash })
      .where(eq(receipts.id, receiptId));

    // 2. تسجيل القيد المحاسبي المزدوج في accountingEntries
    const assetRole = "CASH" as const;
    const sourceComponents: PostingSourceComponents = {
      roleDebits: { EMPLOYEE_ADVANCES: loanAmount },
      roleCredits: { [assetRole]: loanAmount },
    };
    const postingIntent = createPostingIntent(
      "PAYMENT_OUT_EMPLOYEE_ADVANCE",
      "PAYMENT_OUT",
      signedPostingLines("EMPLOYEE_ADVANCES", assetRole, loanAmount),
      sourceComponents,
    );

    await postEntry(tx, {
      entryType: "PAYMENT_OUT",
      branchId,
      receiptId,
      amount: loanAmount,
      paymentMethod: "CASH",
      postingIntent,
      postingSourceComponents: sourceComponents,
      createdBy: actor.userId,
      notes: `EMPLOYEE_LOAN_DISBURSEMENT: صرف سلفة موظف #${lr.id}`,
      dedupeKey: `EMPLOYEE_LOAN_DISBURSEMENT:${lr.id}`,
    });

    // 3. إنشاء سجل السلفة الفعالة في employeeAdvances بربط receiptId
    const [advRes] = await tx.insert(employeeAdvances).values({
      employeeId: lr.employeeId,
      branchId,
      amount: toDbMoney(loanAmount),
      remaining: toDbMoney(loanAmount),
      monthlyDeduction: toDbMoney(loanAmount),
      sourceType: "SALARY_ADVANCE",
      payrollPeriod: period,
      status: "ACTIVE",
      receiptId,
      note: `سلفة مصروفة بناءً على طلب رقم #${lr.id}${lr.reason ? ` — ${lr.reason}` : ""}`,
      createdBy: actor.userId,
    });
    const advanceId = extractInsertId(advRes);

    // 4. تحديث حالة طلب السلفة إلى DISBURSED وربط advanceId
    const [requestUpdate] = await tx
      .update(employeeLoanRequests)
      .set({
        status: "DISBURSED",
        advanceId,
        receiptId,
        payrollPeriod: period,
        installmentsCount: 1,
        monthlyDeduction: toDbMoney(loanAmount),
        disbursedById: actor.userId,
        disbursedAt: new Date(),
      })
      .where(
        and(
          eq(employeeLoanRequests.id, id),
          eq(employeeLoanRequests.status, "APPROVED"),
        ),
      );
    if (requestUpdate.affectedRows !== 1) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر تثبيت صرف السلفة",
          why: "تغيّرت حالة الطلب قبل اكتمال العملية فتراجعت العملية كاملةً",
          doThis: "حدّث الصفحة وتحقق من الحالة قبل إعادة المحاولة",
        }),
      });
    }

    await autoSyncEmployeeAdvanceToDraftPayrollTx(
      tx,
      Number(lr.employeeId),
      period,
    );

    return { id, advanceId, receiptId, status: "DISBURSED" };
  });
}

export const disburseLoan = disburseEmployeeLoan;

/** استعلام طلبات سلف الموظف مع دعم عزل الفروع. */
export async function listEmployeeLoans(
  employeeId: number,
  scopedBranchId?: number | null,
) {
  const db = requireDb();
  const conds = [eq(employeeLoanRequests.employeeId, employeeId)];
  if (scopedBranchId != null) {
    conds.push(eq(employeeLoanRequests.branchId, scopedBranchId));
  }
  return db
    .select()
    .from(employeeLoanRequests)
    .where(and(...conds))
    .orderBy(desc(employeeLoanRequests.createdAt));
}
