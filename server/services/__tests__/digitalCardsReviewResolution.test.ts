import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";
import { createSupplier } from "../supplierService";
import { withTx } from "../tx";
import {
  intentService, offeringService, pricingService, providerService, reviewResolutionService, walletService,
} from "../digitalCards";

const cashier = { userId: 1, branchId: 1, role: "cashier" };
const manager = { userId: 2, branchId: 1, role: "manager" };
const manager2 = { userId: 3, branchId: 1, role: "manager" };
const owner = { userId: 4, branchId: 1, role: "admin", isOwner: true };
const DATE = "2026-08-07";

const TABLES = [
  "digitalSaleReviewResolutionItems", "digitalSaleReviewResolutions", "digitalSaleExecutionClaims",
  "digitalSaleDetails", "digitalSaleIntentItems", "digitalWalletReservations", "digitalSaleIntents",
  "digitalPriceChangeReports", "digitalCurrentPrices", "digitalPriceVersions", "digitalPriceBatches",
  "digitalOfferingBranches", "digitalOfferings", "digitalWalletTransactions", "digitalWallets", "digitalProviders",
  "receipts", "inventoryMovements", "invoiceItems", "invoices", "idempotencyKeys", "accountingEntries", "branchStock",
  "shifts", "productPrices", "productUnitBarcodes", "productUnits", "productVariants", "products", "auditLogs", "studentProfiles", "customers", "suppliers",
  "categories", "users", "branches",
];

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function seed() {
  await db().insert(s.branches).values({ id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values([
    { id: 1, openId: "rr-u1", username: "cashier", name: "موظف البيع", role: "cashier", loginMethod: "local" },
    { id: 2, openId: "rr-u2", username: "manager-1", name: "المدير الأول", role: "manager", loginMethod: "local" },
    { id: 3, openId: "rr-u3", username: "manager-2", name: "المدير الثاني", role: "manager", loginMethod: "local" },
    { id: 4, openId: "rr-u4", username: "owner", name: "المالك", role: "admin", loginMethod: "local", isOwner: true },
  ]);
  await db().insert(s.shifts).values({ id: 1, branchId: 1, userId: 1, status: "OPEN", openingBalance: "0" });

  const { supplierId } = await createSupplier({ name: "مزوّد الاختبار" }, cashier);
  const { providerId } = await withTx((tx) => providerService.createProvider(tx, {
    supplierId, providerType: "TELECOM", settlementMode: "PREPAID", recognitionMode: "PRINCIPAL_GROSS",
    referencePolicy: "OPTIONAL", settlementCycle: "ON_DEMAND",
  }, cashier));
  const { walletId } = await withTx((tx) => walletService.createWallet(tx, {
    providerId, branchId: 1, code: "RR-WALLET", name: "جهاز المزوّد",
  }, cashier));
  await db().update(s.digitalWallets).set({ currentBalance: "100000" }).where(eq(s.digitalWallets.id, walletId));
  const { offeringId } = await withTx((tx) => offeringService.createOffering(tx, {
    providerId, offeringType: "TELECOM_CARD", name: "كارت 10000", pricingMode: "FIXED_MARGIN",
    fixedMargin: "500", roundingStep: "250", branches: [{ branchId: 1, walletId }],
  }, cashier));
  const { batchId } = await withTx((tx) => pricingService.createOrGetDraft(tx, {
    branchId: 1, providerId, businessDate: DATE,
  }, cashier));
  await withTx((tx) => pricingService.saveDraft(tx, {
    batchId, lines: [{ offeringId, providerShare: "9500" }],
  }, cashier));
  await withTx((tx) => pricingService.publish(tx, { batchId }, cashier));
  const [price] = await db().select({ id: s.digitalPriceVersions.id, sellPrice: s.digitalPriceVersions.sellPrice })
    .from(s.digitalCurrentPrices)
    .innerJoin(s.digitalPriceVersions, eq(s.digitalCurrentPrices.priceVersionId, s.digitalPriceVersions.id))
    .where(eq(s.digitalCurrentPrices.offeringId, offeringId));
  return { walletId, offeringId, priceVersionId: Number(price.id), sellPrice: price.sellPrice };
}

async function prepare(context: Awaited<ReturnType<typeof seed>>, reference: string) {
  const prepared = await withTx((tx) => intentService.prepare(tx, {
    clientRequestId: `review-${reference}`, branchId: 1, shiftId: 1, paymentMethod: "CASH",
    cartFingerprint: `fp-${reference}`,
    lines: [{
      lineKey: `line-${reference}`, offeringId: context.offeringId, priceVersionId: context.priceVersionId,
      expectedSellPrice: context.sellPrice, providerReference: reference,
    }],
  }, cashier));
  const [item] = await db().select().from(s.digitalSaleIntentItems)
    .where(eq(s.digitalSaleIntentItems.intentId, prepared.intentId));
  return { intentId: prepared.intentId, itemId: Number(item.id) };
}

async function forceReview(intentId: number) {
  await db().update(s.digitalSaleIntents).set({ status: "NEEDS_REVIEW" }).where(eq(s.digitalSaleIntents.id, intentId));
}

beforeEach(async () => {
  await truncateTables(TABLES);
});

describe("digital sale review resolution", () => {
  it("requests without financial effect, requires another manager, then cancels and releases the reservation", async () => {
    const context = await seed();
    const operation = await prepare(context, "RR-CANCEL-1");
    await forceReview(operation.intentId);
    const before = await db().select().from(s.digitalWallets).where(eq(s.digitalWallets.id, context.walletId));

    await withTx((tx) => reviewResolutionService.requestResolution(tx, {
      intentId: operation.intentId, decision: "CANCEL_NO_ISSUE", reason: "تقرير الجهاز يؤكد عدم الإصدار",
      items: [{ intentItemId: operation.itemId, outcome: "NOT_ISSUED" }],
    }, manager));

    const afterRequest = await db().select().from(s.digitalWallets).where(eq(s.digitalWallets.id, context.walletId));
    expect(afterRequest[0].currentBalance).toBe(before[0].currentBalance);
    expect(afterRequest[0].reservedBalance).toBe(before[0].reservedBalance);
    await expect(withTx((tx) => reviewResolutionService.approveResolution(tx, { intentId: operation.intentId }, manager)))
      .rejects.toThrow(/مدير آخر/);

    await withTx((tx) => reviewResolutionService.approveResolution(tx, { intentId: operation.intentId }, manager2));
    const [intent] = await db().select().from(s.digitalSaleIntents).where(eq(s.digitalSaleIntents.id, operation.intentId));
    const [wallet] = await db().select().from(s.digitalWallets).where(eq(s.digitalWallets.id, context.walletId));
    const [reservation] = await db().select().from(s.digitalWalletReservations)
      .where(eq(s.digitalWalletReservations.intentId, operation.intentId));
    expect(intent.status).toBe("CANCELLED");
    expect(wallet.currentBalance).toBe("100000.00");
    expect(wallet.reservedBalance).toBe("0.00");
    expect(reservation.status).toBe("RELEASED");
  });

  it("allows the owner to approve their own request and creates the real invoice", async () => {
    const context = await seed();
    const operation = await prepare(context, "RR-SALE-1");
    const claimToken = "rr-sale-claim";
    await withTx(async (tx) => {
      await intentService.claimExecution(tx, { intentId: operation.intentId, intentItemId: operation.itemId, claimToken }, cashier);
      await intentService.markExecution(tx, {
        intentId: operation.intentId, intentItemId: operation.itemId, claimToken, status: "SUCCESS",
        providerReference: "RR-SALE-1",
      }, cashier);
    });
    await forceReview(operation.intentId);

    await withTx((tx) => reviewResolutionService.requestResolution(tx, {
      intentId: operation.intentId, decision: "FINALIZE_SALE", reason: "مطابق لتقرير الجهاز ومبلغ البيع مقبوض",
      items: [{ intentItemId: operation.itemId, outcome: "ISSUED", providerReference: "RR-SALE-1" }],
    }, owner));
    const result = await withTx((tx) => reviewResolutionService.approveResolution(tx, {
      intentId: operation.intentId,
    }, owner));

    expect(result.invoiceId).toBeTypeOf("number");
    const [intent] = await db().select().from(s.digitalSaleIntents).where(eq(s.digitalSaleIntents.id, operation.intentId));
    const [resolution] = await db().select().from(s.digitalSaleReviewResolutions)
      .where(eq(s.digitalSaleReviewResolutions.intentId, operation.intentId));
    expect(intent.status).toBe("FINALIZED");
    expect(Number(intent.invoiceId)).toBe(result.invoiceId);
    expect(resolution.status).toBe("APPROVED");
    expect(Number(resolution.requestedBy)).toBe(owner.userId);
    expect(Number(resolution.reviewedBy)).toBe(owner.userId);
  });

  it("blocks remediation while a provider issuance window is still active", async () => {
    const context = await seed();
    const operation = await prepare(context, "RR-ACTIVE-1");
    await withTx((tx) => intentService.claimExecution(tx, {
      intentId: operation.intentId, intentItemId: operation.itemId, claimToken: "rr-active-claim",
    }, cashier));
    await forceReview(operation.intentId);

    await expect(withTx((tx) => reviewResolutionService.requestResolution(tx, {
      intentId: operation.intentId, decision: "CANCEL_NO_ISSUE", reason: "محاولة مبكرة قبل انتهاء الجلسة",
      items: [{ intentItemId: operation.itemId, outcome: "NOT_ISSUED" }],
    }, manager))).rejects.toThrow(/ما زالت نشطة/);
  });

  it("records an approved issued-without-payment decision as a real loss without an invoice", async () => {
    const context = await seed();
    const operation = await prepare(context, "RR-LOSS-1");
    const claimToken = "rr-loss-claim";
    await withTx(async (tx) => {
      await intentService.claimExecution(tx, { intentId: operation.intentId, intentItemId: operation.itemId, claimToken }, cashier);
      await intentService.markExecution(tx, {
        intentId: operation.intentId, intentItemId: operation.itemId, claimToken, status: "SUCCESS",
        providerReference: "RR-LOSS-1",
      }, cashier);
    });
    await forceReview(operation.intentId);

    await withTx((tx) => reviewResolutionService.requestResolution(tx, {
      intentId: operation.intentId, decision: "WRITEOFF_LOSS", reason: "صدر الكرت ولم يستلم الموظف المبلغ",
      items: [{ intentItemId: operation.itemId, outcome: "ISSUED", providerReference: "RR-LOSS-1" }],
    }, manager));
    const result = await withTx((tx) => reviewResolutionService.approveResolution(tx, {
      intentId: operation.intentId,
    }, manager2));

    expect(result.loss).toBe("9500.00");
    const [intent] = await db().select().from(s.digitalSaleIntents).where(eq(s.digitalSaleIntents.id, operation.intentId));
    const [lossEntry] = await db().select().from(s.accountingEntries)
      .where(eq(s.accountingEntries.entryType, "DIGITAL_WRITEOFF"));
    expect(intent.status).toBe("WRITTEN_OFF");
    expect(intent.invoiceId).toBeNull();
    expect(lossEntry.cost).toBe("9500.00");
    expect(lossEntry.revenue).toBe("0.00");
  });

  it("returns employee account, shift, provider item and audit history for the operator", async () => {
    const context = await seed();
    const operation = await prepare(context, "RR-DETAIL-1");
    await forceReview(operation.intentId);

    const details = await reviewResolutionService.getReviewDetails(db(), operation.intentId, 1);
    expect(details.intent.createdByName).toBe("موظف البيع");
    expect(details.intent.createdByUsername).toBe("cashier");
    expect(Number(details.intent.shiftId)).toBe(1);
    expect(details.items[0].providerName).toBe("مزوّد الاختبار");
    expect(details.items[0].providerReference).toBe("RR-DETAIL-1");
    expect(details.timeline.length).toBeGreaterThan(0);
  });

  it("prevents a non-admin manager from viewing or resolving another branch operation", async () => {
    const context = await seed();
    const operation = await prepare(context, "RR-BRANCH-1");
    await forceReview(operation.intentId);
    const otherBranchManager = { ...manager, branchId: 2 };

    await expect(reviewResolutionService.getReviewDetails(db(), operation.intentId, 2)).rejects.toThrow(/فرعاً آخر/);
    await expect(withTx((tx) => reviewResolutionService.requestResolution(tx, {
      intentId: operation.intentId, decision: "CANCEL_NO_ISSUE", reason: "محاولة من فرع آخر",
      items: [{ intentItemId: operation.itemId, outcome: "NOT_ISSUED" }],
    }, otherBranchManager))).rejects.toThrow(/فرعاً آخر/);
  });
});
