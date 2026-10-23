import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  recordCompanyStatement,
  recordDeliveryProof,
  recordManualDeliveryProof,
  recordStaffDeliveryConfirmation,
} from "../delivery/companyStatement";
import { confirmConsignmentDelivery } from "../delivery/courier";
import { payDeliveryFee } from "../delivery/fees";
import { recordDeliveryRemittance } from "../delivery/remittance";
import * as remittanceService from "../delivery/remittance";
import { settleDeliveryBalance } from "../delivery/settle";
import { confirmShipmentDelivery } from "../delivery/shipmentOperations";
import { dispatchInvoiceShipment } from "../delivery/shipments";
import { money } from "../money";
import { createSale } from "../sale/create";
import { openShift } from "../shiftService";
import * as shiftService from "../shiftService";

const CASHIER = { userId: 2, branchId: 1, role: "cashier" };
const MANAGER = { userId: 1, branchId: 1, role: "manager" };
const DRIVER = { userId: 3 };
type FeeCollection = "COURIER" | "SHOP" | "COUNTER";
type Delivery = { invoiceId: number; consignmentId: number; shiftId: number };

function db() {
  const connection = getDb();
  if (!connection) throw new Error("DATABASE_URL not set for tests");
  return connection;
}

const amount = (value: string | number) => money(value).toFixed(2);
const sum = (rows: { amount: string }[]) =>
  rows
    .reduce((total, row) => total.plus(money(row.amount)), money(0))
    .toFixed(2);

