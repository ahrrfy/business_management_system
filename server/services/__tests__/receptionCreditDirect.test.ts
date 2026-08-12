// بيع مباشر آجل في الاستقبال (قرار المالك ١٠/٨) — متابعة الفجوة: يسمح بأن يقلّ المقبوض عن إجمالي
// البضاعة الجاهزة **بلا توصيل** حين يوجد عميلٌ مسجَّل والعلَم `deferredDirect` مرفوع؛ المتبقّي يصير
// ذمّةً على العميل (AR) عبر createSaleInTx. التفويض محصور بعميل فعّال ذي اسم وهاتف عراقي مكتمل
// ويُسجَّل تدقيقياً؛ بلا علَمٍ أو بلا هوية مكتملة يبقى الحاجز صارماً.
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { resolvePermissions, SECTION_CASHIER_ROLES } from "@shared/permissions";
import * as s from "../../../drizzle/schema";
import { hashPassword } from "../../auth/password";
import { resolveCustomRole } from "../../context";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { openShift } from "../shiftService";
import { checkoutReception } from "../receptionCheckoutService";

const CASHIER = { userId: 2, branchId: 1, role: "cashier" };
const TABLES = [
  "orderPayments", "auditLogs", "idempotencyKeys", "accountingEntries", "receipts",
  "workOrderMaterials", "workOrders", "invoiceItems", "invoices",
  "inventoryMovements", "branchStock", "productPrices", "productUnits", "productVariants",
  "products", "shifts", "customers", "branches", "users",
  "roles",
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
    { id: 2, openId: "rc1", name: "موظف", email: "r1@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.customers).values([
    { id: 1, name: "عميل موثوق", phone: "+9647701234567", currentBalance: "0.00", creditLimit: "0.00" },
    { id: 2, name: "عميل محدود", phone: "+9647801234567", currentBalance: "0.00", creditLimit: "5000.00" },
    { id: 3, name: "عميل بلا هاتف", currentBalance: "0.00", creditLimit: "1000000.00" },
  ]);
  await d.insert(s.products).values([{ id: 1, name: "دفتر" }]);
  await d.insert(s.productVariants).values([{ id: 1, productId: 1, sku: "NB-1", costPrice: "500.00" }]);
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: 1, isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" }]);
  await d.insert(s.branchStock).values([{ variantId: 1, branchId: 1, quantity: 500 }]);
}
const openReception = () => openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
const LINE = { variantId: 1, productUnitId: 1, quantity: "10" }; // ١٠ × ١٠٠٠ = ١٠٬٠٠٠

async function balance(customerId: number): Promise<number> {
  return Number((await db().select().from(s.customers).where(eq(s.customers.id, customerId)))[0].currentBalance);
}
async function invoiceOf(id: number) {
  return (await db().select().from(s.invoices).where(eq(s.invoices.id, id)))[0];
}

