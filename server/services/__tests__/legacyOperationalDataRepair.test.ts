import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";

const TABLES = [
  "idempotencyKeys",
  "auditLogs",
  "accountingEntries",
  "deliveryConsignments",
  "deliveryRemittances",
  "deliveryParties",
  "workOrders",
  "invoices",
  "customers",
  "users",
  "branches",
];

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

function adminCaller() {
  const ctx = {
    req: { headers: {}, ip: "127.0.0.1" },
    res: { cookie() {}, clearCookie() {} },
    user: { id: 1, role: "admin", branchId: 1, isOwner: true },
  } as never;
  return appRouter.createCaller(ctx);
}

async function seedFiveLegacyCases() {
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values([
    { id: 1, openId: "legacy-admin", name: "المدير", role: "admin", loginMethod: "local", branchId: 1, isOwner: true },
    { id: 2, openId: "legacy-courier", name: "مندوب البوابة", role: "courier", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.customers).values({ id: 1, name: "عميل قديم", currentBalance: "0.00" });
  await d.insert(s.deliveryParties).values([
    { id: 1, partyType: "INDIVIDUAL", name: "مندوب يدوي", branchId: 1, currentBalance: "0.00" },
    { id: 2, partyType: "COMPANY", name: "شركة خارجية", branchId: 1, currentBalance: "50.00" },
  ]);
  await d.insert(s.invoices).values([
    { id: 1, invoiceNumber: "INV-OLD-1", sourceType: "WORKORDER", sourceId: "WO-OLD-1", branchId: 1, customerId: 1, subtotal: "100.00", total: "100.00", paidAmount: "20.00", status: "PARTIALLY_PAID" },
    { id: 2, invoiceNumber: "INV-OLD-2", sourceType: "WORKORDER", sourceId: "WO-OLD-2", branchId: 1, customerId: 1, subtotal: "100.00", total: "100.00", paidAmount: "100.00", status: "PAID" },
    { id: 3, invoiceNumber: "INV-OLD-3", sourceType: "ORDER", sourceId: "LEG-3", branchId: 1, customerId: 1, subtotal: "100.00", total: "100.00", paidAmount: "40.00", status: "PARTIALLY_PAID" },
    { id: 4, invoiceNumber: "INV-OLD-4", sourceType: "ORDER", sourceId: "LEG-4", branchId: 1, customerId: 1, subtotal: "50.00", total: "50.00", paidAmount: "0.00", status: "PENDING" },
    { id: 5, invoiceNumber: "INV-OLD-5", sourceType: "WORKORDER", sourceId: "WO-OLD-5", branchId: 1, customerId: null, subtotal: "120.00", total: "120.00", paidAmount: "20.00", status: "PARTIALLY_PAID" },
  ]);
  await d.insert(s.workOrders).values([
    { id: 1, orderNumber: "WO-OLD-1", branchId: 1, customerId: 1, title: "مغلق بلا إرسالية", salePrice: "100.00", deposit: "20.00", hasDelivery: true, deliveryCost: "10.00", status: "DELIVERED", invoiceId: 1, deliveredAt: new Date("2026-07-01T09:00:00Z") },
    { id: 2, orderNumber: "WO-OLD-2", branchId: 1, customerId: 1, title: "مدفوع بلا إثبات", salePrice: "100.00", deposit: "100.00", hasDelivery: true, status: "DELIVERED", invoiceId: 2 },
    { id: 5, orderNumber: "WO-OLD-5", branchId: 1, customerId: 1, title: "فاتورة فقدت العميل", salePrice: "120.00", deposit: "20.00", hasDelivery: true, status: "DELIVERED", invoiceId: 5 },
  ]);
  await d.insert(s.deliveryRemittances).values({
    id: 1,
    remittanceNumber: "DR-OLD-1",
    branchId: 1,
    partyId: 1,
    collectedTotal: "40.00",
    feesTotal: "0.00",
    netRemitted: "40.00",
    shortfallTotal: "60.00",
    status: "SHORT",
    receivedBy: 1,
  });
  await d.insert(s.deliveryConsignments).values([
    { id: 2, consignmentNumber: "CN-OLD-2", branchId: 1, partyId: 1, invoiceId: 2, workOrderId: 2, endCustomerId: 1, codAmount: "0.00", collectedAmount: "0.00", status: "DELIVERED", settledAt: new Date("2026-07-01T10:00:00Z") },
    { id: 3, consignmentNumber: "CN-OLD-3", branchId: 1, partyId: 1, invoiceId: 3, codAmount: "100.00", collectedAmount: "40.00", status: "PARTIAL", remittanceId: 1 },
    { id: 4, consignmentNumber: "CN-OLD-4", branchId: 1, partyId: 2, invoiceId: 4, codAmount: "50.00", collectedAmount: "0.00", status: "DISPATCHED" },
  ]);
}

beforeEach(async () => {
  await reset();
  await seedFiveLegacyCases();
});

describe("أداة معالجة بيانات التوصيل القديمة", () => {
  it("تعرض الحالات الخمس قراءةً أولاً دون تغيير أي صف", async () => {
    const beforeAudit = await db().select().from(s.auditLogs);
    const report = await adminCaller().deliveryLegacyRepair.report({});
    // الحالة الخام قد تتقاطع مع حالةٍ أخرى (WO-OLD-5 بلا عميل وبلا إرسالية أيضاً)؛ التقرير
    // يعرض الحقيقة ولا يخفي الصف من عدسةٍ لأنه ظهر في عدسة ثانية.
    expect(report.closedWithoutConsignment.map((row) => row.orderNumber)).toEqual(["WO-OLD-5", "WO-OLD-1"]);
    expect(report.prepaidClosedWithoutProof.map((row) => row.consignmentNumber)).toEqual(["CN-OLD-2"]);
    expect(report.partialOutstanding.map((row) => [row.consignmentNumber, row.remainingAmount])).toEqual([["CN-OLD-3", "60.00"]]);
    expect(report.openPartiesWithoutGateway.map((row) => [row.name, row.openCount])).toEqual([
      ["مندوب يدوي", 1],
      ["شركة خارجية", 1],
    ]);
    expect(report.invoicesMissingCustomer.map((row) => [row.invoiceNumber, row.outstandingAmount])).toEqual([["INV-OLD-5", "100.00"]]);
    expect(await db().select().from(s.auditLogs)).toEqual(beforeAudit);
  });

  it("الطلب المغلق بلا إرسالية يتطلب اختيار جهة وتأكيد رقم الطلب، وينشئ DISPATCHED بلا إثبات وبلا تكرار", async () => {
    const caller = adminCaller();
    await expect(caller.deliveryLegacyRepair.repair({
      action: "CREATE_MISSING_CONSIGNMENT",
      targetId: 1,
      confirmation: "WO-خطأ",
      note: "مراجعة سجل التسليم القديم",
      partyId: 1,
      deliveryFee: "10.00",
    })).rejects.toThrow(/التأكيد غير مطابق/);
    expect((await db().select().from(s.deliveryConsignments)).filter((row) => Number(row.workOrderId) === 1)).toHaveLength(0);

    const input = {
      action: "CREATE_MISSING_CONSIGNMENT" as const,
      targetId: 1,
      confirmation: "WO-OLD-1",
      note: "اختير المندوب من سجل التسليم الورقي",
      partyId: 1,
      deliveryFee: "10.00",
    };
    const first = await caller.deliveryLegacyRepair.repair(input);
    const second = await caller.deliveryLegacyRepair.repair(input);
    expect(second.idempotentReplay).toBe(true);
    const rows = (await db().select().from(s.deliveryConsignments)).filter((row) => Number(row.workOrderId) === 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "DISPATCHED", courierDeliveredAt: null, partyId: 1 });
    expect(Number(first.consignmentId)).toBe(Number(rows[0].id));
    expect(String((await db().select().from(s.deliveryParties).where(eq(s.deliveryParties.id, 1)))[0].currentBalance)).toBe("80.00");
    const audit = (await db().select().from(s.auditLogs)).filter((row) => row.action === "delivery.legacy.createConsignment");
    expect(audit).toHaveLength(1);
  });

  it("COD=0 المغلقة لا تقبل ختم تسليم بلا وقت ومرجع صريحين، ثم تحفظ الإثبات المدخل", async () => {
    const caller = adminCaller();
    await expect(caller.deliveryLegacyRepair.repair({
      action: "RECORD_PREPAID_DELIVERY_PROOF",
      targetId: 2,
      confirmation: "CN-OLD-2",
      note: "أكد العميل الاستلام هاتفياً",
      deliveredAt: "2026-07-02T10:00:00.000Z",
    })).rejects.toThrow(/مرجع إثبات/);
    expect((await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, 2)))[0].courierDeliveredAt).toBeNull();

    await caller.deliveryLegacyRepair.repair({
      action: "RECORD_PREPAID_DELIVERY_PROOF",
      targetId: 2,
      confirmation: "CN-OLD-2",
      note: "أكد العميل الاستلام هاتفياً",
      deliveredAt: "2026-07-02T10:00:00.000Z",
      evidenceRef: "سجل اتصال خدمة العملاء #184",
    });
    const row = (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, 2)))[0];
    expect(row.status).toBe("DELIVERED");
    expect(row.courierDeliveredAt?.toISOString()).toBe("2026-07-02T10:00:00.000Z");
    const audit = (await db().select().from(s.auditLogs)).find((item) => item.action === "delivery.legacy.prepaidProof");
    expect(audit?.newValue).toMatchObject({ evidenceRef: "سجل اتصال خدمة العملاء #184" });
  });

  it("PARTIAL ذات الرصيد المفتوح تبقى ماليةً كما هي وتُسجل مراجعتها مرة واحدة", async () => {
    const caller = adminCaller();
    const input = {
      action: "ACKNOWLEDGE_PARTIAL_OUTSTANDING" as const,
      targetId: 3,
      confirmation: "CN-OLD-3",
      note: "المتبقي مطلوب من الجهة ومثبت للمتابعة",
    };
    await caller.deliveryLegacyRepair.repair(input);
    expect((await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, 3)))[0]).toMatchObject({ status: "PARTIAL", collectedAmount: "40.00" });
    expect((await caller.deliveryLegacyRepair.report({})).partialOutstanding[0].reviewedAt).not.toBeNull();
    expect((await caller.deliveryLegacyRepair.repair(input)).idempotentReplay).toBe(true);
    expect((await db().select().from(s.auditLogs)).filter((row) => row.action === "delivery.legacy.partialReviewed")).toHaveLength(1);
  });

  it("الجهة بلا بوابة لا تُربط تخميناً: يلزم حساب صريح، ثم يظهر الربط في التدقيق", async () => {
    const caller = adminCaller();
    await expect(caller.deliveryLegacyRepair.repair({
      action: "LINK_GATEWAY_ACCOUNT",
      targetId: 2,
      confirmation: "شركة خارجية",
      note: "الحساب مسلّم لمسؤول الشركة",
    })).rejects.toThrow(/اختر حساب البوابة/);
    await caller.deliveryLegacyRepair.repair({
      action: "LINK_GATEWAY_ACCOUNT",
      targetId: 2,
      confirmation: "شركة خارجية",
      note: "الحساب مسلّم لمسؤول الشركة",
      gatewayUserId: 2,
    });
    expect((await db().select().from(s.deliveryParties).where(eq(s.deliveryParties.id, 2)))[0].userId).toBe(2);
    expect((await db().select().from(s.auditLogs)).find((row) => row.action === "delivery.legacy.gatewayLinked")?.newValue).toMatchObject({ userId: 2 });
  });

  it("الفاتورة التي فقدت customerId تستعيد عميل أمر الشغل وتضيف المتبقي الحي مرة واحدة", async () => {
    const caller = adminCaller();
    await expect(caller.deliveryLegacyRepair.repair({
      action: "RESTORE_INVOICE_CUSTOMER",
      targetId: 5,
      confirmation: "INV-OLD-5",
      note: "مطابقة هوية العميل مع أمر الشغل الأصلي",
    })).rejects.toThrow(/حدّد صراحةً/);
    const input = {
      action: "RESTORE_INVOICE_CUSTOMER" as const,
      targetId: 5,
      confirmation: "INV-OLD-5",
      note: "مطابقة هوية العميل مع أمر الشغل الأصلي",
      customerBalanceAction: "ADD_OUTSTANDING" as const,
    };
    const first = await caller.deliveryLegacyRepair.repair(input);
    expect(first).toMatchObject({ customerId: 1, outstandingObserved: "100.00", outstandingAdded: "100.00" });
    expect((await db().select().from(s.invoices).where(eq(s.invoices.id, 5)))[0].customerId).toBe(1);
    expect(String((await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0].currentBalance)).toBe("100.00");
    expect((await caller.deliveryLegacyRepair.repair(input)).idempotentReplay).toBe(true);
    expect(String((await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0].currentBalance)).toBe("100.00");
    expect((await db().select().from(s.auditLogs)).filter((row) => row.action === "delivery.legacy.invoiceCustomerRestored")).toHaveLength(1);
  });
});
