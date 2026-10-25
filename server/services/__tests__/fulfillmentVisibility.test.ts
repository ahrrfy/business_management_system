import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { getFulfillmentRequest } from "../fulfillment/requestQueries";
import {
  aftercareAvailableProducts,
  getAftercareCase,
} from "../fulfillment/aftercareQueries";
import { truncateTables } from "./__testUtils__";

function db() {
  const value = getDb();
  if (!value) throw new Error("isolated test database required");
  return value;
}
const sourceHash = "a".repeat(64);

beforeEach(async () => {
  await truncateTables([
    "aftercareExecutionLines",
    "aftercareExecutions",
    "aftercareLines",
    "aftercareCases",
    "fulfillmentChargePayments",
    "fulfillmentCharges",
    "fulfillmentRequestItems",
    "fulfillmentRequests",
    "inventoryMovements",
    "invoiceItems",
    "invoices",
    "branchStock",
    "productVariants",
    "products",
    "customers",
    "suppliers",
    "users",
    "branches",
  ]);
  await db()
    .insert(s.branches)
    .values({ id: 1, name: "MAIN", code: "VIS", type: "MAIN" });
  await db()
    .insert(s.users)
    .values([
      { id: 1, openId: "vis-cashier", role: "cashier", branchId: 1 },
      {
        id: 2,
        openId: "vis-manager",
        role: "manager",
        branchId: 1,
        permissionsOverride: { reports: "NONE" },
      },
      {
        id: 3,
        openId: "vis-delegated",
        role: "cashier",
        branchId: 1,
        operationPolicy: {
          version: 1,
          grants: {
            "operation.delivery.fulfillment.aftercare.get": true,
            "operation.delivery.fulfillment.requests.get": true,
          },
          dataVisibility: { purchaseCost: false, profitMargin: false },
        },
      },
      { id: 4, openId: "vis-owner", role: "admin", isOwner: true, branchId: 1 },
    ]);
  await db()
    .insert(s.customers)
    .values({ id: 1, name: "Customer", currentBalance: "0" });
  await db()
    .insert(s.suppliers)
    .values({ id: 1, name: "Contractor", currentBalance: "0" });
  await db().insert(s.products).values({ id: 1, name: "Material" });
  await db()
    .insert(s.productVariants)
    .values({ id: 1, productId: 1, sku: "VIS-MATERIAL", costPrice: "777.77" });
  await db()
    .insert(s.branchStock)
    .values({ variantId: 1, branchId: 1, quantity: 10 });
  await db()
    .insert(s.invoices)
    .values({
      id: 1,
      invoiceNumber: "VIS-INVOICE",
      sourceType: "POS",
      sourceId: "vis-source",
      branchId: 1,
      customerId: 1,
      subtotal: "2500",
      total: "2500",
      paidAmount: "2500",
      status: "PAID",
    });
  await db()
    .insert(s.invoiceItems)
    .values({
      id: 1,
      invoiceId: 1,
      variantId: 1,
      quantity: "1",
      baseQuantity: 1,
      unitPrice: "2500",
      total: "2500",
      unitCost: "777.77",
      lineCost: "777.77",
    });
  await db()
    .insert(s.fulfillmentRequests)
    .values({
      id: 1,
      branchId: 1,
      customerId: 1,
      requestNumber: "VIS-REQUEST",
      recipientName: "Customer",
      recipientPhone: "+9647701234567",
      deliveryAddress: "Baghdad",
      deliveryFee: "100",
      createdBy: 4,
      clientRequestId: "vis-request-create",
      sourceHash,
    });
  await db()
    .insert(s.fulfillmentCharges)
    .values({
      id: 1,
      branchId: 1,
      requestId: 1,
      customerId: 1,
      category: "OUTSOURCED",
      status: "APPROVED",
      description: "خدمة خارجية",
      amount: "2500",
      paidAmount: "1000",
      externalCost: "777.77",
      payeePaidAmount: "77.77",
      payeeSupplierId: 1,
      createdBy: 4,
      approvedBy: 4,
      approvedAt: new Date(),
      clientRequestId: "vis-charge-create",
      sourceHash,
    });
  await db()
    .insert(s.aftercareCases)
    .values({
      id: 1,
      branchId: 1,
      customerId: 1,
      invoiceId: 1,
      caseNumber: "VIS-CASE",
      reason: "معالجة مثبتة",
      evidence: "أصل موثق",
      createdBy: 4,
      clientRequestId: "vis-case-create",
      sourceHash,
    });
  await db()
    .insert(s.aftercareLines)
    .values([
      {
        id: 1,
        caseId: 1,
        originalInvoiceItemId: 1,
        componentVariantId: 1,
        disposition: "REPLACEMENT",
        baseQuantity: 1,
        executedBaseQuantity: 1,
        evidence: "بديل",
      },
      {
        id: 2,
        caseId: 1,
        originalInvoiceItemId: 1,
        componentVariantId: 1,
        disposition: "REPRINT",
        baseQuantity: 1,
        executedBaseQuantity: 1,
        evidence: "خامة جديدة",
      },
    ]);
  await db()
    .insert(s.aftercareExecutions)
    .values({
      id: 1,
      caseId: 1,
      branchId: 1,
      totalCost: "888.88",
      deliveryFee: "100",
      recipientName: "Customer",
      recipientPhone: "+9647701234567",
      deliveryAddress: "Baghdad",
      preparedBy: 4,
      clientRequestId: "vis-execution-create",
      sourceHash,
    });
  await db()
    .insert(s.inventoryMovements)
    .values({
      id: 1,
      variantId: 1,
      branchId: 1,
      movementType: "OUT",
      quantity: 1,
      referenceType: "AFTERCARE_EXECUTION",
      referenceId: 1,
      createdBy: 4,
    });
  await db()
    .insert(s.aftercareExecutionLines)
    .values([
      {
        executionId: 1,
        aftercareLineId: 1,
        variantId: 1,
        kind: "OUTPUT",
        baseQuantity: 1,
        fulfilledBaseQuantity: 1,
        custodyBaseQuantity: 1,
        unitCost: "777.77",
        lineCost: "777.77",
      },
      {
        executionId: 1,
        aftercareLineId: 2,
        variantId: 1,
        kind: "OUTPUT",
        baseQuantity: 1,
        fulfilledBaseQuantity: 1,
        custodyBaseQuantity: 1,
      },
      {
        executionId: 1,
        aftercareLineId: 2,
        variantId: 1,
        kind: "MATERIAL",
        baseQuantity: 1,
        fulfilledBaseQuantity: 0,
        movementId: 1,
        unitCost: "111.11",
        lineCost: "111.11",
      },
    ]);
});

