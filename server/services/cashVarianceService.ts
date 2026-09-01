import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gt, lt, or, sql } from "drizzle-orm";
import {
  accountingEntries,
  cashCustodyCounts,
  cashDailyReconciliations,
  cashVarianceEvidenceDocuments,
  cashVarianceCaseEvents,
  cashVarianceCases,
  employeeAdvances,
  employees,
  receipts,
  shifts,
  users,
} from "../../drizzle/schema";
import type {
  CashVarianceEventType,
  CashVarianceReasonCode,
  CashVarianceSourceType,
} from "../../shared/cashVariance";
import {
  CASH_VARIANCE_COUNTER_ACCOUNT_POLICY,
  CASH_VARIANCE_EVIDENCE_MAX_BYTES,
  CASH_VARIANCE_EVIDENCE_MIME_TYPES,
  CASH_VARIANCE_EVIDENCE_REFERENCE_MAX_LENGTH,
  CASH_VARIANCE_EVIDENCE_REFERENCE_MIN_LENGTH,
  isCashVarianceReasonAllowed,
} from "../../shared/cashVariance";
import type { Tx } from "../db";
import { extractInsertId } from "../lib/insertId";
import {
  createPostingIntent,
  creditLine,
  debitLine,
  type AccountRole,
  type JournalLine,
  type PostingProfile,
  type PostingSourceComponents,
} from "./accounting/postingEngine";
import {
  assertCashOutAvailable,
  lockCashSourceForUpdate,
} from "./cash/cashAvailability";
import { buildDailyCashEvidenceTx } from "./cashDailyReconciliationService";
import { postEntry, type EntryType } from "./ledgerService";
import { money, toDbMoney } from "./money";
import { todayUtcDate } from "./businessDay";
import { logAuditTx, type AuditMetadata } from "./auditService";
import { requireDb, withTx, type Actor } from "./tx";

export interface RegisterCashVarianceEvidenceInput {
  branchId: number;
  fileName: string;
  dataUrl: string;
  clientRequestId: string;
}

export interface ProposeCashVarianceInput {
  sourceType: CashVarianceSourceType;
  /** CUSTODY: receipts.id للوارد المعلّق؛ DAILY_TREASURY: cashDailyReconciliations.id. */
  sourceId: number;
  reasonCode: CashVarianceReasonCode;
  reason: string;
  evidenceDocumentId: number;
  evidenceReference: string;
  clientRequestId: string;
}

export interface DecideCashVarianceInput {
  caseId: number;
  expectedVersion: number;
  clientRequestId: string;
  note?: string | null;
}

export interface CashVariancePostingPlan {
  sourceType: CashVarianceSourceType;
  varianceType: "SHORTAGE" | "SURPLUS";
  direction: "IN" | "OUT";
  adjustmentAmount: string;
  counterAccountRole: "EMPLOYEE_ADVANCES" | "LOSSES" | "OTHER_LIABILITY";
  entryType: EntryType;
  postingProfile: Extract<
    PostingProfile,
    | "CASH_CUSTODY_SHORTAGE"
    | "CASH_CUSTODY_SURPLUS"
    | "CASH_DAILY_SHORTAGE"
    | "CASH_DAILY_SURPLUS"
  >;
  entryAmount: string;
  lines: JournalLine[];
  sourceComponents: PostingSourceComponents;
}

