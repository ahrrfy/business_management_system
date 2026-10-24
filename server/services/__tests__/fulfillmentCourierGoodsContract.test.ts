import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import {
  fulfillmentCharges,
  fulfillmentChargePayments,
} from "../../../drizzle/fulfillmentSchema";
import { getDb } from "../../db";
import {
  createFulfillmentRequest,
  releaseFulfillmentRequest,
} from "../fulfillment/requests";
import {
  createFulfillmentCharge,
  approveFulfillmentCharge,
} from "../fulfillment/charges";
import {
  acknowledgeConsignmentClaim,
  confirmConsignmentDelivery,
} from "../delivery/courier";
import { recordDeliveryRemittance } from "../delivery/remittance";
import { dispatchInvoiceToDelivery } from "../delivery/dispatchInvoice";
import { recordCompanyStatement } from "../delivery/companyStatement";

const admin = { userId: 1, branchId: 1, role: "admin" };
const cashier = { userId: 2, branchId: 1, role: "cashier" };
const driver = { userId: 3 };
let sequence = 0;
const key = () => `FGC-CONTRACT-${++sequence}`;
function db() {
  const value = getDb();
  if (!value) throw new Error("isolated test DB required");
  return value;
}
beforeEach(async () => {
  await db()
    .insert(s.branches)
    .values({ id: 1, name: "MAIN", code: "FGC", type: "MAIN" });
  await db()
    .insert(s.users)
    .values([
      { id: 1, openId: "fgc-admin", role: "admin", branchId: 1 },
      { id: 2, openId: "fgc-cashier", role: "cashier", branchId: 1 },
      { id: 3, openId: "fgc-driver", role: "courier", branchId: 1 },
    ]);
  await db().insert(s.customers).values({
    id: 1,
    name: "عميل آجل",
    phone: "+9647701234567",
    currentBalance: "10000",
    creditLimit: null,
  });
  await db().insert(s.deliveryParties).values({
    id: 1,
    name: "ناقل الطلب",
    partyType: "INDIVIDUAL",
    userId: 3,
    branchId: 1,
    currentBalance: "0",
    isActive: true,
  });
  await db().insert(s.deliveryPartyMembers).values({
    partyId: 1,
    userId: 3,
    memberRole: "DRIVER",
    isActive: true,
    createdBy: 1,
  });
  await db().insert(s.shifts).values({
    id: 1,
    branchId: 1,
    userId: 1,
    shiftType: "RECEPTION",
    status: "OPEN",
    openingBalance: "0",
    openGuard: "1:1:RECEPTION",
  });
});

async function dispatchGoods(
  options: {
    anonymous?: boolean;
    prepaid?: boolean;
    credit?: boolean;
    charge?: boolean;
    company?: boolean;
  } = {},
) {
  const customerId = options.anonymous ? null : 1;
  if (options.company)
    await db()
      .update(s.deliveryParties)
      .set({ partyType: "COMPANY" })
      .where(eq(s.deliveryParties.id, 1));
  await db()
    .insert(s.invoices)
    .values({
      id: 1,
      invoiceNumber: "FGC-INVOICE-1",
      branchId: 1,
      customerId,
      contactName: "مستلم الطلب",
      contactPhone: "+9647701234567",
      total: "10000",
      subtotal: "10000",
      paidAmount: options.prepaid ? "10000" : "0",
      status: options.prepaid ? "PAID" : "PENDING",
      paymentMode: options.credit ? "CREDIT" : "COD",
      createdBy: 2,
    });
  const request = await createFulfillmentRequest(
    {
      branchId: 1,
      customerId,
      recipientName: "مستلم الطلب",
      recipientPhone: "07701234567",
      deliveryAddress: "بغداد / المنصور",
      partyId: 1,
      deliveryFee: "0",
      feeCollection: "COURIER",
      sources: [{ invoiceId: 1 }],
      clientRequestId: key(),
    },
    admin,
  );
  let chargeId: number | undefined;
  if (options.charge) {
    const charge = await createFulfillmentCharge(
      {
        branchId: 1,
        requestId: request.id,
        customerId: 1,
        category: "SERVICE",
        description: "أجر تغليف مستقل",
        amount: "2000",
        externalCost: "0",
        clientRequestId: key(),
      },
      cashier,
    );
    await approveFulfillmentCharge(
      {
        id: charge.id,
        expectedVersion: charge.version,
        clientRequestId: key(),
      },
      admin,
    );
    chargeId = charge.id;
  }
  const sent = await releaseFulfillmentRequest(
    {
      assignedUserId: 3,
      id: request.id,
      expectedVersion: request.version,
      clientRequestId: key(),
      ...(options.company
        ? { externalTrackingRef: key() }
        : {}),
    },
    admin,
  );
  const [cn] = await db()
    .select()
    .from(s.deliveryConsignments)
    .where(eq(s.deliveryConsignments.id, sent.consignmentId));
  return { cn, chargeId };
}

