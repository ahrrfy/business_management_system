import { fulfillmentRequestsRouter } from "../../routers/fulfillmentRequestsRouter";
import { createFinalShipmentDispatchDocumentSnapshotsTx, listShipmentInvoiceCandidates } from "../delivery/shipments";
import { reassignDeliveryConsignment } from "../delivery/parties";
import { preservedCreditCollectionChoiceTx, creditCollectionChoiceTx } from "../delivery/creditCollectionTerms";
import { withTx } from "../tx";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import {
  fulfillmentCharges,
  fulfillmentChargePayments,
  deliveryDocumentSnapshots,
} from "../../../drizzle/fulfillmentSchema";
import { createShipmentDispatchDocumentSnapshotsTx, prepareShipmentWorkflowDocumentsTx, type ShipmentDispatchDocumentPayload } from "../delivery/documentSnapshots";
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
    collectCreditOnDelivery?: boolean;
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
  const releaseParser = fulfillmentRequestsRouter._def.procedures.release._def.inputs[0] as {
    parse(input: unknown): Parameters<typeof releaseFulfillmentRequest>[0];
  };
  const sent = await releaseFulfillmentRequest(
    releaseParser.parse({
      assignedUserId: 3,
      collectCreditOnDelivery: options.collectCreditOnDelivery,
      id: request.id,
      expectedVersion: request.version,
      clientRequestId: key(),
      ...(options.company
        ? { externalTrackingRef: key() }
        : {}),
    }),
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


describe("explicit credit collection instruction", () => {
  it("collects CREDIT goods and service charges separately only when selected", async () => {
    const {cn, chargeId} = await dispatchGoods({ credit: true, charge: true, collectCreditOnDelivery: true });
    expect(cn.codAmount).toBe("12000.00");
    expect(await withTx(tx => creditCollectionChoiceTx(tx, cn.id))).toBe(true);
    expect(await withTx(tx => preservedCreditCollectionChoiceTx(tx, [cn]))).toBe(true);
    await acknowledge(cn);
    await confirmConsignmentDelivery({consignmentId:cn.id,clientRequestId:key()},driver);
    expect((await db().select().from(s.invoices))[0].paidAmount).toBe("10000.00");
    expect((await db().select().from(s.customers))[0].currentBalance).toBe("0.00");
    expect((await db().select().from(fulfillmentCharges)).find(x=>x.id===chargeId)?.paidAmount).toBe("2000.00");
    expect((await db().select().from(s.deliveryParties))[0].currentBalance).toBe("12000.00");
    const paymentsBefore=(await db().select().from(s.accountingEntries)).filter(x=>x.entryType==="PAYMENT_IN");
    await remitAndReplay(cn.id,"12000");
    expect((await db().select().from(s.accountingEntries)).filter(x=>x.entryType==="PAYMENT_IN")).toEqual(paymentsBefore);
  });

  async function pendingCredit(dispatchedBy = admin) {
    await db().update(s.customers).set({currentBalance:"5000"}).where(eq(s.customers.id,1));
    await db().insert(s.invoices).values({id:1,invoiceNumber:"101567",sourceType:"POS",branchId:1,customerId:1,
      shiftId:1,total:"35000",subtotal:"35000",paidAmount:"30000",paymentMode:"CREDIT",status:"PARTIALLY_PAID",createdBy:2});
    const sent=await dispatchInvoiceToDelivery({invoiceId:1,partyId:1,assignedUserId:3,deliveryFee:"5000",feeCollection:"COURIER",
      collectCreditOnDelivery:false,recipientName:"عميل الاختبار",recipientPhone:"07701234567",deliveryAddress:"بغداد",clientRequestId:key()},dispatchedBy);
    const cn=(await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id,sent.consignmentId)))[0];
    return {cn,input:{partyId:1,consignmentId:cn.id,collectCreditOnDelivery:true,expectedClaimVersion:cn.codClaimVersion,
      collectionReason:"تحصيل متبقي الفاتورة مع المندوب حسب طلب العميل",clientRequestId:key()}};
  }

  it("changes invoice101567 to goods5000 plus fee5000 without posting a payment; delivery and remittance settle once", async () => {
    const {cn,input}=await pendingCredit(); const before=await goodsSnapshot();
    const changed=await reassignDeliveryConsignment(input,admin);
    expect(changed.documentSnapshotIds.length).toBeGreaterThan(0);
    expect(await goodsSnapshot()).toEqual(before);
    const current=(await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id,cn.id)))[0];
    expect(current).toMatchObject({codAmount:"5000.00",deliveryFee:"5000.00",feeCollection:"COURIER",codClaimVersion:cn.codClaimVersion+1,
      courierAckClaimVersion:0,settledAt:null,parcelStatus:cn.parcelStatus,assignedUserId:cn.assignedUserId});
    expect((await db().select().from(s.deliveryParties))[0].currentBalance).toBe("0.00");
    await db().update(s.deliveryParties).set({isActive:false}).where(eq(s.deliveryParties.id,1));
    expect(await reassignDeliveryConsignment(input,admin)).toMatchObject({replay:true});
    await db().update(s.deliveryParties).set({isActive:true}).where(eq(s.deliveryParties.id,1));
    await expect(reassignDeliveryConsignment({...input,collectCreditOnDelivery:false},admin)).rejects.toThrow();
    await expect(reassignDeliveryConsignment({...input,clientRequestId:key()},admin)).rejects.toThrow(/نسخة/);
    await acknowledge(current);
    await confirmConsignmentDelivery({consignmentId:cn.id,clientRequestId:key()},driver);
    expect((await db().select().from(s.invoices))[0]).toMatchObject({paidAmount:"35000.00",paymentMode:"CREDIT"});
    expect((await db().select().from(s.customers))[0].currentBalance).toBe("0.00");
    const payments=(await db().select().from(s.accountingEntries)).filter(x=>x.entryType==="PAYMENT_IN");
    expect(payments).toHaveLength(1);expect(payments[0].amount).toBe("5000.00");
    await remitAndReplay(cn.id,"5000");
    expect((await db().select().from(s.accountingEntries)).filter(x=>x.entryType==="PAYMENT_IN")).toEqual(payments);
    expect(await reassignDeliveryConsignment(input,admin)).toMatchObject({replay:true});
  });

  it("can retain credit on the customer before collection while releasing only the future courier exposure",async()=>{
    const {cn,input}=await pendingCredit();await reassignDeliveryConsignment(input,admin);
    const before=await goodsSnapshot();
    await reassignDeliveryConsignment({...input,collectCreditOnDelivery:false,expectedClaimVersion:cn.codClaimVersion+1,clientRequestId:key()},admin);
    expect(await goodsSnapshot()).toEqual(before);
    const row=(await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id,cn.id)))[0];
    expect(row).toMatchObject({codAmount:"0.00",moneyStatus:"NOT_APPLICABLE",deliveryFee:"5000.00"});
    expect(await withTx(tx=>creditCollectionChoiceTx(tx,cn.id))).toBe(false);
    expect((await db().select().from(s.deliveryLedgerEntries)).filter(x=>x.entryType==="COD_RELEASED")).toMatchObject([{amount:"5000.00"}]);
  });

  it.each([false,true])("prints the current claim amendment by a different actor; legacy assignment=%s",async(legacy)=>{
    await db().update(s.users).set({role:"admin"}).where(eq(s.users.id,2));
    const {cn,input}=await pendingCredit({...admin,userId:2});
    const originalDocuments=await db().select().from(deliveryDocumentSnapshots);
    const assignment=(await db().select().from(s.deliveryEvents)).find(e=>e.eventType==="OUT_FOR_DELIVERY")!;
    if(legacy) await db().update(s.deliveryEvents).set({payload:{}}).where(eq(s.deliveryEvents.id,assignment.id));
    const economicBefore=await goodsSnapshot();
    const changed=await reassignDeliveryConsignment(input,admin);
    const documents=await withTx(tx=>prepareShipmentWorkflowDocumentsTx(tx,{consignmentId:cn.id,branchId:1}));
    const claim=(await db().select().from(s.deliveryEvents)).find(e=>e.eventKey.endsWith(":CLAIM"))!;
    const current=documents.filter(d=>changed.documentSnapshotIds.includes(d.id));
    expect(current).toHaveLength(3);
    expect(documents.slice(0,3).map(d=>d.id).sort((a,b)=>a-b)).toEqual([...changed.documentSnapshotIds].sort((a,b)=>a-b));
    expect(current.every(d=>d.createdBy===1&&d.eventKey===claim.eventKey&&d.eventOccurredAt.getTime()===claim.occurredAt.getTime())).toBe(true);
    expect(current.find(d=>d.documentType==="DISPATCH_SLIP")?.payload).toMatchObject({
      evidence:{mode:"COMMITTED_CLAIM_CHANGE_EVENT",eventId:claim.id},money:{codAmount:"5000.00",deliveryFee:"5000.00"}});
    expect(current.find(d=>d.documentType==="DELIVERY_MANIFEST")?.payload).toMatchObject({title:"تعديل مطالبة التحصيل"});
    expect((await db().select().from(deliveryDocumentSnapshots)).filter(d=>originalDocuments.some(o=>o.id===d.id))).toEqual(originalDocuments);
    expect(await goodsSnapshot()).toEqual(economicBefore);
    expect(await reassignDeliveryConsignment(input,admin)).toMatchObject({replay:true,documentSnapshotIds:changed.documentSnapshotIds});
    // A later assignment can share the same MySQL event second. Its persisted ID disambiguates it.
    await db().insert(s.deliveryEvents).values({consignmentId:cn.id,eventKey:key(),eventType:"REASSIGNED",actorUserId:2,occurredAt:claim.occurredAt,
      payload:{partyId:cn.partyId,sourceType:cn.sourceType,sourceId:cn.sourceId}});
    const later=await withTx(tx=>createFinalShipmentDispatchDocumentSnapshotsTx(tx,{consignmentId:cn.id,clientRequestId:key(),operationId:"REASSIGNED",eventOccurredAt:claim.occurredAt},{...admin,userId:2}));
    const preparedAgain=await withTx(tx=>prepareShipmentWorkflowDocumentsTx(tx,{consignmentId:cn.id,branchId:1}));
    expect(preparedAgain.slice(0,3).map(row=>row.id).sort((a,b)=>a-b)).toEqual([...later].sort((a,b)=>a-b));
    expect(await goodsSnapshot()).toEqual(economicBefore);
  });

  it("rejects forged amendment identity or money and refuses an incomplete saved print pack",async()=>{
    const {cn,input}=await pendingCredit();
    const changed=await reassignDeliveryConsignment(input,admin);
    const rows=await db().select().from(deliveryDocumentSnapshots);
    const slip=rows.find(row=>changed.documentSnapshotIds.includes(row.id)&&row.documentType==="DISPATCH_SLIP")!;
    const payload=slip.payload as ShipmentDispatchDocumentPayload;
    const base={consignmentId:cn.id,branchId:1,eventKey:slip.eventKey,eventOccurredAt:slip.eventOccurredAt,createdBy:1,payload};
    const economicBefore=await goodsSnapshot();
    for(const invalid of [
      {...base,createdBy:2},
      {...base,payload:{...payload,invoiceIds:[999]}},
      {...base,payload:{...payload,money:{...payload.money,codAmount:"1.00"}}},
      {...base,payload:{...payload,evidence:{...payload.evidence,eventId:999999}}},
    ]) await expect(withTx(tx=>createShipmentDispatchDocumentSnapshotsTx(tx,invalid))).rejects.toThrow(/حدث تعديل المطالبة/);
    const label=rows.find(row=>changed.documentSnapshotIds.includes(row.id)&&row.documentType==="SHIPPING_LABEL")!;
    await db().delete(deliveryDocumentSnapshots).where(eq(deliveryDocumentSnapshots.id,label.id));
    const documentsBefore=await db().select().from(deliveryDocumentSnapshots);
    await expect(withTx(tx=>prepareShipmentWorkflowDocumentsTx(tx,{consignmentId:cn.id,branchId:1}))).rejects.toThrow(/غير مكتملة/);
    expect(await db().select().from(deliveryDocumentSnapshots)).toEqual(documentsBefore);
    expect(await goodsSnapshot()).toEqual(economicBefore);
  });

  it("prepares the latest committed claim even when its read transaction began before the amendment",async()=>{
    const {cn,input}=await pendingCredit();await reassignDeliveryConsignment(input,admin);
    let readerReady!:()=>void;const ready=new Promise<void>(resolve=>{readerReady=resolve;});
    let resumeReader!:()=>void;const resume=new Promise<void>(resolve=>{resumeReader=resolve;});
    const reading=db().transaction(async tx=>{
      await tx.select().from(s.deliveryEvents); // Deliberately establish an older repeatable-read snapshot.
      readerReady();await resume;
      return prepareShipmentWorkflowDocumentsTx(tx,{consignmentId:cn.id,branchId:1});
    },{isolationLevel:"repeatable read"});
    await ready;
    let latest:Awaited<ReturnType<typeof reassignDeliveryConsignment>>;
    try{latest=await reassignDeliveryConsignment({...input,collectCreditOnDelivery:false,expectedClaimVersion:cn.codClaimVersion+1,clientRequestId:key()},admin);}
    finally{resumeReader();}
    const documents=await reading;
    expect(documents.slice(0,3).map(row=>row.id).sort((a,b)=>a-b)).toEqual([...latest.documentSnapshotIds].sort((a,b)=>a-b));
    expect(documents.find(row=>row.documentType==="DISPATCH_SLIP")?.payload).toMatchObject({money:{codAmount:"0.00",deliveryFee:"5000.00"}});
  });

  it("rejects another branch, delivered parcels and any existing financial collection",async()=>{
    const {cn,input}=await pendingCredit();
    await expect(reassignDeliveryConsignment(input,{...cashier,branchId:2})).rejects.toThrow(/نطاق/);
    await db().update(s.deliveryConsignments).set({parcelStatus:"DELIVERED"}).where(eq(s.deliveryConsignments.id,cn.id));
    await expect(reassignDeliveryConsignment(input,admin)).rejects.toThrow(/بدأ/);
    await db().update(s.deliveryConsignments).set({parcelStatus:"OUT_FOR_DELIVERY",counterSettledAmount:"1000"}).where(eq(s.deliveryConsignments.id,cn.id));
    await expect(reassignDeliveryConsignment(input,admin)).rejects.toThrow(/بدأ/);
  });
});


it("returns real CREDIT terms for the candidate anchor and grouped invoice choice",async()=>{
  await db().insert(s.invoices).values([1,2].map(id=>({id,invoiceNumber:'CREDIT-CANDIDATE-'+id,sourceType:'POS' as const,branchId:1,customerId:1,
    total:'5000',subtotal:'5000',paidAmount:'0',status:'PENDING' as const,paymentMode:'CREDIT' as const,createdBy:1})));
  const result=await listShipmentInvoiceCandidates(1,admin);
  expect(result.anchor).toMatchObject({id:1,paymentMode:'CREDIT'});
  expect(result.candidates.find(row=>row.id===2)).toMatchObject({id:2,paymentMode:'CREDIT'});
});
