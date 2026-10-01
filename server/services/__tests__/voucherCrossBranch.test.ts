import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createSale } from "../saleService";
import { createVoucher } from "../voucherService";
import { allocateVoucherToInvoiceTx } from "../voucher/invoiceAllocation";
import { money } from "../money";

const adminBranch1 = { userId: 1, branchId: 1, role: "admin" as const };
const adminBranch2 = { userId: 2, branchId: 2, role: "admin" as const };

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
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع الكرخ", code: "KARKH", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "admin_1", name: "أدمن 1", role: "admin", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "admin_2", name: "أدمن 2", role: "admin", loginMethod: "local", branchId: 2 },
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
    { id: 2, userId: 2, branchId: 2, status: "OPEN", openedAt: new Date(), openGuard: "2:2", openingBalance: "0" },
  ]);
  await d.insert(s.customers).values({ id: 1, name: "شركة الأفق", currentBalance: "0", creditLimit: "9999999.00" });
}

describe("VULN-FIN-02: حظر سداد فاتورة فرع آخر بسند قبض محلي", () => {
  beforeEach(async () => {
    await reset();
    await seed();
  });

  it("يرفض إنشاء سند قبض في الفرع ٢ لفاتورة تابعة للفرع ١", async () => {
    // إصدار فاتورة آجلة في الفرع ١
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        priceTier: "RETAIL",
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }], // إجمالي: 10,000
      },
      adminBranch1,
    );

    // محاولة إنشاء سند قبض من الفرع ٢ على فاتورة الفرع ١
    await expect(
      createVoucher(
        {
          voucherType: "RECEIPT",
          branchId: 2,
          amount: "5000.00",
          paymentMethod: "CASH",
          partyType: "CUSTOMER",
          partyId: 1,
          description: "سداد عبر فرع الكرخ",
          invoiceId: sale.invoiceId,
          clientRequestId: "cross-branch-test-1",
        } as never,
        adminBranch2,
      ),
    ).rejects.toThrow(/لا يمكن سداد فاتورة فرع آخر بسند قبض محلي/);

    // التحقق من بقاء حالة الفاتورة ورصيد الفرع دون أي تعديل
    const [inv] = await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId));
    expect(money(inv.paidAmount).toFixed(2)).toBe("0.00");
    expect(inv.status).toBe("PENDING");
  });

  it("يسمح بإنشاء سند قبض في نفس فرع الفاتورة (الفرع ١)", async () => {
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        priceTier: "RETAIL",
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }], // إجمالي: 5,000
      },
      adminBranch1,
    );

    const res = await createVoucher(
      {
        voucherType: "RECEIPT",
        branchId: 1,
        amount: "5000.00",
        paymentMethod: "CASH",
        partyType: "CUSTOMER",
        partyId: 1,
        description: "سداد محلي سليم",
        invoiceId: sale.invoiceId,
        clientRequestId: "same-branch-test-1",
      } as never,
      adminBranch1,
    );

    expect(res.approvalStatus).toBe("APPROVED");
    const [inv] = await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId));
    expect(money(inv.paidAmount).toFixed(2)).toBe("5000.00");
    expect(inv.status).toBe("PAID");
  });

  it("بوابة allocateVoucherToInvoiceTx ترفض التخصيص عند اختلاف الفرع تحت القفل", async () => {
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
      db().transaction(async (tx) => {
        await allocateVoucherToInvoiceTx(tx, {
          invoiceId: sale.invoiceId,
          amount: money("5000.00"),
          direction: "IN",
          voucherBranchId: 2,
        });
      }),
    ).rejects.toThrow(/لا يمكن سداد فاتورة فرع آخر بسند قبض محلي/);
  });
});
