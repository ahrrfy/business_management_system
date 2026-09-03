import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  like,
  lt,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import {
  accountingEntries,
  cashDailyReconciliations,
  cashVarianceCaseEvents,
  cashVarianceCases,
  idempotencyKeys,
  receipts,
  shifts,
} from "../../drizzle/schema";
import type { Tx } from "../db";
import { logAuditTx, type AuditMetadata } from "./auditService";
import {
  hasCashVariance,
  isCashVarianceWithinTolerance,
} from "../../shared/cashDailyReconciliation";
import {
  checkIdempotency,
  idempotencyHash,
  payloadHashMatches,
  recordIdempotencyKey,
} from "./idempotency";
import { extractInsertId } from "../lib/insertId";
import { todayUtcDate, utcDayRange } from "./businessDay";
import { lockCashSourceForUpdate } from "./cash/cashAvailability";
import { cashEventAtSql } from "./cash/cashEventAt";
import {
  validateCashBreakdown,
  type CashBreakdown,
} from "./cash/countValidation";
import { money, toDbMoney } from "./money";
import { withTx, type Actor } from "./tx";

type AuditContext = AuditMetadata;

export type DailyCashBlockerCode =
  | "OPEN_SHIFT"
  | "UNMATCHED_SHIFT"
  | "PENDING_CUSTODY"
  | "STALE_EVIDENCE"
  | "TREASURY_VARIANCE"
  | "SEPARATION_OF_DUTIES";

interface Evidence {
  expectedTreasuryCash: string;
  evidenceHash: string;
  shiftCount: number;
  openShiftCount: number;
  unmatchedShiftCount: number;
  pendingCustodyCount: number;
  custodyVarianceCount: number;
  treasuryReceiptCount: number;
  treasuryLastReceiptId: number;
}

async function checkReopenIdempotencyCurrentTx(
  tx: Tx,
  operation: string,
  clientRequestId: string,
  payloadHash: string,
): Promise<number | null> {
  // Locking read مهم بعد انتظار قفل الشهادة: القراءة العادية في MySQL REPEATABLE READ
  // قد تبقى على snapshot سبق تسجيل المفتاح في معاملةٍ منافسة.
  const row = (
    await tx
      .select({
        refId: idempotencyKeys.refId,
        payloadHash: idempotencyKeys.payloadHash,
      })
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.operation, operation),
          eq(idempotencyKeys.clientRequestId, clientRequestId),
        ),
      )
      .for("update")
      .limit(1)
  )[0];
  if (!row) return null;
  if (row.payloadHash == null) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذّرت إعادة فتح شهادة إقفال اليوم",
        why: "معرّف الطلب المُرسَل مسجَّل من نسخةٍ قديمة بلا بصمة، فلا سبيل للتأكّد أنّه طلبك أنت لا طلب إعادة فتحٍ آخر بنفس المعرّف",
        doThis: "حدّث شاشة إقفال اليوم ليُولَّد معرّف طلبٍ جديد، ثمّ أعد إعادة الفتح بالسبب نفسه",
      }),
    });
  }
  if (!payloadHashMatches(payloadHash, row.payloadHash)) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذّرت إعادة فتح شهادة إقفال اليوم",
        why: "نفس معرّف الطلب وصل قبل قليل بسببٍ أو بنسخة شهادةٍ مختلفة عمّا أرسلتَه الآن، وإتمامه يعني تنفيذ طلبين بهويّةٍ واحدة",
        doThis: "حدّث الصفحة ليُولَّد معرّف طلبٍ جديد، ثمّ أعد الإرسال بالسبب والنسخة المعروضين أمامك",
      }),
    });
  }
  return Number(row.refId);
}

async function checkDailyCountIdempotencyCurrentTx(
  tx: Tx,
  operation: string,
  clientRequestId: string,
  payloadHash: string,
): Promise<number | null> {
  const row = (
    await tx
      .select({
        refId: idempotencyKeys.refId,
        payloadHash: idempotencyKeys.payloadHash,
      })
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.operation, operation),
          eq(idempotencyKeys.clientRequestId, clientRequestId),
        ),
      )
      .for("update")
      .limit(1)
  )[0];
  if (!row) return null;
  if (row.payloadHash == null || !payloadHashMatches(payloadHash, row.payloadHash)) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذّر تسجيل جرد الخزينة",
        why: "معرّف طلب الجرد المُرسَل مستعمَلٌ لعدٍّ آخر يختلف عنه في المبلغ أو الفئات أو الملاحظة، أو أنّه مسجَّل من نسخةٍ قديمة بلا بصمة",
        doThis: "حدّث شاشة إقفال اليوم ليُولَّد معرّف طلبٍ جديد، ثمّ أعد إدخال العدّ",
      }),
    });
  }
  return Number(row.refId);
}

async function loadDailyCountReplayTx(tx: Tx, refId: number) {
  const row = (
    await tx
      .select()
      .from(cashDailyReconciliations)
      .where(eq(cashDailyReconciliations.id, refId))
      .limit(1)
  )[0];
  if (!row) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذّر عرض نتيجة الجرد المُعاد",
        why: `معرّف الطلب مسجَّل على الشهادة ${refId} وهذه الشهادة لم تعد موجودة، فلا نتيجة نعيدها لك`,
        doThis: "حدّث شاشة إقفال اليوم وأعد الجرد بمعرّف طلبٍ جديد، وأبلغ المدير لمراجعة سجلّ التدقيق إن تكرّر",
      }),
    });
  }
  return { ...row, idempotent: true as const };
}

function assertBranchScope(actor: Actor, branchId: number) {
  if (actor.role !== "admin" && Number(actor.branchId) !== Number(branchId)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: `تعذّر فتح مطابقة خزينة الفرع ${branchId}`,
        why: `صلاحيتك محصورةٌ بفرعك (${actor.branchId})، وعبور الفروع للمدير العام وحده`,
        doThis: "افتح مطابقة خزينة فرعك من شاشة إقفال اليوم، أو اطلب من المدير العام تنفيذها على الفرع الآخر",
      }),
    });
  }
}

