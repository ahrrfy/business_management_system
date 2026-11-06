import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import type { TrpcContext } from "../../context";
import { salesRouter } from "../../routers/digitalCards/salesRouter";
import { reversalRouter } from "../../routers/digitalCards/reversalRouter";
import { withOperationAuthority } from "../authorization/operationExecutionScope";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { getDb } from "../../db";
import { withTx } from "../tx";
import { createSupplier } from "../supplierService";
import { initiateExternalPaymentAttempt, confirmExternalPaymentAttempt } from "../posExternalPayment";
import { finalizeService, intentService, offeringService, pricingService, providerService, reversalService, walletService } from "../digitalCards";
import { digitalIntentSettlements, digitalRefundItems, digitalRefundPayments } from "../../../drizzle/digitalSettlementSchema";
import { materializeDigitalCapture } from "../digitalCards/settlementService";
import { reviewResolutionService, writeoffService } from "../digitalCards";
import { money, toDbMoney } from "../money";
import { returnSaleInTx } from "../returnService";
import { truncateAllTables } from "./__testUtils__";

const actor = { userId: 1, branchId: 1, role: "cashier" };
const manager = { userId: 2, branchId: 1, role: "manager" };
const approver = { userId: 3, branchId: 1, role: "manager" };
function db() { const value = getDb(); if (!value) throw new Error("Missing isolated test DB"); return value; }
function callerContext(user: TrpcContext["user"]): TrpcContext {
  return { req: { headers: {} } as TrpcContext["req"], res: {} as TrpcContext["res"],
    user, sessionId: null, nativeClientId: null, platformAdmin: null };
}

beforeEach(async () => {
  await truncateAllTables();
  await db().insert(s.branches).values({ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values({ id: 1, openId: "reception-digital-cashier", name: "Cashier", role: "cashier", branchId: 1 });
  await db().insert(s.users).values({ id: 2, openId: "digital-cycle-manager", name: "Manager", role: "manager", branchId: 1 });
  await db().insert(s.users).values({ id: 3, openId: "digital-cycle-approver", name: "Approver", role: "manager", branchId: 1 });
  await db().insert(s.customers).values({ id: 1, name: "عميل الاختبار", defaultPriceTier: "RETAIL", currentBalance: "0" });
  await db().insert(s.shifts).values({ id: 1, branchId: 1, userId: 1, status: "OPEN", shiftType: "RECEPTION", openingBalance: "0" });
  await db().insert(s.products).values({ id: 1, name: "دفتر" });
  await db().insert(s.productVariants).values({ id: 1, productId: 1, sku: "RECEPTION-BOOK", costPrice: "10" });
  await db().insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true });
  await db().insert(s.productPrices).values({ productUnitId: 1, priceTier: "RETAIL", price: "100" });
  await db().insert(s.branchStock).values({ branchId: 1, variantId: 1, quantity: 10 });
});

async function fixture(method: "CASH" | "CARD", evidenceChannel: "POS" | "PRINT_POS" = "PRINT_POS", options: { cards?: number; mode?: "PREPAID" | "POSTPAID"; proofAmount?: string } = {}) {
  const mode = options.mode ?? "PREPAID";
  const cards = options.cards ?? 1;
  const { supplierId } = await createSupplier({ name: "Reception digital provider" }, actor);
  const { providerId } = await withTx((tx) => providerService.createProvider(tx, {
    supplierId, providerType: "TELECOM", settlementMode: mode, recognitionMode: "PRINCIPAL_GROSS", referencePolicy: "REQUIRED", settlementCycle: "ON_DEMAND",
  }, actor));
  const walletId = mode === "PREPAID" ? (await withTx((tx) => walletService.createWallet(tx, { providerId, branchId: 1, code: "RECEPTION", name: "Provider wallet" }, actor))).walletId : 0;
  if (walletId) await db().update(s.digitalWallets).set({ currentBalance: "100000" }).where(eq(s.digitalWallets.id, walletId));
  const { offeringId } = await withTx((tx) => offeringService.createOffering(tx, {
    providerId, offeringType: "TELECOM_CARD", name: "كرت اختبار", requiresStudentData: false,
    pricingMode: "FIXED_MARGIN", fixedMargin: "500", roundingStep: "250", branches: [{ branchId: 1, walletId: walletId || undefined }],
  }, actor));
  const { batchId } = await withTx((tx) => pricingService.createOrGetDraft(tx, { branchId: 1, providerId, businessDate: "2026-11-06" }, actor));
  await withTx((tx) => pricingService.saveDraft(tx, { batchId, lines: [{ offeringId, providerShare: "9500" }] }, actor));
  await withTx((tx) => pricingService.publish(tx, { batchId }, actor));
  const [price] = await db().select().from(s.digitalCurrentPrices).where(and(eq(s.digitalCurrentPrices.offeringId, offeringId), eq(s.digitalCurrentPrices.branchId, 1)));
  let attemptId: number | undefined;
  if (method === "CARD") {
    const attempt = await initiateExternalPaymentAttempt({ branchId: 1, channel: evidenceChannel, method, amount: options.proofAmount ?? toDbMoney(money("10000").times(cards).plus("100")), reference: "BANK-10324087", requestId: "reception-digital-stable-1:card", deviceId: "reception-device" }, actor);
    await confirmExternalPaymentAttempt({ branchId: 1, channel: evidenceChannel, attemptId: attempt.attemptId, deviceId: "reception-device" }, actor);
    attemptId = attempt.attemptId;
  }
  const input: intentService.PrepareInput = {
    clientRequestId: "reception-digital-stable-1", branchId: 1, shiftId: 1, paymentMethod: method,
    externalPaymentAttemptId: attemptId, externalPaymentDeviceId: attemptId ? "reception-device" : undefined,
    cartFingerprint: "reception-digital-cart", sourceType: "RECEPTION", priceTier: "RETAIL",
    sourcePayload: { version: 1, cashRoundIQD: method === "CASH", contactName: "طالب", contactPhone: "07800000000" },
    regularLines: [{ lineKey: "book", variantId: 1, productUnitId: 1, quantity: "1" }],
    lines: Array.from({ length: cards }, (_, i) => ({ lineKey: `card-${i}`, offeringId, priceVersionId: Number(price.priceVersionId), expectedSellPrice: "10000.00", providerReference: i === 0 ? "001172" : "001173" })),
  };
  return { input, walletId, attemptId, supplierId };
}

async function execute(intentId: number) {
  const [item] = await db().select().from(s.digitalSaleIntentItems).where(eq(s.digitalSaleIntentItems.intentId, intentId));
  await withTx(async (tx) => {
    await intentService.claimExecution(tx, { intentId, intentItemId: Number(item.id), claimToken: "reception-claim-1" }, actor);
    await intentService.markExecution(tx, { intentId, intentItemId: Number(item.id), claimToken: "reception-claim-1", status: "SUCCESS", providerReference: "001172" }, actor);
  });
}

describe("digital reception checkout: real persistence boundary", () => {
  it.each([["CASH", "PREPAID"], ["CARD", "PREPAID"], ["CASH", "POSTPAID"], ["CARD", "POSTPAID"]] as const)("keeps %s/%s payment, source, settlement and receipt consistent through replay", async (method, mode) => {
    const f = await fixture(method, "PRINT_POS", { mode });
    const prepared = await withTx((tx) => intentService.prepare(tx, f.input, actor));
    const view = await intentService.getIntent(db(), prepared.intentId, actor);
    expect(JSON.stringify(view)).not.toMatch(/pricingGuard|paidCostTotal|giftCostTotal|sourcePayload/);
    await execute(prepared.intentId);
    const paymentAmount = method === "CASH" ? "10000.00" : "10100.00";
    const command = { intentId: prepared.intentId, clientRequestId: f.input.clientRequestId, paymentAmount, paymentMethod: method, externalPaymentAttemptId: f.attemptId, deviceId: f.attemptId ? "reception-device" : undefined };
    const result = await withTx((tx) => finalizeService.finalize(tx, command, actor));
    expect(result).toMatchObject({ total: paymentAmount, paymentMethod: method, paidAmount: paymentAmount, cashRoundingAdjustment: method === "CASH" ? "-100.00" : "0.00" });
    const [invoice] = await db().select().from(s.invoices);
    expect(invoice).toMatchObject({ shiftId: 1, sourceType: "POS", paymentMethod: method, contactName: "طالب", contactPhone: "07800000000" });
    const receipts = await db().select().from(s.receipts);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ paymentMethod: method, amount: paymentAmount, cashBucket: method === "CASH" ? "DRAWER" : null });
    if (mode === "PREPAID") {
      const [wallet] = await db().select().from(s.digitalWallets).where(eq(s.digitalWallets.id, f.walletId));
      expect(wallet).toMatchObject({ currentBalance: "90500.00", reservedBalance: "0.00" });
    } else expect((await db().select().from(s.suppliers).where(eq(s.suppliers.id, f.supplierId)))[0].currentBalance).toBe("9500.00");
    expect(await withTx((tx) => intentService.prepare(tx, f.input, actor))).toMatchObject({ intentId: prepared.intentId, replay: true });
    expect(await withTx((tx) => finalizeService.finalize(tx, command, actor))).toMatchObject({ invoiceId: result.invoiceId, idempotentReplay: true, paymentMethod: method });
    expect(await db().select().from(s.receipts)).toHaveLength(1);
    expect(await db().select().from(s.digitalWalletTransactions)).toHaveLength(mode === "PREPAID" ? 1 : 0);
  });

  it("rejects a POS-channel proof instead of silently consuming it as reception", async () => {
    const f = await fixture("CARD", "POS");
    await expect(withTx((tx) => intentService.prepare(tx, f.input, actor))).rejects.toThrow();
    expect(await db().select().from(s.digitalSaleIntents)).toHaveLength(0);
    expect(await db().select().from(s.digitalWalletReservations)).toHaveLength(0);
  });

  it("rejects the wrong shift type and old untyped source before provider execution", async () => {
    const f = await fixture("CASH");
    await db().update(s.shifts).set({ shiftType: "RETAIL" }).where(eq(s.shifts.id, 1));
    await expect(withTx((tx) => intentService.prepare(tx, f.input, actor))).rejects.toThrow(/استقبال/);
    await expect(withTx((tx) => intentService.prepare(tx, { ...f.input, sourcePayload: {} }, actor))).rejects.toThrow(/عقد/);
    expect(await db().select().from(s.digitalSaleIntents)).toHaveLength(0);
  });
});

