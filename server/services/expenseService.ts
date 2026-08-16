import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gte, inArray, lte, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import { paginateKeyset } from "../lib/paginateKeyset";
import {
  accountingEntries,
  accrualCorrectionRequests,
  accrualObligationEvents,
  accrualObligations,
  assetMaintenance,
  auditLogs,
  branches,
  expenseStockItems,
  expenses,
  fixedAssets,
  idempotencyKeys,
  productVariants,
  purchaseOrders,
  receipts,
  shifts,
  users,
} from "../../drizzle/schema";
import { localDayStart } from "./dateRange";
import { getDb, type Tx } from "../db";
import { escLike } from "../lib/sqlLike";
import { applyMovement, convertToBaseQuantity } from "./inventoryService";
import {
  checkIdempotency,
  idempotencyHash,
  recordIdempotencyKey,
} from "./idempotency";
import { postEntry } from "./ledgerService";
import { getActiveLock } from "./periodLockService";
import { money, round2, toDateStr, toDbMoney } from "./money";
import { assertCashOutAvailable, lockCashSourceForUpdate } from "./cash/cashAvailability";
import { withTx, type Actor } from "./tx";
import { extractInsertId } from "../lib/insertId";
import { parseSystemPaymentRequest } from "./voucher/create";
import { computeSignature } from "./voucher/helpers";
import {
  expensePaymentResubmitKey,
  parseExpensePaymentResubmitDescription,
  parseExpensePaymentResubmitKey,
} from "./voucher/resubmitLineage";
import {
  createPostingIntent,
  signedPostingLines,
  type AccountRole,
  type PostingIntent,
  type PostingSourceComponents,
} from "./accounting/postingEngine";
import { paymentAssetRole } from "./sale/paymentPosting";
import {
  expenseAccrualReversal,
  expenseAccrualSettlement,
  type AccruableExpenseRole,
} from "./accounting/accrualPosting";

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

export function expenseRole(category: ExpenseCategory): AccountRole {
  switch (category) {
    case "RENT":
      return "RENT";
    case "UTILITIES":
      return "UTILITIES";
    case "SALARY":
      return "SALARIES";
    case "OTHER":
      return "OTHER_EXPENSE";
    default:
      return "OPERATING_EXPENSE";
  }
}

export function cashExpensePostingSourceComponents(
  category: ExpenseCategory,
  paymentMethod: ExpensePaymentMethod,
  amount: ReturnType<typeof money>,
  reverse = false,
  cashBucket: "DRAWER" | "TREASURY" | null = null,
): PostingSourceComponents {
  // A compensating PAYMENT_IN reverses the exact asset credited by the original
  // outgoing instrument. In particular, an issued cheque is CARD_BANK (not a
  // newly received CHECKS_RECEIVABLE), and WALLET remains PAYMENT_WALLET.
  const assetRole = paymentAssetRole(paymentMethod, cashBucket, "OUT");
  const expenseAccount = expenseRole(category);
  const sourceAmount = round2(amount.abs());
  return reverse
    ? {
        roleDebits: { [assetRole]: sourceAmount },
        roleCredits: { [expenseAccount]: sourceAmount },
      }
    : {
        roleDebits: { [expenseAccount]: sourceAmount },
        roleCredits: { [assetRole]: sourceAmount },
      };
}

export function cashExpensePostingIntent(
  category: ExpenseCategory,
  paymentMethod: ExpensePaymentMethod,
  amount: ReturnType<typeof money>,
  reverse = false,
  cashBucket: "DRAWER" | "TREASURY" | null = null,
): PostingIntent {
  const assetRole = paymentAssetRole(paymentMethod, cashBucket, "OUT");
  const entryType = reverse ? "PAYMENT_IN" : "PAYMENT_OUT";
  const sourceComponents = cashExpensePostingSourceComponents(
    category,
    paymentMethod,
    amount,
    reverse,
    cashBucket,
  );
  return createPostingIntent(
    reverse
      ? "PAYMENT_IN_OTHER"
      : category === "SALARY"
        ? "PAYMENT_OUT_SALARY"
        : "PAYMENT_OUT_EXPENSE",
    entryType,
    signedPostingLines(
      expenseRole(category),
      assetRole,
      reverse ? amount.neg() : amount,
    ),
    sourceComponents,
  );
}

export type RecurringFrequency =
  | "DAILY"
  | "WEEKLY"
  | "MONTHLY"
  | "QUARTERLY"
  | "YEARLY";

/** production-slice: مصدر الصرف. CASH=نقدي (الموجود)؛ STOCK=صرف من المخزون بالكلفة (نثرية/تلف). */
export type ExpenseSource = "CASH" | "STOCK" | "ACCRUAL";
export type ExpenseStockReason = "INTERNAL_USE" | "WASTAGE";
export type ExpenseCashSource = "OWN_DRAWER" | "TREASURY";
export type ExpenseFundingKind =
  | "DRAWER"
  | "TREASURY"
  | "NON_CASH"
  | "STOCK"
  | "ACCRUED_UNPAID"
  | "ACCRUED_PAID"
  | "UNKNOWN";

/**
 * حدّ النثرية النقدية الذي قرّره المالك. المبلغ الأصغر فقط يستطيع أن يخرج فوراً
 * من درج مُنشئ المصروف؛ الحد نفسه وما فوقه طلب اعتماد خزينة بلا أثر مالي حتى الاعتماد.
 */
export const PETTY_CASH_LIMIT_IQD = money("500000");

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

function requiresExpenseApproval(
  input: CreateExpenseInput,
  amount: ReturnType<typeof money>,
): boolean {
  return (
    input.paymentMethod !== "CASH" ||
    amount.gte(PETTY_CASH_LIMIT_IQD) ||
    input.cashSource === "TREASURY"
  );
}

function assertExpenseFundingInput(input: CreateExpenseInput) {
  if (input.source === "ACCRUAL") {
    throw new TRPCError({ code: "FORBIDDEN", message: "مصدر ACCRUAL محجوز لمنتجي الاستحقاق النظاميين" });
  }
  if (
    input.cashSource &&
    ((input.source ?? "CASH") === "STOCK" || input.paymentMethod !== "CASH")
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "مصدر النقد يُحدَّد للمصروف المالي النقدي فقط",
    });
  }
}

function assertStockExpenseAuthority(actor: Actor) {
  if (actor.role !== "admin" && actor.role !== "manager") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "صرف المخزون كمصروف يتطلب صلاحية مدير مخزون/مدير",
    });
  }
}

/** حمولة قانونية تربط مفتاح إعادة المحاولة بالعملية المالية نفسها وبمنشئها. */
function expenseCreatePayloadHash(input: CreateExpenseInput, actor: Actor) {
  const source = input.source ?? "CASH";
  const shared = {
    actorUserId: actor.userId,
    branchId: input.branchId,
    // غياب التاريخ جزءٌ ثابت من نية الطلب؛ الإعادة بعد منتصف الليل تعيد المستند الأول
    // ولا تتحول إلى حمولة مختلفة بسبب الساعة. تاريخ التنفيذ الفعلي يُحسم مرة واحدة أدناه.
    expenseDate: input.expenseDate?.trim() || null,
    category: input.category,
    paymentMethod: input.paymentMethod,
    source,
    description: input.description?.trim() || null,
    referenceNumber: input.referenceNumber?.trim() || null,
    payee: input.payee?.trim() || null,
    costCenter: input.costCenter?.trim() || null,
  };
  if (source === "STOCK") {
    const items = (input.items ?? [])
      .map((item) => {
        const usesUnit = item.productUnitId != null && item.quantity != null;
        const quantity = usesUnit ? money(item.quantity) : null;
        if (quantity && quantity.decimalPlaces() > 4) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "كمية صرف المخزون تقبل أربعة منازل عشرية كحد أقصى",
          });
        }
        return {
          variantId: item.variantId,
          productUnitId: item.productUnitId ?? null,
          quantity: quantity?.toFixed(4) ?? null,
          baseQuantity: usesUnit ? null : (item.baseQuantity ?? null),
        };
      })
      .sort(
        (a, b) =>
          a.variantId - b.variantId ||
          Number(a.productUnitId ?? 0) - Number(b.productUnitId ?? 0) ||
          String(a.quantity ?? "").localeCompare(String(b.quantity ?? "")) ||
          Number(a.baseQuantity ?? 0) - Number(b.baseQuantity ?? 0),
      );
    return idempotencyHash({
      ...shared,
      stockReason: input.stockReason ?? null,
      items,
    });
  }
  return idempotencyHash({
    ...shared,
    amount: toDbMoney(input.amount),
    shiftId: input.shiftId ?? null,
    cashSource:
      input.paymentMethod === "CASH"
        ? (input.cashSource ?? "OWN_DRAWER")
        : null,
    isRecurring: input.isRecurring === true,
    recurringFrequency:
      input.isRecurring === true ? (input.recurringFrequency ?? null) : null,
  });
}

async function loadExpenseReplay(tx: any, replayId: number) {
  const ex = (
    await tx
      .select({ receiptId: expenses.receiptId, status: expenses.status })
      .from(expenses)
      .where(eq(expenses.id, replayId))
      .limit(1)
  )[0];
  if (!ex) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "معرّف إعادة المحاولة يشير إلى مصروف مفقود؛ لم تُنفذ عملية جديدة ويحتاج السجل مراجعة تدقيقية",
    });
  }
  return {
    expenseId: replayId,
    receiptId: ex.receiptId ? Number(ex.receiptId) : null,
    status: ex.status,
    requiresApproval: ex.status === "PENDING_APPROVAL",
    idempotent: true,
  };
}

async function lockOwnRetailShift(
  tx: any,
  input: CreateExpenseInput,
  actor: Actor,
): Promise<number> {
  const conds = [
    eq(shifts.userId, actor.userId),
    eq(shifts.branchId, input.branchId),
    eq(shifts.status, "OPEN"),
    eq(shifts.shiftType, "RETAIL"),
  ];
  if (input.shiftId != null) conds.push(eq(shifts.id, input.shiftId));

  const shift = (
    await tx
      .select({
        id: shifts.id,
        branchId: shifts.branchId,
        userId: shifts.userId,
        status: shifts.status,
      })
      .from(shifts)
      .where(and(...conds))
      .for("update")
      .limit(1)
  )[0];
  if (!shift) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "المصروف النقدي الصغير يُصرف من درج وردية المُنشئ فقط؛ افتح وردية مبيعات ممولة أولاً.",
    });
  }
  return Number(shift.id);
}

async function insertExpenseAudit(
  tx: any,
  actor: Actor,
  expenseId: number,
  branchId: number,
  action: string,
  oldValue: unknown,
  newValue: unknown,
) {
  await tx.insert(auditLogs).values({
    userId: actor.userId,
    branchId,
    action,
    entityType: "expense",
    entityId: String(expenseId),
    oldValue,
    newValue,
  });
}