export async function buildDailyCashEvidenceTx(
  tx: Tx,
  branchId: number,
  businessDate: string,
  options?: { excludeReceiptIds?: number[] },
): Promise<Evidence> {
  const { start, endExclusive } = utcDayRange(businessDate, businessDate);
  const today = businessDate === todayUtcDate();
  const treasuryCashEventAt = cashEventAtSql({
    approvedBy: receipts.approvedBy,
    createdBy: receipts.createdBy,
    approvedAt: receipts.approvedAt,
    createdAt: receipts.createdAt,
  });

  const treasuryHash = createHash("sha256");
  let treasuryCursor = 0;
  let treasuryReceiptCount = 0;
  let treasuryFirstReceiptId = 0;
  let treasuryLastReceiptId = 0;
  let expected = money(0);
  while (true) {
    const page = await tx
      .select({
        id: receipts.id,
        direction: receipts.direction,
        amount: receipts.amount,
        status: receipts.status,
      })
      .from(receipts)
      .where(
        and(
          eq(receipts.branchId, branchId),
          eq(receipts.cashBucket, "TREASURY"),
          eq(receipts.paymentMethod, "CASH"),
          eq(receipts.approvalStatus, "APPROVED"),
          or(eq(receipts.status, "COMPLETED"), eq(receipts.status, "REVERSED")),
          lt(treasuryCashEventAt, endExclusive),
          gt(receipts.id, treasuryCursor),
          ...(options?.excludeReceiptIds?.length
            ? [notInArray(receipts.id, options.excludeReceiptIds)]
            : []),
        ),
      )
      .orderBy(asc(receipts.id))
      .limit(500);
    if (page.length === 0) break;
    for (const row of page) {
      const id = Number(row.id);
      if (treasuryFirstReceiptId === 0) treasuryFirstReceiptId = id;
      treasuryLastReceiptId = id;
      treasuryReceiptCount += 1;
      expected =
        row.direction === "IN"
          ? expected.plus(row.amount)
          : expected.minus(row.amount);
      treasuryHash.update(
        JSON.stringify([id, row.direction, row.amount, row.status]),
      );
      treasuryHash.update("\n");
    }
    treasuryCursor = treasuryLastReceiptId;
  }
  const treasuryDigest = treasuryHash.digest("hex");

  const dayShifts = await tx
    .select({
      id: shifts.id,
      status: shifts.status,
      expectedCash: shifts.expectedCash,
      countedCash: shifts.countedCash,
      variance: shifts.variance,
      reconciliationStatus: shifts.reconciliationStatus,
    })
    .from(shifts)
    .where(
      and(
        eq(shifts.branchId, branchId),
        gte(shifts.openedAt, start),
        lt(shifts.openedAt, endExclusive),
      ),
    )
    .orderBy(asc(shifts.id));
  const openShiftCount = today
    ? await tx
        .select({ count: sql<number>`COUNT(*)` })
        .from(shifts)
        .where(and(eq(shifts.branchId, branchId), eq(shifts.status, "OPEN")))
        .then((rows) => Number(rows[0]?.count ?? 0))
    : 0;
  const unmatchedShiftCount = dayShifts.filter(
    (row) =>
      row.status !== "CLOSED" ||
      row.reconciliationStatus !== "MATCHED" ||
      row.variance == null ||
      hasCashVariance(row.variance) ||
      row.expectedCash == null ||
      row.countedCash == null ||
      !money(row.expectedCash).eq(money(row.countedCash)),
  ).length;

  const pendingHash = createHash("sha256");
  let pendingCursor = 0;
  let pendingCustodyCount = 0;
  let pendingFirstId = 0;
  let pendingLastId = 0;
  while (true) {
    const page = await tx
      .select({
        id: receipts.id,
        amount: receipts.amount,
        referenceNumber: receipts.referenceNumber,
      })
      .from(receipts)
      .where(
        and(
          eq(receipts.branchId, branchId),
          eq(receipts.direction, "IN"),
          eq(receipts.cashBucket, "TREASURY"),
          eq(receipts.paymentMethod, "CASH"),
          eq(receipts.status, "PENDING"),
          eq(receipts.approvalStatus, "APPROVED"),
          or(
            like(receipts.referenceNumber, "CD-%"),
            like(receipts.referenceNumber, "CH-%"),
          ),
          lt(receipts.createdAt, endExclusive),
          gt(receipts.id, pendingCursor),
        ),
      )
      .orderBy(asc(receipts.id))
      .limit(500);
    if (page.length === 0) break;
    for (const row of page) {
      const id = Number(row.id);
      if (pendingFirstId === 0) pendingFirstId = id;
      pendingLastId = id;
      pendingCustodyCount += 1;
      pendingHash.update(JSON.stringify([id, row.amount, row.referenceNumber]));
      pendingHash.update("\n");
    }
    pendingCursor = pendingLastId;
  }
  const pendingDigest = pendingHash.digest("hex");
  const custodyVarianceCount =
    pendingCustodyCount === 0
      ? 0
      : await tx
          .execute(
            sql`
        SELECT COUNT(*) AS count
        FROM cashCustodyCounts c
        INNER JOIN (
          SELECT treasuryReceiptId, MAX(id) AS maxId
          FROM cashCustodyCounts
          GROUP BY treasuryReceiptId
        ) latest ON latest.maxId = c.id
        INNER JOIN receipts r ON r.id = c.treasuryReceiptId
        WHERE r.branchId = ${branchId}
          AND r.receiptStatus = 'PENDING'
          AND c.cashCustodyCountStatus = 'VARIANCE_OPEN'
      `,
          )
          .then((result) => {
            const rows =
              (result as unknown as [Array<{ count: number | string }>])?.[0] ??
              [];
            return Number(rows[0]?.count ?? 0);
          });

  const canonical = JSON.stringify({
    branchId,
    businessDate,
    treasury: [
      treasuryReceiptCount,
      treasuryFirstReceiptId,
      treasuryLastReceiptId,
      treasuryDigest,
      toDbMoney(expected),
    ],
    shifts: dayShifts.map((row) => [
      row.id,
      row.status,
      row.expectedCash,
      row.countedCash,
      row.variance,
      row.reconciliationStatus,
    ]),
    pendingCustody: [
      pendingCustodyCount,
      pendingFirstId,
      pendingLastId,
      pendingDigest,
    ],
  });

  return {
    expectedTreasuryCash: toDbMoney(expected),
    evidenceHash: createHash("sha256").update(canonical).digest("hex"),
    shiftCount: dayShifts.length,
    openShiftCount,
    unmatchedShiftCount,
    pendingCustodyCount,
    custodyVarianceCount,
    treasuryReceiptCount,
    treasuryLastReceiptId,
  };
}

