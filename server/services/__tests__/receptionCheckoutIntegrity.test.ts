import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { checkoutReception } from "../receptionCheckoutService";
import { openShift } from "../shiftService";

const TABLES = [
  "deliveryOutbox",
  "deliveryEvents",
  "deliveryLedgerEntries",
  "deliveryRemittanceLines",
  "deliveryRemittances",
  "deliveryConsignments",
  "deliveryPartyMembers",
  "deliveryParties",
  "orderPayments",
  "idempotencyKeys",
  "auditLogs",
  "accountingEntries",
  "receipts",
  "workOrderMaterials",
  "workOrderImages",
  "workOrderItems",
  "workOrders",
  "invoiceItems",
  "invoices",
  "inventoryMovements",
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

const CASHIER = { userId: 2, branchId: 1, role: "cashier" } as const;
const REGULAR_LINE = { variantId: 1, productUnitId: 1, quantity: "2" }; // 2,000
const PRINT_LINE = { variantId: 10, productUnitId: 10, quantity: "4" }; // 1,000
const DELIVERY = {
  partyId: 1,
  fee: "0",
  feeCollection: "COURIER" as const,
  recipientName: "المستلم",
  recipientPhone: "07701234567",
  address: "بغداد",
};

function db() {
  const database = getDb();
  if (!database) throw new Error("DATABASE_URL not set for tests");
  return database;
}

async function reset() {
  const database = db();
  await database.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of TABLES)
    await database.execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  await database.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed() {
  const database = db();
  await database
    .insert(s.branches)
    .values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await database.insert(s.users).values([
    {
      id: 1,
      openId: "mgr",
      name: "مدير",
      email: "m@t.test",
      role: "manager",
      loginMethod: "local",
      branchId: 1,
    },
    {
      id: 2,
      openId: "csh",
      name: "كاشير",
      email: "c@t.test",
      role: "cashier",
      loginMethod: "local",
      branchId: 1,
    },
  ]);
  await database.insert(s.deliveryParties).values({
    id: 1,
    name: "مندوب",
    partyType: "INDIVIDUAL",
    branchId: 1,
    currentBalance: "0.00",
    isActive: true,
    defaultFee: "0.00",
  });
  await database.insert(s.products).values([
    { id: 1, name: "دفتر" },
    { id: 10, name: "تصوير A4", productType: "PRINT_SERVICE", isService: true },
  ]);
  await database.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "NB-1", costPrice: "500.00" },
    { id: 10, productId: 10, sku: "SVC-COPY", costPrice: "0.00" },
  ]);
  await database.insert(s.productUnits).values([
    {
      id: 1,
      variantId: 1,
      unitName: "قطعة",
      conversionFactor: 1,
      isBaseUnit: true,
    },
    {
      id: 10,
      variantId: 10,
      unitName: "ورقة",
      conversionFactor: 1,
      isBaseUnit: true,
    },
  ]);
  await database.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "1000.00" },
    { productUnitId: 10, priceTier: "RETAIL", price: "250.00" },
  ]);
  await database
    .insert(s.branchStock)
    .values({ variantId: 1, branchId: 1, quantity: 500 });
}

async function openReception() {
  return openShift(
    { branchId: 1, openingBalance: "0", shiftType: "RECEPTION" },
    CASHIER,
  );
}

