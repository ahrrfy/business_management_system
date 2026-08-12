import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { recordDeliveryRemittance } from "../delivery/remittance";
import { settleDeliveryBalance } from "../delivery/settle";
import { bounceCheck, cancelPlan, createPlan, getPlan, payLine } from "../installmentService";

const actor = { userId: 1, branchId: 1, role: "admin" };
const TABLES = [
  "deliveryOutbox", "deliveryEvents", "deliveryLedgerEntries", "deliveryRemittanceLines", "deliveryPartyMembers",
  "idempotencyKeys", "accountingEntries", "receipts", "deliveryConsignments",
  "deliveryRemittances", "deliveryParties", "installmentLines", "installmentPlans",
  "invoices", "shifts", "customers", "branches", "users",
];

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL is required");
  return value;
}

beforeEach(async () => {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of TABLES) await d.execute(sql.raw(`DELETE FROM \`${table}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "الثاني", code: "B2", type: "SALES" },
  ]);
  await d.insert(s.users).values({
    id: 1, openId: "fih-admin", name: "مدير", email: "fih@test.local", role: "admin", loginMethod: "local",
  });
  await d.insert(s.customers).values({
    id: 1, name: "عميل", currentBalance: "1000.00",
  });
  await d.insert(s.shifts).values({
    id: 1, branchId: 1, userId: 1, shiftType: "RECEPTION", status: "OPEN", openGuard: "1:1:RECEPTION",
  });
});

async function seedParty(balance = "100.00", branchId: number | null = 1) {
  await db().insert(s.deliveryParties).values({
    id: 1, partyType: "INDIVIDUAL", name: "مندوب", branchId, currentBalance: balance,
  });
}

async function seedConsignment(input?: { branchId?: number; fee?: string; feeCollection?: "COURIER" | "COUNTER" | "SHOP" }) {
  const branchId = input?.branchId ?? 1;
  await db().insert(s.invoices).values({
    id: 1, invoiceNumber: "FIH-INV-1", sourceType: "WORKORDER", branchId,
    subtotal: "100.00", total: "100.00", paidAmount: "0.00", status: "PENDING",
  });
  await db().insert(s.deliveryConsignments).values({
    id: 1, consignmentNumber: "FIH-CN-1", branchId, partyId: 1, invoiceId: 1,
    sourceType: "INVOICE", sourceId: 1,
    codAmount: "100.00", collectedAmount: "0.00", deliveryFee: input?.fee ?? "0.00",
    // 5/8: al-ujra tunqas min al-tawrid faqat 'inda COUNTER/SHOP (COURIER yaqbiduha min al-zabun).
    feeCollection: input?.feeCollection ?? "SHOP", status: "DISPATCHED",
    parcelStatus: "DELIVERED", moneyStatus: "UNSETTLED", courierDeliveredAt: new Date(), custodyRecognizedAt: new Date(),
  });
}

describe("حوكمة مصدر نقد التوصيل", () => {
  it("يرفض تسوية تتجاوز العهدة ولا ينشئ إيصالاً", async () => {
    await seedParty("100.00");
    await expect(
      settleDeliveryBalance({ branchId: 1, partyId: 1, amount: "750000.00" }, actor),
    ).rejects.toThrow(/يتجاوز عهدة/);
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    const [party] = await db().select().from(s.deliveryParties).where(eq(s.deliveryParties.id, 1));
    expect(party.currentBalance).toBe("100.00");
  });

  it("يرفض تكرار الإرسالية قبل مضاعفة النقد أو الذمة", async () => {
    await seedParty();
    await seedConsignment();
    await expect(recordDeliveryRemittance({
      branchId: 1,
      partyId: 1,
      countedCash: "200.00",
      lines: [
        { consignmentId: 1, collectedAmount: "100.00" },
        { consignmentId: 1, collectedAmount: "100.00" },
      ],
    }, actor)).rejects.toThrow(/تكرار الإرسالية/);
    expect(await db().select().from(s.receipts)).toHaveLength(0);
  });

  it("يرفض ترحيل إرسالية فرع آخر وأجرة أكبر من النقد المورّد", async () => {
    await seedParty("100.00", null);
    await seedConsignment({ branchId: 2 });
    await expect(recordDeliveryRemittance({
      branchId: 1, partyId: 1, countedCash: "100.00", lines: [{ consignmentId: 1, collectedAmount: "100.00" }],
    }, actor)).rejects.toThrow(/فرعاً آخر/);

    await db().delete(s.deliveryConsignments);
    await db().delete(s.invoices);
    // SHOP: al-maktaba tatahammal al-ujra ⇒ tunqas min al-tawrid ⇒ hares "akbar min al-naqd" hayy.
    await seedConsignment({ fee: "150.00", feeCollection: "SHOP" });
    const remittance = await recordDeliveryRemittance({
      branchId: 1, partyId: 1, countedCash: "100.00", lines: [{ consignmentId: 1, collectedAmount: "100.00" }],
    }, actor);
    expect(remittance.feesTotal).toBe("0.00");
    expect(remittance.netRemitted).toBe("100.00");
  });

  it("يرفض إعادة مفتاح التسوية بحمولة مالية مختلفة", async () => {
    await seedParty("100.00");
    await settleDeliveryBalance({
      branchId: 1, partyId: 1, amount: "50.00", clientRequestId: "fih-settle-1",
    }, actor);
    await expect(settleDeliveryBalance({
      branchId: 1, partyId: 1, amount: "40.00", clientRequestId: "fih-settle-1",
    }, actor)).rejects.toThrow(/بحمولةٍ مختلفة/);
  });
});

describe("حوكمة مصدر الأقساط والشيكات", () => {
  it("الخطة الإنتاجية تطابق متبقي الفاتورة وتمنع خطة نشطة ثانية", async () => {
    await db().insert(s.invoices).values({
      id: 10, invoiceNumber: "FIH-INST-10", sourceType: "POS", branchId: 1, customerId: 1,
      subtotal: "100.00", total: "100.00", paidAmount: "20.00", status: "PARTIALLY_PAID",
    });
    const input = {
      customerId: 1, invoiceId: 10, branchId: 1, totalAmount: "80.00", downPayment: "0.00",
      lines: [{ dueDate: "2026-08-01", amount: "80.00", kind: "CHECK" as const, checkNumber: "CHK-FIH" }],
      enforceFinancialIntegrity: true,
    };
    await createPlan(input, actor);
    await expect(createPlan(input, actor)).rejects.toThrow(/خطة أقساط نشطة/);
    await expect(createPlan({ ...input, invoiceId: 10, totalAmount: "70.00", lines: [
      { dueDate: "2026-08-01", amount: "70.00", kind: "CHECK", checkNumber: "CHK-2" },
    ] }, actor)).rejects.toThrow(/متبقي الفاتورة/);
  });

  it("لا يسمح بارتداد قسط CHECK إذا كان تحصيله الفعلي نقدياً", async () => {
    const { planId } = await createPlan({
      customerId: 1, branchId: 1, totalAmount: "100.00", downPayment: "0.00",
      lines: [{ dueDate: "2026-08-01", amount: "100.00", kind: "CHECK", checkNumber: "CHK-CASH" }],
    }, actor);
    const line = (await getPlan(planId)).lines[0];
    await payLine({ lineId: Number(line.id), paymentMethod: "CASH" }, actor);
    await expect(bounceCheck({ lineId: Number(line.id) }, actor)).rejects.toThrow(/لم يكن بشيك/);
  });

  it("يمنع إلغاء خطة لها سند تحصيل معتمد ولو بقي السطر PENDING", async () => {
    const { planId } = await createPlan({
      customerId: 1, branchId: 1, totalAmount: "100.00", downPayment: "0.00",
      lines: [{ dueDate: "2026-08-01", amount: "100.00", kind: "CHECK", checkNumber: "CHK-APP" }],
    }, actor);
    const line = (await getPlan(planId)).lines[0];
    const inserted = await db().insert(s.receipts).values({
      branchId: 1, direction: "IN", amount: "100.00", paymentMethod: "CHECK",
      status: "COMPLETED", approvalStatus: "APPROVED", partyType: "CUSTOMER", partyId: 1, createdBy: 1,
    });
    const receiptId = extractInsertId(inserted);
    await db().update(s.installmentLines).set({ receiptId }).where(eq(s.installmentLines.id, Number(line.id)));
    await expect(cancelPlan({ planId }, actor)).rejects.toThrow(/سند تحصيل معتمد/);
  });
});
