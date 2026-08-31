/**
 * ظهور الفواتير — البحث والبوّابة (بلاغ المالك ١٨/٨).
 *
 * ثلاثة أعراض مستقلّة أثبتها الفحص، كلٌّ منها كافٍ وحده لإفراغ الشاشة:
 *  ① **البحث**: كان يطابق رقم الفاتورة واسم العميل فقط. ورقمُ أمر الشغل هو ما بيد الزبون
 *    وعلى باركود التذكرة (`WO-…`) بينما الفاتورة تُرقَّم `INV-…` ⇒ مسحُ التذكرة في شاشة
 *    الفواتير كان يعيد «لا فواتير مطابقة» **حتماً**، ولو كانت الفاتورة أمام عينيه.
 *  ② **بوّابة القائمة**: `sales.list` كان على `salesReadProcedure` وحده ⇒ كاشير الطباعة
 *    وفنّي المطبعة (`sales:NONE`) يتلقّون ٤٠٣ — بينما البوّابة المزدوجة كانت مطبَّقةً على
 *    المستند المفرد منذ زمن. الآن القائمة والمستند على نفس المفردة، بنطاقٍ يقصّ القناة.
 *  ③ **عزل القناة**: نطاق الاستقبال/الطباعة يرى فواتير محطّته وحدها — لا بابَ على التجزئة.
 */
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { resolvePermissions, SECTION_CASHIER_ROLES } from "@shared/permissions";
import * as s from "../../../drizzle/schema";
import { resolveCustomRole } from "../../context";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { openShift } from "../shiftService";
import { checkoutReception } from "../receptionCheckoutService";
import { createSale } from "../saleService";
import {
  decideWorkOrderDesignApproval,
  requestWorkOrderDesignApproval,
} from "../workOrder/designApproval";

const TABLES = [
  "orderPayments", "auditLogs", "idempotencyKeys", "accountingEntries", "receipts",
  "workOrderEvents", "workOrderDesignApprovals", "workOrderDesignRevisions", "serviceTypes",
  "workOrderMaterials", "workOrders", "invoiceItems", "invoices",
  "inventoryMovements", "branchStock", "productPrices", "productUnits", "productVariants",
  "products", "shifts", "customers", "branches", "users", "roles",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}
async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}
async function seed() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: 1, openId: "mgr", name: "مدير", email: "m@t.test", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "rc1", name: "موظف استقبال", email: "r1@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "rt1", name: "كاشير تجزئة", email: "t1@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.serviceTypes).values({
    name: "موافقة تصميم",
    defaultKind: "SERVICE_REQUEST",
    defaultPriority: "HIGH",
    slaHours: 24,
    blocksExecution: true,
    isActive: true,
  });
  await d.insert(s.customers).values([
    { id: 1, name: "عميل موثوق", phone: "+9647701234567", currentBalance: "0.00", creditLimit: null },
  ]);
  await d.insert(s.products).values([{ id: 1, name: "دفتر" }]);
  await d.insert(s.productVariants).values([{ id: 1, productId: 1, sku: "NB-1", costPrice: "500.00" }]);
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: 1, isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" }]);
  await d.insert(s.branchStock).values([{ variantId: 1, branchId: 1, quantity: 500 }]);
  // أدوار الأقسام المبذورة — نحتاج `reception_clerk` و`print_cashier` بخرائطهما الحقيقية.
  for (const role of SECTION_CASHIER_ROLES) {
    await d.insert(s.roles).values({
      key: role.key, label: role.label, baseRole: role.baseRole,
      permissions: role.permissions as never, station: role.station as never, isActive: true,
    });
  }
}

/** سياق tRPC بمستخدمٍ حقيقيّ الخريطة (كما يبنيه server/context.ts). */
async function callerFor(userId: number, roleKey?: string, baseRole: string = "cashier") {
  const custom = roleKey ? await resolveCustomRole(roleKey) : null;
  const user = {
    id: userId,
    branchId: 1,
    role: (custom?.baseRole ?? baseRole) as never,
    permissionsOverride: custom
      ? (resolvePermissions(custom.baseRole as never, custom.permissions as never) as never)
      : null,
    isOwner: false,
  };
  return appRouter.createCaller({
    req: { headers: {}, ip: "127.0.0.1", socket: { remoteAddress: "127.0.0.1" } },
    res: { cookie() {}, clearCookie() {} },
    user,
    sessionId: null,
  } as never);
}

const openReception = (userId: number) =>
  openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId, branchId: 1 });

