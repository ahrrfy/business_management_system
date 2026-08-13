import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";

const TABLES = [
  "idempotencyKeys",
  "auditLogs",
  "accountingEntries",
  "deliveryOutbox",
  "deliveryEvents",
  "deliveryLedgerEntries",
  "deliveryRemittanceLines",
  "deliveryPartyMembers",
  "onlineOrders",
  "receipts",
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
    { id: 2, consignmentNumber: "CN-OLD-2", branchId: 1, partyId: 1, invoiceId: 2, workOrderId: 2, sourceType: "WORK_ORDER", sourceId: 2, endCustomerId: 1, codAmount: "0.00", collectedAmount: "0.00", parcelStatus: "DELIVERED", moneyStatus: "NOT_APPLICABLE", status: "DELIVERED", settledAt: new Date("2026-07-01T10:00:00Z") },
    { id: 3, consignmentNumber: "CN-OLD-3", branchId: 1, partyId: 1, invoiceId: 3, sourceType: "INVOICE", sourceId: 3, codAmount: "100.00", collectedAmount: "40.00", parcelStatus: "DELIVERED", moneyStatus: "PARTIAL", status: "PARTIAL", remittanceId: 1 },
    { id: 4, consignmentNumber: "CN-OLD-4", branchId: 1, partyId: 2, invoiceId: 4, sourceType: "INVOICE", sourceId: 4, codAmount: "50.00", collectedAmount: "0.00", parcelStatus: "ASSIGNED", moneyStatus: "UNSETTLED", status: "DISPATCHED" },
  ]);
  await d.insert(s.deliveryRemittanceLines).values({
    remittanceId: 1, consignmentId: 3, grossApplied: "40.00", cashReceived: "40.00", legacySnapshot: true,
  });
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
    expect(rows[0]).toMatchObject({
      sourceType: "WORK_ORDER",
      sourceId: 1,
      status: "DISPATCHED",
      parcelStatus: "ASSIGNED",
      moneyStatus: "UNSETTLED",
      courierDeliveredAt: null,
      partyId: 1,
    });
    expect(Number(first.consignmentId)).toBe(Number(rows[0].id));
    expect(String((await db().select().from(s.deliveryParties).where(eq(s.deliveryParties.id, 1)))[0].currentBalance)).toBe("0.00");
    expect((await db().select().from(s.deliveryLedgerEntries)).map((entry) => [entry.entryType, String(entry.amount)])).toEqual([["COD_ASSIGNED", "80.00"]]);
    expect((await db().select().from(s.deliveryEvents)).map((event) => event.eventType)).toEqual(["ASSIGNED"]);
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
    expect(row).toMatchObject({ status: "DELIVERED", parcelStatus: "DELIVERED", moneyStatus: "NOT_APPLICABLE" });
    expect(row.courierDeliveredAt?.toISOString()).toBe("2026-07-02T10:00:00.000Z");
    expect((await db().select().from(s.deliveryEvents)).map((event) => event.eventType)).toEqual(["DELIVERED"]);
    const audit = (await db().select().from(s.auditLogs)).find((item) => item.action === "delivery.legacy.prepaidProof");
    expect(audit?.newValue).toMatchObject({ evidenceRef: "سجل اتصال خدمة العملاء #184" });
  });

  it("PARTIAL ذات الرصيد المفتوح تبقى ماليةً كما هي وتُسجل مراجعتها مرة واحدة", async () => {
    const caller = adminCaller();
    await db().update(s.deliveryConsignments).set({ status: "DELIVERED", moneyStatus: "PARTIAL" }).where(eq(s.deliveryConsignments.id, 3));
    expect((await caller.deliveryLegacyRepair.report({})).partialOutstanding.map((row) => row.id)).toContain(3);
    const input = {
      action: "ACKNOWLEDGE_PARTIAL_OUTSTANDING" as const,
      targetId: 3,
      confirmation: "CN-OLD-3",
      note: "المتبقي مطلوب من الجهة ومثبت للمتابعة",
    };
    await caller.deliveryLegacyRepair.repair(input);
    expect((await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, 3)))[0]).toMatchObject({ status: "DELIVERED", moneyStatus: "PARTIAL", collectedAmount: "40.00" });
    expect((await caller.deliveryLegacyRepair.report({})).partialOutstanding[0].reviewedAt).not.toBeNull();
    expect((await caller.deliveryLegacyRepair.repair(input)).idempotentReplay).toBe(true);
    const audits = (await db().select().from(s.auditLogs)).filter((row) => row.action === "delivery.legacy.partialReviewed");
    expect(audits).toHaveLength(1);
    expect(audits[0].oldValue).toMatchObject({ status: "DELIVERED", moneyStatus: "PARTIAL", allocationLineCount: 1 });
  });

  it("تعرض PARTIAL ذات مؤشر توريد يتيم وتحظر الإقرار الآمن بدلاً من إخفائها", async () => {
    await db().delete(s.deliveryRemittanceLines).where(eq(s.deliveryRemittanceLines.consignmentId, 3));
    const caller = adminCaller();
    const finding = (await caller.deliveryLegacyRepair.report({})).partialOutstanding.find((row) => row.id === 3);
    expect(finding).toMatchObject({ remittanceId: 1, allocationLineCount: 0, remittanceTraceMissing: true, remainingAmount: "60.00" });
    await expect(caller.deliveryLegacyRepair.repair({
      action: "ACKNOWLEDGE_PARTIAL_OUTSTANDING", targetId: 3, confirmation: "CN-OLD-3",
      note: "لا يُعتمد بلا أثر توريد",
    })).rejects.toThrow(/أثر التوريد مفقود/);
    expect((await db().select().from(s.auditLogs)).filter((row) => row.action === "delivery.legacy.partialReviewed")).toHaveLength(0);
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
    expect((await db().select().from(s.deliveryPartyMembers)).map((member) => [Number(member.partyId), member.userId, member.memberRole, member.isActive])).toEqual([[2, 2, "MANAGER", true]]);
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

  it("يستبعد الطلب إذا كانت فاتورته مرتبطة بإرسالية، ولو فقدت الإرسالية workOrderId", async () => {
    await db().insert(s.invoices).values({
      id: 6, invoiceNumber: "INV-OLD-6", sourceType: "WORKORDER", sourceId: "WO-OLD-6",
      branchId: 1, customerId: 1, subtotal: "75.00", total: "75.00", paidAmount: "0.00", status: "PENDING",
    });
    await db().insert(s.workOrders).values({
      id: 6, orderNumber: "WO-OLD-6", branchId: 1, customerId: 1, title: "ربط فاتورة فقط",
      salePrice: "75.00", deposit: "0.00", hasDelivery: true, status: "DELIVERED", invoiceId: 6,
    });
    await db().insert(s.deliveryConsignments).values({
      consignmentNumber: "CN-OLD-6", branchId: 1, partyId: 1, invoiceId: 6,
      sourceType: "INVOICE", sourceId: 6, codAmount: "75.00", collectedAmount: "0.00",
      parcelStatus: "ASSIGNED", moneyStatus: "UNSETTLED", status: "DISPATCHED",
    });

    expect((await adminCaller().deliveryLegacyRepair.report({})).closedWithoutConsignment.map((row) => row.orderNumber)).not.toContain("WO-OLD-6");
    await expect(adminCaller().deliveryLegacyRepair.repair({
      action: "CREATE_MISSING_CONSIGNMENT", targetId: 6, confirmation: "WO-OLD-6",
      note: "اختبار منع الإرسالية المكررة", partyId: 1, deliveryFee: "5.00",
    })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("يرفض ترميم إرسالية لفاتورة مرتجعة", async () => {
    await db().insert(s.invoices).values({
      id: 6, invoiceNumber: "INV-RETURNED-6", sourceType: "WORKORDER", sourceId: "WO-RETURNED-6",
      branchId: 1, customerId: 1, subtotal: "75.00", total: "75.00", paidAmount: "75.00", status: "RETURNED",
    });
    await db().insert(s.workOrders).values({
      id: 6, orderNumber: "WO-RETURNED-6", branchId: 1, customerId: 1, title: "فاتورة مرتجعة",
      salePrice: "75.00", deposit: "75.00", hasDelivery: true, status: "DELIVERED", invoiceId: 6,
    });

    expect((await adminCaller().deliveryLegacyRepair.report({})).closedWithoutConsignment.map((row) => row.orderNumber)).not.toContain("WO-RETURNED-6");
    await expect(adminCaller().deliveryLegacyRepair.repair({
      action: "CREATE_MISSING_CONSIGNMENT", targetId: 6, confirmation: "WO-RETURNED-6",
      note: "يجب رفض الفاتورة المرتجعة", partyId: 1, deliveryFee: "5.00",
    })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("لا يرمم COUNTER بلا أمانة إيصال مساوية للأجرة", async () => {
    const caller = adminCaller();
    await db().update(s.workOrders).set({ deliveryFeeCollection: "COUNTER" }).where(eq(s.workOrders.id, 1));
    const input = {
      action: "CREATE_MISSING_CONSIGNMENT" as const, targetId: 1, confirmation: "WO-OLD-1",
      note: "مطابقة أمانة أجرة الاستقبال", partyId: 1, deliveryFee: "10.00",
    };
    await expect(caller.deliveryLegacyRepair.repair(input)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    await db().insert(s.receipts).values({
      workOrderId: 1, branchId: 1, direction: "IN", amount: "5.00", paymentMethod: "CASH",
      cashBucket: "DRAWER", status: "COMPLETED", referenceNumber: "DLV-FEE-WO-1", partyType: "OTHER", createdBy: 1,
    });
    await expect(caller.deliveryLegacyRepair.repair(input)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    await db().insert(s.receipts).values({
      workOrderId: 1, branchId: 1, direction: "IN", amount: "5.00", paymentMethod: "CASH",
      cashBucket: "DRAWER", status: "COMPLETED", referenceNumber: "DLV-FEE-WO-1", partyType: "OTHER", createdBy: 1,
    });
    await caller.deliveryLegacyRepair.repair(input);
    const row = (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.workOrderId, 1)))[0];
    expect(row).toMatchObject({ feeCollection: "COUNTER", deliveryFee: "10.00" });
  });

  it("يبقي ترميم COD=0 مفتوحاً حتى إثبات صريح ثم يسجل استحقاق الأجرة بقرار مستقل", async () => {
    await db().insert(s.invoices).values({
      id: 6, invoiceNumber: "INV-PREPAID-6", sourceType: "WORKORDER", sourceId: "WO-PREPAID-6",
      branchId: 1, customerId: 1, subtotal: "75.00", total: "75.00", paidAmount: "75.00", status: "PAID",
    });
    await db().insert(s.workOrders).values({
      id: 6, orderNumber: "WO-PREPAID-6", branchId: 1, customerId: 1, title: "مدفوع قديم",
      salePrice: "75.00", deposit: "75.00", hasDelivery: true, status: "DELIVERED", invoiceId: 6,
    });
    const caller = adminCaller();
    const created = await caller.deliveryLegacyRepair.repair({
      action: "CREATE_MISSING_CONSIGNMENT", targetId: 6, confirmation: "WO-PREPAID-6",
      note: "ترميم من سجل ورقي بلا تخمين تسليم", partyId: 1, deliveryFee: "5.00",
    });
    const consignmentId = Number(created.consignmentId);
    expect((await caller.deliveryLegacyRepair.report({})).prepaidClosedWithoutProof.map((row) => row.id)).toContain(consignmentId);
    expect((await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, consignmentId)))[0]).toMatchObject({
      status: "DISPATCHED", parcelStatus: "ASSIGNED", moneyStatus: "NOT_APPLICABLE", courierDeliveredAt: null,
    });

    const proofInput = {
      action: "RECORD_PREPAID_DELIVERY_PROOF", targetId: consignmentId,
      confirmation: String((await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, consignmentId)))[0].consignmentNumber),
      note: "إثبات تسليم مؤرخ من السجل", deliveredAt: "2026-07-02T10:00:00.000Z", evidenceRef: "POD-LEGACY-6",
    } as const;
    await expect(caller.deliveryLegacyRepair.repair(proofInput)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await caller.deliveryLegacyRepair.repair({ ...proofInput, feeSettlementAction: "EARN_ONLY" });
    expect((await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, consignmentId)))[0]).toMatchObject({
      status: "DELIVERED", parcelStatus: "DELIVERED", moneyStatus: "NOT_APPLICABLE",
    });
    expect((await db().select().from(s.deliveryLedgerEntries).where(eq(s.deliveryLedgerEntries.consignmentId, consignmentId))).map((entry) => [entry.entryType, String(entry.amount)])).toEqual([["FEE_EARNED", "5.00"]]);
    expect((await db().select().from(s.deliveryEvents).where(eq(s.deliveryEvents.consignmentId, consignmentId))).map((event) => event.eventType)).toEqual([
      "ASSIGNED", "DELIVERED",
    ]);
  });

  it("يستبعد الفاتورة ذات COD مملوك لجهة التوصيل ويرفض نقل ذمتها إلى العميل", async () => {
    await db().insert(s.deliveryConsignments).values({
      consignmentNumber: "CN-PARTY-COD-5", branchId: 1, partyId: 1, invoiceId: 5, workOrderId: 5,
      sourceType: "WORK_ORDER", sourceId: 5, endCustomerId: 1, codAmount: "100.00", collectedAmount: "0.00",
      parcelStatus: "DELIVERED", moneyStatus: "UNSETTLED", status: "DELIVERED",
    });
    expect((await adminCaller().deliveryLegacyRepair.report({})).invoicesMissingCustomer.map((row) => row.id)).not.toContain(5);
    await expect(adminCaller().deliveryLegacyRepair.repair({
      action: "RESTORE_INVOICE_CUSTOMER", targetId: 5, confirmation: "INV-OLD-5",
      note: "يجب إبقاء العهدة على جهة التوصيل", customerBalanceAction: "ADD_OUTSTANDING",
    })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await db().select().from(s.invoices).where(eq(s.invoices.id, 5)))[0].customerId).toBeNull();
  });

  it("يحسب طلبات المتجر SHIPPED ويستبعد الجهة ذات عضو بوابة نشط", async () => {
    await db().insert(s.users).values({
      id: 3, openId: "legacy-member", name: "عضو بوابة", role: "courier", loginMethod: "local", branchId: 1,
    });
    await db().insert(s.deliveryParties).values([
      { id: 3, partyType: "COMPANY", name: "Store only external", branchId: 1, currentBalance: "0.00" },
      { id: 4, partyType: "COMPANY", name: "Store with member", branchId: 1, currentBalance: "0.00" },
    ]);
    await db().insert(s.deliveryPartyMembers).values({ partyId: 4, userId: 3, memberRole: "MANAGER", isActive: true, createdBy: 1 });
    await db().insert(s.onlineOrders).values([
      { id: 1, orderNumber: "ON-SHIPPED-1", customerId: 1, branchId: 1, subtotal: "10.00", total: "10.00", status: "SHIPPED", deliveryPartyId: 3 },
      { id: 2, orderNumber: "ON-SHIPPED-2", customerId: 1, branchId: 1, subtotal: "20.00", total: "20.00", status: "SHIPPED", deliveryPartyId: 4 },
    ]);

    const caller = adminCaller();
    const report = await caller.deliveryLegacyRepair.report({});
    expect(report.openPartiesWithoutGateway.find((row) => row.id === 3)?.openCount).toBe(1);
    expect(report.openPartiesWithoutGateway.map((row) => row.id)).not.toContain(4);
    await caller.deliveryLegacyRepair.repair({
      action: "CONFIRM_EXTERNAL_WITHOUT_GATEWAY", targetId: 3, confirmation: "Store only external",
      note: "شركة خارجية تعمل بلا بوابة داخلية",
    });
    const audit = (await db().select().from(s.auditLogs)).find((row) => row.action === "delivery.legacy.externalGatewayConfirmed" && row.entityId === "3");
    expect(audit?.oldValue).toMatchObject({ openCount: 1, consignmentCount: 0, storeOrderCount: 1 });
  });

  it("لا يعيد صفاً أنشأه الإصلاح ثم صار RETURNED إلى DELIVERED", async () => {
    await db().insert(s.invoices).values({
      id: 6, invoiceNumber: "INV-REPAIR-RETURNED-6", sourceType: "WORKORDER", sourceId: "WO-REPAIR-RETURNED-6",
      branchId: 1, customerId: 1, subtotal: "75.00", total: "75.00", paidAmount: "75.00", status: "PAID",
    });
    await db().insert(s.workOrders).values({
      id: 6, orderNumber: "WO-REPAIR-RETURNED-6", branchId: 1, customerId: 1, title: "أعيد بعد الترميم",
      salePrice: "75.00", deposit: "75.00", hasDelivery: true, status: "DELIVERED", invoiceId: 6,
    });
    const caller = adminCaller();
    const created = await caller.deliveryLegacyRepair.repair({
      action: "CREATE_MISSING_CONSIGNMENT", targetId: 6, confirmation: "WO-REPAIR-RETURNED-6",
      note: "ترميم قبل اكتشاف الإرجاع", partyId: 1, deliveryFee: "0.00",
    });
    const id = Number(created.consignmentId);
    const number = String((await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, id)))[0].consignmentNumber);
    await db().update(s.deliveryConsignments).set({ parcelStatus: "RETURNED", status: "RETURNED" }).where(eq(s.deliveryConsignments.id, id));

    expect((await caller.deliveryLegacyRepair.report({})).prepaidClosedWithoutProof.map((row) => row.id)).not.toContain(id);
    await expect(caller.deliveryLegacyRepair.repair({
      action: "RECORD_PREPAID_DELIVERY_PROOF", targetId: id, confirmation: number,
      note: "لا يجوز قلب الإرجاع إلى تسليم", deliveredAt: "2026-07-02T10:00:00.000Z", evidenceRef: "POD-INVALID-6",
    })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("يرفض ربط بوابة بجهة معطلة حتى إعادة تفعيلها بقرار مستقل", async () => {
    await db().update(s.deliveryParties).set({ isActive: false }).where(eq(s.deliveryParties.id, 2));
    await expect(adminCaller().deliveryLegacyRepair.repair({
      action: "LINK_GATEWAY_ACCOUNT", targetId: 2, confirmation: "شركة خارجية",
      note: "لا يجوز إخفاء التعطيل بعضوية نشطة", gatewayUserId: 2,
    })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((await db().select().from(s.deliveryPartyMembers))).toHaveLength(0);
  });

  it("يعرض الجهة إذا كان ربط البوابة القديم أو العضوية يشيران إلى حساب معطل ويسمح باستبداله صراحة", async () => {
    await db().update(s.users).set({ isActive: false }).where(eq(s.users.id, 2));
    await db().update(s.deliveryParties).set({ userId: 2 }).where(eq(s.deliveryParties.id, 2));
    await db().insert(s.deliveryPartyMembers).values({ partyId: 1, userId: 2, memberRole: "DRIVER", isActive: true, createdBy: 1 });
    await db().insert(s.users).values({
      id: 3, openId: "replacement-courier", name: "مندوب بديل", role: "courier", loginMethod: "local", branchId: 1,
    });

    const caller = adminCaller();
    expect((await caller.deliveryLegacyRepair.report({})).openPartiesWithoutGateway.map((row) => row.id).sort()).toEqual([1, 2]);
    await caller.deliveryLegacyRepair.repair({
      action: "CONFIRM_EXTERNAL_WITHOUT_GATEWAY", targetId: 1, confirmation: "مندوب يدوي",
      note: "الحساب العضو معطل والجهة تعمل خارج البوابة",
    });
    await caller.deliveryLegacyRepair.repair({
      action: "CONFIRM_EXTERNAL_WITHOUT_GATEWAY", targetId: 2, confirmation: "شركة خارجية",
      note: "الرابط القديم معطل والجهة تعمل خارج البوابة",
    });
    const externalAudits = (await db().select().from(s.auditLogs)).filter((row) => row.action === "delivery.legacy.externalGatewayConfirmed");
    expect(externalAudits.find((row) => row.entityId === "1")?.oldValue).toMatchObject({
      userId: null,
      legacyGatewayValid: false,
      memberLinks: [{ userId: 2, membershipActive: true, userRole: "courier", userActive: false, validGatewayMember: false }],
    });
    expect(externalAudits.find((row) => row.entityId === "2")?.oldValue).toMatchObject({ userId: 2, legacyGatewayValid: false });
    await caller.deliveryLegacyRepair.repair({
      action: "LINK_GATEWAY_ACCOUNT", targetId: 2, confirmation: "شركة خارجية",
      note: "استبدال الحساب المعطل بحساب نشط مُسلّم للشركة", gatewayUserId: 3,
    });
    expect((await db().select().from(s.deliveryParties).where(eq(s.deliveryParties.id, 2)))[0].userId).toBe(3);
    expect((await db().select().from(s.auditLogs)).find((row) => row.action === "delivery.legacy.gatewayLinked")?.oldValue).toMatchObject({ userId: 2 });
  });

  it("يسجل القبض المباشر للأجرة فقط بقرار صريح ولطريقة COURIER", async () => {
    await db().update(s.deliveryConsignments).set({ deliveryFee: "7.00", feeCollection: "COURIER" }).where(eq(s.deliveryConsignments.id, 2));
    await adminCaller().deliveryLegacyRepair.repair({
      action: "RECORD_PREPAID_DELIVERY_PROOF", targetId: 2, confirmation: "CN-OLD-2",
      note: "السجل يثبت قبض المندوب المباشر", deliveredAt: "2026-07-02T10:00:00.000Z",
      evidenceRef: "POD-DIRECT-FEE-2", feeSettlementAction: "EARN_AND_DIRECT_PAID",
    });
    expect((await db().select().from(s.deliveryLedgerEntries).where(eq(s.deliveryLedgerEntries.consignmentId, 2))).map((entry) => [entry.entryType, String(entry.amount)])).toEqual([
      ["FEE_EARNED", "7.00"], ["FEE_PAID", "7.00"],
    ]);
    expect((await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, 2)))[0].feeSettledAt?.toISOString()).toBe("2026-07-02T10:00:00.000Z");
  });
});
