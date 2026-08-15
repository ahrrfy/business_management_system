import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { fullEmployeeName } from "@shared/hr";
import { isDupEntry } from "@shared/errorMap.ar";
import {
  accountingEntries,
  employeeAdvanceRepaymentAllocations,
  employeeAdvanceRepaymentRequests,
  employeeAdvances,
  employees,
  receipts,
  users,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import {
  assertCashOutAvailable,
  lockCashSourceForUpdate,
} from "../cash/cashAvailability";
import { baghdadToday } from "../businessDay";
import { postEntry } from "../ledgerService";
import { money, round2, toDateStr, toDbMoney } from "../money";
import { lockFinancialPostingGate } from "../reports/monthCloseGate";
import { assertPeriodOpen } from "../periodLockService";
import { requireDb, type Actor, withTx } from "../tx";
import {
  createPostingIntent,
  creditLine,
  debitLine,
  type AccountRole,
  type PostingProfile,
  type PostingSourceComponents,
} from "../accounting/postingEngine";
import { payrollHash } from "./helpers";
import { assertPayrollActiveOwnerChecker } from "./settlement";

export type AdvanceRepaymentRequestKind = "REPAYMENT" | "RETURN";
export type AdvanceRepaymentPaymentMethod = "CASH" | "CARD" | "TRANSFER" | "WALLET";

interface PaymentEvidenceInput {
  paymentMethod: AdvanceRepaymentPaymentMethod;
  cashBucket?: "DRAWER" | "TREASURY" | null;
  shiftId?: number | null;
  referenceNumber?: string | null;
  cardLastFour?: string | null;
  transactionDate: string;
  evidenceNote: string;
  clientRequestId: string;
}

export interface CreateAdvanceRepaymentInput extends PaymentEvidenceInput {
  employeeId: number;
  branchId: number;
  amount: string;
}

export interface CreateAdvanceRepaymentReturnInput extends PaymentEvidenceInput {
  originalRequestId: number;
}

export interface AdvanceRepaymentFilters {
  requestKind?: AdvanceRepaymentRequestKind;
  status?: "PENDING" | "APPROVED" | "REJECTED";
  employeeId?: number;
  branchId?: number;
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function transactionDate(value: string): string {
  const normalized = value.trim();
  const parsed = Date.parse(`${normalized}T00:00:00.000Z`);
  if (
    !YMD_RE.test(normalized) ||
    Number.isNaN(parsed) ||
    new Date(parsed).toISOString().slice(0, 10) !== normalized ||
    normalized > baghdadToday()
  ) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "تاريخ حركة سداد السلفة غير صالح أو مستقبلي." });
  }
  return normalized;
}

function clientRequestId(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 8 || normalized.length > 80 || !/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "مفتاح منع التكرار غير صالح." });
  }
  return normalized;
}

function evidenceNote(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 10 || normalized.length > 500) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "وصف دليل السداد يجب أن يكون بين 10 و500 محرف." });
  }
  return normalized;
}

function normalizeEvidence(input: PaymentEvidenceInput) {
  const method = input.paymentMethod;
  const referenceNumber = input.referenceNumber?.trim().toUpperCase() || null;
  const cardLastFour = input.cardLastFour?.trim() || null;
  if (method === "CASH") {
    if (input.cashBucket !== "DRAWER" || !Number.isInteger(input.shiftId) || Number(input.shiftId) <= 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "السداد النقدي يتطلب درج وردية مفتوحة محددة." });
    }
    if (referenceNumber || cardLastFour) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "السداد النقدي لا يحمل مرجعاً إلكترونياً أو أرقام بطاقة." });
    }
    return {
      paymentMethod: method,
      cashBucket: "DRAWER" as const,
      shiftId: Number(input.shiftId),
      referenceNumber: null,
      cardLastFour: null,
      transactionDate: transactionDate(input.transactionDate),
      evidenceNote: evidenceNote(input.evidenceNote),
      clientRequestId: clientRequestId(input.clientRequestId),
    };
  }
  if (input.cashBucket != null || input.shiftId != null) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الدفع غير النقدي لا يرتبط بدرج أو خزينة نقدية." });
  }
  if (!referenceNumber) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "مرجع التأكيد الخارجي مطلوب للدفع غير النقدي." });
  }
  if (method === "CARD") {
    if (!/^\d{4}$/.test(cardLastFour ?? "")) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "آخر أربعة أرقام للبطاقة مطلوبة بصيغة صحيحة." });
    }
  } else if (cardLastFour != null) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "أرقام البطاقة لا تُقبل مع التحويل أو المحفظة." });
  }
  return {
    paymentMethod: method,
    cashBucket: null,
    shiftId: null,
    referenceNumber,
    cardLastFour: method === "CARD" ? cardLastFour : null,
    transactionDate: transactionDate(input.transactionDate),
    evidenceNote: evidenceNote(input.evidenceNote),
    clientRequestId: clientRequestId(input.clientRequestId),
  };
}

