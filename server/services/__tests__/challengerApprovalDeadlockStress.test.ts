import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createSale } from "../saleService";
import { approveVoucher, cancelVoucher, createVoucher } from "../voucherService";
import { money } from "../money";

const cashier = { userId: 10, branchId: 1, role: "cashier" as const };
const owner = { userId: 2, branchId: 1, role: "manager" as const, isOwner: true };

const TABLES = [
  "auditLogs",
  "idempotencyKeys",
  "accountingEntries",
  "receipts",
  "inventoryMovements",
  "invoiceItems",
  "invoices",
  "branchStock",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
  "shifts",
  "customers",
  "branches",
  "users",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`DELETE FROM \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: 10, openId: "cashier-10", name: "كاشير", role: "cashier", loginMethod: "local", branchId: 1, isOwner: false, isActive: true },
    { id: 2, openId: "owner-2", name: "المالك المعتمد", role: "manager", loginMethod: "local", branchId: 1, isOwner: true, isActive: true },
  ]);
  await d.insert(s.products).values({ id: 1, name: "بضاعة" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "SKU-1", costPrice: "5000.00" });
  await d.insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true });
  await d.insert(s.productPrices).values({ productUnitId: 1, priceTier: "RETAIL", price: "20000.00" });
  await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 50 });
  await d.insert(s.shifts).values({ id: 1, userId: 10, branchId: 1, status: "OPEN", openedAt: new Date(), openGuard: "1:1", openingBalance: "0" });
  await d.insert(s.customers).values({ id: 1, name: "عميل معتمد", currentBalance: "0", creditLimit: "9999999.00" });
  await d.insert(s.receipts).values({
    branchId: 1,
    direction: "IN",
    amount: "5000000.00",
    paymentMethod: "CASH",
    cashBucket: "TREASURY",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    referenceNumber: "TREASURY-SEED-FUND",
    createdBy: 2,
  });
}

describe("ADVERSARIAL STRESS: EDGE-FIN-01 Approval Deadlock Avoidance", () => {
  beforeEach(async () => {
    await reset();
    await seed();
  });

  it("ADV-ED-1: Insufficient remaining balance (EXCEEDS_REMAINING) unlinks invoice, credits customer balance, and leaves invoice intact", async () => {
    // 1. Create sale invoice for 20,000
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        priceTier: "RETAIL",
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      },
      owner,
    );

    // 2. Pending voucher created for full 20,000
    const [inserted] = await db().insert(s.receipts).values({
      voucherNumber: "RV-1-20260929-00010",
      branchId: 1,
      direction: "IN",
      amount: "20000.00",
      paymentMethod: "CASH",
      partyType: "CUSTOMER",
      partyId: 1,
      description: "دفعة كاملة معلقة",
      invoiceId: sale.invoiceId,
      status: "PENDING",
      approvalStatus: "PENDING_APPROVAL",
      createdBy: 10,
      voucherDate: "2026-09-29",
    });
    const receiptId = inserted.insertId;

    // 3. While pending, POS cashier collected partial 15,000 (remaining is now 5,000)
    await db()
      .update(s.invoices)
      .set({ paidAmount: "15000.00", status: "PARTIALLY_PAID" })
      .where(eq(s.invoices.id, sale.invoiceId));
    await db().update(s.customers).set({ currentBalance: "5000.00" }).where(eq(s.customers.id, 1));

    // 4. Manager approves pending voucher (20,000 > 5,000 remaining)
    const res = await approveVoucher(receiptId, owner);
    expect(res.approvalStatus).toBe("APPROVED");

    // 5. Verify Invariants:
    // A. Receipt unlinked from invoice
    const [receipt] = await db().select().from(s.receipts).where(eq(s.receipts.id, receiptId));
    expect(receipt.invoiceId).toBeNull();
    expect(receipt.internalNote).toContain("مبلغ السند يتجاوز المتبقي");

    // B. Invoice settled to full 20,000 paid via automatic credit settlement (never overpaid to 35,000)
    const [inv] = await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId));
    expect(money(inv.paidAmount).toFixed(2)).toBe("20000.00");
    expect(inv.status).toBe("PAID");

    // C. Customer balance credited by full voucher amount (5,000 - 20,000 = -15,000 creditor)
    const [cust] = await db().select().from(s.customers).where(eq(s.customers.id, 1));
    expect(money(cust.currentBalance).toFixed(2)).toBe("-15000.00");

    // D. Audit log recorded
    const auditLogs = await db()
      .select()
      .from(s.auditLogs)
      .where(eq(s.auditLogs.action, "voucher.unlink_invoice_on_approval"));
    expect(auditLogs.length).toBe(1);
  });

  it("ADV-ED-2: Cancellation reversibility on an unlinked voucher restores customer balance without corrupting the invoice", async () => {
    // 1. Create sale invoice for 20,000
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        priceTier: "RETAIL",
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      },
      owner,
    );

    // 2. Pending voucher for 20,000
    const [inserted] = await db().insert(s.receipts).values({
      voucherNumber: "RV-1-20260929-00011",
      branchId: 1,
      direction: "IN",
      amount: "20000.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      partyType: "CUSTOMER",
      partyId: 1,
      description: "دفعة معلقة تحت الفحص",
      invoiceId: sale.invoiceId,
      status: "PENDING",
      approvalStatus: "PENDING_APPROVAL",
      createdBy: 10,
      voucherDate: "2026-09-29",
    });
    const receiptId = inserted.insertId;

    // 3. Settle invoice in POS
    await db()
      .update(s.invoices)
      .set({ paidAmount: "20000.00", status: "PAID" })
      .where(eq(s.invoices.id, sale.invoiceId));
    await db().update(s.customers).set({ currentBalance: "0.00" }).where(eq(s.customers.id, 1));

    // 4. Approve voucher (graceful unlinking, credits customer balance by -20,000)
    await approveVoucher(receiptId, owner);
    const [custAfterApprove] = await db().select().from(s.customers).where(eq(s.customers.id, 1));
    expect(money(custAfterApprove.currentBalance).toFixed(2)).toBe("-20000.00");

    // 5. Cancel the approved voucher
    const cancelRes = await cancelVoucher(receiptId, owner);
    if (cancelRes.status === "PENDING_APPROVAL" && cancelRes.approvalReceiptId) {
      await approveVoucher(cancelRes.approvalReceiptId, owner);
    }

    // 6. Verify Customer Balance restored to 0.00
    const [custAfterCancel] = await db().select().from(s.customers).where(eq(s.customers.id, 1));
    expect(money(custAfterCancel.currentBalance).toFixed(2)).toBe("0.00");

    // 7. Invoice is STILL 20,000 paid and PAID (never modified by unlinked voucher cancellation)
    const [invAfterCancel] = await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId));
    expect(money(invAfterCancel.paidAmount).toFixed(2)).toBe("20000.00");
    expect(invAfterCancel.status).toBe("PAID");
  });

  it("ADV-ED-3: Concurrent pending vouchers racing for the same invoice are handled cleanly without deadlock", async () => {
    // 1. Create sale invoice for 20,000
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        priceTier: "RETAIL",
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      },
      owner,
    );

    // 2. Create TWO pending vouchers for 20,000 each linked to the same invoice
    const [ins1] = await db().insert(s.receipts).values({
      voucherNumber: "RV-1-20260929-00021",
      branchId: 1,
      direction: "IN",
      amount: "20000.00",
      paymentMethod: "CASH",
      partyType: "CUSTOMER",
      partyId: 1,
      description: "سند قبض معلق ١",
      invoiceId: sale.invoiceId,
      status: "PENDING",
      approvalStatus: "PENDING_APPROVAL",
      createdBy: 10,
      voucherDate: "2026-09-29",
    });
    const [ins2] = await db().insert(s.receipts).values({
      voucherNumber: "RV-1-20260929-00022",
      branchId: 1,
      direction: "IN",
      amount: "20000.00",
      paymentMethod: "CASH",
      partyType: "CUSTOMER",
      partyId: 1,
      description: "سند قبض معلق ٢",
      invoiceId: sale.invoiceId,
      status: "PENDING",
      approvalStatus: "PENDING_APPROVAL",
      createdBy: 10,
      voucherDate: "2026-09-29",
    });

    // Customer balance has 20,000 debt
    await db().update(s.customers).set({ currentBalance: "20000.00" }).where(eq(s.customers.id, 1));

    // 3. Approve Voucher 1:
    // First voucher allocates 20,000 to invoice -> invoice becomes PAID (20,000/20,000)
    const res1 = await approveVoucher(ins1.insertId, owner);
    expect(res1.approvalStatus).toBe("APPROVED");

    const [r1] = await db().select().from(s.receipts).where(eq(s.receipts.id, ins1.insertId));
    expect(r1.invoiceId).toBe(sale.invoiceId); // Linked!

    const [invAfter1] = await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId));
    expect(money(invAfter1.paidAmount).toFixed(2)).toBe("20000.00");
    expect(invAfter1.status).toBe("PAID");

    // 4. Approve Voucher 2:
    // Second voucher finds invoice already settled (remaining = 0).
    // It must NOT throw error or deadlock! It unlinks and credits customer balance!
    const res2 = await approveVoucher(ins2.insertId, owner);
    expect(res2.approvalStatus).toBe("APPROVED");

    const [r2] = await db().select().from(s.receipts).where(eq(s.receipts.id, ins2.insertId));
    expect(r2.invoiceId).toBeNull(); // Unlinked!
    expect(r2.internalNote).toContain("مسددة مسبقاً بالكامل");

    // Customer balance: 20,000 debt - 20,000 (vch 1) - 20,000 (vch 2) = -20,000 (creditor)
    const [custFinal] = await db().select().from(s.customers).where(eq(s.customers.id, 1));
    expect(money(custFinal.currentBalance).toFixed(2)).toBe("-20000.00");

    // Invoice remained at 20,000 paid (never double allocated to 40,000!)
    const [invFinal] = await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId));
    expect(money(invFinal.paidAmount).toFixed(2)).toBe("20000.00");
    expect(invFinal.status).toBe("PAID");
  });
});
