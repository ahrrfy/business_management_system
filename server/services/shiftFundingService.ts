import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  or,
} from "drizzle-orm";
import {
  accountingEntries,
  auditLogs,
  branches,
  receipts,
  shiftFundingSourceLinks,
  shifts,
  users,
} from "../../drizzle/schema";
import type { Tx } from "../db";
import { extractInsertId } from "../lib/insertId";
import {
  createPostingIntent,
  creditLine,
  debitLine,
} from "./accounting/postingEngine";
import {
  assertCashTransferAvailable,
  assertNonPhysicalOutReceipt,
  assertTreasuryOutException,
  computeDrawerCashBalance,
} from "./cash/cashAvailability";
import { idempotencyHash, withIdempotency } from "./idempotency";
import { postEntry } from "./ledgerService";
import { money, toDbMoney } from "./money";
import { requireDb, withTx, type Actor } from "./tx";

const OPERATION = "shift.funding.request";
const REFERENCE_PREFIX = "STF-";

export interface ShiftFundingActor extends Actor {
  ipAddress?: string | null;
}

export interface RequestShiftFundingInput {
  shiftId: number;
  amount: string;
  evidenceNote: string;
  sourceTreasuryReceiptId: number;
  clientRequestId: string;
}

export interface RespondShiftFundingInput {
  requestReceiptId: number;
  decision: "ACCEPT" | "REJECT";
  rejectionReason?: string | null;
}

export interface CancelShiftFundingInput {
  requestReceiptId: number;
  cancellationReason: string;
}

type FundingMetadata = {
  kind: "SHIFT_ADDITIONAL_FUNDING";
  version: 1;
  shiftId: number;
  branchId: number;
  targetUserId: number;
  requestedBy: number;
  amount: string;
  evidenceNote: string;
  sourceTreasuryReceiptId: number;
  sourceShiftId: number;
  sourceReferenceNumber: string;
  sourceFingerprint: string;
  clientRequestId: string;
  payloadHash: string;
};

export interface PendingShiftFunding {
  requestReceiptId: number;
  referenceNumber: string;
  shiftId: number;
  branchId: number;
  amount: string;
  evidenceNote: string;
  requestedBy: number;
  requestedByName: string | null;
  targetUserId: number;
  targetUserName: string | null;
  sourceTreasuryReceiptId: number;
  sourceShiftId: number;
  sourceReferenceNumber: string;
  createdAt: Date;
}

export interface EligibleShiftFundingSource {
  receiptId: number;
  branchId: number;
  amount: string;
  referenceNumber: string;
  sourceShiftId: number;
  sourceUserName: string | null;
  acceptedAt: Date;
}

export interface EligibleShiftFundingSourcePage {
  items: EligibleShiftFundingSource[];
  nextCursor: number | null;
}

export interface ListEligibleShiftFundingSourcesInput {
  targetShiftId: number;
  cursorReceiptId?: number | null;
}

export interface ShiftFundingResult extends PendingShiftFunding {
  status: "PENDING" | "COMPLETED" | "FAILED";
  drawerInReceiptId: number | null;
  treasuryBalanceAfter: string | null;
  drawerBalanceAfter: string | null;
  idempotent: boolean;
}

type RequestRow = typeof receipts.$inferSelect;
type AccountingEntryRow = typeof accountingEntries.$inferSelect;

function fail(
  message: string,
  code:
    | "BAD_REQUEST"
    | "CONFLICT"
    | "PRECONDITION_FAILED"
    | "FORBIDDEN"
    | "NOT_FOUND" = "PRECONDITION_FAILED",
): never {
  throw new TRPCError({ code, message });
}

function normalizeRequest(input: RequestShiftFundingInput) {
  const amount = money(input.amount);
  if (!amount.isFinite() || amount.lte(0)) {
    fail("مبلغ تمويل الوردية يجب أن يكون موجباً وصالحاً", "BAD_REQUEST");
  }
  const evidenceNote = input.evidenceNote.trim();
  if (evidenceNote.length < 10 || evidenceNote.length > 500) {
    fail("سبب تمويل الوردية يجب أن يكون بين 10 و500 محرف", "BAD_REQUEST");
  }
  const clientRequestId = input.clientRequestId.trim();
  if (!clientRequestId || clientRequestId.length > 64) {
    fail("معرّف طلب تمويل الوردية غير صالح", "BAD_REQUEST");
  }
  if (!Number.isInteger(input.shiftId) || input.shiftId <= 0) {
    fail("رقم الوردية غير صالح", "BAD_REQUEST");
  }
  const sourceTreasuryReceiptId = input.sourceTreasuryReceiptId;
  if (
    !Number.isInteger(sourceTreasuryReceiptId) ||
    sourceTreasuryReceiptId <= 0
  ) {
    fail(
      "تمويل الوردية المفتوحة يتطلب إيصال سحب نقدي مكتمل من وردية أخرى وبالمبلغ نفسه",
      "BAD_REQUEST",
    );
  }
  return {
    shiftId: input.shiftId,
    amount,
    amountDb: toDbMoney(amount),
    evidenceNote,
    sourceTreasuryReceiptId,
    clientRequestId,
  };
}

function referenceNumber(
  branchId: number,
  shiftId: number,
  clientRequestId: string,
) {
  const suffix = createHash("sha256")
    .update(`${branchId}:${shiftId}:${clientRequestId}`)
    .digest("hex")
    .slice(0, 16)
    .toUpperCase();
  return `${REFERENCE_PREFIX}${branchId}-${shiftId}-${suffix}`;
}

function parseMetadata(row: RequestRow): FundingMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.internalNote ?? "");
  } catch {
    fail(
      "طلب تمويل الوردية تالف ولا يمكن تنفيذه قبل مراجعته",
      "PRECONDITION_FAILED",
    );
  }
  const value = parsed as Partial<FundingMetadata>;
  const valid =
    value?.kind === "SHIFT_ADDITIONAL_FUNDING" &&
    value.version === 1 &&
    Number.isInteger(value.shiftId) &&
    Number(value.shiftId) > 0 &&
    Number.isInteger(value.branchId) &&
    Number(value.branchId) > 0 &&
    Number.isInteger(value.targetUserId) &&
    Number(value.targetUserId) > 0 &&
    Number.isInteger(value.requestedBy) &&
    Number(value.requestedBy) > 0 &&
    typeof value.amount === "string" &&
    typeof value.evidenceNote === "string" &&
    typeof value.clientRequestId === "string" &&
    typeof value.payloadHash === "string" &&
    Number.isInteger(value.sourceTreasuryReceiptId) &&
    Number(value.sourceTreasuryReceiptId) > 0 &&
    Number.isInteger(value.sourceShiftId) &&
    Number(value.sourceShiftId) > 0 &&
    typeof value.sourceReferenceNumber === "string" &&
    value.sourceReferenceNumber.startsWith("CD-") &&
    typeof value.sourceFingerprint === "string" &&
    value.sourceFingerprint.length > 0;
  if (!valid) {
    fail("عقد طلب تمويل الوردية ناقص أو غير صالح", "PRECONDITION_FAILED");
  }
  const metadata = value as FundingMetadata;
  const expectedReference = referenceNumber(
    metadata.branchId,
    metadata.shiftId,
    metadata.clientRequestId,
  );
  const validState =
    (row.status === "PENDING" &&
      row.approvalStatus === "PENDING_APPROVAL" &&
      row.cashBucket == null) ||
    (row.status === "COMPLETED" &&
      row.approvalStatus === "APPROVED" &&
      row.cashBucket === "TREASURY") ||
    (row.status === "FAILED" &&
      row.approvalStatus === "REJECTED" &&
      row.cashBucket == null);
  if (
    row.referenceNumber !== expectedReference ||
    row.signatureHash !== idempotencyHash(metadata) ||
    row.voucherNumber != null ||
    row.invoiceId != null ||
    row.workOrderId != null ||
    row.reservationId != null ||
    Number(row.branchId) !== metadata.branchId ||
    row.shiftId != null ||
    row.direction !== "OUT" ||
    row.paymentMethod !== "CASH" ||
    row.partyType !== "OTHER" ||
    !validState ||
    toDbMoney(money(row.amount)) !== metadata.amount ||
    Number(row.createdBy) !== metadata.requestedBy
  ) {
    fail(
      "بصمة طلب تمويل الوردية أو حقوله المالية لا تتطابق",
      "PRECONDITION_FAILED",
    );
  }
  return metadata;
}

