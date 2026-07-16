// crm.coupons.listIssued — الترقيم وعدّاد النشطة الخادميّ.
//
// الخلل المُعالَج: كانت `SELECT * FROM coupons WHERE programId=X ORDER BY id DESC` **بلا LIMIT**.
// برنامجٌ يُصدر كوبوناً لكل عميل (عملاء × حملات) يُعيد كل إصداراته دفعةً واحدة.
// وبعد الترقيم ظهر خطران لولا العلاج لَمرّا صامتين:
//   ك١) «طباعة النشطة» كانت تُمرَّر القائمة كاملةً ⇒ ستطبع **أوّل صفحة فقط** (ورقة ناقصة لا
//       يكتشفها أحد إلا بعد الطباعة) ⇒ العميل يجلب كل الصفحات صراحةً (fetchAllPaged).
//   ك٢) تعطيل الزرّ كان يعتمد «هل في الصفوف المُحمَّلة نشطة؟» ⇒ يُعطَّل زوراً إن لم تكن نشطةٌ في
//       الصفحة الأولى ⇒ `activeCount` عدٌّ خادميّ على كل البرنامج.
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import type { TrpcContext } from "../../context";
import { appRouter } from "../../routers";
import { getDb } from "../../db";
import { hashCouponCode } from "../couponService";
import { createPromotion } from "../salesPromotionService";
import { withTx } from "../tx";
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

const TABLES = [
  "couponRedemptions", "coupons", "couponPrograms", "crmCampaigns",
  "promotions", "branchStock", "productUnits", "productVariants", "products",
  "categories", "customers", "branches", "users", "auditLogs",
];

let programId = 0;

beforeEach(async () => {
  await truncateTables(TABLES);
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({ id: 1, openId: "t", name: "admin", role: "admin", loginMethod: "local" });
  const promotionId = await withTx((tx) => createPromotion(tx, {
    name: "كوبون 10%", type: "PERCENT", discountPercent: "10", scope: "ALL",
    effectiveFrom: "2026-01-01", effectiveTo: "2027-01-01", branchId: 1, applicationMode: "COUPON",
  }, 1));
  const res = await d.insert(s.couponPrograms).values({
    promotionId, name: "برنامج اختباري", status: "ACTIVE", branchId: 1,
    validFrom: new Date("2026-01-01"), validTo: new Date("2027-01-01"),
    perCouponLimit: 1, perCustomerLimit: 1, codePrefix: "CRM", createdBy: 1,
  });
  programId = Number((res as any)[0]?.insertId ?? (res as any).insertId);

  // ١٢٠ كوبوناً **دفعةً واحدة** (لا حلقة — تنظيف __setup__ التسلسلي قد يحذف أثناءها؛ راجع
  // attendanceListPagination). النشطة كلّها في **الأقدم** عمداً: الترتيب desc(id) يضعها في آخر
  // صفحة ⇒ يكشف الاعتماد على «الصفحة الأولى» في عدّ النشطة (ك٢).
  const rows = Array.from({ length: 120 }, (_, i) => {
    const code = `CRM-${String(i + 1).padStart(4, "0")}`;
    return {
      programId,
      code,
      codeHash: hashCouponCode(code),
      status: (i < 5 ? "ACTIVE" : "VOID") as "ACTIVE" | "VOID",
    };
  });
  await db().insert(s.coupons).values(rows);
});

describe("crm.coupons.listIssued — ترقيم + عدّ نشطة خادميّ", () => {
  it("الصفحة محدودة بينما total للبرنامج كلّه (كان يُعيد الـ١٢٠ دفعةً)", async () => {
    const p1 = await caller().crm.coupons.listIssued({ programId, limit: 20, offset: 0 });
    expect(p1.rows).toHaveLength(20);
    expect(p1.total).toBe(120);
  });

  it("ك٢: activeCount خادميّ = نشطة البرنامج كلّه ولو غابت عن الصفحة الأولى", async () => {
    // الترتيب desc(id) ⇒ الصفحة الأولى كلّها VOID (النشطة في الأقدم).
    const p1 = await caller().crm.coupons.listIssued({ programId, limit: 20, offset: 0 });
    expect(p1.rows.every((c) => c.status === "VOID")).toBe(true);
    // ومع ذلك العدّاد يرى الخمسة ⇒ زرّ «طباعة النشطة» يبقى مُفعَّلاً بحق.
    expect(p1.activeCount).toBe(5);
  });

  it("العدّاد والإجمالي ثابتان عبر الصفحات (لا يتبعان طول الصفحة)", async () => {
    const p1 = await caller().crm.coupons.listIssued({ programId, limit: 50, offset: 0 });
    const p3 = await caller().crm.coupons.listIssued({ programId, limit: 50, offset: 100 });
    expect(p3.rows).toHaveLength(20); // 120 − 100
    expect(p3.total).toBe(p1.total);
    expect(p3.activeCount).toBe(p1.activeCount);
    // الصفحة الأخيرة هي التي تحوي النشطة (الأقدم).
    expect(p3.rows.filter((c) => c.status === "ACTIVE")).toHaveLength(5);
  });

  it("offset يتنقّل بلا تكرار ولا فقد (تجميع الصفحات = البرنامج كلّه)", async () => {
    const ids: number[] = [];
    for (let off = 0; off < 120; off += 40) {
      const p = await caller().crm.coupons.listIssued({ programId, limit: 40, offset: off });
      ids.push(...p.rows.map((c) => c.id));
    }
    expect(ids).toHaveLength(120);
    expect(new Set(ids).size).toBe(120);
  });

  it("سقف limit مفروض خادمياً (٥٠٠) — لا يُمرَّر رقم ضخم فيُمسح الجدول", async () => {
    await expect(caller().crm.coupons.listIssued({ programId, limit: 999999 })).rejects.toThrow();
  });

  it("برنامج غير موجود ⇒ NOT_FOUND (الحارس القائم لم ينكسر)", async () => {
    await expect(caller().crm.coupons.listIssued({ programId: 999999 })).rejects.toThrow();
  });
});