function hashRequest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizeRequiredText(
  value: string,
  fieldLabel: string,
  minimum: number,
  maximum: number,
): string {
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${fieldLabel} مطلوب بطول من ${minimum} إلى ${maximum} محرفاً`,
    });
  }
  return normalized;
}

function assertBranchScope(actor: Actor, branchId: number): void {
  if (actor.role !== "admin" && Number(actor.branchId) !== Number(branchId)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "لا يمكنك إدارة فرق نقد لفرع آخر",
    });
  }
}

function assertDecisionRole(actor: Actor): void {
  if (!["admin", "manager", "accountant"].includes(actor.role ?? "")) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "اعتماد فرق النقد محصور بالإدارة أو المحاسبة",
    });
  }
}

function addComponent(
  target: Partial<Record<AccountRole, string>>,
  role: AccountRole,
  amount: string,
): void {
  target[role] = amount;
}

/**
 * الخطة الوحيدة للقيد:
 * - عجز العهدة فقط ذمة على المسؤول المشتق من عقدها في EMPLOYEE_ADVANCES.
 * - عجز الخزينة اليومية المعتمد LOSSES لأنه لا يوجد سجل حيازة يثبت مسؤولاً بعينه.
 * - الزيادة OTHER_LIABILITY معلّقة، لا إيراد ولا ربح مخترع.
 * - عهدة CH/CD تصفّر CASH_IN_TRANSIT بالمبلغ المعلن كاملاً وتثبت الفعلي في الخزينة.
 */
export function buildCashVariancePostingPlan(input: {
  sourceType: CashVarianceSourceType;
  expectedAmount: string;
  actualAmount: string;
}): CashVariancePostingPlan {
  const expected = money(input.expectedAmount);
  const actual = money(input.actualAmount);
  if (!expected.isFinite() || !actual.isFinite() || expected.isNegative() || actual.isNegative()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "مبالغ فرق النقد غير صالحة" });
  }
  const variance = actual.minus(expected);
  if (variance.abs().lte("0.005")) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا يوجد فرق نقد لتسويته" });
  }

  const shortage = variance.isNegative();
  const varianceType = shortage ? "SHORTAGE" : "SURPLUS";
  const adjustmentAmount = variance.abs().toFixed(2);
  const counterAccountRole =
    CASH_VARIANCE_COUNTER_ACCOUNT_POLICY[input.sourceType][varianceType];
  const lines: JournalLine[] = [];
  const roleDebits: Partial<Record<AccountRole, string>> = {};
  const roleCredits: Partial<Record<AccountRole, string>> = {};

  if (input.sourceType === "CUSTODY") {
    if (actual.isPositive()) {
      lines.push(debitLine("TREASURY_CASH", actual));
      addComponent(roleDebits, "TREASURY_CASH", actual.toFixed(2));
    } else {
      addComponent(roleDebits, "TREASURY_CASH", "0.00");
    }
    if (shortage) {
      lines.push(debitLine("EMPLOYEE_ADVANCES", variance.abs()));
      addComponent(roleDebits, "EMPLOYEE_ADVANCES", adjustmentAmount);
    } else {
      lines.push(creditLine("OTHER_LIABILITY", variance));
      addComponent(roleCredits, "OTHER_LIABILITY", adjustmentAmount);
    }
    lines.push(creditLine("CASH_IN_TRANSIT", expected));
    addComponent(roleCredits, "CASH_IN_TRANSIT", expected.toFixed(2));
    return {
      sourceType: input.sourceType,
      varianceType,
      direction: shortage ? "OUT" : "IN",
      adjustmentAmount,
      counterAccountRole,
      entryType: "CASH_TRANSFER_IN",
      postingProfile: shortage ? "CASH_CUSTODY_SHORTAGE" : "CASH_CUSTODY_SURPLUS",
      entryAmount: actual.toFixed(2),
      lines,
      sourceComponents: { roleDebits, roleCredits },
    };
  }

  if (shortage) {
    lines.push(debitLine("LOSSES", variance.abs()));
    lines.push(creditLine("TREASURY_CASH", variance.abs()));
    addComponent(roleDebits, "LOSSES", adjustmentAmount);
    addComponent(roleCredits, "TREASURY_CASH", adjustmentAmount);
  } else {
    lines.push(debitLine("TREASURY_CASH", variance));
    lines.push(creditLine("OTHER_LIABILITY", variance));
    addComponent(roleDebits, "TREASURY_CASH", adjustmentAmount);
    addComponent(roleCredits, "OTHER_LIABILITY", adjustmentAmount);
  }
  return {
    sourceType: input.sourceType,
    varianceType,
    direction: shortage ? "OUT" : "IN",
    adjustmentAmount,
    counterAccountRole,
    entryType: "ADJUST",
    postingProfile: shortage ? "CASH_DAILY_SHORTAGE" : "CASH_DAILY_SURPLUS",
    entryAmount: adjustmentAmount,
    lines,
    sourceComponents: { roleDebits, roleCredits },
  };
}

async function latestEventTx(tx: Tx, caseId: number, lock = false) {
  let query = tx
    .select()
    .from(cashVarianceCaseEvents)
    .where(eq(cashVarianceCaseEvents.caseId, caseId))
    .orderBy(desc(cashVarianceCaseEvents.version))
    .limit(1);
  if (lock) query = query.for("update") as typeof query;
  return (await query)[0] ?? null;
}

function eventStatus(eventType: CashVarianceEventType) {
  return eventType;
}

const EVIDENCE_MIME_SET = new Set<string>(CASH_VARIANCE_EVIDENCE_MIME_TYPES);

function parseEvidenceDataUrl(dataUrl: string) {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match || !EVIDENCE_MIME_SET.has(match[1])) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "نوع ملف دليل فرق النقد غير مسموح" });
  }
  const content = Buffer.from(match[2], "base64");
  if (
    content.length === 0 ||
    content.length > CASH_VARIANCE_EVIDENCE_MAX_BYTES ||
    content.toString("base64").replace(/=+$/, "") !== match[2].replace(/=+$/, "")
  ) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "ملف دليل فرق النقد فارغ أو تالف أو يتجاوز 5MB" });
  }
  return {
    content,
    contentType: match[1],
    evidenceType: match[1] === "application/pdf" ? "PDF" as const : "IMAGE" as const,
    contentHash: createHash("sha256").update(content).digest("hex"),
  };
}

async function lockEvidenceTx(
  tx: Tx,
  input: { id: number; branchId: number; ownerUserId: number; expectedHash?: string | null },
) {
  const row = (
    await tx.select().from(cashVarianceEvidenceDocuments)
      .where(eq(cashVarianceEvidenceDocuments.id, input.id)).for("update").limit(1)
  )[0];
  if (!row || Number(row.branchId) !== input.branchId || Number(row.createdByUserId) !== input.ownerUserId) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "دليل فرق النقد غير موجود أو لا يخص المنشئ والفرع" });
  }
  const content = Buffer.from(row.content);
  const actualHash = createHash("sha256").update(content).digest("hex");
  if (
    !EVIDENCE_MIME_SET.has(row.contentType) ||
    content.length === 0 ||
    content.length > CASH_VARIANCE_EVIDENCE_MAX_BYTES ||
    actualHash !== row.contentHash ||
    (input.expectedHash != null && actualHash !== input.expectedHash)
  ) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "سلامة دليل فرق النقد أو بصمته غير صالحة" });
  }
  return row;
}

export async function registerCashVarianceEvidence(
  input: RegisterCashVarianceEvidenceInput,
  actor: Actor,
  auditCtx: AuditMetadata = { userId: actor.userId, branchId: actor.branchId },
) {
  assertDecisionRole(actor);
  assertBranchScope(actor, input.branchId);
  const fileName = normalizeRequiredText(input.fileName, "اسم ملف الدليل", 1, 255);
  const parsed = parseEvidenceDataUrl(input.dataUrl);
  const requestHash = hashRequest({
    branchId: input.branchId,
    fileName,
    contentType: parsed.contentType,
    contentHash: parsed.contentHash,
    actorUserId: actor.userId,
  });
  return withTx(async (tx) => {
    const replay = (
      await tx.select().from(cashVarianceEvidenceDocuments)
        .where(eq(cashVarianceEvidenceDocuments.registrationClientRequestId, input.clientRequestId))
        .limit(1)
    )[0];
    if (replay) {
      if (replay.registrationRequestHash !== requestHash) {
        throw new TRPCError({ code: "CONFLICT", message: "مفتاح تسجيل الدليل مستعمل لملف مختلف" });
      }
      await lockEvidenceTx(tx, {
        id: Number(replay.id), branchId: input.branchId, ownerUserId: actor.userId,
        expectedHash: parsed.contentHash,
      });
      return { evidenceDocumentId: Number(replay.id), contentHash: replay.contentHash, idempotent: true };
    }
    const inserted = await tx.insert(cashVarianceEvidenceDocuments).values({
      branchId: input.branchId,
      evidenceType: parsed.evidenceType,
      fileName,
      contentType: parsed.contentType,
      contentHash: parsed.contentHash,
      content: parsed.content,
      createdByUserId: actor.userId,
      registrationClientRequestId: input.clientRequestId,
      registrationRequestHash: requestHash,
    });
    const evidenceDocumentId = extractInsertId(inserted);
    await logAuditTx(tx, auditCtx, {
      action: "treasury.cash_variance.evidence.register",
      entityType: "cash_variance_evidence",
      entityId: evidenceDocumentId,
      branchId: input.branchId,
      newValue: { fileName, contentType: parsed.contentType, contentHash: parsed.contentHash, byteLength: parsed.content.length },
    });
    return { evidenceDocumentId, contentHash: parsed.contentHash, idempotent: false };
  });
}

function cashVarianceDecisionPolicy(
  row: Pick<
    typeof cashVarianceCases.$inferSelect,
    "proposedByUserId" | "countedByUserId" | "responsibleUserId"
  >,
  status: CashVarianceEventType,
  actor: Actor,
) {
  if (status !== "PROPOSED") {
    return { canDecide: false, blockedReason: "حُسمت حالة فرق النقد بالفعل." } as const;
  }
  if (Number(row.proposedByUserId) === actor.userId) {
    return { canDecide: false, blockedReason: "لا يمكنك اعتماد تسوية اقترحتها أنت." } as const;
  }
  if (Number(row.countedByUserId) === actor.userId) {
    return { canDecide: false, blockedReason: "لا يمكنك اعتماد فرق العد الذي نفذته أنت." } as const;
  }
  if (row.responsibleUserId != null && Number(row.responsibleUserId) === actor.userId) {
    return { canDecide: false, blockedReason: "لا يمكنك اعتماد قضية فرق نقد أنت مسؤول عنها." } as const;
  }
  return { canDecide: true, blockedReason: null } as const;
}

async function loadIdempotentProposal(
  tx: Tx,
  input: ProposeCashVarianceInput,
  actor: Actor,
  requestHash: string,
) {
  const existing = (
    await tx
      .select()
      .from(cashVarianceCases)
      .where(eq(cashVarianceCases.proposalClientRequestId, input.clientRequestId))
      .limit(1)
  )[0];
  if (!existing) return null;
  assertBranchScope(actor, Number(existing.branchId));
  if (existing.proposalRequestHash !== requestHash) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "مفتاح محاولة الاقتراح مستعمل لحمولة مختلفة",
    });
  }
  if (existing.evidenceDocumentId == null || existing.evidenceContentHash == null) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "قضية فرق النقد لا تحمل دليلاً موثقاً" });
  }
  await lockEvidenceTx(tx, {
    id: Number(existing.evidenceDocumentId),
    branchId: Number(existing.branchId),
    ownerUserId: Number(existing.proposedByUserId),
    expectedHash: existing.evidenceContentHash,
  });
  const latest = await latestEventTx(tx, Number(existing.id));
  if (!latest) throw new TRPCError({ code: "CONFLICT", message: "سجل حالة فرق النقد ناقص" });
  return {
    caseId: Number(existing.id),
    status: eventStatus(latest.eventType),
    version: Number(latest.version),
    variance: String(existing.variance),
    idempotent: true,
  };
}

async function candidateBranchTx(
  tx: Tx,
  sourceType: CashVarianceSourceType,
  sourceId: number,
): Promise<number> {
  if (sourceType === "CUSTODY") {
    const row = (
      await tx
        .select({ branchId: receipts.branchId })
        .from(receipts)
        .where(eq(receipts.id, sourceId))
        .limit(1)
    )[0];
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "عهدة النقد غير موجودة" });
    if (row.branchId == null) throw new TRPCError({ code: "CONFLICT", message: "عهدة النقد بلا فرع" });
    return Number(row.branchId);
  }
  const row = (
    await tx
      .select({ branchId: cashDailyReconciliations.branchId })
      .from(cashDailyReconciliations)
      .where(eq(cashDailyReconciliations.id, sourceId))
      .limit(1)
  )[0];
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "مطابقة الخزينة غير موجودة" });
  return Number(row.branchId);
}

async function loadProposalSourceTx(
  tx: Tx,
  input: ProposeCashVarianceInput,
  branchId: number,
) {
  if (input.sourceType === "CUSTODY") {
    const receipt = (
      await tx
        .select()
        .from(receipts)
        .where(eq(receipts.id, input.sourceId))
        .for("update")
        .limit(1)
    )[0];
    const reference = receipt?.referenceNumber ?? "";
    if (
      !receipt ||
      receipt.status !== "PENDING" ||
      receipt.direction !== "IN" ||
      receipt.paymentMethod !== "CASH" ||
      receipt.cashBucket !== "TREASURY" ||
      receipt.approvalStatus !== "APPROVED" ||
      (!reference.startsWith("CH-") && !reference.startsWith("CD-"))
    ) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "المصدر ليس عهدة CH/CD ذات فرق مفتوح" });
    }
    if (Number(receipt.branchId) !== branchId) {
      throw new TRPCError({ code: "CONFLICT", message: "فرع عهدة النقد تغيّر" });
    }
    const count = (
      await tx
        .select()
        .from(cashCustodyCounts)
        .where(eq(cashCustodyCounts.treasuryReceiptId, input.sourceId))
        .orderBy(desc(cashCustodyCounts.id))
        .limit(1)
    )[0];
    if (!count || count.status !== "VARIANCE_OPEN") {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا يوجد عدّ عهدة بفرق مفتوح" });
    }
    const custodySources = await tx
      .select({
        id: receipts.id,
        amount: receipts.amount,
        shiftId: receipts.shiftId,
        createdBy: receipts.createdBy,
      })
      .from(receipts)
      .where(
        and(
          eq(receipts.branchId, branchId),
          eq(receipts.referenceNumber, reference),
          eq(receipts.direction, "OUT"),
          eq(receipts.paymentMethod, "CASH"),
          eq(receipts.cashBucket, "DRAWER"),
          eq(receipts.status, "COMPLETED"),
          eq(receipts.approvalStatus, "APPROVED"),
        ),
      )
      .for("update");
    const matchingSources = custodySources.filter((source) =>
      money(source.amount).eq(count.declaredAmount),
    );
    if (matchingSources.length !== 1) {
      throw new TRPCError({ code: "CONFLICT", message: "عقد تسليم العهدة غير مطابق أو غير فريد" });
    }
    const custodySource = matchingSources[0];
    let responsibleUserId = custodySource.createdBy == null
      ? null
      : Number(custodySource.createdBy);
    if (custodySource.shiftId != null) {
      const shift = (
        await tx
          .select({ userId: shifts.userId, branchId: shifts.branchId })
          .from(shifts)
          .where(eq(shifts.id, Number(custodySource.shiftId)))
          .limit(1)
      )[0];
      if (!shift || Number(shift.branchId) !== branchId) {
        throw new TRPCError({ code: "CONFLICT", message: "مالك وردية عقد العهدة غير صالح" });
      }
      responsibleUserId = Number(shift.userId);
    }
    if (responsibleUserId == null) {
      throw new TRPCError({ code: "CONFLICT", message: "عقد العهدة لا يحدد مسلّماً مسؤولاً" });
    }
    return {
      custodyReceiptId: Number(receipt.id),
      custodyCountId: Number(count.id),
      dailyReconciliationId: null,
      sourceVersion: 1,
      sourceReference: reference,
      sourceEvidenceHash: null,
      expectedAmount: toDbMoney(count.declaredAmount),
      actualAmount: toDbMoney(count.countedAmount),
      variance: toDbMoney(count.variance),
      countedByUserId: Number(count.countedByUserId),
      responsibleUserId,
    };
  }

  const daily = (
    await tx
      .select()
      .from(cashDailyReconciliations)
      .where(eq(cashDailyReconciliations.id, input.sourceId))
      .for("update")
      .limit(1)
  )[0];
  if (!daily || daily.status !== "VARIANCE_OPEN" || money(daily.variance).abs().lte("0.005")) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "مطابقة الخزينة لا تحمل فرقاً مفتوحاً" });
  }
  if (Number(daily.branchId) !== branchId) {
    throw new TRPCError({ code: "CONFLICT", message: "فرع مطابقة الخزينة تغيّر" });
  }
  return {
    custodyReceiptId: null,
    custodyCountId: null,
    dailyReconciliationId: Number(daily.id),
    sourceVersion: Number(daily.version),
    sourceReference: `DAILY:${daily.businessDate}`,
    sourceEvidenceHash: daily.evidenceHash,
    expectedAmount: toDbMoney(daily.expectedTreasuryCash),
    actualAmount: toDbMoney(daily.countedTreasuryCash),
    variance: toDbMoney(daily.variance),
    countedByUserId: Number(daily.countedByUserId),
    responsibleUserId: null,
  };
}

export async function proposeCashVarianceCase(
  input: ProposeCashVarianceInput,
  actor: Actor,
  auditCtx: AuditMetadata = { userId: actor.userId, branchId: actor.branchId },
) {
  assertDecisionRole(actor);
  if (!isCashVarianceReasonAllowed(input.sourceType, input.reasonCode)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "سبب فرق النقد غير صالح لنوع المصدر المحدد",
    });
  }
  const reason = normalizeRequiredText(input.reason, "سبب فرق النقد", 10, 500);
  const evidenceReference = normalizeRequiredText(
    input.evidenceReference,
    "دليل فرق النقد",
    CASH_VARIANCE_EVIDENCE_REFERENCE_MIN_LENGTH,
    CASH_VARIANCE_EVIDENCE_REFERENCE_MAX_LENGTH,
  );
  const requestHash = hashRequest({
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    reasonCode: input.reasonCode,
    reason,
    evidenceReference,
    evidenceDocumentId: input.evidenceDocumentId,
    proposedByUserId: actor.userId,
  });

  return withTx(async (tx) => {
    const replay = await loadIdempotentProposal(tx, input, actor, requestHash);
    if (replay) return replay;

    const branchId = await candidateBranchTx(tx, input.sourceType, input.sourceId);
    assertBranchScope(actor, branchId);
    // LOCK ORDER 1/3: company financial gate (withTx) -> treasury branch.
    await lockCashSourceForUpdate(tx, {
      branchId,
      cashBucket: "TREASURY",
      shiftId: null,
    });
    // LOCK ORDER 2/3: source document follows the branch lock.
    const source = await loadProposalSourceTx(tx, input, branchId);
    const evidence = await lockEvidenceTx(tx, {
      id: input.evidenceDocumentId,
      branchId,
      ownerUserId: actor.userId,
    });
    if (!money(source.actualAmount).minus(source.expectedAmount).eq(source.variance)) {
      throw new TRPCError({ code: "CONFLICT", message: "مبالغ فرق النقد غير متسقة" });
    }

    const requiresResponsible =
      input.sourceType === "CUSTODY" && money(source.variance).isNegative();
    const responsibleUserId = requiresResponsible ? source.responsibleUserId : null;
    if (
      requiresResponsible &&
      (responsibleUserId == null ||
        !Number.isInteger(Number(responsibleUserId)) ||
        Number(responsibleUserId) <= 0)
    ) {
      throw new TRPCError({ code: "CONFLICT", message: "عقد العهدة الناقصة لا يحدد موظفاً مسؤولاً صالحاً" });
    }
    if (
      Number(source.countedByUserId) === actor.userId ||
      (responsibleUserId != null && Number(responsibleUserId) === actor.userId)
    ) {
      throw new TRPCError({ code: "FORBIDDEN", message: "منفذ العد أو الموظف المسؤول لا ينشئ قضية فرق النقد" });
    }
    let responsibleEmployee: typeof employees.$inferSelect | null = null;
    let responsible: {
      id: number;
      name: string | null;
      username: string | null;
      branchId: number | null;
      isActive: boolean | null;
    } | null = null;
    if (responsibleUserId != null) {
      responsibleEmployee = (
        await tx
          .select()
          .from(employees)
          .where(eq(employees.userId, Number(responsibleUserId)))
          .for("update")
          .limit(1)
      )[0] ?? null;
      if (
        !responsibleEmployee ||
        responsibleEmployee.isActive !== true ||
        responsibleEmployee.employmentStatus === "terminated" ||
        Number(responsibleEmployee.branchId) !== branchId
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "مسؤول عجز العهدة يجب أن يكون موظفاً فعالاً مرتبطاً بحساب في الفرع",
        });
      }
      responsible = (
        await tx
          .select({ id: users.id, name: users.name, username: users.username, branchId: users.branchId, isActive: users.isActive })
          .from(users)
          .where(eq(users.id, Number(responsibleUserId)))
          .limit(1)
      )[0] ?? null;
      if (!responsible || !responsible.isActive || Number(responsible.branchId) !== branchId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "مسؤول عجز العهدة غير موجود أو معطّل أو لا ينتمي إلى الفرع",
        });
      }
    }

    const existingSource = input.sourceType === "CUSTODY"
      ? (
          await tx
            .select({ id: cashVarianceCases.id })
            .from(cashVarianceCases)
            .where(eq(cashVarianceCases.custodyCountId, source.custodyCountId!))
            .limit(1)
        )[0]
      : (
          await tx
            .select({ id: cashVarianceCases.id })
            .from(cashVarianceCases)
            .where(
              and(
                eq(cashVarianceCases.dailyReconciliationId, source.dailyReconciliationId!),
                eq(cashVarianceCases.sourceVersion, source.sourceVersion),
              ),
            )
            .limit(1)
        )[0];
    if (existingSource) {
      throw new TRPCError({ code: "CONFLICT", message: "يوجد اقتراح تسوية لهذا الفرق والإصدار بالفعل" });
    }

    const inserted = await tx.insert(cashVarianceCases).values({
      branchId,
      sourceType: input.sourceType,
      custodyReceiptId: source.custodyReceiptId,
      custodyCountId: source.custodyCountId,
      dailyReconciliationId: source.dailyReconciliationId,
      sourceVersion: source.sourceVersion,
      sourceReference: source.sourceReference,
      sourceEvidenceHash: source.sourceEvidenceHash,
      expectedAmount: source.expectedAmount,
      actualAmount: source.actualAmount,
      variance: source.variance,
      reasonCode: input.reasonCode,
      reason,
      evidenceReference,
      evidenceDocumentId: Number(evidence.id),
      evidenceContentHash: evidence.contentHash,
      responsibleUserId,
      responsibleEmployeeId: responsibleEmployee == null ? null : Number(responsibleEmployee.id),
      responsibleNameSnapshot:
        responsible == null
          ? null
          : responsible.name ?? responsible.username ?? `#${responsible.id}`,
      countedByUserId: source.countedByUserId,
      proposedByUserId: actor.userId,
      proposalClientRequestId: input.clientRequestId,
      proposalRequestHash: requestHash,
    });
    const caseId = extractInsertId(inserted);
    await tx.insert(cashVarianceCaseEvents).values({
      caseId,
      version: 1,
      eventType: "PROPOSED",
      clientRequestId: input.clientRequestId,
      requestHash,
      actorUserId: actor.userId,
    });
    await logAuditTx(tx, auditCtx, {
      action: "treasury.cash_variance.propose",
      entityType: "cash_variance_case",
      entityId: caseId,
      branchId,
      newValue: {
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        reasonCode: input.reasonCode,
        evidenceDocumentId: Number(evidence.id),
        evidenceContentHash: evidence.contentHash,
      },
    });
    return {
      caseId,
      status: "PROPOSED" as const,
      version: 1,
      variance: source.variance,
      idempotent: false,
    };
  });
}