async function expectNoCheckoutEffects() {
  expect(await db().select().from(s.invoices)).toHaveLength(0);
  expect(await db().select().from(s.invoiceItems)).toHaveLength(0);
  expect(await db().select().from(s.receipts)).toHaveLength(0);
  expect(await db().select().from(s.orderPayments)).toHaveLength(0);
  expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
  expect(await db().select().from(s.auditLogs)).toHaveLength(0);
  expect(await db().select().from(s.inventoryMovements)).toHaveLength(0);
  expect(await db().select().from(s.workOrders)).toHaveLength(0);
  expect(await db().select().from(s.deliveryConsignments)).toHaveLength(0);
  expect(await db().select().from(s.deliveryLedgerEntries)).toHaveLength(0);
  expect(await db().select().from(s.idempotencyKeys)).toHaveLength(0);
  const stock = (
    await db()
      .select()
      .from(s.branchStock)
      .where(eq(s.branchStock.variantId, 1))
  )[0];
  expect(Number(stock.quantity)).toBe(500);
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("reception checkout — سلامة المبلغ الخادمي", () => {
  it("يرفض regularSale.amount المخالف ويعيد كل آثار الفاتورة والمخزون والتوصيل", async () => {
    const shift = await openReception();

    await expect(
      checkoutReception(
        {
          branchId: 1,
          shiftId: shift.shiftId,
          paidAmount: "0",
          clientRequestId: "reception-integrity-regular",
          regularSale: { lines: [REGULAR_LINE], amount: "1.00" },
          delivery: DELIVERY,
        },
        CASHIER,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await expectNoCheckoutEffects();
  });

  it("يرفض printSale.amount المخالف ويعيد كل آثار فاتورة الطباعة والتوصيل", async () => {
    const shift = await openReception();

    await expect(
      checkoutReception(
        {
          branchId: 1,
          shiftId: shift.shiftId,
          paidAmount: "0",
          clientRequestId: "reception-integrity-print",
          printSale: { lines: [PRINT_LINE], amount: "1.00" },
          delivery: DELIVERY,
        },
        CASHIER,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await expectNoCheckoutEffects();
  });
});

describe("reception checkout — بصمة العملية المركبة", () => {
  it("يعيد نفس النتيجة لنفس المفتاح والحمولة ويسجل بصمة reception.checkout واحدة", async () => {
    const shift = await openReception();
    const input = {
      branchId: 1,
      shiftId: shift.shiftId,
      paymentMethod: "CASH" as const,
      paidAmount: "2000.00",
      clientRequestId: "reception-integrity-replay",
      regularSale: { lines: [REGULAR_LINE], amount: "2000.00" },
    };

    const first = await checkoutReception(input, CASHIER);
    const replay = await checkoutReception(input, CASHIER);

    expect(replay.regularSale?.invoiceId).toBe(first.regularSale?.invoiceId);
    expect(await db().select().from(s.invoices)).toHaveLength(1);
    expect(await db().select().from(s.receipts)).toHaveLength(1);
    const roots = await db()
      .select()
      .from(s.idempotencyKeys)
      .where(eq(s.idempotencyKeys.operation, "reception.checkout"));
    expect(roots).toHaveLength(1);
    expect(roots[0].payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("يرفض إضافة مستند جديد إلى مفتاح عملية حديث ولا يغيّر آثار العملية الأولى", async () => {
    const shift = await openReception();
    const input = {
      branchId: 1,
      shiftId: shift.shiftId,
      paymentMethod: "CASH" as const,
      paidAmount: "2000.00",
      clientRequestId: "reception-integrity-conflict",
      regularSale: { lines: [REGULAR_LINE], amount: "2000.00" },
    };
    const first = await checkoutReception(input, CASHIER);

    await expect(
      checkoutReception(
        {
          ...input,
          workOrders: [
            {
              baseVariantId: null,
              title: "مستند مضاف في إعادة ملوثة",
              quantity: 1,
              salePrice: "100.00",
            },
          ],
        },
        CASHIER,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(await db().select().from(s.invoices)).toHaveLength(1);
    expect(await db().select().from(s.workOrders)).toHaveLength(0);
    expect(await db().select().from(s.receipts)).toHaveLength(1);
    const stock = (
      await db()
        .select()
        .from(s.branchStock)
        .where(eq(s.branchStock.variantId, 1))
    )[0];
    expect(Number(stock.quantity)).toBe(498);
    expect(first.regularSale?.invoiceId).toEqual(expect.any(Number));
  });

  it("يبقي replay التاريخي بلا بصمة مركبة قابلاً للإعادة ولا يخترع بصمةً لحمولة مجهولة", async () => {
    const shift = await openReception();
    const input = {
      branchId: 1,
      shiftId: shift.shiftId,
      paymentMethod: "CASH" as const,
      paidAmount: "2000.00",
      clientRequestId: "reception-integrity-legacy",
      regularSale: { lines: [REGULAR_LINE], amount: "2000.00" },
    };
    const first = await checkoutReception(input, CASHIER);
    await db()
      .delete(s.idempotencyKeys)
      .where(eq(s.idempotencyKeys.operation, "reception.checkout"));
    await db()
      .update(s.shifts)
      .set({ status: "CLOSED", openGuard: null })
      .where(eq(s.shifts.id, shift.shiftId));

    const replay = await checkoutReception(input, CASHIER);

    expect(replay.regularSale?.invoiceId).toBe(first.regularSale?.invoiceId);
    const roots = await db()
      .select()
      .from(s.idempotencyKeys)
      .where(eq(s.idempotencyKeys.operation, "reception.checkout"));
    expect(roots).toHaveLength(0);
  });
});