/**
 * مسوح القوائم لا تثق ببادئة STF وحدها: سند يدوي قد يحمل البادئة نفسها. نتجاهل
 * الصف الخارجي، لكن إن أعلن صفٌ أنه عقد تمويل داخلي فكل خلل في بصمته يبقى fail-closed.
 */
function scanFundingMetadata(row: RequestRow): FundingMetadata | null {
  // A user-authored business document is never a system funding request, even
  // when its free-form reference or internal note imitates the STF namespace.
  if (
    row.voucherNumber != null ||
    row.invoiceId != null ||
    row.workOrderId != null ||
    row.reservationId != null
  ) {
    return null;
  }
  if (!row.internalNote) return null;
  let value: unknown;
  try {
    value = JSON.parse(row.internalNote);
  } catch {
    return null;
  }
  if (
    (value as Partial<FundingMetadata> | null)?.kind !==
    "SHIFT_ADDITIONAL_FUNDING"
  ) {
    return null;
  }
  return parseMetadata(row);
}

function sourceFingerprint(
  source: RequestRow,
  pairedDrawerOut: RequestRow,
  ledgerEvidence: AccountingEntryRow[],
) {
  return idempotencyHash({
    id: Number(source.id),
    branchId: source.branchId == null ? null : Number(source.branchId),
    direction: source.direction,
    amount: toDbMoney(money(source.amount)),
    paymentMethod: source.paymentMethod,
    cashBucket: source.cashBucket,
    referenceNumber: source.referenceNumber,
    status: source.status,
    approvalStatus: source.approvalStatus,
    approvedBy: source.approvedBy == null ? null : Number(source.approvedBy),
    approvedAt: source.approvedAt?.toISOString() ?? null,
    createdBy: source.createdBy == null ? null : Number(source.createdBy),
    createdAt: source.createdAt.toISOString(),
    pairedDrawerOut: {
      id: Number(pairedDrawerOut.id),
      shiftId:
        pairedDrawerOut.shiftId == null
          ? null
          : Number(pairedDrawerOut.shiftId),
      branchId:
        pairedDrawerOut.branchId == null
          ? null
          : Number(pairedDrawerOut.branchId),
      amount: toDbMoney(money(pairedDrawerOut.amount)),
      createdBy:
        pairedDrawerOut.createdBy == null
          ? null
          : Number(pairedDrawerOut.createdBy),
      createdAt: pairedDrawerOut.createdAt.toISOString(),
    },
    ledgerEvidence: ledgerEvidence
      .slice()
      .sort((left, right) => Number(left.id) - Number(right.id))
      .map((entry) => ({
        id: Number(entry.id),
        entryType: entry.entryType,
        branchId: entry.branchId == null ? null : Number(entry.branchId),
        receiptId: entry.receiptId == null ? null : Number(entry.receiptId),
        amount: toDbMoney(money(entry.amount)),
        revenue: toDbMoney(money(entry.revenue)),
        cost: toDbMoney(money(entry.cost)),
        profit: toDbMoney(money(entry.profit)),
        taxAmount: toDbMoney(money(entry.taxAmount)),
        dedupeKey: entry.dedupeKey,
        postingCycleId:
          entry.postingCycleId == null ? null : Number(entry.postingCycleId),
        postingProfile: entry.postingProfile,
        postingIntentHash: entry.postingIntentHash,
        createdBy: entry.createdBy == null ? null : Number(entry.createdBy),
        createdAt: entry.createdAt.toISOString(),
      })),
  });
}

/**
 * A cash-drop source exists in one of two immutable ledger shapes:
 *
 * - legacy: one neutral CASH_HANDOVER on the drawer OUT receipt;
 * - governed custody: CASH_TRANSFER_OUT (drawer -> transit) followed by
 *   CASH_TRANSFER_IN (transit -> treasury) on the accepted treasury receipt.
 *
 * Requiring the complete, exclusive shape prevents a manually fabricated CD
 * receipt pair from becoming shift funding while keeping already-issued
 * legacy drops usable after the custody migration.
 */
function cashDropLedgerEvidence(
  entries: AccountingEntryRow[],
  drawerReceiptId: number,
  treasuryReceiptId: number,
  branchId: number,
  amount: string,
): AccountingEntryRow[] | null {
  const hasExactCore = (entry: AccountingEntryRow) =>
    Number(entry.branchId) === branchId &&
    toDbMoney(money(entry.amount)) === amount &&
    money(entry.revenue).isZero() &&
    money(entry.cost).isZero() &&
    money(entry.profit).isZero() &&
    money(entry.taxAmount).isZero();

  const legacy = entries.filter(
    (entry) =>
      entry.entryType === "CASH_HANDOVER" &&
      Number(entry.receiptId) === drawerReceiptId,
  );
  if (entries.length === 1 && legacy.length === 1 && hasExactCore(legacy[0]!)) {
    return legacy;
  }

  const transferOut = entries.filter(
    (entry) =>
      entry.entryType === "CASH_TRANSFER_OUT" &&
      Number(entry.receiptId) === drawerReceiptId,
  );
  const transferIn = entries.filter(
    (entry) =>
      entry.entryType === "CASH_TRANSFER_IN" &&
      Number(entry.receiptId) === treasuryReceiptId,
  );
  if (
    entries.length === 2 &&
    transferOut.length === 1 &&
    transferIn.length === 1 &&
    hasExactCore(transferOut[0]!) &&
    hasExactCore(transferIn[0]!) &&
    (transferOut[0]!.postingProfile == null ||
      transferOut[0]!.postingProfile === "CASH_DROP_TO_TRANSIT") &&
    (transferIn[0]!.postingProfile == null ||
      transferIn[0]!.postingProfile === "CASH_TRANSFER_IN_FROM_TRANSIT")
  ) {
    return [transferOut[0]!, transferIn[0]!];
  }

  return null;
}