async function soldCard(customerId?: number) {
  const f = await fixture("CARD");
  const prepared = await withTx((tx) => intentService.prepare(tx, { ...f.input, customerId }, actor));
  await execute(prepared.intentId);
  const sale = await withTx((tx) => finalizeService.finalize(tx, { intentId: prepared.intentId,
    clientRequestId: f.input.clientRequestId, paymentAmount: "10100", paymentMethod: "CARD", customerId,
    externalPaymentAttemptId: f.attemptId, deviceId: "reception-device" }, actor));
  const [detail] = await db().select().from(s.digitalSaleDetails).where(eq(s.digitalSaleDetails.invoiceId, sale.invoiceId));
  return { ...sale, detailIds: [Number(detail.id)], attemptId: f.attemptId! };
}

describe("digital refund evidence and mixed return accounting", () => {
  it("persists card success independently, rolls back financial failure, and replays once", async () => {
    const sale = await soldCard();
    const input = { invoiceId: sale.invoiceId, detailIds: sale.detailIds, reason: "المزوّد أكد إلغاء الكرت وحصته",
      refund: { method: "CARD" as const, reference: "refund-001172", confirmed: true as const } };
    await expect(withTx((tx) => reversalService.approveReversal(tx, input, manager))).rejects.toThrow(/إثبات/);
    await expect(withTx((tx) => reversalService.evidenceForRefund(tx, input, "REVERSED", manager))).rejects.toThrow(/احجز/);
    await expect(withTx((tx) => reversalService.controlRefund(tx, input, { stage: "RESERVE", expectedAmount: "9999" }, "REVERSED", manager))).rejects.toThrow(/مبلغ/);
    const reservations = await Promise.all([1, 2].map(() => withTx((tx) => reversalService.controlRefund(tx, input, { stage: "RESERVE", expectedAmount: "10000" }, "REVERSED", manager))));
    const grants = reservations.filter((result) => "newReservation" in result && result.newReservation);
    expect(grants).toHaveLength(1);
    const reservedRead=(await reversalService.reversibleDetails(db(),sale.invoiceId,1))[0].pendingRefund;
    expect(reservedRead).toMatchObject({status:"RESERVED",reference:null});
    expect(reservedRead).not.toHaveProperty("reservationToken");
    expect(reservedRead).not.toHaveProperty("grantToken");
    const granted = grants[0];
    if (!("grantToken" in granted) || !granted.grantToken) throw new Error("Missing one-time refund grant");
    const admin={ userId:4,branchId:1,role:"admin",isOwner:true };
    const owner={ userId:5,branchId:1,role:"admin" };
    await db().insert(s.users).values([{id:4,openId:"refund-admin",role:"admin",branchId:1,isOwner:false},{id:5,openId:"refund-owner",role:"admin",branchId:1,isOwner:true}]);
    await expect(withTx(tx=>reversalService.controlRefund(tx,input,{stage:"RELEASE",noRefundConfirmed:true,reason:"طابقنا عدم تنفيذ الرد",grantToken:granted.grantToken!},"REVERSED",admin))).rejects.toThrow(/الموظف/);
    await expect(withTx(tx=>reversalService.evidenceForRefund(tx,input,"REVERSED",admin))).rejects.toThrow(/الموظف/);
    await expect(withTx((tx) => reversalService.controlRefund(tx, input, { stage: "RELEASE", noRefundConfirmed: true, reason: "لم ينفذ رد الجهاز" }, "REVERSED", manager))).rejects.toThrow(/نافذة/);
    await withTx((tx) => reversalService.controlRefund(tx, input, { stage: "RELEASE", noRefundConfirmed: true, reason: "لم ينفذ رد الجهاز", grantToken: granted.grantToken! }, "REVERSED", owner));
    expect(await db().select().from(digitalRefundPayments)).toHaveLength(0);
    await withTx((tx) => reversalService.controlRefund(tx, input, { stage: "RESERVE", expectedAmount: "10000" }, "REVERSED", manager));
    await db().update(digitalRefundPayments).set({ reservationExpiresAt: new Date(Date.now() - 1000) });
    const expiredReplay = await withTx((tx) => reversalService.controlRefund(tx, input, { stage: "RESERVE", expectedAmount: "10000" }, "REVERSED", manager));
    expect(expiredReplay).toMatchObject({ newReservation: false, grantToken: null });
    await withTx((tx) => reversalService.controlRefund(tx, input, { stage: "RELEASE", noRefundConfirmed: true, reason: "تحققت أن الرد لم ينفذ" }, "REVERSED", manager));
    await withTx((tx) => reversalService.controlRefund(tx, input, { stage: "RESERVE", expectedAmount: "10000" }, "REVERSED", manager));
    await withTx((tx) => reversalService.evidenceForRefund(tx, input, "REVERSED", owner));
    expect((await reversalService.reversibleDetails(db(),sale.invoiceId,1))[0].pendingRefund).toMatchObject({status:"EVIDENCED",reference:"REFUND-001172"});
    await expect(withTx(tx=>reversalService.approveReversal(tx,input,admin))).rejects.toThrow(/الموظف/);
    await expect(withTx((tx) => reversalService.controlRefund(tx, input, { stage: "RELEASE", noRefundConfirmed: true, reason: "لا يمحى رد مؤكد" }, "REVERSED", manager))).rejects.toThrow(/تحرير/);
    await expect(withTx(async (tx) => { await reversalService.approveReversal(tx, input, owner); throw new Error("injected financial failure"); })).rejects.toThrow("injected financial failure");
    expect((await db().select().from(digitalRefundPayments))[0].status).toBe("EVIDENCED");
    expect((await db().select().from(digitalRefundItems))[0].occurredAt).toBeNull();
    expect(await db().select().from(s.receipts)).toHaveLength(1);
    await withTx((tx) => reversalService.approveReversal(tx, input, owner));
    await withTx((tx) => reversalService.approveReversal(tx, input, owner));
    const outs = await db().select().from(s.receipts).where(eq(s.receipts.direction, "OUT"));
    expect(outs).toHaveLength(1);
    expect(outs[0]).toMatchObject({ amount: "10000.00", paymentMethod: "CARD", cashBucket: null, referenceNumber: "REFUND-001172" });
    expect((await db().select().from(s.externalPaymentAttempts).where(eq(s.externalPaymentAttempts.id, sale.attemptId)))[0].state).toBe("CONFIRMED");
    expect((await db().select().from(digitalRefundItems))[0].occurredAt).toBeInstanceOf(Date);
  });

  it.each(["digital-first", "goods-credit-first"])("preserves customer credit and finishes the same mixed invoice: %s", async (order) => {
    const sale = await soldCard(1);
    await db().insert(s.receipts).values({ branchId: 1, direction: "IN", amount: "100000", paymentMethod: "CASH", cashBucket: "TREASURY", status: "COMPLETED", createdBy: 2 });
    const [goods] = await db().select().from(s.invoiceItems).where(and(eq(s.invoiceItems.invoiceId, sale.invoiceId), eq(s.invoiceItems.variantId, 1)));
    const refundDigital = () => withTx((tx) => reversalService.approveReversal(tx, { invoiceId: sale.invoiceId,
      detailIds: sale.detailIds, reason: "رد من الخزينة مقابل قبض البطاقة", refund: { method: "CASH" } }, manager));
    const returnGoods = () => withTx((tx) => returnSaleInTx(tx, { invoiceId: sale.invoiceId,
      lines: [{ invoiceItemId: Number(goods.id), baseQuantity: 1 }], restock: true }, manager));
    if (order === "digital-first") { await refundDigital(); await returnGoods(); }
    else { await returnGoods(); await refundDigital(); }
    const [invoice] = await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId));
    expect(invoice).toMatchObject({ status: "RETURNED", returnedTotal: "10100.00", paidAmount: "100.00" });
    expect((await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0].currentBalance).toBe("-100.00");
    const movements = await db().select().from(s.inventoryMovements);
    expect(movements).toHaveLength(2);
    expect(movements.every((movement) => movement.variantId === 1)).toBe(true);
    expect((await db().select().from(s.externalPaymentAttempts).where(eq(s.externalPaymentAttempts.id, sale.attemptId)))[0].state).toBe("CONFIRMED");
    expect((await db().select().from(s.digitalWallets))[0]).toMatchObject({ currentBalance: "100000.00", reservedBalance: "0.00" });
  });
});

