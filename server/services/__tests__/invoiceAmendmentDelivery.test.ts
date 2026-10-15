import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createSale } from "../sale/create";
import { correctSale } from "../sale/correct";
import { cancelSale } from "../sale/cancel";
import { recordStaffDeliveryConfirmation } from "../delivery/companyStatement";
import { getDeliveryFinancialSummary } from "../delivery/lifecycle";
import { recordDeliveryRemittance } from "../delivery/remittance";
import { openShift } from "../shiftService";
import { money } from "../money";
import { withTx } from "../tx";
import { postEntry } from "../ledgerService";
import { createPostingIntent, debitLine, creditLine } from "../accounting/postingEngine";
import { extractInsertId } from "../../lib/insertId";
import { loadRefundCaps } from "../returns/refundCaps";

const actor = { userId: 1, branchId: 1, role: "admin" as const };
const db = () => getDb()!;
const line = (quantity: string) => ({
  variantId: 1,
  productUnitId: 1,
  quantity,
});
const invoice = async (id: number) =>
  (await db().select().from(s.invoices).where(eq(s.invoices.id, id)))[0];
const consignment = async (id: number) =>
  (
    await db()
      .select()
      .from(s.deliveryConsignments)
      .where(eq(s.deliveryConsignments.id, id))
  )[0];
const customer = async () =>
  (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0];
const party = async () =>
  (
    await db()
      .select()
      .from(s.deliveryParties)
      .where(eq(s.deliveryParties.id, 1))
  )[0];

beforeEach(async () => {
  await db()
    .insert(s.branches)
    .values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values({
    id: 1,
    openId: "amendment-admin",
    name: "مدير",
    role: "admin",
    branchId: 1,
  });
  await db()
    .insert(s.customers)
    .values({ id: 1, name: "عميل", currentBalance: "0", creditLimit: "0" });
  await db().insert(s.deliveryParties).values({
    id: 1,
    name: "شركة",
    partyType: "COMPANY",
    branchId: 1,
    currentBalance: "0",
    defaultFee: "0",
  });
  await db().insert(s.products).values({ id: 1, name: "دفتر" });
  await db()
    .insert(s.productVariants)
    .values({ id: 1, productId: 1, sku: "AMEND-1", costPrice: "500" });
  await db().insert(s.productUnits).values({
    id: 1,
    variantId: 1,
    unitName: "قطعة",
    conversionFactor: 1,
    isBaseUnit: true,
  });
  await db()
    .insert(s.productPrices)
    .values({ productUnitId: 1, priceTier: "RETAIL", price: "1000" });
  await db()
    .insert(s.branchStock)
    .values({ variantId: 1, branchId: 1, quantity: 100 });
  await openShift(
    { branchId: 1, openingBalance: "0", shiftType: "RECEPTION" },
    actor,
  );
});

async function sale(customerId: number | null = 1) {
  return createSale(
    {
      branchId: 1,
      sourceType: "POS",
      customerId,
      lines: [line("10")],
      delivery: {
        partyId: 1,
        fee: "0",
        feeCollection: "COURIER",
        recipientPhone: "07701234567",
        externalTrackingRef: "AMEND-TRACK-1",
      },
      clientRequestId: "amend-sale",
    },
    actor,
  );
}
async function delivered(id: number) {
  await recordStaffDeliveryConfirmation(
    {
      consignmentId: id,
      collectedAmount: "10000",
      evidence: "اتصال الشركة",
      clientRequestId: "amend-delivered",
    },
    actor,
  );
}
const correct = (id: number, qty: string, key = "amend-correct") =>
  correctSale(
    { originalInvoiceId: id, lines: [line(qty)], clientRequestId: key },
    actor,
  );
const remit = (consignmentId: number, amount: string) =>
  recordDeliveryRemittance(
    {
      branchId: 1,
      partyId: 1,
      lines: [{ consignmentId, collectedAmount: amount }],
      countedCash: amount,
      shiftType: "RECEPTION",
      clientRequestId: `amend-remit-${amount}`,
    },
    actor,
  );

