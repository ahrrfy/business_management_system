import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import {
  approveCashVarianceCase,
  buildCashVariancePostingPlan,
  getCashVarianceCase,
  listCashVarianceCases,
  proposeCashVarianceCase,
  registerCashVarianceEvidence,
  rejectCashVarianceCase,
} from "../cashVarianceService";
import {
  createPostingIntent,
  creditLine,
  debitLine,
} from "../accounting/postingEngine";
import { postEntry } from "../ledgerService";
import { money, toDateStr } from "../money";
import {
  buildDailyCashEvidenceTx,
  closeDailyCashReconciliation,
  getDailyCashReconciliation,
} from "../cashDailyReconciliationService";
import { suggestDeductionsForPeriod } from "../advancesService";
import { ensureFinancialPostingGate } from "../reports/monthCloseGate";
import { truncateTables } from "./__testUtils__";
import { CASH_VARIANCE_EVIDENCE_MAX_BYTES } from "../../../shared/cashVariance";

const MAKER = { userId: 71, branchId: 1, role: "manager" as const };
const COUNTER = { userId: 72, branchId: 1, role: "manager" as const };
const CHECKER = { userId: 73, branchId: 1, role: "manager" as const };
const SECOND_CHECKER = { userId: 76, branchId: 1, role: "admin" as const };
const OTHER_BRANCH = { userId: 74, branchId: 2, role: "manager" as const };
const RESPONSIBLE_USER_ID = 75;
const INNOCENT_USER_ID = 77;
const RESPONSIBLE_EMPLOYEE_ID = 501;

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

const TABLES = [
  "auditLogs",
  "cashVarianceCaseEvents",
  "cashVarianceCases",
  "cashVarianceEvidenceDocuments",
  "advanceSettlements",
  "employeeAdvances",
  "journalLines",
  "journalEntries",
  "accountingEntries",
  "doubleEntrySettings",
  "monthCloseSequence",
  "financialPeriods",
  "cashDailyReconciliations",
  "cashCustodyCounts",
  "receipts",
  "shifts",
  "employees",
  "users",
  "branches",
];

async function seedBase() {
  await truncateTables(TABLES);
  await db().insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
  await db().insert(s.users).values([
    { id: MAKER.userId, openId: "variance-maker", name: "منشئ الحالة", role: "manager", branchId: 1 },
    { id: COUNTER.userId, openId: "variance-counter", name: "منفذ العد", role: "manager", branchId: 1 },
    { id: CHECKER.userId, openId: "variance-checker", name: "معتمد مستقل", role: "manager", branchId: 1 },
    { id: SECOND_CHECKER.userId, openId: "variance-checker-2", name: "معتمد مستقل ثان", role: "admin", branchId: 1 },
    { id: OTHER_BRANCH.userId, openId: "variance-other", name: "مدير فرع آخر", role: "manager", branchId: 2 },
    { id: RESPONSIBLE_USER_ID, openId: "variance-responsible", name: "الموظف المسؤول", role: "cashier", branchId: 1 },
    { id: INNOCENT_USER_ID, openId: "variance-innocent", name: "موظف بريء", role: "cashier", branchId: 1 },
  ]);
  await db().insert(s.employees).values([
    { id: RESPONSIBLE_EMPLOYEE_ID, userId: RESPONSIBLE_USER_ID, branchId: 1, firstName: "الموظف", lastName: "المسؤول", isActive: true, employmentStatus: "active" },
    { id: 502, userId: INNOCENT_USER_ID, branchId: 1, firstName: "موظف", lastName: "بريء", isActive: true, employmentStatus: "active" },
  ]);
  await db().insert(s.doubleEntrySettings).values({
    id: 1,
    mode: "SHADOW",
    shadowCycleId: "cash-variance-test",
  });
  await ensureFinancialPostingGate(db());
}

beforeEach(seedBase);

async function seedCustodyVariance(input: {
  declared?: string;
  counted?: string;
  reference?: string;
  withoutShift?: boolean;
}) {
  const declared = input.declared ?? "100000.00";
  const counted = input.counted ?? "75000.00";
  const reference = input.reference ?? "CH-1-20260831-0001";
  const shiftId = input.withoutShift
    ? null
    : extractInsertId(await db().insert(s.shifts).values({
        branchId: 1,
        userId: RESPONSIBLE_USER_ID,
        openingBalance: declared,
        status: "CLOSED",
        shiftType: "RETAIL",
      }));
  const outInsert = await db().insert(s.receipts).values({
    branchId: 1,
    shiftId,
    direction: "OUT",
    amount: declared,
    paymentMethod: "CASH",
    cashBucket: "DRAWER",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    referenceNumber: reference,
    createdBy: RESPONSIBLE_USER_ID,
  });
  const outReceiptId = extractInsertId(outInsert);
  const inInsert = await db().insert(s.receipts).values({
    branchId: 1,
    direction: "IN",
    amount: declared,
    paymentMethod: "CASH",
    cashBucket: "TREASURY",
    status: "PENDING",
    approvalStatus: "APPROVED",
    referenceNumber: reference,
    createdBy: COUNTER.userId,
  });
  const treasuryReceiptId = extractInsertId(inInsert);
  await db().transaction((tx) =>
    postEntry(tx, {
      entryType: "CASH_TRANSFER_OUT",
      postingIntent: createPostingIntent(
        "CASH_HANDOVER_TO_TRANSIT",
        "CASH_TRANSFER_OUT",
        [
          debitLine("CASH_IN_TRANSIT", declared),
          creditLine("CASH", declared),
        ],
      ),
      branchId: 1,
      receiptId: outReceiptId,
      amount: money(declared),
      dedupeKey: `TEST-CASH-VARIANCE-STAGE:${reference}`,
    }),
  );
  const countInsert = await db().insert(s.cashCustodyCounts).values({
    treasuryReceiptId,
    clientRequestId: `count-${reference}`,
    declaredAmount: declared,
    countedAmount: counted,
    variance: money(counted).minus(declared).toFixed(2),
    countedBreakdown: {},
    status: "VARIANCE_OPEN",
    countedByUserId: COUNTER.userId,
  });
  return {
    treasuryReceiptId,
    countId: extractInsertId(countInsert),
    reference,
  };
}

