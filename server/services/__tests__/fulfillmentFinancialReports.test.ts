import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import {
  fulfillmentCharges,
  fulfillmentChargePayments,
} from "../../../drizzle/fulfillmentSchema";
import { getDb } from "../../db";
import { money } from "../money";
import { withTx } from "../tx";
import {
  getFinancialPosition,
  getProfitAndLoss,
} from "../reportsFinancialService";
import {
  createFulfillmentCharge,
  approveFulfillmentCharge,
  collectFulfillmentCharges,
  refundFulfillmentCharge,
  refundFulfillmentChargeExcess,
  refundFulfillmentCourierExcess,
  settleFulfillmentChargePayee,
  type CreateFulfillmentChargeInput,
} from "../fulfillment/charges";
import { postAftercareIssueTx } from "../fulfillment/aftercarePosting";
import {
  supplierApEffectSql,
  isSupplierApRecognitionSql,
  isSupplierApLedgerEntrySql,
} from "../ledger/supplierApEffect";
import {
  attachFulfillmentRequestClaimsTx,
  collectAssignedConsignmentClaimsTx,
} from "../fulfillment/chargeDelivery";
import { truncateTables } from "./__testUtils__";
import { recordDeliveryRemittance } from "../delivery/remittance";

const maker = { userId: 1, branchId: 1, role: "cashier" };
const checker = { userId: 2, branchId: 1, role: "manager" };
let seq = 0;
const key = () => `financial-fulfillment-${Date.now()}-${++seq}`;
function db() {
  const value = getDb();
  if (!value) throw new Error("test database required");
  return value;
}
const position = (asOf?: string, branchId = 1) =>
  getFinancialPosition({ branchId, asOf, verify: false });
const pnl = async () =>
  (
    await getProfitAndLoss({
      branchId: 1,
      from: "2000-01-01",
      to: "2099-12-31",
    })
  ).current;
const tender = {
  method: "CASH" as const,
  cashBucket: "DRAWER" as const,
  shiftId: 1,
};

beforeEach(async () => {
  await truncateTables([
    "fulfillmentChargePayments",
    "fulfillmentCharges",
    "fulfillmentRequestItems",
    "fulfillmentRequests",
    "deliveryOutbox",
    "deliveryEvents",
    "deliveryLedgerEntries",
    "deliveryShipmentMembers",
    "deliveryConsignments",
    "deliveryParties",
    "journalLines",
    "journalEntries",
    "doubleEntrySettings",
    "accountingEntries",
    "auditLogs",
    "idempotencyKeys",
    "receipts",
    "invoiceItems",
    "invoices",
    "shifts",
    "suppliers",
    "customers",
    "branches",
    "users",
  ]);
  await db()
    .insert(s.branches)
    .values([
      { id: 1, name: "Reports", code: "FCR", type: "MAIN" },
      { id: 2, name: "Other", code: "FCR2", type: "SALES" },
    ]);
  await db()
    .insert(s.users)
    .values([
      { id: 1, openId: "fcr-maker", role: "cashier", branchId: 1 },
      { id: 2, openId: "fcr-checker", role: "manager", branchId: 1 },
    ]);
  await db().insert(s.customers).values({
    id: 1,
    name: "Report customer",
    currentBalance: "0",
    creditLimit: null,
  });
  await db()
    .insert(s.suppliers)
    .values({ id: 1, name: "Report contractor", currentBalance: "0" });
  await db().insert(s.shifts).values({
    id: 1,
    userId: 1,
    branchId: 1,
    shiftType: "RECEPTION",
    status: "OPEN",
    openingBalance: "10000",
    openGuard: "1:1:RECEPTION",
  });
  await db().insert(s.shifts).values({
    id: 2,
    userId: 2,
    branchId: 1,
    shiftType: "RECEPTION",
    status: "OPEN",
    openingBalance: "1000",
    openGuard: "2:1:RECEPTION",
  });
});

