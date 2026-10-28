import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { reversalRouter } from "../../routers/digitalCards/reversalRouter";
import { computeNetSalesByUser } from "../commissions/base";
import {
  finalizeService,
  intentService,
  offeringService,
  pricingService,
  providerService,
  reversalService,
} from "../digitalCards";
import { money, toDbMoney } from "../money";
import { correctSale } from "../sale/correct";
import { createSale } from "../saleService";
import { returnSaleInTx } from "../returnService";
import { withTx } from "../tx";

const cashier = { userId: 1, branchId: 1, role: "cashier" };
const manager = { userId: 2, branchId: 1, role: "manager" };
const reviewer = { userId: 3, branchId: 1, role: "manager" };
const owner = { userId: 4, branchId: 1, role: "admin", isOwner: true };
const otherBranch = { userId: 5, branchId: 2, role: "manager" };
const admin = { userId: 6, branchId: 1, role: "admin" };
const line = (quantity = "1") => ({ variantId: 1, productUnitId: 1, quantity });
function db() {
  const value = getDb();
  if (!value) throw new Error("Missing isolated test DB");
  return value;
}

beforeEach(async () => {
  await db()
    .insert(s.branches)
    .values([
      { id: 1, name: "Main", code: "MAIN", type: "MAIN" },
      { id: 2, name: "Other", code: "OTHER", type: "SALES" },
    ]);
  await db()
    .insert(s.users)
    .values(
      [cashier, manager, reviewer, owner, otherBranch, admin].map((actor) => ({
        id: actor.userId,
        openId: `audit-contract-${actor.userId}`,
        name: `Actor ${actor.userId}`,
        branchId: actor.branchId,
        role: actor.role as "cashier" | "manager" | "admin",
        isOwner: "isOwner" in actor && actor.isOwner === true,
        loginMethod: "local",
      })),
    );
  await db()
    .insert(s.customers)
    .values({ id: 1, name: "Synthetic customer", creditLimit: "9999999.00" });
  await db().insert(s.products).values({ id: 1, name: "Synthetic product" });
  await db()
    .insert(s.productVariants)
    .values({ id: 1, productId: 1, sku: "AUDIT-ATTR", costPrice: "100.00" });
  await db().insert(s.productUnits).values({
    id: 1,
    variantId: 1,
    unitName: "piece",
    conversionFactor: "1",
    isBaseUnit: true,
  });
  await db()
    .insert(s.productPrices)
    .values({ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" });
  await db()
    .insert(s.branchStock)
    .values({ branchId: 1, variantId: 1, quantity: 100 });
  await db().insert(s.shifts).values({
    id: 1,
    branchId: 1,
    userId: 1,
    status: "OPEN",
    openingBalance: "0",
  });
  await db().insert(s.receipts).values({
    branchId: 1,
    direction: "IN",
    amount: "1000000.00",
    paymentMethod: "CASH",
    cashBucket: "TREASURY",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    createdBy: 4,
  });
});

// All issuance is recorded locally against synthetic inputs; no external adapter runs.
async function digitalSale() {
  await db()
    .insert(s.suppliers)
    .values({ id: 1, name: "Synthetic digital supplier" });
  const { providerId } = await withTx((tx) =>
    providerService.createProvider(
      tx,
      {
        supplierId: 1,
        providerType: "TELECOM",
        settlementMode: "POSTPAID",
        recognitionMode: "PRINCIPAL_GROSS",
        referencePolicy: "OPTIONAL",
        settlementCycle: "ON_DEMAND",
      },
      manager,
    ),
  );
  const offeringIds: number[] = [];
  for (const suffix of ["A", "B"]) {
    const { offeringId } = await withTx((tx) =>
      offeringService.createOffering(
        tx,
        {
          providerId,
          offeringType: "TELECOM_CARD",
          name: `Synthetic card ${suffix}`,
          pricingMode: "FIXED_MARGIN",
          fixedMargin: "100",
          roundingStep: "0",
          branches: [{ branchId: 1, walletId: null }],
        },
        manager,
      ),
    );
    offeringIds.push(offeringId);
  }
  const { batchId } = await withTx((tx) =>
    pricingService.createOrGetDraft(
      tx,
      {
        branchId: 1,
        providerId,
        businessDate: "2026-10-28",
      },
      manager,
    ),
  );
  await withTx((tx) =>
    pricingService.saveDraft(
      tx,
      {
        batchId,
        lines: offeringIds.map((offeringId) => ({
          offeringId,
          providerShare: "900",
        })),
      },
      manager,
    ),
  );
  await withTx((tx) => pricingService.publish(tx, { batchId }, manager));
  const versions = await db()
    .select()
    .from(s.digitalPriceVersions)
    .where(eq(s.digitalPriceVersions.batchId, batchId));
  const { intentId } = await withTx((tx) =>
    intentService.prepare(
      tx,
      {
        clientRequestId: "audit-digital-intent",
        branchId: 1,
        shiftId: 1,
        paymentMethod: "CASH",
        cartFingerprint: "audit-two-cards",
        lines: versions.map((version, index) => ({
          lineKey: `audit-${index}`,
          offeringId: Number(version.offeringId),
          priceVersionId: Number(version.id),
          expectedSellPrice: version.sellPrice,
          providerReference: `audit-ref-${index}`,
        })),
      },
      cashier,
    ),
  );
  const items = await db()
    .select()
    .from(s.digitalSaleIntentItems)
    .where(eq(s.digitalSaleIntentItems.intentId, intentId));
  for (const item of items) {
    await withTx(async (tx) => {
      const claimToken = `audit-claim-${item.id}`;
      await intentService.claimExecution(
        tx,
        { intentId, intentItemId: Number(item.id), claimToken },
        cashier,
      );
      await intentService.markExecution(
        tx,
        {
          intentId,
          intentItemId: Number(item.id),
          claimToken,
          status: "SUCCESS",
          providerReference: item.providerReference,
        },
        cashier,
      );
    });
  }
  const sale = await withTx((tx) =>
    finalizeService.finalize(
      tx,
      {
        intentId,
        clientRequestId: "audit-digital-finalize",
        paymentAmount: "2000.00",
        paymentMethod: "CASH",
      },
      cashier,
    ),
  );
  const details = await reversalService.reversibleDetails(db(), sale.invoiceId);
  return {
    invoiceId: sale.invoiceId,
    detailIds: details.map((detail) => Number(detail.id)),
  };
}

function caller(actor: typeof manager | typeof owner) {
  return reversalRouter.createCaller({
    user: {
      id: actor.userId,
      role: actor.role,
      branchId: actor.branchId,
      isOwner: "isOwner" in actor && actor.isOwner === true,
    },
    req: { headers: {} },
    res: { cookie() {}, clearCookie() {} },
  } as never);
}
async function requestParts(
  sale: Awaited<ReturnType<typeof digitalSale>>,
  first = manager,
) {
  await caller(first).requestLossRefund({
    invoiceId: sale.invoiceId,
    detailIds: [sale.detailIds[0]!],
    reason: "Synthetic first request",
  });
  await caller(reviewer).requestLossRefund({
    invoiceId: sale.invoiceId,
    detailIds: [sale.detailIds[1]!],
    reason: "Synthetic second request",
  });
}
async function digitalEffects(invoiceId: number) {
  return {
    invoice: (
      await db().select().from(s.invoices).where(eq(s.invoices.id, invoiceId))
    )[0],
    details: await db()
      .select()
      .from(s.digitalSaleDetails)
      .where(eq(s.digitalSaleDetails.invoiceId, invoiceId)),
    receipts: await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.invoiceId, invoiceId)),
    entries: await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.invoiceId, invoiceId)),
  };
}

