import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createPrintSale } from "../printSaleService";
import { createSale } from "../sale/create";
import { processPayment } from "../sale/payment";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

const ADMIN = { userId: 1, branchId: 1, role: "admin" } as const;
const MANAGER = { userId: 20, branchId: 1, role: "manager" } as const;
const CASHIER_1 = { userId: 10, branchId: 1, role: "cashier" } as const;
const CASHIER_2 = { userId: 11, branchId: 1, role: "cashier" } as const;
const CASHIER_BRANCH_2 = { userId: 21, branchId: 2, role: "cashier" } as const;

let seq = 0;
function reqId(prefix = "hijack-atk") {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}`;
}

async function seedBase() {
  const d = db();

  // 1. Branches
  await d.insert(s.branches).values([
    { id: 1, name: "MAIN BRANCH", code: "MAIN", type: "MAIN" },
    { id: 2, name: "SALES BRANCH", code: "SALES", type: "SALES" },
  ]);

  // 2. Users
  await d.insert(s.users).values([
    { id: 1, openId: "admin-1", name: "System Admin", role: "admin", loginMethod: "local", branchId: 1 },
    { id: 20, openId: "manager-1", name: "Branch Manager", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 10, openId: "cashier-1", name: "Cashier One", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 11, openId: "cashier-2", name: "Cashier Two", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 21, openId: "cashier-b2", name: "Branch 2 Cashier", role: "cashier", loginMethod: "local", branchId: 2 },
  ]);

  // 3. Customer
  await d.insert(s.customers).values({
    id: 1,
    name: "Regular Customer",
    defaultPriceTier: "RETAIL",
    currentBalance: "0",
    creditLimit: "1000000",
  });

  // 4. Products & Stock
  await d.insert(s.products).values([
    { id: 1, name: "Item Retail", productType: "STOCK_ITEM" },
    { id: 2, name: "Item Print Service", productType: "PRINT_SERVICE", isService: true },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "SKU-RETAIL-1", costPrice: "10" },
    { id: 2, productId: 2, sku: "SKU-PRINT-1", costPrice: "0" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "pc", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 2, unitName: "srv", conversionFactor: "1", isBaseUnit: true },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "5000" },
    { productUnitId: 2, priceTier: "RETAIL", price: "2500" },
  ]);
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 1000 },
    { variantId: 1, branchId: 2, quantity: 500 },
  ]);

  // 5. Initial Treasury Cash Float
  await d.insert(s.receipts).values({
    branchId: 1,
    direction: "IN",
    amount: "10000000.00",
    paymentMethod: "CASH",
    cashBucket: "TREASURY",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    referenceNumber: "TREASURY-FLOAT-TEST",
    createdBy: 1,
  });
}

async function insertShift(opts: {
  id: number;
  userId: number;
  branchId: number;
  status?: "OPEN" | "CLOSED";
  shiftType?: "RETAIL" | "PRINT_SERVICES";
  opening?: string;
  closing?: string | null;
}) {
  const status = opts.status ?? "OPEN";
  const shiftType = opts.shiftType ?? "RETAIL";
  await db()
    .insert(s.shifts)
    .values({
      id: opts.id,
      userId: opts.userId,
      branchId: opts.branchId,
      status,
      shiftType,
      openingBalance: opts.opening ?? "10000.00",
      openGuard: status === "OPEN" ? `${opts.userId}:${opts.branchId}:${shiftType}` : null,
      closedAt: status === "CLOSED" ? new Date() : null,
      closingDrawerCash: opts.closing ?? null,
    });
}

beforeEach(async () => {
  await seedBase();
});

describe("Shift Ownership Accountability & Anti-Hijacking Adversarial Suite", () => {
  it("rejects Admin attempt to record cash sale on Cashier's shift with FORBIDDEN and zero victim attribution", async () => {
    await insertShift({ id: 10, userId: CASHIER_1.userId, branchId: 1, status: "OPEN" });

    // Adversarial Action: Admin attempts to record a cash sale targeting Cashier 1's shift
    await expect(
      createSale(
        {
          branchId: 1,
          shiftId: 10,
          sourceType: "POS",
          lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }],
          payment: { amount: "10000", method: "CASH" },
          clientRequestId: reqId("admin-hijack-sale"),
        },
        ADMIN,
      ),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("لا تَستطيع التسجيل على وردية مستخدم آخر"),
    });

    // Verification: Zero invoices, zero drawer receipts attributed to shift 10
    const victimReceipts = await db()
      .select()
      .from(s.receipts)
      .where(and(eq(s.receipts.shiftId, 10), eq(s.receipts.cashBucket, "DRAWER")));
    expect(victimReceipts).toHaveLength(0);

    const invoices = await db().select().from(s.invoices);
    expect(invoices).toHaveLength(0);
  });

  it("rejects Cashier A attempt to record cash sale on Cashier B's shift with FORBIDDEN", async () => {
    await insertShift({ id: 10, userId: CASHIER_1.userId, branchId: 1, status: "OPEN" });

    // Adversarial Action: Cashier 2 tries to hijack Cashier 1's shift
    await expect(
      createSale(
        {
          branchId: 1,
          shiftId: 10,
          sourceType: "POS",
          lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
          payment: { amount: "5000", method: "CASH" },
          clientRequestId: reqId("cashier-hijack-sale"),
        },
        CASHIER_2,
      ),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("لا تَستطيع التسجيل على وردية مستخدم آخر"),
    });

    const victimReceipts = await db()
      .select()
      .from(s.receipts)
      .where(and(eq(s.receipts.shiftId, 10), eq(s.receipts.cashBucket, "DRAWER")));
    expect(victimReceipts).toHaveLength(0);
  });

  it("rejects Manager attempt to record cash sale on Cashier's shift with FORBIDDEN", async () => {
    await insertShift({ id: 10, userId: CASHIER_1.userId, branchId: 1, status: "OPEN" });

    // Adversarial Action: Manager attempts to record cash sale on Cashier 1's shift
    await expect(
      createSale(
        {
          branchId: 1,
          shiftId: 10,
          sourceType: "POS",
          lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
          payment: { amount: "5000", method: "CASH" },
          clientRequestId: reqId("manager-hijack-sale"),
        },
        MANAGER,
      ),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("لا تَستطيع التسجيل على وردية مستخدم آخر"),
    });

    const victimReceipts = await db()
      .select()
      .from(s.receipts)
      .where(and(eq(s.receipts.shiftId, 10), eq(s.receipts.cashBucket, "DRAWER")));
    expect(victimReceipts).toHaveLength(0);
  });

  it("rejects Manager attempt to record print cash sale on Cashier's shift with FORBIDDEN", async () => {
    await insertShift({ id: 10, userId: CASHIER_1.userId, branchId: 1, status: "OPEN", shiftType: "PRINT_SERVICES" });

    // Adversarial Action: Manager attempts print cash sale on Cashier 1's print shift
    await expect(
      createPrintSale(
        {
          branchId: 1,
          shiftId: 10,
          lines: [{ variantId: 2, productUnitId: 2, quantity: "1" }],
          payment: { amount: "2500", method: "CASH" },
        },
        MANAGER,
      ),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("لا تَستطيع التسجيل على وردية مستخدم آخر"),
    });

    const victimReceipts = await db()
      .select()
      .from(s.receipts)
      .where(and(eq(s.receipts.shiftId, 10), eq(s.receipts.cashBucket, "DRAWER")));
    expect(victimReceipts).toHaveLength(0);
  });

  it("rejects Admin attempt to record cash invoice payment on Cashier's shift with FORBIDDEN", async () => {
    await insertShift({ id: 10, userId: CASHIER_1.userId, branchId: 1, status: "OPEN" });

    // Legitimate sale created on credit for the invoice
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }],
        clientRequestId: reqId("credit-sale-order"),
      },
      ADMIN,
    );

    // Adversarial Action: Admin attempts to collect cash payment into Cashier 1's shift
    await expect(
      processPayment(
        {
          invoiceId: sale.invoiceId,
          amount: "5000",
          method: "CASH",
          shiftId: 10,
        },
        ADMIN,
      ),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("لا تَستطيع التسجيل على وردية مستخدم آخر"),
    });

    // Verification: Zero receipts in Cashier 1's drawer and invoice remains unpaid
    const victimReceipts = await db()
      .select()
      .from(s.receipts)
      .where(and(eq(s.receipts.shiftId, 10), eq(s.receipts.cashBucket, "DRAWER")));
    expect(victimReceipts).toHaveLength(0);

    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0];
    expect(inv.paidAmount).toBe("0.00");
  });

  it("rejects Cashier A attempt to record cash invoice payment on Cashier B's shift with FORBIDDEN", async () => {
    await insertShift({ id: 10, userId: CASHIER_1.userId, branchId: 1, status: "OPEN" });

    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
        clientRequestId: reqId("cashier-order-sale"),
      },
      CASHIER_1,
    );

    // Adversarial Action: Cashier 2 tries to collect payment into Cashier 1's shift
    await expect(
      processPayment(
        {
          invoiceId: sale.invoiceId,
          amount: "5000",
          method: "CASH",
          shiftId: 10,
        },
        CASHIER_2,
      ),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("لا تَستطيع التسجيل على وردية مستخدم آخر"),
    });

    const victimReceipts = await db()
      .select()
      .from(s.receipts)
      .where(and(eq(s.receipts.shiftId, 10), eq(s.receipts.cashBucket, "DRAWER")));
    expect(victimReceipts).toHaveLength(0);
  });

  it("rejects cross-branch shift operations with BAD_REQUEST", async () => {
    // Branch 2 shift belongs to Cashier Branch 2
    await insertShift({ id: 20, userId: CASHIER_BRANCH_2.userId, branchId: 2, status: "OPEN" });

    // 1. Cross-branch POS sale attempt
    await expect(
      createSale(
        {
          branchId: 1,
          shiftId: 20,
          sourceType: "POS",
          lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
          payment: { amount: "5000", method: "CASH" },
          clientRequestId: reqId("cross-branch-pos"),
        },
        CASHIER_1,
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("الوردية غير مفتوحة أو لا تخص هذا الفرع"),
    });

    // 2. Cross-branch Print POS sale attempt
    await expect(
      createPrintSale(
        {
          branchId: 1,
          shiftId: 20,
          lines: [{ variantId: 2, productUnitId: 2, quantity: "1" }],
          payment: { amount: "2500", method: "CASH" },
        },
        CASHIER_1,
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("الوردية غير مفتوحة أو لا تخص هذا الفرع"),
    });

    // 3. Cross-branch invoice payment attempt
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
        clientRequestId: reqId("cross-branch-order"),
      },
      CASHIER_1,
    );

    await expect(
      processPayment(
        {
          invoiceId: sale.invoiceId,
          amount: "5000",
          method: "CASH",
          shiftId: 20,
        },
        CASHIER_1,
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });

    // Verify zero receipts in Branch 2 shift
    const branch2Receipts = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.shiftId, 20));
    expect(branch2Receipts).toHaveLength(0);
  });

  it("rejects cash sale against CLOSED shift with PRECONDITION_FAILED", async () => {
    await insertShift({ id: 10, userId: CASHIER_1.userId, branchId: 1, status: "CLOSED", closing: "10000" });

    await expect(
      createSale(
        {
          branchId: 1,
          shiftId: 10,
          sourceType: "POS",
          lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
          payment: { amount: "5000", method: "CASH" },
          clientRequestId: reqId("closed-shift-pos"),
        },
        CASHIER_1,
      ),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("الوردية مغلقة"),
    });
  });

  it("verifies shift isolation: legitimate sales succeed on actor's own shift without contaminating other shifts", async () => {
    // Cashier 1 open shift 10
    await insertShift({ id: 10, userId: CASHIER_1.userId, branchId: 1, status: "OPEN" });

    // Cashier 1 legitimate sale
    const cashierSale = await createSale(
      {
        branchId: 1,
        shiftId: 10,
        sourceType: "POS",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
        payment: { amount: "5000", method: "CASH" },
        clientRequestId: reqId("cashier-valid-pos"),
      },
      CASHIER_1,
    );
    expect(cashierSale.invoiceId).toBeGreaterThan(0);

    // Verify Cashier 1 drawer receipts strictly count only Cashier 1's sale
    const cashierReceipts = await db()
      .select()
      .from(s.receipts)
      .where(and(eq(s.receipts.shiftId, 10), eq(s.receipts.cashBucket, "DRAWER")));
    expect(cashierReceipts).toHaveLength(1);
    expect(cashierReceipts[0].amount).toBe("5000.00");
    expect(cashierReceipts[0].invoiceId).toBe(cashierSale.invoiceId);
  });

  it("verifies admin on own shift succeeds and attributes exclusively to admin drawer", async () => {
    // Admin open shift 30
    await insertShift({ id: 30, userId: ADMIN.userId, branchId: 1, status: "OPEN" });

    // Admin legitimate sale on own shift 30
    const adminSale = await createSale(
      {
        branchId: 1,
        shiftId: 30,
        sourceType: "POS",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
        payment: { amount: "5000", method: "CASH" },
        clientRequestId: reqId("admin-valid-pos"),
      },
      ADMIN,
    );
    expect(adminSale.invoiceId).toBeGreaterThan(0);

    // Verify Admin drawer receipts strictly count only Admin's sale
    const adminReceipts = await db()
      .select()
      .from(s.receipts)
      .where(and(eq(s.receipts.shiftId, 30), eq(s.receipts.cashBucket, "DRAWER")));
    expect(adminReceipts).toHaveLength(1);
    expect(adminReceipts[0].amount).toBe("5000.00");
    expect(adminReceipts[0].invoiceId).toBe(adminSale.invoiceId);
  });
});
