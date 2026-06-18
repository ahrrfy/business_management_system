// اختبارات تشغيلية لوحدة «الجرد والتسوية» — stocktakeService (العقد docs/stocktake-contract.md).
//
// تغطّي: ذرّية اللقطة وصحّة expectedQty/unitCost، تفرّد الرمز المتسلسل، توزيع التكليفات
// (المُدّعى لصاحبه وغير المُكلَّف كتلاً متتالية متساوية ±1 بترتيب variantId)، معادلة
// الفرق مع الحركات بعد العدّ، الحدود (نسبة/قيمة)، حواجز
// الاعتماد (إعادة عدّ معلّقة/تعارض/فوق الحد بلا قرار)، التوقيع المزدوج (يرفض نفس
// المستخدم ويقبل مستخدمَين)، والاعتماد الذرّي الكامل: setStock بمرجع STOCKTAKE + قيدا
// دفتر بـdedupeKey فريد + قرارات تلقائية (ADJUST ضمن الحد وKEEP للمطابق) + lastCountedAt
// + تكرار approve بلا أثر + ROLLBACK كامل عند فشل وسط الاعتماد.
import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { applyMovement } from "../inventoryService";
import {
  approveStocktake,
  cancelStocktakeSession,
  computeStocktakeReview,
  createStocktakeSession,
  decideStocktakeItem,
  firstSignStocktake,
  forceStocktakeReview,
  getStocktakeCountSheets,
  monitorStocktakeSession,
  requestStocktakeRecount,
  resolveStocktakeConflict,
  type CreateStocktakeInput,
} from "../stocktakeService";
import { withTx } from "../tx";
import { truncateTables } from "./__testUtils__";

const actor = { userId: 1 };
const actor2 = { userId: 2 };

// قائمة truncate: جداول الجرد الخمسة + كل جداول الأساس التي تمسّها الاختبارات.
const TABLES = [
  "stocktakeDecisions",
  "stocktakeCounts",
  "stocktakeItems",
  "stocktakeAssignments",
  "stocktakeSessions",
  "accountingEntries",
  "inventoryMovements",
  "branchStock",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
  "auditLogs",
  "categories",
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
  await truncateTables(TABLES);
}

/** بذرة أساس خاصة بالاختبار: فرعان + مستخدمان (أدمن/مدير) + ٥ متغيّرات بتكاليف متدرّجة. */
async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "local_admin", name: "أحمد المدير", role: "admin", loginMethod: "local" },
    { id: 2, openId: "local_manager", name: "سالم المشرف", role: "manager", loginMethod: "local" },
  ]);
  await d.insert(s.products).values([
    { id: 1, name: "قلم جاف" },
    { id: 2, name: "دفتر 100 ورقة" },
    { id: 3, name: "حبر طابعة HP" },
    { id: 4, name: "تونر ليزر" },
    { id: 5, name: "وشاح تخرج" },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "PEN-1", costPrice: "100.00" },
    { id: 2, productId: 2, sku: "NB-1", costPrice: "50.00" },
    { id: 3, productId: 3, sku: "INK-1", costPrice: "10000.00" },
    { id: 4, productId: 4, sku: "TON-1", costPrice: "100000.00" },
    { id: 5, productId: 5, sku: "SASH-1", costPrice: "25.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: "BC-PEN-1" },
    { id: 2, variantId: 1, unitName: "درزن", conversionFactor: "12", isBaseUnit: false, barcode: "BC-PEN-12" },
    { id: 3, variantId: 2, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 4, variantId: 3, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 5, variantId: 4, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 6, variantId: 5, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
  ]);
}

async function setStockRow(variantId: number, qty: number, branchId = 1) {
  await db().insert(s.branchStock).values({ variantId, branchId, quantity: qty });
}

async function stockOf(variantId: number, branchId = 1): Promise<number> {
  const rows = await db()
    .select({ q: s.branchStock.quantity })
    .from(s.branchStock)
    .where(and(eq(s.branchStock.variantId, variantId), eq(s.branchStock.branchId, branchId)));
  return rows[0]?.q ?? 0;
}

async function mkSession(over: Partial<CreateStocktakeInput> = {}) {
  return createStocktakeSession(
    {
      name: "جرد اختبار",
      branchId: 1,
      scopeType: "MANUAL",
      variantIds: [1, 2, 3],
      assignments: [{ name: "عامل أ", method: "PIN" }],
      ...over,
    },
    actor
  );
}

