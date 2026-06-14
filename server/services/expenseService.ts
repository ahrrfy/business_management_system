import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { branches, expenseStockItems, expenses, productVariants, receipts, shifts, users } from "../../drizzle/schema";
import { localDayStart } from "./dateRange";
import { getDb } from "../db";
import { applyMovement, convertToBaseQuantity } from "./inventoryService";
import { findIdempotentRefId, recordIdempotencyKey } from "./idempotency";
import { postEntry } from "./ledgerService";
import { money, round2, toDateStr, toDbMoney } from "./money";
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

/** production-slice: مصدر الصرف. CASH=نقدي (الموجود)؛ STOCK=صرف من المخزون بالكلفة (نثرية/تلف). */
export type ExpenseSource = "CASH" | "STOCK";
export type ExpenseStockReason = "INTERNAL_USE" | "WASTAGE";

/** صنف مُستهلَك من المخزون (مصدر STOCK): إمّا وحدة+كمية أو كمية أساس مباشرة. */
export interface ExpenseStockItemInput {
  variantId: number;
  productUnitId?: number | null;
  quantity?: string;
  baseQuantity?: number;
}

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
  // production-slice: مصدر الصرف + (مع STOCK) نوعه وأصنافه.
  source?: ExpenseSource | null; // default CASH
  stockReason?: ExpenseStockReason | null; // STOCK only
  items?: ExpenseStockItemInput[]; // STOCK only
  /** idempotency: نقرة مزدوجة/إعادة شبكة بنفس المفتاح ⇒ مصروف واحد (لا صرف نقدي مزدوج). */
  clientRequestId?: string | null;
}

/** صرف من المخزون (نثرية/تلف): يُخصَم بالكلفة عبر applyMovement + قيد INTERNAL_USE/WASTAGE — بلا receipt ولا صندوق. */
async function createStockExpenseTx(tx: any, input: CreateExpenseInput, actor: Actor) {
  const stockReason = input.stockReason;
  if (stockReason !== "INTERNAL_USE" && stockReason !== "WASTAGE") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "حدّد نوع الصرف من المخزون (نثرية/تلف)" });
  }
  if (!input.items?.length) throw new TRPCError({ code: "BAD_REQUEST", message: "حدّد صنفاً واحداً على الأقل" });

  // حلّ كل صنف إلى كمية أساس صحيحة.
  const resolved: Array<{ variantId: number; productUnitId: number | null; quantity: string; baseQuantity: number }> = [];
  for (const it of input.items) {
    if (!Number.isInteger(it.variantId) || it.variantId <= 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "صنف غير صالح" });
    }
    let baseQuantity: number;
    let quantity: string;
    if (it.productUnitId != null && it.quantity != null) {
      const conv = await convertToBaseQuantity(tx, it.productUnitId, it.quantity, it.variantId);
      baseQuantity = conv.baseQuantity;
      quantity = money(it.quantity).toFixed(4);
    } else {
      if (it.baseQuantity == null || !Number.isInteger(it.baseQuantity) || it.baseQuantity <= 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "الكمية الأساس يجب أن تكون عدداً صحيحاً موجباً" });
      }
      baseQuantity = it.baseQuantity;
      quantity = money(it.baseQuantity).toFixed(4);
    }
    resolved.push({ variantId: it.variantId, productUnitId: it.productUnitId ?? null, quantity, baseQuantity });
  }

  const varIds = Array.from(new Set(resolved.map((r) => r.variantId)));
  const existing = await tx.select({ id: productVariants.id }).from(productVariants).where(inArray(productVariants.id, varIds));
  const existSet = new Set(existing.map((v: any) => Number(v.id)));
  for (const id of varIds) if (!existSet.has(id)) throw new TRPCError({ code: "NOT_FOUND", message: `صنف #${id} غير موجود` });

  const expDate = input.expenseDate?.trim() || toDateStr();

  // رأس المصروف (amount مؤقّت 0، بلا receipt/صندوق).
  const eRes = await tx.insert(expenses).values({
    branchId: input.branchId,
    shiftId: null,
    expenseDate: new Date(expDate),
    category: input.category,
    amount: "0",
    paymentMethod: input.paymentMethod,
    source: "STOCK",
    stockReason,
    description: input.description?.trim() || null,
    referenceNumber: input.referenceNumber?.trim() || null,
    payee: input.payee?.trim() || null,
    costCenter: input.costCenter?.trim() || null,
    isRecurring: false,
    recurringFrequency: null,
    receiptId: null,
    status: "ACTIVE",
    createdBy: actor.userId,
  });
  const expenseId = Number((eRes as any)[0]?.insertId ?? (eRes as any).insertId);
  if (input.clientRequestId) await recordIdempotencyKey(tx, "expense.create", input.clientRequestId, expenseId);

  // خصم المخزون (تصاعدياً بـvariantId) + snapshot الكلفة + أسطر الأصناف.
  resolved.sort((a, b) => a.variantId - b.variantId);
  const costRows = await tx
    .select({ id: productVariants.id, costPrice: productVariants.costPrice })
    .from(productVariants)
    .where(inArray(productVariants.id, varIds));
  const costMap = new Map<number, string>(costRows.map((v: any) => [Number(v.id), String(v.costPrice)] as [number, string]));

  let amount = money(0);
  for (const r of resolved) {
    const unitCost = round2(money(costMap.get(r.variantId) ?? "0"));
    const lineCost = round2(unitCost.times(r.baseQuantity));
    amount = amount.plus(lineCost);
    await tx.insert(expenseStockItems).values({
      expenseId,
      variantId: r.variantId,
      productUnitId: r.productUnitId,
      quantity: r.quantity,
      baseQuantity: r.baseQuantity,
      unitCost: unitCost.toFixed(2),
      lineCost: lineCost.toFixed(2),
    });
    await applyMovement(tx, {
      variantId: r.variantId,
      branchId: input.branchId,
      baseQuantity: r.baseQuantity,
      movementType: "OUT",
      referenceType: "EXPENSE",
      referenceId: expenseId,
      createdBy: actor.userId,
    });
  }
  amount = round2(amount);
  await tx.update(expenses).set({ amount: amount.toFixed(2) }).where(eq(expenses.id, expenseId));

  // قيد غير نقدي بالكلفة: نثرية = مصروف، تلف = خسارة (revenue=0، profit سالب).
  await postEntry(tx, {
    entryType: stockReason,
    branchId: input.branchId,
    cost: amount,
    amount,
    revenue: money(0),
    profit: round2(money(0).minus(amount)),
    dedupeKey: `${stockReason}:${expenseId}`,
    entryDate: new Date(expDate),
    notes: `${stockReason === "WASTAGE" ? "تلف/هدر" : "نثرية داخلية"}${input.description?.trim() ? ": " + input.description.trim() : ""}`,
  });

  return { expenseId, receiptId: null };
}