describe("preinvoice capture allocation", () => {
  it.each(["CASH", "CARD"] as const)("refunds confirmed %s capture with no issue, then restores the resolved cancellation", async (method) => {
    const f = await fixture(method);
    const prepared = await withTx((tx) => intentService.prepare(tx, f.input, actor));
    expect(await withTx((tx) => intentService.cancelIntent(tx, { intentId: prepared.intentId }, actor))).toMatchObject({ outcome: "NEEDS_REVIEW" });
    const [item] = await db().select().from(s.digitalSaleIntentItems);
    const refund = { method: "CASH" as const };
    await withTx((tx) => reviewResolutionService.requestResolution(tx, { intentId: prepared.intentId, decision: "SETTLE_PARTIAL",
      reason: "طابقت الجهاز ولم يصدر الكرت؛ يرد كامل المقبوض من الخزينة",
      settlement: { captureConfirmed: true, refundMethod: "CASH", regularDisposition: "RELEASE" },
      items: [{ intentItemId: Number(item.id), outcome: "NOT_ISSUED" }] }, manager));
    await db().insert(s.receipts).values({ branchId: 1, direction: "IN", amount: "100000", paymentMethod: "CASH", cashBucket: "TREASURY", status: "COMPLETED", createdBy: 2 });
    await withTx((tx) => reviewResolutionService.approveResolution(tx, { intentId: prepared.intentId, refund }, approver));
    const state = await intentService.getIntent(db(), prepared.intentId, actor);
    expect(state).toMatchObject({ intent: { status: "CANCELLED" }, financialSettlement: { status: "COMPLETED", saleAmount: "0.00" } });
    expect(await withTx((tx) => intentService.prepare(tx, f.input, actor))).toMatchObject({ intentId: prepared.intentId, replay: true });
    expect(await db().select().from(s.invoices)).toHaveLength(0);
    expect((await db().select().from(s.receipts).where(eq(s.receipts.direction, "OUT")))[0].amount).toBe(method === "CASH" ? "10000.00" : "10100.00");
    expect((await db().select().from(s.digitalWallets))[0]).toMatchObject({ currentBalance: "100000.00", reservedBalance: "0.00" });
    if (method === "CARD") expect((await db().select().from(s.externalPaymentAttempts))[0].state).toBe("CONFIRMED");
  });

  it("keeps confirmed cash and unknown issuance reserved through expiry and failed close attempts", async () => {
    const f = await fixture("CASH");
    const prepared = await withTx((tx) => intentService.prepare(tx, f.input, actor));
    await db().update(s.digitalSaleIntents).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(s.digitalSaleIntents.id, prepared.intentId));
    expect(await withTx((tx) => intentService.expireStaleIntents(tx))).toEqual({ expired: 0, needsReview: 1 });
    const [item] = await db().select().from(s.digitalSaleIntentItems);
    await expect(withTx((tx) => reviewResolutionService.requestResolution(tx, { intentId: prepared.intentId, decision: "CANCEL_NO_ISSUE",
      reason: "لا يجوز إلغاء مال مقبوض دون رد", items: [{ intentItemId: Number(item.id), outcome: "NOT_ISSUED" }] }, manager))).rejects.toThrow(/قبض|العميل/);
    await db().update(s.digitalSaleIntentItems).set({ fulfillmentStatus: "UNKNOWN" }).where(eq(s.digitalSaleIntentItems.id, Number(item.id)));
    await expect(withTx((tx) => finalizeService.finalize(tx, { intentId: prepared.intentId, clientRequestId: f.input.clientRequestId,
      paymentAmount: "10000", paymentMethod: "CASH" }, manager))).rejects.toThrow(/لم ينجح/);
    expect((await db().select().from(s.digitalWallets))[0]).toMatchObject({ currentBalance: "100000.00", reservedBalance: "9500.00" });
    expect(await db().select().from(s.invoices)).toHaveLength(0);
    expect(await db().select().from(s.receipts)).toHaveLength(0);
  });

  it.each([
    ["CASH", "PREPAID", "SELL"], ["CARD", "PREPAID", "RELEASE"],
    ["CASH", "POSTPAID", "RELEASE"], ["CARD", "POSTPAID", "SELL"],
  ] as const)("settles %s/%s/%s once with an issued and non-issued card", async (method, mode, regularDisposition) => {
    const f = await fixture(method, "PRINT_POS", { cards: 2, mode });
    const prepared = await withTx((tx) => intentService.prepare(tx, f.input, actor));
    await execute(prepared.intentId);
    const items = await db().select().from(s.digitalSaleIntentItems).where(eq(s.digitalSaleIntentItems.intentId, prepared.intentId)).orderBy(s.digitalSaleIntentItems.id);
    await withTx(async (tx) => {
      await intentService.claimExecution(tx, { intentId: prepared.intentId, intentItemId: Number(items[1].id), claimToken: "failed-card-claim" }, actor);
      await intentService.markExecution(tx, { intentId: prepared.intentId, intentItemId: Number(items[1].id), claimToken: "failed-card-claim", status: "FAILED" }, actor);
    });
    await expect(withTx((tx) => writeoffService.requestWriteoff(tx, { intentId: prepared.intentId, reason: "لا يجوز تجاهل قبض العميل" }, manager))).rejects.toThrow(/قبض|العميل/);
    const refundMethod = method === "CARD" ? "CARD" : "CASH";
    await withTx((tx) => reviewResolutionService.requestResolution(tx, { intentId: prepared.intentId, decision: "SETTLE_PARTIAL",
      reason: "طوبق الجهاز: الكرت الأول صادر والثاني لم يصدر والقبض كامل",
      settlement: { captureConfirmed: true, refundMethod, regularDisposition },
      items: items.map((item, i) => ({ intentItemId: Number(item.id), outcome: i === 0 ? "ISSUED" : "NOT_ISSUED", providerReference: i === 0 ? "001172" : null })) }, manager));
    const [allocation] = await db().select().from(digitalIntentSettlements);
    expect(money(allocation.saleAmount).plus(allocation.refundAmount).eq(allocation.capturedAmount)).toBe(true);
    const refund = method === "CARD" ? { method: "CARD" as const, reference: "PARTIAL-REFUND", confirmed: true as const } : { method: "CASH" as const };
    if (method === "CARD") {
      await withTx((tx) => reviewResolutionService.controlResolutionRefund(tx, { intentId: prepared.intentId }, { stage: "RESERVE", expectedAmount: allocation.refundAmount }, approver));
      await withTx((tx) => reviewResolutionService.evidenceForResolution(tx, { intentId: prepared.intentId, refund }, approver));
      await expect(withTx(async (tx) => { await reviewResolutionService.approveResolution(tx, { intentId: prepared.intentId, refund }, approver); throw new Error("late settlement failure"); })).rejects.toThrow("late settlement failure");
      expect(await db().select().from(s.invoices)).toHaveLength(0);
      expect(await db().select().from(s.receipts)).toHaveLength(0);
      expect((await db().select().from(digitalRefundPayments))[0].status).toBe("EVIDENCED");
    } else await db().insert(s.receipts).values({ branchId: 1, direction: "IN", amount: "100000", paymentMethod: "CASH", cashBucket: "TREASURY", status: "COMPLETED", createdBy: 2 });
    const [result] = await Promise.all([1, 2].map(() => withTx((tx) => reviewResolutionService.approveResolution(tx, { intentId: prepared.intentId, refund }, approver))));
    expect(await withTx((tx) => reviewResolutionService.approveResolution(tx, { intentId: prepared.intentId, refund }, approver))).toMatchObject({ invoiceId: result.invoiceId });
    expect(await withTx((tx) => intentService.prepare(tx, f.input, actor))).toMatchObject({ intentId: prepared.intentId, replay: true });
    const invoices = await db().select().from(s.invoices);
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ total: allocation.saleAmount, paidAmount: allocation.saleAmount, paymentMethod: method });
    expect(await withTx(tx=>finalizeService.finalize(tx,{intentId:prepared.intentId,clientRequestId:f.input.clientRequestId,
      paymentMethod:method,paymentAmount:allocation.capturedAmount},actor))).toMatchObject({
        total:allocation.saleAmount,paidAmount:allocation.saleAmount,returnedTotal:"0.00",paymentMethod:method,invoiceStatus:"PAID",
        settledCapture:{capturedAmount:allocation.capturedAmount,refundAmount:allocation.refundAmount}});
    const collections = (await db().select().from(s.receipts)).filter((receipt) => receipt.description?.includes("قبض محتجز"));
    expect(collections).toHaveLength(1);
    expect(collections[0]).toMatchObject({ amount: allocation.capturedAmount, invoiceId: null, paymentMethod: method });
    const outs = await db().select().from(s.receipts).where(eq(s.receipts.direction, "OUT"));
    expect(outs).toHaveLength(1);
    expect(outs[0]).toMatchObject({ amount: allocation.refundAmount, paymentMethod: refundMethod });
    expect(await db().select().from(s.digitalSaleDetails)).toHaveLength(1);
    expect((await db().select().from(s.branchStock).where(eq(s.branchStock.variantId, 1)))[0].quantity).toBe(regularDisposition === "SELL" ? 9 : 10);
    if (mode === "PREPAID") expect((await db().select().from(s.digitalWallets))[0]).toMatchObject({ currentBalance: "90500.00", reservedBalance: "0.00" });
    else expect((await db().select().from(s.suppliers).where(eq(s.suppliers.id, f.supplierId)))[0].currentBalance).toBe("9500.00");
  });
});

describe("cash rounding across digital and ordinary returns", () => {
  it.each(["digital-first", "goods-first", "goods-split", "large-goods-first", "large-goods-split", "small-card-first"])("reverses rounding exactly once: %s", async (order) => {
    const f = await fixture("CASH");
    if (["large-goods-first","large-goods-split","small-card-first"].includes(order)) {
      await db().update(s.digitalPriceVersions).set({ sellPrice:"50", providerShare:"40", marginAmount:"10" }).where(eq(s.digitalPriceVersions.id, f.input.lines[0].priceVersionId));
      f.input.lines[0].expectedSellPrice = "50";
      const split = order === "large-goods-split";
      await db().update(s.productPrices).set({ price: split ? "5025" : "10050" }).where(eq(s.productPrices.productUnitId, 1));
      f.input.regularLines![0].quantity = split ? "2" : "1";
    }
    if (order === "goods-split") {
      await db().update(s.productPrices).set({ price: "50" }).where(eq(s.productPrices.productUnitId, 1));
      f.input.regularLines![0].quantity = "2";
    }
    const prepared = await withTx((tx) => intentService.prepare(tx, { ...f.input, customerId: 1 }, actor));
    await execute(prepared.intentId);
    const sale = await withTx((tx) => finalizeService.finalize(tx, { intentId: prepared.intentId, clientRequestId: f.input.clientRequestId,
      paymentAmount: "10000", paymentMethod: "CASH", customerId: 1 }, actor));
    const [detail] = await db().select().from(s.digitalSaleDetails);
    const [goods] = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.variantId, 1));
    const input = { invoiceId: sale.invoiceId, detailIds: [Number(detail.id)], reason: "إلغاء كرت مع تقريب نقدي" };
    await expect(withTx((tx) => reversalService.evidenceForRefund(tx, { ...input, refund: { method: "CARD", reference: "IMPOSSIBLE", confirmed: true } }, "REVERSED", manager))).rejects.toThrow(/الرد|القبض/);
    await db().insert(s.receipts).values({ branchId: 1, direction: "IN", amount: "100000", paymentMethod: "CASH", cashBucket: "TREASURY", status: "COMPLETED", createdBy: 2 });
    const ordinary = () => withTx((tx) => returnSaleInTx(tx, { invoiceId: sale.invoiceId, lines: [{ invoiceItemId: Number(goods.id), baseQuantity: 1 }], restock: true }, manager));
    const digital = () => withTx((tx) => reversalService.approveReversal(tx, input, manager));
    if (order === "digital-first" || order === "small-card-first") { await digital(); await ordinary(); }
    else { await ordinary(); await digital(); if (order === "goods-split" || order === "large-goods-split") await ordinary(); }
    const [invoice] = await db().select().from(s.invoices);
    expect(invoice).toMatchObject({ status: "RETURNED", returnedTotal: "10000.00" });
    if (order.startsWith("large-") || order === "small-card-first") {
      expect((await db().select().from(s.customers).where(eq(s.customers.id,1)))[0].currentBalance).toBe("-9950.50");
      const [out]=await db().select().from(s.receipts).where(eq(s.receipts.direction,"OUT"));
      expect(out.amount).toBe("49.50"); expect(invoice.paidAmount).toBe("9950.50");
    }
    const ledger = await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.invoiceId, sale.invoiceId));
    expect(toDbMoney(ledger.reduce((sum, entry) => sum.plus(entry.revenue ?? "0"), money(0)))).toBe("0.00");
    expect(toDbMoney(ledger.reduce((sum, entry) => sum.plus(entry.profit ?? "0"), money(0)))).toBe("0.00");
  });
});

