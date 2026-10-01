import { and, desc, eq, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { fullEmployeeName } from "@shared/hr";
import {
  employeeSpotBonuses,
  employees,
  receipts,
  shifts,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { withTx, type Actor, type MaybeScopedActor } from "./tx";
import { money, toDbMoney } from "./money";
import { extractInsertId } from "../lib/insertId";
import { openShiftIdTx } from "./shiftService";
import { postEntry } from "./ledgerService";
import {
  createPostingIntent,
  signedPostingLines,
  type PostingSourceComponents,
} from "./accounting/postingEngine";
import { assertCashOutAvailable } from "./cash/cashAvailability";

function requireDb() {
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL not set");
  return db;
}

export type SpotBonusDisbursementType = "CASH_TREASURY" | "PAYROLL_ADDITION";
export type SpotBonusStatus = "DRAFT" | "APPROVED" | "PAID" | "CANCELLED";

export interface CreateSpotBonusInput {
  employeeId: number;
  amount: string | number;
  reason: string;
  decisionNumber?: string | null;
  disbursementType?: SpotBonusDisbursementType;
}

/** تسجيل مكافأة استثنائية فورية (مسودة). */
export async function createSpotBonus(
  actor: MaybeScopedActor,
  input: CreateSpotBonusInput,
) {
  return withTx(async (tx) => {
    const [emp] = await tx
      .select({ id: employees.id, branchId: employees.branchId })
      .from(employees)
      .where(eq(employees.id, input.employeeId))
      .limit(1);

    if (!emp) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر تسجيل المكافأة الفورية",
          why: "الموظف المطلوب غير مسجّل في قاعدة البيانات",
          doThis: "تحقّق من معرّف الموظف وأعد المحاولة",
        }),
      });
    }

    const amt = money(input.amount);
    if (amt.lte(0)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "مبلغ المكافأة غير صحيح",
          why: "يجب أن يكون مبلغ المكافأة أكبر من صفر",
          doThis: "أدخل مبلغ مكافأة صالح وموجب",
        }),
      });
    }

    const branchId = emp.branchId ?? actor.branchId;
    if (!branchId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر تسجيل المكافأة",
          why: "الموظف غير مرتبط بفرع عمل محدد لصرف المكافأة من خزينته",
          doThis: "حدّد فرع عمل للموظف قبل إصدار المكافأة",
        }),
      });
    }

    const [res] = await tx.insert(employeeSpotBonuses).values({
      employeeId: input.employeeId,
      branchId,
      amount: toDbMoney(amt),
      reason: input.reason.trim(),
      decisionNumber: input.decisionNumber?.trim() || null,
      disbursementType: input.disbursementType ?? "CASH_TREASURY",
      status: "DRAFT",
      createdById: actor.userId,
    });

    return { id: res.insertId, status: "DRAFT" };
  });
}

/** اعتماد المكافأة الفورية (Maker-Checker). */
export async function approveSpotBonus(
  actor: MaybeScopedActor,
  id: number,
) {
  return withTx(async (tx) => {
    const [b] = await tx
      .select()
      .from(employeeSpotBonuses)
      .where(eq(employeeSpotBonuses.id, id))
      .limit(1);

    if (!b) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر اعتماد المكافأة",
          why: "سجل المكافأة المطلوب غير موجود",
          doThis: "تحقّق من رقم المكافأة من الجدول وأعد المحاولة",
        }),
      });
    }

    if (b.status !== "DRAFT") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "لا يمكن اعتماد المكافأة",
          why: `حالة المكافأة الحالية هي (${b.status}) وليست مسودة`,
          doThis: "يمكن اعتماد المكافآت التي بحالة مسودة فقط",
        }),
      });
    }

    if (b.createdById === actor.userId && actor.role !== "admin") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "غير مصرّح باعتماد المكافأة",
          why: "مبدأ فصل المهام (Maker-Checker): لا يجوز لمنشئ المكافأة اعتمادها بنفسه",
          doThis: "اطلب من مدير آخر أو مسؤول الصلاحيات اعتماد المكافأة",
        }),
      });
    }

    await tx
      .update(employeeSpotBonuses)
      .set({
        status: "APPROVED",
        approvedById: actor.userId,
        approvedAt: sql`NOW()`,
      })
      .where(eq(employeeSpotBonuses.id, id));

    return { id, status: "APPROVED" };
  });
}

/** استعلام مكافآت الموظف مع دعم عزل الفروع. */
export async function listEmployeeSpotBonuses(
  employeeId: number,
  scopedBranchId?: number | null,
) {
  const db = requireDb();
  const conds = [eq(employeeSpotBonuses.employeeId, employeeId)];
  if (scopedBranchId != null) {
    conds.push(eq(employeeSpotBonuses.branchId, scopedBranchId));
  }
  return db
    .select()
    .from(employeeSpotBonuses)
    .where(and(...conds))
    .orderBy(desc(employeeSpotBonuses.createdAt));
}

export interface PaySpotBonusCashInput {
  id: number;
  shiftId?: number | null;
  cashBucket?: "TREASURY" | "DRAWER";
}