beforeEach(async () => {
  await db()
    .insert(s.branches)
    .values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await db()
    .insert(s.users)
    .values([
      {
        id: 1,
        openId: "integrity-manager",
        name: "مدير",
        email: "manager@integrity.test",
        role: "manager",
        loginMethod: "local",
        branchId: 1,
      },
      {
        id: 2,
        openId: "integrity-cashier",
        name: "كاشير",
        email: "cashier@integrity.test",
        role: "cashier",
        loginMethod: "local",
        branchId: 1,
      },
      {
        id: 3,
        openId: "integrity-driver",
        name: "مندوب",
        email: "driver@integrity.test",
        role: "courier",
        loginMethod: "local",
        branchId: 1,
      },
    ]);
  await db().insert(s.customers).values({
    id: 1,
    name: "عميل التوصيل",
    phone: "+9647701234567",
    currentBalance: "0.00",
    creditLimit: null,
  });
  await db().insert(s.deliveryParties).values({
    id: 1,
    name: "شركة توصيل",
    partyType: "COMPANY",
    branchId: 1,
    currentBalance: "0.00",
    defaultFee: "0.00",
    isActive: true,
  });
  await db().insert(s.deliveryPartyMembers).values({
    partyId: 1,
    userId: DRIVER.userId,
    memberRole: "DRIVER",
    isActive: true,
  });
  await db().insert(s.products).values({ id: 1, name: "دفتر" });
  await db().insert(s.productVariants).values({
    id: 1,
    productId: 1,
    sku: "COLLECTION-INTEGRITY",
    costPrice: "500.00",
  });
  await db().insert(s.productUnits).values({
    id: 1,
    variantId: 1,
    unitName: "قطعة",
    conversionFactor: 1,
    isBaseUnit: true,
  });
  await db()
    .insert(s.productPrices)
    .values({ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" });
  await db()
    .insert(s.branchStock)
    .values({ variantId: 1, branchId: 1, quantity: 500 });
  // Real journal lines expose a duplicate AR/custody posting that balanced operational totals can hide.
  await db().insert(s.doubleEntrySettings).values({
    id: 1,
    mode: "SHADOW",
    shadowCycleId: "delivery-collection-integrity",
  });
});

async function sale(
  key: string,
  feeCollection: FeeCollection = "COURIER",
  fee = "0",
): Promise<Delivery> {
  const shift = await openShift(
    { branchId: 1, openingBalance: "0", shiftType: "RECEPTION" },
    CASHIER,
  );
  const result = await createSale(
    {
      branchId: 1,
      shiftId: shift.shiftId,
      sourceType: "POS",
      customerId: 1,
      lines: [{ variantId: 1, productUnitId: 1, quantity: "20" }],
      deliveryFeeHeld: feeCollection === "COUNTER" ? fee : undefined,
      delivery: {
        partyId: 1,
        fee,
        feeCollection,
        recipientPhone: "07701234567",
        address: "بغداد",
        externalTrackingRef: `TRACK-${key}`,
      },
      clientRequestId: `sale-${key}`,
    },
    CASHIER,
  );
  expect(result.consignmentId).toBeDefined();
  return {
    invoiceId: result.invoiceId,
    consignmentId: result.consignmentId!,
    shiftId: shift.shiftId,
  };
}

const statementInput = (
  delivery: Delivery,
  key: string,
  collected: string,
  counted = collected,
) => ({
  branchId: 1,
  partyId: 1,
  statementNumber: key,
  lines: [
    { consignmentId: delivery.consignmentId, collectedAmount: collected },
  ],
  countedCash: counted,
  clientRequestId: `statement-${key}`,
});

async function staffProof(
  delivery: Delivery,
  key: string,
  collected = "20000",
) {
  return recordStaffDeliveryConfirmation(
    {
      consignmentId: delivery.consignmentId,
      collectedAmount: collected,
      evidence: "اتصال المندوب وتأكيد استلام العميل",
      clientRequestId: key,
    },
    CASHIER,
  );
}

async function financialState(delivery: Delivery) {
  const [
    invoiceRows,
    customerRows,
    partyRows,
    consignments,
    entries,
    receipts,
    ledger,
    journal,
  ] = await Promise.all([
    db().select().from(s.invoices).where(eq(s.invoices.id, delivery.invoiceId)),
    db().select().from(s.customers).where(eq(s.customers.id, 1)),
    db().select().from(s.deliveryParties).where(eq(s.deliveryParties.id, 1)),
    db()
      .select()
      .from(s.deliveryConsignments)
      .where(eq(s.deliveryConsignments.id, delivery.consignmentId)),
    db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.invoiceId, delivery.invoiceId)),
    db()
      .select()
      .from(s.receipts)
      .where(
        and(
          eq(s.receipts.shiftId, delivery.shiftId),
          eq(s.receipts.paymentMethod, "CASH"),
          eq(s.receipts.cashBucket, "DRAWER"),
        ),
      ),
    db()
      .select()
      .from(s.deliveryLedgerEntries)
      .where(eq(s.deliveryLedgerEntries.consignmentId, delivery.consignmentId)),
    db().select().from(s.journalLines),
  ]);
  const invoice = invoiceRows[0]!;
  const consignment = consignments[0]!;
  const ledgerTotal = (type: string) =>
    sum(ledger.filter((row) => row.entryType === type));
  const roleDebit = (role: string) =>
    journal
      .filter((row) => row.role === role)
      .reduce(
        (total, row) => total.plus(money(row.debit)).minus(money(row.credit)),
        money(0),
      )
      .toFixed(2);
  const payments = entries.filter((row) => row.entryType === "PAYMENT_IN");
  return {
    total: invoice.total,
    paid: invoice.paidAmount,
    status: invoice.status,
    customer: customerRows[0]!.currentBalance,
    custody: partyRows[0]!.currentBalance,
    cod: consignment.codAmount,
    remitted: consignment.collectedAmount,
    moneyStatus: consignment.moneyStatus,
    parcelStatus: consignment.parcelStatus,
    payments: sum(payments),
    paymentCount: payments.length,
    cash: receipts
      .reduce(
        (total, row) =>
          row.direction === "IN"
            ? total.plus(money(row.amount))
            : total.minus(money(row.amount)),
        money(0),
      )
      .toFixed(2),
    receiptCount: receipts.length,
    collectedLedger: ledgerTotal("COD_COLLECTED"),
    remittedLedger: ledgerTotal("COD_REMITTED"),
    shortfall: ledgerTotal("SHORTFALL_ASSIGNED"),
    feeEarned: ledgerTotal("FEE_EARNED"),
    feePaid: ledgerTotal("FEE_PAID"),
    feeSettled: consignment.feeSettledAt != null,
    journalAR: roleDebit("AR"),
    journalFloat: roleDebit("DELIVERY_FLOAT"),
    journalCash: roleDebit("CASH"),
    payable: money(roleDebit("COURIER_PAYABLE")).neg().toFixed(2),
    expense: roleDebit("DELIVERY_EXPENSE"),
    feeCost: entries
      .filter((row) => row.entryType === "DELIVERY_FEE")
      .reduce((total, row) => total.plus(money(row.cost ?? "0")), money(0))
      .toFixed(2),
    held: sum(entries.filter((row) => row.entryType === "DELIVERY_FEE_HELD")),
  };
}

