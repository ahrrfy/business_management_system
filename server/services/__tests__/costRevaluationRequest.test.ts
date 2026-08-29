/**
 * إعادة تقييم تكلفة المخزون المحكومة — المسار الذي لم يكن موجوداً.
 *
 * التعديل اليدويّ لتكلفة صنفٍ له رصيد مُغلقٌ بنيوياً (`costRevaluation.ts`) لأنّه يحرّك أصل
 * المخزون بلا قيدٍ مقابل ⇒ حركةُ حقوقِ ملكيةٍ صامتة (تدقيق ٢٧/٧ H3/H4). لكنّ الإغلاق ترك
 * النظام **بلا أيّ طريق** لتصحيح تكلفةٍ خاطئة على صنفٍ قائم. هذه الحزمة تُثبت أنّ الطريق
 * الجديد يفتح ذلك الباب **محكوماً**: مستندٌ بغرضٍ وسبب، اعتمادٌ ثانٍ، قيدٌ لكل فرع، وحارس فترة.
 */
import { and, eq, like } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  approveCostRevaluation,
  getCostRevaluationPreview,
  listCostRevaluations,
  rejectCostRevaluation,
  requestCostRevaluation,
} from "../inventory/costRevaluationRequest";
import { money } from "../money";
import { truncateTables } from "./__testUtils__";

const TABLES = [
  "auditLogs",
  "accountingEntries",
  "costRevaluationRequests",
  "financialPeriods",
  "branchStock",
  "productVariants",
  "products",
  "branches",
  "users",
];

const admin = { userId: 1, branchId: 1, role: "admin" as const };
const mgr1 = { userId: 2, branchId: 1, role: "manager" as const };
const mgr1b = { userId: 3, branchId: 1, role: "manager" as const };
const mgr2 = { userId: 4, branchId: 2, role: "manager" as const };
const admin2 = { userId: 5, branchId: 1, role: "admin" as const };

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function seed(opts: { cost?: string; qty1?: number; qty2?: number; consignment?: boolean } = {}) {
  await db().insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
  await db().insert(s.users).values([
    { id: 1, openId: "u-admin", name: "أدمن", role: "admin", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "u-mgr1", name: "مدير ١", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "u-mgr1b", name: "مدير ١ب", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 4, openId: "u-mgr2", name: "مدير ٢", role: "manager", loginMethod: "local", branchId: 2 },
    { id: 5, openId: "u-admin2", name: "أدمن ٢", role: "admin", loginMethod: "local", branchId: 1 },
  ]);
  await db().insert(s.products).values([{ id: 1, name: "قلم", isConsignment: !!opts.consignment }]);
  await db().insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "PEN-1", costPrice: opts.cost ?? "100.00" },
  ]);
  const stock: Array<{ variantId: number; branchId: number; quantity: number }> = [];
  if (opts.qty1 !== 0) stock.push({ variantId: 1, branchId: 1, quantity: opts.qty1 ?? 10 });
  if (opts.qty2) stock.push({ variantId: 1, branchId: 2, quantity: opts.qty2 });
  if (stock.length) await db().insert(s.branchStock).values(stock);
}

async function entries() {
  return db()
    .select()
    .from(s.accountingEntries)
    .where(and(eq(s.accountingEntries.entryType, "ADJUST"), like(s.accountingEntries.dedupeKey, "COST_REVAL:%")));
}

async function variantCost(): Promise<string> {
  const v = (await db().select().from(s.productVariants).where(eq(s.productVariants.id, 1)))[0];
  return money(v.costPrice ?? 0).toFixed(2);
}

const REASON = "تكلفة أُدخلت خطأً عند الاستلام اليدويّ";

beforeEach(async () => {
  await truncateTables(TABLES);
});

