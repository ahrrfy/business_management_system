import { and, eq, like, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { acceptPendingTreasuryReceipt } from "../treasury/pendingReceipts";
import { createCashDrop } from "../cashDropService";
import {
  computeDrawerCashBalance,
  computeTreasuryCashBalance,
} from "../cash/cashAvailability";
import { getShiftReport } from "../shiftService";
import { toDateStr } from "../money";
import { getTreasurySummary } from "../reportsTreasuryService";
import { getFinancialPosition } from "../reportsFinancialService";
import { getDashboard } from "../treasury/dashboard";
import { getKpiTrends } from "../treasury/kpiTrends";
import {
  cancelShiftFundingRequest,
  listMyPendingShiftFunding,
  listEligibleShiftFundingSources,
  listPendingShiftFundingForOwners,
  requestAdditionalShiftFunding,
  respondToShiftFundingRequest,
} from "../shiftFundingService";

const OWNER = { userId: 1, branchId: 1, role: "admin", isOwner: true } as const;
const CASHIER_A = { userId: 2, branchId: 1, role: "cashier" } as const;
const CASHIER_B = { userId: 3, branchId: 1, role: "cashier" } as const;

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set");
  return value;
}

async function reset() {
  const database = db();
  await database.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of [
    "auditLogs",
    "idempotencyKeys",
    "accountingEntries",
    "shiftFundingSourceLinks",
    "receipts",
    "shifts",
    "branches",
    "users",
  ]) {
    await database.execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  }
  await database.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed(treasury = "0.00") {
  await db().insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values([
    { id: 1, openId: "fund-owner", name: "المالك", role: "admin", loginMethod: "local", branchId: 1, isOwner: true },
    { id: 2, openId: "fund-cashier-a", name: "الكاشير أ", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "fund-cashier-b", name: "الكاشير ب", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 4, openId: "fund-manager", name: "مدير غير مالك", role: "manager", loginMethod: "local", branchId: 1 },
  ]);
  await db().insert(s.shifts).values([
    { id: 101, branchId: 1, userId: 2, openingBalance: "100.00", status: "OPEN", openGuard: "2:1:RETAIL" },
    { id: 102, branchId: 1, userId: 3, openingBalance: "50.00", status: "OPEN", openGuard: "3:1:RETAIL" },
    { id: 103, branchId: 1, userId: 3, openingBalance: "5000.00", status: "OPEN", openGuard: "3:1:RECEPTION", shiftType: "RECEPTION" },
  ]);
  await db().insert(s.receipts).values({
    branchId: 1,
    direction: "IN",
    amount: treasury,
    paymentMethod: "CASH",
    cashBucket: "TREASURY",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    referenceNumber: "TEST-TREASURY-FUND",
    createdBy: 1,
  });
}

async function balances(shiftId: number, opening: string) {
  return db().transaction(async (tx) => ({
    treasury: (await computeTreasuryCashBalance(tx, 1)).toFixed(2),
    drawer: (await computeDrawerCashBalance(tx, shiftId, opening)).toFixed(2),
  }));
}

