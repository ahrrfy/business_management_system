/**
 * بنك جهات الاتصال (S3، T3.2) — البحث الموحّد contacts.search + contact360 + waConsent.set +
 * persons CRUD + findDuplicates. اختبارات تكامل عبر appRouter.createCaller (نمط
 * auditLogGaps.test.ts) لأنها تُحقّق سلوك الراوتر فعلياً (عزل الفرع، الحجب حسب الدور، التدقيق) —
 * لا الخدمة المجرّدة وحدها.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { appRouter } from "../../routers";

const TABLES = [
  "auditLogs",
  "taskEvents",
  "tasks",
  "conversations",
  "contactPersons",
  "deliveryParties",
  "invoiceItems",
  "invoices",
  "customers",
  "suppliers",
  "branches",
  "users",
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
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "local_admin", name: "أدمن", role: "admin", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "local_manager", name: "مدير", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "local_cashier1", name: "كاشير الفرع ١", role: "cashier", loginMethod: "local", branchId: 1 },
  ]);
}

function makeCtx(user: { id: number; role: string; branchId: number | null }) {
  return { req: { headers: {} }, res: { cookie() {}, clearCookie() {} }, user } as any;
}

async function callerFor(userId: 1 | 2 | 3) {
  const row = (await db().select().from(s.users).where(eq(s.users.id, userId)).limit(1))[0];
  return appRouter.createCaller(makeCtx(row as any));
}

/** كاشير مصنَّع بفرع صريح (بلا صفّ DB — كافٍ لقراءات لا تكتب auditLogs/FK). */
function syntheticCashierCaller(branchId: number) {
  return appRouter.createCaller(makeCtx({ id: 999, role: "cashier", branchId }));
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("contacts.search — بحث موحّد", () => {
  it("يعيد الأنواع الأربعة (عميل/مورّد/توصيل/واتساب غير مربوط) لاستعلام مشترك", async () => {
    const d = db();
    await d.insert(s.customers).values({ name: "عميل بحث الاختبار", phone: "07701111111" });
    await d.insert(s.suppliers).values({ name: "مورد بحث الاختبار", phone: "07702222222" });
    await d.insert(s.deliveryParties).values({ name: "توصيل بحث الاختبار", phone: "07703333333", branchId: 1 });
    await d.insert(s.conversations).values({
      branchId: 1,
      channel: "WHATSAPP",
      channelHandle: "+9647704444444",
      customerId: null,
      displayName: "واتساب بحث الاختبار",
    });

    const caller = await callerFor(2); // manager — عابر للفروع
    const res = await caller.contacts.search({ q: "بحث الاختبار" });
    const kinds = res.rows.map((r) => r.kind).sort();
    expect(kinds).toEqual(["customer", "delivery", "supplier", "wa_unlinked"]);
    const waRow = res.rows.find((r) => r.kind === "wa_unlinked");
    expect(waRow?.name).toBe("واتساب بحث الاختبار");
    expect(waRow?.phone).toBe("+9647704444444");
  });

  it("لاحقة الهاتف تجد العميل/المورّد بصيغة محلية رغم التخزين E.164", async () => {
    const d = db();
    await d.insert(s.customers).values({ name: "عميل هاتف موحّد", phone: "+9647705555555" });
    const caller = await callerFor(2);
    const res = await caller.contacts.search({ q: "07705555555", kinds: ["customer"] });
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].name).toBe("عميل هاتف موحّد");
  });

  it("عزل الفرع: كاشير الفرع ١ لا يرى طرف توصيل بالفرع ٢؛ المدير يرى كليهما", async () => {
    const d = db();
    await d.insert(s.deliveryParties).values([
      { name: "مندوب مشترك الاسم", phone: "07706666661", branchId: 1 },
      { name: "مندوب مشترك الاسم", phone: "07706666662", branchId: 2 },
    ]);

    const branch1Caller = syntheticCashierCaller(1);
    const branch1Res = await branch1Caller.contacts.search({ q: "مندوب مشترك الاسم", kinds: ["delivery"] });
    expect(branch1Res.rows).toHaveLength(1);
    expect(branch1Res.rows[0].branchId).toBe(1);

    const branch2Caller = syntheticCashierCaller(2);
    const branch2Res = await branch2Caller.contacts.search({ q: "مندوب مشترك الاسم", kinds: ["delivery"] });
    expect(branch2Res.rows).toHaveLength(1);
    expect(branch2Res.rows[0].branchId).toBe(2);

    const managerCaller = await callerFor(2);
    const managerRes = await managerCaller.contacts.search({ q: "مندوب مشترك الاسم", kinds: ["delivery"] });
    expect(managerRes.rows).toHaveLength(2);
  });

  it("فلتر kinds يقصر الأنواع المُعادة", async () => {
    const d = db();
    await d.insert(s.customers).values({ name: "زبون مقصور الاختبار" });
    await d.insert(s.suppliers).values({ name: "مورّد مقصور الاختبار" });
    const caller = await callerFor(2);
    const res = await caller.contacts.search({ q: "مقصور الاختبار", kinds: ["customer"] });
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].kind).toBe("customer");
  });
});