async function assertActiveMaker(tx: Tx, actor: Actor, branchId: number): Promise<void> {
  const [row] = await tx
    .select({ isActive: users.isActive, isOwner: users.isOwner })
    .from(users)
    .where(eq(users.id, actor.userId))
    .for("share")
    .limit(1);
  if (!row?.isActive) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا ينشئ طلب سداد سلفة إلا مستخدم نشط." });
  }
  if (!row.isOwner && actor.role !== "admin" && Number(actor.branchId) !== branchId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا يجوز إنشاء طلب سداد سلفة لفرع آخر." });
  }
}

function canonicalPayload(input: {
  requestKind: AdvanceRepaymentRequestKind;
  employeeId: number;
  branchId: number;
  originalRequestId: number | null;
  amount: string;
  evidence: ReturnType<typeof normalizeEvidence>;
}) {
  return {
    version: 1,
    domain: "EMPLOYEE_ADVANCE_REPAYMENT_REQUEST" as const,
    requestKind: input.requestKind,
    employeeId: input.employeeId,
    branchId: input.branchId,
    originalRequestId: input.originalRequestId,
    amount: input.amount,
    paymentMethod: input.evidence.paymentMethod,
    cashBucket: input.evidence.cashBucket,
    shiftId: input.evidence.shiftId,
    referenceNumber: input.evidence.referenceNumber,
    cardLastFour: input.evidence.cardLastFour,
    transactionDate: input.evidence.transactionDate,
    evidenceNote: input.evidence.evidenceNote,
    clientRequestId: input.evidence.clientRequestId,
  };
}

async function createRequestTx(
  tx: Tx,
  input: {
    requestKind: AdvanceRepaymentRequestKind;
    employeeId: number;
    branchId: number;
    originalRequestId: number | null;
    amount: string;
    evidence: ReturnType<typeof normalizeEvidence>;
  },
  actor: Actor,
) {
  await assertActiveMaker(tx, actor, input.branchId);
  const amount = round2(money(input.amount));
  if (!amount.isFinite() || amount.lte(0)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "مبلغ سداد السلفة يجب أن يكون موجباً." });
  }
  const [employee] = await tx
    .select({ id: employees.id })
    .from(employees)
    .where(eq(employees.id, input.employeeId))
    .for("share")
    .limit(1);
  if (!employee) throw new TRPCError({ code: "NOT_FOUND", message: "الموظف غير موجود." });

  const normalizedAmount = toDbMoney(amount);
  const canonical = canonicalPayload({ ...input, amount: normalizedAmount });
  const sourceHash = payrollHash(canonical);
  const evidenceHash = payrollHash({
    version: canonical.version,
    employeeId: canonical.employeeId,
    branchId: canonical.branchId,
    paymentMethod: canonical.paymentMethod,
    cashBucket: canonical.cashBucket,
    shiftId: canonical.shiftId,
    referenceNumber: canonical.referenceNumber,
    cardLastFour: canonical.cardLastFour,
    transactionDate: canonical.transactionDate,
    evidenceNote: canonical.evidenceNote,
  });
  const sourceKey = `ADVREP:${input.requestKind}:${input.evidence.clientRequestId}`;
  const [existing] = await tx
    .select()
    .from(employeeAdvanceRepaymentRequests)
    .where(eq(employeeAdvanceRepaymentRequests.sourceKey, sourceKey))
    .for("update")
    .limit(1);
  if (existing) {
    if (existing.sourceHash !== sourceHash) {
      throw new TRPCError({ code: "CONFLICT", message: "مفتاح الطلب مستعمل بمحتوى مختلف." });
    }
    return { ...existing, replayed: true };
  }
  try {
    const result = await tx.insert(employeeAdvanceRepaymentRequests).values({
      requestKind: input.requestKind,
      employeeId: input.employeeId,
      branchId: input.branchId,
      originalRequestId: input.originalRequestId,
      amount: normalizedAmount,
      ...input.evidence,
      transactionDate: new Date(`${input.evidence.transactionDate}T00:00:00.000Z`),
      sourceKey,
      sourceHash,
      evidenceHash,
      createdBy: actor.userId,
    });
    const id = extractInsertId(result);
    return { id, ...canonical, status: "PENDING" as const, sourceKey, sourceHash, evidenceHash, createdBy: actor.userId, replayed: false };
  } catch (error) {
    if (!isDupEntry(error)) throw error;
    const [concurrent] = await tx
      .select()
      .from(employeeAdvanceRepaymentRequests)
      .where(eq(employeeAdvanceRepaymentRequests.sourceKey, sourceKey))
      .limit(1);
    if (concurrent?.sourceHash === sourceHash) return { ...concurrent, replayed: true };
    throw new TRPCError({ code: "CONFLICT", message: "مرجع التأكيد أو مفتاح الطلب مستعمل لحركة أخرى." });
  }
}