/** إدراج عدّة مباشرة (الاختبارات الخدمية لا تمرّ بالبوابة) — افتراضياً FIRST قبل ٥ ثوانٍ. */
async function insertCount(
  sessionId: number,
  variantId: number,
  assignmentId: number,
  qty: number,
  opts: { kind?: "FIRST" | "RECOUNT" | "VERIFY"; at?: Date; byName?: string; isConflict?: boolean } = {}
) {
  await db().insert(s.stocktakeCounts).values({
    sessionId,
    variantId,
    assignmentId,
    kind: opts.kind ?? "FIRST",
    qty,
    countedByName: opts.byName ?? "عامل الاختبار",
    countedAt: opts.at ?? new Date(Date.now() - 5_000),
    isConflict: opts.isConflict ?? false,
    clientRequestId: randomUUID(),
  });
}

async function stocktakeMovements(sessionId: number) {
  return db()
    .select()
    .from(s.inventoryMovements)
    .where(and(eq(s.inventoryMovements.referenceType, "STOCKTAKE"), eq(s.inventoryMovements.referenceId, sessionId)));
}

async function adjustEntries() {
  return db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "ADJUST"));
}

async function expectTrpc(p: Promise<unknown>, code: string, msg?: RegExp) {
  let err: unknown = null;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(TRPCError);
  expect((err as TRPCError).code).toBe(code);
  if (msg) expect((err as TRPCError).message).toMatch(msg);
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("الإنشاء واللقطة", () => {
  it("اللقطة الذرّية: expectedQty من رصيد الفرع وunitCost من تكلفة المتغيّر — ولا تتأثر بتغيير لاحق", async () => {
    await setStockRow(1, 50);
    // المتغيّر 2 بلا صفّ رصيد ⇒ اللقطة 0. المتغيّر 3 برصيد 20.
    await setStockRow(3, 20);
    // رصيد في فرع آخر يجب ألّا يتسرّب للقطة فرعنا.
    await setStockRow(1, 999, 2);

    const r = await mkSession();
    expect(r.itemCount).toBe(3);
    // CNT-YYYY-NNNN-RAND4 (إصلاح أمني: لاحقة عشوائية تمنع تخمين الرمز عبر publicProcedure count.auth).
    expect(r.code).toMatch(new RegExp(`^CNT-${new Date().getFullYear()}-0001-[0-9A-Z]{4}$`));

    const items = await db().select().from(s.stocktakeItems).where(eq(s.stocktakeItems.sessionId, r.sessionId));
    expect(items).toHaveLength(3);
    const byVariant = new Map(items.map((i) => [Number(i.variantId), i]));
    expect(byVariant.get(1)!.expectedQty).toBe(50);
    expect(byVariant.get(1)!.unitCost).toBe("100.00");
    expect(byVariant.get(2)!.expectedQty).toBe(0);
    expect(byVariant.get(2)!.unitCost).toBe("50.00");
    expect(byVariant.get(3)!.expectedQty).toBe(20);
    expect(byVariant.get(3)!.unitCost).toBe("10000.00");
    expect(items.every((i) => Number(i.branchId) === 1)).toBe(true);

    // تغيير التكلفة بعد الإنشاء لا يغيّر اللقطة (تقييم الفرق يثبت عليها).
    await db().update(s.productVariants).set({ costPrice: "777.00" }).where(eq(s.productVariants.id, 1));
    const after = await db()
      .select()
      .from(s.stocktakeItems)
      .where(and(eq(s.stocktakeItems.sessionId, r.sessionId), eq(s.stocktakeItems.variantId, 1)));
    expect(after[0].unitCost).toBe("100.00");

    // PIN يُعاد نصاً مرة واحدة ولا يُخزَّن إلا hash.
    expect(r.assignments[0].pin).toMatch(/^\d{4}$/);
    const asg = (await db().select().from(s.stocktakeAssignments).where(eq(s.stocktakeAssignments.sessionId, r.sessionId)))[0];
    expect(asg.pinHash).toBeTruthy();
    expect(asg.pinHash).not.toBe(r.assignments[0].pin);
  });

  it("ذرّية الإنشاء: تكليف بصنف خارج النطاق ⇒ فشل كامل بلا أي صفّ مكتوب", async () => {
    await setStockRow(1, 10);
    await expectTrpc(
      mkSession({ assignments: [{ name: "عامل أ", method: "PIN", variantIds: [999] }] }),
      "BAD_REQUEST",
      /خارج نطاق/
    );
    expect(await db().select().from(s.stocktakeSessions)).toHaveLength(0);
    expect(await db().select().from(s.stocktakeAssignments)).toHaveLength(0);
    expect(await db().select().from(s.stocktakeItems)).toHaveLength(0);
  });

  it("تفرّد الرمز: تسلسل CNT-<السنة>-NNNN-RAND4، وإنشاءان متزامنان لا يتصادمان", async () => {
    await setStockRow(1, 10);
    const year = new Date().getFullYear();
    const r1 = await mkSession({ variantIds: [1] });
    const r2 = await mkSession({ variantIds: [1] });
    // البادئة التسلسلية تُبقي القراءة البشرية والترتيب، واللاحقة العشوائية تمنع تخمين الرمز.
    expect(r1.code).toMatch(new RegExp(`^CNT-${year}-0001-[0-9A-Z]{4}$`));
    expect(r2.code).toMatch(new RegExp(`^CNT-${year}-0002-[0-9A-Z]{4}$`));

    const [r3, r4] = await Promise.all([mkSession({ variantIds: [1] }), mkSession({ variantIds: [1] })]);
    const codes = [r1.code, r2.code, r3.code, r4.code];
    expect(new Set(codes).size).toBe(4);
    const all = await db().select({ code: s.stocktakeSessions.code }).from(s.stocktakeSessions);
    expect(all).toHaveLength(4);
  });

  it("توزيع التكليفات: المُدّعى لصاحبه، وغير المُكلَّف كتلاً متتالية متساوية (±1) بترتيب variantId", async () => {
    for (const v of [1, 2, 3, 4, 5]) await setStockRow(v, 10);

    const ownedBy = async (sessionId: number, assignmentId: number) => {
      const items = await db().select().from(s.stocktakeItems).where(eq(s.stocktakeItems.sessionId, sessionId));
      return items
        .filter((i) => Number(i.assignmentId) === assignmentId)
        .map((i) => Number(i.variantId))
        .sort((a, b) => a - b);
    };

    // ب يدّعي {2} ⇒ غير المُكلَّف {1,3,4,5} يُقسَم كتلتين متتاليتين متساويتين: أ←{1,3}، ب←{4,5}+ادعاؤه.
    const r = await mkSession({
      variantIds: [1, 2, 3, 4, 5],
      assignments: [
        { name: "عامل أ", method: "PIN" },
        { name: "عامل ب", method: "PIN", variantIds: [2] },
      ],
    });
    expect(r.assignments[0].itemCount).toBe(2);
    expect(r.assignments[1].itemCount).toBe(3);
    expect(await ownedBy(r.sessionId, r.assignments[0].assignmentId)).toEqual([1, 3]);
    expect(await ownedBy(r.sessionId, r.assignments[1].assignmentId)).toEqual([2, 4, 5]);

    // قسمة غير متكافئة: 5 أصناف بلا ادعاءات على تكليفين ⇒ كتلتان 3 و2 (±1) متتاليتان تصاعدياً.
    const r2 = await mkSession({
      variantIds: [1, 2, 3, 4, 5],
      assignments: [
        { name: "عامل أ", method: "PIN" },
        { name: "عامل ب", method: "PIN" },
      ],
    });
    expect(r2.assignments[0].itemCount).toBe(3);
    expect(r2.assignments[1].itemCount).toBe(2);
    expect(await ownedBy(r2.sessionId, r2.assignments[0].assignmentId)).toEqual([1, 2, 3]);
    expect(await ownedBy(r2.sessionId, r2.assignments[1].assignmentId)).toEqual([4, 5]);

    // تكليف واحد ⇒ السلوك القديم نفسه: كل النطاق له.
    const r3 = await mkSession({ variantIds: [1, 2, 3] });
    expect(r3.assignments[0].itemCount).toBe(3);
    expect(await ownedBy(r3.sessionId, r3.assignments[0].assignmentId)).toEqual([1, 2, 3]);
  });
});

describe("معادلات المراجعة", () => {
  it("معادلة الفرق مع حركات بعد العدّ: بيع OUT بعد countedAt يصحَّح فيطابق (diff=0)", async () => {
    await setStockRow(1, 20);
    const r = await mkSession({ variantIds: [1] });
    // عدّ قبل دقيقة (20 مطابقة للدفتر لحظتها)، ثم بيع 5 بعده ⇒ الدفتر الآن 15.
    await insertCount(r.sessionId, 1, r.assignments[0].assignmentId, 20, { at: new Date(Date.now() - 60_000) });
    await withTx((tx) =>
      applyMovement(tx, {
        variantId: 1,
        branchId: 1,
        baseQuantity: 5,
        movementType: "OUT",
        referenceType: "INVOICE",
        referenceId: 77,
        createdBy: 1,
      })
    );
    expect(await stockOf(1)).toBe(15);

    const rv = await computeStocktakeReview(r.sessionId, { viewerId: 1 });
    const row = rv.rows.find((x) => x.variantId === 1)!;
    expect(row.rawCount).toBe(20);
    expect(row.kindUsed).toBe("FIRST");
    expect(row.movesAfter).toHaveLength(1);
    expect(row.movesAfter[0].qty).toBe(-5);
    expect(row.netAfter).toBe(-5);
    expect(row.adjustedCount).toBe(15); // rawCount + netAfter
    expect(row.bookNow).toBe(15);
    expect(row.diff).toBe(0); // التصحيح الآلي أعاد المطابقة
    expect(row.value).toBe("0.00");
    expect(rv.totals.matched).toBe(1);

    // autoAdjust=false ⇒ بلا تصحيح: adjustedCount = rawCount والفرق الظاهري +5.
    const rvRaw = await computeStocktakeReview(r.sessionId, { autoAdjust: false, viewerId: 1 });
    const rowRaw = rvRaw.rows.find((x) => x.variantId === 1)!;
    expect(rowRaw.adjustedCount).toBe(20);
    expect(rowRaw.diff).toBe(5);
    expect(rowRaw.value).toBe("500.00");
  });

  it("الحدود: ضمن الحد (نسبة وقيمة) / يتجاوز بالنسبة / يتجاوز بالقيمة", async () => {
    await setStockRow(1, 100); // تكلفة 100
    await setStockRow(2, 100); // تكلفة 50
    await setStockRow(3, 100); // تكلفة 10000
    const r = await mkSession({ variantIds: [1, 2, 3] });
    const aid = r.assignments[0].assignmentId;
    await insertCount(r.sessionId, 1, aid, 104); // ‎+4 ⇒ 4% و400 ⇒ ضمن الحد (5% / 25000)
    await insertCount(r.sessionId, 2, aid, 88); // ‎−12 ⇒ 12% > 5% ⇒ يتجاوز بالنسبة
    await insertCount(r.sessionId, 3, aid, 97); // ‎−3 ⇒ 3% لكن |القيمة| 30000 > 25000 ⇒ يتجاوز بالقيمة

    const rv = await computeStocktakeReview(r.sessionId, { viewerId: 1 });
    const m = new Map(rv.rows.map((x) => [x.variantId, x]));
    expect(m.get(1)!.withinThreshold).toBe(true);
    expect(m.get(1)!.overThreshold).toBe(false);
    expect(m.get(1)!.pct).toBe(4);
    expect(m.get(2)!.overThreshold).toBe(true);
    expect(m.get(2)!.pct).toBe(12);
    expect(m.get(2)!.value).toBe("-600.00");
    expect(m.get(3)!.overThreshold).toBe(true);
    expect(m.get(3)!.pct).toBe(3);
    expect(m.get(3)!.value).toBe("-30000.00");
    expect(rv.barriers.undecidedOverThreshold).toBe(2);
  });
});

describe("حواجز الاعتماد", () => {
  it("إعادة عدّ معلّقة تمنع الاعتماد حتى وصول العدّ الجديد", async () => {
    await setStockRow(1, 100);
    const r = await mkSession({ variantIds: [1] });
    const aid = r.assignments[0].assignmentId;
    await insertCount(r.sessionId, 1, aid, 99); // ‎−1 ⇒ 1% و100 ⇒ ضمن الحد
    await forceStocktakeReview(r.sessionId, actor);

    // طلب إعادة العدّ أثناء المراجعة يعيد فتح الجلسة، ثم نقفلها مجدداً والطلب ما زال معلّقاً.
    await requestStocktakeRecount({ sessionId: r.sessionId, variantId: 1, reason: "فرق غير مفهوم" }, actor);
    const reopened = (await db().select().from(s.stocktakeSessions).where(eq(s.stocktakeSessions.id, r.sessionId)))[0];
    expect(reopened.status).toBe("COUNTING");
    await forceStocktakeReview(r.sessionId, actor);

    const rv = await computeStocktakeReview(r.sessionId, { viewerId: 1 });
    expect(rv.barriers.pendingRecounts).toBe(1);
    expect(rv.barriers.canApprove).toBe(false);
    await expectTrpc(approveStocktake(r.sessionId, actor), "PRECONDITION_FAILED", /إعادة العدّ/);

    // وصول عدّ RECOUNT يفكّ الحاجز.
    await db()
      .update(s.stocktakeItems)
      .set({ recountStatus: "DONE" })
      .where(and(eq(s.stocktakeItems.sessionId, r.sessionId), eq(s.stocktakeItems.variantId, 1)));
    await insertCount(r.sessionId, 1, aid, 98, { kind: "RECOUNT" });
    const ok = await approveStocktake(r.sessionId, actor);
    expect(ok.ok).toBe(true);
    expect(await stockOf(1)).toBe(98); // RECOUNT يحلّ محل FIRST في الحساب
  });

  it("تعارض عدَّين مفتوح يمنع الاعتماد، والفصل (resolvedPick) يفكّه ويحدّد rawCount", async () => {
    await setStockRow(1, 100);
    const r = await mkSession({
      variantIds: [1],
      assignments: [
        { name: "عامل أ", method: "PIN", variantIds: [1] },
        { name: "عامل ب", method: "PIN" },
      ],
    });
    const [aidA, aidB] = [r.assignments[0].assignmentId, r.assignments[1].assignmentId];
    await insertCount(r.sessionId, 1, aidA, 100, { byName: "عامل أ" });
    await insertCount(r.sessionId, 1, aidB, 95, { kind: "VERIFY", byName: "عامل ب", isConflict: true });
    await forceStocktakeReview(r.sessionId, actor);

    const rv = await computeStocktakeReview(r.sessionId, { viewerId: 1 });
    expect(rv.barriers.openConflicts).toBe(1);
    const row = rv.rows.find((x) => x.variantId === 1)!;
    expect(row.conflict).toEqual({ qty1: 100, by1: "عامل أ", qty2: 95, by2: "عامل ب", resolvedPick: null });
    await expectTrpc(approveStocktake(r.sessionId, actor), "PRECONDITION_FAILED", /تعارض/);

    await resolveStocktakeConflict({ sessionId: r.sessionId, variantId: 1, pick: "VERIFY" }, actor);
    const rv2 = await computeStocktakeReview(r.sessionId, { viewerId: 1 });
    const row2 = rv2.rows.find((x) => x.variantId === 1)!;
    expect(row2.rawCount).toBe(95); // resolvedPick=VERIFY يحدّد القيمة الفعّالة
    expect(rv2.barriers.openConflicts).toBe(0);
    expect(rv2.barriers.canApprove).toBe(true);

    const ok = await approveStocktake(r.sessionId, actor); // ‎−5 ⇒ 5% و500 ⇒ ضمن الحد ⇒ تسوية تلقائية
    expect(ok.ok).toBe(true);
    expect(await stockOf(1)).toBe(95);
  });

  it("فوق الحد بلا قرار صريح يمنع الاعتماد، والقرار يفكّه", async () => {
    await setStockRow(2, 100);
    const r = await mkSession({ variantIds: [2] });
    await insertCount(r.sessionId, 2, r.assignments[0].assignmentId, 88); // 12% > 5% ⇒ فوق الحد
    await forceStocktakeReview(r.sessionId, actor);

    await expectTrpc(approveStocktake(r.sessionId, actor), "PRECONDITION_FAILED", /قرار/);
    await decideStocktakeItem(
      { sessionId: r.sessionId, variantId: 2, action: "ADJUST", reason: "DAMAGE", note: "كرتون تالف" },
      actor
    );
    const ok = await approveStocktake(r.sessionId, actor);
    expect(ok.ok).toBe(true);
    expect(await stockOf(2)).toBe(88);
  });

  it("التوقيع المزدوج: فوق dualThreshold يلزم توقيع أول واعتماد نهائي من مستخدم مختلف", async () => {
    await setStockRow(4, 10); // تكلفة 100,000
    const r = await mkSession({ variantIds: [4] });
    await insertCount(r.sessionId, 4, r.assignments[0].assignmentId, 8); // ‎−2 ⇒ ‎−200,000 > حد 150,000
    await forceStocktakeReview(r.sessionId, actor);
    await decideStocktakeItem({ sessionId: r.sessionId, variantId: 4, action: "ADJUST", reason: "LOSS_THEFT" }, actor);

    const rv = await computeStocktakeReview(r.sessionId, { viewerId: 1 });
    expect(rv.rows.find((x) => x.variantId === 4)!.requiresDualSign).toBe(true);
    expect(rv.barriers.requiresDualSign).toBe(true);
    expect(rv.barriers.canApprove).toBe(true);
    expect(rv.barriers.canFinalApprove).toBe(false); // لا توقيع أول بعد

    // بلا توقيع أول ⇒ ممنوع.
    await expectTrpc(approveStocktake(r.sessionId, actor), "PRECONDITION_FAILED", /توقيع/);

    const fs = await firstSignStocktake(r.sessionId, actor);
    expect(fs.firstSignByName).toBe("أحمد المدير");

    // نفس الموقّع الأول لا يعتمد نهائياً.
    await expectTrpc(approveStocktake(r.sessionId, actor), "FORBIDDEN", /مسؤول آخر/);
    // الموقّع الأول لا يرى canFinalApprove، والمستخدم الآخر يراه.
    const rvMe = await computeStocktakeReview(r.sessionId, { viewerId: 1 });
    expect(rvMe.barriers.canFinalApprove).toBe(false);
    const rvOther = await computeStocktakeReview(r.sessionId, { viewerId: 2 });
    expect(rvOther.barriers.canFinalApprove).toBe(true);

    // مستخدم مختلف ⇒ نجاح.
    const ok = await approveStocktake(r.sessionId, actor2);
    expect(ok.ok).toBe(true);
    expect(await stockOf(4)).toBe(8);
    const sess = (await db().select().from(s.stocktakeSessions).where(eq(s.stocktakeSessions.id, r.sessionId)))[0];
    expect(Number(sess.firstSignBy)).toBe(1);
    expect(Number(sess.approvedBy)).toBe(2);
  });
});

describe("الاعتماد الذرّي", () => {
  it("approve كامل: setStock بمرجع STOCKTAKE + قيدا دفتر بقيم صحيحة وdedupeKey فريد + قرارات تلقائية + lastCountedAt + تكرار بلا أثر", async () => {
    await setStockRow(1, 100); // زيادة ضمن الحد ⇒ تسوية تلقائية
    await setStockRow(2, 100); // عجز فوق الحد ⇒ قرار ADJUST صريح
    await setStockRow(3, 100); // عجز فوق الحد بالقيمة ⇒ قرار KEEP صريح (لا يدخل القيد)
    await setStockRow(4, 10); // غير معدود ⇒ يبقى دفترياً بلا قرار
    await setStockRow(5, 30); // مطابق ⇒ KEEP تلقائي (سجل IRA)
    const r = await mkSession({ variantIds: [1, 2, 3, 4, 5] });
    const aid = r.assignments[0].assignmentId;
    await insertCount(r.sessionId, 1, aid, 104); // ‎+4 × 100 = +400
    await insertCount(r.sessionId, 2, aid, 88); // ‎−12 × 50 = −600
    await insertCount(r.sessionId, 3, aid, 97); // ‎−3 × 10000 = −30000
    await insertCount(r.sessionId, 5, aid, 30); // مطابق
    await forceStocktakeReview(r.sessionId, actor);
    await decideStocktakeItem({ sessionId: r.sessionId, variantId: 2, action: "ADJUST", reason: "DAMAGE" }, actor);
    await decideStocktakeItem({ sessionId: r.sessionId, variantId: 3, action: "KEEP", reason: "ENTRY_ERROR" }, actor);

    const rv = await computeStocktakeReview(r.sessionId, { viewerId: 1 });
    expect(rv.barriers.notCounted).toBe(1);
    expect(rv.barriers.canApprove).toBe(true);
    expect(rv.ledgerPreview).toEqual({ shortExpense: "600.00", overGain: "400.00" });
    expect(rv.totals.counted).toBe(4);
    expect(rv.totals.matched).toBe(1);
    expect(rv.totals.over).toBe(1);
    expect(rv.totals.short).toBe(2);
    expect(rv.totals.shortValue).toBe("-30600.00");
    expect(rv.totals.overValue).toBe("400.00");
    expect(rv.totals.netValue).toBe("-30200.00");

    const ok = await approveStocktake(r.sessionId, actor);
    expect(ok).toEqual({ ok: true, adjustedCount: 2, shortExpense: "600.00", overGain: "400.00" });

    // المخزون: تسويتان فقط (1 و2)، KEEP وغير المعدود لا يُمسّان.
    expect(await stockOf(1)).toBe(104);
    expect(await stockOf(2)).toBe(88);
    expect(await stockOf(3)).toBe(100);
    expect(await stockOf(4)).toBe(10);
    expect(await stockOf(5)).toBe(30);

    // حركتا ADJUST بمرجع STOCKTAKE وملاحظة تتضمن code (setStock يُلحق علامة «(فرق ±D)» دائماً).
    const mv = await stocktakeMovements(r.sessionId);
    expect(mv).toHaveLength(2);
    expect(mv.every((m) => m.movementType === "ADJUST" && (m.notes ?? "").includes(r.code))).toBe(true);
    expect(mv.map((m) => m.quantity).sort((a, b) => a - b)).toEqual([4, 12]);

    // قيدا الدفتر: عجز/زيادة بقيم صحيحة وdedupeKey فريد وamount=0 (لا يلمس الصندوق).
    const entries = await adjustEntries();
    expect(entries).toHaveLength(2);
    const short = entries.find((e) => e.dedupeKey === `STOCKTAKE:${r.sessionId}:SHORT`)!;
    const over = entries.find((e) => e.dedupeKey === `STOCKTAKE:${r.sessionId}:OVER`)!;
    expect(short.cost).toBe("600.00");
    expect(short.profit).toBe("-600.00");
    expect(short.amount).toBe("0.00");
    expect(short.revenue).toBe("0.00");
    expect(Number(short.branchId)).toBe(1);
    expect(short.notes).toContain(r.code);
    expect(short.notes).toContain("عجز");
    expect(over.cost).toBe("-400.00");
    expect(over.profit).toBe("400.00");
    expect(over.amount).toBe("0.00");
    expect(over.notes).toContain("زيادة");
    expect(short.dedupeKey).not.toBe(over.dedupeKey);

    // القرارات المثبَّتة: تلقائي ضمن الحد + صريحان + KEEP تلقائي للمطابق؛ غير المعدود بلا قرار.
    const decisions = await db().select().from(s.stocktakeDecisions).where(eq(s.stocktakeDecisions.sessionId, r.sessionId));
    expect(decisions).toHaveLength(4);
    const dm = new Map(decisions.map((d) => [Number(d.variantId), d]));
    expect(dm.get(1)).toMatchObject({ action: "ADJUST", autoApplied: true, decidedBy: null, finalQty: 104, diffQty: 4, value: "400.00", reason: "UNSPECIFIED" });
    expect(dm.get(2)).toMatchObject({ action: "ADJUST", autoApplied: false, finalQty: 88, diffQty: -12, value: "-600.00", reason: "DAMAGE" });
    expect(Number(dm.get(2)!.decidedBy)).toBe(1);
    expect(dm.get(3)).toMatchObject({ action: "KEEP", finalQty: 97, diffQty: -3, value: "-30000.00", reason: "ENTRY_ERROR" });
    expect(dm.get(5)).toMatchObject({ action: "KEEP", autoApplied: true, decidedBy: null, diffQty: 0, value: "0.00" });
    expect(dm.has(4)).toBe(false);

    // lastCountedAt للمعدود فقط.
    const bs = await db().select().from(s.branchStock).where(eq(s.branchStock.branchId, 1));
    const lc = new Map(bs.map((b) => [Number(b.variantId), b.lastCountedAt]));
    expect(lc.get(1)).not.toBeNull();
    expect(lc.get(2)).not.toBeNull();
    expect(lc.get(3)).not.toBeNull();
    expect(lc.get(5)).not.toBeNull();
    expect(lc.get(4)).toBeNull();

    // الجلسة معتمدة.
    const sess = (await db().select().from(s.stocktakeSessions).where(eq(s.stocktakeSessions.id, r.sessionId)))[0];
    expect(sess.status).toBe("APPROVED");
    expect(Number(sess.approvedBy)).toBe(1);
    expect(sess.approvedAt).not.toBeNull();

    // تكرار approve ⇒ نجاح بلا أثر مزدوج (idempotent).
    const again = await approveStocktake(r.sessionId, actor);
    expect(again.alreadyApproved).toBe(true);
    expect(await stocktakeMovements(r.sessionId)).toHaveLength(2);
    expect(await adjustEntries()).toHaveLength(2);
    expect(await stockOf(1)).toBe(104);
  });

  it("ROLLBACK كامل عند فشل وسط الاعتماد: لا مخزون ولا حركات ولا قرارات ولا lastCountedAt", async () => {
    await setStockRow(1, 100);
    const r = await mkSession({ variantIds: [1] });
    await insertCount(r.sessionId, 1, r.assignments[0].assignmentId, 99); // عجز 1 ضمن الحد ⇒ تسوية تلقائية
    await forceStocktakeReview(r.sessionId, actor);

    // قيد دفتري مزروع بنفس dedupeKey ⇒ postEntry داخل approve يصطدم بـER_DUP_ENTRY بعد setStock.
    await db().insert(s.accountingEntries).values({
      entryType: "ADJUST",
      branchId: 1,
      revenue: "0.00",
      cost: "0.00",
      profit: "0.00",
      taxAmount: "0.00",
      amount: "0.00",
      entryDate: new Date(),
      notes: "قيد مزروع لاختبار التراجع",
      dedupeKey: `STOCKTAKE:${r.sessionId}:SHORT`,
    });

    await expect(approveStocktake(r.sessionId, actor)).rejects.toThrow();

    // كل شيء تراجع: المخزون والحركات والقرارات وlastCountedAt والحالة.
    expect(await stockOf(1)).toBe(100);
    expect(await stocktakeMovements(r.sessionId)).toHaveLength(0);
    expect(await db().select().from(s.stocktakeDecisions).where(eq(s.stocktakeDecisions.sessionId, r.sessionId))).toHaveLength(0);
    const bs = (await db().select().from(s.branchStock).where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1))))[0];
    expect(bs.lastCountedAt).toBeNull();
    const sess = (await db().select().from(s.stocktakeSessions).where(eq(s.stocktakeSessions.id, r.sessionId)))[0];
    expect(sess.status).toBe("REVIEW");

    // بإزالة القيد المزروع يكتمل الاعتماد طبيعياً.
    await db().delete(s.accountingEntries).where(eq(s.accountingEntries.dedupeKey, `STOCKTAKE:${r.sessionId}:SHORT`));
    const ok = await approveStocktake(r.sessionId, actor);
    expect(ok.ok).toBe(true);
    expect(await stockOf(1)).toBe(99);
  });

  it("لا إلغاء لجلسة معتمدة؛ وإلغاء جلسة عدّ idempotent بلا أثر مخزوني", async () => {
    await setStockRow(1, 50);
    const r = await mkSession({ variantIds: [1] });
    await insertCount(r.sessionId, 1, r.assignments[0].assignmentId, 50);
    await forceStocktakeReview(r.sessionId, actor);
    await approveStocktake(r.sessionId, actor);
    await expectTrpc(cancelStocktakeSession({ sessionId: r.sessionId }, actor), "BAD_REQUEST", /معتمدة/);

    const r2 = await mkSession({ variantIds: [1] });
    await cancelStocktakeSession({ sessionId: r2.sessionId, reason: "أُنشئت بالخطأ" }, actor);
    const again = await cancelStocktakeSession({ sessionId: r2.sessionId }, actor);
    expect(again.ok).toBe(true);
    const sess = (await db().select().from(s.stocktakeSessions).where(eq(s.stocktakeSessions.id, r2.sessionId)))[0];
    expect(sess.status).toBe("CANCELLED");
    expect(await stockOf(1)).toBe(50);
  });
});