async function assertCustodySourceStillOpenTx(tx: Tx, row: typeof cashVarianceCases.$inferSelect) {
  if (row.custodyReceiptId == null || row.custodyCountId == null) {
    throw new TRPCError({ code: "CONFLICT", message: "مرجع عهدة فرق النقد ناقص" });
  }
  const receipt = (
    await tx
      .select()
      .from(receipts)
      .where(eq(receipts.id, Number(row.custodyReceiptId)))
      .for("update")
      .limit(1)
  )[0];
  if (
    !receipt ||
    receipt.status !== "PENDING" ||
    receipt.direction !== "IN" ||
    receipt.paymentMethod !== "CASH" ||
    receipt.cashBucket !== "TREASURY" ||
    receipt.approvalStatus !== "APPROVED" ||
    receipt.referenceNumber !== row.sourceReference
  ) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "عهدة النقد لم تعد مفتوحة للتسوية" });
  }
  const latestCount = (
    await tx
      .select()
      .from(cashCustodyCounts)
      .where(eq(cashCustodyCounts.treasuryReceiptId, Number(row.custodyReceiptId)))
      .orderBy(desc(cashCustodyCounts.id))
      .limit(1)
  )[0];
  if (
    !latestCount ||
    Number(latestCount.id) !== Number(row.custodyCountId) ||
    latestCount.status !== "VARIANCE_OPEN" ||
    !money(latestCount.declaredAmount).eq(row.expectedAmount) ||
    !money(latestCount.countedAmount).eq(row.actualAmount) ||
    !money(latestCount.variance).eq(row.variance)
  ) {
    throw new TRPCError({ code: "CONFLICT", message: "تغيّر عدّ العهدة بعد اقتراح التسوية" });
  }

  const sourceRows = await tx
    .select({ id: receipts.id, amount: receipts.amount })
    .from(receipts)
    .where(
      and(
        eq(receipts.branchId, Number(row.branchId)),
        eq(receipts.referenceNumber, row.sourceReference),
        eq(receipts.direction, "OUT"),
        eq(receipts.paymentMethod, "CASH"),
        eq(receipts.cashBucket, "DRAWER"),
        eq(receipts.status, "COMPLETED"),
        eq(receipts.approvalStatus, "APPROVED"),
      ),
    )
    .for("update");
  const matching = sourceRows.filter((source) => money(source.amount).eq(row.expectedAmount));
  if (matching.length !== 1) {
    throw new TRPCError({ code: "CONFLICT", message: "سند خروج العهدة غير مطابق أو غير فريد" });
  }
  const stageEntries = await tx
    .select({ entryType: accountingEntries.entryType, amount: accountingEntries.amount })
    .from(accountingEntries)
    .where(eq(accountingEntries.receiptId, Number(matching[0].id)));
  if (
    stageEntries.filter(
      (entry) => entry.entryType === "CASH_TRANSFER_OUT" && money(entry.amount).eq(row.expectedAmount),
    ).length !== 1
  ) {
    throw new TRPCError({ code: "CONFLICT", message: "قيد CASH_IN_TRANSIT الأصلي مفقود أو متكرر" });
  }
  return receipt;
}