export async function createAdvanceRepaymentRequest(input: CreateAdvanceRepaymentInput, actor: Actor) {
  const evidence = normalizeEvidence(input);
  return withTx(async (tx) => {
    const amount = round2(money(input.amount));
    if (!amount.isFinite() || amount.lte(0)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "مبلغ سداد السلفة يجب أن يكون موجباً." });
    }
    const [replayCandidate] = await tx
      .select({ id: employeeAdvanceRepaymentRequests.id })
      .from(employeeAdvanceRepaymentRequests)
      .where(eq(employeeAdvanceRepaymentRequests.sourceKey, `ADVREP:REPAYMENT:${evidence.clientRequestId}`))
      .limit(1);
    if (replayCandidate) {
      return createRequestTx(tx, {
        requestKind: "REPAYMENT",
        employeeId: input.employeeId,
        branchId: input.branchId,
        originalRequestId: null,
        amount: toDbMoney(amount),
        evidence,
      }, actor);
    }
    await lockFinancialPostingGate(tx);
    await assertPeriodOpen(tx, new Date(`${evidence.transactionDate}T12:00:00.000Z`));
    {
      const advances = await tx
        .select({ remaining: employeeAdvances.remaining })
        .from(employeeAdvances)
        .where(and(
          eq(employeeAdvances.employeeId, input.employeeId),
          eq(employeeAdvances.branchId, input.branchId),
          eq(employeeAdvances.status, "ACTIVE"),
        ));
      const outstanding = advances.reduce((sum, row) => sum.plus(money(row.remaining)), money(0));
      if (outstanding.lt(amount)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "مبلغ السداد يتجاوز رصيد سلف الموظف في الفرع." });
      }
    }
    return createRequestTx(tx, {
      requestKind: "REPAYMENT",
      employeeId: input.employeeId,
      branchId: input.branchId,
      originalRequestId: null,
      amount: toDbMoney(amount),
      evidence,
    }, actor);
  });
}

export async function createAdvanceRepaymentReturnRequest(input: CreateAdvanceRepaymentReturnInput, actor: Actor) {
  const evidence = normalizeEvidence(input);
  return withTx(async (tx) => {
    await lockFinancialPostingGate(tx);
    const [original] = await tx
      .select()
      .from(employeeAdvanceRepaymentRequests)
      .where(eq(employeeAdvanceRepaymentRequests.id, input.originalRequestId))
      .for("update")
      .limit(1);
    if (!original || original.requestKind !== "REPAYMENT" || original.status !== "APPROVED") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يُعكس إلا طلب سداد معتمد." });
    }
    const requestInput = {
      requestKind: "RETURN" as const,
      employeeId: Number(original.employeeId),
      branchId: Number(original.branchId),
      originalRequestId: Number(original.id),
      amount: original.amount,
      evidence,
    };
    const [replayCandidate] = await tx
      .select({ id: employeeAdvanceRepaymentRequests.id })
      .from(employeeAdvanceRepaymentRequests)
      .where(eq(
        employeeAdvanceRepaymentRequests.sourceKey,
        `ADVREP:RETURN:${evidence.clientRequestId}`,
      ))
      .limit(1);
    if (replayCandidate) return createRequestTx(tx, requestInput, actor);
    await assertPeriodOpen(tx, new Date(`${evidence.transactionDate}T12:00:00.000Z`));
    const [activeReturn] = await tx
      .select({ id: employeeAdvanceRepaymentRequests.id })
      .from(employeeAdvanceRepaymentRequests)
      .where(and(
        eq(employeeAdvanceRepaymentRequests.originalRequestId, Number(original.id)),
        eq(employeeAdvanceRepaymentRequests.requestKind, "RETURN"),
        inArray(employeeAdvanceRepaymentRequests.status, ["PENDING", "APPROVED"]),
      ))
      .for("update")
      .limit(1);
    if (activeReturn) {
      throw new TRPCError({ code: "CONFLICT", message: "يوجد طلب إعادة قائم لهذا السداد." });
    }
    return createRequestTx(tx, requestInput, actor);
  });
}

function paymentAssetRole(method: AdvanceRepaymentPaymentMethod): Extract<AccountRole, "CASH" | "CARD_BANK" | "PAYMENT_WALLET"> {
  if (method === "CASH") return "CASH";
  if (method === "WALLET") return "PAYMENT_WALLET";
  return "CARD_BANK";
}