async function lockAndValidateCashDropSource(
  tx: Tx,
  sourceId: number,
  branchId: number,
  amount: string,
  expectedFingerprint?: string | null,
) {
  const [source] = await tx
    .select()
    .from(receipts)
    .where(eq(receipts.id, sourceId))
    .for("update")
    .limit(1);
  if (
    !source ||
    Number(source.branchId) !== branchId ||
    source.shiftId != null ||
    source.direction !== "IN" ||
    source.paymentMethod !== "CASH" ||
    source.cashBucket !== "TREASURY" ||
    source.status !== "COMPLETED" ||
    source.approvalStatus !== "APPROVED" ||
    source.createdBy == null ||
    source.approvedBy == null ||
    Number(source.approvedBy) !== Number(source.createdBy) ||
    source.approvedAt == null ||
    !source.referenceNumber?.startsWith("CD-") ||
    toDbMoney(money(source.amount)) !== amount
  ) {
    fail("إيصال مصدر التمويل ليس سحباً نقدياً مكتملاً ومطابقاً من وردية أخرى");
  }
  const treasuryIns = await tx
    .select()
    .from(receipts)
    .where(
      and(
        eq(receipts.branchId, branchId),
        eq(receipts.referenceNumber, source.referenceNumber),
        eq(receipts.direction, "IN"),
        eq(receipts.paymentMethod, "CASH"),
        eq(receipts.cashBucket, "TREASURY"),
      ),
    )
    .for("update");
  if (
    treasuryIns.length !== 1 ||
    Number(treasuryIns[0]!.id) !== Number(source.id)
  ) {
    fail("سلسلة السحب النقدي لا تملك ساق خزينة واحدة ووحيدة");
  }
  const drawerOuts = await tx
    .select()
    .from(receipts)
    .where(
      and(
        eq(receipts.branchId, branchId),
        eq(receipts.referenceNumber, source.referenceNumber),
        eq(receipts.direction, "OUT"),
        eq(receipts.paymentMethod, "CASH"),
        eq(receipts.cashBucket, "DRAWER"),
      ),
    )
    .for("update");
  if (
    drawerOuts.length !== 1 ||
    drawerOuts[0]!.shiftId == null ||
    drawerOuts[0]!.status !== "COMPLETED" ||
    drawerOuts[0]!.approvalStatus !== "APPROVED" ||
    toDbMoney(money(drawerOuts[0]!.amount)) !== amount
  ) {
    fail("سلسلة حيازة سحب مصدر التمويل غير مكتملة أو غير وحيدة");
  }
  const drawerOut = drawerOuts[0]!;
  // لا تكفي بادئة CD ولا زوج إيصالات يمكن إنشاؤه يدوياً: يلزم دليل دفتر حصري
  // إما من CASH_HANDOVER التاريخي أو من زوج transit الحالي بعد قبول الخزينة.
  const ledgerEntries = await tx
    .select()
    .from(accountingEntries)
    .where(
      or(
        eq(accountingEntries.receiptId, Number(drawerOut.id)),
        eq(accountingEntries.receiptId, Number(source.id)),
      ),
    )
    .for("update");
  const evidence = cashDropLedgerEvidence(
    ledgerEntries,
    Number(drawerOut.id),
    Number(source.id),
    branchId,
    amount,
  );
  if (!evidence) {
    fail("مصدر التمويل لا يملك سلسلة دفتر أصلية وحصرية من الدرج إلى الخزينة");
  }
  const fingerprint = sourceFingerprint(source, drawerOut, evidence);
  if (expectedFingerprint != null && expectedFingerprint !== fingerprint) {
    fail("تغيّر إيصال مصدر التمويل بعد إنشاء الطلب", "CONFLICT");
  }
  return {
    id: Number(source.id),
    sourceShiftId: Number(drawerOut.shiftId),
    referenceNumber: source.referenceNumber,
    fingerprint,
  };
}

async function assertSourceUnused(tx: Tx, sourceReceiptId: number) {
  const [link] = await tx
    .select()
    .from(shiftFundingSourceLinks)
    .where(eq(shiftFundingSourceLinks.activeSourceReceiptId, sourceReceiptId))
    .for("update")
    .limit(1);
  if (link) {
    fail("إيصال السحب مرتبط بطلب تمويل وردية آخر", "CONFLICT");
  }
}

async function lockFundingSourceLink(
  tx: Tx,
  requestReceiptId: number,
  metadata: FundingMetadata,
) {
  const [link] = await tx
    .select()
    .from(shiftFundingSourceLinks)
    .where(eq(shiftFundingSourceLinks.requestReceiptId, requestReceiptId))
    .for("update")
    .limit(1);
  if (
    !link ||
    Number(link.sourceReceiptId) !== metadata.sourceTreasuryReceiptId ||
    Number(link.targetShiftId) !== metadata.shiftId ||
    Number(link.branchId) !== metadata.branchId ||
    (link.state === "PENDING" &&
      (Number(link.activeSourceReceiptId) !== Number(link.sourceReceiptId) ||
        Number(link.activeTargetShiftId) !== Number(link.targetShiftId))) ||
    (link.state === "CONSUMED" &&
      (Number(link.activeSourceReceiptId) !== Number(link.sourceReceiptId) ||
        link.activeTargetShiftId != null)) ||
    (link.state === "RELEASED" &&
      (link.activeSourceReceiptId != null || link.activeTargetShiftId != null))
  ) {
    fail(
      "رابط مصدر تمويل الوردية مفقود أو لا يطابق الطلب الموقّع",
      "PRECONDITION_FAILED",
    );
  }
  return link;
}

async function releaseFundingSourceLink(
  tx: Tx,
  requestReceiptId: number,
  metadata: FundingMetadata,
) {
  const link = await lockFundingSourceLink(tx, requestReceiptId, metadata);
  if (link.state === "RELEASED") return;
  if (link.state !== "PENDING") {
    fail("مصدر تمويل الوردية نُفّذ ولا يمكن تحريره", "CONFLICT");
  }
  await tx
    .update(shiftFundingSourceLinks)
    .set({
      state: "RELEASED",
      activeSourceReceiptId: null,
      activeTargetShiftId: null,
    })
    .where(eq(shiftFundingSourceLinks.id, link.id));
}

async function drawerCounterpart(
  tx: Tx,
  row: RequestRow,
  metadata: FundingMetadata,
) {
  const rows = await tx
    .select()
    .from(receipts)
    .where(
      and(
        eq(receipts.branchId, metadata.branchId),
        eq(receipts.shiftId, metadata.shiftId),
        eq(receipts.direction, "IN"),
        eq(receipts.paymentMethod, "CASH"),
        eq(receipts.cashBucket, "DRAWER"),
        eq(receipts.referenceNumber, String(row.referenceNumber)),
        eq(receipts.signatureHash, row.signatureHash ?? ""),
        eq(receipts.internalNote, row.internalNote ?? ""),
      ),
    )
    // A concurrent accept can commit after this transaction's first consistent
    // read.  A locking current read is required here so an idempotent replay
    // sees the materialized drawer leg instead of the older RR snapshot.
    .for("update");
  if (rows.length > 1)
    fail("طلب تمويل الوردية يملك أكثر من ساق درج", "PRECONDITION_FAILED");
  return rows[0] ?? null;
}

async function resultOf(
  tx: Tx,
  row: RequestRow,
  idempotent: boolean,
): Promise<ShiftFundingResult> {
  const metadata = parseMetadata(row);
  const [maker] = await tx
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, metadata.requestedBy))
    .limit(1);
  const [target] = await tx
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, metadata.targetUserId))
    .limit(1);
  const counterpart = await drawerCounterpart(tx, row, metadata);
  if (row.status === "COMPLETED") {
    if (
      row.cashBucket !== "TREASURY" ||
      row.approvalStatus !== "APPROVED" ||
      !counterpart ||
      counterpart.status !== "COMPLETED" ||
      counterpart.approvalStatus !== "APPROVED" ||
      toDbMoney(money(counterpart.amount)) !== metadata.amount ||
      counterpart.signatureHash !== row.signatureHash
    ) {
      fail("طلب التمويل المنفذ لا يملك ساقي خزنة ودرج متطابقتين");
    }
  } else if (counterpart) {
    fail("طلب تمويل غير منفذ يملك ساق درج غير مشروعة");
  }
  return {
    requestReceiptId: Number(row.id),
    referenceNumber: String(row.referenceNumber),
    shiftId: metadata.shiftId,
    branchId: metadata.branchId,
    amount: metadata.amount,
    evidenceNote: metadata.evidenceNote,
    requestedBy: metadata.requestedBy,
    requestedByName: maker?.name ?? null,
    targetUserId: metadata.targetUserId,
    targetUserName: target?.name ?? null,
    sourceTreasuryReceiptId: metadata.sourceTreasuryReceiptId,
    sourceShiftId: metadata.sourceShiftId,
    sourceReferenceNumber: metadata.sourceReferenceNumber,
    createdAt: row.createdAt,
    status:
      row.status === "COMPLETED"
        ? "COMPLETED"
        : row.status === "FAILED"
          ? "FAILED"
          : "PENDING",
    drawerInReceiptId: counterpart ? Number(counterpart.id) : null,
    treasuryBalanceAfter: null,
    drawerBalanceAfter: null,
    idempotent,
  };
}