async function evidence(requestId: string, actor = MAKER) {
  const content = Buffer.from(`cash-variance-evidence:${requestId}`, "utf8");
  return registerCashVarianceEvidence({
    branchId: actor.branchId,
    fileName: `${requestId}.png`,
    dataUrl: `data:image/png;base64,${content.toString("base64")}`,
    clientRequestId: `evidence-${requestId}`.slice(0, 64),
  }, actor);
}

async function proposal(sourceType: "CUSTODY" | "DAILY_TREASURY", sourceId: number, requestId: string) {
  const registered = await evidence(requestId);
  return proposeCashVarianceCase(
    {
      sourceType,
      sourceId,
      reasonCode: sourceType === "CUSTODY" ? "CUSTODY_LOSS" : "COUNT_ERROR",
      reason: "فرق نقد فعلي مثبت بعد عد مستقل ومراجعة المستند",
      evidenceReference: "evidence://cash-count/verified",
      evidenceDocumentId: registered.evidenceDocumentId,
      clientRequestId: requestId,
    },
    MAKER,
  );
}

async function legacyCaseWithoutEvidence(reference: string) {
  const source = await seedCustodyVariance({ reference });
  const count = (
    await db().select().from(s.cashCustodyCounts)
      .where(eq(s.cashCustodyCounts.id, source.countId)).limit(1)
  )[0];
  const inserted = await db().insert(s.cashVarianceCases).values({
    branchId: 1,
    sourceType: "CUSTODY",
    custodyReceiptId: source.treasuryReceiptId,
    custodyCountId: source.countId,
    sourceVersion: 1,
    sourceReference: reference,
    expectedAmount: count.declaredAmount,
    actualAmount: count.countedAmount,
    variance: count.variance,
    reasonCode: "CUSTODY_LOSS",
    reason: "قضية قديمة بلا مستند دليل ثابت",
    evidenceReference: "legacy-evidence-description",
    evidenceDocumentId: null,
    evidenceContentHash: null,
    responsibleUserId: RESPONSIBLE_USER_ID,
    responsibleEmployeeId: RESPONSIBLE_EMPLOYEE_ID,
    responsibleNameSnapshot: "الموظف المسؤول",
    countedByUserId: COUNTER.userId,
    proposedByUserId: MAKER.userId,
    proposalClientRequestId: `legacy-${reference}`.slice(0, 64),
    proposalRequestHash: "a".repeat(64),
  });
  const caseId = extractInsertId(inserted);
  await db().insert(s.cashVarianceCaseEvents).values({
    caseId,
    version: 1,
    eventType: "PROPOSED",
    clientRequestId: `legacy-event-${reference}`.slice(0, 64),
    requestHash: "b".repeat(64),
    actorUserId: MAKER.userId,
  });
  return { caseId, source };
}

async function installAuditFailure(action: string) {
  await db().execute(sql.raw("DROP TRIGGER IF EXISTS `test_cash_variance_audit_failure`"));
  const safeAction = action.replaceAll("'", "''");
  await db().execute(sql.raw(`
    CREATE TRIGGER \`test_cash_variance_audit_failure\`
    BEFORE INSERT ON \`auditLogs\`
    FOR EACH ROW
    BEGIN
      IF NEW.action = '${safeAction}' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'injected audit failure';
      END IF;
    END
  `));
}

async function removeAuditFailure() {
  await db().execute(sql.raw("DROP TRIGGER IF EXISTS `test_cash_variance_audit_failure`"));
}