/** صرف من المخزون (نثرية/تلف): يُخصَم بالكلفة عبر applyMovement + قيد INTERNAL_USE/WASTAGE — بلا receipt ولا صندوق. */
async function createStockExpenseTx(
  tx: any,
  input: CreateExpenseInput,
  actor: Actor,
  payloadHash: string,
  resolvedExpenseDate: string,
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

  const expDate = resolvedExpenseDate;

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
      payloadHash,
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
    postingIntent: createPostingIntent(
      stockReason === "WASTAGE"
        ? "WASTAGE_INVENTORY"
        : "INTERNAL_USE_INVENTORY",
      stockReason,
      signedPostingLines(
        stockReason === "WASTAGE" ? "LOSSES" : "OPERATING_EXPENSE",
        "INVENTORY",
        amount,
      ),
    ),
    dedupeKey: `${stockReason}:${expenseId}`,
    entryDate: new Date(expDate),
    notes: `${stockReason === "WASTAGE" ? "تلف/هدر" : "نثرية داخلية"}${input.description?.trim() ? ": " + input.description.trim() : ""}`,
    createdBy: actor.userId,
  });

  return { expenseId, receiptId: null };
}

/** Record a daily expense: CASH ⇒ receipt(OUT)+PAYMENT_OUT ; STOCK ⇒ صرف مخزون بالكلفة (نثرية/تلف، بلا صندوق). */
export async function createExpense(input: CreateExpenseInput, actor: Actor) {
  // تُفحص العلاقات البنيوية قبل الـhash/replay حتى لا يخفي مفتاح قديم طلباً غير صالح.
  assertExpenseFundingInput(input);
  // G4: CASH/STOCK منفصلان، والـhash يشمل المنشئ وكل الحقول المؤثرة.
  const opKey =
    (input.source ?? "CASH") === "STOCK"
      ? "expense.create.STOCK"
      : "expense.create.CASH";
  const payloadHash = expenseCreatePayloadHash(input, actor);
  const resolvedExpenseDate = input.expenseDate?.trim() || toDateStr();
  try {
    return await withTx(async (tx) => {
      const replayId = await checkIdempotency(
        tx,
        opKey,
        input.clientRequestId,
        payloadHash,
        { requireStoredHash: true },
      );
      if (replayId) return loadExpenseReplay(tx, replayId);

      const b = (
        await tx
          .select({ id: branches.id })
          .from(branches)
          .where(eq(branches.id, input.branchId))
          .limit(1)
      )[0];
      if (!b)
        throw new TRPCError({ code: "NOT_FOUND", message: "الفرع غير موجود" });

      // production-slice: صرف من المخزون (نثرية/تلف) — مسار منفصل لا يلمس الصندوق النقدي.
      if ((input.source ?? "CASH") === "STOCK") {
        assertStockExpenseAuthority(actor);
        return await createStockExpenseTx(
          tx,
          input,
          actor,
          payloadHash,
          resolvedExpenseDate,
        );
      }

      // طبّع إلى دقّة قاعدة البيانات قبل قرار الحدّ؛ 499999.995 تُخزّن 500000.00
      // ولذلك يجب أن تمرّ بدورة الاعتماد لا أن تُصرف فورياً من الدرج.
      const amt = round2(money(input.amount));
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

      const expDate = resolvedExpenseDate;
      const isRecurring = !!input.isRecurring;
      if (isRecurring && !input.recurringFrequency)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "حدّد دورية التكرار",
        });

      const pendingApproval = requiresExpenseApproval(input, amt);
      let effectiveShiftId: number | null = null;
      let cashBucket: "DRAWER" | "TREASURY" | null = null;

      // لا يوجد سقوط إداري إلى الخزينة: الصرف النقدي الفوري نثريةٌ من درج المُنشئ وحده.
      // أمّا طلب الاعتماد فيبقى بلا bucket/shift حتى يعتمد مالك آخر فيُنفّذ من الخزينة.
      if (!pendingApproval && input.paymentMethod === "CASH") {
        effectiveShiftId = await lockOwnRetailShift(tx, input, actor);
        cashBucket = "DRAWER";
        await assertCashOutAvailable(tx, {
          branchId: input.branchId,
          cashBucket: "DRAWER",
          shiftId: effectiveShiftId,
          amount: amt,
          operation: "تسجيل المصروف النقدي الصغير",
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
        status: pendingApproval ? "PENDING" : "COMPLETED",
        approvalStatus: pendingApproval ? "PENDING_APPROVAL" : "APPROVED",
        createdBy: actor.userId,
      });
      const receiptId = extractInsertId(rRes);

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
        status: pendingApproval ? "PENDING_APPROVAL" : "ACTIVE",
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
          payloadHash,
        );

      if (!pendingApproval) {
        const postingSourceComponents = cashExpensePostingSourceComponents(
          input.category,
          input.paymentMethod,
          amt,
          false,
          cashBucket,
        );
        await postEntry(tx, {
          entryType: "PAYMENT_OUT",
          branchId: input.branchId,
          receiptId,
          amount: amt,
          paymentMethod: input.paymentMethod,
          postingIntent: cashExpensePostingIntent(
            input.category,
            input.paymentMethod,
            amt,
            false,
            cashBucket,
          ),
          postingSourceComponents,
          entryDate: new Date(expDate),
          notes: `مصروف (${input.category})${input.description?.trim() ? ": " + input.description.trim() : ""}`,
          createdBy: actor.userId,
        });
      }

      return {
        expenseId,
        receiptId,
        status: pendingApproval ? "PENDING_APPROVAL" : "ACTIVE",
        requiresApproval: pendingApproval,
      };
    });
  } catch (error) {
    if (!input.clientRequestId) throw error;
    // المكرر النقدي قد ينتظر قفل الدرج حتى يصرف الأول الرصيد، فيرى حارس السيولة قبل
    // INSERT المفتاح. القراءة الجديدة بعد rollback تحوّله إلى replay إن كان الأول قد التزم.
    const replay = await withTx(async (tx) => {
      const replayId = await checkIdempotency(
        tx,
        opKey,
        input.clientRequestId,
        payloadHash,
        { requireStoredHash: true },
      );
      return replayId ? loadExpenseReplay(tx, replayId) : null;
    });
    if (replay) return replay;
    throw error;
  }
}

async function lockActiveOwner(tx: any, actor: Actor) {
  const owner = (
    await tx
      .select({
        id: users.id,
        isActive: users.isActive,
        isOwner: users.isOwner,
      })
      .from(users)
      .where(eq(users.id, actor.userId))
      // قفل SHARE يمنع تعطيل المالك حتى نهاية القرار، ويبقى متوافقاً مع قفل FK
      // الذي تأخذه إيصالات نقدية أخرى على users؛ قفل X هنا يصنع user↔source deadlock.
      .for("share")
      .limit(1)
  )[0];
  if (!owner || owner.isActive !== true || owner.isOwner !== true) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "اعتماد المصروف أو رفضه يتطلب حساب مالك نشطاً",
    });
  }
  return owner;
}

function assertPendingExpenseReceipt(exp: any, receipt: any) {
  const valid =
    receipt &&
    receipt.direction === "OUT" &&
    receipt.status === "PENDING" &&
    receipt.approvalStatus === "PENDING_APPROVAL" &&
    receipt.cashBucket == null &&
    receipt.shiftId == null &&
    receipt.invoiceId == null &&
    receipt.workOrderId == null &&
    receipt.reservationId == null &&
    receipt.voucherNumber == null &&
    Number(receipt.branchId) === Number(exp.branchId) &&
    money(receipt.amount).eq(money(exp.amount)) &&
    receipt.paymentMethod === exp.paymentMethod &&
    receipt.createdBy != null &&
    exp.createdBy != null &&
    Number(receipt.createdBy) === Number(exp.createdBy);
  if (!valid) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "طلب المصروف لا يطابق إيصال الاعتماد المعلّق؛ لم يُنفّذ أي أثر مالي ويحتاج مراجعة تدقيقية.",
    });
  }
}

/**
 * ترتيب الأقفال النقدية ثابت على مستوى النظام: مصدر النقد (فرع الخزينة/الوردية)
 * ثم مستند المصروف ثم الإيصال. القراءة الأولى مجرد hint؛ كل قرار أعمال يُعاد بعد
 * قفل صف المصروف نفسه.
 */
async function lockExpenseCashSourceBeforeDocument(
  tx: any,
  expenseId: number,
  operation: "APPROVE" | "CANCEL",
) {
  const hint = (
    await tx
      .select({
        branchId: expenses.branchId,
        shiftId: expenses.shiftId,
        cashBucket: expenses.cashBucket,
        paymentMethod: expenses.paymentMethod,
      })
      .from(expenses)
      .where(eq(expenses.id, expenseId))
      .limit(1)
  )[0];
  if (!hint) return;

  const locksTreasury =
    hint.cashBucket === "TREASURY" ||
    (operation === "APPROVE" && hint.paymentMethod === "CASH");
  if (locksTreasury) {
    await tx
      .select({ id: branches.id })
      .from(branches)
      .where(eq(branches.id, Number(hint.branchId)))
      .for("update")
      .limit(1);
    return;
  }

  if (hint.shiftId != null) {
    await tx
      .select({ id: shifts.id })
      .from(shifts)
      .where(eq(shifts.id, Number(hint.shiftId)))
      .for("update")
      .limit(1);
  }
}