describe("capture admission and reviewed financial partitions", () => {
  it.each(["CARD","CASH"] as const)("admits a valid attested %s checkout without diverting it to review", async method => {
    const f=await fixture(method);
    const input={...f.input,capturedDigitalPayment:{confirmed:true as const,deviceId:"reception-device",amount:method==="CARD"?"10100.00":"10000.00"}};
    if(method==="CARD") {
      await expect(withTx(tx=>intentService.prepare(tx,{...input,clientRequestId:"different-origin-key"},actor))).rejects.toThrow(/إثبات/);
      await expect(withTx(tx=>intentService.prepare(tx,{...input,capturedDigitalPayment:{...input.capturedDigitalPayment,deviceId:"other-device"}},actor))).rejects.toThrow(/إثبات/);
      expect(await db().select().from(s.digitalSaleIntents)).toHaveLength(0);
    }
    const init=await withTx(tx=>intentService.prepare(tx,input,actor));
    expect((await db().select().from(s.digitalSaleIntents))[0].status).toBe("PREPARED");
    expect((await db().select().from(s.digitalSaleIntentItems))).toHaveLength(1);
    expect(await withTx(tx=>intentService.prepare(tx,input,actor))).toMatchObject({intentId:init.intentId,replay:true});
    await db().update(s.digitalSaleIntents).set({status:"NEEDS_REVIEW"}).where(eq(s.digitalSaleIntents.id,init.intentId));
    await db().update(s.digitalSaleIntentItems).set({fulfillmentStatus:"UNKNOWN"}).where(eq(s.digitalSaleIntentItems.intentId,init.intentId));
    await db().update(s.digitalPriceVersions).set({validUntil:new Date()}).where(eq(s.digitalPriceVersions.id,input.lines[0].priceVersionId));
    expect(await withTx(tx=>intentService.prepare(tx,input,actor))).toMatchObject({intentId:init.intentId,replay:true});
    expect((await db().select().from(s.digitalSaleIntentItems))[0].fulfillmentStatus).toBe("UNKNOWN");
    expect((await db().select().from(s.digitalSaleIntents))[0].checkoutSnapshot?.unadmittedCapture).toBeUndefined();
  });
  it.each([["CARD","retired"],["CASH","retired"],["CARD","changed"],["CASH","changed"]] as const)("preserves a rejected %s/%s capture for reviewed full refund without issuance", async (method, reason) => {
    const f = await fixture(method);
    const input = {...f.input, capturedDigitalPayment: { amount: method === "CARD" ? "10100.00" : "10000.00", confirmed: true as const, deviceId:"reception-device" }};
    await db().update(s.digitalPriceVersions).set(reason==="retired"?{validUntil:new Date()}:{sellPrice:"11000",marginAmount:"1500"}).where(eq(s.digitalPriceVersions.id,input.lines[0].priceVersionId));
    const [first, second] = await Promise.all([0,1].map(()=>withTx(tx=>intentService.prepare(tx,input,actor))));
    expect(first.intentId).toBe(second.intentId);
    const { intentId } = first;
    expect((await db().select().from(s.digitalSaleIntents))[0]).toMatchObject({status:"NEEDS_REVIEW",expectedTotal:input.capturedDigitalPayment.amount});
    expect(await db().select().from(s.digitalSaleIntentItems)).toHaveLength(0);
    expect(await db().select().from(s.digitalWalletReservations)).toHaveLength(0);
    const review=await reviewResolutionService.getReviewDetails(db(),intentId,1);
    expect(review.intent).toMatchObject({capturedRequestId:input.clientRequestId,capturedDevice:"reception-device",capturedReference:method==="CARD"?"BANK-10324087":null});
    const cashier=await intentService.getIntent(db(),intentId,actor);
    expect(JSON.stringify(cashier)).not.toMatch(/unadmittedCapture|sourcePayload|providerShare|requestFingerprint/);
    await expect(withTx(tx=>intentService.prepare(tx,{...input,lines:input.lines.map(l=>({...l,providerReference:"changed"}))},actor))).rejects.toThrow();
    await expect(withTx(tx=>reviewResolutionService.requestResolution(tx,{intentId,reason:"معالجة قبض بلا إصدار",decision:"FINALIZE_SALE",items:[]},manager))).rejects.toThrow();
    await withTx(tx=>reviewResolutionService.requestResolution(tx,{intentId,reason:"القبض مطابق ولم يتم قبول السلة",decision:"SETTLE_PARTIAL",items:[],settlement:{captureConfirmed:true,regularDisposition:"RELEASE",refundMethod:method}},manager));
    const refund = method==="CARD" ? {method,reference:"VERIFIED-BANK-REFUND",confirmed:true as const} : {method};
    if (method==="CARD") {
      await withTx(tx=>reviewResolutionService.controlResolutionRefund(tx,{intentId},{stage:"RESERVE",expectedAmount:input.capturedDigitalPayment.amount},approver));
      await withTx(tx=>reviewResolutionService.evidenceForResolution(tx,{intentId,refund},approver));
    } else await db().insert(s.receipts).values({branchId:1,direction:"IN",amount:"15000",cashBucket:"TREASURY",paymentMethod:"CASH",createdBy:2,status:"COMPLETED"});
    await withTx(tx=>reviewResolutionService.approveResolution(tx,{intentId,refund},approver));
    expect(await withTx(tx=>intentService.prepare(tx,input,actor))).toMatchObject({intentId,replay:true});
    await withTx(tx=>reviewResolutionService.approveResolution(tx,{intentId,refund},approver));
    expect((await db().select().from(s.receipts)).filter(r=>r.direction==="OUT")).toHaveLength(1);
    expect((await db().select().from(s.receipts)).filter(r=>r.description?.includes("قبض محتجز"))).toHaveLength(1);
    expect(await db().select().from(s.invoices)).toHaveLength(0);
    expect(await db().select().from(s.digitalSaleDetails)).toHaveLength(0);
  });

  it("ties a failed POS CARD admission to the exact RETAIL proof; captured funds remain refund-only", async () => {
    const f=await fixture("CARD","POS");
    const input={...f.input,sourceType:"POS" as const,sourcePayload:undefined,capturedDigitalPayment:{amount:"10100.00",confirmed:true as const,deviceId:"reception-device"}};
    await db().update(s.shifts).set({shiftType:"RETAIL"}).where(eq(s.shifts.id,1));
    await db().update(s.digitalPriceVersions).set({validUntil:new Date()}).where(eq(s.digitalPriceVersions.id,input.lines[0].priceVersionId));
    const {intentId}=await withTx(tx=>intentService.prepare(tx,input,actor));
    expect((await db().select().from(s.digitalSaleIntents))[0]).toMatchObject({status:"NEEDS_REVIEW",externalPaymentAttemptId:f.attemptId});
    expect(await db().select().from(s.digitalSaleIntentItems)).toHaveLength(0);
    await withTx(tx=>reviewResolutionService.requestResolution(tx,{intentId,items:[],reason:"رد كامل القبض دون حجز إصدار",decision:"SETTLE_PARTIAL",settlement:{captureConfirmed:true,regularDisposition:"RELEASE",refundMethod:"CARD"}},manager));
    await withTx(tx=>reviewResolutionService.controlResolutionRefund(tx,{intentId},{stage:"RESERVE",expectedAmount:"10100"},approver));
    const refund={method:"CARD" as const,reference:"POS-FULL-REFUND",confirmed:true as const};
    await withTx(tx=>reviewResolutionService.evidenceForResolution(tx,{intentId,refund},approver));
    await withTx(tx=>reviewResolutionService.approveResolution(tx,{intentId,refund},approver));
    expect(await withTx(tx=>intentService.prepare(tx,input,actor))).toMatchObject({intentId,replay:true});
    expect(await db().select().from(s.invoices)).toHaveLength(0);
    expect(await db().select().from(s.receipts)).toHaveLength(2);
  });

  it("partitions admitted discounted INVOICE snapshots before granting a physical refund",async()=>{
    const f=await fixture("CARD","POS",{cards:2,proofAmount:"19000"});
    const [offer]=await db().select().from(s.digitalOfferings);
    const input={...f.input,regularLines:[],sourceType:"INVOICE" as const,priceApprovedBy:2,sourcePayload:{branchId:1,shiftId:1,priceTier:"RETAIL",clientRequestId:f.input.clientRequestId,deviceId:f.input.externalPaymentDeviceId,payment:{method:"CARD",amount:"19000",externalPaymentAttemptId:f.attemptId},lines:f.input.lines.map((l,i)=>({variantId:offer.variantId,productUnitId:offer.productUnitId,quantity:"1",unitPriceOverride:"10000",internalLineToken:l.lineKey,...(!i?{discountPercent:"10"}:{})}))}};
    await db().update(s.digitalPriceVersions).set({providerShare:"8900",marginAmount:"1100"}).where(eq(s.digitalPriceVersions.id,input.lines[0].priceVersionId));
    const {intentId}=await withTx(tx=>intentService.prepare(tx,input,actor));
    await execute(intentId);
    await db().update(s.digitalSaleIntents).set({status:"NEEDS_REVIEW"}).where(eq(s.digitalSaleIntents.id,intentId));
    const items=await db().select().from(s.digitalSaleIntentItems).orderBy(s.digitalSaleIntentItems.id);
    await withTx(tx=>reviewResolutionService.requestResolution(tx,{intentId,decision:"SETTLE_PARTIAL",reason:"مطابقة جزئية حسب تقرير المزود",settlement:{captureConfirmed:true,regularDisposition:"RELEASE",refundMethod:"CARD"},items:items.map((i,n)=>({intentItemId:i.id,outcome:n?"NOT_ISSUED":"ISSUED",providerReference:n?null:i.providerReference}))},manager));
    const [row]=await db().select().from(digitalIntentSettlements);
    expect(row).toMatchObject({saleAmount:"9000.00",refundAmount:"10000.00"});
    const [reviewer]=await db().select().from(s.users).where(eq(s.users.id,approver.userId));
    const route=salesRouter.createCaller(callerContext(reviewer));
    await expect(route.approveReviewResolution({intentId,refund:{method:"CARD"},expectedRefundAmount:"0"})).rejects.toThrow();
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    await db().update(s.shifts).set({status:"CLOSED"}).where(eq(s.shifts.id,1));
    await expect(withTx(tx=>reviewResolutionService.controlResolutionRefund(tx,{intentId},{stage:"RESERVE",expectedAmount:"10000"},approver))).rejects.toThrow(/الوردية/);
    expect(await db().select().from(digitalRefundPayments)).toHaveLength(0);
    await db().update(s.shifts).set({status:"OPEN"}).where(eq(s.shifts.id,1));
    await withTx(tx=>reviewResolutionService.controlResolutionRefund(tx,{intentId},{stage:"RESERVE",expectedAmount:"10000"},approver));
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    expect(await db().select().from(s.invoices)).toHaveLength(0);
    await expect(withTx(tx=>reviewResolutionService.rejectResolution(tx,{intentId,reason:"لا يمكن تبديل الحجز"},approver))).rejects.toThrow();
    const refund={method:"CARD" as const,confirmed:true as const,reference:"BANK-RET-917"};
    await withTx(tx=>reviewResolutionService.evidenceForResolution(tx,{intentId,refund},approver));
    await expect(withTx(async tx=>{await reviewResolutionService.approveResolution(tx,{intentId,refund},approver);throw Error("rollback after sale")})).rejects.toThrow("rollback after sale");
    expect((await db().select().from(digitalRefundPayments))[0].status).toBe("EVIDENCED");
    // Simulate a pre-fix inconsistent allocation after immutable bank evidence; never erase or top it up.
    await db().update(digitalIntentSettlements).set({saleAmount:"10000",refundAmount:"9000"}).where(eq(digitalIntentSettlements.id,row.id));
    await expect(withTx(tx=>reviewResolutionService.approveResolution(tx,{intentId,refund},approver))).rejects.toThrow(/فرق التسوية/);
    expect((await db().select().from(digitalRefundPayments))[0]).toMatchObject({status:"EVIDENCED",amount:"10000.00"});
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    await db().update(digitalIntentSettlements).set({saleAmount:"9000",refundAmount:"10000"}).where(eq(digitalIntentSettlements.id,row.id));
    const done=await withTx(tx=>reviewResolutionService.approveResolution(tx,{intentId,refund},approver));
    expect(await withTx(tx=>reviewResolutionService.approveResolution(tx,{intentId,refund},approver))).toMatchObject(done);
    expect((await db().select().from(s.digitalSaleDetails))[0]).toMatchObject({sellPriceSnapshot:"9000.00",providerShareSnapshot:"8900.00"});
  });
});