/** طلبُ خدمةٍ يُسلَّم فتُنشأ فاتورته — الحالة التي كان رقمها غير قابل للعثور عليه. */
async function receptionWorkOrderInvoice() {
  const shift = await openReception(2);
  const r = await checkoutReception({
    branchId: 1, shiftId: shift.shiftId, customerId: 1,
    paymentMethod: "CASH", paidAmount: "5000", clientRequestId: "vis-wo",
    workOrders: [{ title: "تخصيص", quantity: 1, salePrice: "5000.00", materials: [] }],
  }, { userId: 2, branchId: 1, role: "cashier" });
  const woId = r.workOrders[0].workOrderId;
  const wo = (await db().select().from(s.workOrders).where(eq(s.workOrders.id, woId)))[0];
  const approval = await requestWorkOrderDesignApproval({
    workOrderId: woId,
    requestKey: `invoice-visibility-design-request:${randomUUID()}`,
    note: "اعتماد النسخة الحالية قبل التنفيذ والتسليم",
  }, { userId: 2, branchId: 1, role: "cashier" });
  await decideWorkOrderDesignApproval({
    approvalId: Number(approval.approval.id),
    decisionKey: `invoice-visibility-design-decision:${randomUUID()}`,
    decision: "APPROVED",
    reason: "ثبتت موافقة العميل على النسخة الحالية",
    evidence: { type: "WHATSAPP_MESSAGE", reference: `wamid.invoice-visibility.${randomUUID()}` },
  }, { userId: 1, branchId: 1, role: "manager" });
  const caller = await callerFor(2);
  await caller.workOrders.start({ workOrderId: woId });
  await caller.workOrders.markReady({ workOrderId: woId });
  const delivered = await caller.workOrders.deliver({ workOrderId: woId });
  return { orderNumber: wo.orderNumber, invoiceId: delivered.invoiceId as number, shiftId: shift.shiftId };
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("ظهور الفواتير — البحث برقم أمر الشغل", () => {
  it("البحث برقم أمر الشغل يجد فاتورة تسليمه (كان يعيد صفر نتائج حتماً)", async () => {
    const { orderNumber, invoiceId } = await receptionWorkOrderInvoice();
    const caller = await callerFor(1, undefined, "manager");

    const rows = await caller.sales.list({ q: orderNumber, limit: 50 });
    expect(rows.map((r: { id: number }) => Number(r.id))).toContain(invoiceId);

    // والمجاميع تطابق القائمة بالبناء (نفس دالّة الشروط) — لا رقمٌ يخالف جدولَه.
    const summary = await caller.sales.listSummary({ q: orderNumber });
    expect(Number(summary.count)).toBe(1);
  });

  it("رقمٌ لا يخصّ أحداً ⇒ صفر نتائج (البحث لم يصر فضفاضاً)", async () => {
    await receptionWorkOrderInvoice();
    const caller = await callerFor(1, undefined, "manager");
    expect(await caller.sales.list({ q: "WO-9-29990101-99999", limit: 50 })).toHaveLength(0);
  });
});

describe("ظهور الفواتير — بوّابة القائمة ونطاق القناة", () => {
  it("كاشير الطباعة (sales:NONE) يفتح القائمة بعد أن كان يتلقّى ٤٠٣", async () => {
    const caller = await callerFor(2, "print_cashier");
    await expect(caller.sales.list({ limit: 10 })).resolves.toBeInstanceOf(Array);
  });

  it("نطاق الاستقبال يرى فاتورة محطّته ولا يرى فاتورة التجزئة", async () => {
    const { invoiceId } = await receptionWorkOrderInvoice();
    // فاتورة تجزئة على وردية RETAIL لموظفٍ آخر.
    const retail = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RETAIL" }, { userId: 3, branchId: 1 });
    const retailSale = await createSale({
      branchId: 1, shiftId: retail.shiftId, sourceType: "POS",
      lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      payment: { amount: "1000.00", method: "CASH" },
    }, { userId: 3, branchId: 1 });

    const caller = await callerFor(2, "print_operator");
    const ids = (await caller.sales.list({ limit: 50 })).map((r: { id: number }) => Number(r.id));
    expect(ids).toContain(invoiceId);
    expect(ids).not.toContain(retailSale.invoiceId);
  });

  it("المدير يرى الفاتورتين معاً (نطاق sales بلا حصر قناة)", async () => {
    const { invoiceId } = await receptionWorkOrderInvoice();
    const retail = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RETAIL" }, { userId: 3, branchId: 1 });
    const retailSale = await createSale({
      branchId: 1, shiftId: retail.shiftId, sourceType: "POS",
      lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      payment: { amount: "1000.00", method: "CASH" },
    }, { userId: 3, branchId: 1 });

    const caller = await callerFor(1, undefined, "manager");
    const ids = (await caller.sales.list({ limit: 50 })).map((r: { id: number }) => Number(r.id));
    expect(ids).toEqual(expect.arrayContaining([invoiceId, retailSale.invoiceId]));
  });
});
