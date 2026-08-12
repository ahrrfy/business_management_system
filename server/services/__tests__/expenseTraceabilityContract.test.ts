import { readFileSync } from "node:fs";
import { inArray, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as schema from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createExpense, listExpenses } from "../expenseService";
import { openShift } from "../shiftService";

type FundingKind = "DRAWER" | "TREASURY" | "NON_CASH" | "STOCK";

type TraceableExpenseRow = {
  id: number;
  referenceNumber: string | null;
  source: "CASH" | "STOCK";
  fundingKind: FundingKind;
  paymentMethod: "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET";
  cashBucket: "DRAWER" | "TREASURY" | null;
  shiftId: number | null;
  shiftOwnerName: string | null;
  receiptId: number | null;
  receiptStatus: string | null;
  createdBy: number | null;
  createdByName: string | null;
  payee: string | null;
  costCenter: string | null;
};

type TraceableExpenseTotals = {
  active: string;
  count: number;
  drawer: string;
  treasury: string;
  nonCash: string;
  stock: string;
};

const actor = { userId: 1, branchId: 1, role: "admin" } as const;
const actorName = "مدقق المصروفات";
const commonPayee = "مستفيد الاختبار";
const commonCostCenter = "AUDIT-CENTER";

function db() {
  const connection = getDb();
  if (!connection)
    throw new Error("DATABASE_URL not set for expense traceability tests");
  return connection;
}

async function resetFixtureTables() {
  const connection = db();
  const tables = [
    "accountingEntries",
    "expenseStockItems",
    "expenses",
    "receipts",
    "inventoryMovements",
    "branchStock",
    "productUnits",
    "productVariants",
    "products",
    "shifts",
    "idempotencyKeys",
    "branches",
    "users",
  ];

  await connection.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of tables)
    await connection.execute(sql.raw(`DELETE FROM \`${table}\``));
  await connection.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seedTraceabilityFixtures() {
  const connection = db();
  await connection.insert(schema.branches).values({
    id: 1,
    name: "الفرع التدقيقي",
    code: "AUDIT",
    type: "MAIN",
    isActive: true,
  });
  await connection.insert(schema.users).values({
    id: actor.userId,
    openId: "expense_traceability_admin",
    name: actorName,
    role: actor.role,
    branchId: actor.branchId,
    loginMethod: "local",
  });
  await connection
    .insert(schema.products)
    .values({ id: 1, name: "مادة تدقيقية" });
  await connection.insert(schema.productVariants).values({
    id: 1,
    productId: 1,
    sku: "AUDIT-STOCK",
    costPrice: "2.50",
  });
  await connection.insert(schema.productUnits).values({
    id: 1,
    variantId: 1,
    unitName: "قطعة",
    conversionFactor: "1",
    isBaseUnit: true,
  });
  await connection
    .insert(schema.branchStock)
    .values({ variantId: 1, branchId: 1, quantity: 20 });
}

function rowByReference(
  rows: TraceableExpenseRow[],
  referenceNumber: string,
): TraceableExpenseRow {
  const row = rows.find(
    (candidate) => candidate.referenceNumber === referenceNumber,
  );
  expect(
    row,
    `expense ${referenceNumber} must remain identifiable in the list contract`,
  ).toBeDefined();
  return row!;
}