/**
 * ينشئ عقد تسليم تمويل إضافي بلا أثر مالي. لا تتحرك الخزنة/الوردية إلا حين يؤكد
 * صاحب الوردية استلام النقد فعلياً عبر respondToShiftFundingRequest.
 */
export async function requestAdditionalShiftFunding(
  rawInput: RequestShiftFundingInput,
  actor: ShiftFundingActor,
) {
  const input = normalizeRequest(rawInput);
  const payload = {
    shiftId: input.shiftId,
    amount: input.amountDb,
    evidenceNote: input.evidenceNote,
    sourceTreasuryReceiptId: input.sourceTreasuryReceiptId,
  };
  const payloadHash = idempotencyHash(payload);

  return withTx(async (tx) => {
    const outcome = await withIdempotency<ShiftFundingResult>(
      tx,
      { operation: OPERATION, clientRequestId: input.clientRequestId, payload },
      async () => {
        const [preview] = await tx
          .select({ branchId: shifts.branchId })
          .from(shifts)
          .where(eq(shifts.id, input.shiftId))
          .limit(1);
        if (!preview) fail("الوردية غير موجودة", "NOT_FOUND");
        const branchId = Number(preview.branchId);

        assertTreasuryOutException("SHIFT_FLOAT_INTERNAL");
        const availability = await assertCashTransferAvailable(tx, {
          source: { branchId, cashBucket: "TREASURY", shiftId: null },
          destination: {
            branchId,
            cashBucket: "DRAWER",
            shiftId: input.shiftId,
          },
          amount: input.amount,
          operation: "طلب تمويل إضافي لوردية مفتوحة",
        });

        const [shift] = await tx
          .select()
          .from(shifts)
          .where(eq(shifts.id, input.shiftId))
          .for("update")
          .limit(1);
        if (!shift || shift.status !== "OPEN")
          fail("الوردية مغلقة أو غير موجودة");
        const drawerBefore = await computeDrawerCashBalance(
          tx,
          input.shiftId,
          shift.openingBalance,
        );
        if (drawerBefore.isNegative()) {
          fail(
            "لا يجوز إخفاء عجز وردية بتمويل إضافي؛ عالج المستند المسبب أو استخدم مسار التصحيح التاريخي",
          );
        }

        const [owner] = await tx
          .select({
            id: users.id,
            name: users.name,
            isOwner: users.isOwner,
            isActive: users.isActive,
          })
          .from(users)
          .where(eq(users.id, actor.userId))
          .for("share")
          .limit(1);
        if (!owner?.isActive || !owner.isOwner) {
          fail("إنشاء تمويل إضافي للوردية محصور بحساب مالك نشط", "FORBIDDEN");
        }
        if (Number(shift.userId) === Number(owner.id)) {
          fail(
            "لا يجوز لصاحب الوردية تمويل درج نفسه؛ يلزم مالك آخر يسلّمه النقد",
            "FORBIDDEN",
          );
        }

        const [pendingLink] = await tx
          .select()
          .from(shiftFundingSourceLinks)
          .where(eq(shiftFundingSourceLinks.activeTargetShiftId, input.shiftId))
          .for("update")
          .limit(1);
        if (pendingLink)
          fail(
            "توجد لهذه الوردية عهدة إضافية معلقة؛ نفّذها أو ارفضها أولاً",
            "CONFLICT",
          );

        const source = await lockAndValidateCashDropSource(
          tx,
          input.sourceTreasuryReceiptId,
          branchId,
          input.amountDb,
        );
        if (source.sourceShiftId === input.shiftId) {
          fail(
            "يجب أن يأتي التمويل الإضافي من سحب وردية أخرى، لا من الوردية نفسها",
          );
        }
        await assertSourceUnused(tx, source.id);

        const metadata: FundingMetadata = {
          kind: "SHIFT_ADDITIONAL_FUNDING",
          version: 1,
          shiftId: input.shiftId,
          branchId,
          targetUserId: Number(shift.userId),
          requestedBy: Number(owner.id),
          amount: input.amountDb,
          evidenceNote: input.evidenceNote,
          sourceTreasuryReceiptId: source.id,
          sourceShiftId: source.sourceShiftId,
          sourceReferenceNumber: source.referenceNumber,
          sourceFingerprint: source.fingerprint,
          clientRequestId: input.clientRequestId,
          payloadHash,
        };
        const signatureHash = idempotencyHash(metadata);
        const ref = referenceNumber(
          branchId,
          input.shiftId,
          input.clientRequestId,
        );
        assertNonPhysicalOutReceipt({
          classification: "DEFERRED_APPROVAL",
          paymentMethod: "CASH",
          cashBucket: null,
          approvalStatus: "PENDING_APPROVAL",
          operation: OPERATION,
        });
        const insert = await tx.insert(receipts).values({
          branchId,
          shiftId: null,
          direction: "OUT",
          amount: input.amountDb,
          paymentMethod: "CASH",
          cashBucket: null,
          referenceNumber: ref,
          status: "PENDING",
          partyType: "OTHER",
          description: `طلب تمويل إضافي لوردية #${input.shiftId}: ${input.evidenceNote}`,
          internalNote: JSON.stringify(metadata),
          signatureHash,
          approvalStatus: "PENDING_APPROVAL",
          createdBy: owner.id,
        });
        const requestReceiptId = extractInsertId(insert);
        await tx.insert(shiftFundingSourceLinks).values({
          requestReceiptId,
          sourceReceiptId: source.id,
          activeSourceReceiptId: source.id,
          targetShiftId: input.shiftId,
          activeTargetShiftId: input.shiftId,
          branchId,
          state: "PENDING",
        });
        await tx.insert(auditLogs).values({
          userId: owner.id,
          branchId,
          action: "shift.funding.request",
          entityType: "receipt",
          entityId: String(requestReceiptId),
          oldValue: null,
          newValue: {
            shiftId: input.shiftId,
            amount: input.amountDb,
            drawerBefore: toDbMoney(drawerBefore),
            treasuryAvailable: availability.availableBefore,
            sourceTreasuryReceiptId: source.id,
            payloadHash,
          },
          ipAddress: actor.ipAddress ?? null,
        });
        const [row] = await tx
          .select()
          .from(receipts)
          .where(eq(receipts.id, requestReceiptId))
          .limit(1);
        if (!row) fail("تعذّر إنشاء طلب تمويل الوردية", "CONFLICT");
        const result = await resultOf(tx, row, false);
        result.treasuryBalanceAfter = availability.availableBefore;
        result.drawerBalanceAfter = toDbMoney(drawerBefore);
        return { refId: requestReceiptId, result };
      },
    );

    if (!outcome.replay && outcome.result) return outcome.result;
    const [row] = await tx
      .select()
      .from(receipts)
      .where(eq(receipts.id, outcome.refId))
      .limit(1);
    if (!row) fail("طلب التمويل المعاد غير موجود", "CONFLICT");
    await lockFundingSourceLink(tx, Number(row.id), parseMetadata(row));
    return resultOf(tx, row, true);
  });
}