/** اعتماد وتنفيذ ذريّ: مالك نشط غير المُنشئ، والخزينة هي مصدر CASH الوحيد. */
export async function approveExpense(expenseId: number, actor: Actor) {
  return withTx(async (tx) => {
    await lockActiveOwner(tx, actor);
    await lockExpenseCashSourceBeforeDocument(tx, expenseId, "APPROVE");
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
    if (Number(exp.createdBy) === Number(actor.userId)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "لا يجوز لمن أنشأ طلب المصروف أن يعتمد طلبه بنفسه",
      });
    }
    if (exp.status === "ACTIVE") {
      const completedReceipt =
        exp.receiptId == null
          ? null
          : (
              await tx
                .select({
                  status: receipts.status,
                  approvalStatus: receipts.approvalStatus,
                  approvedBy: receipts.approvedBy,
                })
                .from(receipts)
                .where(eq(receipts.id, Number(exp.receiptId)))
                .for("update")
                .limit(1)
            )[0];
      if (
        !completedReceipt ||
        completedReceipt.status !== "COMPLETED" ||
        completedReceipt.approvalStatus !== "APPROVED" ||
        completedReceipt.approvedBy == null
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "المصروف نافذ أصلاً ولم ينشأ من دورة اعتماد معلّقة",
        });
      }
      return {
        expenseId,
        receiptId: exp.receiptId == null ? null : Number(exp.receiptId),
        status: "ACTIVE" as const,
        idempotent: true,
      };
    }
    if (exp.status !== "PENDING_APPROVAL") {
      throw new TRPCError({
        code: "CONFLICT",
        message: "لا يمكن اعتماد طلب مصروف غير معلّق",
      });
    }
    if (
      exp.source === "STOCK" ||
      exp.source === "ACCRUAL" ||
      exp.paymentMethod === "ACCRUAL" ||
      exp.receiptId == null
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "طلب المصروف المعلّق لا يملك مساراً مالياً صالحاً",
      });
    }

    const receipt = (
      await tx
        .select()
        .from(receipts)
        .where(eq(receipts.id, Number(exp.receiptId)))
        .for("update")
        .limit(1)
    )[0];
    assertPendingExpenseReceipt(exp, receipt);

    const cashBucket = exp.paymentMethod === "CASH" ? "TREASURY" : null;
    if (cashBucket === "TREASURY") {
      await assertCashOutAvailable(tx, {
        branchId: Number(exp.branchId),
        cashBucket,
        shiftId: null,
        amount: exp.amount,
        operation: "اعتماد وصرف المصروف من الخزينة",
      });
    }

    await tx
      .update(receipts)
      .set({
        shiftId: null,
        cashBucket,
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        approvedBy: actor.userId,
        approvedAt: new Date(),
      })
      .where(
        and(
          eq(receipts.id, Number(exp.receiptId)),
          eq(receipts.status, "PENDING"),
          eq(receipts.approvalStatus, "PENDING_APPROVAL"),
        ),
      );
    await tx
      .update(expenses)
      .set({
        shiftId: null,
        cashBucket,
        status: "ACTIVE",
      })
      .where(
        and(
          eq(expenses.id, expenseId),
          eq(expenses.status, "PENDING_APPROVAL"),
        ),
      );

    const postingSourceComponents = cashExpensePostingSourceComponents(
      exp.category,
      exp.paymentMethod,
      money(exp.amount),
      false,
      cashBucket,
    );
    await postEntry(tx, {
      entryType: "PAYMENT_OUT",
      branchId: Number(exp.branchId),
      receiptId: Number(exp.receiptId),
      amount: money(exp.amount),
      paymentMethod: exp.paymentMethod,
      postingIntent: cashExpensePostingIntent(
        exp.category,
        exp.paymentMethod,
        money(exp.amount),
        false,
        cashBucket,
      ),
      postingSourceComponents,
      entryDate: new Date(exp.expenseDate),
      notes: `مصروف معتمد (${exp.category})${exp.description?.trim() ? ": " + exp.description.trim() : ""}`,
      createdBy: actor.userId,
    });
    await insertExpenseAudit(
      tx,
      actor,
      expenseId,
      Number(exp.branchId),
      "expense.approveDisburse",
      { status: "PENDING_APPROVAL", cashBucket: null },
      {
        status: "ACTIVE",
        cashBucket,
        receiptId: Number(exp.receiptId),
        approvedBy: actor.userId,
      },
    );

    return {
      expenseId,
      receiptId: Number(exp.receiptId),
      status: "ACTIVE" as const,
      idempotent: false,
    };
  });
}

/** رفض ذريّ بلا صرف ولا قيد؛ يحتفظ بالسجلّ والأثر التدقيقي. */
export async function rejectExpense(
  expenseId: number,
  actor: Actor,
  rejectionReason: string,
) {
  return withTx(async (tx) => {
    const reason = rejectionReason.trim();
    if (reason.length < 3 || reason.length > 1000) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "سبب الرفض إلزامي وواضح (من 3 إلى 1000 حرف)",
      });
    }
    await lockActiveOwner(tx, actor);
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
    if (Number(exp.createdBy) === Number(actor.userId)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "لا يجوز لمن أنشأ طلب المصروف أن يرفض طلبه بنفسه",
      });
    }
    if (exp.status === "REJECTED") {
      const rejectedReceipt =
        exp.receiptId == null
          ? null
          : (
              await tx
                .select({
                  status: receipts.status,
                  approvalStatus: receipts.approvalStatus,
                  approvedBy: receipts.approvedBy,
                })
                .from(receipts)
                .where(eq(receipts.id, Number(exp.receiptId)))
                .for("update")
                .limit(1)
            )[0];
      if (
        !rejectedReceipt ||
        rejectedReceipt.status !== "FAILED" ||
        rejectedReceipt.approvalStatus !== "REJECTED" ||
        rejectedReceipt.approvedBy == null
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "المصروف مرفوض لكن أثر رفضه غير مكتمل ويحتاج مراجعة تدقيقية",
        });
      }
      return {
        expenseId,
        receiptId: exp.receiptId == null ? null : Number(exp.receiptId),
        status: "REJECTED" as const,
        idempotent: true,
      };
    }
    if (exp.status !== "PENDING_APPROVAL" || exp.receiptId == null) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "لا يمكن رفض طلب مصروف غير معلّق",
      });
    }
    const receipt = (
      await tx
        .select()
        .from(receipts)
        .where(eq(receipts.id, Number(exp.receiptId)))
        .for("update")
        .limit(1)
    )[0];
    assertPendingExpenseReceipt(exp, receipt);

    await tx
      .update(receipts)
      .set({
        status: "FAILED",
        approvalStatus: "REJECTED",
        approvedBy: actor.userId,
        approvedAt: new Date(),
      })
      .where(
        and(
          eq(receipts.id, Number(exp.receiptId)),
          eq(receipts.status, "PENDING"),
          eq(receipts.approvalStatus, "PENDING_APPROVAL"),
        ),
      );
    await tx
      .update(expenses)
      .set({ status: "REJECTED" })
      .where(
        and(
          eq(expenses.id, expenseId),
          eq(expenses.status, "PENDING_APPROVAL"),
        ),
      );
    await insertExpenseAudit(
      tx,
      actor,
      expenseId,
      Number(exp.branchId),
      "expense.reject",
      { status: "PENDING_APPROVAL" },
      { status: "REJECTED", rejectedBy: actor.userId, rejectionReason: reason },
    );
    return {
      expenseId,
      receiptId: Number(exp.receiptId),
      status: "REJECTED" as const,
      idempotent: false,
    };
  });
}

type RecognizedSystemExpenseRequest = Extract<
  NonNullable<ReturnType<typeof parseSystemPaymentRequest>>,
  { kind: "PURCHASE_SHIPPING" | "ASSET_MAINTENANCE" }
>;

async function assertSystemExpenseResubmissionChain(
  tx: Tx,
  exp: typeof expenses.$inferSelect,
  receipt: typeof receipts.$inferSelect,
) {
  if (exp.createdBy == null || receipt.createdBy == null) {
    throw new TRPCError({ code: "CONFLICT", message: "منشئ طلب دفع المصروف مفقود" });
  }
  const links = await tx
    .select({ clientRequestId: idempotencyKeys.clientRequestId })
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.operation, "voucher.create"),
        eq(idempotencyKeys.refId, Number(receipt.id)),
        sql`${idempotencyKeys.clientRequestId} REGEXP ${"^system-expense-resubmit-[1-9][0-9]*-A[1-9][0-9]*$"}`,
      ),
    )
    .for("update")
    .limit(2);
  if (links.length === 0 && Number(exp.createdBy) === Number(receipt.createdBy)) return;
  if (links.length !== 1) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "منشئ طلب دفع المصروف تغيّر بلا سلسلة إعادة تقديم نظامية وحيدة",
    });
  }
  const lineage = parseExpensePaymentResubmitKey(links[0].clientRequestId);
  if (!lineage || lineage.family !== "expense") {
    throw new TRPCError({ code: "CONFLICT", message: "مرجع إعادة تقديم دفع المصروف غير صالح" });
  }
  let parentReceiptId = lineage.rootReceiptId;
  if (lineage.attempt > 1) {
    const [priorKey] = await tx
      .select({ refId: idempotencyKeys.refId })
      .from(idempotencyKeys)
      .where(and(
        eq(idempotencyKeys.operation, "voucher.create"),
        eq(idempotencyKeys.clientRequestId, expensePaymentResubmitKey({
          ...lineage,
          attempt: lineage.attempt - 1,
        })),
      ))
      .for("update")
      .limit(1);
    parentReceiptId = priorKey == null ? 0 : Number(priorKey.refId);
  }
  const descriptionLineage = parseExpensePaymentResubmitDescription(receipt.description);
  if (!Number.isSafeInteger(parentReceiptId) || parentReceiptId <= 0 || parentReceiptId === Number(receipt.id)) {
    throw new TRPCError({ code: "CONFLICT", message: "مرجع إعادة تقديم دفع المصروف غير صالح" });
  }
  const [parent] = await tx
    .select()
    .from(receipts)
    .where(eq(receipts.id, parentReceiptId))
    .for("update")
    .limit(1);
  if (
    !parent ||
    !descriptionLineage ||
    descriptionLineage.attempt !== lineage.attempt ||
    descriptionLineage.priorReceiptId !== parentReceiptId ||
    parent.direction !== "OUT" ||
    parent.status !== "FAILED" ||
    parent.approvalStatus !== "REJECTED" ||
    parent.approvedBy == null ||
    parent.approvedAt == null ||
    parent.createdBy == null ||
    Number(parent.createdBy) !== Number(exp.createdBy) ||
    Number(parent.approvedBy) === Number(parent.createdBy) ||
    parent.signatureHash != null ||
    parent.shiftId != null ||
    parent.cashBucket != null ||
    Number(parent.branchId) !== Number(receipt.branchId) ||
    parent.paymentMethod !== receipt.paymentMethod ||
    !money(parent.amount).eq(money(receipt.amount)) ||
    (parent.referenceNumber ?? null) !== (receipt.referenceNumber ?? null) ||
    (parent.internalNote ?? null) !== (receipt.internalNote ?? null) ||
    (parent.partyType ?? null) !== (receipt.partyType ?? null) ||
    (parent.partyId == null ? null : Number(parent.partyId)) !==
      (receipt.partyId == null ? null : Number(receipt.partyId))
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "سلسلة إعادة تقديم دفع المصروف مفقودة أو لا تطابق الطلب المرفوض",
    });
  }
}

/**
 * Validates the authoritative source behind a recognized system expense, whether
 * its clearing receipt is still unsettled or was genuinely materialized.
 * This is deliberately stricter than trusting the JSON note: the note, source row,
 * expense, receipt and accrual must all describe the same operation.
 */