async function assertDailySourceStillOpenTx(tx: Tx, row: typeof cashVarianceCases.$inferSelect) {
  if (row.dailyReconciliationId == null) {
    throw new TRPCError({ code: "CONFLICT", message: "مرجع المطابقة اليومية ناقص" });
  }
  const daily = (
    await tx
      .select()
      .from(cashDailyReconciliations)
      .where(eq(cashDailyReconciliations.id, Number(row.dailyReconciliationId)))
      .for("update")
      .limit(1)
  )[0];
  if (
    !daily ||
    daily.status !== "VARIANCE_OPEN" ||
    Number(daily.version) !== Number(row.sourceVersion) ||
    !money(daily.expectedTreasuryCash).eq(row.expectedAmount) ||
    !money(daily.countedTreasuryCash).eq(row.actualAmount) ||
    !money(daily.variance).eq(row.variance) ||
    daily.evidenceHash !== row.sourceEvidenceHash
  ) {
    throw new TRPCError({ code: "CONFLICT", message: "تغيّرت المطابقة اليومية بعد اقتراح التسوية" });
  }
  const evidence = await buildDailyCashEvidenceTx(
    tx,
    Number(row.branchId),
    daily.businessDate,
  );
  if (
    evidence.evidenceHash !== daily.evidenceHash ||
    !money(evidence.expectedTreasuryCash).eq(row.expectedAmount)
  ) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "تغيّرت حركات الخزينة؛ أعد الجرد قبل التسوية" });
  }
  return daily;
}