describe("expense list traceability contract", () => {
  it("preserves funding source, actor, shift, receipt and full-dataset totals for DRAWER/TREASURY/NON_CASH/STOCK", async () => {
    await resetFixtureTables();
    await seedTraceabilityFixtures();

    // Create treasury cash before opening the actor's shift so it cannot be
    // auto-attributed to the drawer.
    const treasury = await createExpense(
      {
        branchId: 1,
        category: "RENT",
        amount: "100.00",
        paymentMethod: "CASH",
        description: "صرف نقدي من الخزينة الإدارية",
        referenceNumber: "TRACE-TREASURY",
        payee: commonPayee,
        costCenter: commonCostCenter,
      },
      actor,
    );

    const nonCash = await createExpense(
      {
        branchId: 1,
        category: "UTILITIES",
        amount: "200.00",
        paymentMethod: "TRANSFER",
        description: "مصروف بتحويل مصرفي",
        referenceNumber: "TRACE-NON-CASH",
        payee: commonPayee,
        costCenter: commonCostCenter,
      },
      actor,
    );

    const { shiftId } = await openShift(
      { branchId: 1, openingBalance: "1000.00" },
      actor,
    );
    const drawer = await createExpense(
      {
        branchId: 1,
        shiftId,
        category: "SUPPLIES",
        amount: "300.00",
        paymentMethod: "CASH",
        description: "صرف نقدي من درج الوردية",
        referenceNumber: "TRACE-DRAWER",
        payee: commonPayee,
        costCenter: commonCostCenter,
      },
      actor,
    );

    const stock = await createExpense(
      {
        branchId: 1,
        category: "SUPPLIES",
        amount: "0",
        paymentMethod: "CASH",
        source: "STOCK",
        stockReason: "INTERNAL_USE",
        description: "صرف مادتين من المخزون بالكلفة",
        referenceNumber: "TRACE-STOCK",
        payee: commonPayee,
        costCenter: commonCostCenter,
        items: [{ variantId: 1, baseQuantity: 2 }],
      },
      actor,
    );

    const result = await listExpenses({
      branchId: 1,
      status: "ACTIVE",
      limit: 50,
    });
    const rows = result.rows as unknown as TraceableExpenseRow[];
    const totals = result.totals as unknown as TraceableExpenseTotals;

    expect(rows).toHaveLength(4);
    expect
      .soft(totals, "totals must reconcile by funding source")
      .toMatchObject({
        count: 4,
        active: "605.00",
        drawer: "300.00",
        treasury: "100.00",
        nonCash: "200.00",
        stock: "5.00",
      });

    const drawerRow = rowByReference(rows, "TRACE-DRAWER");
    expect.soft(drawerRow, "drawer expense trace").toMatchObject({
      source: "CASH",
      fundingKind: "DRAWER",
      paymentMethod: "CASH",
      cashBucket: "DRAWER",
      shiftId,
      shiftOwnerName: actorName,
      receiptId: drawer.receiptId,
      receiptStatus: "COMPLETED",
      createdBy: actor.userId,
      createdByName: actorName,
      payee: commonPayee,
      costCenter: commonCostCenter,
    });

    const treasuryRow = rowByReference(rows, "TRACE-TREASURY");
    expect.soft(treasuryRow, "treasury expense trace").toMatchObject({
      source: "CASH",
      fundingKind: "TREASURY",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      shiftId: null,
      shiftOwnerName: null,
      receiptId: treasury.receiptId,
      receiptStatus: "COMPLETED",
      createdBy: actor.userId,
      createdByName: actorName,
      payee: commonPayee,
      costCenter: commonCostCenter,
    });

    const nonCashRow = rowByReference(rows, "TRACE-NON-CASH");
    expect.soft(nonCashRow, "non-cash expense trace").toMatchObject({
      source: "CASH",
      fundingKind: "NON_CASH",
      paymentMethod: "TRANSFER",
      cashBucket: null,
      shiftId: null,
      shiftOwnerName: null,
      receiptId: nonCash.receiptId,
      receiptStatus: "COMPLETED",
      createdBy: actor.userId,
      createdByName: actorName,
      payee: commonPayee,
      costCenter: commonCostCenter,
    });

    const stockRow = rowByReference(rows, "TRACE-STOCK");
    expect.soft(stockRow, "stock expense trace").toMatchObject({
      source: "STOCK",
      fundingKind: "STOCK",
      cashBucket: null,
      shiftId: null,
      shiftOwnerName: null,
      receiptId: null,
      receiptStatus: null,
      createdBy: actor.userId,
      createdByName: actorName,
      payee: commonPayee,
      costCenter: commonCostCenter,
    });
    expect.soft(stockRow.id).toBe(stock.expenseId);

    // The source filters must reconcile with the same full matching dataset,
    // not merely the currently loaded page.
    const cashOnly = await listExpenses({
      branchId: 1,
      source: "CASH",
      limit: 1,
    });
    expect.soft(cashOnly.rows).toHaveLength(1);
    expect.soft(cashOnly.totals).toMatchObject({ count: 3, active: "600.00" });

    const stockOnly = await listExpenses({
      branchId: 1,
      source: "STOCK",
      limit: 1,
    });
    expect.soft(stockOnly.rows).toHaveLength(1);
    expect.soft(stockOnly.totals).toMatchObject({ count: 1, active: "5.00" });

    // Sanity-check the IDs used above really point to the persisted receipts;
    // this prevents a list adapter from manufacturing unrelated document IDs.
    const expectedReceiptIds = [
      Number(treasury.receiptId),
      Number(nonCash.receiptId),
      Number(drawer.receiptId),
    ];
    const persistedReceipts = await db()
      .select({ id: schema.receipts.id })
      .from(schema.receipts)
      .where(inArray(schema.receipts.id, expectedReceiptIds));
    expect
      .soft(new Set(persistedReceipts.map((receipt) => Number(receipt.id))))
      .toEqual(new Set(expectedReceiptIds));
  });

  it("keeps every audit field in the Expenses Excel export column contract", () => {
    const pageSource = readFileSync(
      new URL("../../../client/src/pages/Expenses.tsx", import.meta.url),
      "utf8",
    );
    const columnsStart = pageSource.indexOf("const exportColumns");
    const columnsEnd = pageSource.indexOf(
      "async function exportAll",
      columnsStart,
    );

    expect(
      columnsStart,
      "Expenses.tsx must declare its Excel export columns",
    ).toBeGreaterThanOrEqual(0);
    expect(
      columnsEnd,
      "the export column block must precede exportAll",
    ).toBeGreaterThan(columnsStart);

    const exportColumnBlock = pageSource.slice(columnsStart, columnsEnd);
    const requiredAuditKeys = [
      "description",
      "payee",
      "referenceNumber",
      "costCenter",
      "source",
      "fundingKind",
      "cashBucket",
      "shiftId",
      "shiftOwnerName",
      "receiptId",
      "createdByName",
      "amount",
      "status",
    ];

    for (const key of requiredAuditKeys) {
      expect
        .soft(
          exportColumnBlock,
          `Excel export must not hide the audit field ${key}`,
        )
        .toContain(`key: "${key}"`);
    }
  });
});