export function advanceRepaymentPosting(input: {
  requestKind: AdvanceRepaymentRequestKind;
  paymentMethod: AdvanceRepaymentPaymentMethod;
  amount: string;
}) {
  const amount = money(input.amount);
  const asset = paymentAssetRole(input.paymentMethod);
  const repayment = input.requestKind === "REPAYMENT";
  const profile: PostingProfile = repayment
    ? "PAYMENT_IN_EMPLOYEE_ADVANCE_REPAYMENT"
    : "PAYMENT_OUT_EMPLOYEE_ADVANCE_REPAYMENT_RETURN";
  const entryType = repayment ? "PAYMENT_IN" as const : "PAYMENT_OUT" as const;
  const debit = repayment ? asset : "EMPLOYEE_ADVANCES" as const;
  const credit = repayment ? "EMPLOYEE_ADVANCES" as const : asset;
  const source: PostingSourceComponents = {
    roleDebits: { [debit]: toDbMoney(amount) },
    roleCredits: { [credit]: toDbMoney(amount) },
  };
  return {
    amount,
    profile,
    entryType,
    source,
    intent: createPostingIntent(profile, entryType, [debitLine(debit, amount), creditLine(credit, amount)], source),
  };
}

async function materializeReceiptAndEntry(
  tx: Tx,
  request: typeof employeeAdvanceRepaymentRequests.$inferSelect,
  employeeName: string,
  actor: Actor,
) {
  const incoming = request.requestKind === "REPAYMENT";
  const movementDate = toDateStr(request.transactionDate);
  const receiptResult = await tx.insert(receipts).values({
    branchId: Number(request.branchId),
    shiftId: request.shiftId == null ? null : Number(request.shiftId),
    cashBucket: request.cashBucket,
    direction: incoming ? "IN" : "OUT",
    amount: request.amount,
    paymentMethod: request.paymentMethod,
    referenceNumber: request.referenceNumber,
    cardLastFour: request.cardLastFour,
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    approvedBy: actor.userId,
    approvedAt: new Date(),
    voucherNumber: `ADVREP-${incoming ? "IN" : "OUT"}-${request.id}`,
    partyType: "OTHER",
    partyId: null,
    counterpartyName: employeeName,
    voucherDate: new Date(`${movementDate}T00:00:00.000Z`),
    description: incoming ? `سداد سلفة الموظف ${employeeName}` : `إعادة سداد سلفة إلى الموظف ${employeeName}`,
    internalNote: JSON.stringify({
      version: 1,
      kind: "EMPLOYEE_ADVANCE_REPAYMENT",
      requestId: Number(request.id),
      requestKind: request.requestKind,
      employeeId: Number(request.employeeId),
      sourceHash: request.sourceHash,
      evidenceHash: request.evidenceHash,
    }),
    createdBy: actor.userId,
  });
  const receiptId = extractInsertId(receiptResult);
  const posting = advanceRepaymentPosting(request);
  const sourceKey = `ADVREP:ENTRY:${request.id}`;
  const occurredAt = new Date(`${movementDate}T12:00:00.000Z`);
  await postEntry(tx, {
    entryType: posting.entryType,
    branchId: Number(request.branchId),
    receiptId,
    amount: posting.amount,
    revenue: money(0),
    cost: money(0),
    profit: money(0),
    entryDate: occurredAt,
    dedupeKey: sourceKey,
    notes: incoming ? `سداد سلفة موظف — ${employeeName}` : `إعادة سداد سلفة موظف — ${employeeName}`,
    createdBy: actor.userId,
    paymentMethod: request.paymentMethod,
    postingIntent: posting.intent,
    postingSourceComponents: posting.source,
  });
  const [entry] = await tx
    .select({ id: accountingEntries.id })
    .from(accountingEntries)
    .where(eq(accountingEntries.dedupeKey, sourceKey))
    .limit(1);
  if (!entry) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر ربط سداد السلفة بقيده المحاسبي." });
  return { receiptId, accountingEntryId: Number(entry.id), occurredAt };
}

