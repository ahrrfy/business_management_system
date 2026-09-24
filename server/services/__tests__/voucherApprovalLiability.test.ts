import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { approveVoucher, createVoucher } from "../voucherService";

async function openShift(branchId = 1, userId = 1): Promise<number> {
  const [res] = await db().insert(s.shifts).values({ branchId, userId, openingBalance: "0", status: "OPEN" });
  return Number((res as any).insertId);
}

const cashier = { userId: 10, branchId: 1, role: "cashier" as const };
const owner = { userId: 2, branchId: 1, role: "manager" as const, isOwner: true };

const TABLES = [
  "voucherCategories",
  "idempotencyKeys",
  "accountingEntries",
  "receipts",
  "shifts",
  "branches",
  "users",
  "auditLogs",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: 10, openId: "cashier-10", name: "كاشير الاستنساخ", role: "cashier", loginMethod: "local", branchId: 1, isOwner: false, isActive: true },
    { id: 2, openId: "owner-2", name: "المالك المعتمد", role: "manager", loginMethod: "local", branchId: 1, isOwner: true, isActive: true },
  ]);
  await d.insert(s.voucherCategories).values([
    { id: 11, name: "إيرادات قسم الطباعة والاستنساخ", direction: "IN", postingRole: "OTHER_REVENUE", isActive: true },
    { id: 12, name: "مصروفات عامة", direction: "OUT", postingRole: "RENT", isActive: true },
  ]);
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("ذمة اعتماد السندات ومسارات النقد (Voucher Approval & Cash Custody Liability)", () => {
  it("سند قبض إيراد (OTHER نقدي) من الكاشير: يدخل درج ووردية الكاشير فوراً بلا تعليق ولا حجز في ذمة المالك (المسار الأول)", async () => {
    const cashierShiftId = await openShift(1, cashier.userId);

    const r = await createVoucher(
      {
        voucherType: "RECEIPT",
        branchId: 1,
        amount: "50000.00",
        paymentMethod: "CASH",
        partyType: "OTHER",
        partyId: null,
        counterpartyName: "زبون نقدي - قسم الطباعة والاستنساخ",
        voucherCategoryId: 11,
        description: "إيراد طباعة واستنساخ ملازم",
        clientRequestId: "req-receipt-print-1",
      },
      cashier,
    );

    // 1. لا تعليق: معتمد ومكتمل فوراً لحظة الإنشاء
    expect(r.approvalStatus).toBe("APPROVED");

    // 2. النقد في درج ووردية الكاشير المستلم الحقيقي
    const receipt = (await db().select().from(s.receipts).where(eq(s.receipts.id, r.receiptId)))[0];
    expect(receipt.status).toBe("COMPLETED");
    expect(receipt.approvalStatus).toBe("APPROVED");
    expect(receipt.cashBucket).toBe("DRAWER");
    expect(receipt.shiftId).toBe(cashierShiftId);
    expect(receipt.createdBy).toBe(cashier.userId);

    // 3. القيد المحاسبي مرحل تحت كود الكاشير لا المالك
    const entries = await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.receiptId, r.receiptId));
    expect(entries).toHaveLength(1);
    expect(entries[0].entryType).toBe("PAYMENT_IN");
    expect(entries[0].createdBy).toBe(cashier.userId);
  });

  it("سند قبض بطاقة إلكترونية (CARD): لا يمس درج الكاشير ولا يتطلب وردية ولا يدخل في ذمة المعتمد (المسار الأول)", async () => {
    const r = await createVoucher(
      {
        voucherType: "RECEIPT",
        branchId: 1,
        amount: "25000.00",
        paymentMethod: "CARD",
        cardLastFour: "9876",
        partyType: "OTHER",
        partyId: null,
        counterpartyName: "زبون دفع بطاقة",
        voucherCategoryId: 11,
        description: "طباعة بوسترات عبر الماستركارد",
        clientRequestId: "req-receipt-card-1",
      },
      cashier,
    );

    expect(r.approvalStatus).toBe("APPROVED");

    const receipt = (await db().select().from(s.receipts).where(eq(s.receipts.id, r.receiptId)))[0];
    expect(receipt.status).toBe("COMPLETED");
    expect(receipt.approvalStatus).toBe("APPROVED");
    expect(receipt.cashBucket).toBeNull();
    expect(receipt.shiftId).toBeNull();
  });

  it("عند اعتماد سند قبض نقدي معلق تاريخياً: يؤول النقد لوردية ودرج منشئ السند (الكاشير) وليس للمالك المعتمد", async () => {
    // الكاشير فتح وردية رقم 1
    const cashierShiftId = await openShift(1, cashier.userId);

    // المالك فتح وردية رقم 2 أيضاً في نفس الفرع
    const ownerShiftId = await openShift(1, owner.userId);
    expect(ownerShiftId).not.toBe(cashierShiftId);

    // إنشاء سند معلق يدوياً في القاعدة (يحاكي سنداً أنشأه الكاشير في نظامه وكان معلقاً)
    const [insertResult] = await db().insert(s.receipts).values({
      branchId: 1,
      direction: "IN",
      amount: "75000.00",
      paymentMethod: "CASH",
      partyType: "OTHER",
      partyId: null,
      counterpartyName: "إيراد استنساخ معلق",
      voucherCategoryId: 11,
      description: "إيراد معلق للتجربة",
      voucherNumber: "RV-1-20260924-99999",
      status: "PENDING",
      approvalStatus: "PENDING_APPROVAL",
      cashBucket: null,
      shiftId: null,
      createdBy: cashier.userId, // أنشأه الكاشير
    });
    const pendingReceiptId = Number((insertResult as any).insertId);

    // المالك يقوم بالاعتماد
    await approveVoucher(pendingReceiptId, owner);

    // التحقق: النقد دخل في وردية ودرج الكاشير (createdBy)، ولم يدخل وردية المالك مطلقاً!
    const approvedReceipt = (await db().select().from(s.receipts).where(eq(s.receipts.id, pendingReceiptId)))[0];
    expect(approvedReceipt.status).toBe("COMPLETED");
    expect(approvedReceipt.approvalStatus).toBe("APPROVED");
    expect(approvedReceipt.approvedBy).toBe(owner.userId);
    expect(approvedReceipt.cashBucket).toBe("DRAWER");
    expect(approvedReceipt.shiftId).toBe(cashierShiftId); // وردية الكاشير وليس ownerShiftId!
    expect(approvedReceipt.shiftId).not.toBe(ownerShiftId);

    // وقيد المحاسبة منسوب للكاشير الذي استلم النقد في دروجه
    const entries = await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.receiptId, pendingReceiptId));
    expect(entries).toHaveLength(1);
    expect(entries[0].createdBy).toBe(cashier.userId);
  });

  it("عند اعتماد سند قبض بطاقة معلق: لا يحجز وردية المالك ولا ينسب درجا نقديا للمالك", async () => {
    await openShift(1, owner.userId);

    const [insertResult] = await db().insert(s.receipts).values({
      branchId: 1,
      direction: "IN",
      amount: "30000.00",
      paymentMethod: "CARD",
      cardLastFour: "1234",
      partyType: "OTHER",
      partyId: null,
      counterpartyName: "زبون بطاقة معلق",
      voucherCategoryId: 11,
      description: "سند بطاقة معلق للتجربة",
      voucherNumber: "RV-1-20260924-88888",
      status: "PENDING",
      approvalStatus: "PENDING_APPROVAL",
      cashBucket: null,
      shiftId: null,
      createdBy: cashier.userId,
    });
    const pendingReceiptId = Number((insertResult as any).insertId);

    await approveVoucher(pendingReceiptId, owner);

    const approvedReceipt = (await db().select().from(s.receipts).where(eq(s.receipts.id, pendingReceiptId)))[0];
    expect(approvedReceipt.status).toBe("COMPLETED");
    expect(approvedReceipt.approvalStatus).toBe("APPROVED");
    expect(approvedReceipt.cashBucket).toBeNull();
    expect(approvedReceipt.shiftId).toBeNull();
  });
});