function callerContext(user: any = null) {
  return {
    req: { headers: {}, ip: "127.0.0.1", socket: { remoteAddress: "127.0.0.1" } },
    res: { cookie() {}, clearCookie() {} },
    user,
    sessionId: null,
    platformAdmin: null,
  } as any;
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("بيع مباشر آجل في الاستقبال — deferredDirect", () => {
  it("حساب موظف استقبال فعلي crm=NONE يسجّل الدخول ويضيف العميل ويبيع بلا عربون، بلا صلاحيات CRM إدارية", async () => {
    const d = db();
    const spec = SECTION_CASHIER_ROLES.find((role) => role.key === "reception_clerk");
    expect(spec).toBeTruthy();

    const strictReceptionPermissions = {
      ...spec!.permissions,
      crm: "NONE" as const,
      customers: "NONE" as const,
    };
    await d.insert(s.roles).values({
      id: 1,
      key: "reception_clerk_test",
      label: "موظف خدمة العملاء — اختبار",
      baseRole: "cashier",
      permissions: strictReceptionPermissions,
      isActive: true,
      isSystem: true,
      station: "RECEPTION",
    });
    const receptionPassword = randomUUID();
    await d.update(s.users).set({
      username: "reception.clerk",
      passwordHash: await hashPassword(receptionPassword),
      customRoleId: 1,
    }).where(eq(s.users.id, 2));

    const anonymous = appRouter.createCaller(callerContext());
    const login = await anonymous.auth.login({
      identifier: "reception.clerk",
      password: receptionPassword,
      remember: false,
    });
    expect(login.requiresTwoFactor).toBe(false);

    const receptionUser = (await d.select().from(s.users).where(eq(s.users.id, 2)).limit(1))[0] as any;
    await resolveCustomRole(receptionUser);
    expect(receptionUser.customRoleKey).toBe("reception_clerk_test");
    const effectivePermissions = resolvePermissions(receptionUser.role, receptionUser.permissionsOverride);
    expect(effectivePermissions.crm).toBe("NONE");
    expect(effectivePermissions.workorders).toBe("FULL");

    const caller = appRouter.createCaller(callerContext(receptionUser));
    await expect(caller.customers.list({ limit: 10, offset: 0 })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const customer = await caller.customers.receptionResolveByPhone({
      phone: "07509998888",
      name: "عميل اختبار الاستقبال",
    });
    expect(customer.created).toBe(true);
    expect(customer.customerId).toBeGreaterThan(0);

    const shift = await caller.shifts.open({
      branchId: 1,
      openingBalance: "0",
      shiftType: "RECEPTION",
    });
    const checkout = await caller.workOrders.receptionCheckout({
      branchId: 1,
      shiftId: shift.shiftId,
      customerId: customer.customerId,
      paymentMethod: "CASH",
      paidAmount: "0",
      deferredDirect: true,
      clientRequestId: "strict-reception-user-deferred",
      regularSale: { lines: [LINE], amount: "10000.00" },
      workOrders: [],
    });

    expect(checkout.regularSale?.invoiceId).toBeGreaterThan(0);
    const invoice = await invoiceOf(checkout.regularSale!.invoiceId);
    expect(Number(invoice.customerId)).toBe(customer.customerId);
    expect(invoice.paidAmount).toBe("0.00");
    expect(await balance(customer.customerId)).toBe(10000);
    expect((await d.select().from(s.receipts)).length).toBe(0);

    await expect(caller.customers.update({
      customerId: customer.customerId,
      name: "تعديل غير مسموح",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("بلا العلَم: المقبوض 0 على بضاعة جاهزة بلا توصيل ⇒ يُرفض (الحاجز الأصليّ)", async () => {
    const shift = await openReception();
    await expect(checkoutReception({
      branchId: 1, shiftId: shift.shiftId, customerId: 1,
      paymentMethod: "CASH", paidAmount: "0", clientRequestId: "no-flag",
      regularSale: { lines: [LINE], amount: "10000.00" },
    }, CASHIER)).rejects.toThrowError(/يغطي البيع المباشر/);
    expect(await balance(1)).toBe(0); // ذرّية — لا ذمّة
    expect((await db().select().from(s.invoices)).length).toBe(0);
  });

  it("بالعلَم + عميل موثوق + مقبوض 0 ⇒ بيعٌ آجل، الإجمالي كلّه ذمّة على العميل", async () => {
    const shift = await openReception();
    const r = await checkoutReception({
      branchId: 1, shiftId: shift.shiftId, customerId: 1,
      paymentMethod: "CASH", paidAmount: "0", deferredDirect: true, clientRequestId: "def-full",
      regularSale: { lines: [LINE], amount: "10000.00" },
    }, CASHIER);
    expect(r.regularSale).toBeTruthy();
    const inv = await invoiceOf(r.regularSale!.invoiceId);
    expect(inv.total).toBe("10000.00");
    expect(inv.paidAmount).toBe("0.00"); // لا نقد وهميّ
    expect(await balance(1)).toBe(10000); // كامل الدَّين ذمّة (رُخّي الحاجز لا التسجيل)
    expect((await db().select().from(s.receipts)).length).toBe(0); // لا إيصال قبض ولا حركة درج
    const audit = await db().select().from(s.auditLogs).where(eq(s.auditLogs.action, "reception.deferredDirect"));
    expect(audit).toHaveLength(1);
  });

  it("بالعلَم + دفعة جزئية ⇒ المدفوع نقدٌ فعليّ والباقي ذمّة", async () => {
    const shift = await openReception();
    const r = await checkoutReception({
      branchId: 1, shiftId: shift.shiftId, customerId: 1,
      paymentMethod: "CASH", paidAmount: "4000", deferredDirect: true, clientRequestId: "def-part",
      regularSale: { lines: [LINE], amount: "10000.00" },
    }, CASHIER);
    const inv = await invoiceOf(r.regularSale!.invoiceId);
    expect(inv.paidAmount).toBe("4000.00");
    expect(await balance(1)).toBe(6000); // 10000 − 4000
  });

  it("بالعلَم لكن بلا عميلٍ مسجَّل (عابر) ⇒ يبقى الحاجز صارماً — لا ذمّة بلا صاحب", async () => {
    const shift = await openReception();
    await expect(checkoutReception({
      branchId: 1, shiftId: shift.shiftId, customerId: null, contactName: "زبون عابر",
      paymentMethod: "CASH", paidAmount: "0", deferredDirect: true, clientRequestId: "def-nocust",
      regularSale: { lines: [LINE], amount: "10000.00" },
    }, CASHIER)).rejects.toThrowError(/يتطلب عميلاً محفوظاً/);
  });

  it("بالعلَم + هوية مكتملة ⇒ تفويض الاستقبال محصور بالمعاملة ويتجاوز السقف الصفري مع إبقاء AR", async () => {
    const shift = await openReception();
    const r = await checkoutReception({
      branchId: 1, shiftId: shift.shiftId, customerId: 2, // حدّه 5000 < 10000
      paymentMethod: "CASH", paidAmount: "0", deferredDirect: true, clientRequestId: "def-over",
      regularSale: { lines: [LINE], amount: "10000.00" },
    }, CASHIER);
    expect(r.regularSale).toBeTruthy();
    expect(await balance(2)).toBe(10000);
  });

  it("بالعلَم + عميل بلا هاتف عراقي مكتمل ⇒ يُرفض بلا فاتورة أو ذمّة", async () => {
    const shift = await openReception();
    await expect(checkoutReception({
      branchId: 1, shiftId: shift.shiftId, customerId: 3,
      paymentMethod: "CASH", paidAmount: "0", deferredDirect: true, clientRequestId: "def-no-phone",
      regularSale: { lines: [LINE], amount: "10000.00" },
    }, CASHIER)).rejects.toThrowError(/هاتف عراقي مكتمل/);
    expect(await balance(3)).toBe(0);
    expect((await db().select().from(s.invoices)).length).toBe(0);
  });
});