/** صرف المكافأة الاستثنائية نقداً (من الخزينة أو الدرج). */
export async function paySpotBonusCash(
  actor: MaybeScopedActor,
  input: PaySpotBonusCashInput,
) {
  return withTx(async (tx) => {
    const [b] = await tx
      .select()
      .from(employeeSpotBonuses)
      .where(eq(employeeSpotBonuses.id, input.id))
      .for("update");

    if (!b) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر صرف المكافأة",
          why: "سجل المكافأة المطلوب غير موجود",
          doThis: "تحقّق من رقم المكافأة وأعد المحاولة",
        }),
      });
    }

    if (actor.branchId != null && b.branchId !== actor.branchId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "تعذّر صرف المكافأة",
          why: "المكافأة تابعة لفرع آخر خارج نطاق صلاحيتك الحالية",
          doThis: "حوّل نطاق الفرع إلى فرع المكافأة أو تواصل مع إدارة النظام",
        }),
      });
    }

    if (b.status !== "APPROVED") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "لا يمكن صرف المكافأة",
          why: `حالة المكافأة الحالية هي (${b.status}) وليست معتمدة`,
          doThis: "يجب اعتماد المكافأة أولاً قبل صرفها، أو قد تكون مصروفة مسبقاً",
        }),
      });
    }

    if (b.disbursementType !== "CASH_TREASURY") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "لا يمكن الصرف النقدي لهذه المكافأة",
          why: "طريقة صرف هذه المكافأة هي الإدراج في مسير الرواتب وليست صرفاً نقدياً",
          doThis: "انتظر صرف المكافأة ضمن مسير الرواتب القادم",
        }),
      });
    }

    const bonusAmount = money(b.amount);
    if (bonusAmount.lte(0)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر صرف المكافأة",
          why: "مبلغ المكافأة غير صالح أو صفر",
          doThis: "تحقّق من بيانات المكافأة",
        }),
      });
    }

    const branchId = b.branchId;
    const cashBucket = input.cashBucket ?? "TREASURY";
    let shiftId: number | null = null;

    if (cashBucket === "DRAWER") {
      shiftId = input.shiftId ?? (await openShiftIdTx(tx, actor.userId, branchId));
      if (!shiftId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذّر صرف المكافأة من الدرج",
            why: "لا توجد وردية مفتوحة للصرف من درجها",
            doThis: "افتح وردية أولاً أو اختر الصرف من الخزينة الرئيسية",
          }),
        });
      }

      const [shift] = await tx
        .select()
        .from(shifts)
        .where(eq(shifts.id, shiftId))
        .for("update");

      if (!shift) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: appErrorMessage({
            what: "تعذّر صرف المكافأة",
            why: "الوردية المحددة غير موجودة",
            doThis: "تحقّق من معرف الوردية",
          }),
        });
      }

      if (shift.status !== "OPEN") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذّر صرف المكافأة من الدرج",
            why: "الوردية المحددة مغلقة",
            doThis: "اختر وردية مفتوحة حالياً للصرف من درجها",
          }),
        });
      }

      if (shift.branchId !== branchId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذّر صرف المكافأة",
            why: "الوردية المحددة لا تنتمي لنفس فرع المكافأة",
            doThis: "تأكد من اختيار وردية تابعة لنفس الفرع",
          }),
        });
      }
    }

    await assertCashOutAvailable(tx, {
      branchId,
      cashBucket,
      shiftId,
      amount: toDbMoney(bonusAmount),
      operation: "صرف مكافأة استثنائية فورية",
    });

    const [emp] = await tx
      .select({
        id: employees.id,
        firstName: employees.firstName,
        fatherName: employees.fatherName,
        grandfatherName: employees.grandfatherName,
        lastName: employees.lastName,
      })
      .from(employees)
      .where(eq(employees.id, b.employeeId))
      .limit(1);

    const empName = emp ? fullEmployeeName(emp) : `موظف #${b.employeeId}`;

    const [receiptRes] = await tx.insert(receipts).values({
      branchId,
      shiftId: cashBucket === "DRAWER" ? shiftId : null,
      cashBucket,
      direction: "OUT",
      amount: toDbMoney(bonusAmount),
      paymentMethod: "CASH",
      referenceNumber: `EMP-BONUS:${b.id}`,
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      approvedBy: actor.userId,
      approvedAt: new Date(),
      createdBy: actor.userId,
      partyType: "OTHER",
      counterpartyName: empName,
      description: `صرف مكافأة استثنائية #${b.id} — ${empName}`,
    });
    const receiptId = extractInsertId(receiptRes);

    const assetRole = cashBucket === "DRAWER" ? "CASH" : "TREASURY_CASH";
    const sourceComponents: PostingSourceComponents = {
      roleDebits: { SALARIES: bonusAmount },
      roleCredits: { [assetRole]: bonusAmount },
    };
    const postingIntent = createPostingIntent(
      "PAYMENT_OUT_EXPENSE",
      "PAYMENT_OUT",
      signedPostingLines("SALARIES", assetRole, bonusAmount),
      sourceComponents,
    );

    await postEntry(tx, {
      entryType: "PAYMENT_OUT",
      branchId,
      receiptId,
      amount: bonusAmount,
      paymentMethod: "CASH",
      postingIntent,
      postingSourceComponents: sourceComponents,
      createdBy: actor.userId,
      notes: `EMPLOYEE_SPOT_BONUS_CASH: صرف مكافأة استثنائية #${b.id}`,
      dedupeKey: `EMPLOYEE_SPOT_BONUS_CASH:${b.id}`,
    });

    await tx
      .update(employeeSpotBonuses)
      .set({
        status: "PAID",
        voucherId: receiptId,
        paidAt: new Date(),
      })
      .where(eq(employeeSpotBonuses.id, b.id));

    return { id: b.id, status: "PAID", receiptId };
  });
}