describe("مخرجات بلا تسريب", () => {
  it("monitor وcountSheets لا يسرّبان expectedQty/التكلفة (مخرجات تصل دور warehouse)", async () => {
    await setStockRow(1, 100);
    const r = await mkSession({ variantIds: [1] });
    await insertCount(r.sessionId, 1, r.assignments[0].assignmentId, 95);

    const mon = await monitorStocktakeSession(r.sessionId);
    const monJson = JSON.stringify(mon);
    expect(monJson).not.toMatch(/expectedQty|unitCost|costPrice/);
    expect(mon.recentCounts).toHaveLength(1);
    expect(mon.recentCounts[0].qty).toBe(95);
    expect(mon.recentCounts[0].baseUnit).toBe("قطعة"); // الشاشة تعرض «95 قطعة»
    expect(mon.assignments[0].counted).toBe(1);

    const sheets = await getStocktakeCountSheets(r.sessionId);
    const sheetsJson = JSON.stringify(sheets);
    expect(sheetsJson).not.toMatch(/expectedQty|unitCost|costPrice/);
    expect(sheets.sheets[0].items[0]).toEqual({
      productName: "قلم جاف",
      variantName: null,
      sku: "PEN-1",
      barcode: "BC-PEN-1",
      baseUnit: "قطعة",
    });
  });

  it("monitor بالبحث q: recentCounts تصبح المطابقات (اسم/sku) حتى 50 بدل آخر 20، والتهريب يمنع wildcards", async () => {
    await setStockRow(1, 100);
    await setStockRow(2, 50);
    const r = await mkSession({ variantIds: [1, 2] });
    const aid = r.assignments[0].assignmentId;
    await insertCount(r.sessionId, 1, aid, 95);
    await insertCount(r.sessionId, 2, aid, 45);

    // بلا بحث: العدّتان وكل عنصر يحمل baseUnit.
    const mon = await monitorStocktakeSession(r.sessionId);
    expect(mon.recentCounts).toHaveLength(2);
    expect(mon.recentCounts.every((c) => c.baseUnit === "قطعة")).toBe(true);

    // بحث باسم المنتج ⇒ المطابِق وحده.
    const byName = await monitorStocktakeSession(r.sessionId, { q: "دفتر" });
    expect(byName.recentCounts).toHaveLength(1);
    expect(byName.recentCounts[0].variantId).toBe(2);
    expect(byName.recentCounts[0].qty).toBe(45);

    // بحث بـsku.
    const bySku = await monitorStocktakeSession(r.sessionId, { q: "PEN-1" });
    expect(bySku.recentCounts).toHaveLength(1);
    expect(bySku.recentCounts[0].variantId).toBe(1);

    // لا تطابق ⇒ قائمة فارغة (لا تهبط لآخر العدّات).
    const none = await monitorStocktakeSession(r.sessionId, { q: "غير موجود إطلاقاً" });
    expect(none.recentCounts).toHaveLength(0);

    // محارف LIKE تُهرَّب: «%» مدخلاً لا يطابق كل شيء.
    const wild = await monitorStocktakeSession(r.sessionId, { q: "%" });
    expect(wild.recentCounts).toHaveLength(0);
  });
});
