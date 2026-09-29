import { and, desc, eq, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { employeeSpotBonuses, employees } from "../../drizzle/schema";
import { getDb } from "../db";
import { withTx, type Actor, type MaybeScopedActor } from "./tx";
import { money, toDbMoney } from "./money";

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

/** استعلام مكافآت الموظف. */
export async function listEmployeeSpotBonuses(employeeId: number) {
  const db = requireDb();
  return db
    .select()
    .from(employeeSpotBonuses)
    .where(eq(employeeSpotBonuses.employeeId, employeeId))
    .orderBy(desc(employeeSpotBonuses.createdAt));
}