export async function approveAdvanceRepaymentRequest(id: number, actor: Actor) {
  return withTx(async (tx) => {
    const [preview] = await tx
      .select()
      .from(employeeAdvanceRepaymentRequests)
      .where(eq(employeeAdvanceRepaymentRequests.id, id))
      .limit(1);
    if (!preview) throw new TRPCError({ code: "NOT_FOUND", message: "طلب سداد السلفة غير موجود." });
    // Global close/materialization order: posting gate → cash source → owner → request.
    // The later postEntry call reacquires the shared gate reentrantly.
    await lockFinancialPostingGate(tx);
    const [originalPreview] = preview.requestKind === "RETURN" && preview.originalRequestId != null
      ? await tx
          .select({
            id: employeeAdvanceRepaymentRequests.id,
            createdBy: employeeAdvanceRepaymentRequests.createdBy,
            reviewedBy: employeeAdvanceRepaymentRequests.reviewedBy,
          })
          .from(employeeAdvanceRepaymentRequests)
          .where(eq(employeeAdvanceRepaymentRequests.id, Number(preview.originalRequestId)))
          .limit(1)
      : [undefined];
    const forbiddenReviewers = [
      preview.createdBy,
      originalPreview?.createdBy,
      originalPreview?.reviewedBy,
    ];
    if (preview.status === "APPROVED") {
      await assertPayrollActiveOwnerChecker(
        tx,
        actor,
        forbiddenReviewers,
        "إعادة محاولة اعتماد سداد السلفة",
      );
      const [approved] = await tx
        .select()
        .from(employeeAdvanceRepaymentRequests)
        .where(eq(employeeAdvanceRepaymentRequests.id, id))
        .for("update")
        .limit(1);
      if (
        !approved ||
        approved.status !== "APPROVED" ||
        approved.sourceHash !== preview.sourceHash ||
        approved.receiptId == null ||
        approved.accountingEntryId == null
      ) {
        throw new TRPCError({ code: "CONFLICT", message: "طلب السداد المعتمد بلا أثر مالي كامل أو تغير أثناء الإعادة." });
      }
      return { ...approved, replayed: true };
    }
    if (preview.paymentMethod === "CASH") {
      await lockCashSourceForUpdate(tx, {
        branchId: Number(preview.branchId),
        cashBucket: "DRAWER",
        shiftId: Number(preview.shiftId),
      });
    }
    await assertPayrollActiveOwnerChecker(
      tx,
      actor,
      forbiddenReviewers,
      "اعتماد سداد السلفة",
    );
    const [request] = await tx
      .select()
      .from(employeeAdvanceRepaymentRequests)
      .where(eq(employeeAdvanceRepaymentRequests.id, id))
      .for("update")
      .limit(1);
    if (!request || request.sourceHash !== preview.sourceHash) {
      throw new TRPCError({ code: "CONFLICT", message: "تغير طلب سداد السلفة أثناء الاعتماد." });
    }
    if (request.status === "APPROVED") {
      if (request.receiptId == null || request.accountingEntryId == null) {
        throw new TRPCError({ code: "CONFLICT", message: "طلب سداد معتمد بلا أثر مالي كامل." });
      }
      return { ...request, replayed: true };
    }
    if (request.status !== "PENDING") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يعتمد إلا طلب سداد معلق." });
    }
    const [employee] = await tx
      .select({
        firstName: employees.firstName,
        fatherName: employees.fatherName,
        grandfatherName: employees.grandfatherName,
        lastName: employees.lastName,
      })
      .from(employees)
      .where(eq(employees.id, Number(request.employeeId)))
      .for("share")
      .limit(1);
    if (!employee) throw new TRPCError({ code: "CONFLICT", message: "موظف طلب سداد السلفة مفقود." });
    const employeeName = fullEmployeeName(employee) || `موظف #${request.employeeId}`;

    let applyAdvances: Array<typeof employeeAdvances.$inferSelect> = [];
    let reverseAllocations: Array<typeof employeeAdvanceRepaymentAllocations.$inferSelect> = [];
    let originalReceiptId: number | null = null;
    if (request.requestKind === "REPAYMENT") {
      applyAdvances = await tx
        .select()
        .from(employeeAdvances)
        .where(and(
          eq(employeeAdvances.employeeId, Number(request.employeeId)),
          eq(employeeAdvances.branchId, Number(request.branchId)),
          eq(employeeAdvances.status, "ACTIVE"),
        ))
        .orderBy(asc(employeeAdvances.id))
        .for("update");
      const outstanding = applyAdvances.reduce((sum, row) => sum.plus(money(row.remaining)), money(0));
      if (outstanding.lt(money(request.amount))) {
        throw new TRPCError({ code: "CONFLICT", message: "رصيد السلف تغير وأصبح أقل من مبلغ الطلب؛ ارفض الطلب وأنشئ آخر." });
      }
    } else {
      const [original] = await tx
        .select()
        .from(employeeAdvanceRepaymentRequests)
        .where(eq(employeeAdvanceRepaymentRequests.id, Number(request.originalRequestId)))
        .for("update")
        .limit(1);
      if (
        !original || original.requestKind !== "REPAYMENT" || original.status !== "APPROVED" ||
        Number(original.employeeId) !== Number(request.employeeId) ||
        Number(original.branchId) !== Number(request.branchId) ||
        !money(original.amount).eq(money(request.amount)) || original.receiptId == null
      ) {
        throw new TRPCError({ code: "CONFLICT", message: "أصل إعادة السداد غير متطابق أو غير مكتمل." });
      }
      const [otherApprovedReturn] = await tx
        .select({ id: employeeAdvanceRepaymentRequests.id })
        .from(employeeAdvanceRepaymentRequests)
        .where(and(
          eq(employeeAdvanceRepaymentRequests.originalRequestId, Number(original.id)),
          eq(employeeAdvanceRepaymentRequests.requestKind, "RETURN"),
          eq(employeeAdvanceRepaymentRequests.status, "APPROVED"),
          ne(employeeAdvanceRepaymentRequests.id, Number(request.id)),
        ))
        .limit(1);
      if (otherApprovedReturn) throw new TRPCError({ code: "CONFLICT", message: "سداد السلفة أُعيد فعلياً من قبل." });
      const allocationPreview = await tx
        .select({
          id: employeeAdvanceRepaymentAllocations.id,
          advanceId: employeeAdvanceRepaymentAllocations.advanceId,
        })
        .from(employeeAdvanceRepaymentAllocations)
        .where(and(
          eq(employeeAdvanceRepaymentAllocations.requestId, Number(original.id)),
          eq(employeeAdvanceRepaymentAllocations.direction, "APPLY"),
        ));
      const advanceIds = Array.from(new Set(allocationPreview.map((row) => Number(row.advanceId))))
        .sort((a, b) => a - b);
      applyAdvances = advanceIds.length > 0
        ? await tx
            .select()
            .from(employeeAdvances)
            .where(inArray(employeeAdvances.id, advanceIds))
            .orderBy(asc(employeeAdvances.id))
            .for("update")
        : [];
      reverseAllocations = await tx
        .select()
        .from(employeeAdvanceRepaymentAllocations)
        .where(and(
          eq(employeeAdvanceRepaymentAllocations.requestId, Number(original.id)),
          eq(employeeAdvanceRepaymentAllocations.direction, "APPLY"),
        ))
        .orderBy(
          asc(employeeAdvanceRepaymentAllocations.advanceId),
          asc(employeeAdvanceRepaymentAllocations.id),
        )
        .for("update");
      if (
        reverseAllocations.length !== allocationPreview.length ||
        applyAdvances.length !== advanceIds.length
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "تغيّرت سلف أو تخصيصات السداد أثناء اعتماد الإعادة؛ أعد المحاولة.",
        });
      }
      const total = reverseAllocations.reduce((sum, row) => sum.plus(money(row.amount)), money(0));
      if (!total.eq(money(request.amount)) || reverseAllocations.length === 0) {
        throw new TRPCError({ code: "CONFLICT", message: "تخصيصات السداد الأصلي ناقصة أو غير متوازنة." });
      }
      originalReceiptId = Number(original.receiptId);
      const [originalReceipt] = await tx
        .select({ status: receipts.status })
        .from(receipts)
        .where(eq(receipts.id, originalReceiptId))
        .for("update")
        .limit(1);
      if (!originalReceipt || originalReceipt.status !== "COMPLETED") {
        throw new TRPCError({ code: "CONFLICT", message: "إيصال السداد الأصلي غير صالح للإعادة." });
      }
      if (request.paymentMethod === "CASH") {
        await assertCashOutAvailable(tx, {
          branchId: Number(request.branchId),
          cashBucket: "DRAWER",
          shiftId: Number(request.shiftId),
          amount: request.amount,
          operation: "إعادة سداد سلفة الموظف",
        });
      }
    }

    const materialized = await materializeReceiptAndEntry(tx, request, employeeName, actor);
    if (request.requestKind === "REPAYMENT") {
      let left = money(request.amount);
      for (const advance of applyAdvances) {
        if (left.lte(0)) break;
        const before = money(advance.remaining);
        if (before.lte(0)) continue;
        const applied = round2(before.lt(left) ? before : left);
        const after = round2(before.minus(applied));
        left = round2(left.minus(applied));
        await tx.update(employeeAdvances).set({
          remaining: toDbMoney(after),
          status: after.isZero() ? "SETTLED" : "ACTIVE",
        }).where(eq(employeeAdvances.id, Number(advance.id)));
        await tx.insert(employeeAdvanceRepaymentAllocations).values({
          requestId: Number(request.id),
          advanceId: Number(advance.id),
          direction: "APPLY",
          amount: toDbMoney(applied),
          receiptId: materialized.receiptId,
          accountingEntryId: materialized.accountingEntryId,
          sourceKey: `ADVREP:ALLOC:${request.id}:${advance.id}`,
          occurredAt: materialized.occurredAt,
          createdBy: actor.userId,
        });
      }
      if (!left.isZero()) throw new TRPCError({ code: "CONFLICT", message: "تعذر تخصيص كامل مبلغ السداد على السلف." });
    } else {
      const advancesById = new Map(applyAdvances.map((row) => [Number(row.id), row]));
      for (const allocation of reverseAllocations) {
        const advance = advancesById.get(Number(allocation.advanceId));
        if (!advance) throw new TRPCError({ code: "CONFLICT", message: "سلفة تخصيص الإعادة مفقودة." });
        const restored = round2(money(advance.remaining).plus(money(allocation.amount)));
        if (restored.gt(money(advance.amount))) {
          throw new TRPCError({ code: "CONFLICT", message: "إعادة السداد تتجاوز أصل السلفة." });
        }
        await tx.update(employeeAdvances).set({ remaining: toDbMoney(restored), status: "ACTIVE" })
          .where(eq(employeeAdvances.id, Number(advance.id)));
        await tx.insert(employeeAdvanceRepaymentAllocations).values({
          requestId: Number(request.id),
          advanceId: Number(advance.id),
          direction: "REVERSE",
          amount: allocation.amount,
          reversalOfId: Number(allocation.id),
          receiptId: materialized.receiptId,
          accountingEntryId: materialized.accountingEntryId,
          sourceKey: `ADVREP:ALLOC-REV:${request.id}:${allocation.id}`,
          occurredAt: materialized.occurredAt,
          createdBy: actor.userId,
        });
      }
      await tx.update(receipts).set({ status: "REVERSED" }).where(eq(receipts.id, originalReceiptId!));
    }

    const reviewedAt = new Date();
    await tx.update(employeeAdvanceRepaymentRequests).set({
      status: "APPROVED",
      receiptId: materialized.receiptId,
      accountingEntryId: materialized.accountingEntryId,
      reviewedBy: actor.userId,
      reviewedAt,
    }).where(eq(employeeAdvanceRepaymentRequests.id, Number(request.id)));
    return {
      ...request,
      status: "APPROVED" as const,
      receiptId: materialized.receiptId,
      accountingEntryId: materialized.accountingEntryId,
      reviewedBy: actor.userId,
      reviewedAt,
      replayed: false,
    };
  });
}