describe("contacts.contact360 — بطاقة ٣٦٠° للعميل", () => {
  async function seedCustomer360() {
    const d = db();
    const custRes = await d.insert(s.customers).values({ name: "عميل بطاقة ٣٦٠", phone: "07707777777" });
    const customerId = extractInsertId(custRes);

    await d.insert(s.invoices).values([
      { invoiceNumber: "INV-360-1", sourceType: "POS", branchId: 1, customerId, subtotal: "100.00", total: "100.00", status: "PAID" },
      { invoiceNumber: "INV-360-2", sourceType: "POS", branchId: 1, customerId, subtotal: "50.00", total: "50.00", status: "PENDING" },
    ]);

    await d.insert(s.tasks).values([
      { taskNumber: "TSK-360-1", branchId: 1, title: "مهمة مفتوحة", customerId, taskStatus: "NEW" },
      { taskNumber: "TSK-360-2", branchId: 1, title: "مهمة محلولة", customerId, taskStatus: "RESOLVED" },
    ]);

    await d.insert(s.conversations).values({
      branchId: 1,
      channel: "WHATSAPP",
      channelHandle: "+9647707777777",
      customerId,
      displayName: "محادثة العميل",
      lastMessageAt: new Date(),
    });

    await d.insert(s.contactPersons).values([
      { customerId, name: "شخص فعّال", phone: "07708888888", isActive: true },
      { customerId, name: "شخص معطّل", phone: "07709999999", isActive: false },
    ]);

    return customerId;
  }

  it("يجمّع آخر الفواتير + المهام المفتوحة (يستثني المحلولة) + المحادثات + أشخاص الاتصال الفعّالين", async () => {
    const customerId = await seedCustomer360();
    const caller = await callerFor(2);
    const res = await caller.contacts.contact360({ kind: "customer", id: customerId });

    expect(res.kind).toBe("customer");
    expect(res.customer.name).toBe("عميل بطاقة ٣٦٠");
    expect(res.invoices).toHaveLength(2);
    expect(res.openTasks).toHaveLength(1);
    expect(res.openTasks[0].title).toBe("مهمة مفتوحة");
    expect(res.conversations).toHaveLength(1);
    expect(res.contactPersons).toHaveLength(1);
    expect(res.contactPersons[0].name).toBe("شخص فعّال");
  });

  it("يحجب الرصيد/سقف الائتمان لغير المدير (كاشير) — لا يحجبه عن المدير", async () => {
    const d = db();
    const customerId = await seedCustomer360();
    await d.update(s.customers).set({ currentBalance: "1500.00", creditLimit: "5000.00" }).where(eq(s.customers.id, customerId));

    const cashierCaller = await callerFor(3);
    const cashierRes = await cashierCaller.contacts.contact360({ kind: "customer", id: customerId });
    expect(cashierRes.customer.currentBalance).toBe("0");
    expect(cashierRes.customer.creditLimit).toBeNull();

    const managerCaller = await callerFor(2);
    const managerRes = await managerCaller.contacts.contact360({ kind: "customer", id: customerId });
    expect(managerRes.customer.currentBalance).toBe("1500.00");
  });

  it("مورّد: يجمّع أشخاص الاتصال والمحادثات المرتبطة بالمورّد", async () => {
    const d = db();
    const supRes = await d.insert(s.suppliers).values({ name: "مورد بطاقة ٣٦٠" });
    const supplierId = extractInsertId(supRes);
    await d.insert(s.contactPersons).values({ supplierId, name: "محاسب المورّد", phone: "07701212121", isActive: true });
    await d.insert(s.conversations).values({
      branchId: 1,
      channel: "WHATSAPP",
      channelHandle: "+9647701212121",
      supplierId,
      displayName: "محادثة المورّد",
    });

    const caller = await callerFor(2);
    const res = await caller.contacts.contact360({ kind: "supplier", id: supplierId });
    expect(res.kind).toBe("supplier");
    expect(res.contactPersons).toHaveLength(1);
    expect(res.conversations).toHaveLength(1);
  });
});