async function assertTreasurySnapshotStillCurrentTx(
  tx: Tx,
  branchId: number,
  businessDate: string,
  evidence: Evidence,
): Promise<void> {
  const { endExclusive } = utcDayRange(businessDate, businessDate);
  const eventAt = cashEventAtSql({
    approvedBy: receipts.approvedBy,
    createdBy: receipts.createdBy,
    approvedAt: receipts.approvedAt,
    createdAt: receipts.createdAt,
  });
  const snapshot = (
    await tx
      .select({
        count: sql<number>`COUNT(*)`,
        lastId: sql<string>`COALESCE(MAX(${receipts.id}), 0)`,
        expected: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'IN' THEN ${receipts.amount} ELSE -${receipts.amount} END), 0)`,
      })
      .from(receipts)
      .where(
        and(
          eq(receipts.branchId, branchId),
          eq(receipts.cashBucket, "TREASURY"),
          eq(receipts.paymentMethod, "CASH"),
          eq(receipts.approvalStatus, "APPROVED"),
          or(eq(receipts.status, "COMPLETED"), eq(receipts.status, "REVERSED")),
          lt(eventAt, endExclusive),
        ),
      )
  )[0];
  if (
    Number(snapshot?.count ?? 0) !== evidence.treasuryReceiptCount ||
    Number(snapshot?.lastId ?? 0) !== evidence.treasuryLastReceiptId ||
    !money(snapshot?.expected ?? 0).eq(money(evidence.expectedTreasuryCash))
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: `تعذّر تسجيل جرد خزينة يوم ${businessDate}`,
        why: `سُجّلت حركة خزينةٍ نقدية أثناء تجهيز الدليل: الرصيد المتوقَّع صار ${String(snapshot?.expected ?? 0)} بعد أن كان ${evidence.expectedTreasuryCash} لحظة بدء العدّ`,
        doThis: "حدّث الشاشة ليُعاد حساب الرصيد المتوقَّع على الحركات الحالية، ثمّ أعد إدخال العدّ",
      }),
    });
  }
}

interface ApprovedDailyResolution {
  caseId: number;
  adjustmentReceiptId: number;
  accountingEntryId: number;
  advanceId: number | null;
  approvedAt: Date;
}

/**
 * لا تكفي حالة الصف وحدها لإعفاء الفرق. يجب أن يطابق سجل append-only المعتمد
 * شهادة العد التاريخية نفسها (البصمة والمبالغ) وأن يحمل سنداً وقيداً فعليين.
 */
async function findApprovedDailyResolutionTx(
  tx: Tx,
  row: typeof cashDailyReconciliations.$inferSelect,
): Promise<ApprovedDailyResolution | null> {
  const resolution = (
    await tx
      .select({
        caseId: cashVarianceCases.id,
        adjustmentReceiptId: cashVarianceCaseEvents.adjustmentReceiptId,
        accountingEntryId: cashVarianceCaseEvents.accountingEntryId,
        advanceId: cashVarianceCaseEvents.advanceId,
        counterAccountRole: cashVarianceCaseEvents.counterAccountRole,
        approvedAt: cashVarianceCaseEvents.createdAt,
        adjustmentBranchId: receipts.branchId,
        adjustmentDirection: receipts.direction,
        adjustmentAmount: receipts.amount,
        adjustmentPaymentMethod: receipts.paymentMethod,
        adjustmentCashBucket: receipts.cashBucket,
        adjustmentStatus: receipts.status,
        adjustmentApprovalStatus: receipts.approvalStatus,
        adjustmentReference: receipts.referenceNumber,
        entryReceiptId: accountingEntries.receiptId,
        entryBranchId: accountingEntries.branchId,
        entryDedupeKey: accountingEntries.dedupeKey,
      })
      .from(cashVarianceCases)
      .innerJoin(
        cashVarianceCaseEvents,
        and(
          eq(cashVarianceCaseEvents.caseId, cashVarianceCases.id),
          eq(cashVarianceCaseEvents.eventType, "APPROVED"),
        ),
      )
      .innerJoin(
        receipts,
        eq(receipts.id, cashVarianceCaseEvents.adjustmentReceiptId),
      )
      .innerJoin(
        accountingEntries,
        eq(accountingEntries.id, cashVarianceCaseEvents.accountingEntryId),
      )
      .where(
        and(
          eq(cashVarianceCases.sourceType, "DAILY_TREASURY"),
          eq(cashVarianceCases.dailyReconciliationId, Number(row.id)),
          eq(cashVarianceCases.sourceEvidenceHash, row.evidenceHash),
          eq(
            cashVarianceCases.expectedAmount,
            String(row.expectedTreasuryCash),
          ),
          eq(cashVarianceCases.actualAmount, String(row.countedTreasuryCash)),
          eq(cashVarianceCases.variance, String(row.variance)),
        ),
      )
      .orderBy(desc(cashVarianceCaseEvents.id))
      .limit(1)
  )[0];
  if (
    !resolution ||
    resolution.adjustmentReceiptId == null ||
    resolution.accountingEntryId == null ||
    Number(resolution.adjustmentBranchId) !== Number(row.branchId) ||
    Number(resolution.entryBranchId) !== Number(row.branchId) ||
    Number(resolution.entryReceiptId) !==
      Number(resolution.adjustmentReceiptId) ||
    resolution.entryDedupeKey !== `CASH_VARIANCE:${resolution.caseId}` ||
    resolution.adjustmentPaymentMethod !== "CASH" ||
    resolution.adjustmentCashBucket !== "TREASURY" ||
    resolution.adjustmentStatus !== "COMPLETED" ||
    resolution.adjustmentApprovalStatus !== "APPROVED" ||
    resolution.adjustmentReference !== `CV-${resolution.caseId}` ||
    !money(resolution.adjustmentAmount).eq(money(row.variance).abs()) ||
    (money(row.variance).isNegative()
      ? resolution.adjustmentDirection !== "OUT" ||
        resolution.counterAccountRole !== "LOSSES" ||
        resolution.advanceId != null
      : resolution.adjustmentDirection !== "IN" ||
        resolution.counterAccountRole !== "OTHER_LIABILITY" ||
        resolution.advanceId != null)
  ) {
    return null;
  }
  return {
    caseId: Number(resolution.caseId),
    adjustmentReceiptId: Number(resolution.adjustmentReceiptId),
    accountingEntryId: Number(resolution.accountingEntryId),
    advanceId:
      resolution.advanceId == null ? null : Number(resolution.advanceId),
    approvedAt: resolution.approvedAt,
  };
}

/**
 * علاجُ كلّ عائق. الرسالة كانت تُسمّي العائق وتقف، فيقرأ المحاسب «توجد ورديات غير مطابقة»
 * ولا يعرف أين يعالجها. الخريطة **نصٌّ محضٌ** يُركَّب عند الرمي — لا تدخل في أيّ فحصٍ ولا
 * تغيّر أيّ قرار.
 */
const DAILY_CASH_BLOCKER_REMEDY: Record<DailyCashBlockerCode, string> = {
  OPEN_SHIFT: "أغلق الورديات المفتوحة من تبويب الورديات في الخزينة",
  UNMATCHED_SHIFT: "طابِق كل وردية مغلقة حتى يتساوى متوقَّعها مع معدودها",
  PENDING_CUSTODY: "اعدد عهد النقد واقبلها من طابور عهد الاستلام في الخزينة",
  STALE_EVIDENCE: "أعد جرد الخزينة على الحركات الحالية",
  TREASURY_VARIANCE: "افتح قضية فرق نقد واعتمد سند التصحيح بمبلغ الفرق",
  SEPARATION_OF_DUTIES: "اطلب الاعتماد من مستخدمٍ غير من عدّ الخزينة",
};

/** يجمع علاجات العوائق القائمة بلا تكرار، بترتيب ظهورها. */
function dailyCashBlockerRemedy(
  blockers: ReadonlyArray<{ code: DailyCashBlockerCode }>,
): string {
  return Array.from(
    new Set(blockers.map((item) => DAILY_CASH_BLOCKER_REMEDY[item.code])),
  ).join("، ثمّ ");
}

function blockersFor(evidence: Evidence) {
  const blockers: Array<{
    code: DailyCashBlockerCode;
    message: string;
    count: number;
    amount?: string;
  }> = [];
  if (evidence.openShiftCount > 0) {
    blockers.push({
      code: "OPEN_SHIFT",
      message: "توجد ورديات مفتوحة في الفرع",
      count: evidence.openShiftCount,
    });
  }
  if (evidence.unmatchedShiftCount > 0) {
    blockers.push({
      code: "UNMATCHED_SHIFT",
      message: "توجد ورديات غير مطابقة",
      count: evidence.unmatchedShiftCount,
    });
  }
  if (evidence.pendingCustodyCount > 0) {
    blockers.push({
      code: "PENDING_CUSTODY",
      message: "توجد عهد نقد لم تُعدّ وتُقبل بعد",
      count: evidence.pendingCustodyCount,
    });
  }
  return blockers;
}

export async function getDailyCashReconciliation(
  input: { branchId: number; businessDate: string },
  actor: Actor,
) {
  assertBranchScope(actor, input.branchId);
  return withTx(
    async (tx) => {
      const currentEvidence = await buildDailyCashEvidenceTx(
        tx,
        input.branchId,
        input.businessDate,
      );
      const row =
        (
          await tx
            .select()
            .from(cashDailyReconciliations)
            .where(
              and(
                eq(cashDailyReconciliations.branchId, input.branchId),
                eq(cashDailyReconciliations.businessDate, input.businessDate),
              ),
            )
            .limit(1)
        )[0] ?? null;
      const resolution =
        row == null ? null : await findApprovedDailyResolutionTx(tx, row);
      const evidence =
        resolution == null
          ? currentEvidence
          : await buildDailyCashEvidenceTx(
              tx,
              input.branchId,
              input.businessDate,
              {
                excludeReceiptIds: [resolution.adjustmentReceiptId],
              },
            );
      const blockers = blockersFor(evidence);
      const stale = Boolean(row && row.evidenceHash !== evidence.evidenceHash);
      if (stale)
        blockers.push({
          code: "STALE_EVIDENCE",
          message: "تغيرت الحركات بعد آخر عدّ؛ أعد الجرد",
          count: 1,
        });
      if (row && hasCashVariance(row.variance) && resolution == null) {
        blockers.push({
          code: "TREASURY_VARIANCE",
          message: "الجرد الفعلي لا يطابق رصيد النظام",
          count: 1,
          amount: String(row.variance),
        });
      }
      const separationBlocked = Boolean(
        (row?.status === "MATCHED" ||
          row?.status === "RESOLVED_WITH_ADJUSTMENT") &&
        Number(row.countedByUserId) === actor.userId,
      );
      if (separationBlocked) {
        blockers.push({
          code: "SEPARATION_OF_DUTIES",
          message: "اعتماد الإقفال يحتاج مستخدماً مختلفاً عن منفّذ الجرد",
          count: 1,
        });
      }
      return {
        businessDate: input.businessDate,
        branchId: input.branchId,
        expectedTreasuryCash:
          row?.status === "CLOSED" || resolution != null
            ? String(row.expectedTreasuryCash)
            : evidence.expectedTreasuryCash,
        evidence,
        currentEvidence,
        reconciliation: row,
        resolution,
        blockers,
        actions: {
          canCount:
            input.businessDate === todayUtcDate() &&
            row?.status !== "CLOSED" &&
            row?.status !== "RESOLVED_WITH_ADJUSTMENT" &&
            blockersFor(evidence).length === 0,
          canClose:
            (row?.status === "MATCHED" ||
              (row?.status === "RESOLVED_WITH_ADJUSTMENT" &&
                resolution != null)) &&
            !stale &&
            !separationBlocked &&
            blockers.length === 0 &&
            (row.status === "RESOLVED_WITH_ADJUSTMENT" ||
              isCashVarianceWithinTolerance(row.variance)),
          canReopen:
            row?.status === "CLOSED" &&
            input.businessDate === todayUtcDate() &&
            Number(row.closedByUserId) !== actor.userId &&
            Number(row.countedByUserId) !== actor.userId,
        },
      };
    },
    { gate: "NONE" },
  );
}

export async function recordDailyTreasuryCount(
  input: {
    branchId: number;
    businessDate: string;
    countedCash: string;
    countedBreakdown: CashBreakdown;
    notes?: string | null;
    expectedVersion: number;
    clientRequestId: string;
  },
  actor: Actor,
  auditCtx: AuditContext,
) {
  assertBranchScope(actor, input.branchId);
  const counted = money(input.countedCash);
  const breakdown = validateCashBreakdown(input.countedBreakdown, counted, {
    requiredWhenPositive: true,
  });
  const normalizedNotes = input.notes?.trim() || null;
  const clientRequestId = input.clientRequestId.trim();
  if (!clientRequestId || clientRequestId.length > 64) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر تسجيل جرد الخزينة",
        why: `معرّف طلب الجرد مفقود أو يتجاوز 64 محرفاً (المُرسَل ${clientRequestId.length} محرفاً)، وهو ما يمنع تسجيل العدّ نفسه مرّتين عند إعادة الإرسال`,
        doThis: "حدّث شاشة إقفال اليوم ليُولَّد معرّف طلبٍ صالح، ثمّ أعد إدخال العدّ",
      }),
    });
  }
  const idempotencyOperation = "treasury.dailyCash.count";
  const payloadHash = idempotencyHash({
    branchId: input.branchId,
    businessDate: input.businessDate,
    countedCash: toDbMoney(counted),
    countedBreakdown: breakdown,
    notes: normalizedNotes,
    countedByUserId: actor.userId,
  });
  const canonicalBreakdown = (value: unknown) =>
    JSON.stringify(
      Object.entries((value ?? {}) as Record<string, unknown>)
        .map(([denomination, count]) => [denomination, Number(count)] as const)
        .sort(([left], [right]) => Number(left) - Number(right)),
    );
  const evidenceBeforeLock =
    input.businessDate === todayUtcDate()
      ? await withTx(
          (tx) =>
            buildDailyCashEvidenceTx(tx, input.branchId, input.businessDate),
          { gate: "NONE" },
        )
      : null;
  return withTx(async (tx) => {
    const replay = await checkIdempotency(
      tx,
      idempotencyOperation,
      clientRequestId,
      payloadHash,
      { requireStoredHash: true },
    );
    if (replay != null) return loadDailyCountReplayTx(tx, replay);
    if (input.businessDate !== todayUtcDate()) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: `تعذّر تسجيل الجرد المادي لتاريخ ${input.businessDate}`,
          why: `الجرد المادي متاح لليوم الحالي فقط (${todayUtcDate()})، وشهادة يومٍ مضى دليلٌ مقفل لا يُعاد عدّه`,
          doThis: "اجرد خزينة اليوم الحالي من شاشة إقفال اليوم؛ ولتوثيق يومٍ فائت بلا جرد استعمل «استثناء الجرد الفائت» في الشاشة نفسها",
        }),
      });
    }
    await lockCashSourceForUpdate(tx, {
      branchId: input.branchId,
      cashBucket: "TREASURY",
      shiftId: null,
    });
    const replayAfterLock = await checkDailyCountIdempotencyCurrentTx(
      tx,
      idempotencyOperation,
      clientRequestId,
      payloadHash,
    );
    if (replayAfterLock != null)
      return loadDailyCountReplayTx(tx, replayAfterLock);
    const existing = (
      await tx
        .select()
        .from(cashDailyReconciliations)
        .where(
          and(
            eq(cashDailyReconciliations.branchId, input.branchId),
            eq(cashDailyReconciliations.businessDate, input.businessDate),
          ),
        )
        .for("update")
        .limit(1)
    )[0];
    if (existing?.lastClientRequestId === clientRequestId) {
      if (
        !money(existing.countedTreasuryCash).eq(counted) ||
        canonicalBreakdown(existing.countedBreakdown) !==
          canonicalBreakdown(breakdown) ||
        (existing.notes ?? null) !== normalizedNotes
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: `تعذّر تسجيل جرد خزينة يوم ${input.businessDate}`,
            why: `مفتاح المحاولة نفسه سجّل عدّاً سابقاً بمبلغ ${String(existing.countedTreasuryCash)}، وأنت ترسل الآن ${toDbMoney(counted)} أو فئاتٍ أو ملاحظةً مختلفة`,
            doThis: "حدّث الشاشة ليُولَّد مفتاح محاولةٍ جديد، ثمّ أعد إدخال العدّ الصحيح",
          }),
        });
      }
      return { ...existing, idempotent: true };
    }
    if (evidenceBeforeLock == null) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: `تعذّر تسجيل الجرد المادي لتاريخ ${input.businessDate}`,
          why: `الجرد المادي متاح لليوم الحالي فقط (${todayUtcDate()})، ولم يُجهَّز دليل خزينةٍ لتاريخٍ غيره`,
          doThis: "اجرد خزينة اليوم الحالي من شاشة إقفال اليوم؛ ولتوثيق يومٍ فائت بلا جرد استعمل «استثناء الجرد الفائت» في الشاشة نفسها",
        }),
      });
    }
    await assertTreasurySnapshotStillCurrentTx(
      tx,
      input.branchId,
      input.businessDate,
      evidenceBeforeLock,
    );
    const evidence = evidenceBeforeLock;
    const evidenceBlockers = blockersFor(evidence);
    if (evidenceBlockers.length > 0) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: `تعذّر تسجيل جرد خزينة يوم ${input.businessDate}`,
          why: `العوائق القائمة: ${evidenceBlockers
            .map((item) => `${item.message} (${item.count})`)
            .join("، ")}`,
          doThis: `${dailyCashBlockerRemedy(evidenceBlockers)}، ثمّ أعد جرد الخزينة من شاشة إقفال اليوم`,
        }),
      });
    }
    if (existing?.status === "CLOSED") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: `تعذّر تسجيل جرد خزينة يوم ${input.businessDate}`,
          why: "مطابقة اليوم مغلقة، والمغلقة لا تقبل عدّاً جديداً كي لا يتبدّل الدليل بعد اعتماده",
          doThis: "اطلب من مستخدمٍ ثالثٍ — غير من عدّ ومن اعتمد — إعادة فتح الشهادة بسببٍ مكتوب، ثمّ أعد الجرد",
        }),
      });
    }
    if (existing?.status === "RESOLVED_WITH_ADJUSTMENT") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: `تعذّر تسجيل جرد خزينة يوم ${input.businessDate}`,
          why: `فرق الجرد المسجَّل ${String(existing?.variance ?? "0")} محسومٌ بسند تصحيح معتمد، وإعادة العدّ تستبدل الدليل الذي بُني عليه السند`,
          doThis: "أغلق الشهادة كما هي من شاشة إقفال اليوم؛ ولتغيير الحسم اعكس سند التصحيح أوّلاً ثمّ أعد الجرد",
        }),
      });
    }
    if (
      existing
        ? Number(existing.version) !== input.expectedVersion
        : input.expectedVersion !== 0
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: `تعذّر تسجيل جرد خزينة يوم ${input.businessDate}`,
          why: `نسخة المطابقة تغيّرت: شاشتك ترسل النسخة ${input.expectedVersion} والمخزَّن الآن ${existing ? Number(existing.version) : 0}`,
          doThis: "حدّث الشاشة لتقرأ النسخة الحالية وأرقامها، ثمّ أعد إدخال العدّ",
        }),
      });
    }
    const variance = counted.minus(evidence.expectedTreasuryCash);
    const status = isCashVarianceWithinTolerance(variance)
      ? "MATCHED"
      : "VARIANCE_OPEN";
    const values = {
      branchId: input.branchId,
      businessDate: input.businessDate,
      expectedTreasuryCash: evidence.expectedTreasuryCash,
      countedTreasuryCash: toDbMoney(counted),
      variance: toDbMoney(variance),
      countedBreakdown: breakdown,
      status,
      notes: normalizedNotes,
      lastClientRequestId: clientRequestId,
      evidenceHash: evidence.evidenceHash,
      shiftCount: evidence.shiftCount,
      custodyCount: evidence.pendingCustodyCount,
      countedByUserId: actor.userId,
      countedAt: new Date(),
      closedByUserId: null,
      closedAt: null,
    } as const;
    let id: number;
    if (existing) {
      await tx
        .update(cashDailyReconciliations)
        .set({
          ...values,
          version: sql`${cashDailyReconciliations.version} + 1`,
        })
        .where(eq(cashDailyReconciliations.id, existing.id));
      id = Number(existing.id);
    } else {
      const inserted = await tx.insert(cashDailyReconciliations).values(values);
      id = extractInsertId(inserted);
    }
    await recordIdempotencyKey(
      tx,
      idempotencyOperation,
      clientRequestId,
      id,
      payloadHash,
    );
    await logAuditTx(tx, auditCtx, {
      action: existing
        ? "treasury.dailyCash.recount"
        : "treasury.dailyCash.count",
      entityType: "cashDailyReconciliation",
      entityId: id,
      oldValue: existing ?? null,
      newValue: {
        ...values,
        id,
        version: existing ? Number(existing.version) + 1 : 1,
      },
    });
    return {
      id,
      ...values,
      version: existing ? Number(existing.version) + 1 : 1,
      idempotent: false,
    };
  });
}

export async function closeDailyCashReconciliation(
  input: {
    reconciliationId: number;
    expectedVersion: number;
    clientRequestId: string;
  },
  actor: Actor,
  auditCtx: AuditContext,
) {
  return withTx(async (tx) => {
    const candidate = (
      await tx
        .select({ branchId: cashDailyReconciliations.branchId })
        .from(cashDailyReconciliations)
        .where(eq(cashDailyReconciliations.id, input.reconciliationId))
        .limit(1)
    )[0];
    if (!candidate)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: `تعذّر إقفال شهادة المطابقة ${input.reconciliationId}`,
          why: "لا توجد مطابقة خزينةٍ بهذا الرقم — إمّا حُذفت وإمّا أنّ الرقم من شاشةٍ قديمة",
          doThis: "ارجع إلى شاشة إقفال اليوم واختر الفرع والتاريخ من القائمة بدل الرقم المباشر",
        }),
      });
    assertBranchScope(actor, Number(candidate.branchId));
    await lockCashSourceForUpdate(tx, {
      branchId: Number(candidate.branchId),
      cashBucket: "TREASURY",
      shiftId: null,
      allowClosedCashDay: true,
    });
    const row = (
      await tx
        .select()
        .from(cashDailyReconciliations)
        .where(eq(cashDailyReconciliations.id, input.reconciliationId))
        .for("update")
        .limit(1)
    )[0];
    if (!row)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: `تعذّر إقفال شهادة المطابقة ${input.reconciliationId}`,
          why: "الشهادة اختفت بين قراءتها وقفلها، فلم يبقَ صفٌّ نُقفله",
          doThis: "حدّث شاشة إقفال اليوم واختر الفرع والتاريخ من القائمة من جديد",
        }),
      });
    assertBranchScope(actor, Number(row.branchId));
    if (
      row.status === "CLOSED" &&
      row.closeClientRequestId === input.clientRequestId
    ) {
      return { ...row, idempotent: true };
    }
    if (row.status !== "MATCHED" && row.status !== "RESOLVED_WITH_ADJUSTMENT") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: `تعذّر إقفال مطابقة يوم ${row.businessDate}`,
          why: `الشهادة ليست «مطابقة» ولا «محسومة الفرق بسند تصحيح معتمد»، وهما الحالتان الوحيدتان اللتان يقبلهما الإقفال — والفرق المسجَّل عليها الآن ${String(row.variance)}`,
          doThis: "أعد جرد الخزينة حتى يطابق المعدود رصيد النظام، أو افتح قضية فرق نقد واعتمد سند التصحيح ثمّ أقفل",
        }),
      });
    }
    if (Number(row.version) !== input.expectedVersion) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: `تعذّر إقفال مطابقة يوم ${row.businessDate}`,
          why: `نسخة المطابقة تغيّرت: شاشتك ترسل النسخة ${input.expectedVersion} والمخزَّن الآن ${Number(row.version)}`,
          doThis: "حدّث الشاشة لتقرأ النسخة الحالية وأرقامها، ثمّ أعد اعتماد الإقفال",
        }),
      });
    }
    if (Number(row.countedByUserId) === actor.userId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: `تعذّر اعتماد إقفال يوم ${row.businessDate}`,
          why: "أنت من عدّ الخزينة، وفصل المهام يمنع أن يعتمد العادُّ إقفال عدّه نفسه",
          doThis: "اطلب من مستخدمٍ آخر له صلاحية الخزينة اعتماد الإقفال من شاشة إقفال اليوم",
        }),
      });
    }
    const resolution =
      row.status === "RESOLVED_WITH_ADJUSTMENT"
        ? await findApprovedDailyResolutionTx(tx, row)
        : null;
    if (row.status === "RESOLVED_WITH_ADJUSTMENT" && resolution == null) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: `تعذّر إقفال مطابقة يوم ${row.businessDate}`,
          why: `الشهادة موسومة «محسومة بسند تصحيح» ولا قضية فرق نقدٍ معتمدة تطابق أرقامها: المتوقَّع ${String(row.expectedTreasuryCash)} والمعدود ${String(row.countedTreasuryCash)} والفرق ${String(row.variance)}`,
          doThis: "افتح قضية فرق النقد لهذا اليوم واعتمد سند التصحيح بمبلغ الفرق نفسه، ثمّ أعد الإقفال",
        }),
      });
    }
    const evidence = await buildDailyCashEvidenceTx(
      tx,
      Number(row.branchId),
      row.businessDate,
      resolution == null
        ? undefined
        : { excludeReceiptIds: [resolution.adjustmentReceiptId] },
    );
    const blockers = blockersFor(evidence);
    if (
      blockers.length > 0 ||
      evidence.evidenceHash !== row.evidenceHash ||
      !money(evidence.expectedTreasuryCash).eq(
        money(row.expectedTreasuryCash),
      ) ||
      (row.status === "MATCHED" && hasCashVariance(row.variance))
    ) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: `تعذّر إقفال مطابقة يوم ${row.businessDate}`,
          why: `أرقام اليوم لم تعد كما عُدَّت: الرصيد المتوقَّع الآن ${evidence.expectedTreasuryCash} مقابل ${String(row.expectedTreasuryCash)} وقت العدّ، والفرق المسجَّل ${String(row.variance)}، والعوائق القائمة ${blockers.length}`,
          doThis: "عالِج ما تعرضه «عوائق المطابقة» في شاشة إقفال اليوم، ثمّ أعد جرد الخزينة على الأرقام الحالية قبل الإقفال",
        }),
      });
    }
    const now = new Date();
    await tx
      .update(cashDailyReconciliations)
      .set({
        status: "CLOSED",
        closeClientRequestId: input.clientRequestId,
        closedByUserId: actor.userId,
        closedAt: now,
        version: sql`${cashDailyReconciliations.version} + 1`,
      })
      .where(eq(cashDailyReconciliations.id, row.id));
    await logAuditTx(tx, auditCtx, {
      action: "treasury.dailyCash.close",
      entityType: "cashDailyReconciliation",
      entityId: Number(row.id),
      oldValue: { status: row.status, version: row.version },
      newValue: {
        status: "CLOSED",
        version: Number(row.version) + 1,
        closedByUserId: actor.userId,
        resolutionCaseId: resolution?.caseId ?? null,
      },
    });
    return {
      ...row,
      status: "CLOSED" as const,
      closedAt: now,
      closedByUserId: actor.userId,
      version: Number(row.version) + 1,
      resolution,
      idempotent: false,
    };
  });
}

export async function reopenDailyCashReconciliation(
  input: {
    reconciliationId: number;
    expectedVersion: number;
    reason: string;
    clientRequestId: string;
  },
  actor: Actor,
  auditCtx: AuditContext,
) {
  const reason = input.reason.trim();
  const clientRequestId = input.clientRequestId.trim();
  if (reason.length < 10) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّرت إعادة فتح شهادة إقفال اليوم",
        why: `سبب إعادة الفتح يُحفظ في سجلّ التدقيق فيلزمه تفصيل: أرسلتَ ${reason.length} حرفاً والحدّ الأدنى 10`,
        doThis: "اكتب ما الذي استجدّ ويوجب إعادة العدّ (حركةٌ فاتت، أو خطأ إدخال، أو عهدة وصلت متأخّرة) ثمّ أعد الإرسال",
      }),
    });
  }
  if (!clientRequestId || clientRequestId.length > 64) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّرت إعادة فتح شهادة إقفال اليوم",
        why: `معرّف طلب إعادة الفتح مفقود أو يتجاوز 64 محرفاً (المُرسَل ${clientRequestId.length} محرفاً)، وهو ما يمنع تكرار التنفيذ عند إعادة الإرسال`,
        doThis: "حدّث شاشة إقفال اليوم ليُولَّد معرّف طلبٍ صالح، ثمّ أعد إعادة الفتح",
      }),
    });
  }
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّرت إعادة فتح شهادة إقفال اليوم",
        why: `نسخة الشهادة المتوقَّعة المُرسَلة (${String(input.expectedVersion)}) ليست عدداً صحيحاً لا يقلّ عن 1، والنسخة هي ما يمنع إعادة فتح شهادةٍ تغيّرت`,
        doThis: "حدّث الصفحة لتقرأ نسخة الشهادة الحالية، ثمّ أعد إعادة الفتح",
      }),
    });
  }
  const idempotencyOperation = "treasury.dailyCash.reopen";
  const payloadHash = idempotencyHash({
    reconciliationId: input.reconciliationId,
    expectedVersion: input.expectedVersion,
    reason,
  });

  return withTx(async (tx) => {
    const candidate = (
      await tx
        .select({
          id: cashDailyReconciliations.id,
          branchId: cashDailyReconciliations.branchId,
          status: cashDailyReconciliations.status,
          version: cashDailyReconciliations.version,
        })
        .from(cashDailyReconciliations)
        .where(eq(cashDailyReconciliations.id, input.reconciliationId))
        .limit(1)
    )[0];
    if (!candidate)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: `تعذّرت إعادة فتح شهادة المطابقة ${input.reconciliationId}`,
          why: "لا توجد مطابقة خزينةٍ بهذا الرقم — إمّا حُذفت وإمّا أنّ الرقم من شاشةٍ قديمة",
          doThis: "ارجع إلى شاشة إقفال اليوم واختر الفرع والتاريخ من القائمة بدل الرقم المباشر",
        }),
      });
    assertBranchScope(actor, Number(candidate.branchId));

    // افحص الإعادة قبل أي شرط حالة: قد تكون الشهادة أُعيد إقفالها بنسخة أحدث.
    // إعادة الطلب القديم يجب أن تبقى قراءةً فقط ولا تعيد فتح الشهادة الجديدة.
    const replay = await checkIdempotency(
      tx,
      idempotencyOperation,
      clientRequestId,
      payloadHash,
      { requireStoredHash: true },
    );
    if (replay != null) {
      if (Number(replay) !== Number(candidate.id)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّرت إعادة فتح شهادة إقفال اليوم",
            why: `معرّف طلب إعادة الفتح مستعمَلٌ سابقاً لشهادةٍ أخرى، لا للشهادة ${input.reconciliationId} التي تطلبها الآن`,
            doThis: "حدّث الصفحة ليُولَّد معرّف طلبٍ جديد لهذه الشهادة، ثمّ أعد إعادة الفتح",
          }),
        });
      }
      return {
        id: Number(candidate.id),
        status: candidate.status,
        version: Number(candidate.version),
        reopenedVersion: input.expectedVersion + 1,
        idempotent: true as const,
      };
    }

    await lockCashSourceForUpdate(tx, {
      branchId: Number(candidate.branchId),
      cashBucket: "TREASURY",
      shiftId: null,
      allowClosedCashDay: true,
    });
    const row = (
      await tx
        .select()
        .from(cashDailyReconciliations)
        .where(eq(cashDailyReconciliations.id, input.reconciliationId))
        .for("update")
        .limit(1)
    )[0];
    if (!row)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: `تعذّرت إعادة فتح شهادة المطابقة ${input.reconciliationId}`,
          why: "الشهادة اختفت بين قراءتها وقفلها، فلم يبقَ صفٌّ نعيد فتحه",
          doThis: "حدّث شاشة إقفال اليوم واختر الفرع والتاريخ من القائمة من جديد",
        }),
      });
    assertBranchScope(actor, Number(row.branchId));

    // يغلق سباق طلبين وصلا قبل تسجيل مفتاح العملية الأول. قفل صف الشهادة يجعل
    // الفحص الثاني يرى المفتاح الذي سجله الفائز بعد تحرير القفل.
    const replayAfterLock = await checkReopenIdempotencyCurrentTx(
      tx,
      idempotencyOperation,
      clientRequestId,
      payloadHash,
    );
    if (replayAfterLock != null) {
      if (Number(replayAfterLock) !== Number(row.id)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّرت إعادة فتح شهادة إقفال اليوم",
            why: `معرّف طلب إعادة الفتح مستعمَلٌ سابقاً لشهادةٍ أخرى، لا للشهادة ${input.reconciliationId} التي تطلبها الآن`,
            doThis: "حدّث الصفحة ليُولَّد معرّف طلبٍ جديد لهذه الشهادة، ثمّ أعد إعادة الفتح",
          }),
        });
      }
      return {
        id: Number(row.id),
        status: row.status,
        version: Number(row.version),
        reopenedVersion: input.expectedVersion + 1,
        idempotent: true as const,
      };
    }

    if (row.businessDate !== todayUtcDate()) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: `تعذّرت إعادة فتح شهادة يوم ${row.businessDate}`,
          why: `إعادة الفتح متاحة لليوم الحالي فقط (${todayUtcDate()})، ومطابقة يومٍ مضى دليلٌ تاريخيّ لا يُعاد عدّه`,
          doThis: "عالِج الفرق على اليوم الحالي بسند تصحيح معتمد؛ ولتوثيق يومٍ فائت بلا جرد استعمل «استثناء الجرد الفائت» من شاشة إقفال اليوم",
        }),
      });
    }
    if (row.status !== "CLOSED") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: `تعذّرت إعادة فتح شهادة يوم ${row.businessDate}`,
          why: "الشهادة ليست في حالة «مغلقة»، وإعادة الفتح لا تُطبَّق إلّا على شهادةٍ أُقفلت واعتُمدت",
          doThis: "حدّث الشاشة لترى حالتها الحالية؛ إن كانت ما تزال مفتوحة فأكمل الجرد أو الإقفال مباشرةً",
        }),
      });
    }
    if (Number(row.version) !== input.expectedVersion) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: `تعذّرت إعادة فتح شهادة يوم ${row.businessDate}`,
          why: `نسخة الشهادة تغيّرت: صفحتك ترسل النسخة ${input.expectedVersion} والمخزَّن الآن ${Number(row.version)}`,
          doThis: "حدّث الصفحة لتقرأ النسخة الحالية، ثمّ أعد إعادة الفتح بالسبب نفسه",
        }),
      });
    }
    if (
      Number(row.closedByUserId) === actor.userId ||
      Number(row.countedByUserId) === actor.userId
    ) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: `تعذّرت إعادة فتح شهادة يوم ${row.businessDate}`,
          why: "أنت من عدّ الخزينة أو من اعتمد إقفالها، وإعادة الفتح تحتاج مستخدماً ثالثاً غيرهما",
          doThis: "اطلب من مستخدمٍ ثالثٍ له صلاحية الخزينة أن يعيد الفتح بسببٍ مكتوب من شاشة إقفال اليوم",
        }),
      });
    }
    const now = new Date();
    const updateResult = await tx
      .update(cashDailyReconciliations)
      .set({
        status: "REOPENED",
        reopenedByUserId: actor.userId,
        reopenedAt: now,
        reopenReason: reason,
        version: sql`${cashDailyReconciliations.version} + 1`,
      })
      .where(
        and(
          eq(cashDailyReconciliations.id, row.id),
          eq(cashDailyReconciliations.status, "CLOSED"),
          eq(cashDailyReconciliations.version, input.expectedVersion),
        ),
      );
    const affectedRows = Number(
      (updateResult as unknown as [{ affectedRows?: number }])[0]
        ?.affectedRows ??
        (updateResult as unknown as { affectedRows?: number }).affectedRows ??
        0,
    );
    if (affectedRows !== 1) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: `تعذّرت إعادة فتح شهادة يوم ${row.businessDate}`,
          why: `حالة الشهادة أو نسختها تبدّلت في اللحظة نفسها (كانت النسخة المتوقَّعة ${input.expectedVersion})، فلم يُطبَّق التعديل ولم يتغيّر شيء`,
          doThis: "حدّث الصفحة لتقرأ الحالة والنسخة الحاليتين، ثمّ أعد إعادة الفتح إن كانت ما تزال مغلقة",
        }),
      });
    }
    await recordIdempotencyKey(
      tx,
      idempotencyOperation,
      clientRequestId,
      Number(row.id),
      payloadHash,
    );
    await logAuditTx(tx, auditCtx, {
      action: "treasury.dailyCash.reopen",
      entityType: "cashDailyReconciliation",
      entityId: Number(row.id),
      oldValue: {
        status: "CLOSED",
        version: Number(row.version),
        closedByUserId:
          row.closedByUserId == null ? null : Number(row.closedByUserId),
        evidenceHash: row.evidenceHash,
      },
      newValue: {
        status: "REOPENED",
        version: Number(row.version) + 1,
        reason,
        reopenedByUserId: actor.userId,
        clientRequestId,
        payloadHash,
      },
    });
    return {
      id: Number(row.id),
      status: "REOPENED" as const,
      version: Number(row.version) + 1,
      reopenedVersion: Number(row.version) + 1,
      idempotent: false as const,
    };
  });
}