describe("requestCostRevaluation — المستند قبل الأثر", () => {
  it("الطلب لا يمسّ التكلفة ولا الدفتر، ويحسب أثر القيمة المتوقَّع", async () => {
    await seed({ cost: "100.00", qty1: 10 });
    const res = await requestCostRevaluation(
      { variantId: 1, newCost: "80.00", purpose: "CORRECTION", reason: REASON },
      mgr1,
    );
    expect(res.oldCost).toBe("100.00");
    expect(res.expectedQuantity).toBe(10);
    expect(res.expectedValueDelta).toBe("-200.00");

    expect(await variantCost()).toBe("100.00");
    expect(await entries()).toHaveLength(0);
    const rows = await listCostRevaluations({ status: "PENDING_APPROVAL" }, mgr1);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("PENDING_APPROVAL");
    expect(rows[0].reason).toBe(REASON);
  });

  it("يرفض سبباً أقصر من عشرة محارف — لا حركة قيمةٍ بلا مستند", async () => {
    await seed();
    await expect(
      requestCostRevaluation({ variantId: 1, newCost: "80.00", purpose: "CORRECTION", reason: "خطأ" }, mgr1),
    ).rejects.toThrow(/سبب إعادة التقييم إلزاميّ/);
  });

  it("«هبوط القيمة» لا يرفع التكلفة — الغرض يحدّد الحساب المقابل فلا يُقلَب", async () => {
    await seed({ cost: "100.00" });
    await expect(
      requestCostRevaluation({ variantId: 1, newCost: "150.00", purpose: "IMPAIRMENT", reason: REASON }, mgr1),
    ).rejects.toThrow(/هبوط القيمة لا يرفع التكلفة/);
  });

  it("يرفض تكلفةً مساويةً للحالية، وبضاعةَ الأمانة", async () => {
    await seed({ cost: "100.00" });
    await expect(
      requestCostRevaluation({ variantId: 1, newCost: "100.00", purpose: "CORRECTION", reason: REASON }, mgr1),
    ).rejects.toThrow(/تساوي الحالية/);

    await db().update(s.products).set({ isConsignment: true }).where(eq(s.products.id, 1));
    await expect(
      requestCostRevaluation({ variantId: 1, newCost: "90.00", purpose: "CORRECTION", reason: REASON }, mgr1),
    ).rejects.toThrow(/بضاعة الأمانة/);
  });

  it("طلبٌ معلَّقٌ واحدٌ لكل صنف — الثاني يُحسب من أساسٍ سيزول", async () => {
    await seed();
    await requestCostRevaluation({ variantId: 1, newCost: "80.00", purpose: "CORRECTION", reason: REASON }, mgr1);
    await expect(
      requestCostRevaluation({ variantId: 1, newCost: "70.00", purpose: "CORRECTION", reason: REASON }, mgr1),
    ).rejects.toThrow(/طلب إعادة تقييمٍ معلَّق/);
  });

  it("عزل الفرع: التكلفة عامّة ⇒ مدير فرعٍ لا يطلبها وللصنف رصيدٌ في فرعٍ آخر", async () => {
    await seed({ qty1: 10, qty2: 4 });
    await expect(
      requestCostRevaluation({ variantId: 1, newCost: "80.00", purpose: "CORRECTION", reason: REASON }, mgr1),
    ).rejects.toThrow(/رصيدٌ في فرعٍ آخر/);
    // والإدارة تعبُر الفروع.
    const res = await requestCostRevaluation(
      { variantId: 1, newCost: "80.00", purpose: "CORRECTION", reason: REASON },
      admin,
    );
    expect(res.expectedQuantity).toBe(14);
    expect(res.expectedValueDelta).toBe("-280.00");
  });
});