describe("cash variance maker-checker resolution", () => {
  it("يرفض سبب عجز العهدة عند مصدر المطابقة اليومية من الخدمة مباشرة", async () => {
    await expect(proposeCashVarianceCase({
      sourceType: "DAILY_TREASURY",
      sourceId: 1,
      reasonCode: "CUSTODY_LOSS",
      reason: "سبب غير صالح للمطابقة اليومية",
      evidenceReference: "evidence://invalid-daily-reason",
      evidenceDocumentId: 1,
      clientRequestId: "invalid-daily-reason",
    }, MAKER)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("يسجل دليلاً محدوداً ببصمة خادمية ويرفض MIME والحجم والنطاق والمالك والتلاعب", async () => {
    const bytes = Buffer.from("server-hashed-cash-evidence", "utf8");
    const input = {
      branchId: 1,
      fileName: "count-proof.png",
      dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
      clientRequestId: "evidence-contract-register",
    };
    const registered = await registerCashVarianceEvidence(input, MAKER);
    expect(registered).toEqual({
      evidenceDocumentId: expect.any(Number),
      contentHash: createHash("sha256").update(bytes).digest("hex"),
      idempotent: false,
    });
    await expect(registerCashVarianceEvidence(input, MAKER)).resolves.toMatchObject({
      evidenceDocumentId: registered.evidenceDocumentId,
      idempotent: true,
    });
    const stored = (
      await db().select().from(s.cashVarianceEvidenceDocuments)
        .where(eq(s.cashVarianceEvidenceDocuments.id, registered.evidenceDocumentId)).limit(1)
    )[0];
    expect(Buffer.from(stored.content).equals(bytes)).toBe(true);
    expect(stored.contentHash).toBe(createHash("sha256").update(bytes).digest("hex"));

    await expect(registerCashVarianceEvidence({
      ...input,
      clientRequestId: "evidence-invalid-mime",
      fileName: "proof.svg",
      dataUrl: "data:image/svg+xml;base64,PHN2Zy8+",
    }, MAKER)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const oversized = Buffer.alloc(CASH_VARIANCE_EVIDENCE_MAX_BYTES + 1, 1);
    await expect(registerCashVarianceEvidence({
      ...input,
      clientRequestId: "evidence-oversized",
      dataUrl: `data:image/png;base64,${oversized.toString("base64")}`,
    }, MAKER)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(registerCashVarianceEvidence({
      ...input,
      clientRequestId: "evidence-cross-branch",
      branchId: 2,
    }, MAKER)).rejects.toMatchObject({ code: "FORBIDDEN" });

    const ownerSource = await seedCustodyVariance({ reference: "CH-1-20260831-0020" });
    await expect(proposeCashVarianceCase({
      sourceType: "CUSTODY",
      sourceId: ownerSource.treasuryReceiptId,
      reasonCode: "CUSTODY_LOSS",
      reason: "لا يجوز استعمال دليل منشئ آخر في القضية",
      evidenceReference: "owner-mismatch-description",
      evidenceDocumentId: registered.evidenceDocumentId,
      clientRequestId: "evidence-owner-mismatch",
    }, SECOND_CHECKER)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    const branchEvidence = await registerCashVarianceEvidence({
      branchId: 2,
      fileName: "other-branch.png",
      dataUrl: `data:image/png;base64,${Buffer.from("other-branch").toString("base64")}`,
      clientRequestId: "evidence-admin-other-branch",
    }, SECOND_CHECKER);
    await expect(proposeCashVarianceCase({
      sourceType: "CUSTODY",
      sourceId: ownerSource.treasuryReceiptId,
      reasonCode: "CUSTODY_LOSS",
      reason: "لا يجوز استعمال دليل فرع آخر في القضية",
      evidenceReference: "branch-mismatch-description",
      evidenceDocumentId: branchEvidence.evidenceDocumentId,
      clientRequestId: "evidence-branch-mismatch",
    }, SECOND_CHECKER)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    await expect(
      db().update(s.cashVarianceEvidenceDocuments)
        .set({ content: Buffer.from("tampered") })
        .where(eq(s.cashVarianceEvidenceDocuments.id, registered.evidenceDocumentId)),
    ).rejects.toBeDefined();
  });

  it("يرفض الاقتراح والاعتماد والرفض عند غياب مستند الدليل", async () => {
    const missingSource = await seedCustodyVariance({ reference: "CH-1-20260831-0021" });
    await expect(proposeCashVarianceCase({
      sourceType: "CUSTODY",
      sourceId: missingSource.treasuryReceiptId,
      reasonCode: "CUSTODY_LOSS",
      reason: "هذا الاقتراح بلا سجل دليل داخلي صالح",
      evidenceReference: "missing-evidence-description",
      evidenceDocumentId: 999_999,
      clientRequestId: "missing-evidence-proposal",
    }, MAKER)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await db().select().from(s.cashVarianceCases)).toHaveLength(0);
    expect(await db().select().from(s.cashVarianceCaseEvents)).toHaveLength(0);

    const approveLegacy = await legacyCaseWithoutEvidence("CH-1-20260831-0022");
    await expect(approveCashVarianceCase({
      caseId: approveLegacy.caseId,
      expectedVersion: 1,
      clientRequestId: "legacy-missing-evidence-approve",
    }, CHECKER)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const rejectLegacy = await legacyCaseWithoutEvidence("CH-1-20260831-0023");
    await expect(rejectCashVarianceCase({
      caseId: rejectLegacy.caseId,
      expectedVersion: 1,
      clientRequestId: "legacy-missing-evidence-reject",
      reason: "لا يجوز رفض القضية دون دليلها الحاكم",
    }, CHECKER)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("uses custody receivables, daily losses, and liability suspense without invented revenue", () => {
    const shortage = buildCashVariancePostingPlan({
      sourceType: "CUSTODY",
      expectedAmount: "100000.00",
      actualAmount: "75000.00",
    });
    expect(shortage).toMatchObject({
      direction: "OUT",
      varianceType: "SHORTAGE",
      counterAccountRole: "EMPLOYEE_ADVANCES",
      postingProfile: "CASH_CUSTODY_SHORTAGE",
    });
    expect(shortage.lines).toEqual([
      { role: "TREASURY_CASH", debit: "75000.00", credit: "0.00" },
      { role: "EMPLOYEE_ADVANCES", debit: "25000.00", credit: "0.00" },
      { role: "CASH_IN_TRANSIT", debit: "0.00", credit: "100000.00" },
    ]);

    const dailyShortage = buildCashVariancePostingPlan({
      sourceType: "DAILY_TREASURY",
      expectedAmount: "100000.00",
      actualAmount: "75000.00",
    });
    expect(dailyShortage).toMatchObject({
      direction: "OUT",
      varianceType: "SHORTAGE",
      counterAccountRole: "LOSSES",
      postingProfile: "CASH_DAILY_SHORTAGE",
    });
    expect(dailyShortage.lines).toEqual([
      { role: "LOSSES", debit: "25000.00", credit: "0.00" },
      { role: "TREASURY_CASH", debit: "0.00", credit: "25000.00" },
    ]);

    const surplus = buildCashVariancePostingPlan({
      sourceType: "DAILY_TREASURY",
      expectedAmount: "100000.00",
      actualAmount: "125000.00",
    });
    expect(surplus).toMatchObject({
      direction: "IN",
      varianceType: "SURPLUS",
      counterAccountRole: "OTHER_LIABILITY",
      postingProfile: "CASH_DAILY_SURPLUS",
    });
    expect(surplus.lines.map((line) => line.role)).not.toContain("OTHER_REVENUE");
    const totals = surplus.lines.reduce(
      (sum, line) => ({
        debit: sum.debit.plus(line.debit),
        credit: sum.credit.plus(line.credit),
      }),
      { debit: money(0), credit: money(0) },
    );
    expect(totals.debit.eq(totals.credit)).toBe(true);
  });

  it("resolves a custody shortage atomically, clears transit and is idempotent", async () => {
    const source = await seedCustodyVariance({});
    const created = await proposal("CUSTODY", source.treasuryReceiptId, "variance-propose-1");
    await expect(getCashVarianceCase(created.caseId, MAKER)).resolves.toMatchObject({
      decisionPolicy: { canDecide: false, blockedReason: "لا يمكنك اعتماد تسوية اقترحتها أنت." },
    });
    await expect(getCashVarianceCase(created.caseId, CHECKER)).resolves.toMatchObject({
      decisionPolicy: { canDecide: true, blockedReason: null },
    });

    await expect(
      approveCashVarianceCase(
        { caseId: created.caseId, expectedVersion: 1, clientRequestId: "variance-approve-maker" },
        MAKER,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      approveCashVarianceCase(
        { caseId: created.caseId, expectedVersion: 1, clientRequestId: "variance-approve-counter" },
        COUNTER,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      approveCashVarianceCase(
        { caseId: created.caseId, expectedVersion: 1, clientRequestId: "variance-approve-branch" },
        OTHER_BRANCH,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const approved = await approveCashVarianceCase(
      { caseId: created.caseId, expectedVersion: 1, clientRequestId: "variance-approve-1" },
      CHECKER,
    );
    expect(approved).toMatchObject({ status: "APPROVED", version: 2, idempotent: false });
    const replay = await approveCashVarianceCase(
      { caseId: created.caseId, expectedVersion: 1, clientRequestId: "variance-approve-1" },
      CHECKER,
    );
    expect(replay.idempotent).toBe(true);

    const custodyReceipt = (
      await db().select().from(s.receipts).where(eq(s.receipts.id, source.treasuryReceiptId))
    )[0];
    expect(custodyReceipt.status).toBe("COMPLETED");
    expect(custodyReceipt.amount).toBe("100000.00");
    const adjustment = (
      await db()
        .select()
        .from(s.receipts)
        .where(eq(s.receipts.referenceNumber, `CV-${created.caseId}`))
    )[0];
    expect(adjustment).toMatchObject({ direction: "OUT", amount: "25000.00", cashBucket: "TREASURY" });

    const resolutionEntry = (
      await db()
        .select()
        .from(s.accountingEntries)
        .where(eq(s.accountingEntries.dedupeKey, `CASH_VARIANCE:${created.caseId}`))
    )[0];
    expect(resolutionEntry).toMatchObject({
      postingProfile: "CASH_CUSTODY_SHORTAGE",
      receiptId: adjustment.id,
      revenue: "0.00",
      cost: "0.00",
      profit: "0.00",
    });
    const journal = (
      await db().select().from(s.journalEntries).where(eq(s.journalEntries.entryId, resolutionEntry.id))
    )[0];
    const lines = await db().select().from(s.journalLines).where(eq(s.journalLines.journalId, journal.id));
    expect(lines.map((line) => [line.role, line.debit, line.credit]).sort()).toEqual([
      ["CASH_IN_TRANSIT", "0.00", "100000.00"],
      ["EMPLOYEE_ADVANCES", "25000.00", "0.00"],
      ["TREASURY_CASH", "75000.00", "0.00"],
    ]);
    const approvedEvent = (
      await db().select().from(s.cashVarianceCaseEvents).where(eq(s.cashVarianceCaseEvents.eventType, "APPROVED"))
    )[0];
    const advance = (
      await db().select().from(s.employeeAdvances).where(eq(s.employeeAdvances.id, Number(approvedEvent.advanceId)))
    )[0];
    expect(advance).toMatchObject({
      employeeId: RESPONSIBLE_EMPLOYEE_ID,
      branchId: 1,
      amount: "25000.00",
      remaining: "25000.00",
      status: "ACTIVE",
      receiptId: adjustment.id,
    });
    const employeeAdvanceGl = lines
      .filter((line) => line.role === "EMPLOYEE_ADVANCES")
      .reduce((sum, line) => sum.plus(line.debit).minus(line.credit), money(0));
    expect(employeeAdvanceGl.eq(advance.remaining)).toBe(true);
    expect(await suggestDeductionsForPeriod([RESPONSIBLE_EMPLOYEE_ID])).toEqual({
      [RESPONSIBLE_EMPLOYEE_ID]: { advanceId: Number(advance.id), suggested: "25000.00" },
    });
    expect(await db().select().from(s.cashVarianceCaseEvents)).toHaveLength(2);
  });

  it("derives custody responsibility from the shift contract and blocks the responsible actor", async () => {
    const source = await seedCustodyVariance({ reference: "CH-1-20260831-0006" });
    const maliciousEvidence = await evidence("variance-derived-responsible");
    const malicious = await proposeCashVarianceCase(
      {
        sourceType: "CUSTODY",
        sourceId: source.treasuryReceiptId,
        reasonCode: "CUSTODY_LOSS",
        reason: "عجز عهدة مثبت بمحضر عد مستقل ودليل موقع",
        evidenceReference: "evidence://custody/contract-owner",
        evidenceDocumentId: maliciousEvidence.evidenceDocumentId,
        clientRequestId: "variance-derived-responsible",
      },
      MAKER,
    );
    const stored = (
      await db().select().from(s.cashVarianceCases).where(eq(s.cashVarianceCases.id, malicious.caseId))
    )[0];
    expect(stored).toMatchObject({
      responsibleUserId: RESPONSIBLE_USER_ID,
      responsibleEmployeeId: RESPONSIBLE_EMPLOYEE_ID,
    });
    await expect(
      approveCashVarianceCase(
        { caseId: malicious.caseId, expectedVersion: 1, clientRequestId: "responsible-approve-denied" },
        { userId: RESPONSIBLE_USER_ID, branchId: 1, role: "manager" },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      rejectCashVarianceCase(
        { caseId: malicious.caseId, expectedVersion: 1, clientRequestId: "responsible-reject-denied", reason: "المسؤول لا يحسم قضيته المالية بنفسه" },
        { userId: RESPONSIBLE_USER_ID, branchId: 1, role: "manager" },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const second = await seedCustodyVariance({ reference: "CH-1-20260831-0007" });
    const responsibleActor = { userId: RESPONSIBLE_USER_ID, branchId: 1, role: "manager" as const };
    const responsibleEvidence = await evidence("responsible-propose-denied", responsibleActor);
    await expect(
      proposeCashVarianceCase(
        {
          sourceType: "CUSTODY",
          sourceId: second.treasuryReceiptId,
          reasonCode: "CUSTODY_LOSS",
          reason: "المسؤول لا ينشئ قضية عجز عهدته بنفسه",
          evidenceReference: "evidence://custody/responsible-proposer",
          evidenceDocumentId: responsibleEvidence.evidenceDocumentId,
          clientRequestId: "responsible-propose-denied",
        },
        responsibleActor,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const shiftless = await seedCustodyVariance({
      reference: "CH-1-20260831-0008",
      withoutShift: true,
    });
    const shiftlessCase = await proposal(
      "CUSTODY",
      shiftless.treasuryReceiptId,
      "variance-shiftless-responsible",
    );
    const shiftlessStored = (
      await db().select().from(s.cashVarianceCases).where(eq(s.cashVarianceCases.id, shiftlessCase.caseId))
    )[0];
    expect(shiftlessStored.responsibleUserId).toBe(RESPONSIBLE_USER_ID);
  });

  it("clears custody transit on a surplus and suspends the excess as a liability", async () => {
    const source = await seedCustodyVariance({
      counted: "125000.00",
      reference: "CH-1-20260831-0005",
    });
    const created = await proposal("CUSTODY", source.treasuryReceiptId, "variance-surplus-propose");
    const surplusCase = (
      await db().select().from(s.cashVarianceCases).where(eq(s.cashVarianceCases.id, created.caseId))
    )[0];
    expect(surplusCase).toMatchObject({
      responsibleUserId: null,
      responsibleEmployeeId: null,
      responsibleNameSnapshot: null,
    });
    await approveCashVarianceCase(
      { caseId: created.caseId, expectedVersion: 1, clientRequestId: "variance-surplus-approve" },
      CHECKER,
    );

    const adjustment = (
      await db().select().from(s.receipts).where(eq(s.receipts.referenceNumber, `CV-${created.caseId}`))
    )[0];
    expect(adjustment).toMatchObject({ direction: "IN", amount: "25000.00" });
    const resolutionEntry = (
      await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.dedupeKey, `CASH_VARIANCE:${created.caseId}`))
    )[0];
    expect(resolutionEntry).toMatchObject({
      postingProfile: "CASH_CUSTODY_SURPLUS",
      revenue: "0.00",
      cost: "0.00",
      profit: "0.00",
    });
    const journal = (
      await db().select().from(s.journalEntries).where(eq(s.journalEntries.entryId, resolutionEntry.id))
    )[0];
    const lines = await db().select().from(s.journalLines).where(eq(s.journalLines.journalId, journal.id));
    expect(lines.map((line) => [line.role, line.debit, line.credit]).sort()).toEqual([
      ["CASH_IN_TRANSIT", "0.00", "100000.00"],
      ["OTHER_LIABILITY", "0.00", "25000.00"],
      ["TREASURY_CASH", "125000.00", "0.00"],
    ]);
  });

  it("serializes two checkers in the same lock order and applies one approval only", async () => {
    const source = await seedCustodyVariance({ reference: "CD-1-20260831-0002" });
    const created = await proposal("CUSTODY", source.treasuryReceiptId, "variance-race-propose");
    const results = await Promise.allSettled([
      approveCashVarianceCase(
        { caseId: created.caseId, expectedVersion: 1, clientRequestId: "variance-race-a" },
        CHECKER,
      ),
      approveCashVarianceCase(
        { caseId: created.caseId, expectedVersion: 1, clientRequestId: "variance-race-b" },
        SECOND_CHECKER,
      ),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(["CONFLICT", "PRECONDITION_FAILED"]).toContain(rejected[0].reason?.code);
    expect(String(rejected[0].reason?.message ?? rejected[0].reason)).not.toMatch(
      /deadlock|lock wait|timeout/i,
    );
    expect(
      await db()
        .select()
        .from(s.accountingEntries)
        .where(eq(s.accountingEntries.dedupeKey, `CASH_VARIANCE:${created.caseId}`)),
    ).toHaveLength(1);
    expect(
      await db().select().from(s.cashVarianceCaseEvents).where(eq(s.cashVarianceCaseEvents.caseId, created.caseId)),
    ).toHaveLength(2);
  });

  it("rejects with exact replay, rejects key reuse and stale versions, and serializes approve versus reject", async () => {
    const source = await seedCustodyVariance({ reference: "CH-1-20260831-0010" });
    const created = await proposal("CUSTODY", source.treasuryReceiptId, "variance-reject-propose");
    const rejectInput = {
      caseId: created.caseId,
      expectedVersion: 1,
      clientRequestId: "variance-reject-decision",
      reason: "الدليل المرفق لا يكفي لحسم فرق النقد",
    };

    await expect(rejectCashVarianceCase(rejectInput, CHECKER)).resolves.toMatchObject({
      status: "REJECTED",
      version: 2,
      idempotent: false,
    });
    await expect(rejectCashVarianceCase(rejectInput, CHECKER)).resolves.toMatchObject({
      status: "REJECTED",
      version: 2,
      idempotent: true,
    });
    await expect(
      rejectCashVarianceCase(
        { ...rejectInput, reason: "سبب رفض مختلف يستخدم المفتاح نفسه بصورة غير مسموحة" },
        CHECKER,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      await db()
        .select()
        .from(s.cashVarianceCaseEvents)
        .where(eq(s.cashVarianceCaseEvents.caseId, created.caseId)),
    ).toHaveLength(2);
    expect(
      await db()
        .select()
        .from(s.accountingEntries)
        .where(eq(s.accountingEntries.dedupeKey, `CASH_VARIANCE:${created.caseId}`)),
    ).toHaveLength(0);

    const staleSource = await seedCustodyVariance({ reference: "CH-1-20260831-0011" });
    const stale = await proposal(
      "CUSTODY",
      staleSource.treasuryReceiptId,
      "variance-reject-stale-propose",
    );
    await expect(
      rejectCashVarianceCase(
        {
          caseId: stale.caseId,
          expectedVersion: 0,
          clientRequestId: "variance-reject-stale-decision",
          reason: "قرار مبني على نسخة قديمة من القضية",
        },
        CHECKER,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      await db()
        .select()
        .from(s.cashVarianceCaseEvents)
        .where(eq(s.cashVarianceCaseEvents.caseId, stale.caseId)),
    ).toHaveLength(1);

    const raceSource = await seedCustodyVariance({ reference: "CH-1-20260831-0012" });
    const raced = await proposal(
      "CUSTODY",
      raceSource.treasuryReceiptId,
      "variance-approve-reject-race-propose",
    );
    const racedResults = await Promise.allSettled([
      approveCashVarianceCase(
        {
          caseId: raced.caseId,
          expectedVersion: 1,
          clientRequestId: "variance-approve-reject-race-approve",
        },
        CHECKER,
      ),
      rejectCashVarianceCase(
        {
          caseId: raced.caseId,
          expectedVersion: 1,
          clientRequestId: "variance-approve-reject-race-reject",
          reason: "الأدلة لا تكفي لاعتماد فرق النقد في السباق",
        },
        SECOND_CHECKER,
      ),
    ]);
    const racedFulfilled = racedResults.filter(
      (result): result is PromiseFulfilledResult<unknown> => result.status === "fulfilled",
    );
    const racedRejected = racedResults.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(racedFulfilled).toHaveLength(1);
    expect(racedRejected).toHaveLength(1);
    expect(["CONFLICT", "PRECONDITION_FAILED"]).toContain(racedRejected[0].reason?.code);
    expect(String(racedRejected[0].reason?.message ?? racedRejected[0].reason)).not.toMatch(
      /deadlock|lock wait|timeout/i,
    );

    const raceEvents = await db()
      .select()
      .from(s.cashVarianceCaseEvents)
      .where(eq(s.cashVarianceCaseEvents.caseId, raced.caseId));
    expect(raceEvents).toHaveLength(2);
    const decision = raceEvents.find((event) => Number(event.version) === 2);
    expect(["APPROVED", "REJECTED"]).toContain(decision?.eventType);
    const raceEntries = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.dedupeKey, `CASH_VARIANCE:${raced.caseId}`));
    expect(raceEntries).toHaveLength(decision?.eventType === "APPROVED" ? 1 : 0);
  });

  it("filters by the latest event in SQL before applying the requested limit", async () => {
    const olderSource = await seedCustodyVariance({ reference: "CH-1-20260831-0013" });
    const older = await proposal(
      "CUSTODY",
      olderSource.treasuryReceiptId,
      "variance-list-older-proposed",
    );
    const secondProposedSource = await seedCustodyVariance({ reference: "CH-1-20260831-0015" });
    const secondProposed = await proposal(
      "CUSTODY",
      secondProposedSource.treasuryReceiptId,
      "variance-list-second-proposed",
    );
    const newerSource = await seedCustodyVariance({ reference: "CH-1-20260831-0014" });
    const newer = await proposal(
      "CUSTODY",
      newerSource.treasuryReceiptId,
      "variance-list-newer-rejected",
    );
    await rejectCashVarianceCase(
      {
        caseId: newer.caseId,
        expectedVersion: 1,
        clientRequestId: "variance-list-newer-reject-decision",
        reason: "رفض أحدث قضية لإثبات أن الحد يطبق بعد الحالة",
      },
      CHECKER,
    );

    const firstPage = await listCashVarianceCases(
      { branchId: 1, status: "PROPOSED", limit: 1 },
      CHECKER,
    );
    expect(firstPage).toMatchObject({ total: 2, hasMore: true });
    expect(firstPage.rows).toEqual([
      expect.objectContaining({ id: older.caseId, status: "PROPOSED", version: 1 }),
    ]);
    expect(firstPage.nextCursor).not.toBeNull();
    await expect(
      listCashVarianceCases(
        {
          branchId: 1,
          status: "PROPOSED",
          limit: 1,
          cursor: firstPage.nextCursor,
        },
        CHECKER,
      ),
    ).resolves.toMatchObject({
      rows: [expect.objectContaining({ id: secondProposed.caseId, status: "PROPOSED" })],
      total: 2,
      hasMore: false,
      nextCursor: null,
    });
    await expect(
      listCashVarianceCases({ branchId: 1, status: "REJECTED", limit: 1 }, CHECKER),
    ).resolves.toMatchObject({
      rows: [expect.objectContaining({ id: newer.caseId, status: "REJECTED", version: 2 })],
      total: 1,
    });
  });

  it("rolls back receipt, event and case resolution when financial posting is blocked", async () => {
    const source = await seedCustodyVariance({ reference: "CH-1-20260831-0003" });
    const created = await proposal("CUSTODY", source.treasuryReceiptId, "variance-rollback-propose");
    await db().insert(s.financialPeriods).values({
      cutoffDate: toDateStr(),
      status: "LOCKED",
      lockedBy: CHECKER.userId,
    });

    await expect(
      approveCashVarianceCase(
        { caseId: created.caseId, expectedVersion: 1, clientRequestId: "variance-rollback-approve" },
        CHECKER,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const receipt = (
      await db().select().from(s.receipts).where(eq(s.receipts.id, source.treasuryReceiptId))
    )[0];
    expect(receipt.status).toBe("PENDING");
    expect(
      await db().select().from(s.receipts).where(eq(s.receipts.referenceNumber, `CV-${created.caseId}`)),
    ).toHaveLength(0);
    expect(
      await db().select().from(s.cashVarianceCaseEvents).where(eq(s.cashVarianceCaseEvents.caseId, created.caseId)),
    ).toHaveLength(1);
    expect(await db().select().from(s.employeeAdvances)).toHaveLength(0);
  });

  it("يرد الاقتراح كاملاً عندما يفشل تدقيقه داخل المعاملة", async () => {
    const source = await seedCustodyVariance({ reference: "CH-1-20260831-0024" });
    const registered = await evidence("audit-failure-proposal");
    await installAuditFailure("treasury.cash_variance.propose");
    try {
      await expect(proposeCashVarianceCase({
        sourceType: "CUSTODY",
        sourceId: source.treasuryReceiptId,
        reasonCode: "CUSTODY_LOSS",
        reason: "فشل التدقيق يجب أن يرد الاقتراح كله",
        evidenceReference: "audit-failure-proposal-proof",
        evidenceDocumentId: registered.evidenceDocumentId,
        clientRequestId: "audit-failure-proposal",
      }, MAKER)).rejects.toBeDefined();
    } finally {
      await removeAuditFailure();
    }
    expect(await db().select().from(s.cashVarianceCases)).toHaveLength(0);
    expect(await db().select().from(s.cashVarianceCaseEvents)).toHaveLength(0);
    expect(
      await db().select().from(s.auditLogs)
        .where(eq(s.auditLogs.action, "treasury.cash_variance.propose")),
    ).toHaveLength(0);
  });

  it("يرد السند والقيد والذمة والحدث عندما يفشل تدقيق الاعتماد ويرد حدث الرفض عند فشل تدقيقه", async () => {
    const source = await seedCustodyVariance({ reference: "CH-1-20260831-0025" });
    const created = await proposal("CUSTODY", source.treasuryReceiptId, "audit-failure-approve-proposal");
    await installAuditFailure("treasury.cash_variance.approve");
    try {
      await expect(approveCashVarianceCase({
        caseId: created.caseId,
        expectedVersion: 1,
        clientRequestId: "audit-failure-approve",
      }, CHECKER)).rejects.toBeDefined();
    } finally {
      await removeAuditFailure();
    }
    expect(
      await db().select().from(s.cashVarianceCaseEvents)
        .where(eq(s.cashVarianceCaseEvents.caseId, created.caseId)),
    ).toHaveLength(1);
    expect(
      await db().select().from(s.receipts)
        .where(eq(s.receipts.referenceNumber, `CV-${created.caseId}`)),
    ).toHaveLength(0);
    expect(
      await db().select().from(s.accountingEntries)
        .where(eq(s.accountingEntries.dedupeKey, `CASH_VARIANCE:${created.caseId}`)),
    ).toHaveLength(0);
    expect(await db().select().from(s.employeeAdvances)).toHaveLength(0);
    const custodyReceipt = (
      await db().select().from(s.receipts)
        .where(eq(s.receipts.id, source.treasuryReceiptId)).limit(1)
    )[0];
    expect(custodyReceipt.status).toBe("PENDING");

    await installAuditFailure("treasury.cash_variance.reject");
    try {
      await expect(rejectCashVarianceCase({
        caseId: created.caseId,
        expectedVersion: 1,
        clientRequestId: "audit-failure-reject",
        reason: "فشل التدقيق يجب أن يرد حدث الرفض",
      }, CHECKER)).rejects.toBeDefined();
    } finally {
      await removeAuditFailure();
    }
    expect(
      await db().select().from(s.cashVarianceCaseEvents)
        .where(eq(s.cashVarianceCaseEvents.caseId, created.caseId)),
    ).toHaveLength(1);
  });

  it("rejects proposing or approving a variance after the branch cash day is closed", async () => {
    const source = await seedCustodyVariance({ reference: "CH-1-20260831-0004" });
    const created = await proposal("CUSTODY", source.treasuryReceiptId, "variance-close-gate-propose");
    await db().insert(s.cashDailyReconciliations).values({
      branchId: 1,
      businessDate: toDateStr(),
      expectedTreasuryCash: "0.00",
      countedTreasuryCash: "0.00",
      variance: "0.00",
      status: "CLOSED",
      lastClientRequestId: "closed-day-count",
      closeClientRequestId: "closed-day-close",
      evidenceHash: "c".repeat(64),
      countedByUserId: COUNTER.userId,
      closedByUserId: CHECKER.userId,
      closedAt: new Date(),
    });

    await expect(
      approveCashVarianceCase(
        { caseId: created.caseId, expectedVersion: 1, clientRequestId: "variance-after-close-approve" },
        CHECKER,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(
      proposal("CUSTODY", source.treasuryReceiptId, "variance-after-close-propose"),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(
      await db().select().from(s.cashVarianceCaseEvents).where(eq(s.cashVarianceCaseEvents.caseId, created.caseId)),
    ).toHaveLength(1);
    expect(
      await db().select().from(s.receipts).where(eq(s.receipts.referenceNumber, `CV-${created.caseId}`)),
    ).toHaveLength(0);
    const pendingReceipt = (
      await db().select().from(s.receipts).where(eq(s.receipts.id, source.treasuryReceiptId))
    )[0];
    expect(pendingReceipt.status).toBe("PENDING");
  });

  it("posts a daily shortage without rewriting the historical count as matched", async () => {
    await db().insert(s.receipts).values({
      branchId: 1,
      direction: "IN",
      amount: "100000.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      referenceNumber: "DAILY-OPENING",
      createdBy: MAKER.userId,
    });
    const dailyEvidence = await db().transaction((tx) =>
      buildDailyCashEvidenceTx(tx, 1, toDateStr()),
    );
    const reconciliationInsert = await db().insert(s.cashDailyReconciliations).values({
      branchId: 1,
      businessDate: toDateStr(),
      expectedTreasuryCash: "100000.00",
      countedTreasuryCash: "75000.00",
      variance: "-25000.00",
      countedBreakdown: { "50000": 1, "25000": 1 },
      status: "VARIANCE_OPEN",
      lastClientRequestId: "daily-count-variance",
      evidenceHash: dailyEvidence.evidenceHash,
      countedByUserId: COUNTER.userId,
    });
    const reconciliationId = extractInsertId(reconciliationInsert);
    const innocentAdvanceInsert = await db().insert(s.employeeAdvances).values({
      employeeId: 502,
      branchId: 1,
      amount: "333.00",
      remaining: "333.00",
      monthlyDeduction: "50.00",
      status: "ACTIVE",
      note: "ذمة بريئة سابقة لا تخص فرق الخزينة اليومي",
      createdBy: MAKER.userId,
    });
    const innocentAdvanceId = extractInsertId(innocentAdvanceInsert);
    const created = await proposal("DAILY_TREASURY", reconciliationId, "variance-daily-propose");
    await approveCashVarianceCase(
      { caseId: created.caseId, expectedVersion: 1, clientRequestId: "variance-daily-approve" },
      CHECKER,
    );

    const reconciliation = (
      await db().select().from(s.cashDailyReconciliations).where(eq(s.cashDailyReconciliations.id, reconciliationId))
    )[0];
    expect(reconciliation).toMatchObject({
      expectedTreasuryCash: "100000.00",
      countedTreasuryCash: "75000.00",
      variance: "-25000.00",
      status: "RESOLVED_WITH_ADJUSTMENT",
      version: 2,
    });
    const dailyAdjustment = (
      await db().select().from(s.receipts).where(eq(s.receipts.referenceNumber, `CV-${created.caseId}`))
    )[0];
    expect(dailyAdjustment).toMatchObject({ direction: "OUT", amount: "25000.00" });
    const entry = (
      await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.dedupeKey, `CASH_VARIANCE:${created.caseId}`))
    )[0];
    expect(entry.postingProfile).toBe("CASH_DAILY_SHORTAGE");
    const dailyCase = (
      await db().select().from(s.cashVarianceCases).where(eq(s.cashVarianceCases.id, created.caseId))
    )[0];
    expect(dailyCase).toMatchObject({
      responsibleUserId: null,
      responsibleEmployeeId: null,
      responsibleNameSnapshot: null,
    });
    const dailyApprovedEvent = (
      await db()
        .select()
        .from(s.cashVarianceCaseEvents)
        .where(
          and(
            eq(s.cashVarianceCaseEvents.caseId, created.caseId),
            eq(s.cashVarianceCaseEvents.eventType, "APPROVED"),
          ),
        )
    )[0];
    expect(dailyApprovedEvent).toMatchObject({
      counterAccountRole: "LOSSES",
      advanceId: null,
    });
    const advancesAfterDaily = await db().select().from(s.employeeAdvances);
    expect(advancesAfterDaily).toHaveLength(1);
    expect(advancesAfterDaily[0]).toMatchObject({
      id: innocentAdvanceId,
      employeeId: 502,
      remaining: "333.00",
    });
    const dailyJournal = (
      await db().select().from(s.journalEntries).where(eq(s.journalEntries.entryId, entry.id))
    )[0];
    const dailyLines = await db().select().from(s.journalLines).where(eq(s.journalLines.journalId, dailyJournal.id));
    expect(dailyLines.map((line) => [line.role, line.debit, line.credit]).sort()).toEqual([
      ["LOSSES", "25000.00", "0.00"],
      ["TREASURY_CASH", "0.00", "25000.00"],
    ]);

    const netTreasury = (
      await db()
        .select({
          amount: sql<string>`COALESCE(SUM(CASE WHEN ${s.receipts.direction} = 'IN' THEN ${s.receipts.amount} ELSE -${s.receipts.amount} END), 0)`,
        })
        .from(s.receipts)
        .where(
          and(
            eq(s.receipts.branchId, 1),
            eq(s.receipts.cashBucket, "TREASURY"),
            eq(s.receipts.status, "COMPLETED"),
          ),
        )
    )[0];
    expect(money(netTreasury.amount).toFixed(2)).toBe("75000.00");
  });

  it("approves an August variance in September, closes August honestly and makes September stale", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-31T12:00:00.000Z"));
      await db().delete(s.receipts);
      await db().insert(s.receipts).values({
        branchId: 1,
        direction: "IN",
        amount: "100000.00",
        paymentMethod: "CASH",
        cashBucket: "TREASURY",
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        referenceNumber: "AUGUST-OPENING",
        createdBy: MAKER.userId,
        createdAt: new Date("2026-08-31T08:00:00.000Z"),
        approvedAt: new Date("2026-08-31T08:00:00.000Z"),
      });
      const augustEvidence = await db().transaction((tx) => buildDailyCashEvidenceTx(tx, 1, "2026-08-31"));
      const augustInsert = await db().insert(s.cashDailyReconciliations).values({
        branchId: 1,
        businessDate: "2026-08-31",
        expectedTreasuryCash: "100000.00",
        countedTreasuryCash: "75000.00",
        variance: "-25000.00",
        countedBreakdown: { "50000": 1, "25000": 1 },
        status: "VARIANCE_OPEN",
        lastClientRequestId: "august-variance-count",
        evidenceHash: augustEvidence.evidenceHash,
        countedByUserId: COUNTER.userId,
      });
      const augustId = extractInsertId(augustInsert);
      const created = await proposal("DAILY_TREASURY", augustId, "august-variance-propose");

      vi.setSystemTime(new Date("2026-09-01T10:00:00.000Z"));
      const septemberEvidence = await db().transaction((tx) => buildDailyCashEvidenceTx(tx, 1, "2026-09-01"));
      const septemberInsert = await db().insert(s.cashDailyReconciliations).values({
        branchId: 1,
        businessDate: "2026-09-01",
        expectedTreasuryCash: "100000.00",
        countedTreasuryCash: "100000.00",
        variance: "0.00",
        countedBreakdown: { "50000": 2 },
        status: "MATCHED",
        lastClientRequestId: "september-count-before-adjustment",
        evidenceHash: septemberEvidence.evidenceHash,
        countedByUserId: MAKER.userId,
      });
      const septemberId = extractInsertId(septemberInsert);

      await approveCashVarianceCase(
        { caseId: created.caseId, expectedVersion: 1, clientRequestId: "august-approved-in-september" },
        CHECKER,
      );
      const august = (
        await db().select().from(s.cashDailyReconciliations).where(eq(s.cashDailyReconciliations.id, augustId))
      )[0];
      expect(august).toMatchObject({
        expectedTreasuryCash: "100000.00",
        countedTreasuryCash: "75000.00",
        variance: "-25000.00",
        evidenceHash: augustEvidence.evidenceHash,
        status: "RESOLVED_WITH_ADJUSTMENT",
        version: 2,
      });
      const adjustment = (
        await db().select().from(s.receipts).where(eq(s.receipts.referenceNumber, `CV-${created.caseId}`))
      )[0];
      expect(adjustment.approvedAt?.toISOString().slice(0, 10)).toBe("2026-09-01");

      const augustClosed = await closeDailyCashReconciliation(
        { reconciliationId: augustId, expectedVersion: 2, clientRequestId: "august-close-after-resolution" },
        SECOND_CHECKER,
        { user: { id: SECOND_CHECKER.userId, branchId: 1, role: "admin", name: "مراجع" }, req: { headers: {} } } as never,
      );
      expect(augustClosed.status).toBe("CLOSED");

      const september = await getDailyCashReconciliation(
        { branchId: 1, businessDate: "2026-09-01" },
        CHECKER,
      );
      expect(september.blockers.map((item) => item.code)).toContain("STALE_EVIDENCE");
      await expect(
        closeDailyCashReconciliation(
          { reconciliationId: septemberId, expectedVersion: 1, clientRequestId: "september-close-stale" },
          CHECKER,
          { user: { id: CHECKER.userId, branchId: 1, role: "manager", name: "مراجع" }, req: { headers: {} } } as never,
        ),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    } finally {
      vi.useRealTimers();
    }
  });
});
