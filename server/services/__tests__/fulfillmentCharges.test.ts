import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import {
  fulfillmentCharges,
  fulfillmentChargePayments,
} from "../../../drizzle/fulfillmentSchema";
import { getDb } from "../../db";
import {
  createFulfillmentCharge,
  approveFulfillmentCharge,
  collectFulfillmentCharges,
  refundFulfillmentCharge,
  refundFulfillmentChargeExcess,
  refundFulfillmentCourierExcess,
  recordFulfillmentChargeCourierCollection,
  remitFulfillmentChargeCourier,
  settleFulfillmentChargePayee,
  type CreateFulfillmentChargeInput,
} from "../fulfillment/charges";
import { listFulfillmentCourierExcess } from "../fulfillment/chargeQueries";
import { getFinancialPosition } from "../reportsFinancialService";
import { getCustomerStatement, getARAging } from "../reports/arAging";
import {
  initiateExternalPaymentAttempt,
  confirmExternalPaymentAttempt,
} from "../posExternalPayment";
import * as audit from "../auditService";
import { withTx } from "../tx";
import {
  attachFulfillmentRequestClaimsTx,
  collectAssignedConsignmentClaimsTx,
} from "../fulfillment/chargeDelivery";
import { recordDeliveryRemittance } from "../delivery/remittance";
import { truncateTables } from "./__testUtils__";

const cashier = { userId: 1, branchId: 1, role: "cashier" },
  manager = { userId: 2, branchId: 1, role: "manager" };
