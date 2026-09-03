import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";
import { createSupplier } from "../supplierService";
import { withTx } from "../tx";
import { finalizeService, intentService, offeringService, posCardsService, pricingService, providerService, reviewResolutionService, walletService } from "../digitalCards";

const cashier = { userId: 1, branchId: 1, role: "cashier" };
const manager = { userId: 2, branchId: 1, role: "manager" };
const reviewer = { userId: 3, branchId: 1, role: "manager" };
const TABLES = [
  "digitalSaleReviewResolutionItems", "digitalSaleReviewResolutions", "digitalSaleExecutionClaims",
  "digitalSaleDetails", "digitalSaleIntentItems", "digitalWalletReservations", "digitalSaleIntents",
  "digitalPriceChangeReports", "digitalCurrentPrices", "digitalPriceVersions", "digitalPriceBatches",
  "digitalOfferingBranches", "digitalOfferings", "digitalWalletTransactions", "digitalWallets", "digitalProviders",
  "receipts", "inventoryMovements", "invoiceItems", "invoices", "idempotencyKeys", "accountingEntries", "branchStock",
  "shifts", "productPrices", "productUnitBarcodes", "productUnits", "productVariants", "products", "auditLogs",
  "studentProfiles", "customers", "suppliers", "categories", "users", "branches",
];
function db() { const value = getDb(); if (!value) throw new Error("Missing test database"); return value; }

beforeEach(async () => {
  await truncateTables(TABLES);
  await db().insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values([1, 2, 3].map((id) => ({ id, openId: `basket-${id}`, name: `User ${id}`, role: id === 1 ? "cashier" as const : "manager" as const, loginMethod: "local" })));
  await db().insert(s.shifts).values({ id: 1, branchId: 1, userId: 1, status: "OPEN", openingBalance: "0" });
});

async function setup(mode: "PREPAID" | "POSTPAID" = "PREPAID", suffix = "A") {
  const { supplierId } = await createSupplier({ name: `Provider ${suffix}` }, cashier);
  const { providerId } = await withTx((tx) => providerService.createProvider(tx, {
    supplierId, providerType: "TELECOM", settlementMode: mode, recognitionMode: "PRINCIPAL_GROSS",
    referencePolicy: "OPTIONAL", settlementCycle: "ON_DEMAND",
  }, cashier));
  let walletId: number | null = null;
  if (mode === "PREPAID") {
    ({ walletId } = await withTx((tx) => walletService.createWallet(tx, { providerId, branchId: 1, code: `B-${suffix}`, name: `Wallet ${suffix}` }, cashier)));
    await db().update(s.digitalWallets).set({ currentBalance: "100000" }).where(eq(s.digitalWallets.id, walletId));
  }
  const offerings = [];
  for (let index = 0; index < 2; index++) {
    offerings.push(await withTx((tx) => offeringService.createOffering(tx, {
      providerId, offeringType: "TELECOM_CARD", name: `Card ${suffix}-${index}`, pricingMode: "FIXED_MARGIN",
      fixedMargin: "500", roundingStep: "250", branches: [{ branchId: 1, walletId }],
    }, cashier)));
  }
  const { batchId } = await withTx((tx) => pricingService.createOrGetDraft(tx, { branchId: 1, providerId, businessDate: "2026-09-03" }, cashier));
  await withTx((tx) => pricingService.saveDraft(tx, { batchId, lines: offerings.map((offering, index) => ({ offeringId: offering.offeringId, providerShare: index === 0 ? "9500" : "19500" })) }, cashier));
  await withTx((tx) => pricingService.publish(tx, { batchId }, cashier));
  const cards = await posCardsService.listCards(db(), { branchId: 1, providerId });
  return { providerId, supplierId, walletId, lines: cards.map((card, index): intentService.PrepareLine => ({
    lineKey: `line-${index}`, offeringId: card.offeringId, priceVersionId: card.priceVersionId!, expectedSellPrice: card.sellPrice!,
    providerReference: "OP-ONE", providerBasketKey: "basket-one",
  })) };
}
async function prepare(lines: intentService.PrepareLine[], request = "basket-request-one") {
  const result = await withTx((tx) => intentService.prepare(tx, { clientRequestId: request, branchId: 1, shiftId: 1, paymentMethod: "CASH", cartFingerprint: request, lines }, cashier));
  const items = await db().select().from(s.digitalSaleIntentItems).where(eq(s.digitalSaleIntentItems.intentId, result.intentId)).orderBy(s.digitalSaleIntentItems.id);
  return { ...result, items };
}
async function mark(operation: Awaited<ReturnType<typeof prepare>>, status: intentService.ExecutionStatus = "SUCCESS") {
  const intentItemId = Number(operation.items[1].id);
  const claim = await withTx((tx) => intentService.claimExecution(tx, { intentId: operation.intentId, intentItemId, claimToken: "basket-execution-claim" }, cashier));
  const result = await withTx((tx) => intentService.markExecution(tx, { intentId: operation.intentId, intentItemId, claimToken: claim.claimToken, status }, cashier));
  return { claim, result };
}

