// تغطية شاملة لإصلاح «الرصيد الافتتاحي للطرف لا يظهر» + قدرتَي الحذف/تصحيح الرصيد (٢٥/٧):
//  ① Defect B: الراوتر كان يبتلع الرصيد الافتتاحي صامتاً لغير admin/manager المخوَّلين (مخزن/
//     مشتريات/كاشير) ⇒ الطرف يُنشأ برصيد صفر بلا قيد OPENING فيختفي من القائمة/الكشف/الأعمار.
//  ② Defect A: أعمار الذمم كانت تُقصي الرصيد المدين/الدائن السالب (currentBalance > 0 بدل <> 0).
//  ③ حذف طرفٍ بلا نشاط (تنظيف أخطاء الإدخال الأوّليّ) + حارس يرفض أيّ نشاط.
//  ④ تصحيح الرصيد الافتتاحي (تعديل قيد OPENING + تطبيق الفارق على الرصيد الجاري، يصون النشاط اللاحق).
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import type { TrpcContext } from "../../context";
import { appRouter } from "../../routers";
import { getDb } from "../../db";
import { createSupplier, deleteSupplier, getSupplier, updateSupplier } from "../supplierService";
import { deleteCustomer, getCustomer, updateCustomer } from "../customerService";
import { getAPAging, getSupplierStatement } from "../reports/apAging";
import { getARAging } from "../reports/arAging";

const actor = { userId: 1, branchId: 1 };

const TABLES = [
  "accountingEntries", "receipts", "invoiceItems", "invoices", "purchaseOrders",
  "customers", "suppliers", "financialPeriods", "branches", "users",
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
async function seedBase() {
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({ id: 1, openId: "t", name: "admin", role: "admin", loginMethod: "local" });
}
function ctxWith(role: string, branchId: number | null = 1): TrpcContext {
  return {
    req: { headers: {} } as unknown as TrpcContext["req"],
    res: {} as unknown as TrpcContext["res"],
    user: { id: 1, role, branchId, name: "t", email: "t@t", isActive: true } as unknown as TrpcContext["user"],
  };
}
const caller = (role: string) => appRouter.createCaller(ctxWith(role));

async function openingEntry(party: "CUSTOMER" | "SUPPLIER", id: number) {
  const col = party === "CUSTOMER" ? s.accountingEntries.customerId : s.accountingEntries.supplierId;
  return (await db().select().from(s.accountingEntries)
    .where(and(eq(s.accountingEntries.entryType, "OPENING"), eq(col, id))).limit(1))[0];
}

beforeEach(async () => { await reset(); await seedBase(); });

describe("① Defect B — الراوتر لم يعُد يبتلع الرصيد الافتتاحي لغير المدير المخوَّل", () => {
  it("مسؤول مشتريات يُنشئ مورّداً برصيد افتتاحي ⇒ يُحفظ + قيد OPENING + يظهر في الأعمار", async () => {
    const r = (await caller("purchasing").suppliers.create({
      name: "مورّد بيد مشتريات", openingBalance: "250000", openingBalanceDirection: "OWED_BY_US",
    })) as { supplierId: number };
    const sup = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, r.supplierId)).limit(1))[0];
    expect(sup.currentBalance).toBe("250000.00");
    expect((await openingEntry("SUPPLIER", r.supplierId))?.amount).toBe("250000.00");
    const aging = await getAPAging({});
    expect(aging.find((a) => a.supplierId === r.supplierId)?.currentBalance).toBe("250000.00");
  });

  it("أمين مخزن يُنشئ مورّداً برصيد افتتاحي ⇒ يُحفظ (كان يُبتلع)", async () => {
    const r = (await caller("warehouse").suppliers.create({
      name: "مورّد بيد مخزن", openingBalance: "90000", openingBalanceDirection: "OWED_BY_US",
    })) as { supplierId: number };
    const sup = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, r.supplierId)).limit(1))[0];
    expect(sup.currentBalance).toBe("90000.00");
  });

  it("كاشير يُنشئ عميلاً برصيد افتتاحي ⇒ يُحفظ، لكن سقف الائتمان يبقى محجوباً «0»", async () => {
    const r = (await caller("cashier").customers.create({
      name: "عميل بيد كاشير", openingBalance: "120000", openingBalanceDirection: "OWED_TO_US", creditLimit: "999999",
    })) as { customerId: number };
    const c = (await db().select().from(s.customers).where(eq(s.customers.id, r.customerId)).limit(1))[0];
    expect(c.currentBalance).toBe("120000.00");
    expect(c.creditLimit).toBe("0.00"); // سقف الائتمان يبقى للمدير وحده (قرارٌ ائتمانيّ منفصل) — مُثبَّت 0.
    expect((await openingEntry("CUSTOMER", r.customerId))?.amount).toBe("120000.00");
  });
});