export async function listMyPendingShiftFunding(
  actor: Actor,
): Promise<PendingShiftFunding[]> {
  const db = requireDb();
  const rows = await db
    .select()
    .from(receipts)
    .where(
      and(
        like(receipts.referenceNumber, `${REFERENCE_PREFIX}%`),
        eq(receipts.direction, "OUT"),
        eq(receipts.paymentMethod, "CASH"),
        isNull(receipts.cashBucket),
        eq(receipts.status, "PENDING"),
        eq(receipts.approvalStatus, "PENDING_APPROVAL"),
        eq(receipts.branchId, actor.branchId),
      ),
    )
    .orderBy(asc(receipts.createdAt));
  const pending: PendingShiftFunding[] = [];
  for (const row of rows) {
    const metadata = scanFundingMetadata(row);
    if (!metadata) continue;
    if (metadata.targetUserId !== actor.userId) continue;
    if (actor.branchId !== metadata.branchId) continue;
    const [[maker], [target]] = await Promise.all([
      db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, metadata.requestedBy))
        .limit(1),
      db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, metadata.targetUserId))
        .limit(1),
    ]);
    pending.push({
      requestReceiptId: Number(row.id),
      referenceNumber: String(row.referenceNumber),
      shiftId: metadata.shiftId,
      branchId: metadata.branchId,
      amount: metadata.amount,
      evidenceNote: metadata.evidenceNote,
      requestedBy: metadata.requestedBy,
      requestedByName: maker?.name ?? null,
      targetUserId: metadata.targetUserId,
      targetUserName: target?.name ?? null,
      sourceTreasuryReceiptId: metadata.sourceTreasuryReceiptId,
      sourceShiftId: metadata.sourceShiftId,
      sourceReferenceNumber: metadata.sourceReferenceNumber,
      createdAt: row.createdAt,
    });
  }
  return pending;
}

/** الطلبات المعلّقة لكل المالكين؛ لا أثر لها ويجوز لمالك نشط إلغاؤها مع سبب تدقيقي. */
export async function listPendingShiftFundingForOwners(
  actor: Actor,
): Promise<PendingShiftFunding[]> {
  const db = requireDb();
  const [owner] = await db
    .select({ id: users.id, isOwner: users.isOwner, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, actor.userId))
    .limit(1);
  if (!owner?.isActive || !owner.isOwner) {
    fail("طلبات تمويل الورديات الصادرة محصورة بحساب مالك نشط", "FORBIDDEN");
  }
  const rows = await db
    .select()
    .from(receipts)
    .where(
      and(
        like(receipts.referenceNumber, `${REFERENCE_PREFIX}%`),
        eq(receipts.direction, "OUT"),
        eq(receipts.paymentMethod, "CASH"),
        isNull(receipts.cashBucket),
        eq(receipts.status, "PENDING"),
        eq(receipts.approvalStatus, "PENDING_APPROVAL"),
      ),
    )
    .orderBy(asc(receipts.createdAt));
  const pending: PendingShiftFunding[] = [];
  for (const row of rows) {
    const metadata = scanFundingMetadata(row);
    if (!metadata) continue;
    const [[maker], [target]] = await Promise.all([
      db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, metadata.requestedBy))
        .limit(1),
      db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, metadata.targetUserId))
        .limit(1),
    ]);
    pending.push({
      requestReceiptId: Number(row.id),
      referenceNumber: String(row.referenceNumber),
      shiftId: metadata.shiftId,
      branchId: metadata.branchId,
      amount: metadata.amount,
      evidenceNote: metadata.evidenceNote,
      requestedBy: metadata.requestedBy,
      requestedByName: maker?.name ?? null,
      targetUserId: metadata.targetUserId,
      targetUserName: target?.name ?? null,
      sourceTreasuryReceiptId: metadata.sourceTreasuryReceiptId,
      sourceShiftId: metadata.sourceShiftId,
      sourceReferenceNumber: metadata.sourceReferenceNumber,
      createdAt: row.createdAt,
    });
  }
  return pending;
}

/**
 * السحوبات المقبولة وغير المرتبطة بعهدة أخرى. هذه قائمة تشغيلية للمالك كي لا
 * يضطر إلى معرفة رقم إيصال داخلي أو إدخاله يدوياً، ولا تمنح أي أثر مالي.
 */
