import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import {
  accountingEntries,
  cashDailyReconciliations,
  cashMissedDailyCountExceptions,
  doubleEntrySettings,
  financialPeriods,
  journalEntries,
  journalLines,
  monthCloseCertificateEvidence,
  monthCloseCertificates,
  monthCloseEvents,
  monthCloseRequests,
  monthCloseSequence,
  workOrders,
  yearEndReopenRequests,
  yearEndSnapshots,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import {
  POSTING_POLICY_HASH,
  verifyPostingIntentEvidence,
} from "../accounting/postingEngine";
import { money, toDbMoney } from "../money";
import {
  canonicalCloseJson,
  closeSha256,
  monthCutoff,
} from "./monthCloseSequence";
import type { MonthCloseReadinessResult } from "./monthCloseReadiness";
import type { DoubleEntryRuntime } from "../accounting/journalStore";

export const MONTH_CLOSE_CANONICAL_VERSION = "month-close/v1";
const EVIDENCE_CHUNK_SIZE = 500;

type CertificateKind = "MONTH_CLOSE" | "YEAR_END";

interface RequestEvidence {
  id: number;
  month: string;
  readinessSnapshot: string;
  requestedBy: number;
  requestedAt: Date;
}

export interface CreateMonthCloseCertificateInput {
  kind: CertificateKind;
  request: RequestEvidence;
  revision: number;
  periodId: number;
  approvedBy: number;
  approvedAt: Date;
  approvalReadiness: MonthCloseReadinessResult;
  /** Runtime read under the company close gate by the approving producer. */
  runtime: DoubleEntryRuntime;
  /** Full ACTIVE reconciliation independently derived inside the close tx. */
  doubleEntryIntegrity?: Record<string, unknown> | null;
  yearEndSnapshotId?: number | null;
  retainedEarningsEntryId?: number | null;
  yearEndEvidence?: Record<string, unknown> | null;
}

interface EvidenceChunk {
  datasetCode: string;
  chunkNo: number;
  rowCount: number;
  minId: number | null;
  maxId: number | null;
  canonicalRowsHash: string;
  referenceCanonical: string;
}

interface CertificateEnvelope {
  canonicalVersion: string;
  certificateNumber: string;
  month: string;
  revision: number;
  kind: CertificateKind;
  requestId: number;
  periodId: number;
  supersedesCertificateId: number | null;
  previousCertificateId: number | null;
  previousCertificateHash: string | null;
  yearEndSnapshotId: number | null;
  retainedEarningsEntryId: number | null;
  requestedBy: number;
  requestedAt: string;
  approvedBy: number;
  approvedAt: string;
  doubleEntryMode: "OFF" | "SHADOW" | "ACTIVE";
  cycleId: string | null;
  openingHash: string | null;
  postingPolicyHash: string | null;
  requestSnapshotHash: string;
  approvalReadinessHash: string;
  evidenceRootHash: string;
  snapshotHash: string;
}

function exactSecond(value: Date): Date {
  return new Date(Math.floor(value.getTime() / 1000) * 1000);
}

function parseStoredJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `${label} المخزنة ليست JSON صالحاً ولا يمكن ختمها.`,
    });
  }
}

function evidenceChunks(
  datasetCode: string,
  rows: Array<Record<string, unknown>>,
): EvidenceChunk[] {
  const chunks: EvidenceChunk[] = [];
  if (rows.length === 0) {
    const referenceCanonical = canonicalCloseJson([]);
    return [
      {
        datasetCode,
        chunkNo: 1,
        rowCount: 0,
        minId: null,
        maxId: null,
        canonicalRowsHash: closeSha256(referenceCanonical),
        referenceCanonical,
      },
    ];
  }
  for (let offset = 0; offset < rows.length; offset += EVIDENCE_CHUNK_SIZE) {
    const part = rows.slice(offset, offset + EVIDENCE_CHUNK_SIZE);
    const ids = part
      .map((row) => Number(row.id))
      .filter((id) => Number.isSafeInteger(id));
    const referenceCanonical = canonicalCloseJson(part);
    chunks.push({
      datasetCode,
      chunkNo: chunks.length + 1,
      rowCount: part.length,
      minId: ids.length ? Math.min(...ids) : null,
      maxId: ids.length ? Math.max(...ids) : null,
      canonicalRowsHash: closeSha256(referenceCanonical),
      referenceCanonical,
    });
  }
  return chunks;
}

function evidenceManifest(chunks: readonly EvidenceChunk[]) {
  return chunks
    .map((chunk) => ({
      datasetCode: chunk.datasetCode,
      chunkNo: chunk.chunkNo,
      rowCount: chunk.rowCount,
      minId: chunk.minId,
      maxId: chunk.maxId,
      canonicalRowsHash: chunk.canonicalRowsHash,
    }))
    .sort(
      (left, right) =>
        left.datasetCode.localeCompare(right.datasetCode) ||
        left.chunkNo - right.chunkNo,
    );
}

function certificateHash(envelope: CertificateEnvelope): string {
  return closeSha256(canonicalCloseJson(envelope));
}

function certificateNumber(month: string, revision: number): string {
  return `MC-${month}-R${String(revision).padStart(2, "0")}`;
}

