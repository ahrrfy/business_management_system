import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { computeTreasuryCashBalance } from "../cash/cashAvailability";
import {
  LEGACY_NEGATIVE_SHIFT_CUTOFF,
  remediateAndCloseLegacyNegativeShifts,
  type LegacyNegativeShiftItem,
} from "../legacyNegativeShiftService";

const owner = { userId: 1, branchId: 1, role: "admin", isOwner: true } as const;
const beforeCutoff = new Date("2026-08-10T08:00:00.000Z");

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
    "accountingEntries",
    "receipts",
    "shifts",
    "branches",
    "users",
  ]) {
    await database.execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  }
  await database.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed() {
  await db().insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values([
    { id: 1, openId: "legacy-owner", name: "المالك", role: "admin", loginMethod: "local", branchId: 1, isOwner: true },
    { id: 2, openId: "legacy-marwa", name: "مروة", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "legacy-taghreed", name: "تغريد", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 4, openId: "legacy-shahd", name: "شهد", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 5, openId: "legacy-source-user", name: "مستخدم السحب", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 6, openId: "legacy-non-owner", name: "مدير", role: "manager", loginMethod: "local", branchId: 1, isOwner: false },
  ]);
  await db().insert(s.shifts).values([
    { id: 151, branchId: 1, userId: 2, openingBalance: "0.00", status: "OPEN", openGuard: "2:1:RETAIL", openedAt: beforeCutoff },
    { id: 192, branchId: 1, userId: 3, openingBalance: "0.00", status: "OPEN", openGuard: "3:1:RETAIL", openedAt: beforeCutoff },
    { id: 197, branchId: 1, userId: 4, openingBalance: "500000.00", status: "OPEN", openGuard: "4:1:RETAIL", openedAt: beforeCutoff },
    { id: 199, branchId: 1, userId: 5, openingBalance: "17000.00", status: "OPEN", openGuard: "5:1:RETAIL", openedAt: beforeCutoff },
  ]);
  await db().insert(s.receipts).values([
    {
      id: 1001, branchId: 1, shiftId: 151, direction: "OUT", amount: "324000.00",
      paymentMethod: "CASH", cashBucket: "DRAWER", status: "COMPLETED", approvalStatus: "APPROVED",
      referenceNumber: "LEGACY-MARWA", createdBy: 2, createdAt: beforeCutoff,
    },
    {
      id: 1002, branchId: 1, shiftId: 192, direction: "OUT", amount: "962560.00",
      paymentMethod: "CASH", cashBucket: "DRAWER", status: "COMPLETED", approvalStatus: "APPROVED",
      referenceNumber: "LEGACY-TAGHREED", createdBy: 3, createdAt: beforeCutoff,
    },
    {
      id: 1003, branchId: 1, shiftId: 197, direction: "OUT", amount: "516984.00",
      paymentMethod: "CASH", cashBucket: "DRAWER", status: "COMPLETED", approvalStatus: "APPROVED",
      referenceNumber: "LEGACY-SHAHD", createdBy: 4, createdAt: beforeCutoff,
    },
    {
      id: 2000, branchId: 1, shiftId: null, direction: "IN", amount: "2000000.00",
      paymentMethod: "CASH", cashBucket: "TREASURY", status: "COMPLETED", approvalStatus: "APPROVED",
      referenceNumber: "TEST-TREASURY-FUND", createdBy: 1, createdAt: beforeCutoff,
    },
    {
      id: 2995, branchId: 1, shiftId: 199, direction: "OUT", amount: "17000.00",
      paymentMethod: "CASH", cashBucket: "DRAWER", status: "COMPLETED", approvalStatus: "APPROVED",
      referenceNumber: "CD-1-20260815-0001", createdBy: 5, createdAt: new Date("2026-08-15T12:00:00.000Z"),
    },
    {
      id: 2996, branchId: 1, shiftId: null, direction: "IN", amount: "17000.00",
      paymentMethod: "CASH", cashBucket: "TREASURY", status: "COMPLETED", approvalStatus: "APPROVED",
      referenceNumber: "CD-1-20260815-0001", createdBy: 4, createdAt: new Date("2026-08-15T12:00:00.000Z"),
    },
  ]);
}