async function assertRecognizedExpenseSource(
  tx: Tx,
  exp: typeof expenses.$inferSelect,
  receipt: typeof receipts.$inferSelect,
  settlementState: "UNSETTLED" | "MATERIALIZED" = "UNSETTLED",
): Promise<{
  accrualPurchaseOrderId: number | null;
  accrualDedupe: string;
  expenseRole: AccruableExpenseRole;
}> {
  const expectedExpenseCashBucket =
    receipt.paymentMethod === "CASH" ? "TREASURY" : null;
  const unsettledStateIsValid =
    receipt.shiftId == null &&
    receipt.cashBucket == null &&
    (
      (receipt.status === "PENDING" && receipt.approvalStatus === "PENDING_APPROVAL") ||
      (receipt.status === "FAILED" && receipt.approvalStatus === "REJECTED")
    );
  const materializedStateIsValid =
    receipt.status === "COMPLETED" &&
    receipt.approvalStatus === "APPROVED" &&
    receipt.shiftId == null &&
    receipt.cashBucket === expectedExpenseCashBucket &&
    receipt.approvedBy != null &&
    receipt.approvedAt != null &&
    receipt.createdBy != null &&
    Number(receipt.approvedBy) !== Number(receipt.createdBy) &&
    receipt.voucherNumber != null &&
    receipt.voucherDate != null &&
    receipt.signatureHash != null;
  if (
    exp.status !== "ACTIVE" ||
    exp.source !== "CASH" ||
    exp.shiftId != null ||
    exp.cashBucket !== expectedExpenseCashBucket ||
    exp.paymentMethod !== receipt.paymentMethod ||
    receipt.direction !== "OUT" ||
    receipt.partyType !== "OTHER" ||
    receipt.partyId != null ||
    receipt.invoiceId != null ||
    receipt.workOrderId != null ||
    receipt.reservationId != null ||
    (exp.referenceNumber ?? null) !== (receipt.referenceNumber ?? null) ||
    (settlementState === "UNSETTLED" ? !unsettledStateIsValid : !materializedStateIsValid)
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "حالة استحقاق المصروف غير المدفوع لا تطابق عقد الإلغاء النظامي",
    });
  }

  if (settlementState === "MATERIALIZED") {
    const expectedSignature = computeSignature({
      id: Number(receipt.id),
      amount: toDbMoney(receipt.amount),
      partyType: "OTHER",
      partyId: null,
      paymentMethod: receipt.paymentMethod,
      voucherDate: String(receipt.voucherDate).slice(0, 10),
      voucherNumber: String(receipt.voucherNumber),
      createdBy: Number(receipt.createdBy),
      approvedBy: Number(receipt.approvedBy),
      branchId: Number(receipt.branchId),
    });
    if (receipt.signatureHash !== expectedSignature) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "بصمة اعتماد دفع المصروف المنفذ مفقودة أو لا تطابق السند",
      });
    }
  }

  const request = parseSystemPaymentRequest(receipt.internalNote) as RecognizedSystemExpenseRequest | null;
  if (request?.kind !== "PURCHASE_SHIPPING" && request?.kind !== "ASSET_MAINTENANCE") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "طلب دفع المصروف غير المنفذ لا يحمل مرجع مصدر نظامياً صالحاً",
    });
  }
  await assertSystemExpenseResubmissionChain(tx, exp, receipt);

  let accrualDedupe: string;
  let expectedPurchaseOrderId: number | null;
  if (request.kind === "PURCHASE_SHIPPING") {
    const expectedPaymentReference =
      receipt.paymentMethod === "CARD"
        ? receipt.cardLastFour
        : receipt.paymentMethod === "TRANSFER" ||
            receipt.paymentMethod === "CHECK"
          ? receipt.checkNumber
          : null;
    if (
      !Number.isSafeInteger(request.purchaseOrderId) ||
      request.purchaseOrderId <= 0 ||
      !/^[0-9a-f]{16}$/i.test(request.requestToken) ||
      typeof request.expectedAmount !== "string" ||
      typeof request.sourceShippingTotal !== "string" ||
      (request.paymentReference ?? null) !==
        (expectedPaymentReference ?? null) ||
      !money(request.expectedAmount).eq(money(exp.amount))
    ) {
      throw new TRPCError({ code: "CONFLICT", message: "بيانات مصدر مصروف الشحن غير صالحة" });
    }
    const [purchaseOrder] = await tx
      .select()
      .from(purchaseOrders)
      .where(eq(purchaseOrders.id, request.purchaseOrderId))
      .for("update")
      .limit(1);
    if (
      !purchaseOrder ||
      Number(purchaseOrder.branchId) !== Number(exp.branchId) ||
      exp.category !== "TRANSPORT" ||
      receipt.referenceNumber !== `SHIP-${purchaseOrder.poNumber}-${request.requestToken}` ||
      !money(purchaseOrder.shippingCost)
        .plus(money(purchaseOrder.customsCost))
        .eq(money(request.sourceShippingTotal))
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "مصدر الشحن أو الفرع أو المبلغ لا يطابق المصروف المعترف به",
      });
    }
    accrualDedupe = `PURCHASE_SHIPPING_ACCRUAL:${request.purchaseOrderId}:${request.requestToken}`;
    expectedPurchaseOrderId = request.purchaseOrderId;
  } else {
    if (
      !Number.isSafeInteger(request.assetId) ||
      request.assetId <= 0 ||
      !Number.isSafeInteger(request.maintenanceId) ||
      request.maintenanceId <= 0
    ) {
      throw new TRPCError({ code: "CONFLICT", message: "بيانات مصدر مصروف الصيانة غير صالحة" });
    }
    const [maintenance] = await tx
      .select()
      .from(assetMaintenance)
      .where(eq(assetMaintenance.id, request.maintenanceId))
      .for("update")
      .limit(1);
    const [asset] = await tx
      .select()
      .from(fixedAssets)
      .where(eq(fixedAssets.id, request.assetId))
      .for("update")
      .limit(1);
    if (
      !maintenance ||
      !asset ||
      Number(maintenance.assetId) !== request.assetId ||
      Number(asset.branchId) !== Number(exp.branchId) ||
      exp.category !== "MAINTENANCE" ||
      receipt.referenceNumber !== `ASSET-MAINT-${request.maintenanceId}` ||
      !money(maintenance.cost).eq(money(exp.amount))
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "سجل الصيانة أو الأصل أو الفرع أو المبلغ لا يطابق المصروف المعترف به",
      });
    }
    accrualDedupe = `ASSET_MAINT_ACCRUAL:${request.maintenanceId}`;
    expectedPurchaseOrderId = null;
  }

  const accruals = await tx
    .select({
      entryType: accountingEntries.entryType,
      branchId: accountingEntries.branchId,
      purchaseOrderId: accountingEntries.purchaseOrderId,
      receiptId: accountingEntries.receiptId,
      amount: accountingEntries.amount,
      postingProfile: accountingEntries.postingProfile,
    })
    .from(accountingEntries)
    .where(eq(accountingEntries.dedupeKey, accrualDedupe))
    .for("update")
    .limit(2);
  const accrual = accruals[0];
  if (
    accruals.length !== 1 ||
    !accrual ||
    accrual.entryType !== "ADJUST" ||
    accrual.receiptId != null ||
    Number(accrual.branchId) !== Number(exp.branchId) ||
    Number(accrual.purchaseOrderId ?? 0) !== Number(expectedPurchaseOrderId ?? 0) ||
    !money(accrual.amount).eq(money(exp.amount)) ||
    (accrual.postingProfile != null &&
      accrual.postingProfile !== "ADJUST_EXPENSE_ACCRUAL")
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "قيد استحقاق المصروف مفقود أو لا يطابق مصدره الحقيقي",
    });
  }
  if (settlementState === "MATERIALIZED") {
    const settlements = await tx
      .select({
        entryType: accountingEntries.entryType,
        branchId: accountingEntries.branchId,
        purchaseOrderId: accountingEntries.purchaseOrderId,
        amount: accountingEntries.amount,
        postingProfile: accountingEntries.postingProfile,
      })
      .from(accountingEntries)
      .where(eq(accountingEntries.receiptId, Number(receipt.id)))
      .for("update")
      .limit(2);
    const settlement = settlements[0];
    if (
      settlements.length !== 1 ||
      !settlement ||
      settlement.entryType !== "PAYMENT_OUT" ||
      Number(settlement.branchId) !== Number(exp.branchId) ||
      Number(settlement.purchaseOrderId ?? 0) !==
        Number(expectedPurchaseOrderId ?? 0) ||
      !money(settlement.amount).eq(money(exp.amount)) ||
      (settlement.postingProfile != null &&
        settlement.postingProfile !==
          "PAYMENT_OUT_ACCRUED_EXPENSE_SETTLEMENT")
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "قيد تسوية المصروف المنفذ مفقود أو لا يطابق الاستحقاق",
      });
    }
  }
  return {
    accrualPurchaseOrderId: expectedPurchaseOrderId,
    accrualDedupe,
    expenseRole: "OPERATING_EXPENSE",
  };
}

/**
 * Cancel an active expense. Only allowed when the linked shift (if any) is still OPEN.
 * Marks the linked ordinary payment receipt REVERSED and records its matching reversal.
 * Accrued shipping/maintenance is deliberately rejected before any cash/receipt write:
 * its canonical source-correction workflow owns recognition reversal and any proven refund.
 */