describe("contacts.waConsent.set", () => {
  it("يحدّث موافقة الواتساب ويسجّل التدقيق", async () => {
    const d = db();
    const custRes = await d.insert(s.customers).values({ name: "عميل موافقة الواتساب" });
    const customerId = extractInsertId(custRes);

    const caller = await callerFor(2);
    await caller.contacts.waConsent.set({ customerId, consent: "OPTED_IN" });

    const c = (await d.select().from(s.customers).where(eq(s.customers.id, customerId)).limit(1))[0];
    expect(c.waConsent).toBe("OPTED_IN");
    expect(c.waConsentSource).toBe("MANUAL");
    expect(c.waConsentAt).toBeTruthy();

    const audit = (
      await d.select().from(s.auditLogs).where(eq(s.auditLogs.action, "customer.waConsent.set")).orderBy(sql`${s.auditLogs.id} DESC`).limit(1)
    )[0];
    expect(audit).toBeTruthy();
    expect((audit.newValue as any).waConsent).toBe("OPTED_IN");
    expect(Number(audit.entityId)).toBe(customerId);
  });

  it("عميل غير موجود يُرفض", async () => {
    const caller = await callerFor(2);
    await expect(caller.contacts.waConsent.set({ customerId: 999999, consent: "OPTED_OUT" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("contacts.persons — CRUD أشخاص الاتصال B2B", () => {
  it("ينشئ شخص اتصال لعميل بتطبيع الهاتف E.164 + يظهر في القائمة", async () => {
    const d = db();
    const custRes = await d.insert(s.customers).values({ name: "عميل أشخاص الاتصال" });
    const customerId = extractInsertId(custRes);

    const caller = await callerFor(2);
    const created = await caller.contacts.persons.create({ customerId, name: "المفوَّض بالتوقيع", phone: "07701234567", role: "مفوَّض" });
    expect(created.id).toBeGreaterThan(0);

    const row = (await d.select().from(s.contactPersons).where(eq(s.contactPersons.id, created.id)).limit(1))[0];
    expect(row.phone).toBe("+9647701234567");

    const list = await caller.contacts.persons.list({ customerId });
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("المفوَّض بالتوقيع");

    const audit = (
      await d.select().from(s.auditLogs).where(eq(s.auditLogs.action, "contactPerson.create")).limit(1)
    )[0];
    expect(audit).toBeTruthy();
  });

  it("يرفض ربط شخص الاتصال بعميل ومورّد معاً", async () => {
    const d = db();
    const custRes = await d.insert(s.customers).values({ name: "ع" });
    const customerId = extractInsertId(custRes);
    const supRes = await d.insert(s.suppliers).values({ name: "م" });
    const supplierId = extractInsertId(supRes);

    const caller = await callerFor(2);
    await expect(caller.contacts.persons.create({ customerId, supplierId, name: "خطأ" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("يرفض شخص اتصال بلا طرف على الإطلاق", async () => {
    const caller = await callerFor(2);
    await expect(caller.contacts.persons.create({ name: "بلا طرف" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("update يعدّل الاسم/الهاتف؛ setInactive يعطّل بلا حذف صلب (يبقى في القائمة)", async () => {
    const d = db();
    const custRes = await d.insert(s.customers).values({ name: "عميل تعديل الشخص" });
    const customerId = extractInsertId(custRes);
    const caller = await callerFor(2);
    const created = await caller.contacts.persons.create({ customerId, name: "اسم أوّلي", phone: "07701111111" });

    await caller.contacts.persons.update({ id: created.id, name: "اسم مُعدَّل", phone: "07702222222" });
    let row = (await d.select().from(s.contactPersons).where(eq(s.contactPersons.id, created.id)).limit(1))[0];
    expect(row.name).toBe("اسم مُعدَّل");
    expect(row.phone).toBe("+9647702222222");

    await caller.contacts.persons.setInactive({ id: created.id });
    row = (await d.select().from(s.contactPersons).where(eq(s.contactPersons.id, created.id)).limit(1))[0];
    expect(row.isActive).toBeFalsy();

    // لا حذف صلب — الصفّ يبقى قابلاً للقراءة عبر persons.list.
    const list = await caller.contacts.persons.list({ customerId });
    expect(list).toHaveLength(1);
    expect(list[0].isActive).toBeFalsy();
  });
});

describe("contacts.findDuplicates — كشف ازدواج للقراءة فقط", () => {
  it("يعيد مرشّحين متشابهين بالاسم ويستثني الطرف نفسه", async () => {
    const d = db();
    const aRes = await d.insert(s.customers).values({ name: "شركة النور للتجارة" });
    const aId = extractInsertId(aRes);
    await d.insert(s.customers).values({ name: "شركة النور للاستيراد" });
    await d.insert(s.customers).values({ name: "عميل بلا علاقة" });

    const caller = await callerFor(2);
    const rows = await caller.contacts.findDuplicates({ kind: "customer", id: aId });
    expect(rows.some((r: any) => r.name === "شركة النور للاستيراد")).toBe(true);
    expect(rows.some((r: any) => Number(r.id) === aId)).toBe(false);
  });

  it("لا يُنشئ أو يُعدّل شيئاً — قراءة فقط", async () => {
    const d = db();
    await d.insert(s.customers).values([{ name: "شركة الأمين للطباعة" }, { name: "شركة الأمين للتغليف" }]);
    const before = Number((await d.select({ n: sql<number>`COUNT(*)` }).from(s.customers))[0].n);

    const caller = await callerFor(2);
    await caller.contacts.findDuplicates({ kind: "customer", name: "شركة الأمين للطباعة" });

    const after = Number((await d.select({ n: sql<number>`COUNT(*)` }).from(s.customers))[0].n);
    expect(after).toBe(before);
  });
});
