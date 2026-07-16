// منتقي العميل — الوصول لما بعد سقف الـ٥٠٠.
//
// الخلل المُعالَج: منتقيات العميل كانت تُغذَّى من `customers.list` (سقف **٥٠٠ صلب** بلا بحث ولا
// offset) ثمّ تُصفّي **محلّياً** ⇒ العميل رقم ٥٠١ غير موجود في المنتقي إطلاقاً: لا يُرى ولا
// يُبحَث ولا يُختار، **بلا أيّ مؤشّر**. أثره التشغيليّ: يتعذّر بيعه آجلاً (البيع الآجل يشترط
// عميلاً)، ويُطبَع إيصاله بلا اسم.
//
// العلاج: `customers.search` (q + limit + offset، سقف ٢٠٠٠) للبحث، و`customers.get` بـid لاسم
// المختار. الثوابت هنا تُثبّت أن **المسار الذي صارت الواجهة تستعمله** يصل فعلاً لما بعد ٥٠٠.
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import type { TrpcContext } from "../../context";
import { appRouter } from "../../routers";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

function adminCtx(): TrpcContext {
  return {
    req: { headers: {} } as unknown as TrpcContext["req"],
    res: {} as unknown as TrpcContext["res"],
    user: { id: 1, role: "admin", branchId: 1, name: "t", email: "t@t", isActive: true } as unknown as TrpcContext["user"],
  };
}
const caller = () => appRouter.createCaller(adminCtx());

/**
 * العميل «الحدّي» — يجب أن يقع **خارج أوّل ٥٠٠**.
 * ⚠️ `listCustomers` ترتّب `asc(name), desc(id)` — **أبجدياً بالاسم لا بالمعرّف**. فلا يكفي
 * إدراجه أخيراً (أوّل محاولة سقطت: اسمٌ بحرف «ز» سبق «ع» أبجدياً فظهر **أوّلاً** داخل السقف).
 * الحيلة الحتمية: البقية بحرف «ا» (أوّل الأبجدية) وهو بحرف «ي» (آخرها) ⇒ يقع أخيراً يقيناً
 * مهما كان الترتيب داخل المجموعة. والاسم يحمل همزة (إسماعيل) لاختبار التطبيع العربي أيضاً.
 */
const BEYOND = "ياسر إسماعيل";

beforeEach(async () => {
  await truncateTables(["customers", "branches", "users"]);
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({ id: 1, openId: "t", name: "admin", role: "admin", loginMethod: "local" });

  // ٥٢٠ عميلاً — إدراج **دفعةً واحدة** (لا حلقة): تنظيف __setup__ التسلسلي على ~١٠٢ جدولاً قد
  // يتجاوز مهلة الخطّاف على قاعدة بطيئة فيحذف أثناء الحلقة (راجع attendanceListPagination).
  const bulk = Array.from({ length: 519 }, (_, i) => ({
    name: `احمد رقم ${String(i + 1).padStart(3, "0")}`,
    defaultPriceTier: "RETAIL" as const,
    currentBalance: "0",
    isActive: true,
  }));
  await d.insert(s.customers).values(bulk);
  // بحرف «ي» ⇒ آخر الترتيب الأبجدي بعد كل «احمد …» ⇒ الموضع ٥٢٠ ⇒ خارج سقف الـ٥٠٠ يقيناً.
  await d.insert(s.customers).values({ name: BEYOND, defaultPriceTier: "WHOLESALE", currentBalance: "0", isActive: true });
});

describe("منتقي العميل — ما بعد سقف الـ٥٠٠", () => {
  it("الحقيقة الأساس: العدد ٥٢٠ بينما list تقتطع عند ٥٠٠ (سبب الخلل)", async () => {
    const all = await caller().customers.search({ limit: 2000 });
    expect(all.total).toBe(520);

    // المسار القديم: قائمة مقصوصة صلباً ⇒ الحدّي **غائب**.
    const legacy = await caller().customers.list();
    expect(legacy).toHaveLength(500);
    expect(legacy.map((c) => c.name)).not.toContain(BEYOND);
  });

  it("المسار الجديد: البحث يجد العميل الحدّي (وهو ما تستعمله الواجهة الآن)", async () => {
    const found = await caller().customers.search({ q: "ياسر", limit: 20 });
    expect(found.rows.map((c) => c.name)).toContain(BEYOND);
    expect(found.total).toBe(1);
  });

  it("التطبيع العربي يعمل في البحث الخادميّ («اسماعيل» بلا همزة تجد «إسماعيل») — لم تكن الفلترة المحلّية تفعله", async () => {
    const folded = await caller().customers.search({ q: "اسماعيل", limit: 20 });
    expect(folded.rows.map((c) => c.name)).toContain(BEYOND);
  });

  it("get بـid يُعيد العميل الحدّي (اسم المختار في المنتقي/الإيصال — كان يخرج فارغاً)", async () => {
    const found = await caller().customers.search({ q: "ياسر", limit: 5 });
    const id = found.rows[0].id;
    const got = await caller().customers.get({ customerId: id });
    expect(got?.name).toBe(BEYOND);
    expect(got?.defaultPriceTier).toBe("WHOLESALE"); // الفئة تصل ⇒ التسعير الصحيح ممكن
  });

  it("البحث يضيّق فعلاً (لا يُعيد الكل عند q غير مطابق) و«%» مُهرَّبة", async () => {
    expect((await caller().customers.search({ q: "لا-يوجد-هذا-الاسم", limit: 20 })).total).toBe(0);
    expect((await caller().customers.search({ q: "%", limit: 20 })).total).toBe(0);
  });

  it("سقف search أعلى بكثير (٢٠٠٠) ويحترم offset ⇒ لا اقتطاع صامت", async () => {
    const p1 = await caller().customers.search({ limit: 300, offset: 0 });
    const p2 = await caller().customers.search({ limit: 300, offset: 300 });
    expect(p1.rows).toHaveLength(300);
    expect(p2.rows).toHaveLength(220); // 520 − 300
    const ids = new Set([...p1.rows, ...p2.rows].map((c) => c.id));
    expect(ids.size).toBe(520); // لا تكرار ولا فقد
  });
});
