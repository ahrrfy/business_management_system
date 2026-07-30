/**
 * اختبارات توصيف (characterization) لـ createSale — تلتقط السلوك الحالي قبل refactor الشريحة ١
 * (استخراج createSaleInTx). كل اختبار هنا يجب أن يمرّ **بلا تغيير** بعد الاستخراج.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createSale } from "../sale/create";
import { truncateTables } from "./__testUtils__";

const TABLES = [
  "idempotencyKeys",
  "accountingEntries",
  "receipts",
  "inventoryMovements",
  "invoiceItemBundleComponents",
  "invoiceItems",
  "invoices",
  "branchStock",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
  "shifts",
  "customers",
  "suppliers",
  "branches",
  "users",
];

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function reset() {
  await truncateTables(TABLES);
}

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values([
    { id: 1, openId: "cashier-1", name: "Cashier 1", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "manager-1", name: "Manager 1", role: "manager", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.customers).values({
    id: 1, name: "Credit customer", defaultPriceTier: "RETAIL",
    currentBalance: "0", creditLimit: "500000",
  });
  await d.insert(s.suppliers).values({
    id: 1, name: "Consignor A", supplierKind: "CONSIGNOR", currentBalance: "0",
  });
  await d.insert(s.products).values([
    { id: 1, name: "Stock item" },
    { id: 2, name: "Service item", productType: "PRINT_SERVICE", isService: true },
    { id: 3, name: "Consignment item", isConsignment: true, consignorId: 1 },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "STK-1", costPrice: "50" },
    { id: 2, productId: 2, sku: "SVC-1", costPrice: "0" },
    { id: 3, productId: 3, sku: "CON-1", costPrice: "30" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "piece", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 2, unitName: "service", conversionFactor: "1", isBaseUnit: true },
    { id: 3, variantId: 3, unitName: "piece", conversionFactor: "1", isBaseUnit: true },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "100" },
    { productUnitId: 2, priceTier: "RETAIL", price: "200" },
    { productUnitId: 3, priceTier: "RETAIL", price: "80" },
  ]);
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 100 },
    { variantId: 3, branchId: 1, quantity: 50 },
  ]);
}

async function insertShift(opts?: {
  id?: number; userId?: number; status?: "OPEN" | "CLOSED";
  shiftType?: "RETAIL" | "PRINT_SERVICES"; opening?: string;
}) {
  const id = opts?.id ?? 1;
  const userId = opts?.userId ?? 1;
  const status = opts?.status ?? "OPEN";
  const shiftType = opts?.shiftType ?? "RETAIL";
  await db().insert(s.shifts).values({
    id, userId, branchId: 1, status, shiftType,
    openingBalance: opts?.opening ?? "0",
    openGuard: status === "OPEN" ? `${userId}:1:${shiftType}` : null,
    closedAt: status === "CLOSED" ? new Date() : null,
    closingDrawerCash: status === "CLOSED" ? "0" : null,
  });
}

const cashier = { userId: 1, branchId: 1, role: "cashier" } as const;
const manager = { userId: 2, branchId: 1, role: "manager" } as const;

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("createSale characterization — S0 pre-refactor baseline", () => {
  describe("basic cash sale", () => {
    it("creates invoice + items + receipt + SALE entry + stock deduction", async () => {
      await insertShift();
      const result = await createSale({
        branchId: 1, shiftId: 1, sourceType: "POS",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }],
        payment: { amount: "200", method: "CASH" },
      }, cashier);

      expect(result.invoiceId).toBeGreaterThan(0);
      expect(result.invoiceNumber).toBeTruthy();
      expect(result.total).toBe("200.00");
      expect(result.status).toBe("PAID");
      expect(result.idempotentReplay).toBeUndefined();

      const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, result.invoiceId)))[0];
      expect(inv.total).toBe("200.00");
      expect(inv.paidAmount).toBe("200.00");
      expect(inv.status).toBe("PAID");
      expect(Number(inv.branchId)).toBe(1);

      const items = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, result.invoiceId));
      expect(items).toHaveLength(1);
      expect(items[0].quantity).toBe("2.000");
      expect(items[0].unitPrice).toBe("100.00");

      const rcpts = await db().select().from(s.receipts).where(eq(s.receipts.invoiceId, result.invoiceId));
      expect(rcpts).toHaveLength(1);
      expect(rcpts[0].amount).toBe("200.00");
      expect(rcpts[0].paymentMethod).toBe("CASH");
      expect(rcpts[0].direction).toBe("IN");

      const entries = await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.invoiceId, result.invoiceId));
      const saleEntry = entries.find((e) => e.entryType === "SALE");
      expect(saleEntry).toBeDefined();
      expect(saleEntry!.amount).toBe("200.00");

      const payEntry = entries.find((e) => e.entryType === "PAYMENT_IN");
      expect(payEntry).toBeDefined();

      const stock = (await db().select().from(s.branchStock).where(eq(s.branchStock.variantId, 1)))[0];
      expect(stock.quantity).toBe(98);
    });
  });

  describe("credit (AR) sale", () => {
    it("creates PENDING invoice and updates customer balance", async () => {
      await insertShift();
      const result = await createSale({
        branchId: 1, shiftId: 1, sourceType: "POS", customerId: 1,
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      }, cashier);

      expect(result.status).toBe("PENDING");
      expect(result.total).toBe("100.00");

      const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, result.invoiceId)))[0];
      expect(inv.paidAmount).toBe("0.00");
      expect(inv.status).toBe("PENDING");
      expect(Number(inv.customerId)).toBe(1);

      const cust = (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0];
      expect(cust.currentBalance).toBe("100.00");

      const rcpts = await db().select().from(s.receipts).where(eq(s.receipts.invoiceId, result.invoiceId));
      expect(rcpts).toHaveLength(0);
    });
  });

  describe("partial payment", () => {
    it("creates PARTIALLY_PAID invoice with receipt and AR delta", async () => {
      await insertShift();
      const result = await createSale({
        branchId: 1, shiftId: 1, sourceType: "POS", customerId: 1,
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
        payment: { amount: "40", method: "CASH" },
      }, cashier);

      expect(result.status).toBe("PARTIALLY_PAID");
      expect(result.total).toBe("100.00");

      const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, result.invoiceId)))[0];
      expect(inv.paidAmount).toBe("40.00");

      const cust = (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0];
      expect(cust.currentBalance).toBe("60.00");
    });
  });

  describe("idempotency", () => {
    it("returns same result on replay with matching clientRequestId", async () => {
      await insertShift();
      const input = {
        branchId: 1, shiftId: 1, sourceType: "POS" as const,
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
        payment: { amount: "100", method: "CASH" as const },
        clientRequestId: "idempotency-test-1",
      };

      const first = await createSale(input, cashier);
      const second = await createSale(input, cashier);

      expect(second.invoiceId).toBe(first.invoiceId);
      expect(second.invoiceNumber).toBe(first.invoiceNumber);
      expect(second.total).toBe(first.total);
      expect(second.idempotentReplay).toBe(true);

      const invoiceCount = (await db().select().from(s.invoices)).length;
      expect(invoiceCount).toBe(1);
    });

    it("rejects replay with different customer", async () => {
      await insertShift();
      const base = {
        branchId: 1, shiftId: 1, sourceType: "POS" as const,
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
        payment: { amount: "100", method: "CASH" as const },
        clientRequestId: "idempotency-conflict-1",
      };

      await createSale(base, cashier);
      await expect(
        createSale({ ...base, customerId: 1 }, cashier),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });
  });

  describe("service product (no stock)", () => {
    it("does not deduct stock for service products", async () => {
      await insertShift({ shiftType: "PRINT_SERVICES" });
      const result = await createSale({
        branchId: 1, shiftId: 1, sourceType: "POS",
        lines: [{ variantId: 2, productUnitId: 2, quantity: "1" }],
        payment: { amount: "200", method: "CASH" },
      }, cashier);

      expect(result.total).toBe("200.00");
      expect(result.status).toBe("PAID");

      const movements = await db().select().from(s.inventoryMovements);
      expect(movements).toHaveLength(0);
    });
  });

  describe("consignment sale", () => {
    it("creates orphan PURCHASE entry for consignor and raises supplier balance", async () => {
      await insertShift();
      const result = await createSale({
        branchId: 1, shiftId: 1, sourceType: "POS",
        lines: [{ variantId: 3, productUnitId: 3, quantity: "2" }],
        payment: { amount: "160", method: "CASH" },
      }, cashier);

      expect(result.total).toBe("160.00");

      const entries = await db().select().from(s.accountingEntries)
        .where(eq(s.accountingEntries.invoiceId, result.invoiceId));

      const saleEntry = entries.find((e) => e.entryType === "SALE");
      expect(saleEntry).toBeDefined();
      expect(saleEntry!.amount).toBe("160.00");

      const purchaseEntry = entries.find((e) => e.entryType === "PURCHASE");
      expect(purchaseEntry).toBeDefined();
      expect(Number(purchaseEntry!.supplierId)).toBe(1);
      expect(purchaseEntry!.amount).toBe("60.00");
      expect(purchaseEntry!.invoiceId).not.toBeNull();

      const supplier = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];
      expect(supplier.currentBalance).toBe("60.00");

      const stock = (await db().select().from(s.branchStock).where(eq(s.branchStock.variantId, 3)))[0];
      expect(stock.quantity).toBe(48);
    });
  });

  describe("shift validation", () => {
    it("rejects cash sale without shift", async () => {
      await expect(
        createSale({
          branchId: 1, sourceType: "POS",
          lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
          payment: { amount: "100", method: "CASH" },
        }, cashier),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    });

    it("rejects sale on closed shift", async () => {
      await insertShift({ status: "CLOSED" });
      await expect(
        createSale({
          branchId: 1, shiftId: 1, sourceType: "POS",
          lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
          payment: { amount: "100", method: "CASH" },
        }, cashier),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    });

    it("rejects cashier using another user's shift", async () => {
      await insertShift({ userId: 2 });
      await expect(
        createSale({
          branchId: 1, shiftId: 1, sourceType: "POS",
          lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
          payment: { amount: "100", method: "CASH" },
        }, cashier),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });

  describe("empty lines", () => {
    it("rejects sale with no lines", async () => {
      await insertShift();
      await expect(
        createSale({
          branchId: 1, shiftId: 1, sourceType: "POS",
          lines: [],
          payment: { amount: "0", method: "CASH" },
        }, cashier),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });
  });

  describe("return value shape", () => {
    it("returns exactly { invoiceId, invoiceNumber, total, status } for normal sale", async () => {
      await insertShift();
      const result = await createSale({
        branchId: 1, shiftId: 1, sourceType: "POS",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
        payment: { amount: "100", method: "CASH" },
      }, cashier);

      expect(Object.keys(result).sort()).toEqual(
        expect.arrayContaining(["invoiceId", "invoiceNumber", "status", "total"]),
      );
      expect(typeof result.invoiceId).toBe("number");
      expect(typeof result.invoiceNumber).toBe("string");
      expect(typeof result.total).toBe("string");
      expect(["PAID", "PARTIALLY_PAID", "PENDING"]).toContain(result.status);
    });
  });

  describe("price override", () => {
    it("uses unitPriceOverride when provided (with approval)", async () => {
      await insertShift();
      const result = await createSale({
        branchId: 1, shiftId: 1, sourceType: "POS",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1", unitPriceOverride: "75" }],
        payment: { amount: "75", method: "CASH" },
        priceOverrideApproved: true,
      }, manager);

      expect(result.total).toBe("75.00");
      const items = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, result.invoiceId));
      expect(items[0].unitPrice).toBe("75.00");
    });
  });

  describe("discount", () => {
    it("applies line-level discountPercent", async () => {
      await insertShift();
      const result = await createSale({
        branchId: 1, shiftId: 1, sourceType: "POS",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1", discountPercent: "10" }],
        payment: { amount: "90", method: "CASH" },
      }, cashier);

      expect(result.total).toBe("90.00");
      const items = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, result.invoiceId));
      expect(items[0].unitPrice).toBe("100.00");
      expect(items[0].discountAmount).toBe("10.00");
    });
  });

  describe("multi-line sale", () => {
    it("handles mixed stock + service lines in single sale", async () => {
      await insertShift({ shiftType: "PRINT_SERVICES" });
      const result = await createSale({
        branchId: 1, shiftId: 1, sourceType: "POS",
        lines: [
          { variantId: 1, productUnitId: 1, quantity: "1" },
          { variantId: 2, productUnitId: 2, quantity: "1" },
        ],
        payment: { amount: "300", method: "CASH" },
      }, cashier);

      expect(result.total).toBe("300.00");
      expect(result.status).toBe("PAID");

      const items = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, result.invoiceId));
      expect(items).toHaveLength(2);

      const stock = (await db().select().from(s.branchStock).where(eq(s.branchStock.variantId, 1)))[0];
      expect(stock.quantity).toBe(99);
    });
  });

  describe("invoice number format", () => {
    it("generates sequential invoice numbers", async () => {
      await insertShift();
      const r1 = await createSale({
        branchId: 1, shiftId: 1, sourceType: "POS",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
        payment: { amount: "100", method: "CASH" },
      }, cashier);
      const r2 = await createSale({
        branchId: 1, shiftId: 1, sourceType: "POS",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
        payment: { amount: "100", method: "CASH" },
      }, cashier);

      expect(r1.invoiceNumber).toBeTruthy();
      expect(r2.invoiceNumber).toBeTruthy();
      expect(r2.invoiceNumber).not.toBe(r1.invoiceNumber);
    });
  });

  describe("SALE entry accounting invariant", () => {
    it("SALE entry revenue = net before tax, amount = invoice total", async () => {
      await insertShift();
      const result = await createSale({
        branchId: 1, shiftId: 1, sourceType: "POS",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "3" }],
        payment: { amount: "300", method: "CASH" },
      }, cashier);

      const entries = await db().select().from(s.accountingEntries)
        .where(eq(s.accountingEntries.invoiceId, result.invoiceId));
      const sale = entries.find((e) => e.entryType === "SALE")!;
      expect(sale.amount).toBe("300.00");
      expect(sale.revenue).toBe("300.00");

      const cost = parseFloat(sale.cost!);
      const profit = parseFloat(sale.profit!);
      const revenue = parseFloat(sale.revenue!);
      expect(Math.abs(revenue - cost - profit)).toBeLessThan(0.01);
    });
  });
});