describe("② Defect A — الرصيد السالب (دفعة مقدّمة/دائن) يظهر في الأعمار", () => {
  it("مورّد بدفعة مقدّمة «لنا عليه» (سالب) يظهر في أعمار الذمم الدائنة", async () => {
    const { supplierId } = await createSupplier(
      { name: "مورّد دفعة مقدّمة", openingBalance: "300000", openingBalanceDirection: "OWED_TO_US" }, actor,
    );
    const row = (await getAPAging({})).find((a) => a.supplierId === supplierId);
    expect(row).toBeTruthy();
    expect(row?.currentBalance).toBe("-300000.00");
    expect(row?.unbucketed).toBe("-300000.00");
  });
  it("عميل برصيد دائن «له علينا» (سالب) يظهر في أعمار الذمم المدينة", async () => {
    const r = (await caller("admin").customers.create({
      name: "عميل دائن", openingBalance: "80000", openingBalanceDirection: "OWED_BY_US",
    })) as { customerId: number };
    const row = (await getARAging({})).find((a) => a.customerId === r.customerId);
    expect(row).toBeTruthy();
    expect(row?.currentBalance).toBe("-80000.00");
  });
});

describe("③ حذف طرفٍ بلا نشاط + حارس يرفض النشاط", () => {
  it("مورّد برصيد افتتاحي فقط ⇒ يُحذف ويُزال قيده الافتتاحي", async () => {
    const { supplierId } = await createSupplier(
      { name: "مورّد للحذف", openingBalance: "50000", openingBalanceDirection: "OWED_BY_US" }, actor,
    );
    expect(await openingEntry("SUPPLIER", supplierId)).toBeTruthy();
    const res = await deleteSupplier(supplierId, actor);
    expect(res.deleted).toBe(true);
    expect((await db().select().from(s.suppliers).where(eq(s.suppliers.id, supplierId)).limit(1))[0]).toBeUndefined();
    expect(await openingEntry("SUPPLIER", supplierId)).toBeUndefined();
  });

  it("مورّد له أمر شراء ⇒ يُرفض الحذف", async () => {
    const { supplierId } = await createSupplier({ name: "مورّد بأمر" }, actor);
    await db().insert(s.purchaseOrders).values({
      poNumber: "PO-DEL-1", supplierId, branchId: 1, orderDate: new Date("2026-07-25T12:00:00Z"),
      subtotal: "1000", total: "1000", paidAmount: "0", status: "CONFIRMED",
    });
    await expect(deleteSupplier(supplierId, actor)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // لم يُحذف.
    expect((await db().select().from(s.suppliers).where(eq(s.suppliers.id, supplierId)).limit(1))[0]).toBeTruthy();
  });

  it("مورّد له قيد دفتر غير افتتاحي (دفعة) ⇒ يُرفض الحذف", async () => {
    const { supplierId } = await createSupplier({ name: "مورّد بدفعة" }, actor);
    await db().insert(s.accountingEntries).values({
      entryType: "PAYMENT_OUT", supplierId, revenue: "0", cost: "0", profit: "0", taxAmount: "0",
      amount: "5000", entryDate: new Date("2026-07-25"), dedupeKey: "T:PAYOUT:1",
    });
    await expect(deleteSupplier(supplierId, actor)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("عميل له فاتورة ⇒ يُرفض الحذف؛ وعميل بلا نشاط ⇒ يُحذف", async () => {
    const withInv = (await caller("admin").customers.create({ name: "عميل بفاتورة" })) as { customerId: number };
    await db().insert(s.invoices).values({
      invoiceNumber: "INV-DEL-1", sourceType: "POS", sourceId: "t-del-1", branchId: 1,
      customerId: withInv.customerId, priceTier: "RETAIL", subtotal: "1000", total: "1000", paidAmount: "0", status: "PENDING",
    });
    await expect(deleteCustomer(withInv.customerId, actor)).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const clean = (await caller("admin").customers.create({
      name: "عميل نظيف", openingBalance: "10000", openingBalanceDirection: "OWED_TO_US",
    })) as { customerId: number };
    expect((await deleteCustomer(clean.customerId, actor)).deleted).toBe(true);
    expect(await openingEntry("CUSTOMER", clean.customerId)).toBeUndefined();
  });

  it("الراوتر: دورٌ غير مدير (مخزن) يُمنع من حذف المورّد (FORBIDDEN)", async () => {
    const { supplierId } = await createSupplier({ name: "محميّ" }, actor);
    await expect(caller("warehouse").suppliers.delete({ supplierId })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("④ تصحيح الرصيد الافتتاحي (تعديل قيد OPENING + فارق الرصيد الجاري)", () => {
  it("تعديل 500000 ⇒ 300000: قيد OPENING والرصيد الجاري يتبعان الفارق", async () => {
    const { supplierId } = await createSupplier(
      { name: "تصحيح", openingBalance: "500000", openingBalanceDirection: "OWED_BY_US" }, actor,
    );
    await updateSupplier({ supplierId, openingBalance: "300000", openingBalanceDirection: "OWED_BY_US" }, actor);
    const sup = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, supplierId)).limit(1))[0];
    expect(sup.currentBalance).toBe("300000.00");
    expect((await openingEntry("SUPPLIER", supplierId))?.amount).toBe("300000.00");
  });

  it("تفريغ الرصيد الافتتاحي (⇒ 0) يحذف قيد OPENING ويُنقص الرصيد الجاري", async () => {
    const { supplierId } = await createSupplier(
      { name: "تفريغ", openingBalance: "200000", openingBalanceDirection: "OWED_BY_US" }, actor,
    );
    await updateSupplier({ supplierId, openingBalance: "", openingBalanceDirection: "OWED_BY_US" }, actor);
    const sup = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, supplierId)).limit(1))[0];
    expect(sup.currentBalance).toBe("0.00");
    expect(await openingEntry("SUPPLIER", supplierId)).toBeUndefined();
  });

  it("التصحيح يصون النشاط اللاحق: الفارق يُطبَّق نسبياً لا يُعاد بناء الرصيد", async () => {
    const { supplierId } = await createSupplier(
      { name: "نشاط لاحق", openingBalance: "100000", openingBalanceDirection: "OWED_BY_US" }, actor,
    );
    // محاكاة دفعة 30000 خفّضت الرصيد الجاري (بلا مسّ قيد OPENING) ⇒ 70000.
    await db().update(s.suppliers).set({ currentBalance: "70000.00" }).where(eq(s.suppliers.id, supplierId));
    // تصحيح الرصيد الافتتاحي 100000 ⇒ 150000 (فارق +50000).
    await updateSupplier({ supplierId, openingBalance: "150000", openingBalanceDirection: "OWED_BY_US" }, actor);
    const sup = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, supplierId)).limit(1))[0];
    expect(sup.currentBalance).toBe("120000.00"); // 70000 + 50000 (النشاط -30000 مَصون).
    expect((await openingEntry("SUPPLIER", supplierId))?.amount).toBe("150000.00");
  });

  it("الراوتر: دورٌ غير مرتفع (مخزن) لا يُغيّر الرصيد الافتتاحي عند التعديل", async () => {
    const { supplierId } = await createSupplier(
      { name: "حماية التعديل", openingBalance: "100000", openingBalanceDirection: "OWED_BY_US" }, actor,
    );
    // مخزن يعدّل الاسم فقط — يجب ألّا يمسّ الرصيد الافتتاحي حتى لو أرسله.
    await caller("warehouse").suppliers.update({ supplierId, name: "اسم جديد", openingBalance: "999999", openingBalanceDirection: "OWED_BY_US" });
    const sup = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, supplierId)).limit(1))[0];
    expect(sup.name).toBe("اسم جديد");
    expect(sup.currentBalance).toBe("100000.00"); // لم يتغيّر.
    expect((await openingEntry("SUPPLIER", supplierId))?.amount).toBe("100000.00");
  });

  it("getSupplier/getCustomer يُرفقان الرصيد الافتتاحي الحاليّ لشاشة التعديل", async () => {
    const { supplierId } = await createSupplier(
      { name: "قراءة", openingBalance: "45000", openingBalanceDirection: "OWED_BY_US" }, actor,
    );
    expect((await getSupplier(supplierId))?.openingBalance).toBe("45000.00");
    const { customerId } = (await caller("admin").customers.create({
      name: "قراءة عميل", openingBalance: "33000", openingBalanceDirection: "OWED_TO_US",
    })) as { customerId: number };
    expect((await getCustomer(customerId))?.openingBalance).toBe("33000.00");
  });
});
