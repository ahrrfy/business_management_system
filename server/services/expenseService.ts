import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, inArray, lte, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import { paginateKeyset } from "../lib/paginateKeyset";
import {
  accountingEntries,
  auditLogs,
  branches,
  expenseStockItems,
  expenses,
  productVariants,
  receipts,
  shifts,
  users,
} from "../../drizzle/schema";
import { localDayStart } from "./dateRange";
import { getDb } from "../db";
import { escLike } from "../lib/sqlLike";
import { applyMovement, convertToBaseQuantity } from "./inventoryService";
import { findIdempotentRefId, recordIdempotencyKey } from "./idempotency";
import { postEntry } from "./ledgerService";
import { getActiveLock } from "./periodLockService";
import { money, round2, toDateStr, toDbMoney } from "./money";
import { shiftIdForCashTx } from "./shiftService";
import { assertCashOutAvailable } from "./cash/cashAvailability";
import { withTx, type Actor } from "./tx";
import { extractInsertId } from "../lib/insertId";

export type ExpensePaymentMethod =
  | "CASH"
  | "CARD"
  | "CHECK"
  | "TRANSFER"
  | "WALLET";
export type ExpenseCategory =
  | "RENT"
  | "UTILITIES"
  | "SUPPLIES"
  | "SALARY"
  | "TRANSPORT"
  | "MAINTENANCE"
  | "MARKETING"
  | "OTHER";

export type RecurringFrequency =
  | "DAILY"
  | "WEEKLY"
  | "MONTHLY"
  | "QUARTERLY"
  | "YEARLY";

/** production-slice: مصدر الصرف. CASH=نقدي (الموجود)؛ STOCK=صرف من المخزون بالكلفة (نثرية/تلف). */
export type ExpenseSource = "CASH" | "STOCK";
export type ExpenseStockReason = "INTERNAL_USE" | "WASTAGE";
export type ExpenseCashSource = "OWN_DRAWER" | "TREASURY";
export type ExpenseFundingKind =
  | "DRAWER"
  | "TREASURY"
  | "NON_CASH"
  | "STOCK"
  | "UNKNOWN";

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
  /** اختيار إداري صريح لمصدر النقد. غيابه يحافظ على السلوك التاريخي الآمن. */
  cashSource?: ExpenseCashSource | null;
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
async function createStockExpenseTx(
  tx: any,
  input: CreateExpenseInput,
  actor: Actor,
) {
  const stockReason = input.stockReason;
  if (stockReason !== "INTERNAL_USE" && stockReason !== "WASTAGE") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "حدّد نوع الصرف من المخزون (نثرية/تلف)",
    });
  }
  if (!input.items?.length)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "حدّد صنفاً واحداً على الأقل",
    });

  // حلّ كل صنف إلى كمية أساس صحيحة.
  const resolved: Array<{
    variantId: number;
    productUnitId: number | null;
    quantity: string;
    baseQuantity: number;
  }> = [];
  for (const it of input.items) {
    if (!Number.isInteger(it.variantId) || it.variantId <= 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "صنف غير صالح" });
    }
    let baseQuantity: number;
    let quantity: string;
    if (it.productUnitId != null && it.quantity != null) {
      const conv = await convertToBaseQuantity(
        tx,
        it.productUnitId,
        it.quantity,
        it.variantId,
      );
      baseQuantity = conv.baseQuantity;
      quantity = money(it.quantity).toFixed(4);
    } else {
      if (
        it.baseQuantity == null ||
        !Number.isInteger(it.baseQuantity) ||
        it.baseQuantity <= 0
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "الكمية الأساس يجب أن تكون عدداً صحيحاً موجباً",
        });
      }
      baseQuantity = it.baseQuantity;
      quantity = money(it.baseQuantity).toFixed(4);
    }
    resolved.push({
      variantId: it.variantId,
      productUnitId: it.productUnitId ?? null,
      quantity,
      baseQuantity,
    });
  }

  const varIds = Array.from(new Set(resolved.map((r) => r.variantId)));
  const existing = await tx
    .select({ id: productVariants.id })
    .from(productVariants)
    .where(inArray(productVariants.id, varIds));
  const existSet = new Set(existing.map((v: any) => Number(v.id)));
  for (const id of varIds)
    if (!existSet.has(id))
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `صنف #${id} غير موجود`,
      });

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
  const expenseId = extractInsertId(eRes);
  // G4 (١٩/٦/٢٦): مفتاح idempotency مفصول CASH/STOCK — كان توحيدهما يسمح بإعادة الـreplay
  // عبر المسارَين بنفس clientRequestId فيُرجَع كائن لا يطابق المُدخل (تلوّث بيانات بسيط).
  if (input.clientRequestId)
    await recordIdempotencyKey(
      tx,
      "expense.create.STOCK",
      input.clientRequestId,
      expenseId,
    );

  // خصم المخزون (تصاعدياً بـvariantId) + snapshot الكلفة + أسطر الأصناف.
  resolved.sort((a, b) => a.variantId - b.variantId);
  const costRows = await tx
    .select({ id: productVariants.id, costPrice: productVariants.costPrice })
    .from(productVariants)
    .where(inArray(productVariants.id, varIds));
  const costMap = new Map<number, string>(
    costRows.map(
      (v: any) => [Number(v.id), String(v.costPrice)] as [number, string],
    ),
  );

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
  await tx
    .update(expenses)
    .set({ amount: amount.toFixed(2) })
    .where(eq(expenses.id, expenseId));

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
    createdBy: actor.userId,
  });

  return { expenseId, receiptId: null };
}