describe("approveCostRevaluation — الأثر عند الاعتماد وحده", () => {
  it("يحدّث التكلفة ويُرحّل قيداً لكل فرعٍ له رصيد (خسارة عند النزول)", async () => {
    await seed({ cost: "100.00", qty1: 10, qty2: 4 });
    const req = await requestCostRevaluation(
      { variantId: 1, newCost: "80.00", purpose: "CORRECTION", reason: REASON },
      admin,
    );
    // معتمِدٌ يعبُر الفروع (الأثر يقع على فرعين) وغيرُ الطالب — الشرطان معاً.
    const res = await approveCostRevaluation(req.requestId, admin2);

    expect(await variantCost()).toBe("80.00");
    expect(res.postedEntries).toBe(2);
    expect(res.totalValueDelta).toBe("-280.00");

    const rows = await entries();
    expect(rows).toHaveLength(2);
    const byBranch = new Map(rows.map((r) => [Number(r.branchId), r]));
    // الأثر يتبع كميّة كل فرعٍ على حدة — لا مجموعٌ يُحمَّل على فرع المُعتمِد.
    expect(money(byBranch.get(1)!.profit ?? 0).toFixed(2)).toBe("-200.00");
    expect(money(byBranch.get(2)!.profit ?? 0).toFixed(2)).toBe("-80.00");
    // الخسارة تُخفض التكلفة سالباً وتُبقي amount صفراً: حركة قيمةٍ بلا نقد.
    expect(money(byBranch.get(1)!.cost ?? 0).toFixed(2)).toBe("200.00");
    expect(money(byBranch.get(1)!.amount ?? 0).toFixed(2)).toBe("0.00");

    const audit = (await db().select().from(s.auditLogs).where(eq(s.auditLogs.action, "product.costRevaluation")))[0];
    expect(audit).toBeTruthy();
    expect((audit.oldValue as { costPrice: string }).costPrice).toBe("100.00");
    expect((audit.newValue as { costPrice: string; reason: string }).costPrice).toBe("80.00");
    expect((audit.newValue as { reason: string }).reason).toBe(REASON);
  });

  it("الرفع يُرحَّل ربحاً موجباً بنفس الميزان", async () => {
    await seed({ cost: "100.00", qty1: 5 });
    const req = await requestCostRevaluation(
      { variantId: 1, newCost: "130.00", purpose: "CORRECTION", reason: REASON },
      mgr1,
    );
    const res = await approveCostRevaluation(req.requestId, mgr1b);
    expect(res.totalValueDelta).toBe("150.00");
    const rows = await entries();
    expect(money(rows[0].profit ?? 0).toFixed(2)).toBe("150.00");
    expect(money(rows[0].cost ?? 0).toFixed(2)).toBe("-150.00");
  });

  it("صنفٌ بلا رصيد: التكلفة تُصحَّح بلا قيد (لا أصل تحرّك)", async () => {
    await seed({ cost: "100.00", qty1: 0 });
    const req = await requestCostRevaluation(
      { variantId: 1, newCost: "40.00", purpose: "CORRECTION", reason: REASON },
      mgr1,
    );
    const res = await approveCostRevaluation(req.requestId, mgr1b);
    expect(res.postedEntries).toBe(0);
    expect(await variantCost()).toBe("40.00");
    expect(await entries()).toHaveLength(0);
  });

  it("فصل المهام: لا يعتمد طالبُه (والأدمن مستثنى للتصحيح الإداريّ)", async () => {
    await seed();
    const req = await requestCostRevaluation(
      { variantId: 1, newCost: "80.00", purpose: "CORRECTION", reason: REASON },
      mgr1,
    );
    await expect(approveCostRevaluation(req.requestId, mgr1)).rejects.toThrow(/طلبتها بنفسك/);
    await expect(approveCostRevaluation(req.requestId, mgr1b)).resolves.toMatchObject({ postedEntries: 1 });
  });

  it("انحراف التكلفة منذ الطلب يُرفَض — الفرق محسوبٌ على أساسٍ زال", async () => {
    await seed({ cost: "100.00" });
    const req = await requestCostRevaluation(
      { variantId: 1, newCost: "80.00", purpose: "CORRECTION", reason: REASON },
      mgr1,
    );
    await db().update(s.productVariants).set({ costPrice: "110.00" }).where(eq(s.productVariants.id, 1));
    await expect(approveCostRevaluation(req.requestId, mgr1b)).rejects.toThrow(/تغيّرت تكلفة الصنف منذ الطلب/);
    expect(await variantCost()).toBe("110.00");
    expect(await entries()).toHaveLength(0);
  });

  it("انحراف الكمّية منذ الطلب يُرفَض — الأثر = Δالتكلفة × الكمية", async () => {
    await seed({ cost: "100.00", qty1: 10 });
    const req = await requestCostRevaluation(
      { variantId: 1, newCost: "80.00", purpose: "CORRECTION", reason: REASON },
      mgr1,
    );
    await db().update(s.branchStock).set({ quantity: 7 }).where(eq(s.branchStock.variantId, 1));
    await expect(approveCostRevaluation(req.requestId, mgr1b)).rejects.toThrow(/تغيّرت كميّات الصنف منذ الطلب/);
    expect(await variantCost()).toBe("100.00");
    expect(await entries()).toHaveLength(0);
  });

  it("الفترة المقفلة تمنع الاعتماد كلَّه — التكلفة لا تتحرّك بلا قيدها", async () => {
    await seed({ cost: "100.00", qty1: 10 });
    const req = await requestCostRevaluation(
      { variantId: 1, newCost: "80.00", purpose: "CORRECTION", reason: REASON },
      mgr1,
    );
    // قفلٌ يشمل اليوم ⇒ postEntry يرمي ⇒ ترتدّ المعاملة كاملةً (التكلفة + السجلّ + الحالة).
    const today = new Date().toISOString().slice(0, 10);
    await db().insert(s.financialPeriods).values({ cutoffDate: today, lockedBy: 1, status: "LOCKED" });

    await expect(approveCostRevaluation(req.requestId, mgr1b)).rejects.toThrow(/الفترة المالية مُقفَلة/);
    expect(await variantCost()).toBe("100.00");
    expect(await entries()).toHaveLength(0);
    const rows = await listCostRevaluations({ status: "PENDING_APPROVAL" }, admin);
    expect(rows).toHaveLength(1);
    expect(await db().select().from(s.auditLogs).where(eq(s.auditLogs.action, "product.costRevaluation"))).toHaveLength(0);
  });

  it("لا يُعتمد طلبٌ محسوم مرّتين", async () => {
    await seed();
    const req = await requestCostRevaluation(
      { variantId: 1, newCost: "80.00", purpose: "CORRECTION", reason: REASON },
      mgr1,
    );
    await approveCostRevaluation(req.requestId, mgr1b);
    await expect(approveCostRevaluation(req.requestId, mgr1b)).rejects.toThrow(/ليس في انتظار الموافقة/);
    expect(await entries()).toHaveLength(1);
  });

  it("عزل الفرع عند الاعتماد أيضاً: مدير فرعٍ لا يعتمد أثراً يقع على فرعٍ آخر", async () => {
    await seed({ qty1: 10, qty2: 4 });
    const req = await requestCostRevaluation(
      { variantId: 1, newCost: "80.00", purpose: "CORRECTION", reason: REASON },
      admin,
    );
    await expect(approveCostRevaluation(req.requestId, mgr2)).rejects.toThrow(/فرعٍ آخر/);
    expect(await variantCost()).toBe("100.00");
  });

  it("عزل الفرع يبقى نافذاً عند صفر المخزون — لا موافقة ولا رفض لطلب فرعٍ آخر", async () => {
    await seed({ qty1: 0 });
    const req = await requestCostRevaluation(
      { variantId: 1, newCost: "80.00", purpose: "CORRECTION", reason: REASON },
      mgr1,
    );

    await expect(approveCostRevaluation(req.requestId, mgr2)).rejects.toThrow(/فرعٍ آخر/);
    await expect(rejectCostRevaluation(req.requestId, mgr2, "طلب لا يخص هذا الفرع")).rejects.toThrow(/فرعٍ آخر/);
    expect(await variantCost()).toBe("100.00");

    await rejectCostRevaluation(req.requestId, mgr1b, "الفاتورة الأصلية صحيحة");
    const rows = await listCostRevaluations({ status: "REJECTED", branchId: 1 }, mgr1b);
    expect(rows).toHaveLength(1);
  });
});