async function approved(patch: Partial<CreateFulfillmentChargeInput> = {}) {
  const created = await createFulfillmentCharge(
    {
      branchId: 1,
      customerId: 1,
      category: "SERVICE",
      description: "أجر تقرير",
      amount: "2000",
      externalCost: "0",
      clientRequestId: key(),
      ...patch,
    },
    maker,
  );
  return approveFulfillmentCharge(
    {
      id: created.id,
      expectedVersion: created.version,
      clientRequestId: key(),
    },
    checker,
  );
}
async function current(id: number) {
  return (
    await db()
      .select()
      .from(fulfillmentCharges)
      .where(eq(fulfillmentCharges.id, id))
  )[0];
}
async function collect(
  row: { id: number; version: number },
  amount: string,
  actual = amount,
) {
  return collectFulfillmentCharges(
    {
      branchId: 1,
      clientRequestId: key(),
      allocations: [{ chargeId: row.id, expectedVersion: row.version, amount }],
      amount: actual,
      tender,
    },
    maker,
  );
}
async function payee(id: number, amount: string) {
  const row = await current(id);
  return settleFulfillmentChargePayee(
    {
      id,
      expectedVersion: row.version,
      amount,
      tender,
      clientRequestId: key(),
    },
    maker,
  );
}

describe.sequential("classified fulfillment financial report effects", () => {
  it("recognizes outsourced gross revenue and cost once, then moves AR/AP into real cash", async () => {
    const row = await approved({
      category: "OUTSOURCED",
      amount: "5000",
      externalCost: "3000",
      payeeSupplierId: 1,
    });
    const apColumns = {
      entryType: s.accountingEntries.entryType,
      amount: s.accountingEntries.amount,
      liabilityAccount: s.accountingEntries.purchaseLiabilityAccount,
      dedupeKey: s.accountingEntries.dedupeKey,
    };
    const [costEffect] = await db()
      .select({
        effect: supplierApEffectSql(apColumns),
        recognized: isSupplierApRecognitionSql(apColumns),
        visible: isSupplierApLedgerEntrySql(apColumns),
      })
      .from(s.accountingEntries)
      .where(
        eq(s.accountingEntries.dedupeKey, `FULFILLMENT_CHARGE_COST:${row.id}`),
      );
    expect(String(costEffect.effect)).toBe("3000.00");
    expect(Boolean(costEffect.recognized)).toBe(true);
    expect(Boolean(costEffect.visible)).toBe(true);
    expect(await pnl()).toMatchObject({
      revenue: "5000.00",
      cogs: "0.00",
      totalExpenses: "3000.00",
      netProfit: "2000.00",
    });
    expect(await position()).toMatchObject({
      arDebit: "5000.00",
      apCredit: "3000.00",
      totalAssets: "5000.00",
      totalLiabilities: "3000.00",
      equity: "2000.00",
    });
    await collect(row, "5000");
    await payee(row.id, "3000");
    expect(await position()).toMatchObject({
      cash: "2000.00",
      arDebit: "0.00",
      apCredit: "0.00",
      fulfillmentPayeeLiability: "0.00",
      equity: "2000.00",
    });
    expect(await pnl()).toMatchObject({
      totalExpenses: "3000.00",
      netProfit: "2000.00",
    });
    const date = (await db().select().from(s.accountingEntries))[0].entryDate;
    expect(
      await position(
        typeof date === "string" ? date : date.toISOString().slice(0, 10),
      ),
    ).toMatchObject({ arDebit: "0.00", apCredit: "0.00", cash: "2000.00" });
  });

  it("keeps pass-through liability outside revenue and supplier AP until its actual payout", async () => {
    const row = await approved({
      category: "PASS_THROUGH",
      amount: "3000",
      externalCost: "3000",
      payeeSupplierId: 1,
    });
    expect(await position()).toMatchObject({
      arDebit: "3000.00",
      apCredit: "0.00",
      fulfillmentPassThroughLiability: "3000.00",
      totalLiabilities: "3000.00",
      equity: "0.00",
    });
    await collect(row, "3000");
    expect(await position()).toMatchObject({
      cash: "3000.00",
      arDebit: "0.00",
      fulfillmentPassThroughLiability: "3000.00",
    });
    await payee(row.id, "3000");
    expect(await position()).toMatchObject({
      cash: "0.00",
      fulfillmentPassThroughLiability: "0.00",
      totalLiabilities: "0.00",
      equity: "0.00",
    });
    expect(await pnl()).toMatchObject({
      revenue: "0.00",
      totalExpenses: "0.00",
      netProfit: "0.00",
    });
  });

  it("credits refunded pass-through claim and preserves original allocation caps in reports", async () => {
    const row = await approved({
      category: "PASS_THROUGH",
      amount: "3000",
      externalCost: "3000",
      payeeSupplierId: 1,
    });
    await collect(row, "3000");
    const source = (await db().select().from(fulfillmentChargePayments))[0];
    const updated = await current(row.id);
    await refundFulfillmentCharge(
      {
        id: row.id,
        expectedVersion: updated.version,
        originalPaymentId: source.id,
        amount: "1000",
        reason: "إلغاء جزء من الخدمة",
        clientRequestId: key(),
      },
      checker,
    );
    expect(await position()).toMatchObject({
      cash: "2000.00",
      arDebit: "0.00",
      arCredit: "0.00",
      fulfillmentPassThroughLiability: "2000.00",
      equity: "0.00",
    });
    expect(await pnl()).toMatchObject({
      revenue: "0.00",
      totalExpenses: "0.00",
    });
  });

  it("shows a named contractor accrual by branch/date and never expenses its payment twice", async () => {
    const row = await approved({
      category: "SHOP_EXPENSE",
      customerId: null,
      amount: "0",
      externalCost: "3000",
      payeeName: "متعهد مستقل",
      payeePhone: "+9647701234567",
    });
    expect(await position()).toMatchObject({
      fulfillmentPayeeLiability: "3000.00",
      apCredit: "0.00",
      totalLiabilities: "3000.00",
      equity: "-3000.00",
    });
    expect((await position(undefined, 2)).fulfillmentPayeeLiability).toBe(
      "0.00",
    );
    expect((await position("2000-01-01")).fulfillmentPayeeLiability).toBe(
      "0.00",
    );
    await payee(row.id, "3000");
    expect(await position()).toMatchObject({
      cash: "-3000.00",
      fulfillmentPayeeLiability: "0.00",
      equity: "-3000.00",
    });
    expect(await pnl()).toMatchObject({
      totalExpenses: "3000.00",
      netProfit: "-3000.00",
    });
  });

  it("keeps cash overcollection as an explicit customer credit and reconstructs AR from allocated amount", async () => {
    const row = await approved();
    const received = await collect(row, "2000", "2300");
    expect(await position()).toMatchObject({
      cash: "2300.00",
      arDebit: "0.00",
      arCredit: "0.00",
      fulfillmentCustomerCredit: "300.00",
      totalLiabilities: "300.00",
      equity: "2000.00",
    });
    const entry = (await db().select().from(s.accountingEntries))[0];
    const day =
      typeof entry.entryDate === "string"
        ? entry.entryDate
        : entry.entryDate.toISOString().slice(0, 10);
    expect(await position(day)).toMatchObject({
      arDebit: "0.00",
      arCredit: "0.00",
      fulfillmentCustomerCredit: "300.00",
    });
    const updated = await current(row.id);
    await refundFulfillmentChargeExcess(
      {
        id: row.id,
        expectedVersion: updated.version,
        originalReceiptId: received.receiptId,
        amount: "300",
        reason: "رد فائض القبض",
        clientRequestId: key(),
      },
      checker,
    );
    expect(await position(day)).toMatchObject({
      cash: "2000.00",
      arDebit: "0.00",
      arCredit: "0.00",
      fulfillmentCustomerCredit: "0.00",
    });
    expect(await pnl()).toMatchObject({
      revenue: "2000.00",
      totalExpenses: "0.00",
    });
  });

  it("keeps collected charge COD as a real asset after the writer clears customer AR", async () => {
    await db()
      .insert(s.fulfillmentRequests)
      .values({
        id: 1,
        branchId: 1,
        customerId: 1,
        requestNumber: "FCR-REQUEST",
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
      consignmentNumber: "FCR-CN",
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
        checker,
      );
      await collectAssignedConsignmentClaimsTx(
        tx,
        { consignmentId: 1, actualAmount: "2000", eventKey: key() },
        checker,
      );
    });
    expect((await current(row.id)).paidAmount).toBe("2000.00");
    expect(await position()).toMatchObject({
      cash: "0.00",
      arDebit: "0.00",
      deliveryFloat: "2000.00",
      deliveryFloatCustomerBacked: "0.00",
      totalAssets: "2000.00",
      equity: "2000.00",
    });
  });

  it("preserves invoice-backed excess custody through refund and partial remittances with date/branch limits", async () => {
    await db()
      .insert(s.fulfillmentRequests)
      .values({
        id: 1,
        branchId: 1,
        customerId: 1,
        requestNumber: "FCR-EXCESS",
        recipientName: "عميل",
        recipientPhone: "+9647701234567",
        deliveryAddress: "بغداد",
        createdBy: 1,
        clientRequestId: key(),
        sourceHash: "a".repeat(64),
      });
    await db()
      .insert(s.invoices)
      .values({
        id: 1,
        branchId: 1,
        customerId: 1,
        invoiceNumber: "FCR-PAID",
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
      .values({ id: 1, name: "ناقل الفائض", branchId: 1 });
    await db()
      .insert(s.deliveryConsignments)
      .values({
        id: 1,
        consignmentNumber: "FCR-EXCESS-CN",
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
      await attachFulfillmentRequestClaimsTx(
        tx,
        {
          requestId: 1,
          consignmentId: 1,
          partyId: 1,
          branchId: 1,
          clientRequestId: key(),
        },
        checker,
      );
      await collectAssignedConsignmentClaimsTx(
        tx,
        { consignmentId: 1, actualAmount: "500", eventKey: key() },
        checker,
      );
    });
    const source = (await db().select().from(s.accountingEntries)).find((e) =>
      e.dedupeKey?.startsWith("FULFILLMENT_COURIER_EXCESS:1:"),
    )!;
    const day =
      typeof source.entryDate === "string"
        ? source.entryDate
        : source.entryDate.toISOString().slice(0, 10);
    expect(await position()).toMatchObject({
      arDebit: "0.00",
      arCredit: "0.00",
      deliveryFloat: "500.00",
      deliveryFloatCustomerBacked: "0.00",
      fulfillmentCustomerCredit: "500.00",
      cash: "0.00",
    });
    expect(await position(day)).toMatchObject({
      deliveryFloat: "500.00",
      fulfillmentCustomerCredit: "500.00",
    });
    expect(await position(undefined, 2)).toMatchObject({
      deliveryFloat: "0.00",
      fulfillmentCustomerCredit: "0.00",
    });
    expect(await position("2000-01-01")).toMatchObject({
      deliveryFloat: "0.00",
      fulfillmentCustomerCredit: "0.00",
    });
    const [request] = await db()
      .select()
      .from(s.fulfillmentRequests)
      .where(eq(s.fulfillmentRequests.id, 1));
    await refundFulfillmentCourierExcess(
      {
        fulfillmentRequestId: 1,
        expectedVersion: request.version,
        consignmentId: 1,
        originalExcessEntryId: source.id,
        amount: "500",
        reason: "رد فائض قبض حقيقي قبل التوريد",
        clientRequestId: key(),
        tender: { method: "CASH", cashBucket: "DRAWER", shiftId: 2 },
      },
      checker,
    );
    expect(await position()).toMatchObject({
      deliveryFloat: "500.00",
      fulfillmentCustomerCredit: "0.00",
      cash: "-500.00",
      arDebit: "0.00",
      arCredit: "0.00",
    });
    await db()
      .update(s.deliveryConsignments)
      .set({ parcelStatus: "DELIVERED", courierDeliveredAt: new Date() })
      .where(eq(s.deliveryConsignments.id, 1));
    await recordDeliveryRemittance(
      {
        branchId: 1,
        partyId: 1,
        lines: [{ consignmentId: 1, collectedAmount: "200" }],
        countedCash: "200",
        targetShiftId: 1,
        clientRequestId: key(),
      },
      maker,
    );
    expect(await position()).toMatchObject({
      deliveryFloat: "300.00",
      fulfillmentCustomerCredit: "0.00",
      cash: "-300.00",
      arDebit: "0.00",
    });
    await recordDeliveryRemittance(
      {
        branchId: 1,
        partyId: 1,
        lines: [{ consignmentId: 1, collectedAmount: "300" }],
        countedCash: "300",
        targetShiftId: 1,
        clientRequestId: key(),
      },
      maker,
    );
    expect(await position(day)).toMatchObject({
      deliveryFloat: "0.00",
      fulfillmentCustomerCredit: "0.00",
      cash: "0.00",
      arDebit: "0.00",
      arCredit: "0.00",
    });
    expect(await db().select().from(fulfillmentCharges)).toHaveLength(0);
    expect(await db().select().from(fulfillmentChargePayments)).toHaveLength(0);
  });

  it("recognizes actual aftercare issue cost once without a second sale or a cash expense", async () => {
    await withTx((tx) =>
      postAftercareIssueTx(tx, {
        executionId: 987,
        branchId: 1,
        actorId: 2,
        cost: money("500"),
      }),
    );
    expect(await pnl()).toMatchObject({
      revenue: "0.00",
      cogs: "0.00",
      totalExpenses: "500.00",
      netProfit: "-500.00",
    });
    expect(await position()).toMatchObject({ cash: "0.00", arDebit: "0.00" });
    expect(await db().select().from(s.accountingEntries)).toHaveLength(1);
  });
});
