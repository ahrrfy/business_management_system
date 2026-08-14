import { TRPCError } from "@trpc/server";
import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import {
  accountingEntries,
  branches,
  expenses,
  receipts,
  shifts,
  users,
} from "../../../drizzle/schema";
import { getDb } from "../../db";
import { utcDayStart, utcNextDayStart } from "../businessDay";
import { money, toDbMoney } from "../money";
import { analyzeCashRemediation } from "./classifier";
import type {
  CashRemediationFilters,
  CashRemediationReport,
  RawRemediationExpense,
  RawRemediationReceipt,
} from "./types";

const MAX_SHIFTS = 500;

/**
 * تقرير تشخيص تاريخي فقط. لا transaction ولا insert/update/delete ولا استدعاء خدمة ترحيل.
 * حدود التاريخ واجبة، والحد الأعلى يمنع مسحاً غير محدود لجدول الورديات.
 */
export async function getCashRemediationDryRun(
  filters: CashRemediationFilters,
): Promise<CashRemediationReport> {
  const db = getDb();
  if (!db) throw new Error("قاعدة البيانات غير متاحة");

  const conditions = [
    gte(shifts.openedAt, utcDayStart(filters.from)),
    lt(shifts.openedAt, utcNextDayStart(filters.to)),
  ];
  if (filters.branchId != null) conditions.push(eq(shifts.branchId, filters.branchId));
  if (filters.shiftIds?.length) conditions.push(inArray(shifts.id, filters.shiftIds));
  if (filters.userIds?.length) conditions.push(inArray(shifts.userId, filters.userIds));

  const shiftRows = await db
    .select({
      id: shifts.id,
      branchId: shifts.branchId,
      branchName: branches.name,
      userId: shifts.userId,
      userName: users.name,
      shiftType: shifts.shiftType,
      status: shifts.status,
      openingBalance: shifts.openingBalance,
      expectedCash: shifts.expectedCash,
      countedCash: shifts.countedCash,
      variance: shifts.variance,
      openedAt: shifts.openedAt,
      closedAt: shifts.closedAt,
    })
    .from(shifts)
    .innerJoin(branches, eq(shifts.branchId, branches.id))
    .innerJoin(users, eq(shifts.userId, users.id))
    .where(and(...conditions))
    .orderBy(asc(shifts.openedAt), asc(shifts.id))
    .limit(MAX_SHIFTS + 1);

  if (shiftRows.length > MAX_SHIFTS) {
    throw new TRPCError({
      code: "PAYLOAD_TOO_LARGE",
      message: `النطاق يعيد أكثر من ${MAX_SHIFTS} وردية؛ ضيّق الفترة أو حدّد الموظفين/الورديات.`,
    });
  }

  const shiftIds = shiftRows.map((row) => Number(row.id));
  if (shiftIds.length === 0) {
    return analyzeCashRemediation({ shifts: [], receipts: [] }, filters);
  }

  const receiptRows = await db
    .select({
      id: receipts.id,
      shiftId: receipts.shiftId,
      branchId: receipts.branchId,
      direction: receipts.direction,
      amount: receipts.amount,
      paymentMethod: receipts.paymentMethod,
      cashBucket: receipts.cashBucket,
      referenceNumber: receipts.referenceNumber,
      voucherNumber: receipts.voucherNumber,
      invoiceId: receipts.invoiceId,
      workOrderId: receipts.workOrderId,
      reservationId: receipts.reservationId,
      partyType: receipts.partyType,
      partyId: receipts.partyId,
      counterpartyName: receipts.counterpartyName,
      description: receipts.description,
      attachmentUrl: receipts.attachmentUrl,
      status: receipts.status,
      approvalStatus: receipts.approvalStatus,
      createdBy: receipts.createdBy,
      createdAt: receipts.createdAt,
    })
    .from(receipts)
    .where(inArray(receipts.shiftId, shiftIds))
    .orderBy(asc(receipts.createdAt), asc(receipts.id));

  const receiptIds = receiptRows.map((row) => Number(row.id));
  const [expenseRows, entryRows] = receiptIds.length
    ? await Promise.all([
        db
          .select({
            id: expenses.id,
            receiptId: expenses.receiptId,
            amount: expenses.amount,
            paymentMethod: expenses.paymentMethod,
            cashBucket: expenses.cashBucket,
            status: expenses.status,
            category: expenses.category,
            description: expenses.description,
            referenceNumber: expenses.referenceNumber,
            payee: expenses.payee,
          })
          .from(expenses)
          .where(inArray(expenses.receiptId, receiptIds))
          .orderBy(asc(expenses.id)),
        db
          .select({
            id: accountingEntries.id,
            receiptId: accountingEntries.receiptId,
            entryType: accountingEntries.entryType,
          })
          .from(accountingEntries)
          .where(inArray(accountingEntries.receiptId, receiptIds)),
      ])
    : [[], []];

  const expenseByReceipt = new Map<number, RawRemediationExpense>();
  const expenseIdsByReceipt = new Map<number, number[]>();
  for (const row of expenseRows) {
    if (row.receiptId == null) continue;
    const receiptId = Number(row.receiptId);
    const linkedIds = expenseIdsByReceipt.get(receiptId) ?? [];
    linkedIds.push(Number(row.id));
    expenseIdsByReceipt.set(receiptId, linkedIds);
    if (expenseByReceipt.has(receiptId)) continue;
    expenseByReceipt.set(receiptId, {
      id: Number(row.id),
      receiptId: Number(row.receiptId),
      amount: row.amount,
      paymentMethod: row.paymentMethod,
      cashBucket: row.cashBucket,
      status: row.status,
      category: row.category,
      description: row.description,
      referenceNumber: row.referenceNumber,
      payee: row.payee,
    });
  }

  const entriesByReceipt = new Map<number, Array<{ id: number; entryType: string }>>();
  for (const row of entryRows) {
    if (row.receiptId == null) continue;
    const key = Number(row.receiptId);
    const current = entriesByReceipt.get(key) ?? [];
    current.push({ id: Number(row.id), entryType: row.entryType });
    entriesByReceipt.set(key, current);
  }

  const actorIds = Array.from(
    new Set(
      receiptRows
        .map((row) => row.createdBy)
        .filter((id): id is number => id != null),
    ),
  );
  const actorRows = actorIds.length
    ? await db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(inArray(users.id, actorIds))
    : [];
  const actorNameById = new Map(actorRows.map((row) => [Number(row.id), row.name]));

  // إثبات النقل الداخلي مطابق لتقرير الوردية: بادئة CH/CD وحدها لا تكفي، بل يلزم
  // إيصال IN نقد/خزينة مطابق في الفرع والمرجع والمبلغ، ومطابقة واحد-لواحد.
  const transferCandidates = receiptRows.filter((row) => {
    const reference = row.referenceNumber ?? "";
    return (
      row.direction === "OUT" &&
      row.paymentMethod === "CASH" &&
      row.cashBucket === "DRAWER" &&
      (reference.startsWith("CH-") || reference.startsWith("CD-")) &&
      row.invoiceId == null &&
      row.workOrderId == null &&
      row.reservationId == null &&
      row.voucherNumber == null &&
      !expenseByReceipt.has(Number(row.id))
    );
  });
  const transferReferences = Array.from(
    new Set(
      transferCandidates
        .map((row) => row.referenceNumber)
        .filter((reference): reference is string => Boolean(reference)),
    ),
  );
  const pairRows = transferReferences.length
    ? await db
        .select({
          id: receipts.id,
          branchId: receipts.branchId,
          referenceNumber: receipts.referenceNumber,
          amount: receipts.amount,
          status: receipts.status,
          approvalStatus: receipts.approvalStatus,
        })
        .from(receipts)
        .where(
          and(
            eq(receipts.direction, "IN"),
            eq(receipts.paymentMethod, "CASH"),
            eq(receipts.cashBucket, "TREASURY"),
            inArray(receipts.referenceNumber, transferReferences),
          ),
        )
        .orderBy(asc(receipts.id))
    : [];
  const pairQueues = new Map<string, typeof pairRows>();
  for (const pair of pairRows) {
    if (pair.branchId == null || !pair.referenceNumber) continue;
    const key = `${Number(pair.branchId)}:${pair.referenceNumber}:${toDbMoney(money(pair.amount))}`;
    const queue = pairQueues.get(key) ?? [];
    queue.push(pair);
    pairQueues.set(key, queue);
  }
  const pairByReceipt = new Map<number, (typeof pairRows)[number]>();
  for (const candidate of transferCandidates) {
    if (candidate.branchId == null || !candidate.referenceNumber) continue;
    const key = `${Number(candidate.branchId)}:${candidate.referenceNumber}:${toDbMoney(money(candidate.amount))}`;
    const pair = pairQueues.get(key)?.shift();
    if (pair) pairByReceipt.set(Number(candidate.id), pair);
  }

  const normalizedReceipts: RawRemediationReceipt[] = receiptRows.map((row) => {
    const id = Number(row.id);
    const entries = entriesByReceipt.get(id) ?? [];
    const pair = pairByReceipt.get(id);
    return {
      id,
      shiftId: Number(row.shiftId),
      branchId: row.branchId == null ? null : Number(row.branchId),
      direction: row.direction,
      amount: row.amount,
      paymentMethod: row.paymentMethod,
      cashBucket: row.cashBucket,
      referenceNumber: row.referenceNumber,
      voucherNumber: row.voucherNumber,
      invoiceId: row.invoiceId == null ? null : Number(row.invoiceId),
      workOrderId: row.workOrderId == null ? null : Number(row.workOrderId),
      reservationId: row.reservationId == null ? null : Number(row.reservationId),
      partyType: row.partyType,
      partyId: row.partyId == null ? null : Number(row.partyId),
      counterpartyName: row.counterpartyName,
      description: row.description,
      attachmentUrl: row.attachmentUrl,
      status: row.status,
      approvalStatus: row.approvalStatus,
      createdBy: row.createdBy,
      createdByName: row.createdBy == null ? null : (actorNameById.get(row.createdBy) ?? null),
      createdAt: row.createdAt,
      expense: expenseByReceipt.get(id) ?? null,
      linkedExpenseIds: expenseIdsByReceipt.get(id) ?? [],
      ledgerEntryIds: entries.map((entry) => entry.id),
      ledgerEntryTypes: entries.map((entry) => entry.entryType),
      pairedTreasuryReceiptId: pair ? Number(pair.id) : null,
      pairedTreasuryReceiptStatus: pair?.status ?? null,
      pairedTreasuryApprovalStatus: pair?.approvalStatus ?? null,
    };
  });

  return analyzeCashRemediation(
    {
      shifts: shiftRows.map((row) => ({
        id: Number(row.id),
        branchId: Number(row.branchId),
        branchName: row.branchName,
        userId: Number(row.userId),
        userName: row.userName ?? `#${row.userId}`,
        shiftType: row.shiftType,
        status: row.status,
        openingBalance: row.openingBalance,
        storedExpectedCash: row.expectedCash,
        countedCash: row.countedCash,
        storedVariance: row.variance,
        openedAt: row.openedAt,
        closedAt: row.closedAt,
      })),
      receipts: normalizedReceipts,
    },
    filters,
  );
}