async function buildEvidence(
  tx: Tx,
  input: CreateMonthCloseCertificateInput,
  runtime: {
    mode: "OFF" | "SHADOW" | "ACTIVE";
    cycleId: string | null;
  },
): Promise<{
  chunks: EvidenceChunk[];
  rootHash: string;
  snapshot: Record<string, unknown>;
}> {
  const from = `${input.request.month}-01`;
  const to = monthCutoff(input.request.month);
  const fromDate = new Date(`${from}T00:00:00.000Z`);
  const toDate = new Date(`${to}T00:00:00.000Z`);
  const missedCountCarry = alias(
    cashDailyReconciliations,
    "monthCloseMissedCountCarry",
  );

  const accountingRows = await tx
    .select({
      id: accountingEntries.id,
      entryType: accountingEntries.entryType,
      branchId: accountingEntries.branchId,
      amount: accountingEntries.amount,
      revenue: accountingEntries.revenue,
      cost: accountingEntries.cost,
      profit: accountingEntries.profit,
      taxAmount: accountingEntries.taxAmount,
      postingCycleId: accountingEntries.postingCycleId,
      postingProfile: accountingEntries.postingProfile,
      postingIntentHash: accountingEntries.postingIntentHash,
      entryDate: accountingEntries.entryDate,
      dedupeKey: accountingEntries.dedupeKey,
    })
    .from(accountingEntries)
    .where(
      and(
        gte(accountingEntries.entryDate, fromDate),
        lte(accountingEntries.entryDate, toDate),
      ),
    )
    .orderBy(asc(accountingEntries.id));
  const missedDailyCountRows = await tx
    .select({
      id: cashMissedDailyCountExceptions.id,
      branchId: cashMissedDailyCountExceptions.branchId,
      businessDate: cashMissedDailyCountExceptions.businessDate,
      carryForwardReconciliationId:
        cashMissedDailyCountExceptions.carryForwardReconciliationId,
      carryForwardBusinessDate:
        cashMissedDailyCountExceptions.carryForwardBusinessDate,
      carryForwardVersion:
        cashMissedDailyCountExceptions.carryForwardVersion,
      carryForwardEvidenceHash:
        cashMissedDailyCountExceptions.carryForwardEvidenceHash,
      missingDayEvidenceHash:
        cashMissedDailyCountExceptions.missingDayEvidenceHash,
      reason: cashMissedDailyCountExceptions.reason,
      evidenceReference: cashMissedDailyCountExceptions.evidenceReference,
      requestClientRequestId:
        cashMissedDailyCountExceptions.requestClientRequestId,
      requestHash: cashMissedDailyCountExceptions.requestHash,
      immutableEvidenceHash:
        cashMissedDailyCountExceptions.immutableEvidenceHash,
      requestedByUserId:
        cashMissedDailyCountExceptions.requestedByUserId,
      requestedAt: cashMissedDailyCountExceptions.requestedAt,
      decisionClientRequestId:
        cashMissedDailyCountExceptions.decisionClientRequestId,
      decisionHash: cashMissedDailyCountExceptions.decisionHash,
      reviewedByUserId: cashMissedDailyCountExceptions.reviewedByUserId,
      reviewedAt: cashMissedDailyCountExceptions.reviewedAt,
      decisionNote: cashMissedDailyCountExceptions.decisionNote,
    })
    .from(cashMissedDailyCountExceptions)
    .innerJoin(
      missedCountCarry,
      and(
        eq(
          missedCountCarry.id,
          cashMissedDailyCountExceptions.carryForwardReconciliationId,
        ),
        eq(
          missedCountCarry.branchId,
          cashMissedDailyCountExceptions.branchId,
        ),
        eq(
          missedCountCarry.businessDate,
          cashMissedDailyCountExceptions.carryForwardBusinessDate,
        ),
        eq(missedCountCarry.status, "CLOSED"),
        eq(
          missedCountCarry.version,
          cashMissedDailyCountExceptions.carryForwardVersion,
        ),
        eq(
          missedCountCarry.evidenceHash,
          cashMissedDailyCountExceptions.carryForwardEvidenceHash,
        ),
      ),
    )
    .where(
      and(
        eq(cashMissedDailyCountExceptions.status, "APPROVED"),
        gte(cashMissedDailyCountExceptions.businessDate, from),
        lte(cashMissedDailyCountExceptions.businessDate, to),
      ),
    )
    .orderBy(asc(cashMissedDailyCountExceptions.id));

  const journalRows = await tx
    .select({
      id: journalEntries.id,
      entryId: journalEntries.entryId,
      sourceType: journalEntries.sourceType,
      sourceKey: journalEntries.sourceKey,
      postingProfile: journalEntries.postingProfile,
      cycleId: journalEntries.cycleId,
      entryDate: journalEntries.entryDate,
      branchId: journalEntries.branchId,
      status: journalEntries.status,
      lineId: journalLines.id,
      role: journalLines.role,
      debit: journalLines.debit,
      credit: journalLines.credit,
    })
    .from(journalEntries)
    .leftJoin(journalLines, eq(journalLines.journalId, journalEntries.id))
    .where(
      and(
        gte(journalEntries.entryDate, fromDate),
        lte(journalEntries.entryDate, toDate),
        runtime.cycleId == null
          ? sql`1 = 1`
          : eq(journalEntries.cycleId, runtime.cycleId),
      ),
    )
    .orderBy(asc(journalEntries.id), asc(journalLines.id));

  const roleRows = await tx
    .select({
      role: journalLines.role,
      debit: sql<string>`CAST(COALESCE(SUM(${journalLines.debit}), 0) AS CHAR)`,
      credit: sql<string>`CAST(COALESCE(SUM(${journalLines.credit}), 0) AS CHAR)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalId))
    .where(
      and(
        eq(journalEntries.status, "POSTED"),
        lte(journalEntries.entryDate, toDate),
        runtime.cycleId == null
          ? sql`1 = 1`
          : eq(journalEntries.cycleId, runtime.cycleId),
      ),
    )
    .groupBy(journalLines.role)
    .orderBy(asc(journalLines.role));

  const wipRows = await tx
    .select({
      id: workOrders.id,
      orderNumber: workOrders.orderNumber,
      branchId: workOrders.branchId,
      status: workOrders.status,
      materialsCost: workOrders.materialsCost,
      workStartedAt: workOrders.workStartedAt,
    })
    .from(workOrders)
    .where(inArray(workOrders.status, ["IN_PROGRESS", "READY"]))
    .orderBy(asc(workOrders.id));

  const normalizedAccounting = accountingRows.map((row) => ({
    id: Number(row.id),
    entryType: row.entryType,
    branchId: row.branchId == null ? null : Number(row.branchId),
    amount: toDbMoney(row.amount),
    revenue: toDbMoney(row.revenue),
    cost: toDbMoney(row.cost),
    profit: toDbMoney(row.profit),
    taxAmount: toDbMoney(row.taxAmount),
    postingCycleId: row.postingCycleId,
    postingProfile: row.postingProfile,
    postingIntentHash: row.postingIntentHash,
    entryDate: row.entryDate.toISOString().slice(0, 10),
    dedupeKey: row.dedupeKey,
  }));
  const normalizedJournal = journalRows.map((row) => ({
    id: Number(row.id),
    entryId: row.entryId == null ? null : Number(row.entryId),
    sourceType: row.sourceType,
    sourceKey: row.sourceKey,
    postingProfile: row.postingProfile,
    cycleId: row.cycleId,
    entryDate: row.entryDate.toISOString().slice(0, 10),
    branchId: row.branchId == null ? null : Number(row.branchId),
    status: row.status,
    lineId: row.lineId == null ? null : Number(row.lineId),
    role: row.role,
    debit: toDbMoney(row.debit ?? 0),
    credit: toDbMoney(row.credit ?? 0),
  }));
  const normalizedWip = wipRows.map((row) => ({
    id: Number(row.id),
    orderNumber: row.orderNumber,
    branchId: Number(row.branchId),
    status: row.status,
    materialsCost: toDbMoney(row.materialsCost),
    workStartedAt: row.workStartedAt?.toISOString() ?? null,
  }));
  const normalizedMissedDailyCounts = missedDailyCountRows.map((row) => ({
    id: Number(row.id),
    branchId: Number(row.branchId),
    businessDate: row.businessDate,
    carryForwardReconciliationId: Number(row.carryForwardReconciliationId),
    carryForwardBusinessDate: row.carryForwardBusinessDate,
    carryForwardVersion: Number(row.carryForwardVersion),
    carryForwardEvidenceHash: row.carryForwardEvidenceHash,
    missingDayEvidenceHash: row.missingDayEvidenceHash,
    reason: row.reason,
    evidenceReference: row.evidenceReference,
    requestClientRequestId: row.requestClientRequestId,
    requestHash: row.requestHash,
    immutableEvidenceHash: row.immutableEvidenceHash,
    requestedByUserId: Number(row.requestedByUserId),
    requestedAt: row.requestedAt.toISOString(),
    decisionClientRequestId: row.decisionClientRequestId,
    decisionHash: row.decisionHash,
    reviewedByUserId:
      row.reviewedByUserId == null ? null : Number(row.reviewedByUserId),
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    decisionNote: row.decisionNote,
  }));
  const readinessCanonical = canonicalCloseJson(input.approvalReadiness);
  const requestSnapshot = parseStoredJson(
    input.request.readinessSnapshot,
    "لقطة جاهزية الطلب",
  );
  const requestCanonical = canonicalCloseJson(requestSnapshot);

  const normalizedRoles = roleRows.map((row, index) => ({
    id: index + 1,
    role: row.role,
    debit: toDbMoney(row.debit),
    credit: toDbMoney(row.credit),
    balance: toDbMoney(money(row.debit).minus(money(row.credit))),
  }));
  const chunks = [
    ...evidenceChunks("ACCOUNTING_ENTRIES", normalizedAccounting),
    ...evidenceChunks("JOURNAL", normalizedJournal),
    ...evidenceChunks("ROLE_BALANCES", normalizedRoles),
    ...evidenceChunks("WIP_WORK_ORDERS", normalizedWip),
    ...evidenceChunks(
      "MISSED_DAILY_COUNT_EXCEPTIONS",
      normalizedMissedDailyCounts,
    ),
    ...evidenceChunks("APPROVAL_READINESS", [
      { id: 1, readiness: input.approvalReadiness },
    ]),
    ...evidenceChunks("CLOSE_INTEGRITY", [
      { id: 1, reconciliation: input.doubleEntryIntegrity ?? null },
    ]),
    ...(input.kind === "YEAR_END"
      ? evidenceChunks("YEAR_END_EVIDENCE", [
          { id: 1, evidence: input.yearEndEvidence ?? null },
        ])
      : []),
  ];
  const manifest = evidenceManifest(chunks);
  const rootHash = closeSha256(canonicalCloseJson(manifest));

  const roles = normalizedRoles.map(({ id: _id, ...role }) => role);
  const totalDebit = roles.reduce((sum, row) => sum.plus(row.debit), money(0));
  const totalCredit = roles.reduce(
    (sum, row) => sum.plus(row.credit),
    money(0),
  );
  const wipOperational = normalizedWip.reduce(
    (sum, row) => sum.plus(row.materialsCost),
    money(0),
  );
  const wipLedger =
    roles.find((row) => row.role === "WORK_IN_PROGRESS")?.balance ?? "0.00";

  return {
    chunks,
    rootHash,
    snapshot: {
      canonicalVersion: MONTH_CLOSE_CANONICAL_VERSION,
      scope: "COMPANY",
      calendar: {
        eligibilityTimezone: "Asia/Baghdad",
        accountingDateFrom: from,
        accountingDateTo: to,
      },
      governance: {
        requestId: input.request.id,
        requestReadiness: requestSnapshot,
        requestSnapshotHash: closeSha256(requestCanonical),
        approvalReadiness: input.approvalReadiness,
        approvalReadinessHash: closeSha256(readinessCanonical),
      },
      ledger: {
        mode: runtime.mode,
        cycleId: runtime.cycleId,
        totalDebit: toDbMoney(totalDebit),
        totalCredit: toDbMoney(totalCredit),
        roles,
        monthAccountingEntryCount: normalizedAccounting.length,
        monthJournalRowCount: normalizedJournal.length,
        closeIntegrity: input.doubleEntryIntegrity ?? null,
      },
      workInProgress: {
        openOrderCount: normalizedWip.length,
        operationalMaterialsCost: toDbMoney(wipOperational),
        ledgerBalance: wipLedger,
        difference: toDbMoney(wipOperational.minus(money(wipLedger))),
      },
      evidenceManifest: manifest,
      evidenceRootHash: rootHash,
      yearEnd: input.yearEndEvidence ?? null,
    },
  };
}

export async function createMonthCloseCertificate(
  tx: Tx,
  input: CreateMonthCloseCertificateInput,
): Promise<{
  id: number;
  certificateNumber: string;
  certificateHash: string;
  snapshotHash: string;
  evidenceRootHash: string;
}> {
  const approvedAt = exactSecond(input.approvedAt);
  const [settings] = await tx
    .select({
      mode: doubleEntrySettings.mode,
      cycleId: doubleEntrySettings.shadowCycleId,
      openingHash: doubleEntrySettings.shadowOpeningHash,
      approvalPolicyHash: doubleEntrySettings.policyApprovalPolicyHash,
    })
    .from(doubleEntrySettings)
    .where(eq(doubleEntrySettings.id, 1))
    .for("share")
    .limit(1);
  const runtime = {
    mode: settings?.mode ?? ("OFF" as const),
    cycleId: settings?.cycleId ?? null,
  };
  if (
    runtime.mode !== input.runtime.mode ||
    runtime.cycleId !== input.runtime.cycleId
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "تغيّر وضع الدفتر أثناء الإقفال؛ أعد طلب الإقفال من لقطة حالية.",
    });
  }
  const built = await buildEvidence(tx, input, runtime);
  const snapshotCanonical = canonicalCloseJson({
    ...built.snapshot,
    identity: {
      month: input.request.month,
      revision: input.revision,
      kind: input.kind,
      periodId: input.periodId,
      requestedBy: input.request.requestedBy,
      requestedAt: exactSecond(input.request.requestedAt).toISOString(),
      approvedBy: input.approvedBy,
      approvedAt: approvedAt.toISOString(),
      yearEndSnapshotId: input.yearEndSnapshotId ?? null,
      retainedEarningsEntryId: input.retainedEarningsEntryId ?? null,
    },
  });
  const snapshotHash = closeSha256(snapshotCanonical);
  const requestSnapshotHash = closeSha256(
    canonicalCloseJson(
      parseStoredJson(input.request.readinessSnapshot, "لقطة جاهزية الطلب"),
    ),
  );
  const approvalReadinessHash = closeSha256(
    canonicalCloseJson(input.approvalReadiness),
  );

  const [previous] = await tx
    .select({
      id: monthCloseCertificates.id,
      hash: monthCloseCertificates.certificateHash,
    })
    .from(monthCloseCertificates)
    .orderBy(desc(monthCloseCertificates.id))
    .limit(1);
  const [superseded] = await tx
    .select({ id: monthCloseCertificates.id })
    .from(monthCloseCertificates)
    .where(eq(monthCloseCertificates.month, input.request.month))
    .orderBy(desc(monthCloseCertificates.revision))
    .limit(1);
  const number = certificateNumber(input.request.month, input.revision);
  const envelope: CertificateEnvelope = {
    canonicalVersion: MONTH_CLOSE_CANONICAL_VERSION,
    certificateNumber: number,
    month: input.request.month,
    revision: input.revision,
    kind: input.kind,
    requestId: input.request.id,
    periodId: input.periodId,
    supersedesCertificateId: superseded == null ? null : Number(superseded.id),
    previousCertificateId: previous == null ? null : Number(previous.id),
    previousCertificateHash: previous?.hash ?? null,
    yearEndSnapshotId: input.yearEndSnapshotId ?? null,
    retainedEarningsEntryId: input.retainedEarningsEntryId ?? null,
    requestedBy: input.request.requestedBy,
    requestedAt: exactSecond(input.request.requestedAt).toISOString(),
    approvedBy: input.approvedBy,
    approvedAt: approvedAt.toISOString(),
    doubleEntryMode: runtime.mode,
    cycleId: runtime.cycleId,
    openingHash: settings?.openingHash ?? null,
    postingPolicyHash:
      runtime.mode === "OFF"
        ? null
        : (settings?.approvalPolicyHash ?? POSTING_POLICY_HASH),
    requestSnapshotHash,
    approvalReadinessHash,
    evidenceRootHash: built.rootHash,
    snapshotHash,
  };
  const sealedHash = certificateHash(envelope);
  const result = await tx.insert(monthCloseCertificates).values({
    certificateNumber: number,
    month: input.request.month,
    revision: input.revision,
    kind: input.kind,
    requestId: input.request.id,
    periodId: input.periodId,
    supersedesCertificateId: envelope.supersedesCertificateId,
    previousCertificateId: envelope.previousCertificateId,
    previousCertificateHash: envelope.previousCertificateHash,
    yearEndSnapshotId: envelope.yearEndSnapshotId,
    retainedEarningsEntryId: envelope.retainedEarningsEntryId,
    requestedBy: input.request.requestedBy,
    requestedAt: exactSecond(input.request.requestedAt),
    approvedBy: input.approvedBy,
    approvedAt,
    doubleEntryMode: runtime.mode,
    cycleId: runtime.cycleId,
    openingHash: envelope.openingHash,
    postingPolicyHash: envelope.postingPolicyHash,
    canonicalVersion: MONTH_CLOSE_CANONICAL_VERSION,
    requestSnapshotHash,
    approvalReadinessHash,
    evidenceRootHash: built.rootHash,
    snapshotCanonical,
    snapshotHash,
    certificateHash: sealedHash,
  });
  const id = extractInsertId(result);
  for (const chunk of built.chunks) {
    await tx.insert(monthCloseCertificateEvidence).values({
      certificateId: id,
      datasetCode: chunk.datasetCode,
      chunkNo: chunk.chunkNo,
      rowCount: chunk.rowCount,
      minId: chunk.minId,
      maxId: chunk.maxId,
      canonicalRowsHash: chunk.canonicalRowsHash,
      referenceCanonical: chunk.referenceCanonical,
    });
  }
  return {
    id,
    certificateNumber: number,
    certificateHash: sealedHash,
    snapshotHash,
    evidenceRootHash: built.rootHash,
  };
}

function envelopeOf(
  row: typeof monthCloseCertificates.$inferSelect,
): CertificateEnvelope {
  return {
    canonicalVersion: row.canonicalVersion,
    certificateNumber: row.certificateNumber,
    month: row.month,
    revision: Number(row.revision),
    kind: row.kind,
    requestId: Number(row.requestId),
    periodId: Number(row.periodId),
    supersedesCertificateId:
      row.supersedesCertificateId == null
        ? null
        : Number(row.supersedesCertificateId),
    previousCertificateId:
      row.previousCertificateId == null
        ? null
        : Number(row.previousCertificateId),
    previousCertificateHash: row.previousCertificateHash,
    yearEndSnapshotId:
      row.yearEndSnapshotId == null ? null : Number(row.yearEndSnapshotId),
    retainedEarningsEntryId:
      row.retainedEarningsEntryId == null
        ? null
        : Number(row.retainedEarningsEntryId),
    requestedBy: Number(row.requestedBy),
    requestedAt: exactSecond(row.requestedAt).toISOString(),
    approvedBy: Number(row.approvedBy),
    approvedAt: exactSecond(row.approvedAt).toISOString(),
    doubleEntryMode: row.doubleEntryMode,
    cycleId: row.cycleId,
    openingHash: row.openingHash,
    postingPolicyHash: row.postingPolicyHash,
    requestSnapshotHash: row.requestSnapshotHash,
    approvalReadinessHash: row.approvalReadinessHash,
    evidenceRootHash: row.evidenceRootHash,
    snapshotHash: row.snapshotHash,
  };
}

export async function getMonthCloseCertificate(tx: Tx, id: number) {
  const [row] = await tx
    .select()
    .from(monthCloseCertificates)
    .where(eq(monthCloseCertificates.id, id))
    .limit(1);
  if (!row) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "شهادة الإقفال غير موجودة.",
    });
  }
  const evidence = await tx
    .select()
    .from(monthCloseCertificateEvidence)
    .where(eq(monthCloseCertificateEvidence.certificateId, id))
    .orderBy(
      asc(monthCloseCertificateEvidence.datasetCode),
      asc(monthCloseCertificateEvidence.chunkNo),
    );
  return { row, evidence };
}

export function certificateEvidenceStructuralReasons(
  kind: CertificateKind,
  chunks: readonly EvidenceChunk[],
): string[] {
  const reasons: string[] = [];
  const requiredDatasets = new Set([
    "ACCOUNTING_ENTRIES",
    "JOURNAL",
    "ROLE_BALANCES",
    "WIP_WORK_ORDERS",
    "APPROVAL_READINESS",
    "CLOSE_INTEGRITY",
    ...(kind === "YEAR_END" ? ["YEAR_END_EVIDENCE"] : []),
  ]);
  const chunksByDataset = new Map<string, EvidenceChunk[]>();
  for (const chunk of chunks) {
    const group = chunksByDataset.get(chunk.datasetCode) ?? [];
    group.push(chunk);
    chunksByDataset.set(chunk.datasetCode, group);
    let parsedRows: unknown = null;
    try {
      parsedRows = JSON.parse(chunk.referenceCanonical);
      if (
        !Array.isArray(parsedRows) ||
        canonicalCloseJson(parsedRows) !== chunk.referenceCanonical
      ) {
        reasons.push(
          `EVIDENCE_NOT_CANONICAL:${chunk.datasetCode}:${chunk.chunkNo}`,
        );
      }
    } catch {
      reasons.push(
        `EVIDENCE_INVALID_JSON:${chunk.datasetCode}:${chunk.chunkNo}`,
      );
    }
    if (closeSha256(chunk.referenceCanonical) !== chunk.canonicalRowsHash) {
      reasons.push(
        `EVIDENCE_HASH_MISMATCH:${chunk.datasetCode}:${chunk.chunkNo}`,
      );
    }
    if (Array.isArray(parsedRows)) {
      if (parsedRows.length !== chunk.rowCount) {
        reasons.push(
          `EVIDENCE_ROW_COUNT_MISMATCH:${chunk.datasetCode}:${chunk.chunkNo}`,
        );
      }
      const ids = parsedRows
        .map((item) =>
          item != null && typeof item === "object"
            ? Number((item as { id?: unknown }).id)
            : Number.NaN,
        )
        .filter((item) => Number.isSafeInteger(item));
      const expectedMin = ids.length ? Math.min(...ids) : null;
      const expectedMax = ids.length ? Math.max(...ids) : null;
      if (expectedMin !== chunk.minId || expectedMax !== chunk.maxId) {
        reasons.push(
          `EVIDENCE_RANGE_MISMATCH:${chunk.datasetCode}:${chunk.chunkNo}`,
        );
      }
    }
  }
  for (const dataset of Array.from(requiredDatasets)) {
    const group = chunksByDataset.get(dataset);
    if (!group?.length) {
      reasons.push(`MANDATORY_DATASET_MISSING:${dataset}`);
      continue;
    }
    group.sort((left, right) => left.chunkNo - right.chunkNo);
    if (group.some((chunk, index) => chunk.chunkNo !== index + 1)) {
      reasons.push(`EVIDENCE_CHUNK_SEQUENCE_BROKEN:${dataset}`);
    }
  }
  return reasons;
}

export async function verifyMonthCloseCertificate(tx: Tx, id: number) {
  const { row, evidence } = await getMonthCloseCertificate(tx, id);
  const reasons: string[] = [];
  let snapshot: Record<string, any> | null = null;
  try {
    const parsed = JSON.parse(row.snapshotCanonical) as unknown;
    if (
      parsed == null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      canonicalCloseJson(parsed) !== row.snapshotCanonical
    ) {
      reasons.push("SNAPSHOT_NOT_CANONICAL");
    } else {
      snapshot = parsed as Record<string, any>;
    }
  } catch {
    reasons.push("SNAPSHOT_INVALID_JSON");
  }
  if (closeSha256(row.snapshotCanonical) !== row.snapshotHash) {
    reasons.push("SNAPSHOT_HASH_MISMATCH");
  }
  const chunks: EvidenceChunk[] = evidence.map((item) => ({
    datasetCode: item.datasetCode,
    chunkNo: Number(item.chunkNo),
    rowCount: Number(item.rowCount),
    minId: item.minId == null ? null : Number(item.minId),
    maxId: item.maxId == null ? null : Number(item.maxId),
    canonicalRowsHash: item.canonicalRowsHash,
    referenceCanonical: item.referenceCanonical,
  }));
  reasons.push(...certificateEvidenceStructuralReasons(row.kind, chunks));
  const root = closeSha256(canonicalCloseJson(evidenceManifest(chunks)));
  if (root !== row.evidenceRootHash) reasons.push("EVIDENCE_ROOT_MISMATCH");
  if (snapshot) {
    if (snapshot.evidenceRootHash !== row.evidenceRootHash) {
      reasons.push("SNAPSHOT_EVIDENCE_ROOT_MISMATCH");
    }
    if (
      canonicalCloseJson(snapshot.evidenceManifest ?? null) !==
      canonicalCloseJson(evidenceManifest(chunks))
    ) {
      reasons.push("SNAPSHOT_EVIDENCE_MANIFEST_MISMATCH");
    }
    const identity = snapshot.identity ?? {};
    if (
      identity.month !== row.month ||
      Number(identity.revision) !== Number(row.revision) ||
      identity.kind !== row.kind ||
      Number(identity.periodId) !== Number(row.periodId) ||
      Number(identity.requestedBy) !== Number(row.requestedBy) ||
      Number(identity.approvedBy) !== Number(row.approvedBy) ||
      (identity.yearEndSnapshotId ?? null) !==
        (row.yearEndSnapshotId == null
          ? null
          : Number(row.yearEndSnapshotId)) ||
      (identity.retainedEarningsEntryId ?? null) !==
        (row.retainedEarningsEntryId == null
          ? null
          : Number(row.retainedEarningsEntryId))
    ) {
      reasons.push("SNAPSHOT_IDENTITY_MISMATCH");
    }
    const requestSnapshotHash = closeSha256(
      canonicalCloseJson(snapshot.governance?.requestReadiness ?? null),
    );
    const approvalReadinessHash = closeSha256(
      canonicalCloseJson(snapshot.governance?.approvalReadiness ?? null),
    );
    if (
      requestSnapshotHash !== row.requestSnapshotHash ||
      snapshot.governance?.requestSnapshotHash !== row.requestSnapshotHash
    ) {
      reasons.push("REQUEST_SNAPSHOT_HASH_MISMATCH");
    }
    if (
      approvalReadinessHash !== row.approvalReadinessHash ||
      snapshot.governance?.approvalReadinessHash !== row.approvalReadinessHash
    ) {
      reasons.push("APPROVAL_READINESS_HASH_MISMATCH");
    }
  }
  if (certificateHash(envelopeOf(row)) !== row.certificateHash) {
    reasons.push("CERTIFICATE_HASH_MISMATCH");
  }
  const [immediatePrevious] = await tx
    .select({
      id: monthCloseCertificates.id,
      hash: monthCloseCertificates.certificateHash,
    })
    .from(monthCloseCertificates)
    .where(sql`${monthCloseCertificates.id} < ${id}`)
    .orderBy(desc(monthCloseCertificates.id))
    .limit(1);
  if (
    (immediatePrevious == null) !== (row.previousCertificateId == null) ||
    (immediatePrevious &&
      (Number(row.previousCertificateId) !== Number(immediatePrevious.id) ||
        row.previousCertificateHash !== immediatePrevious.hash))
  ) {
    reasons.push("PREVIOUS_CERTIFICATE_CHAIN_BROKEN");
  }
  if (row.previousCertificateId != null) {
    const [previous] = await tx
      .select({ hash: monthCloseCertificates.certificateHash })
      .from(monthCloseCertificates)
      .where(eq(monthCloseCertificates.id, Number(row.previousCertificateId)))
      .limit(1);
    if (!previous || previous.hash !== row.previousCertificateHash) {
      reasons.push("PREVIOUS_CERTIFICATE_REFERENCE_BROKEN");
    }
  }

  const [request] = await tx
    .select()
    .from(monthCloseRequests)
    .where(eq(monthCloseRequests.id, Number(row.requestId)))
    .limit(1);
  let storedRequestSnapshotHash: string | null = null;
  try {
    storedRequestSnapshotHash = request
      ? closeSha256(
          canonicalCloseJson(JSON.parse(request.readinessSnapshot) as unknown),
        )
      : null;
  } catch {
    storedRequestSnapshotHash = null;
  }
  if (
    !request ||
    request.month !== row.month ||
    Number(request.lockedPeriodId) !== Number(row.periodId) ||
    request.status !== "APPROVED" ||
    storedRequestSnapshotHash !== row.requestSnapshotHash
  ) {
    reasons.push("REQUEST_REFERENCE_BROKEN");
  }
  const [period] = await tx
    .select()
    .from(financialPeriods)
    .where(eq(financialPeriods.id, Number(row.periodId)))
    .limit(1);
  if (
    !period ||
    period.closeMonth !== row.month ||
    Number(period.closeRevision) !== Number(row.revision) ||
    period.cutoffDate !== monthCutoff(row.month)
  ) {
    reasons.push("PERIOD_REFERENCE_BROKEN");
  }

  if (Number(row.revision) === 1) {
    if (row.supersedesCertificateId != null) {
      reasons.push("SUPERSEDES_REVISION_BROKEN");
    }
  } else {
    const [superseded] = await tx
      .select({
        month: monthCloseCertificates.month,
        revision: monthCloseCertificates.revision,
      })
      .from(monthCloseCertificates)
      .where(
        eq(monthCloseCertificates.id, Number(row.supersedesCertificateId ?? 0)),
      )
      .limit(1);
    if (
      !superseded ||
      superseded.month !== row.month ||
      Number(superseded.revision) !== Number(row.revision) - 1
    ) {
      reasons.push("SUPERSEDES_REVISION_BROKEN");
    }
  }
  const previousForks = await tx
    .select({ id: monthCloseCertificates.id })
    .from(monthCloseCertificates)
    .where(eq(monthCloseCertificates.previousCertificateId, id));
  if (previousForks.length > 1) reasons.push("PREVIOUS_CERTIFICATE_FORK");
  const revisionForks = await tx
    .select({ id: monthCloseCertificates.id })
    .from(monthCloseCertificates)
    .where(eq(monthCloseCertificates.supersedesCertificateId, id));
  if (revisionForks.length > 1) reasons.push("SUPERSEDES_CERTIFICATE_FORK");

  if (row.kind === "YEAR_END") {
    const [snapshotLink] = await tx
      .select()
      .from(yearEndSnapshots)
      .where(eq(yearEndSnapshots.id, Number(row.yearEndSnapshotId ?? 0)))
      .limit(1);
    if (
      !snapshotLink ||
      snapshotLink.year !== Number(row.month.slice(0, 4)) ||
      Number(snapshotLink.revision) !== Number(row.revision) ||
      Number(snapshotLink.retainedEarningsEntryId ?? 0) !==
        Number(row.retainedEarningsEntryId ?? 0)
    ) {
      reasons.push("YEAR_END_SNAPSHOT_REFERENCE_BROKEN");
    }
    if (
      snapshotLink &&
      snapshot &&
      (Number(snapshot.yearEnd?.year) !== snapshotLink.year ||
        Number(snapshot.yearEnd?.retainedEarningsEntryId ?? 0) !==
          Number(snapshotLink.retainedEarningsEntryId ?? 0) ||
        snapshot.yearEnd?.totalRevenue !== snapshotLink.totalRevenue ||
        snapshot.yearEnd?.totalCogs !== snapshotLink.totalCogs ||
        snapshot.yearEnd?.totalExpenses !== snapshotLink.totalExpenses ||
        snapshot.yearEnd?.netProfit !== snapshotLink.netProfit ||
        Number(snapshot.yearEnd?.revision) !== Number(snapshotLink.revision) ||
        Number(snapshot.yearEnd?.supersedesSnapshotId ?? 0) !==
          Number(snapshotLink.supersedesSnapshotId ?? 0))
    ) {
      reasons.push("YEAR_END_EVIDENCE_SNAPSHOT_MISMATCH");
    }
    if (snapshotLink) {
      const retainedEntryId = Number(snapshotLink.retainedEarningsEntryId ?? 0);
      const [retainedEntry] = await tx
        .select()
        .from(accountingEntries)
        .where(eq(accountingEntries.id, retainedEntryId))
        .limit(1);
      const [retainedJournal] = await tx
        .select()
        .from(journalEntries)
        .where(eq(journalEntries.entryId, retainedEntryId))
        .limit(1);
      const retainedLines = retainedJournal
        ? await tx
            .select()
            .from(journalLines)
            .where(eq(journalLines.journalId, Number(retainedJournal.id)))
            .orderBy(asc(journalLines.id))
        : [];
      const evidenceProfile = snapshot?.yearEnd?.closePostingProfile;
      const zeroEffectClose = evidenceProfile === "ADJUST_YEAR_CLOSE_ZERO";
      const expectedStatus = zeroEffectClose ? "MEMO" : "POSTED";
      let sealedLinesMatch = false;
      try {
        const sealed = verifyPostingIntentEvidence({
          expectedEntryType: "ADJUST",
          postingProfile: retainedEntry?.postingProfile ?? null,
          postingIntentJson: retainedEntry?.postingIntentJson ?? null,
          postingIntentHash: retainedEntry?.postingIntentHash ?? null,
        });
        sealedLinesMatch =
          canonicalCloseJson(
            sealed.lines.map((line) => ({
              role: line.role,
              debit: line.debit,
              credit: line.credit,
            })),
          ) ===
          canonicalCloseJson(
            retainedLines
              .map((line) => ({
                role: line.role,
                debit: line.debit,
                credit: line.credit,
              }))
              .sort(
                (left, right) =>
                  left.role.localeCompare(right.role) ||
                  left.debit.localeCompare(right.debit) ||
                  left.credit.localeCompare(right.credit),
              ),
          );
      } catch {
        sealedLinesMatch = false;
      }
      if (
        !retainedEntry ||
        retainedEntry.entryType !== "ADJUST" ||
        retainedEntry.postingProfile !== evidenceProfile ||
        !retainedJournal ||
        retainedJournal.postingProfile !== evidenceProfile ||
        retainedJournal.status !== expectedStatus ||
        retainedJournal.cycleId !== snapshot?.yearEnd?.cycleId ||
        retainedEntry.postingCycleId !== snapshot?.yearEnd?.cycleId ||
        (zeroEffectClose
          ? retainedLines.length !== 0 ||
            snapshot?.yearEnd?.zeroEffectClose !== true
          : retainedLines.length === 0 ||
            evidenceProfile !== "ADJUST_YEAR_CLOSE" ||
            snapshot?.yearEnd?.zeroEffectClose !== false) ||
        !sealedLinesMatch
      ) {
        reasons.push("YEAR_END_CLOSE_MARKER_BROKEN");
      }
    }
    if (snapshotLink) {
      if (Number(snapshotLink.revision) === 1) {
        if (snapshotLink.supersedesSnapshotId != null) {
          reasons.push("YEAR_END_SUPERSEDES_REVISION_BROKEN");
        }
      } else {
        const [supersededSnapshot] = await tx
          .select({
            year: yearEndSnapshots.year,
            scopeKey: yearEndSnapshots.scopeKey,
            revision: yearEndSnapshots.revision,
          })
          .from(yearEndSnapshots)
          .where(
            eq(
              yearEndSnapshots.id,
              Number(snapshotLink.supersedesSnapshotId ?? 0),
            ),
          )
          .limit(1);
        const reopenRows = supersededSnapshot
          ? await tx
              .select({
                id: yearEndReopenRequests.id,
                reversalEntryId: yearEndReopenRequests.reversalEntryId,
                reopenEventId: yearEndReopenRequests.reopenEventId,
              })
              .from(yearEndReopenRequests)
              .where(
                and(
                  eq(
                    yearEndReopenRequests.snapshotId,
                    Number(snapshotLink.supersedesSnapshotId),
                  ),
                  eq(yearEndReopenRequests.status, "APPROVED"),
                ),
              )
          : [];
        if (
          !supersededSnapshot ||
          supersededSnapshot.year !== snapshotLink.year ||
          supersededSnapshot.scopeKey !== snapshotLink.scopeKey ||
          Number(supersededSnapshot.revision) !==
            Number(snapshotLink.revision) - 1 ||
          reopenRows.length !== 1 ||
          reopenRows[0].reversalEntryId == null ||
          reopenRows[0].reopenEventId == null ||
          Number(snapshot?.yearEnd?.priorReopenRequestId ?? 0) !==
            Number(reopenRows[0]?.id ?? 0) ||
          Number(snapshot?.yearEnd?.priorReversalEntryId ?? 0) !==
            Number(reopenRows[0]?.reversalEntryId ?? 0)
        ) {
          reasons.push("YEAR_END_SUPERSEDES_REVISION_BROKEN");
        }
      }
      const snapshotForks = await tx
        .select({ id: yearEndSnapshots.id })
        .from(yearEndSnapshots)
        .where(
          eq(yearEndSnapshots.supersedesSnapshotId, Number(snapshotLink.id)),
        );
      if (snapshotForks.length > 1) reasons.push("YEAR_END_SNAPSHOT_FORK");
    }
  } else if (
    row.yearEndSnapshotId != null ||
    row.retainedEarningsEntryId != null
  ) {
    reasons.push("MONTH_CERTIFICATE_HAS_YEAR_END_REFERENCE");
  }

  const closeEvents = await tx
    .select()
    .from(monthCloseEvents)
    .where(
      and(
        eq(monthCloseEvents.eventType, "CLOSE"),
        eq(monthCloseEvents.certificateId, id),
      ),
    );
  if (
    closeEvents.length !== 1 ||
    closeEvents[0]?.month !== row.month ||
    Number(closeEvents[0]?.requestId) !== Number(row.requestId) ||
    Number(closeEvents[0]?.periodId) !== Number(row.periodId)
  ) {
    reasons.push("CLOSE_EVENT_REFERENCE_BROKEN");
  }
  const eventChain = await tx
    .select()
    .from(monthCloseEvents)
    .orderBy(asc(monthCloseEvents.id));
  let previousEventHash: string | null = null;
  for (const event of eventChain) {
    let eventPayload: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(event.payloadCanonical) as unknown;
      eventPayload =
        parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
    } catch {
      eventPayload = null;
    }
    if (
      event.previousEventHash !== previousEventHash ||
      closeSha256(event.payloadCanonical) !== event.eventHash ||
      canonicalCloseJson(eventPayload) !== event.payloadCanonical ||
      eventPayload?.eventKey !== event.eventKey ||
      eventPayload?.eventType !== event.eventType ||
      (eventPayload?.month ?? null) !== event.month ||
      Number(eventPayload?.requestId ?? 0) !== Number(event.requestId ?? 0) ||
      Number(eventPayload?.periodId ?? 0) !== Number(event.periodId ?? 0) ||
      Number(eventPayload?.certificateId ?? 0) !==
        Number(event.certificateId ?? 0) ||
      Number(eventPayload?.actorId ?? 0) !== Number(event.actorId) ||
      (eventPayload?.previousEventHash ?? null) !== event.previousEventHash
    ) {
      reasons.push(`EVENT_CHAIN_BROKEN:${event.id}`);
    }
    previousEventHash = event.eventHash;
  }
  const sequenceTail = eventChain[eventChain.length - 1];
  const [sequenceProjection] = await tx
    .select({
      lastEventId: monthCloseSequence.lastEventId,
      lastEventHash: monthCloseSequence.lastEventHash,
    })
    .from(monthCloseSequence)
    .where(eq(monthCloseSequence.id, 1))
    .limit(1);
  if (
    sequenceTail &&
    (Number(sequenceProjection?.lastEventId ?? 0) !== Number(sequenceTail.id) ||
      sequenceProjection?.lastEventHash !== sequenceTail.eventHash)
  ) {
    reasons.push("EVENT_SEQUENCE_PROJECTION_BROKEN");
  }

  const [state] = await tx
    .select({ activeCertificateId: monthCloseSequence.activeCertificateId })
    .from(monthCloseSequence)
    .where(eq(monthCloseSequence.id, 1))
    .limit(1);
  const [unlock] = await tx
    .select({ id: monthCloseEvents.id })
    .from(monthCloseEvents)
    .where(
      and(
        eq(monthCloseEvents.eventType, "UNLOCK"),
        eq(monthCloseEvents.certificateId, id),
      ),
    )
    .limit(1);
  const [superseding] = await tx
    .select({ id: monthCloseCertificates.id })
    .from(monthCloseCertificates)
    .where(eq(monthCloseCertificates.supersedesCertificateId, id))
    .limit(1);
  const lifecycle =
    Number(state?.activeCertificateId ?? 0) === id
      ? "ACTIVE"
      : superseding
        ? "SUPERSEDED"
        : unlock
          ? "REOPENED"
          : "HISTORICAL";
  return {
    integrity:
      reasons.length === 0 ? ("VERIFIED" as const) : ("TAMPERED" as const),
    lifecycle,
    reasons,
    certificateHash: row.certificateHash,
    snapshotHash: row.snapshotHash,
    evidenceRootHash: row.evidenceRootHash,
  };
}

export async function listMonthCloseCertificates(
  tx: Tx,
  input: { month?: string; beforeId?: number; limit?: number } = {},
) {
  const filters = [];
  if (input.month) filters.push(eq(monthCloseCertificates.month, input.month));
  if (input.beforeId)
    filters.push(sql`${monthCloseCertificates.id} < ${input.beforeId}`);
  return tx
    .select({
      id: monthCloseCertificates.id,
      certificateNumber: monthCloseCertificates.certificateNumber,
      month: monthCloseCertificates.month,
      revision: monthCloseCertificates.revision,
      kind: monthCloseCertificates.kind,
      approvedAt: monthCloseCertificates.approvedAt,
      approvedBy: monthCloseCertificates.approvedBy,
      certificateHash: monthCloseCertificates.certificateHash,
      periodId: monthCloseCertificates.periodId,
    })
    .from(monthCloseCertificates)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(monthCloseCertificates.id))
    .limit(Math.max(1, Math.min(input.limit ?? 50, 100)));
}

export function certificateExportRows(
  row: typeof monthCloseCertificates.$inferSelect,
  evidence: Array<typeof monthCloseCertificateEvidence.$inferSelect>,
  verification: Awaited<ReturnType<typeof verifyMonthCloseCertificate>>,
) {
  const splitValue = (section: string, value: string) => {
    const maxCellLength = 30_000;
    const parts = Math.max(1, Math.ceil(value.length / maxCellLength));
    return Array.from({ length: parts }, (_, index) => ({
      section:
        parts === 1
          ? section
          : `${section}:PART:${String(index + 1).padStart(4, "0")}/${String(parts).padStart(4, "0")}`,
      value: value.slice(index * maxCellLength, (index + 1) * maxCellLength),
    }));
  };
  const snapshot = parseStoredJson(
    row.snapshotCanonical,
    "لقطة الشهادة",
  ) as Record<string, unknown>;
  const metadata = [
    { section: "رقم الشهادة", value: row.certificateNumber },
    { section: "الشهر", value: row.month },
    { section: "الإصدار", value: String(row.revision) },
    { section: "النوع", value: row.kind },
    { section: "حالة السلامة", value: verification.integrity },
    { section: "الحالة التشغيلية", value: verification.lifecycle },
    { section: "بصمة الشهادة", value: row.certificateHash },
    { section: "بصمة اللقطة", value: row.snapshotHash },
    { section: "جذر الأدلة", value: row.evidenceRootHash },
  ];
  const snapshotRows = splitValue(
    "اللقطة القانونية JSON",
    canonicalCloseJson(snapshot),
  );
  const evidenceRows = evidence.flatMap((chunk) => {
    const identity = `${chunk.datasetCode}:${chunk.chunkNo}`;
    const manifest = canonicalCloseJson({
      datasetCode: chunk.datasetCode,
      chunkNo: Number(chunk.chunkNo),
      rowCount: Number(chunk.rowCount),
      minId: chunk.minId == null ? null : Number(chunk.minId),
      maxId: chunk.maxId == null ? null : Number(chunk.maxId),
      canonicalRowsHash: chunk.canonicalRowsHash,
      referenceLength: chunk.referenceCanonical.length,
    });
    return [
      { section: `EVIDENCE_META:${identity}`, value: manifest },
      ...splitValue(`EVIDENCE_DATA:${identity}`, chunk.referenceCanonical),
    ];
  });
  return metadata.concat(snapshotRows, evidenceRows);
}
