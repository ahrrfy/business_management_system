import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  createPostingIntent,
  creditLine,
  debitLine,
  POSTING_POLICY_HASH,
  type PostingSourceComponents,
} from "../accounting/postingEngine";
import { postEntry } from "../ledgerService";
import { money } from "../money";
import { getActiveLock, unlockLatestPeriod } from "../periodLockService";
import { requestMonthClose } from "../reports/monthCloseRequest";
import { verifyMonthCloseCertificate } from "../reports/monthCloseCertificate";
import { withTx } from "../tx";
import { closeYear } from "../yearEndService";
import { approveYearEndReopen, requestYearEndReopen } from "../yearEndService";
import { truncateTables } from "./__testUtils__";

const YEAR = 2025;
const CYCLE_ID = "year-close-cycle-2025";
const ADMIN = 1;
const MANAGER = 2;

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set");
  return value;
}

async function reset() {
  await truncateTables([
    "yearEndReopenRequests",
    "monthCloseCertificateEvidence",
    "monthCloseEvents",
    "monthCloseCertificates",
    "monthCloseSequence",
    "yearEndSnapshots",
    "monthCloseRequests",
    "financialPeriods",
    "journalLines",
    "journalEntries",
    "accountingEntries",
    "doubleEntrySettings",
    "accounts",
    "receipts",
    "shifts",
    "branches",
    "users",
  ]);

  await db()
    .insert(s.users)
    .values([
      {
        id: ADMIN,
        openId: "year-close-admin",
        name: "المالك",
        role: "admin",
        loginMethod: "local",
      },
      {
        id: MANAGER,
        openId: "year-close-manager",
        name: "المدير",
        role: "manager",
        loginMethod: "local",
      },
    ]);
  await db()
    .insert(s.branches)
    .values([
      { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
      { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
    ]);
  await db()
    .insert(s.accounts)
    .values([
      {
        code: "3100",
        name: "الأرباح المحتجزة",
        type: "EQUITY",
        systemRole: "RETAINED_EARNINGS",
      },
      {
        code: "4100",
        name: "إيراد المبيعات",
        type: "REVENUE",
        systemRole: "SALES_STATIONERY",
      },
      {
        code: "5100",
        name: "تكلفة المبيعات",
        type: "EXPENSE",
        systemRole: "COGS",
      },
      {
        code: "6110",
        name: "الإيجار",
        type: "EXPENSE",
        systemRole: "RENT",
      },
    ]);
  const openingHash = "a".repeat(64);
  await db()
    .insert(s.doubleEntrySettings)
    .values({
      id: 1,
      mode: "ACTIVE",
      shadowStartedAt: new Date("2024-12-31T00:00:00.000Z"),
      shadowCycleId: CYCLE_ID,
      shadowOpeningHash: openingHash,
      policyApprovalReference: "YEAR-END-TEST-APPROVAL",
      policyApprovalPolicyHash: POSTING_POLICY_HASH,
      policyApprovalCycleId: CYCLE_ID,
      policyApprovalOpeningHash: openingHash,
      policyAccountantName: "محاسب الاختبار",
      policyApprovedAt: new Date("2024-12-31T00:00:00.000Z"),
      policyApprovedBy: ADMIN,
      updatedBy: ADMIN,
    });
  await db()
    .insert(s.monthCloseSequence)
    .values({
      id: 1,
      status: "READY",
      sequenceStartMonth: `${YEAR}-12`,
      activeThroughMonth: null,
      nextRequiredMonth: `${YEAR}-12`,
      version: 1,
      bootstrappedAt: new Date(`${YEAR}-01-01T00:00:00.000Z`),
      bootstrappedBy: ADMIN,
      bootstrapReason: "Explicit test sequence baseline",
      bootstrapReference: "YEAR-END-TEST-BASELINE",
    });
  await seedProfitAndLoss();
}

async function seedProfitAndLoss() {
  const saleComponents: PostingSourceComponents = {
    roleDebits: { AR: "1000.00", COGS: "600.00" },
    roleCredits: {
      SALES_STATIONERY: "1000.00",
      INVENTORY: "600.00",
    },
  };
  const saleLines = [
    debitLine("AR", "1000.00"),
    debitLine("COGS", "600.00"),
    creditLine("SALES_STATIONERY", "1000.00"),
    creditLine("INVENTORY", "600.00"),
  ];
  await withTx((tx) =>
    postEntry(tx, {
      entryType: "SALE",
      dedupeKey: "YEAR-TEST:SALE",
      branchId: 1,
      revenue: money(1000),
      cost: money(600),
      profit: money(400),
      amount: money(1000),
      postingIntent: createPostingIntent(
        "SALE_INVENTORY",
        "SALE",
        saleLines,
        saleComponents,
      ),
      postingSourceComponents: saleComponents,
      entryDate: new Date(`${YEAR}-06-15T00:00:00.000Z`),
    }),
  );

  const rentComponents: PostingSourceComponents = {
    roleDebits: { RENT: "100.00" },
    roleCredits: { CASH: "100.00" },
  };
  const rentLines = [debitLine("RENT", "100.00"), creditLine("CASH", "100.00")];
  await withTx((tx) =>
    postEntry(tx, {
      entryType: "PAYMENT_OUT",
      dedupeKey: "YEAR-TEST:RENT",
      branchId: 1,
      cost: money(100),
      profit: money(-100),
      amount: money(100),
      postingIntent: createPostingIntent(
        "PAYMENT_OUT_EXPENSE",
        "PAYMENT_OUT",
        rentLines,
        rentComponents,
      ),
      postingSourceComponents: rentComponents,
      entryDate: new Date(`${YEAR}-06-15T00:00:00.000Z`),
    }),
  );
}

async function seedExactProfitAndLossReversals() {
  const returnComponents: PostingSourceComponents = {
    roleDebits: {
      SALES_STATIONERY: "1000.00",
      INVENTORY: "600.00",
    },
    roleCredits: { AR: "1000.00", COGS: "600.00" },
  };
  const returnLines = [
    debitLine("SALES_STATIONERY", "1000.00"),
    debitLine("INVENTORY", "600.00"),
    creditLine("AR", "1000.00"),
    creditLine("COGS", "600.00"),
  ];
  await withTx((tx) =>
    postEntry(tx, {
      entryType: "RETURN",
      dedupeKey: "YEAR-TEST:RETURN",
      branchId: 1,
      revenue: money(-1000),
      cost: money(-600),
      profit: money(-400),
      amount: money(-1000),
      postingIntent: createPostingIntent(
        "RETURN_SALE_INVENTORY",
        "RETURN",
        returnLines,
        returnComponents,
      ),
      postingSourceComponents: returnComponents,
      entryDate: new Date(`${YEAR}-06-16T00:00:00.000Z`),
    }),
  );

  const rentReversalComponents: PostingSourceComponents = {
    roleDebits: { CASH: "100.00" },
    roleCredits: { RENT: "100.00" },
  };
  const rentReversalLines = [
    debitLine("CASH", "100.00"),
    creditLine("RENT", "100.00"),
  ];
  await withTx((tx) =>
    postEntry(tx, {
      entryType: "PAYMENT_IN",
      dedupeKey: "YEAR-TEST:RENT-REVERSAL",
      branchId: 1,
      amount: money(100),
      postingIntent: createPostingIntent(
        "PAYMENT_IN_OTHER",
        "PAYMENT_IN",
        rentReversalLines,
        rentReversalComponents,
      ),
      postingSourceComponents: rentReversalComponents,
      entryDate: new Date(`${YEAR}-06-16T00:00:00.000Z`),
    }),
  );
}

async function pendingRequest(requestedBy = MANAGER) {
  return withTx((tx) =>
    requestMonthClose(tx, { month: `${YEAR}-12`, requestedBy }),
  );
}

async function expectNoClosingEffects() {
  const entries = await db()
    .select()
    .from(s.accountingEntries)
    .where(eq(s.accountingEntries.dedupeKey, `YEAR_CLOSE:${YEAR}:0`));
  const journals = await db()
    .select()
    .from(s.journalEntries)
    .where(eq(s.journalEntries.postingProfile, "ADJUST_YEAR_CLOSE"));
  expect(entries).toHaveLength(0);
  expect(journals).toHaveLength(0);
  expect(await db().select().from(s.financialPeriods)).toHaveLength(0);
  expect(await db().select().from(s.yearEndSnapshots)).toHaveLength(0);
  expect(await db().select().from(s.monthCloseCertificates)).toHaveLength(0);
  const [sequence] = await db().select().from(s.monthCloseSequence);
  expect(sequence).toMatchObject({
    activeThroughMonth: null,
    nextRequiredMonth: `${YEAR}-12`,
    activeCertificateId: null,
    version: 1,
  });
}

beforeEach(reset);

describe("الإقفال السنوي الرسمي من اليومية المزدوجة", () => {
  it("يرفض الإقفال بلا طلب ديسمبر معلّق ولا ينشئ قيداً أو قفلاً", async () => {
    await expect(
      withTx((tx) =>
        closeYear(tx, {
          year: YEAR,
          requestId: 999,
          branchId: null,
          closedBy: ADMIN,
        }),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expectNoClosingEffects();
  });

  it("يرفض إقفال فرع منفرد لأن قفل الفترة شركي عام", async () => {
    const { id } = await pendingRequest();
    await expect(
      withTx((tx) =>
        closeYear(tx, {
          year: YEAR,
          requestId: id,
          branchId: 1,
          closedBy: ADMIN,
        }),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expectNoClosingEffects();
  });

  it("يفرض فصل المهام: طالب الإقفال لا يعتمد طلبه", async () => {
    const { id } = await pendingRequest();
    await expect(
      withTx((tx) =>
        closeYear(tx, {
          year: YEAR,
          requestId: id,
          closedBy: MANAGER,
        }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const [request] = await db()
      .select()
      .from(s.monthCloseRequests)
      .where(eq(s.monthCloseRequests.id, id));
    expect(request.status).toBe("PENDING_APPROVAL");
    await expectNoClosingEffects();
  });

  it("يعيد فحص الجاهزية حيّاً ويرجع كل الآثار عند ظهور وردية بعد الطلب", async () => {
    const { id } = await pendingRequest();
    await db()
      .insert(s.shifts)
      .values({
        userId: MANAGER,
        branchId: 2,
        status: "OPEN",
        openedAt: new Date(`${YEAR}-12-20T09:00:00.000Z`),
        openGuard: `${MANAGER}:2:year-close`,
        openingBalance: "0.00",
      });

    await expect(
      withTx((tx) =>
        closeYear(tx, { year: YEAR, requestId: id, closedBy: ADMIN }),
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    const [request] = await db()
      .select()
      .from(s.monthCloseRequests)
      .where(eq(s.monthCloseRequests.id, id));
    expect(request.status).toBe("PENDING_APPROVAL");
    expect(request.pendingGuard).toBe(`${YEAR}-12`);
    await expectNoClosingEffects();
  });

  it("يرفض وضعاً غير ACTIVE أو دورة بدأت بعد منتصف ليل 1/1 في بغداد بلا تخمين", async () => {
    const { id } = await pendingRequest();
    await db()
      .update(s.doubleEntrySettings)
      .set({ mode: "OFF" })
      .where(eq(s.doubleEntrySettings.id, 1));
    await expect(
      withTx((tx) =>
        closeYear(tx, { year: YEAR, requestId: id, closedBy: ADMIN }),
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expectNoClosingEffects();

    await db()
      .update(s.doubleEntrySettings)
      .set({
        mode: "ACTIVE",
        // نفس YYYY-MM-DD، لكنه 03:00 بغداد؛ المقارنة اليومية القديمة كانت تمرره خطأً.
        shadowStartedAt: new Date(`${YEAR}-01-01T00:00:00.000Z`),
      })
      .where(eq(s.doubleEntrySettings.id, 1));
    await expect(
      withTx((tx) =>
        closeYear(tx, { year: YEAR, requestId: id, closedBy: ADMIN }),
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expectNoClosingEffects();
  });

  it("يرفض الإقفال إذا فشلت مطابقة evidence أو توازن يومية داخل السنة", async () => {
    const { id } = await pendingRequest();
    const [saleJournal] = await db()
      .select({ id: s.journalEntries.id })
      .from(s.journalEntries)
      .where(eq(s.journalEntries.postingProfile, "SALE_INVENTORY"))
      .limit(1);
    await db()
      .update(s.journalLines)
      .set({ debit: "1000.01" })
      .where(
        and(
          eq(s.journalLines.journalId, saleJournal.id),
          eq(s.journalLines.role, "AR"),
        ),
      );

    await expect(
      withTx((tx) =>
        closeYear(tx, { year: YEAR, requestId: id, closedBy: ADMIN }),
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expectNoClosingEffects();
  });

  it("يفشل مغلقاً عند فساد اعتماد ACTIVE حتى إذا تصفّرت كل أرصدة P&L", async () => {
    await seedExactProfitAndLossReversals();
    const { id } = await pendingRequest();
    await db()
      .update(s.doubleEntrySettings)
      .set({ policyApprovalPolicyHash: "0".repeat(64) })
      .where(eq(s.doubleEntrySettings.id, 1));

    await expect(
      withTx((tx) =>
        closeYear(tx, { year: YEAR, requestId: id, closedBy: ADMIN }),
      ),
    ).rejects.toThrow(/ACTIVE/);

    const [request] = await db()
      .select()
      .from(s.monthCloseRequests)
      .where(eq(s.monthCloseRequests.id, id));
    expect(request.status).toBe("PENDING_APPROVAL");
    await expectNoClosingEffects();
  });

  it("checker يصفّر حسابات P&L ويعتمد الطلب ويقفل 31/12 ذرّياً", async () => {
    const { id } = await pendingRequest();
    const result = await withTx((tx) =>
      closeYear(tx, { year: YEAR, requestId: id, closedBy: ADMIN }),
    );

    expect(result).toMatchObject({
      year: YEAR,
      branchId: null,
      totalRevenue: "1000.00",
      totalCogs: "600.00",
      totalExpenses: "100.00",
      netProfit: "300.00",
    });
    expect(result.certificateId).toBeGreaterThan(0);
    expect(result.certificateNumber).toBe("MC-2025-12-R01");
    const [request] = await db()
      .select()
      .from(s.monthCloseRequests)
      .where(eq(s.monthCloseRequests.id, id));
    expect(request.status).toBe("APPROVED");
    expect(Number(request.decidedBy)).toBe(ADMIN);
    expect(Number(request.lockedPeriodId)).toBe(result.periodLockId);
    expect(request.pendingGuard).toBeNull();

    const [entry] = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.dedupeKey, `YEAR_CLOSE:${YEAR}:0`));
    expect(entry.amount).toBe("0.00");
    expect(entry.revenue).toBe("0.00");
    expect(entry.profit).toBe("0.00");
    expect((entry.postingIntentJson as any).sourceComponents).toMatchObject({
      roleDebits: { SALES_STATIONERY: "1000.00" },
      roleCredits: {
        COGS: "600.00",
        RENT: "100.00",
        RETAINED_EARNINGS: "300.00",
      },
    });
    expect(new Date(entry.entryDate).toISOString().slice(0, 10)).toBe(
      `${YEAR}-12-31`,
    );

    const [journal] = await db()
      .select()
      .from(s.journalEntries)
      .where(eq(s.journalEntries.postingProfile, "ADJUST_YEAR_CLOSE"));
    expect(journal.status).toBe("POSTED");
    const lines = await db()
      .select()
      .from(s.journalLines)
      .where(eq(s.journalLines.journalId, journal.id));
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "SALES_STATIONERY",
          debit: "1000.00",
          credit: "0.00",
        }),
        expect.objectContaining({
          role: "COGS",
          debit: "0.00",
          credit: "600.00",
        }),
        expect.objectContaining({
          role: "RENT",
          debit: "0.00",
          credit: "100.00",
        }),
        expect.objectContaining({
          role: "RETAINED_EARNINGS",
          debit: "0.00",
          credit: "300.00",
        }),
      ]),
    );

    await withTx(async (tx) => {
      const lock = await getActiveLock(tx);
      expect(lock?.cutoffDate).toBe(`${YEAR}-12-31`);
      const verification = await verifyMonthCloseCertificate(
        tx,
        result.certificateId,
      );
      expect(verification).toMatchObject({
        integrity: "VERIFIED",
        lifecycle: "ACTIVE",
      });
    });
    const [sequence] = await db().select().from(s.monthCloseSequence);
    expect(sequence).toMatchObject({
      activeThroughMonth: `${YEAR}-12`,
      nextRequiredMonth: `${YEAR + 1}-01`,
      activePeriodId: result.periodLockId,
      activeCertificateId: result.certificateId,
      version: 2,
    });
    await expect(
      withTx((tx) =>
        unlockLatestPeriod(tx, {
          expectedPeriodId: result.periodLockId,
          actorId: ADMIN,
          reason: "Year-end must use an explicit reversal workflow",
        }),
      ),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      cause: expect.objectContaining({
        message: "YEAR_END_REOPEN_REQUIRES_REVERSAL",
      }),
    });
  });

  it("يقفل سنة بلا نشاط بعلامة صفرية ثم يفتحها ويعيد إقفالها كمراجعة R2", async () => {
    await db().delete(s.journalLines);
    await db().delete(s.journalEntries);
    await db().delete(s.accountingEntries);

    const firstRequest = await pendingRequest();
    const firstClose = await withTx(
      (tx) =>
        closeYear(tx, {
          year: YEAR,
          requestId: firstRequest.id,
          closedBy: ADMIN,
        }),
      { gate: "GOVERNANCE" },
    );
    expect(firstClose).toMatchObject({
      totalRevenue: "0.00",
      totalCogs: "0.00",
      totalExpenses: "0.00",
      netProfit: "0.00",
    });
    const [firstEntry] = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.id, firstClose.retainedEarningsEntryId));
    const [firstJournal] = await db()
      .select()
      .from(s.journalEntries)
      .where(eq(s.journalEntries.entryId, firstClose.retainedEarningsEntryId));
    expect(firstEntry.postingProfile).toBe("ADJUST_YEAR_CLOSE_ZERO");
    expect(firstJournal).toMatchObject({
      status: "MEMO",
      postingProfile: "ADJUST_YEAR_CLOSE_ZERO",
    });
    expect(
      await db()
        .select()
        .from(s.journalLines)
        .where(eq(s.journalLines.journalId, firstJournal.id)),
    ).toHaveLength(0);

    const reopenRequest = await withTx(
      (tx) =>
        requestYearEndReopen(tx, {
          snapshotId: firstClose.snapshotId,
          requestedBy: MANAGER,
          reason: "إعادة فتح سنة بلا نشاط لاختبار دورة المراجعة",
          clientRequestId: "zero-year-reopen-r1",
        }),
      { gate: "GOVERNANCE" },
    );
    const opened = await withTx(
      (tx) =>
        approveYearEndReopen(tx, {
          requestId: Number(reopenRequest.id),
          decidedBy: ADMIN,
          decisionReason: "اعتماد اختبار الإقفال الصفري",
        }),
      { gate: "GOVERNANCE" },
    );
    const [reversalEntry] = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.id, opened.reversalEntryId));
    const [reversalJournal] = await db()
      .select()
      .from(s.journalEntries)
      .where(eq(s.journalEntries.entryId, opened.reversalEntryId));
    expect(reversalEntry.postingProfile).toBe("ADJUST_YEAR_CLOSE_ZERO");
    expect(reversalJournal).toMatchObject({
      status: "MEMO",
      postingProfile: "ADJUST_YEAR_CLOSE_ZERO",
    });

    const secondRequest = await pendingRequest();
    const secondClose = await withTx(
      (tx) =>
        closeYear(tx, {
          year: YEAR,
          requestId: secondRequest.id,
          closedBy: ADMIN,
        }),
      { gate: "GOVERNANCE" },
    );
    expect(secondClose.certificateNumber).toBe("MC-2025-12-R02");
    const [secondEntry] = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.id, secondClose.retainedEarningsEntryId));
    expect(secondEntry).toMatchObject({
      dedupeKey: `YEAR_CLOSE:${YEAR}:R2`,
      postingProfile: "ADJUST_YEAR_CLOSE_ZERO",
    });
    const verification = await withTx((tx) =>
      verifyMonthCloseCertificate(tx, secondClose.certificateId),
    );
    expect(verification).toMatchObject({
      integrity: "VERIFIED",
      lifecycle: "ACTIVE",
    });
  });

  it("يوثق السنة ذات النشاط المعكوس بالكامل بعلامة صفرية لا بقيد مخزون وهمي", async () => {
    await seedExactProfitAndLossReversals();
    const request = await pendingRequest();
    const result = await withTx(
      (tx) =>
        closeYear(tx, {
          year: YEAR,
          requestId: request.id,
          closedBy: ADMIN,
        }),
      { gate: "GOVERNANCE" },
    );
    const [entry] = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.id, result.retainedEarningsEntryId));
    const [journal] = await db()
      .select()
      .from(s.journalEntries)
      .where(eq(s.journalEntries.entryId, result.retainedEarningsEntryId));
    expect(entry.postingProfile).toBe("ADJUST_YEAR_CLOSE_ZERO");
    expect(journal.status).toBe("MEMO");
    expect(
      await db()
        .select()
        .from(s.journalLines)
        .where(eq(s.journalLines.journalId, journal.id)),
    ).toHaveLength(0);
  });

  it("يفتح R1 بموافقة مستقلة وعكس مطابق ثم يعيد إقفال ديسمبر كشهادة R2 بلا طمس التاريخ", async () => {
    const firstRequest = await pendingRequest();
    const firstClose = await withTx((tx) =>
      closeYear(tx, {
        year: YEAR,
        requestId: firstRequest.id,
        closedBy: ADMIN,
      }),
    );
    const [originalJournal] = await db()
      .select()
      .from(s.journalEntries)
      .where(eq(s.journalEntries.entryId, firstClose.retainedEarningsEntryId!));
    const originalLines = await db()
      .select()
      .from(s.journalLines)
      .where(eq(s.journalLines.journalId, originalJournal.id));

    const reopenRequest = await withTx((tx) =>
      requestYearEndReopen(tx, {
        snapshotId: firstClose.snapshotId,
        requestedBy: MANAGER,
        reason: "ثبتت تسوية لاحقة تخص سنة الاختبار",
        clientRequestId: "year-reopen-r1-test",
      }),
    );
    expect(reopenRequest?.status).toBe("PENDING_APPROVAL");
    expect(reopenRequest?.replayed).toBe(false);
    const replay = await withTx((tx) =>
      requestYearEndReopen(tx, {
        snapshotId: firstClose.snapshotId,
        requestedBy: MANAGER,
        reason: "ثبتت تسوية لاحقة تخص سنة الاختبار",
        clientRequestId: "year-reopen-r1-test",
      }),
    );
    expect(Number(replay?.id)).toBe(Number(reopenRequest?.id));
    expect(replay?.replayed).toBe(true);
    await expect(
      withTx((tx) =>
        requestYearEndReopen(tx, {
          snapshotId: firstClose.snapshotId,
          requestedBy: MANAGER,
          reason: "سبب مختلف لا يجوز دمجه مع الطلب السابق",
          clientRequestId: "year-reopen-r1-test",
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      withTx((tx) =>
        approveYearEndReopen(tx, {
          requestId: Number(reopenRequest!.id),
          decidedBy: MANAGER,
          decisionReason: "نفس الطالب",
        }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const opened = await withTx((tx) =>
      approveYearEndReopen(tx, {
        requestId: Number(reopenRequest!.id),
        decidedBy: ADMIN,
        decisionReason: "الدليل مكتمل ومعتمد",
      }),
    );
    expect(opened).toMatchObject({
      snapshotId: firstClose.snapshotId,
      nextRequiredMonth: `${YEAR}-12`,
    });

    const [archivedFirstPeriod] = await db()
      .select()
      .from(s.financialPeriods)
      .where(eq(s.financialPeriods.id, firstClose.periodLockId));
    expect(archivedFirstPeriod.status).toBe("ARCHIVED");
    const [reversalJournal] = await db()
      .select()
      .from(s.journalEntries)
      .where(eq(s.journalEntries.entryId, opened.reversalEntryId));
    const reversalLines = await db()
      .select()
      .from(s.journalLines)
      .where(eq(s.journalLines.journalId, reversalJournal.id));
    const normalized = (rows: typeof originalLines) =>
      rows
        .map((line) => ({
          role: line.role,
          debit: line.debit,
          credit: line.credit,
        }))
        .sort((left, right) => left.role.localeCompare(right.role));
    expect(normalized(reversalLines)).toEqual(
      normalized(originalLines).map((line) => ({
        role: line.role,
        debit: line.credit,
        credit: line.debit,
      })),
    );
    let [sequence] = await db().select().from(s.monthCloseSequence);
    expect(sequence).toMatchObject({
      activeThroughMonth: null,
      nextRequiredMonth: `${YEAR}-12`,
      activePeriodId: null,
      activeCertificateId: null,
      version: 3,
    });

    const secondRequest = await pendingRequest();
    const secondClose = await withTx((tx) =>
      closeYear(tx, {
        year: YEAR,
        requestId: secondRequest.id,
        closedBy: ADMIN,
      }),
    );
    expect(secondClose.certificateNumber).toBe("MC-2025-12-R02");
    const snapshots = await db()
      .select()
      .from(s.yearEndSnapshots)
      .orderBy(s.yearEndSnapshots.revision);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toMatchObject({ revision: 1 });
    expect(snapshots[1]).toMatchObject({
      revision: 2,
      supersedesSnapshotId: firstClose.snapshotId,
    });
    const [secondCertificate] = await db()
      .select()
      .from(s.monthCloseCertificates)
      .where(eq(s.monthCloseCertificates.id, secondClose.certificateId));
    expect(secondCertificate).toMatchObject({
      revision: 2,
      supersedesCertificateId: firstClose.certificateId,
      yearEndSnapshotId: secondClose.snapshotId,
    });
    const [secondEntry] = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.dedupeKey, `YEAR_CLOSE:${YEAR}:R2`));
    expect(Number(secondEntry.id)).toBe(secondClose.retainedEarningsEntryId);
    const events = await db()
      .select()
      .from(s.monthCloseEvents)
      .orderBy(s.monthCloseEvents.id);
    expect(events.map((event) => event.eventType)).toEqual([
      "CLOSE",
      "UNLOCK",
      "CLOSE",
    ]);
    sequence = (await db().select().from(s.monthCloseSequence))[0];
    expect(sequence).toMatchObject({
      activeThroughMonth: `${YEAR}-12`,
      nextRequiredMonth: `${YEAR + 1}-01`,
      activePeriodId: secondClose.periodLockId,
      activeCertificateId: secondClose.certificateId,
      version: 4,
    });
    await withTx(async (tx) => {
      const verification = await verifyMonthCloseCertificate(
        tx,
        secondClose.certificateId,
      );
      expect(verification).toMatchObject({
        integrity: "VERIFIED",
        lifecycle: "ACTIVE",
      });
    });
  });
});
