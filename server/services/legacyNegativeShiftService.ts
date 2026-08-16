import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, asc, eq } from "drizzle-orm";
import {
  accountingEntries,
  auditLogs,
  receipts,
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
  assertCashOutAvailable,
  assertTreasuryOutException,
  computeDrawerCashBalance,
  lockCashSourceForUpdate,
} from "./cash/cashAvailability";
import { postEntry } from "./ledgerService";
import { money, toDbMoney } from "./money";
import { withTx, type Actor } from "./tx";

/**
 * لحظة تفعيل حارس الرصيد غير السالب على الإنتاج. لا يجوز استعمال مسار التصحيح
 * الاستثنائي لوردية فُتحت بعده؛ أي عجز جديد يجب إصلاح مستنده من وحدته الأصلية.
 */
export const LEGACY_NEGATIVE_SHIFT_CUTOFF = new Date(
  "2026-08-15T15:43:48.000Z",
);

export interface LegacyNegativeShiftItem {
  shiftId: number;
  /** لقطة سالبة يوافق عليها المالك؛ تمنع المعالجة إذا تغيّر الرصيد بعد فتح الحوار. */
  expectedCash: string;
  /** إيصال TREASURY IN لسحبٍ سابق لم تُسجَّل ساقه إلى هذه الوردية، إن وُجد. */
  sourceTreasuryReceiptId?: number | null;
  evidenceNote: string;
  confirmDrawerCountedZero: true;
  clientRequestId: string;
}

export interface LegacyNegativeShiftActor extends Actor {
  ipAddress?: string | null;
}

type LockedShift = typeof shifts.$inferSelect;

type CorrectionMetadata = {
  kind: "LEGACY_NEGATIVE_SHIFT_REMEDIATION";
  version: 1;
  shiftId: number;
  originalExpectedCash: string;
  appliedAmount: string;
  sourceTreasuryReceiptId: number | null;
  sourceReferenceNumber: string | null;
  sourceAmount: string | null;
  sourceResidualInTreasury: string | null;
  sourceFingerprint: string | null;
  evidenceNote: string;
  clientRequestId: string;
  payloadHash: string;
};

export interface LegacyNegativeShiftResult {
  shiftId: number;
  openingBalance: string;
  originalExpectedCash: string;
  expectedCash: "0.00";
  countedCash: "0.00";
  variance: "0.00";
  reconciliationStatus: "MATCHED";
  treasuryOutReceiptId: number;
  drawerInReceiptId: number;
  fundingAmount: string;
  sourceTreasuryReceiptId: number | null;
  sourceResidualInTreasury: string | null;
  referenceNumber: string;
  alreadyApplied: boolean;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function dedupeKey(item: LegacyNegativeShiftItem): string {
  return item.sourceTreasuryReceiptId != null
    ? `LEGACY_SHIFT_SOURCE:${item.sourceTreasuryReceiptId}`
    : `LEGACY_SHIFT_FUND:${item.shiftId}`;
}

function referenceNumber(item: LegacyNegativeShiftItem): string {
  return item.sourceTreasuryReceiptId != null
    ? `LSR-${item.shiftId}-S${item.sourceTreasuryReceiptId}`
    : `LSR-${item.shiftId}`;
}

function normalizedInput(item: LegacyNegativeShiftItem) {
  const evidenceNote = item.evidenceNote.trim();
  if (evidenceNote.length < 20 || evidenceNote.length > 1000) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "وصف دليل معالجة الوردية مطلوب (من 20 إلى 1000 حرف)",
    });
  }
  if (item.confirmDrawerCountedZero !== true) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "يجب تأكيد أن النقد المعدود فعلياً في درج الوردية يساوي صفراً",
    });
  }
  const expectedCash = money(item.expectedCash);
  if (!expectedCash.isFinite() || !expectedCash.isNegative()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "مسار المعالجة التاريخية مخصص لرصيد متوقع سالب فقط",
    });
  }
  const clientRequestId = item.clientRequestId.trim();
  if (!clientRequestId || clientRequestId.length > 64) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "مفتاح الطلب غير صالح",
    });
  }
  return {
    ...item,
    evidenceNote,
    clientRequestId,
    expectedCash: toDbMoney(expectedCash),
    sourceTreasuryReceiptId: item.sourceTreasuryReceiptId ?? null,
  };
}

