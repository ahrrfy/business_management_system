/**
 * اختبارات storeCustomerService — «العملاء» في لوحة hPanel.
 * يغطّي: قصر القائمة على عملاء المتجر (من لهم طلب أونلاين)، المؤشّرات (طلبات/مُسلَّم/إنفاق يستبعد الملغى/
 * آخر طلب/آخر محافظة)، الملخّص (متكرّرون/متوسّط)، الفرز، البحث، عزل الفرع، والترقيم.
 */
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../../drizzle/schema";
import { getDb } from "../../../db";
import { getStoreCustomers } from "../storeCustomerService";
import { truncateTables } from "../../__tests__/__testUtils__";

const STORE = 1;
const OTHER = 2;

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

let seq = 0;
async function seedOrder(o: { customerId: number; branchId: number; status: s.OnlineOrder["status"]; total: string; date: string; gov?: string | null }) {
  seq++;
  await db().insert(s.onlineOrders).values({
    orderNumber: `ORD-${String(seq).padStart(4, "0")}`,
    customerId: o.customerId, branchId: o.branchId,
    subtotal: o.total, shippingCost: "0", taxAmount: "0", total: o.total,
    status: o.status, orderDate: new Date(o.date), governorate: o.gov ?? null,
  });
}

beforeEach(async () => {
  seq = 0;
  await truncateTables(["onlineOrderItems", "onlineOrders", "customers", "branches", "users"]);
  await db().insert(s.branches).values([
    { id: STORE, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: OTHER, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
  await db().insert(s.users).values({ id: 1, openId: "t", name: "admin", role: "admin", loginMethod: "local" });
  await db().insert(s.customers).values([
    { id: 1, name: "أحمد", phone: "+9647701111111" },
    { id: 2, name: "زينب", phone: "+9647702222222" },
    { id: 3, name: "علي بلا طلبات", phone: "+9647703333333" },
    { id: 4, name: "حسن فرع آخر", phone: "+9647704444444" },
  ]);
});

async function seedScenario() {
  // c1: ٣ طلبات (٢ مُسلَّم + ملغى)، آخر طلب في البصرة
  await seedOrder({ customerId: 1, branchId: STORE, status: "DELIVERED", total: "10000", date: "2026-07-01T10:00:00Z", gov: "بغداد" });
  await seedOrder({ customerId: 1, branchId: STORE, status: "DELIVERED", total: "5000", date: "2026-07-03T10:00:00Z", gov: "بغداد" });
  await seedOrder({ customerId: 1, branchId: STORE, status: "CANCELLED", total: "8000", date: "2026-07-05T10:00:00Z", gov: "البصرة" });
  // c2: طلب واحد
  await seedOrder({ customerId: 2, branchId: STORE, status: "CONFIRMED", total: "20000", date: "2026-07-02T10:00:00Z", gov: "أربيل" });
  // c4: طلب على فرعٍ آخر
  await seedOrder({ customerId: 4, branchId: OTHER, status: "DELIVERED", total: "99999", date: "2026-07-04T10:00:00Z", gov: "النجف" });
}

describe("getStoreCustomers — القائمة والمؤشّرات", () => {
  it("يقصر على عملاء المتجر (من لهم طلب) ويحسب المؤشّرات (إنفاق يستبعد الملغى، آخر محافظة)", async () => {
    await seedScenario();
    const r = await getStoreCustomers({ scopedBranchId: STORE });
    expect(r.total).toBe(2); // c1, c2 (c3 بلا طلب، c4 فرع آخر)
    const c1 = r.rows.find((x) => x.customerId === 1)!;
    expect(c1.orders).toBe(3);
    expect(c1.deliveredOrders).toBe(2);
    expect(c1.spend).toBe("15000.00"); // 10000+5000 (الملغى 8000 مستبعَد)
    expect(c1.lastOrderYmd).toBe("2026-07-05");
    expect(c1.lastGovernorate).toBe("البصرة"); // محافظة أحدث طلب
    const c2 = r.rows.find((x) => x.customerId === 2)!;
    expect(c2.orders).toBe(1);
    expect(c2.spend).toBe("20000.00");
  });

  it("الملخّص: المتكرّرون + المتوسّط + الإيراد", async () => {
    await seedScenario();
    const r = await getStoreCustomers({ scopedBranchId: STORE });
    expect(r.summary.totalCustomers).toBe(2);
    expect(r.summary.repeatCustomers).toBe(1); // c1 (٣ طلبات)
    expect(r.summary.repeatRate).toBeCloseTo(0.5);
    expect(r.summary.totalRevenue).toBe("35000.00"); // 15000 + 20000
    expect(r.summary.avgSpend).toBe("17500.00");
  });
});

describe("getStoreCustomers — الفرز والبحث والعزل", () => {
  it("الفرز بالإنفاق (افتراضي): c2 (٢٠ألف) قبل c1 (١٥ألف)", async () => {
    await seedScenario();
    const r = await getStoreCustomers({ scopedBranchId: STORE, sort: "spend" });
    expect(r.rows.map((x) => x.customerId)).toEqual([2, 1]);
  });

  it("الفرز بعدد الطلبات: c1 (٣) قبل c2 (١)", async () => {
    await seedScenario();
    const r = await getStoreCustomers({ scopedBranchId: STORE, sort: "orders" });
    expect(r.rows.map((x) => x.customerId)).toEqual([1, 2]);
  });

  it("الفرز بالأحدث: c1 (آخر طلب 07-05) قبل c2 (07-02)", async () => {
    await seedScenario();
    const r = await getStoreCustomers({ scopedBranchId: STORE, sort: "recent" });
    expect(r.rows.map((x) => x.customerId)).toEqual([1, 2]);
  });

  it("البحث بالاسم/الهاتف", async () => {
    await seedScenario();
    expect((await getStoreCustomers({ scopedBranchId: STORE, q: "زينب" })).rows.map((x) => x.customerId)).toEqual([2]);
    expect((await getStoreCustomers({ scopedBranchId: STORE, q: "7701111" })).rows.map((x) => x.customerId)).toEqual([1]);
  });

  it("scopedBranchId=null يشمل عميل الفرع الآخر", async () => {
    await seedScenario();
    const r = await getStoreCustomers({ scopedBranchId: null });
    expect(r.total).toBe(3); // + c4
    expect(r.summary.totalCustomers).toBe(3);
    expect(r.summary.totalRevenue).toBe("134999.00"); // 35000 + 99999
  });

  it("الترقيم: limit=1 يعيد صفّاً واحداً مع total=2", async () => {
    await seedScenario();
    const r = await getStoreCustomers({ scopedBranchId: STORE, sort: "spend", limit: 1 });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].customerId).toBe(2); // الأعلى إنفاقاً
    expect(r.total).toBe(2);
  });

  it("نافذة بلا طلبات ⇒ ملخّص صفريّ", async () => {
    const r = await getStoreCustomers({ scopedBranchId: STORE });
    expect(r.total).toBe(0);
    expect(r.summary).toMatchObject({ totalCustomers: 0, repeatCustomers: 0, totalRevenue: "0.00", avgSpend: "0.00" });
  });
});

describe("getStoreCustomers — تحصين (مراجعة عدائية ١٣/٧)", () => {
  it("البحث يُهرّب حارف البدل _ (لا يُطابق أيّ محرف)", async () => {
    await db().insert(s.customers).values([
      { id: 11, name: "زبون_خاص", phone: "+9647711111111" },
      { id: 12, name: "زبونXخاص", phone: "+9647712222222" },
    ]);
    await seedOrder({ customerId: 11, branchId: STORE, status: "DELIVERED", total: "1000", date: "2026-07-01T10:00:00Z" });
    await seedOrder({ customerId: 12, branchId: STORE, status: "DELIVERED", total: "1000", date: "2026-07-01T10:00:00Z" });
    const r = await getStoreCustomers({ scopedBranchId: STORE, q: "زبون_خاص" });
    const ids = r.rows.map((x) => x.customerId);
    expect(ids).toContain(11);
    expect(ids).not.toContain(12); // «_» حرفيّ لا بدل ⇒ لا يُطابق «زبونXخاص»
  });

  it("الترقيم حتميّ عند تعادل الإنفاق (كاسر تعادل id) — لا تكرار/تخطٍّ عبر الصفحات", async () => {
    // عميلان إنفاقهما 0 (طلبٌ ملغى فقط) ⇒ يتعادلان؛ الترتيب يجب أن يكون حتميّاً بـid.
    await db().insert(s.customers).values([
      { id: 21, name: "أ متعادل", phone: "+9647721111111" },
      { id: 22, name: "ب متعادل", phone: "+9647722222222" },
    ]);
    await seedOrder({ customerId: 21, branchId: STORE, status: "CANCELLED", total: "5000", date: "2026-07-01T10:00:00Z" });
    await seedOrder({ customerId: 22, branchId: STORE, status: "CANCELLED", total: "5000", date: "2026-07-01T10:00:00Z" });
    const p0 = await getStoreCustomers({ scopedBranchId: STORE, sort: "spend", limit: 1, offset: 0 });
    const p1 = await getStoreCustomers({ scopedBranchId: STORE, sort: "spend", limit: 1, offset: 1 });
    expect(p0.rows).toHaveLength(1);
    expect(p1.rows).toHaveLength(1);
    expect(p0.rows[0].customerId).toBe(21); // id ASC عند التعادل
    expect(p1.rows[0].customerId).toBe(22);
    expect(p0.rows[0].customerId).not.toBe(p1.rows[0].customerId); // بلا تكرار
  });
});
