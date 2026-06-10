import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { branches, expenses, receipts, shifts } from "../../drizzle/schema";
import { getDb } from "../db";
import { findIdempotentRefId, recordIdempotencyKey } from "./idempotency";
import { postEntry } from "./ledgerService";
import { money, toDateStr, toDbMoney } from "./money";
import { withTx, type Actor } from "./tx";

export type ExpensePaymentMethod = "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET";
export type ExpenseCategory =
  | "RENT"
  | "UTILITIES"
  | "SUPPLIES"
  | "SALARY"
  | "TRANSPORT"
  | "MAINTENANCE"
  | "MARKETING"
  | "OTHER";

export type RecurringFrequency = "DAILY" | "WEEKLY" | "MONTHLY" | "QUARTERLY" | "YEARLY";

export interface CreateExpenseInput {
  branchId: number;
  shiftId?: number | null;
  expenseDate?: string; // YYYY-MM-DD — default today
  category: ExpenseCategory;
  amount: string;
  paymentMethod: ExpensePaymentMethod;
  description?: string | null;
  referenceNumber?: string | null;
  // v3-add-screens: حقول وصفيّة جديدة — لا تؤثّر في الدفتر/الصندوق.
  payee?: string | null;
  costCenter?: string | null;
  isRecurring?: boolean | null;
  recurringFrequency?: RecurringFrequency | null;
  /** idempotency: نقرة مزدوجة/إعادة شبكة بنفس المفتاح ⇒ مصروف واحد (لا صرف نقدي مزدوج). */
  clientRequestId?: string | null;
}

/** Record a daily expense: receipt (OUT) + PAYMENT_OUT ledger entry + expense row. */
export async function createExpense(input: CreateExpenseInput, actor: Actor) {
  return withTx(async (tx) => {
    // idempotency: إعادة طلب بنفس المفتاح ⇒ نُعيد المصروف الأول دون صرف نقدي ثانٍ.
    const replayId = await findIdempotentRefId(tx, "expense.create", input.clientRequestId);
    if (replayId) {
      const ex = (
        await tx.select({ receiptId: expenses.receiptId }).from(expenses).where(eq(expenses.id, replayId)).limit(1)
      )[0];
      return { expenseId: replayId, receiptId: ex?.receiptId ? Number(ex.receiptId) : null, idempotent: true };
    }
    const amt = money(input.amount);
    if (amt.lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "مبلغ المصروف يجب أن يكون موجباً" });
    if (input.category === "OTHER" && !input.description?.trim())
      throw new TRPCError({ code: "BAD_REQUEST", message: "وصف المصروف مطلوب لفئة «أخرى»" });

    const b = (await tx.select({ id: branches.id }).from(branches).where(eq(branches.id, input.branchId)).limit(1))[0];
    if (!b) throw new TRPCError({ code: "NOT_FOUND", message: "الفرع غير موجود" });

    if (input.shiftId) {
      const s = (await tx.select().from(shifts).where(eq(shifts.id, input.shiftId)).limit(1))[0];
      if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "الوردية غير موجودة" });
      if (s.status !== "OPEN")
        throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن تسجيل مصروف على وردية مغلقة" });
      if (Number(s.branchId) !== input.branchId)
        throw new TRPCError({ code: "BAD_REQUEST", message: "الوردية لا تطابق الفرع" });
    }

    const rRes = await tx.insert(receipts).values({
      invoiceId: null,
      branchId: input.branchId,
      shiftId: input.shiftId ?? null,
      direction: "OUT",
      amount: toDbMoney(amt),
      paymentMethod: input.paymentMethod,
      status: "COMPLETED",
      createdBy: actor.userId,
    });
    const receiptId = Number((rRes as any)[0]?.insertId ?? (rRes as any).insertId);

    const expDate = input.expenseDate?.trim() || toDateStr();
    const isRecurring = !!input.isRecurring;
    if (isRecurring && !input.recurringFrequency)
      throw new TRPCError({ code: "BAD_REQUEST", message: "حدّد دورية التكرار" });
    const eRes = await tx.insert(expenses).values({
      branchId: input.branchId,
      shiftId: input.shiftId ?? null,
      expenseDate: new Date(expDate),
      category: input.category,
      amount: toDbMoney(amt),
      paymentMethod: input.paymentMethod,
      description: input.description?.trim() || null,
      referenceNumber: input.referenceNumber?.trim() || null,
      payee: input.payee?.trim() || null,
      costCenter: input.costCenter?.trim() || null,
      isRecurring,
      recurringFrequency: isRecurring ? input.recurringFrequency! : null,
      receiptId,
      status: "ACTIVE",
      createdBy: actor.userId,
    });
    const expenseId = Number((eRes as any)[0]?.insertId ?? (eRes as any).insertId);
    // سجّل مفتاح الـidempotency — طلبٌ متزامن مكرّر يصطدم بالقيد الفريد فيُلغى (ROLLBACK) قبل قيد الصرف.
    if (input.clientRequestId) await recordIdempotencyKey(tx, "expense.create", input.clientRequestId, expenseId);

    await postEntry(tx, {
      entryType: "PAYMENT_OUT",
      branchId: input.branchId,
      receiptId,
      amount: amt,
      entryDate: new Date(expDate),
      notes: `مصروف (${input.category})${input.description?.trim() ? ": " + input.description.trim() : ""}`,
    });

    return { expenseId, receiptId };
  });
}