function parseMetadata(value: string | null): CorrectionMetadata | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<CorrectionMetadata>;
    return parsed.kind === "LEGACY_NEGATIVE_SHIFT_REMEDIATION" &&
      parsed.version === 1
      ? (parsed as CorrectionMetadata)
      : null;
  } catch {
    return null;
  }
}

async function loadCommittedReplay(
  tx: Tx,
  item: ReturnType<typeof normalizedInput>,
  sh: LockedShift,
): Promise<LegacyNegativeShiftResult | null> {
  const key = dedupeKey(item);
  const [entry] = await tx
    .select({
      receiptId: accountingEntries.receiptId,
      dedupeKey: accountingEntries.dedupeKey,
    })
    .from(accountingEntries)
    .where(eq(accountingEntries.dedupeKey, key))
    .limit(1);
  if (!entry?.receiptId) return null;

  const [outReceipt] = await tx
    .select()
    .from(receipts)
    .where(eq(receipts.id, Number(entry.receiptId)))
    .limit(1);
  const metadata = parseMetadata(outReceipt?.internalNote ?? null);
  if (
    !outReceipt ||
    !metadata ||
    outReceipt.direction !== "OUT" ||
    outReceipt.paymentMethod !== "CASH" ||
    outReceipt.cashBucket !== "TREASURY" ||
    outReceipt.status !== "COMPLETED" ||
    outReceipt.approvalStatus !== "APPROVED" ||
    outReceipt.signatureHash !== metadata.payloadHash ||
    !outReceipt.referenceNumber ||
    outReceipt.referenceNumber !== referenceNumber(item) ||
    Number(outReceipt.branchId) !== Number(sh.branchId) ||
    !money(outReceipt.amount).eq(metadata.appliedAmount)
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `وردية #${item.shiftId}: وُجد مفتاح معالجة سابق غير قابل للإثبات`,
    });
  }
  const expectedPayloadHash = sha256({
    shiftId: item.shiftId,
    originalExpectedCash: item.expectedCash,
    sourceTreasuryReceiptId: item.sourceTreasuryReceiptId,
    evidenceNote: item.evidenceNote,
    clientRequestId: item.clientRequestId,
  });
  if (
    metadata.payloadHash !== expectedPayloadHash ||
    metadata.shiftId !== item.shiftId ||
    sh.status !== "CLOSED" ||
    toDbMoney(money(sh.expectedCash ?? "0")) !== "0.00" ||
    toDbMoney(money(sh.countedCash ?? "0")) !== "0.00" ||
    toDbMoney(money(sh.variance ?? "0")) !== "0.00"
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `وردية #${item.shiftId}: لا تطابق محاولة الإعادة المعالجة الملتزمة`,
    });
  }
  if (metadata.sourceTreasuryReceiptId != null) {
    const replaySource = await validateSourceReceipt(
      tx,
      item,
      sh,
      money(metadata.appliedAmount),
    );
    if (
      !replaySource ||
      replaySource.fingerprint !== metadata.sourceFingerprint
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `وردية #${item.shiftId}: تغيّر سند المصدر بعد المعالجة`,
      });
    }
  }
  const [drawerReceipt] = await tx
    .select({
      id: receipts.id,
      internalNote: receipts.internalNote,
      signatureHash: receipts.signatureHash,
    })
    .from(receipts)
    .where(
      and(
        eq(receipts.referenceNumber, outReceipt.referenceNumber),
        eq(receipts.shiftId, item.shiftId),
        eq(receipts.direction, "IN"),
        eq(receipts.paymentMethod, "CASH"),
        eq(receipts.cashBucket, "DRAWER"),
        eq(receipts.status, "COMPLETED"),
        eq(receipts.approvalStatus, "APPROVED"),
      ),
    )
    .orderBy(asc(receipts.id))
    .limit(1);
  if (
    !drawerReceipt ||
    drawerReceipt.signatureHash !== metadata.payloadHash ||
    parseMetadata(drawerReceipt.internalNote)?.payloadHash !==
      metadata.payloadHash
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `وردية #${item.shiftId}: ساق الدرج للمعالجة السابقة مفقودة`,
    });
  }
  return {
    shiftId: item.shiftId,
    openingBalance: toDbMoney(money(sh.openingBalance)),
    originalExpectedCash: metadata.originalExpectedCash,
    expectedCash: "0.00",
    countedCash: "0.00",
    variance: "0.00",
    reconciliationStatus: "MATCHED" as const,
    treasuryOutReceiptId: Number(outReceipt.id),
    drawerInReceiptId: Number(drawerReceipt.id),
    fundingAmount: metadata.appliedAmount,
    sourceTreasuryReceiptId: metadata.sourceTreasuryReceiptId,
    sourceResidualInTreasury: metadata.sourceResidualInTreasury,
    referenceNumber: String(outReceipt.referenceNumber),
    alreadyApplied: true as const,
  };
}