describe.sequential(
  "fulfillment cost visibility uses current persisted authority",
  () => {
    it.each([
      { userId: 1, role: "cashier" },
      { userId: 2, role: "manager" },
      { userId: 3, role: "cashier" },
    ])(
      "conceals request, execution and product costs for restricted user $userId",
      async ({ userId, role }) => {
        const actor = { userId, role, branchId: 1 };
        const request = await getFulfillmentRequest(1, actor);
        expect(request.charges[0]).toMatchObject({
          externalCost: null,
          payeePaidAmount: null,
          amount: "2500.00",
          paidAmount: "1000.00",
          remainingAmount: "1500.00",
        });
        expect(request.totals.deliveryFee).toBe("100.00");
        const aftercare = await getAftercareCase(1, actor);
        expect(aftercare.executions[0]).toMatchObject({
          totalCost: null,
          deliveryFee: "100.00",
          codAmount: "0.00",
        });
        for (const line of aftercare.executions[0].lines)
          expect(line).toMatchObject({ unitCost: null, lineCost: null });
        expect(
          aftercare.executions[0].lines.some(
            (line) => line.kind === "MATERIAL",
          ),
        ).toBe(true);
        const products = await aftercareAvailableProducts(
          { branchId: 1 },
          actor,
        );
        expect(products[0]).toMatchObject({ unitCost: null, quantity: 10 });
        const serialized = JSON.stringify({ request, aftercare, products });
        for (const cost of ["777.77", "77.77", "888.88", "111.11"])
          expect(serialized).not.toContain(cost);
        expect(
          (await db().select().from(s.aftercareExecutions))[0].totalCost,
        ).toBe("888.88");
        expect(
          (await db().select().from(s.fulfillmentCharges))[0].externalCost,
        ).toBe("777.77");
      },
    );

    it("discloses real values to the stored owner and ignores forged caller authority", async () => {
      const owner = { userId: 4, branchId: 1, role: "cashier", isOwner: false };
      expect((await getFulfillmentRequest(1, owner)).charges[0]).toMatchObject({
        externalCost: "777.77",
        payeePaidAmount: "77.77",
      });
      const detail = await getAftercareCase(1, owner);
      expect(detail.executions[0].totalCost).toBe("888.88");
      expect(detail.executions[0].lines.map((line) => line.lineCost)).toEqual([
        "777.77",
        "0.00",
        "111.11",
      ]);
      expect(
        (await aftercareAvailableProducts({ branchId: 1 }, owner))[0].unitCost,
      ).toBe("777.77");
      const forged = { userId: 1, branchId: 1, role: "admin", isOwner: true };
      expect(
        (await getFulfillmentRequest(1, forged)).charges[0].externalCost,
      ).toBeNull();
      expect(
        (await getAftercareCase(1, forged)).executions[0].totalCost,
      ).toBeNull();
      expect(
        (await aftercareAvailableProducts({ branchId: 1 }, forged))[0].unitCost,
      ).toBeNull();
    });
  },
);