describe("reviewed allocation authority, zero sale and refunds",()=>{
  async function reviewOne(method:"CASH"|"CARD") {
    const f=await fixture(method);
    const {intentId}=await withTx(tx=>intentService.prepare(tx,f.input,actor));
    await db().update(s.digitalSaleIntents).set({status:"NEEDS_REVIEW"}).where(eq(s.digitalSaleIntents.id,intentId));
    const [item]=await db().select().from(s.digitalSaleIntentItems);
    return {f,intentId,items:[{intentItemId:item.id,outcome:"ISSUED" as const,providerReference:item.providerReference}]};
  }

  it("rejects a spoofed self-review and removes an unfunded allocation for a replacement full sale",async()=>{
    const {intentId,items}=await reviewOne("CASH");
    const request={intentId,items,reason:"القبض وجهاز الإصدار مطابقان",decision:"SETTLE_PARTIAL" as const,settlement:{refundMethod:"CASH" as const,captureConfirmed:true as const,regularDisposition:"SELL" as const}};
    expect(await withTx(tx=>reviewResolutionService.requestResolution(tx,request,manager))).toMatchObject({autoApproved:false});
    const rejection={intentId,reason:"تصحيح القرار قبل القبض المالي"};
    await expect(withTx(tx=>reviewResolutionService.rejectResolution(tx,rejection,{...manager,isOwner:true}))).rejects.toThrow(/مدير آخر/);
    expect(await db().select().from(digitalIntentSettlements)).toHaveLength(1);
    await expect(withTx(async tx=>{
      const [intent]=await tx.select().from(s.digitalSaleIntents).where(eq(s.digitalSaleIntents.id,intentId));
      await materializeDigitalCapture(tx,intent,approver.userId,approver);
      await reviewResolutionService.rejectResolution(tx,rejection,approver);
    })).rejects.toThrow(/معالجة مالية/);
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    await db().update(s.users).set({isOwner:true,role:"admin"}).where(eq(s.users.id,manager.userId));
    const owner={...manager,role:"admin"};
    await withTx(tx=>reviewResolutionService.rejectResolution(tx,rejection,owner));
    expect(await db().select().from(digitalIntentSettlements)).toHaveLength(0);
    const accepted=await withTx(tx=>reviewResolutionService.requestResolution(tx,{intentId,items,reason:"مطابقة جميع الكروت الصادرة",decision:"FINALIZE_SALE"},owner));
    expect(accepted.autoApproved).toBe(true);
    expect(await db().select().from(s.invoices)).toHaveLength(1);
    expect(await db().select().from(s.receipts)).toHaveLength(1);
  });

  it("executes a zero CARD payout through the actual review router without a fake reference",async()=>{
    const {intentId,items}=await reviewOne("CARD");
    await withTx(tx=>reviewResolutionService.requestResolution(tx,{intentId,items,reason:"كل الكروت صادرة ولا يوجد رد",decision:"SETTLE_PARTIAL",settlement:{refundMethod:"CARD",captureConfirmed:true,regularDisposition:"SELL"}},manager));
    const [user]=await db().select().from(s.users).where(eq(s.users.id,approver.userId));
    const api=salesRouter.createCaller(callerContext(user));
    expect(await api.approveReviewResolution({intentId,refund:{method:"CARD"}})).toMatchObject({stage:"EXECUTE",decision:"SETTLE_PARTIAL"});
    expect(await db().select().from(digitalRefundPayments)).toHaveLength(0);
    expect(await db().select().from(s.receipts)).toHaveLength(1);
  });

  it.each([["PREPAID",true],["POSTPAID",true],["PREPAID",false]] as const)("retains zero-rounded goods/card (%s, issued=%s) through replay",async(mode,issued)=>{
    const f=await fixture("CASH","PRINT_POS",{mode});
    const [version]=await db().select().from(s.digitalPriceVersions);
    const [provider]=await db().select().from(s.digitalProviders);
    await db().update(s.digitalPriceVersions).set({sellPrice:"1000",providerShare:"900",marginAmount:"100"}).where(eq(s.digitalPriceVersions.id,version.id));
    f.input.lines[0].expectedSellPrice="1000"; f.input.regularLines=issued?[]:f.input.regularLines;
    if (issued) {
      const {offeringId}=await withTx(tx=>offeringService.createOffering(tx,{providerId:provider.id,offeringType:"TELECOM_CARD",name:"كرت صغير",pricingMode:"FIXED_MARGIN",fixedMargin:"10",roundingStep:"1",branches:[{branchId:1,walletId:f.walletId||undefined}]},actor));
      const priceVersionId=extractInsertId(await db().insert(s.digitalPriceVersions).values({batchId:version.batchId,branchId:1,offeringId,sellPrice:"100",providerShare:"90",marginAmount:"10",validFrom:new Date(),createdBy:1}));
      await db().insert(s.digitalCurrentPrices).values({branchId:1,offeringId,priceVersionId});
      f.input.lines.push({lineKey:"small-card",offeringId,priceVersionId,expectedSellPrice:"100",providerReference:"SMALL-REF"});
    }
    const {intentId}=await withTx(tx=>intentService.prepare(tx,f.input,actor));
    await db().update(s.digitalSaleIntents).set({status:"NEEDS_REVIEW"}).where(eq(s.digitalSaleIntents.id,intentId));
    const items=await db().select().from(s.digitalSaleIntentItems);
    await withTx(tx=>reviewResolutionService.requestResolution(tx,{intentId,decision:"SETTLE_PARTIAL",reason:"رد غير الصادر بعد مطابقة التقرير",settlement:{regularDisposition:issued?"RELEASE":"SELL",captureConfirmed:true,refundMethod:"CASH"},items:items.map(i=>({intentItemId:i.id,outcome:i.lineKey==="small-card"?"ISSUED":"NOT_ISSUED",providerReference:i.lineKey==="small-card"?i.providerReference:null}))},manager));
    await db().insert(s.receipts).values({branchId:1,direction:"IN",amount:"2000",paymentMethod:"CASH",cashBucket:"TREASURY",status:"COMPLETED",createdBy:2});
    const result=await withTx(tx=>reviewResolutionService.approveResolution(tx,{intentId},approver));
    expect(await withTx(tx=>reviewResolutionService.approveResolution(tx,{intentId},approver))).toMatchObject(result);
    expect((await db().select().from(s.invoices))[0]).toMatchObject({id:result.invoiceId,total:"0.00",cashRoundingAdjustment:"-100.00"});
    expect((await db().select().from(s.digitalSaleDetails))).toHaveLength(issued?1:0);
    expect((await db().select().from(s.branchStock).where(eq(s.branchStock.variantId,1)))[0].quantity).toBe(issued?10:9);
    if(mode==="PREPAID")expect((await db().select().from(s.digitalWallets))[0]).toMatchObject({currentBalance:issued?"99910.00":"100000.00",reservedBalance:"0.00"});
    else expect((await db().select().from(s.suppliers))[0].currentBalance).toBe("90.00");
    const [booked]=await db().select().from(s.accountingEntries).where(and(eq(s.accountingEntries.invoiceId,result.invoiceId!),eq(s.accountingEntries.entryType,"SALE")));
    expect(booked).toMatchObject({revenue:"100.00",cost:issued?"90.00":"10.00"});
    const [out]=await db().select().from(s.receipts).where(eq(s.receipts.direction,"OUT")); expect(out.amount).toBe("1000.00");
  });
});