export async function cancelExpense(expenseId: number, actor: Actor) {
  return withTx(async (tx) => {
    // معاينة غير سلطوية لتحديد mutex النقد ثم ترتيب الأقفال الحاكم:
    // source → receipt → expense. approveVoucher يتبع الترتيب نفسه، فتفشل إعادة
    // التحقق بدلاً من تكوين دورة receipt↔expense عند سباق الإلغاء مع الاعتماد.
    const [expensePreview] = await tx
      .select()
      .from(expenses)
      .where(eq(expenses.id, expenseId))
      .limit(1);
    if (!expensePreview)
      throw new TRPCError({ code: "NOT_FOUND", message: "المصروف غير موجود" });

    const [linkedAccrual] = await tx
      .select({ id: accrualObligations.id, status: accrualObligations.status })
      .from(accrualObligations)
      .where(eq(accrualObligations.expenseId, expenseId))
      .for("update")
      .limit(1);
    if (linkedAccrual) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "مصروف الشحن/الصيانة المرتبط باستحقاق لا يُلغى من الإلغاء العام؛ استخدم طلب تصحيح المصدر المعتمد",
      });
    }

    if (
      expensePreview.source !== "STOCK" &&
      expensePreview.paymentMethod === "CASH" &&
      (expensePreview.cashBucket === "DRAWER" || expensePreview.cashBucket === "TREASURY")
    ) {
      await lockCashSourceForUpdate(tx, {
        branchId: Number(expensePreview.branchId),
        cashBucket: expensePreview.cashBucket,
        shiftId: expensePreview.shiftId != null ? Number(expensePreview.shiftId) : null,
      });
    }

    const linkedReceipt = expensePreview.receiptId != null
      ? (await tx
          .select()
          .from(receipts)
          .where(eq(receipts.id, Number(expensePreview.receiptId)))
          .for("update")
          .limit(1))[0] ?? null
      : null;
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
    if (
      Number(exp.branchId) !== Number(expensePreview.branchId) ||
      Number(exp.receiptId ?? 0) !== Number(expensePreview.receiptId ?? 0) ||
      Number(exp.shiftId ?? 0) !== Number(expensePreview.shiftId ?? 0) ||
      exp.cashBucket !== expensePreview.cashBucket ||
      exp.paymentMethod !== expensePreview.paymentMethod ||
      !money(exp.amount).eq(money(expensePreview.amount))
    ) {
      throw new TRPCError({ code: "CONFLICT", message: "تغيّر مصدر دفع المصروف أثناء الإلغاء — أعد المحاولة" });
    }
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
        postingIntent: createPostingIntent(
          reason === "WASTAGE" ? "WASTAGE_INVENTORY" : "INTERNAL_USE_INVENTORY",
          reason,
          signedPostingLines(
            reason === "WASTAGE" ? "LOSSES" : "OPERATING_EXPENSE",
            "INVENTORY",
            money(exp.amount).neg(),
          ),
        ),
        dedupeKey: null,
        notes: `إلغاء ${reason === "WASTAGE" ? "تلف" : "نثرية"} #${expenseId}`,
        createdBy: actor.userId,
      });
      return { expenseId, status: "CANCELLED" };
    }

    if (!linkedReceipt || exp.receiptId == null) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "المصروف المالي بلا سند دفع مرتبط — أوقف الإلغاء وراجع التدقيق",
      });
    }
    if (
      linkedReceipt.direction !== "OUT" ||
      Number(linkedReceipt.branchId) !== Number(exp.branchId) ||
      linkedReceipt.paymentMethod !== exp.paymentMethod ||
      !money(linkedReceipt.amount).eq(money(exp.amount))
    ) {
      throw new TRPCError({ code: "CONFLICT", message: "سند دفع المصروف لا يطابق سجل المصروف" });
    }

    const cashWasMaterialized =
      linkedReceipt.status === "COMPLETED" &&
      linkedReceipt.approvalStatus === "APPROVED";
    if (linkedReceipt.approvalStatus === "APPROVED" && !cashWasMaterialized) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "سند المصروف معتمد لكنه ليس حركة مكتملة قابلة للعكس",
      });
    }

    // A forged COMPLETED+APPROVED pair must not turn an unsettled system expense
    // into a materialized one.  Recognize the reserved system shape even when its
    // JSON/reference was damaged, then require both the approval signature and the
    // authoritative source before either status changes.
    const parsedSystemRequest = parseSystemPaymentRequest(linkedReceipt.internalNote);
    const recognizedSystemExpenseCandidate =
      parsedSystemRequest?.kind === "PURCHASE_SHIPPING" ||
      parsedSystemRequest?.kind === "ASSET_MAINTENANCE" ||
      linkedReceipt.internalNote?.startsWith("@SYSTEM_PAYMENT_REQUEST:") === true ||
      (
        linkedReceipt.voucherNumber != null &&
        exp.cashBucket === "TREASURY" &&
        (exp.category === "TRANSPORT" || exp.category === "MAINTENANCE")
      ) ||
      /^SHIP-.+-[0-9a-f]{16}$/i.test(linkedReceipt.referenceNumber ?? "") ||
      /^ASSET-MAINT-[1-9][0-9]*$/.test(linkedReceipt.referenceNumber ?? "");
    let recognizedSource: Awaited<
      ReturnType<typeof assertRecognizedExpenseSource>
    > | null = null;
    let unsettledSource: Awaited<
      ReturnType<typeof assertRecognizedExpenseSource>
    > | null = null;
    if (cashWasMaterialized) {
      if (recognizedSystemExpenseCandidate) {
        recognizedSource = await assertRecognizedExpenseSource(
          tx,
          exp,
          linkedReceipt,
          "MATERIALIZED",
        );
      }
    } else {
      unsettledSource = await assertRecognizedExpenseSource(tx, exp, linkedReceipt);
    }

    await tx
      .update(expenses)
      .set({ status: "CANCELLED" })
      .where(eq(expenses.id, expenseId));
    await tx
      .update(receipts)
      .set({ status: "REVERSED" })
      .where(eq(receipts.id, Number(exp.receiptId)));

    // مصروف الشحن/الصيانة يُعترف به قبل الدفع، وإيصاله المعلّق/المرفوض لم يمس
    // النقد. إلغاؤه يعكس قيد الاستحقاق فقط، ولا يخلق قبضاً وهمياً في الخزينة.
    if (unsettledSource) {
      const [accrual] = await tx
        .select({
          entryType: accountingEntries.entryType,
          branchId: accountingEntries.branchId,
          purchaseOrderId: accountingEntries.purchaseOrderId,
          receiptId: accountingEntries.receiptId,
          amount: accountingEntries.amount,
        })
        .from(accountingEntries)
        .where(eq(accountingEntries.dedupeKey, unsettledSource.accrualDedupe))
        .for("update")
        .limit(1);
      if (
        !accrual ||
        accrual.entryType !== "ADJUST" ||
        accrual.receiptId != null ||
        Number(accrual.branchId) !== Number(exp.branchId) ||
        !money(accrual.amount).eq(money(exp.amount))
      ) {
        throw new TRPCError({ code: "CONFLICT", message: "قيد استحقاق المصروف مفقود أو لا يطابق الطلب" });
      }
      const reversal = expenseAccrualReversal(
        unsettledSource.expenseRole,
        money(exp.amount),
      );
      await postEntry(tx, {
        entryType: "ADJUST",
        branchId: Number(exp.branchId),
        purchaseOrderId: unsettledSource.accrualPurchaseOrderId,
        amount: money(exp.amount).neg(),
        postingIntent: reversal.intent,
        postingSourceComponents: reversal.sourceComponents,
        entryDate: new Date(exp.expenseDate),
        dedupeKey: `EXPENSE_ACCRUAL_CANCEL:${expenseId}`,
        notes: `عكس استحقاق مصروف غير مدفوع #${expenseId}`,
        createdBy: actor.userId,
      });
      return { expenseId, status: "CANCELLED" as const };
    }

    if (
      linkedReceipt.cashBucket !== exp.cashBucket ||
      Number(linkedReceipt.shiftId ?? 0) !== Number(exp.shiftId ?? 0)
    ) {
      throw new TRPCError({ code: "CONFLICT", message: "مصدر النقد المنفذ لا يطابق المصروف" });
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
      approvalStatus: "APPROVED",
      referenceNumber: `CANCEL-EXP-${expenseId}`,
      createdBy: actor.userId,
    });
    const compReceiptId = extractInsertId(compRes);

    // G5 (١٩/٦/٢٦): قيد PAYMENT_IN بدل ADJUST (موجب) — متّسق مع نمط cancelVoucher
    // ويُغلق انحرافاً في cashReconcile الذي يتجاهل ADJUST عند حساب الرصيد من القيود.
    const reversalCashBucket =
      (exp as { cashBucket?: "DRAWER" | "TREASURY" | null }).cashBucket ??
      null;
    if (recognizedSource) {
      const assetRole = paymentAssetRole(
        exp.paymentMethod,
        reversalCashBucket,
        "OUT",
      );
      const settlementReversal = expenseAccrualSettlement(
        assetRole,
        money(exp.amount).neg(),
      );
      await postEntry(tx, {
        entryType: "PAYMENT_OUT",
        branchId: Number(exp.branchId),
        receiptId: compReceiptId,
        purchaseOrderId: recognizedSource.accrualPurchaseOrderId,
        amount: money(exp.amount).neg(),
        paymentMethod: exp.paymentMethod,
        postingIntent: settlementReversal.intent,
        postingSourceComponents: settlementReversal.sourceComponents,
        dedupeKey: `EXPENSE_SETTLEMENT_CANCEL:${expenseId}`,
        notes: `عكس تسوية مصروف مستحق #${expenseId}`,
        createdBy: actor.userId,
      });
      const recognitionReversal = expenseAccrualReversal(
        recognizedSource.expenseRole,
        money(exp.amount),
      );
      await postEntry(tx, {
        entryType: "ADJUST",
        branchId: Number(exp.branchId),
        purchaseOrderId: recognizedSource.accrualPurchaseOrderId,
        amount: money(exp.amount).neg(),
        postingIntent: recognitionReversal.intent,
        postingSourceComponents: recognitionReversal.sourceComponents,
        entryDate: new Date(exp.expenseDate),
        dedupeKey: `EXPENSE_ACCRUAL_CANCEL:${expenseId}`,
        notes: `عكس استحقاق مصروف مدفوع #${expenseId}`,
        createdBy: actor.userId,
      });
      return { expenseId, status: "CANCELLED" as const };
    }
    const postingSourceComponents = cashExpensePostingSourceComponents(
      exp.category,
      exp.paymentMethod,
      money(exp.amount),
      true,
      reversalCashBucket,
    );
    await postEntry(tx, {
      entryType: "PAYMENT_IN",
      branchId: Number(exp.branchId),
      receiptId: compReceiptId,
      amount: money(exp.amount),
      paymentMethod: exp.paymentMethod,
      postingIntent: cashExpensePostingIntent(
        exp.category,
        exp.paymentMethod,
        money(exp.amount),
        true,
        reversalCashBucket,
      ),
      postingSourceComponents,
      notes: `إلغاء مصروف #${expenseId}`,
      createdBy: actor.userId,
    });

    return { expenseId, status: "CANCELLED" };
  });
}

