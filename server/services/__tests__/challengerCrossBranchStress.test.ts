import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createSale } from "../saleService";
import { approveVoucher, createVoucher } from "../voucherService";
import { allocateVoucherToInvoiceTx } from "../voucher/invoiceAllocation";
import { money } from "../money";

const adminBranch1 = { userId: 1, branchId: 1, role: "admin" as const };
const adminBranch2 = { userId: 3, branchId: 2, role: "admin" as const };
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
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع الكرخ", code: "KARKH", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "admin_1", name: "أدمن 1", role: "admin", loginMethod: "local", branchId: 1, isActive: true },
    { id: 2, openId: "owner_1", name: "المالك 1", role: "manager", loginMethod: "local", branchId: 1, isOwner: true, isActive: true },
    { id: 3, openId: "admin_2", name: "أدمن 2", role: "admin", loginMethod: "local", branchId: 2, isActive: true },
  ]);
  await d.insert(s.products).values({ id: 1, name: "منتج تجريبي" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "PRD-1", costPrice: "1000.00" });
  await d.insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true });
  await d.insert(s.productPrices).values({ productUnitId: 1, priceTier: "RETAIL", price: "5000.00" });
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 100 },
    { variantId: 1, branchId: 2, quantity: 100 },
  ]);
  await d.insert(s.shifts).values([
    { id: 1, userId: 1, branchId: 1, status: "OPEN", openedAt: new Date(), openGuard: "1:1", openingBalance: "0" },
    { id: 2, userId: 3, branchId: 2, status: "OPEN", openedAt: new Date(), openGuard: "3:2", openingBalance: "0" },
  ]);
  await d.insert(s.customers).values({ id: 1, name: "شركة الأفق", currentBalance: "0", creditLimit: "9999999.00" });
}

describe("ADVERSARIAL STRESS: VULN-FIN-02 Cross-Branch Voucher Isolation", () => {
  beforeEach(async () => {
    await reset();
    await seed();
  });

  it("ADV-CB-1: Rejects cross-branch receipt across all payment methods (CASH, CARD, TRANSFER)", async () => {
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        priceTier: "RETAIL",
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }], // Total: 10,000 in Branch 1
      },
      adminBranch1,
    );

    const methods: ("CASH" | "CARD" | "TRANSFER")[] = ["CASH", "CARD", "TRANSFER"];

    for (const method of methods) {
      await expect(
        createVoucher(
          {
            voucherType: "RECEIPT",
            branchId: 2, // Voucher in Branch 2
            amount: "2000.00",
            paymentMethod: method,
            partyType: "CUSTOMER",
            partyId: 1,
            description: `سداد ${method} من فرع ٢`,
            invoiceId: sale.invoiceId, // Invoice in Branch 1
            clientRequestId: `req-${method}-fail`,
            referenceNumber: method === "TRANSFER" ? "TX-REF-999" : undefined,
            cardLastFour: method === "CARD" ? "1234" : undefined,
          } as never,
          adminBranch2,
        ),
      ).rejects.toThrow(/لا يمكن سداد فاتورة فرع آخر بسند قبض محلي/);
    }

    // Invoice remains unaffected
    const [inv] = await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId));
    expect(money(inv.paidAmount).toFixed(2)).toBe("0.00");
    expect(inv.status).toBe("PENDING");
  });

  it("ADV-CB-2: Rejects cross-branch disbursement/payment voucher (direction OUT)", async () => {
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        priceTier: "RETAIL",
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      },
      adminBranch1,
    );

    await expect(
      createVoucher(
        {
          voucherType: "PAYMENT",
          branchId: 2,
          amount: "1000.00",
          paymentMethod: "CASH",
          partyType: "CUSTOMER",
          partyId: 1,
          description: "صرف من فرع ٢ لفاتورة فرع ١",
          invoiceId: sale.invoiceId,
          clientRequestId: "req-payment-out-fail",
        } as never,
        adminBranch2,
      ),
    ).rejects.toThrow(/لا يمكن سداد فاتورة فرع آخر بسند قبض محلي/);
  });

  it("ADV-CB-3: allocateVoucherToInvoiceTx blocks cross-branch allocation under row lock unless explicit clearing authorized", async () => {
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        priceTier: "RETAIL",
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      },
      adminBranch1,
    );

    // Standard cross-branch allocation without authorization: MUST throw
    await expect(
      db().transaction(async (tx) => {
        await allocateVoucherToInvoiceTx(tx, {
          invoiceId: sale.invoiceId,
          amount: money("5000.00"),
          direction: "IN",
          voucherBranchId: 2,
        });
      }),
    ).rejects.toThrow(/لا يمكن سداد فاتورة فرع آخر بسند قبض محلي/);

    // Explicit inter-branch clearing: allowed when authorized
    await db().transaction(async (tx) => {
      const res = await allocateVoucherToInvoiceTx(tx, {
        invoiceId: sale.invoiceId,
        amount: money("5000.00"),
        direction: "IN",
        voucherBranchId: 2,
        allowInterBranchClearing: true,
      });
      expect(res.allocated).toBe(true);
      expect(money(res.paidAmount).toFixed(2)).toBe("5000.00");
    });

    const [inv] = await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId));
    expect(money(inv.paidAmount).toFixed(2)).toBe("5000.00");
    expect(inv.status).toBe("PAID");
  });
});
