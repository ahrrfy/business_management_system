import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { invoiceRemaining } from "@shared/predicates";
import * as s from "../../../drizzle/schema";
import type { TrpcContext } from "../../context";
import { getDb } from "../../db";
import { salesRouter } from "../../routers/digitalCards/salesRouter";
import {
  offeringService,
  pricingService,
  providerService,
  walletService,
} from "../digitalCards";
import { money } from "../money";
import { createSupplier } from "../supplierService";
import { withTx } from "../tx";

const BRANCH_ID = 1;
const CUSTOMER_ID = 1;
const admin = { userId: 1, branchId: BRANCH_ID, role: "admin" };

function db() {
  const database = getDb();
  if (!database) throw new Error("DATABASE_URL not set for tests");
  return database;
}

function caller(role: "admin" | "cashier") {
  const userId = role === "admin" ? 1 : 2;
  const context = {
    req: { headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
    user: {
      id: userId,
      openId: `digital-credit-${role}`,
      name: role,
      email: `${role}@credit.test`,
      role,
      branchId: BRANCH_ID,
      loginMethod: "local",
      isActive: true,
    } as TrpcContext["user"],
    sessionId: null,
    authenticationError: null,
    platformAdmin: null,
  } as TrpcContext;
  return { sales: salesRouter.createCaller(context), userId, shiftId: userId };
}

async function offeringFixture(educational: boolean) {
  const { supplierId } = await createSupplier({ name: "مزوّد بيع آجل" }, admin);
  const { providerId } = await withTx((tx) =>
    providerService.createProvider(
      tx,
      {
        supplierId,
        providerType: "TELECOM",
        settlementMode: "PREPAID",
        recognitionMode: "PRINCIPAL_GROSS",
        referencePolicy: "OPTIONAL",
        settlementCycle: "ON_DEMAND",
      },
      admin,
    ),
  );
  const { walletId } = await withTx((tx) =>
    walletService.createWallet(
      tx,
      {
        providerId,
        branchId: BRANCH_ID,
        code: "CREDIT-W1",
        name: "محفظة بيع آجل",
      },
      admin,
    ),
  );
  await db()
    .update(s.digitalWallets)
    .set({ currentBalance: "100000" })
    .where(eq(s.digitalWallets.id, walletId));
  const { offeringId } = await withTx((tx) =>
    offeringService.createOffering(
      tx,
      {
        providerId,
        offeringType: educational ? "EDUCATIONAL_SUBSCRIPTION" : "TELECOM_CARD",
        name: educational ? "اشتراك طالب آجل" : "كارت آجل",
        requiresStudentData: educational,
        subscriptionDurationDays: educational ? 30 : null,
        pricingMode: "FIXED_MARGIN",
        fixedMargin: "850",
        roundingStep: "0",
        branches: [{ branchId: BRANCH_ID, walletId }],
      },
      admin,
    ),
  );
  const { batchId } = await withTx((tx) =>
    pricingService.createOrGetDraft(
      tx,
      {
        branchId: BRANCH_ID,
        providerId,
        businessDate: "2026-10-12",
      },
      admin,
    ),
  );
  await withTx((tx) =>
    pricingService.saveDraft(
      tx,
      {
        batchId,
        lines: [{ offeringId, providerShare: "13400" }],
      },
      admin,
    ),
  );
  await withTx((tx) => pricingService.publish(tx, { batchId }, admin));
  const [priced] = await db()
    .select({
      priceVersionId: s.digitalCurrentPrices.priceVersionId,
      sellPrice: s.digitalPriceVersions.sellPrice,
    })
    .from(s.digitalCurrentPrices)
    .innerJoin(
      s.digitalPriceVersions,
      eq(s.digitalPriceVersions.id, s.digitalCurrentPrices.priceVersionId),
    )
    .where(eq(s.digitalCurrentPrices.offeringId, offeringId));
  const [offering] = await db()
    .select()
    .from(s.digitalOfferings)
    .where(eq(s.digitalOfferings.id, offeringId));
  if (!offering.variantId || !offering.productUnitId)
    throw new Error("Digital offering catalog binding missing");
  return {
    offeringId,
    walletId,
    priced,
    variantId: Number(offering.variantId),
    productUnitId: Number(offering.productUnitId),
  };
}

function creditRequest(
  fixture: Awaited<ReturnType<typeof offeringFixture>>,
  shiftId: number,
  clientRequestId: string,
  educational: boolean,
) {
  const { offeringId, priced, variantId, productUnitId } = fixture;
  const lineKey = "digital-credit-line";
  return {
    clientRequestId,
    branchId: BRANCH_ID,
    shiftId,
    paymentMethod: "CREDIT",
    cartFingerprint: clientRequestId,
    customerId: CUSTOMER_ID,
    priceTier: "RETAIL" as const,
    sourceType: "INVOICE" as const,
    dueDate: "2026-10-31",
    sourcePayload: {
      branchId: BRANCH_ID,
      shiftId,
      customerId: CUSTOMER_ID,
      salesRepId: null,
      priceTier: "RETAIL",
      clientRequestId,
      dueDate: "2026-10-31",
      lines: [
        {
          variantId,
          productUnitId,
          quantity: "1",
          unitPriceOverride: priced.sellPrice,
          internalLineToken: lineKey,
        },
      ],
    },
    lines: [
      {
        lineKey,
        offeringId,
        priceVersionId: Number(priced.priceVersionId),
        expectedSellPrice: priced.sellPrice,
        providerReference: `REF-${clientRequestId}`,
        ...(educational
          ? {
              student: { studentName: "طالب آجل", studentPhone: "07700000000" },
            }
          : {}),
      },
    ],
  };
}

beforeEach(async () => {
  await db()
    .insert(s.branches)
    .values({
      id: BRANCH_ID,
      name: "الفرع الرئيسي",
      code: "MAIN",
      type: "MAIN",
    });
  await db()
    .insert(s.users)
    .values([
      {
        id: 1,
        openId: "digital-credit-admin",
        name: "admin",
        role: "admin",
        branchId: BRANCH_ID,
        loginMethod: "local",
      },
      {
        id: 2,
        openId: "digital-credit-cashier",
        name: "cashier",
        role: "cashier",
        branchId: BRANCH_ID,
        loginMethod: "local",
      },
    ]);
  await db()
    .insert(s.shifts)
    .values([
      {
        id: 1,
        branchId: BRANCH_ID,
        userId: 1,
        shiftType: "RETAIL",
        status: "OPEN",
        openingBalance: "0",
      },
      {
        id: 2,
        branchId: BRANCH_ID,
        userId: 2,
        shiftType: "RETAIL",
        status: "OPEN",
        openingBalance: "0",
      },
    ]);
  // العميل معتمد بسقفه، وله دين سابق؛ لا نافذة افتتاح أو قرار استثنائيّ يلغي بوابة السقف.
  await db().insert(s.customers).values({
    id: CUSTOMER_ID,
    name: "عميل معتمد آجل",
    defaultPriceTier: "RETAIL",
    creditLimit: "100000",
    currentBalance: "5000",
  });
});

describe("الراوتر الحقيقي — بيع كروت واشتراكات ضمن سقف عميل معتمد", () => {
  it.each([
    { role: "admin" as const, educational: false },
    { role: "admin" as const, educational: true },
    { role: "cashier" as const, educational: false },
    { role: "cashier" as const, educational: true },
  ])(
    "يثبت ذمة بلا قبض أو موافقة تجاوز ($role / educational=$educational)",
    async ({ role, educational }) => {
      const { sales, shiftId, userId } = caller(role);
      const fixture = await offeringFixture(educational);
      const { offeringId, walletId, priced } = fixture;
      const [before] = await db()
        .select()
        .from(s.customers)
        .where(eq(s.customers.id, CUSTOMER_ID));
      expect(before.currentBalance).toBe("5000.00");
      expect(
        money(before.currentBalance)
          .plus(priced.sellPrice)
          .lte(money(before.creditLimit)),
      ).toBe(true);
      expect(priced.sellPrice).toBe("14250.00");
      const clientRequestId = `credit-${role}-${educational ? "subscription" : "card"}`;
      const prepared = await sales.prepare(
        creditRequest(fixture, shiftId, clientRequestId, educational),
      );
      // إصدار محلي مسجّل عبر نفس الراوتر؛ لا استدعاء لخدمة مزوّد خارجيّ.
      const [item] = await db()
        .select()
        .from(s.digitalSaleIntentItems)
        .where(eq(s.digitalSaleIntentItems.intentId, prepared.intentId));
      const claimToken = `claim-${clientRequestId}`;
      await sales.claimExecution({
        intentId: prepared.intentId,
        intentItemId: Number(item.id),
        claimToken,
      });
      await sales.markExecution({
        intentId: prepared.intentId,
        intentItemId: Number(item.id),
        claimToken,
        status: "SUCCESS",
        providerReference: item.providerReference,
      });
      const result = await sales.finalize({
        intentId: prepared.intentId,
        clientRequestId: `final-${clientRequestId}`,
        paymentAmount: "0.00",
        paymentMethod: "CREDIT",
        customerId: CUSTOMER_ID,
      });

      const [invoice] = await db()
        .select()
        .from(s.invoices)
        .where(eq(s.invoices.id, result.invoiceId));
      expect(invoice).toMatchObject({
        customerId: CUSTOMER_ID,
        shiftId,
        subtotal: "14250.00",
        total: "14250.00",
        paidAmount: "0.00",
        returnedTotal: "0.00",
        status: "PENDING",
        paymentMethod: null,
        salesRepId: userId,
      });
      expect(invoiceRemaining(invoice).toFixed(2)).toBe("14250.00");
      expect(invoice.dueDate?.toISOString().slice(0, 10)).toBe("2026-10-31");
      const [after] = await db()
        .select()
        .from(s.customers)
        .where(eq(s.customers.id, CUSTOMER_ID));
      expect(after.currentBalance).toBe("19250.00");
      expect(
        money(after.currentBalance).minus(before.currentBalance).toFixed(2),
      ).toBe(invoice.total);
      expect(after.creditLimit).toBe(before.creditLimit);
      expect(
        await db()
          .select()
          .from(s.receipts)
          .where(eq(s.receipts.invoiceId, result.invoiceId)),
      ).toHaveLength(0);
      expect(await db().select().from(s.receipts)).toHaveLength(0);
      expect(await db().select().from(s.creditApprovals)).toHaveLength(0);

      const entries = await db()
        .select()
        .from(s.accountingEntries)
        .where(eq(s.accountingEntries.invoiceId, result.invoiceId));
      expect(
        entries.filter((entry) => entry.entryType === "SALE"),
      ).toHaveLength(1);
      expect(entries.find((entry) => entry.entryType === "SALE")).toMatchObject(
        {
          customerId: CUSTOMER_ID,
          amount: "14250.00",
          revenue: "14250.00",
          cost: "13400.00",
          profit: "850.00",
        },
      );
      expect(
        entries.filter((entry) => entry.entryType === "PAYMENT_IN"),
      ).toHaveLength(0);
      const [intent] = await db()
        .select()
        .from(s.digitalSaleIntents)
        .where(eq(s.digitalSaleIntents.id, prepared.intentId));
      expect(intent).toMatchObject({
        status: "FINALIZED",
        invoiceId: result.invoiceId,
        paymentMethod: "CREDIT",
      });
      expect(intent.checkoutSnapshot).toMatchObject({
        creditApprovalId: null,
        priceApprovedBy: null,
        priceOverrideApproved: role === "admin",
      });
      const [detail] = await db()
        .select()
        .from(s.digitalSaleDetails)
        .where(eq(s.digitalSaleDetails.invoiceId, result.invoiceId));
      expect(detail).toMatchObject({
        offeringId,
        fulfillmentStatus: "ISSUED",
        sellPriceSnapshot: "14250.00",
        studentNameSnapshot: educational ? "طالب آجل" : null,
        studentPhoneSnapshot: educational ? "+9647700000000" : null,
      });
      const [wallet] = await db()
        .select()
        .from(s.digitalWallets)
        .where(eq(s.digitalWallets.id, walletId));
      expect(wallet).toMatchObject({
        currentBalance: "86600.00",
        reservedBalance: "0.00",
      });
    },
  );

  it("يرفض تجاوز سقف العميل للأدمن قبل إنشاء نيّة أو حجز أو إصدار", async () => {
    const { sales, shiftId } = caller("admin");
    const fixture = await offeringFixture(false);
    // البيع وحده 14,250 ضمن 15,000؛ الدين السابق 5,000 يجعل الإجمالي 19,250 فوق السقف.
    await db()
      .update(s.customers)
      .set({ creditLimit: "15000" })
      .where(eq(s.customers.id, CUSTOMER_ID));
    await expect(
      sales.prepare(
        creditRequest(fixture, shiftId, "admin-credit-over-limit", false),
      ),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("تجاوز حدّ الائتمان"),
    });
    expect(await db().select().from(s.digitalSaleIntents)).toHaveLength(0);
    expect(await db().select().from(s.digitalSaleIntentItems)).toHaveLength(0);
    expect(await db().select().from(s.digitalWalletReservations)).toHaveLength(
      0,
    );
    expect(await db().select().from(s.digitalSaleDetails)).toHaveLength(0);
    expect(await db().select().from(s.invoices)).toHaveLength(0);
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    expect(await db().select().from(s.creditApprovals)).toHaveLength(0);
    const [customer] = await db()
      .select()
      .from(s.customers)
      .where(eq(s.customers.id, CUSTOMER_ID));
    expect(customer.currentBalance).toBe("5000.00");
    const [wallet] = await db()
      .select()
      .from(s.digitalWallets)
      .where(eq(s.digitalWallets.id, fixture.walletId));
    expect(wallet).toMatchObject({
      currentBalance: "100000.00",
      reservedBalance: "0.00",
    });
  });
});