export async function listEligibleShiftFundingSources(
  input: ListEligibleShiftFundingSourcesInput,
  actor: Actor,
): Promise<EligibleShiftFundingSourcePage> {
  const db = requireDb();
  const [owner] = await db
    .select({ id: users.id, isOwner: users.isOwner, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, actor.userId))
    .limit(1);
  if (!owner?.isActive || !owner.isOwner) {
    fail("قائمة مصادر تمويل الورديات محصورة بحساب مالك نشط", "FORBIDDEN");
  }
  if (!Number.isInteger(input.targetShiftId) || input.targetShiftId <= 0) {
    fail("رقم الوردية المستهدفة غير صالح", "BAD_REQUEST");
  }
  if (
    input.cursorReceiptId != null &&
    (!Number.isInteger(input.cursorReceiptId) || input.cursorReceiptId <= 0)
  ) {
    fail("مؤشر صفحة مصادر التمويل غير صالح", "BAD_REQUEST");
  }
  const [targetShift] = await db
    .select({ id: shifts.id, branchId: shifts.branchId, status: shifts.status })
    .from(shifts)
    .where(eq(shifts.id, input.targetShiftId))
    .limit(1);
  if (!targetShift || targetShift.status !== "OPEN") {
    fail("الوردية المستهدفة غير موجودة أو ليست مفتوحة", "PRECONDITION_FAILED");
  }

  // Page the accepted treasury legs first. All subsequent chain and usage reads
  // are restricted to this bounded page, so the endpoint never scans cash-drop
  // or STF history globally as the installation grows.
  const PAGE_SIZE = 50;
  const candidates = await db
    .select()
    .from(receipts)
    .where(
      and(
        eq(receipts.branchId, Number(targetShift.branchId)),
        isNull(receipts.shiftId),
        eq(receipts.direction, "IN"),
        eq(receipts.paymentMethod, "CASH"),
        eq(receipts.cashBucket, "TREASURY"),
        eq(receipts.status, "COMPLETED"),
        eq(receipts.approvalStatus, "APPROVED"),
        isNotNull(receipts.approvedAt),
        eq(receipts.approvedBy, receipts.createdBy),
        like(receipts.referenceNumber, "CD-%"),
        input.cursorReceiptId == null
          ? undefined
          : lt(receipts.id, input.cursorReceiptId),
      ),
    )
    .orderBy(desc(receipts.id))
    .limit(PAGE_SIZE + 1);
  const pageCandidates = candidates.slice(0, PAGE_SIZE);
  const nextCursor =
    candidates.length > PAGE_SIZE
      ? Number(pageCandidates[pageCandidates.length - 1]!.id)
      : null;
  if (pageCandidates.length === 0) return { items: [], nextCursor };

  const candidateIds = pageCandidates.map((row) => Number(row.id));
  const references = pageCandidates.map((row) => String(row.referenceNumber));
  const [treasuryRows, drawerRows, linkedRows] = await Promise.all([
    db
      .select()
      .from(receipts)
      .where(
        and(
          eq(receipts.branchId, Number(targetShift.branchId)),
          inArray(receipts.referenceNumber, references),
          eq(receipts.direction, "IN"),
          eq(receipts.paymentMethod, "CASH"),
          eq(receipts.cashBucket, "TREASURY"),
        ),
      ),
    db
      .select()
      .from(receipts)
      .where(
        and(
          eq(receipts.branchId, Number(targetShift.branchId)),
          inArray(receipts.referenceNumber, references),
          eq(receipts.direction, "OUT"),
          eq(receipts.paymentMethod, "CASH"),
          eq(receipts.cashBucket, "DRAWER"),
        ),
      ),
    db
      .select({
        activeSourceReceiptId: shiftFundingSourceLinks.activeSourceReceiptId,
      })
      .from(shiftFundingSourceLinks)
      .where(
        inArray(shiftFundingSourceLinks.activeSourceReceiptId, candidateIds),
      ),
  ]);
  const drawerIds = drawerRows.map((row) => Number(row.id));
  const evidenceReceiptIds = [...drawerIds, ...candidateIds];
  const ledgerRows =
    evidenceReceiptIds.length === 0
      ? []
      : await db
          .select()
          .from(accountingEntries)
          .where(inArray(accountingEntries.receiptId, evidenceReceiptIds));
  const sourceShiftIds = Array.from(
    new Set(
      drawerRows.flatMap((row) =>
        row.shiftId == null ? [] : [Number(row.shiftId)],
      ),
    ),
  );
  const sourceUsers =
    sourceShiftIds.length === 0
      ? []
      : await db
          .select({ shiftId: shifts.id, userName: users.name })
          .from(shifts)
          .leftJoin(users, eq(shifts.userId, users.id))
          .where(inArray(shifts.id, sourceShiftIds));
  const userNameByShift = new Map(
    sourceUsers.map((row) => [Number(row.shiftId), row.userName]),
  );
  const linkedSourceIds = new Set<number>();
  for (const row of linkedRows) {
    if (row.activeSourceReceiptId != null)
      linkedSourceIds.add(Number(row.activeSourceReceiptId));
  }

  const items = pageCandidates.flatMap(
    (source): EligibleShiftFundingSource[] => {
      const sourceId = Number(source.id);
      const sourceReference = String(source.referenceNumber);
      const matchingTreasury = treasuryRows.filter(
        (row) => row.referenceNumber === sourceReference,
      );
      const matchingDrawer = drawerRows.filter(
        (row) => row.referenceNumber === sourceReference,
      );
      if (
        matchingTreasury.length !== 1 ||
        Number(matchingTreasury[0]!.id) !== sourceId ||
        matchingDrawer.length !== 1 ||
        linkedSourceIds.has(sourceId)
      ) {
        return [];
      }
      const drawer = matchingDrawer[0]!;
      const sourceShiftId =
        drawer.shiftId == null ? null : Number(drawer.shiftId);
      const matchingLedger = ledgerRows.filter(
        (row) =>
          Number(row.receiptId) === Number(drawer.id) ||
          Number(row.receiptId) === sourceId,
      );
      const evidence = cashDropLedgerEvidence(
        matchingLedger,
        Number(drawer.id),
        sourceId,
        Number(targetShift.branchId),
        toDbMoney(money(source.amount)),
      );
      if (
        sourceShiftId == null ||
        sourceShiftId === input.targetShiftId ||
        drawer.status !== "COMPLETED" ||
        drawer.approvalStatus !== "APPROVED" ||
        toDbMoney(money(drawer.amount)) !== toDbMoney(money(source.amount)) ||
        evidence == null
      ) {
        return [];
      }
      return [
        {
          receiptId: sourceId,
          branchId: Number(source.branchId),
          amount: toDbMoney(money(source.amount)),
          referenceNumber: sourceReference,
          sourceShiftId,
          sourceUserName: userNameByShift.get(sourceShiftId) ?? null,
          acceptedAt: source.approvedAt ?? source.createdAt,
        },
      ];
    },
  );
  return { items, nextCursor };
}

async function lockRequestAndSource(
  tx: Tx,
  requestReceiptId: number,
  metadata: FundingMetadata,
) {
  const ids = [requestReceiptId, metadata.sourceTreasuryReceiptId].sort(
    (a, b) => a - b,
  );
  const rows = await tx
    .select()
    .from(receipts)
    .where(inArray(receipts.id, ids))
    .orderBy(asc(receipts.id))
    .for("update");
  const request = rows.find((row) => Number(row.id) === requestReceiptId);
  if (!request) fail("طلب تمويل الوردية غير موجود", "NOT_FOUND");
  const currentMetadata = parseMetadata(request);
  if (idempotencyHash(currentMetadata) !== idempotencyHash(metadata)) {
    fail("تغيّر طلب تمويل الوردية أثناء التنفيذ", "CONFLICT");
  }
  const link = await lockFundingSourceLink(
    tx,
    requestReceiptId,
    currentMetadata,
  );
  const expectedLinkState =
    request.status === "COMPLETED"
      ? "CONSUMED"
      : request.status === "FAILED"
        ? "RELEASED"
        : "PENDING";
  if (link.state !== expectedLinkState) {
    fail(
      "حالة رابط مصدر تمويل الوردية لا تطابق حالة الطلب",
      "PRECONDITION_FAILED",
    );
  }
  const source = await lockAndValidateCashDropSource(
    tx,
    metadata.sourceTreasuryReceiptId,
    metadata.branchId,
    metadata.amount,
    metadata.sourceFingerprint,
  );
  if (
    source.sourceShiftId !== metadata.sourceShiftId ||
    source.sourceShiftId === metadata.shiftId
  ) {
    fail(
      "وردية مصدر السحب لا تطابق عقد التمويل أو تطابق الوردية المستهدفة",
      "CONFLICT",
    );
  }
  return request;
}

export async function cancelShiftFundingRequest(
  input: CancelShiftFundingInput,
  actor: ShiftFundingActor,
): Promise<ShiftFundingResult> {
  if (
    !Number.isInteger(input.requestReceiptId) ||
    input.requestReceiptId <= 0
  ) {
    fail("رقم طلب التمويل غير صالح", "BAD_REQUEST");
  }
  const cancellationReason = input.cancellationReason.trim();
  if (cancellationReason.length < 5 || cancellationReason.length > 500) {
    fail("سبب إلغاء طلب التمويل يجب أن يكون بين 5 و500 محرف", "BAD_REQUEST");
  }

  return withTx(async (tx) => {
    const [preview] = await tx
      .select()
      .from(receipts)
      .where(eq(receipts.id, input.requestReceiptId))
      .limit(1);
    if (!preview) fail("طلب تمويل الوردية غير موجود", "NOT_FOUND");
    const metadata = parseMetadata(preview);

    // يطابق ترتيب كل نقل نقدي: درج الهدف ثم خزينة الفرع ثم المستندات.
    const [shift] = await tx
      .select({ id: shifts.id, branchId: shifts.branchId })
      .from(shifts)
      .where(eq(shifts.id, metadata.shiftId))
      .for("update")
      .limit(1);
    if (!shift || Number(shift.branchId) !== metadata.branchId) {
      fail("وردية طلب التمويل لم تعد تطابق فرعها", "CONFLICT");
    }
    const [branch] = await tx
      .select({ id: branches.id })
      .from(branches)
      .where(eq(branches.id, metadata.branchId))
      .for("update")
      .limit(1);
    if (!branch) fail("فرع طلب التمويل غير موجود", "CONFLICT");

    const request = await lockRequestAndSource(
      tx,
      input.requestReceiptId,
      metadata,
    );
    const [owner] = await tx
      .select({
        id: users.id,
        isOwner: users.isOwner,
        isActive: users.isActive,
      })
      .from(users)
      .where(eq(users.id, actor.userId))
      .for("share")
      .limit(1);
    if (!owner?.isActive || !owner.isOwner) {
      fail("إلغاء طلب تمويل الوردية محصور بحساب مالك نشط", "FORBIDDEN");
    }
    if (request.status === "FAILED" && request.approvalStatus === "REJECTED") {
      return resultOf(tx, request, true);
    }
    if (
      request.status !== "PENDING" ||
      request.approvalStatus !== "PENDING_APPROVAL"
    ) {
      fail("طلب التمويل لم يعد قابلاً للإلغاء", "CONFLICT");
    }
    const now = new Date();
    await tx
      .update(receipts)
      .set({
        status: "FAILED",
        approvalStatus: "REJECTED",
        approvedBy: owner.id,
        approvedAt: now,
        description: `${request.description ?? "طلب تمويل وردية"} — ألغاه المالك: ${cancellationReason}`,
      })
      .where(eq(receipts.id, request.id));
    await releaseFundingSourceLink(tx, Number(request.id), metadata);
    await tx.insert(auditLogs).values({
      userId: owner.id,
      branchId: metadata.branchId,
      action: "shift.funding.cancel",
      entityType: "receipt",
      entityId: String(request.id),
      oldValue: { status: "PENDING", approvalStatus: "PENDING_APPROVAL" },
      newValue: {
        status: "FAILED",
        approvalStatus: "REJECTED",
        cancellationReason,
      },
      ipAddress: actor.ipAddress ?? null,
    });
    const [failed] = await tx
      .select()
      .from(receipts)
      .where(eq(receipts.id, request.id))
      .limit(1);
    if (!failed) fail("تعذّر تثبيت إلغاء طلب التمويل", "CONFLICT");
    return resultOf(tx, failed, false);
  });
}