export async function rejectAdvanceRepaymentRequest(id: number, reason: string, actor: Actor) {
  const normalizedReason = reason.trim();
  if (normalizedReason.length < 5 || normalizedReason.length > 255) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "سبب الرفض يجب أن يكون بين 5 و255 محرفاً." });
  }
  return withTx(async (tx) => {
    const [preview] = await tx
      .select()
      .from(employeeAdvanceRepaymentRequests)
      .where(eq(employeeAdvanceRepaymentRequests.id, id))
      .limit(1);
    if (!preview) throw new TRPCError({ code: "NOT_FOUND", message: "طلب سداد السلفة غير موجود." });
    const [original] = preview.requestKind === "RETURN" && preview.originalRequestId != null
      ? await tx
          .select({
            createdBy: employeeAdvanceRepaymentRequests.createdBy,
            reviewedBy: employeeAdvanceRepaymentRequests.reviewedBy,
          })
          .from(employeeAdvanceRepaymentRequests)
          .where(eq(employeeAdvanceRepaymentRequests.id, Number(preview.originalRequestId)))
          .limit(1)
      : [undefined];
    await assertPayrollActiveOwnerChecker(
      tx,
      actor,
      [preview.createdBy, original?.createdBy, original?.reviewedBy],
      "رفض سداد السلفة",
    );
    const [request] = await tx
      .select()
      .from(employeeAdvanceRepaymentRequests)
      .where(eq(employeeAdvanceRepaymentRequests.id, id))
      .for("update")
      .limit(1);
    if (!request || request.sourceHash !== preview.sourceHash) {
      throw new TRPCError({ code: "CONFLICT", message: "تغير طلب سداد السلفة أثناء الرفض." });
    }
    if (request.status === "REJECTED") {
      if (request.rejectionReason !== normalizedReason) {
        throw new TRPCError({ code: "CONFLICT", message: "سبب إعادة المحاولة لا يطابق السبب المحفوظ." });
      }
      return { ...request, replayed: true };
    }
    if (request.status !== "PENDING") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يرفض إلا طلب سداد معلق." });
    }
    const reviewedAt = new Date();
    await tx.update(employeeAdvanceRepaymentRequests).set({
      status: "REJECTED",
      reviewedBy: actor.userId,
      reviewedAt,
      rejectionReason: normalizedReason,
    }).where(eq(employeeAdvanceRepaymentRequests.id, id));
    return { ...request, status: "REJECTED" as const, reviewedBy: actor.userId, reviewedAt, rejectionReason: normalizedReason, replayed: false };
  });
}