/**
 * Cancel an active expense. Only allowed when the linked shift (if any) is still OPEN.
 * Marks original receipt REVERSED and inserts a COMPENSATING IN-receipt with the same
 * shiftId/method/amount so shift cash totals remain correct (computeExpectedCash sums all).
 * Posts an ADJUST ledger entry with a negative amount to reverse the books.
 */
export async function cancelExpense(expenseId: number, actor: Actor) {
  return withTx(async (tx) => {
    const exp = (await tx.select().from(expenses).where(eq(expenses.id, expenseId)).for("update").limit(1))[0];
    if (!exp) throw new TRPCError({ code: "NOT_FOUND", message: "المصروف غير موجود" });
    if (exp.status !== "ACTIVE")
      throw new TRPCError({ code: "BAD_REQUEST", message: "المصروف ملغى بالفعل" });

    if (exp.shiftId) {
      const s = (
        await tx.select({ status: shifts.status }).from(shifts).where(eq(shifts.id, Number(exp.shiftId))).limit(1)
      )[0];
      if (s && s.status === "CLOSED")
        throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن إلغاء مصروف على وردية مغلقة" });
    }

    await tx.update(expenses).set({ status: "CANCELLED" }).where(eq(expenses.id, expenseId));
    if (exp.receiptId) {
      await tx.update(receipts).set({ status: "REVERSED" }).where(eq(receipts.id, Number(exp.receiptId)));
    }

    // Compensating IN-receipt so cash totals nullify cleanly.
    const compRes = await tx.insert(receipts).values({
      invoiceId: null,
      branchId: Number(exp.branchId),
      shiftId: exp.shiftId ?? null,
      direction: "IN",
      amount: toDbMoney(exp.amount),
      paymentMethod: exp.paymentMethod,
      status: "COMPLETED",
      referenceNumber: `CANCEL-EXP-${expenseId}`,
      createdBy: actor.userId,
    });
    const compReceiptId = Number((compRes as any)[0]?.insertId ?? (compRes as any).insertId);

    await postEntry(tx, {
      entryType: "ADJUST",
      branchId: Number(exp.branchId),
      receiptId: compReceiptId,
      amount: money(exp.amount).neg(),
      notes: `إلغاء مصروف #${expenseId}`,
    });

    return { expenseId, status: "CANCELLED" };
  });
}

export interface ListExpensesInput {
  branchId?: number;
  category?: ExpenseCategory;
  status?: "ACTIVE" | "CANCELLED";
  from?: string; // YYYY-MM-DD
  to?: string;
  limit?: number;
}

export async function listExpenses(input: ListExpensesInput = {}) {
  const db = getDb();
  if (!db) return { rows: [], totals: { active: "0.00", count: 0 } };
  const conds = [] as any[];
  if (input.branchId) conds.push(eq(expenses.branchId, input.branchId));
  if (input.category) conds.push(eq(expenses.category, input.category));
  if (input.status) conds.push(eq(expenses.status, input.status));
  if (input.from) conds.push(gte(expenses.expenseDate, new Date(input.from)));
  if (input.to) conds.push(lte(expenses.expenseDate, new Date(input.to)));
  const where = conds.length ? and(...conds) : undefined;

  const rows = await db
    .select({
      id: expenses.id,
      branchId: expenses.branchId,
      branchName: branches.name,
      expenseDate: expenses.expenseDate,
      category: expenses.category,
      amount: expenses.amount,
      paymentMethod: expenses.paymentMethod,
      description: expenses.description,
      referenceNumber: expenses.referenceNumber,
      status: expenses.status,
      shiftId: expenses.shiftId,
      createdAt: expenses.createdAt,
    })
    .from(expenses)
    .leftJoin(branches, eq(expenses.branchId, branches.id))
    .where(where as any)
    .orderBy(desc(expenses.id))
    .limit(input.limit ?? 200);

  const totalsRow = (
    await db
      .select({
        active: sql<string>`COALESCE(SUM(CASE WHEN ${expenses.status} = 'ACTIVE' THEN ${expenses.amount} ELSE 0 END), 0)`,
        count: sql<number>`COUNT(*)`,
      })
      .from(expenses)
      .where(where as any)
  )[0];

  return {
    rows,
    totals: {
      active: totalsRow?.active ?? "0.00",
      count: Number(totalsRow?.count ?? 0),
    },
  };
}