async function lockDecisionSourceTx(tx: Tx, candidate: typeof cashVarianceCases.$inferSelect) {
  if (candidate.sourceType === "CUSTODY") {
    if (candidate.custodyReceiptId == null) {
      throw new TRPCError({ code: "CONFLICT", message: "مرجع عهدة فرق النقد ناقص" });
    }
    await tx
      .select({ id: receipts.id })
      .from(receipts)
      .where(eq(receipts.id, Number(candidate.custodyReceiptId)))
      .for("update")
      .limit(1);
  } else {
    if (candidate.dailyReconciliationId == null) {
      throw new TRPCError({ code: "CONFLICT", message: "مرجع المطابقة اليومية ناقص" });
    }
    await tx
      .select({ id: cashDailyReconciliations.id })
      .from(cashDailyReconciliations)
      .where(eq(cashDailyReconciliations.id, Number(candidate.dailyReconciliationId)))
      .for("update")
      .limit(1);
  }
}

export async function approveCashVarianceCase(
  input: DecideCashVarianceInput,
  actor: Actor,
  auditCtx: AuditMetadata = { userId: actor.userId, branchId: actor.branchId },
) {
  assertDecisionRole(actor);
  const note = input.note?.trim() || null;
  if (note && note.length > 500) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "ملاحظة الاعتماد طويلة" });
  }
  const requestHash = hashRequest({
    action: "APPROVE",
    caseId: input.caseId,
    expectedVersion: input.expectedVersion,
    note,
    actorUserId: actor.userId,
  });

  return withTx(async (tx) => {
    const candidate = (
      await tx
        .select()
        .from(cashVarianceCases)
        .where(eq(cashVarianceCases.id, input.caseId))
        .limit(1)
    )[0];
    if (!candidate) throw new TRPCError({ code: "NOT_FOUND", message: "حالة فرق النقد غير موجودة" });
    assertBranchScope(actor, Number(candidate.branchId));

    // LOCK ORDER 1/6 and 2/6: financial gate is held by withTx, then treasury branch.
    await lockCashSourceForUpdate(tx, {
      branchId: Number(candidate.branchId),
      cashBucket: "TREASURY",
      shiftId: null,
    });
    // LOCK ORDER 3/6: source document before the case row.
    await lockDecisionSourceTx(tx, candidate);
    // LOCK ORDER 4/6: immutable case head serializes its append-only event stream.
    const row = (
      await tx
        .select()
        .from(cashVarianceCases)
        .where(eq(cashVarianceCases.id, input.caseId))
        .for("update")
        .limit(1)
    )[0];
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "حالة فرق النقد غير موجودة" });
    if (row.evidenceDocumentId == null || row.evidenceContentHash == null) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا يمكن اعتماد قضية بلا دليل موثق" });
    }
    await lockEvidenceTx(tx, {
      id: Number(row.evidenceDocumentId),
      branchId: Number(row.branchId),
      ownerUserId: Number(row.proposedByUserId),
      expectedHash: row.evidenceContentHash,
    });

    const replay = (
      await tx
        .select()
        .from(cashVarianceCaseEvents)
        .where(eq(cashVarianceCaseEvents.clientRequestId, input.clientRequestId))
        .limit(1)
    )[0];
    if (replay) {
      if (
        Number(replay.caseId) !== input.caseId ||
        replay.eventType !== "APPROVED" ||
        replay.requestHash !== requestHash
      ) {
        throw new TRPCError({ code: "CONFLICT", message: "مفتاح الاعتماد مستعمل لطلب مختلف" });
      }
      return {
        caseId: input.caseId,
        status: "APPROVED" as const,
        version: Number(replay.version),
        adjustmentReceiptId: Number(replay.adjustmentReceiptId),
        accountingEntryId: Number(replay.accountingEntryId),
        advanceId: replay.advanceId == null ? null : Number(replay.advanceId),
        idempotent: true,
      };
    }

    const latest = await latestEventTx(tx, input.caseId, true);
    if (!latest || latest.eventType !== "PROPOSED") {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "حالة فرق النقد محسومة بالفعل" });
    }
    if (Number(latest.version) !== input.expectedVersion) {
      throw new TRPCError({ code: "CONFLICT", message: "تغير إصدار حالة فرق النقد؛ حدّث الشاشة" });
    }
    if (Number(row.proposedByUserId) === actor.userId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "لا يجوز لمن اقترح التسوية اعتمادها" });
    }
    if (Number(row.countedByUserId) === actor.userId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "لا يجوز لمن نفذ العد اعتماد فرق العد نفسه" });
    }

    if (row.responsibleUserId != null && Number(row.responsibleUserId) === actor.userId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "لا يجوز للموظف المسؤول اعتماد قضية فرق النقد الخاصة به" });
    }

    const requiresResponsible =
      row.sourceType === "CUSTODY" && money(row.variance).isNegative();
    if (requiresResponsible) {
      if (row.responsibleUserId == null || row.responsibleEmployeeId == null) {
        throw new TRPCError({ code: "CONFLICT", message: "عجز العهدة لا يحمل هوية مسؤول مكتملة" });
      }
      const responsible = (
        await tx
          .select({
            employeeId: employees.id,
            employeeUserId: employees.userId,
            employeeBranchId: employees.branchId,
            employeeIsActive: employees.isActive,
            employmentStatus: employees.employmentStatus,
            userId: users.id,
            userIsActive: users.isActive,
            userBranchId: users.branchId,
          })
          .from(employees)
          .innerJoin(users, eq(users.id, employees.userId))
          .where(eq(employees.id, Number(row.responsibleEmployeeId)))
          .for("update")
          .limit(1)
      )[0];
      if (
        !responsible ||
        Number(responsible.employeeUserId) !== Number(row.responsibleUserId) ||
        Number(responsible.userId) !== Number(row.responsibleUserId) ||
        responsible.employeeIsActive !== true ||
        responsible.userIsActive !== true ||
        responsible.employmentStatus === "terminated" ||
        Number(responsible.employeeBranchId) !== Number(row.branchId) ||
        Number(responsible.userBranchId) !== Number(row.branchId)
      ) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "هوية موظف عجز العهدة لم تعد صالحة" });
      }
    } else if (row.responsibleUserId != null || row.responsibleEmployeeId != null) {
      throw new TRPCError({ code: "CONFLICT", message: "لا يجوز إسناد فرق غير عجز العهدة إلى موظف" });
    }

    const sourceDocument = row.sourceType === "CUSTODY"
      ? await assertCustodySourceStillOpenTx(tx, row)
      : await assertDailySourceStillOpenTx(tx, row);
    const plan = buildCashVariancePostingPlan({
      sourceType: row.sourceType,
      expectedAmount: String(row.expectedAmount),
      actualAmount: String(row.actualAmount),
    });
    const now = new Date();

    if (row.sourceType === "CUSTODY") {
      await tx
        .update(receipts)
        .set({ status: "COMPLETED", approvedBy: actor.userId, approvedAt: now })
        .where(
          and(
            eq(receipts.id, Number(row.custodyReceiptId)),
            eq(receipts.status, "PENDING"),
          ),
        );
    }

    // LOCK ORDER 5/6: materialized receipt rows are read only after branch/source/case locks.
    if (plan.direction === "OUT") {
      await assertCashOutAvailable(tx, {
        branchId: Number(row.branchId),
        cashBucket: "TREASURY",
        shiftId: null,
        amount: plan.adjustmentAmount,
        operation: "تسوية عجز نقد معتمدة",
      });
    }
    const adjustmentInsert = await tx.insert(receipts).values({
      branchId: Number(row.branchId),
      direction: plan.direction,
      amount: plan.adjustmentAmount,
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      referenceNumber: `CV-${row.id}`,
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      approvedBy: actor.userId,
      approvedAt: now,
      voucherDate: new Date(`${todayUtcDate()}T00:00:00.000Z`),
      createdAt: now,
      partyType: "OTHER",
      counterpartyName: row.responsibleNameSnapshot,
      description:
        `${plan.varianceType === "SHORTAGE" ? "تسوية عجز" : "تعليق زيادة"} ` +
        `لحالة فرق النقد #${row.id} — ${row.reason}`,
      internalNote: `المصدر ${row.sourceReference}؛ الدليل ${row.evidenceReference}`,
      createdBy: Number(row.proposedByUserId),
    });
    const adjustmentReceiptId = extractInsertId(adjustmentInsert);

    // LOCK ORDER 6/6: posting is last; any period/journal failure rolls back every prior write.
    const postingIntent = createPostingIntent(
      plan.postingProfile,
      plan.entryType,
      plan.lines,
      plan.sourceComponents,
    );
    await postEntry(tx, {
      entryType: plan.entryType,
      postingIntent,
      postingSourceComponents: plan.sourceComponents,
      branchId: Number(row.branchId),
      receiptId: adjustmentReceiptId,
      amount: money(plan.entryAmount),
      revenue: money(0),
      cost: money(0),
      profit: money(0),
      dedupeKey: `CASH_VARIANCE:${row.id}`,
      createdBy: actor.userId,
      notes: `${row.sourceReference}: ${
        plan.counterAccountRole === "EMPLOYEE_ADVANCES"
          ? "عجز عهدة محمل كذمة موظف"
          : plan.counterAccountRole === "LOSSES"
            ? "عجز خزينة يومي معتمد كمصروف خسائر"
            : "زيادة معلقة كالتزام"
      }`,
    });
    const accountingEntry = (
      await tx
        .select({ id: accountingEntries.id })
        .from(accountingEntries)
        .where(eq(accountingEntries.dedupeKey, `CASH_VARIANCE:${row.id}`))
        .limit(1)
    )[0];
    if (!accountingEntry) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تثبيت قيد فرق النقد" });
    }

    let advanceId: number | null = null;
    if (plan.counterAccountRole === "EMPLOYEE_ADVANCES") {
      if (row.responsibleEmployeeId == null) {
        throw new TRPCError({ code: "CONFLICT", message: "قيد ذمة عجز العهدة بلا موظف مسؤول" });
      }
      const advanceInsert = await tx.insert(employeeAdvances).values({
        employeeId: Number(row.responsibleEmployeeId),
        branchId: Number(row.branchId),
        amount: plan.adjustmentAmount,
        remaining: plan.adjustmentAmount,
        monthlyDeduction: null,
        status: "ACTIVE",
        receiptId: adjustmentReceiptId,
        note: `ذمة عجز نقد — قضية #${row.id} — ${row.sourceReference}`.slice(0, 255),
        createdBy: actor.userId,
        grantedAt: now,
      });
      advanceId = extractInsertId(advanceInsert);
    }

    if (row.sourceType === "DAILY_TREASURY") {
      const daily = sourceDocument as typeof cashDailyReconciliations.$inferSelect;
      if (daily.businessDate === todayUtcDate()) {
        const refreshed = await buildDailyCashEvidenceTx(
          tx,
          Number(row.branchId),
          daily.businessDate,
        );
        if (!money(refreshed.expectedTreasuryCash).eq(row.actualAmount)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "سند التسوية لم يوصل رصيد اليوم إلى النقد الفعلي",
          });
        }
      }
      if (daily.evidenceHash !== row.sourceEvidenceHash) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "بصمة دليل المطابقة التاريخية لا تطابق القضية",
        });
      }
      await tx
        .update(cashDailyReconciliations)
        .set({
          status: "RESOLVED_WITH_ADJUSTMENT",
          version: sql`${cashDailyReconciliations.version} + 1`,
        })
        .where(
          and(
            eq(cashDailyReconciliations.id, Number(row.dailyReconciliationId)),
            eq(cashDailyReconciliations.version, Number(row.sourceVersion)),
          ),
        );
    }

    const version = Number(latest.version) + 1;
    await tx.insert(cashVarianceCaseEvents).values({
      caseId: Number(row.id),
      version,
      eventType: "APPROVED",
      clientRequestId: input.clientRequestId,
      requestHash,
      actorUserId: actor.userId,
      note,
      counterAccountRole: plan.counterAccountRole,
      resolvedVariance: String(row.variance),
      adjustmentReceiptId,
      accountingEntryId: Number(accountingEntry.id),
      advanceId,
    });
    await logAuditTx(tx, auditCtx, {
      action: "treasury.cash_variance.approve",
      entityType: "cash_variance_case",
      entityId: Number(row.id),
      branchId: Number(row.branchId),
      newValue: { version, evidenceDocumentId: Number(row.evidenceDocumentId), evidenceContentHash: row.evidenceContentHash },
    });
    return {
      caseId: Number(row.id),
      status: "APPROVED" as const,
      version,
      adjustmentReceiptId,
      accountingEntryId: Number(accountingEntry.id),
      advanceId,
      idempotent: false,
    };
  });
}