export interface ListExpensesInput {
  branchId?: number;
  category?: ExpenseCategory;
  status?: "PENDING_APPROVAL" | "ACTIVE" | "REJECTED" | "CANCELLED";
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

const SYSTEM_PAYMENT_REQUEST_PREFIX = "@SYSTEM_PAYMENT_REQUEST:";
const systemRequestJsonSql = sql`CASE
  WHEN LEFT(COALESCE(${receipts.internalNote}, ''), CHAR_LENGTH(${SYSTEM_PAYMENT_REQUEST_PREFIX})) = ${SYSTEM_PAYMENT_REQUEST_PREFIX}
    AND JSON_VALID(SUBSTRING(${receipts.internalNote}, CHAR_LENGTH(${SYSTEM_PAYMENT_REQUEST_PREFIX}) + 1))
  THEN SUBSTRING(${receipts.internalNote}, CHAR_LENGTH(${SYSTEM_PAYMENT_REQUEST_PREFIX}) + 1)
  ELSE '{}'
END`;
const systemRequestKindSql = sql`JSON_UNQUOTE(JSON_EXTRACT(${systemRequestJsonSql}, '$.kind'))`;
const systemAccrualDedupeSql = sql`CASE
  WHEN ${systemRequestKindSql} = 'PURCHASE_SHIPPING' THEN CONCAT(
    'PURCHASE_SHIPPING_ACCRUAL:',
    JSON_UNQUOTE(JSON_EXTRACT(${systemRequestJsonSql}, '$.purchaseOrderId')),
    ':',
    JSON_UNQUOTE(JSON_EXTRACT(${systemRequestJsonSql}, '$.requestToken'))
  )
  WHEN ${systemRequestKindSql} = 'ASSET_MAINTENANCE' THEN CONCAT(
    'ASSET_MAINT_ACCRUAL:',
    JSON_UNQUOTE(JSON_EXTRACT(${systemRequestJsonSql}, '$.maintenanceId'))
  )
  ELSE NULL
END`;

const systemRequestPurchaseOrderIdSql = sql`CAST(JSON_UNQUOTE(JSON_EXTRACT(${systemRequestJsonSql}, '$.purchaseOrderId')) AS UNSIGNED)`;
const systemRequestMaintenanceIdSql = sql`CAST(JSON_UNQUOTE(JSON_EXTRACT(${systemRequestJsonSql}, '$.maintenanceId')) AS UNSIGNED)`;
const systemRequestAssetIdSql = sql`CAST(JSON_UNQUOTE(JSON_EXTRACT(${systemRequestJsonSql}, '$.assetId')) AS UNSIGNED)`;
const systemRequestTokenSql = sql`JSON_UNQUOTE(JSON_EXTRACT(${systemRequestJsonSql}, '$.requestToken'))`;
const systemRequestExpectedAmountSql = sql`JSON_UNQUOTE(JSON_EXTRACT(${systemRequestJsonSql}, '$.expectedAmount'))`;
const systemRequestShippingTotalSql = sql`JSON_UNQUOTE(JSON_EXTRACT(${systemRequestJsonSql}, '$.sourceShippingTotal'))`;

/** A different creator is legitimate only when this receipt is the exact child of a rejected system request. */
const systemExpenseResubmissionChainSql = sql`(
  (
    SELECT COUNT(*)
    FROM idempotencyKeys AS expenseResubmitLinkCount
    WHERE expenseResubmitLinkCount.operation = 'voucher.create'
      AND expenseResubmitLinkCount.clientRequestId REGEXP '^system-expense-resubmit-[1-9][0-9]*-A[1-9][0-9]*$'
      AND expenseResubmitLinkCount.refId = ${receipts.id}
  ) = 1
  AND EXISTS (
  SELECT 1
  FROM idempotencyKeys AS expenseResubmitLink
  INNER JOIN receipts AS expenseResubmitRoot
    ON expenseResubmitRoot.id = CAST(SUBSTRING_INDEX(
      SUBSTRING(expenseResubmitLink.clientRequestId, CHAR_LENGTH('system-expense-resubmit-') + 1),
      '-A',
      1
    ) AS UNSIGNED)
  LEFT JOIN idempotencyKeys AS expenseResubmitPriorLink
    ON CAST(SUBSTRING_INDEX(expenseResubmitLink.clientRequestId, '-A', -1) AS UNSIGNED) > 1
    AND expenseResubmitPriorLink.operation = 'voucher.create'
    AND expenseResubmitPriorLink.clientRequestId = CONCAT(
      'system-expense-resubmit-',
      expenseResubmitRoot.id,
      '-A',
      CAST(SUBSTRING_INDEX(expenseResubmitLink.clientRequestId, '-A', -1) AS UNSIGNED) - 1
    )
  INNER JOIN receipts AS expenseResubmitParent
    ON expenseResubmitParent.id = CASE
      WHEN CAST(SUBSTRING_INDEX(expenseResubmitLink.clientRequestId, '-A', -1) AS UNSIGNED) = 1
        THEN expenseResubmitRoot.id
      ELSE expenseResubmitPriorLink.refId
    END
  WHERE expenseResubmitLink.operation = 'voucher.create'
    AND expenseResubmitLink.refId = ${receipts.id}
    AND expenseResubmitLink.clientRequestId REGEXP '^system-expense-resubmit-[1-9][0-9]*-A[1-9][0-9]*$'
    AND expenseResubmitParent.id <> ${receipts.id}
    AND expenseResubmitRoot.createdBy = ${expenses.createdBy}
    AND expenseResubmitParent.direction = 'OUT'
    AND expenseResubmitParent.receiptStatus = 'FAILED'
    AND expenseResubmitParent.receiptApprovalStatus = 'REJECTED'
    AND expenseResubmitParent.approvedBy IS NOT NULL
    AND expenseResubmitParent.approvedAt IS NOT NULL
    AND expenseResubmitParent.createdBy IS NOT NULL
    AND expenseResubmitParent.approvedBy <> expenseResubmitParent.createdBy
    AND expenseResubmitParent.signatureHash IS NULL
    AND expenseResubmitParent.shiftId IS NULL
    AND expenseResubmitParent.cashBucket IS NULL
    AND (expenseResubmitParent.branchId <=> ${receipts.branchId})
    AND (expenseResubmitParent.amount <=> ${receipts.amount})
    AND (expenseResubmitParent.paymentMethod <=> ${receipts.paymentMethod})
    AND (expenseResubmitParent.referenceNumber <=> ${receipts.referenceNumber})
    AND (expenseResubmitParent.internalNote <=> ${receipts.internalNote})
    AND (expenseResubmitParent.voucherPartyType <=> ${receipts.partyType})
    AND (expenseResubmitParent.partyId <=> ${receipts.partyId})
    AND ${receipts.description} REGEXP CONCAT(
      '(^| — )المحاولة A',
      CAST(SUBSTRING_INDEX(expenseResubmitLink.clientRequestId, '-A', -1) AS UNSIGNED),
      ' بعد السند #',
      expenseResubmitParent.id,
      ': .{5,}$'
    )
  )
)`;

/** The JSON request is accepted only when its authoritative source still matches. */
const recognizedSystemExpenseSourceSql = sql`(
  (
    ${expenses.category} = 'TRANSPORT'
    AND ${systemRequestKindSql} = 'PURCHASE_SHIPPING'
    AND JSON_TYPE(JSON_EXTRACT(${systemRequestJsonSql}, '$.purchaseOrderId')) = 'INTEGER'
    AND ${systemRequestPurchaseOrderIdSql} > 0
    AND JSON_TYPE(JSON_EXTRACT(${systemRequestJsonSql}, '$.requestToken')) = 'STRING'
    AND BINARY ${systemRequestTokenSql} REGEXP '^[0-9A-Fa-f]{16}$'
    AND JSON_TYPE(JSON_EXTRACT(${systemRequestJsonSql}, '$.expectedAmount')) = 'STRING'
    AND ${systemRequestExpectedAmountSql} REGEXP '^[0-9]+([.][0-9]{1,2})?$'
    AND CAST(${systemRequestExpectedAmountSql} AS DECIMAL(15, 2)) <=> ${expenses.amount}
    AND JSON_TYPE(JSON_EXTRACT(${systemRequestJsonSql}, '$.sourceShippingTotal')) = 'STRING'
    AND ${systemRequestShippingTotalSql} REGEXP '^[0-9]+([.][0-9]{1,2})?$'
    AND EXISTS (
      SELECT 1
      FROM purchaseOrders AS recognizedPurchaseOrder
      WHERE recognizedPurchaseOrder.id = ${systemRequestPurchaseOrderIdSql}
        AND (recognizedPurchaseOrder.branchId <=> ${expenses.branchId})
        AND ${receipts.referenceNumber} = CONCAT(
          'SHIP-', recognizedPurchaseOrder.poNumber, '-', ${systemRequestTokenSql}
        )
        AND (
          recognizedPurchaseOrder.shippingCost + recognizedPurchaseOrder.customsCost
          <=> CAST(${systemRequestShippingTotalSql} AS DECIMAL(15, 2))
        )
    )
  )
  OR
  (
    ${expenses.category} = 'MAINTENANCE'
    AND ${systemRequestKindSql} = 'ASSET_MAINTENANCE'
    AND JSON_TYPE(JSON_EXTRACT(${systemRequestJsonSql}, '$.maintenanceId')) = 'INTEGER'
    AND JSON_TYPE(JSON_EXTRACT(${systemRequestJsonSql}, '$.assetId')) = 'INTEGER'
    AND ${systemRequestMaintenanceIdSql} > 0
    AND ${systemRequestAssetIdSql} > 0
    AND ${receipts.referenceNumber} = CONCAT('ASSET-MAINT-', ${systemRequestMaintenanceIdSql})
    AND EXISTS (
      SELECT 1
      FROM assetMaintenance AS recognizedMaintenance
      INNER JOIN fixedAssets AS recognizedAsset
        ON recognizedAsset.id = recognizedMaintenance.assetId
      WHERE recognizedMaintenance.id = ${systemRequestMaintenanceIdSql}
        AND recognizedMaintenance.assetId = ${systemRequestAssetIdSql}
        AND (recognizedAsset.branchId <=> ${expenses.branchId})
        AND (recognizedMaintenance.cost <=> ${expenses.amount})
    )
  )
)`;

/**
 * عقد واحد لحالة «اعترفنا بالمصروف ولم ندفعه ثم ألغيناه».
 * لا يكفي كون السند PENDING/REJECTED: يلزم طلب نظامي من نوع الشحن/الصيانة،
 * وقيد الاستحقاق الأصلي، وعكسه الكامل. يُعاد استعمال هذا التعبير في صفوف
 * القائمة وفي مجاميع التدقيق حتى لا تنحرف دلالتا TypeScript وSQL عن بعضهما.
 */
const recognizedUnsettledCancellationSql = sql`COALESCE((
  ${expenses.status} = 'CANCELLED'
  AND ${expenses.source} = 'CASH'
  AND ${expenses.shiftId} IS NULL
  AND (
    (${expenses.paymentMethod} = 'CASH' AND ${expenses.cashBucket} = 'TREASURY')
    OR (${expenses.paymentMethod} <> 'CASH' AND ${expenses.cashBucket} IS NULL)
  )
  AND ${expenses.createdBy} IS NOT NULL
  AND ${receipts.createdBy} IS NOT NULL
  AND ${receipts.id} IS NOT NULL
  AND ${receipts.direction} = 'OUT'
  AND ${receipts.partyType} = 'OTHER'
  AND ${receipts.partyId} IS NULL
  AND ${receipts.invoiceId} IS NULL
  AND ${receipts.workOrderId} IS NULL
  AND ${receipts.reservationId} IS NULL
  AND ${receipts.status} = 'REVERSED'
  AND ${receipts.approvalStatus} IN ('PENDING_APPROVAL', 'REJECTED')
  AND ${receipts.shiftId} IS NULL
  AND ${receipts.cashBucket} IS NULL
  AND (${expenses.amount} <=> ${receipts.amount})
  AND (${expenses.branchId} <=> ${receipts.branchId})
  AND (${expenses.paymentMethod} <=> ${receipts.paymentMethod})
  AND (
    (${expenses.createdBy} <=> ${receipts.createdBy})
    OR ${systemExpenseResubmissionChainSql}
  )
  AND (${expenses.referenceNumber} <=> ${receipts.referenceNumber})
  AND (
    (
      ${expenses.category} = 'TRANSPORT'
      AND ${systemRequestKindSql} = 'PURCHASE_SHIPPING'
      AND ${receipts.referenceNumber} LIKE 'SHIP-%'
      AND RIGHT(
        ${receipts.referenceNumber},
        CHAR_LENGTH(JSON_UNQUOTE(JSON_EXTRACT(${systemRequestJsonSql}, '$.requestToken')))
      ) = JSON_UNQUOTE(JSON_EXTRACT(${systemRequestJsonSql}, '$.requestToken'))
      AND CAST(
        JSON_UNQUOTE(JSON_EXTRACT(${systemRequestJsonSql}, '$.expectedAmount'))
        AS DECIMAL(15, 2)
      ) <=> ${expenses.amount}
    )
    OR (
      ${expenses.category} = 'MAINTENANCE'
      AND ${systemRequestKindSql} = 'ASSET_MAINTENANCE'
      AND ${receipts.referenceNumber} = CONCAT(
        'ASSET-MAINT-',
        JSON_UNQUOTE(JSON_EXTRACT(${systemRequestJsonSql}, '$.maintenanceId'))
      )
    )
  )
  AND ${recognizedSystemExpenseSourceSql}
  AND EXISTS (
    SELECT 1
    FROM accountingEntries AS recognizedAccrual
    WHERE recognizedAccrual.entryType = 'ADJUST'
      AND recognizedAccrual.receiptId IS NULL
      AND (recognizedAccrual.branchId <=> ${expenses.branchId})
      AND (recognizedAccrual.amount <=> ${expenses.amount})
      AND recognizedAccrual.dedupeKey = ${systemAccrualDedupeSql}
      AND (
        (${systemRequestKindSql} = 'PURCHASE_SHIPPING'
          AND recognizedAccrual.purchaseOrderId = ${systemRequestPurchaseOrderIdSql})
        OR (${systemRequestKindSql} = 'ASSET_MAINTENANCE'
          AND recognizedAccrual.purchaseOrderId IS NULL)
      )
  )
  AND EXISTS (
    SELECT 1
    FROM accountingEntries AS recognizedAccrualReversal
    WHERE recognizedAccrualReversal.entryType = 'ADJUST'
      AND recognizedAccrualReversal.receiptId IS NULL
      AND (recognizedAccrualReversal.branchId <=> ${expenses.branchId})
      AND recognizedAccrualReversal.amount = -${expenses.amount}
      AND recognizedAccrualReversal.dedupeKey = CONCAT('EXPENSE_ACCRUAL_CANCEL:', ${expenses.id})
      AND (
        (${systemRequestKindSql} = 'PURCHASE_SHIPPING'
          AND recognizedAccrualReversal.purchaseOrderId = ${systemRequestPurchaseOrderIdSql})
        OR (${systemRequestKindSql} = 'ASSET_MAINTENANCE'
          AND recognizedAccrualReversal.purchaseOrderId IS NULL)
      )
  )
), FALSE)`;

const missingPayeeSql = sql`(
  TRIM(COALESCE(${expenses.payee}, '')) = ''
  AND NOT (
    ${recognizedUnsettledCancellationSql}
    AND TRIM(COALESCE(${receipts.counterpartyName}, '')) <> ''
  )
)`;

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
      receiptCounterpartyName: receipts.counterpartyName,
      receiptApprovalStatus: receipts.approvalStatus,
      receiptApprovedBy: receipts.approvedBy,
      receiptApprovedByName: expenseReceiptApprover.name,
      receiptApprovedByRole: expenseReceiptApprover.role,
      receiptApprovedAt: receipts.approvedAt,
      accrualObligationId: accrualObligations.id,
      accrualKind: accrualObligations.kind,
      settlementStatus: accrualObligations.status,
      accrualBeneficiaryType: accrualObligations.beneficiaryType,
      accrualBeneficiarySupplierId: accrualObligations.beneficiarySupplierId,
      accrualBeneficiaryName: accrualObligations.beneficiaryName,
      accrualEvidenceReference: accrualObligations.evidenceReference,
      accrualPurchaseOrderId: accrualObligations.purchaseOrderId,
      accrualAssetId: accrualObligations.assetId,
      accrualMaintenanceId: accrualObligations.maintenanceId,
      recognitionAccountingEntryId: sql<number | null>`(
        SELECT aoe.accountingEntryId FROM accrualObligationEvents aoe
        WHERE aoe.obligationId = ${accrualObligations.id}
          AND aoe.eventType = 'RECOGNIZED'
        ORDER BY aoe.id DESC LIMIT 1
      )`,
      settlementAccountingEntryId: sql<number | null>`(
        SELECT aoe.accountingEntryId FROM accrualObligationEvents aoe
        WHERE aoe.obligationId = ${accrualObligations.id}
          AND aoe.eventType IN ('PAYMENT_SETTLED', 'SETTLEMENT_REVERSED')
        ORDER BY aoe.id DESC LIMIT 1
      )`,
      settlementReceiptId: sql<number | null>`(
        SELECT aoe.receiptId FROM accrualObligationEvents aoe
        WHERE aoe.obligationId = ${accrualObligations.id}
          AND aoe.eventType IN ('PAYMENT_SETTLED', 'SETTLEMENT_REVERSED')
        ORDER BY aoe.id DESC LIMIT 1
      )`,
      recognizedUnsettledCancellation: sql<number>`CASE WHEN ${recognizedUnsettledCancellationSql} THEN 1 ELSE 0 END`,
    })
    .from(expenses)
    .leftJoin(branches, eq(expenses.branchId, branches.id))
    .leftJoin(expenseCreator, eq(expenses.createdBy, expenseCreator.id))
    .leftJoin(shifts, eq(expenses.shiftId, shifts.id))
    .leftJoin(accrualObligations, eq(accrualObligations.expenseId, expenses.id))
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
  settlementStatus?: string | null;
}): ExpenseFundingKind {
  if (row.source === "ACCRUAL") {
    return row.settlementStatus === "PAID" ? "ACCRUED_PAID" : "ACCRUED_UNPAID";
  }
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
  const recognizedUnsettledCancellation =
    Number(row.recognizedUnsettledCancellation ?? 0) === 1;
  if (!row.description?.trim()) warnings.push("DESCRIPTION_MISSING");
  if (
    !row.payee?.trim() &&
    !(recognizedUnsettledCancellation && row.receiptCounterpartyName?.trim())
  )
    warnings.push("PAYEE_MISSING");
  if (row.source === "STOCK") {
    if (row.receiptId != null || row.linkedReceiptId != null)
      warnings.push("STOCK_HAS_RECEIPT");
    if (row.shiftId != null || row.cashBucket != null)
      warnings.push("STOCK_HAS_CASH_LOCATION");
    return warnings;
  }
  if (row.source === "ACCRUAL") {
    if (row.paymentMethod !== "ACCRUAL") warnings.push("ACCRUAL_PAYMENT_METHOD_MISMATCH");
    if (row.receiptId != null || row.linkedReceiptId != null) warnings.push("ACCRUAL_HAS_DIRECT_RECEIPT");
    if (row.shiftId != null || row.cashBucket != null) warnings.push("ACCRUAL_HAS_CASH_LOCATION");
    if (row.accrualObligationId == null) warnings.push("ACCRUAL_OBLIGATION_MISSING");
    if (row.recognitionAccountingEntryId == null) warnings.push("ACCRUAL_RECOGNITION_ENTRY_MISSING");
    if (["PAID", "REFUND_PENDING", "REFUNDED"].includes(row.settlementStatus ?? "")) {
      if (row.settlementReceiptId == null || row.settlementAccountingEntryId == null) {
        warnings.push("ACCRUAL_SETTLEMENT_TRACE_MISSING");
      }
    } else if (
      ["ACCRUED_UNPAID", "PAYMENT_PENDING", "PAYABLE_UNSETTLED", "CORRECTION_PENDING"].includes(row.settlementStatus ?? "") &&
      (row.settlementReceiptId != null || row.settlementAccountingEntryId != null)
    ) {
      warnings.push("UNPAID_ACCRUAL_HAS_SETTLEMENT_EFFECT");
    }
    return warnings;
  }

  if (row.receiptId == null || row.linkedReceiptId == null) {
    warnings.push("RECEIPT_MISSING");
  } else if (recognizedUnsettledCancellation) {
    // كل الفروق المقصودة (TREASURY مقابل clearing بلا cashBucket، وعدم الاعتماد)
    // مشمولة في العقد SQL أعلاه؛ لا تُعفَ الحالة إذا فُقد/عُبث أي قيد منه.
    return warnings;
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
    if (row.status === "PENDING_APPROVAL") {
      if (
        row.receiptStatus !== "PENDING" ||
        row.receiptApprovalStatus !== "PENDING_APPROVAL"
      )
        warnings.push("PENDING_RECEIPT_MISMATCH");
    } else if (row.status === "REJECTED") {
      if (
        row.receiptStatus !== "FAILED" ||
        row.receiptApprovalStatus !== "REJECTED"
      )
        warnings.push("REJECTED_RECEIPT_MISMATCH");
    } else {
      if (row.status === "ACTIVE" && row.receiptStatus !== "COMPLETED")
        warnings.push("RECEIPT_STATUS_MISMATCH");
      if (row.status === "CANCELLED" && row.receiptStatus !== "REVERSED")
        warnings.push("RECEIPT_STATUS_MISMATCH");
      if (row.receiptApprovalStatus !== "APPROVED")
        warnings.push("RECEIPT_NOT_APPROVED");
    }
  }

  if (
    fundingKind === "UNKNOWN" &&
    row.status !== "PENDING_APPROVAL" &&
    row.status !== "REJECTED"
  )
    warnings.push("CASH_FUNDING_UNKNOWN");
  if (
    (row.status === "PENDING_APPROVAL" || row.status === "REJECTED") &&
    (row.shiftId != null || row.cashBucket != null)
  )
    warnings.push("UNEXECUTED_HAS_CASH_LOCATION");
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
  const obligationBacked = row.source === "ACCRUAL";
  return {
    ...row,
    // The recognition source never points at a replaceable payment request.
    // Expose the material settlement and the immutable source evidence as
    // explicit report/trace fields while preserving expense.receiptId=null.
    linkedReceiptId: obligationBacked
      ? row.settlementReceiptId ?? null
      : row.linkedReceiptId ?? null,
    beneficiaryName: obligationBacked
      ? row.accrualBeneficiaryName ?? null
      : row.receiptCounterpartyName ?? row.payee ?? null,
    evidenceReference: obligationBacked
      ? row.accrualEvidenceReference ?? null
      : row.referenceNumber ?? null,
    approvalStatus: row.receiptApprovalStatus ?? null,
    approvedBy: row.receiptApprovedBy ?? null,
    approvedByName: row.receiptApprovedByName ?? null,
    approvedAt: row.receiptApprovedAt ?? null,
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
  if (input.fundingKind === "ACCRUED_UNPAID") {
    conds.push(eq(expenses.source, "ACCRUAL"));
    conds.push(sql`${accrualObligations.status} <> 'PAID'`);
  }
  if (input.fundingKind === "ACCRUED_PAID") {
    conds.push(eq(expenses.source, "ACCRUAL"));
    conds.push(eq(accrualObligations.status, "PAID"));
  }
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
  NOT ${recognizedUnsettledCancellationSql}
  AND (
    (${expenses.source} = 'ACCRUAL' AND (
      ${expenses.paymentMethod} <> 'ACCRUAL'
      OR ${expenses.receiptId} IS NOT NULL
      OR ${expenses.shiftId} IS NOT NULL
      OR ${expenses.cashBucket} IS NOT NULL
      OR NOT EXISTS (
        SELECT 1 FROM accrualObligations AS integrityObligation
        WHERE integrityObligation.expenseId = ${expenses.id}
          AND EXISTS (
            SELECT 1 FROM accrualObligationEvents AS integrityRecognition
            WHERE integrityRecognition.obligationId = integrityObligation.id
              AND integrityRecognition.eventType = 'RECOGNIZED'
              AND integrityRecognition.accountingEntryId IS NOT NULL
          )
          AND (
            (integrityObligation.status = 'PAID' AND EXISTS (
              SELECT 1 FROM accrualObligationEvents AS integritySettlement
              WHERE integritySettlement.obligationId = integrityObligation.id
                AND integritySettlement.eventType = 'PAYMENT_SETTLED'
                AND integritySettlement.receiptId IS NOT NULL
                AND integritySettlement.accountingEntryId IS NOT NULL
            ))
            OR integrityObligation.status <> 'PAID'
          )
      )
    ))
    OR
    (${expenses.source} = 'STOCK' AND (${expenses.receiptId} IS NOT NULL OR ${expenses.shiftId} IS NOT NULL OR ${expenses.cashBucket} IS NOT NULL))
    OR
    (${expenses.source} NOT IN ('STOCK','ACCRUAL') AND (
    ${expenses.receiptId} IS NULL OR ${receipts.id} IS NULL
    OR ${receipts.direction} <> 'OUT'
    OR NOT (${expenses.amount} <=> ${receipts.amount})
    OR NOT (${expenses.branchId} <=> ${receipts.branchId})
    OR NOT (${expenses.shiftId} <=> ${receipts.shiftId})
    OR NOT (${expenses.paymentMethod} <=> ${receipts.paymentMethod})
    OR NOT (${expenses.cashBucket} <=> ${receipts.cashBucket})
    OR NOT (${expenses.createdBy} <=> ${receipts.createdBy})
    OR (${expenses.status} = 'PENDING_APPROVAL' AND (
      ${receipts.status} <> 'PENDING'
      OR ${receipts.approvalStatus} <> 'PENDING_APPROVAL'
      OR ${expenses.shiftId} IS NOT NULL OR ${expenses.cashBucket} IS NOT NULL
    ))
    OR (${expenses.status} = 'REJECTED' AND (
      ${receipts.status} <> 'FAILED'
      OR ${receipts.approvalStatus} <> 'REJECTED'
      OR ${expenses.shiftId} IS NOT NULL OR ${expenses.cashBucket} IS NOT NULL
    ))
    OR (${expenses.status} = 'ACTIVE' AND (
      ${receipts.status} <> 'COMPLETED'
      OR ${receipts.approvalStatus} <> 'APPROVED'
      OR (${expenses.paymentMethod} = 'CASH' AND ${expenses.cashBucket} IS NULL)
    ))
    OR (${expenses.status} = 'CANCELLED' AND (
      ${receipts.status} <> 'REVERSED'
      OR ${receipts.approvalStatus} <> 'APPROVED'
    ))
    OR (${expenses.cashBucket} = 'DRAWER' AND ${expenses.shiftId} IS NULL)
    OR (${expenses.cashBucket} = 'TREASURY' AND ${expenses.shiftId} IS NOT NULL)
    OR (${expenses.paymentMethod} <> 'CASH' AND ${expenses.cashBucket} IS NOT NULL)
    ))
  )
)`;

const needsAuditSql = sql`(
  TRIM(COALESCE(${expenses.description}, '')) = ''
  OR ${missingPayeeSql}
  OR ${financialIntegritySql}
)`;

export async function listExpenses(input: ListExpensesInput = {}) {
  const db = getDb();
  const emptyTotals = {
    active: "0.00",
    pendingApproval: "0.00",
    rejected: "0.00",
    drawer: "0.00",
    treasury: "0.00",
    nonCash: "0.00",
    stock: "0.00",
    accruedUnpaid: "0.00",
    accruedPaid: "0.00",
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
        pendingApproval: sql<string>`COALESCE(SUM(CASE WHEN ${expenses.status} = 'PENDING_APPROVAL' THEN ${expenses.amount} ELSE 0 END), 0)`,
        rejected: sql<string>`COALESCE(SUM(CASE WHEN ${expenses.status} = 'REJECTED' THEN ${expenses.amount} ELSE 0 END), 0)`,
        drawer: sql<string>`COALESCE(SUM(CASE WHEN ${expenses.status} = 'ACTIVE' AND ${expenses.source} <> 'STOCK' AND ${expenses.paymentMethod} = 'CASH' AND ${expenses.cashBucket} = 'DRAWER' THEN ${expenses.amount} ELSE 0 END), 0)`,
        treasury: sql<string>`COALESCE(SUM(CASE WHEN ${expenses.status} = 'ACTIVE' AND ${expenses.source} <> 'STOCK' AND ${expenses.paymentMethod} = 'CASH' AND ${expenses.cashBucket} = 'TREASURY' THEN ${expenses.amount} ELSE 0 END), 0)`,
        nonCash: sql<string>`COALESCE(SUM(CASE WHEN ${expenses.status} = 'ACTIVE' AND ${expenses.source} NOT IN ('STOCK','ACCRUAL') AND ${expenses.paymentMethod} <> 'CASH' THEN ${expenses.amount} ELSE 0 END), 0)`,
        stock: sql<string>`COALESCE(SUM(CASE WHEN ${expenses.status} = 'ACTIVE' AND ${expenses.source} = 'STOCK' THEN ${expenses.amount} ELSE 0 END), 0)`,
        accruedUnpaid: sql<string>`COALESCE(SUM(CASE WHEN ${expenses.status} = 'ACTIVE' AND ${expenses.source} = 'ACCRUAL' AND ${accrualObligations.status} <> 'PAID' THEN ${expenses.amount} ELSE 0 END), 0)`,
        accruedPaid: sql<string>`COALESCE(SUM(CASE WHEN ${expenses.status} = 'ACTIVE' AND ${expenses.source} = 'ACCRUAL' AND ${accrualObligations.status} = 'PAID' THEN ${expenses.amount} ELSE 0 END), 0)`,
        cancelled: sql<string>`COALESCE(SUM(CASE WHEN ${expenses.status} = 'CANCELLED' THEN ${expenses.amount} ELSE 0 END), 0)`,
        unknown: sql<string>`COALESCE(SUM(CASE WHEN ${expenses.status} = 'ACTIVE' AND ${expenses.source} <> 'STOCK' AND ${expenses.paymentMethod} = 'CASH' AND ${expenses.cashBucket} IS NULL THEN ${expenses.amount} ELSE 0 END), 0)`,
        needsAudit: sql<number>`COALESCE(SUM(CASE WHEN ${needsAuditSql} THEN 1 ELSE 0 END), 0)`,
        missingDescription: sql<number>`COALESCE(SUM(CASE WHEN TRIM(COALESCE(${expenses.description}, '')) = '' THEN 1 ELSE 0 END), 0)`,
        missingPayee: sql<number>`COALESCE(SUM(CASE WHEN ${missingPayeeSql} THEN 1 ELSE 0 END), 0)`,
        sourceMismatch: sql<number>`COALESCE(SUM(CASE WHEN ${financialIntegritySql} THEN 1 ELSE 0 END), 0)`,
        drawerMismatch: sql<number>`COALESCE(SUM(CASE WHEN ${expenses.cashBucket} = 'DRAWER' AND (${expenses.shiftId} IS NULL OR ${expenses.receiptId} IS NULL) THEN 1 ELSE 0 END), 0)`,
        count: sql<number>`COUNT(*)`,
      })
      .from(expenses)
      .leftJoin(receipts, eq(expenses.receiptId, receipts.id))
      .leftJoin(accrualObligations, eq(accrualObligations.expenseId, expenses.id))
      .where(baseWhere)
      .then((rows) => rows[0]),
  ]);

  return {
    rows: pageResult.rows.map(enrichExpenseRow),
    totals: {
      active: totalsRow?.active ?? "0.00",
      pendingApproval: totalsRow?.pendingApproval ?? "0.00",
      rejected: totalsRow?.rejected ?? "0.00",
      drawer: totalsRow?.drawer ?? "0.00",
      treasury: totalsRow?.treasury ?? "0.00",
      nonCash: totalsRow?.nonCash ?? "0.00",
      stock: totalsRow?.stock ?? "0.00",
      accruedUnpaid: totalsRow?.accruedUnpaid ?? "0.00",
      accruedPaid: totalsRow?.accruedPaid ?? "0.00",
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

  const obligationEvents = raw.accrualObligationId == null
    ? []
    : await db
        .select({
          id: accrualObligationEvents.id,
          eventType: accrualObligationEvents.eventType,
          amount: accrualObligationEvents.amount,
          receiptId: accrualObligationEvents.receiptId,
          accountingEntryId: accrualObligationEvents.accountingEntryId,
          evidenceReference: accrualObligationEvents.evidenceReference,
          actorId: accrualObligationEvents.actorId,
          reviewerId: accrualObligationEvents.reviewerId,
          createdAt: accrualObligationEvents.createdAt,
        })
        .from(accrualObligationEvents)
        .where(eq(accrualObligationEvents.obligationId, Number(raw.accrualObligationId)))
        .orderBy(asc(accrualObligationEvents.id));
  const obligationEntryIds = obligationEvents
    .map((event) => event.accountingEntryId == null ? null : Number(event.accountingEntryId))
    .filter((id): id is number => id != null);
  const ledgerWhere =
    obligationEntryIds.length > 0
      ? inArray(accountingEntries.id, obligationEntryIds)
      : raw.receiptId != null
      ? eq(accountingEntries.receiptId, Number(raw.receiptId))
      : raw.source === "STOCK" && raw.stockReason
        ? eq(accountingEntries.dedupeKey, `${raw.stockReason}:${expenseId}`)
        : eq(accountingEntries.id, -1);

  const [stockItems, ledgerEntries, auditTrail, reversalReceipts, correctionRequests] =
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
          postingProfile: accountingEntries.postingProfile,
          postingIntentJson: accountingEntries.postingIntentJson,
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
        .orderBy(asc(accountingEntries.id))
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
      raw.accrualObligationId == null
        ? Promise.resolve([])
        : db
            .select()
            .from(accrualCorrectionRequests)
            .where(eq(accrualCorrectionRequests.obligationId, Number(raw.accrualObligationId)))
            .orderBy(desc(accrualCorrectionRequests.id)),
    ]);

  return {
    expense,
    stockItems,
    ledgerEntries,
    obligationEvents,
    correctionRequests,
    auditTrail,
    reversalReceipts,
  };
}