describe("COM20-01 / COM20-02: digital loss decisions", () => {
  it("denies another branch before checking supplied detail identities", async () => {
    const sale = await digitalSale();
    await expect(
      caller(otherBranch).requestLossRefund({
        invoiceId: sale.invoiceId,
        detailIds: [999999],
        reason: "Foreign document details",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it.each(["lossRefund", "rejectLossRefund"] as const)(
    "rechecks the stored owner exception before %s",
    async (operation) => {
      const sale = await digitalSale();
      await requestParts(sale, owner);
      await db()
        .update(s.users)
        .set({ isOwner: false })
        .where(eq(s.users.id, owner.userId));
      const before = await digitalEffects(sale.invoiceId);
      await expect(caller(owner)[operation](sale)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      expect(await digitalEffects(sale.invoiceId)).toEqual(before);
    },
  );

  it.each(["lossRefund", "rejectLossRefund"] as const)(
    "rejects own request inside mixed-requester %s batch before any effect",
    async (operation) => {
      const sale = await digitalSale();
      await requestParts(sale);
      const before = await digitalEffects(sale.invoiceId);
      await expect(caller(manager)[operation](sale)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      expect(await digitalEffects(sale.invoiceId)).toEqual(before);
    },
  );

  it.each(["requestLossRefund", "rejectLossRefund"] as const)(
    "refuses %s on another branch without changing the request",
    async (operation) => {
      const sale = await digitalSale();
      if (operation === "rejectLossRefund") await requestParts(sale);
      const before = await digitalEffects(sale.invoiceId);
      await expect(
        caller(otherBranch)[operation]({
          ...sale,
          reason: "Synthetic cross-branch attempt",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(await digitalEffects(sale.invoiceId)).toEqual(before);
    },
  );

  it("allows an independent reviewer and refuses replay without another financial effect", async () => {
    const sale = await digitalSale();
    await requestParts(sale);
    expect(await caller(admin).lossRefund(sale)).toMatchObject({
      reversed: 2,
      refunded: "2000.00",
      loss: "1800.00",
    });
    const after = await digitalEffects(sale.invoiceId);
    await expect(caller(admin).lossRefund(sale)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await digitalEffects(sale.invoiceId)).toEqual(after);
    expect(
      after.receipts.filter((receipt) => receipt.direction === "OUT"),
    ).toHaveLength(1);
    expect(
      after.entries.filter((entry) => entry.entryType === "RETURN"),
    ).toHaveLength(1);
  });

  it.each(["lossRefund", "rejectLossRefund"] as const)(
    "retains the active owner's own-request exception for mixed %s batches",
    async (operation) => {
      const sale = await digitalSale();
      await requestParts(sale, owner);
      expect(await caller(owner)[operation](sale)).toMatchObject({
        invoiceId: sale.invoiceId,
      });
    },
  );

  it("allows central admin to request and reject across branches", async () => {
    const sale = await digitalSale();
    await db()
      .update(s.invoices)
      .set({ branchId: 2 })
      .where(eq(s.invoices.id, sale.invoiceId));
    await caller(admin).requestLossRefund({
      ...sale,
      reason: "Central request",
    });
    await caller(owner).rejectLossRefund({
      ...sale,
      reason: "Central rejection",
    });
    expect(
      (await digitalEffects(sale.invoiceId)).details.every(
        (detail) => detail.fulfillmentStatus === "ISSUED",
      ),
    ).toBe(true);
  });
});

async function attributedSale(mode: "SPLIT" | "POOL" = "SPLIT") {
  return createSale(
    {
      branchId: 1,
      customerId: 1,
      sourceType: "ORDER",
      lines: [line("2")],
      attribution: {
        repId: 3,
        mode,
        splitRatio: "70/30",
        teamPoolId: mode === "POOL" ? 741 : null,
      },
    },
    cashier,
  );
}
async function attributions(invoiceId: number) {
  const rows = await db()
    .select()
    .from(s.invoiceAttributions)
    .where(eq(s.invoiceAttributions.invoiceId, invoiceId));
  return rows
    .map(
      ({
        userId,
        role,
        attributionMode,
        sharePct,
        creditedBaseAmount,
        teamPoolId,
      }) => ({
        userId,
        role,
        attributionMode,
        sharePct,
        creditedBaseAmount,
        teamPoolId,
      }),
    )
    .sort((a, b) => a.userId - b.userId);
}

describe("29-F1: correction retains historical commission attribution", () => {
  it("preserves unattributed legacy invoices without crediting the correcting manager", async () => {
    const original = await attributedSale();
    await db()
      .delete(s.invoiceAttributions)
      .where(eq(s.invoiceAttributions.invoiceId, original.invoiceId));
    await db()
      .update(s.invoices)
      .set({
        createdBy: null,
        salesRepId: null,
        attributionMode: "DIRECT",
        salespersonNameSnapshot: null,
      })
      .where(eq(s.invoices.id, original.invoiceId));
    const input = {
      originalInvoiceId: original.invoiceId,
      lines: [line("1")],
      clientRequestId: "audit-unattributed-correction",
    };
    const corrected = await correctSale(input, admin);
    expect(await attributions(corrected.correctedInvoiceId)).toEqual([]);
    const [head] = await db()
      .select()
      .from(s.invoices)
      .where(eq(s.invoices.id, corrected.correctedInvoiceId));
    expect(head).toMatchObject({
      createdBy: null,
      salesRepId: null,
      salespersonNameSnapshot: null,
    });
    expect(await correctSale(input, admin)).toMatchObject({
      correctedInvoiceId: corrected.correctedInvoiceId,
      idempotentReplay: true,
    });
    expect(await attributions(corrected.correctedInvoiceId)).toEqual([]);
    expect(
      await computeNetSalesByUser(
        db(),
        new Date().toISOString().slice(0, 7),
        1,
      ),
    ).toEqual(new Map());
  });

  it.each(["1", "2", "3"])(
    "keeps SPLIT identities/shares at corrected quantity %s and replays once",
    async (quantity) => {
      const original = await attributedSale();
      const input = {
        originalInvoiceId: original.invoiceId,
        lines: [line(quantity)],
        clientRequestId: "audit-correction-split",
      };
      const corrected = await correctSale(input, admin);
      const base = money(quantity).times(1000);
      expect(await attributions(corrected.correctedInvoiceId)).toEqual([
        {
          userId: 1,
          role: "CASHIER",
          attributionMode: "SPLIT",
          sharePct: "0.3000",
          creditedBaseAmount: toDbMoney(base.times("0.3")),
          teamPoolId: null,
        },
        {
          userId: 3,
          role: "FLOOR_REP",
          attributionMode: "SPLIT",
          sharePct: "0.7000",
          creditedBaseAmount: toDbMoney(base.times("0.7")),
          teamPoolId: null,
        },
      ]);
      const head = (
        await db()
          .select()
          .from(s.invoices)
          .where(eq(s.invoices.id, corrected.correctedInvoiceId))
      )[0]!;
      expect(head).toMatchObject({
        createdBy: 1,
        salesRepId: 3,
        attributionMode: "SPLIT",
        salespersonNameSnapshot: "Actor 3",
      });
      const beforeReplay = await attributions(corrected.correctedInvoiceId);
      expect(await correctSale(input, admin)).toMatchObject({
        correctedInvoiceId: corrected.correctedInvoiceId,
        idempotentReplay: true,
      });
      expect(await attributions(corrected.correctedInvoiceId)).toEqual(
        beforeReplay,
      );
      const monthly = await computeNetSalesByUser(
        db(),
        new Date().toISOString().slice(0, 7),
        1,
      );
      expect(
        toDbMoney(monthly.get(1)!.sales.minus(monthly.get(1)!.returns)),
      ).toBe(toDbMoney(base.times("0.3")));
      expect(
        toDbMoney(monthly.get(3)!.sales.minus(monthly.get(3)!.returns)),
      ).toBe(toDbMoney(base.times("0.7")));
      expect(monthly.has(6)).toBe(false);
    },
  );

  it("keeps POOL, roles and team identity through correction-of-correction with gifts, discount, tax and shipping", async () => {
    const original = await attributedSale("POOL");
    const first = await correctSale(
      { originalInvoiceId: original.invoiceId, lines: [line("2")] },
      admin,
    );
    const second = await correctSale(
      {
        originalInvoiceId: first.correctedInvoiceId,
        lines: [line("1"), { ...line("1"), isGift: true }],
        invoiceDiscount: "10",
        deliveryFee: "100",
        taxRatePercent: "5",
        priceOverrideApproved: true,
      },
      admin,
    );
    const head = (
      await db()
        .select()
        .from(s.invoices)
        .where(eq(s.invoices.id, second.correctedInvoiceId))
    )[0]!;
    const base = toDbMoney(money(head.subtotal).minus(head.discountAmount));
    expect(await attributions(second.correctedInvoiceId)).toEqual([
      {
        userId: 3,
        role: "FLOOR_REP",
        attributionMode: "POOL",
        sharePct: "1.0000",
        creditedBaseAmount: base,
        teamPoolId: 741,
      },
    ]);
    expect(head).toMatchObject({
      salesRepId: 3,
      attributionMode: "POOL",
      salespersonNameSnapshot: "Actor 3",
    });
  });

  it("inherits three roles and absorbs rounding while a partial/full return retains their shares", async () => {
    const original = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "ORDER",
        lines: [line("2")],
        attribution: {
          customSplits: [
            { userId: 1, role: "CASHIER", sharePct: "0.3333" },
            { userId: 2, role: "RECEPTIONIST", sharePct: "0.3333" },
            { userId: 3, role: "FULFILLER", sharePct: "0.3334" },
          ],
        },
      },
      cashier,
    );
    const corrected = await correctSale(
      {
        originalInvoiceId: original.invoiceId,
        lines: [line("2")],
        invoiceDiscount: "0.01",
      },
      admin,
    );
    const attrs = await attributions(corrected.correctedInvoiceId);
    expect(
      attrs.map(({ userId, role, sharePct }) => ({ userId, role, sharePct })),
    ).toEqual([
      { userId: 1, role: "CASHIER", sharePct: "0.3333" },
      { userId: 2, role: "RECEPTIONIST", sharePct: "0.3333" },
      { userId: 3, role: "FULFILLER", sharePct: "0.3334" },
    ]);
    expect(
      toDbMoney(
        attrs.reduce(
          (sum, attr) => sum.plus(attr.creditedBaseAmount),
          money(0),
        ),
      ),
    ).toBe("1999.99");
    const [item] = await db()
      .select()
      .from(s.invoiceItems)
      .where(eq(s.invoiceItems.invoiceId, corrected.correctedInvoiceId));
    for (const _ of [1, 2]) {
      await withTx((tx) =>
        returnSaleInTx(
          tx,
          {
            invoiceId: corrected.correctedInvoiceId,
            lines: [{ invoiceItemId: Number(item!.id), baseQuantity: 1 }],
            restock: true,
          },
          admin,
        ),
      );
      expect(await attributions(corrected.correctedInvoiceId)).toEqual(attrs);
    }
    const monthly = await computeNetSalesByUser(
      db(),
      new Date().toISOString().slice(0, 7),
      1,
    );
    for (const userId of [1, 2, 3])
      expect(
        toDbMoney(
          monthly.get(userId)!.sales.minus(monthly.get(userId)!.returns),
        ),
      ).toBe("0.00");
  });

  it("uses original creator only for legacy invoices with no attribution rows", async () => {
    const original = await attributedSale();
    await db()
      .delete(s.invoiceAttributions)
      .where(eq(s.invoiceAttributions.invoiceId, original.invoiceId));
    const corrected = await correctSale(
      { originalInvoiceId: original.invoiceId, lines: [line("1")] },
      admin,
    );
    expect(await attributions(corrected.correctedInvoiceId)).toEqual([
      {
        userId: 1,
        role: "CASHIER",
        attributionMode: "DIRECT",
        sharePct: "1.0000",
        creditedBaseAmount: "1000.00",
        teamPoolId: null,
      },
    ]);
  });
});