async function expectCollection(
  delivery: Delivery,
  paid: string,
  collected: string,
  remitted: string,
  custody = "0",
  shortfall = "0",
) {
  expect(await financialState(delivery)).toMatchObject({
    total: "20000.00",
    cod: "20000.00",
    paid: amount(paid),
    customer: money(20000).minus(money(paid)).toFixed(2),
    custody: amount(custody),
    remitted: amount(remitted),
    payments: amount(paid),
    cash: amount(remitted),
    journalCash: amount(remitted),
    collectedLedger: amount(collected),
    remittedLedger: amount(remitted),
    shortfall: amount(shortfall),
    journalAR: money(20000).minus(money(paid)).toFixed(2),
    journalFloat: amount(custody),
  });
}

async function snapshot(delivery: Delivery) {
  return {
    financial: await financialState(delivery),
    invoices: await db().select().from(s.invoices).orderBy(s.invoices.id),
    consignments: await db()
      .select()
      .from(s.deliveryConsignments)
      .orderBy(s.deliveryConsignments.id),
    entries: await db()
      .select()
      .from(s.accountingEntries)
      .orderBy(s.accountingEntries.id),
    receipts: await db().select().from(s.receipts).orderBy(s.receipts.id),
    ledger: await db()
      .select()
      .from(s.deliveryLedgerEntries)
      .orderBy(s.deliveryLedgerEntries.id),
    events: await db()
      .select()
      .from(s.deliveryEvents)
      .orderBy(s.deliveryEvents.id),
    remittances: await db()
      .select()
      .from(s.deliveryRemittances)
      .orderBy(s.deliveryRemittances.id),
    lines: await db()
      .select()
      .from(s.deliveryRemittanceLines)
      .orderBy(s.deliveryRemittanceLines.id),
    idempotency: await db()
      .select()
      .from(s.idempotencyKeys)
      .orderBy(s.idempotencyKeys.id),
    journal: await db()
      .select()
      .from(s.journalLines)
      .orderBy(s.journalLines.id),
  };
}

async function invoiceShipment(key: string) {
  const shift = await openShift(
    { branchId: 1, openingBalance: "0", shiftType: "RECEPTION" },
    CASHIER,
  );
  const invoiceIds: number[] = [];
  for (const suffix of ["first", "second"]) {
    const invoice = await createSale(
      {
        branchId: 1,
        shiftId: shift.shiftId,
        sourceType: "POS",
        customerId: 1,
        lines: [{ variantId: 1, productUnitId: 1, quantity: "20" }],
        clientRequestId: `${key}-${suffix}`,
      },
      CASHIER,
    );
    invoiceIds.push(invoice.invoiceId);
  }
  const shipment = await dispatchInvoiceShipment(
    {
      invoiceId: invoiceIds[0],
      invoiceIds,
      partyId: 1,
      deliveryFee: "1500",
      feeCollection: "SHOP",
      recipientPhone: "07701234567",
      deliveryAddress: "بغداد",
      externalTrackingRef: `TRACK-${key}`,
      clientRequestId: `${key}-dispatch`,
    },
    CASHIER,
  );
  return {
    shipment,
    delivery: {
      invoiceId: invoiceIds[0],
      consignmentId: shipment.leaderConsignmentId,
      shiftId: shift.shiftId,
    },
  };
}