describe("atomic invoice amendment with courier custody", () => {
  it("corrects walk-in unpaid COD without requiring a registered customer", async () => {
    const original = await sale(null);
    const corrected = await correct(original.invoiceId, "8");
    expect(await invoice(corrected.correctedInvoiceId)).toMatchObject({
      customerId: null,
      paymentMode: "COD",
      paidAmount: "0.00",
    });
    expect((await getDeliveryFinancialSummary(1)).codOutstandingRaw).toBe(
      "8000.00",
    );
    expect(await db().select().from(s.receipts)).toHaveLength(0);
  });

  it("corrects cancelled unpaid COD and releases stale exposure without reactivating the parcel", async () => {
    const original = await sale(null);
    await db()
      .update(s.deliveryConsignments)
      .set({
        status: "CANCELLED",
        parcelStatus: "CANCELLED",
        moneyStatus: "CANCELLED",
        custodyRecognizedAt: new Date(),
        feeSettledAt: new Date(),
      })
      .where(eq(s.deliveryConsignments.id, original.consignmentId!));
    const corrected = await correct(original.invoiceId, "8");
    expect(await invoice(corrected.correctedInvoiceId)).toMatchObject({
      customerId: null,
      paymentMode: "COD",
      paidAmount: "0.00",
    });
    expect(await consignment(original.consignmentId!)).toMatchObject({
      status: "CANCELLED",
      parcelStatus: "CANCELLED",
      moneyStatus: "CANCELLED",
    });
    expect((await getDeliveryFinancialSummary(1)).codOutstandingRaw).toBe(
      "0.00",
    );
    expect(await db().select().from(s.receipts)).toHaveLength(0);
  });

  it("corrects live unpaid COD and keeps the same parcel without cash or credit admission", async () => {
    const original = await sale();
    const corrected = await correct(original.invoiceId, "8");
    expect((await invoice(original.invoiceId)).status).toBe("SUPERSEDED");
    expect(await invoice(corrected.correctedInvoiceId)).toMatchObject({
      total: "8000.00",
      paidAmount: "0.00",
      paymentMode: "COD",
    });
    expect(await consignment(original.consignmentId!)).toMatchObject({
      invoiceId: corrected.correctedInvoiceId,
      codAmount: "8000.00",
      parcelStatus: "OUT_FOR_DELIVERY",
    });
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    expect((await getDeliveryFinancialSummary(1)).codOutstandingRaw).toBe(
      "8000.00",
    );
    expect((await customer()).currentBalance).toBe("8000.00");
    expect((await db().select().from(s.branchStock))[0].quantity).toBe(92);
  });

  it("carries a delivered collection without creating a receipt or changing custody", async () => {
    const original = await sale();
    await delivered(original.consignmentId!);
    const corrected = await correct(original.invoiceId, "10");
    expect(await invoice(corrected.correctedInvoiceId)).toMatchObject({
      paidAmount: "10000.00",
      status: "PAID",
    });
    expect(await consignment(original.consignmentId!)).toMatchObject({
      invoiceId: corrected.correctedInvoiceId,
      parcelStatus: "DELIVERED",
    });
    expect((await party()).currentBalance).toBe("10000.00");
    expect((await customer()).currentBalance).toBe("0.00");
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    expect((await getDeliveryFinancialSummary(1)).cashInCustody).toBe(
      "10000.00",
    );
  });

  it("reduces only excess unremitted custody when the corrected total is lower", async () => {
    const original = await sale();
    await delivered(original.consignmentId!);
    const corrected = await correct(original.invoiceId, "8");
    expect(await invoice(corrected.correctedInvoiceId)).toMatchObject({
      paidAmount: "8000.00",
      total: "8000.00",
    });
    expect((await party()).currentBalance).toBe("8000.00");
    expect((await customer()).currentBalance).toBe("0.00");
    expect((await getDeliveryFinancialSummary(1)).cashInCustody).toBe(
      "8000.00",
    );
    expect(await db().select().from(s.receipts)).toHaveLength(0);
  });

  it("cancels a live unpaid parcel and releases exposure in the invoice transaction", async () => {
    const original = await sale();
    const result = await cancelSale(
      {
        invoiceId: original.invoiceId,
        reason: "إلغاء الطلب",
        refundPaymentMethod: "CASH",
        clientRequestId: "amend-cancel",
        enforceOperationalDecision: true,
      },
      actor,
    );
    expect(result.refundAmount).toBe("0.00");
    expect((await invoice(original.invoiceId)).status).toBe("CANCELLED");
    expect((await getDeliveryFinancialSummary(1)).codOutstandingRaw).toBe(
      "0.00",
    );
    expect(await db().select().from(s.receipts)).toHaveLength(0);
  });

  it("rejects delivered unremitted cancellation until physical return without changing money", async () => {
    const original = await sale();
    await delivered(original.consignmentId!);
    const before = await Promise.all([invoice(original.invoiceId), consignment(original.consignmentId!), db().select().from(s.deliveryLedgerEntries), db().select().from(s.branchStock)]);
    await expect(cancelSale(
      {
        invoiceId: original.invoiceId,
        reason: "إلغاء الطلب",
        refundPaymentMethod: "CASH",
        clientRequestId: "amend-cancel-paid",
        enforceOperationalDecision: true,
      },
      actor,
    )).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await Promise.all([invoice(original.invoiceId), consignment(original.consignmentId!), db().select().from(s.deliveryLedgerEntries), db().select().from(s.branchStock)])).toEqual(before);
    expect((await party()).currentBalance).toBe("10000.00");
    expect((await customer()).currentBalance).toBe("0.00");
    expect((await getDeliveryFinancialSummary(1)).cashInCustody).toBe("10000.00");
    expect(await db().select().from(s.receipts)).toHaveLength(0);
  });

  it("keeps partial remittance evidence and only reverses the unremitted excess", async () => {
    const original = await sale();
    await delivered(original.consignmentId!);
    await remit(original.consignmentId!, "4000");
    const remittances = await db().select().from(s.deliveryRemittanceLines);
    const corrected = await correct(original.invoiceId, "8");
    expect((await invoice(corrected.correctedInvoiceId)).paidAmount).toBe(
      "8000.00",
    );
    expect((await party()).currentBalance).toBe("4000.00");
    expect((await getDeliveryFinancialSummary(1)).cashInCustody).toBe(
      "4000.00",
    );
    expect(await db().select().from(s.deliveryRemittanceLines)).toEqual(
      remittances,
    );
    expect(
      (await db().select().from(s.receipts)).map((r) => r.direction),
    ).toEqual(["IN"]);
    expect((await customer()).currentBalance).toBe("0.00");
  });

  it("rejects fully remitted delivered cancellation until physical return with receipts unchanged", async () => {
    const original = await sale();
    await delivered(original.consignmentId!);
    await remit(original.consignmentId!, "10000");
    const before = await Promise.all([invoice(original.invoiceId), consignment(original.consignmentId!), db().select().from(s.receipts), db().select().from(s.deliveryRemittanceLines), db().select().from(s.branchStock)]);
    await expect(cancelSale(
      {
        invoiceId: original.invoiceId,
        reason: "رجوع الطلب",
        refundPaymentMethod: "CASH",
        clientRequestId: "amend-refund-paid",
        enforceOperationalDecision: true,
      },
      actor,
    )).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await Promise.all([invoice(original.invoiceId), consignment(original.consignmentId!), db().select().from(s.receipts), db().select().from(s.deliveryRemittanceLines), db().select().from(s.branchStock)])).toEqual(before);
    expect((await party()).currentBalance).toBe("0.00");
    expect((await customer()).currentBalance).toBe("0.00");
    const receipts = await db().select().from(s.receipts);
    expect(receipts.map((r) => [r.direction, r.amount])).toEqual([
      ["IN", "10000.00"],
    ]);
  });

  it("splits a large correction decrease between custody reversal and an actual cash refund", async () => {
    const original = await sale();
    await delivered(original.consignmentId!);
    await remit(original.consignmentId!, "4000");
    const corrected = await correctSale(
      {
        originalInvoiceId: original.invoiceId,
        lines: [line("3")],
        clientRequestId: "amend-split",
        overpayHandling: "CASH_REFUND",
      },
      actor,
    );
    expect((await invoice(corrected.correctedInvoiceId)).paidAmount).toBe(
      "3000.00",
    );
    expect((await party()).currentBalance).toBe("0.00");
    expect((await customer()).currentBalance).toBe("0.00");
    expect(
      (await db().select().from(s.receipts)).map((r) => [
        r.direction,
        r.amount,
      ]),
    ).toEqual([
      ["IN", "4000.00"],
      ["OUT", "1000.00"],
    ]);
  });

  it("rolls back invoice, custody, stock, ledger and replay key if a replacement is invalid", async () => {
    const original = await sale();
    await delivered(original.consignmentId!);
    const before = await consignment(original.consignmentId!);
    const ledger = await db().select().from(s.deliveryLedgerEntries);
    await expect(
      correct(original.invoiceId, "1000", "amend-invalid"),
    ).rejects.toThrow();
    expect(await consignment(original.consignmentId!)).toEqual(before);
    expect((await invoice(original.invoiceId)).status).toBe("PAID");
    expect((await party()).currentBalance).toBe("10000.00");
    expect((await db().select().from(s.branchStock))[0].quantity).toBe(90);
    expect(await db().select().from(s.deliveryLedgerEntries)).toEqual(ledger);
    expect(
      (await db().select().from(s.idempotencyKeys)).some(
        (r) => r.requestId === "amend-invalid",
      ),
    ).toBe(false);
  });

  it("replays correction without releasing custody or exposure twice", async () => {
    const original = await sale();
    await delivered(original.consignmentId!);
    const first = await correct(original.invoiceId, "8");
    const ledger = await db().select().from(s.deliveryLedgerEntries);
    const replay = await correct(original.invoiceId, "8");
    expect(replay.correctedInvoiceId).toBe(first.correctedInvoiceId);
    expect((await party()).currentBalance).toBe("8000.00");
    expect(await db().select().from(s.deliveryLedgerEntries)).toEqual(ledger);
  });

  it("reverses assigned shortfall before cash custody and creates no cash return for debt relief", async () => {
    const original = await sale();
    await recordStaffDeliveryConfirmation(
      {
        consignmentId: original.consignmentId!,
        collectedAmount: "8000",
        evidence: "اتصال الشركة",
        clientRequestId: "amend-shortfall",
        shortfallReason: "WRONG_PRICE_QUOTED",
      },
      actor,
    );
    const corrected = await correct(original.invoiceId, "9");
    expect((await invoice(corrected.correctedInvoiceId)).paidAmount).toBe(
      "9000.00",
    );
    expect((await party()).currentBalance).toBe("9000.00");
    expect((await customer()).currentBalance).toBe("0.00");
    const ledger = await db().select().from(s.deliveryLedgerEntries);
    expect(
      ledger
        .filter((r) => r.entryType === "SHORTFALL_SETTLED")
        .map((r) => r.amount),
    ).toEqual(["1000.00"]);
    expect(ledger.filter((r) => r.entryType === "COD_RETURNED")).toHaveLength(
      0,
    );
    expect(await db().select().from(s.receipts)).toHaveLength(0);
  });

  it("reattributes courier-paid AR between customers with immutable source collection and no receipt", async () => {
    await db()
      .insert(s.doubleEntrySettings)
      .values({
        id: 1,
        mode: "SHADOW",
        shadowCycleId: "invoice-amendment-customer",
      });
    await db()
      .insert(s.customers)
      .values({
        id: 2,
        name: "العميل الصحيح",
        currentBalance: "0",
        creditLimit: "0",
      });
    const original = await sale();
    await delivered(original.consignmentId!);
    const collection = (
      await db()
        .select()
        .from(s.accountingEntries)
        .where(eq(s.accountingEntries.entryType, "PAYMENT_IN"))
    )[0];
    const corrected = await correctSale(
      {
        originalInvoiceId: original.invoiceId,
        customerId: 2,
        priorPaymentReceivedAmount: "10000",
        lines: [line("8")],
        clientRequestId: "amend-new-customer",
      },
      actor,
    );
    expect((await invoice(corrected.correctedInvoiceId)).customerId).toBe(2);
    expect((await customer()).currentBalance).toBe("0.00");
    expect(
      (await db().select().from(s.customers).where(eq(s.customers.id, 2)))[0]
        .currentBalance,
    ).toBe("0.00");
    expect(
      (
        await db()
          .select()
          .from(s.accountingEntries)
          .where(eq(s.accountingEntries.id, collection.id))
      )[0],
    ).toEqual(collection);
    for (const customerId of [1, 2]) {
      const rows = await db()
        .select({ debit: s.journalLines.debit, credit: s.journalLines.credit })
        .from(s.journalLines)
        .innerJoin(
          s.journalEntries,
          eq(s.journalEntries.id, s.journalLines.journalId),
        )
        .where(
          and(
            eq(s.journalLines.role, "AR"),
            eq(s.journalLines.customerId, customerId),
            eq(s.journalEntries.status, "POSTED"),
          ),
        );
      expect(rows.length).toBeGreaterThan(0);
      expect(
        rows
          .reduce(
            (total, row) =>
              total.plus(money(row.debit)).minus(money(row.credit)),
            money(0),
          )
          .toFixed(2),
      ).toBe("0.00");
    }
    const bridge = (
      await db()
        .select({
          net: sql<string>`COALESCE(SUM(${s.journalLines.debit}-${s.journalLines.credit}),0)`,
        })
        .from(s.journalLines)
        .where(eq(s.journalLines.role, "OPENING_EQUITY"))
    )[0];
    expect(money(bridge.net).toFixed(2)).toBe("0.00");
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    expect((await party()).currentBalance).toBe("8000.00");
  });

  it("corrects again after a split custody/cash refund and keeps that refund in the carried paid pool", async () => {
    const original = await sale();
    await delivered(original.consignmentId!);
    await remit(original.consignmentId!, "4000");
    const first = await correctSale(
      {
        originalInvoiceId: original.invoiceId,
        lines: [line("3")],
        clientRequestId: "amend-first-refund",
        overpayHandling: "CASH_REFUND",
      },
      actor,
    );
    const second = await correct(
      first.correctedInvoiceId,
      "4",
      "amend-after-refund",
    );
    expect(await invoice(second.correctedInvoiceId)).toMatchObject({
      paidAmount: "3000.00",
      total: "4000.00",
      paymentMode: "COD",
    });
    const receipts = await db().select().from(s.receipts);
    expect(receipts.map((r) => [r.direction, r.amount])).toEqual([
      ["IN", "4000.00"],
      ["OUT", "1000.00"],
    ]);
    expect(receipts.find((r) => r.direction === "OUT")?.invoiceId).toBe(
      second.correctedInvoiceId,
    );
    expect((await party()).currentBalance).toBe("0.00");
    expect((await customer()).currentBalance).toBe("1000.00");
  });

  describe("refund source proof", () => {
    it("rejects a refund exceeding the proved pool before changing any invoice or receipt", async () => {
      const shift = (await db().select().from(s.shifts))[0];
      const original = await createSale({ branchId: 1, shiftId: Number(shift.id), sourceType: "POS", customerId: 1, lines: [line("10")], payment: { method: "CASH", amount: "10000" }, clientRequestId: "unproved-rail-sale" }, actor);
      // Inconsistent legacy import: the refund exceeds all proved inbound money.
      await db().insert(s.receipts).values({ invoiceId: original.invoiceId, branchId: 1, direction: "OUT", amount: "12000", paymentMethod: "CARD", referenceNumber: "legacy-refund", status: "COMPLETED", approvalStatus: "APPROVED", createdBy: 1 });
      await db().update(s.invoices).set({ paidAmount: "8000" }).where(eq(s.invoices.id, original.invoiceId));
      const before = await Promise.all([invoice(original.invoiceId), db().select().from(s.receipts), db().select().from(s.branchStock), db().select().from(s.accountingEntries)]);
      await expect(correct(original.invoiceId, "8", "unproved-rail-correct")).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      expect(await Promise.all([invoice(original.invoiceId), db().select().from(s.receipts), db().select().from(s.branchStock), db().select().from(s.accountingEntries)])).toEqual(before);
    });

    it("carries CASH after an actual CARD roundtrip when the customer changes", async () => {
      await db().insert(s.doubleEntrySettings).values({ id: 1, mode: "SHADOW", shadowCycleId: "refund-rails" });
      await db().update(s.customers).set({ creditLimit: "10000" }).where(eq(s.customers.id, 1));
      await db().insert(s.customers).values({ id: 2, name: "العميل الصحيح", currentBalance: "0", creditLimit: "0" });
      const shift = (await db().select().from(s.shifts))[0];
      const original = await createSale({ branchId: 1, shiftId: Number(shift.id), sourceType: "POS", customerId: 1, lines: [line("10")], payment: { method: "CASH", amount: "5000" }, clientRequestId: "rail-sale" }, actor);
      // Historical confirmed processor receipt and refund; their net is zero.
      await withTx(async tx => {
        for (const direction of ["IN", "OUT"] as const) {
          const id = extractInsertId(await tx.insert(s.receipts).values({ invoiceId: original.invoiceId, branchId: 1, shiftId: Number(shift.id), cashBucket: null, direction, amount: "5000", paymentMethod: "CARD", referenceNumber: `processor-${direction}`, cardLastFour: "1234", status: "COMPLETED", approvalStatus: "APPROVED", createdBy: 1 }));
          const amount = money("5000");
          const source = direction === "IN" ? { roleDebits: { CARD_BANK: amount }, roleCredits: { AR: amount } } : { roleDebits: { AR: amount }, roleCredits: { CARD_BANK: amount } };
          await postEntry(tx, { entryType: direction === "IN" ? "PAYMENT_IN" : "PAYMENT_OUT", branchId: 1, invoiceId: original.invoiceId, receiptId: id, customerId: 1, amount, postingIntent: createPostingIntent(direction === "IN" ? "PAYMENT_IN_CUSTOMER" : "PAYMENT_OUT_CUSTOMER_REFUND", direction === "IN" ? "PAYMENT_IN" : "PAYMENT_OUT", direction === "IN" ? [debitLine("CARD_BANK", amount), creditLine("AR", amount)] : [debitLine("AR", amount), creditLine("CARD_BANK", amount)], source), postingSourceComponents: source });
        }
      });
      const history = await db().select().from(s.receipts);
      const corrected = await correctSale({ originalInvoiceId: original.invoiceId, customerId: 2, priorPaymentReceivedAmount: "5000", lines: [line("5")], clientRequestId: "rail-reassign" }, actor);
      const after = await db().select().from(s.receipts);
      expect(after.filter(row => row.invoiceId === corrected.correctedInvoiceId).map(row => [row.direction, row.paymentMethod, row.amount, row.shiftId, row.cashBucket])).toEqual([["IN", "CASH", "5000.00", Number(shift.id), "DRAWER"]]);
      for (const old of history) expect(after.find(row => row.id === old.id)).toMatchObject({ amount: old.amount, paymentMethod: old.paymentMethod, shiftId: old.shiftId, cashBucket: old.cashBucket, referenceNumber: old.referenceNumber, cardLastFour: old.cardLastFour });
      expect(after.filter(row => row.internalNote?.startsWith("SALE_CORRECTION_REVERSAL:")).map(row => [row.paymentMethod, row.amount])).toEqual([["CASH", "5000.00"]]);
      for (const customerId of [1, 2]) {
        const rows = await db().select().from(s.journalLines).where(and(eq(s.journalLines.role, "AR"), eq(s.journalLines.customerId, customerId)));
        expect(rows.reduce((total, row) => total.plus(money(row.debit)).minus(money(row.credit)), money(0)).toFixed(2)).toBe("0.00");
      }
    });

    it("carries refunded store advance with a consignment and zero courier collection", async () => {
      const shift = (await db().select().from(s.shifts))[0];
      const original = await createSale({ branchId: 1, shiftId: Number(shift.id), sourceType: "POS", customerId: 1, lines: [line("10")], payment: { method: "CASH", amount: "10000" }, delivery: { partyId: 1, fee: "0", feeCollection: "COURIER", recipientPhone: "07701234567", externalTrackingRef: "advance-zero" }, clientRequestId: "advance-zero-sale" }, actor);
      const first = await correctSale({ originalInvoiceId: original.invoiceId, lines: [line("8")], clientRequestId: "advance-zero-first", overpayHandling: "CASH_REFUND" }, actor);
      const second = await correctSale({ originalInvoiceId: first.correctedInvoiceId, lines: [line("6")], clientRequestId: "advance-zero-second", overpayHandling: "CASH_REFUND" }, actor);
      expect(await invoice(second.correctedInvoiceId)).toMatchObject({ paidAmount: "6000.00", total: "6000.00" });
      expect((await db().select().from(s.receipts)).map(row => [row.direction, row.amount])).toEqual([["IN", "10000.00"], ["OUT", "2000.00"], ["OUT", "2000.00"]]);
      expect((await party()).currentBalance).toBe("0.00");
      expect((await consignment(original.consignmentId!)).codAmount).toBe("0.00");
    });

    it("preserves pooled CASH refunds of CARD receipts on their original rails when reassigned", async () => {
      await db().insert(s.doubleEntrySettings).values({ id: 1, mode: "SHADOW", shadowCycleId: "pooled-refund" });
      await db().update(s.customers).set({ creditLimit: "10000" }).where(eq(s.customers.id, 1));
      await db().insert(s.customers).values({ id: 2, name: "العميل الصحيح", currentBalance: "0", creditLimit: "0" });
      const shift = (await db().select().from(s.shifts))[0];
      await db().update(s.shifts).set({ openingBalance: "2000" }).where(eq(s.shifts.id, Number(shift.id)));
      const original = await createSale({ branchId: 1, shiftId: Number(shift.id), sourceType: "POS", customerId: 1, lines: [line("10")], clientRequestId: "pooled-card-sale" }, actor);
      await withTx(async tx => {
        const receiptId = extractInsertId(await tx.insert(s.receipts).values({ invoiceId: original.invoiceId, branchId: 1, shiftId: Number(shift.id), direction: "IN", amount: "10000", paymentMethod: "CARD", referenceNumber: "confirmed-card-only", status: "COMPLETED", approvalStatus: "APPROVED", createdBy: 1 }));
        const amount = money("10000");
        const source = { roleDebits: { CARD_BANK: amount }, roleCredits: { AR: amount } };
        await postEntry(tx, { entryType: "PAYMENT_IN", invoiceId: original.invoiceId, receiptId, branchId: 1, customerId: 1, amount, postingIntent: createPostingIntent("PAYMENT_IN_CUSTOMER", "PAYMENT_IN", [debitLine("CARD_BANK", amount), creditLine("AR", amount)], source), postingSourceComponents: source });
        await tx.update(s.invoices).set({ paidAmount: "10000", status: "PAID", paymentMethod: "CARD" }).where(eq(s.invoices.id, original.invoiceId));
        await tx.update(s.customers).set({ currentBalance: "0" }).where(eq(s.customers.id, 1));
      });
      const first = await correctSale({ originalInvoiceId: original.invoiceId, lines: [line("8")], overpayHandling: "CASH_REFUND", clientRequestId: "pooled-cash-refund" }, actor);
      const physicalRefund = (await db().select().from(s.receipts)).find(row => row.direction === "OUT")!;
      const reassigned = await correctSale({ originalInvoiceId: first.correctedInvoiceId, customerId: 2, priorPaymentReceivedAmount: "8000", lines: [line("8")], clientRequestId: "pooled-reassign" }, actor);
      const after = await db().select().from(s.receipts);
      expect(after.find(row => row.id === physicalRefund.id)).toEqual(physicalRefund);
      expect(after.filter(row => row.invoiceId === reassigned.correctedInvoiceId).map(row => [row.direction, row.paymentMethod, row.amount])).toEqual([["IN", "CARD", "8000.00"]]);
      expect(after.filter(row => row.internalNote?.startsWith("SALE_CORRECTION_REVERSAL:")).map(row => [row.direction, row.paymentMethod, row.amount])).toEqual([["OUT", "CARD", "8000.00"]]);
      for (const customerId of [1, 2]) {
        const rows = await db().select().from(s.journalLines).where(and(eq(s.journalLines.role, "AR"), eq(s.journalLines.customerId, customerId)));
        expect(rows.reduce((total, row) => total.plus(money(row.debit)).minus(money(row.credit)), money(0)).toFixed(2)).toBe("0.00");
      }
    });

    it("keeps a single actual refund spanning store and courier in one paid pool", async () => {
      const shift = (await db().select().from(s.shifts))[0];
      await db().insert(s.customers).values({ id: 2, name: "العميل الصحيح", currentBalance: "0", creditLimit: "0" });
      const original = await createSale({ branchId: 1, shiftId: Number(shift.id), sourceType: "POS", customerId: 1, lines: [line("13")], payment: { method: "CASH", amount: "3000" }, delivery: { partyId: 1, fee: "0", feeCollection: "COURIER", recipientPhone: "07701234567", externalTrackingRef: "spanning-refund" }, clientRequestId: "spanning-sale" }, actor);
      await delivered(original.consignmentId!);
      await remit(original.consignmentId!, "10000");
      const first = await correctSale({ originalInvoiceId: original.invoiceId, lines: [line("8")], overpayHandling: "CASH_REFUND", clientRequestId: "spanning-refund-first" }, actor);
      const physicalRefund = (await db().select().from(s.receipts)).find(row => row.direction === "OUT")!;
      const reassigned = await correctSale({ originalInvoiceId: first.correctedInvoiceId, customerId: 2, priorPaymentReceivedAmount: "8000", lines: [line("8")], clientRequestId: "spanning-reassign" }, actor);
      const repeated = await correct(reassigned.correctedInvoiceId, "8", "spanning-repeat");
      expect(await invoice(repeated.correctedInvoiceId)).toMatchObject({ paidAmount: "8000.00", customerId: 2 });
      const rows = await db().select().from(s.receipts);
      expect(rows.filter(row => row.direction === "OUT")).toHaveLength(1);
      expect(rows.find(row => row.id === physicalRefund.id)).toEqual({ ...physicalRefund, invoiceId: repeated.correctedInvoiceId });
      expect(rows.filter(row => row.invoiceId === repeated.correctedInvoiceId).map(row => [row.direction, row.amount])).toEqual([["IN", "3000.00"], ["OUT", "5000.00"]]);
      expect((await loadRefundCaps(db(), repeated.correctedInvoiceId)).pool.toFixed(2)).toBe("8000.00");
      expect((await party()).currentBalance).toBe("0.00");
    });

    it("rejects unrepresentable split-refund reassignment before any invoice stock or AR mutation", async () => {
      await db().insert(s.doubleEntrySettings).values({ id: 1, mode: "SHADOW", shadowCycleId: "split-refund-boundary" });
      await db().insert(s.customers).values({ id: 2, name: "العميل الصحيح", currentBalance: "0", creditLimit: "0" });
      const shift = (await db().select().from(s.shifts))[0];
      const receiptIds: number[] = [];
      for (const [method, amount] of [["CASH", "3000"], ["CARD", "2000"]] as const) {
        receiptIds.push(extractInsertId(await db().insert(s.receipts).values({ branchId: 1, shiftId: Number(shift.id), cashBucket: method === "CASH" ? "DRAWER" : null, direction: "IN", amount, paymentMethod: method, referenceNumber: `confirmed-${method}`, status: "COMPLETED", approvalStatus: "APPROVED", createdBy: 1 })));
      }
      const original = await createSale({ branchId: 1, shiftId: Number(shift.id), sourceType: "POS", customerId: 1, lines: [line("15")], preCollected: { amount: "5000", receiptIds }, delivery: { partyId: 1, fee: "0", feeCollection: "COURIER", recipientPhone: "07701234567", externalTrackingRef: "split-source-proof" }, clientRequestId: "split-source-sale" }, actor);
      await withTx(async tx => {
        for (const [index, role, amountText] of [[0, "CASH", "3000"], [1, "CARD_BANK", "2000"]] as const) {
          const amount = money(amountText);
          const source = { roleDebits: { [role]: amount }, roleCredits: { AR: amount } };
          await postEntry(tx, { entryType: "PAYMENT_IN", branchId: 1, invoiceId: original.invoiceId, receiptId: receiptIds[index], customerId: 1, amount, postingIntent: createPostingIntent("PAYMENT_IN_CUSTOMER", "PAYMENT_IN", [debitLine(role, amount), creditLine("AR", amount)], source), postingSourceComponents: source });
        }
      });
      await delivered(original.consignmentId!);
      await remit(original.consignmentId!, "10000");
      const first = await correctSale({ originalInvoiceId: original.invoiceId, lines: [line("10")], overpayHandling: "CASH_REFUND", clientRequestId: "split-source-refund" }, actor);
      const snapshot = () => Promise.all([db().select().from(s.invoices), db().select().from(s.receipts), db().select().from(s.branchStock), db().select().from(s.accountingEntries), db().select().from(s.journalLines), db().select().from(s.customers), db().select().from(s.deliveryConsignments), db().select().from(s.deliveryLedgerEntries)]);
      const before = await snapshot();
      await expect(correctSale({ originalInvoiceId: first.correctedInvoiceId, customerId: 2, priorPaymentReceivedAmount: "10000", lines: [line("10")], clientRequestId: "split-source-reassign" }, actor)).rejects.toThrow(/طابق توزيع مستند الاسترداد بين المصدرين/);
      expect(await snapshot()).toEqual(before);
    });

    it("attributes a mixed store and remitted courier refund once across customer reassignment", async () => {
      await db().insert(s.doubleEntrySettings).values({ id: 1, mode: "SHADOW", shadowCycleId: "mixed-refund" });
      await db().insert(s.customers).values({ id: 2, name: "العميل الصحيح", currentBalance: "0", creditLimit: "0" });
      const shift = (await db().select().from(s.shifts))[0];
      const original = await createSale({ branchId: 1, shiftId: Number(shift.id), sourceType: "POS", customerId: 1, lines: [line("10")], payment: { method: "CASH", amount: "4000" }, delivery: { partyId: 1, fee: "0", feeCollection: "COURIER", recipientPhone: "07701234567", externalTrackingRef: "mixed-advance" }, clientRequestId: "mixed-advance-sale" }, actor);
      await recordStaffDeliveryConfirmation({ consignmentId: original.consignmentId!, collectedAmount: "6000", evidence: "تحصيل الشركة", clientRequestId: "mixed-delivery" }, actor);
      await remit(original.consignmentId!, "6000");
      const first = await correctSale({ originalInvoiceId: original.invoiceId, lines: [line("8")], clientRequestId: "mixed-refund-first", overpayHandling: "CASH_REFUND" }, actor);
      const actualRefund = (await db().select().from(s.receipts)).find(row => row.direction === "OUT")!;
      const reassigned = await correctSale({ originalInvoiceId: first.correctedInvoiceId, customerId: 2, priorPaymentReceivedAmount: "8000", lines: [line("8")], clientRequestId: "mixed-reassign" }, actor);
      const repeated = await correct(reassigned.correctedInvoiceId, "8", "mixed-repeat");
      expect(await invoice(repeated.correctedInvoiceId)).toMatchObject({ paidAmount: "8000.00", customerId: 2 });
      expect((await db().select().from(s.receipts).where(eq(s.receipts.id, Number(actualRefund.id))))[0]).toEqual(actualRefund);
      expect((await db().select().from(s.receipts).where(eq(s.receipts.invoiceId, repeated.correctedInvoiceId))).map(row => [row.direction, row.amount])).toEqual([["IN", "2000.00"]]);
      for (const customerId of [1, 2]) {
        const rows = await db().select().from(s.journalLines).where(and(eq(s.journalLines.role, "AR"), eq(s.journalLines.customerId, customerId)));
        expect(rows.reduce((total, row) => total.plus(money(row.debit)).minus(money(row.credit)), money(0)).toFixed(2)).toBe("0.00");
      }
      expect((await party()).currentBalance).toBe("0.00");
    });
  });

  it("carries net ordinary CASH across two reductions and cancels only the remaining paid pool", async () => {
    const shift = (await db().select().from(s.shifts))[0];
    const original = await createSale({ branchId: 1, shiftId: Number(shift.id), sourceType: "POS", customerId: 1, lines: [line("10")], payment: { method: "CASH", amount: "10000" }, clientRequestId: "ordinary-cash-original" }, actor);
    const first = await correctSale({ originalInvoiceId: original.invoiceId, lines: [line("8")], clientRequestId: "ordinary-cash-first", overpayHandling: "CASH_REFUND" }, actor);
    const evidence = await db().select().from(s.receipts);
    const second = await correctSale({ originalInvoiceId: first.correctedInvoiceId, lines: [line("6")], clientRequestId: "ordinary-cash-second", overpayHandling: "CASH_REFUND" }, actor);
    expect(await invoice(second.correctedInvoiceId)).toMatchObject({ total: "6000.00", paidAmount: "6000.00" });
    const carried = await db().select().from(s.receipts);
    for (const old of evidence) {
      const current = carried.find(row => row.id === old.id)!;
      expect({ ...current, invoiceId: old.invoiceId }).toEqual(old);
      expect(current.invoiceId).toBe(second.correctedInvoiceId);
    }
    expect(carried.map(row => [row.direction, row.amount])).toEqual([["IN", "10000.00"], ["OUT", "2000.00"], ["OUT", "2000.00"]]);
    const cancelled = await cancelSale({ invoiceId: second.correctedInvoiceId, refundPaymentMethod: "CASH", clientRequestId: "ordinary-cash-cancel", reason: "إلغاء بعد التصحيح" }, actor);
    expect(cancelled.refundAmount).toBe("6000.00");
    const receipts = await db().select().from(s.receipts);
    expect(receipts.reduce((total, row) => row.direction === "IN" ? total.plus(money(row.amount)) : total.minus(money(row.amount)), money(0)).toFixed(2)).toBe("0.00");
    expect((await customer()).currentBalance).toBe("0.00");
    expect((await db().select().from(s.branchStock))[0].quantity).toBe(100);
  });

  it("reassigns only net ordinary CASH after a prior refund and preserves actual drawer cash", async () => {
    await db().insert(s.doubleEntrySettings).values({ id: 1, mode: "SHADOW", shadowCycleId: "ordinary-cash-reassign" });
    await db().insert(s.customers).values({ id: 2, name: "العميل الصحيح", currentBalance: "0", creditLimit: "0" });
    const shift = (await db().select().from(s.shifts))[0];
    const original = await createSale({ branchId: 1, shiftId: Number(shift.id), sourceType: "POS", customerId: 1, lines: [line("10")], payment: { method: "CASH", amount: "10000" }, clientRequestId: "ordinary-reassign-original" }, actor);
    const first = await correctSale({ originalInvoiceId: original.invoiceId, lines: [line("8")], clientRequestId: "ordinary-reassign-first", overpayHandling: "CASH_REFUND" }, actor);
    const reassigned = await correctSale({ originalInvoiceId: first.correctedInvoiceId, customerId: 2, priorPaymentReceivedAmount: "8000", lines: [line("8")], clientRequestId: "ordinary-reassign-net" }, actor);
    expect(await invoice(reassigned.correctedInvoiceId)).toMatchObject({ customerId: 2, paidAmount: "8000.00" });
    const receipts = await db().select().from(s.receipts);
    expect(receipts.filter(row => row.direction === "OUT").map(row => row.amount)).toEqual(["2000.00", "8000.00"]);
    expect(receipts.filter(row => row.direction === "IN").map(row => row.amount)).toEqual(["10000.00", "8000.00"]);
    expect(receipts.reduce((total, row) => row.direction === "IN" ? total.plus(money(row.amount)) : total.minus(money(row.amount)), money(0)).toFixed(2)).toBe("8000.00");
    for (const customerId of [1, 2]) {
      const rows = await db().select({ debit: s.journalLines.debit, credit: s.journalLines.credit }).from(s.journalLines).where(and(eq(s.journalLines.role, "AR"), eq(s.journalLines.customerId, customerId)));
      expect(rows.reduce((total, row) => total.plus(money(row.debit)).minus(money(row.credit)), money(0)).toFixed(2)).toBe("0.00");
    }
    const cancellation = await cancelSale({ invoiceId: reassigned.correctedInvoiceId, refundPaymentMethod: "CASH", clientRequestId: "ordinary-reassign-cancel", reason: "إلغاء الفاتورة المصححة" }, actor);
    expect(cancellation.refundAmount).toBe("8000.00");
    expect((await db().select().from(s.customers).where(eq(s.customers.id, 2)))[0].currentBalance).toBe("0.00");
  });
});