export async function rejectCashVarianceCase(
  input: DecideCashVarianceInput & { reason: string },
  actor: Actor,
  auditCtx: AuditMetadata = { userId: actor.userId, branchId: actor.branchId },
) {
  assertDecisionRole(actor);
  const reason = normalizeRequiredText(input.reason, "سبب رفض التسوية", 10, 500);
  const requestHash = hashRequest({
    action: "REJECT",
    caseId: input.caseId,
    expectedVersion: input.expectedVersion,
    reason,
    actorUserId: actor.userId,
  });
  return withTx(async (tx) => {
    const candidate = (
      await tx.select().from(cashVarianceCases).where(eq(cashVarianceCases.id, input.caseId)).limit(1)
    )[0];
    if (!candidate) throw new TRPCError({ code: "NOT_FOUND", message: "حالة فرق النقد غير موجودة" });
    assertBranchScope(actor, Number(candidate.branchId));
    await lockCashSourceForUpdate(tx, {
      branchId: Number(candidate.branchId),
      cashBucket: "TREASURY",
      shiftId: null,
    });
    await lockDecisionSourceTx(tx, candidate);
    const row = (await tx
      .select()
      .from(cashVarianceCases)
      .where(eq(cashVarianceCases.id, input.caseId))
      .for("update")
      .limit(1))[0];
    if (!row || row.evidenceDocumentId == null || row.evidenceContentHash == null) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا يمكن رفض قضية بلا دليل موثق" });
    }
    await lockEvidenceTx(tx, {
      id: Number(row.evidenceDocumentId),
      branchId: Number(row.branchId),
      ownerUserId: Number(row.proposedByUserId),
      expectedHash: row.evidenceContentHash,
    });
    const replay = (
      await tx.select().from(cashVarianceCaseEvents).where(eq(cashVarianceCaseEvents.clientRequestId, input.clientRequestId)).limit(1)
    )[0];
    if (replay) {
      if (replay.eventType !== "REJECTED" || replay.requestHash !== requestHash) {
        throw new TRPCError({ code: "CONFLICT", message: "مفتاح الرفض مستعمل لطلب مختلف" });
      }
      return { caseId: input.caseId, status: "REJECTED" as const, version: Number(replay.version), idempotent: true };
    }
    const latest = await latestEventTx(tx, input.caseId, true);
    if (!latest || latest.eventType !== "PROPOSED") {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "حالة فرق النقد محسومة بالفعل" });
    }
    if (Number(latest.version) !== input.expectedVersion) {
      throw new TRPCError({ code: "CONFLICT", message: "تغير إصدار حالة فرق النقد" });
    }
    if (
      Number(candidate.proposedByUserId) === actor.userId ||
      Number(candidate.countedByUserId) === actor.userId ||
      Number(candidate.responsibleUserId) === actor.userId
    ) {
      throw new TRPCError({ code: "FORBIDDEN", message: "قرار فرق النقد يحتاج مراجعاً مستقلاً" });
    }
    const version = Number(latest.version) + 1;
    await tx.insert(cashVarianceCaseEvents).values({
      caseId: input.caseId,
      version,
      eventType: "REJECTED",
      clientRequestId: input.clientRequestId,
      requestHash,
      actorUserId: actor.userId,
      note: reason,
    });
    await logAuditTx(tx, auditCtx, {
      action: "treasury.cash_variance.reject",
      entityType: "cash_variance_case",
      entityId: input.caseId,
      branchId: Number(row.branchId),
      newValue: { version, reason, evidenceDocumentId: Number(row.evidenceDocumentId), evidenceContentHash: row.evidenceContentHash },
    });
    return { caseId: input.caseId, status: "REJECTED" as const, version, idempotent: false };
  });
}