async function validateSourceReceipt(
  tx: Tx,
  item: ReturnType<typeof normalizedInput>,
  sh: LockedShift,
  deficit: ReturnType<typeof money>,
) {
  if (item.sourceTreasuryReceiptId == null) return null;
  const [source] = await tx
    .select()
    .from(receipts)
    .where(eq(receipts.id, item.sourceTreasuryReceiptId))
    .for("update")
    .limit(1);
  if (
    !source ||
    Number(source.branchId) !== Number(sh.branchId) ||
    source.shiftId != null ||
    source.direction !== "IN" ||
    source.paymentMethod !== "CASH" ||
    source.cashBucket !== "TREASURY" ||
    source.status !== "COMPLETED" ||
    source.approvalStatus !== "APPROVED" ||
    !source.referenceNumber?.startsWith("CD-") ||
    Number(source.createdBy) !== Number(sh.userId) ||
    new Date(source.createdAt).getTime() >=
      LEGACY_NEGATIVE_SHIFT_CUTOFF.getTime() ||
    money(source.amount).lt(deficit)
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `وردية #${item.shiftId}: إيصال مصدر السحب لا يثبت مبلغاً صالحاً في الخزينة`,
    });
  }

  const paired = await tx
    .select()
    .from(receipts)
    .where(eq(receipts.referenceNumber, source.referenceNumber))
    .orderBy(asc(receipts.id))
    .for("update");
  const drawerOuts = paired.filter(
    (row) =>
      Number(row.id) !== Number(source.id) &&
      row.direction === "OUT" &&
      row.paymentMethod === "CASH" &&
      row.cashBucket === "DRAWER" &&
      row.shiftId != null &&
      row.status === "COMPLETED" &&
      row.approvalStatus === "APPROVED" &&
      money(row.amount).eq(source.amount),
  );
  if (drawerOuts.length !== 1) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `وردية #${item.shiftId}: سلسلة حيازة السحب المصدر غير مكتملة أو غير وحيدة`,
    });
  }

  const sourceFingerprint = sha256({
    id: source.id,
    branchId: source.branchId,
    direction: source.direction,
    amount: toDbMoney(money(source.amount)),
    paymentMethod: source.paymentMethod,
    cashBucket: source.cashBucket,
    referenceNumber: source.referenceNumber,
    status: source.status,
    approvalStatus: source.approvalStatus,
    createdBy: source.createdBy,
    createdAt: new Date(source.createdAt).toISOString(),
    pairedDrawerOutId: drawerOuts[0]!.id,
  });
  return {
    id: Number(source.id),
    referenceNumber: source.referenceNumber,
    amount: toDbMoney(money(source.amount)),
    residual: toDbMoney(money(source.amount).minus(deficit)),
    fingerprint: sourceFingerprint,
  };
}