let sequence = 0;
const key = () => `FC-TEST-${Date.now()}-${++sequence}`;
const device = "CHARGE-TEST-TERMINAL";
function db() {
  const value = getDb();
  if (!value) throw new Error("test database required");
  return value;
}
beforeEach(async () => {
  vi.restoreAllMocks();
  await truncateTables([
    "deliveryRemittanceLines",
    "deliveryRemittances",
    "deliveryOutbox",
    "deliveryEvents",
    "deliveryLedgerEntries",
    "deliveryShipmentMembers",
    "deliveryConsignments",
    "fulfillmentChargePayments",
    "fulfillmentCharges",
    "fulfillmentRequestItems",
    "fulfillmentRequests",
    "externalPaymentAttempts",
    "journalLines",
    "journalEntries",
    "accountingEntries",
    "auditLogs",
    "idempotencyKeys",
    "receipts",
    "invoiceItems",
    "invoices",
    "shifts",
    "deliveryParties",
    "suppliers",
    "customers",
    "branches",
    "users",
  ]);
  await db()
    .insert(s.branches)
    .values([
      { id: 1, name: "MAIN", code: "CHARGE1", type: "MAIN" },
      { id: 2, name: "OTHER", code: "CHARGE2", type: "SALES" },
    ]);
  await db()
    .insert(s.users)
    .values([
      {
        id: 1,
        openId: "charge-maker",
        name: "Maker",
        role: "cashier",
        branchId: 1,
      },
      {
        id: 2,
        openId: "charge-checker",
        name: "Checker",
        role: "manager",
        branchId: 1,
      },
      {
        id: 3,
        openId: "charge-other",
        name: "Other",
        role: "cashier",
        branchId: 2,
      },
    ]);
  await db().insert(s.customers).values({
    id: 1,
    name: "Charge Customer",
    creditLimit: null,
    currentBalance: "0",
  });
  await db()
    .insert(s.suppliers)
    .values({ id: 1, name: "Charge Contractor", currentBalance: "0" });
  await db()
    .insert(s.shifts)
    .values([
      {
        id: 1,
        userId: 1,
        branchId: 1,
        shiftType: "RECEPTION",
        status: "OPEN",
        openingBalance: "10000",
        openGuard: "1:1:RECEPTION",
      },
      {
        id: 2,
        userId: 2,
        branchId: 1,
        shiftType: "RECEPTION",
        status: "OPEN",
        openingBalance: "1000",
        openGuard: "2:1:RECEPTION",
      },
    ]);
});
function input(
  patch: Partial<CreateFulfillmentChargeInput> = {},
): CreateFulfillmentChargeInput {
  return {
    branchId: 1,
    customerId: 1,
    category: "SERVICE",
    description: "أجر تغليف",
    amount: "2000",
    externalCost: "0",
    clientRequestId: key(),
    ...patch,
  };
}
async function approved(patch: Partial<CreateFulfillmentChargeInput> = {}) {
  const row = await createFulfillmentCharge(input(patch), cashier);
  return approveFulfillmentCharge(
    { id: row.id, expectedVersion: row.version, clientRequestId: key() },
    manager,
  );
}
async function cashCollect(
  id: number,
  version: number,
  amount = "2000",
  actual = amount,
  requestId = key(),
) {
  return collectFulfillmentCharges(
    {
      branchId: 1,
      clientRequestId: requestId,
      allocations: [{ chargeId: id, expectedVersion: version, amount }],
      amount: actual,
      tender: { method: "CASH", cashBucket: "DRAWER", shiftId: 1 },
    },
    cashier,
  );
}
async function allowCashierCost() {
  await db()
    .update(s.users)
    .set({
      operationPolicy: {
        version: 1,
        grants: {},
        dataVisibility: { purchaseCost: true, profitMargin: true },
      },
    })
    .where(eq(s.users.id, cashier.userId));
}
async function balance() {
  return (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0]
    .currentBalance;
}
describe("classified fulfillment charge lifecycle", () => {
  it("SERVICE 2000 settles only its own claim beside an already-paid invoice", async () => {
    await db().insert(s.invoices).values({
      id: 1,
      branchId: 1,
      customerId: 1,
      invoiceNumber: "CHARGE-PAID",
      sourceType: "POS",
      sourceId: key(),
      subtotal: "50000",
      total: "50000",
      paidAmount: "50000",
      status: "PAID",
      createdBy: 1,
    });
    const row = await approved();
    expect(await balance()).toBe("2000.00");
    await cashCollect(row.id, row.version);
    expect(await balance()).toBe("0.00");
    expect((await db().select().from(s.invoices))[0].paidAmount).toBe(
      "50000.00",
    );
    expect(await db().select().from(s.invoices)).toHaveLength(1);
    expect((await db().select().from(s.receipts))[0].invoiceId).toBeNull();
  });
  it("OUTSOURCED 5000/3000 posts gross service and independent AP cost", async () => {
    await allowCashierCost();
    const row = await approved({
      category: "OUTSOURCED",
      amount: "5000",
      externalCost: "3000",
      payeeSupplierId: 1,
    });
    const entries = await db().select().from(s.accountingEntries);
    expect(
      entries.find(
        (e) => e.dedupeKey === `FULFILLMENT_CHARGE_ACCRUAL:${row.id}`,
      )?.revenue,
    ).toBe("5000.00");
    expect(
      entries.find((e) => e.dedupeKey === `FULFILLMENT_CHARGE_COST:${row.id}`)
        ?.cost,
    ).toBe("3000.00");
    await settleFulfillmentChargePayee(
      {
        id: row.id,
        expectedVersion: row.version,
        amount: "3000",
        clientRequestId: key(),
        tender: { method: "CASH", cashBucket: "DRAWER", shiftId: 1 },
      },
      cashier,
    );
    expect((await db().select().from(s.suppliers))[0].currentBalance).toBe(
      "0.00",
    );
    expect(
      (await db().select().from(s.accountingEntries)).filter(
        (e) => e.cost === "3000.00",
      ),
    ).toHaveLength(1);
  });
  it("PASS_THROUGH 3000 is liability with zero revenue and no duplicate expense", async () => {
    await allowCashierCost();
    const row = await approved({
      category: "PASS_THROUGH",
      amount: "3000",
      externalCost: "3000",
      payeeSupplierId: 1,
    });
    await cashCollect(row.id, row.version, "3000");
    expect(
      (await db().select().from(s.accountingEntries)).every(
        (e) => e.revenue === "0.00" && e.cost === "0.00",
      ),
    ).toBe(true);
    const current = (await db().select().from(fulfillmentCharges))[0];
    await settleFulfillmentChargePayee(
      {
        id: row.id,
        expectedVersion: current.version,
        amount: "3000",
        clientRequestId: key(),
        tender: { method: "CASH", shiftId: 1, cashBucket: "DRAWER" },
      },
      cashier,
    );
    expect(await balance()).toBe("0.00");
  });
  it("SHOP_EXPENSE never creates customer AR", async () => {
    await approved({
      category: "SHOP_EXPENSE",
      customerId: null,
      amount: "0",
      externalCost: "3000",
      payeeSupplierId: 1,
    });
    expect(await balance()).toBe("0.00");
    expect((await db().select().from(s.accountingEntries))[0].cost).toBe(
      "3000.00",
    );
  });
  it("requires independent expense approval", async () => {
    const row = await createFulfillmentCharge(
      input({
        category: "OUTSOURCED",
        externalCost: "3000",
        payeeSupplierId: 1,
      }),
      manager,
    );
    await expect(
      approveFulfillmentCharge(
        { id: row.id, expectedVersion: row.version, clientRequestId: key() },
        manager,
      ),
    ).rejects.toThrow(/مستقل/);
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
  });
  it("denies foreign branch, stale versions and allocation above claim", async () => {
    const row = await approved();
    await expect(cashCollect(row.id, 1)).rejects.toThrow();
    await expect(cashCollect(row.id, row.version, "2001")).rejects.toThrow(
      /يتجاوز/,
    );
    await expect(async () =>
      createFulfillmentCharge(input(), {
        userId: 3,
        branchId: 2,
        role: "cashier",
      }),
    ).rejects.toThrow();
    expect(await db().select().from(s.receipts)).toHaveLength(0);
  });
  it("same-key replay succeeds before stale version check and changed payload rejects", async () => {
    const row = await approved(),
      requestId = key();
    const first = await cashCollect(
      row.id,
      row.version,
      "2000",
      "2000",
      requestId,
    );
    expect(
      (await cashCollect(row.id, row.version, "2000", "2000", requestId))
        .receiptId,
    ).toBe(first.receiptId);
    await expect(
      cashCollect(row.id, row.version, "1000", "1000", requestId),
    ).rejects.toThrow();
    expect(await db().select().from(s.receipts)).toHaveLength(1);
  });
  it("concurrent collectors cannot overallocate the same charge", async () => {
    const row = await approved(),
      results = await Promise.allSettled([
        cashCollect(row.id, row.version),
        cashCollect(row.id, row.version),
      ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db().select().from(s.receipts)).toHaveLength(1);
    expect(await balance()).toBe("0.00");
  });
  it("failed audit rolls back receipt, AR, allocation and idempotency key", async () => {
    const row = await approved();
    vi.spyOn(audit, "logAuditTx").mockRejectedValueOnce(
      new Error("injected audit failure"),
    );
    await expect(cashCollect(row.id, row.version)).rejects.toThrow(
      "injected audit failure",
    );
    expect(await balance()).toBe("2000.00");
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    expect(await db().select().from(fulfillmentChargePayments)).toHaveLength(0);
  });
  it("preserves and refunds overcollection liability without modifying customer AR", async () => {
    const row = await approved(),
      collected = await cashCollect(row.id, row.version, "2000", "2300");
    expect(await balance()).toBe("0.00");
    const updated = (await db().select().from(fulfillmentCharges))[0];
    await refundFulfillmentChargeExcess(
      {
        id: row.id,
        expectedVersion: updated.version,
        originalReceiptId: collected.receiptId,
        amount: "300",
        reason: "إعادة فائض القبض",
        clientRequestId: key(),
      },
      manager,
    );
    expect(await balance()).toBe("0.00");
    const statement = await getCustomerStatement(1);
    expect(statement?.fulfillmentHeldExcess).toBe("0.00");
    expect(
      statement?.payments.find((p) => p.id === collected.receiptId)?.amount,
    ).toBe("2000.00");
  });
  it("cash availability guard rejects unfunded actual payout after card collection", async () => {
    await allowCashierCost();
    const row = await approved({
      category: "OUTSOURCED",
      externalCost: "3000",
      payeeSupplierId: 1,
    });
    await db()
      .update(s.shifts)
      .set({ openingBalance: "0" })
      .where(eq(s.shifts.id, 1));
    await expect(
      settleFulfillmentChargePayee(
        {
          id: row.id,
          expectedVersion: row.version,
          amount: "3000",
          clientRequestId: key(),
          tender: { method: "CASH", cashBucket: "DRAWER", shiftId: 1 },
        },
        cashier,
      ),
    ).rejects.toThrow();
    expect(await db().select().from(s.receipts)).toHaveLength(0);
  });
  it("card collection and original-rail refund have zero drawer effect and no reusable proof", async () => {
    const row = await approved(),
      reference = key();
    const attempt = await initiateExternalPaymentAttempt(
      {
        branchId: 1,
        channel: "SALES_COLLECTION",
        method: "CARD",
        amount: "2000",
        reference,
        requestId: key(),
        deviceId: device,
      },
      cashier,
    );
    await confirmExternalPaymentAttempt(
      {
        branchId: 1,
        channel: "SALES_COLLECTION",
        attemptId: attempt.attemptId,
        deviceId: device,
      },
      cashier,
    );
    const collect = {
      branchId: 1,
      clientRequestId: key(),
      allocations: [
        { chargeId: row.id, expectedVersion: row.version, amount: "2000" },
      ],
      amount: "2000",
      tender: {
        method: "CARD" as const,
        externalPaymentAttemptId: attempt.attemptId,
        externalPaymentDeviceId: device,
        reference,
      },
    };
    await collectFulfillmentCharges(collect, cashier);
    const current = (await db().select().from(fulfillmentCharges))[0],
      payment = (await db().select().from(fulfillmentChargePayments))[0];
    await refundFulfillmentCharge(
      {
        id: row.id,
        expectedVersion: current.version,
        clientRequestId: key(),
        originalPaymentId: payment.id,
        amount: "500",
        reason: "رد جزء التغليف",
        reference: key(),
      },
      manager,
    );
    expect(
      (await db().select().from(s.receipts)).every(
        (r) => r.paymentMethod === "CARD" && r.cashBucket === null,
      ),
    ).toBe(true);
    expect(await balance()).toBe("0.00");
    const another = await approved();
    await expect(
      collectFulfillmentCharges(
        {
          ...collect,
          clientRequestId: key(),
          allocations: [
            {
              chargeId: another.id,
              expectedVersion: another.version,
              amount: "2000",
            },
          ],
        },
        cashier,
      ),
    ).rejects.toThrow();
    await expect(
      refundFulfillmentCharge(
        {
          id: row.id,
          expectedVersion: current.version + 1,
          clientRequestId: key(),
          originalPaymentId: payment.id,
          amount: "1600",
          reason: "رد فوق التخصيص",
          reference: key(),
        },
        manager,
      ),
    ).rejects.toThrow(/يتجاوز/);
  });
  it("refunds courier excess before remittance while preserving the entire actual custody", async () => {
    await db()
      .insert(s.fulfillmentRequests)
      .values({
        id: 1,
        branchId: 1,
        customerId: 1,
        requestNumber: "FC-EXCESS-REQUEST",
        recipientName: "عميل",
        recipientPhone: "+9647701234567",
        deliveryAddress: "بغداد",
        createdBy: 1,
        clientRequestId: key(),
        sourceHash: "a".repeat(64),
      });
    const row = await approved({ requestId: 1 });
    await db()
      .insert(s.deliveryParties)
      .values({ id: 1, name: "ناقل الأمانة", branchId: 1 });
    await db().insert(s.deliveryConsignments).values({
      id: 1,
      consignmentNumber: "FC-EXCESS-CN",
      branchId: 1,
      partyId: 1,
      sourceType: "FULFILLMENT_REQUEST",
      sourceId: 1,
      fulfillmentRequestId: 1,
      codAmount: "0",
      feeCollection: "SHOP",
      deliveryFee: "0",
      endCustomerId: 1,
      dispatchedBy: 1,
    });
    await withTx(async (tx) => {
      await attachFulfillmentRequestClaimsTx(
        tx,
        {
          requestId: 1,
          consignmentId: 1,
          partyId: 1,
          branchId: 1,
          clientRequestId: key(),
        },
        manager,
      );
      await collectAssignedConsignmentClaimsTx(
        tx,
        { consignmentId: 1, actualAmount: "2500", eventKey: key() },
        manager,
      );
      await tx
        .update(s.deliveryConsignments)
        .set({
          parcelStatus: "DELIVERED",
          courierDeliveredAt: new Date(),
        })
        .where(eq(s.deliveryConsignments.id, 1));
    });
    const source = (await db().select().from(s.accountingEntries)).find((e) =>
      e.dedupeKey?.startsWith("FULFILLMENT_COURIER_EXCESS:1:"),
    )!;
    const current = (await db().select().from(fulfillmentCharges))[0];
    const refund = {
      id: row.id,
      expectedVersion: current.version,
      clientRequestId: key(),
      originalExcessEntryId: source.id,
      consignmentId: 1,
      amount: "500",
      reason: "رد أمانة القبض الزائد الموثق",
      tender: {
        method: "CASH" as const,
        cashBucket: "DRAWER" as const,
        shiftId: 2,
      },
    };
    expect(
      await getFinancialPosition({ branchId: 1, verify: false }),
    ).toMatchObject({
      arDebit: "0.00",
      arCredit: "0.00",
      deliveryFloat: "2500.00",
      fulfillmentCustomerCredit: "500.00",
      cash: "0.00",
    });
    const first = await refundFulfillmentCourierExcess(refund, manager);
    expect(await refundFulfillmentCourierExcess(refund, manager)).toEqual(
      first,
    );
    expect(await balance()).toBe("0.00");
    expect(
      await getFinancialPosition({ branchId: 1, verify: false }),
    ).toMatchObject({
      arDebit: "0.00",
      arCredit: "0.00",
      deliveryFloat: "2500.00",
      fulfillmentCustomerCredit: "0.00",
      cash: "-500.00",
    });
    expect(
      (await db().select().from(s.deliveryParties))[0].currentBalance,
    ).toBe("2500.00");
    expect((await getCustomerStatement(1))?.fulfillmentHeldExcess).toBe("0.00");
    await expect(
      refundFulfillmentCourierExcess(
        {
          ...refund,
          clientRequestId: key(),
          expectedVersion: current.version + 1,
          amount: "1",
        },
        manager,
      ),
    ).rejects.toThrow(/يتجاوز/);
    await recordDeliveryRemittance(
      {
        branchId: 1,
        partyId: 1,
        lines: [{ consignmentId: 1, collectedAmount: "2500" }],
        countedCash: "2500",
        targetShiftId: 1,
        clientRequestId: key(),
      },
      cashier,
    );
    expect(
      (await db().select().from(s.deliveryParties))[0].currentBalance,
    ).toBe("0.00");
    expect(await balance()).toBe("0.00");
    expect(await db().select().from(s.invoices)).toHaveLength(0);
    expect(
      await getFinancialPosition({ branchId: 1, verify: false }),
    ).toMatchObject({
      arDebit: "0.00",
      arCredit: "0.00",
      deliveryFloat: "0.00",
      fulfillmentCustomerCredit: "0.00",
      cash: "2000.00",
    });
    const payments = await db().select().from(fulfillmentChargePayments);
    expect(
      payments
        .filter((p) => p.kind === "COURIER_REMITTANCE")
        .map((p) => p.amount),
    ).toEqual(["2000.00"]);
    const receipts = await db().select().from(s.receipts);
    expect(receipts.find((r) => r.direction === "IN")?.amount).toBe("2500.00");
    expect(receipts.find((r) => r.direction === "OUT")?.amount).toBe("500.00");
    const ledger = await db().select().from(s.deliveryLedgerEntries);
    expect(
      ledger
        .filter((e) => e.entryType === "COD_COLLECTED")
        .map((e) => e.amount),
    ).toEqual(["2500.00"]);
    expect(
      ledger.filter((e) => e.entryType === "COD_REMITTED").map((e) => e.amount),
    ).toEqual(["2500.00"]);
  });
  it("raw remittance closes finance after actual physical delivery without inventing delivery from payment", async () => {
    await db()
      .insert(s.fulfillmentRequests)
      .values({
        id: 1,
        branchId: 1,
        customerId: 1,
        requestNumber: "FC-RAW-REQUEST",
        recipientName: "عميل",
        recipientPhone: "+9647701234567",
        deliveryAddress: "بغداد",
        createdBy: 1,
        clientRequestId: key(),
        sourceHash: "a".repeat(64),
      });
    const row = await approved({ requestId: 1 });
    await db()
      .insert(s.deliveryParties)
      .values({ id: 1, name: "ناقل", branchId: 1 });
    await db().insert(s.deliveryConsignments).values({
      id: 1,
      consignmentNumber: "FC-RAW-CN",
      branchId: 1,
      partyId: 1,
      sourceType: "FULFILLMENT_REQUEST",
      sourceId: 1,
      fulfillmentRequestId: 1,
      codAmount: "2000",
      feeCollection: "SHOP",
      deliveryFee: "0",
      endCustomerId: 1,
      dispatchedBy: 1,
    });
    await recordFulfillmentChargeCourierCollection(
      {
        branchId: 1,
        partyId: 1,
        consignmentId: 1,
        clientRequestId: key(),
        allocations: [
          { chargeId: row.id, expectedVersion: row.version, amount: "2000" },
        ],
      },
      cashier,
    );
    const remit = async () =>
      remitFulfillmentChargeCourier(
        {
          id: row.id,
          expectedVersion: (await db().select().from(fulfillmentCharges))[0]
            .version,
          clientRequestId: key(),
          originalPaymentId: (
            await db().select().from(fulfillmentChargePayments)
          ).find((p) => p.kind === "COURIER_COLLECTION")!.id,
          amount: "1000",
          tender: { method: "CASH", cashBucket: "DRAWER", shiftId: 1 },
        },
        cashier,
      );
    await remit();
    expect((await db().select().from(s.deliveryConsignments))[0]).toMatchObject(
      {
        status: "PARTIAL",
        moneyStatus: "PARTIAL",
        parcelStatus: "ASSIGNED",
        settledAt: null,
      },
    );
    await db()
      .update(s.deliveryConsignments)
      .set({ parcelStatus: "DELIVERED", courierDeliveredAt: new Date() })
      .where(eq(s.deliveryConsignments.id, 1));
    await remit();
    expect((await db().select().from(s.deliveryConsignments))[0]).toMatchObject(
      {
        status: "DELIVERED",
        moneyStatus: "SETTLED",
        parcelStatus: "DELIVERED",
        collectedAmount: "2000.00",
        settledAt: expect.any(Date),
      },
    );
    expect(await balance()).toBe("0.00");
    expect(
      (await db().select().from(s.deliveryParties))[0].currentBalance,
    ).toBe("0.00");
  });
  it("refunds and remits goods-only old actual cash with an empty assigned-claims snapshot", async () => {
    await db()
      .insert(s.fulfillmentRequests)
      .values({
        id: 1,
        branchId: 1,
        customerId: 1,
        requestNumber: "FC-EMPTY-REQUEST",
        recipientName: "عميل",
        recipientPhone: "+9647701234567",
        deliveryAddress: "بغداد",
        createdBy: 1,
        clientRequestId: key(),
        sourceHash: "a".repeat(64),
      });
    await db().insert(s.invoices).values({
      id: 1,
      branchId: 1,
      customerId: 1,
      invoiceNumber: "FC-PAID-GOODS",
      sourceType: "POS",
      sourceId: key(),
      subtotal: "2000",
      total: "2000",
      paidAmount: "2000",
      status: "PAID",
      createdBy: 1,
    });
    await db()
      .insert(s.deliveryParties)
      .values({ id: 1, name: "ناقل", branchId: 1 });
    await db().insert(s.deliveryConsignments).values({
      id: 1,
      consignmentNumber: "FC-EMPTY-CN",
      branchId: 1,
      partyId: 1,
      sourceType: "INVOICE",
      sourceId: 1,
      invoiceId: 1,
      fulfillmentRequestId: 1,
      codAmount: "0",
      feeCollection: "SHOP",
      deliveryFee: "0",
      endCustomerId: 1,
      dispatchedBy: 1,
    });
    await withTx(async (tx) => {
      expect(
        await attachFulfillmentRequestClaimsTx(
          tx,
          {
            requestId: 1,
            consignmentId: 1,
            partyId: 1,
            branchId: 1,
            clientRequestId: key(),
          },
          manager,
        ),
      ).toEqual({ chargeCodAmount: "0.00" });
      expect(
        await collectAssignedConsignmentClaimsTx(
          tx,
          { consignmentId: 1, actualAmount: "500", eventKey: key() },
          manager,
        ),
      ).toMatchObject({
        invoiceAmount: "0.00",
        chargeAmount: "0.00",
        excessAmount: "500.00",
      });
    });
    const assignment = (await db().select().from(s.deliveryEvents)).find(
      (e) => e.eventType === "FULFILLMENT_CHARGES_ASSIGNED",
    );
    expect(assignment?.payload).toMatchObject({
      requestId: 1,
      customerId: 1,
      invoiceIds: [1],
      chargeIds: [],
    });
    expect(
      (await db().select().from(s.accountingEntries)).find((e) =>
        e.dedupeKey?.startsWith("FULFILLMENT_COURIER_EXCESS:1:"),
      ),
    ).toMatchObject({ customerId: 1, amount: "500.00" });
    expect((await db().select().from(s.invoices))[0].paidAmount).toBe(
      "2000.00",
    );
    expect(await balance()).toBe("0.00");
    expect(
      (await db().select().from(s.deliveryParties))[0].currentBalance,
    ).toBe("500.00");
    const excess = (
      await listFulfillmentCourierExcess({ branchId: 1 }, manager)
    ).rows[0];
    expect(excess).toMatchObject({
      fulfillmentRequestId: 1,
      customerId: 1,
      originalAmount: "500.00",
      remainingAmount: "500.00",
    });
    const refund = {
      fulfillmentRequestId: 1,
      expectedVersion: excess.requestVersion,
      consignmentId: 1,
      originalExcessEntryId: excess.originalExcessEntryId,
      amount: "500",
      reason: "رد أمانة قبض البضاعة الموثق",
      clientRequestId: key(),
      tender: {
        method: "CASH" as const,
        cashBucket: "DRAWER" as const,
        shiftId: 2,
      },
    };
    const first = await refundFulfillmentCourierExcess(refund, manager);
    expect(await refundFulfillmentCourierExcess(refund, manager)).toEqual(
      first,
    );
    expect(
      (await listFulfillmentCourierExcess({ branchId: 1 }, manager)).rows[0]
        .remainingAmount,
    ).toBe("0.00");
    expect(
      await getFinancialPosition({ branchId: 1, verify: false }),
    ).toMatchObject({
      arDebit: "0.00",
      arCredit: "0.00",
      deliveryFloat: "500.00",
      fulfillmentCustomerCredit: "0.00",
      cash: "-500.00",
    });
    expect(
      (await db().select().from(s.deliveryParties))[0].currentBalance,
    ).toBe("500.00");
    await db()
      .update(s.deliveryConsignments)
      .set({ parcelStatus: "DELIVERED", courierDeliveredAt: new Date() })
      .where(eq(s.deliveryConsignments.id, 1));
    await recordDeliveryRemittance(
      {
        branchId: 1,
        partyId: 1,
        lines: [{ consignmentId: 1, collectedAmount: "500" }],
        countedCash: "500",
        targetShiftId: 1,
        clientRequestId: key(),
      },
      cashier,
    );
    expect(
      await getFinancialPosition({ branchId: 1, verify: false }),
    ).toMatchObject({
      arDebit: "0.00",
      arCredit: "0.00",
      deliveryFloat: "0.00",
      fulfillmentCustomerCredit: "0.00",
      cash: "0.00",
    });
    expect(
      (await db().select().from(s.deliveryParties))[0].currentBalance,
    ).toBe("0.00");
    expect((await db().select().from(s.invoices))[0].paidAmount).toBe(
      "2000.00",
    );
    expect(await db().select().from(fulfillmentCharges)).toHaveLength(0);
    expect(await db().select().from(fulfillmentChargePayments)).toHaveLength(0);
    expect((await db().select().from(s.deliveryConsignments))[0]).toMatchObject(
      {
        status: "DELIVERED",
        moneyStatus: "SETTLED",
        collectedAmount: "500.00",
      },
    );
  });
  it("independent charge AR appears in aging and statement without multiplying source invoices", async () => {
    const row = await approved();
    const statement = await getCustomerStatement(1),
      aging = await getARAging({ branchId: 1 });
    expect(statement?.fulfillmentCharges[0].id).toBe(row.id);
    expect(statement?.summary.unpaid).toBe("2000.00");
    expect(aging[0].unpaidTotal).toBe("2000.00");
    expect(statement?.invoices).toHaveLength(0);
  });
});