/** Record a daily expense: CASH ⇒ receipt(OUT)+PAYMENT_OUT ; STOCK ⇒ صرف مخزون بالكلفة (نثرية/تلف، بلا صندوق). */
export async function createExpense(input: CreateExpenseInput, actor: Actor) {
  return withTx(async (tx) => {
    // idempotency: إعادة طلب بنفس المفتاح ⇒ نُعيد المصروف الأول دون صرف ثانٍ.
    const replayId = await findIdempotentRefId(tx, "expense.create", input.clientRequestId);
    if (replayId) {
      const ex = (
        await tx.select({ receiptId: expenses.receiptId }).from(expenses).where(eq(expenses.id, replayId)).limit(1)
      )[0];
      return { expenseId: replayId, receiptId: ex?.receiptId ? Number(ex.receiptId) : null, idempotent: true };
    }

    const b = (await tx.select({ id: branches.id }).from(branches).where(eq(branches.id, input.branchId)).limit(1))[0];
    if (!b) throw new TRPCError({ code: "NOT_FOUND", message: "الفرع غير موجود" });

    // production-slice: صرف من المخزون (نثرية/تلف) — مسار منفصل لا يلمس الصندوق النقدي.
    if ((input.source ?? "CASH") === "STOCK") {
      return await createStockExpenseTx(tx, input, actor);
    }

    const amt = money(input.amount);
    if (amt.lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "مبلغ المصروف يجب أن يكون موجباً" });
    if (input.category === "OTHER" && !input.description?.trim())
      throw new TRPCError({ code: "BAD_REQUEST", message: "وصف المصروف مطلوب لفئة «أخرى»" });

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

    // عزل عبر-فرعي: admin يمرّ؛ غيره يجب أن يكون من فرع المصروف نفسه (نمط جذري ٢).
    // expenseRouter لا يمرّر role، فنقرأه من قاعدة البيانات.
    {
      const role =
        actor.role ??
        ((await tx.select({ role: users.role }).from(users).where(eq(users.id, actor.userId)).limit(1))[0]?.role ?? "");
      if (role !== "admin" && Number(actor.branchId) !== Number(exp.branchId)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا تستطيع إلغاء مصروف لفرع آخر" });
      }
    }

    if (exp.shiftId) {
      const s = (
        await tx.select({ status: shifts.status }).from(shifts).where(eq(shifts.id, Number(exp.shiftId))).limit(1)
      )[0];
      if (s && s.status === "CLOSED")
        throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن إلغاء مصروف على وردية مغلقة" });
    }

    // production-slice: إلغاء صرف مخزون (نثرية/تلف) ⇒ إعادة المخزون + قيد معكوس، بلا صندوق/receipt.
    if (exp.source === "STOCK") {
      const items = await tx.select().from(expenseStockItems).where(eq(expenseStockItems.expenseId, expenseId));
      items.sort((a: any, b: any) => Number(a.variantId) - Number(b.variantId));
      for (const it of items) {
        await applyMovement(tx, {
          variantId: Number(it.variantId),
          branchId: Number(exp.branchId),
          baseQuantity: Number(it.baseQuantity),
          movementType: "IN",
          referenceType: "EXPENSE_CANCEL",
          referenceId: expenseId,
          createdBy: actor.userId,
        });
      }
      await tx.update(expenses).set({ status: "CANCELLED" }).where(eq(expenses.id, expenseId));
      const reason = exp.stockReason === "WASTAGE" ? "WASTAGE" : "INTERNAL_USE";
      await postEntry(tx, {
        entryType: reason,
        branchId: Number(exp.branchId),
        cost: money(exp.amount).neg(),
        amount: money(exp.amount).neg(),
        revenue: money(0),
        profit: round2(money(exp.amount)),
        dedupeKey: null,
        notes: `إلغاء ${reason === "WASTAGE" ? "تلف" : "نثرية"} #${expenseId}`,
      });
      return { expenseId, status: "CANCELLED" };
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
  // expenseDate عمود DATE ⇒ منتصف ليل محلي (UTC يستثني يوم from كاملاً على +03:00).
  if (input.from) conds.push(gte(expenses.expenseDate, localDayStart(input.from)));
  if (input.to) conds.push(lte(expenses.expenseDate, localDayStart(input.to)));
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
      source: expenses.source,
      stockReason: expenses.stockReason,
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