describe("digital provider transaction baskets", () => {
  it("stores one reference owner and reserves the sum of private line costs", async () => {
    const context = await setup();
    const operation = await prepare(context.lines);
    expect(operation.items.map((item) => item.providerReference)).toEqual(["OP-ONE", "OP-ONE"]);
    expect(operation.items.map((item) => item.referenceOwnerItemId)).toEqual([null, operation.items[0].id]);
    expect(operation.items[0].refKey).toBe(`${context.providerId}:OP-ONE`);
    expect(operation.items[1].refKey).toBeNull();
    const [wallet] = await db().select().from(s.digitalWallets).where(eq(s.digitalWallets.id, context.walletId!));
    expect(wallet.currentBalance).toBe("100000.00");
    expect(wallet.reservedBalance).toBe("29000.00");
    expect((await intentService.getIntent(db(), operation.intentId))!.items[1].providerBasketKey).toBe("basket-one");
  });

  it("retains the legacy rejection for repeated refs without an explicit basket", async () => {
    const context = await setup();
    await expect(prepare(context.lines.map(({ providerBasketKey: _, ...line }) => line))).rejects.toThrow(/الرقم نفسه/);
  });

  it("canonicalizes basket key case and rejects replay with changed digital contents", async () => {
    const context = await setup();
    const lines = context.lines.map((line, index) => ({ ...line, providerBasketKey: index ? "BASKET-ONE" : "basket-one" }));
    const operation = await prepare(lines);
    expect(operation.items.map((item) => item.providerBasketKey)).toEqual(["basket-one", "basket-one"]);
    await expect(prepare(lines)).resolves.toMatchObject({ replay: true, intentId: operation.intentId });
    await expect(prepare(lines.map((line) => ({ ...line, providerReference: "ALTERED" })))).rejects.toThrow(/نفس مفتاح/);
  });

  it("rejects mismatched references, providers, and duplicate references across baskets", async () => {
    const context = await setup();
    await expect(prepare([context.lines[0], { ...context.lines[1], providerReference: "OTHER" }])).rejects.toThrow(/رقم عملية واحد/);
    await expect(prepare([context.lines[0], { ...context.lines[1], providerBasketKey: "another" }])).rejects.toThrow(/الرقم نفسه/);
    const other = await setup("PREPAID", "B");
    await expect(prepare([context.lines[0], { ...other.lines[0], lineKey: "other-provider" }])).rejects.toThrow(/مزوّداً واحداً/);
  });

  it("enforces global uniqueness against concurrent baskets and legacy requests", async () => {
    const context = await setup();
    const results = await Promise.allSettled([prepare(context.lines, "concurrent-basket-a"), prepare(context.lines, "concurrent-basket-b")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    await expect(prepare([{ ...context.lines[0], providerBasketKey: undefined }], "legacy-collision")).rejects.toThrow(/محفوظ/);
  });

  it("claims any member once, then records all members atomically and replays", async () => {
    const operation = await prepare((await setup()).lines);
    const { claim, result } = await mark(operation);
    expect(claim.intentItemId).toBe(operation.items[0].id);
    expect(claim.intentItemIds).toEqual(operation.items.map((item) => item.id));
    expect(result.itemIds).toEqual(claim.intentItemIds);
    expect(result.allSettled).toBe(true);
    const replay = await withTx((tx) => intentService.markExecution(tx, { intentId: operation.intentId, intentItemId: Number(operation.items[0].id), claimToken: claim.claimToken, status: "SUCCESS" }, cashier));
    expect(replay.idempotent).toBe(true);
    await expect(withTx((tx) => intentService.claimExecution(tx, { intentId: operation.intentId, intentItemId: Number(operation.items[1].id), claimToken: "second-group-claim" }, cashier))).rejects.toThrow();
  });

  it("serializes competing claims through different basket members", async () => {
    const operation = await prepare((await setup()).lines);
    const results = await Promise.allSettled(operation.items.map((item, index) => withTx((tx) => intentService.claimExecution(tx, { intentId: operation.intentId, intentItemId: Number(item.id), claimToken: `competing-group-${index}` }, cashier))));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const claims = await db().execute(sql`SELECT * FROM digitalSaleExecutionClaims`);
    expect((claims as unknown as [unknown[]])[0]).toHaveLength(1);
  });

  it("rejects changing the captured group reference and rolls back group execution", async () => {
    const operation = await prepare((await setup()).lines);
    await expect(withTx(async (tx) => {
      await intentService.claimExecution(tx, { intentId: operation.intentId, intentItemId: Number(operation.items[1].id), claimToken: "changed-group-ref" }, cashier);
      await intentService.markExecution(tx, { intentId: operation.intentId, intentItemId: Number(operation.items[1].id), claimToken: "changed-group-ref", status: "SUCCESS", providerReference: "REPLACED" }, cashier);
    })).rejects.toThrow(/تغيّر/);
    expect((await intentService.getIntent(db(), operation.intentId))!.items.every((item) => item.fulfillmentStatus === "PENDING")).toBe(true);
  });

  it("releases an entirely unissued basket reference on cancellation", async () => {
    const context = await setup();
    const operation = await prepare(context.lines);
    await withTx((tx) => intentService.cancelIntent(tx, { intentId: operation.intentId }, cashier));
    await expect(prepare(context.lines, "retry-after-cancel")).resolves.toMatchObject({ replay: false });
  });

  it("keeps unknown basket funds reserved until review", async () => {
    const context = await setup();
    const operation = await prepare(context.lines);
    await mark(operation, "UNKNOWN");
    const result = await withTx((tx) => intentService.cancelIntent(tx, { intentId: operation.intentId }, cashier));
    expect(result.outcome).toBe("NEEDS_REVIEW");
    const [wallet] = await db().select().from(s.digitalWallets).where(eq(s.digitalWallets.id, context.walletId!));
    expect(wallet.reservedBalance).toBe("29000.00");
  });

  it("releases the entire reference after review proves every member unissued", async () => {
    const context = await setup();
    const operation = await prepare(context.lines);
    await mark(operation, "UNKNOWN");
    await withTx((tx) => reviewResolutionService.requestResolution(tx, {
      intentId: operation.intentId, decision: "CANCEL_NO_ISSUE", reason: "تقرير الجهاز يؤكد عدم إصدار أي بطاقة",
      items: operation.items.map((item) => ({ intentItemId: Number(item.id), outcome: "NOT_ISSUED" })),
    }, manager));
    await withTx((tx) => reviewResolutionService.approveResolution(tx, { intentId: operation.intentId }, reviewer));
    await expect(prepare(context.lines, "retry-after-review")).resolves.toMatchObject({ replay: false });
  });

  it("expires an untouched basket and frees its reference for another attempt", async () => {
    const context = await setup();
    const operation = await prepare(context.lines);
    await db().update(s.digitalSaleIntents).set({ expiresAt: new Date("2020-01-01T00:00:00Z") }).where(eq(s.digitalSaleIntents.id, operation.intentId));
    await withTx((tx) => intentService.expireStaleIntents(tx));
    await expect(prepare(context.lines, "retry-after-expiry")).resolves.toMatchObject({ replay: false });
  });

  it("retains the owner reference when only a non-owner card was issued and written off", async () => {
    const context = await setup();
    const operation = await prepare(context.lines);
    await mark(operation, "UNKNOWN");
    await withTx((tx) => reviewResolutionService.requestResolution(tx, {
      intentId: operation.intentId, decision: "WRITEOFF_LOSS", reason: "المطابقة تؤكد إصدار البطاقة الثانية وحدها",
      items: operation.items.map((item, index) => ({ intentItemId: Number(item.id), outcome: index === 0 ? "NOT_ISSUED" : "ISSUED" })),
    }, manager));
    await withTx((tx) => reviewResolutionService.approveResolution(tx, { intentId: operation.intentId }, reviewer));
    const [owner] = await db().select().from(s.digitalSaleIntentItems).where(eq(s.digitalSaleIntentItems.id, Number(operation.items[0].id)));
    expect(owner.fulfillmentStatus).toBe("FAILED");
    expect(owner.providerReference).toBe("OP-ONE");
    expect(owner.refKey).toBe(`${context.providerId}:OP-ONE`);
    const [wallet] = await db().select().from(s.digitalWallets).where(eq(s.digitalWallets.id, context.walletId!));
    expect(wallet.currentBalance).toBe("80500.00");
    expect(wallet.reservedBalance).toBe("0.00");
    await expect(prepare(context.lines, "reuse-written-off-ref")).rejects.toThrow(/محفوظ/);
  });

  it("rejects a per-member reference change during review", async () => {
    const operation = await prepare((await setup()).lines);
    await mark(operation, "UNKNOWN");
    await expect(withTx((tx) => reviewResolutionService.requestResolution(tx, {
      intentId: operation.intentId, decision: "FINALIZE_SALE", reason: "مطابقة مع جهاز المزوّد",
      items: operation.items.map((item, index) => ({ intentItemId: Number(item.id), outcome: "ISSUED", providerReference: index ? "ALTERED" : "OP-ONE" })),
    }, manager))).rejects.toThrow(/مرجع السلة/);
  });

  it.each(["PREPAID", "POSTPAID"] as const)("finalizes %s as distinct invoice rows with private independent costs", async (mode) => {
    const context = await setup(mode);
    const operation = await prepare(context.lines);
    await mark(operation);
    const result = await withTx((tx) => finalizeService.finalize(tx, { intentId: operation.intentId, clientRequestId: "basket-finalize", paymentAmount: "30000", paymentMethod: "CASH" }, cashier));
    const details = await finalizeService.getSaleDetails(db(), result.invoiceId);
    expect(details).toHaveLength(2);
    expect(new Set(details.map((item) => item.invoiceItemId)).size).toBe(2);
    expect(details.map((item) => item.providerShare)).toEqual(["9500.00", "19500.00"]);
    expect(details.map((item) => item.profit)).toEqual(["500.00", "500.00"]);
    expect(result.printDetails.map((item) => item.providerReference)).toEqual(["OP-ONE", "OP-ONE"]);
    expect(JSON.stringify(result.printDetails)).not.toMatch(/providerShare|profit|wallet/);
  });
});