describe("delivery collection, remittance and fee integrity", () => {
  it("does not pay the same earned fee twice with distinct concurrent request keys", async () => {
    const delivery = await sale("fee-concurrent", "SHOP", "1500");
    await staffProof(delivery, "fee-concurrent-proof");
    await recordDeliveryRemittance({
      branchId: 1, partyId: 1,
      lines: [{ consignmentId: delivery.consignmentId, collectedAmount: "20000" }],
      countedCash: "20000", clientRequestId: "fee-concurrent-remit",
    }, CASHIER);
    let release!: () => void, reached!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const arrived = new Promise<void>((resolve) => { reached = resolve; });
    const original = shiftService.resolveBranchCashShiftTx;
    let paused = false;
    const spy = vi.spyOn(shiftService, "resolveBranchCashShiftTx").mockImplementation(async (...args) => {
      if (!paused) { paused = true; reached(); await gate; }
      return original(...args);
    });
    const input = { consignmentId: delivery.consignmentId, shiftId: delivery.shiftId };
    const first = payDeliveryFee({ ...input, clientRequestId: "fee-concurrent-first" }, CASHIER);
    const outcome = first.then((value) => ({ value, error: null }), (error) => ({ value: null, error }));
    try {
      await arrived;
      await payDeliveryFee({ ...input, clientRequestId: "fee-concurrent-second" }, CASHIER);
      release();
      const firstResult = await outcome;
      expect(await financialState(delivery)).toMatchObject({
        feeEarned: "1500.00", feePaid: "1500.00", payable: "0.00",
        cash: "18500.00", journalCash: "18500.00", customer: "0.00", custody: "0.00",
      });
      expect(firstResult.error).not.toBeNull();
    } finally {
      release();
      await outcome;
      spy.mockRestore();
    }
  });
  it.each(["OFF", "ON"] as const)("reads a collection committed after the statement snapshot without crediting the customer twice (%s)", async (ledgerMode) => {
    vi.stubEnv("ROLLOUT_COURIER_LEDGER_DERIVED", ledgerMode);
    const delivery = await sale("concurrent-proof");
    let release!: () => void, reached!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const snapshotReady = new Promise<void>((resolve) => { reached = resolve; });
    const originalLock = remittanceService.lockDeliveryRemittanceCashSourceInTx;
    let paused = false;
    const spy = vi.spyOn(remittanceService, "lockDeliveryRemittanceCashSourceInTx").mockImplementation(async (...args) => {
      if (!paused) { paused = true; reached(); await gate; }
      return originalLock(...args);
    });
    const pending = recordCompanyStatement(statementInput(delivery, "CONCURRENT-CASH", "4000"), CASHIER);
    try {
      await snapshotReady;
      await recordDeliveryProof({
        branchId: 1, partyId: 1, statementNumber: "CONCURRENT-PROOF",
        lines: [{ consignmentId: delivery.consignmentId, collectedAmount: "12000" }],
        clientRequestId: "concurrent-independent-proof",
      }, CASHIER);
      release();
      await pending;
      await expectCollection(delivery, "12000", "12000", "4000", "8000");
      expect(await financialState(delivery)).toMatchObject({ paymentCount: 1, receiptCount: 1 });
    } finally {
      release();
      spy.mockRestore();
      await pending.catch(() => undefined);
      vi.unstubAllEnvs();
    }
  });
  it("collects two invoices as one shipment, remits both references atomically and pays its single fee once", async () => {
    const { shipment, delivery } = await invoiceShipment("group-cash");
    expect(shipment.members).toHaveLength(2);
    expect(shipment.codAmount).toBe("40000.00");
    expect(shipment.members.map((member) => member.deliveryFee)).toEqual([
      "1500.00",
      "0.00",
    ]);
    const proofInput = {
      consignmentId: Number(shipment.members[1].id),
      collectedAmount: "40000",
      evidence: "المندوب قبض كامل فواتير الشحنة الواحدة",
      clientRequestId: "group-cash-proof",
    };
    const confirmed = await confirmShipmentDelivery(proofInput, CASHIER);
    expect(confirmed.consignmentIds).toEqual(
      shipment.members.map((member) => Number(member.id)),
    );
    const proved = await snapshot(delivery);
    expect(proved.invoices.map((invoice) => invoice.paidAmount)).toEqual([
      "20000.00",
      "20000.00",
    ]);
    expect(proved.consignments.map((row) => row.parcelStatus)).toEqual([
      "DELIVERED",
      "DELIVERED",
    ]);
    // Journal/cash/customer values are shipment totals; each PAYMENT_IN remains invoice-specific.
    expect(proved.financial).toMatchObject({
      customer: "0.00",
      custody: "40000.00",
      cash: "0.00",
      journalAR: "0.00",
      journalFloat: "40000.00",
      payable: "1500.00",
      expense: "1500.00",
    });
    expect(
      sum(proved.ledger.filter((entry) => entry.entryType === "COD_COLLECTED")),
    ).toBe("40000.00");
    expect(
      proved.ledger.filter((entry) => entry.entryType === "FEE_EARNED"),
    ).toMatchObject([
      { consignmentId: shipment.leaderConsignmentId, amount: "1500.00" },
    ]);
    for (const member of shipment.members) {
      expect(
        sum(
          proved.entries.filter(
            (entry) =>
              entry.entryType === "PAYMENT_IN" &&
              Number(entry.invoiceId) === Number(member.invoiceId),
          ),
        ),
      ).toBe("20000.00");
    }
    await confirmShipmentDelivery(proofInput, CASHIER);
    expect(await snapshot(delivery)).toEqual(proved);

    const statement = {
      branchId: 1,
      partyId: 1,
      statementNumber: "GROUP-CASH",
      lines: shipment.members.map((member) => ({
        consignmentId: Number(member.id),
        collectedAmount: "20000",
      })),
      countedCash: "40000",
      clientRequestId: "group-cash-statement",
    };
    await expect(
      recordCompanyStatement({ ...statement, countedCash: "40001" }, CASHIER),
    ).rejects.toThrow();
    expect(await snapshot(delivery)).toEqual(proved);
    await recordCompanyStatement(statement, CASHIER);
    const remitted = await snapshot(delivery);
    expect(remitted.financial).toMatchObject({
      customer: "0.00",
      custody: "0.00",
      cash: "40000.00",
      journalAR: "0.00",
      journalFloat: "0.00",
      journalCash: "40000.00",
      payable: "1500.00",
    });
    expect(
      remitted.consignments.map((row) => [
        row.collectedAmount,
        row.moneyStatus,
      ]),
    ).toEqual([
      ["20000.00", "SETTLED"],
      ["20000.00", "SETTLED"],
    ]);
    expect(
      remitted.lines.map((line) => [
        Number(line.consignmentId),
        line.grossApplied,
      ]),
    ).toEqual(
      shipment.members.map((member) => [Number(member.id), "20000.00"]),
    );
    expect(
      sum(remitted.entries.filter((entry) => entry.entryType === "PAYMENT_IN")),
    ).toBe("40000.00");
    expect(
      sum(
        remitted.ledger.filter((entry) => entry.entryType === "COD_REMITTED"),
      ),
    ).toBe("40000.00");
    await recordCompanyStatement(statement, CASHIER);
    expect(await snapshot(delivery)).toEqual(remitted);

    const feeInput = {
      consignmentId: shipment.leaderConsignmentId,
      shiftId: delivery.shiftId,
      clientRequestId: "group-cash-fee",
    };
    const fee = await payDeliveryFee(feeInput, CASHIER);
    const paid = await snapshot(delivery);
    expect(paid.financial).toMatchObject({
      customer: "0.00",
      custody: "0.00",
      cash: "38500.00",
      journalAR: "0.00",
      journalFloat: "0.00",
      journalCash: "38500.00",
      payable: "0.00",
      expense: "1500.00",
    });
    expect(
      sum(paid.ledger.filter((entry) => entry.entryType === "FEE_PAID")),
    ).toBe("1500.00");
    expect(
      paid.invoices.map((invoice) => [invoice.paidAmount, invoice.status]),
    ).toEqual([
      ["20000.00", "PAID"],
      ["20000.00", "PAID"],
    ]);
    expect((await payDeliveryFee(feeInput, CASHIER)).receiptId).toBe(
      fee.receiptId,
    );
    expect(await snapshot(delivery)).toEqual(paid);
  });

  it("rolls back collection of the first shipment invoice when a later member rejects the fan-out", async () => {
    const { shipment, delivery } = await invoiceShipment("group-rollback");
    await db()
      .update(s.deliveryConsignments)
      .set({ returnDeclaredAt: new Date() })
      .where(eq(s.deliveryConsignments.id, Number(shipment.members[1].id)));
    const before = await snapshot(delivery);
    await expect(
      confirmShipmentDelivery(
        {
          consignmentId: shipment.leaderConsignmentId,
          collectedAmount: "40000",
          evidence: "تأكيد استلام فواتير الشحنة",
          clientRequestId: "group-rollback-proof",
        },
        CASHIER,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await snapshot(delivery)).toEqual(before);
    expect(before.invoices.map((invoice) => invoice.paidAmount)).toEqual([
      "0.00",
      "0.00",
    ]);
    expect(before.financial).toMatchObject({
      customer: "40000.00",
      custody: "0.00",
      cash: "0.00",
      journalAR: "40000.00",
      journalFloat: "0.00",
      payable: "0.00",
      expense: "0.00",
    });
  });

  it("collects 12,000 + 4,000 + 4,000 once each and preserves the remaining customer debt after every statement", async () => {
    const delivery = await sale("three-part");
    for (const [index, collected, paid] of [
      [1, "12000", "12000"],
      [2, "4000", "16000"],
      [3, "4000", "20000"],
    ] as const) {
      const input = statementInput(delivery, `THREE-${index}`, collected);
      const result = await recordCompanyStatement(input, CASHIER);
      await expectCollection(delivery, paid, paid, paid);
      const saved = await snapshot(delivery);
      const replay = await recordCompanyStatement(input, CASHIER);
      expect(replay.remittanceId).toBe(result.remittanceId);
      expect(await snapshot(delivery)).toEqual(saved);
    }
    expect(await financialState(delivery)).toMatchObject({
      status: "PAID",
      moneyStatus: "SETTLED",
      paymentCount: 3,
      receiptCount: 3,
    });
  });

  it("remits a full staff-confirmed collection through the first company statement without collecting the customer again", async () => {
    const delivery = await sale("prior-full");
    await staffProof(delivery, "prior-full-proof");
    await expectCollection(delivery, "20000", "20000", "0", "20000");
    const input = statementInput(delivery, "PRIOR-FULL", "20000");
    await recordCompanyStatement(input, CASHIER);
    await expectCollection(delivery, "20000", "20000", "20000");
    expect(await financialState(delivery)).toMatchObject({
      paymentCount: 1,
      receiptCount: 1,
    });
    const saved = await snapshot(delivery);
    await recordCompanyStatement(input, CASHIER);
    expect(await snapshot(delivery)).toEqual(saved);
  });

  it("uses prior independent company proof before collecting only the increase in a later remittance statement", async () => {
    const delivery = await sale("prior-partial");
    await recordDeliveryProof(
      {
        branchId: 1,
        partyId: 1,
        statementNumber: "PARTIAL-PROOF",
        lines: [
          { consignmentId: delivery.consignmentId, collectedAmount: "12000" },
        ],
        clientRequestId: "prior-partial-proof",
      },
      CASHIER,
    );
    await expectCollection(delivery, "12000", "12000", "0", "12000");
    await recordCompanyStatement(
      statementInput(delivery, "PARTIAL-CASH", "16000"),
      CASHIER,
    );
    await expectCollection(delivery, "16000", "16000", "16000");
    expect(await financialState(delivery)).toMatchObject({
      paymentCount: 2,
      status: "PARTIALLY_PAID",
    });
    await recordCompanyStatement(
      statementInput(delivery, "PARTIAL-FINAL", "4000"),
      CASHIER,
    );
    await expectCollection(delivery, "20000", "20000", "20000");
  });

  it("remits an already collected 20,000 in two company statements of 10,000 without changing the paid invoice", async () => {
    const delivery = await sale("prior-split");
    await staffProof(delivery, "prior-split-proof");
    await recordCompanyStatement(
      statementInput(delivery, "PRIOR-SPLIT-1", "10000"),
      CASHIER,
    );
    await expectCollection(delivery, "20000", "20000", "10000", "10000");
    expect(await financialState(delivery)).toMatchObject({
      paymentCount: 1,
      moneyStatus: "PARTIAL",
    });
    await recordCompanyStatement(
      statementInput(delivery, "PRIOR-SPLIT-2", "10000"),
      CASHIER,
    );
    await expectCollection(delivery, "20000", "20000", "20000");
    expect(await financialState(delivery)).toMatchObject({
      paymentCount: 1,
      moneyStatus: "SETTLED",
      receiptCount: 2,
    });
  });

  it.each(["STAFF", "MANUAL", "PORTAL"] as const)(
    "assigns a fully unpaid delivery to the party with a classified reason through %s, including replay",
    async (channel) => {
      const delivery = await sale(`zero-${channel}`);
      const input = {
        consignmentId: delivery.consignmentId,
        collectedAmount: "0",
        evidence: "العميل استلم الطلب ولم يسلم النقد للمندوب",
        shortfallReason: "PARTIAL_REFUSAL",
        clientRequestId: `zero-proof-${channel}`,
      };
      if (channel === "PORTAL") {
        await db()
          .update(s.deliveryConsignments)
          .set({ parcelStatus: "OUT_FOR_DELIVERY" })
          .where(eq(s.deliveryConsignments.id, delivery.consignmentId));
      }
      const confirm = () =>
        channel === "STAFF"
          ? recordStaffDeliveryConfirmation(input, CASHIER)
          : channel === "MANUAL"
            ? recordManualDeliveryProof(input, MANAGER)
            : confirmConsignmentDelivery(input, DRIVER);
      await confirm();
      await expectCollection(delivery, "20000", "0", "0", "20000", "20000");
      expect(await financialState(delivery)).toMatchObject({
        status: "PAID",
        parcelStatus: "DELIVERED",
        paymentCount: 1,
        receiptCount: 0,
      });
      const saved = await snapshot(delivery);
      await confirm();
      expect(await snapshot(delivery)).toEqual(saved);
      expect(await financialState(delivery)).toMatchObject({
        moneyStatus: "SETTLED",
      });
      const settlementInput = {
        branchId: 1,
        partyId: 1,
        amount: "20000",
        shiftType: "RECEPTION" as const,
        clientRequestId: `zero-shortfall-settle-${channel}`,
      };
      await settleDeliveryBalance(settlementInput, CASHIER);
      expect(await financialState(delivery)).toMatchObject({
        paid: "20000.00",
        customer: "0.00",
        custody: "0.00",
        cash: "20000.00",
        journalCash: "20000.00",
        journalFloat: "0.00",
        paymentCount: 1,
        receiptCount: 1,
      });
      const settled = await snapshot(delivery);
      await settleDeliveryBalance(settlementInput, CASHIER);
      expect(await snapshot(delivery)).toEqual(settled);
    },
  );

  it("keeps company proof of zero collection without a reason as customer debt with no cash or party shortfall", async () => {
    const delivery = await sale("company-zero");
    const result = await recordCompanyStatement(
      statementInput(delivery, "ZERO-COMPANY", "0"),
      CASHIER,
    );
    expect(result.remittanceId).toBeNull();
    await expectCollection(delivery, "0", "0", "0");
    expect(await financialState(delivery)).toMatchObject({
      parcelStatus: "DELIVERED",
      paymentCount: 0,
      receiptCount: 0,
    });
  });

  it("rolls back a supplementary collection, customer balance and every monetary document when counted cash exceeds the statement", async () => {
    const delivery = await sale("rollback-partial");
    await recordCompanyStatement(
      statementInput(delivery, "ROLLBACK-FIRST", "12000"),
      CASHIER,
    );
    const saved = await snapshot(delivery);
    await expect(
      recordCompanyStatement(
        statementInput(delivery, "ROLLBACK-BAD", "4000", "5000"),
        CASHIER,
      ),
    ).rejects.toThrow();
    expect(await snapshot(delivery)).toEqual(saved);
    await expectCollection(delivery, "12000", "12000", "12000");
  });

  it.each(["COURIER", "SHOP", "COUNTER"] as const)(
    "preserves COD/customer balances and settles %s fees separately, with no duplicate fee payment",
    async (feeCollection) => {
      const delivery = await sale(
        `fee-${feeCollection}`,
        feeCollection,
        "1500",
      );
      const heldCash = feeCollection === "COUNTER" ? "1500.00" : "0.00";
      expect(await financialState(delivery)).toMatchObject({
        paid: "0.00",
        customer: "20000.00",
        custody: "0.00",
        cod: "20000.00",
        payments: "0.00",
        feeEarned: "0.00",
        feePaid: "0.00",
        cash: heldCash,
        payable: heldCash,
        held: heldCash,
        expense: "0.00",
      });
      await staffProof(delivery, `fee-proof-${feeCollection}`);
      expect(await financialState(delivery)).toMatchObject({
        paid: "20000.00",
        customer: "0.00",
        custody: "20000.00",
        cash: heldCash,
        feeEarned: "1500.00",
        feePaid: feeCollection === "COURIER" ? "1500.00" : "0.00",
        payable: feeCollection === "COURIER" ? "0.00" : "1500.00",
        expense: feeCollection === "SHOP" ? "1500.00" : "0.00",
      });
      const remittance = await recordDeliveryRemittance(
        {
          branchId: 1,
          partyId: 1,
          lines: [
            { consignmentId: delivery.consignmentId, collectedAmount: "20000" },
          ],
          countedCash: "20000",
          clientRequestId: `fee-remit-${feeCollection}`,
        },
        CASHIER,
      );
      expect(remittance.feesTotal).toBe("0.00");
      expect(remittance.netRemitted).toBe("20000.00");
      const feeInput = {
        consignmentId: delivery.consignmentId,
        shiftId: delivery.shiftId,
        clientRequestId: `fee-pay-${feeCollection}`,
      };
      if (feeCollection === "COURIER") {
        const saved = await snapshot(delivery);
        await expect(payDeliveryFee(feeInput, CASHIER)).rejects.toThrow();
        expect(await snapshot(delivery)).toEqual(saved);
      } else {
        const payment = await payDeliveryFee(feeInput, CASHIER);
        const saved = await snapshot(delivery);
        const replay = await payDeliveryFee(feeInput, CASHIER);
        expect(replay.receiptId).toBe(payment.receiptId);
        expect(replay.replay).toBe(true);
        expect(await snapshot(delivery)).toEqual(saved);
        await expect(
          payDeliveryFee(
            {
              ...feeInput,
              clientRequestId: `${feeInput.clientRequestId}-again`,
            },
            CASHIER,
          ),
        ).rejects.toThrow();
        expect(await snapshot(delivery)).toEqual(saved);
      }
      const finalCash = feeCollection === "SHOP" ? "18500.00" : "20000.00";
      expect(await financialState(delivery)).toMatchObject({
        paid: "20000.00",
        customer: "0.00",
        custody: "0.00",
        cod: "20000.00",
        remitted: "20000.00",
        payments: "20000.00",
        paymentCount: 1,
        collectedLedger: "20000.00",
        remittedLedger: "20000.00",
        cash: finalCash,
        journalCash: finalCash,
        journalAR: "0.00",
        journalFloat: "0.00",
        feeEarned: "1500.00",
        feePaid: "1500.00",
        feeSettled: true,
        payable: "0.00",
        held: "0.00",
        expense: feeCollection === "SHOP" ? "1500.00" : "0.00",
        feeCost: feeCollection === "SHOP" ? "1500.00" : "0.00",
      });
    },
  );
});