/** Record a daily expense: CASH ⇒ receipt(OUT)+PAYMENT_OUT ; STOCK ⇒ صرف مخزون بالكلفة (نثرية/تلف، بلا صندوق). */
export async function createExpense(input: CreateExpenseInput, actor: Actor) {
  return withTx(async (tx) => {
    // Defense in depth behind the router gate. A cashier-controlled expense
    // would be an alternate way to reduce expected drawer cash and conceal a
    // shortage. Legacy internal maintenance callers may omit role; every API
    // caller supplies it through context.
    if (actor.role && actor.role !== "admin" && actor.role !== "manager") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "تسجيل المصروفات المالية من صلاحية المدير/الخزينة فقط",
      });
    }

    // G4 (١٩/٦/٢٦): مفتاح idempotency مفصول حسب المصدر — كان توحيد المفتاح بين CASH/STOCK
    // يسمح بـreplay صامت يُرجع نتيجة لا تطابق المُدخل عند تغيّر source بين طلبَين بنفس الـID.
    const opKey =
      (input.source ?? "CASH") === "STOCK"
        ? "expense.create.STOCK"
        : "expense.create.CASH";
    const replayId = await findIdempotentRefId(
      tx,
      opKey,
      input.clientRequestId,
    );
    if (replayId) {
      const ex = (
        await tx
          .select({ receiptId: expenses.receiptId })
          .from(expenses)
          .where(eq(expenses.id, replayId))
          .limit(1)
      )[0];
      return {
        expenseId: replayId,
        receiptId: ex?.receiptId ? Number(ex.receiptId) : null,
        idempotent: true,
      };
    }

    const b = (
      await tx
        .select({ id: branches.id })
        .from(branches)
        .where(eq(branches.id, input.branchId))
        .limit(1)
    )[0];
    if (!b)
      throw new TRPCError({ code: "NOT_FOUND", message: "الفرع غير موجود" });

    if (
      input.cashSource &&
      ((input.source ?? "CASH") === "STOCK" || input.paymentMethod !== "CASH")
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "مصدر النقد يُحدَّد للمصروف المالي النقدي فقط",
      });
    }

    // production-slice: صرف من المخزون (نثرية/تلف) — مسار منفصل لا يلمس الصندوق النقدي.
    if ((input.source ?? "CASH") === "STOCK") {
      return await createStockExpenseTx(tx, input, actor);
    }

    const amt = money(input.amount);
    if (amt.lte(0))
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "مبلغ المصروف يجب أن يكون موجباً",
      });
    if (input.category === "OTHER" && !input.description?.trim())
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "وصف المصروف مطلوب لفئة «أخرى»",
      });

    // سياسة الخزينة الإدارية vs درج الكاشير (تدقيق ١٧/٦ — تعديل المرحلة-١):
    //  - admin/manager بلا وردية + نقدي ⇒ shiftId=null + bucket=TREASURY (سجلّ خزينة).
    //  - cashier/warehouse بلا وردية + نقدي ⇒ PRECONDITION_FAILED (الحماية الأصلية).
    //  - أيٌّ منهم مع وردية مفتوحة ⇒ shiftId=الوردية + bucket=DRAWER (Z-report).
    //  - غير النقدي ⇒ shiftId اختياري + bucket=NULL (لا يَمسّ صندوقاً).
    let effectiveShiftId: number | null = input.shiftId ?? null;
    let cashBucket: "DRAWER" | "TREASURY" | null = null;
    if (input.paymentMethod === "CASH") {
      if (input.cashSource === "TREASURY") {
        // اختيار صريح: الخزينة الإدارية لا تتبع أي وردية، حتى لو كان للفاعل درج مفتوح.
        effectiveShiftId = null;
        cashBucket = "TREASURY";
      } else if (input.cashSource === "OWN_DRAWER") {
        if (effectiveShiftId == null) {
          const g = await shiftIdForCashTx(
            tx,
            actor,
            input.branchId,
            "مصروف نقدي من درج الفاعل",
          );
          if (g.shiftId == null || g.cashBucket !== "DRAWER") {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message:
                "لا توجد وردية مفتوحة للفاعل في هذا الفرع؛ اختر الخزينة الإدارية أو افتح وردية",
            });
          }
          effectiveShiftId = g.shiftId;
        }
        cashBucket = "DRAWER";
      } else if (effectiveShiftId == null) {
        const g = await shiftIdForCashTx(
          tx,
          actor,
          input.branchId,
          "مصروف نقدي",
        );
        effectiveShiftId = g.shiftId;
        cashBucket = g.cashBucket;
      } else {
        cashBucket = "DRAWER"; // shiftId مُمرَّر صراحةً ⇒ نقد درج
      }
    }

    if (effectiveShiftId) {
      const s = (
        await tx
          .select()
          .from(shifts)
          .where(eq(shifts.id, effectiveShiftId))
          .for("update")
          .limit(1)
      )[0];
      if (!s)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "الوردية غير موجودة",
        });
      if (s.status !== "OPEN")
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "لا يمكن تسجيل مصروف على وردية مغلقة",
        });
      if (Number(s.branchId) !== input.branchId)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "الوردية لا تطابق الفرع",
        });
      // لا امتياز إداري على عهدة شخص آخر: اختيار OWN_DRAWER أو تمرير shiftId يربطان وردية الفاعل فقط.
      if (Number(s.userId) !== Number(actor.userId)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "لا تَستطيع تسجيل مصروف على وردية مستخدم آخر",
        });
      }
    }

    if (input.paymentMethod === "CASH" && cashBucket != null) {
      await assertCashOutAvailable(tx, {
        branchId: input.branchId,
        cashBucket,
        shiftId: effectiveShiftId,
        amount: amt,
        operation: "تسجيل المصروف النقدي",
      });
    }

    const rRes = await tx.insert(receipts).values({
      invoiceId: null,
      branchId: input.branchId,
      shiftId: effectiveShiftId,
      cashBucket,
      direction: "OUT",
      amount: toDbMoney(amt),
      paymentMethod: input.paymentMethod,
      referenceNumber: input.referenceNumber?.trim() || null,
      status: "COMPLETED",
      createdBy: actor.userId,
    });
    const receiptId = extractInsertId(rRes);

    const expDate = input.expenseDate?.trim() || toDateStr();
    const isRecurring = !!input.isRecurring;
    if (isRecurring && !input.recurringFrequency)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "حدّد دورية التكرار",
      });
    const eRes = await tx.insert(expenses).values({
      branchId: input.branchId,
      shiftId: effectiveShiftId,
      cashBucket,
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
    const expenseId = extractInsertId(eRes);
    // سجّل مفتاح الـidempotency — طلبٌ متزامن مكرّر يصطدم بالقيد الفريد فيُلغى (ROLLBACK) قبل قيد الصرف.
    // G4: المفتاح مفصول CASH عن STOCK.
    if (input.clientRequestId)
      await recordIdempotencyKey(
        tx,
        "expense.create.CASH",
        input.clientRequestId,
        expenseId,
      );

    await postEntry(tx, {
      entryType: "PAYMENT_OUT",
      branchId: input.branchId,
      receiptId,
      amount: amt,
      entryDate: new Date(expDate),
      notes: `مصروف (${input.category})${input.description?.trim() ? ": " + input.description.trim() : ""}`,
      createdBy: actor.userId,
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
    const exp = (
      await tx
        .select()
        .from(expenses)
        .where(eq(expenses.id, expenseId))
        .for("update")
        .limit(1)
    )[0];
    if (!exp)
      throw new TRPCError({ code: "NOT_FOUND", message: "المصروف غير موجود" });
    if (exp.status !== "ACTIVE")
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "المصروف ملغى بالفعل",
      });

    // عزل عبر-فرعي: admin يمرّ؛ غيره يجب أن يكون من فرع المصروف نفسه (نمط جذري ٢).
    // role يُمرَّر من الموجّه؛ نقرأه من قاعدة البيانات احتياطاً إن غاب.
    const role =
      actor.role ??
      (
        await tx
          .select({ role: users.role })
          .from(users)
          .where(eq(users.id, actor.userId))
          .limit(1)
      )[0]?.role ??
      "";
    if (role !== "admin" && Number(actor.branchId) !== Number(exp.branchId)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "لا تستطيع إلغاء مصروف لفرع آخر",
      });
    }

    // SOD-05 (فصل المهام، قرار المالك ٢٠/٦): مُنشئ المصروف لا يُلغيه بنفسه (يلزم مدير آخر) — يَسدّ
    // تلاعب «إنشاء مصروف ثم إلغاؤه» لإخفاء حركة نقد. الأدمن مستثنى (سلطة عليا للتصحيح الإداري).
    if (
      role !== "admin" &&
      exp.createdBy != null &&
      Number(exp.createdBy) === actor.userId
    ) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message:
          "لا يجوز إلغاء مصروف أنشأته بنفسك — يلزم مدير آخر (فصل المهام).",
      });
    }

    // قفل الفترة (تدقيق ١٧/٧): الإلغاء يقلب الحالة إلى CANCELLED فيختفي المصروف من P&L لشهره (الفلتر
    // ACTIVE بتاريخ expenseDate). لو كان المصروف مؤرَّخاً داخل فترة مُقفَلة تتغيّر أرقامها بأثر رجعي.
    // نرفض ونطلب فتح الفترة أوّلاً. expenseDate عمود DATE (drizzle string / mysql2 Date وقت التشغيل).
    const lock = await getActiveLock(tx);
    if (lock) {
      const expDay = exp.expenseDate
        ? new Date(exp.expenseDate).toISOString().slice(0, 10)
        : "";
      if (expDay && expDay <= lock.cutoffDate) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `الفترة المالية مُقفَلة حتى ${lock.cutoffDate} — لا يمكن إلغاء مصروف مؤرَّخ داخلها. يلزم فتح الفترة أوّلاً (admin).`,
        });
      }
    }

    if (exp.shiftId) {
      const s = (
        await tx
          .select({ status: shifts.status })
          .from(shifts)
          .where(eq(shifts.id, Number(exp.shiftId)))
          .for("update")
          .limit(1)
      )[0];
      if (s && s.status === "CLOSED")
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "لا يمكن إلغاء مصروف على وردية مغلقة",
        });
    }

    // production-slice: إلغاء صرف مخزون (نثرية/تلف) ⇒ إعادة المخزون + قيد معكوس، بلا صندوق/receipt.
    if (exp.source === "STOCK") {
      const items = await tx
        .select()
        .from(expenseStockItems)
        .where(eq(expenseStockItems.expenseId, expenseId));
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
      await tx
        .update(expenses)
        .set({ status: "CANCELLED" })
        .where(eq(expenses.id, expenseId));
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
        createdBy: actor.userId,
      });
      return { expenseId, status: "CANCELLED" };
    }

    await tx
      .update(expenses)
      .set({ status: "CANCELLED" })
      .where(eq(expenses.id, expenseId));
    if (exp.receiptId) {
      await tx
        .update(receipts)
        .set({ status: "REVERSED" })
        .where(eq(receipts.id, Number(exp.receiptId)));
    }

    // Compensating IN-receipt so cash totals nullify cleanly.
    // cashBucket مرآة الأصل: مصروف TREASURY ⇒ تعويضه TREASURY (يَبقى خارج Z-report).
    const compRes = await tx.insert(receipts).values({
      invoiceId: null,
      branchId: Number(exp.branchId),
      shiftId: exp.shiftId ?? null,
      cashBucket:
        (exp as { cashBucket?: "DRAWER" | "TREASURY" | null }).cashBucket ??
        null,
      direction: "IN",
      amount: toDbMoney(exp.amount),
      paymentMethod: exp.paymentMethod,
      status: "COMPLETED",
      referenceNumber: `CANCEL-EXP-${expenseId}`,
      createdBy: actor.userId,
    });
    const compReceiptId = extractInsertId(compRes);

    // G5 (١٩/٦/٢٦): قيد PAYMENT_IN بدل ADJUST (موجب) — متّسق مع نمط cancelVoucher
    // ويُغلق انحرافاً في cashReconcile الذي يتجاهل ADJUST عند حساب الرصيد من القيود.
    await postEntry(tx, {
      entryType: "PAYMENT_IN",
      branchId: Number(exp.branchId),
      receiptId: compReceiptId,
      amount: money(exp.amount),
      notes: `إلغاء مصروف #${expenseId}`,
      createdBy: actor.userId,
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
  /** بحث نصّي خادمي: البيان/المرجع/المستفيد (أعمدة expenses فقط ⇒ بلا join في المجاميع). */
  q?: string;
  /** طريقة الدفع (مطابقة يوم البطاقات مع كشف جهاز الدفع ونحوها). */
  paymentMethod?: ExpensePaymentMethod;
  /** مصدر الصرف: نقدي أو صرف من المخزون بالكلفة (نثرية/تلف). */
  source?: ExpenseSource;
  /** التصنيف التشغيلي الصادق لمصدر التمويل. */
  fundingKind?: Exclude<ExpenseFundingKind, "UNKNOWN">;
  /** منفّذ التسجيل — يُقيَّده الراوتر بمالك السجل لغير المرتفعين. */
  createdBy?: number | null;
  /** وردية/درج محدد. */
  shiftId?: number;
  /** مبلغ مطابق تماماً (decimal 15,2). */
  amount?: string;
  limit?: number;
  /** إزاحة للتصفّح/التصدير الشامل (fetchAllPaged) — totals تبقى على كامل المطابق. */
  offset?: number;
  // S3 (٣٠/٦): cursor (id) لـkeyset — يَتجاوز COUNT/SUM الكامل في الـtotals.
  cursor?: number;
}

const expenseCreator = alias(users, "expenseCreator");
const expenseShiftOwner = alias(users, "expenseShiftOwner");
const expenseReceiptCreator = alias(users, "expenseReceiptCreator");
const expenseReceiptApprover = alias(users, "expenseReceiptApprover");
const expenseAuditActor = alias(users, "expenseAuditActor");

function expenseDetailedSelect(db: NonNullable<ReturnType<typeof getDb>>) {
  return db
    .select({
      id: expenses.id,
      branchId: expenses.branchId,
      branchName: branches.name,
      branchCode: branches.code,
      expenseDate: expenses.expenseDate,
      category: expenses.category,
      amount: expenses.amount,
      paymentMethod: expenses.paymentMethod,
      cashBucket: expenses.cashBucket,
      source: expenses.source,
      stockReason: expenses.stockReason,
      description: expenses.description,
      referenceNumber: expenses.referenceNumber,
      payee: expenses.payee,
      costCenter: expenses.costCenter,
      isRecurring: expenses.isRecurring,
      recurringFrequency: expenses.recurringFrequency,
      status: expenses.status,
      shiftId: expenses.shiftId,
      receiptId: expenses.receiptId,
      createdBy: expenses.createdBy,
      createdByName: expenseCreator.name,
      createdByRole: expenseCreator.role,
      createdAt: expenses.createdAt,
      updatedAt: expenses.updatedAt,

      shiftOwnerId: shifts.userId,
      shiftOwnerName: expenseShiftOwner.name,
      shiftOwnerRole: expenseShiftOwner.role,
      shiftType: shifts.shiftType,
      shiftStatus: shifts.status,
      shiftOpenedAt: shifts.openedAt,
      shiftClosedAt: shifts.closedAt,

      linkedReceiptId: receipts.id,
      receiptBranchId: receipts.branchId,
      receiptDirection: receipts.direction,
      receiptAmount: receipts.amount,
      receiptPaymentMethod: receipts.paymentMethod,
      receiptCashBucket: receipts.cashBucket,
      receiptShiftId: receipts.shiftId,
      receiptStatus: receipts.status,
      receiptReferenceNumber: receipts.referenceNumber,
      receiptCreatedBy: receipts.createdBy,
      receiptCreatedByName: expenseReceiptCreator.name,
      receiptCreatedByRole: expenseReceiptCreator.role,
      receiptCreatedAt: receipts.createdAt,
      receiptApprovalStatus: receipts.approvalStatus,
      receiptApprovedBy: receipts.approvedBy,
      receiptApprovedByName: expenseReceiptApprover.name,
      receiptApprovedByRole: expenseReceiptApprover.role,
      receiptApprovedAt: receipts.approvedAt,
    })
    .from(expenses)
    .leftJoin(branches, eq(expenses.branchId, branches.id))
    .leftJoin(expenseCreator, eq(expenses.createdBy, expenseCreator.id))
    .leftJoin(shifts, eq(expenses.shiftId, shifts.id))
    .leftJoin(expenseShiftOwner, eq(shifts.userId, expenseShiftOwner.id))
    .leftJoin(receipts, eq(expenses.receiptId, receipts.id))
    .leftJoin(
      expenseReceiptCreator,
      eq(receipts.createdBy, expenseReceiptCreator.id),
    )
    .leftJoin(
      expenseReceiptApprover,
      eq(receipts.approvedBy, expenseReceiptApprover.id),
    );
}

function fundingKindOf(row: {
  source: string;
  paymentMethod: string;
  cashBucket: "DRAWER" | "TREASURY" | null;
}): ExpenseFundingKind {
  if (row.source === "STOCK") return "STOCK";
  if (row.paymentMethod !== "CASH") return "NON_CASH";
  if (row.cashBucket === "DRAWER") return "DRAWER";
  if (row.cashBucket === "TREASURY") return "TREASURY";
  return "UNKNOWN";
}

function nullableId(value: unknown): number | null {
  return value == null ? null : Number(value);
}

function integrityWarningsOf(row: any): string[] {
  const warnings: string[] = [];
  const fundingKind = fundingKindOf(row);
  if (!row.description?.trim()) warnings.push("DESCRIPTION_MISSING");
  if (!row.payee?.trim()) warnings.push("PAYEE_MISSING");
  if (row.source === "STOCK") {
    if (row.receiptId != null || row.linkedReceiptId != null)
      warnings.push("STOCK_HAS_RECEIPT");
    if (row.shiftId != null || row.cashBucket != null)
      warnings.push("STOCK_HAS_CASH_LOCATION");
    return warnings;
  }

  if (row.receiptId == null || row.linkedReceiptId == null) {
    warnings.push("RECEIPT_MISSING");
  } else {
    if (row.receiptDirection !== "OUT")
      warnings.push("RECEIPT_DIRECTION_MISMATCH");
    if (!money(row.amount).eq(money(row.receiptAmount)))
      warnings.push("RECEIPT_AMOUNT_MISMATCH");
    if (nullableId(row.branchId) !== nullableId(row.receiptBranchId)) {
      warnings.push("RECEIPT_BRANCH_MISMATCH");
    }
    if (nullableId(row.shiftId) !== nullableId(row.receiptShiftId))
      warnings.push("RECEIPT_SHIFT_MISMATCH");
    if (row.paymentMethod !== row.receiptPaymentMethod)
      warnings.push("RECEIPT_PAYMENT_METHOD_MISMATCH");
    if ((row.cashBucket ?? null) !== (row.receiptCashBucket ?? null))
      warnings.push("RECEIPT_CASH_BUCKET_MISMATCH");
    if (nullableId(row.createdBy) !== nullableId(row.receiptCreatedBy))
      warnings.push("RECEIPT_CREATOR_MISMATCH");
    if (row.status === "ACTIVE" && row.receiptStatus !== "COMPLETED")
      warnings.push("RECEIPT_STATUS_MISMATCH");
    if (row.status === "CANCELLED" && row.receiptStatus !== "REVERSED")
      warnings.push("RECEIPT_STATUS_MISMATCH");
    if (row.receiptApprovalStatus !== "APPROVED")
      warnings.push("RECEIPT_NOT_APPROVED");
  }

  if (fundingKind === "UNKNOWN") warnings.push("CASH_FUNDING_UNKNOWN");
  if (row.cashBucket === "DRAWER" && row.shiftId == null)
    warnings.push("DRAWER_WITHOUT_SHIFT");
  if (row.cashBucket === "TREASURY" && row.shiftId != null)
    warnings.push("TREASURY_WITH_SHIFT");
  if (row.paymentMethod !== "CASH" && row.cashBucket != null)
    warnings.push("NON_CASH_HAS_CASH_BUCKET");
  return warnings;
}

function enrichExpenseRow<T extends Record<string, any>>(row: T) {
  const fundingKind = fundingKindOf(row as any);
  const integrityWarnings = integrityWarningsOf(row);
  return {
    ...row,
    fundingKind,
    integrityWarnings,
    needsAudit: integrityWarnings.length > 0,
  };
}

function buildExpenseConditions(input: ListExpensesInput) {
  const conds = [] as any[];
  if (input.branchId) conds.push(eq(expenses.branchId, input.branchId));
  if (input.createdBy != null)
    conds.push(eq(expenses.createdBy, input.createdBy));
  if (input.shiftId) conds.push(eq(expenses.shiftId, input.shiftId));
  if (input.category) conds.push(eq(expenses.category, input.category));
  if (input.status) conds.push(eq(expenses.status, input.status));
  if (input.paymentMethod)
    conds.push(eq(expenses.paymentMethod, input.paymentMethod));
  if (input.source) conds.push(eq(expenses.source, input.source));
  if (input.amount != null) conds.push(eq(expenses.amount, input.amount));
  if (input.fundingKind === "STOCK") conds.push(eq(expenses.source, "STOCK"));
  if (input.fundingKind === "NON_CASH") {
    conds.push(
      and(eq(expenses.source, "CASH"), ne(expenses.paymentMethod, "CASH")),
    );
  }
  if (input.fundingKind === "DRAWER") {
    conds.push(
      and(
        eq(expenses.source, "CASH"),
        eq(expenses.paymentMethod, "CASH"),
        eq(expenses.cashBucket, "DRAWER"),
      ),
    );
  }
  if (input.fundingKind === "TREASURY") {
    conds.push(
      and(
        eq(expenses.source, "CASH"),
        eq(expenses.paymentMethod, "CASH"),
        eq(expenses.cashBucket, "TREASURY"),
      ),
    );
  }
  if (input.from)
    conds.push(gte(expenses.expenseDate, localDayStart(input.from)));
  if (input.to) conds.push(lte(expenses.expenseDate, localDayStart(input.to)));
  if (input.q) {
    const pat = `%${escLike(input.q.trim())}%`;
    conds.push(
      or(
        sql`${expenses.description} LIKE ${pat} ESCAPE '!'`,
        sql`${expenses.referenceNumber} LIKE ${pat} ESCAPE '!'`,
        sql`${expenses.payee} LIKE ${pat} ESCAPE '!'`,
        sql`CAST(${expenses.amount} AS CHAR) LIKE ${pat} ESCAPE '!'`,
      ),
    );
  }
  return conds;
}

const financialIntegritySql = sql`(
  (${expenses.source} = 'STOCK' AND (${expenses.receiptId} IS NOT NULL OR ${expenses.shiftId} IS NOT NULL OR ${expenses.cashBucket} IS NOT NULL))
  OR
  (${expenses.source} <> 'STOCK' AND (
    ${expenses.receiptId} IS NULL OR ${receipts.id} IS NULL
    OR ${receipts.direction} <> 'OUT'
    OR NOT (${expenses.amount} <=> ${receipts.amount})
    OR NOT (${expenses.branchId} <=> ${receipts.branchId})
    OR NOT (${expenses.shiftId} <=> ${receipts.shiftId})
    OR NOT (${expenses.paymentMethod} <=> ${receipts.paymentMethod})
    OR NOT (${expenses.cashBucket} <=> ${receipts.cashBucket})
    OR NOT (${expenses.createdBy} <=> ${receipts.createdBy})
    OR (${expenses.status} = 'ACTIVE' AND ${receipts.status} <> 'COMPLETED')
    OR (${expenses.status} = 'CANCELLED' AND ${receipts.status} <> 'REVERSED')
    OR ${receipts.approvalStatus} <> 'APPROVED'
    OR (${expenses.paymentMethod} = 'CASH' AND ${expenses.cashBucket} IS NULL)
    OR (${expenses.cashBucket} = 'DRAWER' AND ${expenses.shiftId} IS NULL)
    OR (${expenses.cashBucket} = 'TREASURY' AND ${expenses.shiftId} IS NOT NULL)
    OR (${expenses.paymentMethod} <> 'CASH' AND ${expenses.cashBucket} IS NOT NULL)
  ))
)`;

const needsAuditSql = sql`(
  TRIM(COALESCE(${expenses.description}, '')) = ''
  OR TRIM(COALESCE(${expenses.payee}, '')) = ''
  OR ${financialIntegritySql}
)`;

export async function listExpenses(input: ListExpensesInput = {}) {
  const db = getDb();
  const emptyTotals = {
    active: "0.00",
    drawer: "0.00",
    treasury: "0.00",
    nonCash: "0.00",
    stock: "0.00",
    cancelled: "0.00",
    unknown: "0.00",
    needsAudit: 0,
    missingDescription: 0,
    missingPayee: 0,
    sourceMismatch: 0,
    drawerMismatch: 0,
    count: 0,
  };
  if (!db)
    return {
      rows: [],
      totals: emptyTotals,
      hasMore: false,
      nextCursor: null as number | null,
    };
  const conds = buildExpenseConditions(input);
  // /simplify ٣٠/٦: paginateKeyset + Promise.all (rows + totals بالتَوازي — يَقطع زمن الجدار).
  const baseWhere = conds.length ? and(...conds) : undefined;
  const [pageResult, totalsRow] = await Promise.all([
    paginateKeyset({
      cursor: input.cursor,
      limit: input.limit,
      offset: input.offset,
      defaultLimit: 200,
      idCol: expenses.id,
      baseConds: conds,
      runQuery: (where, lim, off) =>
        expenseDetailedSelect(db)
          .where(where)
          .orderBy(desc(expenses.id))
          .limit(lim)
          .offset(off),
    }),
    // المجاميع المالية على كامل المطابق (لا تَستفيد من keyset) — تُشغَّل بالتَوازي.
    db
      .select({
        active: sql<string>`COALESCE(SUM(CASE WHEN ${expenses.status} = 'ACTIVE' THEN ${expenses.amount} ELSE 0 END), 0)`,
        drawer: sql<string>`COALESCE(SUM(CASE WHEN ${expenses.status} = 'ACTIVE' AND ${expenses.source} <> 'STOCK' AND ${expenses.paymentMethod} = 'CASH' AND ${expenses.cashBucket} = 'DRAWER' THEN ${expenses.amount} ELSE 0 END), 0)`,
        treasury: sql<string>`COALESCE(SUM(CASE WHEN ${expenses.status} = 'ACTIVE' AND ${expenses.source} <> 'STOCK' AND ${expenses.paymentMethod} = 'CASH' AND ${expenses.cashBucket} = 'TREASURY' THEN ${expenses.amount} ELSE 0 END), 0)`,
        nonCash: sql<string>`COALESCE(SUM(CASE WHEN ${expenses.status} = 'ACTIVE' AND ${expenses.source} <> 'STOCK' AND ${expenses.paymentMethod} <> 'CASH' THEN ${expenses.amount} ELSE 0 END), 0)`,
        stock: sql<string>`COALESCE(SUM(CASE WHEN ${expenses.status} = 'ACTIVE' AND ${expenses.source} = 'STOCK' THEN ${expenses.amount} ELSE 0 END), 0)`,
        cancelled: sql<string>`COALESCE(SUM(CASE WHEN ${expenses.status} = 'CANCELLED' THEN ${expenses.amount} ELSE 0 END), 0)`,
        unknown: sql<string>`COALESCE(SUM(CASE WHEN ${expenses.status} = 'ACTIVE' AND ${expenses.source} <> 'STOCK' AND ${expenses.paymentMethod} = 'CASH' AND ${expenses.cashBucket} IS NULL THEN ${expenses.amount} ELSE 0 END), 0)`,
        needsAudit: sql<number>`COALESCE(SUM(CASE WHEN ${needsAuditSql} THEN 1 ELSE 0 END), 0)`,
        missingDescription: sql<number>`COALESCE(SUM(CASE WHEN TRIM(COALESCE(${expenses.description}, '')) = '' THEN 1 ELSE 0 END), 0)`,
        missingPayee: sql<number>`COALESCE(SUM(CASE WHEN TRIM(COALESCE(${expenses.payee}, '')) = '' THEN 1 ELSE 0 END), 0)`,
        sourceMismatch: sql<number>`COALESCE(SUM(CASE WHEN ${financialIntegritySql} THEN 1 ELSE 0 END), 0)`,
        drawerMismatch: sql<number>`COALESCE(SUM(CASE WHEN ${expenses.cashBucket} = 'DRAWER' AND (${expenses.shiftId} IS NULL OR ${expenses.receiptId} IS NULL) THEN 1 ELSE 0 END), 0)`,
        count: sql<number>`COUNT(*)`,
      })
      .from(expenses)
      .leftJoin(receipts, eq(expenses.receiptId, receipts.id))
      .where(baseWhere)
      .then((rows) => rows[0]),
  ]);

  return {
    rows: pageResult.rows.map(enrichExpenseRow),
    totals: {
      active: totalsRow?.active ?? "0.00",
      drawer: totalsRow?.drawer ?? "0.00",
      treasury: totalsRow?.treasury ?? "0.00",
      nonCash: totalsRow?.nonCash ?? "0.00",
      stock: totalsRow?.stock ?? "0.00",
      cancelled: totalsRow?.cancelled ?? "0.00",
      unknown: totalsRow?.unknown ?? "0.00",
      needsAudit: Number(totalsRow?.needsAudit ?? 0),
      missingDescription: Number(totalsRow?.missingDescription ?? 0),
      missingPayee: Number(totalsRow?.missingPayee ?? 0),
      sourceMismatch: Number(totalsRow?.sourceMismatch ?? 0),
      drawerMismatch: Number(totalsRow?.drawerMismatch ?? 0),
      count: Number(totalsRow?.count ?? 0),
    },
    hasMore: pageResult.hasMore,
    nextCursor: pageResult.nextCursor,
  };
}

export interface ExpenseTraceScope {
  branchId?: number;
  createdBy?: number | null;
}

/** أثر مصروف واحد: صف العقد الكامل + بنود المخزون + القيد + أحداث التدقيق وسندات التعويض. */
export async function getExpenseTrace(
  expenseId: number,
  scope: ExpenseTraceScope = {},
) {
  const db = getDb();
  if (!db) return null;
  const conds: any[] = [eq(expenses.id, expenseId)];
  if (scope.branchId) conds.push(eq(expenses.branchId, scope.branchId));
  if (scope.createdBy != null)
    conds.push(eq(expenses.createdBy, scope.createdBy));
  const raw = (
    await expenseDetailedSelect(db)
      .where(and(...conds))
      .limit(1)
  )[0];
  if (!raw) return null;
  const expense = enrichExpenseRow(raw);

  const ledgerWhere =
    raw.receiptId != null
      ? eq(accountingEntries.receiptId, Number(raw.receiptId))
      : raw.source === "STOCK" && raw.stockReason
        ? eq(accountingEntries.dedupeKey, `${raw.stockReason}:${expenseId}`)
        : eq(accountingEntries.id, -1);

  const [stockItems, ledgerEntries, auditTrail, reversalReceipts] =
    await Promise.all([
      raw.source === "STOCK"
        ? db
            .select({
              id: expenseStockItems.id,
              variantId: expenseStockItems.variantId,
              productUnitId: expenseStockItems.productUnitId,
              quantity: expenseStockItems.quantity,
              baseQuantity: expenseStockItems.baseQuantity,
              unitCost: expenseStockItems.unitCost,
              lineCost: expenseStockItems.lineCost,
              createdAt: expenseStockItems.createdAt,
            })
            .from(expenseStockItems)
            .where(eq(expenseStockItems.expenseId, expenseId))
            .orderBy(expenseStockItems.id)
        : Promise.resolve([]),
      db
        .select({
          id: accountingEntries.id,
          entryType: accountingEntries.entryType,
          receiptId: accountingEntries.receiptId,
          amount: accountingEntries.amount,
          cost: accountingEntries.cost,
          revenue: accountingEntries.revenue,
          profit: accountingEntries.profit,
          entryDate: accountingEntries.entryDate,
          notes: accountingEntries.notes,
          createdBy: accountingEntries.createdBy,
          createdByNameSnapshot: accountingEntries.createdByNameSnapshot,
          createdAt: accountingEntries.createdAt,
        })
        .from(accountingEntries)
        .where(ledgerWhere)
        .orderBy(desc(accountingEntries.id))
        .limit(25),
      db
        .select({
          id: auditLogs.id,
          action: auditLogs.action,
          userId: auditLogs.userId,
          userName: expenseAuditActor.name,
          userRole: expenseAuditActor.role,
          oldValue: auditLogs.oldValue,
          newValue: auditLogs.newValue,
          createdAt: auditLogs.createdAt,
        })
        .from(auditLogs)
        .leftJoin(expenseAuditActor, eq(auditLogs.userId, expenseAuditActor.id))
        .where(
          and(
            eq(auditLogs.entityType, "expense"),
            eq(auditLogs.entityId, String(expenseId)),
          ),
        )
        .orderBy(desc(auditLogs.id))
        .limit(25),
      db
        .select({
          id: receipts.id,
          direction: receipts.direction,
          amount: receipts.amount,
          paymentMethod: receipts.paymentMethod,
          cashBucket: receipts.cashBucket,
          shiftId: receipts.shiftId,
          status: receipts.status,
          referenceNumber: receipts.referenceNumber,
          createdBy: receipts.createdBy,
          createdByName: expenseReceiptCreator.name,
          createdAt: receipts.createdAt,
          approvalStatus: receipts.approvalStatus,
        })
        .from(receipts)
        .leftJoin(
          expenseReceiptCreator,
          eq(receipts.createdBy, expenseReceiptCreator.id),
        )
        .where(
          and(
            eq(receipts.branchId, Number(raw.branchId)),
            eq(receipts.referenceNumber, `CANCEL-EXP-${expenseId}`),
          ),
        )
        .orderBy(desc(receipts.id))
        .limit(5),
    ]);

  return { expense, stockItems, ledgerEntries, auditTrail, reversalReceipts };
}
