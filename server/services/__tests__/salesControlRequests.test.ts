import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createSale } from "../saleService";
import {
  approveSalesControlRequest,
  requestSalesControl,
} from "../sale/controlRequests";
import { ensureFinancialPostingGate } from "../reports/monthCloseGate";

const TABLES = [
  "salesExchangeCommands", "salesControlRequests", "returnRequests", "idempotencyKeys",
  "auditLogs", "accountingEntries", "receipts", "invoiceItems", "invoices",
  "inventoryMovements", "branchStock", "productPrices", "productUnits",
  "productVariants", "products", "shifts", "customers", "branches", "users",
];
const CASHIER = { userId: 2, branchId: 1, role: "cashier" };
const MANAGER = { userId: 1, branchId: 1, role: "manager" };
const ADMIN = { userId: 4, branchId: 0, role: "admin" };

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

beforeEach(async () => {
  const d = db();
  await d.transaction(async (tx) => {
    await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
    for (const table of TABLES) await tx.execute(sql.raw(`DELETE FROM \`${table}\``));
    await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  });
  await ensureFinancialPostingGate(d);
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values([
    { id: 1, openId: "m1", name: "مدير مستقل", email: "m1@s.test", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "c1", name: "بائع", email: "c1@s.test", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "m2", name: "مدير ثان", email: "m2@s.test", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 4, openId: "a1", name: "أدمن", email: "a1@s.test", role: "admin", loginMethod: "local", branchId: null },
  ]);
  await d.insert(s.customers).values({ id: 1, name: "عميل", phone: "+9647701111111", currentBalance: "0.00" });
  await d.insert(s.products).values({ id: 1, name: "دفتر" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "NB", costPrice: "400.00" });
  await d.insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true });
  await d.insert(s.productPrices).values({ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" });
  await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 100 });
  await d.insert(s.shifts).values([
    { id: 1, branchId: 1, userId: 2, openingBalance: "0", status: "OPEN" },
    { id: 2, branchId: 1, userId: 1, openingBalance: "10000", status: "OPEN" },
  ]);
});

async function sale() {
  return createSale({
    branchId: 1,
    shiftId: 1,
    sourceType: "POS",
    customerId: 1,
    lines: [{ variantId: 1, productUnitId: 1, quantity: "5" }],
    payment: { amount: "5000.00", method: "CASH" },
  }, CASHIER);
}

