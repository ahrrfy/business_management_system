import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  activateCustomer,
  createCustomer,
  deactivateCustomer,
  getCustomer,
  listCustomers,
  updateCustomer,
} from "../customerService";

const actor = { userId: 1, branchId: 1 };

const TABLES = [
  "accountingEntries",
  "receipts",
  "invoiceItems",
  "invoices",
  "customers",
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
  await d.insert(s.users).values({
    id: 1,
    openId: "local_test",
    name: "admin",
    role: "admin",
    loginMethod: "local",
  });
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("customerService.createCustomer", () => {
  it("ينشئ عميلاً جديداً بالحقول الكاملة", async () => {
    const r = await createCustomer(
      {
        name: "شركة الرفيع",
        phone: "07701234567",
        whatsapp: "07701234567",
        address: "كرادة داخل",
        city: "بغداد",
        district: "كرادة",
        customerType: "شركة",
        defaultPriceTier: "WHOLESALE",
        creditLimit: "500000",
        notes: "دفع شهري",
      },
      actor,
    );
    expect(r.customerId).toBeGreaterThan(0);
    const c = (await db().select().from(s.customers).where(eq(s.customers.id, r.customerId)).limit(1))[0];
    expect(c.name).toBe("شركة الرفيع");
    expect(c.phone).toBe("07701234567");
    expect(c.customerType).toBe("شركة");
    expect(c.defaultPriceTier).toBe("WHOLESALE");
    expect(c.creditLimit).toBe("500000.00");
    expect(c.currentBalance).toBe("0.00");
    expect(c.isActive).toBe(true);
  });

  it("يقبل اسماً فقط مع قيم افتراضية", async () => {
    const r = await createCustomer({ name: "عميل سريع" }, actor);
    const c = (await db().select().from(s.customers).where(eq(s.customers.id, r.customerId)).limit(1))[0];
    expect(c.customerType).toBe("فرد");
    expect(c.defaultPriceTier).toBe("RETAIL");
    expect(c.creditLimit).toBe("0.00");
    expect(c.phone).toBeNull();
  });

  it("يرفض اسماً فارغاً", async () => {
    await expect(createCustomer({ name: "  " }, actor)).rejects.toThrow();
    await expect(createCustomer({ name: "" }, actor)).rejects.toThrow();
  });

  it("يرفض اسماً أطول من ٢٥٥ حرفاً", async () => {
    await expect(createCustomer({ name: "أ".repeat(256) }, actor)).rejects.toThrow();
  });

  it("يرفض هاتفاً مكرّراً لعميل آخر", async () => {
    await createCustomer({ name: "أحمد", phone: "07709999999" }, actor);
    await expect(createCustomer({ name: "محمد", phone: "07709999999" }, actor)).rejects.toThrow();
  });

  it("يقبل عملاء متعدّدين بلا هاتف", async () => {
    const a = await createCustomer({ name: "أ" }, actor);
    const b = await createCustomer({ name: "ب" }, actor);
    expect(a.customerId).not.toBe(b.customerId);
  });

  it("يرفض سقف ائتمان غير رقمي", async () => {
    await expect(
      createCustomer({ name: "س", creditLimit: "abc" }, actor),
    ).rejects.toThrow();
  });
});

describe("customerService.updateCustomer", () => {
  it("يعدّل الحقول المحدّدة فقط", async () => {
    const { customerId } = await createCustomer({ name: "بسام", phone: "07700001" }, actor);
    const r = await updateCustomer({ customerId, name: "بسام محمد", city: "كركوك" }, actor);
    expect(r.changed).toBe(true);
    const c = await getCustomer(customerId);
    expect(c?.name).toBe("بسام محمد");
    expect(c?.city).toBe("كركوك");
    expect(c?.phone).toBe("07700001");
  });

  it("يُرجع changed=false إن لم تتغيّر أيّ حقول", async () => {
    const { customerId } = await createCustomer({ name: "علي" }, actor);
    const r = await updateCustomer({ customerId }, actor);
    expect(r.changed).toBe(false);
  });

  it("يرفض هاتفاً متعارضاً مع عميل آخر", async () => {
    await createCustomer({ name: "أ", phone: "07710001" }, actor);
    const { customerId } = await createCustomer({ name: "ب", phone: "07710002" }, actor);
    await expect(
      updateCustomer({ customerId, phone: "07710001" }, actor),
    ).rejects.toThrow();
  });

  it("يسمح بإبقاء الهاتف نفسه عند تعديل العميل ذاته", async () => {
    const { customerId } = await createCustomer({ name: "ج", phone: "07720000" }, actor);
    const r = await updateCustomer({ customerId, phone: "07720000", city: "أربيل" }, actor);
    expect(r.changed).toBe(true);
  });

  it("يرفض تعديل عميل غير موجود", async () => {
    await expect(updateCustomer({ customerId: 99999, name: "x" }, actor)).rejects.toThrow();
  });
});

describe("customerService.deactivateCustomer", () => {
  it("يعطّل عميلاً بلا رصيد", async () => {
    const { customerId } = await createCustomer({ name: "د" }, actor);
    const r = await deactivateCustomer(customerId, actor);
    expect(r.isActive).toBe(false);
    const c = await getCustomer(customerId);
    expect(c?.isActive).toBe(false);
  });

  it("يرفض تعطيل عميل عليه رصيد مفتوح", async () => {
    const { customerId } = await createCustomer({ name: "هـ" }, actor);
    await db().update(s.customers).set({ currentBalance: "1000" }).where(eq(s.customers.id, customerId));
    await expect(deactivateCustomer(customerId, actor)).rejects.toThrow(/رصيد/);
  });

  it("يرفض تعطيل عميل له فاتورة معلّقة", async () => {
    const { customerId } = await createCustomer({ name: "و" }, actor);
    await db().insert(s.invoices).values({
      invoiceNumber: "TEST-PENDING-001",
      sourceType: "POS",
      branchId: 1,
      customerId,
      priceTier: "RETAIL",
      subtotal: "100.00",
      total: "100.00",
      status: "PENDING",
    });
    await expect(deactivateCustomer(customerId, actor)).rejects.toThrow(/فواتير/);
  });

  it("يرفض تعطيل عميل معطّل بالفعل", async () => {
    const { customerId } = await createCustomer({ name: "ز" }, actor);
    await deactivateCustomer(customerId, actor);
    await expect(deactivateCustomer(customerId, actor)).rejects.toThrow();
  });
});

describe("customerService.activateCustomer", () => {
  it("يعيد تفعيل عميل معطّل", async () => {
    const { customerId } = await createCustomer({ name: "ح" }, actor);
    await deactivateCustomer(customerId, actor);
    const r = await activateCustomer(customerId, actor);
    expect(r.isActive).toBe(true);
    const c = await getCustomer(customerId);
    expect(c?.isActive).toBe(true);
  });

  it("يرفض إعادة تفعيل عميل مفعّل", async () => {
    const { customerId } = await createCustomer({ name: "ط" }, actor);
    await expect(activateCustomer(customerId, actor)).rejects.toThrow();
  });
});

describe("customerService.listCustomers", () => {
  it("يعرض المفعّلين فقط افتراضياً", async () => {
    const a = await createCustomer({ name: "أبو علي" }, actor);
    const b = await createCustomer({ name: "أم محمد" }, actor);
    await deactivateCustomer(a.customerId, actor);
    const r = await listCustomers({});
    expect(r.rows).toHaveLength(1);
    expect(Number(r.rows[0].id)).toBe(b.customerId);
    expect(r.total).toBe(1);
  });

  it("يعرض الكل عند includeInactive=true", async () => {
    const a = await createCustomer({ name: "أأ" }, actor);
    await createCustomer({ name: "بب" }, actor);
    await deactivateCustomer(a.customerId, actor);
    const r = await listCustomers({ includeInactive: true });
    expect(r.rows).toHaveLength(2);
    expect(r.total).toBe(2);
  });

  it("يبحث بالاسم والهاتف", async () => {
    await createCustomer({ name: "أحمد محمد", phone: "07701111111" }, actor);
    await createCustomer({ name: "علي حسن", phone: "07702222222" }, actor);
    const byName = await listCustomers({ q: "أحمد" });
    expect(byName.rows).toHaveLength(1);
    const byPhone = await listCustomers({ q: "07702" });
    expect(byPhone.rows).toHaveLength(1);
    expect(byPhone.rows[0].name).toBe("علي حسن");
  });

  it("يفلتر بنوع العميل وفئة السعر", async () => {
    await createCustomer({ name: "ت١", customerType: "تاجر", defaultPriceTier: "WHOLESALE" }, actor);
    await createCustomer({ name: "ف١", customerType: "فرد", defaultPriceTier: "RETAIL" }, actor);
    const traders = await listCustomers({ customerType: "تاجر" });
    expect(traders.rows).toHaveLength(1);
    expect(traders.rows[0].name).toBe("ت١");
    const wholesale = await listCustomers({ priceTier: "WHOLESALE" });
    expect(wholesale.rows).toHaveLength(1);
  });

  it("يحترم limit و offset مع إجمالي صحيح", async () => {
    for (let i = 0; i < 5; i++) await createCustomer({ name: `عميل ${i}` }, actor);
    const page1 = await listCustomers({ limit: 2, offset: 0 });
    expect(page1.rows).toHaveLength(2);
    expect(page1.total).toBe(5);
    const page2 = await listCustomers({ limit: 2, offset: 2 });
    expect(page2.rows).toHaveLength(2);
    expect(page2.total).toBe(5);
    const page3 = await listCustomers({ limit: 2, offset: 4 });
    expect(page3.rows).toHaveLength(1);
  });
});

describe("customerService.getCustomer", () => {
  it("يُرجع بطاقة العميل كاملة", async () => {
    const { customerId } = await createCustomer({ name: "ك", phone: "07703333" }, actor);
    const c = await getCustomer(customerId);
    expect(c).toBeTruthy();
    expect(c?.name).toBe("ك");
    expect(c?.phone).toBe("07703333");
  });

  it("يُرجع null لمعرّف غير موجود", async () => {
    const c = await getCustomer(99999);
    expect(c).toBeNull();
  });
});