export async function listAdvanceRepaymentRequests(filters?: AdvanceRepaymentFilters) {
  if (filters?.branchId != null && (!Number.isInteger(filters.branchId) || filters.branchId <= 0)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "نطاق الفرع مطلوب." });
  }
  const where = [
    filters?.requestKind ? eq(employeeAdvanceRepaymentRequests.requestKind, filters.requestKind) : undefined,
    filters?.status ? eq(employeeAdvanceRepaymentRequests.status, filters.status) : undefined,
    filters?.employeeId ? eq(employeeAdvanceRepaymentRequests.employeeId, filters.employeeId) : undefined,
    filters?.branchId != null ? eq(employeeAdvanceRepaymentRequests.branchId, filters.branchId) : undefined,
  ].filter(Boolean) as ReturnType<typeof eq>[];
  return requireDb()
    .select({
      id: employeeAdvanceRepaymentRequests.id,
      requestKind: employeeAdvanceRepaymentRequests.requestKind,
      status: employeeAdvanceRepaymentRequests.status,
      employeeId: employeeAdvanceRepaymentRequests.employeeId,
      branchId: employeeAdvanceRepaymentRequests.branchId,
      originalRequestId: employeeAdvanceRepaymentRequests.originalRequestId,
      amount: employeeAdvanceRepaymentRequests.amount,
      paymentMethod: employeeAdvanceRepaymentRequests.paymentMethod,
      cashBucket: employeeAdvanceRepaymentRequests.cashBucket,
      shiftId: employeeAdvanceRepaymentRequests.shiftId,
      referenceNumber: employeeAdvanceRepaymentRequests.referenceNumber,
      cardLastFour: employeeAdvanceRepaymentRequests.cardLastFour,
      transactionDate: employeeAdvanceRepaymentRequests.transactionDate,
      evidenceNote: employeeAdvanceRepaymentRequests.evidenceNote,
      sourceHash: employeeAdvanceRepaymentRequests.sourceHash,
      evidenceHash: employeeAdvanceRepaymentRequests.evidenceHash,
      receiptId: employeeAdvanceRepaymentRequests.receiptId,
      accountingEntryId: employeeAdvanceRepaymentRequests.accountingEntryId,
      createdBy: employeeAdvanceRepaymentRequests.createdBy,
      reviewedBy: employeeAdvanceRepaymentRequests.reviewedBy,
      reviewedAt: employeeAdvanceRepaymentRequests.reviewedAt,
      rejectionReason: employeeAdvanceRepaymentRequests.rejectionReason,
      createdAt: employeeAdvanceRepaymentRequests.createdAt,
      firstName: employees.firstName,
      fatherName: employees.fatherName,
      grandfatherName: employees.grandfatherName,
      lastName: employees.lastName,
    })
    .from(employeeAdvanceRepaymentRequests)
    .leftJoin(employees, eq(employeeAdvanceRepaymentRequests.employeeId, employees.id))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(employeeAdvanceRepaymentRequests.id))
    .then((rows) => rows.map((row) => ({ ...row, employeeName: fullEmployeeName(row) })));
}