describe("second review regressions",()=>{
  it("recovers confirmed bank capture after actual source close without rewriting its shift",async()=>{
    const f=await fixture("CARD");
    const {closeShift}=await import("../shiftService");
    await closeShift({shiftId:1,countedCash:"0",enforceCashGovernance:true},actor);
    const [closed]=await db().select().from(s.shifts).where(eq(s.shifts.id,1));
    await db().insert(s.shifts).values({id:2,branchId:1,userId:2,status:"OPEN",shiftType:"RECEPTION",openingBalance:"0"});
    const input={...f.input,capturedDigitalPayment:{confirmed:true as const,amount:"10100.00",deviceId:"reception-device"}};
    const {intentId}=await withTx(tx=>intentService.prepare(tx,input,actor));
    await withTx(tx=>reviewResolutionService.requestResolution(tx,{intentId,items:[],decision:"SETTLE_PARTIAL",reason:"قبض البطاقة قبل إقفال الوردية",
      settlement:{captureConfirmed:true,regularDisposition:"RELEASE",refundMethod:"CARD",recovery:{postingShiftId:2,reason:"استدراك القبض الأصلي في الفترة المفتوحة"}}},manager));
    await withTx(tx=>reviewResolutionService.controlResolutionRefund(tx,{intentId},{stage:"RESERVE",expectedAmount:"10100"},approver));
    await expect(closeShift({shiftId:2,countedCash:"0",enforceCashGovernance:true},manager)).rejects.toThrow(/استدراك|تسوية/);
    const refund={method:"CARD" as const,reference:"CLOSED-SOURCE-REFUND",confirmed:true as const};
    await withTx(tx=>reviewResolutionService.evidenceForResolution(tx,{intentId,refund},approver));
    const [evidence]=await db().select().from(digitalRefundPayments);
    const [allocation]=await db().select().from(digitalIntentSettlements);
    await expect(closeShift({shiftId:2,countedCash:"0",enforceCashGovernance:true},manager)).rejects.toThrow(/استدراك|تسوية/);
    expect((await db().select().from(s.shifts).where(eq(s.shifts.id,2)))[0].status).toBe("OPEN");
    expect((await db().select().from(digitalRefundPayments))[0]).toEqual(evidence);
    expect((await db().select().from(digitalIntentSettlements))[0]).toEqual(allocation);
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    await db().insert(s.shifts).values({id:3,branchId:1,userId:3,status:"OPEN",shiftType:"RETAIL",openingBalance:"0"});
    await closeShift({shiftId:3,countedCash:"0",enforceCashGovernance:true},approver);
    await withTx(tx=>reviewResolutionService.approveResolution(tx,{intentId,refund},approver));
    await closeShift({shiftId:2,countedCash:"0",enforceCashGovernance:true},manager);
    await withTx(tx=>reviewResolutionService.approveResolution(tx,{intentId,refund},approver));
    expect((await db().select().from(s.shifts).where(eq(s.shifts.id,1)))[0]).toEqual(closed);
    expect((await db().select().from(s.receipts)).every(r=>r.shiftId!==1)).toBe(true);
    expect((await db().select().from(s.receipts)).find(r=>r.direction==="IN")).toMatchObject({shiftId:2,paymentMethod:"CARD",cashBucket:null});
    expect(await withTx(tx=>intentService.prepare(tx,input,actor))).toMatchObject({intentId,replay:true});
  });
  it.each([["POS","CASH"],["INVOICE","CASH"],["INVOICE","CREDIT"]] as const)("durably closes rejected noncaptured %s/%s before a late retry",async(sourceType,paymentMethod)=>{
    const f=await fixture("CASH");
    const [offer]=await db().select().from(s.digitalOfferings);
    await db().update(s.shifts).set({shiftType:"RETAIL"}).where(eq(s.shifts.id,1));
    const input={...f.input,sourceType,paymentMethod,regularLines:[],customerId:1,
      sourcePayload:sourceType==="INVOICE"?{branchId:1,shiftId:1,customerId:1,priceTier:"RETAIL",clientRequestId:f.input.clientRequestId,
        ...(paymentMethod==="CASH"?{payment:{method:"CASH",amount:"10000"}}:{}),
        lines:[{variantId:offer.variantId,productUnitId:offer.productUnitId,quantity:"1",unitPriceOverride:"10000",internalLineToken:f.input.lines[0].lineKey}]}:undefined};
    await db().update(s.digitalPriceVersions).set({validUntil:new Date()});
    await expect(withTx(tx=>intentService.prepare(tx,input,actor))).rejects.toThrow();
    const result=await withTx(tx=>intentService.prepare(tx,{...input,closeRejectedWithoutPayment:true},actor));
    expect((await intentService.getIntent(db(),result.intentId,actor))?.noAdmissionClosed).toBe(true);
    await db().update(s.digitalPriceVersions).set({validUntil:null});
    const retries=await Promise.all([0,1].map(()=>withTx(tx=>intentService.prepare(tx,input,actor))));
    expect(retries.every(r=>r.intentId===result.intentId)).toBe(true);
    expect(await db().select().from(s.digitalSaleIntentItems)).toHaveLength(0);
    expect(await db().select().from(s.digitalWalletReservations)).toHaveLength(0);
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    const next={...input,clientRequestId:"new-after-closed-request",sourcePayload:input.sourcePayload?{...input.sourcePayload,clientRequestId:"new-after-closed-request"}:undefined};
    expect((await withTx(tx=>intentService.prepare(tx,next,actor))).intentId).not.toBe(result.intentId);
  });
  it.each([["card-first",false],["goods-first",false],["grouped-goods",false],["split-goods",false],["legacy-card-first",false],["card-first",true],["goods-first",true],["grouped-goods",true],["split-goods",true]] as const)("allocates the exact original cent independently: %s positive=%s",async(order,positive)=>{
    const f=await fixture("CASH");
    await db().update(s.productPrices).set({price:"1000"}).where(eq(s.productPrices.productUnitId,1));
    await db().insert(s.products).values({id:2,name:"سلعة ثانية"});
    await db().insert(s.productVariants).values({id:2,productId:2,sku:"ROUND-2",costPrice:"10"});
    await db().insert(s.productUnits).values({id:2,variantId:2,unitName:"قطعة",conversionFactor:"1",isBaseUnit:true});
    await db().insert(s.productPrices).values({productUnitId:2,priceTier:"RETAIL",price:order==="split-goods"?(positive?"2499.5":"2500.5"):(positive?"4999":"5001")});
    await db().insert(s.branchStock).values({branchId:1,variantId:2,quantity:10});
    f.input.regularLines!.push({lineKey:"goods2",variantId:2,productUnitId:2,quantity:order==="split-goods"?"2":"1"});
    const {intentId}=await withTx(tx=>intentService.prepare(tx,{...f.input,customerId:1},actor));
    await execute(intentId);
    const sale=await withTx(tx=>finalizeService.finalize(tx,{intentId,clientRequestId:f.input.clientRequestId,paymentMethod:"CASH",paymentAmount:"16000",customerId:1},actor));
    const items=await db().select().from(s.invoiceItems);const [detail]=await db().select().from(s.digitalSaleDetails);
    await db().insert(s.receipts).values({branchId:1,direction:"IN",amount:"20000",paymentMethod:"CASH",cashBucket:"TREASURY",status:"COMPLETED",createdBy:2});
    const digital=()=>withTx(tx=>reversalService.approveReversal(tx,{invoiceId:sale.invoiceId,detailIds:[detail.id],reason:"رد حصة ثابتة من التقريب الأصلي"},manager));
    const goods=(variants:number[])=>withTx(tx=>returnSaleInTx(tx,{invoiceId:sale.invoiceId,restock:true,lines:items.filter(i=>variants.includes(i.variantId!)).map(i=>({invoiceItemId:i.id,baseQuantity:1}))},manager));
    if(order==="card-first" && !positive) {
      const beforeFailure = {
        items: await db().select().from(s.invoiceItems),
        details: await db().select().from(s.digitalSaleDetails),
        ledger: await db().select().from(s.accountingEntries),
        wallet: await db().select().from(s.digitalWallets),
      };
      await db().execute(sql.raw("CREATE TRIGGER test_digital_rounding_audit_failure BEFORE INSERT ON auditLogs FOR EACH ROW BEGIN IF NEW.action = 'invoice.return.roundingAllocation.v1' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rounding policy audit unavailable'; END IF; END"));
      try {
        await expect(digital()).rejects.toThrow();
        expect((await db().select().from(s.receipts)).filter(r=>r.direction==="OUT")).toHaveLength(0);
        expect((await db().select().from(s.invoices))[0].returnedTotal).toBe("0.00");
        expect(await db().select().from(digitalRefundPayments)).toHaveLength(0);
        expect(await db().select().from(digitalRefundItems)).toHaveLength(0);
        expect(await db().select().from(s.auditLogs).where(eq(s.auditLogs.action,"invoice.return.roundingAllocation.v1"))).toHaveLength(0);
        expect(await db().select().from(s.invoiceItems)).toEqual(beforeFailure.items);
        expect(await db().select().from(s.digitalSaleDetails)).toEqual(beforeFailure.details);
        expect(await db().select().from(s.accountingEntries)).toEqual(beforeFailure.ledger);
        expect(await db().select().from(s.digitalWallets)).toEqual(beforeFailure.wallet);
      } finally {await db().execute(sql.raw("DROP TRIGGER test_digital_rounding_audit_failure"));}
    }
    if(order==="card-first" || order==="legacy-card-first")await digital();
    if(order==="legacy-card-first"){
      await db().update(s.invoiceItems).set({returnedBaseQuantity:0}).where(eq(s.invoiceItems.id,detail.invoiceItemId));
      await db().delete(s.auditLogs).where(eq(s.auditLogs.action,"invoice.return.roundingAllocation.v1"));
    }
    if(order==="grouped-goods")await goods([1,2]);else {await goods([1]);await goods([2]);}
    if(order==="split-goods")await goods([2]);
    if(order!=="card-first" && order!=="legacy-card-first")await digital();
    expect((await db().select().from(s.receipts)).find(r=>r.direction==="OUT")?.amount).toBe(positive?"10000.63":"9999.38");
    expect((await db().select().from(s.invoices))[0]).toMatchObject({returnedTotal:"16000.00",status:"RETURNED",paidAmount:positive?"5999.37":"6000.62"});
    expect((await db().select().from(s.customers).where(eq(s.customers.id,1)))[0].currentBalance).toBe(positive?"-5999.37":"-6000.62");
    const ledger=await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.invoiceId,sale.invoiceId));
    expect(toDbMoney(ledger.reduce((sum,r)=>sum.plus(r.revenue??"0"),money(0)))).toBe("0.00");
    expect(toDbMoney(ledger.reduce((sum,r)=>sum.plus(r.profit??"0"),money(0)))).toBe("0.00");
    const roundingEntries=ledger.filter(r=>r.dedupeKey?.startsWith("ADJUST:IQD:"));
    expect(new Set(roundingEntries.map(r=>r.dedupeKey)).size).toBe(roundingEntries.length);
    expect((await db().select().from(s.auditLogs).where(eq(s.auditLogs.action,"invoice.return.roundingAllocation.v1")))).toHaveLength(1);
  });
});