async function acceptedDrop(amount: string, key: string) {
  const drop = await createCashDrop(
    {
      shiftId: 103,
      amount,
      dropTo: 1,
      notes: `سحب نقدي موثق لتمويل وردية أخرى ${key}`,
      clientRequestId: `drop-${key}`,
    },
    CASHIER_B,
  );
  await acceptPendingTreasuryReceipt(drop.inReceiptId, OWNER);
  return drop;
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("additional shift funding — عهدة خزنة إلى درج بقبول فعلي", () => {
  it("يبقى الطلب صفري الأثر ثم ينفذ الساقين والقيد والتقرير عند قبول صاحب الوردية", async () => {
    const source = await acceptedDrop("300", "happy-300");
    expect((await listEligibleShiftFundingSources({ targetShiftId: 101 }, OWNER)).items).toEqual([
      expect.objectContaining({ receiptId: source.inReceiptId, sourceShiftId: 103, amount: "300.00" }),
    ]);
    const before = await balances(101, "100.00");
    const request = await requestAdditionalShiftFunding(
      {
        shiftId: 101,
        amount: "300",
        evidenceNote: "عهدة إضافية لتغطية مصروفات الوردية المتوقعة",
        sourceTreasuryReceiptId: source.inReceiptId,
        clientRequestId: "fund-happy-101",
      },
      OWNER,
    );
    expect(request.status).toBe("PENDING");
    expect((await listEligibleShiftFundingSources({ targetShiftId: 101 }, OWNER)).items).toHaveLength(0);
    expect(await listPendingShiftFundingForOwners(OWNER)).toEqual([
      expect.objectContaining({ requestReceiptId: request.requestReceiptId, targetUserId: 2 }),
    ]);
    expect(await balances(101, "100.00")).toEqual(before);
    const [pending] = await db().select().from(s.receipts).where(eq(s.receipts.id, request.requestReceiptId));
    expect(pending).toMatchObject({
      direction: "OUT",
      status: "PENDING",
      approvalStatus: "PENDING_APPROVAL",
      cashBucket: null,
      shiftId: null,
    });
    const [pendingLink] = await db()
      .select()
      .from(s.shiftFundingSourceLinks)
      .where(eq(s.shiftFundingSourceLinks.requestReceiptId, request.requestReceiptId));
    expect(pendingLink).toMatchObject({
      state: "PENDING",
      sourceReceiptId: source.inReceiptId,
      activeSourceReceiptId: source.inReceiptId,
      targetShiftId: 101,
      activeTargetShiftId: 101,
    });
    expect(
      await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "SHIFT_FLOAT_OUT")),
    ).toHaveLength(0);
    expect(await listMyPendingShiftFunding(CASHIER_A)).toHaveLength(1);
    expect(await listMyPendingShiftFunding(CASHIER_B)).toHaveLength(0);

    const accepted = await respondToShiftFundingRequest(
      { requestReceiptId: request.requestReceiptId, decision: "ACCEPT" },
      CASHIER_A,
    );
    expect(accepted).toMatchObject({
      status: "COMPLETED",
      treasuryBalanceAfter: "0.00",
      drawerBalanceAfter: "400.00",
    });
    const [consumedLink] = await db()
      .select()
      .from(s.shiftFundingSourceLinks)
      .where(eq(s.shiftFundingSourceLinks.requestReceiptId, request.requestReceiptId));
    expect(consumedLink).toMatchObject({
      state: "CONSUMED",
      activeSourceReceiptId: source.inReceiptId,
      activeTargetShiftId: null,
    });
    expect(await listPendingShiftFundingForOwners(OWNER)).toHaveLength(0);
    expect(await balances(101, "100.00")).toEqual({ treasury: "0.00", drawer: "400.00" });
    const rows = await db().select().from(s.receipts).where(eq(s.receipts.referenceNumber, request.referenceNumber));
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.direction === "OUT")).toMatchObject({ cashBucket: "TREASURY", status: "COMPLETED" });
    expect(rows.find((row) => row.direction === "IN")).toMatchObject({ cashBucket: "DRAWER", shiftId: 101, status: "COMPLETED" });
    const [entry] = await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.dedupeKey, `SHIFT_TOPUP:${request.requestReceiptId}`));
    expect(entry).toMatchObject({ entryType: "SHIFT_FLOAT_OUT", revenue: "0.00", cost: "0.00", profit: "0.00" });
    expect(await db().select().from(s.auditLogs).where(eq(s.auditLogs.action, "shift.funding.accept"))).toHaveLength(1);
    const report = await getShiftReport(101);
    expect(report?.cashReconciliation.breakdown.otherCashIn).toEqual(
      expect.arrayContaining([expect.objectContaining({ referenceNumber: request.referenceNumber, amount: "300.00" })]),
    );
    const today = toDateStr();
    const reportScope = { scopedBranchId: 1, role: "admin", userId: 1 };
    expect(await getTreasurySummary({ branchId: 1, from: today, to: today })).toMatchObject({
      totalIn: "0.00",
      totalOut: "0.00",
      net: "0.00",
    });
    expect((await getDashboard({ branchId: 1 }, reportScope)).todayReceiptsTotal).toBe("0.00");
    expect((await getKpiTrends({ branchId: 1 }, reportScope)).todayReceipts.current).toBe("0.00");

    // البادئة وحدها ليست سبباً للإخفاء: سند خارجي يدوي بلا قيد SHIFT_FLOAT_OUT يبقى ظاهراً.
    await db().insert(s.receipts).values({
      branchId: 1,
      direction: "IN",
      amount: "7.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      referenceNumber: request.referenceNumber,
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      createdBy: 1,
    });
    expect(await getTreasurySummary({ branchId: 1, from: today, to: today })).toMatchObject({
      totalIn: "7.00",
      totalOut: "0.00",
      net: "7.00",
    });
    expect((await getDashboard({ branchId: 1 }, reportScope)).todayReceiptsTotal).toBe("7.00");
    expect((await getKpiTrends({ branchId: 1 }, reportScope)).todayReceipts.current).toBe("7.00");
  });

  it("يؤرخ ساقي التمويل بلحظة الاستلام ولا يعيد كتابة النقد في يوم الطلب", async () => {
    const source = await acceptedDrop("130", "cross-day-materialization");
    const request = await requestAdditionalShiftFunding(
      {
        shiftId: 101,
        amount: "130",
        evidenceNote: "طلب عهدة سيجري استلامه في يوم مالي لاحق عن وقت الطلب",
        sourceTreasuryReceiptId: source.inReceiptId,
        clientRequestId: "fund-cross-day-materialization",
      },
      OWNER,
    );
    const yesterday = new Date(Date.now() - 86_400_000);
    const yesterdayDay = toDateStr(yesterday);
    await db().update(s.receipts).set({ createdAt: yesterday, voucherDate: yesterdayDay }).where(eq(s.receipts.id, request.requestReceiptId));
    expect((await getFinancialPosition({ branchId: 1, asOf: yesterdayDay })).cash).toBe("0.00");

    await respondToShiftFundingRequest(
      { requestReceiptId: request.requestReceiptId, decision: "ACCEPT" },
      CASHIER_A,
    );
    expect((await getFinancialPosition({ branchId: 1, asOf: yesterdayDay })).cash).toBe("0.00");
    const materialRows = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.referenceNumber, request.referenceNumber));
    expect(materialRows).toHaveLength(2);
    expect(new Set(materialRows.map((row) => toDateStr(row.createdAt)))).toEqual(new Set([toDateStr()]));
    const [entry] = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.dedupeKey, `SHIFT_TOPUP:${request.requestReceiptId}`));
    expect(toDateStr(entry!.entryDate)).toBe(toDateStr());
  });

  it("لا يعطل سند يدوي يحمل مرجع STF نفسه القبول ولا يختفي من التقارير", async () => {
    const source = await acceptedDrop("120", "same-reference-external");
    const request = await requestAdditionalShiftFunding(
      {
        shiftId: 101,
        amount: "120",
        evidenceNote: "اختبار فصل الساق الموقعة عن سند خارجي يحمل المرجع الظاهر نفسه",
        sourceTreasuryReceiptId: source.inReceiptId,
        clientRequestId: "fund-same-reference-external",
      },
      OWNER,
    );
    await db().insert(s.receipts).values({
      branchId: 1,
      shiftId: 101,
      direction: "IN",
      amount: "5.00",
      paymentMethod: "CASH",
      cashBucket: "DRAWER",
      referenceNumber: request.referenceNumber,
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      createdBy: 2,
    });
    await expect(
      respondToShiftFundingRequest(
        { requestReceiptId: request.requestReceiptId, decision: "ACCEPT" },
        CASHIER_A,
      ),
    ).resolves.toMatchObject({ status: "COMPLETED", drawerBalanceAfter: "225.00" });
    expect(await getTreasurySummary({ branchId: 1, from: toDateStr(), to: toDateStr() })).toMatchObject({
      totalIn: "5.00",
      totalOut: "0.00",
      net: "5.00",
    });
  });

  it("القبول المتزامن وإعادة الطلب ينفذان مرة واحدة فقط حتى لو استُنفد آخر رصيد", async () => {
    const source = await acceptedDrop("300", "concurrent-300");
    const request = await requestAdditionalShiftFunding(
      {
        shiftId: 101,
        amount: "300",
        evidenceNote: "تسليم آخر مبلغ متاح في الخزنة للوردية",
        sourceTreasuryReceiptId: source.inReceiptId,
        clientRequestId: "fund-concurrent-101",
      },
      OWNER,
    );
    const attempts = await Promise.all([
      respondToShiftFundingRequest({ requestReceiptId: request.requestReceiptId, decision: "ACCEPT" }, CASHIER_A),
      respondToShiftFundingRequest({ requestReceiptId: request.requestReceiptId, decision: "ACCEPT" }, CASHIER_A),
    ]);
    expect(attempts.filter((value) => value.idempotent)).toHaveLength(1);
    expect(await balances(101, "100.00")).toEqual({ treasury: "0.00", drawer: "400.00" });
    expect(await db().select().from(s.receipts).where(eq(s.receipts.referenceNumber, request.referenceNumber))).toHaveLength(2);
    expect(await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.dedupeKey, `SHIFT_TOPUP:${request.requestReceiptId}`))).toHaveLength(1);

    const replay = await requestAdditionalShiftFunding(
      {
        shiftId: 101,
        amount: "300",
        evidenceNote: "تسليم آخر مبلغ متاح في الخزنة للوردية",
        sourceTreasuryReceiptId: source.inReceiptId,
        clientRequestId: "fund-concurrent-101",
      },
      OWNER,
    );
    expect(replay.idempotent).toBe(true);
    await expect(
      requestAdditionalShiftFunding(
        {
          shiftId: 101,
          amount: "301",
          evidenceNote: "تسليم آخر مبلغ متاح في الخزنة للوردية",
          sourceTreasuryReceiptId: source.inReceiptId,
          clientRequestId: "fund-concurrent-101",
        },
        OWNER,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("يقبل طلب عهدة جديداً بمصدر جديد بعد اكتمال عهدة سابقة", async () => {
    const firstSource = await acceptedDrop("100", "sequential-first");
    const first = await requestAdditionalShiftFunding(
      {
        shiftId: 101,
        amount: "100",
        evidenceNote: "العهدة الأولى من سحب نقدي فعلي مستقل",
        sourceTreasuryReceiptId: firstSource.inReceiptId,
        clientRequestId: "fund-sequential-first",
      },
      OWNER,
    );
    await respondToShiftFundingRequest(
      { requestReceiptId: first.requestReceiptId, decision: "ACCEPT" },
      CASHIER_A,
    );

    const secondSource = await acceptedDrop("75", "sequential-second");
    expect((await listEligibleShiftFundingSources({ targetShiftId: 101 }, OWNER)).items).toEqual([
      expect.objectContaining({ receiptId: secondSource.inReceiptId, amount: "75.00" }),
    ]);
    await expect(
      requestAdditionalShiftFunding(
        {
          shiftId: 101,
          amount: "75",
          evidenceNote: "العهدة الثانية من سحب نقدي فعلي مستقل",
          sourceTreasuryReceiptId: secondSource.inReceiptId,
          clientRequestId: "fund-sequential-second",
        },
        OWNER,
      ),
    ).resolves.toMatchObject({ status: "PENDING", amount: "75.00" });
  });

  it("سباق قبول صاحب الوردية مع إلغاء المالك يحسم حالة واحدة بلا أثر جزئي", async () => {
    const source = await acceptedDrop("250", "accept-cancel-race");
    const request = await requestAdditionalShiftFunding(
      {
        shiftId: 101,
        amount: "250",
        evidenceNote: "اختبار حسم القبول والإلغاء المتزامنين بلا أثر جزئي",
        sourceTreasuryReceiptId: source.inReceiptId,
        clientRequestId: "fund-accept-cancel-race",
      },
      OWNER,
    );
    const outcomes = await Promise.allSettled([
      respondToShiftFundingRequest(
        { requestReceiptId: request.requestReceiptId, decision: "ACCEPT" },
        CASHIER_A,
      ),
      cancelShiftFundingRequest(
        { requestReceiptId: request.requestReceiptId, cancellationReason: "تعذّر التسليم أثناء السباق" },
        OWNER,
      ),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const [requestRow] = await db().select().from(s.receipts).where(eq(s.receipts.id, request.requestReceiptId));
    const accepted = requestRow?.status === "COMPLETED";
    expect(await balances(101, "100.00")).toEqual(
      accepted
        ? { treasury: "0.00", drawer: "350.00" }
        : { treasury: "250.00", drawer: "100.00" },
    );
    expect(
      await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "SHIFT_FLOAT_OUT")),
    ).toHaveLength(accepted ? 1 : 0);
  });

  it("سباق القبول والرفض يتبع ترتيب قفل واحداً ويحسم أثراً واحداً", async () => {
    const source = await acceptedDrop("225", "accept-reject-race");
    const request = await requestAdditionalShiftFunding(
      {
        shiftId: 101,
        amount: "225",
        evidenceNote: "اختبار سباق قبول ورفض عهدة مسلمة بلا تعطل",
        sourceTreasuryReceiptId: source.inReceiptId,
        clientRequestId: "fund-accept-reject-race",
      },
      OWNER,
    );
    const outcomes = await Promise.allSettled([
      respondToShiftFundingRequest(
        { requestReceiptId: request.requestReceiptId, decision: "ACCEPT" },
        CASHIER_A,
      ),
      respondToShiftFundingRequest(
        {
          requestReceiptId: request.requestReceiptId,
          decision: "REJECT",
          rejectionReason: "لم يصل النقد الفعلي إلى الدرج",
        },
        CASHIER_A,
      ),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const [requestRow] = await db().select().from(s.receipts).where(eq(s.receipts.id, request.requestReceiptId));
    const accepted = requestRow?.status === "COMPLETED";
    expect(await balances(101, "100.00")).toEqual(
      accepted
        ? { treasury: "0.00", drawer: "325.00" }
        : { treasury: "225.00", drawer: "100.00" },
    );
    expect(
      await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "SHIFT_FLOAT_OUT")),
    ).toHaveLength(accepted ? 1 : 0);
  });

  it("تغيير ساق سحب المصدر بعد الطلب يمنع القبول ويرجع المعاملة كلها", async () => {
    const source = await acceptedDrop("175", "source-tamper");
    const request = await requestAdditionalShiftFunding(
      {
        shiftId: 101,
        amount: "175",
        evidenceNote: "عقد مصدر سيُختبر ضد تغيير الساق التاريخية",
        sourceTreasuryReceiptId: source.inReceiptId,
        clientRequestId: "fund-source-tamper",
      },
      OWNER,
    );
    await db()
      .update(s.receipts)
      .set({ createdBy: 4 })
      .where(and(eq(s.receipts.referenceNumber, source.dropNumber), eq(s.receipts.direction, "OUT")));
    await expect(
      respondToShiftFundingRequest(
        { requestReceiptId: request.requestReceiptId, decision: "ACCEPT" },
        CASHIER_A,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await balances(101, "100.00")).toEqual({ treasury: "175.00", drawer: "100.00" });
    expect(
      await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "SHIFT_FLOAT_OUT")),
    ).toHaveLength(0);
  });

  it("تغيير فرع صف الطلب لا يحول خزينة فرع إلى درج فرع آخر", async () => {
    const source = await acceptedDrop("155", "request-branch-tamper");
    const request = await requestAdditionalShiftFunding(
      {
        shiftId: 101,
        amount: "155",
        evidenceNote: "اختبار ربط فرع صف الطلب بالعقد الموقع قبل أي أثر مالي",
        sourceTreasuryReceiptId: source.inReceiptId,
        clientRequestId: "fund-request-branch-tamper",
      },
      OWNER,
    );
    await db().insert(s.branches).values({ id: 2, name: "فرع اختبار التلاعب", code: "TAMPER", type: "SALES" });
    await db().update(s.receipts).set({ branchId: 2 }).where(eq(s.receipts.id, request.requestReceiptId));
    await expect(
      respondToShiftFundingRequest(
        { requestReceiptId: request.requestReceiptId, decision: "ACCEPT" },
        CASHIER_A,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((await balances(101, "100.00")).drawer).toBe("100.00");
    expect(
      await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "SHIFT_FLOAT_OUT")),
    ).toHaveLength(0);
    expect(
      await db().select().from(s.receipts).where(and(eq(s.receipts.referenceNumber, request.referenceNumber), eq(s.receipts.cashBucket, "DRAWER"))),
    ).toHaveLength(0);
  });

  it("يصفح مصادر السحب داخل فرع الوردية بلا مسح التاريخ أو إخفاء المصادر الأقدم", async () => {
    const drawerRows = Array.from({ length: 51 }, (_, index) => ({
      id: 10_000 + index,
      branchId: 1,
      shiftId: 103,
      direction: "OUT" as const,
      amount: "1.00",
      paymentMethod: "CASH" as const,
      cashBucket: "DRAWER" as const,
      status: "COMPLETED" as const,
      approvalStatus: "APPROVED" as const,
      referenceNumber: `CD-PAGE-${index.toString().padStart(3, "0")}`,
      createdBy: 3,
    }));
    const acceptedAt = new Date("2026-08-15T12:00:00.000Z");
    const treasuryRows = drawerRows.map((row, index) => ({
      id: 11_000 + index,
      branchId: 1,
      shiftId: null,
      direction: "IN" as const,
      amount: row.amount,
      paymentMethod: "CASH" as const,
      cashBucket: "TREASURY" as const,
      status: "COMPLETED" as const,
      approvalStatus: "APPROVED" as const,
      referenceNumber: row.referenceNumber,
      createdBy: 1,
      approvedBy: 1,
      approvedAt: acceptedAt,
    }));
    await db().insert(s.receipts).values([...drawerRows, ...treasuryRows]);
    await db().insert(s.accountingEntries).values(drawerRows.map((row) => ({
      entryType: "CASH_HANDOVER" as const,
      branchId: 1,
      receiptId: row.id,
      amount: row.amount,
      entryDate: "2026-08-15",
      dedupeKey: `CASH_DROP:PAGE:${row.id}`,
      createdBy: 3,
    })));

    const newest = await listEligibleShiftFundingSources({ targetShiftId: 101 }, OWNER);
    expect(newest.items).toHaveLength(50);
    expect(newest.nextCursor).not.toBeNull();
    const older = await listEligibleShiftFundingSources(
      { targetShiftId: 101, cursorReceiptId: newest.nextCursor },
      OWNER,
    );
    expect(older.items).toEqual([
      expect.objectContaining({ receiptId: 11_000, sourceShiftId: 103 }),
    ]);
    expect(older.nextCursor).toBeNull();
  });

  it("يرفض زوج إيصالات CD مصطنعاً أو قيد تسليم تغيّر بعد الطلب", async () => {
    await db().insert(s.receipts).values([
      {
        branchId: 1,
        shiftId: 103,
        direction: "OUT",
        amount: "125.00",
        paymentMethod: "CASH",
        cashBucket: "DRAWER",
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        referenceNumber: "CD-FAKE-PAIR",
        createdBy: 3,
      },
      {
        branchId: 1,
        shiftId: null,
        direction: "IN",
        amount: "125.00",
        paymentMethod: "CASH",
        cashBucket: "TREASURY",
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        referenceNumber: "CD-FAKE-PAIR",
        createdBy: 1,
      },
      {
        branchId: 1,
        shiftId: null,
        direction: "OUT",
        amount: "9.00",
        paymentMethod: "CASH",
        cashBucket: null,
        status: "PENDING",
        approvalStatus: "PENDING_APPROVAL",
        referenceNumber: "STF-1-101-MANUAL-UNSIGNED",
        createdBy: 1,
      },
      {
        branchId: 1,
        shiftId: null,
        direction: "OUT",
        amount: "11.00",
        paymentMethod: "CASH",
        cashBucket: null,
        status: "PENDING",
        approvalStatus: "PENDING_APPROVAL",
        partyType: "OTHER",
        referenceNumber: "STF-1-101-INJECTED-KIND",
        voucherNumber: "PV-INJECTED-STF-101",
        internalNote: JSON.stringify({ kind: "SHIFT_ADDITIONAL_FUNDING" }),
        createdBy: 1,
      },
    ]);
    const [fakeSource] = await db()
      .select()
      .from(s.receipts)
      .where(and(eq(s.receipts.referenceNumber, "CD-FAKE-PAIR"), eq(s.receipts.direction, "IN")));
    expect(fakeSource).toBeDefined();
    expect((await listEligibleShiftFundingSources({ targetShiftId: 101 }, OWNER)).items).toHaveLength(0);
    await expect(
      requestAdditionalShiftFunding(
        {
          shiftId: 101,
          amount: "125",
          evidenceNote: "محاولة استعمال زوج إيصالات بلا قيد تسليم نقدي أصلي",
          sourceTreasuryReceiptId: Number(fakeSource!.id),
          clientRequestId: "fund-fake-cd-pair",
        },
        OWNER,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    const unacceptedDrop = await createCashDrop(
      {
        shiftId: 103,
        amount: "90",
        dropTo: 1,
        notes: "سحب لم يؤكد المستلم حيازته فعلياً",
        clientRequestId: "drop-status-only-tamper",
      },
      CASHIER_B,
    );
    await db().update(s.receipts).set({ status: "COMPLETED" }).where(eq(s.receipts.id, unacceptedDrop.inReceiptId));
    expect((await listEligibleShiftFundingSources({ targetShiftId: 101 }, OWNER)).items).toHaveLength(0);
    await expect(
      requestAdditionalShiftFunding(
        {
          shiftId: 101,
          amount: "90",
          evidenceNote: "محاولة استعمال سحب غُيّرت حالته بلا قبول المستلم المعيّن",
          sourceTreasuryReceiptId: unacceptedDrop.inReceiptId,
          clientRequestId: "fund-status-only-tamper",
        },
        OWNER,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    const duplicatedSource = await acceptedDrop("140", "duplicate-treasury-leg");
    await db().insert(s.receipts).values({
      branchId: 1,
      shiftId: null,
      direction: "IN",
      amount: "140.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      referenceNumber: duplicatedSource.dropNumber,
      createdBy: 1,
    });
    expect((await listEligibleShiftFundingSources({ targetShiftId: 101 }, OWNER)).items).toHaveLength(0);
    await expect(
      requestAdditionalShiftFunding(
        {
          shiftId: 101,
          amount: "140",
          evidenceNote: "محاولة استعمال سحب يملك ساقي خزينة بالمرجع نفسه",
          sourceTreasuryReceiptId: duplicatedSource.inReceiptId,
          clientRequestId: "fund-duplicate-treasury-leg",
        },
        OWNER,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    const genuineSource = await acceptedDrop("160", "ledger-tamper");
    const request = await requestAdditionalShiftFunding(
      {
        shiftId: 101,
        amount: "160",
        evidenceNote: "طلب مرتبط بقيد تسليم أصلي ثم تتغير بصمته قبل الاستلام",
        sourceTreasuryReceiptId: genuineSource.inReceiptId,
        clientRequestId: "fund-ledger-tamper",
      },
      OWNER,
    );
    await db()
      .update(s.accountingEntries)
      .set({ createdBy: 4 })
      .where(eq(s.accountingEntries.receiptId, genuineSource.outReceiptId));
    await expect(
      respondToShiftFundingRequest(
        { requestReceiptId: request.requestReceiptId, decision: "ACCEPT" },
        CASHIER_A,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await balances(101, "100.00")).drawer).toBe("100.00");
    expect(
      await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "SHIFT_FLOAT_OUT")),
    ).toHaveLength(0);
  });

  it("طلبان على آخر الخزنة يقبل أحدهما فقط ولا يتركان أثراً جزئياً", async () => {
    const sourceA = await acceptedDrop("700", "race-a-700");
    const sourceB = await acceptedDrop("700", "race-b-700");
    await db().insert(s.receipts).values({
      branchId: 1,
      direction: "OUT",
      amount: "700.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      referenceNumber: "TEST-OTHER-TREASURY-OUT",
      createdBy: 1,
    });
    const first = await requestAdditionalShiftFunding(
      { shiftId: 101, amount: "700", evidenceNote: "تمويل الوردية الأولى من سحب موثق", sourceTreasuryReceiptId: sourceA.inReceiptId, clientRequestId: "fund-race-a" },
      OWNER,
    );
    const second = await requestAdditionalShiftFunding(
      { shiftId: 102, amount: "700", evidenceNote: "تمويل الوردية الثانية من سحب موثق", sourceTreasuryReceiptId: sourceB.inReceiptId, clientRequestId: "fund-race-b" },
      OWNER,
    );
    const results = await Promise.allSettled([
      respondToShiftFundingRequest({ requestReceiptId: first.requestReceiptId, decision: "ACCEPT" }, CASHIER_A),
      respondToShiftFundingRequest({ requestReceiptId: second.requestReceiptId, decision: "ACCEPT" }, CASHIER_B),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    let treasury = "";
    await db().transaction(async (tx) => {
      treasury = (await computeTreasuryCashBalance(tx, 1)).toFixed(2);
    });
    expect(treasury).toBe("0.00");
    expect(await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "SHIFT_FLOAT_OUT"))).toHaveLength(1);
    expect(await db().select().from(s.receipts).where(and(like(s.receipts.referenceNumber, "STF-%"), eq(s.receipts.cashBucket, "DRAWER")))).toHaveLength(1);
  });

  it("يربط سحب وردية أخرى مرة واحدة بعد قبول الخزنة وبالمبلغ نفسه", async () => {
    const drop = await createCashDrop(
      { shiftId: 103, amount: "200", dropTo: 1, notes: "تحويل عهدة للكاشير أ", clientRequestId: "source-drop-200" },
      CASHIER_B,
    );
    await acceptPendingTreasuryReceipt(drop.inReceiptId, OWNER);
    const request = await requestAdditionalShiftFunding(
      {
        shiftId: 101,
        amount: "200",
        evidenceNote: "نقل النقد المسحوب من وردية الكاشير ب إلى وردية الكاشير أ",
        sourceTreasuryReceiptId: drop.inReceiptId,
        clientRequestId: "fund-from-drop-200",
      },
      OWNER,
    );
    expect(request.sourceTreasuryReceiptId).toBe(drop.inReceiptId);
    expect(request.sourceReferenceNumber).toBe(drop.dropNumber);
    await respondToShiftFundingRequest({ requestReceiptId: request.requestReceiptId, decision: "ACCEPT" }, CASHIER_A);
    expect((await balances(103, "5000.00")).drawer).toBe("4800.00");
    expect((await balances(101, "100.00")).drawer).toBe("300.00");

    await db().insert(s.receipts).values({
      branchId: 1,
      direction: "IN",
      amount: "200.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      referenceNumber: "TEST-DUPLICATE-SOURCE-FUND",
      createdBy: 1,
    });

    await expect(
      requestAdditionalShiftFunding(
        {
          shiftId: 102,
          amount: "200",
          evidenceNote: "محاولة إعادة استعمال إيصال السحب نفسه مرة ثانية",
          sourceTreasuryReceiptId: drop.inReceiptId,
          clientRequestId: "fund-from-drop-duplicate",
        },
        OWNER,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("الرفض وصفاء الحراس: لا أثر، ولا تمويل ذاتي/سالب/مغلق/فوق المتاح", async () => {
    const source = await acceptedDrop("100", "reject-100");
    await expect(
      requestAdditionalShiftFunding(
        {
          shiftId: 101,
          amount: "100",
          evidenceNote: "محاولة تمويل مباشر بلا سحب وردية مصدر",
          clientRequestId: "fund-without-source",
        } as unknown as Parameters<typeof requestAdditionalShiftFunding>[0],
        OWNER,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const request = await requestAdditionalShiftFunding(
      { shiftId: 101, amount: "100", evidenceNote: "طلب سيُرفض لأن النقد لم يُسلّم", sourceTreasuryReceiptId: source.inReceiptId, clientRequestId: "fund-reject-101" },
      OWNER,
    );
    const rejected = await respondToShiftFundingRequest(
      { requestReceiptId: request.requestReceiptId, decision: "REJECT", rejectionReason: "لم يصل النقد فعلياً" },
      CASHIER_A,
    );
    expect(rejected.status).toBe("FAILED");
    const [releasedAfterReject] = await db()
      .select()
      .from(s.shiftFundingSourceLinks)
      .where(eq(s.shiftFundingSourceLinks.requestReceiptId, request.requestReceiptId));
    expect(releasedAfterReject).toMatchObject({
      state: "RELEASED",
      activeSourceReceiptId: null,
      activeTargetShiftId: null,
    });
    expect(await balances(101, "100.00")).toEqual({ treasury: "100.00", drawer: "100.00" });
    expect(
      await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "SHIFT_FLOAT_OUT")),
    ).toHaveLength(0);

    const stranded = await requestAdditionalShiftFunding(
      {
        shiftId: 101,
        amount: "100",
        evidenceNote: "طلب سيُلغى بعد تغيير فرع صاحب الوردية",
        sourceTreasuryReceiptId: source.inReceiptId,
        clientRequestId: "fund-cancel-stranded",
      },
      OWNER,
    );
    await db().update(s.users).set({ branchId: null }).where(eq(s.users.id, 2));
    await expect(
      respondToShiftFundingRequest(
        { requestReceiptId: stranded.requestReceiptId, decision: "ACCEPT" },
        CASHIER_A,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const cancelled = await cancelShiftFundingRequest(
      { requestReceiptId: stranded.requestReceiptId, cancellationReason: "تغيّر فرع الموظف قبل التسليم" },
      OWNER,
    );
    expect(cancelled.status).toBe("FAILED");
    expect(
      await cancelShiftFundingRequest(
        { requestReceiptId: stranded.requestReceiptId, cancellationReason: "تغيّر فرع الموظف قبل التسليم" },
        OWNER,
      ),
    ).toMatchObject({ idempotent: true, status: "FAILED" });
    expect((await listEligibleShiftFundingSources({ targetShiftId: 101 }, OWNER)).items).toEqual([
      expect.objectContaining({ receiptId: source.inReceiptId }),
    ]);
    await db().update(s.users).set({ branchId: 1 }).where(eq(s.users.id, 2));

    await expect(
      requestAdditionalShiftFunding(
        {
          shiftId: 103,
          amount: "100",
          evidenceNote: "محاولة إعادة سحب الوردية إلى الوردية نفسها",
          sourceTreasuryReceiptId: source.inReceiptId,
          clientRequestId: "fund-same-source-shift",
        },
        OWNER,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    await db().update(s.shifts).set({ userId: 1, openGuard: "1:1:RETAIL" }).where(eq(s.shifts.id, 101));
    await expect(
      requestAdditionalShiftFunding(
        { shiftId: 101, amount: "1", evidenceNote: "محاولة تمويل المالك لدرجه الشخصي", sourceTreasuryReceiptId: source.inReceiptId, clientRequestId: "fund-self" },
        OWNER,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await db().update(s.shifts).set({ userId: 2, openGuard: "2:1:RETAIL" }).where(eq(s.shifts.id, 101));
    await db().insert(s.receipts).values({
      branchId: 1, shiftId: 101, direction: "OUT", amount: "101.00", paymentMethod: "CASH",
      cashBucket: "DRAWER", status: "COMPLETED", approvalStatus: "APPROVED", createdBy: 2,
    });
    await expect(
      requestAdditionalShiftFunding(
        { shiftId: 101, amount: "1", evidenceNote: "محاولة إخفاء عجز الدرج بتمويل إضافي", sourceTreasuryReceiptId: source.inReceiptId, clientRequestId: "fund-negative" },
        OWNER,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    await db().update(s.shifts).set({ status: "CLOSED", openGuard: null }).where(eq(s.shifts.id, 102));
    await expect(
      requestAdditionalShiftFunding(
        { shiftId: 102, amount: "1", evidenceNote: "محاولة تمويل وردية مغلقة بعد انتهائها", sourceTreasuryReceiptId: source.inReceiptId, clientRequestId: "fund-closed" },
        OWNER,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(
      requestAdditionalShiftFunding(
        { shiftId: 103, amount: "5000", evidenceNote: "محاولة طلب مبلغ أكبر من الخزنة المتاحة", sourceTreasuryReceiptId: source.inReceiptId, clientRequestId: "fund-insufficient" },
        OWNER,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await db().select().from(s.receipts).where(like(s.receipts.referenceNumber, "STF-%"))).toHaveLength(2);
  });
});