export async function respondToShiftFundingRequest(
  input: RespondShiftFundingInput,
  actor: ShiftFundingActor,
): Promise<ShiftFundingResult> {
  if (
    !Number.isInteger(input.requestReceiptId) ||
    input.requestReceiptId <= 0
  ) {
    fail("رقم طلب التمويل غير صالح", "BAD_REQUEST");
  }
  const rejectionReason = input.rejectionReason?.trim() ?? "";
  if (
    input.decision === "REJECT" &&
    (rejectionReason.length < 5 || rejectionReason.length > 500)
  ) {
    fail("سبب رفض التمويل يجب أن يكون بين 5 و500 محرف", "BAD_REQUEST");
  }

  return withTx(async (tx) => {
    const [preview] = await tx
      .select()
      .from(receipts)
      .where(eq(receipts.id, input.requestReceiptId))
      .limit(1);
    if (!preview) fail("طلب تمويل الوردية غير موجود", "NOT_FOUND");
    const metadata = parseMetadata(preview);
    if (
      metadata.targetUserId !== actor.userId ||
      metadata.branchId !== actor.branchId
    ) {
      fail("طلب التمويل مسند إلى صاحب وردية آخر", "FORBIDDEN");
    }

    if (input.decision === "REJECT") {
      // يطابق الرفض ترتيب قفل القبول/إلغاء المالك: درج الهدف → خزينة الفرع → الطلب.
      // قفل الإيصال أولاً قد ينشئ دورة receipt→branch مقابل branch→receipt عند إدراج سجل التدقيق.
      const [targetShift] = await tx
        .select({
          id: shifts.id,
          branchId: shifts.branchId,
          userId: shifts.userId,
        })
        .from(shifts)
        .where(eq(shifts.id, metadata.shiftId))
        .for("update")
        .limit(1);
      if (
        !targetShift ||
        Number(targetShift.branchId) !== metadata.branchId ||
        Number(targetShift.userId) !== metadata.targetUserId
      ) {
        fail("وردية طلب التمويل لم تعد تطابق صاحبها أو فرعها", "CONFLICT");
      }
      const [targetBranch] = await tx
        .select({ id: branches.id })
        .from(branches)
        .where(eq(branches.id, metadata.branchId))
        .for("update")
        .limit(1);
      if (!targetBranch) fail("فرع طلب التمويل غير موجود", "CONFLICT");

      const [request] = await tx
        .select()
        .from(receipts)
        .where(eq(receipts.id, input.requestReceiptId))
        .for("update")
        .limit(1);
      if (!request) fail("طلب تمويل الوردية غير موجود", "NOT_FOUND");
      const currentMetadata = parseMetadata(request);
      if (
        currentMetadata.targetUserId !== actor.userId ||
        currentMetadata.branchId !== actor.branchId
      ) {
        fail("طلب التمويل مسند إلى صاحب وردية آخر", "FORBIDDEN");
      }
      const link = await lockFundingSourceLink(
        tx,
        Number(request.id),
        currentMetadata,
      );
      if (
        request.status === "FAILED" &&
        request.approvalStatus === "REJECTED"
      ) {
        if (link.state !== "RELEASED") {
          fail("طلب التمويل المرفوض ما زال يحجز مصدره", "PRECONDITION_FAILED");
        }
        return resultOf(tx, request, true);
      }
      if (
        request.status !== "PENDING" ||
        request.approvalStatus !== "PENDING_APPROVAL"
      ) {
        fail("طلب التمويل لم يعد قابلاً للرفض", "CONFLICT");
      }
      if (link.state !== "PENDING") {
        fail("مصدر طلب التمويل لم يعد محجوزاً له", "PRECONDITION_FAILED");
      }
      const [target] = await tx
        .select({
          id: users.id,
          branchId: users.branchId,
          isActive: users.isActive,
        })
        .from(users)
        .where(eq(users.id, actor.userId))
        .for("share")
        .limit(1);
      if (
        !target?.isActive ||
        Number(target.branchId) !== currentMetadata.branchId
      ) {
        fail("صاحب الوردية غير نشط أو لم يعد تابعاً لفرع الوردية", "FORBIDDEN");
      }
      const now = new Date();
      await tx
        .update(receipts)
        .set({
          status: "FAILED",
          approvalStatus: "REJECTED",
          approvedBy: actor.userId,
          approvedAt: now,
          description: `${request.description ?? "طلب تمويل وردية"} — رُفض: ${rejectionReason}`,
        })
        .where(eq(receipts.id, input.requestReceiptId));
      await releaseFundingSourceLink(tx, Number(request.id), currentMetadata);
      await tx.insert(auditLogs).values({
        userId: actor.userId,
        branchId: metadata.branchId,
        action: "shift.funding.reject",
        entityType: "receipt",
        entityId: String(request.id),
        oldValue: { status: "PENDING", approvalStatus: "PENDING_APPROVAL" },
        newValue: {
          status: "FAILED",
          approvalStatus: "REJECTED",
          rejectionReason,
        },
        ipAddress: actor.ipAddress ?? null,
      });
      const [failed] = await tx
        .select()
        .from(receipts)
        .where(eq(receipts.id, request.id))
        .limit(1);
      if (!failed) fail("تعذّر تثبيت رفض طلب التمويل", "CONFLICT");
      return resultOf(tx, failed, false);
    }

    // إعادة الطلب بعد التنفيذ لا تحتاج إلى قفل حسابٍ مغلق أو إعادة إنفاق المبلغ.
    if (
      preview.status === "COMPLETED" &&
      preview.approvalStatus === "APPROVED"
    ) {
      const link = await lockFundingSourceLink(
        tx,
        Number(preview.id),
        metadata,
      );
      if (link.state !== "CONSUMED") {
        fail(
          "طلب التمويل المنفذ لا يملك رابط مصدر مستهلكاً",
          "PRECONDITION_FAILED",
        );
      }
      return resultOf(tx, preview, true);
    }

    assertTreasuryOutException("SHIFT_FLOAT_INTERNAL");
    let availability: Awaited<ReturnType<typeof assertCashTransferAvailable>>;
    try {
      availability = await assertCashTransferAvailable(tx, {
        source: {
          branchId: metadata.branchId,
          cashBucket: "TREASURY",
          shiftId: null,
        },
        destination: {
          branchId: metadata.branchId,
          cashBucket: "DRAWER",
          shiftId: metadata.shiftId,
        },
        amount: metadata.amount,
        operation: "تسليم تمويل إضافي لوردية مفتوحة",
      });
    } catch (error) {
      // قبولان متزامنان: الثاني قد يرى الرصيد بعد خصم الأول قبل أن يقفل الطلب.
      // نقرأ الطلب بعد قفل الحسابات؛ إن كان الأول قد أتمّه فهذه إعادة آمنة، وإلا نعيد الخطأ الأصلي.
      const request = await lockRequestAndSource(
        tx,
        input.requestReceiptId,
        metadata,
      );
      if (
        request.status === "COMPLETED" &&
        request.approvalStatus === "APPROVED"
      ) {
        return resultOf(tx, request, true);
      }
      throw error;
    }
    const [shift] = await tx
      .select()
      .from(shifts)
      .where(eq(shifts.id, metadata.shiftId))
      .for("update")
      .limit(1);
    if (
      !shift ||
      shift.status !== "OPEN" ||
      Number(shift.branchId) !== metadata.branchId ||
      Number(shift.userId) !== metadata.targetUserId
    ) {
      fail(
        "الوردية المستهدفة أُغلقت أو تغيّر صاحبها؛ لا يمكن تسليم التمويل",
        "CONFLICT",
      );
    }
    const drawerBefore = await computeDrawerCashBalance(
      tx,
      metadata.shiftId,
      shift.openingBalance,
    );
    if (drawerBefore.isNegative()) {
      fail("لا يجوز تمويل وردية سالبة عبر مسار العهدة الإضافية");
    }
    const request = await lockRequestAndSource(
      tx,
      input.requestReceiptId,
      metadata,
    );
    if (
      request.status === "COMPLETED" &&
      request.approvalStatus === "APPROVED"
    ) {
      const replay = await resultOf(tx, request, true);
      replay.drawerBalanceAfter = toDbMoney(drawerBefore);
      return replay;
    }
    if (
      request.status !== "PENDING" ||
      request.approvalStatus !== "PENDING_APPROVAL"
    ) {
      fail("طلب التمويل لم يعد قابلاً للقبول", "CONFLICT");
    }
    const [target, maker] = await Promise.all([
      tx
        .select({
          id: users.id,
          name: users.name,
          branchId: users.branchId,
          isActive: users.isActive,
        })
        .from(users)
        .where(eq(users.id, actor.userId))
        .for("share")
        .limit(1)
        .then((rows) => rows[0]),
      tx
        .select({
          id: users.id,
          isActive: users.isActive,
          isOwner: users.isOwner,
        })
        .from(users)
        .where(eq(users.id, metadata.requestedBy))
        .for("share")
        .limit(1)
        .then((rows) => rows[0]),
    ]);
    if (!target?.isActive || Number(target.branchId) !== metadata.branchId) {
      fail("صاحب الوردية غير نشط أو لم يعد تابعاً لفرع الوردية", "FORBIDDEN");
    }
    if (
      !maker?.isActive ||
      !maker.isOwner ||
      Number(maker.id) === Number(target.id)
    ) {
      fail("صانع طلب التمويل لم يعد مالكاً نشطاً مستقلاً", "FORBIDDEN");
    }

    const now = new Date();
    await tx
      .update(receipts)
      .set({
        cashBucket: "TREASURY",
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        approvedBy: actor.userId,
        approvedAt: now,
        createdAt: now,
        voucherDate: now,
      })
      .where(eq(receipts.id, request.id));
    await tx
      .update(shiftFundingSourceLinks)
      .set({ state: "CONSUMED", activeTargetShiftId: null })
      .where(eq(shiftFundingSourceLinks.requestReceiptId, Number(request.id)));
    const insert = await tx.insert(receipts).values({
      branchId: metadata.branchId,
      shiftId: metadata.shiftId,
      direction: "IN",
      amount: metadata.amount,
      paymentMethod: "CASH",
      cashBucket: "DRAWER",
      referenceNumber: request.referenceNumber,
      status: "COMPLETED",
      partyType: "OTHER",
      description: `عهدة إضافية مستلمة للوردية #${metadata.shiftId}: ${metadata.evidenceNote}`,
      internalNote: request.internalNote,
      signatureHash: request.signatureHash,
      approvalStatus: "APPROVED",
      approvedBy: actor.userId,
      approvedAt: now,
      createdBy: actor.userId,
      createdAt: now,
    });
    const drawerInReceiptId = extractInsertId(insert);
    const postingAmount = money(metadata.amount);
    const postingSource = {
      roleDebits: { CASH: postingAmount },
      roleCredits: { TREASURY_CASH: postingAmount },
    };
    await postEntry(tx, {
      entryType: "SHIFT_FLOAT_OUT",
      postingIntent: createPostingIntent(
        "SHIFT_FLOAT_FROM_TREASURY",
        "SHIFT_FLOAT_OUT",
        [
          debitLine("CASH", postingAmount),
          creditLine("TREASURY_CASH", postingAmount),
        ],
        postingSource,
      ),
      postingSourceComponents: postingSource,
      branchId: metadata.branchId,
      receiptId: Number(request.id),
      amount: postingAmount,
      dedupeKey: `SHIFT_TOPUP:${request.id}`,
      notes: `تمويل إضافي للوردية #${metadata.shiftId}: ${metadata.evidenceNote}`,
      createdBy: actor.userId,
      createdByNameSnapshot: target.name ?? null,
    });
    const drawerAfter = drawerBefore.plus(metadata.amount);
    await tx.insert(auditLogs).values({
      userId: actor.userId,
      branchId: metadata.branchId,
      action: "shift.funding.accept",
      entityType: "receipt",
      entityId: String(request.id),
      oldValue: {
        status: "PENDING",
        approvalStatus: "PENDING_APPROVAL",
        drawerBefore: toDbMoney(drawerBefore),
      },
      newValue: {
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        drawerInReceiptId,
        treasuryBalanceAfter: availability.availableAfter,
        drawerAfter: toDbMoney(drawerAfter),
        sourceTreasuryReceiptId: metadata.sourceTreasuryReceiptId,
      },
      ipAddress: actor.ipAddress ?? null,
    });
    const [completed] = await tx
      .select()
      .from(receipts)
      .where(eq(receipts.id, request.id))
      .limit(1);
    if (!completed) fail("تعذّر تثبيت تمويل الوردية", "CONFLICT");
    const result = await resultOf(tx, completed, false);
    result.drawerInReceiptId = drawerInReceiptId;
    result.treasuryBalanceAfter = availability.availableAfter;
    result.drawerBalanceAfter = toDbMoney(drawerAfter);
    return result;
  });
}

/** عقد ثابت لاختبار الحارس: لا أثر مالي لطلب PENDING، والأثر الوحيد عند القبول. */
export const SHIFT_ADDITIONAL_FUNDING_CONTRACT = Object.freeze({
  requestStatus: "PENDING",
  requestApprovalStatus: "PENDING_APPROVAL",
  requestCashBucket: null,
  materialEntryType: "SHIFT_FLOAT_OUT",
  treasuryException: "SHIFT_FLOAT_INTERNAL",
});