export async function getAdvanceRepaymentRequest(id: number, branchId?: number) {
  const db = requireDb();
  if (branchId != null && (!Number.isInteger(branchId) || branchId <= 0)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "نطاق الفرع مطلوب." });
  }
  const rows = await db
    .select({
      request: employeeAdvanceRepaymentRequests,
      firstName: employees.firstName,
      fatherName: employees.fatherName,
      grandfatherName: employees.grandfatherName,
      lastName: employees.lastName,
    })
    .from(employeeAdvanceRepaymentRequests)
    .leftJoin(employees, eq(employeeAdvanceRepaymentRequests.employeeId, employees.id))
    .where(and(
      eq(employeeAdvanceRepaymentRequests.id, id),
      branchId != null ? eq(employeeAdvanceRepaymentRequests.branchId, branchId) : undefined,
    ))
    .limit(1);
  if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "طلب سداد السلفة غير موجود ضمن النطاق." });
  const allocations = await db
    .select()
    .from(employeeAdvanceRepaymentAllocations)
    .where(eq(employeeAdvanceRepaymentAllocations.requestId, id))
    .orderBy(asc(employeeAdvanceRepaymentAllocations.id));
  const row = rows[0];
  return {
    ...row.request,
    employeeName: fullEmployeeName(row),
    allocations,
  };
}

export async function listAdvanceRepaymentLedger(filters?: Omit<AdvanceRepaymentFilters, "status">) {
  const requests = await listAdvanceRepaymentRequests({ ...filters, status: "APPROVED" });
  if (requests.length === 0) return [];
  const allocations = await requireDb()
    .select()
    .from(employeeAdvanceRepaymentAllocations)
    .where(inArray(employeeAdvanceRepaymentAllocations.requestId, requests.map((row) => Number(row.id))))
    .orderBy(asc(employeeAdvanceRepaymentAllocations.id));
  const byRequest = new Map<number, typeof allocations>();
  for (const allocation of allocations) {
    const list = byRequest.get(Number(allocation.requestId)) ?? [];
    list.push(allocation);
    byRequest.set(Number(allocation.requestId), list);
  }
  return requests.map((request) => ({ ...request, allocations: byRequest.get(Number(request.id)) ?? [] }));
}