describe("second review guarded recovery",()=>{
 it("links a real approved treasury surplus without collecting closed CASH twice",async()=>{
   const f=await fixture("CASH");
   const {closeShift}=await import("../shiftService");
   await closeShift({shiftId:1,countedCash:"0",enforceCashGovernance:true},actor);
   const [closed]=await db().select().from(s.shifts);
   const input={...f.input,capturedDigitalPayment:{confirmed:true as const,amount:"10000",deviceId:"reception-device"}};
   const {intentId}=await withTx(tx=>intentService.prepare(tx,input,actor));
   const {recordDailyTreasuryCount}=await import("../cashDailyReconciliationService");
   const cv=await import("../cashVarianceService");
   const day=new Date().toISOString().slice(0,10);
   await db().insert(s.users).values({id:4,openId:"independent-counter",role:"manager",branchId:1});
   const counter={userId:4,branchId:1,role:"manager"};
   await recordDailyTreasuryCount({branchId:1,businessDate:day,countedCash:"10000",countedBreakdown:{"10000":1},expectedVersion:0,clientRequestId:"captured-cash-count"},counter,{user:{id:4,branchId:1,role:"manager",name:"Manager"},req:{headers:{}}} as never);
   const [daily]=await db().select().from(s.cashDailyReconciliations);
   const evidence=await cv.registerCashVarianceEvidence({branchId:1,fileName:"physical-count.png",dataUrl:"data:image/png;base64,"+Buffer.from("counted unadmitted original cash").toString("base64"),clientRequestId:"capture-custody-evidence"},manager);
   const proposal=await cv.proposeCashVarianceCase({sourceType:"DAILY_TREASURY",sourceId:daily.id,reasonCode:"UNRECORDED_CASH_IN",reason:"نقد محصل قبل قبول الطلب محفوظ في الخزينة",evidenceReference:"DIGITAL_CAPTURE:"+input.clientRequestId,evidenceDocumentId:evidence.evidenceDocumentId,clientRequestId:"capture-custody-propose"},manager);
   const approved=await cv.approveCashVarianceCase({caseId:proposal.caseId,expectedVersion:1,clientRequestId:"capture-custody-approve"},approver);
   await db().insert(s.shifts).values({id:2,branchId:1,userId:2,status:"OPEN",shiftType:"RECEPTION",openingBalance:"0"});
   const request={intentId,items:[],decision:"SETTLE_PARTIAL" as const,reason:"رد النقد المحفوظ بالخزينة دون إعادة قبض",
     settlement:{captureConfirmed:true as const,regularDisposition:"RELEASE" as const,refundMethod:"CASH" as const,recovery:{postingShiftId:2,cashCustodyReceiptId:approved.adjustmentReceiptId,reason:"ربط دليل العهدة بمصدر القبض الأصلي"}}};
   await expect(withTx(tx=>reviewResolutionService.requestResolution(tx,{...request,settlement:{...request.settlement,recovery:{...request.settlement.recovery,cashCustodyReceiptId:9999}}},manager))).rejects.toThrow(/سند/);
   await withTx(tx=>reviewResolutionService.requestResolution(tx,request,manager));
   await expect(closeShift({shiftId:2,countedCash:"0",enforceCashGovernance:true},manager)).rejects.toThrow(/استدراك|تسوية/);
   await expect(withTx(tx=>reviewResolutionService.approveResolution(tx,{intentId},manager))).rejects.toThrow();
   await withTx(tx=>reviewResolutionService.approveResolution(tx,{intentId},approver));
   await withTx(tx=>reviewResolutionService.approveResolution(tx,{intentId},approver));
   await closeShift({shiftId:2,countedCash:"0",enforceCashGovernance:true},manager);
   const receipts=await db().select().from(s.receipts);
   expect(receipts.filter(r=>r.direction==="IN")).toHaveLength(1);
   expect(receipts.filter(r=>r.direction==="OUT")).toHaveLength(1);
   expect(receipts.find(r=>r.direction==="OUT")).toMatchObject({amount:"10000.00",cashBucket:"TREASURY"});
   expect((await db().select().from(digitalIntentSettlements))[0].collectionReceiptId).toBe(approved.adjustmentReceiptId);
   expect((await db().select().from(s.shifts).where(eq(s.shifts.id,1)))[0]).toEqual(closed);
   expect(await withTx(tx=>intentService.prepare(tx,input,actor))).toMatchObject({intentId,replay:true});
 });
 it("does not tombstone an admitted or unknown command, or an admissible command",async()=>{
   const f=await fixture("CASH");await db().update(s.shifts).set({shiftType:"RETAIL"}).where(eq(s.shifts.id,1));
   const input={...f.input,sourceType:"POS" as const,sourcePayload:undefined};
   await expect(withTx(tx=>intentService.prepare(tx,{...input,closeRejectedWithoutPayment:true},actor))).rejects.toThrow(/قابل للقبول/);
   expect(await db().select().from(s.digitalSaleIntents)).toHaveLength(0);
   const {intentId}=await withTx(tx=>intentService.prepare(tx,input,actor));
   await db().update(s.digitalSaleIntentItems).set({fulfillmentStatus:"UNKNOWN"});
   await db().update(s.digitalSaleIntents).set({status:"NEEDS_REVIEW"}).where(eq(s.digitalSaleIntents.id,intentId));
   expect(await withTx(tx=>intentService.prepare(tx,{...input,closeRejectedWithoutPayment:true},actor))).toMatchObject({intentId,replay:true});
   expect((await intentService.getIntent(db(),intentId,actor))?.noAdmissionClosed).toBe(false);
   expect((await db().select().from(s.digitalSaleIntentItems))[0].fulfillmentStatus).toBe("UNKNOWN");
 });
});


describe("historical terminal digital completion",()=>{
 it("finishes another digital return after a legacy terminal line without rewriting its quantity",async()=>{
   const f=await fixture("CASH","PRINT_POS",{cards:2});
   const {intentId}=await withTx(tx=>intentService.prepare(tx,{...f.input,customerId:1},actor));
   const pending=await db().select().from(s.digitalSaleIntentItems);
   for(const item of pending)await withTx(async tx=>{
     const claimToken="legacy-"+item.id;
     await intentService.claimExecution(tx,{intentId,intentItemId:item.id,claimToken},actor);
     await intentService.markExecution(tx,{intentId,intentItemId:item.id,claimToken,status:"SUCCESS",providerReference:item.providerReference!},actor);
   });
   const sale=await withTx(tx=>finalizeService.finalize(tx,{intentId,clientRequestId:f.input.clientRequestId,paymentMethod:"CASH",paymentAmount:"20000",customerId:1},actor));
   const details=await db().select().from(s.digitalSaleDetails).orderBy(s.digitalSaleDetails.id);
   const [goods]=await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.variantId,1));
   await db().insert(s.receipts).values({branchId:1,direction:"IN",amount:"30000",paymentMethod:"CASH",cashBucket:"TREASURY",status:"COMPLETED",createdBy:2});
   const digital=(detailId:number)=>withTx(tx=>reversalService.approveReversal(tx,{invoiceId:sale.invoiceId,detailIds:[detailId],reason:"إعادة الكرت المعتمد من المزود"},manager));
   await digital(details[0].id);
   const firstRefund=(await db().select().from(s.receipts).where(eq(s.receipts.direction,"OUT")))[0];
   await db().update(s.invoiceItems).set({returnedBaseQuantity:0}).where(eq(s.invoiceItems.id,details[0].invoiceItemId));
   await db().delete(s.auditLogs).where(eq(s.auditLogs.action,"invoice.return.roundingAllocation.v1"));
   await withTx(tx=>returnSaleInTx(tx,{invoiceId:sale.invoiceId,lines:[{invoiceItemId:goods.id,baseQuantity:1}],restock:true},manager));
   await digital(details[1].id);
   expect((await db().select().from(s.invoices))[0]).toMatchObject({status:"RETURNED",returnedTotal:"20000.00"});
   expect((await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.id,details[0].invoiceItemId)))[0].returnedBaseQuantity).toBe(0);
   expect((await db().select().from(s.receipts).where(eq(s.receipts.id,firstRefund.id)))[0]).toEqual(firstRefund);
   expect(await withTx(tx=>finalizeService.finalize(tx,{intentId,clientRequestId:f.input.clientRequestId,paymentMethod:"CASH",paymentAmount:"20000",customerId:1},actor))).toMatchObject({invoiceStatus:"RETURNED",returnedTotal:"20000.00"});
 });
});


