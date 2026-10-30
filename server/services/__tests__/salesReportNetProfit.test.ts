import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import type { TrpcContext } from "../../context";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { money, toDbMoney } from "../money";
import { createSale } from "../saleService";
import { returnSale } from "../returnService";
import { truncateAllTables } from "./__testUtils__";
import { createWorkOrder, startWorkOrder, markWorkOrderReady, deliverWorkOrder } from "../workOrderService";
import { requestWorkOrderDesignApproval, decideWorkOrderDesignApproval } from "../workOrder/designApproval";

const actor = { userId: 1, branchId: 1, role: "admin" as const };
const db = () => getDb()!;
const caller = (role = "admin") => appRouter.createCaller({
  req: { headers: {} }, res: {},
  user: { id: 1, role, branchId: 1, isActive: true },
} as TrpcContext);

beforeEach(async () => {
  await truncateAllTables();
  await db().insert(s.branches).values({ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values({ id: 1, openId: "net-report-owner", role: "admin", branchId: 1, isOwner: true });
  await db().insert(s.products).values({ id: 1, name: "Report item" });
  await db().insert(s.productVariants).values({ id: 1, productId: 1, sku: "NET-1", costPrice: "60000" });
  await db().insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true });
  await db().insert(s.productPrices).values({ productUnitId: 1, priceTier: "RETAIL", price: "100000" });
  await db().insert(s.branchStock).values({ branchId: 1, variantId: 1, quantity: 20 });
  await db().insert(s.customers).values({ id: 1, name: "Credit customer", currentBalance: "0", creditLimit: null });
});

async function sale() {
  const result = await createSale({ branchId: 1, customerId: 1, sourceType: "ORDER", clientRequestId: randomUUID(),
    lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }] }, actor);
  const [item] = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, result.invoiceId));
  return { invoiceId: result.invoiceId, itemId: item!.id };
}

async function ledger(invoiceId: number) {
  const entries = await db().select().from(s.accountingEntries).where(sql`${s.accountingEntries.invoiceId}=${invoiceId} AND ${s.accountingEntries.entryType} IN ('SALE','RETURN')`);
  const sum = (field: "revenue" | "cost" | "profit") => toDbMoney(entries.reduce((acc, e) => acc.plus(money(e[field])), money(0)));
  return { netRevenue: sum("revenue"), netCOGS: sum("cost"), profit: sum("profit") };
}

it.each([true, false])("actual invoice report matches posted COGS after a full return (restock=%s)", async restock => {
  const { invoiceId, itemId } = await sale();
  await returnSale({ invoiceId, lines: [{ invoiceItemId: itemId, baseQuantity: 1 }], restock, refund: null,
    operatorReason: "report full return acceptance" }, actor);
  const expected = { netRevenue: "0.00", netCOGS: restock ? "0.00" : "60000.00", profit: restock ? "0.00" : "-60000.00" };
  expect(await ledger(invoiceId)).toEqual(expected);
  const report = await caller().reports.salesReport({});
  expect(report.rows).toHaveLength(1);
  expect(report.rows[0]).toMatchObject({ id: invoiceId, costTotal: "60000.00", ...expected });
});

it("active sale uses frozen issue cost after the current catalogue cost changes", async () => {
  const { invoiceId } = await sale();
  await db().update(s.productVariants).set({ costPrice: "90000" }).where(eq(s.productVariants.id, 1));
  expect((await caller().reports.salesReport({})).rows[0]).toMatchObject({ id: invoiceId, ...(await ledger(invoiceId)),
    netRevenue: "100000.00", netCOGS: "60000.00", profit: "40000.00" });
});

it("report authority without cost visibility never returns original cost, net cost or profit", async () => {
  const { invoiceId } = await sale();
  expect((await caller("auditor").reports.salesReport({})).rows[0]).toMatchObject({
    id: invoiceId, netRevenue: "100000.00", costTotal: null, netCOGS: null, profit: null,
  });
});