describe("rejectCostRevaluation + المعاينة", () => {
  it("الرفض بلا أيّ أثر", async () => {
    await seed();
    const req = await requestCostRevaluation(
      { variantId: 1, newCost: "80.00", purpose: "CORRECTION", reason: REASON },
      mgr1,
    );
    await rejectCostRevaluation(req.requestId, mgr1b, "الفاتورة الأصلية صحيحة");
    expect(await variantCost()).toBe("100.00");
    expect(await entries()).toHaveLength(0);
    const rows = await listCostRevaluations({ status: "REJECTED" }, admin);
    expect(rows[0].rejectionReason).toBe("الفاتورة الأصلية صحيحة");
    // ومحسومٌ لا يُعتمد بعدها.
    await expect(approveCostRevaluation(req.requestId, mgr1b)).rejects.toThrow(/ليس في انتظار الموافقة/);
  });

  it("المعاينة تُظهر التكلفة والكميّات لكل فرع قبل الإرسال", async () => {
    await seed({ cost: "100.00", qty1: 10, qty2: 4 });
    const pv = await getCostRevaluationPreview(1, admin);
    expect(pv.costPrice).toBe("100.00");
    expect(pv.totalQuantity).toBe(14);
    expect(pv.branches.map((b) => [b.branchId, b.quantity])).toEqual([[1, 10], [2, 4]]);
    expect(pv.branches[0].branchName).toBe("الرئيسي");
  });

  it("معاينة مدير الفرع لا تكشف اسم فرعٍ آخر أو كميته", async () => {
    await seed({ cost: "100.00", qty1: 10, qty2: 4 });
    const pv = await getCostRevaluationPreview(1, mgr1);
    expect(pv.totalQuantity).toBe(10);
    expect(pv.branches.map((b) => [b.branchId, b.quantity])).toEqual([[1, 10]]);
    expect(pv.branches.some((b) => b.branchName === "فرع المبيعات")).toBe(false);
  });
});