export async function listCashVarianceCases(
  input: {
    branchId?: number;
    status?: CashVarianceEventType;
    limit?: number;
    cursor?: { createdAt: Date; id: number } | null;
  },
  actor: Actor,
) {
  assertDecisionRole(actor);
  const branchId = input.branchId ?? actor.branchId;
  assertBranchScope(actor, branchId);
  const runner = requireDb();
  const latestVersions = runner
    .select({
      caseId: cashVarianceCaseEvents.caseId,
      version: sql<number>`MAX(${cashVarianceCaseEvents.version})`.as("latestVersion"),
    })
    .from(cashVarianceCaseEvents)
    .groupBy(cashVarianceCaseEvents.caseId)
    .as("cashVarianceLatestVersions");
  const baseWhere = and(
    eq(cashVarianceCases.branchId, branchId),
    input.status ? eq(cashVarianceCaseEvents.eventType, input.status) : undefined,
  );
  const oldestFirst = input.status === "PROPOSED";
  const cursorWhere = input.cursor == null
    ? undefined
    : oldestFirst
      ? or(
          gt(cashVarianceCases.createdAt, input.cursor.createdAt),
          and(
            eq(cashVarianceCases.createdAt, input.cursor.createdAt),
            gt(cashVarianceCases.id, input.cursor.id),
          ),
        )
      : or(
          lt(cashVarianceCases.createdAt, input.cursor.createdAt),
          and(
            eq(cashVarianceCases.createdAt, input.cursor.createdAt),
            lt(cashVarianceCases.id, input.cursor.id),
          ),
        );
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const total = Number((await runner
    .select({ count: sql<number>`COUNT(*)` })
    .from(cashVarianceCases)
    .innerJoin(latestVersions, eq(latestVersions.caseId, cashVarianceCases.id))
    .innerJoin(
      cashVarianceCaseEvents,
      and(
        eq(cashVarianceCaseEvents.caseId, cashVarianceCases.id),
        eq(cashVarianceCaseEvents.version, latestVersions.version),
      ),
    )
    .where(baseWhere))[0]?.count ?? 0);
  const pageRows = await runner
    .select({ case: cashVarianceCases, latestEvent: cashVarianceCaseEvents })
    .from(cashVarianceCases)
    .innerJoin(latestVersions, eq(latestVersions.caseId, cashVarianceCases.id))
    .innerJoin(
      cashVarianceCaseEvents,
      and(
        eq(cashVarianceCaseEvents.caseId, cashVarianceCases.id),
        eq(cashVarianceCaseEvents.version, latestVersions.version),
      ),
    )
    .where(and(baseWhere, cursorWhere))
    .orderBy(
      oldestFirst ? asc(cashVarianceCases.createdAt) : desc(cashVarianceCases.createdAt),
      oldestFirst ? asc(cashVarianceCases.id) : desc(cashVarianceCases.id),
    )
    .limit(limit + 1);
  const hasMore = pageRows.length > limit;
  const page = hasMore ? pageRows.slice(0, limit) : pageRows;
  const rows = page.map(({ case: row, latestEvent }) => ({
    ...row,
    status: latestEvent.eventType,
    version: Number(latestEvent.version),
    latestEvent,
  }));
  const last = page.at(-1)?.case;
  return {
    rows,
    hasMore,
    nextCursor: hasMore && last
      ? { createdAt: last.createdAt, id: Number(last.id) }
      : null,
    total,
  };
}