async function goodsSnapshot() {
  return {
    invoices: await db().select().from(s.invoices),
    receipts: await db().select().from(s.receipts),
    stock: await db().select().from(s.branchStock),
    movements: await db().select().from(s.inventoryMovements),
    sales: (await db().select().from(s.accountingEntries)).filter(
      (entry) => entry.entryType === "SALE",
    ),
  };
}
async function acknowledge(cn: typeof s.deliveryConsignments.$inferSelect) {
  await acknowledgeConsignmentClaim(
    {
      consignmentId: cn.id,
      expectedClaimVersion: cn.codClaimVersion,
      clientRequestId: key(),
    },
    driver,
  );
}

async function remitAndReplay(consignmentId: number, amount: string) {
  const input = {
    branchId: 1,
    partyId: 1,
    lines: [{ consignmentId, collectedAmount: amount }],
    countedCash: amount,
    targetShiftId: 1,
    clientRequestId: key(),
  };
  const result = await recordDeliveryRemittance(input, admin);
  const snapshot = async () => ({
    goods: await goodsSnapshot(),
    entries: await db().select().from(s.accountingEntries),
    payments: await db().select().from(fulfillmentChargePayments),
    parties: await db().select().from(s.deliveryParties),
    customers: await db().select().from(s.customers),
  });
  const beforeReplay = await snapshot();
  expect(await recordDeliveryRemittance(input, admin)).toMatchObject({
    remittanceId: result.remittanceId,
    idempotentReplay: true,
  });
  expect(await snapshot()).toEqual(beforeReplay);
  return result;
}