function requestItems(): LegacyNegativeShiftItem[] {
  return [
    {
      shiftId: 151,
      expectedCash: "-324000.00",
      evidenceNote: "توجيه المالك بتحميل العجز التاريخي المثبت على خزنة الفرع وتصفير الوردية.",
      confirmDrawerCountedZero: true,
      clientRequestId: "legacy-close-151-v1",
    },
    {
      shiftId: 192,
      expectedCash: "-962560.00",
      evidenceNote: "توجيه المالك بتحميل العجز التاريخي المثبت على خزنة الفرع وتصفير الوردية.",
      confirmDrawerCountedZero: true,
      clientRequestId: "legacy-close-192-v1",
    },
    {
      shiftId: 197,
      expectedCash: "-16984.00",
      sourceTreasuryReceiptId: 2996,
      evidenceNote: "السحب CD-1-20260815-0001 وصل الخزنة ولم تسجل ساق 16984 إلى وردية شهد.",
      confirmDrawerCountedZero: true,
      clientRequestId: "legacy-close-197-v1",
    },
  ];
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("legacy negative shifts — تصحيح خزنة→درج وإغلاق صفري", () => {
  it("يعالج الورديات الثلاث ذرّياً، يحفظ مصدر شهد، ويترك 16 د.ع في الخزنة", async () => {
    const sourceBefore = (await db().select().from(s.receipts).where(eq(s.receipts.id, 2996)).limit(1))[0];
    let treasuryBefore = "";
    await db().transaction(async (tx) => {
      treasuryBefore = (await computeTreasuryCashBalance(tx, 1)).toFixed(2);
    });

    const result = await remediateAndCloseLegacyNegativeShifts(requestItems(), owner);
    expect(result.totalFunding).toBe("1303544.00");
    expect(result.items.map((item) => [item.shiftId, item.fundingAmount])).toEqual([
      [151, "324000.00"],
      [192, "962560.00"],
      [197, "16984.00"],
    ]);
    expect(result.items[2]?.sourceResidualInTreasury).toBe("16.00");

    const closed = await db().select().from(s.shifts).where(sql`${s.shifts.id} IN (151, 192, 197)`).orderBy(s.shifts.id);
    expect(closed).toHaveLength(3);
    for (const shift of closed) {
      expect(shift.status).toBe("CLOSED");
      expect(shift.expectedCash).toBe("0.00");
      expect(shift.countedCash).toBe("0.00");
      expect(shift.variance).toBe("0.00");
      expect(shift.closingDrawerCash).toBe("0.00");
      expect(shift.reconciliationStatus).toBe("MATCHED");
      expect(shift.closedByUserId).toBe(1);
    }

    const corrections = await db()
      .select()
      .from(s.receipts)
      .where(sql`${s.receipts.referenceNumber} LIKE 'LSR-%'`)
      .orderBy(s.receipts.id);
    expect(corrections).toHaveLength(6);
    expect(corrections.filter((row) => row.direction === "OUT" && row.cashBucket === "TREASURY")).toHaveLength(3);
    expect(corrections.filter((row) => row.direction === "IN" && row.cashBucket === "DRAWER")).toHaveLength(3);
    expect(corrections.every((row) => row.status === "COMPLETED" && row.approvalStatus === "APPROVED")).toBe(true);

    const sourceAfter = (await db().select().from(s.receipts).where(eq(s.receipts.id, 2996)).limit(1))[0];
    expect(sourceAfter).toEqual(sourceBefore);
    let treasuryAfter = "";
    await db().transaction(async (tx) => {
      treasuryAfter = (await computeTreasuryCashBalance(tx, 1)).toFixed(2);
    });
    expect(treasuryBefore).toBe("2017000.00");
    expect(treasuryAfter).toBe("713456.00");

    const entries = await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "SHIFT_FLOAT_OUT"));
    expect(entries).toHaveLength(3);
    expect(entries.every((entry) => entry.revenue === "0.00" && entry.cost === "0.00" && entry.profit === "0.00")).toBe(true);
    expect(await db().select().from(s.auditLogs).where(eq(s.auditLogs.action, "shift.legacy_negative_remediation"))).toHaveLength(3);
  });

  it("إعادة الطلب المطابق لا تكرر أي إيصال أو قيد", async () => {
    const items = requestItems();
    await remediateAndCloseLegacyNegativeShifts(items, owner);
    const replay = await remediateAndCloseLegacyNegativeShifts(items, owner);
    expect(replay.items.every((item) => item.alreadyApplied)).toBe(true);
    expect(replay.totalFunding).toBe("1303544.00");
    expect(await db().select().from(s.receipts).where(sql`${s.receipts.referenceNumber} LIKE 'LSR-%'`)).toHaveLength(6);
    expect(await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "SHIFT_FLOAT_OUT"))).toHaveLength(3);
  });

  it("إعادة الطلب تفشل إذا عُبث بسند مصدر شهد بعد الالتزام", async () => {
    const item = [requestItems()[2]!];
    await remediateAndCloseLegacyNegativeShifts(item, owner);
    await db().update(s.receipts).set({ amount: "17001.00" }).where(eq(s.receipts.id, 2996));
    await expect(remediateAndCloseLegacyNegativeShifts(item, owner)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(await db().select().from(s.receipts).where(eq(s.receipts.referenceNumber, "LSR-197-S2996"))).toHaveLength(2);
  });

  it("نقرتان متزامنتان لوردية واحدة تنفذان مادياً مرة واحدة فقط", async () => {
    const item = [requestItems()[0]!];
    const attempts = await Promise.allSettled([
      remediateAndCloseLegacyNegativeShifts(item, owner),
      remediateAndCloseLegacyNegativeShifts(item, owner),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(2);
    expect(await db().select().from(s.receipts).where(eq(s.receipts.referenceNumber, "LSR-151"))).toHaveLength(2);
    expect(await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.dedupeKey, "LEGACY_SHIFT_FUND:151"))).toHaveLength(1);
  });

  it("يفشل مغلقاً لغير المالك ولوردية جديدة ولا يكتب أثراً", async () => {
    await expect(
      remediateAndCloseLegacyNegativeShifts([requestItems()[0]!], {
        userId: 6,
        branchId: 1,
        role: "manager",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await db().insert(s.shifts).values({
      id: 300,
      branchId: 1,
      userId: 2,
      openingBalance: "0.00",
      status: "OPEN",
      openGuard: "2:1:PRINT_SERVICES",
      openedAt: new Date(LEGACY_NEGATIVE_SHIFT_CUTOFF.getTime() + 1000),
      shiftType: "PRINT_SERVICES",
    });
    await db().insert(s.receipts).values({
      branchId: 1, shiftId: 300, direction: "OUT", amount: "1.00", paymentMethod: "CASH",
      cashBucket: "DRAWER", status: "COMPLETED", approvalStatus: "APPROVED", createdBy: 2,
    });
    await expect(
      remediateAndCloseLegacyNegativeShifts(
        [{ shiftId: 300, expectedCash: "-1.00", evidenceNote: "محاولة غير مشروعة بعد تفعيل الحارس الإنتاجي الصارم.", confirmDrawerCountedZero: true, clientRequestId: "new-shift-denied" }],
        owner,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await db().select().from(s.receipts).where(sql`${s.receipts.referenceNumber} LIKE 'LSR-%'`)).toHaveLength(0);
  });

  it("أي تغير في اللقطة أو مصدر شهد أو نقص الخزنة يرجع الدفعة كلها", async () => {
    await db().update(s.receipts).set({ createdBy: 5 }).where(eq(s.receipts.id, 2996));
    await expect(remediateAndCloseLegacyNegativeShifts(requestItems(), owner)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect((await db().select().from(s.shifts).where(eq(s.shifts.id, 151)).limit(1))[0]?.status).toBe("OPEN");
    expect(await db().select().from(s.receipts).where(sql`${s.receipts.referenceNumber} LIKE 'LSR-%'`)).toHaveLength(0);

    await db().update(s.receipts).set({ createdBy: 4 }).where(eq(s.receipts.id, 2996));
    await db().delete(s.receipts).where(eq(s.receipts.referenceNumber, "TEST-TREASURY-FUND"));
    await expect(remediateAndCloseLegacyNegativeShifts(requestItems(), owner)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(await db().select().from(s.receipts).where(sql`${s.receipts.referenceNumber} LIKE 'LSR-%'`)).toHaveLength(0);
  });
});