export async function getCashVarianceCase(caseId: number, actor: Actor) {
  assertDecisionRole(actor);
  const row = (
    await requireDb()
      .select()
      .from(cashVarianceCases)
      .where(eq(cashVarianceCases.id, caseId))
      .limit(1)
  )[0];
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "حالة فرق النقد غير موجودة" });
  }
  assertBranchScope(actor, Number(row.branchId));
  const events = await requireDb()
    .select()
    .from(cashVarianceCaseEvents)
    .where(eq(cashVarianceCaseEvents.caseId, caseId))
    .orderBy(desc(cashVarianceCaseEvents.version));
  const latest = events[0];
  if (!latest) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "سجل حالة فرق النقد غير مكتمل" });
  }
  return {
    ...row,
    status: latest.eventType,
    version: Number(latest.version),
    latestEvent: latest,
    events,
    decisionPolicy: cashVarianceDecisionPolicy(row, latest.eventType, actor),
  };
}

export async function listCashVarianceResponsibleUsers(branchId: number, actor: Actor) {
  assertDecisionRole(actor);
  assertBranchScope(actor, branchId);
  return requireDb()
    .select({
      id: users.id,
      employeeId: employees.id,
      name: users.name,
      username: users.username,
      role: users.role,
    })
    .from(employees)
    .innerJoin(users, eq(users.id, employees.userId))
    .where(
      and(
        eq(employees.branchId, branchId),
        eq(employees.isActive, true),
        eq(employees.employmentStatus, "active"),
        eq(users.branchId, branchId),
        eq(users.isActive, true),
      ),
    )
    .orderBy(users.name, users.id)
    .limit(500);
}
