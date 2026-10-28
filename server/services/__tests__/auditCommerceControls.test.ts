import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { createReservation } from "../reservations";
import * as conversion from "../reservations/convert";
import { cancelOutboundGift, createOutboundGift } from "../gifts/outbound";

const actor = { userId: 1, branchId: 1, role: "admin" as const };
const db = () => getDb()!;
const ctx = (user: unknown) => ({ req: { headers: {} }, res: { cookie() {}, clearCookie() {} }, user }) as any;
async function caller() {
  return appRouter.createCaller(ctx((await db().select().from(s.users).where(eq(s.users.id, 1)))[0]));
}
beforeEach(async () => {
  await db().insert(s.branches).values([{ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" }, { id: 2, name: "OTHER", code: "OTHER", type: "SALES" }]);
  await db().insert(s.users).values([{ id: 1, openId: "audit-commerce-admin", name: "admin", role: "admin", branchId: 1 }, { id: 2, openId: "audit-commerce-manager", name: "manager", role: "manager", branchId: 1 }]);
  await db().insert(s.customers).values({ id: 1, name: "older unique customer", creditLimit: null });
  await db().insert(s.products).values({ id: 1, name: "Audit paper" });
  await db().insert(s.productVariants).values({ id: 1, productId: 1, sku: "AUDIT-COMMERCE", costPrice: "100" });
  await db().insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "piece", conversionFactor: "1", isBaseUnit: true }, { id: 2, variantId: 1, unitName: "dozen", conversionFactor: "12", isBaseUnit: false }]);
  await db().insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "1000" }, { productUnitId: 2, priceTier: "RETAIL", price: "12000" }]);
  await db().insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 1000 });
});
async function reservation() {
  return createReservation({ branchId: 1, customerId: 1, contactPhone: "07701234567", lines: [{ variantId: 1, productUnitId: 2, quantity: 1, quotedUnitPrice: "12000" }] }, actor);
}
async function effects() {
  const tables = [s.invoices, s.receipts, s.inventoryMovements, s.accountingEntries];
  return Promise.all(tables.map(async (table) => Number((await db().select({ n: sql<number>`count(*)` }).from(table))[0].n)));
}
describe("audit commerce controls", () => {
  it("matches literal plan-ID searches without treating metacharacters as numeric wildcards", async () => {
    await db().insert(s.installmentPlans).values([
      { id: 1, branchId: 1, customerId: 1, totalAmount: "1000", createdBy: 1 },
      { id: 12, branchId: 1, customerId: 1, totalAmount: "1000", createdBy: 1 },
    ]);
    const api = await caller();
    expect((await api.installments.list({ branchId: 1, q: "1" })).rows.map((row) => row.id)).toEqual([12, 1]);
    for (const q of ["%", "_", "!"]) {
      expect((await api.installments.list({ branchId: 1, q })).rows).toEqual([]);
    }
  });
  it.each(["%", "_", "!"])("matches literal %s in customer names before pagination", async (token) => {
    const query = `literal-name-100${token}tail`;
    const decoy = token === "!" ? "literal-name-100!!tail" : "literal-name-100!xtail";
    await db().update(s.customers).set({ name: query }).where(eq(s.customers.id, 1));
    await db().insert(s.customers).values({ id: 2, name: decoy });
    await db().insert(s.installmentPlans).values([
      { id: 1, branchId: 1, customerId: 1, totalAmount: "1000", createdBy: 1 },
      { id: 2, branchId: 1, customerId: 2, totalAmount: "1000", createdBy: 1 },
      { id: 3, branchId: 2, customerId: 1, totalAmount: "1000", createdBy: 1 },
    ]);
    const result = await (await caller()).installments.list({ branchId: 1, q: query, limit: 1 });
    expect(result.rows.map((row) => row.id)).toEqual([1]);
    expect(result.hasMore).toBe(false);
  });
  it.each(["%", "_", "!"])("matches literal %s in historical check numbers before pagination", async (token) => {
    const query = `literal-check-100${token}tail`;
    const decoy = token === "!" ? "literal-check-100!!tail" : "literal-check-100!xtail";
    await db().insert(s.installmentPlans).values([
      { id: 1, branchId: 1, customerId: 1, totalAmount: "1000", createdBy: 1 },
      { id: 2, branchId: 1, customerId: 1, totalAmount: "1000", createdBy: 1 },
      { id: 3, branchId: 2, customerId: 1, totalAmount: "1000", createdBy: 1 },
    ]);
    await db().insert(s.installmentLines).values([
      { planId: 1, seq: 1, dueDate: "2026-12-01", amount: "1000", kind: "CHECK", checkNumber: query },
      { planId: 2, seq: 1, dueDate: "2026-12-01", amount: "1000", kind: "CHECK", checkNumber: decoy },
      { planId: 3, seq: 1, dueDate: "2026-12-01", amount: "1000", kind: "CHECK", checkNumber: query },
    ]);
    const result = await (await caller()).installments.list({ branchId: 1, q: query, limit: 1 });
    expect(result.rows.map((row) => row.id)).toEqual([1]);
    expect(result.hasMore).toBe(false);
  });
  it("COM09-02 filters the complete relation before bounded pages and preserves hasMore", async () => {
    await db().insert(s.installmentPlans).values(Array.from({ length: 203 }, (_, index) => ({ id: index + 1, branchId: index === 202 ? 2 : 1, customerId: 1, totalAmount: "1000", createdBy: 1, createdAt: new Date(index === 0 ? "2025-01-03T23:00:00Z" : "2026-10-28T00:00:00Z") })));
    const api = await caller();
    const oldest = await api.installments.list({ branchId: 1, from: "2025-01-03", to: "2025-01-03", q: "older", limit: 1 });
    expect(oldest.rows.map((r) => r.id)).toEqual([1]);
    expect(oldest.hasMore).toBe(false);
    const first = await api.installments.list({ branchId: 1, q: "older", limit: 200 });
    expect(first.rows).toHaveLength(200);
    expect(first.hasMore).toBe(true);
    const last = await api.installments.list({ branchId: 1, q: "older", limit: 200, offset: 200 });
    expect(last.rows.map((r) => r.id)).toEqual([2, 1]);
    expect(last.hasMore).toBe(false);
  });
  it.each(["0.00", "200.00"])("30-P2 rejects invalid percent %s without changing the promotion", async (discountPercent) => {
    const api = await caller();
    const { promotionId } = await api.salesPromotions.create({ name: "Audit", type: "PERCENT", discountPercent: "10", scope: "ALL", effectiveFrom: "2026-01-01" });
    await expect(api.salesPromotions.update({ promotionId, discountPercent })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await db().select().from(s.promotions).where(eq(s.promotions.id, promotionId)))[0].discountPercent).toBe("10.00");
  });
  it("COM21-01 replays a cancelled pending gift truthfully without inventory or ledger effects", async () => {
    const input = { branchId: 1, clientRequestId: randomUUID(), lines: [{ variantId: 1, productUnitId: 1, quantity: 600 }] };
    const maker = { userId: 2, branchId: 1, role: "manager" as const };
    const first = await createOutboundGift(input, maker);
    expect(first.status).toBe("PENDING_APPROVAL");
    await cancelOutboundGift(first.giftVoucherId, actor, "withdraw");
    const before = await effects();
    const replay = await createOutboundGift(input, maker);
    expect(replay).toMatchObject({ giftVoucherId: first.giftVoucherId, status: "CANCELLED", pending: false });
    expect(await effects()).toEqual(before);
  });
  it("COM19-02 recovers the original fulfilled conversion with identical payload", async () => {
    const r = await reservation();
    const input = { reservationId: r.reservationId, payment: null };
    const first = await conversion.convertReservationToSale(input, actor);
    const before = await effects();
    const replay = await conversion.convertReservationToSale(input, actor);
    expect(replay).toMatchObject({ invoiceId: first.invoiceId, total: first.total, idempotentReplay: true });
    expect(await effects()).toEqual(before);
    await expect(conversion.convertReservationToSale({ ...input, shiftId: null }, actor)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(conversion.convertReservationToSale(input, { userId: 2, branchId: 2, role: "manager" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("recovers concurrent matching conversions after waiting on the reservation lock", async () => {
    const r = await reservation();
    const input = { reservationId: r.reservationId, payment: null };
    const outcomes = await Promise.allSettled([
      conversion.convertReservationToSale(input, actor),
      conversion.convertReservationToSale(input, actor),
    ]);
    expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
    const results = outcomes.filter((outcome) => outcome.status === "fulfilled").map((outcome) => outcome.value);
    expect(new Set(results.map((result) => result.invoiceId)).size).toBe(1);
    expect((await db().select({ quantity: s.branchStock.quantity }).from(s.branchStock).where(and(eq(s.branchStock.branchId, 1), eq(s.branchStock.variantId, 1))))[0].quantity).toBe(988);
  });
  it("COM19-01 refuses a stale pricing confirmation before any committed sale effect", async () => {
    const r = await reservation();
    const before = await effects();
    await expect(conversion.convertReservationToSale({ reservationId: r.reservationId, payment: null, pricingConfirmation: { fingerprint: "0".repeat(64), total: "12000.00" } } as any, actor)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await effects()).toEqual(before);
    expect((await db().select().from(s.reservations).where(eq(s.reservations.id, r.reservationId)))[0].status).toBe("ACTIVE");
  });
  it("previews current base-unit prices and executes exactly the confirmed total", async () => {
    const r = await reservation();
    await db().update(s.productPrices).set({ price: "2000" }).where(eq(s.productPrices.productUnitId, 1));
    const api = await caller();
    const input = { reservationId: r.reservationId, payment: null };
    const preview = await api.reservations.previewConversion(input);
    expect(preview).toMatchObject({ total: "24000.00", referenceTotal: "12000.00", difference: "12000.00" });
    expect(preview.lines[0]).toMatchObject({ productUnitId: 1, unitName: "piece", baseQuantity: 12, unitPrice: "2000.00", lineTotal: "24000.00" });
    const confirmed = { ...input, pricingConfirmation: { fingerprint: preview.fingerprint, total: preview.total } };
    const executed = await api.reservations.convert(confirmed);
    expect(executed.total).toBe(preview.total);
    const before = await effects();
    expect(await api.reservations.convert(confirmed)).toMatchObject({ invoiceId: executed.invoiceId, idempotentReplay: true });
    expect(await effects()).toEqual(before);
    await expect(api.reservations.convert({ ...confirmed, payment: { amount: "1000", method: "TRANSFER", reference: "changed" } })).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("uses the current contract price and rejects subsequent contract or payment drift", async () => {
    const r = await reservation();
    await db().insert(s.customerContractPrices).values({ customerId: 1, productUnitId: 1, price: "900", createdBy: 1 });
    const input = { reservationId: r.reservationId, payment: null };
    const preview = await conversion.previewReservationConversion(input, actor);
    expect(preview.total).toBe("10800.00");
    const confirmed = { ...input, pricingConfirmation: { fingerprint: preview.fingerprint, total: preview.total } };
    const before = await effects();
    await expect(conversion.convertReservationToSale({ ...confirmed, payment: { amount: "100", method: "TRANSFER", reference: "new" } }, actor)).rejects.toMatchObject({ code: "CONFLICT" });
    await db().update(s.customerContractPrices).set({ price: "950" }).where(eq(s.customerContractPrices.customerId, 1));
    await expect(conversion.convertReservationToSale(confirmed, actor)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await effects()).toEqual(before);
  });
  it("rejects customer-credit and quantity drift without effects", async () => {
    const r = await reservation();
    const input = { reservationId: r.reservationId, payment: null };
    const preview = await conversion.previewReservationConversion(input, actor);
    const confirmed = { ...input, pricingConfirmation: { fingerprint: preview.fingerprint, total: preview.total } };
    const before = await effects();
    await db().update(s.customers).set({ creditLimit: "5000" }).where(eq(s.customers.id, 1));
    await expect(conversion.convertReservationToSale(confirmed, actor)).rejects.toMatchObject({ code: "CONFLICT" });
    await db().update(s.customers).set({ creditLimit: null }).where(eq(s.customers.id, 1));
    await db().update(s.reservationLines).set({ baseQuantity: 13 }).where(eq(s.reservationLines.reservationId, r.reservationId));
    await expect(conversion.convertReservationToSale(confirmed, actor)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await effects()).toEqual(before);
  });
  it("keeps promotion patch semantics, valid boundaries, type, dates and inactive state", async () => {
    const api = await caller();
    const { promotionId } = await api.salesPromotions.create({ name: "Original", type: "PERCENT", discountPercent: "10", scope: "ALL", effectiveFrom: "2026-01-01" });
    await api.salesPromotions.deactivate({ promotionId });
    await api.salesPromotions.update({ promotionId, discountPercent: "100", applicationMode: "COUPON", name: " Changed " });
    expect((await db().select().from(s.promotions).where(eq(s.promotions.id, promotionId)))[0]).toMatchObject({ discountPercent: "100.00", isActive: false, name: "Changed", applicationMode: "COUPON" });
    await expect(api.salesPromotions.update({ promotionId, discountAmount: "0" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(api.salesPromotions.update({ promotionId, effectiveTo: "2025-12-31" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const amount = await api.salesPromotions.create({ name: "Amount", type: "AMOUNT", discountAmount: "100", scope: "ALL", effectiveFrom: "2026-01-01" });
    await expect(api.salesPromotions.update({ promotionId: amount.promotionId, discountAmount: "0" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await api.salesPromotions.update({ promotionId: amount.promotionId, discountAmount: "200" });
  });
  it("replays a delivered gift without a second effect", async () => {
    const input = { branchId: 1, clientRequestId: randomUUID(), lines: [{ variantId: 1, productUnitId: 1, quantity: 1 }] };
    const first = await createOutboundGift(input, actor);
    const before = await effects();
    expect(await createOutboundGift(input, actor)).toMatchObject({ giftVoucherId: first.giftVoucherId, status: "DELIVERED", pending: false });
    expect(await effects()).toEqual(before);
  });
});