it("native taxed, delivered and cash-rounded sale excludes tax/rounding and retains delivery revenue", async () => {
  await db().update(s.productPrices).set({ price: "100010" }).where(eq(s.productPrices.productUnitId, 1));
  await db().insert(s.shifts).values({ id: 1, userId: 1, branchId: 1, status: "OPEN", openGuard: "1:1", openingBalance: "0" });
  const result = await createSale({ branchId: 1, shiftId: 1, customerId: 1, sourceType: "POS", deliveryFee: "17", taxRatePercent: "10",
    cashRoundIQD: true, payment: { amount: "200000", method: "CASH" },
    lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }] }, actor);
  const [saved] = await db().select().from(s.invoices).where(eq(s.invoices.id, result.invoiceId));
  expect(saved!.taxAmount).not.toBe("0.00"); expect(saved!.cashRoundingAdjustment).not.toBe("0.00");
  const report = await caller().reports.salesReport({});
  expect(report.rows[0]).toMatchObject({ id: result.invoiceId, netRevenue: "100027.00", netCOGS: "60000.00", profit: "40027.00" });
  expect(report.rows[0]).toMatchObject(await ledger(result.invoiceId));
});

it("repeated native partial returns preserve cumulative cents from a legacy frozen line cost", async () => {
  // Supported imported source: saved 1.00 issue cost over three units, not today's catalogue.
  const [inserted] = await db().insert(s.invoices).values({ invoiceNumber: `LEGACY-${randomUUID()}`, sourceType: "ORDER", branchId: 1,
    customerId: 1, subtotal: "3.00", total: "3.00", costTotal: "1.00", paidAmount: "0", status: "PENDING" });
  const invoiceId = inserted.insertId;
  const [item] = await db().insert(s.invoiceItems).values({ invoiceId, variantId: 1, productUnitId: 1, quantity: "3", baseQuantity: 3,
    unitPrice: "1.00", total: "3.00", unitCost: "0.33", lineCost: "1.00" });
  await db().insert(s.accountingEntries).values({ entryType: "SALE", invoiceId, branchId: 1, createdBy: 1, entryDate: new Date(),
    amount: "3.00", revenue: "3.00", cost: "1.00", profit: "2.00", dedupeKey: `SALE:${invoiceId}` });
  await db().update(s.customers).set({ currentBalance: "3.00" }).where(eq(s.customers.id, 1));
  for (const expected of [{ netRevenue: "2.00", netCOGS: "0.67", profit: "1.33" },
    { netRevenue: "1.00", netCOGS: "0.33", profit: "0.67" }, { netRevenue: "0.00", netCOGS: "0.00", profit: "0.00" }]) {
    await returnSale({ invoiceId, lines: [{ invoiceItemId: item.insertId, baseQuantity: 1 }], restock: true, refund: null,
      operatorReason: "legacy cumulative-cent return acceptance" }, actor);
    expect(await ledger(invoiceId)).toEqual(expected);
    expect((await caller().reports.salesReport({})).rows[0]).toMatchObject({ id: invoiceId, costTotal: "1.00", ...expected });
  }
});

it("native work-order COGS follows its ledger and does not capitalize quoted labour", async () => {
  await db().insert(s.users).values({ id: 2, openId: "net-report-checker", role: "manager", branchId: 1, isOwner: true });
  await db().insert(s.serviceTypes).values({ name: "موافقة تصميم", defaultKind: "SERVICE_REQUEST", defaultPriority: "HIGH", slaHours: 24,
    blocksExecution: true, isActive: true });
  const order = await createWorkOrder({ branchId: 1, baseVariantId: 1, customerId: 1, title: "Report work order", salePrice: "100000",
    laborCost: "12", deposit: "0" }, actor);
  const requested = await requestWorkOrderDesignApproval({ workOrderId: order.workOrderId, requestKey: randomUUID(), note: "تصميم الاختبار" }, actor);
  await decideWorkOrderDesignApproval({ approvalId: requested.approval.id, decisionKey: randomUUID(), decision: "APPROVED", reason: "وافق العميل على التصميم",
    evidence: { type: "WHATSAPP_MESSAGE", reference: `wamid.${randomUUID()}` } }, { userId: 2, branchId: 1, role: "manager" });
  await startWorkOrder(order.workOrderId, actor); await markWorkOrderReady(order.workOrderId, actor);
  await deliverWorkOrder({ workOrderId: order.workOrderId }, actor);
  const [saved] = await db().select().from(s.workOrders).where(eq(s.workOrders.id, order.workOrderId));
  expect(saved!.invoiceId).toBeTruthy();
  const expected = await ledger(saved!.invoiceId!);
  expect(expected).toEqual({ netRevenue: "100000.00", netCOGS: "60000.00", profit: "40000.00" });
  expect((await caller().reports.salesReport({})).rows[0]).toMatchObject({ id: saved!.invoiceId, costTotal: "60012.00", ...expected });
});
