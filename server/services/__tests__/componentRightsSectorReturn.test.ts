import { and, eq } from "drizzle-orm";
import { expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import {
  aftercareCases,
  aftercareLines,
  aftercareSettlements,
} from "../../../drizzle/fulfillmentSchema";
import { componentRightsAdjustments } from "../../../drizzle/fulfillmentRightsSchema";
import { getDb } from "../../db";
import { createSale } from "../sale/create";
import { postComponentRights } from "../fulfillment/componentRights";
import { returnSale } from "../returnService";
import { money } from "../money";

const db = () => getDb()!;
const maker = { userId: 1, branchId: 1, role: "cashier" };
const reviewer = { userId: 2, branchId: 1, role: "admin" };
async function effects() {
  return Promise.all([
    db().select().from(s.invoices),
    db().select().from(s.invoiceItems),
    db().select().from(s.receipts),
    db().select().from(s.accountingEntries),
    db().select().from(s.journalEntries),
    db().select().from(s.journalLines),
    db().select().from(s.inventoryMovements),
    db().select().from(s.branchStock),
    db().select().from(s.customers),
    db().select().from(componentRightsAdjustments),
  ]);
}

it("returns bundle 7000 and service 1000 after a source-linked component credit of 3000, atomically and once", async () => {
  await db()
    .insert(s.branches)
    .values({ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" });
  await db()
    .insert(s.users)
    .values([
      {
        id: 1,
        openId: "sector-maker",
        name: "maker",
        role: "cashier",
        branchId: 1,
      },
      {
        id: 2,
        openId: "sector-reviewer",
        name: "reviewer",
        role: "admin",
        branchId: 1,
      },
    ]);
  await db().insert(s.doubleEntrySettings).values({
    id: 1,
    mode: "SHADOW",
    shadowCycleId: "component-sector-regression",
  });
  await db()
    .insert(s.customers)
    .values({ id: 1, name: "registered customer", currentBalance: "0" });
  await db()
    .insert(s.products)
    .values([
      { id: 1, name: "component A" },
      { id: 2, name: "component B" },
      { id: 10, name: "bundle", isBundle: true },
      {
        id: 11,
        name: "service",
        isService: true,
        productType: "PRINT_SERVICE",
      },
    ]);
  await db()
    .insert(s.productVariants)
    .values([
      { id: 1, productId: 1, sku: "SECTOR-A", costPrice: "150" },
      { id: 2, productId: 2, sku: "SECTOR-B", costPrice: "200" },
      { id: 10, productId: 10, sku: "SECTOR-PACK", costPrice: "0" },
      { id: 11, productId: 11, sku: "SECTOR-SERVICE", costPrice: "0" },
    ]);
  await db()
    .insert(s.productUnits)
    .values(
      [1, 2, 10, 11].map((id) => ({
        id,
        variantId: id,
        unitName: "piece",
        conversionFactor: "1",
        isBaseUnit: true,
      })),
    );
  await db()
    .insert(s.productPrices)
    .values([
      { productUnitId: 10, priceTier: "RETAIL", price: "10000" },
      { productUnitId: 11, priceTier: "RETAIL", price: "1000" },
    ]);
  await db()
    .insert(s.bundleComponents)
    .values([
      { bundleVariantId: 10, componentVariantId: 1, componentBaseQuantity: 1 },
      { bundleVariantId: 10, componentVariantId: 2, componentBaseQuantity: 1 },
    ]);
  await db()
    .insert(s.branchStock)
    .values([
      { branchId: 1, variantId: 1, quantity: 10 },
      { branchId: 1, variantId: 2, quantity: 10 },
    ]);
  await db().insert(s.shifts).values({
    id: 1,
    branchId: 1,
    userId: 1,
    openingBalance: "0",
    status: "OPEN",
  });
  const sale = await createSale(
    {
      branchId: 1,
      shiftId: 1,
      customerId: 1,
      sourceType: "POS",
      clientRequestId: "sector-original-sale",
      lines: [
        { variantId: 10, productUnitId: 10, quantity: "1" },
        { variantId: 11, productUnitId: 11, quantity: "1" },
      ],
      payment: { method: "CASH", amount: "11000" },
    },
    maker,
  );
  const items = await db()
    .select()
    .from(s.invoiceItems)
    .where(eq(s.invoiceItems.invoiceId, sale.invoiceId));
  const bundle = items.find((row) => row.variantId === 10)!;
  const [component] = await db()
    .select()
    .from(s.invoiceItemBundleComponents)
    .where(
      and(
        eq(s.invoiceItemBundleComponents.invoiceItemId, bundle.id),
        eq(s.invoiceItemBundleComponents.componentVariantId, 1),
      ),
    );
  const [issue] = await db()
    .select()
    .from(s.inventoryMovements)
    .where(
      and(
        eq(s.inventoryMovements.referenceId, sale.invoiceId),
        eq(s.inventoryMovements.referenceType, "INVOICE"),
        eq(s.inventoryMovements.variantId, 1),
        eq(s.inventoryMovements.movementType, "OUT"),
      ),
    );
  expect(component.issueLineCost).toBe("150.00");
  await db()
    .insert(aftercareCases)
    .values({
      id: 1,
      caseNumber: "AC-SECTOR-1",
      branchId: 1,
      invoiceId: sale.invoiceId,
      customerId: 1,
      status: "IN_PROGRESS",
      reason: "original component held in shop",
      evidence: "physical inspection",
      createdBy: 1,
      approvedBy: 2,
      approvedAt: new Date(),
      clientRequestId: "sector-case",
      sourceHash: "a".repeat(64),
    });
  await db().insert(aftercareLines).values({
    id: 1,
    caseId: 1,
    originalInvoiceItemId: bundle.id,
    originalBundleComponentId: component.id,
    componentVariantId: 1,
    baseQuantity: 1,
    disposition: "MISSING_HELD",
    originalMovementId: issue.id,
    settledBaseQuantity: 1,
    heldConfirmedBy: 1,
    heldConfirmedAt: new Date(),
    evidence: "original component physically inspected",
  });
  await db()
    .insert(aftercareSettlements)
    .values({
      id: 1,
      caseId: 1,
      branchId: 1,
      caseVersion: 1,
      status: "POSTED",
      reason: "customer stops compensation",
      evidence: "independent inspected settlement",
      decisions: [],
      sourceRights: [
        {
          invoiceItemId: bundle.id,
          originalBundleComponentId: component.id,
          componentVariantId: 1,
          baseQuantity: 1,
          originalMovementId: issue.id,
          usableBaseQuantity: 1,
          damagedBaseQuantity: 0,
          commercialAmount: "3000",
          originalIssueValue: "150",
          costEvidence: "actual original issue snapshot",
          costEvidenceReference: `invoiceItemBundleComponents:${component.id}:issueLineCost`,
        },
      ],
      restoredValue: "0",
      previewHash: "b".repeat(64),
      sourceHash: "c".repeat(64),
      createdBy: 1,
      approvedBy: 2,
      approvedAt: new Date(),
      postedBy: 2,
      postedAt: new Date(),
      clientRequestId: "sector-settlement",
    });
  const credit = {
    settlementId: 1,
    rightIndex: 0,
    clientRequestId: "sector-component-credit",
    refund: { amount: "3000", method: "CASH" as const, shiftId: 1 },
  };
  await postComponentRights(credit, reviewer);
  const credited = await effects();
  expect(await postComponentRights(credit, reviewer)).toMatchObject({
    replay: true,
  });
  expect(await effects()).toEqual(credited);
  await db()
    .update(aftercareCases)
    .set({ status: "RESOLVED" })
    .where(eq(aftercareCases.id, 1));

  const command = {
    invoiceId: sale.invoiceId,
    lines: items.map((row) => ({ invoiceItemId: row.id, baseQuantity: 1 })),
    refund: { method: "CASH" as const, amount: "8000", shiftId: 1 },
    clientRequestId: "sector-remaining-return",
  };
  const result = await returnSale(command, reviewer);
  expect(result).toMatchObject({
    returnedTotal: "8000.00",
    fullyReturned: true,
    pendingRefundAmount: "0.00",
  });
  const returns = await db()
    .select()
    .from(s.accountingEntries)
    .where(
      and(
        eq(s.accountingEntries.invoiceId, sale.invoiceId),
        eq(s.accountingEntries.entryType, "RETURN"),
      ),
    )
    .orderBy(s.accountingEntries.id);
  expect(returns).toHaveLength(2);
  expect(returns.map((row) => row.revenue)).toEqual(["-3000.00", "-8000.00"]);
  const [journal] = await db()
    .select()
    .from(s.journalEntries)
    .where(eq(s.journalEntries.entryId, returns[1].id));
  expect(journal.postingProfile).toBe("RETURN_SALE_MIXED");
  const lines = await db()
    .select()
    .from(s.journalLines)
    .where(eq(s.journalLines.journalId, journal.id));
  const debit = (role: string) =>
    lines
      .filter((row) => row.role === role)
      .reduce((sum, row) => sum.plus(row.debit), money(0))
      .toFixed(2);
  expect(debit("SALES_STATIONERY")).toBe("7000.00");
  expect(debit("SALES_PRINT")).toBe("1000.00");
  expect(
    lines.every((row) => money(row.debit).gte(0) && money(row.credit).gte(0)),
  ).toBe(true);
  expect(
    lines
      .reduce((sum, row) => sum.plus(row.debit).minus(row.credit), money(0))
      .toFixed(2),
  ).toBe("0.00");
  const [invoice] = await db()
    .select()
    .from(s.invoices)
    .where(eq(s.invoices.id, sale.invoiceId));
  expect(invoice).toMatchObject({
    returnedTotal: "11000.00",
    paidAmount: "0.00",
    status: "RETURNED",
  });
  expect(
    (
      await db()
        .select()
        .from(s.receipts)
        .where(eq(s.receipts.direction, "OUT"))
    ).map((row) => row.amount),
  ).toEqual(["3000.00", "8000.00"]);
  expect(
    (await db().select().from(s.branchStock)).map((row) => row.quantity),
  ).toEqual([10, 10]);
  expect((await db().select().from(s.customers))[0].currentBalance).toBe(
    "0.00",
  );
  const completed = await effects();
  expect(await returnSale(command, reviewer)).toMatchObject({
    returnedTotal: "8000.00",
    idempotentReplay: true,
  });
  expect(await effects()).toEqual(completed);
});