describe("حوكمة عمليات البيع الحرجة", () => {
  it("طلب الإلغاء صفري الأثر والاعتماد وحده ينفذه", async () => {
    const created = await sale();
    const stockBefore = Number((await db().select().from(s.branchStock).where(eq(s.branchStock.variantId, 1)))[0].quantity);
    const entriesBefore = (await db().select().from(s.accountingEntries)).length;
    const requested = await requestSalesControl({
      requestKey: "cancel-one",
      invoiceId: created.invoiceId,
      requestType: "SALES_CANCEL",
      reason: "أدخل البائع فاتورة مكررة",
      payload: { refundPaymentMethod: "CASH" },
    }, CASHIER);
    expect(requested.status).toBe("PENDING");
    expect((await db().select().from(s.accountingEntries)).length).toBe(entriesBefore);
    expect(Number((await db().select().from(s.branchStock).where(eq(s.branchStock.variantId, 1)))[0].quantity)).toBe(stockBefore);
    expect((await db().select().from(s.invoices).where(eq(s.invoices.id, created.invoiceId)))[0].status).toBe("PAID");

    await approveSalesControlRequest(Number(requested.id), MANAGER);
    expect((await db().select().from(s.invoices).where(eq(s.invoices.id, created.invoiceId)))[0].status).toBe("CANCELLED");
    expect(Number((await db().select().from(s.branchStock).where(eq(s.branchStock.variantId, 1)))[0].quantity)).toBe(100);
  });

  it("فصل المهام لا يملك استثناء admin ولا منشئ الفاتورة", async () => {
    const created = await sale();
    const request = await requestSalesControl({
      requestKey: "cancel-admin",
      invoiceId: created.invoiceId,
      requestType: "SALES_CANCEL",
      reason: "طلب رقابي",
      payload: { refundPaymentMethod: "CARD" },
    }, ADMIN);
    await expect(approveSalesControlRequest(Number(request.id), ADMIN)).rejects.toThrow(/لا تراجع طلبك/);

    const second = await sale();
    const creatorRequest = await requestSalesControl({
      requestKey: "cancel-creator",
      invoiceId: second.invoiceId,
      requestType: "SALES_CANCEL",
      reason: "طلب البائع",
      payload: { refundPaymentMethod: "CARD" },
    }, MANAGER);
    // نبدّل منشئ الفاتورة للمراجع إظهاراً لحارس منشئ المستند بصرف النظر عن الدور.
    await db().update(s.invoices).set({ createdBy: 4 }).where(eq(s.invoices.id, second.invoiceId));
    await expect(approveSalesControlRequest(Number(creatorRequest.id), ADMIN)).rejects.toThrow(/منشئ الفاتورة/);
  });

  it("تغيّر اللقطة يوسم الطلب STALE بلا تنفيذ", async () => {
    const created = await sale();
    const request = await requestSalesControl({
      requestKey: "stale-cancel",
      invoiceId: created.invoiceId,
      requestType: "SALES_CANCEL",
      reason: "طلب سيصبح قديماً",
      payload: { refundPaymentMethod: "CARD" },
    }, CASHIER);
    await db().update(s.invoices).set({ notes: "تعديل بعد الطلب", updatedAt: new Date(Date.now() + 1000) })
      .where(eq(s.invoices.id, created.invoiceId));
    await expect(approveSalesControlRequest(Number(request.id), MANAGER)).rejects.toThrow(/تغيّرت الفاتورة/);
    const stored = (await db().select().from(s.salesControlRequests).where(eq(s.salesControlRequests.id, Number(request.id))))[0];
    expect(stored.status).toBe("STALE");
    expect((await db().select().from(s.invoices).where(eq(s.invoices.id, created.invoiceId)))[0].status).toBe("PAID");
  });

  it("طلب تغيير تاريخ الاستحقاق صفري الأثر ولا يطبقه إلا اعتماد مستقل", async () => {
    const created = await sale();
    const request = await requestSalesControl({
      requestKey: "due-date-one",
      invoiceId: created.invoiceId,
      requestType: "SALES_DUE_DATE_CHANGE",
      reason: "تمديد الأجل باتفاق موثق مع العميل",
      payload: { dueDate: "2026-10-15" },
    }, CASHIER);
    const before = (await db().select().from(s.invoices).where(eq(s.invoices.id, created.invoiceId)))[0];
    expect(before.dueDate).toBeNull();

    await approveSalesControlRequest(Number(request.id), MANAGER);
    const after = (await db().select().from(s.invoices).where(eq(s.invoices.id, created.invoiceId)))[0];
    const appliedDueDate = after.dueDate instanceof Date
      ? after.dueDate.toISOString().slice(0, 10)
      : String(after.dueDate).slice(0, 10);
    expect(appliedDueDate).toBe("2026-10-15");
    const evidence = (
      await db().select().from(s.salesControlRequests)
        .where(eq(s.salesControlRequests.id, Number(request.id)))
    )[0];
    expect(evidence.status).toBe("APPROVED");
    expect(evidence.payloadHash).toHaveLength(64);
    expect(evidence.snapshotHash).toHaveLength(64);
  });

  it("الاستبدال يعكس الأصل ويصدر البديل ويسجل الفرق داخل اعتماد واحد", async () => {
    const created = await sale();
    const request = await requestSalesControl({
      requestKey: "exchange-one",
      invoiceId: created.invoiceId,
      requestType: "SALES_EXCHANGE",
      reason: "العميل استبدل الكمية",
      payload: {
        customerId: 1,
        lines: [{ variantId: 1, productUnitId: 1, quantity: "3" }],
        overpayHandling: "CREDIT",
      },
    }, CASHIER);
    const approved = await approveSalesControlRequest(Number(request.id), MANAGER);
    expect(approved.replayed).toBe(false);
    const original = (await db().select().from(s.invoices).where(eq(s.invoices.id, created.invoiceId)))[0];
    expect(original.status).toBe("SUPERSEDED");
    const commands = await db().select().from(s.salesExchangeCommands);
    expect(commands).toHaveLength(1);
    expect(commands[0].replacementInvoiceId).not.toBe(created.invoiceId);
    expect(commands[0].settlementKind).toBe("CUSTOMER_CREDIT");
    expect(commands[0].deltaAmount).toBe("2000.00");
  });
});