describe("fulfillment courier goods COD contract", () => {
  it("delivers a phone-validated anonymous prepaid invoice without inventing a customer or collection", async () => {
    const { cn } = await dispatchGoods({ anonymous: true, prepaid: true });
    expect(cn).toMatchObject({ codAmount: "0.00", endCustomerId: null });
    const before = await goodsSnapshot();
    const input = { consignmentId: cn.id, clientRequestId: key() };
    await confirmConsignmentDelivery(input, driver);
    await confirmConsignmentDelivery(input, driver);
    expect(await goodsSnapshot()).toEqual(before);
    expect((await db().select().from(s.deliveryConsignments))[0]).toMatchObject(
      { parcelStatus: "DELIVERED", moneyStatus: "SETTLED" },
    );
    expect(
      (await db().select().from(s.deliveryParties))[0].currentBalance,
    ).toBe("0.00");
    expect(
      (await db().select().from(s.accountingEntries)).filter(
        (entry) => entry.entryType === "PAYMENT_IN",
      ),
    ).toHaveLength(0);
    expect(
      (await db().select().from(s.deliveryLedgerEntries)).filter(
        (entry) => entry.entryType === "COD_COLLECTED",
      ),
    ).toHaveLength(0);
  });

  it("collects eligible anonymous goods COD once without touching another customer's debt", async () => {
    const { cn } = await dispatchGoods({ anonymous: true });
    expect(cn.codAmount).toBe("10000.00");
    const input = { consignmentId: cn.id, clientRequestId: key() };
    await confirmConsignmentDelivery(input, driver);
    await confirmConsignmentDelivery(input, driver);
    expect((await db().select().from(s.invoices))[0]).toMatchObject({
      customerId: null,
      paidAmount: "10000.00",
      status: "PAID",
    });
    expect((await db().select().from(s.customers))[0].currentBalance).toBe(
      "10000.00",
    );
    expect(
      (await db().select().from(s.deliveryParties))[0].currentBalance,
    ).toBe("10000.00");
    expect(
      (await db().select().from(s.accountingEntries)).filter(
        (entry) => entry.entryType === "PAYMENT_IN",
      ),
    ).toMatchObject([{ invoiceId: 1, customerId: null, amount: "10000.00" }]);
    expect(await db().select().from(s.receipts)).toHaveLength(0);
  });

  it("defaults CREDIT delivery to zero collection and preserves the invoice receivable", async () => {
    const { cn } = await dispatchGoods({ credit: true });
    expect(cn.codAmount).toBe("0.00");
    const before = await goodsSnapshot();
    await confirmConsignmentDelivery(
      { consignmentId: cn.id, clientRequestId: key() },
      driver,
    );
    expect(await goodsSnapshot()).toEqual(before);
    expect((await db().select().from(s.customers))[0].currentBalance).toBe(
      "10000.00",
    );
    expect(
      (await db().select().from(s.deliveryParties))[0].currentBalance,
    ).toBe("0.00");
    expect(
      (await db().select().from(s.accountingEntries)).filter(
        (entry) => entry.entryType === "PAYMENT_IN",
      ),
    ).toHaveLength(0);
    expect(
      (await db().select().from(s.deliveryLedgerEntries)).filter(
        (entry) => entry.entryType === "COD_COLLECTED",
      ),
    ).toHaveLength(0);
  });

  it.each([
    { mode: "full", amounts: ["2000"] },
    { mode: "partial", amounts: ["750", "1250"] },
  ])(
    "defaults a CREDIT invoice plus a true service charge to the charge COD alone through $mode remittance",
    async ({ amounts }) => {
      const { cn, chargeId } = await dispatchGoods({
        credit: true,
        charge: true,
      });
      expect(cn.codAmount).toBe("2000.00");
      await acknowledge(cn);
      const before = await goodsSnapshot();
      await confirmConsignmentDelivery(
        { consignmentId: cn.id, clientRequestId: key() },
        driver,
      );
      expect(await goodsSnapshot()).toEqual(before);
      expect((await db().select().from(fulfillmentCharges))[0]).toMatchObject({
        id: chargeId,
        paidAmount: "2000.00",
      });
      expect((await db().select().from(s.customers))[0].currentBalance).toBe(
        "10000.00",
      );
      expect(
        (await db().select().from(s.deliveryParties))[0].currentBalance,
      ).toBe("2000.00");
      expect(await db().select().from(fulfillmentChargePayments)).toMatchObject(
        [{ kind: "COURIER_COLLECTION", amount: "2000.00" }],
      );
      expect(
        (await db().select().from(s.accountingEntries)).filter(
          (entry) => entry.entryType === "PAYMENT_IN",
        ),
      ).toMatchObject([{ invoiceId: null, amount: "2000.00" }]);
      const originalInvoice = before.invoices;
      for (const amount of amounts) {
        const result = await remitAndReplay(cn.id, amount);
        expect(result.netRemitted).toBe(`${amount}.00`);
        expect(await db().select().from(s.invoices)).toEqual(originalInvoice);
        expect((await db().select().from(s.customers))[0].currentBalance).toBe(
          "10000.00",
        );
        expect(
          (await db().select().from(s.accountingEntries)).filter(
            (entry) =>
              entry.invoiceId === 1 && entry.entryType === "PAYMENT_IN",
          ),
        ).toHaveLength(0);
      }
      expect(
        (await db().select().from(s.deliveryParties))[0].currentBalance,
      ).toBe("0.00");
      expect(
        (await db().select().from(s.deliveryConsignments))[0],
      ).toMatchObject({
        status: "DELIVERED",
        moneyStatus: "SETTLED",
        collectedAmount: "2000.00",
      });
      const payments = await db().select().from(fulfillmentChargePayments);
      expect(
        payments
          .filter((payment) => payment.kind === "COURIER_REMITTANCE")
          .map((payment) => payment.amount),
      ).toEqual(amounts.map((amount) => `${amount}.00`));
      expect(
        (await db().select().from(s.receipts)).map((receipt) => receipt.amount),
      ).toEqual(amounts.map((amount) => `${amount}.00`));
    },
  );

  it("requires proof for cash beyond charge COD and records proven excess without paying CREDIT goods", async () => {
    const { cn } = await dispatchGoods({ credit: true, charge: true });
    const before = await goodsSnapshot();
    const input = {
      consignmentId: cn.id,
      collectedAmount: "3000",
      clientRequestId: key(),
    };
    await expect(confirmConsignmentDelivery(input, driver)).rejects.toThrow(
      /يتجاوز المطالبة الحالية/,
    );
    expect(await goodsSnapshot()).toEqual(before);
    expect(
      (await db().select().from(s.deliveryParties))[0].currentBalance,
    ).toBe("0.00");
    expect((await db().select().from(fulfillmentCharges))[0].paidAmount).toBe(
      "0.00",
    );
    expect(
      (await db().select().from(s.deliveryConsignments))[0].parcelStatus,
    ).toBe("OUT_FOR_DELIVERY");
    const proven = {
      ...input,
      clientRequestId: key(),
      collectionEvidence: "قبض فعلي موثق يزيد على مطالبة التغليف",
    };
    await confirmConsignmentDelivery(proven, driver);
    await confirmConsignmentDelivery(proven, driver);
    expect(await goodsSnapshot()).toEqual(before);
    expect((await db().select().from(s.customers))[0].currentBalance).toBe(
      "10000.00",
    );
    expect(
      (await db().select().from(s.deliveryParties))[0].currentBalance,
    ).toBe("3000.00");
    const entries = await db().select().from(s.accountingEntries);
    expect(
      entries.filter(
        (entry) => entry.invoiceId === 1 && entry.entryType === "PAYMENT_IN",
      ),
    ).toHaveLength(0);
    expect(
      entries.filter((entry) =>
        entry.dedupeKey?.startsWith("FULFILLMENT_COURIER_EXCESS:"),
      ),
    ).toMatchObject([{ amount: "1000.00" }]);
    expect(
      (await db().select().from(s.deliveryLedgerEntries)).filter(
        (entry) => entry.entryType === "COD_COLLECTED",
      ),
    ).toMatchObject([{ amount: "3000.00" }]);
    await remitAndReplay(cn.id, "3000");
    expect(await db().select().from(s.invoices)).toEqual(before.invoices);
    expect((await db().select().from(s.customers))[0].currentBalance).toBe(
      "10000.00",
    );
    expect(
      (await db().select().from(s.deliveryParties))[0].currentBalance,
    ).toBe("0.00");
    const afterRemit = await db().select().from(s.accountingEntries);
    expect(
      afterRemit.filter(
        (entry) => entry.invoiceId === 1 && entry.entryType === "PAYMENT_IN",
      ),
    ).toHaveLength(0);
    expect(
      afterRemit.filter((entry) =>
        entry.dedupeKey?.startsWith("FULFILLMENT_COURIER_EXCESS:"),
      ),
    ).toMatchObject([{ amount: "1000.00" }]);
    expect(
      (await db().select().from(fulfillmentChargePayments)).filter(
        (payment) => payment.kind === "COURIER_REMITTANCE",
      ),
    ).toMatchObject([{ amount: "2000.00" }]);
  });

  it("preserves remittance settlement for historical uncredited goods without a fulfillment request", async () => {
    await db().insert(s.invoices).values({
      id: 1,
      invoiceNumber: "FGC-LEGACY-1",
      branchId: 1,
      customerId: 1,
      total: "10000",
      subtotal: "10000",
      paidAmount: "0",
      status: "PENDING",
      paymentMode: "COD",
      createdBy: 2,
    });
    const sent = await dispatchInvoiceToDelivery(
      {
      assignedUserId: 3, invoiceId: 1, partyId: 1, deliveryFee: "0", clientRequestId: key() },
      admin,
    );
    const deliveredAt = new Date();
    await db()
      .update(s.deliveryConsignments)
      .set({
        parcelStatus: "DELIVERED",
        courierDeliveredAt: deliveredAt,
        custodyRecognizedAt: deliveredAt,
      })
      .where(eq(s.deliveryConsignments.id, sent.consignmentId));
    await db()
      .update(s.deliveryParties)
      .set({ currentBalance: "10000" })
      .where(eq(s.deliveryParties.id, 1));
    await db()
      .insert(s.deliveryLedgerEntries)
      .values({
        eventKey: `CN:${sent.consignmentId}:LEGACY_COLLECTED`,
        consignmentId: sent.consignmentId,
        partyId: 1,
        branchId: 1,
        entryType: "COD_COLLECTED",
        amount: "10000",
        actorUserId: 3,
      });
    await remitAndReplay(sent.consignmentId, "4000");
    expect((await db().select().from(s.invoices))[0].paidAmount).toBe(
      "4000.00",
    );
    expect((await db().select().from(s.customers))[0].currentBalance).toBe(
      "6000.00",
    );
    await remitAndReplay(sent.consignmentId, "6000");
    expect((await db().select().from(s.invoices))[0]).toMatchObject({
      paidAmount: "10000.00",
      status: "PAID",
    });
    expect((await db().select().from(s.customers))[0].currentBalance).toBe(
      "0.00",
    );
    expect(
      (await db().select().from(s.deliveryParties))[0].currentBalance,
    ).toBe("0.00");
  });

  it("rejects unproved request cash despite unrelated party custody, then lets the company statement allocate genuine goods", async () => {
    const { cn } = await dispatchGoods({ company: true });
    await confirmConsignmentDelivery(
      {
        consignmentId: cn.id,
        clientRequestId: key(),
        statementWitness: {
          partyId: 1,
          statementNumber: key(),
          collectedAmount: "0",
        },
      },
      admin,
    );
    await db()
      .update(s.deliveryParties)
      .set({ currentBalance: "10000" })
      .where(eq(s.deliveryParties.id, 1));
    await db().insert(s.deliveryLedgerEntries).values({
      eventKey: key(),
      partyId: 1,
      branchId: 1,
      entryType: "COD_COLLECTED",
      amount: "10000",
      actorUserId: 3,
    });
    const before = await goodsSnapshot();
    await expect(
      recordDeliveryRemittance(
        {
          branchId: 1,
          partyId: 1,
          lines: [{ consignmentId: cn.id, collectedAmount: "10000" }],
          countedCash: "10000",
          targetShiftId: 1,
          clientRequestId: key(),
        },
        admin,
      ),
    ).rejects.toThrow(/لم يثبت تحصيله/);
    expect(await goodsSnapshot()).toEqual(before);
    expect(
      (await db().select().from(s.deliveryParties))[0].currentBalance,
    ).toBe("10000.00");
    const input = {
      branchId: 1,
      partyId: 1,
      statementNumber: key(),
      lines: [{ consignmentId: cn.id, collectedAmount: "10000" }],
      countedCash: "10000",
      targetShiftId: 1,
      clientRequestId: key(),
    };
    const result = await recordCompanyStatement(input, admin);
    expect(await recordCompanyStatement(input, admin)).toMatchObject({
      remittanceId: result.remittanceId,
    });
    expect((await db().select().from(s.invoices))[0]).toMatchObject({
      paidAmount: "10000.00",
      status: "PAID",
    });
    expect((await db().select().from(s.customers))[0].currentBalance).toBe(
      "0.00",
    );
    expect(
      (await db().select().from(s.deliveryParties))[0].currentBalance,
    ).toBe("10000.00");
    expect(
      (await db().select().from(s.accountingEntries)).filter(
        (entry) => entry.invoiceId === 1 && entry.entryType === "PAYMENT_IN",
      ),
    ).toMatchObject([{ amount: "10000.00" }]);
    expect(
      (await db().select().from(s.receipts)).map((receipt) => receipt.amount),
    ).toEqual(["10000.00"]);
  });
});