describe("recovery shift lifecycle races",()=>{
 async function unbound(){
  const f=await fixture("CARD");const {closeShift}=await import("../shiftService");
  await closeShift({shiftId:1,countedCash:"0",enforceCashGovernance:true},actor);
  await db().insert(s.shifts).values({id:2,branchId:1,userId:2,status:"OPEN",shiftType:"RECEPTION",openingBalance:"0"});
  const {intentId}=await withTx(tx=>intentService.prepare(tx,{...f.input,capturedDigitalPayment:{confirmed:true,amount:"10100",deviceId:"reception-device"}},actor));
  const request={intentId,items:[],decision:"SETTLE_PARTIAL" as const,reason:"ربط القبض الأصلي بورديّة الاستدراك",
    settlement:{captureConfirmed:true as const,regularDisposition:"RELEASE" as const,refundMethod:"CARD" as const,recovery:{postingShiftId:2,reason:"إثبات الاستدراك قبل حجز رد البنك"}}};
  return {intentId,request,closeShift};
 }
 it("binding wins against close with an authority snapshot established before its commit",async()=>{
  const {request,closeShift}=await unbound();
  const {withOperationAuthority}=await import("../authorization/operationExecutionScope");
  let bound!:()=>void;let release!:()=>void;let authorityRead!:()=>void;
  const boundGate=new Promise<void>(resolve=>{bound=resolve;});
  const releaseGate=new Promise<void>(resolve=>{release=resolve;});
  const authorityGate=new Promise<void>(resolve=>{authorityRead=resolve;});
  const binding=withTx(async tx=>{await reviewResolutionService.requestResolution(tx,request,manager);bound();await releaseGate;});
  await boundGate;
  const closing=withOperationAuthority({actor:manager,path:"shifts.close",legacyAllowed:()=>true,assertCurrent:()=>authorityRead()},
    ()=>closeShift({shiftId:2,countedCash:"0",enforceCashGovernance:true},manager));
  const closeOutcome=closing.then(value=>({ok:true as const,value}),error=>({ok:false as const,error}));
  try {await authorityGate;} finally {release();}
  await binding;
  const outcome=await closeOutcome;
  expect(outcome.ok).toBe(false);
  if(!outcome.ok)expect(outcome.error).toMatchObject({code:"PRECONDITION_FAILED"});
  expect((await db().select().from(s.shifts).where(eq(s.shifts.id,2)))[0].status).toBe("OPEN");
  expect(await db().select().from(digitalIntentSettlements)).toHaveLength(1);
  expect(await db().select().from(s.receipts)).toHaveLength(0);
 });
 it("a close racing a pending binding cannot commit alongside that binding",async()=>{
  const {request,closeShift}=await unbound();
  const results=await Promise.allSettled([
    closeShift({shiftId:2,countedCash:"0",enforceCashGovernance:true},manager),
    withTx(tx=>reviewResolutionService.requestResolution(tx,request,manager)),
  ]);
  expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
  const [shift]=await db().select().from(s.shifts).where(eq(s.shifts.id,2));
  const allocations=await db().select().from(digitalIntentSettlements);
  if(shift.status==="CLOSED")expect(allocations).toHaveLength(0);
  else expect(allocations).toHaveLength(1);
  expect(await db().select().from(s.receipts)).toHaveLength(0);
  expect(await db().select().from(digitalRefundPayments)).toHaveLength(0);
 });
 it("busy recovery source rejects close immediately without waiting in reverse lock order",async()=>{
  const {intentId,request,closeShift}=await unbound();
  await withTx(tx=>reviewResolutionService.requestResolution(tx,request,manager));
  let locked!:()=>void;let release!:()=>void;
  const lockedGate=new Promise<void>(resolve=>{locked=resolve;});
  const releaseGate=new Promise<void>(resolve=>{release=resolve;});
  const holder=withTx(async tx=>{
    await tx.select({id:s.digitalSaleIntents.id}).from(s.digitalSaleIntents).where(eq(s.digitalSaleIntents.id,intentId)).for("update");
    locked();await releaseGate;
  });
  await lockedGate;
  try {
    await expect(closeShift({shiftId:2,countedCash:"0",enforceCashGovernance:true},manager)).rejects.toThrow(/تُحدّث حالياً/);
    expect((await db().select().from(s.shifts).where(eq(s.shifts.id,2)))[0].status).toBe("OPEN");
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    expect((await db().select().from(digitalIntentSettlements))[0].status).toBe("REQUESTED");
  } finally {release();await holder;}
 });
 it("does not scan or lock a busy recovery intent in another branch",async()=>{
  const {intentId,request,closeShift}=await unbound();
  await withTx(tx=>reviewResolutionService.requestResolution(tx,request,manager));
  await db().insert(s.branches).values({id:2,name:"Other",code:"OTHER",type:"SALES"});
  await db().insert(s.users).values({id:4,openId:"other-branch-manager",branchId:2,role:"manager"});
  await db().insert(s.shifts).values({id:3,branchId:2,userId:4,status:"OPEN",shiftType:"RETAIL",openingBalance:"0"});
  let locked!:()=>void;let release!:()=>void;
  const lockedGate=new Promise<void>(resolve=>{locked=resolve;});
  const releaseGate=new Promise<void>(resolve=>{release=resolve;});
  const holder=withTx(async tx=>{
    await tx.select({id:s.digitalSaleIntents.id}).from(s.digitalSaleIntents).where(eq(s.digitalSaleIntents.id,intentId)).for("update");
    locked();await releaseGate;
  });
  await lockedGate;
  try {
    await closeShift({shiftId:3,countedCash:"0",enforceCashGovernance:true},{userId:4,branchId:2,role:"manager"});
    expect((await db().select().from(s.shifts).where(eq(s.shifts.id,3)))[0].status).toBe("CLOSED");
  } finally {release();await holder;}
 });
 it("close winner refuses new binding and allows a different open recovery context",async()=>{
  const {request,closeShift}=await unbound();
  await closeShift({shiftId:2,countedCash:"0",enforceCashGovernance:true},manager);
  await expect(withTx(tx=>reviewResolutionService.requestResolution(tx,request,manager))).rejects.toThrow(/مفتوحة/);
  expect(await db().select().from(digitalIntentSettlements)).toHaveLength(0);
  await db().insert(s.shifts).values({id:3,branchId:1,userId:2,status:"OPEN",shiftType:"RECEPTION",openingBalance:"0"});
  await withTx(tx=>reviewResolutionService.requestResolution(tx,{...request,settlement:{...request.settlement,recovery:{...request.settlement.recovery,postingShiftId:3}}},manager));
  expect((await db().select().from(s.shifts).where(eq(s.shifts.id,2)))[0].status).toBe("CLOSED");
 });
});

describe("refund preview and current mixed-return state", () => {
  async function mixedSale(rounded = true, savedPlan = false) {
    const f = await fixture("CASH");
    await db().update(s.productPrices).set({ price: savedPlan ? "500.50" : "1001" });
    f.input.regularLines![0].quantity = savedPlan ? "2" : "1";
    f.input.sourcePayload = { ...f.input.sourcePayload as object, cashRoundIQD: rounded };
    const { intentId } = await withTx(tx => intentService.prepare(tx, { ...f.input, customerId: 1 }, actor));
    await execute(intentId);
    const sale = await withTx(tx => finalizeService.finalize(tx, { intentId, clientRequestId: f.input.clientRequestId,
      paymentMethod: "CASH", paymentAmount: rounded ? "11000" : "11001", customerId: 1 }, actor));
    const [detail] = await db().select().from(s.digitalSaleDetails);
    const [goods] = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.variantId, 1));
    await db().insert(s.receipts).values({ branchId: 1, direction: "IN", amount: "20000", paymentMethod: "CASH", cashBucket: "TREASURY", status: "COMPLETED", createdBy: 2 });
    const input = { invoiceId: sale.invoiceId, detailIds: [detail.id], reason: "إلغاء الكرت المؤكد من المزود" };
    const ordinary = (tx: Tx) => returnSaleInTx(tx, { invoiceId: sale.invoiceId, restock: true,
      lines: [{ invoiceItemId: goods.id, baseQuantity: 1 }] }, manager);
    const digital = (tx: Tx) => reversalService.approveReversal(tx, input, manager);
    if (savedPlan) await withTx(ordinary);
    return { ...sale, input, ordinary, digital };
  }

  async function financialState() {
    return {
      audit: await db().select().from(s.auditLogs).orderBy(s.auditLogs.id),
      invoices: await db().select().from(s.invoices),
      items: await db().select().from(s.invoiceItems),
      details: await db().select().from(s.digitalSaleDetails),
      refunds: await db().select().from(digitalRefundPayments),
      claims: await db().select().from(digitalRefundItems),
      receipts: await db().select().from(s.receipts),
      ledger: await db().select().from(s.accountingEntries),
      customers: await db().select().from(s.customers),
    };
  }

  it.each(["goods-first", "digital-first"])("keeps actual accountant READ previews nonpersisting: %s", async order => {
    const sale = await mixedSale();
    await db().insert(s.users).values({ id: 4, openId: "refund-read-accountant", name: "Accountant", role: "accountant", branchId: 1, isOwner: false });
    const [user] = await db().select().from(s.users).where(eq(s.users.id, 4));
    const api = reversalRouter.createCaller(callerContext(user));
    const before = await financialState();
    const preview = await api.reversible(sale.input);
    expect(preview[0].refundQuote).toMatchObject({ amount: "9999.09", originalMethod: "CASH" });
    expect(await api.reversible(sale.input)).toEqual(preview);
    expect(await financialState()).toEqual(before);
    await expect(api.approve({ ...sale.input, stage: "EXECUTE", refund: { method: "CASH" } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await withTx(async tx => { await (order === "goods-first" ? sale.ordinary(tx) : sale.digital(tx)); });
    const afterFirst = await financialState();
    expect(afterFirst.audit.filter(row => row.action === "invoice.return.roundingAllocation.v1")).toHaveLength(1);
    expect((await api.reversible(sale.input))[0].refundQuote?.amount).toBe("9999.09");
    expect((await api.reversible(sale.input))[0].refundQuote?.amount).toBe("9999.09");
    expect(await financialState()).toEqual(afterFirst);
    await withTx(async tx => { await (order === "goods-first" ? sale.digital(tx) : sale.ordinary(tx)); });
    await withTx(sale.digital);
    const final = await financialState();
    expect(final.audit.filter(row => row.action === "invoice.return.roundingAllocation.v1")).toEqual(
      afterFirst.audit.filter(row => row.action === "invoice.return.roundingAllocation.v1"));
    expect(final.receipts.filter(row => row.direction === "OUT")).toMatchObject([{ amount: "9999.09" }]);
    expect(final.invoices[0]).toMatchObject({ status: "RETURNED", returnedTotal: "11000.00", paidAmount: "1000.91" });
  });

  it.each([
    [false, false, "digital-last"], [true, false, "digital-last"], [true, true, "digital-last"],
    [false, false, "goods-last"], [true, false, "goods-last"], [true, true, "goods-last"],
  ] as const)("uses current state after a real authority snapshot: rounded=%s saved=%s %s", async (rounded, saved, order) => {
    const sale = await mixedSale(rounded, saved);
    let locked!: () => void;
    let authorityRead!: () => void;
    const lockedGate = new Promise<void>(resolve => { locked = resolve; });
    const authorityGate = new Promise<void>(resolve => { authorityRead = resolve; });
    const first = order === "digital-last" ? sale.ordinary : sale.digital;
    const last = order === "digital-last" ? sale.digital : sale.ordinary;
    // A runs the actual service and holds its invoice mutex through commit.
    // B's real loadOperationUserTx sees the pre-commit REPEATABLE READ snapshot.
    const firstReturn = withTx(async tx => {
      const result = await first(tx);
      locked();
      await authorityGate;
      return result;
    });
    await lockedGate;
    const lastReturn = withOperationAuthority({ actor: manager,
      path: order === "digital-last" ? "digitalCards.reversal.approve" : "returns.create",
      legacyAllowed: current => current.role === "manager" || current.role === "admin",
      assertCurrent: () => authorityRead() }, () => withTx(async tx => { await last(tx); }));
    const outcomes = await Promise.allSettled([firstReturn, lastReturn]);
    for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
    expect(outcomes.map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
    const final = await financialState();
    expect(final.invoices[0]).toMatchObject({ status: "RETURNED", returnedTotal: rounded ? "11000.00" : "11001.00",
      paidAmount: rounded ? "1000.91" : "1001.00" });
    expect(final.items.every(item => item.returnedBaseQuantity === item.baseQuantity)).toBe(true);
    expect(final.customers[0].currentBalance).toBe(rounded ? "-1000.91" : "-1001.00");
    expect(final.receipts.filter(row => row.direction === "OUT")).toMatchObject([{ amount: rounded ? "9999.09" : "10000.00" }]);
    expect(final.claims).toHaveLength(1);
    expect(final.claims[0].occurredAt).toBeInstanceOf(Date);
    const ledger = final.ledger.filter(row => row.invoiceId === sale.invoiceId);
    expect(toDbMoney(ledger.reduce((sum, row) => sum.plus(row.revenue ?? "0"), money(0)))).toBe("0.00");
    expect(toDbMoney(ledger.reduce((sum, row) => sum.plus(row.profit ?? "0"), money(0)))).toBe("0.00");
    expect(final.audit.filter(row => row.action === "invoice.return.roundingAllocation.v1")).toHaveLength(rounded ? 1 : 0);
    const movements = await db().select().from(s.inventoryMovements);
    expect(movements.every(row => row.variantId === 1)).toBe(true);
    await withTx(sale.digital);
    expect((await db().select().from(s.receipts)).filter(row => row.direction === "OUT")).toHaveLength(1);
  });
});
