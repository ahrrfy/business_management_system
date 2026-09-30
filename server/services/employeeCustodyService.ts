import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { employeeAdvances, employeeCustody, employees } from "../../drizzle/schema";
import { getDb } from "../db";
import { withTx, type Actor, type MaybeScopedActor } from "./tx";
import { baghdadToday } from "./businessDay";
import { postEntry } from "./ledgerService";
import { money, toDbMoney } from "./money";
import { extractInsertId } from "../lib/insertId";

function requireDb() {
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL not set");
  return db;
}

export type CustodyItemType =
  | "TOOL"
  | "DEVICE"
  | "VEHICLE"
  | "KEY"
  | "DOCUMENT"
  | "UNIFORM"
  | "OTHER";

export type CustodyStatus = "HELD" | "RETURNED" | "DAMAGED" | "LOST";

export interface AssignCustodyInput {
  employeeId: number;
  itemType: CustodyItemType;
  itemName: string;
  itemCode?: string | null;
  serialNumber?: string | null;
  quantity?: number;
  conditionAtHandover?: string | null;
  handoverDate: string;
  expectedReturnDate?: string | null;
  notes?: string | null;
}

export interface ReturnCustodyInput {
  id: number;
  actualReturnDate: string;
  conditionAtReturn?: string | null;
  returnNotes?: string | null;
  status?: "RETURNED" | "DAMAGED" | "LOST";
  damageAmount?: string | number | null;
}

/** تسليم عهدة عينية أو أداة عمل لموظف. */
export async function assignEmployeeCustody(
  actor: MaybeScopedActor,
  input: AssignCustodyInput,
) {
  return withTx(async (tx) => {
    const [emp] = await tx
      .select({ id: employees.id, branchId: employees.branchId, employmentStatus: employees.employmentStatus })
      .from(employees)
      .where(eq(employees.id, input.employeeId))
      .limit(1);

    if (!emp) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر تسليم العهدة",
          why: "الموظف المطلوب غير مسجّل في قاعدة البيانات",
          doThis: "تحقّق من معرّف الموظف وأعد المحاولة",
        }),
      });
    }

    if (emp.employmentStatus !== "active") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "لا يمكن تسليم عهدة عينية",
          why: `الموظف بحالة وظيفية (${emp.employmentStatus}) ولا يمارس عمله الفعلي`,
          doThis: "يجب أن تكون حالة الموظف نشطة (active) لتسليم عهد العمل",
        }),
      });
    }

    const branchId = emp.branchId ?? actor.branchId;
    if (!branchId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر تسجيل العهدة",
          why: "لم يتم تحديد الفرع المسؤول عن العهدة",
          doThis: "حدّد فرع العمل لتسجيل العهدة في ذمته",
        }),
      });
    }

    const [res] = await tx.insert(employeeCustody).values({
      employeeId: input.employeeId,
      branchId,
      itemType: input.itemType,
      itemName: input.itemName.trim(),
      itemCode: input.itemCode?.trim() || null,
      serialNumber: input.serialNumber?.trim() || null,
      quantity: input.quantity ?? 1,
      conditionAtHandover: input.conditionAtHandover?.trim() || "جيدة",
      handoverDate: input.handoverDate,
      expectedReturnDate: input.expectedReturnDate || null,
      status: "HELD",
      notes: input.notes?.trim() || null,
      createdById: actor.userId,
    });

    return { id: res.insertId, status: "HELD" };
  });
}

/** إرجاع أو تسوية عهدة موظف. */
export async function returnEmployeeCustody(
  actor: MaybeScopedActor,
  input: ReturnCustodyInput,
) {
  return withTx(async (tx) => {
    const [c] = await tx
      .select()
      .from(employeeCustody)
      .where(eq(employeeCustody.id, input.id))
      .limit(1)
      .for("update");

    if (!c) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر استرجاع العهدة",
          why: "سجل العهدة المطلوب غير موجود في النظام",
          doThis: "تحقّق من رقم العهدة من جدول العهد النشطة",
        }),
      });
    }

    if (c.status !== "HELD") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "لا يمكن استرجاع العهدة",
          why: `العهدة مسواة مسبقاً بحالة (${c.status}) وليست في ذمة الموظف`,
          doThis: "يمكن استرجاع وتصفية العهد التي بحالة (في ذمة الموظف) فقط",
        }),
      });
    }

    const finalStatus = input.status ?? "RETURNED";

    let accountingEntryId: number | null = null;
    let advanceId: number | null = null;

    if (finalStatus === "DAMAGED" || finalStatus === "LOST") {
      const lossAmount = money(input.damageAmount);
      if (lossAmount.gt(0)) {
        const branchId = c.branchId ?? actor.branchId ?? 1;
        const entryDate = input.actualReturnDate
          ? new Date(`${input.actualReturnDate}T00:00:00Z`)
          : new Date();

        accountingEntryId = await postEntry(tx, {
          entryType: "ADJUST",
          branchId,
          dedupeKey: `CUSTODY_LOSS:${c.id}`,
          amount: lossAmount,
          notes: `تعويض عهدة ${finalStatus === "DAMAGED" ? "تالفة" : "مفقودة"}: ${c.itemName} (موظف #${c.employeeId})`,
          createdBy: actor.userId,
          entryDate,
        });

        const [advRes] = await tx.insert(employeeAdvances).values({
          employeeId: c.employeeId,
          branchId,
          amount: toDbMoney(lossAmount),
          remaining: toDbMoney(lossAmount),
          status: "ACTIVE",
          note: `استقطاع تعويض عهدة ${finalStatus === "DAMAGED" ? "تالفة" : "مفقودة"}: ${c.itemName} (#${c.id})`,
          createdBy: actor.userId,
        });
        advanceId = extractInsertId(advRes);
      }
    }

    await tx
      .update(employeeCustody)
      .set({
        actualReturnDate: input.actualReturnDate,
        conditionAtReturn: input.conditionAtReturn?.trim() || null,
        returnNotes: input.returnNotes?.trim() || null,
        status: finalStatus,
        receivedById: actor.userId,
      })
      .where(eq(employeeCustody.id, input.id));

    return {
      id: input.id,
      status: finalStatus,
      accountingEntryId,
      advanceId,
    };
  });
}

/** استعلام عهد الموظف مع دعم عزل الفروع. */
export async function listEmployeeCustody(
  employeeId: number,
  scopedBranchId?: number | null,
) {
  const db = requireDb();
  const conds = [eq(employeeCustody.employeeId, employeeId)];
  if (scopedBranchId != null) {
    conds.push(eq(employeeCustody.branchId, scopedBranchId));
  }
  return db
    .select()
    .from(employeeCustody)
    .where(and(...conds))
    .orderBy(desc(employeeCustody.handoverDate));
}

/** استعلام عدد العهد المفتوحة بذمة الموظف (لحارس إنهاء الخدمة). */
export async function getOpenEmployeeCustody(employeeId: number, conn?: any) {
  const db = conn ?? requireDb();
  return db
    .select()
    .from(employeeCustody)
    .where(
      and(
        eq(employeeCustody.employeeId, employeeId),
        eq(employeeCustody.status, "HELD"),
      ),
    );
}