/**
 * تصحيح append-only لورديات سالبة موروثة فقط. يضيف خزينة OUT + درج IN متقابلين،
 * ثم يثبت أن الرصيد صار صفراً ويغلق الوردية داخل المعاملة نفسها. لا يعدّل أي إيصال تاريخي.
 */
export async function remediateAndCloseLegacyNegativeShifts(
  rawItems: LegacyNegativeShiftItem[],
  actor: LegacyNegativeShiftActor,
) {
  if (rawItems.length === 0 || rawItems.length > 20) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "عدد الورديات المطلوب معالجتها غير صالح",
    });
  }
  const items = rawItems
    .map(normalizedInput)
    .sort((a, b) => a.shiftId - b.shiftId);
  if (new Set(items.map((item) => item.shiftId)).size !== items.length) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "لا يجوز تكرار الوردية في طلب المعالجة",
    });
  }
  const sourceIds = items
    .map((item) => item.sourceTreasuryReceiptId)
    .filter((id): id is number => id != null);
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "لا يجوز استعمال إيصال المصدر لأكثر من وردية",
    });
  }

  return withTx(async (tx) => {
    // ترتيب الأقفال الحاكم: كل الأدراج تصاعدياً، ثم كل الخزائن، ثم المستخدم، ثم الإيصالات.
    const lockedShifts: LockedShift[] = [];
    for (const item of items) {
      const [sh] = await tx
        .select()
        .from(shifts)
        .where(eq(shifts.id, item.shiftId))
        .for("update")
        .limit(1);
      if (!sh)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `الوردية #${item.shiftId} غير موجودة`,
        });
      lockedShifts.push(sh);
    }
    const branchIds = Array.from(
      new Set(lockedShifts.map((sh) => Number(sh.branchId))),
    ).sort((a, b) => a - b);
    for (const branchId of branchIds) {
      await lockCashSourceForUpdate(tx, {
        branchId,
        cashBucket: "TREASURY",
        shiftId: null,
      });
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
    if (!owner?.isOwner || !owner.isActive) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "هذه المعالجة محصورة بحساب مالك نشط",
      });
    }

    const pending: Array<{
      item: ReturnType<typeof normalizedInput>;
      sh: LockedShift;
      expected: ReturnType<typeof money>;
      deficit: ReturnType<typeof money>;
    }> = [];
    const results: LegacyNegativeShiftResult[] = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      const sh = lockedShifts[index]!;
      if (Number(sh.userId) === Number(owner.id)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `وردية #${item.shiftId}: يلزم مالك مختلف عن صاحب الوردية`,
        });
      }
      if (sh.status !== "OPEN") {
        const replay = await loadCommittedReplay(tx, item, sh);
        if (!replay) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `الوردية #${item.shiftId} مغلقة وليست معالجة مطابقة`,
          });
        }
        results.push(replay);
        continue;
      }
      if (
        new Date(sh.openedAt).getTime() >=
        LEGACY_NEGATIVE_SHIFT_CUTOFF.getTime()
      ) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `الوردية #${item.shiftId} ليست ضمن الورديات التاريخية السابقة للحارس`,
        });
      }
      const expected = await computeDrawerCashBalance(
        tx,
        item.shiftId,
        sh.openingBalance,
      );
      if (!expected.isNegative() || !expected.eq(item.expectedCash)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `وردية #${item.shiftId}: تغيّر الرصيد المتوقع؛ حدّث التقرير قبل المعالجة`,
        });
      }
      const [existingDedupe] = await tx
        .select({ receiptId: accountingEntries.receiptId })
        .from(accountingEntries)
        .where(eq(accountingEntries.dedupeKey, dedupeKey(item)))
        .limit(1);
      if (existingDedupe) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `وردية #${item.shiftId}: استُعمل مصدر المعالجة أو مفتاحها سابقاً`,
        });
      }
      pending.push({ item, sh, expected, deficit: expected.abs() });
    }

    const fundingByBranch = new Map<number, ReturnType<typeof money>>();
    for (const row of pending) {
      const branchId = Number(row.sh.branchId);
      fundingByBranch.set(
        branchId,
        (fundingByBranch.get(branchId) ?? money(0)).plus(row.deficit),
      );
    }
    const treasury = [];
    for (const [branchId, amount] of Array.from(fundingByBranch.entries()).sort(
      ([a], [b]) => a - b,
    )) {
      assertTreasuryOutException("LEGACY_SHIFT_REMEDIATION_INTERNAL");
      const availability = await assertCashOutAvailable(tx, {
        branchId,
        cashBucket: "TREASURY",
        amount,
        operation: "معالجة الورديات السالبة الموروثة",
      });
      treasury.push({ branchId, amount: toDbMoney(amount), ...availability });
    }

    const now = new Date();
    for (const row of pending) {
      const { item, sh, expected, deficit } = row;
      const source = await validateSourceReceipt(tx, item, sh, deficit);
      const payloadHash = sha256({
        shiftId: item.shiftId,
        originalExpectedCash: item.expectedCash,
        sourceTreasuryReceiptId: item.sourceTreasuryReceiptId,
        evidenceNote: item.evidenceNote,
        clientRequestId: item.clientRequestId,
      });
      const metadata: CorrectionMetadata = {
        kind: "LEGACY_NEGATIVE_SHIFT_REMEDIATION",
        version: 1,
        shiftId: item.shiftId,
        originalExpectedCash: toDbMoney(expected),
        appliedAmount: toDbMoney(deficit),
        sourceTreasuryReceiptId: source?.id ?? null,
        sourceReferenceNumber: source?.referenceNumber ?? null,
        sourceAmount: source?.amount ?? null,
        sourceResidualInTreasury: source?.residual ?? null,
        sourceFingerprint: source?.fingerprint ?? null,
        evidenceNote: item.evidenceNote,
        clientRequestId: item.clientRequestId,
        payloadHash,
      };
      const internalNote = JSON.stringify(metadata);
      const ref = referenceNumber(item);
      const outRes = await tx.insert(receipts).values({
        branchId: Number(sh.branchId),
        shiftId: null,
        direction: "OUT",
        amount: toDbMoney(deficit),
        paymentMethod: "CASH",
        cashBucket: "TREASURY",
        referenceNumber: ref,
        status: "COMPLETED",
        partyType: "OTHER",
        description: `تمويل تصحيح وردية سالبة موروثة #${item.shiftId} من الخزينة`,
        internalNote,
        signatureHash: payloadHash,
        approvalStatus: "APPROVED",
        approvedBy: owner.id,
        approvedAt: now,
        createdBy: owner.id,
        createdAt: now,
      });
      const treasuryOutReceiptId = extractInsertId(outRes);
      const inRes = await tx.insert(receipts).values({
        branchId: Number(sh.branchId),
        shiftId: item.shiftId,
        direction: "IN",
        amount: toDbMoney(deficit),
        paymentMethod: "CASH",
        cashBucket: "DRAWER",
        referenceNumber: ref,
        status: "COMPLETED",
        partyType: "OTHER",
        description: `تصفير الرصيد المتوقع السالب لوردية #${item.shiftId} بتمويل الخزينة`,
        internalNote,
        signatureHash: payloadHash,
        approvalStatus: "APPROVED",
        approvedBy: owner.id,
        approvedAt: now,
        createdBy: owner.id,
        createdAt: now,
      });
      const drawerInReceiptId = extractInsertId(inRes);
      const postingSource = {
        roleDebits: { CASH: deficit },
        roleCredits: { TREASURY_CASH: deficit },
      };
      await postEntry(tx, {
        entryType: "SHIFT_FLOAT_OUT",
        postingIntent: createPostingIntent(
          "SHIFT_FLOAT_FROM_TREASURY",
          "SHIFT_FLOAT_OUT",
          [debitLine("CASH", deficit), creditLine("TREASURY_CASH", deficit)],
          postingSource,
        ),
        postingSourceComponents: postingSource,
        branchId: Number(sh.branchId),
        receiptId: treasuryOutReceiptId,
        amount: deficit,
        dedupeKey: dedupeKey(item),
        notes: `معالجة تاريخية للوردية #${item.shiftId}: ${item.evidenceNote}`,
        createdBy: owner.id,
        createdByNameSnapshot: owner.name ?? null,
      });

      const finalExpected = await computeDrawerCashBalance(
        tx,
        item.shiftId,
        sh.openingBalance,
      );
      if (!finalExpected.isZero()) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `وردية #${item.shiftId}: لم تصل المعالجة إلى صفر؛ تراجعت العملية كاملة`,
        });
      }
      const marker = `[LEGACY_NEGATIVE_SHIFT_REMEDIATION ${ref} expected=${toDbMoney(expected)} funded=${toDbMoney(deficit)}]`;
      await tx
        .update(shifts)
        .set({
          status: "CLOSED",
          closedAt: now,
          openGuard: null,
          expectedCash: "0.00",
          countedCash: "0.00",
          variance: "0.00",
          countedBreakdown: null,
          closingDrawerCash: "0.00",
          varianceReasonCode: null,
          varianceReason: null,
          reconciliationStatus: "MATCHED",
          closedByUserId: owner.id,
          varianceReviewedByUserId: null,
          notes: sh.notes ? `${sh.notes}\n${marker}` : marker,
        })
        .where(eq(shifts.id, item.shiftId));

      await tx.insert(auditLogs).values({
        userId: owner.id,
        branchId: Number(sh.branchId),
        action: "shift.legacy_negative_remediation",
        entityType: "shift",
        entityId: String(item.shiftId),
        oldValue: {
          status: sh.status,
          expectedCash: toDbMoney(expected),
          sourceTreasuryReceiptId: source?.id ?? null,
          sourceFingerprint: source?.fingerprint ?? null,
        },
        newValue: {
          status: "CLOSED",
          expectedCash: "0.00",
          countedCash: "0.00",
          variance: "0.00",
          treasuryOutReceiptId,
          drawerInReceiptId,
          fundingAmount: toDbMoney(deficit),
          sourceResidualInTreasury: source?.residual ?? null,
          payloadHash,
          evidenceNote: item.evidenceNote,
        },
        ipAddress: actor.ipAddress ?? null,
      });

      results.push({
        shiftId: item.shiftId,
        openingBalance: toDbMoney(money(sh.openingBalance)),
        originalExpectedCash: toDbMoney(expected),
        expectedCash: "0.00",
        countedCash: "0.00",
        variance: "0.00",
        reconciliationStatus: "MATCHED" as const,
        treasuryOutReceiptId,
        drawerInReceiptId,
        fundingAmount: toDbMoney(deficit),
        sourceTreasuryReceiptId: source?.id ?? null,
        sourceResidualInTreasury: source?.residual ?? null,
        referenceNumber: ref,
        alreadyApplied: false as const,
      });
    }

    return {
      items: results.sort((a, b) => Number(a.shiftId) - Number(b.shiftId)),
      treasury,
      totalFunding: toDbMoney(
        results.reduce(
          (sum, result) => sum.plus(result.fundingAmount),
          money(0),
        ),
      ),
      cutoff: LEGACY_NEGATIVE_SHIFT_CUTOFF.toISOString(),
    };
  });
}
